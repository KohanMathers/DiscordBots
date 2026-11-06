import type { Kysely } from 'kysely';
import type { Clock } from '../core/clock.ts';
import { type LockPlan, planLock, planRestore, type RoleFacts, type Snapshot, type Tri } from '../core/lock.ts';
import type { OverwritePort } from '../core/ports.ts';
import type { Database } from '../storage/schema.ts';
import type { AuditService } from './audit.ts';
import type { JobQueue } from './jobs.ts';

export type LockOutcome = { status: 'already' } | { status: 'locked'; plan: LockPlan };
export type UnlockOutcome = { status: 'not-locked' } | { status: 'unlocked'; restored: number };

export const expiryKey = (guildId: string, channelId: string) => `lock:${guildId}:${channelId}`;

export class LockService {
  private readonly db: Kysely<Database>;
  private readonly clock: Clock;
  private readonly audit: AuditService;
  private readonly jobs: JobQueue;

  constructor(deps: { db: Kysely<Database>; clock: Clock; audit: AuditService; jobs: JobQueue }) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.audit = deps.audit;
    this.jobs = deps.jobs;
  }

  async isLocked(guildId: string, channelId: string): Promise<boolean> {
    return Boolean(await this.db.selectFrom('channel_lock').select('channel_id').where('guild_id', '=', guildId).where('channel_id', '=', channelId).executeTakeFirst());
  }

  async lock(o: {
    guildId: string;
    channelId: string;
    actorId: string;
    reason: string | null;
    expiresAt: Date | null;
    port: OverwritePort;
    everyoneId: string;
    botId: string;
    botTopPosition: number;
    roles: Map<string, RoleFacts>;
    staffMemberIds: ReadonlySet<string>;
  }): Promise<LockOutcome> {
    if (await this.isLocked(o.guildId, o.channelId)) return { status: 'already' };
    const plan = planLock({ ...o, overwrites: await o.port.overwrites() });
    const now = this.clock.now().toISOString();

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('channel_lock')
        .values({ guild_id: o.guildId, channel_id: o.channelId, locked_at: now, locked_by: o.actorId, reason: o.reason, expires_at: o.expiresAt?.toISOString() ?? null })
        .execute();
      for (const s of plan.snapshots) {
        await trx
          .insertInto('channel_lock_override')
          .values({
            guild_id: o.guildId,
            channel_id: o.channelId,
            target_id: s.targetId,
            target_type: s.targetType,
            existed: s.existed ? 1 : 0,
            prior_send: s.prior.SendMessages,
            prior_send_in_threads: s.prior.SendMessagesInThreads,
          })
          .execute();
      }
      if (o.expiresAt) {
        await this.jobs.enqueue([{ type: 'lock.expire', guildId: o.guildId, payload: { channelId: o.channelId }, runAt: o.expiresAt, dedupeKey: expiryKey(o.guildId, o.channelId) }], trx);
      }
      await this.audit.record({ guildId: o.guildId, actorId: o.actorId, action: 'lock', target: o.channelId, payload: { reason: o.reason, expiresAt: o.expiresAt?.toISOString() ?? null, roles: plan.snapshots.length, skipped: plan.skipped } }, trx);
    });

    const applied: number[] = [];
    try {
      for (const [n, edit] of plan.edits.entries()) {
        await o.port.apply(edit);
        applied.push(n);
      }
    } catch (err) {
      const restore = planRestore(plan.snapshots);
      for (const n of applied.reverse()) await o.port.apply(restore[n]!).catch(() => undefined);
      await this.forget(o.guildId, o.channelId);
      throw err;
    }
    return { status: 'locked', plan };
  }

  async snapshots(guildId: string, channelId: string): Promise<Snapshot[]> {
    const rows = await this.db.selectFrom('channel_lock_override').selectAll().where('guild_id', '=', guildId).where('channel_id', '=', channelId).execute();
    return rows.map((r) => ({
      targetId: r.target_id,
      targetType: r.target_type,
      existed: Boolean(r.existed),
      prior: { SendMessages: r.prior_send as Tri, SendMessagesInThreads: r.prior_send_in_threads as Tri },
    }));
  }

  async unlock(o: { guildId: string; channelId: string; actorId: string; botId: string; port: OverwritePort; reason?: string }): Promise<UnlockOutcome> {
    if (!(await this.isLocked(o.guildId, o.channelId))) return { status: 'not-locked' };
    const edits = planRestore(await this.snapshots(o.guildId, o.channelId));
    edits.sort((a, b) => Number(a.targetId === o.botId) - Number(b.targetId === o.botId));
    for (const e of edits) await o.port.apply(e);
    await this.forget(o.guildId, o.channelId);
    await this.jobs.cancel(expiryKey(o.guildId, o.channelId));
    await this.audit.record({ guildId: o.guildId, actorId: o.actorId, action: 'unlock', target: o.channelId, payload: { restored: edits.length, reason: o.reason ?? null } });
    return { status: 'unlocked', restored: edits.length };
  }

  private async forget(guildId: string, channelId: string) {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('channel_lock_override').where('guild_id', '=', guildId).where('channel_id', '=', channelId).execute();
      await trx.deleteFrom('channel_lock').where('guild_id', '=', guildId).where('channel_id', '=', channelId).execute();
    });
  }
}
