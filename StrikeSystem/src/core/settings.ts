import { DAY_S, durationToken, formatDuration, LONG_MAX_S, parseDuration } from './duration.ts';
import { UserError } from './errors.ts';
import { formatLadder, LEGACY_LADDER, type LadderStep, parseLadder } from './escalation.ts';

export type SettingValue = string | number | boolean | null | string[] | LadderStep[];

export interface SettingDef<T extends SettingValue = SettingValue> {
  key: string;
  description: string;
  default: T;
  parse(input: string): T;
  format(value: T): string;
  hidden?: boolean;
}

const snowflake = (input: string, what: string): string => {
  const id = input.match(/\d{15,22}/)?.[0];
  if (!id) throw new UserError(`Give a ${what} mention or ID.`);
  return id;
};

const unsetWords = new Set(['', 'none', 'unset', 'off', 'clear']);

export const kinds = {
  int(min: number, max: number) {
    return {
      parse: (input: string) => {
        const n = Number(input.trim());
        if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`Give a whole number from ${min} to ${max}.`);
        return n;
      },
      format: (v: number) => String(v),
    };
  },
  bool() {
    return {
      parse: (input: string) => {
        const s = input.trim().toLowerCase();
        if (['true', 'on', 'yes', '1', 'enable', 'enabled'].includes(s)) return true;
        if (['false', 'off', 'no', '0', 'disable', 'disabled'].includes(s)) return false;
        throw new UserError('Give `on` or `off`.');
      },
      format: (v: boolean) => (v ? 'on' : 'off'),
    };
  },
  channel() {
    return {
      parse: (input: string): string | null => (unsetWords.has(input.trim().toLowerCase()) ? null : snowflake(input, 'channel')),
      format: (v: string | null) => (v ? `<#${v}>` : '*not set*'),
    };
  },
  role() {
    return {
      parse: (input: string): string | null => (unsetWords.has(input.trim().toLowerCase()) ? null : snowflake(input, 'role')),
      format: (v: string | null) => (v ? `<@&${v}>` : '*not set*'),
    };
  },
  roles() {
    return {
      parse: (input: string): string[] => [...new Set(input.match(/\d{15,22}/g) ?? [])],
      format: (v: string[]) => (v.length ? v.map((r) => `<@&${r}>`).join(' ') : '*none*'),
    };
  },
  choice<T extends string>(choices: readonly T[]) {
    return {
      parse: (input: string): T => {
        const s = input.trim().toLowerCase() as T;
        if (!choices.includes(s)) throw new UserError(`Choose one of: ${choices.map((c) => `\`${c}\``).join(', ')}.`);
        return s;
      },
      format: (v: T) => `\`${v}\``,
    };
  },
  set<T extends string>(choices: readonly T[]) {
    return {
      parse: (input: string): string[] => {
        const s = input.trim().toLowerCase();
        if (s === 'all') return [...choices];
        if (unsetWords.has(s)) return [];
        const items = s.split(/[\s,]+/).filter(Boolean);
        const bad = items.filter((i) => !choices.includes(i as T));
        if (bad.length) throw new UserError(`Unknown: ${bad.join(', ')}. Choose from ${choices.join(', ')}, or \`all\`/\`none\`.`);
        return [...new Set(items)];
      },
      format: (v: string[]) => (v.length === choices.length ? 'all' : v.length ? v.join(', ') : 'none'),
    };
  },
  text(max: number) {
    return {
      parse: (input: string): string | null => {
        const s = input.trim();
        if (unsetWords.has(s.toLowerCase())) return null;
        if (s.length > max) throw new UserError(`At most ${max} characters.`);
        return s;
      },
      format: (v: string | null) => (v ? v : '*not set*'),
    };
  },
  durationOrNever(maxS: number) {
    return {
      parse: (input: string): number | null =>
        ['never', 'none', 'off'].includes(input.trim().toLowerCase()) ? null : parseDuration(input, { max: maxS }),
      format: (v: number | null) => (v === null ? 'never' : formatDuration(v)),
    };
  },
  seconds(max: number) {
    return {
      parse: (input: string): number => (['0', 'none'].includes(input.trim()) ? 0 : parseDuration(input, { max })),
      format: (v: number) => (v ? formatDuration(v) : 'none'),
    };
  },
  ladder() {
    return { parse: parseLadder, format: formatLadder };
  },
};

