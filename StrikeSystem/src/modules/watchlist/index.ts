import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type GuildMember,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { checkReason, MAX_REASON } from '../../core/cases.ts';
import { DAY_S, formatDuration, parseDuration, TIMEOUT_MAX_S } from '../../core/duration.ts';
import { UserError } from '../../core/errors.ts';
import { discordTime } from '../../core/timestamps.ts';
import type { BotContext } from '../../discord/context.ts';
import { sendableChannel } from '../../discord/delivery.ts';
import { actorOf, fetchMember } from '../../discord/members.ts';
import { COLORS, ok, respond } from '../../discord/replies.ts';
import type { WatchlistTable } from '../../storage/schema.ts';
import { doBan, doTimeout, executeBan, executeTimeout, prepareBan } from '../moderation/actions.ts';
import type { Module } from '../types.ts';

const PAGE = 10;
const SWEEP_MS = 6 * 3_600_000;

type Entry = WatchlistTable;

async function entryFor(ctx: BotContext, guildId: string, userId: string): Promise<Entry | undefined> {
  return ctx.db.selectFrom('watchlist').selectAll().where('guild_id', '=', guildId).where('user_id', '=', userId).executeTakeFirst();
}

async function trigger(ctx: BotContext, member: GuildMember, e: Entry): Promise<void> {
  const guild = member.guild;
  const botId = ctx.client.user!.id;
  const reason = `Watchlist: ${e.reason ?? 'no reason given'}`.slice(0, 1000);
  const meta = { watchlist: true, addedBy: e.actor_id };
  const settings = await ctx.settings.get(guild.id);
  try {
    if (e.action === 'ban') {
      await executeBan({ ctx, guild, actorId: botId, reason, target: member.user, isMember: true, dm: settings.dmEnabled('ban'), deleteSeconds: 0, metadata: meta });
      await ctx.db.deleteFrom('watchlist').where('guild_id', '=', guild.id).where('user_id', '=', member.id).execute();
    } else if (e.action === 'timeout') {
      await executeTimeout({ ctx, guild, actorId: botId, reason, member, durationS: e.duration_s ?? DAY_S, dm: settings.dmEnabled('timeout'), metadata: meta });
    } else {
      await ctx.cases.create({ guildId: guild.id, type: 'BOJ_TRIGGER', targetId: member.id, actorId: botId, reason, metadata: { ...meta, action: 'alert' } });
      await postAlert(ctx, member, e);
    }
    ctx.kickWorker();
  } catch (err) {
    ctx.log.warn({ err, guildId: guild.id, userId: member.id }, 'watchlist action failed');
    await postAlert(ctx, member, e, `I couldn't ${e.action} them automatically: ${(err as Error).message}`);
  }
}

