import { describe, expect, it } from 'vitest';
import type { RoleFacts } from '../src/core/lock.ts';
import { LockService } from '../src/services/locks.ts';
import { runPurge } from '../src/services/purge.ts';
import { ScheduleService } from '../src/services/schedule.ts';
import { FakeChannel, FakeHistory, FakeScheduleHooks } from './fakes.ts';
import { CH, FakeClock, G, MOD, services, silentLog } from './helpers.ts';

const BOT = '900000000000000009';
const ROLE_MEMBER = '400000000000000001';
const ROLE_MUTED = '400000000000000002';
const ROLE_MOD = '400000000000000003';
const ROLE_HIGH = '400000000000000004';
const USER_ALLOWED = '500000000000000001';

function guildFacts(): { roles: Map<string, RoleFacts>; staff: Set<string> } {
  const roles = new Map<string, RoleFacts>([
    [G, { id: G, position: 0, staff: false }],
    [ROLE_MEMBER, { id: ROLE_MEMBER, position: 2, staff: false }],
    [ROLE_MUTED, { id: ROLE_MUTED, position: 3, staff: false }],
    [ROLE_MOD, { id: ROLE_MOD, position: 5, staff: true }],
    [ROLE_HIGH, { id: ROLE_HIGH, position: 20, staff: false }],
  ]);
  return { roles, staff: new Set() };
}

const realisticChannel = () =>
  new FakeChannel()
    .set(G, 'role', ['ViewChannel'], ['AddReactions'])
    .set(ROLE_MEMBER, 'role', ['SendMessages'], [])
    .set(ROLE_MUTED, 'role', [], ['SendMessages'])
    .set(ROLE_MOD, 'role', ['SendMessages', 'ManageMessages'], [])
    .set(ROLE_HIGH, 'role', ['SendMessages'], [])
    .set(USER_ALLOWED, 'member', ['SendMessages', 'SendMessagesInThreads'], []);

async function lockArgs(channel: FakeChannel) {
  const f = guildFacts();
  return { guildId: G, channelId: CH, actorId: MOD, reason: 'raid', expiresAt: null, port: channel, everyoneId: G, botId: BOT, botTopPosition: 10, roles: f.roles, staffMemberIds: f.staff };
}

describe('lock / unlock', () => {
  it('lock -> restart -> unlock restores every override exactly', async () => {
    const svc = await services();
    const ch = realisticChannel();
    const before = ch.snapshot();
    const r = await svc.locks.lock(await lockArgs(ch));
    expect(r.status).toBe('locked');
    expect(ch.map.get(G)!.deny.has('SendMessages')).toBe(true);
    expect(ch.map.get(ROLE_MEMBER)!.deny.has('SendMessages')).toBe(true);
    expect(ch.map.get(USER_ALLOWED)!.deny.has('SendMessages')).toBe(true);
    expect(ch.map.get(BOT)!.allow.has('SendMessages')).toBe(true);

    const fresh = new LockService({ db: svc.db.kysely, clock: svc.clock, audit: svc.audit, jobs: svc.jobs });
    expect((await fresh.unlock({ guildId: G, channelId: CH, actorId: MOD, botId: BOT, port: ch })).status).toBe('unlocked');
    expect(ch.snapshot()).toBe(before);
    expect(await fresh.isLocked(G, CH)).toBe(false);
  });

  it('never touches staff roles or roles at or above the bot', async () => {
    const svc = await services();
    const ch = realisticChannel();
    const r = await svc.locks.lock(await lockArgs(ch));
    expect(ch.map.get(ROLE_MOD)!.allow.has('SendMessages')).toBe(true);
    expect(ch.map.get(ROLE_HIGH)!.allow.has('SendMessages')).toBe(true);
    expect(r.status === 'locked' && r.plan.skipped.map((s) => s.reason).sort()).toEqual(['above-bot', 'staff']);
  });

  it('reports already-locked and not-locked', async () => {
    const svc = await services();
    const ch = realisticChannel();
    await svc.locks.lock(await lockArgs(ch));
    expect((await svc.locks.lock(await lockArgs(ch))).status).toBe('already');
    await svc.locks.unlock({ guildId: G, channelId: CH, actorId: MOD, botId: BOT, port: ch });
    expect((await svc.locks.unlock({ guildId: G, channelId: CH, actorId: MOD, botId: BOT, port: ch })).status).toBe('not-locked');
  });

  it('removes overrides it created, on a channel that had none', async () => {
    const svc = await services();
    const ch = new FakeChannel();
    await svc.locks.lock(await lockArgs(ch));
    expect(ch.map.size).toBe(2);
    await svc.locks.unlock({ guildId: G, channelId: CH, actorId: MOD, botId: BOT, port: ch });
    expect(ch.map.size).toBe(0);
  });

  it('rolls back and forgets the lock if Discord refuses midway', async () => {
    const svc = await services();
    const ch = realisticChannel();
    const before = ch.snapshot();
    ch.failAt = 2;
    await expect(svc.locks.lock(await lockArgs(ch))).rejects.toThrow(/Missing Permissions/);
    expect(ch.snapshot()).toBe(before);
    expect(await svc.locks.isLocked(G, CH)).toBe(false);
  });

  it('records lock and unlock in the audit log', async () => {
    const svc = await services();
    const ch = realisticChannel();
    await svc.locks.lock(await lockArgs(ch));
    await svc.locks.unlock({ guildId: G, channelId: CH, actorId: MOD, botId: BOT, port: ch });
    const rows = await svc.db.kysely.selectFrom('audit_log').select('action').execute();
    expect(rows.map((r) => r.action)).toEqual(['lock', 'unlock']);
  });
});

