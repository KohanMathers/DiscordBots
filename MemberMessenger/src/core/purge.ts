export const BULK_MAX_AGE_MS = 14 * 86_400_000 - 60_000;
export const PURGE_MAX = 1000;
export const SCAN_LIMIT = 5000;

export interface PurgeCandidate {
  id: string;
  createdAt: number;
  authorId: string;
  authorBot: boolean;
  content: string;
  pinned: boolean;
}

export interface PurgeFilter {
  userId?: string | null;
  contains?: string | null;
  botsOnly?: boolean;
  includePinned?: boolean;
}

export function filterAccepts(m: PurgeCandidate, f: PurgeFilter): boolean {
  if (m.pinned && !f.includePinned) return false;
  if (f.userId && m.authorId !== f.userId) return false;
  if (f.botsOnly && !m.authorBot) return false;
  if (f.contains && !m.content.toLowerCase().includes(f.contains.toLowerCase())) return false;
  return true;
}

export function planDeletes(messages: PurgeCandidate[], nowMs: number): { batches: string[][]; singles: string[] } {
  const recent = messages.filter((m) => nowMs - m.createdAt < BULK_MAX_AGE_MS).map((m) => m.id);
  const old = messages.filter((m) => nowMs - m.createdAt >= BULK_MAX_AGE_MS).map((m) => m.id);
  const batches: string[][] = [];
  const singles = [...old];
  for (let i = 0; i < recent.length; i += 100) {
    const batch = recent.slice(i, i + 100);
    if (batch.length === 1) singles.unshift(batch[0]!);
    else batches.push(batch);
  }
  return { batches, singles };
}
