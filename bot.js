const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, PermissionFlagsBits,
  AuditLogEvent, ActivityType, Collection,
  ActionRowBuilder, StringSelectMenuBuilder, ComponentType,
  AttachmentBuilder,
} = require('discord.js');
const { QuickDB } = require('quick.db');
const crypto = require('crypto');

const db      = new QuickDB();
const client  = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.GuildMember, Partials.Message, Partials.Reaction],
});

// ─────────────────────────────────────────────
//  SMALL HELPERS
// ─────────────────────────────────────────────
const hashPw = pw => crypto.createHash('sha256').update(pw).digest('hex');

// Safe placeholder replacement — plain .replace(str) breaks if a username
// contains "$&" or "$'", so always use a function replacement.
function fillPlaceholders(template, map) {
  let out = template;
  for (const [key, value] of Object.entries(map)) {
    out = out.replace(new RegExp(`\\{${key}\\}`, 'g'), () => String(value));
  }
  return out;
}

// Resolve a member from a mention or a raw ID arg.
// IMPORTANT: never call guild.members.fetch(undefined) — that fetches the
// ENTIRE member list and returns a truthy Collection, breaking the !t check.
async function resolveMember(message, arg) {
  const mentioned = message.mentions.members.first();
  if (mentioned) return mentioned;
  if (!arg || !/^\d{15,21}$/.test(arg)) return null;
  return message.guild.members.fetch(arg).catch(() => null);
}

async function resolveUser(message, arg) {
  const mentioned = message.mentions.users.first();
  if (mentioned) return mentioned;
  if (!arg || !/^\d{15,21}$/.test(arg)) return null;
  return client.users.fetch(arg).catch(() => null);
}

// ─────────────────────────────────────────────
//  GIVEAWAY / MUTE TIMERS
// ─────────────────────────────────────────────
const giveawayTimers = new Map();
const muteTimers     = new Map();

// ─────────────────────────────────────────────
//  MUTE ROLE HELPER
//  The role is stored by ID (not looked up by name) so a renamed role or a
//  fake second "Muted" role can't break or hijack the mute system.
// ─────────────────────────────────────────────
async function getMuteRole(guild, createIfMissing = true) {
  const storedId = await db.get(`muterole.${guild.id}`);
  if (storedId) {
    const role = guild.roles.cache.get(storedId) ?? await guild.roles.fetch(storedId).catch(() => null);
    if (role) return role;
    await db.delete(`muterole.${guild.id}`); // role was deleted — fall through
  }
  if (!createIfMissing) return null;

  const role = await guild.roles.create({
    name: 'Muted',
    color: 0x808080,
    permissions: [],
    reason: 'Auto-created for -mute command',
  });
  await db.set(`muterole.${guild.id}`, role.id);

  for (const ch of guild.channels.cache.values()) {
    if (ch.isTextBased() || ch.type === 2) {
      await ch.permissionOverwrites.edit(role, {
        SendMessages:           false,
        SendMessagesInThreads:  false,
        AddReactions:           false,
        Speak:                  false,
      }).catch(() => {});
    }
  }
  console.log(`[mute] Created Muted role in ${guild.name}`);
  return role;
}

async function unmuteUser(guild, userId, reason) {
  const muteRole = await getMuteRole(guild, false);
  if (muteRole) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member?.roles.cache.has(muteRole.id)) {
      await member.roles.remove(muteRole, reason).catch(() => {});
    }
  }
  await db.delete(`mutes.${guild.id}.${userId}`);
  muteTimers.delete(`${guild.id}:${userId}`);
}

function parseDuration(str) {
  if (!str) return null;
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const match  = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const ms = parseInt(match[1]) * units[match[2].toLowerCase()];
  if (ms < 1000 || ms > 7 * 86400000) return null;
  return ms;
}

function formatDuration(ms) {
  if (ms >= 86400000) return `${Math.round(ms / 86400000)}d`;
  if (ms >= 3600000)  return `${Math.round(ms / 3600000)}h`;
  if (ms >= 60000)    return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

// ─────────────────────────────────────────────
//  GIVEAWAY END
// ─────────────────────────────────────────────
async function endGiveaway(guildId, messageId, reroll = false) {
  const data = await db.get(`giveaways.${guildId}.${messageId}`);
  if (!data) return console.warn(`[giveaway] No data for ${messageId}`);
  if (!reroll && !data.active) return;

  // Clear the timer to prevent a double-fire if -gend is used while timer is running
  if (!reroll) {
    clearTimeout(giveawayTimers.get(messageId));
    giveawayTimers.delete(messageId);
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return console.error(`[giveaway] Guild not found: ${guildId}`);

  let channel = guild.channels.cache.get(data.channelId);
  if (!channel) channel = await guild.channels.fetch(data.channelId).catch(() => null);
  if (!channel) return console.error(`[giveaway] Channel not found: ${data.channelId}`);

  // Always fetch fresh from API so reactions are up to date
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) return console.error(`[giveaway] Message not found: ${messageId}`);

  const reaction = msg.reactions.cache.find(r => r.emoji.name === '🎉');
  let users = new Collection();
  if (reaction) {
    const fetched = await reaction.users.fetch().catch(() => null);
    if (fetched) users = fetched.filter(u => !u.bot);
  }

  // Mark inactive AFTER fetching users so a silent error doesn't kill the giveaway
  if (!reroll) {
    await db.set(`giveaways.${guildId}.${messageId}`, { ...data, active: false });
  }

  if (users.size === 0) {
    await msg.edit({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('🎉 GIVEAWAY ENDED').setDescription(`**${data.prize}**\n\nNo valid entries — no winner.`).setFooter({ text: `${data.winnerCount} winner(s) • Ended` }).setTimestamp()] }).catch(() => {});
    await channel.send({ embeds: [new EmbedBuilder().setColor(0xff4444).setDescription(`🎉 The giveaway for **${data.prize}** ended with no valid entries.`)] }).catch(() => {});
    return;
  }

  // Pick winners randomly without repeats
  const pool = [...users.values()];
  const count = Math.min(data.winnerCount, pool.length);
  const winners = [];
  while (winners.length < count) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }

  const mentions = winners.map(w => `<@${w.id}>`).join(', ');
  // allowedMentions: only ping the actual winners, never roles/everyone
  await msg.edit({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎉 GIVEAWAY ENDED').setDescription(`**${data.prize}**\n\n🏆 Winner${count > 1 ? 's' : ''}: ${mentions}`).setFooter({ text: `${count} winner(s) • Ended` }).setTimestamp()] }).catch(() => {});
  await channel.send({
    content: mentions,
    embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(`🎉 Congrats ${mentions}! You won **${data.prize}**!\n\n*Hosted by <@${data.hostId}>*`)],
    allowedMentions: { users: winners.map(w => w.id) },
  }).catch(() => {});

  if (!reroll) {
    await db.set(`giveaways.${guildId}.${messageId}`, { ...data, active: false, lastWinners: winners.map(w => w.id) });
  }

  console.log(`[giveaway] Ended ${messageId} in ${guild.name} — winners: ${winners.map(w => w.tag).join(', ')}`);
}

function scheduleGiveaway(guildId, messageId, endsAt) {
  if (giveawayTimers.has(messageId)) clearTimeout(giveawayTimers.get(messageId));
  const delay = Math.max(endsAt - Date.now(), 0);
  const timer = setTimeout(() => endGiveaway(guildId, messageId), delay);
  giveawayTimers.set(messageId, timer);
  console.log(`[giveaway] Scheduled ${messageId} to end in ${formatDuration(delay)}`);
}

const PREFIX       = '-';
const restoring    = new Set();
const snapCooldown = new Map();
const pendingPassword = new Map();

// ─────────────────────────────────────────────
//  AUTOMOD SETTINGS + CACHE
// ─────────────────────────────────────────────
const amCache = new Map();
async function getAutomod(gid) {
  if (amCache.has(gid)) return amCache.get(gid);
  const s = (await db.get(`automod.${gid}`)) || {};
  const cfg = {
    enabled:     !!s.enabled,
    antispam:    s.antispam    !== false, // default on
    antilink:    !!s.antilink,
    anticaps:    !!s.anticaps,
    antimention: s.antimention !== false, // default on
    filter:      s.filter || [],
  };
  amCache.set(gid, cfg);
  return cfg;
}
function clearAmCache(gid) { amCache.delete(gid); }

const spamMap = new Map(); // "gid:uid" -> [timestamps]

// Temporary mute used by automod (reuses the same mute system as -mute)
async function tempMute(guild, member, ms, reason) {
  const muteRole = await getMuteRole(guild).catch(() => null);
  if (!muteRole) return false;
  if (guild.members.me.roles.highest.position <= muteRole.position) return false;
  if (member.roles.cache.has(muteRole.id)) return true;
  const ok = await member.roles.add(muteRole, reason).then(() => true).catch(() => false);
  if (!ok) return false;
  const endsAt = Date.now() + ms;
  await db.set(`mutes.${guild.id}.${member.id}`, { endsAt, reason, moderatorId: client.user.id });
  clearTimeout(muteTimers.get(`${guild.id}:${member.id}`));
  muteTimers.set(`${guild.id}:${member.id}`, setTimeout(() => unmuteUser(guild, member.id, 'Mute expired'), ms));
  return true;
}

