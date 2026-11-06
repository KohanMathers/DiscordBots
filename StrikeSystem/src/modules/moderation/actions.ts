import { type Guild, type GuildMember, PermissionFlagsBits, type User } from 'discord.js';
import type { Case, Evidence } from '../../core/cases.ts';
import { checkReason } from '../../core/cases.ts';
import { formatDuration, LONG_MAX_S, TIMEOUT_MAX_S } from '../../core/duration.ts';
import { UserError } from '../../core/errors.ts';
import { describeStep } from '../../core/escalation.ts';
import type { GuildSettings } from '../../core/settings.ts';
import type { BotContext } from '../../discord/context.ts';
import { apiCode, ERR, sendCaseDm } from '../../discord/delivery.ts';
import { type Actor, assertBotCan, assertTargetable, fetchMember, highestRole } from '../../discord/members.ts';
import type { JobSpec } from '../../services/jobs.ts';

export class ActionError extends Error {
  override readonly name = 'ActionError';
}

export interface ActionCommon {
  ctx: BotContext;
  guild: Guild;
  actorId: string;
  reason: string | null;
  parentCase?: Case | null;
  metadata?: Record<string, unknown>;
  evidence?: Evidence[];
}

const auditReason = (actorTag: string, reason: string | null) =>
  `${actorTag}: ${reason ?? 'no reason given'}`.slice(0, 512);

const actorTag = (ctx: BotContext, actorId: string) => (actorId === ctx.client.user!.id ? 'Automatic' : `By ${actorId}`);

function explain(err: unknown, what: string): never {
  const code = apiCode(err);
  if (code === ERR.missingPermissions || code === ERR.missingAccess) {
    throw new ActionError(`I don't have permission to ${what}, or their role is above mine.`);
  }
  if (code === ERR.unknownMember) throw new ActionError(`They're no longer in the server, so I can't ${what}.`);
  throw err;
}

const parentMeta = (p?: Case | null) => (p ? { parentNumber: p.number } : {});

export async function doStrike(
  o: ActionCommon & { actor: Actor; target: User; silent: boolean },
): Promise<string> {
  const { ctx, guild } = o;
  checkReason(o.reason);
  await assertTargetable(guild, o.actor, o.target, ctx.client.user!.id);
  const settings = await ctx.settings.get(guild.id);
  const dm = !o.silent && settings.dmEnabled('strike');
  const r = await ctx.cases.strike(
    { guildId: guild.id, targetId: o.target.id, actorId: o.actorId, reason: o.reason, evidence: o.evidence ?? [], metadata: o.metadata ?? {} },
    settings,
    { dm },
  );
  ctx.metrics.inc('strikes_cases_total', { type: 'STRIKE' });
  ctx.kickWorker();
  const lines = [`Strike issued to <@${o.target.id}>. They now have **${r.count}/${settings.maxStrikes}** strikes (case #${r.case.number}).`];
  if (r.escalation) lines.push(`This triggers: **${describeStep(r.escalation)}**.`);
  if (!dm) lines.push(o.silent ? 'They were not DMed (silent).' : 'DMs for strikes are turned off.');
  return lines.join('\n');
}

export async function doWarn(o: ActionCommon & { actor: Actor; target: User }): Promise<string> {
  const { ctx, guild } = o;
  checkReason(o.reason);
  await assertTargetable(guild, o.actor, o.target, ctx.client.user!.id);
  const settings = await ctx.settings.get(guild.id);
  const c = await ctx.cases.create(
    { guildId: guild.id, type: 'WARN', targetId: o.target.id, actorId: o.actorId, reason: o.reason, evidence: o.evidence ?? [], metadata: o.metadata ?? {} },
    { dm: settings.dmEnabled('warn') },
  );
  ctx.metrics.inc('strikes_cases_total', { type: 'WARN' });
  ctx.kickWorker();
  return `<@${o.target.id}> was warned (case #${c.number}).`;
}

