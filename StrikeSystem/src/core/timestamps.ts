export function normaliseTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(' ', 'T');
  s = s.replace(/(\.\d{3})\d+/, '$1');
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const ms = Date.parse(hasZone ? s : `${s}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export const discordTime = (iso: string, style: 'f' | 'R' | 'd' | 'F' = 'f') =>
  `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;
