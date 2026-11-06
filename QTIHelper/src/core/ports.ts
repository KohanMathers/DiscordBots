import type { LockedPerm, OverwriteEdit, OverwriteState } from './lock.ts';
import type { PurgeCandidate } from './purge.ts';

export interface OverwritePort {
  overwrites(): Promise<OverwriteState[]>;
  apply(edit: OverwriteEdit): Promise<void>;
}

export interface PurgePort {
  fetchPage(before: string | null): Promise<PurgeCandidate[]>;
  bulkDelete(ids: string[]): Promise<void>;
  deleteOne(id: string): Promise<void>;
}

export class SendError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'SendError';
    this.permanent = permanent;
  }
}

export type { LockedPerm };
