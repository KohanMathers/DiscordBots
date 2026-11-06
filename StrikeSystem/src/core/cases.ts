import { UserError } from './errors.ts';

export type CaseStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'SUPERSEDED';
export type DmStatus = 'PENDING' | 'SENT' | 'FAILED' | 'DISABLED' | 'N/A';

export interface Evidence {
  kind: 'attachment' | 'message_link' | 'text';
  url?: string;
  filename?: string;
  size?: number;
  sha256?: string;
  path?: string;
  text?: string;
}

export interface Case {
  id: string;
  guildId: string;
  number: number;
  type: string;
  targetId: string | null;
  actorId: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string | null;
  durationS: number | null;
  status: CaseStatus;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  parentCase: string | null;
  evidence: Evidence[];
  dmStatus: DmStatus;
  logMessageId: string | null;
  metadata: Record<string, unknown>;
}

export interface CaseTypeDef {
  type: string;
  title: string;
  icon: string;
  color: number;
  countsAsStrike?: boolean;
  visibleToUser?: boolean;
  dmVerb?: string;
}

const RED = 0xe74c3c;
const AMBER = 0xf39c12;
const GREEN = 0x2ecc71;
const BLUE = 0x3498db;
const GREY = 0x95a5a6;
const DARK_RED = 0x992d22;

export const CORE_CASE_TYPES: CaseTypeDef[] = [
  { type: 'STRIKE', title: 'Strike', icon: '⚠️', color: RED, countsAsStrike: true, visibleToUser: true, dmVerb: 'received a strike' },
  { type: 'STRIKE_REVOKE', title: 'Strike revoked', icon: '↩️', color: GREEN, visibleToUser: true },
  { type: 'WARN', title: 'Warning', icon: '📝', color: AMBER, visibleToUser: true, dmVerb: 'been warned' },
  { type: 'TIMEOUT', title: 'Timeout', icon: '🔇', color: AMBER, visibleToUser: true, dmVerb: 'been timed out' },
  { type: 'UNTIMEOUT', title: 'Timeout removed', icon: '🔊', color: GREEN, visibleToUser: true },
  { type: 'KICK', title: 'Kick', icon: '👢', color: AMBER, visibleToUser: true, dmVerb: 'been kicked' },
  { type: 'BAN', title: 'Ban', icon: '🔨', color: DARK_RED, visibleToUser: true, dmVerb: 'been banned' },
  { type: 'UNBAN', title: 'Unban', icon: '🕊️', color: GREEN, visibleToUser: true },
  { type: 'NOTE', title: 'Staff note', icon: '🗒️', color: GREY },
  { type: 'ESCALATION_NOTIFY', title: 'Escalation alert', icon: '📣', color: AMBER },
  { type: 'CONFIG_CHANGE', title: 'Settings changed', icon: '⚙️', color: BLUE },
  { type: 'DATA_PURGE', title: 'User data purged', icon: '🧹', color: GREY },
];

export class CaseTypeRegistry {
  private readonly types = new Map<string, CaseTypeDef>();

  constructor(defs: CaseTypeDef[] = []) {
    for (const d of [...CORE_CASE_TYPES, ...defs]) this.add(d);
  }

  add(def: CaseTypeDef): void {
    if (this.types.has(def.type)) throw new Error(`case type ${def.type} registered twice`);
    this.types.set(def.type, def);
  }

  get(type: string): CaseTypeDef {
    return this.types.get(type) ?? { type, title: type, icon: '•', color: GREY };
  }

  strikeTypes(): string[] {
    return [...this.types.values()].filter((t) => t.countsAsStrike).map((t) => t.type);
  }

  all(): CaseTypeDef[] {
    return [...this.types.values()];
  }
}

export const MAX_REASON = 1000;

export function checkReason(reason: string | null | undefined): string | null {
  const r = reason?.trim() ?? '';
  if (r.length > MAX_REASON) {
    throw new UserError(`The reason is ${r.length} characters; the limit is ${MAX_REASON}.`);
  }
  return r || null;
}
