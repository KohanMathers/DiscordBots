import {
  type Guild,
  type GuildMember,
  type Interaction,
  PermissionFlagsBits,
  PermissionsBitField,
  type User,
} from 'discord.js';
import { UserError } from '../core/errors.ts';
import { type ActorFacts, guardTarget, resolveTier, type Tier } from '../core/permissions.ts';
import type { GuildSettings } from '../core/settings.ts';

const FALLBACK: Record<string, bigint> = {
  moderatemembers: PermissionFlagsBits.ModerateMembers,
  kickmembers: PermissionFlagsBits.KickMembers,
  banmembers: PermissionFlagsBits.BanMembers,
  managemessages: PermissionFlagsBits.ManageMessages,
  manageguild: PermissionFlagsBits.ManageGuild,
};

export function interactionTier(i: Interaction, settings: GuildSettings): Tier {
  if (!i.inGuild() || !i.guild) return 'public';
  const perms = i.memberPermissions ?? new PermissionsBitField();
  const roles = actorOf(i).roleIds;
  const facts: ActorFacts = {
    userId: i.user.id,
    ownerId: i.guild.ownerId,
    isAdministrator: perms.has(PermissionFlagsBits.Administrator),
    roleIds: roles,
    hasFallbackPermission: perms.has(FALLBACK[settings.get<string>('perms.fallback_permission')] ?? PermissionFlagsBits.ModerateMembers),
  };
  return resolveTier(facts, { modRoles: settings.get('perms.mod_roles'), adminRoles: settings.get('perms.admin_roles') });
}

export function highestRole(guild: Guild, roleIds: Iterable<string>): number {
  let max = 0;
  for (const id of roleIds) {
    if (id === guild.id) continue;
    const pos = guild.roles.cache.get(id)?.position ?? 0;
    if (pos > max) max = pos;
  }
  return max;
}

export async function fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  return guild.members.fetch({ user: userId, force: false }).catch(() => null);
}

export interface Actor {
  id: string;
  roleIds: string[];
}

export function actorOf(i: Interaction): Actor {
  const m = i.member;
  const roleIds = m && 'roles' in m ? (Array.isArray(m.roles) ? m.roles : [...m.roles.cache.keys()]) : [];
  return { id: i.user.id, roleIds };
}

export async function assertTargetable(guild: Guild, actor: Actor, target: User, botId: string) {
  const member = await fetchMember(guild, target.id);
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const actorRoles = actor.roleIds;
  const refusal = guardTarget({
    guildOwnerId: guild.ownerId,
    botId,
    actorId: actor.id,
    actorHighestRole: highestRole(guild, actorRoles),
    botHighestRole: highestRole(guild, me.roles.cache.keys()),
    target: { userId: target.id, isBot: target.bot, highestRole: member ? highestRole(guild, member.roles.cache.keys()) : null },
  });
  if (refusal) throw new UserError(refusal);
  return member;
}

const PERM_NAMES: Record<string, string> = {
  BanMembers: 'Ban Members',
  KickMembers: 'Kick Members',
  ModerateMembers: 'Timeout Members',
  ManageRoles: 'Manage Roles',
  SendMessages: 'Send Messages',
  EmbedLinks: 'Embed Links',
  AttachFiles: 'Attach Files',
  ViewChannel: 'View Channel',
  CreatePublicThreads: 'Create Public Threads',
  SendMessagesInThreads: 'Send Messages in Threads',
  ManageThreads: 'Manage Threads',
  ViewAuditLog: 'View Audit Log',
};

export async function assertBotCan(guild: Guild, perms: bigint[], extra = '') {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const missing = perms.filter((p) => !me.permissions.has(p));
  if (missing.length) {
    const names = missing.map((p) => PERM_NAMES[new PermissionsBitField(p).toArray()[0] ?? ''] ?? 'an unknown permission');
    throw new UserError(`I need **${names.join('** and **')}**${extra} to do that.`);
  }
}
