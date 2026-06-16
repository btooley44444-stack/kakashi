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
//  ANTINUKE
// ─────────────────────────────────────────────
const tracker = new Map();
const LIMITS  = { ban: 3, kick: 3, channelDelete: 3, roleDelete: 3 };
const WINDOW  = 10_000;

async function trackAction(guild, userId, type) {
  if (!(await db.get(`antinuke.${guild.id}.enabled`))) return false;
  if (userId === guild.ownerId || userId === guild.members.me?.id) return false;
  const wl = (await db.get(`antinuke.${guild.id}.whitelist`)) || [];
  if (wl.includes(userId)) return false;

  if (!tracker.has(guild.id)) tracker.set(guild.id, new Map());
  const gMap = tracker.get(guild.id);
  if (!gMap.has(userId)) gMap.set(userId, {});
  const u = gMap.get(userId);
  if (!u[type]) u[type] = [];

  const now = Date.now();
  u[type].push(now);
  u[type] = u[type].filter(t => now - t < WINDOW);

  if (u[type].length >= LIMITS[type]) {
    u[type] = [];
    return true;
  }
  return false;
}

async function punish(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member?.manageable) await member.roles.set([], 'Antinuke').catch(() => {});
  if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers))
    await guild.members.ban(userId, { reason: 'Antinuke: suspicious activity' }).catch(() => {});
}

async function nukeLog(guild, msg) {
  const id = await db.get(`antinuke.${guild.id}.logChannel`);
  if (id) guild.channels.cache.get(id)?.send(msg).catch(() => {});
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
    const ch  = guild.channels.cache.get(chId);
    let   msg = await db.get(`welcome.${guild.id}.message`);
    if (ch) {
      if (msg) {
        msg = msg
          .replace(/{user}/g, `<@${user.id}>`)
          .replace(/{username}/g, user.username)
          .replace(/{server}/g, guild.name)
          .replace(/{memberCount}/g, guild.memberCount);
        ch.send(msg).catch(() => {});
      } else {
        ch.send({
          embeds: [new EmbedBuilder().setColor(0x5865f2)
            .setTitle(`Welcome to ${guild.name}!`)
            .setDescription(`Hey <@${user.id}>, you are member **#${guild.memberCount}**!`)
            .setThumbnail(user.displayAvatarURL()).setTimestamp()],
        }).catch(() => {});
      }
    }
  }

  const roles = (await db.get(`autorole.${guild.id}.roles`)) || [];
  for (const roleId of roles) {
    const role = guild.roles.cache.get(roleId);
    if (role && guild.members.me.roles.highest.position > role.position)
      await member.roles.add(role).catch(() => {});
  }
});

// ─────────────────────────────────────────────
//  ANTINUKE EVENTS
// ─────────────────────────────────────────────
client.on('guildBanAdd', async ban => {
  try {
    const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBan, limit: 1 });
    const exec = logs.entries.first()?.executor;
    if (!exec || exec.id === ban.guild.members.me?.id) return;
    if (await trackAction(ban.guild, exec.id, 'ban')) {
      await nukeLog(ban.guild, `🚨 **Antinuke** — **${exec.tag}** hit the ban limit. Punishing...`);
      await punish(ban.guild, exec.id);
    }
  } catch {}
});

client.on('channelDelete', async channel => {
  if (!channel.guild) return;
  try {
    const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 1 });
    const exec = logs.entries.first()?.executor;
    if (!exec || exec.id === channel.guild.members.me?.id) return;
    if (await trackAction(channel.guild, exec.id, 'channelDelete')) {
      await nukeLog(channel.guild, `🚨 **Antinuke** — **${exec.tag}** hit the channel-delete limit. Punishing...`);
      await punish(channel.guild, exec.id);
    }
  } catch {}
});

client.on('roleDelete', async role => {
  try {
    const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 1 });
    const exec = logs.entries.first()?.executor;
    if (!exec || exec.id === role.guild.members.me?.id) return;
    if (await trackAction(role.guild, exec.id, 'roleDelete')) {
      await nukeLog(role.guild, `🚨 **Antinuke** — **${exec.tag}** hit the role-delete limit. Punishing...`);
      await punish(role.guild, exec.id);
    }
  } catch {}
});

