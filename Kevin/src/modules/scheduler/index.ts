import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ChannelType,
  type Guild,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { UserError } from '../../core/errors.ts';
import { SendError } from '../../core/ports.ts';
import { kinds } from '../../core/settings.ts';
import { mentionPolicyFor } from '../../core/text.ts';
import { allZones, type LocalDateTime, parseWhen, RECURRENCES, type Recurrence, resolveZone, v2DateParts } from '../../core/time.ts';
import { buildOutgoing, canPost, classifySendError, templateVars } from '../../discord/adapters.ts';
import type { BotContext } from '../../discord/context.ts';
import { embed, respond } from '../../discord/replies.ts';
import { t } from '../../messages.ts';
import type { EmbedSpec, ScheduledMessage, ScheduleHooks } from '../../services/schedule.ts';
import type { CommandInteraction, CommandSpec, ComponentSpec, Module } from '../types.ts';
import { readContentModal } from '../../discord/forms.ts';

const MM = PermissionFlagsBits.ManageMessages;
const TARGETS = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.PublicThread, ChannelType.AnnouncementThread] as const;
const PAGE = 10;
const unix = (ms: number | string) => Math.floor((typeof ms === 'string' ? Date.parse(ms) : ms) / 1000);
const REPEAT_LABEL: Record<string, string> = { 'FREQ=DAILY': 'daily', 'FREQ=WEEKLY': 'weekly', 'FREQ=MONTHLY': 'monthly' };

interface Draft {
  kind: 'create' | 'edit';
  userId: string;
  expires: number;
  keyword: string;
  channelId: string;
  local: LocalDateTime;
  timezone: string;
  recurrence: Recurrence | null;
  existing?: ScheduledMessage;
}
const drafts = new Map<string, Draft>();

const zoneAutocomplete: CommandSpec['autocomplete'] = async (i, ctx) => {
  const focused = i.options.getFocused(true);
  if (focused.name === 'keyword') {
    const typed = focused.value.toLowerCase();
    const list = await ctx.schedule.pending(i.guildId!);
    await i.respond(list.filter((m) => m.keyword.toLowerCase().includes(typed)).slice(0, 25).map((m) => ({ name: m.keyword, value: m.keyword })));
    return;
  }
  if (focused.name === 'when') {
    const v = focused.value.trim();
    const presets = ['in 1h', 'in 1d', 'tomorrow 09:00', '18:00'];
    await i.respond([...(v ? [v] : []), ...presets.filter((p) => p !== v)].slice(0, 25).map((p) => ({ name: p, value: p })));
    return;
  }
  const typed = focused.value.trim().toLowerCase().replace(/ /g, '_');
  const guildZone = (await ctx.settings.get(i.guildId!)).timezone;
  const zones = allZones().filter((z) => z.toLowerCase().includes(typed));
  const ordered = [guildZone, ...zones.filter((z) => z !== guildZone)].filter((z) => z.toLowerCase().includes(typed));
  await i.respond(ordered.slice(0, 25).map((z) => ({ name: z, value: z })));
};

function contentModal(nonce: string, title: string, prefill?: ScheduledMessage) {
  const row = (id: string, label: string, style: TextInputStyle, max: number, value?: string) => {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(false);
    if (value) input.setValue(value);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  };
  return new ModalBuilder()
    .setCustomId(`sch:modal:${nonce}`)
    .setTitle(title.slice(0, 45))
    .addComponents(
      row('text', 'Message (supports {server}, {channel}, …)', TextInputStyle.Paragraph, 2000, prefill?.content),
      row('title', 'Embed title (optional: sends as an embed)', TextInputStyle.Short, 256, prefill?.embed?.title),
      row('color', 'Embed colour, hex (optional)', TextInputStyle.Short, 7, prefill?.embed?.color !== undefined ? `#${prefill.embed.color.toString(16).padStart(6, '0')}` : undefined),
      row('image', 'Embed image URL (optional)', TextInputStyle.Short, 500, prefill?.embed?.image),
    );
}

