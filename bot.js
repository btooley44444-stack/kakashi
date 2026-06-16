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

const PREFIX = '-';

// ─────────────────────────────────────────────
//  IN-MEMORY ANTINUKE SETTINGS CACHE
//  Avoids hitting SQLite on every single event.
//  Invalidated whenever settings change.
// ─────────────────────────────────────────────
const settingsCache = new Map(); // guildId → { enabled, whitelist, logChannel }

async function getSettings(guildId) {
  if (settingsCache.has(guildId)) return settingsCache.get(guildId);
  const s = {
    enabled:    !!(await db.get(`antinuke.${guildId}.enabled`)),
    whitelist:  (await db.get(`antinuke.${guildId}.whitelist`)) || [],
    logChannel: await db.get(`antinuke.${guildId}.logChannel`),
  };
  settingsCache.set(guildId, s);
  return s;
}

function clearCache(guildId) { settingsCache.delete(guildId); }

// ─────────────────────────────────────────────
//  IN-MEMORY DELETION COUNTERS
//  No DB reads — pure array timestamp checks.
// ─────────────────────────────────────────────
const counters = {
  channelDelete: new Map(),
  roleDelete:    new Map(),
  ban:           new Map(),
  kick:          new Map(),
};

// Returns true the moment the guild crosses the limit within the window.
// Resets the counter so it won't double-fire.
function crossed(type, guildId, windowMs = 4000, limit = 2) {
  const map = counters[type];
  if (!map.has(guildId)) map.set(guildId, []);
  const now   = Date.now();
  const times = map.get(guildId).filter(t => now - t < windowMs);
  times.push(now);
  map.set(guildId, times);
  if (times.length >= limit) { map.delete(guildId); return true; }
  return false;
}

// ─────────────────────────────────────────────
//  AUDIT LOG PREFETCH
//  We start the network request the moment the
//  FIRST event fires, so by the time the 2nd
//  event crosses the threshold the result is
//  likely already back.
// ─────────────────────────────────────────────
const auditPrefetch = new Map(); // `${guildId}:${type}` → Promise

function prefetch(guild, auditType) {
  const key = `${guild.id}:${auditType}`;
  if (!auditPrefetch.has(key)) {
    auditPrefetch.set(key, guild.fetchAuditLogs({ type: auditType, limit: 1 }).catch(() => null));
    setTimeout(() => auditPrefetch.delete(key), 5000);
  }
  return auditPrefetch.get(key);
}

async function getExec(guild, auditType) {
  // Always fire a fresh fetch in parallel with the cached one.
  // Whichever resolves first that has a valid entry wins.
  const [cached, fresh] = await Promise.all([
    auditPrefetch.get(`${guild.id}:${auditType}`) || Promise.resolve(null),
    guild.fetchAuditLogs({ type: auditType, limit: 1 }).catch(() => null),
  ]);
  const entry = (fresh?.entries.first()) || (cached?.entries.first());
  return entry?.executor || null;
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
const restoring = new Set(); // guilds currently mid-restore

function isTrusted(settings, userId, ownerId, botId) {
  return userId === ownerId || userId === botId || settings.whitelist.includes(userId);
}

async function punish(guild, userId) {
  // Ban first — immediately stops any bot token from making more API calls
  if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers))
    await guild.members.ban(userId, { reason: 'Antinuke', deleteMessageSeconds: 0 }).catch(() => {});
  // Also strip roles in case ban hierarchy blocks it
  const m = await guild.members.fetch(userId).catch(() => null);
  if (m?.manageable) await m.roles.set([], 'Antinuke').catch(() => {});
}

async function sendLog(settings, guild, msg) {
  if (!settings.logChannel) return;
  guild.channels.cache.get(settings.logChannel)?.send(msg).catch(() => {});
}

