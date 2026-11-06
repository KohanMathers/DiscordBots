import { describe, expect, it } from 'vitest';
import { filterAccepts, isAnnounceable } from '../src/core/rules.ts';
import type { SourceEvent } from '../src/core/types.ts';

const now = new Date('2026-11-05T12:00:00Z');
const ev = (kind: SourceEvent['kind'], hoursAgo: number): SourceEvent => ({
  provider: 'x',
  externalId: '1',
  kind,
  itemId: 'i',
  title: 't',
  subtitle: null,
  url: 'u',
  imageUrl: null,
  occurredAt: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
  extra: {},
});
const policy = { firstPoll: false, firstSync: 'mark-seen' as const, maxAgeMs: 24 * 3_600_000, now };

describe('isAnnounceable', () => {
  it('announces recent uploads and skips old ones', () => {
    expect(isAnnounceable(ev('UPLOAD', 1), policy)).toBe(true);
    expect(isAnnounceable(ev('UPLOAD', 25), policy)).toBe(false);
  });
  it('announces a live stream however long it has been running', () => {
    expect(isAnnounceable(ev('LIVE_START', 30), policy)).toBe(true);
  });
  it('never announces the back catalogue on a mark-seen first poll', () => {
    expect(isAnnounceable(ev('UPLOAD', 0), { ...policy, firstPoll: true })).toBe(false);
  });
  it('announces current items on an announce-current first poll', () => {
    expect(isAnnounceable(ev('LIVE_START', 0), { ...policy, firstPoll: true, firstSync: 'announce-current' })).toBe(true);
  });
  it('never creates announcements for LIVE_END', () => {
    expect(isAnnounceable(ev('LIVE_END', 0), policy)).toBe(false);
  });
});

describe('filterAccepts', () => {
  it('null filters accept everything', () => expect(filterAccepts(null, 'SHORT')).toBe(true));
  it('respects the kind list', () => {
    expect(filterAccepts({ kinds: ['UPLOAD'] }, 'SHORT')).toBe(false);
    expect(filterAccepts({ kinds: ['UPLOAD', 'SHORT'] }, 'SHORT')).toBe(true);
  });
});
