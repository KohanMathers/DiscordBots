import { describe, expect, it } from 'vitest';
import { Detector } from '../src/core/detector.ts';
import { Dispatcher } from '../src/core/dispatcher.ts';
import type { HelixStream } from '../src/providers/twitch/client.ts';
import { TwitchProvider } from '../src/providers/twitch/provider.ts';
import { YouTubeProvider } from '../src/providers/youtube/provider.ts';
import { Store } from '../src/storage/store.ts';
import { FakeClock, FakeSender, fakeFetch, json, memoryStore, silentLog } from './helpers.ts';
import { feedXml, videoResource } from './fixtures.ts';

const DAY = 86_400_000;

function twitchApi(state: { streams: HelixStream[]; rejectNextToken?: boolean }) {
  let tokens = 0;
  return fakeFetch({
    'https://id.twitch.tv/oauth2/token': () => json({ access_token: `tok${++tokens}`, expires_in: 3600, token_type: 'bearer' }),
    'https://api.twitch.tv/helix/users': (url) => {
      const users = url.searchParams.getAll('login').length ? url.searchParams.getAll('login') : url.searchParams.getAll('id');
      return json({
        data: users
          .filter((u) => u !== 'nobody')
          .map((u) => ({
            id: /^\d+$/.test(u) ? u : String(1000 + u.length),
            login: /^\d+$/.test(u) ? `user${u}` : u,
            display_name: /^\d+$/.test(u) ? `User${u}` : u.toUpperCase(),
            description: '',
            profile_image_url: `https://img/${u}.png`,
            created_at: '2016-03-05T00:00:00Z',
          })),
      });
    },
    'https://api.twitch.tv/helix/streams': (_url, init) => {
      if (state.rejectNextToken) {
        state.rejectNextToken = false;
        return json({ message: 'invalid token' }, 401);
      }
      const auth = new Headers(init?.headers).get('authorization');
      return json({ data: state.streams }, 200, {
        'Ratelimit-Limit': '800',
        'Ratelimit-Remaining': '799',
        'Ratelimit-Reset': String(Math.floor(Date.now() / 1000) + 60),
        'x-auth': auth ?? '',
      });
    },
  });
}

const stream = (userId: string, login: string, id: string, startedAt: string, name = login.toUpperCase()): HelixStream => ({
  id,
  user_id: userId,
  user_login: login,
  user_name: name,
  game_name: 'Just Chatting',
  type: 'live',
  title: 'Hello world',
  started_at: startedAt,
  thumbnail_url: '',
});

async function setup() {
  const { store, clock, metrics, db } = await memoryStore();
  const sender = new FakeSender();
  const state: { streams: HelixStream[]; rejectNextToken?: boolean } = { streams: [] };
  const api = twitchApi(state);
  const twitch = new TwitchProvider({ clientId: 'id', clientSecret: 'secret', pollIntervalMs: 60_000, log: silentLog, fetchFn: api.fetch });
  const detector = new Detector({ store, metrics, log: silentLog, clock, maxAgeMs: DAY });
  const dispatcher = new Dispatcher({ store, sender, providers: [twitch], metrics, log: silentLog, clock });

  async function subscribe(guildId: string, login: string, channelId = `chan-${guildId}`) {
    await store.setDefaultChannel(guildId, 'twitch', channelId);
    const r = await twitch.resolve(login);
    if (!r.ok) throw new Error(r.message);
    const source = await store.upsertSource(r.source);
    const sub = await store.upsertSubscription({ guildId, sourceId: source.id, channelId: null, roleId: null, filters: null, createdBy: 'u' });
    await detector.syncNewSubscription(twitch, source, sub.id, null);
    return { source, sub };
  }

  return { store, clock, db, sender, state, api, twitch, detector, dispatcher, subscribe, metrics };
}

