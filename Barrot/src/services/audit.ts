import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Clock } from '../core/clock.ts';
import type { Database } from '../storage/schema.ts';
import type { JobQueue } from './jobs.ts';

export interface AuditEntry {
  guildId: string;
  actorId: string;
  action: string;
  target?: string | null;
  payload?: Record<string, unknown>;
}

export class AuditService {
  private readonly db: Kysely<Database>;
  private readonly jobs: JobQueue;
  private readonly clock: Clock;

  constructor(db: Kysely<Database>, jobs: JobQueue, clock: Clock) {
    this.db = db;
    this.jobs = jobs;
    this.clock = clock;
  }

  async record(e: AuditEntry, db: Kysely<Database> = this.db): Promise<string> {
    const id = randomUUID();
    const write = async (trx: Kysely<Database>) => {
      await trx
        .insertInto('audit_log')
        .values({ id, guild_id: e.guildId, actor_id: e.actorId, action: e.action, target: e.target ?? null, payload_json: JSON.stringify(e.payload ?? {}), at: this.clock.now().toISOString() })
        .execute();
      await this.jobs.enqueue([{ type: 'audit.post', guildId: e.guildId, payload: { auditId: id } }], trx);
    };
    if (db === this.db) await this.db.transaction().execute(write);
    else await write(db);
    return id;
  }

  async get(id: string) {
    return this.db.selectFrom('audit_log').selectAll().where('id', '=', id).executeTakeFirst();
  }
}
