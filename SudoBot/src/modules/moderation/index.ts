import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type GuildBasedChannel,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { parseDuration } from '../../core/duration.ts';
import { UserError } from '../../core/errors.ts';
import { PURGE_MAX } from '../../core/purge.ts';
import { lockFacts, overwritePort, purgePort } from '../../discord/adapters.ts';
import type { BotContext } from '../../discord/context.ts';
import { respond } from '../../discord/replies.ts';
import { targetChannel } from '../../discord/router.ts';
import { t } from '../../messages.ts';
import { runPurge } from '../../services/purge.ts';
import type { CommandSpec, ComponentSpec, Module } from '../types.ts';

const MM = PermissionFlagsBits.ManageMessages;
const LOCKABLE = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.GuildVoice, ChannelType.GuildStageVoice] as const;
const MAX_LOCK_S = 28 * 86400;

type Overwritable = Parameters<typeof overwritePort>[0];
const isOverwritable = (c: GuildBasedChannel): c is Overwritable => 'permissionOverwrites' in c;

async function postNotice(channel: GuildBasedChannel, text: string) {
  if (channel.isSendable()) await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => undefined);
}

export async function unlockChannel(ctx: BotContext, guildId: string, channelId: string, actorId: string, reason?: string) {
  const guild = await ctx.client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !isOverwritable(channel)) {
    return ctx.locks.unlock({ guildId, channelId, actorId, botId: ctx.client.user!.id, port: { overwrites: async () => [], apply: async () => {} }, reason: 'channel deleted' });
  }
  const r = await ctx.locks.unlock({ guildId, channelId, actorId, botId: ctx.client.user!.id, port: overwritePort(channel), ...(reason ? { reason } : {}) });
  if (r.status === 'unlocked') await postNotice(channel, t('lock.noticeUnlocked'));
  return r;
}

const lock: CommandSpec = {
  replyMode: 'ephemeral',
  slow: true,
  memberPermissions: [MM],
  permAction: 'lock this channel',
  botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewChannel],
  channelOption: 'channel',
  useParentChannel: true,
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Stop members from sending messages in a channel')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MM)
    .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: this one)').addChannelTypes(...LOCKABLE))
    .addStringOption((o) => o.setName('duration').setDescription('Unlock automatically after, e.g. 30m, 2h, 1d'))
    .addStringOption((o) => o.setName('reason').setDescription('Shown in the channel and the audit log').setMaxLength(500))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const guild = i.guild!;
    const channel = await targetChannel(i, this);
    if (!isOverwritable(channel)) throw new UserError('That channel can’t be locked');
    const durRaw = i.options.getString('duration');
    const expiresAt = durRaw ? new Date(Date.now() + parseDuration(durRaw, { min: 60, max: MAX_LOCK_S }) * 1000) : null;
    const reason = i.options.getString('reason');
    const inThread = i.channel?.isThread() && !i.options.getChannel('channel');

    const r = await ctx.locks.lock({
      guildId: guild.id,
      channelId: channel.id,
      actorId: i.user.id,
      reason,
      expiresAt,
      port: overwritePort(channel),
      ...(await lockFacts(guild, channel)),
    });
    ctx.kickWorker();
    if (r.status === 'already') {
      await respond(i, { content: t('lock.already', { channel: `<#${channel.id}>` }) });
      return;
    }
    const notice = [t('lock.notice'), reason ? `**Reason:** ${reason}` : '', expiresAt ? `Unlocks <t:${Math.floor(expiresAt.getTime() / 1000)}:R>.` : ''].filter(Boolean).join('\n');
    await postNotice(channel, notice);
    const skipped = r.plan.skipped.length ? `\nLeft alone: ${r.plan.skipped.map((s) => `<@&${s.id}> (${s.reason === 'staff' ? 'staff role' : 'above my role'})`).join(', ')}.` : '';
    await respond(i, { content: `${t('lock.done', { channel: `<#${channel.id}>` })}${inThread ? `\n${t('lock.parent')}` : ''}${skipped}` });
  },
};

const unlock: CommandSpec = {
  replyMode: 'ephemeral',
  slow: true,
  memberPermissions: [MM],
  permAction: 'unlock this channel',
  botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewChannel],
  channelOption: 'channel',
  useParentChannel: true,
  data: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Let members send messages again, restoring the channel exactly as it was')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MM)
    .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: this one)').addChannelTypes(...LOCKABLE))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const channel = await targetChannel(i, this);
    const r = await unlockChannel(ctx, i.guildId!, channel.id, i.user.id);
    ctx.kickWorker();
    const inThread = i.channel?.isThread() && !i.options.getChannel('channel');
    const text = r.status === 'not-locked' ? t('lock.notLocked', { channel: `<#${channel.id}>` }) : t('lock.unlocked', { channel: `<#${channel.id}>` });
    await respond(i, { content: `${text}${inThread ? `\n${t('lock.parent')}` : ''}` });
  },
};

const cancelled = new Set<string>();