describe('Twitch pipeline', () => {
  it('announces a go-live once per guild, with the embed', async () => {
    const t = await setup();
    const { source } = await t.subscribe('g1', 'shroud');
    await t.subscribe('g2', 'shroud');

    t.state.streams = [stream(source.externalId, 'shroud', 's1', t.clock.now().toISOString())];
    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();

    expect(t.sender.sent.map((s) => s.target.channelId).sort()).toEqual(['chan-g1', 'chan-g2']);
    const embed = t.sender.sent[0]!.message.embed;
    expect(embed.title).toBe('🔴 SHROUD is live!');
    expect(embed.description).toBe('**Hello world**\nNow playing: Just Chatting\n[Watch here](https://twitch.tv/shroud)');
    expect(embed.color).toBe(0x9146ff);
    expect(embed.footer).toBe('Twitch Stream Announcement');
    expect(embed.thumbnailUrl).toBe('https://img/shroud.png');
    expect(embed.imageUrl).toMatch(/^https:\/\/static-cdn\.jtvnw\.net\/previews-ttv\/live_user_shroud-1920x1080\.jpg\?t=\d+$/);

    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();
    expect(t.sender.sent).toHaveLength(2);

    t.state.streams = [stream(source.externalId, 'shroud', 's2', t.clock.now().toISOString())];
    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();
    expect(t.sender.sent).toHaveLength(4);
  });

  it('makes one Twitch request per cycle for a creator followed by 50 guilds', async () => {
    const t = await setup();
    for (let g = 0; g < 50; g++) await t.subscribe(`g${g}`, 'popular');
    const before = t.api.calls.filter((c) => c.includes('/helix/streams')).length;
    await t.detector.pollProvider(t.twitch);
    expect(t.api.calls.filter((c) => c.includes('/helix/streams')).length - before).toBe(1);
  });

  it('announces at once when a guild subscribes to a creator who is already live', async () => {
    const t = await setup();
    const { source } = await t.subscribe('g1', 'shroud');
    t.state.streams = [stream(source.externalId, 'shroud', 's1', t.clock.now().toISOString())];
    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();
    expect(t.sender.sent).toHaveLength(1);

    await t.subscribe('g2', 'shroud');
    await t.dispatcher.drainOnce();
    expect(t.sender.sent.map((s) => s.target.channelId)).toEqual(['chan-g1', 'chan-g2']);
  });

  it('does not announce twice after a restart mid-stream', async () => {
    const t = await setup();
    const { source } = await t.subscribe('g1', 'shroud');
    t.state.streams = [stream(source.externalId, 'shroud', 's1', t.clock.now().toISOString())];
    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();

    const store2 = new Store(t.db, t.clock);
    const detector2 = new Detector({ store: store2, metrics: t.metrics, log: silentLog, clock: t.clock, maxAgeMs: DAY });
    const dispatcher2 = new Dispatcher({ store: store2, sender: t.sender, providers: [t.twitch], metrics: t.metrics, log: silentLog, clock: t.clock });
    await detector2.pollProvider(t.twitch);
    await dispatcher2.drainOnce();
    expect(t.sender.sent).toHaveLength(1);
  });

  it('keeps announcing a renamed streamer, under the new name', async () => {
    const t = await setup();
    const { source } = await t.subscribe('g1', 'oldname');
    t.state.streams = [stream(source.externalId, 'newname', 's1', t.clock.now().toISOString(), 'NewName')];
    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();
    expect(t.sender.sent[0]!.message.embed.title).toBe('🔴 NewName is live!');
    const [sub] = await t.store.listSubscriptions('g1');
    expect(sub!.source.handle).toBe('newname');
  });

  it('rejects unknown logins at add time', async () => {
    const t = await setup();
    const r = await t.twitch.resolve('nobody');
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await t.twitch.resolve('not a login!')).toMatchObject({ ok: false, reason: 'invalid_input' });
  });

  it('gets a fresh app token after a 401', async () => {
    const t = await setup();
    const { source } = await t.subscribe('g1', 'shroud');
    t.state.streams = [stream(source.externalId, 'shroud', 's1', t.clock.now().toISOString())];
    t.state.rejectNextToken = true;
    const outcome = await t.detector.pollProvider(t.twitch);
    expect(outcome.ok).toBe(true);
    expect(t.api.calls.filter((c) => c.includes('oauth2/token'))).toHaveLength(2);
  });
});

