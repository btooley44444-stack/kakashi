const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, PermissionFlagsBits,
  AuditLogEvent, ActivityType,
} = require('discord.js');
const { QuickDB } = require('quick.db');

const db     = new QuickDB();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.GuildMember],
});

const PREFIX   = '-';
const restoring = new Set();

// ─────────────────────────────────────────────
//  SETTINGS CACHE  (avoids DB read on every event)
// ─────────────────────────────────────────────
const cache = new Map();
async function getSettings(gid) {
  if (cache.has(gid)) return cache.get(gid);
  const s = {
    enabled:    !!(await db.get(`antinuke.${gid}.enabled`)),
    whitelist:  (await db.get(`antinuke.${gid}.whitelist`)) || [],
    logChannel: await db.get(`antinuke.${gid}.logChannel`),
  };
  cache.set(gid, s);
  return s;
}
function clearCache(gid) { cache.delete(gid); }

// ─────────────────────────────────────────────
//  IN-MEMORY COUNTERS  (no DB, no await)
// ─────────────────────────────────────────────
const counts = { ch: new Map(), role: new Map(), ban: new Map(), kick: new Map() };

function crossed(map, gid, window = 4000, limit = 2) {
  if (!map.has(gid)) map.set(gid, []);
  const now   = Date.now();
  const times = map.get(gid).filter(t => now - t < window);
  times.push(now);
  map.set(gid, times);
  if (times.length >= limit) { map.delete(gid); return true; }
  return false;
}

// ─────────────────────────────────────────────
//  AUDIT LOG PREFETCH  (starts on 1st event so
//  result is ready when threshold fires on 2nd)
// ─────────────────────────────────────────────
const prefetched = new Map();
function prefetch(guild, type) {
  const k = `${guild.id}:${type}`;
  if (!prefetched.has(k)) {
    prefetched.set(k, guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null));
    setTimeout(() => prefetched.delete(k), 5000);
  }
  return prefetched.get(k);
}
async function getExec(guild, type) {
  const [pre, fresh] = await Promise.all([
    prefetched.get(`${guild.id}:${type}`) || Promise.resolve(null),
    guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null),
  ]);
  return (fresh?.entries.first() || pre?.entries.first())?.executor || null;
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function trusted(s, uid, ownerId, botId) {
  return uid === ownerId || uid === botId || s.whitelist.includes(uid);
}
async function punish(guild, uid) {
  await guild.members.ban(uid, { reason: 'Antinuke', deleteMessageSeconds: 0 }).catch(() => {});
  const m = await guild.members.fetch(uid).catch(() => null);
  if (m?.manageable) await m.roles.set([], 'Antinuke').catch(() => {});
}
async function log(gid, guild, msg) {
  const s = await getSettings(gid);
  if (s.logChannel) guild.channels.cache.get(s.logChannel)?.send(msg).catch(() => {});
}

function snapCh(ch) {
  return {
    id: ch.id, name: ch.name, type: ch.type,
    parentId: ch.parentId || null,
    position: ch.position,
    topic: ch.topic || null,
    nsfw: ch.nsfw || false,
    rateLimitPerUser: ch.rateLimitPerUser || 0,
    bitrate: ch.bitrate || null,
    userLimit: ch.userLimit || null,
    permissionOverwrites: ch.permissionOverwrites.cache.map(p => ({
      id: p.id, type: p.type,
      allow: p.allow.bitfield.toString(),
      deny:  p.deny.bitfield.toString(),
    })),
  };
}

// Safely convert stored permission overwrites back to BigInt.
// Returns [] if anything is invalid — channel still gets created, just without perms.
function buildPerms(overwrites) {
  try {
    return overwrites.map(p => ({
      id:    p.id,
      type:  p.type,
      allow: BigInt(p.allow || '0'),
      deny:  BigInt(p.deny  || '0'),
    }));
  } catch { return []; }
}

