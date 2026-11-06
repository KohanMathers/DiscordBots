import { describe, expect, it } from 'vitest';
import { shouldFire } from '../src/fork/jag/index.ts';

describe('jag trigger', () => {
  it.each(["But it's okay", 'but its okay fjfdhsgjhdsfg', 'BUT IT’S OKAY', 'but   its okay', "yeah but it's okay!"])('fires on %j', (text) => expect(shouldFire(text)).toBe(true));

  it.each(['but it is okay', "but it's ok", 'butits okay', "but it's okayish", 'nothing to see'])('ignores %j', (text) => expect(shouldFire(text)).toBe(false));
});