// Snapshot a channel to a storable plain object
function snap(ch) {
  return {
    id:               ch.id,
    name:             ch.name,
    type:             ch.type,
    parentId:         ch.parentId         || null,
    position:         ch.position,
    topic:            ch.topic            || null,
    nsfw:             ch.nsfw             || false,
    rateLimitPerUser: ch.rateLimitPerUser || 0,
    bitrate:          ch.bitrate          || null,
    userLimit:        ch.userLimit        || null,
    permissionOverwrites: ch.permissionOverwrites.cache.map(p => ({
      id:    p.id,
      type:  p.type,
      allow: p.allow.bitfield.toString(),
      deny:  p.deny.bitfield.toString(),
    })),
  };
}

// Attempt to create a channel.
// If it fails (e.g. bad permission overwrite IDs), retry without overwrites.
// Returns the created channel or null.
async function makeChannel(guild, opts) {
  try {
    return await guild.channels.create(opts);
  } catch {}
  try {
    const { permissionOverwrites: _skip, ...clean } = opts;
    return await guild.channels.create(clean);
  } catch {}
  return null;
}

// Channel types that can be created via the API.
// Threads (10, 11, 12) and directory (14) cannot.
const CREATABLE = new Set([0, 2, 4, 5, 13, 15]);

// ─────────────────────────────────────────────
//  AUTO-RESTORE
//  Fires automatically on nuke detection.
//  1. Waits for the nuker's in-flight calls to settle
//  2. Deletes all channels NOT in the pre-nuke snapshot
//  3. Recreates categories, then channels inside them
// ─────────────────────────────────────────────
async function autoRestore(guild) {
  if (restoring.has(guild.id)) return;
  restoring.add(guild.id);

  const settings = await getSettings(guild.id);
  const log = msg => sendLog(settings, guild, msg);

  try {
    await log('🔄 Nuke stopped. Waiting for in-flight deletions to settle…');
    await new Promise(r => setTimeout(r, 4000)); // let nuke bot's queued calls land

    const snapshot = await db.get(`snap.${guild.id}`);
    if (!snapshot?.length) {
      await log('❌ No pre-nuke snapshot found — cannot restore. A snapshot is saved automatically on the first channel deletion.');
      return;
    }

    await log(`🔄 Restoring **${snapshot.length}** channels…`);

    let removed = 0, restored = 0, skipped = 0, failed = 0;

    // ── Step 1: delete channels the nuker created ─────────────────
    const snapIds  = new Set(snapshot.map(c => c.id));
    const nukeChs  = [...guild.channels.cache.values()].filter(c => !snapIds.has(c.id));
    for (const ch of nukeChs) {
      await ch.delete('Antinuke: auto-restore cleanup').catch(() => {});
      removed++;
      await new Promise(r => setTimeout(r, 300));
    }
    await new Promise(r => setTimeout(r, 2000));

    // ── Step 2: recreate categories first ────────────────────────
    const catMap = new Map(); // oldId → newId

    for (const ch of snapshot.filter(c => c.type === 4)) {
      // If the category wasn't deleted (still exists by ID), just remap it
      const byId = guild.channels.cache.get(ch.id);
      if (byId) { catMap.set(ch.id, byId.id); skipped++; continue; }

      const newCh = await makeChannel(guild, {
        name:     ch.name,
        type:     ch.type,
        position: ch.position,
        permissionOverwrites: ch.permissionOverwrites.map(p => ({
          id: p.id, type: p.type, allow: BigInt(p.allow), deny: BigInt(p.deny),
        })),
      });

      if (newCh) { catMap.set(ch.id, newCh.id); restored++; }
      else          failed++;

      await new Promise(r => setTimeout(r, 700));
    }

    // ── Step 3: recreate every other channel ─────────────────────
    for (const ch of snapshot.filter(c => c.type !== 4)) {
      // Skip unsupported types (threads etc.)
      if (!CREATABLE.has(ch.type)) { skipped++; continue; }

      // Already exists by ID (wasn't deleted)
      if (guild.channels.cache.has(ch.id)) { skipped++; continue; }

      // Resolve category: use newly created category, or the original if it survived
      const parentId = ch.parentId
        ? (catMap.get(ch.parentId) || null)
        : null;

      const opts = {
        name:     ch.name,
        type:     ch.type,
        position: ch.position,
        permissionOverwrites: ch.permissionOverwrites.map(p => ({
          id: p.id, type: p.type, allow: BigInt(p.allow), deny: BigInt(p.deny),
        })),
      };
      if (parentId)            opts.parent           = parentId;
      if (ch.topic)            opts.topic            = ch.topic;
      if (ch.nsfw)             opts.nsfw             = ch.nsfw;
      if (ch.rateLimitPerUser) opts.rateLimitPerUser = ch.rateLimitPerUser;
      if (ch.bitrate)          opts.bitrate          = ch.bitrate;
      if (ch.userLimit)        opts.userLimit        = ch.userLimit;

      const newCh = await makeChannel(guild, opts);
      if (newCh) restored++; else failed++;

      await new Promise(r => setTimeout(r, 700));
    }

    await log(
      `✅ **Done** — removed **${removed}** nuke channels, restored **${restored}**` +
      (skipped ? `, skipped **${skipped}** (already existed or unsupported type)` : '') +
      (failed  ? `, **${failed}** failed` : '') + '.'
    );

  } catch (e) {
    console.error('[autoRestore]', e);
  } finally {
    restoring.delete(guild.id);
  }
}