// Try to create a channel; if it fails (bad perm IDs etc) retry without overwrites.
async function makeChannel(guild, opts) {
  try { return await guild.channels.create(opts); } catch {}
  try {
    const { permissionOverwrites: _skip, ...clean } = opts;
    return await guild.channels.create(clean);
  } catch {}
  return null;
}

// Channel types we can actually create via the API (no threads / directory)
const CREATABLE = new Set([0, 2, 4, 5, 13, 15]);

// ─────────────────────────────────────────────
//  AUTO-RESTORE
//  Triggered automatically when a nuke is
//  detected. No command needed.
// ─────────────────────────────────────────────
async function autoRestore(guild) {
  if (restoring.has(guild.id)) return;
  restoring.add(guild.id);

  try {
    await log(guild.id, guild, '🔄 Nuke stopped. Waiting for in-flight deletes to settle…');
    await new Promise(r => setTimeout(r, 4000));

    const snapshot = await db.get(`snap.${guild.id}`);
    if (!snapshot?.length) {
      await log(guild.id, guild, '❌ No snapshot — cannot restore. One is saved on the first channel deletion.');
      return;
    }

    await log(guild.id, guild, `🔄 Restoring **${snapshot.length}** channels…`);
    let removed = 0, restored = 0, skipped = 0, failed = 0;

    // ── Step 1: delete nuker channels — ALL AT ONCE (parallel) ───
    // Any channel whose ID is not in the pre-nuke snapshot was created
    // by the nuker. Deleting them in parallel is much faster.
    const snapIds = new Set(snapshot.map(c => c.id));
    const nukeChs = [...guild.channels.cache.values()].filter(c => !snapIds.has(c.id));

    await Promise.all(nukeChs.map(c => c.delete('Antinuke restore').catch(() => {})));
    removed = nukeChs.length;

    // Brief pause for Discord to process the deletes
    await new Promise(r => setTimeout(r, 2000));

    // ── Step 2: recreate categories first (type 4) ───────────────
    const catMap = new Map(); // old category ID → new category ID

    for (const ch of snapshot.filter(c => c.type === 4)) {
      try {
        // If it still exists (wasn't deleted by the nuke), just remap it
        const existing = guild.channels.cache.get(ch.id);
        if (existing) { catMap.set(ch.id, existing.id); skipped++; continue; }

        const newCh = await makeChannel(guild, {
          name:     ch.name,
          type:     ch.type,
          position: ch.position,
          permissionOverwrites: buildPerms(ch.permissionOverwrites),
        });

        if (newCh) { catMap.set(ch.id, newCh.id); restored++; }
        else        failed++;
      } catch (e) {
        // Each channel is isolated — one failure NEVER stops the loop
        console.error(`[restore] category "${ch.name}":`, e.message);
        failed++;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // ── Step 3: recreate every other channel ─────────────────────
    for (const ch of snapshot.filter(c => c.type !== 4)) {
      try {
        // Skip threads and other uncreatable types
        if (!CREATABLE.has(ch.type)) { skipped++; continue; }

        // Skip if somehow still alive
        if (guild.channels.cache.has(ch.id)) { skipped++; continue; }

        // Map old category ID to the newly created one
        const parentId = ch.parentId ? catMap.get(ch.parentId) : null;

        const opts = {
          name:     ch.name,
          type:     ch.type,
          position: ch.position,
          permissionOverwrites: buildPerms(ch.permissionOverwrites),
        };
        if (parentId)            opts.parent           = parentId;
        if (ch.topic)            opts.topic            = ch.topic;
        if (ch.nsfw)             opts.nsfw             = ch.nsfw;
        if (ch.rateLimitPerUser) opts.rateLimitPerUser = ch.rateLimitPerUser;
        if (ch.bitrate)          opts.bitrate          = ch.bitrate;
        if (ch.userLimit)        opts.userLimit        = ch.userLimit;

        const newCh = await makeChannel(guild, opts);
        if (newCh) restored++; else failed++;
      } catch (e) {
        // Isolated — loop always continues to the next channel
        console.error(`[restore] channel "${ch.name}":`, e.message);
        failed++;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    await log(guild.id, guild,
      `✅ **Restore complete** — deleted **${removed}** nuke channels, ` +
      `restored **${restored}**` +
      (skipped ? `, skipped **${skipped}** (already existed / threads)` : '') +
      (failed  ? `, **${failed}** failed` : '') + '.'
    );

  } catch (e) {
    console.error('[autoRestore fatal]', e);
  } finally {
    restoring.delete(guild.id);
  }
}

// ─────────────────────────────────────────────
//  READY
// ─────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ ${client.user.tag} online`);
  client.user.setPresence({
    activities: [{ name: '.gg/rasengan', type: ActivityType.Watching }],
    status: 'online',
  });
});

// ─────────────────────────────────────────────
//  WELCOME + AUTOROLE
// ─────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  const { guild, user } = member;
  const chId = await db.get(`welcome.${guild.id}.channel`);
  if (chId) {
    const ch = guild.channels.cache.get(chId);
    let msg  = await db.get(`welcome.${guild.id}.message`);
    if (ch) {
      if (msg) {
        msg = msg.replace(/{user}/g,`<@${user.id}>`).replace(/{username}/g,user.username).replace(/{server}/g,guild.name).replace(/{memberCount}/g,guild.memberCount);
        ch.send(msg).catch(()=>{});
      } else {
        ch.send({ embeds:[new EmbedBuilder().setColor(0x5865f2).setTitle(`Welcome to ${guild.name}!`).setDescription(`Hey <@${user.id}>, you are member **#${guild.memberCount}**!`).setThumbnail(user.displayAvatarURL()).setTimestamp()] }).catch(()=>{});
      }
    }
  }
  for (const rid of (await db.get(`autorole.${guild.id}.roles`)) || []) {
    const r = guild.roles.cache.get(rid);
    if (r && guild.members.me.roles.highest.position > r.position) await member.roles.add(r).catch(()=>{});
  }
});

