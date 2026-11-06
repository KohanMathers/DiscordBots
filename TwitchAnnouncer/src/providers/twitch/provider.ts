import type { Logger } from 'pino';
import type {
  AnnouncementMessage,
  PollResult,
  Provider,
  ResolveResult,
  SourceEvent,
  SourceRef,
} from '../../core/types.ts';
import type { FetchFn } from '../http.ts';
import { type HelixUser, TwitchClient } from './client.ts';
import { livePreviewUrl, parseTwitchInput } from './parse.ts';

export const TWITCH_COLOR = 0x9146ff;

const userToRef = (u: HelixUser): SourceRef => ({
  provider: 'twitch',
  externalId: u.id,
  displayName: u.display_name || u.login,
  handle: u.login,
  avatarUrl: u.profile_image_url || null,
  url: `https://twitch.tv/${u.login}`,
});

export class TwitchProvider implements Provider {
  readonly id = 'twitch';
  readonly displayName = 'Twitch';
  readonly enabled = true;
  readonly firstSync = 'announce-current' as const;
  readonly filterableKinds = [] as const;
  readonly pollIntervalMs: number;
  private readonly client: TwitchClient;

  constructor(opts: { clientId: string; clientSecret: string; pollIntervalMs: number; log: Logger; fetchFn?: FetchFn }) {
    this.pollIntervalMs = opts.pollIntervalMs;
    this.client = new TwitchClient({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      log: opts.log.child({ provider: 'twitch' }),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
  }

  async resolve(input: string): Promise<ResolveResult> {
    const login = parseTwitchInput(input);
    if (!login) {
      return { ok: false, reason: 'invalid_input', message: 'That doesn’t look like a Twitch username or channel URL.' };
    }
    const [user] = await this.client.getUsersByLogin([login]);
    if (!user) return { ok: false, reason: 'not_found', message: `No Twitch channel called **${login}** exists.` };
    return { ok: true, source: userToRef(user) };
  }

  async resolveLogins(logins: string[]): Promise<Map<string, SourceRef>> {
    const users = await this.client.getUsersByLogin(logins);
    return new Map(users.map((u) => [u.login.toLowerCase(), userToRef(u)]));
  }

  async poll(sources: SourceRef[]): Promise<PollResult> {
    const known = new Map(sources.map((s) => [s.externalId, s]));
    const streams = await this.client.getStreams([...known.keys()]);
    const events: SourceEvent[] = [];
    const updatedRefs: SourceRef[] = [];

    for (const s of streams) {
      const source = known.get(s.user_id);
      if (!source) continue;
      events.push({
        provider: 'twitch',
        externalId: s.user_id,
        kind: 'LIVE_START',
        itemId: s.id,
        title: s.title || 'No Title',
        subtitle: s.game_name || 'Unknown Game',
        url: `https://twitch.tv/${s.user_login}`,
        imageUrl: livePreviewUrl(s.user_login, s.started_at),
        occurredAt: s.started_at,
        extra: { login: s.user_login, displayName: s.user_name },
      });
      if (s.user_login !== source.handle || s.user_name !== source.displayName) {
        updatedRefs.push({
          ...source,
          handle: s.user_login,
          displayName: s.user_name || s.user_login,
          url: `https://twitch.tv/${s.user_login}`,
          avatarUrl: null,
        });
      }
    }
    return { events, updatedRefs, errors: [] };
  }

  async refresh(sources: SourceRef[]): Promise<SourceRef[]> {
    const users = await this.client.getUsersById(sources.map((s) => s.externalId));
    return users.map(userToRef);
  }

  render(event: SourceEvent, source: SourceRef): AnnouncementMessage {
    const login = typeof event.extra.login === 'string' ? event.extra.login : source.handle;
    const name = typeof event.extra.displayName === 'string' && event.extra.displayName
      ? event.extra.displayName
      : source.displayName;
    return {
      allowedRoleIds: [],
      embed: {
        title: `🔴 ${name} is live!`,
        description:
          `**${event.title || 'No Title'}**\n` +
          `Now playing: ${event.subtitle || 'Unknown Game'}\n` +
          `[Watch here](https://twitch.tv/${login})`,
        url: `https://twitch.tv/${login}`,
        color: TWITCH_COLOR,
        ...(event.imageUrl ? { imageUrl: event.imageUrl } : {}),
        ...(source.avatarUrl ? { thumbnailUrl: source.avatarUrl } : {}),
        footer: 'Twitch Stream Announcement',
      },
    };
  }

  sampleEvent(source: SourceRef): SourceEvent {
    const now = new Date().toISOString();
    return {
      provider: 'twitch',
      externalId: source.externalId,
      kind: 'LIVE_START',
      itemId: `test-${Date.now()}`,
      title: 'Test announcement — this is what a go-live post will look like',
      subtitle: 'Just Chatting',
      url: source.url,
      imageUrl: livePreviewUrl(source.handle, now),
      occurredAt: now,
      extra: { login: source.handle, displayName: source.displayName },
    };
  }

  status(): Record<string, string> {
    const rl = this.client.rateLimit;
    return {
      'rate limit': rl.remaining === null ? 'no requests yet' : `${rl.remaining}/${rl.limit ?? '?'} points left`,
    };
  }
}