describe('purge', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const history = () =>
    new FakeHistory(
      [
        ...Array.from({ length: 1200 }, (_, n) => ({ id: `r${String(n).padStart(5, '0')}`, createdAt: now - (n + 1) * 60_000, authorId: n % 3 ? 'u1' : 'bot', authorBot: n % 3 === 0, content: n % 10 === 0 ? 'buy cheap stuff' : 'hi', pinned: n === 5 })),
        ...Array.from({ length: 50 }, (_, n) => ({ id: `old${n}`, createdAt: now - 15 * 86_400_000 - n * 60_000, authorId: 'u1', authorBot: false, content: 'old', pinned: false })),
      ],
      now,
    );

  it.each([1, 2, 100, 101, 1000])('deletes exactly %i messages', async (amount) => {
    const h = history();
    const r = await runPurge({ amount, filter: {}, port: h, nowMs: now });
    expect(r.deleted).toBe(amount);
    expect(h.bulkCalls.every((n) => n >= 2 && n <= 100)).toBe(true);
  });

  it('falls back to single deletes for 15-day-old messages', async () => {
    const onlyOld = new FakeHistory(Array.from({ length: 30 }, (_, n) => ({ id: `o${n}`, createdAt: now - 15 * 86_400_000 - n, authorId: 'u', authorBot: false, content: '', pinned: false })), now);
    const r = await runPurge({ amount: 30, filter: {}, port: onlyOld, nowMs: now });
    expect(r.deleted).toBe(30);
    expect(onlyOld.bulkCalls).toEqual([]);
    expect(onlyOld.singleCalls).toBe(30);
  });

  it('applies filters and keeps pinned messages', async () => {
    const h = history();
    const r = await runPurge({ amount: 10, filter: { botsOnly: true }, port: h, nowMs: now });
    expect(r.deleted).toBe(10);
    const users = await runPurge({ amount: 1000, filter: { userId: 'u1', contains: 'cheap' }, port: history(), nowMs: now });
    expect(users.deleted).toBeGreaterThan(0);
    const all = history();
    const p = await runPurge({ amount: 10, filter: {}, port: all, nowMs: now });
    expect(p.skippedPinned).toBe(1);
    expect(all.messages.some((m) => m.pinned)).toBe(true);
  });

  it('can be cancelled', async () => {
    let calls = 0;
    const r = await runPurge({ amount: 1000, filter: {}, port: history(), nowMs: now, isCancelled: () => ++calls > 2 });
    expect(r.cancelled).toBe(true);
    expect(r.deleted).toBeLessThan(1000);
  });
});

