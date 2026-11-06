import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { Migration } from 'kysely/migration';
import { migrateToLatest } from './migrations.ts';
import type { Database } from './schema.ts';

export interface Db {
  kysely: Kysely<Database>;
  sqlite: SqliteDatabase.Database;
}

export async function openDatabase(path: string, migrations: Record<string, Migration> = {}): Promise<Db> {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new SqliteDatabase(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  const kysely = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  await migrateToLatest(kysely, migrations);
  return { kysely, sqlite };
}
