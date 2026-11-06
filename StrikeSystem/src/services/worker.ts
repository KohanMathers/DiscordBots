import type { Logger } from 'pino';
import type { Metrics } from '../core/metrics.ts';
import type { Job, JobQueue } from './jobs.ts';

export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';
}

export interface RegisteredHandler {
  moduleId: string;
  run(job: Job): Promise<void>;
}

export class JobWorker {
  private readonly queue: JobQueue;
  private readonly handlers: Map<string, RegisteredHandler>;
  private readonly isEnabled: (guildId: string, moduleId: string) => Promise<boolean>;
  private readonly log: Logger;
  private readonly metrics: Metrics;

  constructor(deps: {
    queue: JobQueue;
    handlers: Map<string, RegisteredHandler>;
    isEnabled: (guildId: string, moduleId: string) => Promise<boolean>;
    log: Logger;
    metrics: Metrics;
  }) {
    this.queue = deps.queue;
    this.handlers = deps.handlers;
    this.isEnabled = deps.isEnabled;
    this.log = deps.log;
    this.metrics = deps.metrics;
  }

  async drainOnce(limit = 100): Promise<number> {
    const jobs = await this.queue.claimDue(limit);
    const byGuild = new Map<string, Job[]>();
    for (const j of jobs) {
      const k = j.guildId ?? `global:${j.id}`;
      byGuild.set(k, [...(byGuild.get(k) ?? []), j]);
    }
    await Promise.all([...byGuild.values()].map(async (list) => {
      for (const j of list) await this.run(j);
    }));
    const backlog = await this.queue.backlog();
    this.metrics.set('strikes_jobs_backlog', backlog.pending);
    return jobs.length;
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    const ctx = { jobId: job.id, type: job.type, guildId: job.guildId, attempt: job.attempts + 1 };
    if (!handler) {
      await this.queue.fail(job, `no handler for ${job.type}`, false);
      this.log.error(ctx, 'job has no handler');
      return;
    }
    try {
      if (job.guildId && !(await this.isEnabled(job.guildId, handler.moduleId))) {
        await this.queue.complete(job.id);
        return;
      }
      await handler.run(job);
      await this.queue.complete(job.id);
      this.metrics.inc('strikes_jobs_total', { type: job.type, result: 'ok' });
    } catch (err) {
      const permanent = err instanceof PermanentJobError;
      const retrying = await this.queue.fail(job, err instanceof Error ? err.message : String(err), !permanent);
      this.metrics.inc('strikes_jobs_total', { type: job.type, result: retrying ? 'retry' : 'failed' });
      this.log[retrying ? 'warn' : 'error']({ ...ctx, err }, retrying ? 'job failed, will retry' : 'job failed');
    }
  }
}
