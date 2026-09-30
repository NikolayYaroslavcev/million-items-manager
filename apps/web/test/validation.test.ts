import { describe, expect, it } from 'vitest';
import { digitsOnly, secondsToAdd, validateNewId } from '../src/ui/validation.js';

describe('input helpers', () => {
  it('keeps digits only, up to the limit (D2)', () => {
    expect(digitsOnly(' 12a-3 ', 16)).toBe('123');
    expect(digitsOnly('1'.repeat(20), 16)).toHaveLength(16);
  });

  it('validates a new ID live (5.6)', () => {
    const none = () => false;
    expect(validateNewId('', none)).toBeNull();
    expect(validateNewId('0', none)).toMatch(/больше нуля/);
    expect(validateNewId('1000000', none)).toMatch(/уже существуют/);
    expect(validateNewId('9007199254740992', none)).toMatch(/Слишком большое/);
    expect(validateNewId('9007199254740991', none)).toBeNull();
    expect(validateNewId('1000001', (id) => id === 1000001)).toMatch(/в очереди/);
  });

  it('counts down to the next ADD phase', () => {
    expect(secondsToAdd(null, 0)).toBeNull();
    expect(secondsToAdd(10_000, 2_500)).toBe(8);
    expect(secondsToAdd(10_000, 13_000)).toBe(7);
    expect(secondsToAdd(10_000, 10_000)).toBe(10);
  });
});
