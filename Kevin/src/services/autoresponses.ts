import type { Kysely } from 'kysely';
import type { Clock } from '../core/clock.ts';
import { UserError } from '../core/errors.ts';
import { t } from '../messages.ts';
import { checkRegex, type MatchMode, type MentionPolicy } from '../core/text.ts';
import type { AutoResponseTable, Database } from '../storage/schema.ts';
import type { AuditService } from './audit.ts';
import type { EmbedSpec } from './schedule.ts';

export interface AutoResponse {
  keyword: string;
  keywordNorm: string;
  response: string;
  embed: EmbedSpec | null;
  matchMode: MatchMode;
  mentions: MentionPolicy;
  createdBy: string;
  useCount: number;
}

const toAr = (r: AutoResponseTable): AutoResponse => ({
  keyword: r.keyword,
  keywordNorm: r.keyword_norm,
  response: r.response,
  embed: r.embed_json ? (JSON.parse(r.embed_json) as EmbedSpec) : null,
  matchMode: r.match_mode as MatchMode,
  mentions: JSON.parse(r.allowed_mentions) as MentionPolicy,
  createdBy: r.created_by,
  useCount: Number(r.use_count),
});

export const normKeyword = (k: string) => k.trim().toLowerCase();

export class AutoResponseService {
  private readonly db: Kysely<Database>;
  private readonly clock: Clock;
  private readonly audit: AuditService;

  constructor(deps: { db: Kysely<Database>; clock: Clock; audit: AuditService }) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.audit = deps.audit;
  }

  async add(guildId: string, actorId: string, o: { keyword: string; response: string; embed: EmbedSpec | null; matchMode: MatchMode; mentions: MentionPolicy }) {
    const keyword = o.keyword.trim();
    if (!keyword || keyword.length > 100) throw new UserError('The keyword must be 1–100 characters');
    if (o.response.length > 2000) throw new UserError('The response can be at most 2000 characters');
    if (!o.response.trim() && !o.embed) throw new UserError('The response is empty');
    if (o.matchMode === 'regex') checkRegex(keyword);
    await this.db.transaction().execute(async (trx) => {
      const exists = await trx.selectFrom('auto_response').select('keyword').where('guild_id', '=', guildId).where('keyword_norm', '=', normKeyword(keyword)).executeTakeFirst();
      if (exists) throw new UserError(t('ar.exists'));
      await trx
        .insertInto('auto_response')
        .values({
          guild_id: guildId,
          keyword_norm: normKeyword(keyword),
          keyword,
          response: o.response,
          embed_json: o.embed ? JSON.stringify(o.embed) : null,
          match_mode: o.matchMode,
          allowed_mentions: JSON.stringify(o.mentions),
          created_by: actorId,
          created_at: this.clock.now().toISOString(),
          use_count: 0,
        })
        .execute();
      await this.audit.record({ guildId, actorId, action: 'autoresponse.add', target: keyword, payload: { matchMode: o.matchMode } }, trx);
    });
  }

  async edit(guildId: string, actorId: string, keyword: string, patch: { response: string; embed: EmbedSpec | null; mentions: MentionPolicy; matchMode?: MatchMode }) {
    if (patch.response.length > 2000) throw new UserError('The response can be at most 2000 characters');
    await this.db.transaction().execute(async (trx) => {
      const r = await trx
        .updateTable('auto_response')
        .set({
          response: patch.response,
          embed_json: patch.embed ? JSON.stringify(patch.embed) : null,
          allowed_mentions: JSON.stringify(patch.mentions),
          ...(patch.matchMode ? { match_mode: patch.matchMode } : {}),
        })
        .where('guild_id', '=', guildId)
        .where('keyword_norm', '=', normKeyword(keyword))
        .executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw new UserError(t('ar.missing'));
      await this.audit.record({ guildId, actorId, action: 'autoresponse.edit', target: keyword }, trx);
    });
  }

  async remove(guildId: string, actorId: string, keyword: string): Promise<AutoResponse> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('auto_response').selectAll().where('guild_id', '=', guildId).where('keyword_norm', '=', normKeyword(keyword)).executeTakeFirst();
      if (!row) throw new UserError(t('ar.missing'));
      await trx.deleteFrom('auto_response').where('guild_id', '=', guildId).where('keyword_norm', '=', row.keyword_norm).execute();
      await this.audit.record({ guildId, actorId, action: 'autoresponse.remove', target: row.keyword }, trx);
      return toAr(row);
    });
  }

  async get(guildId: string, keyword: string): Promise<AutoResponse | undefined> {
    const r = await this.db.selectFrom('auto_response').selectAll().where('guild_id', '=', guildId).where('keyword_norm', '=', normKeyword(keyword)).executeTakeFirst();
    return r ? toAr(r) : undefined;
  }

  async list(guildId: string, opts: { passiveOnly?: boolean } = {}): Promise<AutoResponse[]> {
    let q = this.db.selectFrom('auto_response').selectAll().where('guild_id', '=', guildId);
    if (opts.passiveOnly) q = q.where('match_mode', '!=', 'manual');
    return (await q.orderBy('use_count', 'desc').orderBy('keyword_norm').execute()).map(toAr);
  }

  async recordUse(guildId: string, keywordNorm: string): Promise<void> {
    await this.db
      .updateTable('auto_response')
      .set((eb) => ({ use_count: eb('use_count', '+', 1) }))
      .where('guild_id', '=', guildId)
      .where('keyword_norm', '=', keywordNorm)
      .execute();
  }
}
