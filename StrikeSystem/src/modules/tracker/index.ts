import { EmbedBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { describeStep, nextStep, resolveAt } from '../../core/escalation.ts';
import { kinds } from '../../core/settings.ts';
import { layoutTracker, type TrackerRow } from '../../core/tracker.ts';
import type { BotContext } from '../../discord/context.ts';
import { sendableChannel } from '../../discord/delivery.ts';
import { ok, respond } from '../../discord/replies.ts';
import type { JobSpec } from '../../services/jobs.ts';
import type { Module } from '../types.ts';

const DEBOUNCE_MS = 5_000;

export const trackerRefreshJob = (guildId: string, delayMs = DEBOUNCE_MS): JobSpec => ({
  type: 'tracker.refresh',
  guildId,
  payload: {},
  runAt: new Date(Date.now() + delayMs),
  dedupeKey: `tracker:${guildId}`,
  maxAttempts: 3,
});

const AFFECTS_TRACKER = new Set(['BAN', 'UNBAN', 'KICK']);

async function buildRows(ctx: BotContext, guildId: string): Promise<TrackerRow[]> {
  const guild = await ctx.client.guilds.fetch(guildId);
  const settings = await ctx.settings.get(guildId);
  const includeDeparted = settings.get<boolean>('tracker.include_departed');
  const summary = await ctx.cases.strikeSummary(guildId);
  const ids = summary.map((s) => s.userId);
  const names = new Map<string, string>();
  for (let n = 0; n < ids.length; n += 100) {
    const found = await guild.members.fetch({ user: ids.slice(n, n + 100) }).catch(() => null);
    found?.forEach((m) => names.set(m.id, m.displayName));
  }
  const banned = await ctx.cases.activelyBanned(guildId, ids);
  const max = settings.maxStrikes;
  return summary
    .filter((s) => includeDeparted || (names.has(s.userId) && !banned.has(s.userId)))
    .map((s) => {
      const next = nextStep(settings.ladder, max, s.count);
      return {
        userId: s.userId,
        name: names.get(s.userId) ?? null,
        count: s.count,
        next: next ? `${describeStep(next)} at ${resolveAt(next, max)}` : null,
        soonestExpiry: s.soonestExpiry,
      };
    });
}

async function refreshTracker(ctx: BotContext, guildId: string): Promise<void> {
  const settings = await ctx.settings.get(guildId);
  const channelId = settings.get<string | null>('log.tracker_channel') ?? settings.logChannel;
  const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const stored = await ctx.db.selectFrom('tracker').selectAll().where('guild_id', '=', guildId).executeTakeFirst();
  let messageIds: string[] = stored ? (JSON.parse(stored.message_ids) as string[]) : [];

  if (stored && stored.channel_id !== channelId) {
    const old = await sendableChannel(guild, stored.channel_id);
    for (const id of messageIds) await old?.messages.delete(id).catch(() => undefined);
    messageIds = [];
  }
  if (!channelId) {
    await ctx.db.deleteFrom('tracker').where('guild_id', '=', guildId).execute();
    return;
  }
  const channel = await sendableChannel(guild, channelId);
  if (!channel) return;

  const pages = layoutTracker({ guildName: guild.name, max: settings.maxStrikes, rows: await buildRows(ctx, guildId), updatedAt: new Date().toISOString() });
  const next: string[] = [];
  for (const [n, embeds] of pages.entries()) {
    const payload = {
      embeds: embeds.map((e) => {
        const b = new EmbedBuilder().setColor(e.color);
        if (e.title) b.setTitle(e.title);
        if (e.description) b.setDescription(e.description);
        if (e.fields.length) b.addFields(e.fields);
        if (e.footer) b.setFooter({ text: e.footer });
        return b;
      }),
      allowedMentions: { parse: [] as never[] },
    };
    const existing = messageIds[n] ? await channel.messages.fetch(messageIds[n]).catch(() => null) : null;
    if (existing) {
      await existing.edit(payload);
      next.push(existing.id);
    } else {
      next.push((await channel.send(payload)).id);
    }
  }
  for (const id of messageIds.slice(pages.length)) await channel.messages.delete(id).catch(() => undefined);

  await ctx.db
    .insertInto('tracker')
    .values({ guild_id: guildId, channel_id: channelId, message_ids: JSON.stringify(next) })
    .onConflict((oc) => oc.column('guild_id').doUpdateSet({ channel_id: channelId, message_ids: JSON.stringify(next) }))
    .execute();
}

export const trackerModule: Module = {
  id: 'tracker',
  name: 'Strike tracker',
  description: 'A live summary of everyone with strikes, kept up to date in a channel',
  settings: [
    { key: 'log.tracker_channel', description: 'Channel for the strike tracker (default: the log channel). A dedicated read-only channel is best', default: null, ...kinds.channel() },
    { key: 'tracker.include_departed', description: 'Also list members who left or are banned', default: false, ...kinds.bool() },
  ],
  migrations: {
    '0100_tracker': {
      async up(db) {
        await db.schema
          .createTable('tracker')
          .addColumn('guild_id', 'text', (c) => c.primaryKey())
          .addColumn('channel_id', 'text', (c) => c.notNull())
          .addColumn('message_ids', 'text', (c) => c.notNull())
          .execute();
      },
    },
  },
  caseHooks: [
    (c) => (c.targetId && (c.type === 'STRIKE' || c.type === 'STRIKE_REVOKE' || AFFECTS_TRACKER.has(c.type)) ? [trackerRefreshJob(c.guildId)] : []),
  ],
  jobs: {
    'tracker.refresh': async (job, ctx) => refreshTracker(ctx, job.guildId!),
  },
  events: {
    async ready(ctx) {
      const rows = await ctx.db.selectFrom('tracker').select('guild_id').execute();
      const withStrikes = await ctx.db.selectFrom('cases').select('guild_id').distinct().where('type', '=', 'STRIKE').where('status', '=', 'ACTIVE').execute();
      const guilds = new Set([...rows.map((r) => r.guild_id), ...withStrikes.map((r) => r.guild_id)]);
      await ctx.jobs.enqueue([...guilds].filter((g) => ctx.client.guilds.cache.has(g)).map((g) => trackerRefreshJob(g, 10_000)));
    },
    async memberRemove(member, ctx) {
      if ((await ctx.cases.activeStrikeCount(member.guild.id, member.id)) > 0) await ctx.jobs.enqueue([trackerRefreshJob(member.guild.id)]);
    },
    async memberAdd(member, ctx) {
      if ((await ctx.cases.activeStrikeCount(member.guild.id, member.id)) > 0) await ctx.jobs.enqueue([trackerRefreshJob(member.guild.id)]);
    },
  },
  commands: [
    {
      tier: 'mod',
      data: new SlashCommandBuilder()
        .setName('tracker')
        .setDescription('Rebuild the strike tracker now')
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .toJSON(),
      async execute(i, ctx) {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await ctx.jobs.enqueue([trackerRefreshJob(i.guildId!, 0)]);
        ctx.kickWorker();
        await respond(i, { content: ok('The tracker is being rebuilt.') });
      },
    },
  ],
  async purgeGuild(guildId, ctx) {
    await ctx.db.deleteFrom('tracker').where('guild_id', '=', guildId).execute();
  },
};
