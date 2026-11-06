import type { Client } from 'discord.js';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Config } from '../app/config.ts';
import type { CaseTypeRegistry } from '../core/cases.ts';
import type { Clock } from '../core/clock.ts';
import type { Metrics } from '../core/metrics.ts';
import type { CommandSpec, Module } from '../modules/types.ts';
import type { CaseService } from '../services/cases.ts';
import type { JobQueue } from '../services/jobs.ts';
import type { SettingsService } from '../services/settings.ts';
import type { Database } from '../storage/schema.ts';

export interface BotContext {
  client: Client;
  config: Config;
  log: Logger;
  metrics: Metrics;
  clock: Clock;
  db: Kysely<Database>;
  settings: SettingsService;
  cases: CaseService;
  caseTypes: CaseTypeRegistry;
  jobs: JobQueue;
  modules: Module[];
  version: string;
  startedAt: Date;
  owners: Set<string>;
  kickWorker(): void;
  isModuleEnabled(guildId: string, moduleId: string): Promise<boolean>;
  maintenance: { on: boolean; message: string };
  commandList(): Array<{ spec: CommandSpec; module: Module }>;
}
