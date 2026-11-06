import type { Logger } from 'pino';
import { ApiError, chunk, type FetchFn, httpFetch, sleep } from '../http.ts';

const HELIX = 'https://api.twitch.tv/helix';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

export interface HelixUser {
  id: string;
  login: string;
  display_name: string;
  description: string;
  profile_image_url: string;
  created_at: string;
}

export interface HelixStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_name: string;
  type: string;
  title: string;
  started_at: string;
  thumbnail_url: string;
}

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
}

export class TwitchClient {
  readonly rateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null };
  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchFn: FetchFn;
  private readonly log: Logger;

  constructor(opts: { clientId: string; clientSecret: string; fetchFn?: FetchFn; log: Logger }) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.log = opts.log;
  }

  async getUsersByLogin(logins: string[]): Promise<HelixUser[]> {
    return this.getUsers('login', logins);
  }

  async getUsersById(ids: string[]): Promise<HelixUser[]> {
    return this.getUsers('id', ids);
  }

  async getStreams(userIds: string[]): Promise<HelixStream[]> {
    const out: HelixStream[] = [];
    for (const ids of chunk(userIds, 100)) {
      const params = new URLSearchParams({ type: 'live', first: '100' });
      for (const id of ids) params.append('user_id', id);
      const body = await this.get<{ data: HelixStream[] }>(`/streams?${params}`);
      out.push(...body.data.filter((s) => s.type === 'live'));
    }
    return out;
  }

  private async getUsers(key: 'login' | 'id', values: string[]): Promise<HelixUser[]> {
    const out: HelixUser[] = [];
    for (const batch of chunk(values, 100)) {
      const params = new URLSearchParams();
      for (const v of batch) params.append(key, v);
      const body = await this.get<{ data: HelixUser[] }>(`/users?${params}`);
      out.push(...body.data);
    }
    return out;
  }

  private async get<T>(path: string, retried = false): Promise<T> {
    await this.waitForBudget();
    const token = await this.accessToken();
    const res = await httpFetch(this.fetchFn, `${HELIX}${path}`, {
      headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${token}` },
    });
    this.readRateLimit(res.headers);

    if (res.status === 401 && !retried) {
      this.log.info('twitch token rejected, fetching a new one');
      this.token = null;
      return this.get<T>(path, true);
    }
    if (res.status === 429 && !retried) {
      await this.waitForBudget(true);
      return this.get<T>(path, true);
    }
    if (!res.ok) throw new ApiError('twitch', res.status, await res.text());
    return (await res.json()) as T;
  }

  private async waitForBudget(force = false): Promise<void> {
    const { remaining, resetAt } = this.rateLimit;
    if (!resetAt) return;
    if (!force && (remaining === null || remaining > 5)) return;
    const wait = Math.min(Math.max(resetAt.getTime() - Date.now(), 0) + 250, 60_000);
    if (wait > 0) {
      this.log.warn({ waitMs: wait, remaining }, 'twitch rate limit nearly spent, backing off');
      await sleep(wait);
    }
  }

  private readRateLimit(headers: Headers): void {
    const num = (name: string) => {
      const v = headers.get(name);
      return v === null ? null : Number(v);
    };
    const limit = num('Ratelimit-Limit');
    const remaining = num('Ratelimit-Remaining');
    const reset = num('Ratelimit-Reset');
    if (limit !== null) this.rateLimit.limit = limit;
    if (remaining !== null) this.rateLimit.remaining = remaining;
    if (reset !== null) this.rateLimit.resetAt = new Date(reset * 1000);
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const res = await httpFetch(this.fetchFn, TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
      }),
    });
    if (!res.ok) throw new ApiError('twitch-auth', res.status, await res.text());
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    this.log.info({ expiresInS: body.expires_in }, 'twitch app token acquired');
    return body.access_token;
  }
}
