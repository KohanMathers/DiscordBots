import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  type Guild,
  type GuildMember,
  GuildVerificationLevel,
  InteractionContextType,
  MessageFlags,
  PermissionsBitField,
  SlashCommandBuilder,
} from 'discord.js';
import { formatDuration } from '../../core/duration.ts';
import { UserError } from '../../core/errors.ts';
import type { BotContext } from '../../discord/context.ts';
import { embed, respond } from '../../discord/replies.ts';
import { t } from '../../messages.ts';
import { variant } from '../../variant.ts';
import type { CommandInteraction, CommandSpec, Module } from '../types.ts';

const ts = (d: Date | null | undefined, style = 'R') => (d ? `<t:${Math.floor(d.getTime() / 1000)}:${style}>` : 'unknown');

const bot: CommandSpec = {
  replyMode: 'public',
  data: new SlashCommandBuilder()
    .setName('bot')
    .setDescription(`About ${variant.name}`)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('ping').setDescription('Ping the bot (like a game of ping pong, but you only play once).'))
    .addSubcommand((s) => s.setName('info').setDescription('Version, uptime, links and how to get help.'))
    .addSubcommand((s) => s.setName('hello').setDescription('Say hello.'))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const sub = i.options.getSubcommand();
    if (sub === 'ping') {
      await respond(i, { content: t('bot.pong', { ms: Math.round(ctx.client.ws.ping) }) });
      return;
    }
    if (sub === 'hello') {
      const name = i.member && 'displayName' in i.member ? i.member.displayName : i.user.displayName;
      await respond(i, { content: t('bot.hello', { name }) });
      return;
    }
    const links = [
      variant.links.author && `[Author](${variant.links.author})`,
      ctx.supportUrl() && `[Support server](${ctx.supportUrl()})`,
      variant.links.source && `[Source](${variant.links.source})`,
    ].filter(Boolean);
    const e = embed('info')
      .setTitle(variant.name)
      .setDescription(variant.description)
      .addFields(
        { name: 'Version', value: ctx.version, inline: true },
        { name: 'Uptime', value: formatDuration(Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000)), inline: true },
        { name: 'Servers', value: String(ctx.client.guilds.cache.size), inline: true },
        { name: 'Commands', value: 'Use `/help` to see everything you can do.' },
      );
    if (links.length) e.addFields({ name: 'Links', value: links.join(' · ') });
    if (ctx.client.user) e.setThumbnail(ctx.client.user.displayAvatarURL());
    await respond(i, { embeds: [e] });
  },
};

function canRun(spec: CommandSpec, perms: Readonly<PermissionsBitField> | null): boolean {
  const need = spec.data.default_member_permissions;
  if (need === undefined || need === null) return true;
  if (need === '0') return Boolean(perms?.has('Administrator'));
  return Boolean(perms?.has(BigInt(need)));
}