describe('delivery failures', () => {
  it('pauses the subscription and notifies once when permission is revoked, losing no state', async () => {
    const t = await setup();
    const { source } = await t.subscribe('g1', 'shroud');
    t.sender.failWith = 'forbidden';
    t.state.streams = [stream(source.externalId, 'shroud', 's1', t.clock.now().toISOString())];
    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();

    const [sub] = await t.store.listSubscriptions('g1');
    expect(sub!.state).toBe('broken');
    expect(t.sender.notices).toHaveLength(1);

    t.state.streams = [stream(source.externalId, 'shroud', 's2', t.clock.now().toISOString())];
    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();
    expect(t.sender.notices).toHaveLength(1);
    expect((await t.store.listSubscriptions('g1'))[0]!.source.externalId).toBe(source.externalId);
  });

  it('retries transient failures 3 times over about 5 minutes, then gives up', async () => {
    const t = await setup();
    const { source } = await t.subscribe('g1', 'shroud');
    t.sender.failWith = 'retryable';
    t.state.streams = [stream(source.externalId, 'shroud', 's1', t.clock.now().toISOString())];
    await t.detector.pollProvider(t.twitch);

    expect(await t.dispatcher.drainOnce()).toBe(1);
    expect(await t.dispatcher.drainOnce()).toBe(0);
    t.clock.advance(60_000);
    expect(await t.dispatcher.drainOnce()).toBe(1);
    t.clock.advance(240_000);
    expect(await t.dispatcher.drainOnce()).toBe(1);
    t.clock.advance(600_000);
    expect(await t.dispatcher.drainOnce()).toBe(0);
    expect(await t.store.pendingDeliveryCount()).toBe(0);
    expect((await t.store.listSubscriptions('g1'))[0]!.state).toBe('active');
  });

  it('succeeds on a retry after a transient failure', async () => {
    const t = await setup();
    const { source } = await t.subscribe('g1', 'shroud');
    t.sender.failWith = 'retryable';
    t.state.streams = [stream(source.externalId, 'shroud', 's1', t.clock.now().toISOString())];
    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();
    t.sender.failWith = null;
    t.clock.advance(60_000);
    await t.dispatcher.drainOnce();
    expect(t.sender.sent).toHaveLength(1);
  });

  it('pings the subscribed role and allows only that mention', async () => {
    const t = await setup();
    const { source, sub } = await t.subscribe('g1', 'shroud');
    await t.store.upsertSubscription({ guildId: 'g1', sourceId: source.id, channelId: null, roleId: 'role1', filters: null, createdBy: 'u' });
    expect(sub.created).toBe(true);
    t.state.streams = [stream(source.externalId, 'shroud', 's1', t.clock.now().toISOString())];
    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();
    expect(t.sender.sent[0]!.message.content).toBe('<@&role1>');
    expect(t.sender.sent[0]!.message.allowedRoleIds).toEqual(['role1']);
  });
});

