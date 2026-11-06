import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Clock } from '../core/clock.ts';
import { filterAccepts, isAnnounceable, type DetectionPolicy } from '../core/rules.ts';
import type { FirstSyncMode, SourceEvent, SourceRef } from '../core/types.ts';
import {
  DEFAULT_GUILD_SETTINGS,
  type Database,
  type GuildSettings,
  type SourceTable,
  type SubscriptionFilters,
  type SubscriptionState,
} from './schema.ts';

export interface StoredSource extends SourceRef {
  id: string;
  lastPolledAt: string | null;
  lastError: string | null;
}

export interface GuildConfig {
  guildId: string;
  logChannelId: string | null;
  settings: GuildSettings;
  defaultChannels: Record<string, string>;
}

export interface SubscriptionView {
  id: string;
  guildId: string;
  channelId: string | null;
  roleId: string | null;
  filters: SubscriptionFilters | null;
  state: SubscriptionState;
  createdAt: string;
  source: StoredSource;
}

export interface DueDelivery {
  id: string;
  attempts: number;
  subscriptionId: string;
  guildId: string;
  channelId: string | null;
  roleId: string | null;
  logChannelId: string | null;
  crosspost: boolean;
  source: StoredSource;
  event: SourceEvent;
}

export interface DetectionResult {
  newItems: number;
  deliveriesCreated: number;
}

const toSource = (row: SourceTable): StoredSource => ({
  id: row.id,
  provider: row.provider,
  externalId: row.external_id,
  displayName: row.display_name,
  handle: row.handle,
  avatarUrl: row.avatar_url,
  url: row.url,
  lastPolledAt: row.last_polled_at,
  lastError: row.last_error,
});

const parseJson = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

export class Store {
  readonly db: Kysely<Database>;
  private readonly clock: Clock;

