import SqliteDatabase from 'better-sqlite3';
import type { CaseStatus } from '../core/cases.ts';
import { LEGACY_LADDER } from '../core/escalation.ts';
import type { SettingValue } from '../core/settings.ts';
import { normaliseTimestamp } from '../core/timestamps.ts';
import type { CaseService } from '../services/cases.ts';
import type { SettingsService } from '../services/settings.ts';
import type { Database } from '../storage/schema.ts';
import type { Kysely } from 'kysely';

interface LegacyRow {
  table: 'strikes' | 'warnings' | 'mutes';
  id: number;
  guildId: string;
  userId: string | null;
  moderatorId: string | null;
  reason: string | null;
  ts: string | null;
  rawTs: string | null;
  active?: boolean;
}

export interface GuildReport {
  guildId: string;
  settings: boolean;
  strikes: number;
  strikesRevoked: number;
  warnings: number;
  mutes: number;
  watchlist: number;
  skippedExisting: number;
}

export interface ImportReport {
  guilds: GuildReport[];
  anomalies: string[];
}

const sf = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'bigint' ? v.toString() : String(v);
  return s === '0' || s === '' ? null : s;
};

function tableExists(db: SqliteDatabase.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function rows<T>(db: SqliteDatabase.Database, table: string): T[] {
  return tableExists(db, table) ? (db.prepare(`SELECT * FROM "${table}"`).all() as T[]) : [];
}

export async function importLegacy(opts: {
  legacyPath: string;
  db: Kysely<Database>;
  cases: CaseService;
  settings: SettingsService;
  botId: string;
  now: Date;
  dryRun: boolean;
}): Promise<ImportReport> {
  const legacy = new SqliteDatabase(opts.legacyPath, { readonly: true, fileMustExist: true });
  legacy.defaultSafeIntegers(true);
  const anomalies: string[] = [];
  const reports = new Map<string, GuildReport>();
  const report = (g: string) => {
    let r = reports.get(g);
    if (!r) {
      r = { guildId: g, settings: false, strikes: 0, strikesRevoked: 0, warnings: 0, mutes: 0, watchlist: 0, skippedExisting: 0 };
      reports.set(g, r);
    }
    return r;
  };

  const settingsRows = rows<Record<string, unknown>>(legacy, 'server_settings');
  const dmRows = rows<Record<string, unknown>>(legacy, 'dm_subscriptions');
  const dmOn = new Set(dmRows.filter((r) => Number(r.subscribed) === 1).map((r) => sf(r.guild_id)!));

  const caseRows: LegacyRow[] = [];
  const push = (table: LegacyRow['table'], r: Record<string, unknown>, tsKey: string, extra: Partial<LegacyRow> = {}) => {
    const guildId = sf(r.guild_id);
    const id = Number(r.id ?? 0);
    if (!guildId) {
      anomalies.push(`${table}#${id}: no guild ID, skipped`);
      return;
    }
    const rawTs = r[tsKey] === null || r[tsKey] === undefined ? null : String(r[tsKey]);
    const ts = normaliseTimestamp(rawTs);
    if (!ts) anomalies.push(`${table}#${id || `${guildId}/${sf(r.user_id)}`}: unparseable timestamp "${rawTs}", import time used`);
    caseRows.push({ table, id, guildId, userId: sf(r.user_id), moderatorId: sf(r.moderator_id), reason: (r.reason as string | null) ?? null, ts, rawTs, ...extra });
  };
  for (const r of rows<Record<string, unknown>>(legacy, 'strikes')) push('strikes', r, 'timestamp', { active: Number(r.active ?? 1) === 1 });
  for (const r of rows<Record<string, unknown>>(legacy, 'warnings')) push('warnings', r, 'timestamp');
  for (const r of rows<Record<string, unknown>>(legacy, 'mutes')) push('mutes', { ...r, id: 0 }, 'unmute_time');
  const boj = rows<Record<string, unknown>>(legacy, 'ban_on_join');
  legacy.close();

  const guildIds = new Set<string>([
    ...settingsRows.map((r) => sf(r.guild_id)!).filter(Boolean),
    ...caseRows.map((r) => r.guildId),
    ...boj.map((r) => sf(r.guild_id)!).filter(Boolean),
    ...dmOn,
  ]);

  for (const guildId of guildIds) {
    const rep = report(guildId);

    const s = settingsRows.find((r) => sf(r.guild_id) === guildId);
    if (s) {
      rep.settings = true;
      const patch: Record<string, SettingValue> = { 'strikes.escalation': LEGACY_LADDER, 'strikes.expiry': null };
      let max = Number(s.max_strikes ?? 3);
      if (!Number.isInteger(max) || max < 1) {
        anomalies.push(`guild ${guildId}: max_strikes ${s.max_strikes} clamped to 1`);
        max = 1;
      }
      if (max > 100) {
        anomalies.push(`guild ${guildId}: max_strikes ${max} clamped to 100`);
        max = 100;
      }
      patch['strikes.max'] = max;
      const log = sf(s.log_channel_id);
      if (log) {
        patch['log.channel'] = log;
        patch['log.tracker_channel'] = log;
      }
      const mute = sf(s.mute_role_id);
      if (mute) patch['mute.role'] = mute;
      try {
        const roles = JSON.parse(String(s.allowed_roles ?? '[]').replace(/(?<![\d"])(\d{15,})(?![\d"])/g, '"$1"')) as unknown[];
        patch['perms.mod_roles'] = roles.map((x) => String(x));
      } catch {
        anomalies.push(`guild ${guildId}: allowed_roles is not valid JSON, ignored`);
      }
      if (dmOn.has(guildId)) {
        patch['modmail.enabled'] = true;
        if (log) patch['modmail.channel'] = log;
      }
      if (!opts.dryRun) await opts.settings.update(guildId, patch);
    } else if (dmOn.has(guildId) && !opts.dryRun) {
      await opts.settings.update(guildId, { 'modmail.enabled': true });
    }

    const tableOrder = { strikes: 0, warnings: 1, mutes: 2 };
    const mine = caseRows
      .filter((r) => r.guildId === guildId)
      .sort((a, b) => (a.ts ?? '9').localeCompare(b.ts ?? '9') || tableOrder[a.table] - tableOrder[b.table] || a.id - b.id);

    for (const r of mine) {
      const ref = r.table === 'mutes' ? `mutes:${r.userId}` : `${r.table}:${r.id}`;
      if (!r.userId) {
        anomalies.push(`${ref} in guild ${guildId}: no user ID, skipped`);
        continue;
      }
      const exists = await opts.db.selectFrom('cases').select('id').where('guild_id', '=', guildId).where('legacy_ref', '=', ref).executeTakeFirst();
      if (exists) {
        rep.skippedExisting++;
        continue;
      }
      const createdAt = r.ts ?? opts.now.toISOString();
      let type = 'STRIKE';
      let status: CaseStatus = 'ACTIVE';
      let expiresAt: string | null = null;
      if (r.table === 'strikes') {
        if (r.active) rep.strikes++;
        else {
          rep.strikesRevoked++;
          status = 'REVOKED';
        }
      } else if (r.table === 'warnings') {
        type = 'WARN';
        rep.warnings++;
      } else {
        type = 'TIMEOUT';
        rep.mutes++;
        expiresAt = createdAt;
        status = Date.parse(createdAt) <= opts.now.getTime() ? 'EXPIRED' : 'ACTIVE';
      }
      if (opts.dryRun) continue;
      await opts.db.transaction().execute(async (trx) => {
        const c = await opts.cases.insert(trx, {
          guildId,
          type,
          targetId: r.userId,
          actorId: r.moderatorId ?? opts.botId,
          reason: r.reason?.slice(0, 1000) ?? null,
          createdAt,
          expiresAt,
          status,
          dmStatus: 'N/A',
          legacyRef: ref,
          metadata: { legacy: { table: r.table, id: r.id }, ...(r.ts ? {} : { legacyTimestamp: r.rawTs }) },
        });
        if (status === 'REVOKED') {
          await trx
            .updateTable('cases')
            .set({ revoked_by: opts.botId, revoked_at: createdAt, revoke_reason: 'imported: revoked in legacy system' })
            .where('id', '=', c.id)
            .execute();
        }
      });
    }

    for (const b of boj.filter((x) => sf(x.guild_id) === guildId)) {
      const userId = sf(b.user_id);
      if (!userId) {
        anomalies.push(`ban_on_join in guild ${guildId}: no user ID, skipped`);
        continue;
      }
      const ref = `ban_on_join:${userId}`;
      const exists = await opts.db.selectFrom('watchlist').select('user_id').where('guild_id', '=', guildId).where('user_id', '=', userId).executeTakeFirst();
      if (exists) {
        rep.skippedExisting++;
        continue;
      }
      rep.watchlist++;
      const created = normaliseTimestamp(b.timestamp === null ? null : String(b.timestamp));
      if (!created) anomalies.push(`${ref} in guild ${guildId}: unparseable timestamp "${b.timestamp}", import time used`);
      if (opts.dryRun) continue;
      await opts.db
        .insertInto('watchlist')
        .values({
          guild_id: guildId,
          user_id: userId,
          action: 'ban',
          duration_s: null,
          reason: (b.reason as string | null) ?? null,
          actor_id: sf(b.moderator_id) ?? opts.botId,
          created_at: created ?? opts.now.toISOString(),
          legacy_ref: ref,
        })
        .execute();
    }
  }

  return { guilds: [...reports.values()], anomalies };
}

export function botIdFromToken(token: string | undefined): string | null {
  const first = token?.split('.')[0];
  if (!first) return null;
  try {
    const id = Buffer.from(first, 'base64').toString('utf8');
    return /^\d{15,22}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
