export type Tri = 'allow' | 'deny' | 'inherit';
export const LOCKED_PERMS = ['SendMessages', 'SendMessagesInThreads'] as const;
export type LockedPerm = (typeof LOCKED_PERMS)[number];

export interface OverwriteState {
  id: string;
  type: 'role' | 'member';
  allow: ReadonlySet<string>;
  deny: ReadonlySet<string>;
}

export interface RoleFacts {
  id: string;
  position: number;
  staff: boolean;
}

export interface Snapshot {
  targetId: string;
  targetType: 'role' | 'member';
  existed: boolean;
  prior: Record<LockedPerm, Tri>;
}

export interface OverwriteEdit {
  targetId: string;
  targetType: 'role' | 'member';
  set: Record<LockedPerm, boolean | null>;
  deleteIfEmpty: boolean;
}

const triOf = (o: OverwriteState | undefined, p: string): Tri => (o?.allow.has(p) ? 'allow' : o?.deny.has(p) ? 'deny' : 'inherit');
const snap = (o: OverwriteState | undefined, id: string, type: 'role' | 'member'): Snapshot => ({
  targetId: id,
  targetType: type,
  existed: Boolean(o),
  prior: { SendMessages: triOf(o, 'SendMessages'), SendMessagesInThreads: triOf(o, 'SendMessagesInThreads') },
});
const allSet = (v: boolean | null) => ({ SendMessages: v, SendMessagesInThreads: v });

export interface LockPlan {
  snapshots: Snapshot[];
  edits: OverwriteEdit[];
  skipped: Array<{ id: string; reason: 'staff' | 'above-bot' }>;
}

export function planLock(o: {
  everyoneId: string;
  botId: string;
  botTopPosition: number;
  overwrites: OverwriteState[];
  roles: Map<string, RoleFacts>;
  staffMemberIds: ReadonlySet<string>;
}): LockPlan {
  const byId = new Map(o.overwrites.map((w) => [w.id, w]));
  const snapshots: Snapshot[] = [];
  const edits: OverwriteEdit[] = [];
  const skipped: LockPlan['skipped'] = [];

  const lockTarget = (id: string, type: 'role' | 'member') => {
    const s = snap(byId.get(id), id, type);
    snapshots.push(s);
    edits.push({ targetId: id, targetType: type, set: allSet(false), deleteIfEmpty: false });
  };

  const everyone = o.roles.get(o.everyoneId);
  if (!everyone?.staff) lockTarget(o.everyoneId, 'role');

  for (const w of o.overwrites) {
    if (w.id === o.everyoneId || w.id === o.botId) continue;
    if (w.type === 'role') {
      const r = o.roles.get(w.id);
      if (!r) continue;
      if (r.staff) skipped.push({ id: w.id, reason: 'staff' });
      else if (r.position >= o.botTopPosition) skipped.push({ id: w.id, reason: 'above-bot' });
      else lockTarget(w.id, 'role');
    } else if (!o.staffMemberIds.has(w.id) && LOCKED_PERMS.some((p) => w.allow.has(p))) {
      lockTarget(w.id, 'member');
    }
  }

  const bot = snap(byId.get(o.botId), o.botId, 'member');
  snapshots.push(bot);
  edits.push({ targetId: o.botId, targetType: 'member', set: allSet(true), deleteIfEmpty: false });

  return { snapshots, edits, skipped };
}

const triToValue = (t: Tri): boolean | null => (t === 'allow' ? true : t === 'deny' ? false : null);

export function planRestore(snapshots: Snapshot[]): OverwriteEdit[] {
  return snapshots.map((s) => ({
    targetId: s.targetId,
    targetType: s.targetType,
    set: { SendMessages: triToValue(s.prior.SendMessages), SendMessagesInThreads: triToValue(s.prior.SendMessagesInThreads) },
    deleteIfEmpty: !s.existed,
  }));
}
