export const USER_AGENT = 'TwitchAnnouncer/3.0 (Discord bot)';

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(service: string, status: number, body: string) {
    super(`${service} responded ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body.slice(0, 500);
  }
}

export type FetchFn = typeof fetch;

export async function httpFetch(fetchFn: FetchFn, url: string, init: RequestInit = {}, timeoutMs = 10_000) {
  const headers = new Headers(init.headers);
  headers.set('User-Agent', USER_AGENT);
  return fetchFn(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
