export const LIMITS = {
  fieldValue: 1024,
  fieldName: 256,
  fields: 25,
  embedTotal: 6000,
  embedsPerMessage: 10,
  description: 4096,
};

export const MAX_TRACKER_MESSAGES = 5;

export interface TrackerRow {
  userId: string;
  name: string | null;
  count: number;
  next: string | null;
  soonestExpiry: string | null;
}

export interface TrackerField {
  name: string;
  value: string;
}

export interface TrackerEmbed {
  title?: string;
  description?: string;
  color: number;
  fields: TrackerField[];
  footer?: string;
}

export const BAND_COLORS = { red: 0xe74c3c, amber: 0xf39c12, green: 0x2ecc71 };

export function bandOf(count: number, max: number): keyof typeof BAND_COLORS {
  if (count >= max) return 'red';
  if (count >= Math.ceil(max * 0.7)) return 'amber';
  return 'green';
}

const embedSize = (e: TrackerEmbed) =>
  (e.title?.length ?? 0) +
  (e.description?.length ?? 0) +
  (e.footer?.length ?? 0) +
  e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

function rowLine(r: TrackerRow): string {
  const who = r.name ? `${r.name.slice(0, 40)} (<@${r.userId}>)` : `Unknown user (\`${r.userId}\`)`;
  const extra = [
    r.next ? `next: ${r.next}` : null,
    r.soonestExpiry ? `expires <t:${Math.floor(Date.parse(r.soonestExpiry) / 1000)}:R>` : null,
  ].filter(Boolean);
  return `${who}${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
}

export function layoutTracker(opts: {
  guildName: string;
  max: number;
  rows: TrackerRow[];
  updatedAt: string;
}): TrackerEmbed[][] {
  const { max, rows } = opts;
  const header: TrackerEmbed = {
    title: '📋 Strike tracker',
    description:
      rows.length === 0
        ? '✨ **Clean server:** nobody has active strikes.'
        : `**${rows.length}** member${rows.length === 1 ? '' : 's'} with active strikes · limit **${max}**\nUpdated <t:${Math.floor(Date.parse(opts.updatedAt) / 1000)}:R>`,
    color: rows.length === 0 ? BAND_COLORS.green : 0x3498db,
    fields: [],
    footer: opts.guildName.slice(0, 100),
  };

  const byCount = new Map<number, TrackerRow[]>();
  for (const r of [...rows].sort((a, b) => b.count - a.count || (a.name ?? '').localeCompare(b.name ?? ''))) {
    byCount.set(r.count, [...(byCount.get(r.count) ?? []), r]);
  }

  const bandEmbeds: TrackerEmbed[] = [];
  let current: TrackerEmbed | null = null;
  let currentBand: string | null = null;
  const icons = { red: '🔴', amber: '🟠', green: '🟢' };

  for (const [count, group] of byCount) {
    const band = bandOf(count, max);
    const chunks: string[] = [];
    let buf = '';
    for (const r of group) {
      const line = rowLine(r);
      if (buf.length + line.length + 1 > LIMITS.fieldValue) {
        chunks.push(buf);
        buf = '';
      }
      buf += (buf ? '\n' : '') + line;
    }
    if (buf) chunks.push(buf);

    chunks.forEach((value, i) => {
      const name = `${icons[band]} ${count}/${max} strikes${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}`;
      const field = { name, value };
      const fits =
        current &&
        currentBand === band &&
        current.fields.length < LIMITS.fields &&
        embedSize(current) + name.length + value.length <= LIMITS.embedTotal - 100;
      if (!fits) {
        current = { color: BAND_COLORS[band], fields: [] };
        currentBand = band;
        bandEmbeds.push(current);
      }
      current!.fields.push(field);
    });
  }

  const messages: TrackerEmbed[][] = [];
  let msg: TrackerEmbed[] = [header];
  let size = embedSize(header);
  let dropped = 0;
  for (const e of bandEmbeds) {
    const s = embedSize(e);
    if (msg.length >= LIMITS.embedsPerMessage || size + s > LIMITS.embedTotal - 100) {
      messages.push(msg);
      msg = [];
      size = 0;
    }
    if (messages.length >= MAX_TRACKER_MESSAGES) {
      dropped += e.fields.reduce((n, f) => n + f.value.split('\n').length, 0);
      continue;
    }
    msg.push(e);
    size += s;
  }
  if (msg.length && messages.length < MAX_TRACKER_MESSAGES) messages.push(msg);
  if (dropped) {
    const last = messages.at(-1)!;
    const tail = last.at(-1)!;
    tail.footer = `…and ${dropped} more not shown. Use /history to look people up.`;
  }
  return messages;
}

export { embedSize };
