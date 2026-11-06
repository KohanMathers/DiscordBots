import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Case, CaseStatus, CaseTypeRegistry, DmStatus, Evidence } from '../core/cases.ts';
import { checkReason } from '../core/cases.ts';
import type { Clock } from '../core/clock.ts';
import { UserError } from '../core/errors.ts';
import { describeStep, type LadderStep, planEscalation } from '../core/escalation.ts';
import type { GuildSettings } from '../core/settings.ts';
import type { CaseTable, Database } from '../storage/schema.ts';
import type { JobQueue, JobSpec } from './jobs.ts';

export interface NewCase {
  guildId: string;
  type: string;
  targetId: string | null;
  actorId: string;
  reason?: string | null;
  durationS?: number | null;
  expiresAt?: string | null;
  status?: CaseStatus;
  parentCase?: string | null;
  evidence?: Evidence[];
  dmStatus?: DmStatus;
  metadata?: Record<string, unknown>;
  legacyRef?: string | null;
  createdAt?: string;
}

export type CaseJobHook = (c: Case, change: 'created' | 'updated') => JobSpec[];

export interface StrikeResult {
  case: Case;
  count: number;
  escalation: LadderStep | null;
}

export const toCase = (r: CaseTable): Case => ({
  id: r.id,
  guildId: r.guild_id,
  number: Number(r.number),
  type: r.type,
  targetId: r.target_id,
  actorId: r.actor_id,
  reason: r.reason,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  durationS: r.duration_s === null ? null : Number(r.duration_s),
  status: r.status as CaseStatus,
  revokedBy: r.revoked_by,
  revokedAt: r.revoked_at,
  revokeReason: r.revoke_reason,
  parentCase: r.parent_case,
  evidence: JSON.parse(r.evidence) as Evidence[],
  dmStatus: r.dm_status as DmStatus,
  logMessageId: r.log_message_id,
  metadata: JSON.parse(r.metadata) as Record<string, unknown>,
});

export function standardJobs(c: Case, opts: { dm: boolean }): JobSpec[] {
  const jobs: JobSpec[] = [];
  if (opts.dm && c.targetId) jobs.push({ type: 'case.dm', guildId: c.guildId, payload: { caseId: c.id } });
  jobs.push({ type: 'case.log', guildId: c.guildId, payload: { caseId: c.id } });
  return jobs;
}

export class CaseService {
  readonly types: CaseTypeRegistry;
  private readonly db: Kysely<Database>;
  private readonly jobs: JobQueue;
  private readonly clock: Clock;
  private readonly hooks: CaseJobHook[] = [];

  constructor(deps: { db: Kysely<Database>; jobs: JobQueue; clock: Clock; types: CaseTypeRegistry }) {
    this.db = deps.db;
    this.jobs = deps.jobs;
    this.clock = deps.clock;
    this.types = deps.types;
  }

  addHook(hook: CaseJobHook): void {
    this.hooks.push(hook);
  }

  private hookJobs(c: Case, change: 'created' | 'updated'): JobSpec[] {
    return this.hooks.flatMap((h) => h(c, change));
  }

  async insert(trx: Kysely<Database>, input: NewCase): Promise<Case> {
    const reason = checkReason(input.reason);
    const last = await trx
      .selectFrom('cases')
      .select((eb) => eb.fn.max('number').as('n'))
      .where('guild_id', '=', input.guildId)
      .executeTakeFirst();
    const row: CaseTable = {
      id: randomUUID(),
      guild_id: input.guildId,
      number: Number(last?.n ?? 0) + 1,
      type: input.type,
      target_id: input.targetId,
      actor_id: input.actorId,
      reason,
      created_at: input.createdAt ?? this.clock.now().toISOString(),
      expires_at: input.expiresAt ?? null,
      duration_s: input.durationS ?? null,
      status: input.status ?? 'ACTIVE',
      revoked_by: null,
      revoked_at: null,
      revoke_reason: null,
      parent_case: input.parentCase ?? null,
      evidence: JSON.stringify(input.evidence ?? []),
      dm_status: input.dmStatus ?? 'N/A',
      log_message_id: null,
      metadata: JSON.stringify(input.metadata ?? {}),
      legacy_ref: input.legacyRef ?? null,
    };
    await trx.insertInto('cases').values(row).execute();
    return toCase(row);
  }