describe('scheduled messages', () => {
  const local = (iso: string) => {
    const d = new Date(iso);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  };
  const create = (svc: Awaited<ReturnType<typeof services>>, keyword: string, at: string, recurrence: 'FREQ=DAILY' | null = null) =>
    svc.schedule.create({ guildId: G, keyword, channelId: CH, content: 'Hello {server}', embed: null, local: local(at), timezone: 'UTC', recurrence, mentions: { everyone: false, roles: [] }, createdBy: MOD });

  it('rejects past times and duplicate keywords', async () => {
    const svc = await services();
    await expect(create(svc, 'old', '2026-01-01T00:00:00Z')).rejects.toThrow(/past/);
    await create(svc, 'promo', '2026-11-07T09:00:00Z');
    await expect(create(svc, 'promo', '2026-11-08T09:00:00Z')).rejects.toThrow(/already exists/);
  });

  it('sends when due, once', async () => {
    const svc = await services();
    const hooks = new FakeScheduleHooks();
    await create(svc, 'a', '2026-11-06T12:05:00Z');
    await svc.schedule.start(hooks);
    expect(await svc.schedule.tick()).toBe(0);
    svc.clock.advance(5 * 60_000);
    await svc.schedule.tick();
    await svc.schedule.tick();
    expect(hooks.sent.map((m) => m.keyword)).toEqual(['a']);
    expect(await svc.schedule.pendingCount()).toBe(0);
    await svc.schedule.stop();
  });

  it('two instances never double-send (lease)', async () => {
    const svc = await services();
    const a = new FakeScheduleHooks();
    const b = new FakeScheduleHooks();
    await create(svc, 'once', '2026-11-06T12:01:00Z');
    const other = new ScheduleService({ db: svc.db.kysely, clock: svc.clock, audit: svc.audit, log: silentLog });
    await svc.schedule.start(a);
    await other.start(b);
    svc.clock.advance(60_000);
    await Promise.all([svc.schedule.tick(), other.tick()]);
    expect(a.sent.length + b.sent.length).toBe(1);
    await svc.schedule.stop();
    await other.stop();
  });

  it('a deleted channel marks it failed and tells the creator and log', async () => {
    const svc = await services();
    const hooks = new FakeScheduleHooks();
    hooks.fail = 'permanent';
    await create(svc, 'gone', '2026-11-06T12:01:00Z');
    await svc.schedule.start(hooks);
    svc.clock.advance(60_000);
    await svc.schedule.tick();
    const row = await svc.db.kysely.selectFrom('scheduled_message').selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(hooks.failures).toEqual([{ keyword: 'gone', reason: 'the channel no longer exists' }]);
    await svc.schedule.stop();
  });

  it('retries transient failures with backoff, up to 5 attempts', async () => {
    const svc = await services();
    const hooks = new FakeScheduleHooks();
    hooks.fail = 'transient';
    await create(svc, 'flaky', '2026-11-06T12:01:00Z');
    await svc.schedule.start(hooks);
    svc.clock.advance(60_000);
    for (let n = 0; n < 5; n++) {
      await svc.schedule.tick();
      svc.clock.advance(3_600_000);
    }
    const row = await svc.db.kysely.selectFrom('scheduled_message').selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(Number(row.attempts)).toBe(4);
    expect(hooks.failures).toHaveLength(1);
    await svc.schedule.stop();
  });

  it('survives a restart across its send time, within the grace window', async () => {
    const svc = await services();
    await create(svc, 'late', '2026-11-06T13:00:00Z');
    await create(svc, 'too-late', '2026-11-06T12:30:00Z');
    svc.clock.advance(2 * 3_600_000);
    const hooks = new FakeScheduleHooks();
    await svc.schedule.start(hooks);
    await svc.schedule.tick();
    expect(hooks.sent.map((m) => m.keyword).sort()).toEqual(['late', 'too-late']);
    await svc.schedule.stop();

    const svc2 = await services();
    await create(svc2, 'missed', '2026-11-06T13:00:00Z');
    svc2.clock.advance(26 * 3_600_000);
    const hooks2 = new FakeScheduleHooks();
    await svc2.schedule.start(hooks2);
    await svc2.schedule.tick();
    expect(hooks2.sent).toEqual([]);
    expect(hooks2.failures[0]?.keyword).toBe('missed');
    expect((await svc2.db.kysely.selectFrom('scheduled_message').select('last_error').executeTakeFirstOrThrow()).last_error).toBe('missed');
    await svc2.schedule.stop();
  });

  it('recurring messages move to the next run instead of finishing', async () => {
    const svc = await services();
    const hooks = new FakeScheduleHooks();
    await create(svc, 'daily', '2026-11-06T12:01:00Z', 'FREQ=DAILY');
    await svc.schedule.start(hooks);
    svc.clock.advance(60_000);
    await svc.schedule.tick();
    const [m] = await svc.schedule.pending(G);
    expect(m!.runAt).toBe('2026-11-07T12:01:00.000Z');
    expect(svc.schedule.upcoming(m!, 3)).toHaveLength(3);
    await svc.schedule.stop();
  });
});

