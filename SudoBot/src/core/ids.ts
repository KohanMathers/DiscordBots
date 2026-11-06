import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(nowMs = Date.now()): string {
  let time = '';
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += ALPHABET[rand[i]! % 32];
  return time + r;
}