  async create(input: NewCase, opts: { dm?: boolean; extraJobs?: (c: Case) => JobSpec[] } = {}): Promise<Case> {
    checkReason(input.reason);
    return this.db.transaction().execute(async (trx) => {
      const c = await this.insert(trx, { ...input, dmStatus: input.dmStatus ?? (opts.dm ? 'PENDING' : 'N/A') });
      await this.jobs.enqueue(
        [...standardJobs(c, { dm: Boolean(opts.dm) }), ...(opts.extraJobs?.(c) ?? []), ...this.hookJobs(c, 'created')],
        trx,
      );
      return c;
    });
  }

  async strike(
    input: Omit<NewCase, 'type'>,
    settings: GuildSettings,
    opts: { dm: boolean },
  ): Promise<StrikeResult> {
    checkReason(input.reason);
    const expiry = settings.get<number | null>('strikes.expiry');
    return this.db.transaction().execute(async (trx) => {
      const created = this.clock.now();
      const c = await this.insert(trx, {
        ...input,
        type: 'STRIKE',
        expiresAt: expiry ? new Date(created.getTime() + expiry * 1000).toISOString() : null,
        dmStatus: opts.dm ? 'PENDING' : 'DISABLED',
      });
      const count = await this.activeStrikeCount(input.guildId, input.targetId!, trx);
      const fired = await this.firedSteps(input.guildId, input.targetId!, trx);
      const plan = planEscalation(settings.ladder, settings.maxStrikes, count, fired);
      for (const at of plan.markAts) {
        await trx
          .insertInto('escalation_marker')
          .values({ guild_id: input.guildId, user_id: input.targetId!, at, case_id: c.id, fired_at: created.toISOString() })
          .orIgnore()
          .execute();
      }
      const metadata = {
        ...c.metadata,
        count,
        max: settings.maxStrikes,
        ...(plan.fire ? { escalation: describeStep(plan.fire) } : {}),
      };
      await trx.updateTable('cases').set({ metadata: JSON.stringify(metadata) }).where('id', '=', c.id).execute();
      c.metadata = metadata;

      const jobs: JobSpec[] = [...standardJobs(c, { dm: opts.dm }), ...this.hookJobs(c, 'created')];
      if (plan.fire) {
        jobs.push({
          type: 'escalation.run',
          guildId: input.guildId,
          payload: { strikeCaseId: c.id, step: plan.fire, at: plan.atKey },
          maxAttempts: 3,
        });
      }
      await this.jobs.enqueue(jobs, trx);
      return { case: c, count, escalation: plan.fire };
    });
  }

  async reserve(input: NewCase): Promise<Case> {
    checkReason(input.reason);
    return this.db.transaction().execute((trx) => this.insert(trx, input));
  }

