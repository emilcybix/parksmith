import { describe, expect, it } from 'vitest';
import { MAXIMUM_LOOP_ITERATIONS, MAXIMUM_SAVED_COUNTER, requireNumberInRange } from './ranges';
import { SaveError } from './version';

describe('requireNumberInRange', () => {
  it('returns values inside the inclusive range', () => {
    expect(requireNumberInRange('Owner', 0, 'p', 0, 100), 'lower edge').toBe(0);
    expect(requireNumberInRange('Owner', 100, 'p', 0, 100), 'upper edge').toBe(100);
    expect(requireNumberInRange('Owner', 42.5, 'p', 0, 100), 'inside').toBe(42.5);
  });

  it('refuses out-of-range, non-finite and non-number values with an invalid-state error naming owner and path', () => {
    for (const bad of [-0.001, 100.001, 1e300, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) {
      let caught: unknown;
      try { requireNumberInRange('Owner', bad, 'a.b[2]', 0, 100); } catch (error) { caught = error; }
      expect(caught, `${String(bad)} is refused`).toBeInstanceOf(SaveError);
      expect((caught as SaveError).code).toBe('invalid-state');
      expect((caught as SaveError).message, 'names owner and path').toMatch(/Owner cannot restore: a\.b\[2\]/);
    }
  });

  it('keeps the counter bound far below 2^53 so id + 1 stays exact, and the loop guard finite', () => {
    expect(MAXIMUM_SAVED_COUNTER + 1_000_000, 'ids stay exactly representable').toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(MAXIMUM_LOOP_ITERATIONS)).toBe(true);
  });
});
