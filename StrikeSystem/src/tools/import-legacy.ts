import SqliteDatabase from 'better-sqlite3';
import { REST, Routes } from 'discord.js';
import { createLogger } from '../app/logger.ts';
import { buildServices } from '../app/wiring.ts';
import { systemClock } from '../core/clock.ts';
import { MODULES } from '../modules/index.ts';
import { botIdFromToken, importLegacy } from './legacy.ts';
import { join } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const legacyPath = arg('--sqlite');
  const dryRun = process.argv.includes('--dry-run');
  if (!legacyPath) {
    console.error('usage: pnpm import-legacy --sqlite <moderation.db> [--dry-run] [--convert-boj] [--delete-old-tracker]');
    process.exit(2);
  }
  const log = createLogger(process.env.LOG_LEVEL ?? 'warn', 'text');
  const token = process.env.DISCORD_TOKEN;
  const botId = botIdFromToken(token) ?? '0';
  const dbPath = join(process.env.DATA_DIR ?? 'data', 'strikes.db');
  const svc = await buildServices({ dbPath, modules: MODULES, clock: systemClock, log });

  const report = await importLegacy({ legacyPath, db: svc.db.kysely, cases: svc.cases, settings: svc.settings, botId, now: new Date(), dryRun });

  console.log(dryRun ? '\nDRY RUN: nothing was written.\n' : '\nImport finished.\n');
  console.log('guild                 settings  strikes  revoked  warnings  mutes  watchlist  already-imported');
  for (const g of report.guilds) {
    console.log(
      `${g.guildId.padEnd(22)}${(g.settings ? 'yes' : '-').padEnd(10)}${String(g.strikes).padEnd(9)}${String(g.strikesRevoked).padEnd(9)}${String(g.warnings).padEnd(10)}${String(g.mutes).padEnd(7)}${String(g.watchlist).padEnd(11)}${g.skippedExisting}`,
    );
  }
  console.log(`\n${report.anomalies.length} anomal${report.anomalies.length === 1 ? 'y' : 'ies'}`);
  for (const a of report.anomalies) console.log(`  - ${a}`);
  if (botId === '0') console.log('\nNote: DISCORD_TOKEN not set, so revoked strikes are attributed to user 0 instead of the bot.');

  if (!dryRun && token && (process.argv.includes('--convert-boj') || process.argv.includes('--delete-old-tracker'))) {
    const rest = new REST().setToken(token);
    if (process.argv.includes('--convert-boj')) {
      const entries = await svc.db.kysely.selectFrom('watchlist').selectAll().where('action', '=', 'ban').where('legacy_ref', 'is not', null).execute();
      let banned = 0;
      for (const e of entries) {
        try {
          await rest.put(Routes.guildBan(e.guild_id, e.user_id), { body: { delete_message_seconds: 0 }, reason: `Converted ban-on-join: ${e.reason ?? 'no reason'}`.slice(0, 512) });
          await svc.cases.create({ guildId: e.guild_id, type: 'BAN', targetId: e.user_id, actorId: e.actor_id, reason: e.reason, metadata: { preemptive: true, convertedFromBanOnJoin: true } });
          await svc.db.kysely.deleteFrom('watchlist').where('guild_id', '=', e.guild_id).where('user_id', '=', e.user_id).execute();
          banned++;
        } catch (err) {
          console.log(`  could not ban ${e.user_id} in ${e.guild_id}: ${(err as Error).message}`);
        }
      }
      console.log(`\nConverted ${banned}/${entries.length} ban-on-join entries into pre-emptive bans. Their log entries post when the bot starts.`);
    }
    if (process.argv.includes('--delete-old-tracker')) {
      const legacy = new SqliteDatabase(legacyPath, { readonly: true });
      legacy.defaultSafeIntegers(true);
      const trackers = legacy.prepare('SELECT t.guild_id, t.message_id, s.log_channel_id FROM strike_tracking t LEFT JOIN server_settings s ON s.guild_id = t.guild_id').all() as Array<Record<string, bigint | null>>;
      legacy.close();
      for (const t of trackers) {
        if (!t.log_channel_id || !t.message_id) continue;
        await rest.delete(Routes.channelMessage(String(t.log_channel_id), String(t.message_id))).then(
          () => console.log(`  deleted old tracker in guild ${t.guild_id}`),
          () => console.log(`  old tracker in guild ${t.guild_id} not found`),
        );
      }
    }
  }
  await svc.db.kysely.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
