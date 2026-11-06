import { filterAccepts, PURGE_MAX, type PurgeCandidate, type PurgeFilter, planDeletes, SCAN_LIMIT } from '../core/purge.ts';
import type { PurgePort } from '../core/ports.ts';

export interface PurgeResult {
  deleted: number;
  scanned: number;
  skippedPinned: number;
  failed: number;
  cancelled: boolean;
}

export async function runPurge(o: {
  amount: number;
  filter: PurgeFilter;
  port: PurgePort;
  nowMs: number;
  onProgress?: (deleted: number, total: number) => void;
  isCancelled?: () => boolean;
}): Promise<PurgeResult> {
  const amount = Math.min(Math.max(1, o.amount), PURGE_MAX);
  const chosen: PurgeCandidate[] = [];
  let scanned = 0;
  let skippedPinned = 0;
  let before: string | null = null;

  while (chosen.length < amount && scanned < SCAN_LIMIT) {
    const page = await o.port.fetchPage(before);
    if (!page.length) break;
    for (const m of page) {
      scanned++;
      if (m.pinned && !o.filter.includePinned) skippedPinned++;
      if (filterAccepts(m, o.filter)) chosen.push(m);
      if (chosen.length >= amount) break;
    }
    before = page.at(-1)!.id;
    if (page.length < 100) break;
  }

  const { batches, singles } = planDeletes(chosen, o.nowMs);
  let deleted = 0;
  let failed = 0;
  const total = chosen.length;
  for (const batch of batches) {
    if (o.isCancelled?.()) return { deleted, scanned, skippedPinned, failed, cancelled: true };
    try {
      await o.port.bulkDelete(batch);
      deleted += batch.length;
    } catch {
      singles.push(...batch);
    }
    o.onProgress?.(deleted, total);
  }
  for (const id of singles) {
    if (o.isCancelled?.()) return { deleted, scanned, skippedPinned, failed, cancelled: true };
    try {
      await o.port.deleteOne(id);
      deleted++;
    } catch {
      failed++;
    }
    o.onProgress?.(deleted, total);
  }
  return { deleted, scanned, skippedPinned, failed, cancelled: false };
}