const help: CommandSpec = {
  replyMode: 'ephemeral',
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('List the commands you can use')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('command').setDescription('Show details for one command').setAutocomplete(true))
    .toJSON(),
  async autocomplete(i, ctx) {
    const typed = i.options.getFocused().toLowerCase();
    const names = ctx.commandList().filter((c) => (c.spec.data.type ?? 1) === ApplicationCommandType.ChatInput && canRun(c.spec, i.memberPermissions)).map((c) => c.spec.data.name);
    await i.respond(names.filter((n) => n.includes(typed)).slice(0, 25).map((n) => ({ name: `/${n}`, value: n })));
  },
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const usable = [];
    for (const c of ctx.commandList()) {
      if (!canRun(c.spec, i.memberPermissions)) continue;
      if (!(await ctx.isModuleEnabled(i.guildId!, c.module.id))) continue;
      usable.push(c);
    }
    const wanted = i.options.getString('command');
    if (wanted) {
      const c = usable.find((u) => u.spec.data.name === wanted);
      if (!c) throw new UserError(`\`/${wanted}\` doesn't exist or you can't use it here`);
      const d = c.spec.data as { name: string; description?: string; options?: Array<{ name: string; description: string; type: number; required?: boolean; options?: Array<{ name: string; description: string; required?: boolean }> }> };
      const lines = (d.options ?? []).flatMap((o) =>
        o.type === ApplicationCommandOptionType.Subcommand
          ? [`**/${d.name} ${o.name}**: ${o.description}${(o.options ?? []).map((x) => `\n  • \`${x.name}\`${x.required ? '' : ' (optional)'}: ${x.description}`).join('')}`]
          : [`• \`${o.name}\`${o.required ? '' : ' (optional)'}: ${o.description}`],
      );
      const e = embed('info').setTitle(`/${d.name}`).setDescription(`${d.description ?? ''}\n\n${lines.join('\n')}`.slice(0, 4000));
      if (c.spec.memberPermissions?.length) e.setFooter({ text: `Needs: ${new PermissionsBitField(c.spec.memberPermissions).toArray().join(', ')}` });
      await respond(i, { embeds: [e] }, { ephemeral: true });
      return;
    }
    const e = embed('info').setTitle(t('help.title')).setFooter({ text: t('help.footer') });
    for (const m of ctx.modules) {
      const mine = usable.filter((u) => u.module.id === m.id);
      if (!mine.length) continue;
      const text = mine
        .flatMap((u) => {
          if ((u.spec.data.type ?? 1) !== ApplicationCommandType.ChatInput) return [`*${u.spec.data.name}* (right-click menu)`];
          const subs = ((u.spec.data as { options?: Array<{ type: number; name: string; description: string }> }).options ?? []).filter((o) => o.type === ApplicationCommandOptionType.Subcommand);
          const desc = 'description' in u.spec.data ? u.spec.data.description : '';
          return subs.length ? subs.map((s) => `\`/${u.spec.data.name} ${s.name}\` ${s.description}`) : [`\`/${u.spec.data.name}\` ${desc}`];
        })
        .join('\n');
      e.addFields({ name: m.name, value: text.slice(0, 1024) });
    }
    await respond(i, { embeds: [e] }, { ephemeral: true });
  },
};

async function memberEmbed(ctx: BotContext, guild: Guild, member: GuildMember, self: boolean) {
  const joined = member.joinedAt;
  const hoursIn = joined ? Math.floor((Date.now() - joined.getTime()) / 3_600_000) : null;
  const position = await ctx.joinIndex.position(guild.id, member.id);
  const counts = await ctx.joinIndex.counts(guild.id);
  const top = member.roles.highest.id === guild.id ? '@everyone' : `<@&${member.roles.highest.id}>`;
  const lines = [
    self ? t('member.whoami', { name: member.displayName }) : `**${member.displayName}** (<@${member.id}>)`,
    hoursIn !== null ? t(self ? 'member.time' : 'member.timeOther', { name: member.displayName, days: Math.floor(hoursIn / 24), hours: hoursIn % 24 }) : '',
    member.user.bot ? 'Bots don’t have a join position.' : position ? t(self ? 'member.position' : 'member.positionOther', { name: member.displayName, n: position }) : t('member.positionUnknown'),
    t('member.count', { n: counts ? counts.humans + counts.bots : guild.memberCount }),
  ].filter(Boolean);
  return embed('ok')
    .setAuthor({ name: member.user.username, iconURL: member.displayAvatarURL() })
    .setThumbnail(member.displayAvatarURL())
    .setDescription(lines.join('\n'))
    .addFields(
      { name: 'Username', value: member.user.username, inline: true },
      { name: 'Joined', value: ts(joined), inline: true },
      { name: 'Account created', value: ts(member.user.createdAt), inline: true },
      { name: 'Roles', value: String(member.roles.cache.size - 1), inline: true },
      { name: 'Top role', value: top, inline: true },
    );
}

async function showMember(i: CommandInteraction, ctx: BotContext, userId: string) {
  const guild = i.guild!;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new UserError('That user isn’t a member of this server');
  await respond(i, { embeds: [await memberEmbed(ctx, guild, member, userId === i.user.id)] });
}

const memberCmd: CommandSpec = {
  replyMode: 'public',
  data: new SlashCommandBuilder()
    .setName('member')
    .setDescription('Facts about a member')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('info')
        .setDescription('Name, time in the server, join position, roles and more')
        .addUserOption((o) => o.setName('user').setDescription('Who (default: you)')),
    )
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await showMember(i, ctx, i.options.getUser('user')?.id ?? i.user.id);
  },
};

