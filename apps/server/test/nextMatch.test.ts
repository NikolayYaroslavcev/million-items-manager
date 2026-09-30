import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nextMatch } from '../src/store/nextMatch.js';

function brute(x: number, s: string, max: number): number | null {
  for (let y = Math.max(1, x); y <= max; y++) if (String(y).includes(s)) return y;
  return null;
}

describe('nextMatch', () => {
  it('matches brute force for every filter of length 1-2 and many x (max 1e5)', () => {
    const max = 100_000;
    const filters: string[] = [];
    for (let i = 0; i < 10; i++) filters.push(String(i));
    for (let i = 0; i < 100; i++) filters.push(String(i).padStart(2, '0'));
    for (const s of filters) {
      let x = 1;
      let expected = brute(x, s, max);
      for (let steps = 0; steps < 3000 && expected !== null; steps++) {
        expect(nextMatch(x, s, max)).toBe(expected);
        x = expected + 1;
        expected = brute(x, s, max);
      }
    }
  });

  it('matches brute force for all 3-digit filters on sampled x', () => {
    const max = 1_000_000;
    for (let i = 0; i < 1000; i++) {
      const s = String(i).padStart(3, '0');
      for (const x of [1, 7, 99, 100, 999, 1000, 54_321, 999_000, 999_999]) {
        expect(nextMatch(x, s, max), `x=${x} s=${s}`).toBe(brute(x, s, max));
      }
    }
  });

  it('matches brute force on 10 000 random (x, filter) pairs, filter length 1-3', () => {
    const max = 1_000_000;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: max + 5 }),
        fc.stringMatching(/^\d{1,3}$/),
        (x, s) => nextMatch(x, s, max) === brute(x, s, max),
      ),
      { numRuns: 10_000 },
    );
  });

  it('matches brute force on random filters of length 4-7', () => {
    const max = 1_000_000;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: max }),
        fc.stringMatching(/^\d{4,7}$/),
        (x, s) => nextMatch(x, s, max) === brute(x, s, max),
      ),
      { numRuns: 300 },
    );
  });

  it('handles edge cases', () => {
    expect(nextMatch(1, '0', 1_000_000)).toBe(10);
    expect(nextMatch(1, '00', 1_000_000)).toBe(100);
    expect(nextMatch(1, '1000000', 1_000_000)).toBe(1_000_000);
    expect(nextMatch(1, '1234567', 1_000_000)).toBeNull();
    expect(nextMatch(1, '9999999999999999', 1_000_000)).toBeNull();
    expect(nextMatch(1_000_001, '1', 1_000_000)).toBeNull();
    expect(nextMatch(-5, '5', 100)).toBe(5);
    expect(nextMatch(999_999, '999999', 1_000_000)).toBe(999_999);
  });
});
