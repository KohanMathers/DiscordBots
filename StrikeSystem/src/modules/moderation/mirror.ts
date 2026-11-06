import { AuditLogEvent, type Guild, type GuildAuditLogsEntry } from 'discord.js';
import type { BotContext } from '../../discord/context.ts';
import { recordUnban } from './actions.ts';

export async function mirrorAuditEntry(entry: GuildAuditLogsEntry<AuditLogEvent>, guild: Guild, ctx: BotContext) {
  const actorId = entry.executorId;
  const targetId = entry.targetId;
  if (!actorId || !targetId || actorId === ctx.client.user!.id) return;
  const reason = entry.reason ?? null;
  const base = { guildId: guild.id, targetId, actorId, reason, metadata: { mirrored: true } };

  switch (entry.action) {
    case AuditLogEvent.MemberBanAdd:
      await ctx.cases.create({ ...base, type: 'BAN' });
      break;
    case AuditLogEvent.MemberBanRemove:
      await recordUnban(ctx, guild.id, targetId, actorId, reason, { mirrored: true });
      break;
    case AuditLogEvent.MemberKick:
      await ctx.cases.create({ ...base, type: 'KICK' });
      break;
    case AuditLogEvent.MemberUpdate: {
      const change = entry.changes.find((c) => c.key === 'communication_disabled_until');
      if (!change) return;
      if (change.new) {
        const until = new Date(String(change.new));
        const durationS = Math.max(1, Math.round((until.getTime() - Date.now()) / 1000));
        await ctx.cases.create({ ...base, type: 'TIMEOUT', durationS, expiresAt: until.toISOString() });
      } else {
        await ctx.cases.supersedeActive(guild.id, targetId, 'TIMEOUT', actorId);
        await ctx.cases.create({ ...base, type: 'UNTIMEOUT' });
      }
      break;
    }
    default:
      return;
  }
  ctx.kickWorker();
}
