import { readFileSync } from 'node:fs';
import { Events } from 'discord.js';
import { sql } from 'kysely';
import { loadConfig } from './app/config.ts';
import { startHttpServer } from './app/http.ts';
import { createLogger } from './app/logger.ts';
import { Scheduler } from './app/scheduler.ts';
import { systemClock } from './core/clock.ts';
import { Detector } from './core/detector.ts';
import { Dispatcher } from './core/dispatcher.ts';
import { createMetrics } from './core/metrics.ts';
import { attachHandlers, buildCommands, createClient, resolveOwners, syncCommands } from './discord/bot.ts';
import type { BotContext } from './discord/context.ts';
import { DiscordSender } from './discord/sender.ts';
import { loadProviders } from './providers/registry.ts';
import { openDatabase } from './storage/db.ts';
import { Store } from './storage/store.ts';

const DISPATCH_INTERVAL_MS = 2_000;
const REFRESH_INTERVAL_MS = 24 * 3_600_000;
const PRUNE_INTERVAL_MS = 6 * 3_600_000;
const SHUTDOWN_DRAIN_MS = 10_000;

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

async function main() {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, config.LOG_FORMAT);
  log.info({ version }, 'starting TwitchAnnouncer');

  const db = await openDatabase(config.DATABASE_URL);
  const clock = systemClock;
  const store = new Store(db, clock);
  const metrics = createMetrics();
  const providers = loadProviders(config, log);
  for (const info of providers.catalog) {
    log.info({ provider: info.id, enabled: Boolean(providers.get(info.id)) }, 'provider loaded');
  }

  const client = createClient();
  const sender = new DiscordSender(client, log.child({ component: 'sender' }));
  const detector = new Detector({ store, metrics, log: log.child({ component: 'detector' }), clock, maxAgeMs: config.CATCHUP_MAX_AGE });
  const dispatcher = new Dispatcher({ store, sender, providers: providers.enabled, metrics, log: log.child({ component: 'dispatcher' }), clock });
  const scheduler = new Scheduler(log);
  let owners = new Set<string>(config.OWNER_IDS);

  const ctx: BotContext = {
    client,
    config,
    store,
    providers,
    detector,
    sender,
    metrics,
    log,
    version,
    startedAt: new Date(),
    kickDispatcher: () => scheduler.trigger('dispatch'),
    isOwner: (id) => owners.has(id),
  };
  const commands = buildCommands(providers.catalog);
  attachHandlers(ctx, commands);

  const http = await startHttpServer({
    port: config.HTTP_PORT,
    metrics,
    log,
    isHealthy: async () => {
      const dbOk = await sql`select 1`.execute(db).then(() => true, () => false);
      const gatewayOk = client.isReady();
      return { ok: dbOk && gatewayOk, detail: { db: dbOk, gateway: gatewayOk } };
    },
  });

  client.once(Events.ClientReady, async (ready) => {
    log.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, 'connected to Discord');
    try {
      owners = await resolveOwners(ready, config.OWNER_IDS);
      await syncCommands(ready, commands, store, log);
      for (const guild of ready.guilds.cache.values()) await store.ensureGuild(guild.id);
    } catch (err) {
      log.error({ err }, 'startup tasks failed');
    }

    for (const provider of providers.enabled) {
      scheduler.every(`poll:${provider.id}`, provider.pollIntervalMs, () => detector.pollProvider(provider));
      scheduler.every(
        `refresh:${provider.id}`,
        REFRESH_INTERVAL_MS,
        async () => {
          const sources = await store.activeSources(provider.id);
          if (sources.length) await store.updateSourceDisplay(await provider.refresh(sources));
          log.info({ provider: provider.id, sources: sources.length }, 'display data refreshed');
        },
        { initialDelayMs: 60_000 },
      );
    }
    scheduler.every('dispatch', DISPATCH_INTERVAL_MS, () => dispatcher.drainOnce());
    scheduler.every('prune', PRUNE_INTERVAL_MS, async () => log.info(await store.prune(), 'pruned old records'), {
      initialDelayMs: 5 * 60_000,
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    await scheduler.stop(SHUTDOWN_DRAIN_MS);
    try {
      while (Date.now() < deadline && client.isReady() && (await dispatcher.drainOnce()) > 0) {
      }
    } catch (err) {
      log.warn({ err }, 'outbox drain interrupted');
    }
    await client.destroy();
    http.close();
    await db.destroy();
    log.info('bye');
    log.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(config.DISCORD_TOKEN);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
