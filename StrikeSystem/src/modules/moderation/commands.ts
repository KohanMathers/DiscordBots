import {
  ActionRowBuilder,
  ApplicationCommandType,
  type Attachment,
  ButtonBuilder,
  ButtonStyle,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  type Guild,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  type RepliableInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type User,
} from 'discord.js';
import type { CaseStatus, Evidence } from '../../core/cases.ts';
import { MAX_REASON } from '../../core/cases.ts';
import { DAY_S, LONG_MAX_S, parseDuration, TIMEOUT_MAX_S } from '../../core/duration.ts';
import { UserError } from '../../core/errors.ts';
import { describeStep, nextStep, resolveAt } from '../../core/escalation.ts';
import { askConfirmation } from '../../discord/confirm.ts';
import type { BotContext } from '../../discord/context.ts';
import { downloadAttachments } from '../../discord/evidence.ts';
import { actorOf } from '../../discord/members.ts';
import { caseLine, caseLogEmbed } from '../../discord/render.ts';
import { COLORS, ok, respond } from '../../discord/replies.ts';
import type { CommandSpec, ComponentSpec } from '../types.ts';
import { doBan, doKick, doStrike, doTimeout, doUnban, doUntimeout, doWarn, prepareBan } from './actions.ts';

const MOD = PermissionFlagsBits.ModerateMembers;
const PAGE = 10;
const DURATION_PRESETS = ['10m', '1h', '6h', '1d', '3d', '7d', '28d'];

async function deferAction(i: RepliableInteraction, ctx: BotContext) {
  if (i.deferred || i.replied) return;
  const pub = i.guildId ? (await ctx.settings.get(i.guildId)).get<boolean>('notify.public_confirmations') : false;
  await i.deferReply(pub ? {} : { flags: MessageFlags.Ephemeral });
}

const guildOf = (i: RepliableInteraction): Guild => {
  if (!i.guild) throw new UserError('Use this in a server.');
  return i.guild;
};

async function collectEvidence(ctx: BotContext, guildId: string, atts: Attachment[]) {
  if (!atts.length) return { evidence: [] as Evidence[], problems: [] as string[] };
  return downloadAttachments(atts, { dir: `${ctx.config.evidenceDir}/${guildId}`, maxBytes: ctx.config.EVIDENCE_MAX_MB * 1_048_576 });
}

const withProblems = (text: string, problems: string[]) => (problems.length ? `${text}\n⚠️ ${problems.join('\n⚠️ ')}` : text);

const durationAutocomplete: CommandSpec['autocomplete'] = async (i) => {
  const typed = i.options.getFocused().trim().toLowerCase();
  const choices = DURATION_PRESETS.filter((d) => !typed || d.startsWith(typed));
  if (typed && !choices.includes(typed)) choices.unshift(typed);
  await i.respond(choices.slice(0, 25).map((d) => ({ name: d, value: d })));
};

const strike: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('strike')
    .setDescription('Give a member a strike')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('user').setDescription('Who to strike').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(MAX_REASON))
    .addAttachmentOption((o) => o.setName('evidence').setDescription('Screenshot or file'))
    .addAttachmentOption((o) => o.setName('evidence2').setDescription('Another file'))
    .addAttachmentOption((o) => o.setName('evidence3').setDescription('Another file'))
    .addBooleanOption((o) => o.setName('silent').setDescription("Don't DM them"))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await deferAction(i, ctx);
    const guild = guildOf(i);
    const atts = ['evidence', 'evidence2', 'evidence3'].map((n) => i.options.getAttachment(n)).filter((a): a is Attachment => !!a);
    const { evidence, problems } = await collectEvidence(ctx, guild.id, atts);
    const text = await doStrike({
      ctx,
      guild,
      actor: actorOf(i),
      actorId: i.user.id,
      target: i.options.getUser('user', true),
      reason: i.options.getString('reason'),
      evidence,
      silent: i.options.getBoolean('silent') ?? false,
    });
    await respond(i, { content: ok(withProblems(text, problems)) });
  },
};