async function postAlert(ctx: BotContext, member: GuildMember, e: Entry, problem?: string) {
  const settings = await ctx.settings.get(member.guild.id);
  const channel = await sendableChannel(member.guild, settings.logChannel);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle('👁️ Watched user joined')
    .setDescription(
      `<@${member.id}> (\`${member.id}\`) is on the watchlist.\n**Reason:** ${e.reason ?? '*none*'}\n**Added by** <@${e.actor_id}> ${discordTime(e.created_at, 'R')}` +
        (problem ? `\n\n⚠️ ${problem}` : ''),
    )
    .setThumbnail(member.displayAvatarURL());
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`wl:ban:${member.id}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`wl:timeout:${member.id}`).setLabel('Timeout 1d').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wl:dismiss:${member.id}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
  );
  await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
}

async function sweep(ctx: BotContext): Promise<number> {
  const entries = await ctx.db.selectFrom('watchlist').selectAll().execute();
  const byGuild = new Map<string, Entry[]>();
  for (const e of entries) byGuild.set(e.guild_id, [...(byGuild.get(e.guild_id) ?? []), e]);
  let hits = 0;
  for (const [guildId, list] of byGuild) {
    const guild = ctx.client.guilds.cache.get(guildId);
    if (!guild || !(await ctx.isModuleEnabled(guildId, 'watchlist'))) continue;
    for (let n = 0; n < list.length; n += 100) {
      const batch = list.slice(n, n + 100);
      const found = await guild.members.fetch({ user: batch.map((e) => e.user_id) }).catch(() => null);
      for (const member of found?.values() ?? []) {
        const e = batch.find((x) => x.user_id === member.id);
        if (e) {
          hits++;
          await trigger(ctx, member, e);
        }
      }
    }
  }
  return hits;
}

export const watchlistModule: Module = {
  id: 'watchlist',
  name: 'Watchlist',
  description: 'Ban, time out or flag specific users as soon as they join (replaces ban-on-join)',
  caseTypes: [
    { type: 'BOJ_ADD', title: 'Added to watchlist', icon: '👁️', color: 0x9b59b6 },
    { type: 'BOJ_REMOVE', title: 'Removed from watchlist', icon: '🙈', color: 0x2ecc71 },
    { type: 'BOJ_TRIGGER', title: 'Watchlist triggered', icon: '🚨', color: 0x992d22 },
  ],
  migrations: {
    '0200_watchlist': {
      async up(db) {
        await db.schema
          .createTable('watchlist')
          .addColumn('guild_id', 'text', (c) => c.notNull())
          .addColumn('user_id', 'text', (c) => c.notNull())
          .addColumn('action', 'text', (c) => c.notNull())
          .addColumn('duration_s', 'integer')
          .addColumn('reason', 'text')
          .addColumn('actor_id', 'text', (c) => c.notNull())
          .addColumn('created_at', 'text', (c) => c.notNull())
          .addColumn('legacy_ref', 'text')
          .addPrimaryKeyConstraint('watchlist_pk', ['guild_id', 'user_id'])
          .execute();
      },
    },
  },
  events: {
    async memberAdd(member, ctx) {
      const e = await entryFor(ctx, member.guild.id, member.id);
      if (e) await trigger(ctx, member, e);
    },
  },
  periodic: [{ name: 'watchlist-sweep', intervalMs: SWEEP_MS, initialDelayMs: 30_000, run: sweep }],
  commands: [
    {
      tier: 'mod',
      data: new SlashCommandBuilder()
        .setName('watchlist')
        .setDescription('Users to act on as soon as they join')
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Watch a user who is not in the server')
            .addUserOption((o) => o.setName('user').setDescription('User (paste an ID)').setRequired(true))
            .addStringOption((o) =>
              o.setName('action').setDescription('What to do when they join').setRequired(true).addChoices(
                { name: 'ban', value: 'ban' },
                { name: 'alert the mods', value: 'alert' },
                { name: 'timeout', value: 'timeout' },
              ),
            )
            .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(MAX_REASON))
            .addStringOption((o) => o.setName('duration').setDescription('Timeout length (default 1d)')),
        )
        .addSubcommand((s) =>
          s.setName('remove').setDescription('Stop watching a user').addUserOption((o) => o.setName('user').setDescription('User (paste an ID)').setRequired(true)),
        )
        .addSubcommand((s) => s.setName('list').setDescription('Everyone on the watchlist').addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)))
        .toJSON(),
      async execute(i, ctx) {
        if (!i.isChatInputCommand()) return;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = i.guild!;
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const page = (i.options.getInteger('page') ?? 1) - 1;
          const total = await ctx.db.selectFrom('watchlist').select((eb) => eb.fn.countAll<number>().as('n')).where('guild_id', '=', guild.id).executeTakeFirstOrThrow();
          const rows = await ctx.db.selectFrom('watchlist').selectAll().where('guild_id', '=', guild.id).orderBy('created_at', 'desc').limit(PAGE).offset(page * PAGE).execute();
          const pages = Math.max(1, Math.ceil(Number(total.n) / PAGE));
          const lines = rows.map((r) => `• <@${r.user_id}> (\`${r.user_id}\`) -> **${r.action}**${r.action === 'timeout' ? ` ${formatDuration(r.duration_s ?? DAY_S)}` : ''} · ${r.reason ?? '*no reason*'} · by <@${r.actor_id}> ${discordTime(r.created_at, 'd')}`);
          const embed = new EmbedBuilder().setColor(COLORS.info).setTitle(`Watchlist (${total.n})`).setDescription(lines.join('\n') || '*Empty.*').setFooter({ text: `Page ${page + 1}/${pages} · /watchlist list page:<n>` });
          await respond(i, { embeds: [embed] });
          return;
        }
        const user = i.options.getUser('user', true);
        if (sub === 'remove') {
          const r = await ctx.db.deleteFrom('watchlist').where('guild_id', '=', guild.id).where('user_id', '=', user.id).executeTakeFirst();
          if (!Number(r.numDeletedRows)) throw new UserError(`<@${user.id}> isn't on the watchlist.`);
          await ctx.cases.create({ guildId: guild.id, type: 'BOJ_REMOVE', targetId: user.id, actorId: i.user.id, reason: null });
          ctx.kickWorker();
          await respond(i, { content: ok(`<@${user.id}> was removed from the watchlist.`) });
          return;
        }
        const action = i.options.getString('action', true) as Entry['action'];
        const reason = checkReason(i.options.getString('reason'));
        const durRaw = i.options.getString('duration');
        const durationS = action === 'timeout' ? (durRaw ? parseDuration(durRaw, { max: TIMEOUT_MAX_S }) : DAY_S) : null;
        if (await fetchMember(guild, user.id)) {
          throw new UserError(`<@${user.id}> is already in the server. Use \`/ban\`, \`/timeout\` or \`/note\` instead.`);
        }
        await ctx.db
          .insertInto('watchlist')
          .values({ guild_id: guild.id, user_id: user.id, action, duration_s: durationS, reason, actor_id: i.user.id, created_at: ctx.clock.now().toISOString(), legacy_ref: null })
          .onConflict((oc) => oc.columns(['guild_id', 'user_id']).doUpdateSet({ action, duration_s: durationS, reason, actor_id: i.user.id }))
          .execute();
        await ctx.cases.create({ guildId: guild.id, type: 'BOJ_ADD', targetId: user.id, actorId: i.user.id, reason, metadata: { action, durationS } });
        ctx.kickWorker();
        const hint = action === 'ban' ? '\nTip: `/ban` works on users who aren’t in the server and bans them right away.' : '';
        await respond(i, { content: ok(`<@${user.id}> is on the watchlist (**${action}** on join).${hint}`) });
      },
    },
  ],
  components: [
    {
      prefix: 'wl',
      tier: 'mod',
      async handle(i, ctx, [action, userId = '']) {
        if (!i.isButton()) return;
        const guild = i.guild!;
        const done = (text: string) => i.update({ content: text, components: [], allowedMentions: { parse: [] } });
        if (action === 'dismiss') {
          await done(`Dismissed by <@${i.user.id}>.`);
          return;
        }
        await i.deferUpdate();
        const target = await ctx.client.users.fetch(userId);
        const actor = actorOf(i);
        const text =
          action === 'ban'
            ? await doBan({ ctx, guild, actor, actorId: i.user.id, target, reason: 'Watchlist alert', deleteSeconds: null, durationS: null, member: (await prepareBan({ ctx, guild, actor, target })).member })
            : await doTimeout({ ctx, guild, actor, actorId: i.user.id, target, reason: 'Watchlist alert', durationS: DAY_S });
        await i.editReply({ content: `${text} (by <@${i.user.id}>)`, components: [], allowedMentions: { parse: [] } });
      },
    },
  ],
  async purgeGuild(guildId, ctx) {
    await ctx.db.deleteFrom('watchlist').where('guild_id', '=', guildId).execute();
  },
  async purgeUser(guildId, userId, ctx) {
    const r = await ctx.db.deleteFrom('watchlist').where('guild_id', '=', guildId).where('user_id', '=', userId).executeTakeFirst();
    await ctx.db.updateTable('watchlist').set({ actor_id: '0' }).where('guild_id', '=', guildId).where('actor_id', '=', userId).execute();
    return Number(r.numDeletedRows);
  },
};
