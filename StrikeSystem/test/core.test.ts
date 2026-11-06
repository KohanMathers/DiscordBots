import { describe, expect, it } from 'vitest';
import { checkReason } from '../src/core/cases.ts';
import { DAY_S, durationToken, formatDuration, LONG_MAX_S, parseDuration, TIMEOUT_MAX_S } from '../src/core/duration.ts';
import { formatLadder, GRADUATED_LADDER, LEGACY_LADDER, nextStep, parseLadder, planEscalation } from '../src/core/escalation.ts';
import { guardTarget, resolveTier } from '../src/core/permissions.ts';
import { CORE_SETTINGS } from '../src/core/settings.ts';
import { normaliseTimestamp } from '../src/core/timestamps.ts';

describe('durations', () => {
  it('parses compound durations', () => {
    expect(parseDuration('1d12h', { max: TIMEOUT_MAX_S })).toBe(129600);
    expect(parseDuration('90m', { max: TIMEOUT_MAX_S })).toBe(5400);
    expect(parseDuration('2w', { max: LONG_MAX_S })).toBe(14 * DAY_S);
    expect(parseDuration(' 1H 30M ', { max: TIMEOUT_MAX_S })).toBe(5400);
  });
  it('enforces bounds: 1 s to 28 d for timeouts', () => {
    expect(parseDuration('28d', { max: TIMEOUT_MAX_S })).toBe(28 * DAY_S);
    expect(() => parseDuration('29d', { max: TIMEOUT_MAX_S })).toThrow(/at most/);
    expect(() => parseDuration('0m', { max: TIMEOUT_MAX_S })).toThrow(/at least/);
  });
  it('allows up to 10 years for role mutes and temp bans', () => {
    expect(parseDuration('3650d', { max: LONG_MAX_S })).toBe(LONG_MAX_S);
    expect(() => parseDuration('3651d', { max: LONG_MAX_S })).toThrow();
  });
  it('rejects 64-bit overflow, negatives and garbage (D-10)', () => {
    expect(() => parseDuration('99999999999999999999999d', { max: TIMEOUT_MAX_S })).toThrow(/at most/);
    expect(() => parseDuration('-5m', { max: TIMEOUT_MAX_S })).toThrow(/isn't a duration/);
    expect(() => parseDuration('spamming', { max: TIMEOUT_MAX_S })).toThrow(/isn't a duration/);
    expect(() => parseDuration('5', { max: TIMEOUT_MAX_S })).toThrow();
  });
  it('formats with d/h/m/s and round-trips', () => {
    expect(formatDuration(93784)).toBe('1d 2h 3m 4s');
    expect(formatDuration(45)).toBe('45s');
    for (const s of [1, 59, 61, 3600, 93784, 28 * DAY_S]) expect(parseDuration(durationToken(s), { max: LONG_MAX_S })).toBe(s);
  });
});

describe('timestamp normaliser', () => {
  it('treats naive values as UTC', () => {
    expect(normaliseTimestamp('2025-08-26T00:18:02.689307')).toBe('2025-08-26T00:18:02.689Z');
  });
  it('handles Z and +00:00 and other offsets', () => {
    expect(normaliseTimestamp('2025-08-26T00:18:02Z')).toBe('2025-08-26T00:18:02.000Z');
    expect(normaliseTimestamp('2025-08-26T00:18:02.689307+00:00')).toBe('2025-08-26T00:18:02.689Z');
    expect(normaliseTimestamp('2025-08-26T02:18:02+02:00')).toBe('2025-08-26T00:18:02.000Z');
    expect(normaliseTimestamp('2025-08-26 00:18:02')).toBe('2025-08-26T00:18:02.000Z');
  });
  it('returns null for junk', () => {
    expect(normaliseTimestamp('yesterday')).toBeNull();
    expect(normaliseTimestamp(null)).toBeNull();
  });
});

describe('permission resolver', () => {
  const base = { userId: 'u', ownerId: 'o', isAdministrator: false, roleIds: [] as string[], hasFallbackPermission: false };
  const none = { modRoles: [] as string[], adminRoles: [] as string[] };
  it('owner and Administrator are always admin, even with mod roles set (D-21)', () => {
    expect(resolveTier({ ...base, userId: 'o' }, none)).toBe('admin');
    expect(resolveTier({ ...base, isAdministrator: true }, { modRoles: ['m'], adminRoles: [] })).toBe('admin');
  });
  it('admin roles grant admin', () => expect(resolveTier({ ...base, roleIds: ['a'] }, { modRoles: [], adminRoles: ['a'] })).toBe('admin'));
  it('mod roles, when set, decide mod access', () => {
    expect(resolveTier({ ...base, roleIds: ['m'] }, { modRoles: ['m'], adminRoles: [] })).toBe('mod');
    expect(resolveTier({ ...base, hasFallbackPermission: true }, { modRoles: ['m'], adminRoles: [] })).toBe('public');
  });
  it('falls back to the permission when no mod roles are set', () => {
    expect(resolveTier({ ...base, hasFallbackPermission: true }, none)).toBe('mod');
    expect(resolveTier(base, none)).toBe('public');
  });
});

describe('target guard (D-09)', () => {
  const g = { guildOwnerId: 'owner', botId: 'bot', actorId: 'mod', actorHighestRole: 10, botHighestRole: 20 };
  const t = (o: Partial<{ userId: string; isBot: boolean; highestRole: number | null }>) => ({ userId: 'x', isBot: false, highestRole: 1, ...o });
  it.each([
    ['self', t({ userId: 'mod' }), /yourself/],
    ['the bot', t({ userId: 'bot' }), /myself/],
    ['the owner', t({ userId: 'owner' }), /owner/],
    ['another bot', t({ isBot: true }), /Bots/],
    ['a higher role', t({ highestRole: 15 }), /above yours/],
    ['an equal role', t({ highestRole: 10 }), /above yours/],
  ])('refuses %s', (_n, target, re) => expect(guardTarget({ ...g, target })).toMatch(re));
  it('refuses when the bot is below the target', () => {
    expect(guardTarget({ ...g, actorId: 'owner', actorHighestRole: 99, botHighestRole: 5, target: t({ highestRole: 7 }) })).toMatch(/above mine/);
  });
  it('allows a lower member, and non-members', () => {
    expect(guardTarget({ ...g, target: t({ highestRole: 3 }) })).toBeNull();
    expect(guardTarget({ ...g, target: t({ highestRole: null }) })).toBeNull();
  });
});

describe('escalation ladder', () => {
  it('parses and formats', () => {
    const l = parseLadder('2:timeout:1h, 3:timeout:24h, max:ban');
    expect(l).toEqual(GRADUATED_LADDER);
    expect(formatLadder(l)).toBe('2:timeout:1h, 3:timeout:1d, max:ban');
    expect(parseLadder('3:notify:<@&123456789012345678>')).toEqual([{ at: 3, action: 'notify', roleId: '123456789012345678' }]);
    expect(() => parseLadder('2:explode')).toThrow();
    expect(() => parseLadder('2:timeout')).toThrow(/duration/);
  });
  it('fires the legacy step at max and only once per crossing', () => {
    expect(planEscalation(LEGACY_LADDER, 3, 2, new Set()).fire).toBeNull();
    const p = planEscalation(LEGACY_LADDER, 3, 3, new Set());
    expect(p.fire?.action).toBe('ban');
    expect(p.markAts).toEqual([3]);
    expect(planEscalation(LEGACY_LADDER, 3, 4, new Set([3])).fire).toBeNull();
  });
  it('walks the graduated ladder', () => {
    const fired = new Set<number>();
    const seen = [];
    for (let n = 1; n <= 4; n++) {
      const p = planEscalation(GRADUATED_LADDER, 4, n, fired);
      p.markAts.forEach((a) => fired.add(a));
      seen.push(p.fire ? `${p.fire.action}${p.fire.durationS ?? ''}` : '-');
    }
    expect(seen).toEqual(['-', 'timeout3600', 'timeout86400', 'ban']);
  });
  it('only fires the most severe step when a ladder is added late', () => {
    const p = planEscalation(GRADUATED_LADDER, 4, 5, new Set());
    expect(p.fire?.action).toBe('ban');
    expect(p.markAts.sort()).toEqual([2, 3, 4]);
  });
  it('reports the next step', () => {
    expect(nextStep(GRADUATED_LADDER, 4, 1)?.at).toBe(2);
    expect(nextStep(LEGACY_LADDER, 3, 3)).toBeNull();
  });
});

describe('settings validation', () => {
  const def = (k: string) => CORE_SETTINGS.find((d) => d.key === k)!;
  it('strikes.max is 1–100 (D-21)', () => {
    expect(def('strikes.max').parse('5')).toBe(5);
    expect(() => def('strikes.max').parse('0')).toThrow();
    expect(() => def('strikes.max').parse('101')).toThrow();
  });
  it('parses channels, roles, expiry and sets', () => {
    expect(def('log.channel').parse('<#123456789012345678>')).toBe('123456789012345678');
    expect(def('log.channel').parse('none')).toBeNull();
    expect(def('perms.mod_roles').parse('<@&123456789012345678> 223456789012345678')).toEqual(['123456789012345678', '223456789012345678']);
    expect(def('strikes.expiry').parse('never')).toBeNull();
    expect(def('strikes.expiry').parse('90d')).toBe(90 * DAY_S);
    expect(def('notify.dm_on_action').parse('strike, ban')).toEqual(['strike', 'ban']);
    expect(() => def('notify.dm_on_action').parse('hug')).toThrow();
  });
  it('rejects a 1001-character reason (D-05)', () => {
    expect(checkReason('x'.repeat(1000))).toHaveLength(1000);
    expect(() => checkReason('x'.repeat(1001))).toThrow(/limit is 1000/);
  });
});
