import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Guild,
  type GuildTextBasedChannel,
  type BaseInteraction,
  InteractionContextType,
  LabelBuilder,
  type Message,
  type MessageComponentInteraction,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  type OverwriteResolvable,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import type { Kysely } from 'kysely';
import { UserError } from '../../core/errors.ts';
import { kinds, type SettingSpec } from '../../core/settings.ts';
import type { BotContext } from '../../discord/context.ts';
import { embed, respond } from '../../discord/replies.ts';
import type { CommandSpec, ComponentSpec, Module } from '../../modules/types.ts';
import { memberRoleIds, requireQti } from '../qti/access.ts';
import { formatTranscript, slug, ticketChannelName, ticketId, type TranscriptMessage } from './format.ts';
import { PRIORITIES, PRIORITY_LABEL, type Priority, type TicketDatabase, type TicketTable } from './schema.ts';
import { TicketStore } from './store.ts';

const P = PermissionFlagsBits;
const TRANSCRIPT_LIMIT = 1000;
const store = (ctx: BotContext) => new TicketStore(ctx.db as unknown as Kysely<TicketDatabase>, ctx.clock);

const typesSetting: SettingSpec<string[]> = {
  key: 'tickets.types',
  description: 'Ticket categories people pick from, comma-separated (e.g. General, Bug report, Appeal)',
  default: ['General'],
  parse: (s: string) => {
    const list = [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];
    if (!list.length) throw new UserError('Give at least one ticket type');
    if (list.length > 25 || list.some((x) => x.length > 50)) throw new UserError('At most 25 types, each up to 50 characters');
    return list;
  },
  format: (v: string[]) => v.join(', '),
};

const SETTINGS: SettingSpec<any>[] = [
  { key: 'tickets.open_category', description: 'Category new tickets are created in', default: null, ...kinds.channel() },
  { key: 'tickets.closed_category', description: 'Category closed tickets are moved to', default: null, ...kinds.channel() },
  { key: 'tickets.support_roles', description: 'Roles that can see and manage every ticket', default: [], ...kinds.roles() },
  { key: 'tickets.transcript_channel', description: 'Where transcripts are also posted (optional)', default: null, ...kinds.channel() },
  typesSetting,
  { key: 'tickets.max_open', description: 'Open tickets one person may have at once', default: 2, ...kinds.int(1, 10) },
];

async function ticketSettings(ctx: BotContext, guildId: string) {
  const s = await ctx.settings.get(guildId);
  return {
    open: s.get<string | null>('tickets.open_category'),
    closed: s.get<string | null>('tickets.closed_category'),
    support: s.get<string[]>('tickets.support_roles'),
    transcripts: s.get<string | null>('tickets.transcript_channel'),
    types: s.get<string[]>('tickets.types'),
    maxOpen: s.get<number>('tickets.max_open'),
  };
}

async function isSupport(i: BaseInteraction, ctx: BotContext): Promise<boolean> {
  if (i.memberPermissions?.has(P.Administrator)) return true;
  const { support } = await ticketSettings(ctx, i.guildId!);
  const mine = memberRoleIds(i);
  return support.some((r) => mine.includes(r));
}

async function requireSupport(i: BaseInteraction, ctx: BotContext, action: string) {
  if (!(await isSupport(i, ctx))) throw new UserError(`Only support staff can ${action}`);
}

async function ticketHere(i: BaseInteraction, ctx: BotContext): Promise<TicketTable> {
  const t = i.channelId ? await store(ctx).byChannel(i.channelId) : undefined;
  if (!t) throw new UserError('Use this inside a ticket channel');
  return t;
}

async function ticketByArg(i: BaseInteraction, ctx: BotContext, n: string): Promise<TicketTable> {
  const t = await store(ctx).byNumber(i.guildId!, Number(n));
  if (!t || t.status === 'deleted') throw new UserError('That ticket no longer exists');
  return t;
}

