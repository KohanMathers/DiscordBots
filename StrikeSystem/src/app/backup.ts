import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

export async function backupDatabase(sqlite: Database.Database, dir: string, keep: number, log: Logger): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(dir, `strikes-${stamp}.db`);
  await sqlite.backup(path);
  const files = (await readdir(dir)).filter((f) => /^strikes-.*\.db$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) await rm(join(dir, old), { force: true });
  log.info({ path, kept: Math.min(files.length, keep) }, 'database backed up');
  return path;
}
