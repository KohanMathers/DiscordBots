import { durationToken, LONG_MAX_S, parseDuration, TIMEOUT_MAX_S } from './duration.ts';
import { UserError } from './errors.ts';

export type EscalationAction = 'timeout' | 'kick' | 'ban' | 'notify';

export interface LadderStep {
  at: number | 'max';
  action: EscalationAction;
  durationS?: number;
  roleId?: string;
}

export const LEGACY_LADDER: LadderStep[] = [{ at: 'max', action: 'ban' }];
export const GRADUATED_LADDER: LadderStep[] = [
  { at: 2, action: 'timeout', durationS: 3600 },
  { at: 3, action: 'timeout', durationS: 86400 },
  { at: 'max', action: 'ban' },
];
export const GRADUATED_MAX = 4;

export function parseLadder(input: string): LadderStep[] {
  const text = input.trim();
  if (text === '' || text.toLowerCase() === 'none') return [];
  const steps = text.split(',').map((part) => {
    const [atRaw = '', actionRaw = '', arg] = part.trim().split(':').map((x) => x.trim());
    const at: number | 'max' = atRaw.toLowerCase() === 'max' ? 'max' : Number(atRaw);
    if (at !== 'max' && (!Number.isInteger(at) || at < 1 || at > 100)) {
      throw new UserError(`"${part.trim()}": the count must be 1–100 or \`max\`.`);
    }
    const action = actionRaw.toLowerCase() as EscalationAction;
    switch (action) {
      case 'timeout':
        if (!arg) throw new UserError(`"${part.trim()}": timeouts need a duration, e.g. \`2:timeout:1h\`.`);
        return { at, action, durationS: parseDuration(arg, { max: TIMEOUT_MAX_S }) };
      case 'kick':
      case 'ban':
        return { at, action };
      case 'notify': {
        const roleId = arg?.match(/\d{15,22}/)?.[0];
        if (!roleId) throw new UserError(`"${part.trim()}": notify needs a role, e.g. \`3:notify:@Mods\`.`);
        return { at, action, roleId };
      }
      default:
        throw new UserError(`"${part.trim()}": the action must be timeout, kick, ban or notify.`);
    }
  });
  return steps;
}

export function formatLadder(steps: LadderStep[]): string {
  if (steps.length === 0) return 'none';
  return steps
    .map((s) => {
      const arg = s.action === 'timeout' ? `:${durationToken(s.durationS ?? 0)}` : s.action === 'notify' ? `:<@&${s.roleId}>` : '';
      return `${s.at}:${s.action}${arg}`;
    })
    .join(', ');
}

export function describeStep(s: LadderStep): string {
  switch (s.action) {
    case 'timeout':
      return `${durationToken(s.durationS ?? 0)} timeout`;
    case 'notify':
      return `alert <@&${s.roleId}>`;
    default:
      return s.action;
  }
}

export const resolveAt = (s: LadderStep, max: number) => (s.at === 'max' ? max : s.at);

export function planEscalation(
  ladder: LadderStep[],
  max: number,
  newCount: number,
  fired: ReadonlySet<number>,
): { fire: LadderStep | null; atKey: number | null; markAts: number[] } {
  const applicable = ladder
    .map((s) => ({ s, at: resolveAt(s, max) }))
    .filter((x) => x.at <= newCount)
    .sort((a, b) => b.at - a.at || severity(b.s.action) - severity(a.s.action));
  const markAts = [...new Set(applicable.map((x) => x.at))].filter((at) => !fired.has(at));
  const top = applicable[0];
  if (!top || fired.has(top.at)) return { fire: null, atKey: null, markAts };
  return { fire: top.s, atKey: top.at, markAts };
}

export function nextStep(ladder: LadderStep[], max: number, count: number): LadderStep | null {
  return (
    ladder
      .filter((s) => resolveAt(s, max) > count)
      .sort((a, b) => resolveAt(a, max) - resolveAt(b, max))[0] ?? null
  );
}

const severity = (a: EscalationAction) => ({ notify: 0, timeout: 1, kick: 2, ban: 3 })[a];

export { LONG_MAX_S };
