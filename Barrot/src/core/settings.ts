import { UserError } from './errors.ts';
import { resolveZone } from './time.ts';

export type SettingValue = string | number | boolean | null | string[];

export interface SettingSpec<T extends SettingValue = SettingValue> {
  key: string;
  description: string;
  default: T;
  parse(input: string): T;
  format(value: T): string;
  hidden?: boolean;
}

const unset = new Set(['', 'none', 'unset', 'off', 'clear']);
const snowflake = (input: string, what: string) => {
  const id = input.match(/\d{15,22}/)?.[0];
  if (!id) throw new UserError(`Give a ${what} mention or ID`);
  return id;
};

export const kinds = {
  int: (min: number, max: number) => ({
    parse: (s: string) => {
      const n = Number(s.trim());
      if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`Give a whole number from ${min} to ${max}`);
      return n;
    },
    format: (v: number) => String(v),
  }),
  bool: () => ({
    parse: (s: string) => {
      const v = s.trim().toLowerCase();
      if (['on', 'true', 'yes', '1', 'enable', 'enabled'].includes(v)) return true;
      if (['off', 'false', 'no', '0', 'disable', 'disabled'].includes(v)) return false;
      throw new UserError('Give `on` or `off`');
    },
    format: (v: boolean) => (v ? 'on' : 'off'),
  }),
  channel: () => ({
    parse: (s: string): string | null => (unset.has(s.trim().toLowerCase()) ? null : snowflake(s, 'channel')),
    format: (v: string | null) => (v ? `<#${v}>` : '*not set*'),
  }),
  channels: () => ({
    parse: (s: string): string[] => [...new Set(s.match(/\d{15,22}/g) ?? [])],
    format: (v: string[]) => (v.length ? v.map((c) => `<#${c}>`).join(' ') : '*all channels*'),
  }),
  role: () => ({
    parse: (s: string): string | null => (unset.has(s.trim().toLowerCase()) ? null : snowflake(s, 'role')),
    format: (v: string | null) => (v ? `<@&${v}>` : '*not set*'),
  }),
  roles: () => ({
    parse: (s: string): string[] => [...new Set(s.match(/\d{15,22}/g) ?? [])],
    format: (v: string[]) => (v.length ? v.map((r) => `<@&${r}>`).join(' ') : '*none*'),
  }),
  zone: () => ({ parse: (s: string) => resolveZone(s), format: (v: string) => `\`${v}\`` }),
};

export class SettingsRegistry {
  private readonly specs = new Map<string, SettingSpec>();
  constructor(specs: SettingSpec<any>[]) {
    for (const s of specs) {
      if (this.specs.has(s.key)) throw new Error(`setting ${s.key} registered twice`);
      this.specs.set(s.key, s);
    }
  }
  get(key: string) {
    return this.specs.get(key);
  }
  visible() {
    return [...this.specs.values()].filter((s) => !s.hidden);
  }
  defaults(): Record<string, SettingValue> {
    return Object.fromEntries([...this.specs.values()].map((s) => [s.key, s.default]));
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
  get logChannel(): string | null {
    return this.get('log.channel');
  }
  get timezone(): string {
    return this.get('timezone');
  }
}

export const CORE_SETTINGS: SettingSpec<any>[] = [
  { key: 'log.channel', description: 'Channel for the audit log (locks, purges, auto-response and schedule changes)', default: null, ...kinds.channel() },
  { key: 'timezone', description: 'Default time zone for scheduled messages (IANA name, e.g. Europe/London)', default: 'UTC', ...kinds.zone() },
  { key: 'mentions.allow_mass', description: 'Allow @everyone, @here and role pings in auto-responses and scheduled messages (authors also need Mention Everyone)', default: false, ...kinds.bool() },
];

export const moduleToggle = (id: string, name: string): SettingSpec<boolean> => ({
  key: `module.${id}.enabled`,
  description: `Turn the ${name} module on or off in this server`,
  default: true,
  ...kinds.bool(),
});