export async function executeTimeout(
  o: ActionCommon & { member: GuildMember; durationS: number; dm: boolean },
): Promise<Case> {
  const { ctx, guild, member } = o;
  const settings = await ctx.settings.get(guild.id);
  const mode = settings.get<string>('mute.mode');
  const expiresAt = new Date(ctx.clock.now().getTime() + o.durationS * 1000).toISOString();
  const jobs: JobSpec[] = [];
  if (mode === 'role') {
    const roleId = settings.get<string | null>('mute.role');
    if (!roleId) throw new ActionError('mute.mode is `role` but no mute role is set (`/config set mute.role`).');
    if (o.durationS > LONG_MAX_S) throw new ActionError(`Mutes can last at most ${formatDuration(LONG_MAX_S)}.`);
    await member.roles.add(roleId, auditReason(actorTag(ctx, o.actorId), o.reason)).catch((e) => explain(e, 'give them the mute role'));
    jobs.push({
      type: 'rolemute.remove',
      guildId: guild.id,
      payload: { userId: member.id, roleId },
      runAt: new Date(expiresAt),
      dedupeKey: `rolemute:${guild.id}:${member.id}`,
    });
  } else {
    if (o.durationS > TIMEOUT_MAX_S) throw new ActionError('Discord timeouts last at most 28 days. Use a mute role (`mute.mode role`) for longer.');
    await member.timeout(o.durationS * 1000, auditReason(actorTag(ctx, o.actorId), o.reason)).catch((e) => explain(e, 'time them out'));
  }
  const c = await ctx.cases.create(
    {
      guildId: guild.id,
      type: 'TIMEOUT',
      targetId: member.id,
      actorId: o.actorId,
      reason: o.reason,
      durationS: o.durationS,
      expiresAt,
      parentCase: o.parentCase?.id ?? null,
      evidence: o.evidence ?? [],
      metadata: { ...o.metadata, ...parentMeta(o.parentCase), mode },
    },
    { dm: o.dm, extraJobs: () => jobs },
  );
  ctx.metrics.inc('strikes_cases_total', { type: 'TIMEOUT' });
  ctx.kickWorker();
  return c;
}

export async function doTimeout(o: ActionCommon & { actor: Actor; target: User; durationS: number }): Promise<string> {
  const { ctx, guild } = o;
  checkReason(o.reason);
  const member = await assertTargetable(guild, o.actor, o.target, ctx.client.user!.id);
  if (!member) throw new UserError(`<@${o.target.id}> isn't in the server, so they can't be timed out.`);
  const settings = await ctx.settings.get(guild.id);
  await assertBotCan(guild, [settings.get('mute.mode') === 'role' ? PermissionFlagsBits.ManageRoles : PermissionFlagsBits.ModerateMembers]);
  try {
    const c = await executeTimeout({ ...o, member, dm: settings.dmEnabled('timeout') });
    return `<@${member.id}> is timed out for **${formatDuration(o.durationS)}** (case #${c.number}).`;
  } catch (err) {
    if (err instanceof ActionError) throw new UserError(err.message);
    throw err;
  }
}