function infoEmbed(t: TicketTable) {
  const e = embed(t.priority === 'urgent' ? 'error' : t.priority === 'high' ? 'warn' : 'info')
    .setTitle(`🎫 Ticket ${ticketId(t.number)}: ${t.subject}`.slice(0, 256))
    .setDescription(t.description || '*No description.*')
    .addFields(
      { name: 'Opened by', value: `<@${t.creator_id}>`, inline: true },
      { name: 'Priority', value: PRIORITY_LABEL[t.priority], inline: true },
      { name: 'Type', value: t.type, inline: true },
      { name: 'Ticket ID', value: ticketId(t.number), inline: true },
      { name: 'Claimed by', value: t.claimed_by ? `<@${t.claimed_by}>` : '*nobody yet*', inline: true },
    )
    .setTimestamp(new Date(t.created_at));
  return e;
}

function controlRows(n: number, disabled = false) {
  const b = (id: string, label: string, style: ButtonStyle, emoji: string) => new ButtonBuilder().setCustomId(`tk:${id}:${n}`).setLabel(label).setStyle(style).setEmoji(emoji).setDisabled(disabled);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(b('claim', 'Claim', ButtonStyle.Primary, '🙋'), b('add', 'Add member', ButtonStyle.Secondary, '➕'), b('rename', 'Rename', ButtonStyle.Secondary, '✏️')),
    new ActionRowBuilder<ButtonBuilder>().addComponents(b('close', 'Close', ButtonStyle.Danger, '🔒'), b('closereason', 'Close with reason', ButtonStyle.Danger, '📝'), b('transcriptclose', 'Transcript + Close', ButtonStyle.Danger, '📄')),
  ];
}

function closedRows(n: number) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`tk:reopen:${n}`).setLabel('Reopen').setStyle(ButtonStyle.Success).setEmoji('🔓'),
      new ButtonBuilder().setCustomId(`tk:transcript:${n}`).setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('📄'),
      new ButtonBuilder().setCustomId(`tk:delete:${n}`).setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    ),
  ];
}

const textModal = (customId: string, title: string, label: string, max: number, style: TextInputStyle, required = true, value?: string) => {
  const input = new TextInputBuilder().setCustomId('value').setStyle(style).setMaxLength(max).setRequired(required);
  if (value) input.setValue(value);
  return new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, 45)).addLabelComponents(new LabelBuilder().setLabel(label).setTextInputComponent(input));
};

async function textChannel(ctx: BotContext, guild: Guild, id: string): Promise<TextChannel | null> {
  const ch = await guild.channels.fetch(id).catch(() => null);
  return ch instanceof TextChannel ? ch : null;
}

const MEMBER_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.AddReactions];
const MEMBER_ALLOW_EDIT = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true, AddReactions: true } as const;

function overwrites(guild: Guild, botId: string, creatorId: string, support: string[], extra: string[]): OverwriteResolvable[] {
  return [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: botId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles] },
    { id: creatorId, allow: MEMBER_ALLOW },
    ...support.map((id) => ({ id, allow: [...MEMBER_ALLOW, P.ManageMessages] })),
    ...extra.map((id) => ({ id, allow: MEMBER_ALLOW })),
  ];
}