async function checkTarget(i: CommandInteraction, guild: Guild, channelId: string) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new UserError('Pick a channel I can post in');
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!canPost(channel, me, true)) throw new UserError(`I can’t post in <#${channelId}>. I need **View Channel**, **Send Messages** and **Embed Links** there`);
  const member = await guild.members.fetch(i.user.id);
  if (!channel.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, MM])) {
    throw new UserError(t('perm.need', { perm: 'Manage Messages', action: `schedule messages in <#${channelId}>` }));
  }
}

function confirmation(m: ScheduledMessage): string {
  const { date, time } = v2DateParts(m.local);
  const preview = m.content.length > 200 ? `${m.content.slice(0, 200)}…` : m.content || (m.embed?.title ?? 'embed');
  const lines = [
    t('schedule.created', { message: preview, channel: `<#${m.channelId}>`, time, date, tz: m.timezone }),
    `That's <t:${unix(m.runAt)}:F> (<t:${unix(m.runAt)}:R>) for you.`,
  ];
  if (m.recurrence) lines.push(`Repeats ${REPEAT_LABEL[m.recurrence]}.`);
  return lines.join('\n');
}

const schedule: CommandSpec = {
  replyMode: 'ephemeral',
  memberPermissions: [MM],
  permAction: 'schedule a message',
  data: new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Messages posted at a set time')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MM)
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Schedule a message (you write it in the next step)')
        .addStringOption((o) => o.setName('keyword').setDescription('A name for it, used to edit or cancel').setRequired(true).setMaxLength(50))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post').setRequired(true).addChannelTypes(...TARGETS))
        .addStringOption((o) => o.setName('when').setDescription('e.g. 25/12/2026 09:00, 2026-12-25 09:00, 18:30, in 2h').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('timezone').setDescription('IANA zone (default: the server’s)').setAutocomplete(true))
        .addStringOption((o) => o.setName('repeat').setDescription('Repeat it').addChoices(...Object.keys(RECURRENCES).map((k) => ({ name: k, value: k })))),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Messages waiting to be sent').addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)))
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Change a scheduled message')
        .addStringOption((o) => o.setName('keyword').setDescription('Which one').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('when').setDescription('New time').setAutocomplete(true))
        .addChannelOption((o) => o.setName('channel').setDescription('New channel').addChannelTypes(...TARGETS))
        .addStringOption((o) => o.setName('timezone').setDescription('New time zone').setAutocomplete(true))
        .addStringOption((o) => o.setName('repeat').setDescription('Repeat').addChoices(...Object.keys(RECURRENCES).map((k) => ({ name: k, value: k }))))
        .addBooleanOption((o) => o.setName('edit_text').setDescription('Also edit the message text')),
    )
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a scheduled message').addStringOption((o) => o.setName('keyword').setDescription('Which one').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('preview').setDescription('See exactly what will be posted, and when').addStringOption((o) => o.setName('keyword').setDescription('Which one').setRequired(true).setAutocomplete(true)))
    .toJSON(),
  autocomplete: zoneAutocomplete,
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const guild = i.guild!;
    const sub = i.options.getSubcommand();
    const settings = await ctx.settings.get(guild.id);

    if (sub === 'list') {
      const list = await ctx.schedule.pending(guild.id);
      const page = (i.options.getInteger('page') ?? 1) - 1;
      const pages = Math.max(1, Math.ceil(list.length / PAGE));
      const lines = list.slice(page * PAGE, page * PAGE + PAGE).map((m) => `• \`${m.keyword}\` -> <#${m.channelId}> <t:${unix(m.runAt)}:f> (<t:${unix(m.runAt)}:R>)${m.recurrence ? ` · ${REPEAT_LABEL[m.recurrence]}` : ''}${m.attempts ? ` · retrying (${m.lastError})` : ''}`);
      await respond(i, { embeds: [embed('info').setTitle(`Scheduled messages (${list.length})`).setDescription(lines.join('\n') || '*Nothing scheduled.*').setFooter({ text: `Page ${page + 1}/${pages}` })] }, { ephemeral: true });
      return;
    }

    if (sub === 'create') {
      const keyword = i.options.getString('keyword', true).trim();
      if (await ctx.schedule.byKeyword(guild.id, keyword)) throw new UserError(t('schedule.exists'));
      const channelId = i.options.getChannel('channel', true).id;
      await checkTarget(i, guild, channelId);
      const timezone = resolveZone(i.options.getString('timezone') ?? settings.timezone);
      const { local } = parseWhen(i.options.getString('when', true), timezone, Date.now());
      const nonce = randomBytes(5).toString('hex');
      drafts.set(nonce, { kind: 'create', userId: i.user.id, expires: Date.now() + 15 * 60_000, keyword, channelId, local, timezone, recurrence: RECURRENCES[i.options.getString('repeat') ?? 'none'] ?? null });
      await i.showModal(contentModal(nonce, `Message for ${keyword}`));
      return;
    }

    const m = await ctx.schedule.byKeyword(guild.id, i.options.getString('keyword', true));
    if (!m) throw new UserError('There’s no pending scheduled message with that keyword. See `/schedule list`');

    if (sub === 'cancel') {
      await ctx.schedule.cancel(m, i.user.id);
      ctx.kickWorker();
      await respond(i, { content: `Scheduled message \`${m.keyword}\` cancelled.` }, { ephemeral: true });
      return;
    }

    if (sub === 'preview') {
      const out = buildOutgoing(m.content, m.embed, m.mentions, templateVars({ guild, channelId: m.channelId, member: await guild.members.fetch(m.createdBy).catch(() => null) }));
      const runs = ctx.schedule.upcoming(m, 5).map((ms) => `<t:${unix(ms)}:F>`);
      await i.reply({
        content: `**${m.keyword}** -> <#${m.channelId}>\nNext run${runs.length > 1 ? 's' : ''}: ${runs.join(', ')}\n────────\n${out.content ?? ''}`.slice(0, 2000),
        ...(out.embeds ? { embeds: out.embeds } : {}),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const timezone = i.options.getString('timezone') ? resolveZone(i.options.getString('timezone')!) : m.timezone;
    const channelId = i.options.getChannel('channel')?.id ?? m.channelId;
    if (channelId !== m.channelId) await checkTarget(i, guild, channelId);
    const whenRaw = i.options.getString('when');
    const local = whenRaw ? parseWhen(whenRaw, timezone, Date.now()).local : m.local;
    const repeat = i.options.getString('repeat');
    const recurrence = repeat ? (RECURRENCES[repeat] ?? null) : m.recurrence;
    if (i.options.getBoolean('edit_text')) {
      const nonce = randomBytes(5).toString('hex');
      drafts.set(nonce, { kind: 'edit', userId: i.user.id, expires: Date.now() + 15 * 60_000, keyword: m.keyword, channelId, local, timezone, recurrence, existing: m });
      await i.showModal(contentModal(nonce, `Edit ${m.keyword}`, m));
      return;
    }
    const updated = await ctx.schedule.update(m, { channelId, local, timezone, recurrence }, i.user.id);
    ctx.kickWorker();
    await respond(i, { content: `Updated.\n${confirmation(updated)}` }, { ephemeral: true });
  },
};

async function onModal(i: ModalSubmitInteraction, ctx: BotContext, nonce: string) {
  const d = drafts.get(nonce);
  drafts.delete(nonce);
  if (!d || d.expires < Date.now() || d.userId !== i.user.id) throw new UserError('That form expired. Run the command again');
  const { text, embed: e } = readContentModal(i);
  const settings = await ctx.settings.get(i.guildId!);
  const mentions = mentionPolicyFor(`${text} ${e?.title ?? ''}`, {
    authorCanMentionEveryone: Boolean(i.memberPermissions?.has(PermissionFlagsBits.MentionEveryone)),
    guildAllowsMass: settings.get<boolean>('mentions.allow_mass'),
  });
  const m =
    d.kind === 'create'
      ? await ctx.schedule.create({ guildId: i.guildId!, keyword: d.keyword, channelId: d.channelId, content: text, embed: e, local: d.local, timezone: d.timezone, recurrence: d.recurrence, mentions, createdBy: i.user.id })
      : await ctx.schedule.update(d.existing!, { channelId: d.channelId, local: d.local, timezone: d.timezone, recurrence: d.recurrence, content: text, embed: e, mentions }, i.user.id);
  ctx.kickWorker();
  await i.reply({ content: `${d.kind === 'edit' ? 'Updated.\n' : ''}${confirmation(m)}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

const modalComponent: ComponentSpec = {
  prefix: 'sch',
  memberPermissions: [MM],
  async handle(i, ctx, [kind, nonce = '']) {
    if (kind === 'modal' && i.isModalSubmit()) await onModal(i, ctx, nonce);
  },
};

export function scheduleHooks(ctx: BotContext): ScheduleHooks {
  return {
    async send(m) {
      const guild = await ctx.client.guilds.fetch(m.guildId).catch(() => null);
      if (!guild) throw new SendError('the bot is no longer in the server', true);
      const channel = await guild.channels.fetch(m.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !channel.isSendable()) throw new SendError('the channel no longer exists', true);
      const me = guild.members.me ?? (await guild.members.fetchMe());
      if (!canPost(channel, me, Boolean(m.embed))) throw new SendError('I no longer have permission to post there', true);
      const creator = await guild.members.fetch(m.createdBy).catch(() => null);
      try {
        await channel.send(buildOutgoing(m.content, m.embed, m.mentions, templateVars({ guild, channelId: m.channelId, member: creator })));
      } catch (err) {
        throw classifySendError(err);
      }
      ctx.metrics.set('mm_scheduler_lag_ms', Date.now() - Date.parse(m.runAt));
    },
    async notifyFailure(m, reason) {
      const text = `⚠️ Scheduled message \`${m.keyword}\` for <#${m.channelId}> couldn't be sent: ${reason}.`;
      await ctx.client.users.send(m.createdBy, { content: text, allowedMentions: { parse: [] } }).catch(() => undefined);
      await ctx.audit.record({ guildId: m.guildId, actorId: ctx.client.user?.id ?? '0', action: 'schedule.failed', target: m.keyword, payload: { reason, channelId: m.channelId } });
      ctx.kickWorker();
    },
    async graceHours(guildId) {
      return (await ctx.settings.get(guildId)).get<number>('schedule.grace_hours');
    },
  };
}

export const schedulerModule: Module = {
  id: 'scheduler',
  name: 'Scheduled messages',
  description: 'Post messages at a set time, once or on repeat',
  commands: [schedule],
  components: [modalComponent],
  settings: [{ key: 'schedule.grace_hours', description: 'If the bot was offline, still send messages that are at most this many hours late', default: 24, ...kinds.int(1, 168) }],
  migrations: {
    '0300_scheduler': {
      async up(db) {
        await db.schema
          .createTable('scheduled_message')
          .addColumn('id', 'text', (c) => c.primaryKey())
          .addColumn('guild_id', 'text', (c) => c.notNull().references('guild.guild_id').onDelete('cascade'))
          .addColumn('keyword', 'text', (c) => c.notNull())
          .addColumn('channel_id', 'text', (c) => c.notNull())
          .addColumn('content', 'text', (c) => c.notNull())
          .addColumn('embed_json', 'text')
          .addColumn('run_at', 'text', (c) => c.notNull())
          .addColumn('local_time', 'text', (c) => c.notNull())
          .addColumn('anchor_day', 'integer', (c) => c.notNull())
          .addColumn('recurrence', 'text')
          .addColumn('timezone', 'text', (c) => c.notNull())
          .addColumn('allowed_mentions', 'text', (c) => c.notNull())
          .addColumn('status', 'text', (c) => c.notNull())
          .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
          .addColumn('last_error', 'text')
          .addColumn('lease_until', 'text')
          .addColumn('created_by', 'text', (c) => c.notNull())
          .addColumn('created_at', 'text', (c) => c.notNull())
          .addColumn('sent_at', 'text')
          .execute();
        await db.schema.createIndex('scheduled_due').on('scheduled_message').columns(['status', 'run_at']).execute();
        const { sql } = await import('kysely');
        await sql`CREATE UNIQUE INDEX scheduled_keyword_pending ON scheduled_message (guild_id, keyword) WHERE status = 'pending'`.execute(db);
      },
    },
  },
  events: {
    async ready(ctx) {
      await ctx.schedule.start(scheduleHooks(ctx));
    },
  },
  periodic: [
    {
      name: 'pending-gauge',
      intervalMs: 60_000,
      run: async (ctx) => ctx.metrics.set('mm_scheduled_pending', await ctx.schedule.pendingCount()),
    },
  ],
};

