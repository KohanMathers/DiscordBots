import type { Module } from '../types.ts';
import { moderationCommands, moderationComponents } from './commands.ts';
import { escalationRetry, escalationRun, rolemuteRemove, tempbanUnban } from './jobs.ts';
import { mirrorAuditEntry } from './mirror.ts';

export const moderationModule: Module = {
  id: 'moderation',
  name: 'Moderation',
  description: 'Strikes, warnings, timeouts, kicks, bans, notes, cases and history',
  required: true,
  commands: moderationCommands,
  components: [...moderationComponents, escalationRetry],
  jobs: {
    'escalation.run': escalationRun,
    'tempban.unban': tempbanUnban,
    'rolemute.remove': rolemuteRemove,
  },
  events: {
    auditLog: mirrorAuditEntry,
  },
  periodic: [
    {
      name: 'expire-cases',
      intervalMs: 60_000,
      async run(ctx) {
        const guilds = await ctx.cases.expireDue();
        if (guilds.length) ctx.kickWorker();
      },
    },
  ],
};
