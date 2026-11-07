import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface FunContent {
  facts: string[];
  slots: [string[], string[], string[]];
  memberTonight: string[];
  templates: { intro?: string; tonight?: string; membertonight?: string };
}

interface PackFile {
  id: string;
  locale?: string;
  kind: 'facts' | 'intros' | 'templates';
  slot?: number;
  entries?: string[];
  templates?: Record<string, string>;
}

export function loadFunContent(dir: string): FunContent {
  const folder = join(dir, 'fun');
  const out: FunContent = { facts: [], slots: [[], [], []], memberTonight: [], templates: {} };
  for (const file of readdirSync(folder).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort()) {
    const doc = parse(readFileSync(join(folder, file), 'utf8')) as PackFile;
    if (!doc?.kind) throw new Error(`${file}: missing "kind"`);
    const entries = (doc.entries ?? []).map((e) => String(e).trim()).filter(Boolean);
    if (doc.kind === 'facts') out.facts.push(...entries);
    else if (doc.kind === 'intros') {
      const slot = Number(doc.slot);
      if (![1, 2, 3, 4].includes(slot)) throw new Error(`${file}: intros need slot 1, 2, 3 or 4`);
      if (slot === 4) out.memberTonight.push(...entries);
      else out.slots[slot - 1]!.push(...entries);
    } else if (doc.kind === 'templates') Object.assign(out.templates, doc.templates ?? {});
  }
  return out;
}

export type Rng = () => number;
const pick = <T>(list: T[], rng: Rng): T => list[Math.floor(rng() * list.length)]!;

export function pickTwoFacts(facts: string[], rng: Rng = Math.random): [string, string] {
  if (facts.length < 2) throw new Error('need at least two facts');
  const a = Math.floor(rng() * facts.length);
  let b = Math.floor(rng() * (facts.length - 1));
  if (b >= a) b++;
  return [facts[a]!, facts[b]!];
}

export function pickTonight(slots: FunContent['slots'], rng: Rng = Math.random): [string, string, string] {
  return [pick(slots[0], rng), pick(slots[1], rng), pick(slots[2], rng)];
}

export function pickMemberTonight(pool: string[], rng: Rng = Math.random): [string, string, string] {
  return [pick(pool, rng), pick(pool, rng), pick(pool, rng)];
}
