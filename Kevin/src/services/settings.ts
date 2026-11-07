import type { Kysely } from 'kysely';
import { GuildSettings, type SettingsRegistry, type SettingValue } from '../core/settings.ts';
import type { Database } from '../storage/schema.ts';

export class SettingsService {
  readonly registry: SettingsRegistry;
  private readonly db: Kysely<Database>;
  private readonly cache = new Map<string, GuildSettings>();

  constructor(db: Kysely<Database>, registry: SettingsRegistry) {
    this.db = db;
    this.registry = registry;
  }

  async get(guildId: string): Promise<GuildSettings> {
    const hit = this.cache.get(guildId);
    if (hit) return hit;
    const rows = await this.db.selectFrom('guild_setting').select(['key', 'value_json']).where('guild_id', '=', guildId).execute();
    const s = new GuildSettings(this.registry.defaults(), Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json) as SettingValue])));
    this.cache.set(guildId, s);
    return s;
  }

  async set(guildId: string, patch: Record<string, SettingValue | undefined>, db: Kysely<Database> = this.db): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        await db.deleteFrom('guild_setting').where('guild_id', '=', guildId).where('key', '=', key).execute();
      } else {
        await db
          .insertInto('guild_setting')
          .values({ guild_id: guildId, key, value_json: JSON.stringify(value) })
          .onConflict((oc) => oc.columns(['guild_id', 'key']).doUpdateSet({ value_json: JSON.stringify(value) }))
          .execute();
      }
    }
    this.cache.delete(guildId);
  }

  invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }
}