// ─────────────────────────────────────────────
//  MOD LOG
// ─────────────────────────────────────────────
async function modLog(guild, embed) {
  const cid = await db.get(`modlog.${guild.id}`);
  if (!cid) return;
  const ch = guild.channels.cache.get(cid) ?? await guild.channels.fetch(cid).catch(() => null);
  if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

// ─────────────────────────────────────────────
//  SNIPE (last deleted message per channel)
// ─────────────────────────────────────────────
const snipes = new Map(); // channelId -> { content, authorTag, authorAvatar, time }

// ─────────────────────────────────────────────
//  REMINDERS
// ─────────────────────────────────────────────
const reminderTimers = new Map();
function scheduleReminder(id, rem) {
  clearTimeout(reminderTimers.get(id));
  const delay = Math.max(rem.endsAt - Date.now(), 0);
  reminderTimers.set(id, setTimeout(async () => {
    reminderTimers.delete(id);
    await db.delete(`reminders.${id}`).catch(() => {});
    const ch = client.channels.cache.get(rem.channelId) ?? await client.channels.fetch(rem.channelId).catch(() => null);
    if (!ch) return;
    ch.send({
      content: `<@${rem.userId}>`,
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⏰ Reminder').setDescription(rem.text).setTimestamp()],
      allowedMentions: { users: [rem.userId] },
    }).catch(() => {});
  }, delay));
}

// ─────────────────────────────────────────────
//  FUN DATA
// ─────────────────────────────────────────────
const EIGHTBALL = [
  'It is certain.', 'Without a doubt.', 'Yes, definitely.', 'You may rely on it.',
  'As I see it, yes.', 'Most likely.', 'Outlook good.', 'Yes.', 'Signs point to yes.',
  'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.',
  'Cannot predict now.', 'Concentrate and ask again.',
  "Don't count on it.", 'My reply is no.', 'My sources say no.',
  'Outlook not so good.', 'Very doubtful.', 'Absolutely not.',
];
const POLL_EMOJIS = ['🇦', '🇧', '🇨', '🇩', '🇪', '🇫', '🇬', '🇭', '🇮', '🇯'];

// ─────────────────────────────────────────────
//  SHIP CARD IMAGE (needs: npm install @napi-rs/canvas)
//  Falls back to a text embed if the library isn't installed.
// ─────────────────────────────────────────────
let canvasLib = null;
try { canvasLib = require('@napi-rs/canvas'); } catch { console.warn('[ship] @napi-rs/canvas not installed — ship cards will be text-only'); }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawHeart(ctx, cx, cy, w, h, color) {
  const top = h * 0.3;
  ctx.beginPath();
  ctx.moveTo(cx, cy + top);
  ctx.bezierCurveTo(cx, cy, cx - w / 2, cy, cx - w / 2, cy + top);
  ctx.bezierCurveTo(cx - w / 2, cy + (h + top) / 2, cx, cy + (h + top) / 1.4, cx, cy + h);
  ctx.bezierCurveTo(cx, cy + (h + top) / 1.4, cx + w / 2, cy + (h + top) / 2, cx + w / 2, cy + top);
  ctx.bezierCurveTo(cx + w / 2, cy, cx, cy, cx, cy + top);
  ctx.fillStyle = color;
  ctx.fill();
}

async function makeShipCard(a, b, score) {
  const { createCanvas, loadImage } = canvasLib;
  const W = 700, H = 310;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const color = score >= 70 ? '#ff4d8d' : score >= 40 ? '#ffaa33' : '#8899aa';

  const [imgA, imgB] = await Promise.all([
    loadImage(a.displayAvatarURL({ extension: 'png', size: 256 })),
    loadImage(b.displayAvatarURL({ extension: 'png', size: 256 })),
  ]);

  // avatars in circles with a colored ring
  const r = 85, yC = 125;
  const drawAvatar = (img, xC) => {
    ctx.save();
    ctx.beginPath(); ctx.arc(xC, yC, r, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
    ctx.drawImage(img, xC - r, yC - r, r * 2, r * 2);
    ctx.restore();
    ctx.beginPath(); ctx.arc(xC, yC, r, 0, Math.PI * 2);
    ctx.lineWidth = 6; ctx.strokeStyle = color; ctx.stroke();
  };
  drawAvatar(imgA, 130);
  drawAvatar(imgB, 570);

  // heart between them (broken-hearted gray at low scores)
  drawHeart(ctx, 350, yC - 55, 115, 115, score >= 40 ? '#ff4d6d' : '#556');

  // progress bar
  const bx = 100, by = 250, bw = 500, bh = 36, rad = 18;
  roundRect(ctx, bx, by, bw, bh, rad);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fill();
  if (score > 0) {
    const fw = Math.max((bw * score) / 100, rad * 2);
    roundRect(ctx, bx, by, fw, bh, rad);
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, '#ff9a9e');
    grad.addColorStop(1, '#ff2d6d');
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${score}%`, bx + bw / 2, by + bh / 2 + 1);

  return new AttachmentBuilder(await canvas.encode('png'), { name: 'ship.png' });
}

// ─────────────────────────────────────────────
//  HELP MENU DATA
// ─────────────────────────────────────────────
const HELP = {
  moderation: {
    emoji: '🔨', label: 'Moderation', desc: 'Bans, kicks, mutes, warns, purge, lock',
    commands: [
      ['ban @user [reason]', 'Ban a member (DMs them the reason)'],
      ['kick @user [reason]', 'Kick a member'],
      ['mute @user <duration> [reason]', 'Mute for 1s–7d, e.g. `30m` `2h` `1d`'],
      ['unmute @user', 'Remove a mute early'],
      ['warn @user <reason>', 'Warn a member'],
      ['warnings @user', 'View their last 10 warnings'],
      ['warnings clear @user', 'Wipe all their warnings'],
      ['purge <1-100>', 'Bulk delete recent messages'],
      ['purge @user <1-100>', 'Bulk delete one person\'s messages'],
      ['lock / unlock', 'Lock the channel (whitelist roles bypass)'],
      ['lockwhitelist add/remove/list @role', 'Roles that can type in locked channels'],
    ],
  },
  roles: {
    emoji: '🎭', label: 'Roles', desc: 'Role management and autoroles',
    commands: [
      ['role @user <role name>', 'Toggle a role — run again to remove it'],
      ['roleinfo <role>', 'Show role details and member count'],
      ['autorole add/remove/list @role', 'Roles auto-given to new members'],
    ],
  },
  invites: {
    emoji: '📨', label: 'Invites', desc: 'Who invited who, leaderboards',
    commands: [
      ['invites [@user]', 'See someone\'s invite count'],
      ['inviteleaderboard', 'Top 10 inviters in the server'],
      ['invites reset @user', 'Reset a count (needs Manage Server)'],
    ],
  },
  giveaways: {
    emoji: '🎉', label: 'Giveaways', desc: 'Create, end, and reroll giveaways',
    commands: [
      ['gcreate <duration> <winners> <prize>', 'Start a giveaway, e.g. `-gcreate 1d 2 Nitro`'],
      ['gend <messageId>', 'End a giveaway early'],
      ['greroll <messageId>', 'Pick new winners for an ended giveaway'],
      ['glist', 'List all active giveaways'],
    ],
  },
  fun: {
    emoji: '🎲', label: 'Fun', desc: '8ball, dice, ship, and more',
    commands: [
      ['8ball <question>', 'Ask the magic 8-ball'],
      ['coinflip', 'Heads or tails'],
      ['dice [sides]', 'Roll a die (default d6, up to d1000)'],
      ['rps <rock|paper|scissors>', 'Play against the bot'],
      ['choose a | b | c', 'Let the bot decide for you'],
      ['ship @user [@user2]', 'Compatibility check 💘'],
      ['mock <text>', 'sPoNgEbOb TeXt'],
      ['reverse <text>', 'Flip text backwards'],
    ],
  },
  utility: {
    emoji: '🔧', label: 'Utility', desc: 'Info, polls, AFK, reminders, snipe',
    commands: [
      ['userinfo [@user]', 'Account age, join date, roles'],
      ['serverinfo', 'Server stats at a glance'],
      ['avatar [@user]', 'Full-size avatar'],
      ['membercount', 'Current member count'],
      ['ping', 'Bot latency'],
      ['uptime', 'How long the bot\'s been online'],
      ['poll <question>', 'Quick 👍👎 poll'],
      ['poll question | opt1 | opt2', 'Multi-option poll (up to 10)'],
      ['snipe', 'Show the last deleted message here'],
      ['afk [reason]', 'Set AFK — auto-clears when you talk'],
      ['remindme <duration> <text>', 'Get pinged later, e.g. `-remindme 2h food`'],
      ['steal <emoji> [name]', 'Clone an emoji into this server'],
      ['stealsticker [name]', 'Reply to a sticker to clone it here'],
      ['say <message>', 'Make the bot say something (Manage Server)'],
    ],
  },
  automod: {
    emoji: '🧹', label: 'Automod & Logs', desc: 'Anti-spam, word filter, mod logs',
    commands: [
      ['automod enable/disable', 'Toggle automod (spam + mention-spam on by default)'],
      ['automod status', 'See what\'s on and off'],
      ['automod antispam on/off', '6 msgs in 5s → 5m mute'],
      ['automod antilink on/off', 'Delete links and invites'],
      ['automod anticaps on/off', 'Delete EXCESSIVE CAPS'],
      ['automod antimention on/off', '5+ pings → 5m mute'],
      ['automod filter add/remove/list <word>', 'Banned words (list is DMed)'],
      ['modlog #channel', 'Log deletes, edits, joins, bans, automod'],
      ['modlog disable', 'Turn off mod logging'],
    ],
  },
};

// ─────────────────────────────────────────────
//  INVITE CACHE
// ─────────────────────────────────────────────
const inviteCache = new Map();

async function cacheInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const cache = new Map(invites.map(i => [i.code, { uses: i.uses, inviterId: i.inviter?.id ?? null }]));
    try {
      const vanity = await guild.fetchVanityData();
      if (vanity?.code) cache.set(`vanity:${vanity.code}`, { uses: vanity.uses, inviterId: null });
    } catch {}
    inviteCache.set(guild.id, cache);
    console.log(`[invites] Cached ${cache.size} invite(s) for ${guild.name}`);
  } catch (e) {
    console.error(`[invites] Failed to cache invites for ${guild.name}:`, e.message);
  }
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
//  limit 3 in 4s — 2 was aggressive enough to ban a mod doing normal cleanup
// ─────────────────────────────────────────────
const counters = { ch: new Map(), role: new Map(), ban: new Map(), kick: new Map() };
function crossed(map, gid, window = 4000, limit = 3) {
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
// Only trust audit entries created in the last 5s — a stale entry means we'd
// blame (and ban) whoever happened to do that action last, minutes ago.
async function getExec(guild, type) {
  const k = `${guild.id}:${type}`;
  const [pre, fresh] = await Promise.all([
    prefetchMap.get(k) || Promise.resolve(null),
    guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null),
  ]);
  const entry = fresh?.entries.first() || pre?.entries.first();
  if (!entry) return null;
  if (Date.now() - entry.createdTimestamp > 5000) return null;
  return entry.executor;
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
    for (const ch of categories) {
      try {
        const existing = guild.channels.cache.find(c => c.name === ch.name && c.type === 4);
        if (existing) { catMap.set(ch.id, existing.id); skipped++; continue; }
        const newCh = await makeChannel(guild, {
          name: ch.name, type: ch.type, position: ch.position,
          permissionOverwrites: buildPerms(ch.permissionOverwrites),
        });
        if (newCh) { catMap.set(ch.id, newCh.id); restored++; } else failed++;
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
    await cacheInvites(guild);
  }

  // ── Reschedule active giveaways on restart ──────────────────
  // quick.db stores dot-notation keys as ONE nested object under the first
  // segment, so db.all() has an entry with id "giveaways" — filtering ids by
  // startsWith('giveaways.') matches nothing. Read the nested object instead.
  try {
    const allGiveaways = (await db.get('giveaways')) || {};
    let rescheduled = 0;
    for (const [guildId, msgs] of Object.entries(allGiveaways)) {
      if (!msgs || typeof msgs !== 'object') continue;
      for (const [messageId, data] of Object.entries(msgs)) {
        if (!data?.active) continue;
        if (Date.now() >= data.endsAt) {
          // Already expired while bot was offline — end immediately
          endGiveaway(guildId, messageId);
        } else {
          scheduleGiveaway(guildId, messageId, data.endsAt);
          rescheduled++;
        }
      }
    }
    if (rescheduled > 0) console.log(`[giveaway] Rescheduled ${rescheduled} active giveaway(s)`);
  } catch (e) {
    console.error('[giveaway] Failed to reschedule on startup:', e.message);
  }

  // ── Reschedule active mutes on restart ──────────────────────
  try {
    const allMutes = (await db.get('mutes')) || {};
    for (const [guildId, users] of Object.entries(allMutes)) {
      if (!users || typeof users !== 'object') continue;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      for (const [userId, data] of Object.entries(users)) {
        if (!data) continue;
        const remaining = data.endsAt - Date.now();
        if (remaining <= 0) {
          await unmuteUser(guild, userId, 'Mute expired');
        } else {
          const timer = setTimeout(() => unmuteUser(guild, userId, 'Mute expired'), remaining);
          muteTimers.set(`${guildId}:${userId}`, timer);
        }
      }
    }
  } catch (e) {
    console.error('[mute] Failed to reschedule mutes on startup:', e.message);
  }

  // ── Reschedule reminders on restart ─────────────────────────
  try {
    const allReminders = (await db.get('reminders')) || {};
    for (const [id, rem] of Object.entries(allReminders)) {
      if (rem?.endsAt) scheduleReminder(id, rem);
    }
  } catch (e) {
    console.error('[remind] Failed to reschedule reminders:', e.message);
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

client.on('guildCreate', guild => cacheInvites(guild));

client.on('channelCreate', async channel => {
  if (!channel.guild) return;
  const muteRole = await getMuteRole(channel.guild, false);
  if (!muteRole) return;
  if (channel.isTextBased() || channel.type === 2) {
    await channel.permissionOverwrites.edit(muteRole, {
      SendMessages:           false,
      SendMessagesInThreads:  false,
      AddReactions:           false,
      Speak:                  false,
    }).catch(() => {});
  }
});

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
//  LOGGING EVENTS  (modlog + snipe)
// ─────────────────────────────────────────────
client.on('messageDelete', async message => {
  if (!message.guild || message.partial || message.author?.bot) return;
  const content = message.content || '*[no text content]*';
  snipes.set(message.channel.id, {
    content,
    authorTag:    message.author.tag,
    authorAvatar: message.author.displayAvatarURL(),
    time:         Date.now(),
  });
  modLog(message.guild, new EmbedBuilder()
    .setColor(0xff4444).setTitle('🗑️ Message Deleted')
    .addFields(
      { name: 'Author',  value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Content', value: content.slice(0, 1024) },
    ).setTimestamp());
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (!newMsg.guild || newMsg.partial || oldMsg.partial || newMsg.author?.bot) return;
  if (oldMsg.content === newMsg.content) return;
  modLog(newMsg.guild, new EmbedBuilder()
    .setColor(0xffcc00).setTitle('✏️ Message Edited')
    .addFields(
      { name: 'Author',  value: `${newMsg.author.tag} (<@${newMsg.author.id}>)`, inline: true },
      { name: 'Channel', value: `<#${newMsg.channel.id}> — [Jump](${newMsg.url})`, inline: true },
      { name: 'Before',  value: (oldMsg.content || '*empty*').slice(0, 1024) },
      { name: 'After',   value: (newMsg.content || '*empty*').slice(0, 1024) },
    ).setTimestamp());
});