async function openTicket(i: ModalSubmitInteraction, ctx: BotContext, input: { type: string; priority: Priority; subject: string; description: string }) {
  const guild = i.guild!;
  const cfg = await ticketSettings(ctx, guild.id);
  if (!cfg.open || !cfg.support.length) throw new UserError('Tickets aren’t set up here yet. Ask an admin to run `/tickets setup`');
  if ((await store(ctx).openCountFor(guild.id, i.user.id)) >= cfg.maxOpen) {
    throw new UserError(`You already have ${cfg.maxOpen} open ticket${cfg.maxOpen === 1 ? '' : 's'}. Close one first`);
  }
  const category = await guild.channels.fetch(cfg.open).catch(() => null);
  if (category?.type !== ChannelType.GuildCategory) throw new UserError('The open-tickets category is missing. Ask an admin to run `/tickets setup` again');

  const s = store(ctx);
  const t = await s.create({ guildId: guild.id, channelId: '', creatorId: i.user.id, ...input });
  let channel: TextChannel;
  try {
    channel = await guild.channels.create({
      name: ticketChannelName(t.number, i.user.username),
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Ticket ${ticketId(t.number)} · ${input.subject}`.slice(0, 1024),
      permissionOverwrites: overwrites(guild, ctx.client.user!.id, i.user.id, cfg.support, []),
      reason: `Ticket ${ticketId(t.number)} opened by ${i.user.username}`,
    });
  } catch (err) {
    await s.discard(guild.id, t.number);
    ctx.log.warn({ err, guild_id: guild.id }, 'ticket channel creation failed');
    throw new UserError('I couldn’t create the ticket channel. The category may be full (50 channels), or I’m missing **Manage Channels** / **Manage Roles**');
  }
  const control = await channel.send({
    content: `<@${i.user.id}> ${cfg.support.map((r) => `<@&${r}>`).join(' ')}`,
    embeds: [infoEmbed({ ...t, channel_id: channel.id })],
    components: controlRows(t.number),
    allowedMentions: { users: [i.user.id], roles: cfg.support },
  });
  await s.update(guild.id, t.number, { channel_id: channel.id, control_message_id: control.id });
  await ctx.audit.record({ guildId: guild.id, actorId: i.user.id, action: 'ticket.open', target: channel.id, payload: { ticket: ticketId(t.number), type: input.type, priority: input.priority } });
  ctx.kickWorker();
  await i.editReply({ content: `🎫 Your ticket is open: <#${channel.id}> (${ticketId(t.number)})` });
}

async function fetchTranscript(channel: GuildTextBasedChannel, t: TicketTable, guildName: string): Promise<AttachmentBuilder> {
  const collected: Message[] = [];
  let before: string | undefined;
  while (collected.length < TRANSCRIPT_LIMIT) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;
    collected.push(...page.values());
    before = page.last()!.id;
    if (page.size < 100) break;
  }
  const messages: TranscriptMessage[] = collected
    .slice(0, TRANSCRIPT_LIMIT)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((m) => ({ createdAt: m.createdAt, authorTag: m.author.username, authorId: m.author.id, bot: m.author.bot, content: m.content, attachments: [...m.attachments.values()].map((a) => a.url), embeds: m.embeds.length }));
  const text = formatTranscript(
    {
      Server: guildName,
      Ticket: `${ticketId(t.number)} (${t.type}, ${t.priority})`,
      Subject: t.subject,
      'Opened by': t.creator_id,
      Opened: t.created_at,
      Exported: new Date().toISOString(),
    },
    messages,
  );
  return new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `transcript-${String(t.number).padStart(4, '0')}.txt` });
}

async function postTranscript(ctx: BotContext, guild: Guild, channel: TextChannel, t: TicketTable, actorId: string) {
  const file = await fetchTranscript(channel, t, guild.name);
  await channel.send({ content: `📄 Transcript of ${ticketId(t.number)}`, files: [file] });
  const { transcripts } = await ticketSettings(ctx, guild.id);
  const log = transcripts ? await textChannel(ctx, guild, transcripts) : null;
  if (log && log.id !== channel.id) {
    await log
      .send({ content: `📄 Transcript of ${ticketId(t.number)} · ${t.subject} · opened by <@${t.creator_id}>`, files: [await fetchTranscript(channel, t, guild.name)], allowedMentions: { parse: [] } })
      .catch((err) => ctx.log.warn({ err }, 'could not post transcript to the transcript channel'));
  }
  await ctx.audit.record({ guildId: guild.id, actorId, action: 'ticket.transcript', target: channel.id, payload: { ticket: ticketId(t.number) } });
}

async function closeTicket(ctx: BotContext, guild: Guild, t: TicketTable, actorId: string, reason: string | null): Promise<void> {
  if (!(await store(ctx).markClosed(guild.id, t.number, actorId, reason))) throw new UserError(`${ticketId(t.number)} is already closed`);
  const channel = await textChannel(ctx, guild, t.channel_id);
  if (channel) {
    if (t.control_message_id) {
      const control = await channel.messages.fetch(t.control_message_id).catch(() => null);
      await control?.edit({ components: controlRows(t.number, true) }).catch(() => undefined);
    }
    const e = embed('error')
      .setTitle('🔒 Ticket Closed')
      .addFields({ name: 'Closed by', value: `<@${actorId}>`, inline: true }, { name: 'Ticket', value: ticketId(t.number), inline: true })
      .setTimestamp();
    if (reason) e.addFields({ name: 'Reason', value: reason.slice(0, 1024) });
    await channel.send({ embeds: [e], components: closedRows(t.number), allowedMentions: { parse: [] } });
    const people = [t.creator_id, ...(await store(ctx).members(guild.id, t.number))];
    for (const id of people) await channel.permissionOverwrites.delete(id, 'ticket closed').catch(() => undefined);
    const { closed } = await ticketSettings(ctx, guild.id);
    if (closed) await channel.setParent(closed, { lockPermissions: false, reason: 'ticket closed' }).catch((err) => ctx.log.warn({ err }, 'could not move closed ticket'));
    await channel.setName(ticketChannelName(t.number, channel.name.replace(/^(ticket|closed)-\d+-/, ''), true)).catch(() => undefined);
  }
  await ctx.client.users
    .send(t.creator_id, { content: `🔒 Your ticket ${ticketId(t.number)} (“${t.subject}”) in **${guild.name}** was closed${reason ? `: ${reason}` : '.'}`, allowedMentions: { parse: [] } })
    .catch(() => undefined);
  await ctx.audit.record({ guildId: guild.id, actorId, action: 'ticket.close', target: t.channel_id, payload: { ticket: ticketId(t.number), reason } });
  ctx.kickWorker();
}