  async publish(c: Case, dmStatus: DmStatus, extraJobs: JobSpec[] = []): Promise<Case> {
    const updated = { ...c, dmStatus };
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('cases').set({ dm_status: dmStatus }).where('id', '=', c.id).execute();
      await this.jobs.enqueue([...standardJobs(updated, { dm: false }), ...extraJobs, ...this.hookJobs(updated, 'created')], trx);
    });
    return updated;
  }

  async discard(id: string): Promise<void> {
    await this.db.deleteFrom('cases').where('id', '=', id).execute();
  }

  async setStatus(c: Case, status: CaseStatus, by?: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('cases')
        .set({ status, ...(by ? { revoked_by: by, revoked_at: this.clock.now().toISOString() } : {}) })
        .where('id', '=', c.id)
        .execute();
      await this.jobs.enqueue([{ type: 'case.log', guildId: c.guildId, payload: { caseId: c.id } }, ...this.hookJobs({ ...c, status }, 'updated')], trx);
    });
  }

  async escalationDone(strikeCaseId: string, at: number): Promise<boolean> {
    const rows = await this.db.selectFrom('cases').select('metadata').where('parent_case', '=', strikeCaseId).execute();
    return rows.some((r) => (JSON.parse(r.metadata) as { escalationAt?: number }).escalationAt === at);
  }

  async activeStrikeCount(guildId: string, userId: string, db: Kysely<Database> = this.db): Promise<number> {
    const r = await db
      .selectFrom('cases')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('guild_id', '=', guildId)
      .where('target_id', '=', userId)
      .where('status', '=', 'ACTIVE')
      .where('type', 'in', this.types.strikeTypes())
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  private async firedSteps(guildId: string, userId: string, db: Kysely<Database>): Promise<Set<number>> {
    const rows = await db
      .selectFrom('escalation_marker')
      .select('at')
      .where('guild_id', '=', guildId)
      .where('user_id', '=', userId)
      .execute();
    return new Set(rows.map((r) => Number(r.at)));
  }

  async byId(id: string): Promise<Case | undefined> {
    const r = await this.db.selectFrom('cases').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toCase(r) : undefined;
  }

  async byNumber(guildId: string, number: number): Promise<Case | undefined> {
    const r = await this.db
      .selectFrom('cases')
      .selectAll()
      .where('guild_id', '=', guildId)
      .where('number', '=', number)
      .executeTakeFirst();
    return r ? toCase(r) : undefined;
  }

  async list(
    guildId: string,
    f: { targetId?: string; types?: string[]; statuses?: CaseStatus[]; limit: number; offset?: number },
  ): Promise<{ cases: Case[]; total: number }> {
    let q = this.db.selectFrom('cases').where('guild_id', '=', guildId);
    if (f.targetId) q = q.where('target_id', '=', f.targetId);
    if (f.types?.length) q = q.where('type', 'in', f.types);
    if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
    const total = await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const rows = await q
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('number', 'desc')
      .limit(f.limit)
      .offset(f.offset ?? 0)
      .execute();
    return { cases: rows.map(toCase), total: Number(total.n) };
  }

  async latestActiveStrike(guildId: string, userId: string): Promise<Case | undefined> {
    const { cases } = await this.list(guildId, {
      targetId: userId,
      types: this.types.strikeTypes(),
      statuses: ['ACTIVE'],
      limit: 1,
    });
    return cases[0];
  }

  async strikeSummary(guildId: string): Promise<Array<{ userId: string; count: number; soonestExpiry: string | null }>> {
    const rows = await this.db
      .selectFrom('cases')
      .select(['target_id', (eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.min('expires_at').as('soonest')])
      .where('guild_id', '=', guildId)
      .where('status', '=', 'ACTIVE')
      .where('type', 'in', this.types.strikeTypes())
      .where('target_id', 'is not', null)
      .groupBy('target_id')
      .execute();
    return rows.map((r) => ({ userId: r.target_id!, count: Number(r.n), soonestExpiry: (r.soonest as string | null) ?? null }));
  }

  async activelyBanned(guildId: string, userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const rows = await this.db
      .selectFrom('cases')
      .select('target_id')
      .where('guild_id', '=', guildId)
      .where('type', '=', 'BAN')
      .where('status', '=', 'ACTIVE')
      .where('target_id', 'in', userIds)
      .execute();
    return new Set(rows.map((r) => r.target_id!));
  }

  async revoke(c: Case, by: string, reason: string | null, opts: { recordRevokeCase: boolean }): Promise<Case | null> {
    checkReason(reason);
    if (c.status !== 'ACTIVE') throw new UserError(`Case #${c.number} is already ${c.status.toLowerCase()}.`);
    return this.db.transaction().execute(async (trx) => {
      const now = this.clock.now().toISOString();
      await trx
        .updateTable('cases')
        .set({ status: 'REVOKED', revoked_by: by, revoked_at: now, revoke_reason: reason })
        .where('id', '=', c.id)
        .execute();
      const updated = { ...c, status: 'REVOKED' as const, revokedBy: by, revokedAt: now, revokeReason: reason };
      if (typeof c.metadata.escalationAt === 'number' && c.targetId) {
        await trx
          .deleteFrom('escalation_marker')
          .where('guild_id', '=', c.guildId)
          .where('user_id', '=', c.targetId)
          .where('at', '=', c.metadata.escalationAt)
          .execute();
      }
      const jobs: JobSpec[] = [{ type: 'case.log', guildId: c.guildId, payload: { caseId: c.id } }, ...this.hookJobs(updated, 'updated')];
      let revokeCase: Case | null = null;
      if (opts.recordRevokeCase) {
        revokeCase = await this.insert(trx, {
          guildId: c.guildId,
          type: 'STRIKE_REVOKE',
          targetId: c.targetId,
          actorId: by,
          reason,
          parentCase: c.id,
          metadata: { revokedCase: c.number, count: c.targetId ? await this.activeStrikeCount(c.guildId, c.targetId, trx) : 0 },
        });
        jobs.push(...standardJobs(revokeCase, { dm: false }), ...this.hookJobs(revokeCase, 'created'));
      }
      await this.jobs.enqueue(jobs, trx);
      return revokeCase;
    });
  }

  async supersedeActive(guildId: string, targetId: string, type: string, by: string): Promise<void> {
    const { cases } = await this.list(guildId, { targetId, types: [type], statuses: ['ACTIVE'], limit: 10 });
    for (const c of cases) {
      await this.db.transaction().execute(async (trx) => {
        await trx.updateTable('cases').set({ status: 'SUPERSEDED', revoked_by: by, revoked_at: this.clock.now().toISOString() }).where('id', '=', c.id).execute();
        if (typeof c.metadata.escalationAt === 'number') {
          await trx.deleteFrom('escalation_marker').where('guild_id', '=', guildId).where('user_id', '=', targetId).where('at', '=', c.metadata.escalationAt).execute();
        }
        await this.jobs.enqueue([{ type: 'case.log', guildId, payload: { caseId: c.id } }, ...this.hookJobs({ ...c, status: 'SUPERSEDED' }, 'updated')], trx);
      });
    }
  }

  async editReason(c: Case, reason: string, by: string): Promise<void> {
    const r = checkReason(reason);
    await this.db.transaction().execute(async (trx) => {
      const metadata = { ...c.metadata, reasonEditedBy: by, reasonEditedAt: this.clock.now().toISOString() };
      await trx.updateTable('cases').set({ reason: r, metadata: JSON.stringify(metadata) }).where('id', '=', c.id).execute();
      await this.jobs.enqueue([{ type: 'case.log', guildId: c.guildId, payload: { caseId: c.id } }], trx);
    });
  }

  async setDmStatus(id: string, status: DmStatus): Promise<void> {
    await this.db.updateTable('cases').set({ dm_status: status }).where('id', '=', id).execute();
  }

  async setLogMessage(id: string, messageId: string): Promise<void> {
    await this.db.updateTable('cases').set({ log_message_id: messageId }).where('id', '=', id).execute();
  }

  async setEvidence(id: string, evidence: Evidence[]): Promise<void> {
    await this.db.updateTable('cases').set({ evidence: JSON.stringify(evidence) }).where('id', '=', id).execute();
  }

  async mergeMetadata(id: string, patch: Record<string, unknown>): Promise<void> {
    const c = await this.byId(id);
    if (!c) return;
    await this.db.updateTable('cases').set({ metadata: JSON.stringify({ ...c.metadata, ...patch }) }).where('id', '=', id).execute();
  }

  async expireDue(): Promise<string[]> {
    const now = this.clock.now().toISOString();
    const due = await this.db
      .selectFrom('cases')
      .selectAll()
      .where('status', '=', 'ACTIVE')
      .where('type', 'in', [...this.types.strikeTypes(), 'TIMEOUT'])
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', now)
      .limit(500)
      .execute();
    const guilds = new Set<string>();
    for (const row of due) {
      const c = toCase(row);
      await this.db.transaction().execute(async (trx) => {
        await trx.updateTable('cases').set({ status: 'EXPIRED' }).where('id', '=', c.id).execute();
        const count = this.types.get(c.type).countsAsStrike ? await this.activeStrikeCount(c.guildId, c.targetId!, trx) : Infinity;
        const markers = await trx.selectFrom('escalation_marker').select('at').where('guild_id', '=', c.guildId).where('user_id', '=', c.targetId!).execute();
        const below = markers.map((m) => Number(m.at)).filter((at) => at > count);
        if (below.length) {
          await trx.deleteFrom('escalation_marker').where('guild_id', '=', c.guildId).where('user_id', '=', c.targetId!).where('at', 'in', below).execute();
        }
        await this.jobs.enqueue(
          [{ type: 'case.log', guildId: c.guildId, payload: { caseId: c.id } }, ...this.hookJobs({ ...c, status: 'EXPIRED' }, 'updated')],
          trx,
        );
      });
      guilds.add(c.guildId);
    }
    return [...guilds];
  }

  async purgeUser(guildId: string, userId: string): Promise<{ deleted: number; anonymised: number }> {
    return this.db.transaction().execute(async (trx) => {
      const del = await trx.deleteFrom('cases').where('guild_id', '=', guildId).where('target_id', '=', userId).executeTakeFirst();
      const anon = await trx.updateTable('cases').set({ actor_id: '0' }).where('guild_id', '=', guildId).where('actor_id', '=', userId).executeTakeFirst();
      await trx.updateTable('cases').set({ revoked_by: '0' }).where('guild_id', '=', guildId).where('revoked_by', '=', userId).execute();
      await trx.deleteFrom('escalation_marker').where('guild_id', '=', guildId).where('user_id', '=', userId).execute();
      return { deleted: Number(del.numDeletedRows), anonymised: Number(anon.numUpdatedRows) };
    });
  }
}
