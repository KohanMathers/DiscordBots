export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const iso = (d: Date): string => d.toISOString();
