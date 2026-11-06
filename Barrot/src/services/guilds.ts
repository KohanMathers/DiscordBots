import type { Kysely } from 'kysely';
import type { Clock } from '../core/clock.ts';
import type { Database } from '../storage/schema.ts';

export class GuildService {
  private readonly db: Kysely<Database>;
  private readonly clock: Clock;

  constructor(db: Kysely<Database>, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  async ensure(guildId: string): Promise<void> {
    await this.db
      .insertInto('guild')
      .values({ guild_id: guildId, created_at: this.clock.now().toISOString(), left_at: null })
      .onConflict((oc) => oc.column('guild_id').doUpdateSet({ left_at: null }))
      .execute();
  }

  async markLeft(guildId: string): Promise<void> {
    await this.db.updateTable('guild').set({ left_at: this.clock.now().toISOString() }).where('guild_id', '=', guildId).execute();
  }

  async purgeGone(days: number): Promise<string[]> {
    const cutoff = new Date(this.clock.now().getTime() - days * 86_400_000).toISOString();
    const gone = await this.db.selectFrom('guild').select('guild_id').where('left_at', 'is not', null).where('left_at', '<', cutoff).execute();
    for (const { guild_id } of gone) await this.deleteAll(guild_id);
    return gone.map((g) => g.guild_id);
  }

  async deleteAll(guildId: string, keepGuildRow = false): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('jobs').where('guild_id', '=', guildId).execute();
      await trx.deleteFrom('guild').where('guild_id', '=', guildId).execute();
      if (keepGuildRow) await trx.insertInto('guild').values({ guild_id: guildId, created_at: this.clock.now().toISOString(), left_at: null }).execute();
    });
  }
}