const purge: CommandSpec = {
  replyMode: 'ephemeral',
  slow: true,
  cooldownS: 5,
  memberPermissions: [MM],
  permAction: 'purge messages',
  botPermissions: [MM, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ViewChannel],
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete recent messages in this channel')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MM)
    .addIntegerOption((o) => o.setName('amount').setDescription(`How many (1–${PURGE_MAX})`).setRequired(true).setMinValue(1).setMaxValue(PURGE_MAX))
    .addUserOption((o) => o.setName('user').setDescription('Only messages from this user'))
    .addStringOption((o) => o.setName('contains').setDescription('Only messages containing this text').setMaxLength(100))
    .addBooleanOption((o) => o.setName('bots_only').setDescription('Only messages from bots'))
    .addBooleanOption((o) => o.setName('include_pinned').setDescription('Also delete pinned messages (default: keep them)'))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const amount = i.options.getInteger('amount', true);
    if (amount < 1) throw new UserError(t('purge.positive'));
    const contains = i.options.getString('contains');
    if (contains && !ctx.config.ENABLE_MESSAGE_CONTENT) {
      throw new UserError('Filtering by text needs the Message Content intent, which this bot runs without. Filter by user instead');
    }
    const channel = i.channel;
    if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new UserError('Use this in a text channel');

    const token = randomBytes(5).toString('hex');
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`purge:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    );
    const started = Date.now();
    let lastUpdate = 0;
    try {
      const r = await runPurge({
        amount,
        filter: { userId: i.options.getUser('user')?.id ?? null, contains, botsOnly: i.options.getBoolean('bots_only') ?? false, includePinned: i.options.getBoolean('include_pinned') ?? false },
        port: purgePort(channel),
        nowMs: Date.now(),
        isCancelled: () => cancelled.has(token),
        onProgress: (done, total) => {
          if (Date.now() - started < 3000 || Date.now() - lastUpdate < 2000) return;
          lastUpdate = Date.now();
          void i.editReply({ content: `🧹 Deleting… ${done}/${total}`, components: [cancelRow] }).catch(() => undefined);
        },
      });
      const extra = [
        r.cancelled ? 'Stopped early (cancelled).' : '',
        r.skippedPinned ? `Kept ${r.skippedPinned} pinned message${r.skippedPinned === 1 ? '' : 's'}.` : '',
        r.failed ? `${r.failed} couldn't be deleted.` : '',
        r.deleted < amount && !r.cancelled ? `Only ${r.deleted} matched in the last ${r.scanned} messages.` : '',
      ].filter(Boolean);
      await ctx.audit.record({ guildId: i.guildId!, actorId: i.user.id, action: 'purge', target: channel.id, payload: { requested: amount, deleted: r.deleted, scanned: r.scanned } });
      ctx.kickWorker();
      await respond(i, { content: [t('purge.done', { n: r.deleted }), ...extra].join('\n'), components: [] });
    } finally {
      cancelled.delete(token);
    }
  },
};

const purgeCancel: ComponentSpec = {
  prefix: 'purge',
  memberPermissions: [MM],
  async handle(i, _ctx, [, token = '']) {
    if (!i.isButton()) return;
    cancelled.add(token);
    await i.update({ content: '⏹️ Cancelling…', components: [] });
  },
};

export const moderationModule: Module = {
  id: 'moderation',
  name: 'Moderation',
  description: 'Lock and unlock channels, and purge messages',
  commands: [lock, unlock, purge],
  components: [purgeCancel],
  migrations: {
    '0100_moderation': {
      async up(db) {
        const fk = (c: any) => c.notNull().references('guild.guild_id').onDelete('cascade');
        await db.schema
          .createTable('channel_lock')
          .addColumn('guild_id', 'text', fk)
          .addColumn('channel_id', 'text', (c) => c.notNull())
          .addColumn('locked_at', 'text', (c) => c.notNull())
          .addColumn('locked_by', 'text', (c) => c.notNull())
          .addColumn('reason', 'text')
          .addColumn('expires_at', 'text')
          .addPrimaryKeyConstraint('channel_lock_pk', ['guild_id', 'channel_id'])
          .execute();
        await db.schema
          .createTable('channel_lock_override')
          .addColumn('guild_id', 'text', fk)
          .addColumn('channel_id', 'text', (c) => c.notNull())
          .addColumn('target_id', 'text', (c) => c.notNull())
          .addColumn('target_type', 'text', (c) => c.notNull())
          .addColumn('existed', 'integer', (c) => c.notNull())
          .addColumn('prior_send', 'text', (c) => c.notNull())
          .addColumn('prior_send_in_threads', 'text', (c) => c.notNull())
          .addPrimaryKeyConstraint('channel_lock_override_pk', ['guild_id', 'channel_id', 'target_id'])
          .execute();
      },
    },
  },
  jobs: {
    'lock.expire': async (job, ctx) => {
      await unlockChannel(ctx, job.guildId!, String(job.payload.channelId), ctx.client.user!.id, 'lock expired');
    },
  },
};

