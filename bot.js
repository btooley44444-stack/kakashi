const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, PermissionFlagsBits,
  AuditLogEvent, ActivityType,
} = require('discord.js');
const { QuickDB } = require('quick.db');

const db      = new QuickDB();
const client  = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildInvites,   // ← required for invite tracking
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.GuildMember],
});

const PREFIX      = '-';
const restoring   = new Set();
const snapCooldown = new Map();

// ─────────────────────────────────────────────
//  INVITE CACHE  (guildId → Map(code → { uses, inviterId }))
// ─────────────────────────────────────────────
const inviteCache = new Map();

async function cacheInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(
      guild.id,
      new Map(invites.map(i => [i.code, { uses: i.uses, inviterId: i.inviter?.id ?? null }]))
    );
  } catch {}
}

// ─────────────────────────────────────────────
//  SETTINGS CACHE
// ─────────────────────────────────────────────
const settCache = new Map();
async function getSettings(gid) {
  if (settCache.has(gid)) return settCache.get(gid);
  const s = {
    enabled:    !!(await db.get(`antinuke.${gid}.enabled`)),
    whitelist:  (await db.get(`antinuke.${gid}.whitelist`)) || [],
    logChannel: await db.get(`antinuke.${gid}.logChannel`),
  };
  settCache.set(gid, s);
  return s;
}
function clearCache(gid) { settCache.delete(gid); }

// ─────────────────────────────────────────────
//  IN-MEMORY COUNTERS
// ─────────────────────────────────────────────
const counters = { ch: new Map(), role: new Map(), ban: new Map(), kick: new Map() };
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
//  AUDIT LOG PREFETCH
// ─────────────────────────────────────────────
const prefetchMap = new Map();
function prefetch(guild, type) {
  const k = `${guild.id}:${type}`;
  if (!prefetchMap.has(k)) {
    prefetchMap.set(k, guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null));
    setTimeout(() => prefetchMap.delete(k), 5000);
  }
}
async function getExec(guild, type) {
  const k = `${guild.id}:${type}`;
  const [pre, fresh] = await Promise.all([
    prefetchMap.get(k) || Promise.resolve(null),
    guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null),
  ]);
  return (fresh?.entries.first() || pre?.entries.first())?.executor || null;
}

// ─────────────────────────────────────────────
//  SNAPSHOT
// ─────────────────────────────────────────────
function snapCh(ch) {
  return {
    id: ch.id, name: ch.name, type: ch.type,
    parentId: ch.parentId || null, position: ch.position,
    topic: ch.topic || null, nsfw: ch.nsfw || false,
    rateLimitPerUser: ch.rateLimitPerUser || 0,
    bitrate: ch.bitrate || null, userLimit: ch.userLimit || null,
    permissionOverwrites: ch.permissionOverwrites.cache.map(p => ({
      id: p.id, type: p.type,
      allow: p.allow.bitfield.toString(),
      deny:  p.deny.bitfield.toString(),
    })),
  };
}

