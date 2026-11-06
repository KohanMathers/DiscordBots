import { UserError } from './errors.ts';

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export const ZONE_SUGGESTIONS: Record<string, string> = {
  EST: 'America/New_York',
  EDT: 'America/New_York',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  AKST: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  GMT: 'Europe/London',
  BST: 'Europe/London',
  WET: 'Europe/Lisbon',
  CET: 'Europe/Paris',
  CEST: 'Europe/Paris',
  EET: 'Europe/Athens',
  EEST: 'Europe/Athens',
  MSK: 'Europe/Moscow',
  IST: 'Asia/Kolkata',
  JST: 'Asia/Tokyo',
  KST: 'Asia/Seoul',
  AEST: 'Australia/Sydney',
  AEDT: 'Australia/Sydney',
  ACST: 'Australia/Adelaide',
  AWST: 'Australia/Perth',
  NZST: 'Pacific/Auckland',
  NZDT: 'Pacific/Auckland',
};

let zoneList: string[] | null = null;
export function allZones(): string[] {
  zoneList ??= ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')];
  return zoneList;
}

export function resolveZone(input: string): string {
  const s = input.trim();
  if (/^(utc|z|etc\/utc)$/i.test(s)) return 'UTC';
  const exact = allZones().find((z) => z.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const suggestion = ZONE_SUGGESTIONS[s.toUpperCase()];
  if (suggestion) {
    throw new UserError(`"${s}" is an abbreviation, which is ambiguous and ignores daylight saving. Use \`${suggestion}\` instead`);
  }
  throw new UserError(`"${s}" isn't a time zone I know. Use a name like \`Europe/London\` or \`America/New_York\` (the option autocompletes)`);
}

const partsFormatter = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = partsFormatter.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatter.set(zone, f);
  }
  return f;
}

export function utcToLocal(ms: number, zone: string): LocalDateTime & { second: number } {
  const p = Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour!, minute: +p.minute!, second: +p.second! };
}

export function offsetMs(zone: string, ms: number): number {
  const l = utcToLocal(ms, zone);
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - Math.floor(ms / 1000) * 1000;
}

export function localToUtc(l: LocalDateTime, zone: string): number {
  const naive = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute);
  const candidates = [offsetMs(zone, naive - 86_400_000), offsetMs(zone, naive + 86_400_000)].map((o) => naive - o);
  const exact = candidates.filter((ms) => sameLocal(utcToLocal(ms, zone), l)).sort((a, b) => a - b);
  if (exact.length) return exact[0]!;
  return naive - offsetMs(zone, naive - 86_400_000);
}

const sameLocal = (a: LocalDateTime, b: LocalDateTime) =>
  a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;

export const formatLocal = (l: LocalDateTime) =>
  `${l.year}-${pad(l.month)}-${pad(l.day)}T${pad(l.hour)}:${pad(l.minute)}`;

export function parseLocal(s: string): LocalDateTime {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`bad local time ${s}`);
  return { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]! };
}

const pad = (n: number) => String(n).padStart(2, '0');

function validLocal(l: LocalDateTime): boolean {
  const d = new Date(Date.UTC(l.year, l.month - 1, l.day));
  return (
    l.hour >= 0 && l.hour <= 23 && l.minute >= 0 && l.minute <= 59 &&
    d.getUTCFullYear() === l.year && d.getUTCMonth() === l.month - 1 && d.getUTCDate() === l.day
  );
}

const RELATIVE_UNITS: Record<string, number> = { m: 60_000, min: 60_000, mins: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function parseWhen(input: string, zone: string, nowMs: number): { runAt: number; local: LocalDateTime } {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  let local: LocalDateTime | null = null;

  const rel = s.match(/^in ((?:\d+ ?[a-z]+ ?)+)$/);
  if (rel) {
    let ms = 0;
    for (const [, n, u] of rel[1]!.matchAll(/(\d+) ?([a-z]+)/g)) {
      const unit = RELATIVE_UNITS[u!];
      if (!unit) throw new UserError(`"${u}" isn't a time unit. Use m, h, d or w, e.g. \`in 2h\``);
      ms += Number(n) * unit;
    }
    if (ms <= 0 || ms > 3650 * 86_400_000) throw new UserError('That relative time is out of range');
    const runAt = Math.ceil((nowMs + ms) / 60_000) * 60_000;
    return { runAt, local: utcToLocal(runAt, zone) };
  }

  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/);
  if (dmy) local = { day: +dmy[1]!, month: +dmy[2]!, year: +dmy[3]!, hour: +dmy[4]!, minute: +dmy[5]! };
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{1,2}):(\d{2})$/);
  if (!local && iso) local = { year: +iso[1]!, month: +iso[2]!, day: +iso[3]!, hour: +iso[4]!, minute: +iso[5]! };
  const clock = s.match(/^(tomorrow |today )?(\d{1,2}):(\d{2})$/);
  if (!local && clock) {
    const today = utcToLocal(nowMs, zone);
    local = { year: today.year, month: today.month, day: today.day, hour: +clock[2]!, minute: +clock[3]! };
    if (!validLocal(local)) throw new UserError('That time isn’t valid. Use 24-hour HH:MM, like `18:30`');
    if (clock[1] === 'tomorrow ' || (!clock[1] && localToUtc(local, zone) <= nowMs)) local = addDays(local, 1);
  }
  if (!local) {
    throw new UserError('I couldn’t read that time. Use `DD/MM/YYYY HH:MM`, `YYYY-MM-DD HH:MM`, `HH:MM`, or `in 2h`');
  }
  if (!validLocal(local)) throw new UserError('That date or time doesn’t exist. Check the day, month and 24-hour time');
  const runAt = localToUtc(local, zone);
  if (runAt <= nowMs) throw new UserError('That time is in the past. Pick a time in the future');
  return { runAt, local };
}

export function addDays(l: LocalDateTime, n: number): LocalDateTime {
  const d = new Date(Date.UTC(l.year, l.month - 1, l.day + n));
  return { ...l, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function addMonths(anchorDay: number, l: LocalDateTime, n: number): LocalDateTime {
  const first = new Date(Date.UTC(l.year, l.month - 1 + n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return { ...l, year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: Math.min(anchorDay, lastDay) };
}

export type Recurrence = 'FREQ=DAILY' | 'FREQ=WEEKLY' | 'FREQ=MONTHLY';
export const RECURRENCES: Record<string, Recurrence | null> = { none: null, daily: 'FREQ=DAILY', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY' };

export function nextLocal(recurrence: Recurrence, local: LocalDateTime, anchorDay: number): LocalDateTime {
  if (recurrence === 'FREQ=DAILY') return addDays(local, 1);
  if (recurrence === 'FREQ=WEEKLY') return addDays(local, 7);
  return addMonths(anchorDay, local, 1);
}

export function upcomingRuns(recurrence: Recurrence | null, anchor: LocalDateTime, zone: string, fromLocal: LocalDateTime, afterMs: number, count: number): number[] {
  const out: number[] = [];
  let l = fromLocal;
  let guard = 0;
  while (out.length < count && guard++ < 5000) {
    const ms = localToUtc(l, zone);
    if (ms > afterMs) out.push(ms);
    if (!recurrence) break;
    l = nextLocal(recurrence, l, anchor.day);
  }
  return out;
}

export function v2DateParts(l: LocalDateTime): { date: string; time: string } {
  return { date: `${pad(l.day)}/${pad(l.month)}/${l.year}`, time: `${pad(l.hour)}:${pad(l.minute)}` };
}