export const DM_ACTIONS = ['strike', 'warn', 'timeout', 'kick', 'ban'] as const;
export const PERMISSION_CHOICES = ['moderatemembers', 'kickmembers', 'banmembers', 'managemessages', 'manageguild'] as const;

export const CORE_SETTINGS: SettingDef<any>[] = [
  { key: 'strikes.max', description: 'Active strikes before the top escalation step (1–100)', default: 3, ...kinds.int(1, 100) },
  { key: 'strikes.expiry', description: 'How long a strike stays active (`never`, or e.g. `90d`)', default: null, ...kinds.durationOrNever(LONG_MAX_S) },
  { key: 'strikes.escalation', description: 'Escalation ladder, e.g. `2:timeout:1h, 3:timeout:24h, max:ban`', default: LEGACY_LADDER, ...kinds.ladder() },
  { key: 'log.channel', description: 'Channel for the case log', default: null, ...kinds.channel() },
  { key: 'notify.dm_on_action', description: `Actions that DM the member (${DM_ACTIONS.join(', ')})`, default: [...DM_ACTIONS], ...kinds.set(DM_ACTIONS) },
  { key: 'notify.public_confirmations', description: 'Show command confirmations to everyone instead of only the moderator', default: false, ...kinds.bool() },
  { key: 'notify.appeal_text', description: 'Text added to punishment DMs, e.g. how to appeal (≤ 500 chars)', default: null, ...kinds.text(500) },
  { key: 'notify.show_moderator', description: 'Show the moderator’s name to punished members (DMs, /mystrikes)', default: false, ...kinds.bool() },
  { key: 'mute.mode', description: '`timeout` (Discord timeout, ≤ 28 days) or `role` (mute role, any length)', default: 'timeout', ...kinds.choice(['timeout', 'role'] as const) },
  { key: 'mute.role', description: 'Role given when mute.mode is `role`', default: null, ...kinds.role() },
  { key: 'ban.delete_message_seconds', description: 'Message history deleted on ban by default (`0`–`7d`)', default: 0, ...kinds.seconds(7 * DAY_S) },
  { key: 'perms.mod_roles', description: 'Roles that can moderate (empty = fallback permission)', default: [], ...kinds.roles() },
  { key: 'perms.admin_roles', description: 'Roles that can change settings without Administrator', default: [], ...kinds.roles() },
  { key: 'perms.fallback_permission', description: 'Permission that grants moderator access when no mod roles are set', default: 'moderatemembers', ...kinds.choice(PERMISSION_CHOICES) },
  { key: 'modules.disabled', description: 'Modules turned off in this guild', default: [], hidden: true, parse: (s: string) => s.split(','), format: (v: string[]) => v.join(', ') || 'none' },
];

export class SettingsRegistry {
  private readonly defs = new Map<string, SettingDef>();

  constructor(defs: SettingDef[] = []) {
    for (const d of [...CORE_SETTINGS, ...defs]) {
      if (this.defs.has(d.key)) throw new Error(`setting ${d.key} registered twice`);
      this.defs.set(d.key, d);
    }
  }

  get(key: string): SettingDef | undefined {
    return this.defs.get(key);
  }

  visible(): SettingDef[] {
    return [...this.defs.values()].filter((d) => !d.hidden);
  }

  defaults(): Record<string, SettingValue> {
    return Object.fromEntries([...this.defs.values()].map((d) => [d.key, d.default]));
  }
}

export class GuildSettings {
  readonly values: Record<string, SettingValue>;
  constructor(defaults: Record<string, SettingValue>, stored: Record<string, SettingValue>) {
    this.values = { ...defaults, ...stored };
  }
  get<T extends SettingValue>(key: string): T {
    return this.values[key] as T;
  }
  get maxStrikes(): number {
    return this.get<number>('strikes.max');
  }
  get ladder(): LadderStep[] {
    return this.get<LadderStep[]>('strikes.escalation');
  }
  get logChannel(): string | null {
    return this.get<string | null>('log.channel');
  }
  dmEnabled(action: (typeof DM_ACTIONS)[number]): boolean {
    return this.get<string[]>('notify.dm_on_action').includes(action);
  }
}

export { durationToken };
