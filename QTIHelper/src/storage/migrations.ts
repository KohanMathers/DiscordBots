import { type Kysely, sql } from 'kysely';
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';

export const guildFk = (c: any) => c.notNull().references('guild.guild_id').onDelete('cascade');

export const coreMigrations: Record<string, Migration> = {
  '0001_core': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('guild')
        .addColumn('guild_id', 'text', (c) => c.primaryKey())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('left_at', 'text')
        .execute();
      await db.schema
        .createTable('guild_setting')
        .addColumn('guild_id', 'text', guildFk)
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('value_json', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('guild_setting_pk', ['guild_id', 'key'])
        .execute();
      await db.schema
        .createTable('audit_log')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('guild_id', 'text', guildFk)
        .addColumn('actor_id', 'text', (c) => c.notNull())
        .addColumn('action', 'text', (c) => c.notNull())
        .addColumn('target', 'text')
        .addColumn('payload_json', 'text', (c) => c.notNull())
        .addColumn('at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('audit_log_guild_at').on('audit_log').columns(['guild_id', 'at']).execute();
      await db.schema
        .createTable('member_join')
        .addColumn('guild_id', 'text', guildFk)
        .addColumn('user_id', 'text', (c) => c.notNull())
        .addColumn('joined_at', 'text', (c) => c.notNull())
        .addColumn('is_bot', 'integer', (c) => c.notNull())
        .addPrimaryKeyConstraint('member_join_pk', ['guild_id', 'user_id'])
        .execute();
      await db.schema.createIndex('member_join_order').on('member_join').columns(['guild_id', 'is_bot', 'joined_at', 'user_id']).execute();
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

export async function migrateToLatest(db: Kysely<any>, extra: Record<string, Migration>): Promise<void> {
  const all = { ...coreMigrations, ...extra };
  const provider: MigrationProvider = { getMigrations: async () => all };
  const { error } = await new Migrator({ db, provider }).migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
}
