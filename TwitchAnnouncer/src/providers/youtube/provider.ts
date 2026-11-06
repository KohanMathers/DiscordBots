import type { Logger } from 'pino';
import type {
  AnnouncementMessage,
  EventKind,
  PollContext,
  PollResult,
  Provider,
  ResolveResult,
  SourceEvent,
  SourceRef,
} from '../../core/types.ts';
import { ApiError, chunk, type FetchFn, httpFetch, mapLimit } from '../http.ts';
import { classifyVideo, type VideoDetails } from './classify.ts';
import { type FeedEntry, parseFeed } from './feed.ts';
import { excerpt, feedUrl, parseYouTubeInput, thumbnailUrl, watchUrl } from './parse.ts';

const API = 'https://www.googleapis.com/youtube/v3';
export const YOUTUBE_COLOR = 0xff0000;
const FEED_CONCURRENCY = 8;

interface ChannelResource {
  id: string;
  snippet?: { title?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> };
}

const channelToRef = (c: ChannelResource): SourceRef => {
  const thumbs = c.snippet?.thumbnails ?? {};
  const handle = c.snippet?.customUrl?.startsWith('@') ? c.snippet.customUrl.toLowerCase() : c.id;
  return {
    provider: 'youtube',
    externalId: c.id,
    displayName: c.snippet?.title || handle,
    handle,
    avatarUrl: thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null,
    url: handle.startsWith('@') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${c.id}`,
  };
};

const quotaDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

export class YouTubeProvider implements Provider {
  readonly id = 'youtube';
  readonly displayName = 'YouTube';
  readonly enabled = true;
  readonly firstSync = 'mark-seen' as const;
  readonly filterableKinds: readonly EventKind[] = ['UPLOAD', 'SHORT', 'PREMIERE', 'LIVE_VOD'];
  readonly pollIntervalMs: number;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private readonly log: Logger;
  private quota = { day: '', units: 0 };

  constructor(opts: { apiKey: string; pollIntervalMs: number; log: Logger; fetchFn?: FetchFn }) {
    this.apiKey = opts.apiKey;
    this.pollIntervalMs = opts.pollIntervalMs;
    this.log = opts.log.child({ provider: 'youtube' });
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  get unitsToday(): number {
    return this.quota.day === quotaDay(new Date()) ? this.quota.units : 0;
  }

  async resolve(input: string): Promise<ResolveResult> {
    const ref = parseYouTubeInput(input);
    if (!ref) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'Give a YouTube @handle, a channel URL, or a channel ID (starts with `UC`).',
      };
    }
    const param = ref.type === 'handle' ? 'forHandle' : ref.type === 'channelId' ? 'id' : 'forUsername';
    const body = await this.api<{ items?: ChannelResource[] }>('channels', { part: 'id,snippet', [param]: ref.value });
    const channel = body.items?.[0];
    if (!channel) return { ok: false, reason: 'not_found', message: `No YouTube channel matches **${ref.value}**.` };
    return { ok: true, source: channelToRef(channel) };
  }

  async poll(sources: SourceRef[], ctx: PollContext): Promise<PollResult> {
    const errors: PollResult['errors'] = [];
    const feeds = await mapLimit(sources, FEED_CONCURRENCY, async (source) => {
      try {
        return { source, entries: await this.fetchFeed(source.externalId) };
      } catch (err) {
        errors.push({ externalId: source.externalId, error: err instanceof Error ? err.message : String(err) });
        return { source, entries: [] as FeedEntry[] };
      }
    });

    const cutoff = ctx.now.getTime() - ctx.maxAgeMs;
    const toEnrich = feeds.flatMap(({ source, entries }) =>
      ctx.isFirstPoll(source.externalId)
        ? []
        : entries.filter((e) => !ctx.isKnown(source.externalId, e.videoId) && Date.parse(e.published) >= cutoff),
    );
    const details = await this.videoDetails(toEnrich.map((e) => e.videoId));

    const events: SourceEvent[] = [];
    for (const { source, entries } of feeds) {
      for (const entry of entries) events.push(this.toEvent(source, entry, details.get(entry.videoId)));
    }
    return { events, updatedRefs: [], errors };
  }

  async refresh(sources: SourceRef[]): Promise<SourceRef[]> {
    const out: SourceRef[] = [];
    for (const ids of chunk(sources.map((s) => s.externalId), 50)) {
      const body = await this.api<{ items?: ChannelResource[] }>('channels', { part: 'id,snippet', id: ids.join(',') });
      out.push(...(body.items ?? []).map(channelToRef));
    }
    return out;
  }

  render(event: SourceEvent, source: SourceRef): AnnouncementMessage {
    const channel = typeof event.extra.channelTitle === 'string' && event.extra.channelTitle
      ? event.extra.channelTitle
      : source.displayName;
    const description = typeof event.extra.description === 'string' ? excerpt(event.extra.description) : '';
    const parts = [`**${event.title}**`, description, `[Watch here](${event.url})`].filter(Boolean);
    return {
      allowedRoleIds: [],
      embed: {
        title: titleFor(event, channel),
        description: parts.join('\n\n'),
        url: event.url,
        color: YOUTUBE_COLOR,
        ...(event.imageUrl ? { imageUrl: event.imageUrl } : {}),
        footer: 'YouTube Video Announcement',
        timestamp: event.occurredAt,
      },
    };
  }

  sampleEvent(source: SourceRef): SourceEvent {
    return {
      provider: 'youtube',
      externalId: source.externalId,
      kind: 'UPLOAD',
      itemId: `test-${Date.now()}`,
      title: 'Test announcement — this is what an upload post will look like',
      subtitle: null,
      url: source.url,
      imageUrl: source.avatarUrl,
      occurredAt: new Date().toISOString(),
      extra: { channelTitle: source.displayName, description: 'The video description appears here.' },
    };
  }

  status(): Record<string, string> {
    return { 'quota used today': `${this.unitsToday} units` };
  }

  private toEvent(source: SourceRef, entry: FeedEntry, details: VideoDetails | undefined): SourceEvent {
    return {
      provider: 'youtube',
      externalId: source.externalId,
      kind: details ? classifyVideo(details) : 'UPLOAD',
      itemId: entry.videoId,
      title: details?.snippet?.title || entry.title,
      subtitle: null,
      url: watchUrl(entry.videoId),
      imageUrl: thumbnailUrl(entry.videoId),
      occurredAt: details?.snippet?.publishedAt || entry.published,
      extra: {
        channelTitle: details?.snippet?.channelTitle || entry.channelTitle,
        description: details?.snippet?.description ?? entry.description,
        broadcast: details?.snippet?.liveBroadcastContent ?? 'none',
        enriched: Boolean(details),
      },
    };
  }

  private async fetchFeed(channelId: string): Promise<FeedEntry[]> {
    const res = await httpFetch(this.fetchFn, feedUrl(channelId));
    if (res.status === 404) return [];
    if (!res.ok) throw new ApiError('youtube-feed', res.status, await res.text());
    return parseFeed(await res.text());
  }

  private async videoDetails(ids: string[]): Promise<Map<string, VideoDetails>> {
    const map = new Map<string, VideoDetails>();
    for (const batch of chunk([...new Set(ids)], 50)) {
      try {
        const body = await this.api<{ items?: VideoDetails[] }>('videos', {
          part: 'snippet,contentDetails,liveStreamingDetails,player',
          id: batch.join(','),
          maxWidth: '1280',
        });
        for (const v of body.items ?? []) map.set(v.id, v);
      } catch (err) {
        this.log.warn({ err }, 'videos.list failed; announcing without enrichment');
      }
    }
    return map;
  }

  private async api<T>(resource: string, params: Record<string, string>): Promise<T> {
    const url = `${API}/${resource}?${new URLSearchParams({ ...params, key: this.apiKey })}`;
    const res = await httpFetch(this.fetchFn, url);
    this.spend(1);
    if (!res.ok) throw new ApiError('youtube', res.status, await res.text());
    return (await res.json()) as T;
  }

  private spend(units: number): void {
    const day = quotaDay(new Date());
    if (this.quota.day !== day) this.quota = { day, units: 0 };
    this.quota.units += units;
  }
}

function titleFor(event: SourceEvent, channel: string): string {
  switch (event.kind) {
    case 'SHORT':
      return `📱 ${channel} posted a new Short!`;
    case 'PREMIERE':
      return event.extra.broadcast === 'live'
        ? `🔴 ${channel} is live on YouTube!`
        : `⏰ ${channel} scheduled a premiere!`;
    default:
      return `📺 ${channel} uploaded a new video!`;
  }
}