const unstrike: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('unstrike')
    .setDescription("Remove a member's strike (the latest, or a specific case)")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addIntegerOption((o) => o.setName('case_number').setDescription('Strike case to remove (default: latest)').setMinValue(1))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(MAX_REASON))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await deferAction(i, ctx);
    const guild = guildOf(i);
    const user = i.options.getUser('user', true);
    const number = i.options.getInteger('case_number');
    const c = number ? await ctx.cases.byNumber(guild.id, number) : await ctx.cases.latestActiveStrike(guild.id, user.id);
    if (!c) throw new UserError(number ? `There's no case #${number}.` : `<@${user.id}> has no active strikes.`);
    if (c.targetId !== user.id || !ctx.caseTypes.get(c.type).countsAsStrike) throw new UserError(`Case #${c.number} isn't a strike for <@${user.id}>.`);
    const revokeCase = await ctx.cases.revoke(c, i.user.id, i.options.getString('reason'), { recordRevokeCase: true });
    ctx.kickWorker();
    const remaining = await ctx.cases.activeStrikeCount(guild.id, user.id);
    const max = (await ctx.settings.get(guild.id)).maxStrikes;
    await respond(i, { content: ok(`Removed strike #${c.number} from <@${user.id}>. They now have **${remaining}/${max}** (case #${revokeCase?.number}).`) });
  },
};

const warn: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member (does not count as a strike)')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('user').setDescription('Who to warn').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(MAX_REASON))
    .addAttachmentOption((o) => o.setName('evidence').setDescription('Screenshot or file'))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await deferAction(i, ctx);
    const guild = guildOf(i);
    const att = i.options.getAttachment('evidence');
    const { evidence, problems } = await collectEvidence(ctx, guild.id, att ? [att] : []);
    const text = await doWarn({ ctx, guild, actor: actorOf(i), actorId: i.user.id, target: i.options.getUser('user', true), reason: i.options.getString('reason'), evidence });
    await respond(i, { content: ok(withProblems(text, problems)) });
  },
};

const timeout: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Time a member out')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 1h, 1d12h').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(MAX_REASON))
    .toJSON(),
  autocomplete: durationAutocomplete,
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const guild = guildOf(i);
    const settings = await ctx.settings.get(guild.id);
    const max = settings.get('mute.mode') === 'role' ? LONG_MAX_S : TIMEOUT_MAX_S;
    const durationS = parseDuration(i.options.getString('duration', true), { max });
    await deferAction(i, ctx);
    const text = await doTimeout({ ctx, guild, actor: actorOf(i), actorId: i.user.id, target: i.options.getUser('user', true), reason: i.options.getString('reason'), durationS });
    await respond(i, { content: ok(text) });
  },
};

const untimeout: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription("Lift a member's timeout or mute")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(MAX_REASON))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await deferAction(i, ctx);
    const text = await doUntimeout({ ctx, guild: guildOf(i), actor: actorOf(i), actorId: i.user.id, target: i.options.getUser('user', true), reason: i.options.getString('reason') });
    await respond(i, { content: ok(text) });
  },
};

const kick: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(MAX_REASON))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await deferAction(i, ctx);
    const text = await doKick({ ctx, guild: guildOf(i), actor: actorOf(i), actorId: i.user.id, target: i.options.getUser('user', true), reason: i.options.getString('reason') });
    await respond(i, { content: ok(text) });
  },
};

const DELETE_CHOICES = { none: 0, '1h': 3600, '24h': 86400, '7d': 7 * DAY_S } as const;

