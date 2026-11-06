import type { Logger } from 'pino';
import { CaseTypeRegistry } from '../core/cases.ts';
import type { Clock } from '../core/clock.ts';
import { createMetrics } from '../core/metrics.ts';
import { SettingsRegistry } from '../core/settings.ts';
import type { Module } from '../modules/types.ts';
import { CaseService } from '../services/cases.ts';
import { JobQueue } from '../services/jobs.ts';
import { SettingsService } from '../services/settings.ts';
import { openDatabase } from '../storage/db.ts';

export async function buildServices(opts: { dbPath: string; modules: Module[]; clock: Clock; log: Logger }) {
  const migrations = Object.assign({}, ...opts.modules.map((m) => m.migrations ?? {}));
  const db = await openDatabase(opts.dbPath, migrations);
  const caseTypes = new CaseTypeRegistry(opts.modules.flatMap((m) => m.caseTypes ?? []));
  const registry = new SettingsRegistry(opts.modules.flatMap((m) => m.settings ?? []));
  const jobs = new JobQueue(db.kysely, opts.clock);
  const settings = new SettingsService(db.kysely, registry, opts.clock);
  const cases = new CaseService({ db: db.kysely, jobs, clock: opts.clock, types: caseTypes });
  for (const m of opts.modules) for (const hook of m.caseHooks ?? []) cases.addHook(hook);
  const metrics = createMetrics();

  const isModuleEnabled = async (guildId: string, moduleId: string) => {
    const m = opts.modules.find((x) => x.id === moduleId);
    if (!m || m.required) return true;
    return !(await settings.get(guildId)).get<string[]>('modules.disabled').includes(moduleId);
  };

  return { db, caseTypes, registry, jobs, settings, cases, metrics, isModuleEnabled };
}