describe('YouTube pipeline', () => {
  async function ytSetup() {
    const clock = new FakeClock('2026-11-05T12:00:00Z');
    const { store, metrics } = await memoryStore(clock);
    const sender = new FakeSender();
    const feed: { entries: Array<{ id: string; published: string; title?: string }> } = { entries: [] };
    const videos = new Map<string, object>();
    const api = fakeFetch({
      'https://www.youtube.com/feeds/videos.xml': () => new Response(feedXml('UCaaaaaaaaaaaaaaaaaaaaaa', 'Chan', feed.entries)),
      'https://www.googleapis.com/youtube/v3/channels': () =>
        json({ items: [{ id: 'UCaaaaaaaaaaaaaaaaaaaaaa', snippet: { title: 'Chan', customUrl: '@chan', thumbnails: {} } }] }),
      'https://www.googleapis.com/youtube/v3/videos': (url) =>
        json({ items: (url.searchParams.get('id') ?? '').split(',').map((id) => videos.get(id)).filter(Boolean) }),
    });
    const yt = new YouTubeProvider({ apiKey: 'k', pollIntervalMs: 300_000, log: silentLog, fetchFn: api.fetch });
    const detector = new Detector({ store, metrics, log: silentLog, clock, maxAgeMs: DAY });
    const dispatcher = new Dispatcher({ store, sender, providers: [yt], metrics, log: silentLog, clock });
    const subscribe = async (guildId: string, filters: { kinds: string[] } | null = null) => {
      await store.setDefaultChannel(guildId, 'youtube', `chan-${guildId}`);
      const r = await yt.resolve('@chan');
      if (!r.ok) throw new Error(r.message);
      const source = await store.upsertSource(r.source);
      const sub = await store.upsertSubscription({ guildId, sourceId: source.id, channelId: null, roleId: null, filters, createdBy: 'u' });
      await detector.syncNewSubscription(yt, source, sub.id, filters);
    };
    return { store, clock, sender, feed, videos, api, yt, detector, dispatcher, subscribe };
  }

  it('never announces the back catalogue, then announces new uploads with the embed', async () => {
    const t = await ytSetup();
    t.feed.entries = [{ id: 'oldvideo001', published: '2026-11-05T11:00:00Z' }];
    await t.subscribe('g1');
    await t.dispatcher.drainOnce();
    expect(t.sender.sent).toHaveLength(0);

    t.videos.set('newvideo001', videoResource('newvideo001', { description: 'd'.repeat(250) }));
    t.feed.entries.unshift({ id: 'newvideo001', published: '2026-11-05T12:01:00Z', title: 'Fresh' });
    await t.detector.pollProvider(t.yt);
    await t.dispatcher.drainOnce();

    expect(t.sender.sent).toHaveLength(1);
    const embed = t.sender.sent[0]!.message.embed;
    expect(embed.title).toBe('📺 Chan uploaded a new video!');
    expect(embed.description).toBe(`**Fresh**\n\n${'d'.repeat(200)}...\n\n[Watch here](https://www.youtube.com/watch?v=newvideo001)`);
    expect(embed.color).toBe(0xff0000);
    expect(embed.imageUrl).toBe('https://img.youtube.com/vi/newvideo001/maxresdefault.jpg');
    expect(embed.footer).toBe('YouTube Video Announcement');
    expect(embed.timestamp).toBe('2026-11-05T12:01:00Z');
  });

  it('announces Shorts by default but honours a no-Shorts filter', async () => {
    const t = await ytSetup();
    await t.subscribe('all');
    await t.subscribe('noshorts', { kinds: ['UPLOAD', 'PREMIERE', 'LIVE_VOD'] });
    t.videos.set('shortvid001', videoResource('shortvid001', { duration: 'PT45S', width: 405, height: 720 }));
    t.feed.entries = [{ id: 'shortvid001', published: '2026-11-05T12:01:00Z' }];
    await t.detector.pollProvider(t.yt);
    await t.dispatcher.drainOnce();
    expect(t.sender.sent.map((s) => s.target.channelId)).toEqual(['chan-all']);
    expect(t.sender.sent[0]!.message.embed.title).toBe('📱 Chan posted a new Short!');
  });

  it('skips videos older than the catch-up window and spends no quota on them', async () => {
    const t = await ytSetup();
    await t.subscribe('g1');
    t.feed.entries = [{ id: 'stalevideo1', published: '2026-11-03T12:00:00Z' }];
    const before = t.api.calls.filter((c) => c.includes('/videos?')).length;
    await t.detector.pollProvider(t.yt);
    await t.dispatcher.drainOnce();
    expect(t.sender.sent).toHaveLength(0);
    expect(t.api.calls.filter((c) => c.includes('/videos?')).length).toBe(before);
  });

  it('polls via the free feed: no Data API units when nothing is new', async () => {
    const t = await ytSetup();
    await t.subscribe('g1');
    const units = t.yt.unitsToday;
    for (let i = 0; i < 10; i++) await t.detector.pollProvider(t.yt);
    expect(t.yt.unitsToday).toBe(units);
  });
});

describe('housekeeping', () => {
  it('prunes de-dup records after 30 days', async () => {
    const t = await setup();
    const { source } = await t.subscribe('g1', 'shroud');
    t.state.streams = [stream(source.externalId, 'shroud', 's1', t.clock.now().toISOString())];
    await t.detector.pollProvider(t.twitch);
    await t.dispatcher.drainOnce();
    t.clock.advance(31 * DAY);
    const pruned = await t.store.prune();
    expect(pruned.seenItems).toBe(1);
    expect(pruned.deliveries).toBe(1);
  });
});
