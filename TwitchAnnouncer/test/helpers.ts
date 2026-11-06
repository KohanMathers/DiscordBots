import pino from 'pino';
import type { Clock } from '../src/core/clock.ts';
import { createMetrics } from '../src/core/metrics.ts';
import { SendError, type Sender, type SendTarget } from '../src/core/sender.ts';
import type { AnnouncementMessage } from '../src/core/types.ts';
import { openDatabase } from '../src/storage/db.ts';
import { Store } from '../src/storage/store.ts';

export const silentLog = pino({ level: 'silent' });

export class FakeClock implements Clock {
  t: number;
  constructor(iso = '2026-11-05T12:00:00.000Z') {
    this.t = Date.parse(iso);
  }
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export async function memoryStore(clock = new FakeClock()) {
  const db = await openDatabase('sqlite::memory:');
  return { db, clock, store: new Store(db, clock), metrics: createMetrics() };
}

export class FakeSender implements Sender {
  sent: Array<{ target: SendTarget; message: AnnouncementMessage }> = [];
  notices: Array<{ guildId: string; text: string }> = [];
  failWith: SendError['kind'] | null = null;
  private n = 0;

  async send(target: SendTarget, message: AnnouncementMessage): Promise<string> {
    if (this.failWith) throw new SendError(this.failWith, `fake ${this.failWith}`);
    this.sent.push({ target, message });
    return `msg-${++this.n}`;
  }
  async notifyBroken(guildId: string, _log: string | null, text: string) {
    this.notices.push({ guildId, text });
  }
}

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

export function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.href.startsWith(k));
    if (!key) return new Response('no route', { status: 599 });
    return routes[key]!(url, init);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