async function reopenTicket(ctx: BotContext, guild: Guild, t: TicketTable, actorId: string): Promise<void> {
  if (t.status !== 'closed') throw new UserError(`${ticketId(t.number)} isn’t closed`);
  const channel = await textChannel(ctx, guild, t.channel_id);
  if (!channel) throw new UserError('That ticket’s channel is gone');
  const cfg = await ticketSettings(ctx, guild.id);
  if (cfg.open) await channel.setParent(cfg.open, { lockPermissions: false, reason: 'ticket reopened' }).catch(() => undefined);
  for (const id of [t.creator_id, ...(await store(ctx).members(guild.id, t.number))]) {
    await channel.permissionOverwrites.edit(id, MEMBER_ALLOW_EDIT, { reason: 'ticket reopened' }).catch(() => undefined);
  }
  await channel.setName(ticketChannelName(t.number, channel.name.replace(/^(ticket|closed)-\d+-/, ''))).catch(() => undefined);
  const control = await channel.send({ content: `🔓 Reopened by <@${actorId}>.`, embeds: [infoEmbed(t)], components: controlRows(t.number), allowedMentions: { parse: [] } });
  await store(ctx).update(guild.id, t.number, { status: 'open', closed_at: null, closed_by: null, close_reason: null, control_message_id: control.id });
  await ctx.audit.record({ guildId: guild.id, actorId, action: 'ticket.reopen', target: channel.id, payload: { ticket: ticketId(t.number) } });
  ctx.kickWorker();
}

async function addMembers(ctx: BotContext, guild: Guild, t: TicketTable, userIds: string[], actorId: string): Promise<string[]> {
  const channel = await textChannel(ctx, guild, t.channel_id);
  if (!channel) throw new UserError('That ticket’s channel is gone');
  const added: string[] = [];
  for (const id of userIds) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member || member.user.bot) continue;
    await channel.permissionOverwrites.edit(id, MEMBER_ALLOW_EDIT, { reason: `added to ticket by ${actorId}` });
    await store(ctx).addMember(guild.id, t.number, id, actorId);
    added.push(id);
  }
  if (added.length) {
    await channel.send({ content: `➕ ${added.map((id) => `<@${id}>`).join(', ')} added by <@${actorId}>.`, allowedMentions: { users: added } });
    await ctx.audit.record({ guildId: guild.id, actorId, action: 'ticket.add', target: channel.id, payload: { ticket: ticketId(t.number), users: added } });
    ctx.kickWorker();
  }
  return added;
}

async function removeMember(ctx: BotContext, guild: Guild, t: TicketTable, userId: string, actorId: string) {
  if (userId === t.creator_id) throw new UserError('That’s the person who opened the ticket. Close the ticket instead');
  const channel = await textChannel(ctx, guild, t.channel_id);
  if (!channel) throw new UserError('That ticket’s channel is gone');
  await channel.permissionOverwrites.delete(userId, `removed from ticket by ${actorId}`).catch(() => undefined);
  await store(ctx).removeMember(guild.id, t.number, userId);
  await channel.send({ content: `➖ <@${userId}> removed by <@${actorId}>.`, allowedMentions: { parse: [] } });
  await ctx.audit.record({ guildId: guild.id, actorId, action: 'ticket.remove', target: channel.id, payload: { ticket: ticketId(t.number), user: userId } });
  ctx.kickWorker();
}

