import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import type { Config } from '../app/config.ts';
import type { Detector } from '../core/detector.ts';
import type { Metrics } from '../core/metrics.ts';
import type { Sender } from '../core/sender.ts';
import type { ProviderSet } from '../providers/registry.ts';
import type { Store } from '../storage/store.ts';

export interface BotContext {
  client: Client;
  config: Config;
  store: Store;
  providers: ProviderSet;
  detector: Detector;
  sender: Sender;
  metrics: Metrics;
  log: Logger;
  version: string;
  startedAt: Date;
  kickDispatcher(): void;
  isOwner(userId: string): boolean;
}
