import { describe, expect, it } from 'vitest';
import { loadFunContent, pickTwoFacts } from '../src/core/content.ts';
import { planDeletes } from '../src/core/purge.ts';
import { analyseMentions, checkRegex, matches, mentionPolicyFor, renderTemplate } from '../src/core/text.ts';
import { localToUtc, nextLocal, parseWhen, resolveZone, upcomingRuns, utcToLocal } from '../src/core/time.ts';
import { MESSAGES, t } from '../src/messages.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('time zones', () => {
  it('accepts IANA names in any case and UTC', () => {
    expect(resolveZone('europe/london')).toBe('Europe/London');
    expect(resolveZone('UTC')).toBe('UTC');
  });
  it('rejects EST with a suggestion of America/New_York', () => {
    expect(() => resolveZone('EST')).toThrow(/America\/New_York/);
    expect(() => resolveZone('Mars/Base')).toThrow(/isn't a time zone/);
  });
});

describe('parseWhen', () => {
  it('reads the v2.0 DD/MM/YYYY HH:MM format in the given zone', () => {
    expect(iso(parseWhen('25/12/2026 09:00', 'Europe/London', NOW).runAt)).toBe('2026-12-25T09:00:00.000Z');
    expect(iso(parseWhen('25/12/2026 09:00', 'America/New_York', NOW).runAt)).toBe('2026-12-25T14:00:00.000Z');
  });
  it('reads ISO, clock times and relative times', () => {
    expect(iso(parseWhen('2026-12-25 09:00', 'UTC', NOW).runAt)).toBe('2026-12-25T09:00:00.000Z');
    expect(iso(parseWhen('18:30', 'UTC', NOW).runAt)).toBe('2026-11-06T18:30:00.000Z');
    expect(iso(parseWhen('09:00', 'UTC', NOW).runAt)).toBe('2026-11-07T09:00:00.000Z');
    expect(iso(parseWhen('tomorrow 18:30', 'UTC', NOW).runAt)).toBe('2026-11-07T18:30:00.000Z');
    expect(iso(parseWhen('in 2h', 'UTC', NOW).runAt)).toBe('2026-11-06T14:00:00.000Z');
    expect(iso(parseWhen('in 1d 30m', 'UTC', NOW).runAt)).toBe('2026-11-07T12:30:00.000Z');
  });
  it('rejects past times and nonsense', () => {
    expect(() => parseWhen('01/01/2020 10:00', 'UTC', NOW)).toThrow(/past/);
    expect(() => parseWhen('31/02/2027 10:00', 'UTC', NOW)).toThrow(/doesn’t exist/);
    expect(() => parseWhen('25:00', 'UTC', NOW)).toThrow();
    expect(() => parseWhen('next tuesday-ish', 'UTC', NOW)).toThrow(/couldn’t read/);
  });
});

describe('DST', () => {
  const L = 'Europe/London';
  it('moves a time in the spring-forward gap (2026-03-29 01:30) forward', () => {
    expect(iso(localToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, L))).toBe('2026-03-29T01:30:00.000Z');
  });
  it('picks the earlier instant in the autumn overlap (2026-10-25 01:30)', () => {
    expect(iso(localToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, L))).toBe('2026-10-25T00:30:00.000Z');
  });
  it('keeps a daily 09:00 at 09:00 local across both changes', () => {
    const start = { year: 2026, month: 3, day: 28, hour: 9, minute: 0 };
    const runs = upcomingRuns('FREQ=DAILY', start, L, start, 0, 3).map(iso);
    expect(runs).toEqual(['2026-03-28T09:00:00.000Z', '2026-03-29T08:00:00.000Z', '2026-03-30T08:00:00.000Z']);
    const autumn = { year: 2026, month: 10, day: 24, hour: 9, minute: 0 };
    expect(upcomingRuns('FREQ=DAILY', autumn, L, autumn, 0, 2).map(iso)).toEqual(['2026-10-24T08:00:00.000Z', '2026-10-25T09:00:00.000Z']);
  });
  it('monthly on the 31st clamps to the last day', () => {
    const jan31 = { year: 2027, month: 1, day: 31, hour: 9, minute: 0 };
    const feb = nextLocal('FREQ=MONTHLY', jan31, 31);
    expect(feb).toMatchObject({ month: 2, day: 28 });
    expect(nextLocal('FREQ=MONTHLY', feb, 31)).toMatchObject({ month: 3, day: 31 });
  });
  it('round-trips local ↔ UTC', () => {
    const ms = Date.parse('2026-07-01T16:45:00Z');
    expect(localToUtc(utcToLocal(ms, L), L)).toBe(ms);
  });
});

