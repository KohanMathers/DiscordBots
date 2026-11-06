import pino from 'pino';
import { buildServices, selectModules } from '../src/app/wiring.ts';
import type { Clock } from '../src/core/clock.ts';

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
  const svc = await buildServices({ dbPath: ':memory:', modules: selectModules(null), clock, log: silentLog });
  await svc.guilds.ensure(G);
  return { ...svc, clock };
}

export const G = '100000000000000001';
export const MOD = '200000000000000002';
export const CH = '300000000000000003';