  constructor(db: Kysely<Database>, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  async ensureGuild(guildId: string): Promise<void> {
    await this.db
      .insertInto('guild')
      .values({
        guild_id: guildId,
        log_channel_id: null,
        settings: JSON.stringify(DEFAULT_GUILD_SETTINGS),
        created_at: this.now(),
        left_at: null,
      })
      .onConflict((oc) => oc.column('guild_id').doUpdateSet({ left_at: null }))
      .execute();
  }

  async markGuildLeft(guildId: string): Promise<void> {
    await this.db.updateTable('guild').set({ left_at: this.now() }).where('guild_id', '=', guildId).execute();
  }

  async getGuild(guildId: string): Promise<GuildConfig> {
    await this.ensureGuild(guildId);
    const row = await this.db
      .selectFrom('guild')
      .selectAll()
      .where('guild_id', '=', guildId)
      .executeTakeFirstOrThrow();
    const channels = await this.db
      .selectFrom('guild_channel')
      .select(['provider', 'channel_id'])
      .where('guild_id', '=', guildId)
      .execute();
    return {
      guildId,
      logChannelId: row.log_channel_id,
      settings: { ...DEFAULT_GUILD_SETTINGS, ...parseJson<Partial<GuildSettings>>(row.settings, {}) },
      defaultChannels: Object.fromEntries(channels.map((c) => [c.provider, c.channel_id])),
    };
  }

  async setDefaultChannel(guildId: string, provider: string, channelId: string): Promise<void> {
    await this.ensureGuild(guildId);
    await this.db
      .insertInto('guild_channel')
      .values({ guild_id: guildId, provider, channel_id: channelId })
      .onConflict((oc) => oc.columns(['guild_id', 'provider']).doUpdateSet({ channel_id: channelId }))
      .execute();
    await this.db
      .updateTable('subscription')
      .set({ state: 'active' })
      .where('guild_id', '=', guildId)
      .where('state', '=', 'broken')
      .where('channel_id', 'is', null)
      .where('source_id', 'in', (qb) => qb.selectFrom('source').select('id').where('provider', '=', provider))
      .execute();
  }

  async setLogChannel(guildId: string, channelId: string | null): Promise<void> {
    await this.ensureGuild(guildId);
    await this.db
      .updateTable('guild')
      .set({ log_channel_id: channelId })
      .where('guild_id', '=', guildId)
      .execute();
  }

  async updateGuildSettings(guildId: string, patch: Partial<GuildSettings>): Promise<void> {
    const current = await this.getGuild(guildId);
    await this.db
      .updateTable('guild')
      .set({ settings: JSON.stringify({ ...current.settings, ...patch }) })
      .where('guild_id', '=', guildId)
      .execute();
  }

  async upsertSource(ref: SourceRef): Promise<StoredSource> {
    await this.db
      .insertInto('source')
      .values({
        id: randomUUID(),
        provider: ref.provider,
        external_id: ref.externalId,
        display_name: ref.displayName,
        handle: ref.handle,
        avatar_url: ref.avatarUrl,
        url: ref.url,
        last_polled_at: null,
        last_error: null,
        created_at: this.now(),
      })
      .onConflict((oc) =>
        oc.columns(['provider', 'external_id']).doUpdateSet({
          display_name: ref.displayName,
          handle: ref.handle,
          avatar_url: ref.avatarUrl,
          url: ref.url,
        }),
      )
      .execute();
    const row = await this.db
      .selectFrom('source')
      .selectAll()
      .where('provider', '=', ref.provider)
      .where('external_id', '=', ref.externalId)
      .executeTakeFirstOrThrow();
    return toSource(row);
  }

  async updateSourceDisplay(refs: SourceRef[]): Promise<void> {
    for (const ref of refs) {
      await this.db
        .updateTable('source')
        .set({
          display_name: ref.displayName,
          handle: ref.handle,
          ...(ref.avatarUrl ? { avatar_url: ref.avatarUrl } : {}),
          url: ref.url,
        })
        .where('provider', '=', ref.provider)
        .where('external_id', '=', ref.externalId)
        .execute();
    }
  }

  async activeSources(provider: string): Promise<StoredSource[]> {
    const rows = await this.db
      .selectFrom('source')
      .selectAll()
      .where('provider', '=', provider)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('subscription')
            .innerJoin('guild', 'guild.guild_id', 'subscription.guild_id')
            .select('subscription.id')
            .whereRef('subscription.source_id', '=', 'source.id')
            .where('subscription.state', '=', 'active')
            .where('guild.left_at', 'is', null),
        ),
      )
      .execute();
    return rows.map(toSource);
  }

  async markPolled(sourceIds: string[], error: string | null): Promise<void> {
    if (sourceIds.length === 0) return;
    await this.db
      .updateTable('source')
      .set({ last_polled_at: this.now(), last_error: error })
      .where('id', 'in', sourceIds)
      .execute();
  }

  async upsertSubscription(input: {
    guildId: string;
    sourceId: string;
    channelId: string | null;
    roleId: string | null;
    filters: SubscriptionFilters | null;
    createdBy: string;
  }): Promise<{ id: string; created: boolean }> {
    await this.ensureGuild(input.guildId);
    const existing = await this.db
      .selectFrom('subscription')
      .select('id')
      .where('guild_id', '=', input.guildId)
      .where('source_id', '=', input.sourceId)
      .executeTakeFirst();
    const filters = input.filters ? JSON.stringify(input.filters) : null;
    if (existing) {
      await this.db
        .updateTable('subscription')
        .set({ channel_id: input.channelId, role_id: input.roleId, filters, state: 'active' })
        .where('id', '=', existing.id)
        .execute();
      return { id: existing.id, created: false };
    }
    const id = randomUUID();
    await this.db
      .insertInto('subscription')
      .values({
        id,
        guild_id: input.guildId,
        source_id: input.sourceId,
        channel_id: input.channelId,
        role_id: input.roleId,
        template: null,
        filters,
        state: 'active',
        created_by: input.createdBy,
        created_at: this.now(),
      })
      .execute();
    return { id, created: true };
  }

  async listSubscriptions(guildId: string, provider?: string): Promise<SubscriptionView[]> {
    let q = this.db
      .selectFrom('subscription')
      .innerJoin('source', 'source.id', 'subscription.source_id')
      .selectAll('source')
      .select([
        'subscription.id as sub_id',
        'subscription.guild_id as sub_guild_id',
        'subscription.channel_id as sub_channel_id',
        'subscription.role_id as sub_role_id',
        'subscription.filters as sub_filters',
        'subscription.state as sub_state',
        'subscription.created_at as sub_created_at',
      ])
      .where('subscription.guild_id', '=', guildId)
      .orderBy('source.display_name');
    if (provider) q = q.where('source.provider', '=', provider);
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.sub_id,
      guildId: r.sub_guild_id,
      channelId: r.sub_channel_id,
      roleId: r.sub_role_id,
      filters: parseJson<SubscriptionFilters | null>(r.sub_filters, null),
      state: r.sub_state,
      createdAt: r.sub_created_at,
      source: toSource(r),
    }));
  }

  async getSubscription(guildId: string, subscriptionId: string): Promise<SubscriptionView | undefined> {
    const all = await this.listSubscriptions(guildId);
    return all.find((s) => s.id === subscriptionId);
  }

  async removeSubscription(guildId: string, subscriptionId: string): Promise<boolean> {
    const res = await this.db
      .deleteFrom('subscription')
      .where('guild_id', '=', guildId)
      .where('id', '=', subscriptionId)
      .executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }

  async breakSubscription(subscriptionId: string, reason: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('subscription')
        .set({ state: 'broken' })
        .where('id', '=', subscriptionId)
        .where('state', '=', 'active')
        .executeTakeFirst();
      await trx
        .updateTable('delivery')
        .set({ status: 'failed', last_error: `subscription paused: ${reason}` })
        .where('subscription_id', '=', subscriptionId)
        .where('status', '=', 'pending')
        .execute();
      return Number(res.numUpdatedRows) > 0;
    });
  }

  async setSubscriptionState(subscriptionId: string, state: SubscriptionState): Promise<void> {
    await this.db.updateTable('subscription').set({ state }).where('id', '=', subscriptionId).execute();
  }

  async seenItemKeys(sourceIds: string[]): Promise<Set<string>> {
    const keys = new Set<string>();
    for (let i = 0; i < sourceIds.length; i += 500) {
      const rows = await this.db
        .selectFrom('seen_item')
        .select(['source_id', 'item_id'])
        .where('source_id', 'in', sourceIds.slice(i, i + 500))
        .execute();
      for (const r of rows) keys.add(`${r.source_id}\u0000${r.item_id}`);
    }
    return keys;
  }

  async recordDetection(
    source: StoredSource,
    events: SourceEvent[],
    opts: { firstSync: FirstSyncMode; maxAgeMs: number },
  ): Promise<DetectionResult> {
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    const policy: DetectionPolicy = {
      firstPoll: source.lastPolledAt === null,
      firstSync: opts.firstSync,
      maxAgeMs: opts.maxAgeMs,
      now: nowDate,
    };

    return this.db.transaction().execute(async (trx) => {
      let newItems = 0;
      let deliveriesCreated = 0;
      let subs: Array<{ id: string; filters: string | null }> | undefined;

      for (const event of events) {
        const inserted = await trx
          .insertInto('seen_item')
          .values({
            source_id: source.id,
            item_id: event.itemId,
            kind: event.kind,
            payload: JSON.stringify(event),
            first_seen_at: now,
          })
          .onConflict((oc) => oc.columns(['source_id', 'item_id']).doNothing())
          .returning('item_id')
          .execute();
        if (inserted.length === 0) continue;
        newItems++;
        if (!isAnnounceable(event, policy)) continue;

        subs ??= await trx
          .selectFrom('subscription')
          .innerJoin('guild', 'guild.guild_id', 'subscription.guild_id')
          .select(['subscription.id', 'subscription.filters'])
          .where('subscription.source_id', '=', source.id)
          .where('subscription.state', '=', 'active')
          .where('guild.left_at', 'is', null)
          .execute();

        for (const sub of subs) {
          if (!filterAccepts(parseJson<SubscriptionFilters | null>(sub.filters, null), event.kind)) continue;
          const created = await trx
            .insertInto('delivery')
            .values(newDelivery(sub.id, event.itemId, now))
            .onConflict((oc) => oc.columns(['subscription_id', 'item_id']).doNothing())
            .returning('id')
            .execute();
          deliveriesCreated += created.length;
        }
      }

      await trx
        .updateTable('source')
        .set({ last_polled_at: now, last_error: null })
        .where('id', '=', source.id)
        .execute();
      return { newItems, deliveriesCreated };
    });
  }

  async queueDelivery(subscriptionId: string, sourceId: string, event: SourceEvent): Promise<boolean> {
    const now = this.now();
    return this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('seen_item')
        .values({
          source_id: sourceId,
          item_id: event.itemId,
          kind: event.kind,
          payload: JSON.stringify(event),
          first_seen_at: now,
        })
        .onConflict((oc) => oc.columns(['source_id', 'item_id']).doNothing())
        .execute();
      const created = await trx
        .insertInto('delivery')
        .values(newDelivery(subscriptionId, event.itemId, now))
        .onConflict((oc) => oc.columns(['subscription_id', 'item_id']).doNothing())
        .returning('id')
        .execute();
      return created.length > 0;
    });
  }

  async seedSentDelivery(subscriptionId: string, itemId: string): Promise<void> {
    const now = this.now();
    await this.db
      .insertInto('delivery')
      .values({ ...newDelivery(subscriptionId, itemId, now), status: 'sent', sent_at: now })
      .onConflict((oc) => oc.columns(['subscription_id', 'item_id']).doNothing())
      .execute();
  }

  async dueDeliveries(limit: number): Promise<DueDelivery[]> {
    const rows = await this.db
      .selectFrom('delivery')
      .innerJoin('subscription', 'subscription.id', 'delivery.subscription_id')
      .innerJoin('source', 'source.id', 'subscription.source_id')
      .innerJoin('guild', 'guild.guild_id', 'subscription.guild_id')
      .innerJoin('seen_item', (j) =>
        j.onRef('seen_item.source_id', '=', 'source.id').onRef('seen_item.item_id', '=', 'delivery.item_id'),
      )
      .leftJoin('guild_channel', (j) =>
        j
          .onRef('guild_channel.guild_id', '=', 'subscription.guild_id')
          .onRef('guild_channel.provider', '=', 'source.provider'),
      )
      .selectAll('source')
      .select([
        'delivery.id as delivery_id',
        'delivery.attempts',
        'subscription.id as sub_id',
        'subscription.guild_id as sub_guild_id',
        'subscription.channel_id as sub_channel_id',
        'subscription.role_id as sub_role_id',
        'guild.log_channel_id',
        'guild.settings as guild_settings',
        'guild_channel.channel_id as default_channel_id',
        'seen_item.payload',
      ])
      .where('delivery.status', '=', 'pending')
      .where('delivery.next_attempt_at', '<=', this.now())
      .where('subscription.state', '=', 'active')
      .where('guild.left_at', 'is', null)
      .orderBy('delivery.created_at')
      .limit(limit)
      .execute();

    return rows.map((r) => ({
      id: r.delivery_id,
      attempts: Number(r.attempts),
      subscriptionId: r.sub_id,
      guildId: r.sub_guild_id,
      channelId: r.sub_channel_id ?? r.default_channel_id ?? null,
      roleId: r.sub_role_id,
      logChannelId: r.log_channel_id,
      crosspost: { ...DEFAULT_GUILD_SETTINGS, ...parseJson<Partial<GuildSettings>>(r.guild_settings, {}) }
        .crosspost,
      source: toSource(r),
      event: JSON.parse(r.payload) as SourceEvent,
    }));
  }

  async markDeliverySent(id: string, attempts: number, messageId: string): Promise<void> {
    await this.db
      .updateTable('delivery')
      .set({ status: 'sent', attempts, discord_message_id: messageId, sent_at: this.now(), last_error: null })
      .where('id', '=', id)
      .execute();
  }

  async markDeliveryRetry(id: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void> {
    await this.db
      .updateTable('delivery')
      .set({ attempts, next_attempt_at: nextAttemptAt.toISOString(), last_error: error })
      .where('id', '=', id)
      .execute();
  }

  async markDeliveryFailed(id: string, attempts: number, error: string): Promise<void> {
    await this.db
      .updateTable('delivery')
      .set({ status: 'failed', attempts, last_error: error })
      .where('id', '=', id)
      .execute();
  }

  async pendingDeliveryCount(): Promise<number> {
    const r = await this.db
      .selectFrom('delivery')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  async prune(retentionDays = 30): Promise<Record<string, number>> {
    const cutoff = daysAgo(this.clock.now(), retentionDays);
    const seen = await this.db.deleteFrom('seen_item').where('first_seen_at', '<', cutoff).executeTakeFirst();
    const deliveries = await this.db
      .deleteFrom('delivery')
      .where('created_at', '<', cutoff)
      .where('status', '!=', 'pending')
      .executeTakeFirst();
    const guilds = await this.db
      .deleteFrom('guild')
      .where('left_at', 'is not', null)
      .where('left_at', '<', cutoff)
      .executeTakeFirst();
    const orphans = await this.db
      .deleteFrom('source')
      .where((eb) =>
        eb.not(eb.exists(eb.selectFrom('subscription').select('id').whereRef('subscription.source_id', '=', 'source.id'))),
      )
      .executeTakeFirst();
    return {
      seenItems: Number(seen.numDeletedRows),
      deliveries: Number(deliveries.numDeletedRows),
      guilds: Number(guilds.numDeletedRows),
      sources: Number(orphans.numDeletedRows),
    };
  }

  async counts(): Promise<{ guilds: number; sourcesByProvider: Record<string, number>; broken: number }> {
    const guilds = await this.db
      .selectFrom('guild')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('left_at', 'is', null)
      .executeTakeFirstOrThrow();
    const sources = await this.db
      .selectFrom('source')
      .select(['provider', (eb) => eb.fn.countAll<number>().as('n')])
      .groupBy('provider')
      .execute();
    const broken = await this.db
      .selectFrom('subscription')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('state', '=', 'broken')
      .executeTakeFirstOrThrow();
    return {
      guilds: Number(guilds.n),
      sourcesByProvider: Object.fromEntries(sources.map((s) => [s.provider, Number(s.n)])),
      broken: Number(broken.n),
    };
  }

  async getMeta(key: string): Promise<string | undefined> {
    const r = await this.db.selectFrom('meta').select('value').where('key', '=', key).executeTakeFirst();
    return r?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db
      .insertInto('meta')
      .values({ key, value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute();
  }
}

function newDelivery(subscriptionId: string, itemId: string, now: string) {
  return {
    id: randomUUID(),
    subscription_id: subscriptionId,
    item_id: itemId,
    status: 'pending' as const,
    attempts: 0,
    next_attempt_at: now,
    last_error: null,
    discord_message_id: null,
    created_at: now,
    sent_at: null,
  };
}