async function renameTicket(ctx: BotContext, guild: Guild, t: TicketTable, label: string, actorId: string) {
  const channel = await textChannel(ctx, guild, t.channel_id);
  if (!channel) throw new UserError('That ticket’s channel is gone');
  const name = ticketChannelName(t.number, slug(label), t.status === 'closed');
  await channel.setName(name, `renamed by ${actorId}`);
  await ctx.audit.record({ guildId: guild.id, actorId, action: 'ticket.rename', target: channel.id, payload: { ticket: ticketId(t.number), name } });
  ctx.kickWorker();
  return name;
}

async function claimTicket(ctx: BotContext, guild: Guild, t: TicketTable, actorId: string) {
  await store(ctx).update(guild.id, t.number, { claimed_by: actorId });
  const channel = await textChannel(ctx, guild, t.channel_id);
  if (channel && t.control_message_id) {
    const control = await channel.messages.fetch(t.control_message_id).catch(() => null);
    await control?.edit({ embeds: [infoEmbed({ ...t, claimed_by: actorId })] }).catch(() => undefined);
  }
  await channel?.send({ content: `🙋 <@${actorId}> is handling this ticket.`, allowedMentions: { parse: [] } });
  await ctx.audit.record({ guildId: guild.id, actorId, action: 'ticket.claim', target: t.channel_id, payload: { ticket: ticketId(t.number) } });
  ctx.kickWorker();
}

function panelMessage() {
  return {
    embeds: [embed('primary').setTitle('🎫 Support Tickets').setDescription('Need help from the team? Press **Create Ticket** and fill in the form. A private channel will open for you and the support team.')],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('tk:new').setLabel('Create Ticket').setStyle(ButtonStyle.Primary).setEmoji('🎫'))],
  };
}

