import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { describeStep, type LadderStep, resolveAt } from '../../core/escalation.ts';
import type { BotContext } from '../../discord/context.ts';
import { apiCode, ERR, sendableChannel } from '../../discord/delivery.ts';
import { fetchMember } from '../../discord/members.ts';
import { COLORS } from '../../discord/replies.ts';
import type { Job } from '../../services/jobs.ts';
import { PermanentJobError } from '../../services/worker.ts';
import type { ComponentSpec, JobHandler } from '../types.ts';
import { ActionError, executeBan, executeKick, executeTimeout, recordUnban } from './actions.ts';

export const escalationRun: JobHandler = async (job, ctx) => {
  const { strikeCaseId, step, at } = job.payload as { strikeCaseId: string; step: LadderStep; at: number };
  const strikeCase = await ctx.cases.byId(strikeCaseId);
  if (!strikeCase?.targetId || (await ctx.cases.escalationDone(strikeCaseId, at))) return;
  const guild = await ctx.client.guilds.fetch(strikeCase.guildId).catch(() => null);
  if (!guild) return;
  const settings = await ctx.settings.get(guild.id);
  const botId = ctx.client.user!.id;
  const reason = `Escalation: reached ${strikeCase.metadata.count ?? at} strikes (case #${strikeCase.number})`;
  const common = { ctx, guild, actorId: botId, reason, parentCase: strikeCase, metadata: { escalationAt: at } };
  try {
    const target = await ctx.client.users.fetch(strikeCase.targetId);
    const member = await fetchMember(guild, target.id);
    switch (step.action) {
      case 'timeout':
        if (!member) throw new ActionError("they're not in the server");
        await executeTimeout({ ...common, member, durationS: step.durationS ?? 3600, dm: settings.dmEnabled('timeout') });
        break;
      case 'kick':
        if (!member) throw new ActionError("they're not in the server");
        await executeKick({ ...common, target, member, dm: settings.dmEnabled('kick') });
        break;
      case 'ban': {
        const banned = await guild.bans.fetch({ user: target.id, force: true }).catch(() => null);
        if (banned) return;
        await executeBan({ ...common, target, isMember: Boolean(member), dm: settings.dmEnabled('ban'), deleteSeconds: settings.get<number>('ban.delete_message_seconds') });
        break;
      }
      case 'notify':
        await ctx.cases.create({
          guildId: guild.id,
          type: 'ESCALATION_NOTIFY',
          targetId: target.id,
          actorId: botId,
          reason,
          parentCase: strikeCase.id,
          metadata: { escalationAt: at, parentNumber: strikeCase.number, pingRole: step.roleId },
        });
        ctx.kickWorker();
        break;
    }
  } catch (err) {
    const human = err instanceof ActionError || [ERR.missingPermissions, ERR.missingAccess, ERR.unknownMember, ERR.unknownUser].includes(apiCode(err) as never);
    const lastTry = job.attempts + 1 >= job.maxAttempts;
    if (human || lastTry) {
      await alertEscalationFailure(ctx, guild.id, strikeCase.targetId, step, strikeCase.id, at, err instanceof Error ? err.message : String(err));
      throw new PermanentJobError(`escalation failed: ${err instanceof Error ? err.message : err}`);
    }
    throw err;
  }
};

async function alertEscalationFailure(ctx: BotContext, guildId: string, userId: string, step: LadderStep, strikeCaseId: string, at: number, why: string) {
  const guild = await ctx.client.guilds.fetch(guildId);
  const settings = await ctx.settings.get(guildId);
  const channel = await sendableChannel(guild, settings.logChannel);
  if (!channel) return;
  const modRoles = settings.get<string[]>('perms.mod_roles');
  await channel.send({
    content: modRoles.map((r) => `<@&${r}>`).join(' ') || undefined,
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.error)
        .setTitle('⚠️ Escalation failed')
        .setDescription(`<@${userId}> reached ${at} strikes, but I couldn't apply **${describeStep(step)}**: ${why}.\nFix the problem, then press Retry.`),
    ],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`esc:retry:${strikeCaseId}:${at}`).setLabel('Retry').setStyle(ButtonStyle.Primary))],
    allowedMentions: { parse: [], roles: modRoles },
  });
}

export const escalationRetry: ComponentSpec = {
  prefix: 'esc',
  tier: 'mod',
  async handle(i, ctx, [, strikeCaseId = '', atRaw = '0']) {
    if (!i.isButton()) return;
    const at = Number(atRaw);
    const settings = await ctx.settings.get(i.guildId!);
    const step = settings.ladder.find((s) => resolveAt(s, settings.maxStrikes) === at);
    if (!step) {
      await i.update({ content: `The ladder no longer has a step at ${at} strikes, so there's nothing to retry.`, components: [] });
      return;
    }
    await ctx.jobs.enqueue([{ type: 'escalation.run', guildId: i.guildId!, payload: { strikeCaseId, step, at }, maxAttempts: 3 }]);
    ctx.kickWorker();
    await i.update({ content: `🔁 Retry queued by <@${i.user.id}>.`, components: [], allowedMentions: { parse: [] } });
  },
};

export const tempbanUnban: JobHandler = async (job: Job, ctx) => {
  const { userId } = job.payload as { userId: string };
  const guild = await ctx.client.guilds.fetch(job.guildId!).catch(() => null);
  if (!guild) return;
  try {
    await guild.bans.remove(userId, 'Temporary ban ended');
  } catch (err) {
    if (apiCode(err) !== ERR.unknownBan) throw err;
  }
  await recordUnban(ctx, guild.id, userId, ctx.client.user!.id, 'Temporary ban ended');
};

export const rolemuteRemove: JobHandler = async (job: Job, ctx) => {
  const { userId, roleId } = job.payload as { userId: string; roleId: string };
  const guild = await ctx.client.guilds.fetch(job.guildId!).catch(() => null);
  if (!guild) return;
  const member = await fetchMember(guild, userId);
  if (member?.roles.cache.has(roleId)) {
    await member.roles.remove(roleId, 'Mute ended').catch((err) => {
      if (apiCode(err) === ERR.missingPermissions) throw new PermanentJobError('cannot remove the mute role');
      throw err;
    });
  }
};
