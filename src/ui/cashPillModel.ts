/**
 * Phase 15: the animated cash pill. Pure arithmetic, shared by the hook in Hud.tsx and its tests. A new cash value
 * tweens the shown number from where it is to the target over CASH_TWEEN_MS (ease-out cubic, whole dollars), and a
 * change of at least CASH_DELTA_MINIMUM shows a rising "+$40" / "-$1,150" chip beside it (a gain green, a spend coral).
 * Under reduced motion the number jumps and the chip only fades (styles.css). The accessible label always carries
 * the real cash, never a tweened one.
 */

export const CASH_TWEEN_MS = 450;
/** Smaller changes (a stall's takings trickling in) tween but raise no chip. */
export const CASH_DELTA_MINIMUM = 25;

export interface CashTween {
  readonly from: number;
  readonly to: number;
  readonly startMs: number;
}

/** The whole-dollar value shown at `nowMs` (the target once the tween is over, or at once under reduced motion). */
export const tweenedCash = (tween: CashTween, nowMs: number, reduced: boolean): number => {
  if (reduced) return tween.to;
  const t = Math.min(1, Math.max(0, (nowMs - tween.startMs) / CASH_TWEEN_MS));
  const eased = 1 - (1 - t) ** 3;
  return Math.round(tween.from + (tween.to - tween.from) * eased);
};

/** The chip text of a change, or null below the minimum: "+$40", "-$1,150". */
export const cashDeltaText = (delta: number): string | null => {
  const whole = Math.round(delta);
  if (Math.abs(whole) < CASH_DELTA_MINIMUM) return null;
  return `${whole > 0 ? '+' : '-'}$${Math.abs(whole).toLocaleString()}`;
};
