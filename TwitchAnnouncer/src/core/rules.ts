import type { EventKind, FirstSyncMode, SourceEvent } from './types.ts';

const ONGOING_KINDS: ReadonlySet<EventKind> = new Set(['LIVE_START']);

const NON_ANNOUNCING_KINDS: ReadonlySet<EventKind> = new Set(['LIVE_END']);

export interface DetectionPolicy {
  firstPoll: boolean;
  firstSync: FirstSyncMode;
  maxAgeMs: number;
  now: Date;
}

export function isAnnounceable(event: SourceEvent, policy: DetectionPolicy): boolean {
  if (NON_ANNOUNCING_KINDS.has(event.kind)) return false;
  if (policy.firstPoll && policy.firstSync === 'mark-seen') return false;
  if (ONGOING_KINDS.has(event.kind)) return true;
  const occurred = Date.parse(event.occurredAt);
  if (Number.isNaN(occurred)) return false;
  return policy.now.getTime() - occurred <= policy.maxAgeMs;
}

export function filterAccepts(filters: { kinds: string[] } | null, kind: EventKind): boolean {
  if (!filters) return true;
  return filters.kinds.includes(kind);
}