// ─────────────────────────────────────────────
//  ANTINUKE EVENTS
// ─────────────────────────────────────────────
client.on('channelDelete', async channel => {
  if (!channel.guild || restoring.has(channel.guild.id)) return;
  const { guild } = channel;

  // Kick off audit log fetch immediately (parallel, no await yet)
  prefetch(guild, AuditLogEvent.ChannelDelete);

  // Take full guild snapshot once per 30-second window.
  // Captures parentId BEFORE category gets deleted and channels lose their parent.
  try {
    const last = await db.get(`snap.${guild.id}.time`);
    if (!last || Date.now() - last > 30_000) {
      const all = new Map(guild.channels.cache);
      all.set(channel.id, channel);
      await db.set(`snap.${guild.id}`,      [...all.values()].map(snapCh));
      await db.set(`snap.${guild.id}.time`, Date.now());
    }
  } catch {}

  // Instant in-memory count — no DB, no await
  if (!crossed(counts.ch, guild.id)) return;

  const s = await getSettings(guild.id);
  if (!s.enabled) return;

  // By now the prefetch from the 1st deletion is likely already resolved
  const exec = await getExec(guild, AuditLogEvent.ChannelDelete);
  if (!exec || trusted(s, exec.id, guild.ownerId, guild.members.me?.id)) return;

  await log(guild.id, guild, `🚨 **Antinuke** — **${exec.tag}** nuking! Banning + auto-restoring…`);
  await punish(guild, exec.id);
  autoRestore(guild); // fire-and-forget so punish lands first
});

