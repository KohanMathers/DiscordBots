import type { Logger } from 'pino';
import type { Clock } from '../core/clock.ts';
import { createMetrics } from '../core/metrics.ts';
import { CORE_SETTINGS, moduleToggle, SettingsRegistry } from '../core/settings.ts';
import { BUILT_IN_MODULES } from '../modules/index.ts';
import type { Module } from '../modules/types.ts';
import { AuditService } from '../services/audit.ts';
import { AutoResponseService } from '../services/autoresponses.ts';
import { GuildService } from '../services/guilds.ts';
import { JobQueue } from '../services/jobs.ts';
import { JoinIndex } from '../services/joinIndex.ts';
import { LockService } from '../services/locks.ts';
import { ScheduleService } from '../services/schedule.ts';
import { SettingsService } from '../services/settings.ts';
import { openDatabase } from '../storage/db.ts';
import { forkModules } from '../fork/index.ts';
import { variant } from '../variant.ts';

export function selectModules(only: string[] | null): Module[] {
  const ids = variant.modules.filter((id) => !only || only.includes(id) || BUILT_IN_MODULES[id]!.required);
  return [...ids.map((id) => BUILT_IN_MODULES[id]!), ...forkModules];
}

export async function buildServices(o: { dbPath: string; modules: Module[]; clock: Clock; log: Logger }) {
  const migrations = Object.assign({}, ...[...Object.values(BUILT_IN_MODULES), ...o.modules].map((m) => m.migrations ?? {}));
  const db = await openDatabase(o.dbPath, migrations);
  const registry = new SettingsRegistry([
    ...CORE_SETTINGS,
    ...o.modules.flatMap((m) => m.settings ?? []),
    ...o.modules.filter((m) => !m.required).map((m) => moduleToggle(m.id, m.name)),
  ]);
  const jobs = new JobQueue(db.kysely, o.clock);
  const audit = new AuditService(db.kysely, jobs, o.clock);
  const settings = new SettingsService(db.kysely, registry);
  const services = {
    db,
    jobs,
    audit,
    settings,
    metrics: createMetrics(),
    guilds: new GuildService(db.kysely, o.clock),
    joinIndex: new JoinIndex(db.kysely),
    locks: new LockService({ db: db.kysely, clock: o.clock, audit, jobs }),
    schedule: new ScheduleService({ db: db.kysely, clock: o.clock, audit, log: o.log.child({ component: 'scheduler' }) }),
    autoresponses: new AutoResponseService({ db: db.kysely, clock: o.clock, audit }),
    isModuleEnabled: async (guildId: string, moduleId: string) => {
      const m = o.modules.find((x) => x.id === moduleId);
      if (!m || m.required) return true;
      return (await settings.get(guildId)).get(`module.${moduleId}.enabled`) !== false;
    },
  };
  return services;
}