async function saveSnapshot(guild, channels) {
  const list = channels || [...guild.channels.cache.values()];
  await db.set(`snap.${guild.id}`,      list.map(snapCh));
  await db.set(`snap.${guild.id}.time`, Date.now());
  console.log(`[snap] ${guild.name}: saved ${list.length} channels`);
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
async function sendLog(guild, msg) {
  const s = await getSettings(guild.id);
  if (s.logChannel) guild.channels.cache.get(s.logChannel)?.send(msg).catch(() => {});
}

function buildPerms(overwrites) {
  try {
    return overwrites.map(p => ({
      id: p.id, type: p.type,
      allow: BigInt(p.allow || '0'),
      deny:  BigInt(p.deny  || '0'),
    }));
  } catch { return []; }
}

async function makeChannel(guild, opts) {
  try { return await guild.channels.create(opts); } catch {}
  try {
    const { permissionOverwrites: _, ...clean } = opts;
    return await guild.channels.create(clean);
  } catch { return null; }
}

const CREATABLE = new Set([0, 2, 4, 5, 13, 15]);

// ─────────────────────────────────────────────
//  AUTO-RESTORE
// ─────────────────────────────────────────────
async function autoRestore(guild) {
  if (restoring.has(guild.id)) return;
  restoring.add(guild.id);
  try {
    await sendLog(guild, '🔄 Nuke stopped. Waiting 4s before restoring…');
    await new Promise(r => setTimeout(r, 4000));

    const snapshot = await db.get(`snap.${guild.id}`);
    if (!snapshot?.length) {
      await sendLog(guild, '❌ No snapshot. Enable antinuke and wait for a periodic snapshot (every 30s).');
      return;
    }

    console.log(`[restore] Starting — snapshot has ${snapshot.length} channels`);
    await sendLog(guild, `🔄 Snapshot has **${snapshot.length}** channels. Restoring…`);

    let removed = 0, restored = 0, skipped = 0, failed = 0;

    const snapIds = new Set(snapshot.map(c => c.id));
    const nukeChs = [...guild.channels.cache.values()].filter(c => !snapIds.has(c.id));
    console.log(`[restore] Deleting ${nukeChs.length} nuke channels`);
    await Promise.all(nukeChs.map(c => c.delete('Antinuke restore').catch(() => {})));
    removed = nukeChs.length;
    await new Promise(r => setTimeout(r, 2000));

    const catMap = new Map();
    const categories = snapshot.filter(c => c.type === 4);
    console.log(`[restore] Creating ${categories.length} categories`);

    for (const ch of categories) {
      try {
        const existing = guild.channels.cache.find(c => c.name === ch.name && c.type === 4);
        if (existing) {
          catMap.set(ch.id, existing.id);
          skipped++;
          continue;
        }
        const newCh = await makeChannel(guild, {
          name: ch.name, type: ch.type, position: ch.position,
          permissionOverwrites: buildPerms(ch.permissionOverwrites),
        });
        if (newCh) { catMap.set(ch.id, newCh.id); restored++; }
        else failed++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 500));
    }

    const channels = snapshot.filter(c => c.type !== 4);
    for (const ch of channels) {
      try {
        if (!CREATABLE.has(ch.type)) { skipped++; continue; }
        const existing = guild.channels.cache.find(c => c.name === ch.name && c.type === ch.type);
        if (existing) { skipped++; continue; }
        const parentId = ch.parentId ? catMap.get(ch.parentId) : null;
        const opts = {
          name: ch.name, type: ch.type, position: ch.position,
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
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 500));
    }

    const msg = `✅ Done — removed **${removed}** nuke channels, restored **${restored}**${skipped ? `, skipped **${skipped}**` : ''}${failed ? `, **${failed}** failed` : ''}.`;
    console.log(`[restore] ${msg}`);
    await sendLog(guild, msg);

  } catch (e) {
    console.error('[autoRestore fatal]', e);
  } finally {
    restoring.delete(guild.id);
  }
}

// ─────────────────────────────────────────────
//  READY
// ─────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} online`);
  client.user.setPresence({
    activities: [{ name: '.gg/rasengan', type: ActivityType.Watching }],
    status: 'online',
  });

  for (const guild of client.guilds.cache.values()) {
    try {
      const s = await getSettings(guild.id);
      if (s.enabled) await saveSnapshot(guild);
    } catch {}
    await cacheInvites(guild); // cache invites for all guilds on startup
  }

  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const s = await getSettings(guild.id);
        if (s.enabled && !restoring.has(guild.id)) {
          await saveSnapshot(guild);
          snapCooldown.set(guild.id, Date.now());
        }
      } catch {}
    }
  }, 30 * 1000);
});

// Cache invites when bot joins a new guild
client.on('guildCreate', guild => cacheInvites(guild));

// Keep invite cache fresh when invites are created/deleted
client.on('inviteCreate', invite => {
  if (!invite.guild) return;
  const cache = inviteCache.get(invite.guild.id) || new Map();
  cache.set(invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviter?.id ?? null });
  inviteCache.set(invite.guild.id, cache);
});

client.on('inviteDelete', invite => {
  if (!invite.guild) return;
  inviteCache.get(invite.guild.id)?.delete(invite.code);
});