client.on('roleDelete', async role => {
  if (!role.guild || restoring.has(role.guild.id)) return;
  prefetch(role.guild, AuditLogEvent.RoleDelete);
  if (!crossed(counts.role, role.guild.id)) return;
  const s = await getSettings(role.guild.id);
  if (!s.enabled) return;
  const exec = await getExec(role.guild, AuditLogEvent.RoleDelete);
  if (!exec || trusted(s, exec.id, role.guild.ownerId, role.guild.members.me?.id)) return;
  await log(role.guild.id, role.guild, `🚨 **Antinuke** — **${exec.tag}** mass-deleting roles! Banning…`);
  await punish(role.guild, exec.id);
});

client.on('guildBanAdd', async ban => {
  prefetch(ban.guild, AuditLogEvent.MemberBan);
  if (!crossed(counts.ban, ban.guild.id)) return;
  const s = await getSettings(ban.guild.id);
  if (!s.enabled) return;
  const exec = await getExec(ban.guild, AuditLogEvent.MemberBan);
  if (!exec || trusted(s, exec.id, ban.guild.ownerId, ban.guild.members.me?.id)) return;
  await log(ban.guild.id, ban.guild, `🚨 **Antinuke** — **${exec.tag}** mass-banning! Banning…`);
  await punish(ban.guild, exec.id);
});

client.on('guildMemberRemove', async member => {
  if (!crossed(counts.kick, member.guild.id)) return;
  const s = await getSettings(member.guild.id);
  if (!s.enabled) return;
  try {
    const logs  = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 1 });
    const entry = logs.entries.first();
    if (!entry?.executor || entry.target?.id !== member.id || Date.now() - entry.createdTimestamp > 3000) return;
    if (trusted(s, entry.executor.id, member.guild.ownerId, member.guild.members.me?.id)) return;
    await log(member.guild.id, member.guild, `🚨 **Antinuke** — **${entry.executor.tag}** mass-kicking! Banning…`);
    await punish(member.guild, entry.executor.id);
  } catch {}
});