const ticketsCmd: CommandSpec = {
  replyMode: 'ephemeral',
  data: new SlashCommandBuilder()
    .setName('tickets')
    .setDescription('Ticket system setup and overview')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Set the ticket categories and support role, and post the Create Ticket panel')
        .addChannelOption((o) => o.setName('open_category').setDescription('Category for open tickets').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
        .addChannelOption((o) => o.setName('closed_category').setDescription('Category for closed tickets').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
        .addRoleOption((o) => o.setName('support_role').setDescription('Role that handles tickets (add more with /config set tickets.support_roles)').setRequired(true))
        .addChannelOption((o) => o.setName('panel_channel').setDescription('Where to post the panel (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) => s.setName('panel').setDescription('Post the Create Ticket panel again').addChannelOption((o) => o.setName('channel').setDescription('Where (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Open or closed tickets')
        .addStringOption((o) => o.setName('status').setDescription('Which').addChoices({ name: 'open', value: 'open' }, { name: 'closed', value: 'closed' })),
    )
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const guild = i.guild!;
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      await requireSupport(i, ctx, 'list tickets');
      const status = (i.options.getString('status') ?? 'open') as 'open' | 'closed';
      const rows = await store(ctx).list(guild.id, status);
      const lines = rows.map((t) => `${PRIORITY_LABEL[t.priority].split(' ')[0]} **${ticketId(t.number)}** <#${t.channel_id}> · ${t.subject.slice(0, 60)} · <@${t.creator_id}>${t.claimed_by ? ` · 🙋 <@${t.claimed_by}>` : ''} · <t:${Math.floor(Date.parse(t.created_at) / 1000)}:R>`);
      await respond(i, { embeds: [embed('info').setTitle(`${status === 'open' ? 'Open' : 'Closed'} tickets (${rows.length}${rows.length === 50 ? '+' : ''})`).setDescription(lines.join('\n').slice(0, 4000) || '*None.*')] }, { ephemeral: true });
      return;
    }
    await requireQti(i, ctx, 'set up tickets');
    let target = i.options.getChannel(sub === 'setup' ? 'panel_channel' : 'channel')?.id ?? i.channelId;
    if (sub === 'setup') {
      const open = i.options.getChannel('open_category', true).id;
      const closed = i.options.getChannel('closed_category', true).id;
      if (open === closed) throw new UserError('Use two different categories for open and closed tickets');
      const role = i.options.getRole('support_role', true);
      if (role.id === guild.id) throw new UserError('Pick a real role, not @everyone');
      const me = guild.members.me ?? (await guild.members.fetchMe());
      if (!me.permissions.has([P.ManageChannels, P.ManageRoles])) throw new UserError('I need **Manage Channels** and **Manage Roles** to run tickets');
      await ctx.settings.set(guild.id, { 'tickets.open_category': open, 'tickets.closed_category': closed, 'tickets.support_roles': [role.id] });
      await ctx.audit.record({ guildId: guild.id, actorId: i.user.id, action: 'tickets.setup', payload: { open, closed, supportRole: role.id } });
      ctx.kickWorker();
    } else {
      const cfg = await ticketSettings(ctx, guild.id);
      if (!cfg.open || !cfg.support.length) throw new UserError('Run `/tickets setup` first');
    }
    const channel = await guild.channels.fetch(target).catch(() => null);
    if (!channel?.isSendable()) throw new UserError(`I can’t post in <#${target}>`);
    await channel.send(panelMessage());
    target = channel.id;
    await respond(i, { content: `✅ ${sub === 'setup' ? 'Tickets are set up and the' : 'The'} panel is posted in <#${target}>.` }, { ephemeral: true });
  },
};

const ticketCmd: CommandSpec = {
  replyMode: 'ephemeral',
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Manage the ticket you’re in')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('add').setDescription('Give someone access to this ticket').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Take someone’s access away').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
    .addSubcommand((s) => s.setName('rename').setDescription('Rename this ticket (its number stays)').addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(60)))
    .addSubcommand((s) => s.setName('claim').setDescription('Mark yourself as handling this ticket'))
    .addSubcommand((s) => s.setName('close').setDescription('Close this ticket').addStringOption((o) => o.setName('reason').setDescription('Shown to the person who opened it').setMaxLength(500)))
    .addSubcommand((s) => s.setName('reopen').setDescription('Reopen this closed ticket'))
    .addSubcommand((s) => s.setName('transcript').setDescription('Post a transcript of this ticket'))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const guild = i.guild!;
    const t = await ticketHere(i, ctx);
    const sub = i.options.getSubcommand();
    if (sub === 'close') {
      if (i.user.id !== t.creator_id) await requireSupport(i, ctx, 'close other people’s tickets');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await closeTicket(ctx, guild, t, i.user.id, i.options.getString('reason'));
      await respond(i, { content: `Closed ${ticketId(t.number)}.` });
      return;
    }
    await requireSupport(i, ctx, 'manage tickets');
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'add') {
      const added = await addMembers(ctx, guild, t, [i.options.getUser('user', true).id], i.user.id);
      await respond(i, { content: added.length ? 'Added.' : 'Nobody added (bots and non-members are skipped).' });
    } else if (sub === 'remove') {
      await removeMember(ctx, guild, t, i.options.getUser('user', true).id, i.user.id);
      await respond(i, { content: 'Removed.' });
    } else if (sub === 'rename') {
      await respond(i, { content: `Renamed to \`${await renameTicket(ctx, guild, t, i.options.getString('name', true), i.user.id)}\`.` });
    } else if (sub === 'claim') {
      await claimTicket(ctx, guild, t, i.user.id);
      await respond(i, { content: 'Claimed.' });
    } else if (sub === 'reopen') {
      await reopenTicket(ctx, guild, t, i.user.id);
      await respond(i, { content: `Reopened ${ticketId(t.number)}.` });
    } else {
      const channel = await textChannel(ctx, guild, t.channel_id);
      if (!channel) throw new UserError('That ticket’s channel is gone');
      await postTranscript(ctx, guild, channel, t, i.user.id);
      await respond(i, { content: 'Transcript posted.' });
    }
  },
};

const pendingDeletes = new Map<string, number>();