// ─────────────────────────────────────────────
//  WELCOME + AUTOROLE  (with invite tracking)
// ─────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  const { guild, user } = member;

  // ── Detect which invite was used ──────────────────────────────
  let inviter      = null;
  let inviterCount = 0;

  try {
    const oldCache  = inviteCache.get(guild.id) || new Map();
    const newInvites = await guild.invites.fetch();

    for (const [code, inv] of newInvites) {
      const old = oldCache.get(code);
      // This invite's use count went up — it's the one that was used
      if (old !== undefined && inv.uses > old.uses) {
        const inviterId = inv.inviter?.id ?? old.inviterId;
        if (inviterId) {
          inviter = await client.users.fetch(inviterId).catch(() => null);
          // Persist the invite count so it survives restarts
          const key     = `invites.${guild.id}.${inviterId}`;
          const current = (await db.get(key)) ?? 0;
          await db.set(key, current + 1);
          inviterCount = current + 1;
        }
        break;
      }
    }

    // Update in-memory cache with fresh data
    inviteCache.set(
      guild.id,
      new Map(newInvites.map(i => [i.code, { uses: i.uses, inviterId: i.inviter?.id ?? null }]))
    );
  } catch {}

  // ── Welcome message ───────────────────────────────────────────
  const chId = await db.get(`welcome.${guild.id}.channel`);
  if (chId) {
    // Try cache first; fall back to API fetch (this was the main bug)
    const ch = guild.channels.cache.get(chId)
      ?? await guild.channels.fetch(chId).catch(() => null);

    let msg = await db.get(`welcome.${guild.id}.message`);
    if (ch) {
      if (msg) {
        // Replace all supported placeholders
        msg = msg
          .replace(/{user}/g,          `<@${user.id}>`)
          .replace(/{username}/g,       user.username)
          .replace(/{server}/g,         guild.name)
          .replace(/{memberCount}/g,    guild.memberCount)
          .replace(/{inviter}/g,        inviter ? `<@${inviter.id}>` : 'Unknown')
          .replace(/{inviterTag}/g,     inviter?.tag ?? 'Unknown')
          .replace(/{inviterCount}/g,   String(inviterCount));
        ch.send(msg).catch(() => {});
      } else {
        // Default embed — shows inviter when known
        const desc = inviter
          ? `Hey <@${user.id}>, you are member **#${guild.memberCount}**!\n\nInvited by **${inviter.tag}** · **${inviterCount}** invite${inviterCount !== 1 ? 's' : ''}`
          : `Hey <@${user.id}>, you are member **#${guild.memberCount}**!`;
        ch.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle(`Welcome to ${guild.name}!`)
              .setDescription(desc)
              .setThumbnail(user.displayAvatarURL())
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    }
  }

  // ── Autorole ──────────────────────────────────────────────────
  for (const rid of (await db.get(`autorole.${guild.id}.roles`)) || []) {
    const r = guild.roles.cache.get(rid);
    if (r && guild.members.me.roles.highest.position > r.position) member.roles.add(r).catch(() => {});
  }
});

// ─────────────────────────────────────────────
//  ANTINUKE EVENTS
// ─────────────────────────────────────────────
client.on('channelDelete', async channel => {
  if (!channel.guild || restoring.has(channel.guild.id)) return;
  const { guild } = channel;

  const capturedChannels = [...guild.channels.cache.values()];
  if (!capturedChannels.find(c => c.id === channel.id)) {
    capturedChannels.push(channel);
  }

  prefetch(guild, AuditLogEvent.ChannelDelete);

  const now = Date.now();
  const lastSnap = snapCooldown.get(guild.id) || 0;
  if (now - lastSnap > 5000) {
    snapCooldown.set(guild.id, now);
    db.set(`snap.${guild.id}`, capturedChannels.map(snapCh)).catch(() => {});
    db.set(`snap.${guild.id}.time`, now).catch(() => {});
    console.log(`[snap] ${guild.name}: captured ${capturedChannels.length} channels on deletion`);
  }

  if (!crossed(counters.ch, guild.id)) return;

  const s = await getSettings(guild.id);
  if (!s.enabled) return;

  const exec = await getExec(guild, AuditLogEvent.ChannelDelete);
  if (!exec || trusted(s, exec.id, guild.ownerId, guild.members.me?.id)) return;

  await sendLog(guild, `🚨 **Antinuke** — **${exec.tag}** is nuking! Banning + restoring…`);
  await punish(guild, exec.id);
  autoRestore(guild);
});

client.on('roleDelete', async role => {
  if (!role.guild || restoring.has(role.guild.id)) return;
  prefetch(role.guild, AuditLogEvent.RoleDelete);
  if (!crossed(counters.role, role.guild.id)) return;
  const s = await getSettings(role.guild.id);
  if (!s.enabled) return;
  const exec = await getExec(role.guild, AuditLogEvent.RoleDelete);
  if (!exec || trusted(s, exec.id, role.guild.ownerId, role.guild.members.me?.id)) return;
  await sendLog(role.guild, `🚨 **Antinuke** — **${exec.tag}** mass-deleting roles! Banning…`);
  await punish(role.guild, exec.id);
});

client.on('guildBanAdd', async ban => {
  prefetch(ban.guild, AuditLogEvent.MemberBan);
  if (!crossed(counters.ban, ban.guild.id)) return;
  const s = await getSettings(ban.guild.id);
  if (!s.enabled) return;
  const exec = await getExec(ban.guild, AuditLogEvent.MemberBan);
  if (!exec || trusted(s, exec.id, ban.guild.ownerId, ban.guild.members.me?.id)) return;
  await sendLog(ban.guild, `🚨 **Antinuke** — **${exec.tag}** mass-banning! Banning…`);
  await punish(ban.guild, exec.id);
});