const memberMenu: CommandSpec = {
  replyMode: 'ephemeral',
  data: new ContextMenuCommandBuilder().setName('Member info').setType(ApplicationCommandType.User).setContexts(InteractionContextType.Guild).toJSON(),
  async execute(i, ctx) {
    if (!i.isUserContextMenuCommand()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await showMember(i, ctx, i.targetId);
  },
};

const VERIFICATION: Record<number, string> = {
  [GuildVerificationLevel.None]: 'None',
  [GuildVerificationLevel.Low]: 'Low',
  [GuildVerificationLevel.Medium]: 'Medium',
  [GuildVerificationLevel.High]: 'High',
  [GuildVerificationLevel.VeryHigh]: 'Highest',
};

const server: CommandSpec = {
  replyMode: 'public',
  data: new SlashCommandBuilder()
    .setName('server')
    .setDescription('Facts about this server')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('info').setDescription('Owner, age, members, channels, roles and boosts'))
    .toJSON(),
  async execute(i, ctx) {
    const guild = i.guild!;
    const counts = await ctx.joinIndex.counts(guild.id);
    const members = counts ? `${counts.humans + counts.bots} (${counts.humans} people, ${counts.bots} bots)` : String(guild.memberCount);
    const e = embed('ok')
      .setTitle(guild.name)
      .addFields(
        { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
        { name: 'Created', value: `${ts(guild.createdAt, 'D')} (${ts(guild.createdAt)})`, inline: true },
        { name: 'Members', value: members, inline: true },
        { name: 'Channels', value: String(guild.channels.cache.size), inline: true },
        { name: 'Roles', value: String(guild.roles.cache.size - 1), inline: true },
        { name: 'Boosts', value: `${guild.premiumSubscriptionCount ?? 0} (level ${guild.premiumTier})`, inline: true },
        { name: 'Verification', value: VERIFICATION[guild.verificationLevel] ?? 'Unknown', inline: true },
      )
      .setFooter({ text: `Requested by ${i.user.username}`, iconURL: i.user.displayAvatarURL() });
    const icon = guild.iconURL();
    if (icon) e.setThumbnail(icon);
    await respond(i, { embeds: [e] });
  },
};

export async function backfillJoinIndex(ctx: BotContext, guild: Guild, force = false): Promise<void> {
  const settings = await ctx.settings.get(guild.id);
  const last = settings.get<string | null>('joinindex.backfilled_at');
  if (!force && last && Date.now() - Date.parse(last) < 86_400_000) return;
  await ctx.guilds.ensure(guild.id);
  const members = await guild.members.fetch();
  await ctx.joinIndex.replaceAll(
    guild.id,
    [...members.values()].filter((m) => m.joinedAt).map((m) => ({ userId: m.id, joinedAt: m.joinedAt!.toISOString(), isBot: m.user.bot })),
  );
  await ctx.settings.set(guild.id, { 'joinindex.backfilled_at': new Date().toISOString() });
  ctx.log.info({ guild_id: guild.id, members: members.size }, 'join index rebuilt');
}

export const infoModule: Module = {
  id: 'info',
  name: 'Info',
  description: 'Bot, member and server information',
  required: true,
  commands: [bot, help, memberCmd, memberMenu, server],
  settings: [{ key: 'joinindex.backfilled_at', description: 'internal', default: null, hidden: true, parse: (s: string) => s, format: (v: string | null) => v ?? 'never' }],
  events: {
    async memberAdd(m, ctx) {
      await ctx.guilds.ensure(m.guild.id);
      await ctx.joinIndex.add(m.guild.id, { userId: m.id, joinedAt: (m.joinedAt ?? new Date()).toISOString(), isBot: m.user.bot });
    },
    async memberRemove(m, ctx) {
      await ctx.joinIndex.remove(m.guild.id, m.id);
    },
    async guildJoin(g, ctx) {
      await backfillJoinIndex(ctx, g, true);
    },
    async ready(ctx) {
      for (const g of ctx.client.guilds.cache.values()) {
        await backfillJoinIndex(ctx, g).catch((err) => ctx.log.warn({ err, guild_id: g.id }, 'join index backfill failed'));
      }
    },
  },
};
