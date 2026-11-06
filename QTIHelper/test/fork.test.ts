import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { isQti } from '../src/fork/qti/access.ts';
import { postMotd } from '../src/fork/qti/index.ts';
import { renameForClone } from '../src/fork/qti/rename.ts';
import { formatTranscript, slug, ticketChannelName, ticketId } from '../src/fork/tickets/format.ts';
import type { TicketDatabase } from '../src/fork/tickets/schema.ts';
import { TicketStore } from '../src/fork/tickets/store.ts';
import { G, services } from './helpers.ts';

describe('/clonecat naming', () => {
  it.each([
    ['📢｜qti-announcements', 'beta', '📢｜beta-announcements'],
    ['qti-dev-logs', 'beta', 'beta-dev-logs'],
    ['general', 'beta', 'beta-general'],
    ['🔊 QTI-Lobby', 'beta', '🔊 beta-Lobby'],
    ['2024-events', 'beta', 'beta-events'],
    ['💬・qti-chat', 'b', '💬・b-chat'],
  ])('%s -> %s', (name, prefix, expected) => expect(renameForClone(name, prefix)).toBe(expected));
});

describe('ticket names keep a unique ID', () => {
  it('builds open, closed and renamed names', () => {
    expect(ticketChannelName(42, 'Alice!')).toBe('ticket-0042-alice');
    expect(ticketChannelName(42, 'Alice!', true)).toBe('closed-0042-alice');
    expect(ticketChannelName(7, 'Login bug (urgent)')).toBe('ticket-0007-login-bug-urgent');
    expect(ticketChannelName(12345, 'x')).toBe('ticket-12345-x');
    expect(ticketId(3)).toBe('#0003');
    expect(slug('Zoë_ŁÓDŹ')).toBe('zoe-odz');
    expect(slug('!!!')).toBe('user');
  });
});

describe('transcripts', () => {
  it('include timestamps, authors, [BOT], attachments and embed counts', () => {
    const text = formatTranscript({ Ticket: '#0001' }, [
      { createdAt: new Date('2026-11-06T10:00:00Z'), authorTag: 'alice', authorId: '1', bot: false, content: 'help', attachments: ['https://cdn/x.png'], embeds: 0 },
      { createdAt: new Date('2026-11-06T10:01:00Z'), authorTag: 'QTIHelper', authorId: '2', bot: true, content: '', attachments: [], embeds: 2 },
    ]);
    expect(text).toContain('Ticket: #0001');
    expect(text).toContain('Messages: 2');
    expect(text).toContain('[2026-11-06 10:00:00 UTC] alice (1): help');
    expect(text).toContain('    [attachment] https://cdn/x.png');
    expect(text).toContain('QTIHelper (2) [BOT]: ');
    expect(text).toContain('    [2 embeds]');
  });
});

describe('ticket store', () => {
  const open = (s: TicketStore, creator = 'u1') => s.create({ guildId: G, channelId: '', creatorId: creator, type: 'General', subject: 's', description: 'd', priority: 'medium' });

  it('numbers tickets per server, uniquely even when opened at once', async () => {
    const svc = await services();
    const s = new TicketStore(svc.db.kysely as unknown as Kysely<TicketDatabase>, svc.clock);
    const made = await Promise.all(Array.from({ length: 10 }, () => open(s)));
    expect(made.map((t) => t.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('closes once, counts open tickets, tracks members', async () => {
    const svc = await services();
    const s = new TicketStore(svc.db.kysely as unknown as Kysely<TicketDatabase>, svc.clock);
    const t = await open(s);
    await s.update(G, t.number, { channel_id: 'c1' });
    expect(await s.openCountFor(G, 'u1')).toBe(1);
    expect((await s.byChannel('c1'))?.number).toBe(1);
    expect(await s.markClosed(G, t.number, 'mod', 'done')).toBe(true);
    expect(await s.markClosed(G, t.number, 'mod', 'again')).toBe(false);
    expect(await s.openCountFor(G, 'u1')).toBe(0);
    await s.addMember(G, t.number, 'u2', 'mod');
    await s.addMember(G, t.number, 'u2', 'mod');
    expect(await s.members(G, t.number)).toEqual(['u2']);
    expect(await s.removeMember(G, t.number, 'u2')).toBe(true);
  });

  it('discards a reservation whose channel failed', async () => {
    const svc = await services();
    const s = new TicketStore(svc.db.kysely as unknown as Kysely<TicketDatabase>, svc.clock);
    const t = await open(s);
    await s.discard(G, t.number);
    expect(await s.byNumber(G, t.number)).toBeUndefined();
  });

  it('is wiped by /config reset-data and the leave purge (base 3.0.2)', async () => {
    const svc = await services();
    const s = new TicketStore(svc.db.kysely as unknown as Kysely<TicketDatabase>, svc.clock);
    const t = await open(s);
    await s.addMember(G, t.number, 'u2', 'mod');
    await svc.guilds.deleteAll(G, true);
    expect((await s.exportAll(G)).tickets).toHaveLength(0);
    expect((await s.exportAll(G)).members).toHaveLength(0);
    expect(await svc.db.kysely.selectFrom('guild').selectAll().where('guild_id', '=', G).executeTakeFirst()).toBeTruthy();
  });
});

describe('/motd API contract', () => {
  const cfg = { QTI_ADMIN_IDS: [], QTI_MOTD_URL: 'https://api.example/motd', QTI_MOTD_TOKEN: 'secret' };
  it('POSTs {"motd": text} with a Bearer token', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    await postMotd('Hello QTI', cfg, (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);
    expect(seen!.url).toBe('https://api.example/motd');
    expect(seen!.init.method).toBe('POST');
    expect(new Headers(seen!.init.headers).get('authorization')).toBe('Bearer secret');
    expect(JSON.parse(String(seen!.init.body))).toEqual({ motd: 'Hello QTI' });
  });
  it('explains failures', async () => {
    const reply = (status: number) => (async () => new Response('', { status })) as unknown as typeof fetch;
    await expect(postMotd('x', cfg, reply(401))).rejects.toThrow(/rejected my token/);
    await expect(postMotd('x', cfg, reply(500))).rejects.toThrow(/answered 500/);
    await expect(postMotd('x', { ...cfg, QTI_MOTD_TOKEN: undefined })).rejects.toThrow(/isn’t set up/);
    await expect(postMotd('x', cfg, (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).rejects.toThrow(/couldn’t reach/);
  });
});

describe('QTI access', () => {
  const interaction = (o: { roles?: string[]; admin?: boolean; userId?: string }) =>
    ({ user: { id: o.userId ?? 'someone' }, guildId: G, member: { roles: o.roles ?? [] }, memberPermissions: { has: () => Boolean(o.admin) } }) as never;
  it('allows QTI roles and administrators, refuses everyone else', async () => {
    const svc = await services();
    const ctx = { settings: svc.settings } as never;
    await svc.settings.set(G, { 'qti.roles': ['111111111111111111'] });
    expect(await isQti(interaction({ roles: ['111111111111111111'] }), ctx)).toBe(true);
    expect(await isQti(interaction({ admin: true }), ctx)).toBe(true);
    expect(await isQti(interaction({ roles: ['222222222222222222'] }), ctx)).toBe(false);
  });
});
