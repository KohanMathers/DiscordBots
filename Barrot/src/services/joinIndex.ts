import type { Kysely } from 'kysely';
import type { Database } from '../storage/schema.ts';

export interface JoinRecord {
  userId: string;
  joinedAt: string;
  isBot: boolean;
}

export class JoinIndex {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  async add(guildId: string, r: JoinRecord): Promise<void> {
    await this.db
      .insertInto('member_join')
      .values({ guild_id: guildId, user_id: r.userId, joined_at: r.joinedAt, is_bot: r.isBot ? 1 : 0 })
      .onConflict((oc) => oc.columns(['guild_id', 'user_id']).doUpdateSet({ joined_at: r.joinedAt, is_bot: r.isBot ? 1 : 0 }))
      .execute();
  }

  async remove(guildId: string, userId: string): Promise<void> {
    await this.db.deleteFrom('member_join').where('guild_id', '=', guildId).where('user_id', '=', userId).execute();
  }

  async replaceAll(guildId: string, members: JoinRecord[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('member_join').where('guild_id', '=', guildId).execute();
      for (let i = 0; i < members.length; i += 500) {
        await trx
          .insertInto('member_join')
          .values(members.slice(i, i + 500).map((m) => ({ guild_id: guildId, user_id: m.userId, joined_at: m.joinedAt, is_bot: m.isBot ? 1 : 0 })))
          .execute();
      }
    });
  }

  async position(guildId: string, userId: string): Promise<number | null> {
    const me = await this.db.selectFrom('member_join').selectAll().where('guild_id', '=', guildId).where('user_id', '=', userId).executeTakeFirst();
    if (!me || me.is_bot) return null;
    const r = await this.db
      .selectFrom('member_join')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('guild_id', '=', guildId)
      .where('is_bot', '=', 0)
      .where((eb) => eb.or([eb('joined_at', '<', me.joined_at), eb.and([eb('joined_at', '=', me.joined_at), eb('user_id', '<', userId)])]))
      .executeTakeFirstOrThrow();
    return Number(r.n) + 1;
  }

  async counts(guildId: string): Promise<{ humans: number; bots: number } | null> {
    const rows = await this.db
      .selectFrom('member_join')
      .select(['is_bot', (eb) => eb.fn.countAll<number>().as('n')])
      .where('guild_id', '=', guildId)
      .groupBy('is_bot')
      .execute();
    if (!rows.length) return null;
    return { humans: Number(rows.find((r) => !r.is_bot)?.n ?? 0), bots: Number(rows.find((r) => r.is_bot)?.n ?? 0) };
  }
}
