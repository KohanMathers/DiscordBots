import { UserError } from './errors.ts';

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

export const SECOND = 1;
export const DAY_S = 86400;
export const TIMEOUT_MAX_S = 28 * DAY_S;
export const LONG_MAX_S = 3650 * DAY_S;

export function parseDuration(input: string, bounds: { min?: number; max: number }): number {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+[smhdw])+$/.test(s)) {
    throw new UserError(`"${input}" isn't a duration. Use forms like \`10m\`, \`1h\`, \`1d12h\` or \`2w\`.`);
  }
  let total = 0n;
  for (const [, n, unit] of s.matchAll(/(\d+)([smhdw])/g)) {
    total += BigInt(n!) * BigInt(UNITS[unit!]!);
    if (total > BigInt(bounds.max)) break;
  }
  const min = bounds.min ?? 1;
  if (total < BigInt(min)) throw new UserError(`The duration must be at least ${formatDuration(min)}.`);
  if (total > BigInt(bounds.max)) throw new UserError(`The duration can be at most ${formatDuration(bounds.max)}.`);
  return Number(total);
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  const parts: string[] = [];
  let rest = Math.floor(seconds);
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    const n = Math.floor(rest / size);
    if (n) parts.push(`${n}${unit}`);
    rest -= n * size;
  }
  return parts.join(' ');
}

export const durationToken = (seconds: number) => formatDuration(seconds).replace(/ /g, '');
