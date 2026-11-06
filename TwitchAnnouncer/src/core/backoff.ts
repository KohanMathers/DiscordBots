export const MAX_DELIVERY_ATTEMPTS = 3;

const RETRY_DELAYS_MS = [60_000, 240_000];

export function nextRetryDelayMs(failedAttempts: number): number | null {
  if (failedAttempts >= MAX_DELIVERY_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[failedAttempts - 1] ?? null;
}
