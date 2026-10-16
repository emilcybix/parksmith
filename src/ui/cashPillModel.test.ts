import { describe, expect, it } from 'vitest';
import { CASH_DELTA_MINIMUM, CASH_TWEEN_MS, cashDeltaText, tweenedCash } from './cashPillModel';

describe('cash pill model (Phase 15)', () => {
  it('tweens whole dollars with an ease-out to the target, and jumps under reduced motion', () => {
    const tween = { from: 1_000, to: 2_000, startMs: 100 };
    expect(tweenedCash(tween, 100, false)).toBe(1_000);
    expect(tweenedCash(tween, 100 + CASH_TWEEN_MS / 2, false)).toBe(1_875);
    expect(tweenedCash(tween, 100 + CASH_TWEEN_MS, false)).toBe(2_000);
    expect(tweenedCash(tween, 9_999, false)).toBe(2_000);
    expect(tweenedCash(tween, 100, true)).toBe(2_000);
  });

  it('a chip only for a change worth noticing', () => {
    expect(cashDeltaText(CASH_DELTA_MINIMUM - 1)).toBeNull();
    expect(cashDeltaText(40)).toBe('+$40');
    expect(cashDeltaText(-1_150)).toBe('-$1,150');
  });
});
