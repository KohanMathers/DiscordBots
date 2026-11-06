import { type Kysely, sql } from 'kysely';
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';

export const coreMigrations: Record<string, Migration> = {
  '0001_core': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('guild')
        .addColumn('guild_id', 'text', (c) => c.primaryKey())
        .addColumn('joined_at', 'text', (c) => c.notNull())
        .addColumn('left_at', 'text')
        .execute();

      await db.schema
        .createTable('guild_settings')
        .addColumn('guild_id', 'text', (c) => c.primaryKey())
        .addColumn('data', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('cases')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('guild_id', 'text', (c) => c.notNull())
        .addColumn('number', 'integer', (c) => c.notNull())
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('target_id', 'text')
        .addColumn('actor_id', 'text', (c) => c.notNull())
        .addColumn('reason', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text')
        .addColumn('duration_s', 'integer')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('revoked_by', 'text')
        .addColumn('revoked_at', 'text')
        .addColumn('revoke_reason', 'text')
        .addColumn('parent_case', 'text')
        .addColumn('evidence', 'text', (c) => c.notNull().defaultTo('[]'))
        .addColumn('dm_status', 'text', (c) => c.notNull())
        .addColumn('log_message_id', 'text')
        .addColumn('metadata', 'text', (c) => c.notNull().defaultTo('{}'))
        .addColumn('legacy_ref', 'text')
        .execute();
      await db.schema.createIndex('cases_guild_number_uq').unique().on('cases').columns(['guild_id', 'number']).execute();
      await db.schema.createIndex('cases_guild_target_status').on('cases').columns(['guild_id', 'target_id', 'status']).execute();
      await db.schema.createIndex('cases_expiry').on('cases').columns(['status', 'expires_at']).execute();
      await db.schema.createIndex('cases_legacy_uq').unique().on('cases').columns(['guild_id', 'legacy_ref']).execute();

      await db.schema
        .createTable('escalation_marker')
        .addColumn('guild_id', 'text', (c) => c.notNull())
        .addColumn('user_id', 'text', (c) => c.notNull())
        .addColumn('at', 'integer', (c) => c.notNull())
        .addColumn('case_id', 'text', (c) => c.notNull())
        .addColumn('fired_at', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('escalation_marker_pk', ['guild_id', 'user_id', 'at'])
        .execute();

      await db.schema
        .createTable('jobs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('guild_id', 'text')
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('run_at', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('max_attempts', 'integer', (c) => c.notNull().defaultTo(5))
        .addColumn('last_error', 'text')
        .addColumn('dedupe_key', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('finished_at', 'text')
        .execute();
      await db.schema.createIndex('jobs_due').on('jobs').columns(['status', 'run_at']).execute();
      await sql`CREATE UNIQUE INDEX jobs_dedupe_pending ON jobs (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL`.execute(db);

      await db.schema
        .createTable('meta')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .execute();
    },
  },
};

export async function migrateToLatest(db: Kysely<any>, extra: Record<string, Migration>): Promise<string[]> {
  const all = { ...coreMigrations, ...extra };
  const provider: MigrationProvider = { getMigrations: async () => all };
  const { error, results } = await new Migrator({ db, provider }).migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