// ─────────────────────────────────────────────
//  READY
// ─────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
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
  const roles = (await db.get(`autorole.${guild.id}.roles`)) || [];
  for (const rid of roles) {
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

  // ── Prefetch audit log immediately (parallel with everything else) ──
  prefetch(guild, AuditLogEvent.ChannelDelete);

  // ── Take full guild snapshot on the first deletion of each wave ──
  // 30-second cooldown ensures rapid deletions share one pre-nuke snapshot.
  try {
    const lastSnap = await db.get(`snap.${guild.id}.time`);
    if (!lastSnap || Date.now() - lastSnap > 30_000) {
      const all = new Map(guild.channels.cache);
      all.set(channel.id, channel); // include the one being deleted right now
      await db.set(`snap.${guild.id}`,      [...all.values()].map(snap));
      await db.set(`snap.${guild.id}.time`, Date.now());
    }
  } catch {}

  // ── Fast in-memory threshold check (no DB, no await) ──
  if (!crossed('channelDelete', guild.id)) return;

  // ── Threshold crossed ─────────────────────────────────────────────
  const settings = await getSettings(guild.id);
  if (!settings.enabled) return;

  // The prefetch started earlier — by now the audit log result is likely back
  const exec = await getExec(guild, AuditLogEvent.ChannelDelete);
  if (!exec || isTrusted(settings, exec.id, guild.ownerId, guild.members.me?.id)) return;

  await sendLog(settings, guild, `🚨 **Antinuke** — **${exec.tag}** is nuking! Banning + auto-restoring channels…`);
  await punish(guild, exec.id);
  autoRestore(guild); // runs in background — no await so punish lands instantly
});

client.on('roleDelete', async role => {
  if (!role.guild || restoring.has(role.guild.id)) return;
  prefetch(role.guild, AuditLogEvent.RoleDelete);
  if (!crossed('roleDelete', role.guild.id)) return;

  const settings = await getSettings(role.guild.id);
  if (!settings.enabled) return;

  const exec = await getExec(role.guild, AuditLogEvent.RoleDelete);
  if (!exec || isTrusted(settings, exec.id, role.guild.ownerId, role.guild.members.me?.id)) return;

  await sendLog(settings, role.guild, `🚨 **Antinuke** — **${exec.tag}** is mass-deleting roles! Banning…`);
  await punish(role.guild, exec.id);
});

client.on('guildBanAdd', async ban => {
  prefetch(ban.guild, AuditLogEvent.MemberBan);
  if (!crossed('ban', ban.guild.id)) return;

  const settings = await getSettings(ban.guild.id);
  if (!settings.enabled) return;

  const exec = await getExec(ban.guild, AuditLogEvent.MemberBan);
  if (!exec || isTrusted(settings, exec.id, ban.guild.ownerId, ban.guild.members.me?.id)) return;

  await sendLog(settings, ban.guild, `🚨 **Antinuke** — **${exec.tag}** is mass-banning! Banning…`);
  await punish(ban.guild, exec.id);
});

