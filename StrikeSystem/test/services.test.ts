import { describe, expect, it } from 'vitest';
import { GRADUATED_LADDER } from '../src/core/escalation.ts';
import { JobQueue } from '../src/services/jobs.ts';
import { JobWorker, PermanentJobError, type RegisteredHandler } from '../src/services/worker.ts';
import { G, MOD, pendingJobs, services, silentLog, U1, U2 } from './helpers.ts';

const strike = async (svc: Awaited<ReturnType<typeof services>>, user = U1, reason: string | null = 'spam') =>
  svc.cases.strike({ guildId: G, targetId: user, actorId: MOD, reason }, await svc.settings.get(G), { dm: true });

describe('strike -> case + outbox', () => {
  it('writes the case and its jobs in one go', async () => {
    const svc = await services();
    const r = await strike(svc);
    expect(r.case.number).toBe(1);
    expect(r.count).toBe(1);
    const types = (await pendingJobs(svc)).map((j) => j.type).sort();
    expect(types).toEqual(['case.dm', 'case.log', 'tracker.refresh']);
    expect(r.case.dmStatus).toBe('PENDING');
  });

  it('numbers cases per guild', async () => {
    const svc = await services();
    await strike(svc);
    await svc.cases.create({ guildId: G, type: 'WARN', targetId: U1, actorId: MOD });
    const other = await svc.cases.create({ guildId: '999999999999999999', type: 'WARN', targetId: U1, actorId: MOD });
    expect((await svc.cases.byNumber(G, 2))?.type).toBe('WARN');
    expect(other.number).toBe(1);
  });

  it('rejects a 1001-character reason before writing anything (D-05)', async () => {
    const svc = await services();
    await expect(strike(svc, U1, 'x'.repeat(1001))).rejects.toThrow(/limit is 1000/);
    expect((await svc.cases.list(G, { limit: 10 })).total).toBe(0);
    expect(await pendingJobs(svc)).toHaveLength(0);
    await expect(strike(svc, U1, 'x'.repeat(1000))).resolves.toBeTruthy();
  });

  it('debounces tracker refreshes: a burst leaves one pending job', async () => {
    const svc = await services();
    for (let n = 0; n < 5; n++) await strike(svc, n % 2 ? U1 : U2);
    expect(await pendingJobs(svc, 'tracker.refresh')).toHaveLength(1);
  });
});

describe('escalation', () => {
  it('bans at max with the legacy default', async () => {
    const svc = await services();
    await strike(svc);
    await strike(svc);
    const third = await strike(svc);
    expect(third.count).toBe(3);
    expect(third.escalation?.action).toBe('ban');
    expect(await pendingJobs(svc, 'escalation.run')).toHaveLength(1);
  });

  it('concurrent strikes produce exactly one escalation (D-07)', async () => {
    const svc = await services();
    await strike(svc);
    const results = await Promise.all([strike(svc), strike(svc), strike(svc)]);
    expect(results.map((r) => r.count).sort()).toEqual([2, 3, 4]);
    expect(await pendingJobs(svc, 'escalation.run')).toHaveLength(1);
  });

  it('revoke then re-strike does not fire the same step twice', async () => {
    const svc = await services();
    await strike(svc);
    await strike(svc);
    const third = await strike(svc);
    await svc.cases.revoke(third.case, MOD, 'mistake', { recordRevokeCase: true });
    const again = await strike(svc);
    expect(again.count).toBe(3);
    expect(again.escalation).toBeNull();
    expect(await pendingJobs(svc, 'escalation.run')).toHaveLength(1);
  });

  it('revoking the escalation case re-arms its step', async () => {
    const svc = await services();
    await strike(svc);
    await strike(svc);
    const third = await strike(svc);
    const ban = await svc.cases.create({ guildId: G, type: 'BAN', targetId: U1, actorId: 'bot', parentCase: third.case.id, metadata: { escalationAt: 3 } });
    await svc.cases.revoke(ban, MOD, 'appeal accepted', { recordRevokeCase: false });
    const next = await strike(svc);
    expect(next.escalation?.action).toBe('ban');
  });

  it('follows a graduated ladder', async () => {
    const svc = await services();
    await svc.settings.update(G, { 'strikes.escalation': GRADUATED_LADDER, 'strikes.max': 4 });
    const fired = [];
    for (let n = 0; n < 4; n++) fired.push((await strike(svc)).escalation?.action ?? '-');
    expect(fired).toEqual(['-', 'timeout', 'timeout', 'ban']);
  });
});

