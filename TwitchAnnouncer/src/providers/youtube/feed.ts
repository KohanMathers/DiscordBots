import { XMLParser } from 'fast-xml-parser';

export interface FeedEntry {
  videoId: string;
  channelId: string;
  title: string;
  channelTitle: string;
  published: string;
  description: string;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => name === 'entry' });

const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && '#text' in v) return String((v as { '#text': unknown })['#text']);
  return '';
};

export function parseFeed(xml: string): FeedEntry[] {
  const doc = parser.parse(xml) as { feed?: { entry?: Array<Record<string, any>>; author?: { name?: unknown } } };
  const feed = doc.feed;
  if (!feed) throw new Error('not an Atom feed');
  const feedAuthor = text(feed.author?.name);
  return (feed.entry ?? [])
    .map((e) => ({
      videoId: text(e['yt:videoId']),
      channelId: text(e['yt:channelId']),
      title: text(e.title),
      channelTitle: text(e.author?.name) || feedAuthor,
      published: text(e.published),
      description: text(e['media:group']?.['media:description']),
    }))
    .filter((e) => e.videoId && e.published);
}