const components: ComponentSpec = {
  prefix: 'tk',
  async handle(raw, ctx, [action = '', arg = '']) {
    const guild = raw.guild!;

    if (action === 'new' && raw.isButton()) {
      const cfg = await ticketSettings(ctx, guild.id);
      if (!cfg.open || !cfg.support.length) throw new UserError('Tickets aren’t set up here yet');
      if ((await store(ctx).openCountFor(guild.id, raw.user.id)) >= cfg.maxOpen) throw new UserError(`You already have ${cfg.maxOpen} open ticket${cfg.maxOpen === 1 ? '' : 's'}. Close one first`);
      const modal = new ModalBuilder().setCustomId('tk:create').setTitle('Create Ticket');
      if (cfg.types.length > 1) {
        modal.addLabelComponents(
          new LabelBuilder().setLabel('Type').setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('type').addOptions(cfg.types.map((t) => ({ label: t, value: t })))),
        );
      }
      modal.addLabelComponents(
        new LabelBuilder()
          .setLabel('Priority')
          .setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('priority').addOptions(PRIORITIES.map((p) => ({ label: PRIORITY_LABEL[p], value: p, default: p === 'medium' })))),
        new LabelBuilder().setLabel('Subject').setTextInputComponent(new TextInputBuilder().setCustomId('subject').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
        new LabelBuilder().setLabel('Description').setDescription('What do you need help with?').setTextInputComponent(new TextInputBuilder().setCustomId('description').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)),
      );
      await raw.showModal(modal);
      return;
    }
    if (action === 'create' && raw.isModalSubmit()) {
      await raw.deferReply({ flags: MessageFlags.Ephemeral });
      const cfg = await ticketSettings(ctx, guild.id);
      const type = cfg.types.length > 1 ? (raw.fields.getStringSelectValues('type')[0] ?? cfg.types[0]!) : cfg.types[0]!;
      const priority = (raw.fields.getStringSelectValues('priority')[0] ?? 'medium') as Priority;
      await openTicket(raw, ctx, { type, priority, subject: raw.fields.getTextInputValue('subject').trim(), description: raw.fields.getTextInputValue('description').trim() });
      return;
    }

    const t = await ticketByArg(raw, ctx, arg);
    const i = raw as MessageComponentInteraction | ModalSubmitInteraction;

    const creatorAllowed = action === 'close' || action === 'closereason' || action === 'closereason-modal';
    if (!(creatorAllowed && i.user.id === t.creator_id)) await requireSupport(i, ctx, 'do that');

    switch (action) {
      case 'claim':
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await claimTicket(ctx, guild, t, i.user.id);
        await i.editReply({ content: 'Claimed.' });
        return;
      case 'add':
        if (!i.isButton()) return;
        await i.showModal(
          new ModalBuilder()
            .setCustomId(`tk:add-modal:${t.number}`)
            .setTitle(`Add to ${ticketId(t.number)}`)
            .addLabelComponents(new LabelBuilder().setLabel('Members to add').setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId('users').setMinValues(1).setMaxValues(5))),
        );
        return;
      case 'add-modal': {
        if (!i.isModalSubmit()) return;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const users = [...(i.fields.getSelectedUsers('users')?.keys() ?? [])];
        const added = await addMembers(ctx, guild, t, users, i.user.id);
        await i.editReply({ content: added.length ? `Added ${added.length}.` : 'Nobody added (bots and non-members are skipped).' });
        return;
      }
      case 'rename':
        if (!i.isButton()) return;
        await i.showModal(textModal(`tk:rename-modal:${t.number}`, `Rename ${ticketId(t.number)}`, `New name (the number ${ticketId(t.number)} stays)`, 60, TextInputStyle.Short));
        return;
      case 'rename-modal': {
        if (!i.isModalSubmit()) return;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const name = await renameTicket(ctx, guild, t, i.fields.getTextInputValue('value'), i.user.id);
        await i.editReply({ content: `Renamed to \`${name}\`.` });
        return;
      }
      case 'close':
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await closeTicket(ctx, guild, t, i.user.id, null);
        await i.editReply({ content: `Closed ${ticketId(t.number)}.` });
        return;
      case 'closereason':
        if (!i.isButton()) return;
        await i.showModal(textModal(`tk:closereason-modal:${t.number}`, `Close ${ticketId(t.number)}`, 'Reason', 500, TextInputStyle.Paragraph));
        return;
      case 'closereason-modal':
        if (!i.isModalSubmit()) return;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await closeTicket(ctx, guild, t, i.user.id, i.fields.getTextInputValue('value').trim() || null);
        await i.editReply({ content: `Closed ${ticketId(t.number)}.` });
        return;
      case 'transcriptclose':
      case 'transcript': {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const channel = await textChannel(ctx, guild, t.channel_id);
        if (!channel) throw new UserError('That ticket’s channel is gone');
        await postTranscript(ctx, guild, channel, t, i.user.id);
        if (action === 'transcriptclose') await closeTicket(ctx, guild, t, i.user.id, null);
        await i.editReply({ content: action === 'transcriptclose' ? `Transcript posted and ${ticketId(t.number)} closed.` : 'Transcript posted.' });
        return;
      }
      case 'reopen':
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await reopenTicket(ctx, guild, t, i.user.id);
        await i.editReply({ content: `Reopened ${ticketId(t.number)}.` });
        return;
      case 'delete': {
        if (!i.isButton()) return;
        if (t.status !== 'closed') throw new UserError('Close the ticket before deleting it');
        const nonce = randomBytes(4).toString('hex');
        pendingDeletes.set(nonce, Date.now() + 60_000);
        await i.reply({
          content: `Delete ${ticketId(t.number)} and its channel for good? Post a transcript first if you need one.`,
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`tk:delete-confirm:${t.number}:${nonce}`).setLabel('Delete').setStyle(ButtonStyle.Danger))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      case 'delete-confirm': {
        if (!i.isButton()) return;
        const nonce = i.customId.split(':')[3] ?? '';
        if ((pendingDeletes.get(nonce) ?? 0) < Date.now()) throw new UserError('That confirmation expired');
        pendingDeletes.delete(nonce);
        await store(ctx).update(guild.id, t.number, { status: 'deleted' });
        await ctx.audit.record({ guildId: guild.id, actorId: i.user.id, action: 'ticket.delete', target: t.channel_id, payload: { ticket: ticketId(t.number) } });
        ctx.kickWorker();
        await i.update({ content: 'Deleting…', components: [] });
        const channel = await guild.channels.fetch(t.channel_id).catch(() => null);
        await channel?.delete(`ticket ${ticketId(t.number)} deleted by ${i.user.username}`);
        return;
      }
    }
  },
};