describe('strike expiry', () => {
  it('expires strikes at the boundary and updates the count', async () => {
    const svc = await services();
    await svc.settings.update(G, { 'strikes.expiry': 90 * 86400 });
    const r = await strike(svc);
    expect(r.case.expiresAt).toBe('2027-02-04T12:00:00.000Z');
    svc.clock.advance(90 * 86_400_000 - 1000);
    expect(await svc.cases.expireDue()).toEqual([]);
    svc.clock.advance(1000);
    expect(await svc.cases.expireDue()).toEqual([G]);
    expect(await svc.cases.activeStrikeCount(G, U1)).toBe(0);
    expect((await svc.cases.byId(r.case.id))?.status).toBe('EXPIRED');
  });

  it('expiring below a step re-arms it for the next crossing', async () => {
    const svc = await services();
    await svc.settings.update(G, { 'strikes.expiry': 86400 });
    for (let n = 0; n < 3; n++) await strike(svc);
    svc.clock.advance(86_400_000);
    await svc.cases.expireDue();
    await strike(svc);
    await strike(svc);
    expect((await strike(svc)).escalation?.action).toBe('ban');
  });
});

describe('job worker', () => {
  function workerWith(svc: Awaited<ReturnType<typeof services>>, handlers: Record<string, RegisteredHandler['run']>) {
    const map = new Map(Object.entries(handlers).map(([k, run]) => [k, { moduleId: 'core', run }]));
    return new JobWorker({ queue: svc.jobs, handlers: map, isEnabled: async () => true, log: silentLog, metrics: svc.metrics });
  }

  it('delivers exactly once after a crash between commit and delivery', async () => {
    const svc = await services();
    await svc.cases.create({ guildId: G, type: 'WARN', targetId: U1, actorId: MOD });
    await svc.jobs.claimDue(10);
    const restarted = new JobQueue(svc.db.kysely, svc.clock);
    expect(await restarted.recoverRunning()).toBeGreaterThan(0);
    const delivered: string[] = [];
    const w = workerWith(svc, { 'case.log': async (j) => void delivered.push(String(j.payload.caseId)), 'case.dm': async () => { } });
    await w.drainOnce();
    await w.drainOnce();
    expect(delivered).toHaveLength(1);
  });

  it('retries with backoff, and stops on permanent errors', async () => {
    const svc = await services();
    await svc.jobs.enqueue([{ type: 'flaky', guildId: G, payload: {} }, { type: 'doomed', guildId: G, payload: {} }]);
    let flaky = 0;
    const w = workerWith(svc, {
      flaky: async () => {
        if (++flaky < 3) throw new Error('503');
      },
      doomed: async () => {
        throw new PermanentJobError('no permission');
      },
    });
    await w.drainOnce();
    expect(flaky).toBe(1);
    svc.clock.advance(10_000);
    await w.drainOnce();
    svc.clock.advance(40_000);
    await w.drainOnce();
    expect(flaky).toBe(3);
    const rows = await svc.db.kysely.selectFrom('jobs').select(['type', 'status']).execute();
    expect(rows.find((r) => r.type === 'flaky')?.status).toBe('done');
    expect(rows.find((r) => r.type === 'doomed')?.status).toBe('failed');
  });

  it('runs a guild’s jobs in order', async () => {
    const svc = await services();
    for (let n = 0; n < 5; n++) await svc.jobs.enqueue([{ type: 'step', guildId: G, payload: { n } }]);
    const order: number[] = [];
    const w = workerWith(svc, { step: async (j) => void order.push(Number(j.payload.n)) });
    await w.drainOnce();
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('privacy', () => {
  it('purges a user and anonymises their actions', async () => {
    const svc = await services();
    await strike(svc, U1);
    await svc.cases.create({ guildId: G, type: 'WARN', targetId: U2, actorId: U1 });
    const r = await svc.cases.purgeUser(G, U1);
    expect(r).toEqual({ deleted: 1, anonymised: 1 });
    expect((await svc.cases.list(G, { targetId: U1, limit: 10 })).total).toBe(0);
    expect((await svc.cases.list(G, { targetId: U2, limit: 10 })).cases[0]?.actorId).toBe('0');
  });
});
