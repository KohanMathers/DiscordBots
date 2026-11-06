import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import SqliteDatabase from 'better-sqlite3';
import type { Database } from './schema.ts';
import { migrateToLatest } from './migrations.ts';

export async function openDatabase(url: string): Promise<Kysely<Database>> {
  let db: Kysely<Database>;
  if (url.startsWith('sqlite:')) {
    const path = url.slice('sqlite:'.length);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const sqlite = new SqliteDatabase(path);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  } else if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pg = await import('pg');
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new pg.default.Pool({ connectionString: url, max: 10 }) }),
    });
  } else {
    throw new Error('DATABASE_URL must start with sqlite: or postgres://');
  }
  await migrateToLatest(db);
  return db;
}