// ─────────────────────────────────────────────
//  COMMANDS
// ─────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd  = args.shift().toLowerCase();

  if (cmd === 'cmds' || cmd === 'commands' || cmd === 'help') {
    return message.reply({ embeds:[new EmbedBuilder().setColor(0x5865f2).setTitle('📋 Commands')
      .addFields(
        { name:'🔨 Moderation', value:'`-ban @user [reason]`\n`-kick @user [reason]`\n`-timeout @user <60s|5m|10m|1h|1d|1w> [reason]`\n`-warn @user <reason>`\n`-warnings @user`\n`-warnings clear @user`\n`-purge <1-100>`\n`-purge @user <1-100>`' },
        { name:'🎭 Roles',      value:'`-role add @user <name>`\n`-role remove @user <name>`' },
        { name:'👋 Welcome',    value:'`-setwelcome #channel`\n`-setwelcome message <text>`\n`-setwelcome disable`\n`-setwelcome test`' },
        { name:'⚙️ Config',     value:'`-autorole add @role`\n`-autorole remove @role`\n`-autorole list`' },
        { name:'🛡️ Antinuke (owner only)', value:'`-antinuke enable`\n`-antinuke disable`\n`-antinuke setlog #channel`\n`-antinuke whitelist add/remove @user`\n`-antinuke status`\n`-antinuke restore` — manual restore\n`-antinuke restore clear`' },
      ).setFooter({ text:`Prefix: ${PREFIX}  •  Auto-restore fires automatically on nuke detection` })] });
  }

  if (cmd === 'ban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply('❌ You need **Ban Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(()=>null);
    if (!t) return message.reply('❌ Usage: `-ban @user [reason]`');
    const r = args.slice(1).join(' ') || 'No reason provided';
    if (t.id===message.author.id) return message.reply('❌ Cannot ban yourself.');
    if (t.id===message.guild.ownerId) return message.reply('❌ Cannot ban the server owner.');
    if (!t.bannable) return message.reply("❌ I can't ban that user.");
    if (message.member.roles.highest.position<=t.roles.highest.position) return message.reply('❌ That user has an equal or higher role.');
    await t.send({ embeds:[new EmbedBuilder().setColor(0xff4444).setTitle(`Banned from ${message.guild.name}`).addFields({name:'Reason',value:r})] }).catch(()=>{});
    await t.ban({ reason:`${message.author.tag}: ${r}` });
    message.reply({ embeds:[new EmbedBuilder().setColor(0xff4444).setTitle('🔨 Banned').addFields({name:'User',value:t.user.tag,inline:true},{name:'Moderator',value:message.author.tag,inline:true},{name:'Reason',value:r}).setTimestamp()] });
  }
  else if (cmd === 'kick') {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) return message.reply('❌ You need **Kick Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(()=>null);
    if (!t) return message.reply('❌ Usage: `-kick @user [reason]`');
    const r = args.slice(1).join(' ') || 'No reason provided';
    if (t.id===message.author.id) return message.reply('❌ Cannot kick yourself.');
    if (t.id===message.guild.ownerId) return message.reply('❌ Cannot kick the server owner.');
    if (!t.kickable) return message.reply("❌ I can't kick that user.");
    if (message.member.roles.highest.position<=t.roles.highest.position) return message.reply('❌ That user has an equal or higher role.');
    await t.send({ embeds:[new EmbedBuilder().setColor(0xff8800).setTitle(`Kicked from ${message.guild.name}`).addFields({name:'Reason',value:r})] }).catch(()=>{});
    await t.kick(`${message.author.tag}: ${r}`);
    message.reply({ embeds:[new EmbedBuilder().setColor(0xff8800).setTitle('👢 Kicked').addFields({name:'User',value:t.user.tag,inline:true},{name:'Moderator',value:message.author.tag,inline:true},{name:'Reason',value:r}).setTimestamp()] });
  }
  else if (cmd === 'timeout' || cmd === 'mute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('❌ You need **Timeout Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(()=>null);
    if (!t) return message.reply('❌ Usage: `-timeout @user <60s|5m|10m|1h|1d|1w> [reason]`');
    const dur = {'60s':60,'5m':300,'10m':600,'1h':3600,'1d':86400,'1w':604800};
    const dk=args[1]?.toLowerCase(), secs=dur[dk];
    if (!secs) return message.reply('❌ Duration: `60s` `5m` `10m` `1h` `1d` `1w`');
    const r=args.slice(2).join(' ')||'No reason provided';
    if (!t.moderatable) return message.reply("❌ I can't timeout that user.");
    if (message.member.roles.highest.position<=t.roles.highest.position) return message.reply('❌ That user has an equal or higher role.');
    await t.timeout(secs*1000,`${message.author.tag}: ${r}`);
    message.reply({ embeds:[new EmbedBuilder().setColor(0xffcc00).setTitle('⏱️ Timed Out').addFields({name:'User',value:t.user.tag,inline:true},{name:'Duration',value:dk,inline:true},{name:'Moderator',value:message.author.tag,inline:true},{name:'Reason',value:r}).setTimestamp()] });
  }
  else if (cmd === 'warn') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('❌ You need **Timeout Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(()=>null);
    if (!t) return message.reply('❌ Usage: `-warn @user <reason>`');
    const r=args.slice(1).join(' ');
    if (!r) return message.reply('❌ Provide a reason.');
    if (t.id===message.author.id) return message.reply('❌ Cannot warn yourself.');
    const key=`warnings.${message.guild.id}.${t.id}`;
    await db.push(key,{reason:r,moderator:message.author.tag,date:new Date().toISOString()});
    const count=((await db.get(key))||[]).length;
    await t.send({ embeds:[new EmbedBuilder().setColor(0xffcc00).setTitle(`Warned in ${message.guild.name}`).addFields({name:'Reason',value:r},{name:'Warning #',value:String(count)})] }).catch(()=>{});
    message.reply({ embeds:[new EmbedBuilder().setColor(0xffcc00).setTitle('⚠️ Warned').addFields({name:'User',value:t.user.tag,inline:true},{name:'Warning #',value:String(count),inline:true},{name:'Moderator',value:message.author.tag,inline:true},{name:'Reason',value:r}).setTimestamp()] });
  }
  else if (cmd === 'warnings' || cmd === 'warns') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('❌ You need **Timeout Members** permission.');
    const isClear=args[0]?.toLowerCase()==='clear';
    const t = isClear ? message.mentions.users.first()||await client.users.fetch(args[1]).catch(()=>null) : message.mentions.users.first()||await client.users.fetch(args[0]).catch(()=>null);
    if (!t) return message.reply('❌ Usage: `-warnings @user` or `-warnings clear @user`');
    const key=`warnings.${message.guild.id}.${t.id}`;
    if (isClear) { await db.delete(key); return message.reply(`✅ Cleared warnings for **${t.tag}**.`); }
    const list=(await db.get(key))||[];
    if (!list.length) return message.reply(`✅ **${t.tag}** has no warnings.`);
    const lines=list.slice(-10).reverse().map((w,i)=>`**${list.length-i}.** ${w.reason}\n> by ${w.moderator} • <t:${Math.floor(new Date(w.date).getTime()/1000)}:R>`);
    message.reply({ embeds:[new EmbedBuilder().setColor(0xffcc00).setTitle(`⚠️ Warnings — ${t.tag}`).setDescription(lines.join('\n\n')).setFooter({text:`Total: ${list.length}`}).setTimestamp()] });
  }
  else if (cmd === 'purge') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('❌ You need **Manage Messages** permission.');
    const fm=message.mentions.members.first(), amount=parseInt(fm?args[1]:args[0]);
    if (isNaN(amount)||amount<1||amount>100) return message.reply('❌ Usage: `-purge <1-100>` or `-purge @user <1-100>`');
    await message.delete().catch(()=>{});
    const fetched=await message.channel.messages.fetch({limit:fm?100:amount});
    const toDelete=fm?[...fetched.filter(m=>m.author.id===fm.id).values()].slice(0,amount):[...fetched.values()];
    const deleted=await message.channel.bulkDelete(toDelete,true);
    const conf=await message.channel.send({ embeds:[new EmbedBuilder().setColor(0x00cc44).setDescription(`🗑️ Deleted **${deleted.size}** messages.`)] });
    setTimeout(()=>conf.delete().catch(()=>{}),4000);
  }
  else if (cmd === 'role') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return message.reply('❌ You need **Manage Roles** permission.');
    const sub=args[0]?.toLowerCase(), t=message.mentions.members.first();
    if (!['add','remove'].includes(sub)) return message.reply('❌ Usage: `-role add @user <name>` or `-role remove @user <name>`');
    if (!t) return message.reply('❌ Please mention a user.');
    const rn=args.slice(2).join(' ');
    if (!rn) return message.reply('❌ Please provide a role name.');
    const role=message.mentions.roles.first()||message.guild.roles.cache.find(r=>r.name.toLowerCase()===rn.toLowerCase());
    if (!role) return message.reply(`❌ No role named **${rn}**.`);
    if (message.guild.members.me.roles.highest.position<=role.position) return message.reply("❌ That role is above my highest role.");
    if (message.member.roles.highest.position<=role.position) return message.reply("❌ That role is above your highest role.");
    if (role.managed) return message.reply('❌ Managed by an integration.');
    if (sub==='add') {
      if (t.roles.cache.has(role.id)) return message.reply(`❌ ${t} already has **${role.name}**.`);
      await t.roles.add(role,`Added by ${message.author.tag}`);
      message.reply({ embeds:[new EmbedBuilder().setColor(0x00cc44).setTitle('✅ Role Added').addFields({name:'Member',value:`${t}`,inline:true},{name:'Role',value:role.name,inline:true})] });
    } else {
      if (!t.roles.cache.has(role.id)) return message.reply(`❌ ${t} doesn't have **${role.name}**.`);
      await t.roles.remove(role,`Removed by ${message.author.tag}`);
      message.reply({ embeds:[new EmbedBuilder().setColor(0xff4444).setTitle('✅ Role Removed').addFields({name:'Member',value:`${t}`,inline:true},{name:'Role',value:role.name,inline:true})] });
    }
  }
  else if (cmd === 'setwelcome') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('❌ You need **Manage Server** permission.');
    const gid=message.guild.id, ch=message.mentions.channels.first();
    if (ch) { await db.set(`welcome.${gid}.channel`,ch.id); return message.reply(`✅ Welcome channel set to ${ch}.`); }
    const sub=args[0]?.toLowerCase();
    if (sub==='message') {
      const text=args.slice(1).join(' ');
      if (!text) return message.reply('❌ Usage: `-setwelcome message Hello {user}!`');
      await db.set(`welcome.${gid}.message`,text);
      return message.reply('✅ Set! Placeholders: `{user}` `{username}` `{server}` `{memberCount}`');
    }
    if (sub==='disable') { await db.delete(`welcome.${gid}.channel`); await db.delete(`welcome.${gid}.message`); return message.reply('✅ Disabled.'); }
    if (sub==='test') {
      const cid=await db.get(`welcome.${gid}.channel`); if (!cid) return message.reply('❌ Set a channel first.');
      const chan=message.guild.channels.cache.get(cid); if (!chan) return message.reply('❌ Channel no longer exists.');
      let msg=await db.get(`welcome.${gid}.message`);
      if (msg) { msg=msg.replace(/{user}/g,`<@${message.author.id}>`).replace(/{username}/g,message.author.username).replace(/{server}/g,message.guild.name).replace(/{memberCount}/g,message.guild.memberCount); await chan.send(msg); }
      else { await chan.send({ embeds:[new EmbedBuilder().setColor(0x5865f2).setTitle(`Welcome to ${message.guild.name}!`).setDescription(`Hey <@${message.author.id}>, member **#${message.guild.memberCount}**!`).setThumbnail(message.author.displayAvatarURL()).setTimestamp()] }); }
      return message.reply(`✅ Test sent to ${chan}.`);
    }
    message.reply('❌ Usage: `-setwelcome #channel` | `message <text>` | `disable` | `test`');
  }
  else if (cmd === 'autorole') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return message.reply('❌ You need **Manage Roles** permission.');
    const sub=args[0]?.toLowerCase(), key=`autorole.${message.guild.id}.roles`, role=message.mentions.roles.first();
    if (sub==='add') {
      if (!role) return message.reply('❌ Usage: `-autorole add @role`');
      if (message.guild.members.me.roles.highest.position<=role.position) return message.reply("❌ That role is above my highest role.");
      const roles=(await db.get(key))||[]; if (roles.includes(role.id)) return message.reply(`❌ Already an autorole.`);
      roles.push(role.id); await db.set(key,roles); return message.reply(`✅ **${role.name}** will be given to new members.`);
    }
    if (sub==='remove') {
      if (!role) return message.reply('❌ Usage: `-autorole remove @role`');
      const roles=(await db.get(key))||[]; if (!roles.includes(role.id)) return message.reply('❌ Not an autorole.');
      await db.set(key,roles.filter(id=>id!==role.id)); return message.reply(`✅ Removed **${role.name}**.`);
    }
    if (sub==='list') {
      const roles=(await db.get(key))||[]; if (!roles.length) return message.reply('❌ No autoroles set.');
      return message.reply({ embeds:[new EmbedBuilder().setColor(0x5865f2).setTitle('🎭 Autoroles').setDescription(roles.map(id=>{ const r=message.guild.roles.cache.get(id); return r?`• ${r}`:'• Unknown'; }).join('\n')).setFooter({text:`${roles.length} role(s)`})] });
    }
    message.reply('❌ Usage: `add @role` | `remove @role` | `list`');
  }
  else if (cmd === 'antinuke' || cmd === 'an') {
    if (message.author.id!==message.guild.ownerId) return message.reply('❌ Only the **server owner** can manage antinuke.');
    const sub=args[0]?.toLowerCase(), gid=message.guild.id;
    if (sub==='enable') {
      await db.set(`antinuke.${gid}.enabled`,true); clearCache(gid);
      return message.reply({ embeds:[new EmbedBuilder().setColor(0x00cc44).setTitle('🛡️ Antinuke Enabled')
        .setDescription('**Triggers at:** 2 deletions / bans / kicks in 4s\n**On trigger:** instantly bans nuker + auto-restores all channels\n\n⚠️ Give this bot the **highest role** so it can ban anyone.\n`-antinuke setlog #channel` — receive alerts there.\n`-antinuke whitelist add @user` — trust your admins.')] });
    }
    if (sub==='disable') { await db.set(`antinuke.${gid}.enabled`,false); clearCache(gid); return message.reply('✅ Antinuke disabled.'); }
    if (sub==='setlog') {
      const ch=message.mentions.channels.first(); if (!ch) return message.reply('❌ Usage: `-antinuke setlog #channel`');
      await db.set(`antinuke.${gid}.logChannel`,ch.id); clearCache(gid); return message.reply(`✅ Alerts → ${ch}.`);
    }
    if (sub==='whitelist') {
      const action=args[1]?.toLowerCase(), user=message.mentions.users.first();
      if (!['add','remove'].includes(action)||!user) return message.reply('❌ Usage: `whitelist add/remove @user`');
      const wk=`antinuke.${gid}.whitelist`; let list=(await db.get(wk))||[];
      if (action==='add') {
        if (list.includes(user.id)) return message.reply('❌ Already whitelisted.');
        list.push(user.id); await db.set(wk,list); clearCache(gid); return message.reply(`✅ **${user.tag}** whitelisted.`);
      } else {
        if (!list.includes(user.id)) return message.reply('❌ Not whitelisted.');
        await db.set(wk,list.filter(id=>id!==user.id)); clearCache(gid); return message.reply(`✅ **${user.tag}** removed.`);
      }
    }
    if (sub==='status') {
      const s=await getSettings(gid), snapTime=await db.get(`snap.${gid}.time`), snapData=(await db.get(`snap.${gid}`))||[];
      return message.reply({ embeds:[new EmbedBuilder().setColor(s.enabled?0x00cc44:0xff4444).setTitle('🛡️ Antinuke Status')
        .addFields(
          {name:'Status',      value:s.enabled?'✅ Enabled':'❌ Disabled',                                                inline:true},
          {name:'Log Channel', value:s.logChannel?`<#${s.logChannel}>`:'Not set',                                        inline:true},
          {name:'Snapshot',    value:snapTime?`${snapData.length} channels • <t:${Math.floor(snapTime/1000)}:R>`:'None', inline:true},
          {name:'Whitelist',   value:s.whitelist.length?s.whitelist.map(id=>`<@${id}>`).join(', '):'None'},
        ).setTimestamp()] });
    }
    if (sub==='restore') {
      if (args[1]?.toLowerCase()==='clear') { await db.delete(`snap.${gid}`); await db.delete(`snap.${gid}.time`); return message.reply('✅ Snapshot cleared.'); }
      if (!(await db.get(`snap.${gid}`))?.length) return message.reply('❌ No snapshot found.');
      await message.reply('⏳ Starting restore…');
      autoRestore(message.guild);
      return;
    }
    message.reply('❌ Subcommands: `enable` `disable` `setlog #ch` `whitelist add/remove @user` `status` `restore` `restore clear`');
  }
});

client.login(process.env.BOT_TOKEN);
