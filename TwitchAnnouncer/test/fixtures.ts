export function feedXml(channelId: string, channelTitle: string, entries: Array<{ id: string; published: string; title?: string }>) {
  const items = entries
    .map(
      (e) => `
  <entry>
    <id>yt:video:${e.id}</id>
    <yt:videoId>${e.id}</yt:videoId>
    <yt:channelId>${channelId}</yt:channelId>
    <title>${e.title ?? `Video ${e.id}`}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${e.id}"/>
    <author><name>${channelTitle}</name><uri>https://www.youtube.com/channel/${channelId}</uri></author>
    <published>${e.published}</published>
    <updated>${e.published}</updated>
    <media:group>
      <media:title>${e.title ?? `Video ${e.id}`}</media:title>
      <media:thumbnail url="https://i1.ytimg.com/vi/${e.id}/hqdefault.jpg" width="480" height="360"/>
      <media:description>Feed description for ${e.id}</media:description>
    </media:group>
  </entry>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${channelId}"/>
  <id>yt:channel:${channelId.slice(2)}</id>
  <yt:channelId>${channelId}</yt:channelId>
  <title>${channelTitle}</title>
  <author><name>${channelTitle}</name></author>
  <published>2015-01-01T00:00:00+00:00</published>${items}
</feed>`;
}

export function videoResource(
  id: string,
  o: {
    title?: string;
    description?: string;
    duration?: string;
    width?: number;
    height?: number;
    broadcast?: 'none' | 'live' | 'upcoming';
    liveEnded?: boolean;
  } = {},
) {
  return {
    kind: 'youtube#video',
    id,
    snippet: {
      publishedAt: '2026-11-05T12:01:00Z',
      channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
      title: o.title ?? 'Fresh',
      description: o.description ?? '',
      channelTitle: 'Chan',
      liveBroadcastContent: o.broadcast ?? 'none',
    },
    contentDetails: { duration: o.duration ?? 'PT10M' },
    player: { embedHtml: '<iframe/>', embedWidth: String(o.width ?? 1280), embedHeight: String(o.height ?? 720) },
    ...(o.liveEnded ? { liveStreamingDetails: { actualStartTime: '2026-11-05T10:00:00Z', actualEndTime: '2026-11-05T11:00:00Z' } } : {}),
  };
}
