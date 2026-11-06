import pino from 'pino';
import { buildServices } from '../src/app/wiring.ts';
import type { Clock } from '../src/core/clock.ts';
import { MODULES } from '../src/modules/index.ts';

export const silentLog = pino({ level: 'silent' });

export class FakeClock implements Clock {
  t: number;
  constructor(iso = '2026-11-06T12:00:00.000Z') {
    this.t = Date.parse(iso);
  }
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export async function services(clock = new FakeClock()) {
  const svc = await buildServices({ dbPath: ':memory:', modules: MODULES, clock, log: silentLog });
  return { ...svc, clock };
}

export async function pendingJobs(svc: Awaited<ReturnType<typeof services>>, type?: string) {
  let q = svc.db.kysely.selectFrom('jobs').selectAll().where('status', '=', 'pending');
  if (type) q = q.where('type', '=', type);
  return q.execute();
}

export const G = '100000000000000001';
export const MOD = '200000000000000002';
export const U1 = '300000000000000003';
export const U2 = '300000000000000004';
