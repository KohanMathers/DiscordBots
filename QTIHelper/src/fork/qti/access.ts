import { type BaseInteraction, PermissionFlagsBits } from 'discord.js';
import { UserError } from '../../core/errors.ts';
import { kinds, type SettingSpec } from '../../core/settings.ts';
import type { BotContext } from '../../discord/context.ts';
import { qtiConfig } from './config.ts';

export const qtiRolesSetting: SettingSpec<string[]> = {
  key: 'qti.roles',
  description: 'Roles allowed to use QTI commands (/clonecat, /motd, ticket setup). Administrators always can',
  default: [],
  ...kinds.roles(),
};

export function memberRoleIds(i: BaseInteraction): string[] {
  const m = i.member;
  if (!m || !('roles' in m)) return [];
  return Array.isArray(m.roles) ? m.roles : [...m.roles.cache.keys()];
}

export async function isQti(i: BaseInteraction, ctx: BotContext): Promise<boolean> {
  if (qtiConfig().QTI_ADMIN_IDS.includes(i.user.id)) return true;
  if (i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (!i.guildId) return false;
  const roles = (await ctx.settings.get(i.guildId)).get<string[]>('qti.roles');
  const mine = memberRoleIds(i);
  return roles.some((r) => mine.includes(r));
}

export async function requireQti(i: BaseInteraction, ctx: BotContext, action: string): Promise<void> {
  if (!(await isQti(i, ctx))) {
    throw new UserError(`You need the QTI role to ${action}. An admin can set which roles count with \`/config set qti.roles\``);
  }
}
