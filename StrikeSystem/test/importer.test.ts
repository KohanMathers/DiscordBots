import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { botIdFromToken, importLegacy } from '../src/tools/legacy.ts';
import { services } from './helpers.ts';

const GA = '1100000000000000001';
const GB = '1100000000000000002';
const LOG = '1200000000000000001';
const ROLE = '1300000000000000001';

function legacyFixture(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'legacy-')), 'moderation.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE server_settings(guild_id INTEGER PRIMARY KEY, max_strikes INTEGER DEFAULT 3, log_channel_id INTEGER, mute_role_id INTEGER, allowed_roles TEXT);
    CREATE TABLE strikes(id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id INTEGER, user_id INTEGER, moderator_id INTEGER, reason TEXT NULL, timestamp TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE warnings(id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id, user_id, moderator_id, reason TEXT NULL, timestamp TEXT);
    CREATE TABLE mutes(guild_id, user_id, unmute_time TEXT, reason TEXT, PRIMARY KEY(guild_id,user_id));
    CREATE TABLE strike_tracking(guild_id INTEGER PRIMARY KEY, message_id INTEGER);
    CREATE TABLE dm_subscriptions(guild_id INTEGER PRIMARY KEY, subscribed INTEGER DEFAULT 0);
    CREATE TABLE ban_on_join(guild_id, user_id, reason TEXT NULL, moderator_id, timestamp TEXT, PRIMARY KEY(guild_id,user_id));
  `);
  db.prepare('INSERT INTO server_settings VALUES (?, 3, ?, 0, ?)').run(BigInt(GA), BigInt(LOG), `[${ROLE}]`);
  db.prepare('INSERT INTO server_settings VALUES (?, 0, 0, 0, ?)').run(BigInt(GB), '[]');
  const s = db.prepare('INSERT INTO strikes (guild_id,user_id,moderator_id,reason,timestamp,active) VALUES (?,?,?,?,?,?)');
  s.run(BigInt(GA), 1400000000000000001n, 1500000000000000001n, 'naive', '2025-08-26T00:18:02.689307', 1);
  s.run(BigInt(GA), 1400000000000000001n, 1500000000000000001n, 'offset', '2025-08-27T00:00:00.000000+00:00', 1);
  s.run(BigInt(GA), 1400000000000000001n, 1500000000000000001n, 'zulu', '2025-08-28T00:00:00Z', 0);
  s.run(BigInt(GA), 1400000000000000002n, 1500000000000000001n, null, '2025-08-25T10:00:00', 1);
  s.run(BigInt(GA), null, 1500000000000000001n, 'no user', '2025-08-25T10:00:00', 1);
  s.run(BigInt(GB), 1400000000000000003n, 1500000000000000001n, 'bad ts', 'not a date', 1);
  db.prepare('INSERT INTO warnings (guild_id,user_id,moderator_id,reason,timestamp) VALUES (?,?,?,?,?)').run(BigInt(GA), 1400000000000000001n, 1500000000000000001n, 'warned', '2025-08-26T12:00:00');
  db.prepare('INSERT INTO mutes VALUES (?,?,?,?)').run(BigInt(GA), 1400000000000000002n, '2025-09-01T00:00:00', 'muted');
  db.prepare('INSERT INTO ban_on_join VALUES (?,?,?,?,?)').run(BigInt(GA), 1600000000000000001n, 'raider', 1500000000000000001n, '2025-08-20T00:00:00.123456');
  db.prepare('INSERT INTO dm_subscriptions VALUES (?, 1)').run(BigInt(GA));
  db.close();
  return path;
}

describe('legacy importer', () => {
  it('imports everything with exact snowflakes, and re-running changes nothing', async () => {
    const svc = await services();
    const legacyPath = legacyFixture();
    const run = () => importLegacy({ legacyPath, db: svc.db.kysely, cases: svc.cases, settings: svc.settings, botId: '999000000000000000', now: svc.clock.now(), dryRun: false });

    const first = await run();
    const a = first.guilds.find((g) => g.guildId === GA)!;
    expect(a).toMatchObject({ strikes: 3, strikesRevoked: 1, warnings: 1, mutes: 1, watchlist: 1 });
    expect(first.anomalies.some((x) => x.includes('no user ID'))).toBe(true);
    expect(first.anomalies.some((x) => x.includes('not a date'))).toBe(true);
    expect(first.anomalies.some((x) => x.includes('clamped to 1'))).toBe(true);

    const s = await svc.settings.get(GA);
    expect(s.logChannel).toBe(LOG);
    expect(s.get('log.tracker_channel')).toBe(LOG);
    expect(s.get('perms.mod_roles')).toEqual([ROLE]);
    expect(s.get('modmail.enabled')).toBe(true);
    expect(s.get('modmail.channel')).toBe(LOG);
    expect((await svc.settings.get(GB)).maxStrikes).toBe(1);

    const { cases } = await svc.cases.list(GA, { limit: 50 });
    const byNumber = [...cases].sort((x, y) => x.number - y.number);
    expect(byNumber.map((c) => c.createdAt)).toEqual([...byNumber.map((c) => c.createdAt)].sort());
    const naive = cases.find((c) => c.reason === 'naive')!;
    expect(naive.createdAt).toBe('2025-08-26T00:18:02.689Z');
    expect(naive.targetId).toBe('1400000000000000001');
    expect(naive.metadata.legacy).toEqual({ table: 'strikes', id: 1 });
    const revoked = cases.find((c) => c.reason === 'zulu')!;
    expect(revoked.status).toBe('REVOKED');
    expect(revoked.revokedBy).toBe('999000000000000000');
    expect(cases.find((c) => c.type === 'TIMEOUT')?.status).toBe('EXPIRED');
    expect(await svc.cases.activeStrikeCount(GA, '1400000000000000001')).toBe(2);

    const wl = await svc.db.kysely.selectFrom('watchlist').selectAll().execute();
    expect(wl).toHaveLength(1);
    expect(wl[0]).toMatchObject({ user_id: '1600000000000000001', action: 'ban', created_at: '2025-08-20T00:00:00.123Z' });

    expect(await svc.db.kysely.selectFrom('jobs').selectAll().execute()).toHaveLength(0);

    const total = (await svc.cases.list(GA, { limit: 50 })).total;
    const second = await run();
    expect((await svc.cases.list(GA, { limit: 50 })).total).toBe(total);
    expect(second.guilds.find((g) => g.guildId === GA)!.skippedExisting).toBe(7);
  });

  it('dry run writes nothing', async () => {
    const svc = await services();
    const r = await importLegacy({ legacyPath: legacyFixture(), db: svc.db.kysely, cases: svc.cases, settings: svc.settings, botId: '0', now: svc.clock.now(), dryRun: true });
    expect(r.guilds.find((g) => g.guildId === GA)?.strikes).toBe(3);
    expect((await svc.cases.list(GA, { limit: 5 })).total).toBe(0);
  });

  it('reads the bot ID from a token', () => {
    const id = '123456789012345678';
    expect(botIdFromToken(`${Buffer.from(id).toString('base64')}.xxx.yyy`)).toBe(id);
    expect(botIdFromToken('garbage')).toBeNull();
  });
});