export const ticketsModule: Module = {
  id: 'tickets',
  name: 'Tickets',
  description: 'Private support tickets with numbered IDs, types, priorities, claims and transcripts',
  commands: [ticketsCmd, ticketCmd],
  components: [components],
  settings: SETTINGS,
  migrations: {
    '9001_tickets': {
      async up(db) {
        await db.schema
          .createTable('ticket')
          .addColumn('guild_id', 'text', (c) => c.notNull().references('guild.guild_id').onDelete('cascade'))
          .addColumn('number', 'integer', (c) => c.notNull())
          .addColumn('channel_id', 'text', (c) => c.notNull())
          .addColumn('creator_id', 'text', (c) => c.notNull())
          .addColumn('type', 'text', (c) => c.notNull())
          .addColumn('subject', 'text', (c) => c.notNull())
          .addColumn('description', 'text', (c) => c.notNull())
          .addColumn('priority', 'text', (c) => c.notNull())
          .addColumn('status', 'text', (c) => c.notNull())
          .addColumn('claimed_by', 'text')
          .addColumn('control_message_id', 'text')
          .addColumn('created_at', 'text', (c) => c.notNull())
          .addColumn('closed_at', 'text')
          .addColumn('closed_by', 'text')
          .addColumn('close_reason', 'text')
          .addPrimaryKeyConstraint('ticket_pk', ['guild_id', 'number'])
          .execute();
        await db.schema.createIndex('ticket_channel').on('ticket').column('channel_id').execute();
        await db.schema.createIndex('ticket_creator_status').on('ticket').columns(['guild_id', 'creator_id', 'status']).execute();
        await db.schema
          .createTable('ticket_member')
          .addColumn('guild_id', 'text', (c) => c.notNull().references('guild.guild_id').onDelete('cascade'))
          .addColumn('number', 'integer', (c) => c.notNull())
          .addColumn('user_id', 'text', (c) => c.notNull())
          .addColumn('added_by', 'text', (c) => c.notNull())
          .addColumn('added_at', 'text', (c) => c.notNull())
          .addPrimaryKeyConstraint('ticket_member_pk', ['guild_id', 'number', 'user_id'])
          .execute();
      },
    },
  },
  exportData: async (guildId, ctx) => store(ctx).exportAll(guildId),
};