export async function doUntimeout(o: ActionCommon & { actor: Actor; target: User }): Promise<string> {
  const { ctx, guild } = o;
  checkReason(o.reason);
  const member = await assertTargetable(guild, o.actor, o.target, ctx.client.user!.id);
  if (!member) throw new UserError(`<@${o.target.id}> isn't in the server.`);
  const settings = await ctx.settings.get(guild.id);
  const roleId = settings.get<string | null>('mute.role');
  const timedOut = member.isCommunicationDisabled();
  const roleMuted = roleId ? member.roles.cache.has(roleId) : false;
  if (!timedOut && !roleMuted) throw new UserError(`<@${member.id}> isn't timed out or muted.`);
  const why = `By ${o.actorId}: ${o.reason ?? 'no reason given'}`.slice(0, 512);
  try {
    if (timedOut) await member.timeout(null, why);
    if (roleMuted && roleId) await member.roles.remove(roleId, why);
  } catch (err) {
    try {
      explain(err, 'lift their timeout');
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }
  await ctx.jobs.cancel(`rolemute:${guild.id}:${member.id}`);
  await ctx.cases.supersedeActive(guild.id, member.id, 'TIMEOUT', o.actorId);
  const c = await ctx.cases.create({ guildId: guild.id, type: 'UNTIMEOUT', targetId: member.id, actorId: o.actorId, reason: o.reason });
  ctx.kickWorker();
  return `<@${member.id}>'s timeout was lifted (case #${c.number}).`;
}

async function dmThenAct(
  o: ActionCommon & { target: User; type: 'KICK' | 'BAN'; dm: boolean; durationS?: number | null; expiresAt?: string | null },
  act: () => Promise<unknown>,
  extraJobs: (c: Case) => JobSpec[] = () => [],
): Promise<Case> {
  const { ctx, guild } = o;
  const c = await ctx.cases.reserve({
    guildId: guild.id,
    type: o.type,
    targetId: o.target.id,
    actorId: o.actorId,
    reason: o.reason,
    durationS: o.durationS ?? null,
    expiresAt: o.expiresAt ?? null,
    parentCase: o.parentCase?.id ?? null,
    evidence: o.evidence ?? [],
    metadata: { ...o.metadata, ...parentMeta(o.parentCase) },
  });
  let dm: Case['dmStatus'] = o.dm ? await sendCaseDm(ctx, c, guild.name).catch(() => 'FAILED' as const) : 'DISABLED';
  try {
    await act();
  } catch (err) {
    await ctx.cases.discard(c.id);
    if (dm === 'SENT') {
      await ctx.client.users
        .send(o.target.id, `Please ignore my previous message about **${guild.name}**: that action did not go through.`)
        .catch(() => undefined);
      dm = 'FAILED';
    }
    explain(err, o.type === 'BAN' ? 'ban them' : 'kick them');
  }
  const published = await ctx.cases.publish(c, dm, extraJobs(c));
  ctx.metrics.inc('strikes_cases_total', { type: o.type });
  ctx.kickWorker();
  return published;
}

export async function executeKick(o: ActionCommon & { target: User; member: GuildMember; dm: boolean }): Promise<Case> {
  return dmThenAct({ ...o, type: 'KICK' }, () => o.member.kick(auditReason(actorTag(o.ctx, o.actorId), o.reason)));
}

export async function executeBan(
  o: ActionCommon & { target: User; isMember: boolean; dm: boolean; deleteSeconds: number; durationS?: number | null },
): Promise<Case> {
  const { ctx, guild } = o;
  const expiresAt = o.durationS ? new Date(ctx.clock.now().getTime() + o.durationS * 1000).toISOString() : null;
  return dmThenAct(
    {
      ...o,
      type: 'BAN',
      dm: o.dm && o.isMember,
      durationS: o.durationS ?? null,
      expiresAt,
      metadata: { ...o.metadata, ...(o.isMember ? {} : { preemptive: true }) },
    },
    () => guild.bans.create(o.target.id, { deleteMessageSeconds: o.deleteSeconds, reason: auditReason(actorTag(ctx, o.actorId), o.reason) }),
    (c) =>
      o.durationS
        ? [{ type: 'tempban.unban', guildId: guild.id, payload: { userId: o.target.id, caseId: c.id }, runAt: new Date(expiresAt!), dedupeKey: `tempban:${guild.id}:${o.target.id}` }]
        : [],
  );
}

export async function doKick(o: ActionCommon & { actor: Actor; target: User }): Promise<string> {
  const { ctx, guild } = o;
  checkReason(o.reason);
  const member = await assertTargetable(guild, o.actor, o.target, ctx.client.user!.id);
  if (!member) throw new UserError(`<@${o.target.id}> isn't in the server.`);
  await assertBotCan(guild, [PermissionFlagsBits.KickMembers]);
  const settings = await ctx.settings.get(guild.id);
  try {
    const c = await executeKick({ ...o, member, dm: settings.dmEnabled('kick') });
    return `<@${o.target.id}> was kicked (case #${c.number}).`;
  } catch (err) {
    if (err instanceof ActionError) throw new UserError(err.message);
    throw err;
  }
}

export async function prepareBan(o: { ctx: BotContext; guild: Guild; actor: Actor; target: User }) {
  const member = await assertTargetable(o.guild, o.actor, o.target, o.ctx.client.user!.id);
  await assertBotCan(o.guild, [PermissionFlagsBits.BanMembers]);
  const existing = await o.guild.bans.fetch({ user: o.target.id, force: true }).catch(() => null);
  if (existing) throw new UserError(`<@${o.target.id}> is already banned.`);
  return { member };
}

export async function doBan(
  o: ActionCommon & { actor: Actor; target: User; deleteSeconds: number | null; durationS: number | null; member: GuildMember | null },
): Promise<string> {
  const settings: GuildSettings = await o.ctx.settings.get(o.guild.id);
  try {
    const c = await executeBan({
      ...o,
      isMember: Boolean(o.member),
      dm: settings.dmEnabled('ban'),
      deleteSeconds: o.deleteSeconds ?? settings.get<number>('ban.delete_message_seconds'),
    });
    const extra = [
      o.member ? '' : ' This was a pre-emptive ban: they are not in the server.',
      o.durationS ? ` They will be unbanned <t:${Math.floor(Date.parse(c.expiresAt!) / 1000)}:R>.` : '',
    ].join('');
    return `<@${o.target.id}> was banned (case #${c.number}).${extra}`;
  } catch (err) {
    if (err instanceof ActionError) throw new UserError(err.message);
    throw err;
  }
}

export async function doUnban(o: ActionCommon & { target: User }): Promise<string> {
  const { ctx, guild } = o;
  checkReason(o.reason);
  await assertBotCan(guild, [PermissionFlagsBits.BanMembers]);
  try {
    await guild.bans.remove(o.target.id, `By ${o.actorId}: ${o.reason ?? 'no reason given'}`.slice(0, 512));
  } catch (err) {
    if (apiCode(err) === ERR.unknownBan) throw new UserError(`<@${o.target.id}> isn't banned.`);
    try {
      explain(err, 'unban them');
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }
  await recordUnban(ctx, guild.id, o.target.id, o.actorId, o.reason);
  return `<@${o.target.id}> was unbanned.`;
}

export async function recordUnban(ctx: BotContext, guildId: string, userId: string, actorId: string, reason: string | null, metadata: Record<string, unknown> = {}) {
  await ctx.jobs.cancel(`tempban:${guildId}:${userId}`);
  await ctx.cases.supersedeActive(guildId, userId, 'BAN', actorId);
  const c = await ctx.cases.create({ guildId, type: 'UNBAN', targetId: userId, actorId, reason, metadata });
  ctx.kickWorker();
  return c;
}

export { fetchMember, highestRole };