describe('auto-responses', () => {
  it('keywords are case-insensitive and duplicates are refused', async () => {
    const svc = await services();
    const add = (k: string) => svc.autoresponses.add(G, MOD, { keyword: k, response: 'Read the rules', embed: null, matchMode: 'manual', mentions: { everyone: false, roles: [] } });
    await add('Rules');
    await expect(add('rules')).rejects.toThrow('Autoresponse already exists, please remove it before adding another.');
    expect((await svc.autoresponses.get(G, 'RULES'))?.keyword).toBe('Rules');
    await expect(svc.autoresponses.remove(G, MOD, 'nope')).rejects.toThrow('Autoresponse does not exist, check your spelling and try again.');
    await svc.autoresponses.recordUse(G, 'rules');
    expect((await svc.autoresponses.list(G))[0]?.useCount).toBe(1);
  });
});

describe('join position', () => {
  it('is correct in a 10,000-member guild with bots excluded', async () => {
    const svc = await services();
    const base = Date.parse('2020-01-01T00:00:00Z');
    const members = Array.from({ length: 10_000 }, (_, n) => ({ userId: String(600000000000000000n + BigInt(n)), joinedAt: new Date(base + n * 60_000).toISOString(), isBot: n % 50 === 0 }));
    await svc.joinIndex.replaceAll(G, members);
    const started = Date.now();
    expect(await svc.joinIndex.position(G, members[6999]!.userId)).toBe(7000 - 140);
    expect(Date.now() - started).toBeLessThan(200);
    expect(await svc.joinIndex.position(G, members[0]!.userId)).toBeNull();
    expect(await svc.joinIndex.counts(G)).toEqual({ humans: 9800, bots: 200 });
    await svc.joinIndex.remove(G, members[1]!.userId);
    expect(await svc.joinIndex.position(G, members[2]!.userId)).toBe(1);
  });
});

describe('data lifecycle', () => {
  it('leaves zero rows for a guild 30 days after the bot leaves', async () => {
    const clock = new FakeClock();
    const svc = await services(clock);
    await svc.settings.set(G, { timezone: 'Europe/London' });
    await svc.autoresponses.add(G, MOD, { keyword: 'k', response: 'r', embed: null, matchMode: 'manual', mentions: { everyone: false, roles: [] } });
    await svc.schedule.create({ guildId: G, keyword: 's', channelId: CH, content: 'x', embed: null, local: { year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, timezone: 'UTC', recurrence: null, mentions: { everyone: false, roles: [] }, createdBy: MOD });
    await svc.joinIndex.add(G, { userId: '7', joinedAt: clock.now().toISOString(), isBot: false });
    await svc.locks.lock(await lockArgs(new FakeChannel()));
    await svc.guilds.markLeft(G);
    clock.advance(29 * 86_400_000);
    expect(await svc.guilds.purgeGone(30)).toEqual([]);
    clock.advance(2 * 86_400_000);
    expect(await svc.guilds.purgeGone(30)).toEqual([G]);
    for (const table of ['guild', 'guild_setting', 'audit_log', 'member_join', 'channel_lock', 'channel_lock_override', 'auto_response', 'scheduled_message', 'jobs'] as const) {
      const n = await svc.db.kysely.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
      expect([table, Number(n.n)]).toEqual([table, 0]);
    }
  });

  it('rejoining cancels the purge', async () => {
    const clock = new FakeClock();
    const svc = await services(clock);
    await svc.guilds.markLeft(G);
    clock.advance(10 * 86_400_000);
    await svc.guilds.ensure(G);
    clock.advance(30 * 86_400_000);
    expect(await svc.guilds.purgeGone(30)).toEqual([]);
  });
});
