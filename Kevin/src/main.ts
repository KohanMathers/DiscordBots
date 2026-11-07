import { readFileSync } from 'node:fs';
import { ActivityType, Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';
import { sql } from 'kysely';
import { loadConfig } from './app/config.ts';
import { startHttpServer } from './app/http.ts';
import { createLogger } from './app/logger.ts';
import { Scheduler } from './app/scheduler.ts';
import { buildServices, selectModules } from './app/wiring.ts';
import { systemClock } from './core/clock.ts';
import { loadFunContent } from './core/content.ts';
import type { BotContext } from './discord/context.ts';
import { Router } from './discord/router.ts';
import { syncCommands } from './discord/sync.ts';
import { setMessageOverrides } from './messages.ts';
import type { ModuleEvents } from './modules/types.ts';
import { JobWorker, type RegisteredHandler } from './services/worker.ts';
import { variant } from './variant.ts';

const WORKER_INTERVAL_MS = 1_000;
const SHUTDOWN_DRAIN_MS = 10_000;
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

async function main() {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, config.LOG_FORMAT);
  log.info({ version, variant: variant.name }, `starting ${variant.name}`);
  setMessageOverrides(variant.messages);

  const modules = selectModules(config.MODULES);
  const clock = systemClock;
  const svc = await buildServices({ dbPath: config.dbPath, modules, clock, log });
  const db = svc.db.kysely;
  const content = loadFunContent(new URL(`../${variant.contentDir}/`, import.meta.url).pathname);
  log.info({ modules: modules.map((m) => m.id), facts: content.facts.length }, 'modules loaded');
  if (await svc.jobs.recoverRunning()) log.warn('requeued jobs interrupted by the last shutdown');

  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers];
  const messageContent = config.ENABLE_MESSAGE_CONTENT || modules.some((m) => m.needsMessageContent);
  if (messageContent) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  const client = new Client({
    intents,
    partials: [Partials.GuildMember],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      GuildMemberManager: { maxSize: 500, keepOverLimit: (m) => m.id === m.client.user.id },
      MessageManager: 100,
      PresenceManager: 0,
      ReactionManager: 0,
      VoiceStateManager: 0,
    }),
    presence: { activities: [{ name: variant.presence.text, type: ActivityType[variant.presence.type] }] },
  });

  const scheduler = new Scheduler(log);
  const router = new Router(modules);
  const ctx: BotContext = {
    client,
    config,
    log,
    metrics: svc.metrics,
    clock,
    db,
    settings: svc.settings,
    guilds: svc.guilds,
    audit: svc.audit,
    jobs: svc.jobs,
    joinIndex: svc.joinIndex,
    locks: svc.locks,
    schedule: svc.schedule,
    autoresponses: svc.autoresponses,
    content,
    modules,
    version,
    startedAt: new Date(),
    kickWorker: () => scheduler.trigger('worker'),
    isModuleEnabled: svc.isModuleEnabled,
    commandList: () => router.all(),
    supportUrl: () => config.SUPPORT_URL ?? variant.links.support,
  };

  const handlers = new Map<string, RegisteredHandler>();
  for (const m of modules) {
    for (const [type, fn] of Object.entries(m.jobs ?? {})) {
      if (handlers.has(type)) throw new Error(`job type ${type} registered twice`);
      handlers.set(type, { moduleId: m.id, run: (job) => fn(job, ctx) });
    }
  }
  const worker = new JobWorker({ queue: svc.jobs, handlers, isEnabled: svc.isModuleEnabled, log: log.child({ component: 'worker' }), metrics: svc.metrics });

  const dispatch = <K extends keyof ModuleEvents>(event: K, guildId: string | null, call: (fn: NonNullable<ModuleEvents[K]>) => Promise<void>) => {
    for (const m of modules) {
      const fn = m.events?.[event];
      if (!fn) continue;
      void (async () => {
        if (guildId && !(await svc.isModuleEnabled(guildId, m.id))) return;
        await call(fn as NonNullable<ModuleEvents[K]>);
      })().catch((err) => log.error({ err, event, module: m.id, guild_id: guildId }, 'event handler failed'));
    }
  };

  let accepting = true;
  client.on(Events.InteractionCreate, (i) => {
    if (accepting) void router.handle(i, ctx);
  });
  client.on(Events.GuildMemberAdd, (m) => dispatch('memberAdd', m.guild.id, (fn) => fn(m, ctx)));
  client.on(Events.GuildMemberRemove, (m) => dispatch('memberRemove', m.guild.id, (fn) => fn(m, ctx)));
  client.on(Events.MessageCreate, (msg) => {
    if (msg.inGuild() && !msg.author.bot) dispatch('message', msg.guildId, (fn) => fn(msg, ctx));
  });
  client.on(Events.GuildCreate, (g) => {
    void svc.guilds.ensure(g.id).then(() => dispatch('guildJoin', g.id, (fn) => fn(g, ctx)));
  });
  client.on(Events.GuildDelete, (g) => {
    void svc.guilds.markLeft(g.id).catch((err) => log.error({ err }, 'guild leave bookkeeping failed'));
  });

  const http = config.port
    ? await startHttpServer({
        port: config.port,
        metrics: svc.metrics,
        log,
        health: async () => ({ gateway: client.isReady(), db: await sql`select 1`.execute(db).then(() => true, () => false) }),
      })
    : null;

  client.once(Events.ClientReady, async (ready) => {
    log.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, 'connected to Discord');
    try {
      await syncCommands(ready, router.all().map((c) => c.spec.data), db, config.DEV_GUILD_IDS, log);
      for (const g of ready.guilds.cache.values()) await svc.guilds.ensure(g.id);
    } catch (err) {
      log.error({ err }, 'startup tasks failed');
    }
    dispatch('ready', null, (fn) => fn(ctx));
    scheduler.every('worker', WORKER_INTERVAL_MS, () => worker.drainOnce());
    for (const m of modules) for (const p of m.periodic ?? []) scheduler.every(`${m.id}:${p.name}`, p.intervalMs, () => p.run(ctx), { initialDelayMs: p.initialDelayMs ?? 5_000 });
    scheduler.every('gateway-ping', 30_000, async () => svc.metrics.set('mm_gateway_ping_ms', client.ws.ping));
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    accepting = false;
    log.info({ signal }, 'shutting down');
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    await Promise.race([Promise.all([scheduler.stop(SHUTDOWN_DRAIN_MS), svc.schedule.stop()]), new Promise((r) => setTimeout(r, SHUTDOWN_DRAIN_MS))]);
    try {
      while (Date.now() < deadline && client.isReady() && (await worker.drainOnce()) > 0) {
      }
    } catch (err) {
      log.warn({ err }, 'job drain interrupted');
    }
    await client.destroy();
    http?.close();
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
