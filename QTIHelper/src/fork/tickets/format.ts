export const ticketId = (n: number) => `#${String(n).padStart(4, '0')}`;

export function slug(s: string, max = 40): string {
  const out = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return out || 'user';
}

export function ticketChannelName(n: number, label: string, closed = false): string {
  return `${closed ? 'closed' : 'ticket'}-${String(n).padStart(4, '0')}-${slug(label)}`.slice(0, 100);
}

export interface TranscriptMessage {
  createdAt: Date;
  authorTag: string;
  authorId: string;
  bot: boolean;
  content: string;
  attachments: string[];
  embeds: number;
}

export function formatTranscript(header: Record<string, string>, messages: TranscriptMessage[]): string {
  const head = Object.entries(header).map(([k, v]) => `${k}: ${v}`);
  const lines = messages.map((m) => {
    const when = m.createdAt.toISOString().replace('T', ' ').slice(0, 19);
    const parts = [`[${when} UTC] ${m.authorTag} (${m.authorId})${m.bot ? ' [BOT]' : ''}: ${m.content}`];
    for (const url of m.attachments) parts.push(`    [attachment] ${url}`);
    if (m.embeds) parts.push(`    [${m.embeds} embed${m.embeds === 1 ? '' : 's'}]`);
    return parts.join('\n');
  });
  return [...head, `Messages: ${messages.length}`, '-'.repeat(60), ...lines, ''].join('\n');
}