client.on('guildMemberAdd', member => {
  modLog(member.guild, new EmbedBuilder()
    .setColor(0x00cc44).setTitle('📥 Member Joined')
    .setDescription(`${member.user.tag} (<@${member.id}>)\nAccount created <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`)
    .setThumbnail(member.user.displayAvatarURL()).setTimestamp());
});

client.on('guildMemberRemove', member => {
  modLog(member.guild, new EmbedBuilder()
    .setColor(0xff8800).setTitle('📤 Member Left')
    .setDescription(`${member.user?.tag ?? member.id} (<@${member.id}>)`)
    .setTimestamp());
});

client.on('guildBanAdd', ban => {
  modLog(ban.guild, new EmbedBuilder()
    .setColor(0xff4444).setTitle('🔨 Member Banned')
    .setDescription(`${ban.user.tag} (<@${ban.user.id}>)`)
    .setTimestamp());
});

client.on('guildBanRemove', ban => {
  modLog(ban.guild, new EmbedBuilder()
    .setColor(0x00cc44).setTitle('🔓 Member Unbanned')
    .setDescription(`${ban.user.tag} (<@${ban.user.id}>)`)
    .setTimestamp());
});

// ─────────────────────────────────────────────
//  WELCOME + AUTOROLE
// ─────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  const { guild, user } = member;
  let inviter      = null;
  let inviterCount = 0;

  try {
    const cachedBefore = inviteCache.get(guild.id) || new Map();
    const newInvites   = await guild.invites.fetch();
    const newCache     = new Map(newInvites.map(i => [i.code, { uses: i.uses, inviterId: i.inviter?.id ?? null }]));
    try {
      const vanity = await guild.fetchVanityData();
      if (vanity?.code) newCache.set(`vanity:${vanity.code}`, { uses: vanity.uses, inviterId: null });
    } catch {}

    for (const [code, inv] of newCache) {
      const old = cachedBefore.get(code);
      if (old !== undefined && inv.uses > old.uses) {
        if (!code.startsWith('vanity:') && inv.inviterId) {
          inviter = await client.users.fetch(inv.inviterId).catch(() => null);
          const key     = `invites.${guild.id}.${inv.inviterId}`;
          const current = (await db.get(key)) ?? 0;
          await db.set(key, current + 1);
          inviterCount = current + 1;
        }
        break;
      }
    }
    if (!inviter) {
      for (const [code, old] of cachedBefore) {
        if (!newCache.has(code) && !code.startsWith('vanity:') && old.inviterId) {
          inviter = await client.users.fetch(old.inviterId).catch(() => null);
          const key     = `invites.${guild.id}.${old.inviterId}`;
          const current = (await db.get(key)) ?? 0;
          await db.set(key, current + 1);
          inviterCount = current + 1;
          break;
        }
      }
    }
    inviteCache.set(guild.id, newCache);
  } catch (e) {
    console.error(`[invites] Error tracking invite for ${user.tag}:`, e.message);
  }

  try {
    const chId = await db.get(`welcome.${guild.id}.channel`);
    if (chId) {
      const ch = guild.channels.cache.get(chId) ?? await guild.channels.fetch(chId).catch(() => null);
      if (ch) {
        const perms = ch.permissionsFor(guild.members.me);
        if (perms?.has(PermissionFlagsBits.ViewChannel) && perms?.has(PermissionFlagsBits.SendMessages)) {
          const template = await db.get(`welcome.${guild.id}.message`);
          if (template) {
            const msg = fillPlaceholders(template, {
              user:         `<@${user.id}>`,
              username:     user.username,
              server:       guild.name,
              memberCount:  guild.memberCount,
              inviter:      inviter ? `<@${inviter.id}>` : 'Unknown',
              inviterTag:   inviter?.tag ?? 'Unknown',
              inviterCount: inviterCount,
            });
            // only allow pinging the new member + inviter, never everyone/roles
            const allowedUsers = [user.id];
            if (inviter) allowedUsers.push(inviter.id);
            await ch.send({ content: msg, allowedMentions: { users: allowedUsers } });
          } else {
            const desc = inviter
              ? `Hey <@${user.id}>, you are member **#${guild.memberCount}**!\n\nInvited by **${inviter.tag}** · **${inviterCount}** invite${inviterCount !== 1 ? 's' : ''}`
              : `Hey <@${user.id}>, you are member **#${guild.memberCount}**!`;
            await ch.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`Welcome to ${guild.name}!`).setDescription(desc).setThumbnail(user.displayAvatarURL()).setTimestamp()] });
          }
        }
      }
    }
  } catch (e) {
    console.error(`[welcome] ${guild.name}: error —`, e.message);
  }

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
  if (!capturedChannels.find(c => c.id === channel.id)) capturedChannels.push(channel);
  prefetch(guild, AuditLogEvent.ChannelDelete);
  const now = Date.now();
  const lastSnap = snapCooldown.get(guild.id) || 0;
  if (now - lastSnap > 5000) {
    snapCooldown.set(guild.id, now);
    db.set(`snap.${guild.id}`, capturedChannels.map(snapCh)).catch(() => {});
    db.set(`snap.${guild.id}.time`, now).catch(() => {});
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

  // ── AUTOMOD ────────────────────────────────────────────────────
  // Mods (Manage Messages), the owner, and antinuke-whitelisted users are exempt.
  try {
    const am = await getAutomod(message.guild.id);
    const exempt = message.author.id === message.guild.ownerId
      || message.member?.permissions.has(PermissionFlagsBits.ManageMessages);
    if (am.enabled && !exempt) {
      const content = message.content ?? '';
      const lower   = content.toLowerCase();

      // word filter
      if (am.filter.length && am.filter.some(w => lower.includes(w))) {
        await message.delete().catch(() => {});
        message.channel.send(`⚠️ <@${message.author.id}>, that word isn't allowed here.`)
          .then(m => setTimeout(() => m.delete().catch(() => {}), 4000)).catch(() => {});
        modLog(message.guild, new EmbedBuilder().setColor(0xff4444).setTitle('🧹 Automod — Filtered Word')
          .setDescription(`**${message.author.tag}** in <#${message.channel.id}>:\n${content.slice(0, 500)}`).setTimestamp());
        return;
      }

      // anti-link (discord invites + urls)
      if (am.antilink && /(discord\.(gg|com\/invite)\/|https?:\/\/)/i.test(content)) {
        await message.delete().catch(() => {});
        message.channel.send(`⚠️ <@${message.author.id}>, links aren't allowed here.`)
          .then(m => setTimeout(() => m.delete().catch(() => {}), 4000)).catch(() => {});
        modLog(message.guild, new EmbedBuilder().setColor(0xff4444).setTitle('🧹 Automod — Link Removed')
          .setDescription(`**${message.author.tag}** in <#${message.channel.id}>:\n${content.slice(0, 500)}`).setTimestamp());
        return;
      }

      // anti-caps (>70% caps in messages longer than 8 letters)
      if (am.anticaps) {
        const letters = content.replace(/[^A-Za-z]/g, '');
        if (letters.length > 8 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) {
          await message.delete().catch(() => {});
          message.channel.send(`⚠️ <@${message.author.id}>, please don't use excessive caps.`)
            .then(m => setTimeout(() => m.delete().catch(() => {}), 4000)).catch(() => {});
          return;
        }
      }

      // anti mention-spam (5+ user mentions in one message → 5m mute)
      if (am.antimention && message.mentions.users.size >= 5) {
        await message.delete().catch(() => {});
        const muted = await tempMute(message.guild, message.member, 5 * 60000, 'Automod: mention spam');
        message.channel.send(`🔇 <@${message.author.id}> ${muted ? 'was muted for 5m' : 'was warned'} — mention spam.`)
          .then(m => setTimeout(() => m.delete().catch(() => {}), 6000)).catch(() => {});
        modLog(message.guild, new EmbedBuilder().setColor(0xff4444).setTitle('🧹 Automod — Mention Spam')
          .setDescription(`**${message.author.tag}** mentioned ${message.mentions.users.size} users in <#${message.channel.id}>.`).setTimestamp());
        return;
      }

      // anti-spam (6 messages within 5s → delete recent + 5m mute)
      if (am.antispam) {
        const key = `${message.guild.id}:${message.author.id}`;
        const now = Date.now();
        const times = (spamMap.get(key) || []).filter(t => now - t < 5000);
        times.push(now);
        spamMap.set(key, times);
        if (times.length >= 6) {
          spamMap.delete(key);
          const muted = await tempMute(message.guild, message.member, 5 * 60000, 'Automod: spam');
          const recent = await message.channel.messages.fetch({ limit: 30 }).catch(() => null);
          if (recent) {
            const theirs = [...recent.filter(m => m.author.id === message.author.id).values()].slice(0, 10);
            await message.channel.bulkDelete(theirs, true).catch(() => {});
          }
          message.channel.send(`🔇 <@${message.author.id}> ${muted ? 'was muted for 5m' : 'was warned'} — spamming.`)
            .then(m => setTimeout(() => m.delete().catch(() => {}), 6000)).catch(() => {});
          modLog(message.guild, new EmbedBuilder().setColor(0xff4444).setTitle('🧹 Automod — Spam')
            .setDescription(`**${message.author.tag}** was spamming in <#${message.channel.id}>.`).setTimestamp());
          return;
        }
      }
    }
  } catch (e) { console.error('[automod]', e.message); }

  // ── AFK ────────────────────────────────────────────────────────
  try {
    const selfAfk = await db.get(`afk.${message.guild.id}.${message.author.id}`);
    if (selfAfk && !message.content.toLowerCase().startsWith(`${PREFIX}afk`)) {
      await db.delete(`afk.${message.guild.id}.${message.author.id}`);
      message.reply(`👋 Welcome back! I removed your AFK.`)
        .then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
    }
    if (message.mentions.users.size > 0 && message.mentions.users.size < 5) {
      const notes = [];
      for (const [, u] of message.mentions.users) {
        if (u.id === message.author.id) continue;
        const a = await db.get(`afk.${message.guild.id}.${u.id}`);
        if (a) notes.push(`💤 **${u.username}** is AFK: ${a.reason} — <t:${Math.floor(a.since / 1000)}:R>`);
      }
      if (notes.length) {
        message.reply({ content: notes.join('\n'), allowedMentions: { parse: [] } })
          .then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
      }
    }
  } catch {}

  // ── Password intercept ─────────────────────────────────────────
  const pending = pendingPassword.get(message.author.id);
  if (pending && pending.guildId === message.guild.id) {
    if (Date.now() - pending.timestamp > 60000) {
      pendingPassword.delete(message.author.id);
    } else {
      const attempt = message.content.trim();
      const deleted = await message.delete().then(() => true).catch(() => false);
      const storedHash = await db.get(`ownerpassword.${message.guild.id}`);
      pendingPassword.delete(message.author.id);
      if (!deleted) {
        // If we couldn't delete the message, the password is exposed in chat — warn.
        message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0xffcc00).setDescription("⚠️ I couldn't delete your message (missing **Manage Messages** here). Delete it yourself and consider changing the password.")]}).then(m => setTimeout(() => m.delete().catch(() => {}), 10000)).catch(() => {});
      }
      if (!storedHash) {
        return message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0xff4444).setDescription('❌ No password set. The server owner can set one with `-setownerpassword <password>`.')]}).then(m => setTimeout(() => m.delete().catch(() => {}), 6000));
      }
      if (hashPw(attempt) !== storedHash) {
        return message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0xff4444).setDescription('❌ Wrong password.')]}).then(m => setTimeout(() => m.delete().catch(() => {}), 4000));
      }
      return message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ Owner Commands').addFields(
        { name: '👋 Welcome',        value: '`-setwelcome #channel`\n`-setwelcome message <text>`\n`-setwelcome disable`\n`-setwelcome test`' },
        { name: '⚙️ Config',         value: '`-autorole add @role`\n`-autorole remove @role`\n`-autorole list`' },
        { name: '🛡️ Antinuke',       value: '`-antinuke enable`\n`-antinuke disable`\n`-antinuke setlog #channel`\n`-antinuke whitelist add/remove @user`\n`-antinuke snapshot`\n`-antinuke status`\n`-antinuke restore`\n`-antinuke restore clear`' },
        { name: '🎉 Giveaways',      value: '`-gcreate <duration> <winners> <prize>`\n`-gend <messageId>`\n`-greroll <messageId>`\n`-glist`' },
        { name: '🔒 Lock Whitelist', value: '`-lockwhitelist add @role`\n`-lockwhitelist remove @role`\n`-lockwhitelist list`' },
        { name: '🔑 Password',       value: '`-setownerpassword <password>`' },
        { name: '🤫 Secret',         value: '`-shiprig @a @b <0-100>` — rig the ship-o-meter\n`-shiprig clear [@a @b]` — un-rig one pair or all' },
      ).setFooter({ text: `Only you can see this • Auto-deletes in 30s • Prefix: ${PREFIX}` })] }).then(m => setTimeout(() => m.delete().catch(() => {}), 30000));
    }
  }

  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd  = args.shift().toLowerCase();

  // ── -cmdsowner ────────────────────────────────────────────────
  if (cmd === 'cmdsowner') {
    await message.delete().catch(() => {});
    const storedHash = await db.get(`ownerpassword.${message.guild.id}`);
    if (!storedHash) {
      if (message.author.id !== message.guild.ownerId) return;
      return message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0xffcc00).setDescription('⚠️ No password set yet. Use `-setownerpassword <password>` first.')]}).then(m => setTimeout(() => m.delete().catch(() => {}), 8000));
    }
    pendingPassword.set(message.author.id, { guildId: message.guild.id, channelId: message.channel.id, timestamp: Date.now() });
    const prompt = await message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('🔑 Type the password. *(your message will be deleted instantly)*')] });
    setTimeout(() => { prompt.delete().catch(() => {}); pendingPassword.delete(message.author.id); }, 60000);
    return;
  }

  // ── -setownerpassword ──────────────────────────────────────────
  if (cmd === 'setownerpassword') {
    if (message.author.id !== message.guild.ownerId)
      return message.reply('❌ Only the server owner can set the password.');
    await message.delete().catch(() => {});
    const pw = args.join(' ');
    if (!pw) return message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0xff4444).setDescription('❌ Usage: `-setownerpassword <password>`')]}).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
    // stored as a sha256 hash — never plaintext
    await db.set(`ownerpassword.${message.guild.id}`, hashPw(pw));
    return message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0x00cc44).setDescription('✅ Owner password set. Use `-cmdsowner` to access owner commands.')]}).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
  }

  // ── -cmds (interactive help menu) ──────────────────────────────
  if (cmd === 'cmds' || cmd === 'commands' || cmd === 'help') {
    const total = Object.values(HELP).reduce((n, c) => n + c.commands.length, 0);

    const homeEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: `${client.user.username} • Help`, iconURL: client.user.displayAvatarURL() })
      .setDescription(`**${total}** commands across **${Object.keys(HELP).length}** categories • Prefix: \`${PREFIX}\`\n\n📂 **Pick a category from the menu below** to see its commands with descriptions.`)
      .addFields(Object.values(HELP).map(c => ({
        name: `${c.emoji} ${c.label}`,
        value: `${c.desc}\n*${c.commands.length} commands*`,
        inline: true,
      })))
      .setFooter({ text: 'Menu is active for 2 minutes' })
      .setTimestamp();

    const buildMenu = (disabled = false) => new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('help-menu')
        .setPlaceholder(disabled ? 'Menu expired — run -cmds again' : '📂 Choose a category…')
        .setDisabled(disabled)
        .addOptions(
          { label: 'Home', value: 'home', emoji: '🏠', description: 'Back to the overview' },
          ...Object.entries(HELP).map(([id, c]) => ({
            label: c.label, value: id, emoji: c.emoji, description: c.desc.slice(0, 100),
          })),
        )
    );

    const sent = await message.reply({ embeds: [homeEmbed], components: [buildMenu()] });
    const collector = sent.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 120000 });

    collector.on('collect', async i => {
      if (i.user.id !== message.author.id)
        return i.reply({ content: `❌ This menu belongs to someone else — run \`${PREFIX}cmds\` yourself!`, ephemeral: true }).catch(() => {});
      if (i.values[0] === 'home')
        return i.update({ embeds: [homeEmbed], components: [buildMenu()] }).catch(() => {});
      const c = HELP[i.values[0]];
      const catEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: `${c.emoji} ${c.label}`, iconURL: client.user.displayAvatarURL() })
        .setDescription(c.commands.map(([usage, desc]) => `**\`${PREFIX}${usage}\`**\n> ${desc}`).join('\n'))
        .setFooter({ text: `${c.commands.length} commands • Prefix: ${PREFIX}` })
        .setTimestamp();
      i.update({ embeds: [catEmbed], components: [buildMenu()] }).catch(() => {});
    });

    collector.on('end', () => sent.edit({ components: [buildMenu(true)] }).catch(() => {}));
    return;
  }

  // ── -invites ───────────────────────────────────────────────────
  if (cmd === 'invites') {
    const isReset = args[0]?.toLowerCase() === 'reset';
    const target  = message.mentions.users.first() ?? message.author;
    if (isReset) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return message.reply('❌ You need **Manage Server** permission.');
      const resetTarget = message.mentions.users.first();
      if (!resetTarget) return message.reply('❌ Usage: `-invites reset @user`');
      await db.set(`invites.${message.guild.id}.${resetTarget.id}`, 0);
      return message.reply(`✅ Reset invite count for **${resetTarget.tag}**.`);
    }
    const count = (await db.get(`invites.${message.guild.id}.${target.id}`)) ?? 0;
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📨 Invite Count').setDescription(`**${target.tag}** has **${count}** invite${count !== 1 ? 's' : ''} in **${message.guild.name}**.`).setThumbnail(target.displayAvatarURL()).setTimestamp()] });
  }

  // ── -inviteleaderboard ─────────────────────────────────────────
  // One db read for the whole guild instead of a member fetch + one read per member.
  if (cmd === 'inviteleaderboard' || cmd === 'invlb') {
    const all = (await db.get(`invites.${message.guild.id}`)) || {};
    const top = Object.entries(all)
      .filter(([, count]) => typeof count === 'number' && count > 0)
      .map(([uid, count]) => ({ uid, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    if (!top.length) return message.reply('❌ No invite data yet.');
    const lines = top.map((e, i) => `**${i + 1}.** <@${e.uid}> — **${e.count}** invite${e.count !== 1 ? 's' : ''}`);
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📨 Invite Leaderboard').setDescription(lines.join('\n')).setFooter({ text: `${message.guild.name} • Top ${top.length}` }).setTimestamp()] });
  }

  // ── -ban ───────────────────────────────────────────────────────
  if (cmd === 'ban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers))
      return message.reply('❌ You need **Ban Members** permission.');
    const t = await resolveMember(message, args[0]);
    if (!t) return message.reply('❌ Usage: `-ban @user [reason]`');
    const r = args.slice(1).join(' ') || 'No reason provided';
    if (t.id === message.author.id) return message.reply('❌ Cannot ban yourself.');
    if (t.id === message.guild.ownerId) return message.reply('❌ Cannot ban the server owner.');
    if (!t.bannable) return message.reply("❌ I can't ban that user.");
    if (message.member.roles.highest.position <= t.roles.highest.position && message.author.id !== message.guild.ownerId) return message.reply('❌ That user has an equal or higher role.');
    await t.send({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle(`Banned from ${message.guild.name}`).addFields({ name: 'Reason', value: r })] }).catch(() => {});
    await t.ban({ reason: `${message.author.tag}: ${r}` });
    message.reply({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('🔨 Banned').addFields({ name: 'User', value: t.user.tag, inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }, { name: 'Reason', value: r }).setTimestamp()] });
  }

  // ── -kick ──────────────────────────────────────────────────────
  else if (cmd === 'kick') {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers))
      return message.reply('❌ You need **Kick Members** permission.');
    const t = await resolveMember(message, args[0]);
    if (!t) return message.reply('❌ Usage: `-kick @user [reason]`');
    const r = args.slice(1).join(' ') || 'No reason provided';
    if (t.id === message.author.id) return message.reply('❌ Cannot kick yourself.');
    if (t.id === message.guild.ownerId) return message.reply('❌ Cannot kick the server owner.');
    if (!t.kickable) return message.reply("❌ I can't kick that user.");
    if (message.member.roles.highest.position <= t.roles.highest.position && message.author.id !== message.guild.ownerId) return message.reply('❌ That user has an equal or higher role.');
    await t.send({ embeds: [new EmbedBuilder().setColor(0xff8800).setTitle(`Kicked from ${message.guild.name}`).addFields({ name: 'Reason', value: r })] }).catch(() => {});
    await t.kick(`${message.author.tag}: ${r}`);
    message.reply({ embeds: [new EmbedBuilder().setColor(0xff8800).setTitle('👢 Kicked').addFields({ name: 'User', value: t.user.tag, inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }, { name: 'Reason', value: r }).setTimestamp()] });
  }

  // ── -mute ─────────────────────────────────────────────────────
  else if (cmd === 'mute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles))
      return message.reply('❌ You need **Manage Roles** permission.');
    const t = await resolveMember(message, args[0]);
    if (!t) return message.reply('❌ Usage: `-mute @user <duration> [reason]`\nDurations: `30s` `5m` `1h` `12h` `1d` `7d`');
    const ms = parseDuration(args[1]?.toLowerCase());
    if (!ms) return message.reply('❌ Invalid duration. Examples: `30s` `5m` `1h` `12h` `1d` `7d`');
    const r = args.slice(2).join(' ') || 'No reason provided';
    if (t.id === message.author.id) return message.reply('❌ Cannot mute yourself.');
    if (t.id === message.guild.ownerId) return message.reply('❌ Cannot mute the server owner.');
    if (message.member.roles.highest.position <= t.roles.highest.position && message.author.id !== message.guild.ownerId) return message.reply('❌ That user has an equal or higher role.');
    const muteRole = await getMuteRole(message.guild).catch(() => null);
    if (!muteRole) return message.reply('❌ Failed to create/find the Muted role.');
    if (message.guild.members.me.roles.highest.position <= muteRole.position) return message.reply('❌ The Muted role is above my highest role — move it below my role.');
    if (t.roles.cache.has(muteRole.id)) return message.reply('❌ That user is already muted.');
    await t.roles.add(muteRole, `Muted by ${message.author.tag}: ${r}`);
    const endsAt = Date.now() + ms;
    await db.set(`mutes.${message.guild.id}.${t.id}`, { endsAt, reason: r, moderatorId: message.author.id });
    const timer = setTimeout(() => unmuteUser(message.guild, t.id, 'Mute expired'), ms);
    muteTimers.set(`${message.guild.id}:${t.id}`, timer);
    await t.send({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle(`Muted in ${message.guild.name}`).addFields({ name: 'Duration', value: formatDuration(ms) }, { name: 'Reason', value: r })] }).catch(() => {});
    message.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('🔇 Muted').addFields({ name: 'User', value: t.user.tag, inline: true }, { name: 'Duration', value: formatDuration(ms), inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }, { name: 'Reason', value: r }).setTimestamp()] });
  }

  // ── -unmute ────────────────────────────────────────────────────
  else if (cmd === 'unmute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles))
      return message.reply('❌ You need **Manage Roles** permission.');
    const t = await resolveMember(message, args[0]);
    if (!t) return message.reply('❌ Usage: `-unmute @user`');
    const muteRole = await getMuteRole(message.guild, false);
    if (!muteRole || !t.roles.cache.has(muteRole.id)) return message.reply('❌ That user is not muted.');
    clearTimeout(muteTimers.get(`${message.guild.id}:${t.id}`));
    await unmuteUser(message.guild, t.id, `Unmuted by ${message.author.tag}`);
    message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('🔊 Unmuted').addFields({ name: 'User', value: t.user.tag, inline: true }, { name: 'Moderator', value: message.author.tag, inline: true }).setTimestamp()] });
  }

  // ── -warn ──────────────────────────────────────────────────────
  else if (cmd === 'warn') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return message.reply('❌ You need **Timeout Members** permission.');
    const t = await resolveMember(message, args[0]);
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
    const t = await resolveUser(message, isClear ? args[1] : args[0]);
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
    if (isNaN(amount) || amount < 1 || amount > 100) return message.reply('❌ Usage: `-purge <1-100>` or `-purge @user <1-100>`');
    await message.delete().catch(() => {});
    const fetched  = await message.channel.messages.fetch({ limit: fm ? 100 : amount });
    const toDelete = fm ? [...fetched.filter(m => m.author.id === fm.id).values()].slice(0, amount) : [...fetched.values()];
    const deleted  = await message.channel.bulkDelete(toDelete, true);
    const conf = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x00cc44).setDescription(`🗑️ Deleted **${deleted.size}** messages.`)] });
    setTimeout(() => conf.delete().catch(() => {}), 4000);
  }

  // ── -lock / -unlock ────────────────────────────────────────────
  else if (cmd === 'lock' || cmd === 'unlock') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels))
      return message.reply('❌ You need **Manage Channels** permission.');
    const ch       = message.channel;
    const everyone = message.guild.roles.everyone;
    const bypassIds   = (await db.get(`lockwhitelist.${message.guild.id}`)) ?? [];
    const bypassRoles = bypassIds.map(id => message.guild.roles.cache.get(id)).filter(Boolean);
    if (cmd === 'lock') {
      await ch.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: `Locked by ${message.author.tag}` });
      for (const role of bypassRoles) await ch.permissionOverwrites.edit(role, { SendMessages: true }, { reason: 'Lock whitelist bypass' }).catch(() => {});
      const roleList = bypassRoles.length ? bypassRoles.map(r => `<@&${r.id}>`).join(' ') : 'None set — use `-lockwhitelist add @role`';
      ch.send({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('🔒 Channel Locked').setDescription(`This channel has been locked.\n\n**Roles that can still type:** ${roleList}`).setFooter({ text: `Locked by ${message.author.tag}` }).setTimestamp()] });
    } else {
      await ch.permissionOverwrites.edit(everyone, { SendMessages: null }, { reason: `Unlocked by ${message.author.tag}` });
      for (const role of bypassRoles) await ch.permissionOverwrites.edit(role, { SendMessages: null }, { reason: 'Lock removed' }).catch(() => {});
      ch.send({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('🔓 Channel Unlocked').setDescription('Everyone can type here again.').setFooter({ text: `Unlocked by ${message.author.tag}` }).setTimestamp()] });
    }
  }

  // ── -lockwhitelist ─────────────────────────────────────────────
  else if (cmd === 'lockwhitelist') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
      return message.reply('❌ You need **Manage Server** permission.');
    const action = args[0]?.toLowerCase();
    const key    = `lockwhitelist.${message.guild.id}`;
    const list   = (await db.get(key)) ?? [];
    if (action === 'add') {
      const role = message.mentions.roles.first();
      if (!role) return message.reply('❌ Usage: `-lockwhitelist add @role`');
      if (list.includes(role.id)) return message.reply(`❌ ${role} is already whitelisted.`);
      list.push(role.id); await db.set(key, list);
      const all = list.map(id => { const r = message.guild.roles.cache.get(id); return r ? `<@&${r.id}>` : null; }).filter(Boolean).join(' ');
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('✅ Lock Whitelist').setDescription(`Added ${role}.\n\n**Current whitelist:** ${all}`)] });
    }
    if (action === 'remove') {
      const role = message.mentions.roles.first();
      if (!role) return message.reply('❌ Usage: `-lockwhitelist remove @role`');
      if (!list.includes(role.id)) return message.reply(`❌ ${role} is not whitelisted.`);
      const remaining = list.filter(id => id !== role.id);
      await db.set(key, remaining);
      const all = remaining.length ? remaining.map(id => { const r = message.guild.roles.cache.get(id); return r ? `<@&${r.id}>` : null; }).filter(Boolean).join(' ') : 'None';
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('✅ Lock Whitelist').setDescription(`Removed ${role}.\n\n**Current whitelist:** ${all}`)] });
    }
    if (action === 'list' || !action) {
      if (!list.length) return message.reply('❌ No roles whitelisted. Use `-lockwhitelist add @role`');
      const all = list.map(id => { const r = message.guild.roles.cache.get(id); return r ? `• <@&${r.id}>` : null; }).filter(Boolean).join('\n');
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🔒 Lock Whitelist').setDescription(all).setFooter({ text: `${list.length} role(s) — these can type in locked channels` })] });
    }
    message.reply('❌ Usage: `-lockwhitelist add/remove @role` or `-lockwhitelist list`');
  }

  // ── -role ──────────────────────────────────────────────────────
  else if (cmd === 'role') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles))
      return message.reply('❌ You need **Manage Roles** permission.');
    const t = message.mentions.members.first();
    if (!t) return message.reply('❌ Usage: `-role @user <role name>`');
    const rn = args.slice(1).join(' ').replace(/<@[^>]+>\s*/g, '').trim();
    if (!rn) return message.reply('❌ Please provide a role name.');
    const role = message.mentions.roles.first() || message.guild.roles.cache.find(r => r.name.toLowerCase() === rn.toLowerCase());
    if (!role) return message.reply(`❌ No role named **${rn}**.`);
    if (message.guild.members.me.roles.highest.position <= role.position) return message.reply('❌ That role is above my highest role.');
    if (message.member.roles.highest.position <= role.position && message.author.id !== message.guild.ownerId) return message.reply('❌ That role is above your highest role.');
    if (role.managed) return message.reply('❌ Managed by an integration.');
    if (t.roles.cache.has(role.id)) {
      await t.roles.remove(role, `Removed by ${message.author.tag}`);
      message.reply({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('✅ Role Removed').addFields({ name: 'Member', value: `${t}`, inline: true }, { name: 'Role', value: role.name, inline: true })] });
    } else {
      await t.roles.add(role, `Added by ${message.author.tag}`);
      message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('✅ Role Added').addFields({ name: 'Member', value: `${t}`, inline: true }, { name: 'Role', value: role.name, inline: true })] });
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
      const chan = message.guild.channels.cache.get(cid) ?? await message.guild.channels.fetch(cid).catch(() => null);
      if (!chan) return message.reply('❌ Channel no longer exists.');
      const template = await db.get(`welcome.${gid}.message`);
      if (template) {
        const msg = fillPlaceholders(template, {
          user:         `<@${message.author.id}>`,
          username:     message.author.username,
          server:       message.guild.name,
          memberCount:  message.guild.memberCount,
          inviter:      `<@${message.author.id}>`,
          inviterTag:   message.author.tag,
          inviterCount: 1,
        });
        await chan.send({ content: msg, allowedMentions: { users: [message.author.id] } });
      } else {
        await chan.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`Welcome to ${message.guild.name}!`).setDescription(`Hey <@${message.author.id}>, member **#${message.guild.memberCount}**!\n\nInvited by **${message.author.tag}** · **1** invite (test)`).setThumbnail(message.author.displayAvatarURL()).setTimestamp()] });
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

  // ── -gcreate ───────────────────────────────────────────────────
  else if (cmd === 'gcreate' || cmd === 'gstart') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
      return message.reply('❌ You need **Manage Server** permission.');
    const duration = parseDuration(args[0]);
    if (!duration) return message.reply('❌ Usage: `-gcreate <duration> <winners> <prize>`\nExamples: `30s` `5m` `2h` `3d`');
    const winnerCount = parseInt(args[1]);
    if (isNaN(winnerCount) || winnerCount < 1 || winnerCount > 20)
      return message.reply('❌ Winners must be between 1 and 20.');
    const prize = args.slice(2).join(' ');
    if (!prize) return message.reply('❌ Please provide a prize name.');

    const endsAt = Date.now() + duration;
    const embed  = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎉 GIVEAWAY')
      .setDescription(`**${prize}**\n\nReact with 🎉 to enter!\n\n⏰ Ends: <t:${Math.floor(endsAt / 1000)}:R>`)
      .addFields(
        { name: 'Duration',  value: formatDuration(duration), inline: true },
        { name: 'Winners',   value: String(winnerCount),      inline: true },
        { name: 'Hosted by', value: message.author.tag,       inline: true },
      )
      .setFooter({ text: `${winnerCount} winner(s) • Ends` })
      .setTimestamp(endsAt);

    const gMsg = await message.channel.send({ embeds: [embed] });
    await gMsg.react('🎉');

    await db.set(`giveaways.${message.guild.id}.${gMsg.id}`, {
      channelId: message.channel.id,
      prize, winnerCount, endsAt,
      hostId: message.author.id,
      active: true,
    });

    scheduleGiveaway(message.guild.id, gMsg.id, endsAt);
    message.reply(`✅ Giveaway started! Ends <t:${Math.floor(endsAt / 1000)}:R> — [Jump to it](${gMsg.url})`);
  }

  // ── -gend ──────────────────────────────────────────────────────
  else if (cmd === 'gend') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
      return message.reply('❌ You need **Manage Server** permission.');
    const mid = args[0];
    if (!mid) return message.reply('❌ Usage: `-gend <messageId>`');
    const data = await db.get(`giveaways.${message.guild.id}.${mid}`);
    if (!data) return message.reply('❌ No giveaway found with that message ID.');
    if (!data.active) return message.reply('❌ That giveaway has already ended.');
    await endGiveaway(message.guild.id, mid);
    message.reply('✅ Giveaway ended.');
  }

  // ── -greroll ───────────────────────────────────────────────────
  else if (cmd === 'greroll') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
      return message.reply('❌ You need **Manage Server** permission.');
    const mid = args[0];
    if (!mid) return message.reply('❌ Usage: `-greroll <messageId>`');
    const data = await db.get(`giveaways.${message.guild.id}.${mid}`);
    if (!data) return message.reply('❌ No giveaway found with that message ID.');
    if (data.active) return message.reply('❌ That giveaway is still running. Use `-gend` first.');
    await endGiveaway(message.guild.id, mid, true);
    message.reply('✅ Rerolled!');
  }

  // ── -glist ─────────────────────────────────────────────────────
  else if (cmd === 'glist') {
    try {
      const guildGiveaways = (await db.get(`giveaways.${message.guild.id}`)) || {};
      const active = Object.entries(guildGiveaways).filter(([, d]) => d?.active);
      if (!active.length) return message.reply('❌ No active giveaways.');
      const lines = active.map(([mid, d]) =>
        `• **${d.prize}** — ${d.winnerCount} winner(s) — ends <t:${Math.floor(d.endsAt / 1000)}:R> — ID: \`${mid}\``
      );
      message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎉 Active Giveaways').setDescription(lines.join('\n')).setTimestamp()] });
    } catch (e) {
      message.reply('❌ Could not fetch giveaway list.');
    }
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
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('🛡️ Antinuke Enabled').setDescription('**Triggers at:** 3 deletions / bans / kicks in 4s\n**On trigger:** bans nuker + auto-restores channels\n**Snapshot:** taken now, refreshes every 30s\n\n⚠️ Give this bot the **highest role** so it can ban anyone.\n`-antinuke setlog #channel` — receive alerts\n`-antinuke whitelist add @user` — trust your admins')] });
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
      return message.reply({ embeds: [new EmbedBuilder().setColor(s.enabled ? 0x00cc44 : 0xff4444).setTitle('🛡️ Antinuke Status').addFields(
        { name: 'Status',      value: s.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
        { name: 'Log Channel', value: s.logChannel ? `<#${s.logChannel}>` : 'Not set', inline: true },
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

  // ═══════════════════════════════════════════════════════════════
  //  FUN COMMANDS
  // ═══════════════════════════════════════════════════════════════

  // ── -8ball ─────────────────────────────────────────────────────
  else if (cmd === '8ball') {
    const q = args.join(' ');
    if (!q) return message.reply('❌ Ask a question! `-8ball will I win?`');
    const answer = EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)];
    message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎱 Magic 8-Ball').addFields({ name: 'Question', value: q.slice(0, 1024) }, { name: 'Answer', value: answer })] });
  }

  // ── -coinflip ──────────────────────────────────────────────────
  else if (cmd === 'coinflip' || cmd === 'flip') {
    message.reply(`🪙 **${Math.random() < 0.5 ? 'Heads' : 'Tails'}**!`);
  }

  // ── -dice ──────────────────────────────────────────────────────
  else if (cmd === 'dice' || cmd === 'roll') {
    const sides = parseInt(args[0]) || 6;
    if (sides < 2 || sides > 1000) return message.reply('❌ Sides must be 2–1000.');
    message.reply(`🎲 You rolled a **${Math.floor(Math.random() * sides) + 1}** (d${sides})`);
  }

  // ── -rps ───────────────────────────────────────────────────────
  else if (cmd === 'rps') {
    const choices = ['rock', 'paper', 'scissors'];
    const you = args[0]?.toLowerCase();
    if (!choices.includes(you)) return message.reply('❌ Usage: `-rps rock|paper|scissors`');
    const bot = choices[Math.floor(Math.random() * 3)];
    const emoji = { rock: '🪨', paper: '📄', scissors: '✂️' };
    let result;
    if (you === bot) result = "It's a **tie**!";
    else if ((you === 'rock' && bot === 'scissors') || (you === 'paper' && bot === 'rock') || (you === 'scissors' && bot === 'paper')) result = 'You **win**! 🎉';
    else result = 'You **lose**! 😈';
    message.reply(`${emoji[you]} vs ${emoji[bot]} — ${result}`);
  }

  // ── -choose ────────────────────────────────────────────────────
  else if (cmd === 'choose' || cmd === 'pick') {
    const options = args.join(' ').split('|').map(s => s.trim()).filter(Boolean);
    if (options.length < 2) return message.reply('❌ Usage: `-choose pizza | burgers | tacos`');
    message.reply({ content: `🤔 I choose... **${options[Math.floor(Math.random() * options.length)]}**`, allowedMentions: { parse: [] } });
  }

  // ── -ship ──────────────────────────────────────────────────────
  else if (cmd === 'ship') {
    const users = [...message.mentions.users.values()];
    if (users.length < 1) return message.reply('❌ Usage: `-ship @user` or `-ship @user1 @user2`');
    const a = users[0], b = users[1] ?? message.author;

    // 🤫 secret rig check — set with -shiprig (owner only, via -cmdsowner)
    const pairKey = [a.id, b.id].sort().join('-');
    const rigged  = await db.get(`shiprig.${message.guild.id}.${pairKey}`);
    const score   = rigged ?? Math.floor(Math.random() * 101);

    // ship name: first half of one name + second half of the other
    const shipName = (a.username.slice(0, Math.ceil(a.username.length / 2)) +
                      b.username.slice(Math.floor(b.username.length / 2))).slice(0, 32);

    const verdict =
      score === 100 ? '💍 SOULMATES. Book the venue.' :
      score >= 90   ? '💖 Written in the stars!' :
      score >= 70   ? '💕 There\'s definitely something here…' :
      score >= 50   ? '🧡 Could work with some effort!' :
      score >= 30   ? '💛 Eh… maybe as friends.' :
      score >= 10   ? '💔 The vibes are off.' :
      score === 0   ? '☠️ Restraining order territory.' :
                      '🥶 Absolutely not.';

    const embedColor = score >= 70 ? 0xff4d8d : score >= 40 ? 0xffaa33 : 0x8899aa;

    // image card (like the big bots) — falls back to text if canvas isn't installed
    if (canvasLib) {
      try {
        const card = await makeShipCard(a, b, score);
        return message.reply({
          embeds: [new EmbedBuilder()
            .setColor(embedColor)
            .setTitle('💘 Ship-o-meter 💘')
            .setDescription(`✨ **${a.username}** ✕ **${b.username}** ✨\n💞 Ship name: **${shipName}**\n\n**${verdict}**`)
            .setImage('attachment://ship.png')
            .setFooter({ text: 'Cupid has spoken 🏹' })],
          files: [card],
        });
      } catch (e) { console.error('[ship card]', e.message); }
    }

    // text fallback
    const filled = Math.round(score / 10);
    const heart  = score >= 90 ? '💖' : score >= 70 ? '❤️' : score >= 50 ? '🧡' : score >= 30 ? '💛' : '🖤';
    const bar    = heart.repeat(filled) + '🤍'.repeat(10 - filled);
    message.reply({ embeds: [new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('💘 Ship-o-meter 💘')
      .setDescription(`✨ **${a.username}** ✕ **${b.username}** ✨\n💞 Ship name: **${shipName}**\n\n${bar}  **${score}%**\n\n**${verdict}**`)
      .setFooter({ text: 'Cupid has spoken 🏹' })] });
  }

  // ── -mock ──────────────────────────────────────────────────────
  else if (cmd === 'mock') {
    const text = args.join(' ');
    if (!text) return message.reply('❌ Usage: `-mock <text>`');
    const mocked = [...text].map((c, i) => i % 2 ? c.toUpperCase() : c.toLowerCase()).join('');
    message.reply({ content: mocked.slice(0, 2000), allowedMentions: { parse: [] } });
  }

  // ── -reverse ───────────────────────────────────────────────────
  else if (cmd === 'reverse') {
    const text = args.join(' ');
    if (!text) return message.reply('❌ Usage: `-reverse <text>`');
    message.reply({ content: [...text].reverse().join('').slice(0, 2000), allowedMentions: { parse: [] } });
  }

  // ═══════════════════════════════════════════════════════════════
  //  UTILITY COMMANDS
  // ═══════════════════════════════════════════════════════════════

  // ── -ping ──────────────────────────────────────────────────────
  else if (cmd === 'ping') {
    const sent = await message.reply('🏓 Pinging…');
    sent.edit(`🏓 Pong! Roundtrip: **${sent.createdTimestamp - message.createdTimestamp}ms** • API: **${Math.round(client.ws.ping)}ms**`);
  }

  // ── -uptime ────────────────────────────────────────────────────
  else if (cmd === 'uptime') {
    const s = Math.floor(process.uptime());
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    message.reply(`⏱️ Online for **${d}d ${h}h ${m}m ${s % 60}s**`);
  }

  // ── -avatar ────────────────────────────────────────────────────
  else if (cmd === 'avatar' || cmd === 'av') {
    const t = message.mentions.users.first() ?? (args[0] ? await resolveUser(message, args[0]) : message.author) ?? message.author;
    const url = t.displayAvatarURL({ size: 1024 });
    message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🖼️ ${t.username}'s avatar`).setImage(url).setDescription(`[Open in browser](${url})`)] });
  }

  // ── -userinfo ──────────────────────────────────────────────────
  else if (cmd === 'userinfo' || cmd === 'whois') {
    const t = message.mentions.members.first() ?? (args[0] ? await resolveMember(message, args[0]) : message.member) ?? message.member;
    const roles = t.roles.cache.filter(r => r.id !== message.guild.id).sort((a, b) => b.position - a.position);
    const roleList = roles.size ? [...roles.values()].slice(0, 15).join(' ') + (roles.size > 15 ? ` +${roles.size - 15} more` : '') : 'None';
    message.reply({ embeds: [new EmbedBuilder().setColor(t.displayHexColor === '#000000' ? 0x5865f2 : t.displayColor).setTitle(`👤 ${t.user.tag}`).setThumbnail(t.user.displayAvatarURL()).addFields(
      { name: 'ID',            value: t.id, inline: true },
      { name: 'Nickname',      value: t.nickname ?? 'None', inline: true },
      { name: 'Bot',           value: t.user.bot ? 'Yes' : 'No', inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(t.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: 'Joined Server',   value: t.joinedTimestamp ? `<t:${Math.floor(t.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
      { name: `Roles [${roles.size}]`, value: roleList.slice(0, 1024) },
    ).setTimestamp()] });
  }

  // ── -serverinfo ────────────────────────────────────────────────
  else if (cmd === 'serverinfo' || cmd === 'si') {
    const g = message.guild;
    const chans = g.channels.cache;
    message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🏠 ${g.name}`).setThumbnail(g.iconURL() ?? '').addFields(
      { name: 'Owner',    value: `<@${g.ownerId}>`, inline: true },
      { name: 'Members',  value: String(g.memberCount), inline: true },
      { name: 'Created',  value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
      { name: 'Channels', value: `💬 ${chans.filter(c => c.type === 0).size} text • 🔊 ${chans.filter(c => c.type === 2).size} voice • 📁 ${chans.filter(c => c.type === 4).size} categories`, inline: true },
      { name: 'Roles',    value: String(g.roles.cache.size), inline: true },
      { name: 'Boosts',   value: `${g.premiumSubscriptionCount ?? 0} (Level ${g.premiumTier})`, inline: true },
    ).setFooter({ text: `ID: ${g.id}` }).setTimestamp()] });
  }

  // ── -roleinfo ──────────────────────────────────────────────────
  else if (cmd === 'roleinfo') {
    const rn = args.join(' ').replace(/<@&\d+>\s*/g, '').trim();
    const role = message.mentions.roles.first() || message.guild.roles.cache.find(r => r.name.toLowerCase() === rn.toLowerCase());
    if (!role) return message.reply('❌ Usage: `-roleinfo <role name or @role>`');
    message.reply({ embeds: [new EmbedBuilder().setColor(role.color || 0x5865f2).setTitle(`🎭 ${role.name}`).addFields(
      { name: 'ID',          value: role.id, inline: true },
      { name: 'Members',     value: String(role.members.size), inline: true },
      { name: 'Color',       value: role.hexColor, inline: true },
      { name: 'Position',    value: String(role.position), inline: true },
      { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
      { name: 'Hoisted',     value: role.hoist ? 'Yes' : 'No', inline: true },
      { name: 'Created',     value: `<t:${Math.floor(role.createdTimestamp / 1000)}:R>`, inline: true },
    )] });
  }

  // ── -membercount ───────────────────────────────────────────────
  else if (cmd === 'membercount' || cmd === 'mc') {
    message.reply(`👥 **${message.guild.name}** has **${message.guild.memberCount}** members.`);
  }

  // ── -poll ──────────────────────────────────────────────────────
  else if (cmd === 'poll') {
    const raw = args.join(' ');
    if (!raw) return message.reply('❌ Usage: `-poll <question>` or `-poll question | option1 | option2`');
    const parts = raw.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length === 1) {
      const p = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📊 Poll').setDescription(parts[0]).setFooter({ text: `Poll by ${message.author.tag}` }).setTimestamp()] });
      await p.react('👍'); await p.react('👎'); await p.react('🤷');
    } else {
      const question = parts.shift();
      if (parts.length > 10) return message.reply('❌ Max 10 options.');
      const desc = parts.map((o, i) => `${POLL_EMOJIS[i]} ${o}`).join('\n');
      const p = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`📊 ${question}`).setDescription(desc).setFooter({ text: `Poll by ${message.author.tag}` }).setTimestamp()] });
      for (let i = 0; i < parts.length; i++) await p.react(POLL_EMOJIS[i]);
    }
    await message.delete().catch(() => {});
  }

  // ── -snipe ─────────────────────────────────────────────────────
  else if (cmd === 'snipe') {
    const s = snipes.get(message.channel.id);
    if (!s) return message.reply('❌ Nothing to snipe in this channel.');
    message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setAuthor({ name: s.authorTag, iconURL: s.authorAvatar }).setDescription(s.content.slice(0, 2048)).setFooter({ text: 'Deleted' }).setTimestamp(s.time)] });
  }

  // ── -steal ─────────────────────────────────────────────────────
  else if (cmd === 'steal') {
    const stealPerm = PermissionFlagsBits.ManageGuildExpressions ?? PermissionFlagsBits.ManageEmojisAndStickers;
    if (!message.member.permissions.has(stealPerm))
      return message.reply('❌ You need **Manage Expressions** permission.');
    const match = message.content.match(/<(a?):(\w+):(\d+)>/);
    if (!match) return message.reply('❌ Usage: `-steal <emoji> [new name]` — paste a custom emoji from another server.');
    const [, animated, defaultName, id] = match;
    const customName = args.find(a => !a.includes(':') && /^\w{2,32}$/.test(a));
    const name = customName || defaultName;
    const url = `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=128&quality=lossless`;
    try {
      const emoji = await message.guild.emojis.create({ attachment: url, name });
      message.reply(`✅ Stolen! ${emoji} → \`:${emoji.name}:\``);
    } catch (e) {
      const why = /maximum/i.test(e.message) ? 'this server is out of emoji slots.'
        : /permission/i.test(e.message) ? 'I\'m missing **Manage Expressions** permission.'
        : e.message.slice(0, 100);
      message.reply(`❌ Couldn't add the emoji — ${why}`);
    }
  }

  // ── -stealsticker ──────────────────────────────────────────────
  else if (cmd === 'stealsticker') {
    const stealPerm = PermissionFlagsBits.ManageGuildExpressions ?? PermissionFlagsBits.ManageEmojisAndStickers;
    if (!message.member.permissions.has(stealPerm))
      return message.reply('❌ You need **Manage Expressions** permission.');

    // Grab the sticker from this message, or from the message being replied to
    let sticker = message.stickers.first();
    if (!sticker && message.reference?.messageId) {
      const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
      sticker = ref?.stickers.first();
    }
    if (!sticker) return message.reply('❌ Usage: **reply to a message that has a sticker** with `-stealsticker [new name]`.');

    // Lottie stickers (Discord's default sticker packs) can't be uploaded to normal servers
    if (sticker.format === 3)
      return message.reply('❌ That\'s one of Discord\'s built-in stickers (Lottie format) — those can\'t be copied to servers. Only custom server stickers work.');

    const customName = args.find(a => /^[\w -]{2,30}$/.test(a));
    const name = (customName || sticker.name).slice(0, 30);
    try {
      const created = await message.guild.stickers.create({
        file: sticker.url,
        name,
        tags: sticker.tags || 'sticker',
        reason: `Stolen by ${message.author.tag}`,
      });
      message.reply(`✅ Sticker stolen! Added **${created.name}** to this server.`);
    } catch (e) {
      const why = /maximum|asset exceeds/i.test(e.message) ? 'this server is out of sticker slots (or the file is too big).'
        : /permission/i.test(e.message) ? 'I\'m missing **Manage Expressions** permission.'
        : e.message.slice(0, 100);
      message.reply(`❌ Couldn't add the sticker — ${why}`);
    }
  }

  // ── -afk ───────────────────────────────────────────────────────
  else if (cmd === 'afk') {
    const reason = args.join(' ') || 'AFK';
    await db.set(`afk.${message.guild.id}.${message.author.id}`, { reason: reason.slice(0, 200), since: Date.now() });
    message.reply({ content: `💤 You're now AFK: **${reason.slice(0, 200)}**`, allowedMentions: { parse: [] } });
  }

  // ── -remindme ──────────────────────────────────────────────────
  else if (cmd === 'remindme' || cmd === 'remind') {
    const ms = parseDuration(args[0]?.toLowerCase());
    if (!ms) return message.reply('❌ Usage: `-remindme <duration> <text>` — e.g. `-remindme 2h take out the trash`');
    const text = args.slice(1).join(' ') || 'Reminder!';
    const id = `${message.author.id}-${Date.now()}`;
    const rem = { userId: message.author.id, channelId: message.channel.id, text: text.slice(0, 1000), endsAt: Date.now() + ms };
    await db.set(`reminders.${id}`, rem);
    scheduleReminder(id, rem);
    message.reply(`⏰ Got it! I'll remind you <t:${Math.floor(rem.endsAt / 1000)}:R>.`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  AUTOMOD & LOGGING COMMANDS
  // ═══════════════════════════════════════════════════════════════

  // ── -automod ───────────────────────────────────────────────────
  else if (cmd === 'automod' || cmd === 'am') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
      return message.reply('❌ You need **Manage Server** permission.');
    const gid = message.guild.id;
    const sub = args[0]?.toLowerCase();
    const key = `automod.${gid}`;
    const cur = (await db.get(key)) || {};

    if (sub === 'enable') {
      await db.set(key, { ...cur, enabled: true }); clearAmCache(gid);
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('🧹 Automod Enabled').setDescription('**On by default:** anti-spam, anti-mention-spam\n**Off by default:** anti-link, anti-caps, word filter\n\nToggle with `-automod antilink on`, add words with `-automod filter add <word>`.\nMods with **Manage Messages** are exempt.')] });
    }
    if (sub === 'disable') {
      await db.set(key, { ...cur, enabled: false }); clearAmCache(gid);
      return message.reply('✅ Automod disabled.');
    }
    if (['antispam', 'antilink', 'anticaps', 'antimention'].includes(sub)) {
      const state = args[1]?.toLowerCase();
      if (!['on', 'off'].includes(state)) return message.reply(`❌ Usage: \`-automod ${sub} on/off\``);
      await db.set(key, { ...cur, [sub]: state === 'on' }); clearAmCache(gid);
      return message.reply(`✅ **${sub}** is now **${state}**.`);
    }
    if (sub === 'filter') {
      const action = args[1]?.toLowerCase();
      const word   = args.slice(2).join(' ').toLowerCase().trim();
      const list   = cur.filter || [];
      if (action === 'add') {
        if (!word) return message.reply('❌ Usage: `-automod filter add <word>`');
        if (list.includes(word)) return message.reply('❌ Already filtered.');
        list.push(word);
        await db.set(key, { ...cur, filter: list }); clearAmCache(gid);
        await message.delete().catch(() => {});
        return message.channel.send(`✅ Added a word to the filter. (**${list.length}** total)`);
      }
      if (action === 'remove') {
        if (!word || !list.includes(word)) return message.reply('❌ That word is not in the filter.');
        await db.set(key, { ...cur, filter: list.filter(w => w !== word) }); clearAmCache(gid);
        await message.delete().catch(() => {});
        return message.channel.send(`✅ Removed a word from the filter. (**${list.length - 1}** total)`);
      }
      if (action === 'list' || !action) {
        if (!list.length) return message.reply('❌ No filtered words. Add with `-automod filter add <word>`');
        return message.author.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🧹 Filtered Words — ${message.guild.name}`).setDescription(list.map(w => `• ${w}`).join('\n').slice(0, 4000))] })
          .then(() => message.reply('📬 Sent you the filter list in DMs.'))
          .catch(() => message.reply('❌ I couldn\'t DM you — enable DMs from server members.'));
      }
      return message.reply('❌ Usage: `-automod filter add/remove/list <word>`');
    }
    if (sub === 'status' || !sub) {
      const am = await getAutomod(gid);
      const on = v => v ? '✅ On' : '❌ Off';
      return message.reply({ embeds: [new EmbedBuilder().setColor(am.enabled ? 0x00cc44 : 0xff4444).setTitle('🧹 Automod Status').addFields(
        { name: 'Automod',       value: on(am.enabled), inline: true },
        { name: 'Anti-Spam',     value: on(am.antispam), inline: true },
        { name: 'Anti-Link',     value: on(am.antilink), inline: true },
        { name: 'Anti-Caps',     value: on(am.anticaps), inline: true },
        { name: 'Anti-Mention',  value: on(am.antimention), inline: true },
        { name: 'Filtered Words', value: String(am.filter.length), inline: true },
      ).setTimestamp()] });
    }
    message.reply('❌ Subcommands: `enable` `disable` `status` `antispam/antilink/anticaps/antimention on/off` `filter add/remove/list`');
  }

  // ── -modlog ────────────────────────────────────────────────────
  else if (cmd === 'modlog') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
      return message.reply('❌ You need **Manage Server** permission.');
    if (args[0]?.toLowerCase() === 'disable') {
      await db.delete(`modlog.${message.guild.id}`);
      return message.reply('✅ Mod logging disabled.');
    }
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply('❌ Usage: `-modlog #channel` or `-modlog disable`');
    await db.set(`modlog.${message.guild.id}`, ch.id);
    return message.reply(`✅ Mod logs → ${ch}. Logging: message deletes/edits, joins, leaves, bans, and automod actions.`);
  }

  // ── -shiprig (secret, owner only) ──────────────────────────────
  else if (cmd === 'shiprig') {
    if (message.author.id !== message.guild.ownerId) return; // silent — it's a secret
    await message.delete().catch(() => {});
    const sub = args[0]?.toLowerCase();

    if (sub === 'clear') {
      const users = [...message.mentions.users.values()];
      if (users.length >= 1) {
        const a = users[0], b = users[1] ?? message.author;
        await db.delete(`shiprig.${message.guild.id}.${[a.id, b.id].sort().join('-')}`);
      } else {
        await db.delete(`shiprig.${message.guild.id}`); // clear all rigs
      }
      return message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0x00cc44).setDescription('🤫 Rig(s) cleared.')] })
        .then(m => setTimeout(() => m.delete().catch(() => {}), 4000));
    }

    const users = [...message.mentions.users.values()];
    const score = parseInt(args.find(x => /^\d{1,3}$/.test(x)));
    if (users.length < 1 || isNaN(score) || score < 0 || score > 100) {
      return message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0xff4444).setDescription('🤫 Usage: `-shiprig @a @b <0-100>` • `-shiprig @a <0-100>` (pairs with you) • `-shiprig clear [@a @b]`')] })
        .then(m => setTimeout(() => m.delete().catch(() => {}), 8000));
    }
    const a = users[0], b = users[1] ?? message.author;
    await db.set(`shiprig.${message.guild.id}.${[a.id, b.id].sort().join('-')}`, score);
    return message.channel.send({ content: `<@${message.author.id}>`, embeds: [new EmbedBuilder().setColor(0xff66aa).setDescription(`🤫 Rigged! **${a.username}** ✕ **${b.username}** will always roll **${score}%**.\nUndo with \`-shiprig clear @a @b\`.`)] })
      .then(m => setTimeout(() => m.delete().catch(() => {}), 8000));
  }

  // ── -say ──────────────────────────────────────────────────────
  else if (cmd === 'say') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
      return message.reply('❌ You need **Manage Server** permission.');
    const text = args.join(' ');
    if (!text) return message.reply('❌ Usage: `-say <message>`');
    await message.delete().catch(() => {});
    // allowedMentions: parse [] — the bot will never ping @everyone/roles/users via -say
    await message.channel.send({ content: text, allowedMentions: { parse: [] } });
  }
});

client.login(process.env.BOT_TOKEN);
