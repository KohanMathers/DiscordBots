import type { Logger } from 'pino';
import type { DueDelivery, Store } from '../storage/store.ts';
import { nextRetryDelayMs } from './backoff.ts';
import type { Clock } from './clock.ts';
import type { Metrics } from './metrics.ts';
import { SendError, type Sender } from './sender.ts';
import type { Provider } from './types.ts';

export class Dispatcher {
  private readonly store: Store;
  private readonly sender: Sender;
  private readonly providers: Map<string, Provider>;
  private readonly metrics: Metrics;
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly batchSize: number;

  constructor(deps: {
    store: Store;
    sender: Sender;
    providers: Provider[];
    metrics: Metrics;
    log: Logger;
    clock: Clock;
    batchSize?: number;
  }) {
    this.store = deps.store;
    this.sender = deps.sender;
    this.providers = new Map(deps.providers.map((p) => [p.id, p]));
    this.metrics = deps.metrics;
    this.log = deps.log;
    this.clock = deps.clock;
    this.batchSize = deps.batchSize ?? 25;
  }

  async drainOnce(): Promise<number> {
    const due = await this.store.dueDeliveries(this.batchSize);
    const byChannel = new Map<string, DueDelivery[]>();
    for (const d of due) {
      const key = d.channelId ?? `none:${d.id}`;
      byChannel.set(key, [...(byChannel.get(key) ?? []), d]);
    }
    await Promise.all(
      [...byChannel.values()].map(async (list) => {
        for (const d of list) await this.deliver(d);
      }),
    );
    this.metrics.set('announcer_outbox_depth', await this.store.pendingDeliveryCount());
    return due.length;
  }

  private async deliver(d: DueDelivery): Promise<void> {
    const ctx = { deliveryId: d.id, guildId: d.guildId, subscriptionId: d.subscriptionId, sourceId: d.source.id };
    const attempts = d.attempts + 1;
    const provider = this.providers.get(d.source.provider);
    if (!provider) {
      await this.store.markDeliveryFailed(d.id, attempts, `unknown provider ${d.source.provider}`);
      return;
    }
    if (!d.channelId) {
      await this.pause(d, 'no announcement channel is set', ctx);
      await this.store.markDeliveryFailed(d.id, attempts, 'no target channel');
      return;
    }

    const message = provider.render(d.event, d.source);
    if (d.roleId) {
      message.content = `<@&${d.roleId}>`;
      message.allowedRoleIds = [d.roleId];
    }

    try {
      const messageId = await this.sender.send(
        { guildId: d.guildId, channelId: d.channelId, crosspost: d.crosspost },
        message,
      );
      await this.store.markDeliverySent(d.id, attempts, messageId);
      this.metrics.inc('announcer_announcements_total', { provider: provider.id, result: 'sent' });
      this.log.info({ ...ctx, messageId, itemId: d.event.itemId }, 'announcement sent');
    } catch (err) {
      const kind = err instanceof SendError ? err.kind : 'retryable';
      const reason = err instanceof Error ? err.message : String(err);
      if (kind === 'forbidden' || kind === 'missing') {
        await this.store.markDeliveryFailed(d.id, attempts, reason);
        await this.pause(d, reason, ctx);
        this.metrics.inc('announcer_announcements_total', { provider: provider.id, result: 'failed' });
        return;
      }
      const delay = nextRetryDelayMs(attempts);
      if (delay === null) {
        await this.store.markDeliveryFailed(d.id, attempts, reason);
        this.metrics.inc('announcer_announcements_total', { provider: provider.id, result: 'failed' });
        this.log.error({ ...ctx, err }, 'announcement failed after retries');
      } else {
        await this.store.markDeliveryRetry(d.id, attempts, new Date(this.clock.now().getTime() + delay), reason);
        this.metrics.inc('announcer_announcements_total', { provider: provider.id, result: 'retried' });
        this.log.warn({ ...ctx, err, retryInMs: delay }, 'announcement failed, will retry');
      }
    }
  }

  private async pause(d: DueDelivery, reason: string, ctx: Record<string, string>): Promise<void> {
    const changed = await this.store.breakSubscription(d.subscriptionId, reason);
    if (!changed) return;
    this.log.warn({ ...ctx, reason }, 'subscription paused');
    const where = d.channelId ? `<#${d.channelId}>` : 'its announcement channel';
    await this.sender.notifyBroken(
      d.guildId,
      d.logChannelId,
      `⚠️ I couldn't post the announcement for **${d.source.displayName}** in ${where} (${reason}), ` +
        `so I've paused that subscription. Fix the channel permissions, then run ` +
        `\`/announcer test\` or add the creator again to resume.`,
    );
  }
}
