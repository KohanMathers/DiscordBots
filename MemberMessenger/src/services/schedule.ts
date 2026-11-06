import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../core/clock.ts';
import { UserError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { SendError } from '../core/ports.ts';
import type { MentionPolicy } from '../core/text.ts';
import { formatLocal, type LocalDateTime, localToUtc, nextLocal, parseLocal, type Recurrence, upcomingRuns } from '../core/time.ts';
import type { Database, ScheduledMessageTable } from '../storage/schema.ts';
import type { AuditService } from './audit.ts';
import { backoffMs } from './jobs.ts';

export const MAX_SEND_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const MAX_SLEEP_MS = 60_000;

export interface EmbedSpec {
  title?: string;
  color?: number;
  image?: string;
}

export interface ScheduledMessage {
  id: string;
  guildId: string;
  keyword: string;
  channelId: string;
  content: string;
  embed: EmbedSpec | null;
  runAt: string;
  local: LocalDateTime;
  anchorDay: number;
  recurrence: Recurrence | null;
  timezone: string;
  mentions: MentionPolicy;
  status: ScheduledMessageTable['status'];
  attempts: number;
  lastError: string | null;
  createdBy: string;
}

const toMessage = (r: ScheduledMessageTable): ScheduledMessage => ({
  id: r.id,
  guildId: r.guild_id,
  keyword: r.keyword,
  channelId: r.channel_id,
  content: r.content,
  embed: r.embed_json ? (JSON.parse(r.embed_json) as EmbedSpec) : null,
  runAt: r.run_at,
  local: parseLocal(r.local_time),
  anchorDay: Number(r.anchor_day),
  recurrence: (r.recurrence as Recurrence | null) ?? null,
  timezone: r.timezone,
  mentions: JSON.parse(r.allowed_mentions) as MentionPolicy,
  status: r.status,
  attempts: Number(r.attempts),
  lastError: r.last_error,
  createdBy: r.created_by,
});

export interface ScheduleHooks {
  send(m: ScheduledMessage): Promise<void>;
  notifyFailure(m: ScheduledMessage, reason: string): Promise<void>;
  graceHours(guildId: string): Promise<number>;
}

export class ScheduleService {
  private readonly db: Kysely<Database>;
  private readonly clock: Clock;
  private readonly audit: AuditService;
  private readonly log: Logger;
  private hooks: ScheduleHooks | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  lastLagMs = 0;

  constructor(deps: { db: Kysely<Database>; clock: Clock; audit: AuditService; log: Logger }) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.audit = deps.audit;
    this.log = deps.log;
  }

  async create(o: {
    guildId: string;
    keyword: string;
    channelId: string;
    content: string;
    embed: EmbedSpec | null;
    local: LocalDateTime;
    timezone: string;
    recurrence: Recurrence | null;
    mentions: MentionPolicy;
    createdBy: string;
  }): Promise<ScheduledMessage> {
    const keyword = o.keyword.trim();
    if (!keyword || keyword.length > 50) throw new UserError('The keyword must be 1–50 characters');
    if (!o.content.trim() && !o.embed?.title && !o.embed?.image) throw new UserError('The message is empty');
    if (o.content.length > 2000) throw new UserError('The message can be at most 2000 characters');
    const runAt = localToUtc(o.local, o.timezone);
    if (runAt <= this.clock.now().getTime()) throw new UserError('That time is in the past. Pick a time in the future');
    const row: ScheduledMessageTable = {
      id: ulid(this.clock.now().getTime()),
      guild_id: o.guildId,
      keyword,
      channel_id: o.channelId,
      content: o.content,
      embed_json: o.embed ? JSON.stringify(o.embed) : null,
      run_at: new Date(runAt).toISOString(),
      local_time: formatLocal(o.local),
      anchor_day: o.local.day,
      recurrence: o.recurrence,
      timezone: o.timezone,
      allowed_mentions: JSON.stringify(o.mentions),
      status: 'pending',
      attempts: 0,
      last_error: null,
      lease_until: null,
      created_by: o.createdBy,
      created_at: this.clock.now().toISOString(),
      sent_at: null,
    };
    await this.db.transaction().execute(async (trx) => {
      const dup = await trx
        .selectFrom('scheduled_message')
        .select('id')
        .where('guild_id', '=', o.guildId)
        .where('keyword', '=', keyword)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (dup) throw new UserError('Scheduled message already exists, please remove it before adding another.');
      await trx.insertInto('scheduled_message').values(row).execute();
      await this.audit.record({ guildId: o.guildId, actorId: o.createdBy, action: 'schedule.create', target: keyword, payload: { channelId: o.channelId, runAt: row.run_at, timezone: o.timezone, recurrence: o.recurrence } }, trx);
    });
    this.wake();
    return toMessage(row);
  }

  async pending(guildId: string): Promise<ScheduledMessage[]> {
    const rows = await this.db.selectFrom('scheduled_message').selectAll().where('guild_id', '=', guildId).where('status', '=', 'pending').orderBy('run_at').execute();
    return rows.map(toMessage);
  }

  async byKeyword(guildId: string, keyword: string): Promise<ScheduledMessage | undefined> {
    const r = await this.db
      .selectFrom('scheduled_message')
      .selectAll()
      .where('guild_id', '=', guildId)
      .where('status', '=', 'pending')
      .where((eb) => eb(eb.fn('lower', ['keyword']), '=', keyword.trim().toLowerCase()))
      .executeTakeFirst();
    return r ? toMessage(r) : undefined;
  }

  async update(
    m: ScheduledMessage,
    patch: Partial<Pick<ScheduledMessage, 'channelId' | 'content' | 'embed' | 'local' | 'timezone' | 'recurrence' | 'mentions'>>,
    actorId: string,
  ): Promise<ScheduledMessage> {
    const next = { ...m, ...patch };
    const runAt = localToUtc(next.local, next.timezone);
    if ((patch.local || patch.timezone) && runAt <= this.clock.now().getTime()) throw new UserError('That time is in the past. Pick a time in the future');
    await this.db.transaction().execute(async (trx) => {
      const r = await trx
        .updateTable('scheduled_message')
        .set({
          channel_id: next.channelId,
          content: next.content,
          embed_json: next.embed ? JSON.stringify(next.embed) : null,
          local_time: formatLocal(next.local),
          anchor_day: patch.local ? next.local.day : m.anchorDay,
          run_at: new Date(runAt).toISOString(),
          timezone: next.timezone,
          recurrence: next.recurrence,
          allowed_mentions: JSON.stringify(next.mentions),
          attempts: 0,
          last_error: null,
        })
        .where('id', '=', m.id)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw new UserError('That scheduled message has already been sent or cancelled');
      await this.audit.record({ guildId: m.guildId, actorId, action: 'schedule.edit', target: m.keyword, payload: { changed: Object.keys(patch) } }, trx);
    });
    this.wake();
    return { ...next, runAt: new Date(runAt).toISOString() };
  }

  async cancel(m: ScheduledMessage, actorId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('scheduled_message').set({ status: 'cancelled' }).where('id', '=', m.id).where('status', '=', 'pending').execute();
      await this.audit.record({ guildId: m.guildId, actorId, action: 'schedule.cancel', target: m.keyword }, trx);
    });
    this.wake();
  }

  upcoming(m: ScheduledMessage, count = 5): number[] {
    return upcomingRuns(m.recurrence, { ...m.local, day: m.anchorDay }, m.timezone, m.local, this.clock.now().getTime() - 1, count);
  }

  async start(hooks: ScheduleHooks): Promise<void> {
    this.hooks = hooks;
    this.stopped = false;
    await this.db.updateTable('scheduled_message').set({ lease_until: null }).where('status', '=', 'pending').execute();
    await this.recoverOverdue();
    this.wake();
  }

  async recoverOverdue(): Promise<{ missed: number }> {
    const now = this.clock.now().getTime();
    const overdue = await this.db.selectFrom('scheduled_message').selectAll().where('status', '=', 'pending').where('run_at', '<=', new Date(now).toISOString()).execute();
    let missed = 0;
    for (const r of overdue) {
      const m = toMessage(r);
      const grace = (await this.hooks!.graceHours(m.guildId)) * 3_600_000;
      if (now - Date.parse(m.runAt) > grace) {
        missed++;
        await this.finish(m, 'failed', 'missed');
        await this.hooks!.notifyFailure(m, `it was due ${new Date(m.runAt).toISOString()} while the bot was offline, past the ${grace / 3_600_000} h grace window`);
      }
    }
    return { missed };
  }

  wake(): void {
    if (this.stopped || !this.hooks) return;
    if (this.timer) clearTimeout(this.timer);
    void this.nextDueMs().then((due) => {
      if (this.stopped) return;
      const delay = due === null ? MAX_SLEEP_MS : Math.min(Math.max(due - this.clock.now().getTime(), 0), MAX_SLEEP_MS);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.tick(), delay);
    });
  }

  private async nextDueMs(): Promise<number | null> {
    const r = await this.db.selectFrom('scheduled_message').select((eb) => eb.fn.min('run_at').as('next')).where('status', '=', 'pending').executeTakeFirst();
    return r?.next ? Date.parse(r.next as string) : null;
  }

  async tick(): Promise<number> {
    if (this.running) return this.running.then(() => 0);
    let n = 0;
    this.running = (async () => {
      for (const m of await this.claimDue()) {
        await this.deliver(m);
        n++;
      }
    })().finally(() => {
      this.running = null;
      this.wake();
    });
    await this.running;
    return n;
  }

  private async claimDue(): Promise<ScheduledMessage[]> {
    const now = this.clock.now();
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('scheduled_message')
        .selectAll()
        .where('status', '=', 'pending')
        .where('run_at', '<=', now.toISOString())
        .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', now.toISOString())]))
        .orderBy('run_at')
        .limit(50)
        .execute();
      if (rows.length) {
        await trx
          .updateTable('scheduled_message')
          .set({ lease_until: new Date(now.getTime() + LEASE_MS).toISOString() })
          .where('id', 'in', rows.map((r) => r.id))
          .execute();
      }
      return rows.map(toMessage);
    });
  }

  private async deliver(m: ScheduledMessage): Promise<void> {
    const now = this.clock.now().getTime();
    try {
      await this.hooks!.send(m);
      this.lastLagMs = now - Date.parse(m.runAt);
      if (m.recurrence) await this.advance(m);
      else await this.finish(m, 'sent', null);
    } catch (err) {
      const permanent = err instanceof SendError && err.permanent;
      const attempts = m.attempts + 1;
      const reason = err instanceof Error ? err.message : String(err);
      if (permanent || attempts >= MAX_SEND_ATTEMPTS) {
        this.log.warn({ guildId: m.guildId, keyword: m.keyword, reason }, 'scheduled message failed');
        await this.finish(m, 'failed', reason);
        await this.hooks!.notifyFailure(m, reason);
      } else {
        await this.db
          .updateTable('scheduled_message')
          .set({ attempts, last_error: reason, lease_until: null, run_at: new Date(now + backoffMs(attempts)).toISOString() })
          .where('id', '=', m.id)
          .execute();
      }
    }
  }

  private async advance(m: ScheduledMessage): Promise<void> {
    let local = nextLocal(m.recurrence!, m.local, m.anchorDay);
    const now = this.clock.now().getTime();
    while (localToUtc(local, m.timezone) <= now) local = nextLocal(m.recurrence!, local, m.anchorDay);
    await this.db
      .updateTable('scheduled_message')
      .set({ local_time: formatLocal(local), run_at: new Date(localToUtc(local, m.timezone)).toISOString(), attempts: 0, last_error: null, lease_until: null, sent_at: new Date(now).toISOString() })
      .where('id', '=', m.id)
      .execute();
  }

  private async finish(m: ScheduledMessage, status: 'sent' | 'failed', error: string | null) {
    await this.db
      .updateTable('scheduled_message')
      .set({ status, last_error: error, lease_until: null, ...(status === 'sent' ? { sent_at: this.clock.now().toISOString() } : {}) })
      .where('id', '=', m.id)
      .execute();
  }

  async pendingCount(): Promise<number> {
    const r = await this.db.selectFrom('scheduled_message').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'pending').executeTakeFirstOrThrow();
    return Number(r.n);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
