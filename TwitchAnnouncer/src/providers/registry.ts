import type { Logger } from 'pino';
import type { Config } from '../app/config.ts';
import type { EventKind, Provider } from '../core/types.ts';
import { TwitchProvider } from './twitch/provider.ts';
import { YouTubeProvider } from './youtube/provider.ts';

export interface FilterChoice {
  label: string;
  value: string;
  kinds: EventKind[] | null;
}

export interface ProviderInfo {
  id: string;
  name: string;
  color: number;
  input: { option: string; description: string };
  filterChoices: FilterChoice[];
}

interface ProviderFactory extends ProviderInfo {
  create: (cfg: Config, log: Logger) => Provider | null;
}

const factories: ProviderFactory[] = [
  {
    id: 'twitch',
    name: 'Twitch',
    color: 0x9146ff,
    input: { option: 'creator', description: 'Twitch username or channel URL' },
    filterChoices: [],
    create: (cfg, log) =>
      cfg.TWITCH_CLIENT_ID && cfg.TWITCH_CLIENT_SECRET
        ? new TwitchProvider({
            clientId: cfg.TWITCH_CLIENT_ID,
            clientSecret: cfg.TWITCH_CLIENT_SECRET,
            pollIntervalMs: cfg.TWITCH_POLL_INTERVAL,
            log,
          })
        : null,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    color: 0xff0000,
    input: { option: 'channel_ref', description: 'YouTube @handle, channel URL or channel ID' },
    filterChoices: [
      { label: 'Everything (default)', value: 'all', kinds: null },
      { label: 'Everything except Shorts', value: 'no_shorts', kinds: ['UPLOAD', 'PREMIERE', 'LIVE_VOD'] },
      { label: 'Regular videos only', value: 'videos', kinds: ['UPLOAD'] },
      { label: 'Shorts only', value: 'shorts', kinds: ['SHORT'] },
      { label: 'Live streams and premieres', value: 'live', kinds: ['PREMIERE', 'LIVE_VOD'] },
    ],
    create: (cfg, log) =>
      cfg.YOUTUBE_API_KEY
        ? new YouTubeProvider({ apiKey: cfg.YOUTUBE_API_KEY, pollIntervalMs: cfg.YOUTUBE_POLL_INTERVAL, log })
        : null,
  },
];

export interface ProviderSet {
  catalog: ProviderInfo[];
  enabled: Provider[];
  get(id: string): Provider | undefined;
  info(id: string): ProviderInfo | undefined;
}

export function loadProviders(cfg: Config, log: Logger): ProviderSet {
  const enabled: Provider[] = [];
  const catalog: ProviderInfo[] = [];
  for (const { create, ...info } of factories) {
    catalog.push(info);
    const p = create(cfg, log);
    if (p) enabled.push(p);
  }
  return fromProviders(catalog, enabled);
}

export function fromProviders(catalog: ProviderInfo[], enabled: Provider[]): ProviderSet {
  const byId = new Map(enabled.map((p) => [p.id, p]));
  const infoById = new Map(catalog.map((i) => [i.id, i]));
  return { catalog, enabled, get: (id) => byId.get(id), info: (id) => infoById.get(id) };
}

export const PROVIDER_CATALOG: ProviderInfo[] = factories.map(({ create: _create, ...info }) => info);