client.on('guildMemberRemove', async member => {
  if (!crossed(counters.kick, member.guild.id)) return;
  const s = await getSettings(member.guild.id);
  if (!s.enabled) return;
  try {
    const logs  = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 1 });
    const entry = logs.entries.first();
    if (!entry?.executor || entry.target?.id !== member.id) return;
    if (Date.now() - entry.createdTimestamp > 3000) return;
    if (trusted(s, entry.executor.id, member.guild.ownerId, member.guild.members.me?.id)) return;
    await sendLog(member.guild, `🚨 **Antinuke** — **${entry.executor.tag}** mass-kicking! Banning…`);
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

  // ── -cmds ──────────────────────────────────────────────────────
  if (cmd === 'cmds' || cmd === 'commands' || cmd === 'help') {
    return message.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📋 Commands').addFields(
        { name: '🔨 Moderation', value: '`-ban @user [reason]`\n`-kick @user [reason]`\n`-timeout @user <60s|5m|10m|1h|1d|1w> [reason]`\n`-unmute @user`\n`-warn @user <reason>`\n`-warnings @user`\n`-warnings clear @user`\n`-purge <1-100>`\n`-purge @user <1-100>`\n`-lock [#channel] [reason]`\n`-unlock [#channel] [reason]`' },
        { name: '🎭 Roles',      value: '`-role add @user <name>`\n`-role remove @user <name>`' },
        { name: '📨 Invites',    value: '`-invites [@user]` — see invite count\n`-inviteleaderboard` — top inviters\n`-invites reset @user` — reset someone\'s count (admin)' },
        { name: '👋 Welcome',    value: '`-setwelcome #channel`\n`-setwelcome message <text>`\n`-setwelcome disable`\n`-setwelcome test`\n\nPlaceholders: `{user}` `{username}` `{server}` `{memberCount}` `{inviter}` `{inviterTag}` `{inviterCount}`' },
        { name: '⚙️ Config',     value: '`-autorole add @role`\n`-autorole remove @role`\n`-autorole list`' },
        { name: '🛡️ Antinuke (owner only)', value: '`-antinuke enable`\n`-antinuke disable`\n`-antinuke setlog #channel`\n`-antinuke whitelist add/remove @user`\n`-antinuke snapshot` — manually save snapshot\n`-antinuke status`\n`-antinuke restore`\n`-antinuke restore clear`' },
      ).setFooter({ text: `Prefix: ${PREFIX}  •  Snapshot auto-saves every 30s` })],
    });
  }

  // ── -invites ───────────────────────────────────────────────────
  if (cmd === 'invites') {
    const isReset  = args[0]?.toLowerCase() === 'reset';
    const target   = message.mentions.users.first() ?? message.author;

    if (isReset) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return message.reply('❌ You need **Manage Server** permission.');
      const resetTarget = message.mentions.users.first();
      if (!resetTarget) return message.reply('❌ Usage: `-invites reset @user`');
      await db.set(`invites.${message.guild.id}.${resetTarget.id}`, 0);
      return message.reply(`✅ Reset invite count for **${resetTarget.tag}**.`);
    }

    const count = (await db.get(`invites.${message.guild.id}.${target.id}`)) ?? 0;
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📨 Invite Count')
          .setDescription(`**${target.tag}** has **${count}** invite${count !== 1 ? 's' : ''} in **${message.guild.name}**.`)
          .setThumbnail(target.displayAvatarURL())
          .setTimestamp(),
      ],
    });
  }

  // ── -inviteleaderboard ─────────────────────────────────────────
  if (cmd === 'inviteleaderboard' || cmd === 'invlb') {
    // Fetch all members and their stored invite counts
    const members = await message.guild.members.fetch().catch(() => null);
    if (!members) return message.reply('❌ Could not fetch members.');

    const entries = [];
    for (const [uid] of members) {
      const count = (await db.get(`invites.${message.guild.id}.${uid}`)) ?? 0;
      if (count > 0) entries.push({ uid, count });
    }

    entries.sort((a, b) => b.count - a.count);
    const top = entries.slice(0, 10);

    if (!top.length) return message.reply('❌ No invite data yet.');

    const lines = top.map((e, i) => `**${i + 1}.** <@${e.uid}> — **${e.count}** invite${e.count !== 1 ? 's' : ''}`);
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📨 Invite Leaderboard')
          .setDescription(lines.join('\n'))
          .setFooter({ text: `${message.guild.name} • Top ${top.length}` })
          .setTimestamp(),
      ],
    });
  }

  // ── -ban ───────────────────────────────────────────────────────
  if (cmd === 'ban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers))
      return message.reply('❌ You need **Ban Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(() => null);
    if (!t) return message.reply('❌ Usage: `-ban @user [reason]`');
    const r = args.slice(1).join(' ') || 'No reason provided';
    if (t.id === message.author.id) return message.reply('❌ Cannot ban yourself.');
    if (t.id === message.guild.ownerId) return message.reply('❌ Cannot ban the server owner.');
    if (!t.bannable) return message.reply("❌ I can't ban that user.");
    if (message.member.roles.highest.position <= t.roles.highest.position)
      return message.reply('❌ That user has an equal or higher role.');
    await t.send({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle(`Banned from ${message.guild.name}`).addFields({ name: 'Reason', value: r })] }).catch(() => {});
    await t.ban({ reason: `${message.author.tag}: ${r}` });
    message.reply({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('🔨 Banned').addFields({ name: 'User', value: t.user.tag, inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }, { name: 'Reason', value: r }).setTimestamp()] });
  }

  // ── -kick ──────────────────────────────────────────────────────
  else if (cmd === 'kick') {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers))
      return message.reply('❌ You need **Kick Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(() => null);
    if (!t) return message.reply('❌ Usage: `-kick @user [reason]`');
    const r = args.slice(1).join(' ') || 'No reason provided';
    if (t.id === message.author.id) return message.reply('❌ Cannot kick yourself.');
    if (t.id === message.guild.ownerId) return message.reply('❌ Cannot kick the server owner.');
    if (!t.kickable) return message.reply("❌ I can't kick that user.");
    if (message.member.roles.highest.position <= t.roles.highest.position)
      return message.reply('❌ That user has an equal or higher role.');
    await t.send({ embeds: [new EmbedBuilder().setColor(0xff8800).setTitle(`Kicked from ${message.guild.name}`).addFields({ name: 'Reason', value: r })] }).catch(() => {});
    await t.kick(`${message.author.tag}: ${r}`);
    message.reply({ embeds: [new EmbedBuilder().setColor(0xff8800).setTitle('👢 Kicked').addFields({ name: 'User', value: t.user.tag, inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }, { name: 'Reason', value: r }).setTimestamp()] });
  }

  // ── -timeout ───────────────────────────────────────────────────
  else if (cmd === 'timeout' || cmd === 'mute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return message.reply('❌ You need **Timeout Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(() => null);
    if (!t) return message.reply('❌ Usage: `-timeout @user <60s|5m|10m|1h|1d|1w> [reason]`');
    const dur = { '60s': 60, '5m': 300, '10m': 600, '1h': 3600, '1d': 86400, '1w': 604800 };
    const dk = args[1]?.toLowerCase(), secs = dur[dk];
    if (!secs) return message.reply('❌ Duration: `60s` `5m` `10m` `1h` `1d` `1w`');
    const r = args.slice(2).join(' ') || 'No reason provided';
    if (!t.moderatable) return message.reply("❌ I can't timeout that user.");
    if (message.member.roles.highest.position <= t.roles.highest.position)
      return message.reply('❌ That user has an equal or higher role.');
    await t.timeout(secs * 1000, `${message.author.tag}: ${r}`);
    message.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('⏱️ Timed Out').addFields({ name: 'User', value: t.user.tag, inline: true }, { name: 'Duration', value: dk, inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }, { name: 'Reason', value: r }).setTimestamp()] });
  }

  // ── -unmute ────────────────────────────────────────────────────
  else if (cmd === 'unmute' || cmd === 'untimeout') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return message.reply('❌ You need **Timeout Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(() => null);
    if (!t) return message.reply('❌ Usage: `-unmute @user`');
    if (!t.isCommunicationDisabled()) return message.reply('❌ That user is not timed out.');
    if (!t.moderatable) return message.reply("❌ I can't unmute that user.");
    await t.timeout(null, `Unmuted by ${message.author.tag}`);
    message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('🔊 Unmuted').addFields({ name: 'User', value: t.user.tag, inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }).setTimestamp()] });
  }

  // ── -warn ──────────────────────────────────────────────────────
  else if (cmd === 'warn') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return message.reply('❌ You need **Timeout Members** permission.');
    const t = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(() => null);
    if (!t) return message.reply('❌ Usage: `-warn @user <reason>`');
    const r = args.slice(1).join(' ');
    if (!r) return message.reply('❌ Provide a reason.');
    if (t.id === message.author.id) return message.reply('❌ Cannot warn yourself.');
    const key = `warnings.${message.guild.id}.${t.id}`;
    await db.push(key, { reason: r, moderator: message.author.tag, date: new Date().toISOString() });
    const count = ((await db.get(key)) || []).length;
    await t.send({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle(`Warned in ${message.guild.name}`).addFields({ name: 'Reason', value: r }, { name: 'Warning #', value: String(count) })] }).catch(() => {});
    message.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('⚠️ Warned').addFields({ name: 'User', value: t.user.tag, inline: true }, { name: 'Warning #', value: String(count), inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }, { name: 'Reason', value: r }).setTimestamp()] });
  }

  // ── -warnings ──────────────────────────────────────────────────
  else if (cmd === 'warnings' || cmd === 'warns') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return message.reply('❌ You need **Timeout Members** permission.');
    const isClear = args[0]?.toLowerCase() === 'clear';
    const t = isClear
      ? message.mentions.users.first() || await client.users.fetch(args[1]).catch(() => null)
      : message.mentions.users.first() || await client.users.fetch(args[0]).catch(() => null);
    if (!t) return message.reply('❌ Usage: `-warnings @user` or `-warnings clear @user`');
    const key = `warnings.${message.guild.id}.${t.id}`;
    if (isClear) { await db.delete(key); return message.reply(`✅ Cleared warnings for **${t.tag}**.`); }
    const list = (await db.get(key)) || [];
    if (!list.length) return message.reply(`✅ **${t.tag}** has no warnings.`);
    const lines = list.slice(-10).reverse().map((w, i) =>
      `**${list.length - i}.** ${w.reason}\n> by ${w.moderator} • <t:${Math.floor(new Date(w.date).getTime() / 1000)}:R>`
    );
    message.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle(`⚠️ Warnings — ${t.tag}`).setDescription(lines.join('\n\n')).setFooter({ text: `Total: ${list.length}` }).setTimestamp()] });
  }

  // ── -purge ─────────────────────────────────────────────────────
  else if (cmd === 'purge') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
      return message.reply('❌ You need **Manage Messages** permission.');
    const fm = message.mentions.members.first();
    const amount = parseInt(fm ? args[1] : args[0]);
    if (isNaN(amount) || amount < 1 || amount > 100)
      return message.reply('❌ Usage: `-purge <1-100>` or `-purge @user <1-100>`');
    await message.delete().catch(() => {});
    const fetched = await message.channel.messages.fetch({ limit: fm ? 100 : amount });
    const toDelete = fm
      ? [...fetched.filter(m => m.author.id === fm.id).values()].slice(0, amount)
      : [...fetched.values()];
    const deleted = await message.channel.bulkDelete(toDelete, true);
    const conf = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x00cc44).setDescription(`🗑️ Deleted **${deleted.size}** messages.`)] });
    setTimeout(() => conf.delete().catch(() => {}), 4000);
  }

  // ── -lock / -unlock ────────────────────────────────────────────
  else if (cmd === 'lock' || cmd === 'unlock') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels))
      return message.reply('❌ You need **Manage Channels** permission.');
    const ch = message.mentions.channels.first() ?? message.channel;
    if (!ch.isTextBased()) return message.reply('❌ That channel cannot be locked.');
    const everyone = message.guild.roles.everyone;
    const reason   = args.filter(a => !a.startsWith('<')).join(' ') || 'No reason provided';
    if (cmd === 'lock') {
      await ch.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: `Locked by ${message.author.tag}: ${reason}` });
      message.reply({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('🔒 Channel Locked').addFields({ name: 'Channel', value: `${ch}`, inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }, { name: 'Reason', value: reason }).setTimestamp()] });
    } else {
      await ch.permissionOverwrites.edit(everyone, { SendMessages: null }, { reason: `Unlocked by ${message.author.tag}: ${reason}` });
      message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('🔓 Channel Unlocked').addFields({ name: 'Channel', value: `${ch}`, inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }, { name: 'Reason', value: reason }).setTimestamp()] });
    }
  }

  // ── -role ──────────────────────────────────────────────────────
  else if (cmd === 'role') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles))
      return message.reply('❌ You need **Manage Roles** permission.');
    const sub = args[0]?.toLowerCase();
    const t   = message.mentions.members.first();
    if (!['add', 'remove'].includes(sub))
      return message.reply('❌ Usage: `-role add @user <name>` or `-role remove @user <name>`');
    if (!t) return message.reply('❌ Please mention a user.');
    const rn = args.slice(2).join(' ');
    if (!rn) return message.reply('❌ Please provide a role name.');
    const role = message.mentions.roles.first() || message.guild.roles.cache.find(r => r.name.toLowerCase() === rn.toLowerCase());
    if (!role) return message.reply(`❌ No role named **${rn}**.`);
    if (message.guild.members.me.roles.highest.position <= role.position) return message.reply("❌ That role is above my highest role.");
    if (message.member.roles.highest.position <= role.position) return message.reply("❌ That role is above your highest role.");
    if (role.managed) return message.reply('❌ Managed by an integration.');
    if (sub === 'add') {
      if (t.roles.cache.has(role.id)) return message.reply(`❌ ${t} already has **${role.name}**.`);
      await t.roles.add(role, `Added by ${message.author.tag}`);
      message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('✅ Role Added').addFields({ name: 'Member', value: `${t}`, inline: true }, { name: 'Role', value: role.name, inline: true })] });
    } else {
      if (!t.roles.cache.has(role.id)) return message.reply(`❌ ${t} doesn't have **${role.name}**.`);
      await t.roles.remove(role, `Removed by ${message.author.tag}`);
      message.reply({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('✅ Role Removed').addFields({ name: 'Member', value: `${t}`, inline: true }, { name: 'Role', value: role.name, inline: true })] });
    }
  }

  // ── -setwelcome ────────────────────────────────────────────────
  else if (cmd === 'setwelcome') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
      return message.reply('❌ You need **Manage Server** permission.');
    const gid = message.guild.id;
    const ch  = message.mentions.channels.first();
    if (ch) { await db.set(`welcome.${gid}.channel`, ch.id); return message.reply(`✅ Welcome channel set to ${ch}.`); }
    const sub = args[0]?.toLowerCase();
    if (sub === 'message') {
      const text = args.slice(1).join(' ');
      if (!text) return message.reply('❌ Usage: `-setwelcome message Hello {user}!`');
      await db.set(`welcome.${gid}.message`, text);
      return message.reply('✅ Set! Placeholders: `{user}` `{username}` `{server}` `{memberCount}` `{inviter}` `{inviterTag}` `{inviterCount}`');
    }
    if (sub === 'disable') {
      await db.delete(`welcome.${gid}.channel`); await db.delete(`welcome.${gid}.message`);
      return message.reply('✅ Disabled.');
    }
    if (sub === 'test') {
      const cid = await db.get(`welcome.${gid}.channel`);
      if (!cid) return message.reply('❌ Set a channel first.');
      const chan = guild.channels.cache.get(cid) ?? await message.guild.channels.fetch(cid).catch(() => null);
      if (!chan) return message.reply('❌ Channel no longer exists.');
      let msg = await db.get(`welcome.${gid}.message`);
      if (msg) {
        msg = msg
          .replace(/{user}/g,          `<@${message.author.id}>`)
          .replace(/{username}/g,       message.author.username)
          .replace(/{server}/g,         message.guild.name)
          .replace(/{memberCount}/g,    message.guild.memberCount)
          .replace(/{inviter}/g,        `<@${message.author.id}>`)
          .replace(/{inviterTag}/g,     message.author.tag)
          .replace(/{inviterCount}/g,   '1');
        await chan.send(msg);
      } else {
        await chan.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle(`Welcome to ${message.guild.name}!`)
              .setDescription(`Hey <@${message.author.id}>, member **#${message.guild.memberCount}**!\n\nInvited by **${message.author.tag}** · **1** invite (test)`)
              .setThumbnail(message.author.displayAvatarURL())
              .setTimestamp(),
          ],
        });
      }
      return message.reply(`✅ Test sent to ${chan}.`);
    }
    message.reply('❌ Usage: `-setwelcome #channel` | `message <text>` | `disable` | `test`');
  }

  // ── -autorole ──────────────────────────────────────────────────
  else if (cmd === 'autorole') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles))
      return message.reply('❌ You need **Manage Roles** permission.');
    const sub  = args[0]?.toLowerCase();
    const key  = `autorole.${message.guild.id}.roles`;
    const role = message.mentions.roles.first();
    if (sub === 'add') {
      if (!role) return message.reply('❌ Usage: `-autorole add @role`');
      if (message.guild.members.me.roles.highest.position <= role.position) return message.reply("❌ That role is above my highest role.");
      const roles = (await db.get(key)) || [];
      if (roles.includes(role.id)) return message.reply('❌ Already an autorole.');
      roles.push(role.id); await db.set(key, roles);
      return message.reply(`✅ **${role.name}** will be given to new members.`);
    }
    if (sub === 'remove') {
      if (!role) return message.reply('❌ Usage: `-autorole remove @role`');
      const roles = (await db.get(key)) || [];
      if (!roles.includes(role.id)) return message.reply('❌ Not an autorole.');
      await db.set(key, roles.filter(id => id !== role.id));
      return message.reply(`✅ Removed **${role.name}**.`);
    }
    if (sub === 'list') {
      const roles = (await db.get(key)) || [];
      if (!roles.length) return message.reply('❌ No autoroles.');
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎭 Autoroles').setDescription(roles.map(id => { const r = message.guild.roles.cache.get(id); return r ? `• ${r}` : '• Unknown'; }).join('\n')).setFooter({ text: `${roles.length} role(s)` })] });
    }
    message.reply('❌ Usage: `add @role` | `remove @role` | `list`');
  }

  // ── -antinuke ──────────────────────────────────────────────────
  else if (cmd === 'antinuke' || cmd === 'an') {
    if (message.author.id !== message.guild.ownerId)
      return message.reply('❌ Only the **server owner** can manage antinuke.');
    const sub = args[0]?.toLowerCase();
    const gid = message.guild.id;

    if (sub === 'enable') {
      await db.set(`antinuke.${gid}.enabled`, true); clearCache(gid);
      await saveSnapshot(message.guild);
      snapCooldown.set(gid, Date.now());
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('🛡️ Antinuke Enabled')
        .setDescription('**Triggers at:** 2 deletions / bans / kicks in 4s\n**On trigger:** bans nuker + auto-restores channels\n**Snapshot:** taken now, refreshes every 30s\n\n⚠️ Give this bot the **highest role** so it can ban anyone.\n`-antinuke setlog #channel` — receive alerts\n`-antinuke whitelist add @user` — trust your admins')] });
    }
    if (sub === 'disable') {
      await db.set(`antinuke.${gid}.enabled`, false); clearCache(gid);
      return message.reply('✅ Antinuke disabled.');
    }
    if (sub === 'setlog') {
      const ch = message.mentions.channels.first();
      if (!ch) return message.reply('❌ Usage: `-antinuke setlog #channel`');
      await db.set(`antinuke.${gid}.logChannel`, ch.id); clearCache(gid);
      return message.reply(`✅ Alerts → ${ch}.`);
    }
    if (sub === 'snapshot') {
      await saveSnapshot(message.guild);
      snapCooldown.set(gid, Date.now());
      const snap = (await db.get(`snap.${gid}`)) || [];
      return message.reply(`✅ Snapshot saved — **${snap.length}** channels captured.`);
    }
    if (sub === 'whitelist') {
      const action = args[1]?.toLowerCase();
      const user   = message.mentions.users.first();
      if (!['add', 'remove'].includes(action) || !user)
        return message.reply('❌ Usage: `whitelist add/remove @user`');
      const wk = `antinuke.${gid}.whitelist`;
      let list = (await db.get(wk)) || [];
      if (action === 'add') {
        if (list.includes(user.id)) return message.reply('❌ Already whitelisted.');
        list.push(user.id); await db.set(wk, list); clearCache(gid);
        return message.reply(`✅ **${user.tag}** whitelisted.`);
      } else {
        if (!list.includes(user.id)) return message.reply('❌ Not whitelisted.');
        await db.set(wk, list.filter(id => id !== user.id)); clearCache(gid);
        return message.reply(`✅ **${user.tag}** removed.`);
      }
    }
    if (sub === 'status') {
      const s        = await getSettings(gid);
      const snapTime = await db.get(`snap.${gid}.time`);
      const snapData = (await db.get(`snap.${gid}`)) || [];
      return message.reply({ embeds: [new EmbedBuilder().setColor(s.enabled ? 0x00cc44 : 0xff4444).setTitle('🛡️ Antinuke Status')
        .addFields(
          { name: 'Status',      value: s.enabled ? '✅ Enabled' : '❌ Disabled',                                              inline: true },
          { name: 'Log Channel', value: s.logChannel ? `<#${s.logChannel}>` : 'Not set',                                      inline: true },
          { name: 'Snapshot',    value: snapTime ? `${snapData.length} channels • <t:${Math.floor(snapTime / 1000)}:R>` : 'None', inline: true },
          { name: 'Whitelist',   value: s.whitelist.length ? s.whitelist.map(id => `<@${id}>`).join(', ') : 'None' },
        ).setTimestamp()] });
    }
    if (sub === 'restore') {
      if (args[1]?.toLowerCase() === 'clear') {
        await db.delete(`snap.${gid}`); await db.delete(`snap.${gid}.time`);
        return message.reply('✅ Snapshot cleared.');
      }
      const snap = await db.get(`snap.${gid}`);
      if (!snap?.length) return message.reply('❌ No snapshot. Run `-antinuke snapshot` first.');
      await message.reply(`⏳ Starting restore (${snap.length} channels in snapshot)…`);
      autoRestore(message.guild);
      return;
    }
    message.reply('❌ Subcommands: `enable` `disable` `setlog #ch` `snapshot` `whitelist add/remove @user` `status` `restore` `restore clear`');
  }
});

client.login(process.env.BOT_TOKEN);
