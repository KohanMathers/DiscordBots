export type YouTubeRef =
  | { type: 'handle'; value: string }
  | { type: 'channelId'; value: string }
  | { type: 'username'; value: string };

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^@?[A-Za-z0-9._-]{3,30}$/;

export function parseYouTubeInput(raw: string): YouTubeRef | null {
  const s = raw.trim();
  const url = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/([^?#\s]+)/i);
  if (url?.[1]) {
    const [first, second] = url[1].split('/');
    if (first?.startsWith('@')) return handleRef(first);
    if (first === 'channel' && second && CHANNEL_ID.test(second)) return { type: 'channelId', value: second };
    if (first === 'user' && second) return { type: 'username', value: second };
    return null;
  }
  if (CHANNEL_ID.test(s)) return { type: 'channelId', value: s };
  return handleRef(s);
}

function handleRef(s: string): YouTubeRef | null {
  if (!HANDLE.test(s)) return null;
  return { type: 'handle', value: `@${s.replace(/^@/, '').toLowerCase()}` };
}

export function parseIsoDuration(d: string | undefined): number {
  if (!d) return 0;
  const m = d.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, days, h, min, sec] = m;
  return Number(days ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(sec ?? 0);
}

export const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
export const thumbnailUrl = (videoId: string) => `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
export const feedUrl = (channelId: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

export function excerpt(text: string, max = 200): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}
