import type { Kysely } from 'kysely';
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';

const migrations: Record<string, Migration> = {
  '0001_initial': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('guild')
        .addColumn('guild_id', 'text', (c) => c.primaryKey())
        .addColumn('log_channel_id', 'text')
        .addColumn('settings', 'text', (c) => c.notNull().defaultTo('{}'))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('left_at', 'text')
        .execute();

      await db.schema
        .createTable('guild_channel')
        .addColumn('guild_id', 'text', (c) => c.notNull().references('guild.guild_id').onDelete('cascade'))
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('channel_id', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('guild_channel_pk', ['guild_id', 'provider'])
        .execute();

      await db.schema
        .createTable('source')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('external_id', 'text', (c) => c.notNull())
        .addColumn('display_name', 'text', (c) => c.notNull())
        .addColumn('handle', 'text', (c) => c.notNull())
        .addColumn('avatar_url', 'text')
        .addColumn('url', 'text', (c) => c.notNull())
        .addColumn('last_polled_at', 'text')
        .addColumn('last_error', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addUniqueConstraint('source_provider_external_uq', ['provider', 'external_id'])
        .execute();

      await db.schema
        .createTable('subscription')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('guild_id', 'text', (c) => c.notNull().references('guild.guild_id').onDelete('cascade'))
        .addColumn('source_id', 'text', (c) => c.notNull().references('source.id').onDelete('cascade'))
        .addColumn('channel_id', 'text')
        .addColumn('role_id', 'text')
        .addColumn('template', 'text')
        .addColumn('filters', 'text')
        .addColumn('state', 'text', (c) => c.notNull().defaultTo('active'))
        .addColumn('created_by', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addUniqueConstraint('subscription_guild_source_uq', ['guild_id', 'source_id'])
        .execute();
      await db.schema.createIndex('subscription_source_idx').on('subscription').column('source_id').execute();

      await db.schema
        .createTable('seen_item')
        .addColumn('source_id', 'text', (c) => c.notNull().references('source.id').onDelete('cascade'))
        .addColumn('item_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('first_seen_at', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('seen_item_pk', ['source_id', 'item_id'])
        .execute();
      await db.schema.createIndex('seen_item_first_seen_idx').on('seen_item').column('first_seen_at').execute();

      await db.schema
        .createTable('delivery')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('subscription_id', 'text', (c) =>
          c.notNull().references('subscription.id').onDelete('cascade'),
        )
        .addColumn('item_id', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('next_attempt_at', 'text', (c) => c.notNull())
        .addColumn('last_error', 'text')
        .addColumn('discord_message_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('sent_at', 'text')
        .addUniqueConstraint('delivery_subscription_item_uq', ['subscription_id', 'item_id'])
        .execute();
      await db.schema
        .createIndex('delivery_due_idx')
        .on('delivery')
        .columns(['status', 'next_attempt_at'])
        .execute();

      await db.schema
        .createTable('meta')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .execute();
    },
  },
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

export async function migrateToLatest(db: Kysely<any>): Promise<string[]> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
