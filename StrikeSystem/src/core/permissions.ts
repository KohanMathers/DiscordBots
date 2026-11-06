export type Tier = 'admin' | 'mod' | 'public';

export interface ActorFacts {
  userId: string;
  ownerId: string;
  isAdministrator: boolean;
  roleIds: string[];
  hasFallbackPermission: boolean;
}

export interface PermSettings {
  modRoles: string[];
  adminRoles: string[];
}

export function resolveTier(a: ActorFacts, s: PermSettings): Tier {
  if (a.userId === a.ownerId || a.isAdministrator) return 'admin';
  if (s.adminRoles.some((r) => a.roleIds.includes(r))) return 'admin';
  if (s.modRoles.length > 0) return s.modRoles.some((r) => a.roleIds.includes(r)) ? 'mod' : 'public';
  return a.hasFallbackPermission ? 'mod' : 'public';
}

export const tierAllows = (have: Tier, need: Tier) =>
  need === 'public' || have === 'admin' || (need === 'mod' && have === 'mod');

export interface TargetFacts {
  userId: string;
  isBot: boolean;
  highestRole: number | null;
}

export interface GuardInput {
  guildOwnerId: string;
  botId: string;
  actorId: string;
  actorHighestRole: number;
  botHighestRole: number;
  target: TargetFacts;
}

export function guardTarget(g: GuardInput): string | null {
  const t = g.target;
  if (t.userId === g.actorId) return "You can't take action against yourself.";
  if (t.userId === g.botId) return "I can't take action against myself.";
  if (t.userId === g.guildOwnerId) return "The server owner can't be moderated.";
  if (t.isBot) return "Bots can't be moderated with this command.";
  if (t.highestRole === null) return null;
  if (g.actorId !== g.guildOwnerId && t.highestRole >= g.actorHighestRole) {
    return 'Their highest role is equal to or above yours.';
  }
  if (t.highestRole >= g.botHighestRole) return 'Their highest role is equal to or above mine. Move my role higher.';
  return null;
}
