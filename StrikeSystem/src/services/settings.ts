import type { Kysely } from 'kysely';
import type { Clock } from '../core/clock.ts';
import { GuildSettings, type SettingsRegistry, type SettingValue } from '../core/settings.ts';
import type { Database } from '../storage/schema.ts';

export class SettingsService {
  private readonly cache = new Map<string, GuildSettings>();
  readonly registry: SettingsRegistry;
  private readonly db: Kysely<Database>;
  private readonly clock: Clock;

  constructor(db: Kysely<Database>, registry: SettingsRegistry, clock: Clock) {
    this.db = db;
    this.registry = registry;
    this.clock = clock;
  }

  async get(guildId: string): Promise<GuildSettings> {
    const hit = this.cache.get(guildId);
    if (hit) return hit;
    const row = await this.db.selectFrom('guild_settings').select('data').where('guild_id', '=', guildId).executeTakeFirst();
    const stored = row ? (JSON.parse(row.data) as Record<string, SettingValue>) : {};
    const s = new GuildSettings(this.registry.defaults(), stored);
    this.cache.set(guildId, s);
    return s;
  }

  async update(guildId: string, patch: Record<string, SettingValue | undefined>, db: Kysely<Database> = this.db) {
    const row = await db.selectFrom('guild_settings').select('data').where('guild_id', '=', guildId).executeTakeFirst();
    const stored = row ? (JSON.parse(row.data) as Record<string, SettingValue>) : {};
    const before: Record<string, SettingValue> = {};
    const current = new GuildSettings(this.registry.defaults(), stored);
    for (const [k, v] of Object.entries(patch)) {
      before[k] = current.get(k);
      if (v === undefined) delete stored[k];
      else stored[k] = v;
    }
    await db
      .insertInto('guild_settings')
      .values({ guild_id: guildId, data: JSON.stringify(stored), updated_at: this.clock.now().toISOString() })
      .onConflict((oc) => oc.column('guild_id').doUpdateSet({ data: JSON.stringify(stored), updated_at: this.clock.now().toISOString() }))
      .execute();
    this.cache.delete(guildId);
    return before;
  }

  invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }

  async guildsWhere(key: string, value: SettingValue): Promise<string[]> {
    const rows = await this.db.selectFrom('guild_settings').select(['guild_id', 'data']).execute();
    return rows.filter((r) => (JSON.parse(r.data) as Record<string, SettingValue>)[key] === value).map((r) => r.guild_id);
  }
}