client.on('guildMemberRemove', async member => {
  try {
    const logs  = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 1 });
    const entry = logs.entries.first();
    if (!entry?.executor || entry.target?.id !== member.id) return;
    if (Date.now() - entry.createdTimestamp > 3000) return;
    if (entry.executor.id === member.guild.members.me?.id) return;
    if (await trackAction(member.guild, entry.executor.id, 'kick')) {
      await nukeLog(member.guild, `🚨 **Antinuke** — **${entry.executor.tag}** hit the kick limit. Punishing...`);
      await punish(member.guild, entry.executor.id);
    }
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

  // -ban @user [reason]
  if (cmd === 'ban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers))
      return message.reply('❌ You need **Ban Members** permission.');
    const target = message.mentions.members.first()
      || await message.guild.members.fetch(args[0]).catch(() => null);
    if (!target) return message.reply('❌ Usage: `-ban @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (target.id === message.author.id)     return message.reply('❌ You cannot ban yourself.');
    if (target.id === message.guild.ownerId) return message.reply('❌ You cannot ban the server owner.');
    if (!target.bannable)                    return message.reply("❌ I can't ban that user.");
    if (message.member.roles.highest.position <= target.roles.highest.position)
      return message.reply('❌ That user has an equal or higher role than you.');
    await target.send({ embeds: [new EmbedBuilder().setColor(0xff4444)
      .setTitle(`Banned from ${message.guild.name}`).addFields({ name: 'Reason', value: reason })] }).catch(() => {});
    await target.ban({ reason: `${message.author.tag}: ${reason}` });
    message.reply({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('🔨 Banned')
      .addFields(
        { name: 'User',      value: `${target.user.tag}`, inline: true },
        { name: 'Moderator', value: message.author.tag,   inline: true },
        { name: 'Reason',    value: reason },
      ).setTimestamp()] });
  }

  // -kick @user [reason]
  else if (cmd === 'kick') {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers))
      return message.reply('❌ You need **Kick Members** permission.');
    const target = message.mentions.members.first()
      || await message.guild.members.fetch(args[0]).catch(() => null);
    if (!target) return message.reply('❌ Usage: `-kick @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (target.id === message.author.id)     return message.reply('❌ You cannot kick yourself.');
    if (target.id === message.guild.ownerId) return message.reply('❌ You cannot kick the server owner.');
    if (!target.kickable)                    return message.reply("❌ I can't kick that user.");
    if (message.member.roles.highest.position <= target.roles.highest.position)
      return message.reply('❌ That user has an equal or higher role than you.');
    await target.send({ embeds: [new EmbedBuilder().setColor(0xff8800)
      .setTitle(`Kicked from ${message.guild.name}`).addFields({ name: 'Reason', value: reason })] }).catch(() => {});
    await target.kick(`${message.author.tag}: ${reason}`);
    message.reply({ embeds: [new EmbedBuilder().setColor(0xff8800).setTitle('👢 Kicked')
      .addFields(
        { name: 'User',      value: `${target.user.tag}`, inline: true },
        { name: 'Moderator', value: message.author.tag,   inline: true },
        { name: 'Reason',    value: reason },
      ).setTimestamp()] });
  }

  // -timeout @user <60s|5m|10m|1h|1d|1w> [reason]
  else if (cmd === 'timeout' || cmd === 'mute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return message.reply('❌ You need **Timeout Members** permission.');
    const target = message.mentions.members.first()
      || await message.guild.members.fetch(args[0]).catch(() => null);
    if (!target) return message.reply('❌ Usage: `-timeout @user <60s|5m|10m|1h|1d|1w> [reason]`');
    const durations = { '60s': 60, '5m': 300, '10m': 600, '1h': 3600, '1d': 86400, '1w': 604800 };
    const durKey    = args[1]?.toLowerCase();
    const secs      = durations[durKey];
    if (!secs) return message.reply('❌ Duration must be: `60s` `5m` `10m` `1h` `1d` `1w`');
    const reason = args.slice(2).join(' ') || 'No reason provided';
    if (!target.moderatable) return message.reply("❌ I can't timeout that user.");
    if (message.member.roles.highest.position <= target.roles.highest.position)
      return message.reply('❌ That user has an equal or higher role than you.');
    await target.timeout(secs * 1000, `${message.author.tag}: ${reason}`);
    message.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('⏱️ Timed Out')
      .addFields(
        { name: 'User',      value: `${target.user.tag}`, inline: true },
        { name: 'Duration',  value: durKey,               inline: true },
        { name: 'Moderator', value: message.author.tag,   inline: true },
        { name: 'Reason',    value: reason },
      ).setTimestamp()] });
  }

  // -warn @user <reason>
  else if (cmd === 'warn') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return message.reply('❌ You need **Timeout Members** permission.');
    const target = message.mentions.members.first()
      || await message.guild.members.fetch(args[0]).catch(() => null);
    if (!target) return message.reply('❌ Usage: `-warn @user <reason>`');
    const reason = args.slice(1).join(' ');
    if (!reason) return message.reply('❌ Please provide a reason.');
    if (target.id === message.author.id) return message.reply('❌ You cannot warn yourself.');
    const key = `warnings.${message.guild.id}.${target.id}`;
    await db.push(key, { reason, moderator: message.author.tag, date: new Date().toISOString() });
    const count = ((await db.get(key)) || []).length;
    await target.send({ embeds: [new EmbedBuilder().setColor(0xffcc00)
      .setTitle(`Warned in ${message.guild.name}`)
      .addFields({ name: 'Reason', value: reason }, { name: 'Warning #', value: String(count) })] }).catch(() => {});
    message.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('⚠️ Warned')
      .addFields(
        { name: 'User',      value: `${target.user.tag}`, inline: true },
        { name: 'Warning #', value: String(count),        inline: true },
        { name: 'Moderator', value: message.author.tag,   inline: true },
        { name: 'Reason',    value: reason },
      ).setTimestamp()] });
  }

  // -warnings @user  /  -warnings clear @user
  else if (cmd === 'warnings' || cmd === 'warns') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return message.reply('❌ You need **Timeout Members** permission.');
    const isClear = args[0]?.toLowerCase() === 'clear';
    const target  = isClear
      ? message.mentions.users.first() || await client.users.fetch(args[1]).catch(() => null)
      : message.mentions.users.first() || await client.users.fetch(args[0]).catch(() => null);
    if (!target) return message.reply('❌ Usage: `-warnings @user` or `-warnings clear @user`');
    const key = `warnings.${message.guild.id}.${target.id}`;
    if (isClear) {
      await db.delete(key);
      return message.reply(`✅ Cleared all warnings for **${target.tag}**.`);
    }
    const list = (await db.get(key)) || [];
    if (!list.length) return message.reply(`✅ **${target.tag}** has no warnings.`);
    const lines = list.slice(-10).reverse().map((w, i) =>
      `**${list.length - i}.** ${w.reason}\n> by ${w.moderator} • <t:${Math.floor(new Date(w.date).getTime() / 1000)}:R>`
    );
    message.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00)
      .setTitle(`⚠️ Warnings for ${target.tag}`)
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `Total: ${list.length}` }).setTimestamp()] });
  }

  // -purge <amount>  /  -purge @user <amount>
  else if (cmd === 'purge' || cmd === 'clear') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
      return message.reply('❌ You need **Manage Messages** permission.');
    const filterMember = message.mentions.members.first();
    const amount       = parseInt(filterMember ? args[1] : args[0]);
    if (isNaN(amount) || amount < 1 || amount > 100)
      return message.reply('❌ Usage: `-purge <1-100>` or `-purge @user <1-100>`');
    await message.delete().catch(() => {});
    const fetched  = await message.channel.messages.fetch({ limit: filterMember ? 100 : amount });
    const toDelete = filterMember
      ? [...fetched.filter(m => m.author.id === filterMember.id).values()].slice(0, amount)
      : [...fetched.values()];
    const deleted  = await message.channel.bulkDelete(toDelete, true);
    const confirm  = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x00cc44)
      .setDescription(`🗑️ Deleted **${deleted.size}** messages.`)] });
    setTimeout(() => confirm.delete().catch(() => {}), 4000);
  }

  // -role add/remove @user @role
  else if (cmd === 'role') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles))
      return message.reply('❌ You need **Manage Roles** permission.');
    const sub    = args[0]?.toLowerCase();
    const target = message.mentions.members.first();
    const role   = message.mentions.roles.first();
    if (!['add', 'remove'].includes(sub)) return message.reply('❌ Usage: `-role add @user @role` or `-role remove @user @role`');
    if (!target) return message.reply('❌ Please mention a user.');
    if (!role)   return message.reply('❌ Please mention a role.');
    if (message.guild.members.me.roles.highest.position <= role.position) return message.reply("❌ That role is above my highest role.");
    if (message.member.roles.highest.position <= role.position)           return message.reply("❌ That role is above your highest role.");
    if (role.managed) return message.reply('❌ That role is managed by an integration.');
    if (sub === 'add') {
      if (target.roles.cache.has(role.id)) return message.reply(`❌ ${target} already has **${role.name}**.`);
      await target.roles.add(role, `Added by ${message.author.tag}`);
      message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('✅ Role Added')
        .addFields({ name: 'Member', value: `${target}`, inline: true }, { name: 'Role', value: `${role}`, inline: true })] });
    } else {
      if (!target.roles.cache.has(role.id)) return message.reply(`❌ ${target} doesn't have **${role.name}**.`);
      await target.roles.remove(role, `Removed by ${message.author.tag}`);
      message.reply({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('✅ Role Removed')
        .addFields({ name: 'Member', value: `${target}`, inline: true }, { name: 'Role', value: `${role}`, inline: true })] });
    }
  }

  // -setwelcome #channel / message <text> / disable / test
  else if (cmd === 'setwelcome') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
      return message.reply('❌ You need **Manage Server** permission.');
    const gid = message.guild.id;
    const ch  = message.mentions.channels.first();
    if (ch) {
      await db.set(`welcome.${gid}.channel`, ch.id);
      return message.reply(`✅ Welcome channel set to ${ch}.\nSet a message with \`-setwelcome message Hello {user}!\``);
    }
    const sub = args[0]?.toLowerCase();
    if (sub === 'message') {
      const text = args.slice(1).join(' ');
      if (!text) return message.reply('❌ Usage: `-setwelcome message Hello {user}!`');
      await db.set(`welcome.${gid}.message`, text);
      return message.reply(`✅ Welcome message set! Placeholders: \`{user}\` \`{username}\` \`{server}\` \`{memberCount}\``);
    }
    if (sub === 'disable') {
      await db.delete(`welcome.${gid}.channel`);
      await db.delete(`welcome.${gid}.message`);
      return message.reply('✅ Welcome messages disabled.');
    }
    if (sub === 'test') {
      const channelId = await db.get(`welcome.${gid}.channel`);
      if (!channelId) return message.reply('❌ Set a channel first with `-setwelcome #channel`.');
      const channel = message.guild.channels.cache.get(channelId);
      if (!channel) return message.reply('❌ Welcome channel no longer exists.');
      let msg = await db.get(`welcome.${gid}.message`);
      if (msg) {
        msg = msg
          .replace(/{user}/g, `<@${message.author.id}>`)
          .replace(/{username}/g, message.author.username)
          .replace(/{server}/g, message.guild.name)
          .replace(/{memberCount}/g, message.guild.memberCount);
        await channel.send(msg);
      } else {
        await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2)
          .setTitle(`Welcome to ${message.guild.name}!`)
          .setDescription(`Hey <@${message.author.id}>, you are member **#${message.guild.memberCount}**!`)
          .setThumbnail(message.author.displayAvatarURL()).setTimestamp()] });
      }
      return message.reply(`✅ Test sent to ${channel}.`);
    }
    message.reply('❌ Usage: `-setwelcome #channel` | `-setwelcome message <text>` | `-setwelcome disable` | `-setwelcome test`');
  }

  // -autorole add/remove/list @role
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
      if (roles.includes(role.id)) return message.reply(`❌ **${role.name}** is already an autorole.`);
      roles.push(role.id);
      await db.set(key, roles);
      return message.reply(`✅ **${role.name}** will now be given to all new members.`);
    }
    if (sub === 'remove') {
      if (!role) return message.reply('❌ Usage: `-autorole remove @role`');
      const roles = (await db.get(key)) || [];
      if (!roles.includes(role.id)) return message.reply(`❌ **${role.name}** is not an autorole.`);
      await db.set(key, roles.filter(id => id !== role.id));
      return message.reply(`✅ Removed **${role.name}** from autoroles.`);
    }
    if (sub === 'list') {
      const roles = (await db.get(key)) || [];
      if (!roles.length) return message.reply('❌ No autoroles set.');
      const lines = roles.map(id => {
        const r = message.guild.roles.cache.get(id);
        return r ? `• ${r}` : `• Unknown (\`${id}\`)`;
      });
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2)
        .setTitle('🎭 Autoroles').setDescription(lines.join('\n'))
        .setFooter({ text: `${roles.length} role(s)` })] });
    }
    message.reply('❌ Usage: `-autorole add @role` | `-autorole remove @role` | `-autorole list`');
  }

  // -antinuke (owner only)
  else if (cmd === 'antinuke' || cmd === 'an') {
    if (message.author.id !== message.guild.ownerId)
      return message.reply('❌ Only the **server owner** can manage antinuke.');
    const sub = args[0]?.toLowerCase();
    const gid = message.guild.id;
    if (sub === 'enable') {
      await db.set(`antinuke.${gid}.enabled`, true);
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x00cc44).setTitle('🛡️ Antinuke Enabled')
        .setDescription('Protecting against:\n• Mass bans (3+ in 10s)\n• Mass kicks (3+ in 10s)\n• Mass channel deletes (3+ in 10s)\n• Mass role deletes (3+ in 10s)\n\nUse `-antinuke whitelist add @user` to trust your admins.')] });
    }
    if (sub === 'disable') {
      await db.set(`antinuke.${gid}.enabled`, false);
      return message.reply('✅ Antinuke disabled.');
    }
    if (sub === 'setlog') {
      const ch = message.mentions.channels.first();
      if (!ch) return message.reply('❌ Usage: `-antinuke setlog #channel`');
      await db.set(`antinuke.${gid}.logChannel`, ch.id);
      return message.reply(`✅ Antinuke alerts will go to ${ch}.`);
    }
    if (sub === 'whitelist') {
      const action = args[1]?.toLowerCase();
      const user   = message.mentions.users.first();
      if (!['add', 'remove'].includes(action) || !user)
        return message.reply('❌ Usage: `-antinuke whitelist add @user` or `-antinuke whitelist remove @user`');
      const wlKey = `antinuke.${gid}.whitelist`;
      let   list  = (await db.get(wlKey)) || [];
      if (action === 'add') {
        if (list.includes(user.id)) return message.reply(`❌ **${user.tag}** is already whitelisted.`);
        list.push(user.id);
        await db.set(wlKey, list);
        return message.reply(`✅ **${user.tag}** added to the whitelist.`);
      } else {
        if (!list.includes(user.id)) return message.reply(`❌ **${user.tag}** is not whitelisted.`);
        await db.set(wlKey, list.filter(id => id !== user.id));
        return message.reply(`✅ **${user.tag}** removed from the whitelist.`);
      }
    }
    if (sub === 'status') {
      const enabled = await db.get(`antinuke.${gid}.enabled`);
      const wl      = (await db.get(`antinuke.${gid}.whitelist`)) || [];
      const logCh   = await db.get(`antinuke.${gid}.logChannel`);
      return message.reply({ embeds: [new EmbedBuilder().setColor(enabled ? 0x00cc44 : 0xff4444)
        .setTitle('🛡️ Antinuke Status')
        .addFields(
          { name: 'Status',      value: enabled ? '✅ Enabled' : '❌ Disabled',                   inline: true },
          { name: 'Log Channel', value: logCh ? `<#${logCh}>` : 'Not set',                       inline: true },
          { name: 'Whitelist',   value: wl.length ? wl.map(id => `<@${id}>`).join(', ') : 'None' },
        ).setTimestamp()] });
    }
    message.reply('❌ Usage: `-antinuke enable` | `disable` | `setlog #ch` | `whitelist add/remove @user` | `status`');
  }
});

client.login(process.env.BOT_TOKEN);