const ban: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user: a member, or anyone by ID (pre-emptive ban)')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('user').setDescription('User (or paste an ID)').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(MAX_REASON))
    .addStringOption((o) =>
      o
        .setName('delete_messages')
        .setDescription('Delete their recent messages (default: server setting)')
        .addChoices(...Object.keys(DELETE_CHOICES).map((k) => ({ name: k, value: k }))),
    )
    .addStringOption((o) => o.setName('duration').setDescription('Temporary ban length, e.g. 7d (default: permanent)').setAutocomplete(true))
    .addBooleanOption((o) => o.setName('confirm').setDescription('Skip the confirmation button'))
    .toJSON(),
  autocomplete: durationAutocomplete,
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const guild = guildOf(i);
    const target = i.options.getUser('user', true);
    const reason = i.options.getString('reason');
    const del = i.options.getString('delete_messages') as keyof typeof DELETE_CHOICES | null;
    const durRaw = i.options.getString('duration');
    const durationS = durRaw ? parseDuration(durRaw, { max: LONG_MAX_S }) : null;
    const actor = actorOf(i);
    const { member } = await prepareBan({ ctx, guild, actor, target });
    const run = async (r: RepliableInteraction) => {
      const text = await doBan({ ctx, guild, actor, actorId: i.user.id, target, reason, deleteSeconds: del ? DELETE_CHOICES[del] : null, durationS, member });
      await respond(r, { content: ok(text) });
    };
    if (i.options.getBoolean('confirm')) {
      await deferAction(i, ctx);
      await run(i);
      return;
    }
    const what = `${member ? '' : 'pre-emptively '}ban <@${target.id}>${durationS ? ` for ${durRaw}` : ''}`;
    await askConfirmation(i, `Are you sure you want to ${what}?`, run, 'Ban');
  },
};

const unban: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('user').setDescription('User (or paste an ID)').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(MAX_REASON))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await deferAction(i, ctx);
    const text = await doUnban({ ctx, guild: guildOf(i), actorId: i.user.id, target: i.options.getUser('user', true), reason: i.options.getString('reason') });
    await respond(i, { content: ok(text) });
  },
};

const note: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('note')
    .setDescription('Add a staff-only note to a user (they are never told)')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption((o) => o.setName('text').setDescription('The note').setRequired(true).setMaxLength(MAX_REASON))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const user = i.options.getUser('user', true);
    const c = await ctx.cases.create({ guildId: i.guildId!, type: 'NOTE', targetId: user.id, actorId: i.user.id, reason: i.options.getString('text', true) });
    ctx.kickWorker();
    await respond(i, { content: ok(`Note added to <@${user.id}> (case #${c.number}).`) });
  },
};

const TYPE_FILTERS = ['STRIKE', 'WARN', 'TIMEOUT', 'KICK', 'BAN', 'NOTE'];
const SHOWN_STATUSES: CaseStatus[] = ['ACTIVE', 'EXPIRED', 'SUPERSEDED'];

