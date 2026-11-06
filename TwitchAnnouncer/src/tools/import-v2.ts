import SqliteDatabase from 'better-sqlite3';
import { loadConfig } from '../app/config.ts';
import { createLogger } from '../app/logger.ts';
import { systemClock } from '../core/clock.ts';
import type { SourceRef } from '../core/types.ts';
import { loadProviders } from '../providers/registry.ts';
import { TwitchProvider } from '../providers/twitch/provider.ts';
import { openDatabase } from '../storage/db.ts';
import { Store } from '../storage/store.ts';

interface V2Guild {
  guildID: string;
  primaryID: string | null;
  announced: string | null;
}

const TWITCH_ITEM = /^\d+$/;
const YOUTUBE_ITEM = /^[A-Za-z0-9_-]{11}$/;

function parseList<T>(json: string | null | undefined): T[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!file) {
    console.error('usage: pnpm import-v2 <v2.db> [--dry-run]');
    process.exit(2);
  }

  const config = loadConfig({ DISCORD_TOKEN: 'unused', ...process.env });
  const log = createLogger(config.LOG_LEVEL, config.LOG_FORMAT);
  const providers = loadProviders(config, log);
  const twitch = providers.get('twitch');
  const youtube = providers.get('youtube');

  const old = new SqliteDatabase(file, { readonly: true, fileMustExist: true });
  const guilds = old.prepare('SELECT "guildID", "primaryID", "announced" FROM "guildInfo"').all() as V2Guild[];
  const byGroup = <T>(table: string, cols: string) =>
    new Map(
      (old.prepare(`SELECT "primaryID", ${cols} FROM "${table}"`).all() as Array<Record<string, string | null>>).map((r) => [
        String(r.primaryID),
        r as T,
      ]),
    );
  const channels = byGroup<{ twitch: string | null; youtube: string | null }>('announcementChannels', '"twitch", "youtube"');
  const twitchLists = byGroup<{ registered: string | null }>('registeredUsers', '"registered"');
  const youtubeLists = byGroup<{ registered: string | null }>('registeredYoutubes', '"registered"');

  const report = { guilds: 0, guildsWithoutGroup: 0, subscriptions: 0, seeded: 0, skipped: [] as string[] };

  const allLogins = new Set<string>();
  const allHandles = new Set<string>();
  for (const g of guilds) {
    if (!g.primaryID) continue;
    for (const u of parseList<{ username?: string }>(twitchLists.get(g.primaryID)?.registered)) {
      if (u.username) allLogins.add(u.username.toLowerCase());
    }
    for (const y of parseList<{ handle?: string }>(youtubeLists.get(g.primaryID)?.registered)) {
      if (y.handle) allHandles.add(y.handle.toLowerCase());
    }
  }

  const twitchRefs = new Map<string, SourceRef>();
  if (allLogins.size) {
    if (twitch instanceof TwitchProvider) {
      for (const [login, ref] of await twitch.resolveLogins([...allLogins])) twitchRefs.set(login, ref);
      for (const l of allLogins) if (!twitchRefs.has(l)) report.skipped.push(`twitch login "${l}": no longer exists`);
    } else {
      report.skipped.push(`${allLogins.size} Twitch logins: Twitch is not configured`);
    }
  }
  const youtubeRefs = new Map<string, SourceRef>();
  if (allHandles.size) {
    if (youtube) {
      for (const h of allHandles) {
        const r = await youtube.resolve(h);
        if (r.ok) youtubeRefs.set(h, r.source);
        else report.skipped.push(`youtube handle "${h}": ${r.reason}`);
      }
    } else {
      report.skipped.push(`${allHandles.size} YouTube handles: YouTube is not configured`);
    }
  }

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, guilds: guilds.length, twitch: twitchRefs.size, youtube: youtubeRefs.size, skipped: report.skipped }, null, 2));
    return;
  }

  const db = await openDatabase(config.DATABASE_URL);
  const store = new Store(db, systemClock);

  for (const g of guilds) {
    if (!g.primaryID) {
      report.guildsWithoutGroup++;
      continue;
    }
    report.guilds++;
    await store.ensureGuild(g.guildID);
    const ch = channels.get(g.primaryID);
    if (ch?.twitch) await store.setDefaultChannel(g.guildID, 'twitch', String(ch.twitch));
    if (ch?.youtube) await store.setDefaultChannel(g.guildID, 'youtube', String(ch.youtube));

    const refs: SourceRef[] = [
      ...parseList<{ username?: string }>(twitchLists.get(g.primaryID)?.registered).map((u) => twitchRefs.get(u.username?.toLowerCase() ?? '')),
      ...parseList<{ handle?: string }>(youtubeLists.get(g.primaryID)?.registered).map((y) => youtubeRefs.get(y.handle?.toLowerCase() ?? '')),
    ].filter((r): r is SourceRef => Boolean(r));

    const announced = parseList<string>(g.announced).map(String);
    for (const ref of refs) {
      const source = await store.upsertSource(ref);
      const sub = await store.upsertSubscription({
        guildId: g.guildID,
        sourceId: source.id,
        channelId: null,
        roleId: null,
        filters: null,
        createdBy: 'import-v2',
      });
      if (sub.created) report.subscriptions++;
      const shape = ref.provider === 'twitch' ? TWITCH_ITEM : YOUTUBE_ITEM;
      for (const id of announced) {
        if (!shape.test(id)) continue;
        await store.seedSentDelivery(sub.id, id);
        report.seeded++;
      }
    }
  }

  old.close();
  await db.destroy();
  console.log(
    [
      'Import finished.',
      `  guilds imported:          ${report.guilds}`,
      `  guilds with no group:     ${report.guildsWithoutGroup} (they had nothing to import)`,
      `  subscriptions created:    ${report.subscriptions}`,
      `  announced IDs seeded:     ${report.seeded}`,
      `  skipped:                  ${report.skipped.length}`,
      ...report.skipped.map((s) => `    - ${s}`),
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
