import type { Logger } from 'pino';
import type { Store, StoredSource } from '../storage/store.ts';
import type { Metrics } from './metrics.ts';
import { filterAccepts, isAnnounceable } from './rules.ts';
import type { PollContext, Provider, SourceEvent } from './types.ts';
import type { Clock } from './clock.ts';

export interface PollOutcome {
  provider: string;
  at: string;
  ok: boolean;
  sources: number;
  newItems: number;
  deliveries: number;
  errors: number;
  message?: string;
}

export class Detector {
  readonly lastOutcome = new Map<string, PollOutcome>();
  private readonly store: Store;
  private readonly metrics: Metrics;
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly maxAgeMs: number;

  constructor(deps: { store: Store; metrics: Metrics; log: Logger; clock: Clock; maxAgeMs: number }) {
    this.store = deps.store;
    this.metrics = deps.metrics;
    this.log = deps.log;
    this.clock = deps.clock;
    this.maxAgeMs = deps.maxAgeMs;
  }

  async pollProvider(provider: Provider): Promise<PollOutcome> {
    const at = this.clock.now().toISOString();
    const sources = await this.store.activeSources(provider.id);
    const outcome: PollOutcome = {
      provider: provider.id,
      at,
      ok: true,
      sources: sources.length,
      newItems: 0,
      deliveries: 0,
      errors: 0,
    };
    if (sources.length === 0) {
      this.lastOutcome.set(provider.id, outcome);
      return outcome;
    }

    try {
      const result = await provider.poll(sources, await this.pollContext(sources));
      if (result.updatedRefs.length) await this.store.updateSourceDisplay(result.updatedRefs);

      const failed = new Map(result.errors.map((e) => [e.externalId, e.error]));
      const byExternal = groupBy(result.events, (e) => e.externalId);
      for (const source of sources) {
        const error = failed.get(source.externalId);
        if (error !== undefined) {
          outcome.errors++;
          await this.store.markPolled([source.id], error);
          continue;
        }
        const r = await this.store.recordDetection(source, byExternal.get(source.externalId) ?? [], {
          firstSync: provider.firstSync,
          maxAgeMs: this.maxAgeMs,
        });
        outcome.newItems += r.newItems;
        outcome.deliveries += r.deliveriesCreated;
      }
      this.metrics.inc('announcer_polls_total', { provider: provider.id, result: 'ok' });
      this.metrics.inc('announcer_items_detected_total', { provider: provider.id }, outcome.newItems);
    } catch (err) {
      outcome.ok = false;
      outcome.message = err instanceof Error ? err.message : String(err);
      this.metrics.inc('announcer_polls_total', { provider: provider.id, result: 'error' });
      this.log.error({ err, provider: provider.id }, 'poll failed');
    }

    if (outcome.deliveries > 0 || outcome.errors > 0) {
      this.log.info(outcome, 'poll finished');
    } else {
      this.log.debug(outcome, 'poll finished');
    }
    this.lastOutcome.set(provider.id, outcome);
    return outcome;
  }

  private async pollContext(sources: StoredSource[]): Promise<PollContext> {
    const seen = await this.store.seenItemKeys(sources.map((s) => s.id));
    const byExternal = new Map(sources.map((s) => [s.externalId, s]));
    return {
      isKnown: (externalId, itemId) => {
        const s = byExternal.get(externalId);
        return s ? seen.has(`${s.id}\u0000${itemId}`) : false;
      },
      isFirstPoll: (externalId) => byExternal.get(externalId)?.lastPolledAt === null,
      maxAgeMs: this.maxAgeMs,
      now: this.clock.now(),
    };
  }

  async syncNewSubscription(
    provider: Provider,
    source: StoredSource,
    subscriptionId: string,
    filters: { kinds: string[] } | null,
  ): Promise<number> {
    const result = await provider.poll([source], await this.pollContext([source]));
    const events = result.events.filter((e) => e.externalId === source.externalId);
    await this.store.recordDetection(source, events, { firstSync: provider.firstSync, maxAgeMs: this.maxAgeMs });
    if (provider.firstSync !== 'announce-current') return 0;

    let queued = 0;
    const policy = { firstPoll: false, firstSync: provider.firstSync, maxAgeMs: this.maxAgeMs, now: this.clock.now() };
    for (const event of events) {
      if (!isAnnounceable(event, policy) || !filterAccepts(filters, event.kind)) continue;
      if (await this.store.queueDelivery(subscriptionId, source.id, event)) queued++;
    }
    return queued;
  }
}

function groupBy(events: SourceEvent[], key: (e: SourceEvent) => string): Map<string, SourceEvent[]> {
  const map = new Map<string, SourceEvent[]>();
  for (const e of events) {
    const k = key(e);
    const list = map.get(k);
    if (list) list.push(e);
    else map.set(k, [e]);
  }
  return map;
}
