import { describe, expect, it } from 'vitest';
import { bandOf, embedSize, LIMITS, layoutTracker, MAX_TRACKER_MESSAGES } from '../src/core/tracker.ts';

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    userId: String(300000000000000000n + BigInt(i)),
    name: `Member number ${i} with a fairly long display name`,
    count: (i % 5) + 1,
    next: 'ban at 3',
    soonestExpiry: '2026-12-01T00:00:00.000Z',
  }));

describe('tracker layout', () => {
  it('shows a clean server', () => {
    const [msg] = layoutTracker({ guildName: 'G', max: 3, rows: [], updatedAt: '2026-11-06T00:00:00Z' });
    expect(msg![0]!.description).toMatch(/Clean server/);
  });

  it('keeps 500 users within every embed limit and paginates', () => {
    const pages = layoutTracker({ guildName: 'Big guild', max: 3, rows: rows(500), updatedAt: '2026-11-06T00:00:00Z' });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.length).toBeLessThanOrEqual(MAX_TRACKER_MESSAGES);
    for (const embeds of pages) {
      expect(embeds.length).toBeLessThanOrEqual(LIMITS.embedsPerMessage);
      expect(embeds.reduce((n, e) => n + embedSize(e), 0)).toBeLessThanOrEqual(LIMITS.embedTotal);
      for (const e of embeds) {
        expect(e.fields.length).toBeLessThanOrEqual(LIMITS.fields);
        for (const f of e.fields) {
          expect(f.value.length).toBeLessThanOrEqual(LIMITS.fieldValue);
          expect(f.name.length).toBeLessThanOrEqual(LIMITS.fieldName);
        }
      }
    }
  });

  it('notes users that did not fit', () => {
    const pages = layoutTracker({ guildName: 'Huge', max: 3, rows: rows(3000), updatedAt: '2026-11-06T00:00:00Z' });
    expect(pages.length).toBe(MAX_TRACKER_MESSAGES);
    expect(pages.at(-1)!.at(-1)!.footer).toMatch(/more not shown/);
  });

  it('groups by count, highest first, with severity colours', () => {
    const pages = layoutTracker({ guildName: 'G', max: 3, rows: rows(10), updatedAt: '2026-11-06T00:00:00Z' });
    const names = pages.flat().flatMap((e) => e.fields.map((f) => f.name));
    expect(names[0]).toMatch(/5\/3/);
    expect(bandOf(3, 3)).toBe('red');
    expect(bandOf(7, 10)).toBe('amber');
    expect(bandOf(1, 3)).toBe('green');
  });
});
