import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Clock } from '../core/clock.ts';
import type { Database, JobTable } from '../storage/schema.ts';

export interface JobSpec {
  type: string;
  guildId: string | null;
  payload: Record<string, unknown>;
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface Job {
  id: string;
  guildId: string | null;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAt: string;
}

const toJob = (r: JobTable): Job => ({
  id: r.id,
  guildId: r.guild_id,
  type: r.type,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  runAt: r.run_at,
});

export const backoffMs = (attempts: number) => Math.min(10_000 * 4 ** Math.max(attempts - 1, 0), 3_600_000);

export class JobQueue {
  private readonly db: Kysely<Database>;
  private readonly clock: Clock;

  constructor(db: Kysely<Database>, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  async enqueue(specs: JobSpec[], db: Kysely<Database> = this.db): Promise<void> {
    const now = this.clock.now().toISOString();
    for (const s of specs) {
      await db
        .insertInto('jobs')
        .values({
          id: randomUUID(),
          guild_id: s.guildId,
          type: s.type,
          payload: JSON.stringify(s.payload),
          run_at: (s.runAt ?? this.clock.now()).toISOString(),
          status: 'pending',
          attempts: 0,
          max_attempts: s.maxAttempts ?? 5,
          last_error: null,
          dedupe_key: s.dedupeKey ?? null,
          created_at: now,
          finished_at: null,
        })
        .orIgnore()
        .execute();
    }
  }

  async claimDue(limit: number): Promise<Job[]> {
    const now = this.clock.now().toISOString();
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('jobs')
        .selectAll()
        .where('status', '=', 'pending')
        .where('run_at', '<=', now)
        .orderBy('run_at')
        .orderBy('created_at')
        .limit(limit)
        .execute();
      if (rows.length) {
        await trx
          .updateTable('jobs')
          .set({ status: 'running' })
          .where('id', 'in', rows.map((r) => r.id))
          .execute();
      }
      return rows.map(toJob);
    });
  }

  async complete(id: string): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({ status: 'done', finished_at: this.clock.now().toISOString(), last_error: null })
      .where('id', '=', id)
      .execute();
  }

  async fail(job: Job, error: string, retryable: boolean): Promise<boolean> {
    const attempts = job.attempts + 1;
    const retry = retryable && attempts < job.maxAttempts;
    await this.db
      .updateTable('jobs')
      .set({
        status: retry ? 'pending' : 'failed',
        attempts,
        last_error: error.slice(0, 1000),
        run_at: retry ? new Date(this.clock.now().getTime() + backoffMs(attempts)).toISOString() : job.runAt,
        finished_at: retry ? null : this.clock.now().toISOString(),
      })
      .where('id', '=', job.id)
      .execute();
    return retry;
  }

  async recoverRunning(): Promise<number> {
    const r = await this.db.updateTable('jobs').set({ status: 'pending' }).where('status', '=', 'running').executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  async cancel(dedupeKey: string): Promise<void> {
    await this.db.deleteFrom('jobs').where('dedupe_key', '=', dedupeKey).where('status', '=', 'pending').execute();
  }

  async backlog(): Promise<{ pending: number; failed: number }> {
    const rows = await this.db
      .selectFrom('jobs')
      .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
      .where('status', 'in', ['pending', 'failed'])
      .groupBy('status')
      .execute();
    const get = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    return { pending: get('pending'), failed: get('failed') };
  }

  async prune(days: number): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - days * 86_400_000).toISOString();
    const r = await this.db
      .deleteFrom('jobs')
      .where('status', 'in', ['done', 'failed'])
      .where('finished_at', '<', cutoff)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }
}
