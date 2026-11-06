import type { Kysely } from 'kysely';
import type { Clock } from '../../core/clock.ts';
import type { Priority, TicketDatabase, TicketTable } from './schema.ts';

export class TicketStore {
  private readonly db: Kysely<TicketDatabase>;
  private readonly clock: Clock;

  constructor(db: Kysely<TicketDatabase>, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  async create(o: { guildId: string; channelId: string; creatorId: string; type: string; subject: string; description: string; priority: Priority }): Promise<TicketTable> {
    return this.db.transaction().execute(async (trx) => {
      const last = await trx.selectFrom('ticket').select((eb) => eb.fn.max('number').as('n')).where('guild_id', '=', o.guildId).executeTakeFirst();
      const row: TicketTable = {
        guild_id: o.guildId,
        number: Number(last?.n ?? 0) + 1,
        channel_id: o.channelId,
        creator_id: o.creatorId,
        type: o.type,
        subject: o.subject,
        description: o.description,
        priority: o.priority,
        status: 'open',
        claimed_by: null,
        control_message_id: null,
        created_at: this.clock.now().toISOString(),
        closed_at: null,
        closed_by: null,
        close_reason: null,
      };
      await trx.insertInto('ticket').values(row).execute();
      return row;
    });
  }

  async discard(guildId: string, n: number): Promise<void> {
    await this.db.deleteFrom('ticket').where('guild_id', '=', guildId).where('number', '=', n).where('channel_id', '=', '').execute();
  }

  async byChannel(channelId: string): Promise<TicketTable | undefined> {
    return this.db.selectFrom('ticket').selectAll().where('channel_id', '=', channelId).where('status', '!=', 'deleted').executeTakeFirst();
  }

  async byNumber(guildId: string, n: number): Promise<TicketTable | undefined> {
    return this.db.selectFrom('ticket').selectAll().where('guild_id', '=', guildId).where('number', '=', n).executeTakeFirst();
  }

  async update(guildId: string, n: number, patch: Partial<Omit<TicketTable, 'guild_id' | 'number'>>): Promise<void> {
    await this.db.updateTable('ticket').set(patch).where('guild_id', '=', guildId).where('number', '=', n).execute();
  }

  async markClosed(guildId: string, n: number, by: string, reason: string | null): Promise<boolean> {
    const r = await this.db
      .updateTable('ticket')
      .set({ status: 'closed', closed_at: this.clock.now().toISOString(), closed_by: by, close_reason: reason })
      .where('guild_id', '=', guildId)
      .where('number', '=', n)
      .where('status', '=', 'open')
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  async openCountFor(guildId: string, userId: string): Promise<number> {
    const r = await this.db.selectFrom('ticket').select((eb) => eb.fn.countAll<number>().as('n')).where('guild_id', '=', guildId).where('creator_id', '=', userId).where('status', '=', 'open').executeTakeFirstOrThrow();
    return Number(r.n);
  }

  async list(guildId: string, status: TicketTable['status']): Promise<TicketTable[]> {
    return this.db.selectFrom('ticket').selectAll().where('guild_id', '=', guildId).where('status', '=', status).orderBy('number', 'desc').limit(50).execute();
  }

  async members(guildId: string, n: number): Promise<string[]> {
    return (await this.db.selectFrom('ticket_member').select('user_id').where('guild_id', '=', guildId).where('number', '=', n).execute()).map((r) => r.user_id);
  }

  async addMember(guildId: string, n: number, userId: string, by: string): Promise<void> {
    await this.db.insertInto('ticket_member').values({ guild_id: guildId, number: n, user_id: userId, added_by: by, added_at: this.clock.now().toISOString() }).orIgnore().execute();
  }

  async removeMember(guildId: string, n: number, userId: string): Promise<boolean> {
    const r = await this.db.deleteFrom('ticket_member').where('guild_id', '=', guildId).where('number', '=', n).where('user_id', '=', userId).executeTakeFirst();
    return Number(r.numDeletedRows) > 0;
  }

  async exportAll(guildId: string) {
    return {
      tickets: await this.db.selectFrom('ticket').selectAll().where('guild_id', '=', guildId).orderBy('number').execute(),
      members: await this.db.selectFrom('ticket_member').selectAll().where('guild_id', '=', guildId).execute(),
    };
  }
}