async function historyPage(ctx: BotContext, guildId: string, user: User | { id: string; username?: string }, page: number, type: string, includeRevoked: boolean) {
  const { cases, total } = await ctx.cases.list(guildId, {
    targetId: user.id,
    ...(type !== '*' ? { types: [type] } : {}),
    ...(includeRevoked ? {} : { statuses: [...SHOWN_STATUSES] }),
    limit: PAGE,
    offset: page * PAGE,
  });
  const settings = await ctx.settings.get(guildId);
  const count = await ctx.cases.activeStrikeCount(guildId, user.id);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`History for ${'username' in user && user.username ? user.username : user.id}`)
    .setDescription(
      `<@${user.id}> · active strikes **${count}/${settings.maxStrikes}** · ${total} case${total === 1 ? '' : 's'}${includeRevoked ? '' : ' (revoked hidden)'}\n\n` +
        (cases.length ? cases.map((c) => caseLine(c, ctx.caseTypes.get(c.type), { showModerator: true, botId: ctx.client.user!.id })).join('\n') : '*Nothing here.*'),
    )
    .setFooter({ text: `Page ${page + 1}/${pages} · /case view <number> for details` });
  const nav = (p: number, label: string, disabled: boolean) =>
    new ButtonBuilder().setCustomId(`hist:${user.id}:${p}:${type}:${includeRevoked ? 1 : 0}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(nav(page - 1, '◀ Previous', page <= 0), nav(page + 1, 'Next ▶', page + 1 >= pages));
  return { embeds: [embed], components: pages > 1 ? [row] : [] };
}

const history: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription("A user's moderation history, including warnings and notes")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption((o) => o.setName('type').setDescription('Only this kind').addChoices(...TYPE_FILTERS.map((t) => ({ name: t.toLowerCase(), value: t }))))
    .addBooleanOption((o) => o.setName('include_revoked').setDescription('Also show revoked cases'))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const user = i.options.getUser('user', true);
    await respond(i, await historyPage(ctx, i.guildId!, user, 0, i.options.getString('type') ?? '*', i.options.getBoolean('include_revoked') ?? false));
  },
};

const historyPager: ComponentSpec = {
  prefix: 'hist',
  tier: 'mod',
  async handle(i, ctx, [userId = '', page = '0', type = '*', inc = '0']) {
    if (!i.isButton()) return;
    await i.update(await historyPage(ctx, i.guildId!, { id: userId }, Number(page), type, inc === '1'));
  },
};

const caseCmd: CommandSpec = {
  tier: 'mod',
  data: new SlashCommandBuilder()
    .setName('case')
    .setDescription('View or change a case')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .addSubcommand((s) => s.setName('view').setDescription('Show a case').addIntegerOption((o) => o.setName('number').setDescription('Case number').setRequired(true).setMinValue(1)))
    .addSubcommand((s) =>
      s
        .setName('reason')
        .setDescription("Change a case's reason (the log entry is updated)")
        .addIntegerOption((o) => o.setName('number').setDescription('Case number').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('reason').setDescription('New reason').setRequired(true).setMaxLength(MAX_REASON)),
    )
    .addSubcommand((s) =>
      s
        .setName('revoke')
        .setDescription('Revoke a case (bans are lifted, timeouts removed)')
        .addIntegerOption((o) => o.setName('number').setDescription('Case number').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(MAX_REASON)),
    )
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = i.guildId!;
    const number = i.options.getInteger('number', true);
    const c = await ctx.cases.byNumber(guildId, number);
    if (!c) throw new UserError(`There's no case #${number}.`);
    const sub = i.options.getSubcommand();
    if (sub === 'view') {
      await respond(i, { embeds: [caseLogEmbed(c, ctx.caseTypes.get(c.type), ctx.client.user!.id)] });
      return;
    }
    if (sub === 'reason') {
      await ctx.cases.editReason(c, i.options.getString('reason', true), i.user.id);
      ctx.kickWorker();
      await respond(i, { content: ok(`Case #${number}'s reason was updated.`) });
      return;
    }
    const reason = i.options.getString('reason');
    const guild = guildOf(i);
    if (c.type === 'BAN' && c.status === 'ACTIVE' && c.targetId) {
      const text = await doUnban({ ctx, guild, actorId: i.user.id, target: await ctx.client.users.fetch(c.targetId), reason: reason ?? `Case #${number} revoked` });
      await ctx.cases.setStatus((await ctx.cases.byId(c.id))!, 'REVOKED', i.user.id);
      await respond(i, { content: ok(`Case #${number} revoked. ${text}`) });
      return;
    }
    if (c.type === 'TIMEOUT' && c.status === 'ACTIVE' && c.targetId) {
      const target = await ctx.client.users.fetch(c.targetId);
      await doUntimeout({ ctx, guild, actor: actorOf(i), actorId: i.user.id, target, reason: reason ?? `Case #${number} revoked` }).catch(() => undefined);
    }
    const revokeCase = await ctx.cases.revoke(c, i.user.id, reason, { recordRevokeCase: Boolean(ctx.caseTypes.get(c.type).countsAsStrike) });
    ctx.kickWorker();
    await respond(i, { content: ok(`Case #${number} revoked${revokeCase ? ` (case #${revokeCase.number})` : ''}.`) });
  },
};

const mystrikes: CommandSpec = {
  tier: 'public',
  allowInMaintenance: true,
  data: new SlashCommandBuilder().setName('mystrikes').setDescription('See your own active strikes in this server').setContexts(InteractionContextType.Guild).toJSON(),
  async execute(i, ctx) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = i.guildId!;
    const settings = await ctx.settings.get(guildId);
    const { cases } = await ctx.cases.list(guildId, { targetId: i.user.id, types: ctx.caseTypes.strikeTypes(), statuses: ['ACTIVE'], limit: 25 });
    const count = cases.length;
    const next = nextStep(settings.ladder, settings.maxStrikes, count);
    const show = settings.get<boolean>('notify.show_moderator');
    const embed = new EmbedBuilder()
      .setColor(count >= settings.maxStrikes ? COLORS.error : count ? COLORS.warn : COLORS.ok)
      .setTitle(`Your strikes: ${count}/${settings.maxStrikes}`)
      .setDescription(
        (cases.length ? cases.map((c) => caseLine(c, ctx.caseTypes.get(c.type), { showModerator: show, botId: ctx.client.user!.id }) + (c.expiresAt ? ` · expires <t:${Math.floor(Date.parse(c.expiresAt) / 1000)}:R>` : '')).join('\n') : "You don't have any active strikes. 🎉") +
          (next ? `\n\nAt ${resolveAt(next, settings.maxStrikes)} strikes: **${describeStep(next)}**.` : ''),
      );
    await respond(i, { embeds: [embed] });
  },
};

const myhistory: CommandSpec = {
  tier: 'public',
  allowInMaintenance: true,
  data: new SlashCommandBuilder().setName('myhistory').setDescription('See your own moderation history in this server').setContexts(InteractionContextType.Guild).toJSON(),
  async execute(i, ctx) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = i.guildId!;
    const settings = await ctx.settings.get(guildId);
    const visible = ctx.caseTypes.all().filter((t) => t.visibleToUser).map((t) => t.type);
    const { cases, total } = await ctx.cases.list(guildId, { targetId: i.user.id, types: visible, limit: 15 });
    const show = settings.get<boolean>('notify.show_moderator');
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('Your moderation history')
      .setDescription(cases.length ? cases.map((c) => caseLine(c, ctx.caseTypes.get(c.type), { showModerator: show, botId: ctx.client.user!.id })).join('\n') : 'Nothing on record. 🎉')
      .setFooter({ text: total > cases.length ? `Showing the latest ${cases.length} of ${total}` : `${total} record${total === 1 ? '' : 's'}` });
    await respond(i, { embeds: [embed] });
  },
};

const reasonInput = (label = 'Reason') =>
  new TextInputBuilder().setCustomId('reason').setLabel(label).setStyle(TextInputStyle.Paragraph).setMaxLength(MAX_REASON).setRequired(false);

const modal = (id: string, title: string, inputs: TextInputBuilder[]) =>
  new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(...inputs.map((t) => new ActionRowBuilder<TextInputBuilder>().addComponents(t)));

const userMenu = (name: string): ContextMenuCommandBuilder =>
  new ContextMenuCommandBuilder().setName(name).setType(ApplicationCommandType.User).setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(MOD);

const ctxStrike: CommandSpec = {
  tier: 'mod',
  data: userMenu('Strike').toJSON(),
  async execute(i) {
    if (!i.isUserContextMenuCommand()) return;
    await i.showModal(modal(`mod:strike:${i.targetId}`, `Strike ${i.targetUser.username}`.slice(0, 45), [reasonInput()]));
  },
};

const ctxWarn: CommandSpec = {
  tier: 'mod',
  data: userMenu('Warn').toJSON(),
  async execute(i) {
    if (!i.isUserContextMenuCommand()) return;
    await i.showModal(modal(`mod:warn:${i.targetId}`, `Warn ${i.targetUser.username}`.slice(0, 45), [reasonInput()]));
  },
};

const ctxTimeout: CommandSpec = {
  tier: 'mod',
  data: userMenu('Timeout').toJSON(),
  async execute(i) {
    if (!i.isUserContextMenuCommand()) return;
    await i.showModal(
      modal(`mod:timeout:${i.targetId}`, `Time out ${i.targetUser.username}`.slice(0, 45), [
        new TextInputBuilder().setCustomId('duration').setLabel('Duration (e.g. 10m, 1h, 1d)').setStyle(TextInputStyle.Short).setValue('1h').setRequired(true).setMaxLength(20),
        reasonInput(),
      ]),
    );
  },
};

const ctxHistory: CommandSpec = {
  tier: 'mod',
  data: userMenu('View history').toJSON(),
  async execute(i, ctx) {
    if (!i.isUserContextMenuCommand()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await respond(i, await historyPage(ctx, i.guildId!, i.targetUser, 0, '*', false));
  },
};

const ctxMessageStrike: CommandSpec = {
  tier: 'mod',
  data: new ContextMenuCommandBuilder()
    .setName('Strike for this message')
    .setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MOD)
    .toJSON(),
  async execute(i) {
    if (!i.isMessageContextMenuCommand()) return;
    if (i.targetMessage.author.bot) throw new UserError("That message is from a bot; bots can't be struck.");
    await i.showModal(modal(`mod:mstrike:${i.channelId}:${i.targetId}`, `Strike ${i.targetMessage.author.username}`.slice(0, 45), [reasonInput()]));
  },
};

const modals: ComponentSpec = {
  prefix: 'mod',
  tier: 'mod',
  async handle(i, ctx, [kind, a = '', b = '']) {
    if (!i.isModalSubmit()) return;
    const guild = guildOf(i);
    const reason = i.fields.getTextInputValue('reason') || null;
    const common = { ctx, guild, actor: actorOf(i), actorId: i.user.id, reason };
    if (kind === 'timeout') {
      const settings = await ctx.settings.get(guild.id);
      const durationS = parseDuration(i.fields.getTextInputValue('duration'), { max: settings.get('mute.mode') === 'role' ? LONG_MAX_S : TIMEOUT_MAX_S });
      await deferAction(i, ctx);
      await respond(i, { content: ok(await doTimeout({ ...common, target: await ctx.client.users.fetch(a), durationS })) });
      return;
    }
    await deferAction(i, ctx);
    if (kind === 'strike') {
      await respond(i, { content: ok(await doStrike({ ...common, target: await ctx.client.users.fetch(a), silent: false })) });
    } else if (kind === 'warn') {
      await respond(i, { content: ok(await doWarn({ ...common, target: await ctx.client.users.fetch(a) })) });
    } else if (kind === 'mstrike') {
      const channel = await guild.channels.fetch(a).catch(() => null);
      const message = channel?.isTextBased() ? await channel.messages.fetch(b).catch(() => null) : null;
      if (!message) throw new UserError('That message is gone, so I can’t attach it as evidence. Use /strike instead.');
      const { evidence, problems } = await collectEvidence(ctx, guild.id, [...message.attachments.values()].slice(0, 3));
      evidence.unshift({ kind: 'message_link', url: message.url });
      if (message.content) evidence.unshift({ kind: 'text', text: message.content.slice(0, 1000) });
      const text = await doStrike({ ...common, target: message.author, silent: false, evidence, metadata: { messageId: message.id, channelId: message.channelId } });
      await respond(i, { content: ok(withProblems(text, problems)) });
    }
  },
};

export const moderationCommands: CommandSpec[] = [
  strike, unstrike, warn, timeout, untimeout, kick, ban, unban, note, history, caseCmd, mystrikes, myhistory,
  ctxStrike, ctxWarn, ctxTimeout, ctxHistory, ctxMessageStrike,
];
export const moderationComponents: ComponentSpec[] = [historyPager, modals];