describe('templates and mentions', () => {
  it('fills known variables and leaves unknown ones as typed', () => {
    expect(renderTemplate('Hi {member}, welcome to {server}! {nope}', { member: 'Ann', server: 'Club' })).toBe('Hi Ann, welcome to Club! {nope}');
  });
  it('blocks @everyone and role pings without Mention Everyone', () => {
    expect(() => mentionPolicyFor('hey @everyone', { authorCanMentionEveryone: false, guildAllowsMass: true })).toThrow(/Mention Everyone/);
    expect(() => mentionPolicyFor('hey <@&123456789012345678>', { authorCanMentionEveryone: true, guildAllowsMass: false })).toThrow(/doesn’t allow/);
    expect(mentionPolicyFor('hey @here', { authorCanMentionEveryone: true, guildAllowsMass: true })).toEqual({ everyone: true, roles: [] });
    expect(mentionPolicyFor('plain', { authorCanMentionEveryone: false, guildAllowsMass: false })).toEqual({ everyone: false, roles: [] });
    expect(analyseMentions('<@123456789012345678> <@!223456789012345678>').users).toHaveLength(2);
  });
  it('matches passive modes', () => {
    expect(matches('exact', 'Hello', ' hello ')).toBe(true);
    expect(matches('word', 'rules', 'where are the rules?')).toBe(true);
    expect(matches('word', 'rule', 'where are the rules?')).toBe(false);
    expect(matches('manual', 'x', 'x')).toBe(false);
    expect(matches('regex', '^ip\\b', 'IP address please')).toBe(true);
    expect(() => checkRegex('(a+)+$')).toThrow(/nested/);
  });
});

describe('purge planning', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const msg = (id: number, daysAgo: number) => ({ id: String(id), createdAt: now - daysAgo * 86_400_000, authorId: 'u', authorBot: false, content: '', pinned: false });
  it('bulk-deletes recent messages in batches of ≤ 100 and singles the rest', () => {
    const msgs = [...Array.from({ length: 101 }, (_, n) => msg(n, 1)), msg(500, 15)];
    const p = planDeletes(msgs, now);
    expect(p.batches.map((b) => b.length)).toEqual([100]);
    expect(p.singles).toEqual(['100', '500']);
  });
  it('never sends a bulk delete of one', () => {
    expect(planDeletes([msg(1, 1)], now)).toEqual({ batches: [], singles: ['1'] });
  });
});

describe('content packs', () => {
  const c = loadFunContent('content');
  it('loads all 314 strings', () => {
    expect(c.facts).toHaveLength(155);
    expect(c.slots.map((s) => s.length)).toEqual([55, 49, 55]);
    expect(c.templates.intro).toBe(MESSAGES['fun.intro']);
  });
  it('always picks two different facts', () => {
    for (let n = 0; n < 500; n++) {
      const [a, b] = pickTwoFacts(c.facts);
      expect(a).not.toBe(b);
    }
    expect(pickTwoFacts(['x', 'y'], () => 0.99)).toEqual(['y', 'x']);
  });
});

describe('parity strings', () => {
  it.each([
    ['bot.pong', { ms: 42 }, 'Pong! Gateway latency: 42ms'],
    ['bot.hello', { name: 'Kai' }, 'Hello Kai!'],
    ['member.whoami', { name: 'Kai' }, "You're Kai, of course!"],
    ['member.count', { n: 120 }, "This server has `120` members, that's a lot of people!"],
    ['member.position', { n: 7 }, 'You were number **7** to join this server.'],
    ['lock.already', { channel: '<#1>' }, 'Channel <#1> is already locked.'],
    ['lock.done', { channel: '<#1>' }, 'Channel <#1> has been locked.'],
    ['lock.notLocked', { channel: '<#1>' }, 'Channel <#1> is not locked.'],
    ['lock.unlocked', { channel: '<#1>' }, 'Channel <#1> has been unlocked.'],
    ['purge.positive', {}, 'Amount must be a positive number.'],
    ['purge.done', { n: 5 }, 'Deleted 5 messages.'],
    ['ar.exists', {}, 'Autoresponse already exists, please remove it before adding another.'],
    ['ar.added', { keyword: 'rules', response: 'Read #rules' }, 'Autoresponse `rules` added: Read #rules'],
    ['ar.removed', { keyword: 'rules' }, 'Autoresponse `rules` removed.'],
    ['ar.missing', {}, 'Autoresponse does not exist, check your spelling and try again.'],
    ['ar.notFound', {}, 'Autoresponse not found.'],
    ['schedule.exists', {}, 'Scheduled message already exists, please remove it before adding another.'],
    ['schedule.created', { message: 'hi', channel: '<#1>', time: '09:00', date: '25/12/2026', tz: 'UTC' }, 'Scheduled message "hi" to send in <#1> at 09:00 on 25/12/2026 UTC'],
    ['perm.need', { perm: 'Manage Messages', action: 'lock this channel' }, 'You need the Manage Messages permission to lock this channel.'],
    ['fun.intro', { fact1: 'a', fact2: 'b', name: 'Kai' }, "Some say a, and b... all we know is, they're called Kai!"],
    ['fun.tonight', { slot1: 'J', slot2: 'M', slot3: 'R' }, 'Tonight... J, M, and R.'],
  ] as const)('%s', (key, vars, expected) => expect(t(key, vars)).toBe(expected));
});