client.on('guildMemberRemove', async member => {
  if (!crossed('kick', member.guild.id)) return;

  const settings = await getSettings(member.guild.id);
  if (!settings.enabled) return;

  try {
    const logs  = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 1 });
    const entry = logs.entries.first();
    if (!entry?.executor || entry.target?.id !== member.id) return;
    if (Date.now() - entry.createdTimestamp > 3000) return;
    if (isTrusted(settings, entry.executor.id, member.guild.ownerId, member.guild.members.me?.id)) return;

    await sendLog(settings, member.guild, `🚨 **Antinuke** — **${entry.executor.tag}** is mass-kicking! Banning…`);
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

  // -cmds
  if (cmd === 'cmds' || cmd === 'commands' || cmd === 'help') {
    return message.reply({ embeds:[new EmbedBuilder().setColor(0x5865f2).setTitle('📋 Commands')
      .addFields(
        { name:'🔨 Moderation', value:['`-ban @user [reason]`','`-kick @user [reason]`','`-timeout @user <60s|5m|10m|1h|1d|1w> [reason]`','`-warn @user <reason>`','`-warnings @user`','`-warnings clear @user`','`-purge <1-100>`','`-purge @user <1-100>`'].join('\n') },
        { name:'🎭 Roles',      value:'`-role add @user <name>` or `-role remove @user <name>`' },
        { name:'👋 Welcome',    value:['`-setwelcome #channel`','`-setwelcome message <text>`','`-setwelcome disable`','`-setwelcome test`'].join('\n') },
        { name:'⚙️ Config',     value:['`-autorole add @role`','`-autorole remove @role`','`-autorole list`'].join('\n') },
        { name:'🛡️ Antinuke (owner only)', value:['`-antinuke enable` — enable + auto-restore on detection','`-antinuke disable`','`-antinuke setlog #channel`','`-antinuke whitelist add/remove @user`','`-antinuke status`','`-antinuke restore` — manually trigger restore','`-antinuke restore clear`'].join('\n') },
      )
      .setFooter({ text:`Prefix: ${PREFIX}  •  Auto-restore fires instantly on nuke detection — no command needed` })] });
  }

  // -ban
  if (cmd === 'ban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply('❌ You need **Ban Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(()=>null);
    if (!t) return message.reply('❌ Usage: `-ban @user [reason]`');
    const r = args.slice(1).join(' ') || 'No reason provided';
    if (t.id===message.author.id) return message.reply('❌ You cannot ban yourself.');
    if (t.id===message.guild.ownerId) return message.reply('❌ You cannot ban the server owner.');
    if (!t.bannable) return message.reply("❌ I can't ban that user.");
    if (message.member.roles.highest.position<=t.roles.highest.position) return message.reply('❌ That user has an equal or higher role than you.');
    await t.send({ embeds:[new EmbedBuilder().setColor(0xff4444).setTitle(`Banned from ${message.guild.name}`).addFields({name:'Reason',value:r})] }).catch(()=>{});
    await t.ban({ reason:`${message.author.tag}: ${r}` });
    message.reply({ embeds:[new EmbedBuilder().setColor(0xff4444).setTitle('🔨 Banned').addFields({name:'User',value:t.user.tag,inline:true},{name:'Moderator',value:message.author.tag,inline:true},{name:'Reason',value:r}).setTimestamp()] });
  }

  // -kick
  else if (cmd === 'kick') {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) return message.reply('❌ You need **Kick Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(()=>null);
    if (!t) return message.reply('❌ Usage: `-kick @user [reason]`');
    const r = args.slice(1).join(' ') || 'No reason provided';
    if (t.id===message.author.id) return message.reply('❌ You cannot kick yourself.');
    if (t.id===message.guild.ownerId) return message.reply('❌ You cannot kick the server owner.');
    if (!t.kickable) return message.reply("❌ I can't kick that user.");
    if (message.member.roles.highest.position<=t.roles.highest.position) return message.reply('❌ That user has an equal or higher role than you.');
    await t.send({ embeds:[new EmbedBuilder().setColor(0xff8800).setTitle(`Kicked from ${message.guild.name}`).addFields({name:'Reason',value:r})] }).catch(()=>{});
    await t.kick(`${message.author.tag}: ${r}`);
    message.reply({ embeds:[new EmbedBuilder().setColor(0xff8800).setTitle('👢 Kicked').addFields({name:'User',value:t.user.tag,inline:true},{name:'Moderator',value:message.author.tag,inline:true},{name:'Reason',value:r}).setTimestamp()] });
  }

  // -timeout
  else if (cmd === 'timeout' || cmd === 'mute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('❌ You need **Timeout Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(()=>null);
    if (!t) return message.reply('❌ Usage: `-timeout @user <60s|5m|10m|1h|1d|1w> [reason]`');
    const d={'60s':60,'5m':300,'10m':600,'1h':3600,'1d':86400,'1w':604800};
    const dk=args[1]?.toLowerCase(), s=d[dk];
    if (!s) return message.reply('❌ Duration: `60s` `5m` `10m` `1h` `1d` `1w`');
    const r=args.slice(2).join(' ')||'No reason provided';
    if (!t.moderatable) return message.reply("❌ I can't timeout that user.");
    if (message.member.roles.highest.position<=t.roles.highest.position) return message.reply('❌ That user has an equal or higher role than you.');
    await t.timeout(s*1000,`${message.author.tag}: ${r}`);
    message.reply({ embeds:[new EmbedBuilder().setColor(0xffcc00).setTitle('⏱️ Timed Out').addFields({name:'User',value:t.user.tag,inline:true},{name:'Duration',value:dk,inline:true},{name:'Moderator',value:message.author.tag,inline:true},{name:'Reason',value:r}).setTimestamp()] });
  }

  // -warn
  else if (cmd === 'warn') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('❌ You need **Timeout Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(()=>null);
    if (!t) return message.reply('❌ Usage: `-warn @user <reason>`');
    const r=args.slice(1).join(' ');
    if (!r) return message.reply('❌ Please provide a reason.');
    if (t.id===message.author.id) return message.reply('❌ You cannot warn yourself.');
    const key=`warnings.${message.guild.id}.${t.id}`;
    await db.push(key,{reason:r,moderator:message.author.tag,date:new Date().toISOString()});
    const count=((await db.get(key))||[]).length;
    await t.send({ embeds:[new EmbedBuilder().setColor(0xffcc00).setTitle(`Warned in ${message.guild.name}`).addFields({name:'Reason',value:r},{name:'Warning #',value:String(count)})] }).catch(()=>{});
    message.reply({ embeds:[new EmbedBuilder().setColor(0xffcc00).setTitle('⚠️ Warned').addFields({name:'User',value:t.user.tag,inline:true},{name:'Warning #',value:String(count),inline:true},{name:'Moderator',value:message.author.tag,inline:true},{name:'Reason',value:r}).setTimestamp()] });
  }

  // -warnings
  else if (cmd === 'warnings' || cmd === 'warns') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('❌ You need **Timeout Members** permission.');
    const isClear=args[0]?.toLowerCase()==='clear';
    const t=isClear ? message.mentions.users.first()||await client.users.fetch(args[1]).catch(()=>null) : message.mentions.users.first()||await client.users.fetch(args[0]).catch(()=>null);
    if (!t) return message.reply('❌ Usage: `-warnings @user` or `-warnings clear @user`');
    const key=`warnings.${message.guild.id}.${t.id}`;
    if (isClear) { await db.delete(key); return message.reply(`✅ Cleared all warnings for **${t.tag}**.`); }
    const list=(await db.get(key))||[];
    if (!list.length) return message.reply(`✅ **${t.tag}** has no warnings.`);
    const lines=list.slice(-10).reverse().map((w,i)=>`**${list.length-i}.** ${w.reason}\n> by ${w.moderator} • <t:${Math.floor(new Date(w.date).getTime()/1000)}:R>`);
    message.reply({ embeds:[new EmbedBuilder().setColor(0xffcc00).setTitle(`⚠️ Warnings for ${t.tag}`).setDescription(lines.join('\n\n')).setFooter({text:`Total: ${list.length}`}).setTimestamp()] });
  }

  // -purge
  else if (cmd === 'purge') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('❌ You need **Manage Messages** permission.');
    const fm=message.mentions.members.first(), amount=parseInt(fm?args[1]:args[0]);
    if (isNaN(amount)||amount<1||amount>100) return message.reply('❌ Usage: `-purge <1-100>` or `-purge @user <1-100>`');
    await message.delete().catch(()=>{});
    const fetched=await message.channel.messages.fetch({limit:fm?100:amount});
    const toDelete=fm?[...fetched.filter(m=>m.author.id===fm.id).values()].slice(0,amount):[...fetched.values()];
    const deleted=await message.channel.bulkDelete(toDelete,true);
    const c=await message.channel.send({ embeds:[new EmbedBuilder().setColor(0x00cc44).setDescription(`🗑️ Deleted **${deleted.size}** messages.`)] });
    setTimeout(()=>c.delete().catch(()=>{}),4000);
  }

  // -role
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
    if (role.managed) return message.reply('❌ That role is managed by an integration.');
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

  // -setwelcome
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
      const cid=await db.get(`welcome.${gid}.channel`);
      if (!cid) return message.reply('❌ Set a channel first.');
      const chan=message.guild.channels.cache.get(cid);
      if (!chan) return message.reply('❌ Channel no longer exists.');
      let msg=await db.get(`welcome.${gid}.message`);
      if (msg) { msg=msg.replace(/{user}/g,`<@${message.author.id}>`).replace(/{username}/g,message.author.username).replace(/{server}/g,message.guild.name).replace(/{memberCount}/g,message.guild.memberCount); await chan.send(msg); }
      else { await chan.send({ embeds:[new EmbedBuilder().setColor(0x5865f2).setTitle(`Welcome to ${message.guild.name}!`).setDescription(`Hey <@${message.author.id}>, member **#${message.guild.memberCount}**!`).setThumbnail(message.author.displayAvatarURL()).setTimestamp()] }); }
      return message.reply(`✅ Test sent to ${chan}.`);
    }
    message.reply('❌ Usage: `-setwelcome #channel` | `message <text>` | `disable` | `test`');
  }

  // -autorole
  else if (cmd === 'autorole') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return message.reply('❌ You need **Manage Roles** permission.');
    const sub=args[0]?.toLowerCase(), key=`autorole.${message.guild.id}.roles`, role=message.mentions.roles.first();
    if (sub==='add') {
      if (!role) return message.reply('❌ Usage: `-autorole add @role`');
      if (message.guild.members.me.roles.highest.position<=role.position) return message.reply("❌ That role is above my highest role.");
      const roles=(await db.get(key))||[];
      if (roles.includes(role.id)) return message.reply(`❌ **${role.name}** already an autorole.`);
      roles.push(role.id); await db.set(key,roles);
      return message.reply(`✅ **${role.name}** will be given to all new members.`);
    }
    if (sub==='remove') {
      if (!role) return message.reply('❌ Usage: `-autorole remove @role`');
      const roles=(await db.get(key))||[];
      if (!roles.includes(role.id)) return message.reply(`❌ Not an autorole.`);
      await db.set(key,roles.filter(id=>id!==role.id));
      return message.reply(`✅ Removed **${role.name}** from autoroles.`);
    }
    if (sub==='list') {
      const roles=(await db.get(key))||[];
      if (!roles.length) return message.reply('❌ No autoroles set.');
      return message.reply({ embeds:[new EmbedBuilder().setColor(0x5865f2).setTitle('🎭 Autoroles').setDescription(roles.map(id=>{ const r=message.guild.roles.cache.get(id); return r?`• ${r}`:`• Unknown`; }).join('\n')).setFooter({text:`${roles.length} role(s)`})] });
    }
    message.reply('❌ Usage: `-autorole add @role` | `remove @role` | `list`');
  }

  // -antinuke (owner only)
  else if (cmd === 'antinuke' || cmd === 'an') {
    if (message.author.id !== message.guild.ownerId) return message.reply('❌ Only the **server owner** can manage antinuke.');
    const sub=args[0]?.toLowerCase(), gid=message.guild.id;

    if (sub==='enable') {
      await db.set(`antinuke.${gid}.enabled`,true); clearCache(gid);
      return message.reply({ embeds:[new EmbedBuilder().setColor(0x00cc44).setTitle('🛡️ Antinuke Enabled')
        .setDescription([
          '**Triggers at:** 2 deletions / bans / kicks within 4 seconds',
          '**On trigger:** instantly bans the nuker + auto-restores all channels',
          '',
          '⚠️ **Important:** Give this bot the highest role so it can ban anyone.',
          'Use `-antinuke setlog #channel` to receive alerts.',
          'Use `-antinuke whitelist add @user` to trust your admins.',
        ].join('\n'))] });
    }
    if (sub==='disable') { await db.set(`antinuke.${gid}.enabled`,false); clearCache(gid); return message.reply('✅ Antinuke disabled.'); }
    if (sub==='setlog') {
      const ch=message.mentions.channels.first();
      if (!ch) return message.reply('❌ Usage: `-antinuke setlog #channel`');
      await db.set(`antinuke.${gid}.logChannel`,ch.id); clearCache(gid);
      return message.reply(`✅ Antinuke alerts → ${ch}.`);
    }
    if (sub==='whitelist') {
      const action=args[1]?.toLowerCase(), user=message.mentions.users.first();
      if (!['add','remove'].includes(action)||!user) return message.reply('❌ Usage: `-antinuke whitelist add @user` or `remove @user`');
      const wk=`antinuke.${gid}.whitelist`; let list=(await db.get(wk))||[];
      if (action==='add') {
        if (list.includes(user.id)) return message.reply(`❌ Already whitelisted.`);
        list.push(user.id); await db.set(wk,list); clearCache(gid);
        return message.reply(`✅ **${user.tag}** whitelisted.`);
      } else {
        if (!list.includes(user.id)) return message.reply(`❌ Not whitelisted.`);
        await db.set(wk,list.filter(id=>id!==user.id)); clearCache(gid);
        return message.reply(`✅ **${user.tag}** removed from whitelist.`);
      }
    }
    if (sub==='status') {
      const s=await getSettings(gid), snapTime=await db.get(`snap.${gid}.time`), snapData=(await db.get(`snap.${gid}`))||[];
      return message.reply({ embeds:[new EmbedBuilder().setColor(s.enabled?0x00cc44:0xff4444).setTitle('🛡️ Antinuke Status')
        .addFields(
          {name:'Status',      value:s.enabled?'✅ Enabled':'❌ Disabled',                                                           inline:true},
          {name:'Log Channel', value:s.logChannel?`<#${s.logChannel}>`:'Not set',                                                    inline:true},
          {name:'Snapshot',    value:snapTime?`${snapData.length} ch • <t:${Math.floor(snapTime/1000)}:R>`:'None yet',               inline:true},
          {name:'Whitelist',   value:s.whitelist.length?s.whitelist.map(id=>`<@${id}>`).join(', '):'None'},
        ).setTimestamp()] });
    }
    if (sub==='restore') {
      if (args[1]?.toLowerCase()==='clear') { await db.delete(`snap.${gid}`); await db.delete(`snap.${gid}.time`); return message.reply('✅ Snapshot cleared.'); }
      if (!(await db.get(`snap.${gid}`))?.length) return message.reply('❌ No snapshot found.');
      await message.reply('⏳ Starting manual restore…');
      autoRestore(message.guild);
      return;
    }
    message.reply('❌ Usage: `enable` | `disable` | `setlog #ch` | `whitelist add/remove @user` | `status` | `restore` | `restore clear`');
  }
});

client.login(process.env.BOT_TOKEN);
