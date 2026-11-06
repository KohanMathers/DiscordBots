import { UserError } from './errors.ts';

export const TEMPLATE_VARIABLES = ['member', 'member.mention', 'member.id', 'server', 'membercount', 'channel'] as const;

export function renderTemplate(text: string, vars: Partial<Record<(typeof TEMPLATE_VARIABLES)[number], string>>): string {
  return text.replace(/\{([\w.]+)\}/g, (m, k: string) => (k in vars && vars[k as keyof typeof vars] !== undefined ? String(vars[k as keyof typeof vars]) : m));
}

export interface MentionPolicy {
  everyone: boolean;
  roles: string[];
}

export function analyseMentions(text: string): { everyone: boolean; roles: string[]; users: string[] } {
  return {
    everyone: /@(everyone|here)\b/.test(text),
    roles: [...new Set([...text.matchAll(/<@&(\d{15,22})>/g)].map((m) => m[1]!))],
    users: [...new Set([...text.matchAll(/<@!?(\d{15,22})>/g)].map((m) => m[1]!))],
  };
}

export function mentionPolicyFor(text: string, o: { authorCanMentionEveryone: boolean; guildAllowsMass: boolean }): MentionPolicy {
  const a = analyseMentions(text);
  if (a.everyone || a.roles.length) {
    if (!o.authorCanMentionEveryone) {
      throw new UserError('This content pings @everyone, @here or a role, and you don’t have the **Mention Everyone** permission. Remove the ping or ask an admin');
    }
    if (!o.guildAllowsMass) {
      throw new UserError('This server doesn’t allow @everyone, @here or role pings in saved messages. An admin can allow them with `/config`');
    }
  }
  return { everyone: a.everyone, roles: a.roles };
}

export function allowedMentionsFor(policy: MentionPolicy, rendered: string) {
  const users = analyseMentions(rendered).users;
  return { parse: policy.everyone ? (['everyone'] as const).slice() : [], roles: policy.roles, users };
}

export function checkRegex(pattern: string): RegExp {
  if (pattern.length > 200) throw new UserError('Regex patterns can be at most 200 characters');
  if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(pattern) || /(\.\*){2,}/.test(pattern)) {
    throw new UserError('That pattern has nested repetition, which can make the bot hang. Simplify it');
  }
  try {
    return new RegExp(pattern, 'i');
  } catch {
    throw new UserError('That isn’t a valid regular expression');
  }
}

export type MatchMode = 'manual' | 'exact' | 'word' | 'regex';

export function matches(mode: MatchMode, keyword: string, content: string): boolean {
  const c = content.trim().toLowerCase();
  const k = keyword.trim().toLowerCase();
  switch (mode) {
    case 'exact':
      return c === k;
    case 'word':
      return new RegExp(`(^|[^\\p{L}\\p{N}_])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_])`, 'u').test(c);
    case 'regex':
      return content.length <= 2000 && checkRegex(keyword).test(content);
    default:
      return false;
  }
}
