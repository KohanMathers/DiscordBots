import { DiscordAPIError, type Guild, type GuildTextBasedChannel, PermissionFlagsBits } from 'discord.js';
import type { Case } from '../core/cases.ts';
import { describeStep, nextStep, resolveAt } from '../core/escalation.ts';
import type { GuildSettings } from '../core/settings.ts';
import { PermanentJobError } from '../services/worker.ts';
import type { BotContext } from './context.ts';
import { evidenceFiles } from './evidence.ts';
import { caseDmEmbed, caseLogEmbed } from './render.ts';

export const ERR = {
  unknownChannel: 10003,
  unknownMember: 10007,
  unknownMessage: 10008,
  unknownUser: 10013,
  unknownBan: 10026,
  missingAccess: 50001,
  cannotDm: 50007,
  missingPermissions: 50013,
} as const;

export const apiCode = (err: unknown): number | null =>
  err instanceof DiscordAPIError && typeof err.code === 'number' ? err.code : null;

export async function sendableChannel(guild: Guild, channelId: string | null): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased() || !ch.isSendable()) return null;
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const perms = ch.permissionsFor(me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return null;
  return ch;
}

export async function deliverCaseLog(ctx: BotContext, c: Case): Promise<void> {
  const settings = await ctx.settings.get(c.guildId);
  const guild = await ctx.client.guilds.fetch(c.guildId).catch(() => null);
  if (!guild) return;
  const def = ctx.caseTypes.get(c.type);
  const embed = caseLogEmbed(c, def, ctx.client.user!.id);
  const pingRole = typeof c.metadata.pingRole === 'string' ? c.metadata.pingRole : null;
  const channel = await sendableChannel(guild, settings.logChannel);
  if (!channel) {
    ctx.log.info({ guildId: c.guildId, caseNumber: c.number, type: c.type }, 'no usable log channel; case not posted');
    return;
  }
  if (c.logMessageId) {
    const existing = await channel.messages.fetch(c.logMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    }
  }
  const msg = await channel
    .send({
      ...(pingRole && c.status === 'ACTIVE' ? { content: `<@&${pingRole}>` } : {}),
      embeds: [embed],
      files: await evidenceFiles(c.evidence),
      allowedMentions: { parse: [], roles: pingRole ? [pingRole] : [] },
    })
    .catch((err: unknown) => {
      const code = apiCode(err);
      if (code === ERR.missingAccess || code === ERR.missingPermissions) throw new PermanentJobError('cannot post in the log channel');
      throw err;
    });
  await ctx.cases.setLogMessage(c.id, msg.id);
}

export function dmExtras(c: Case, settings: GuildSettings) {
  const count = typeof c.metadata.count === 'number' ? c.metadata.count : null;
  const max = settings.maxStrikes;
  let willEscalate: string | null = null;
  if (c.type === 'STRIKE' && count !== null) {
    const fired = typeof c.metadata.escalation === 'string' ? c.metadata.escalation : null;
    const next = nextStep(settings.ladder, max, count);
    willEscalate = fired
      ? `This strike triggered: **${fired}**.`
      : next
        ? `Reaching ${resolveAt(next, max)} strikes leads to: **${describeStep(next)}**.`
        : null;
  }
  return {
    showModerator: settings.get<boolean>('notify.show_moderator'),
    appealText: settings.get<string | null>('notify.appeal_text'),
    ...(count !== null ? { strikes: { count, max } } : {}),
    willEscalate,
  };
}

export async function sendCaseDm(ctx: BotContext, c: Case, guildName: string): Promise<'SENT' | 'FAILED'> {
  if (!c.targetId) return 'FAILED';
  const settings = await ctx.settings.get(c.guildId);
  const def = ctx.caseTypes.get(c.type);
  try {
    const user = await ctx.client.users.fetch(c.targetId);
    await user.send({
      embeds: [caseDmEmbed(c, def, { guildName, ...dmExtras(c, settings) })],
      files: await evidenceFiles(c.evidence),
      allowedMentions: { parse: [] },
    });
    return 'SENT';
  } catch (err) {
    const code = apiCode(err);
    if (code === ERR.cannotDm || code === ERR.unknownUser) return 'FAILED';
    throw err;
  }
}
