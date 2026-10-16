import type { UiScale } from './schema';

/** CSS pixels the HUD needs to lay out without overlaps; calibrated by the overlap audit. */
export const UI_LAYOUT_MIN_WIDTH = 1100;
export const UI_LAYOUT_MIN_HEIGHT = 690;

/**
 * The scale actually applied to the UI layer. Scaling down (85) and 100 are never changed by the
 * clamp; scaling UP is capped to what fits the window and never goes below 100.
 */
export const effectiveUiScale = (pref: UiScale, innerWidth: number, innerHeight: number): number => {
  const wanted = pref / 100;
  if (wanted <= 1) return wanted;
  const fit = Math.min(innerWidth / UI_LAYOUT_MIN_WIDTH, innerHeight / UI_LAYOUT_MIN_HEIGHT);
  if (!Number.isFinite(fit)) return 1;
  return Math.max(1, Math.min(wanted, fit));
};

export const isUiScaleCapped = (pref: UiScale, innerWidth: number, innerHeight: number): boolean => (
  effectiveUiScale(pref, innerWidth, innerHeight) < pref / 100 - 1e-9
);
