import type { OverwriteEdit, OverwriteState } from '../src/core/lock.ts';
import { type OverwritePort, type PurgePort, SendError } from '../src/core/ports.ts';
import type { PurgeCandidate } from '../src/core/purge.ts';
import type { ScheduledMessage, ScheduleHooks } from '../src/services/schedule.ts';

export class FakeChannel implements OverwritePort {
  map = new Map<string, { type: 'role' | 'member'; allow: Set<string>; deny: Set<string> }>();
  failAt: number | null = null;
  applied = 0;

  set(id: string, type: 'role' | 'member', allow: string[] = [], deny: string[] = []) {
    this.map.set(id, { type, allow: new Set(allow), deny: new Set(deny) });
    return this;
  }
  snapshot() {
    return JSON.stringify([...this.map.entries()].sort().map(([id, o]) => [id, o.type, [...o.allow].sort(), [...o.deny].sort()]));
  }
  async overwrites(): Promise<OverwriteState[]> {
    return [...this.map.entries()].map(([id, o]) => ({ id, type: o.type, allow: new Set(o.allow), deny: new Set(o.deny) }));
  }
  async apply(edit: OverwriteEdit): Promise<void> {
    if (this.failAt !== null && this.applied === this.failAt) {
      this.failAt = null;
      throw new Error('Missing Permissions');
    }
    this.applied++;
    const o = this.map.get(edit.targetId) ?? { type: edit.targetType, allow: new Set<string>(), deny: new Set<string>() };
    for (const [perm, v] of Object.entries(edit.set)) {
      o.allow.delete(perm);
      o.deny.delete(perm);
      if (v === true) o.allow.add(perm);
      if (v === false) o.deny.add(perm);
    }
    if (edit.deleteIfEmpty && !o.allow.size && !o.deny.size) this.map.delete(edit.targetId);
    else this.map.set(edit.targetId, o);
  }
}

export class FakeHistory implements PurgePort {
  messages: PurgeCandidate[];
  bulkCalls: number[] = [];
  singleCalls = 0;
  now: number;
  constructor(messages: PurgeCandidate[], now: number) {
    this.messages = [...messages].sort((a, b) => b.createdAt - a.createdAt);
    this.now = now;
  }
  async fetchPage(before: string | null) {
    const start = before ? this.messages.findIndex((m) => m.id === before) + 1 : 0;
    return this.messages.slice(start, start + 100);
  }
  async bulkDelete(ids: string[]) {
    if (ids.length < 2 || ids.length > 100) throw new Error('bulk delete needs 2–100 messages');
    if (ids.some((id) => this.now - this.messages.find((m) => m.id === id)!.createdAt >= 14 * 86_400_000)) throw new Error('older than 14 days');
    this.bulkCalls.push(ids.length);
    this.messages = this.messages.filter((m) => !ids.includes(m.id));
  }
  async deleteOne(id: string) {
    this.singleCalls++;
    this.messages = this.messages.filter((m) => m.id !== id);
  }
}

export class FakeScheduleHooks implements ScheduleHooks {
  sent: ScheduledMessage[] = [];
  failures: Array<{ keyword: string; reason: string }> = [];
  fail: 'none' | 'permanent' | 'transient' = 'none';
  grace = 24;
  async send(m: ScheduledMessage) {
    if (this.fail === 'permanent') throw new SendError('the channel no longer exists', true);
    if (this.fail === 'transient') throw new SendError('503 Service Unavailable', false);
    this.sent.push(m);
  }
  async notifyFailure(m: ScheduledMessage, reason: string) {
    this.failures.push({ keyword: m.keyword, reason });
  }
  async graceHours() {
    return this.grace;
  }
}
