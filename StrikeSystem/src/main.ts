import { readFileSync } from 'node:fs';
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  type GuildMember,
  Options,
  Partials,
  type PartialGuildMember,
  Team,
} from 'discord.js';
import { sql } from 'kysely';
import { backupDatabase } from './app/backup.ts';
import { loadConfig } from './app/config.ts';
import { startHttpServer } from './app/http.ts';
import { createLogger } from './app/logger.ts';
import { Scheduler } from './app/scheduler.ts';
import { buildServices } from './app/wiring.ts';
import { systemClock } from './core/clock.ts';
import type { BotContext } from './discord/context.ts';
import { confirmComponent } from './discord/confirm.ts';
import { Router } from './discord/router.ts';
import { syncCommands } from './discord/sync.ts';
import { MODULES } from './modules/index.ts';
import type { Module, ModuleEvents } from './modules/types.ts';
import { JobWorker, type RegisteredHandler } from './services/worker.ts';

const WORKER_INTERVAL_MS = 1_000;
const SHUTDOWN_DRAIN_MS = 10_000;
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

async function main() {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, config.LOG_FORMAT);
  log.info({ version }, 'starting StrikeSystem');

  const modules: Module[] = MODULES.map((m) => (m.id === 'core' ? { ...m, components: [...(m.components ?? []), confirmComponent] } : m));
  const clock = systemClock;
  const svc = await buildServices({ dbPath: config.dbPath, modules, clock, log });
  const db = svc.db.kysely;
  const recovered = await svc.jobs.recoverRunning();
  if (recovered) log.warn({ recovered }, 'requeued jobs interrupted by the last shutdown');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      GuildMemberManager: { maxSize: 200, keepOverLimit: (m) => m.id === m.client.user.id },
      MessageManager: 50,
      PresenceManager: 0,
      ReactionManager: 0,
      GuildEmojiManager: 0,
      GuildStickerManager: 0,
      VoiceStateManager: 0,
    }),
    sweepers: { ...Options.DefaultSweeperSettings, guildMembers: { interval: 3600, filter: () => (m) => m.id !== m.client.user.id } },
    presence: { activities: [{ name: 'over the server', type: ActivityType.Watching }] },
  });

  const scheduler = new Scheduler(log);
  const router = new Router(modules);
  const maintenanceRow = await db.selectFrom('meta').select('value').where('key', '=', 'maintenance').executeTakeFirst();

  const ctx: BotContext = {
    client,
    config,
    log,
    metrics: svc.metrics,
    clock,
    db,
    settings: svc.settings,
    cases: svc.cases,
    caseTypes: svc.caseTypes,
    jobs: svc.jobs,
    modules,
    version,
    startedAt: new Date(),
    owners: new Set(config.OWNER_IDS),
    kickWorker: () => scheduler.trigger('worker'),
    isModuleEnabled: svc.isModuleEnabled,
    maintenance: maintenanceRow ? JSON.parse(maintenanceRow.value) : { on: false, message: '' },
    commandList: () => router.allCommands(),
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
      })().catch((err) => log.error({ err, event, module: m.id, guildId }, 'event handler failed'));
    }
  };

  let accepting = true;
  client.on(Events.InteractionCreate, (i) => {
    if (!accepting) return;
    void router.handle(i, ctx);
  });
  client.on(Events.GuildMemberAdd, (m: GuildMember) => dispatch('memberAdd', m.guild.id, (fn) => fn(m, ctx)));
  client.on(Events.GuildMemberRemove, (m: GuildMember | PartialGuildMember) => dispatch('memberRemove', m.guild.id, (fn) => fn(m, ctx)));
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => dispatch('auditLog', guild.id, (fn) => fn(entry, guild, ctx)));
  client.on(Events.ThreadDelete, (t) => dispatch('threadDelete', t.guildId, (fn) => fn(t, ctx)));
  client.on(Events.MessageCreate, (msg) => {
    if (msg.author.bot || msg.inGuild()) return;
    dispatch('directMessage', null, (fn) => fn(msg, ctx));
  });

  const joined = async (guildId: string) => {
    await db
      .insertInto('guild')
      .values({ guild_id: guildId, joined_at: clock.now().toISOString(), left_at: null })
      .onConflict((oc) => oc.column('guild_id').doUpdateSet({ left_at: null }))
      .execute();
    await svc.jobs.cancel(`purge:${guildId}`);
  };
  client.on(Events.GuildCreate, (g) => void joined(g.id).catch((err) => log.error({ err }, 'guild join bookkeeping failed')));
  client.on(Events.GuildDelete, (g) => {
    void (async () => {
      await db.updateTable('guild').set({ left_at: clock.now().toISOString() }).where('guild_id', '=', g.id).execute();
      await svc.jobs.enqueue([{ type: 'guild.purge', guildId: g.id, payload: {}, runAt: new Date(Date.now() + config.GUILD_DATA_GRACE), dedupeKey: `purge:${g.id}` }]);
      log.info({ guildId: g.id }, 'left guild; data deletion scheduled');
    })().catch((err) => log.error({ err }, 'guild leave bookkeeping failed'));
  });

  const http = await startHttpServer({
    port: config.HTTP_PORT,
    metrics: svc.metrics,
    log,
    ready: async () => ({
      gateway: client.isReady(),
      db: await sql`select 1`.execute(db).then(() => true, () => false),
    }),
  });

  client.once(Events.ClientReady, async (ready) => {
    log.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, 'connected to Discord');
    try {
      if (!config.OWNER_IDS.length) {
        const app = await ready.application.fetch();
        ctx.owners = new Set(app.owner instanceof Team ? app.owner.members.map((m) => m.id) : app.owner ? [app.owner.id] : []);
      }
      await syncCommands(ready, router.allCommands().map((c) => c.spec.data), db, config.DEV_GUILD_ID, log);
      for (const g of ready.guilds.cache.values()) await joined(g.id);
    } catch (err) {
      log.error({ err }, 'startup tasks failed');
    }
    dispatch('ready', null, (fn) => fn(ctx));

    scheduler.every('worker', WORKER_INTERVAL_MS, () => worker.drainOnce());
    for (const m of modules) {
      for (const p of m.periodic ?? []) scheduler.every(`${m.id}:${p.name}`, p.intervalMs, () => p.run(ctx), { initialDelayMs: p.initialDelayMs ?? 5_000 });
    }
    scheduler.every('backup', config.BACKUP_INTERVAL, () => backupDatabase(svc.db.sqlite, config.backupDir, config.BACKUP_KEEP, log), { initialDelayMs: 60_000 });
    scheduler.every('gateway-ping', 30_000, async () => svc.metrics.set('strikes_gateway_ping_ms', client.ws.ping));
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    accepting = false;
    log.info({ signal }, 'shutting down');
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    await scheduler.stop(SHUTDOWN_DRAIN_MS);
    try {
      while (Date.now() < deadline && client.isReady() && (await worker.drainOnce()) > 0) {
      }
    } catch (err) {
      log.warn({ err }, 'job drain interrupted');
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
