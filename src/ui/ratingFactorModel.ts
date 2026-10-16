import type { RatingFactor } from '../game/management/types';

/**
 * Pure rows for the Overview rating factors (Phase 11, PA-016): each factor's share of the rating and the points it
 * still has to gain, sorted biggest gain first. The order uses whole points, so the 4 Hz refresh does not shuffle
 * near-equal rows; ties go to the heavier weight, then to the canonical (management) order.
 */

export const FACTOR_SORT_NOTE = 'Biggest gains first.';

export interface RatingFactorRow {
  factor: RatingFactor;
  /** `weight × 100`: the points this factor is worth at full marks. */
  maxPoints: number;
  /** The factor's `contribution` to the rating. */
  points: number;
  /** `max(0, maxPoints − points)`. */
  gain: number;
  /** `17% of the rating`. */
  weightLabel: string;
  /** `15 pts to gain` (`1 pt to gain`), or `full marks` when under half a point is left. */
  gainLabel: string;
  /** The third row line: `17% of the rating · 15 pts to gain`. */
  weightLine: string;
}

export const ratingFactorRow = (factor: RatingFactor): RatingFactorRow => {
  const maxPoints = factor.weight * 100;
  const points = factor.contribution;
  const gain = Math.max(0, maxPoints - points);
  const weightLabel = `${Math.round(factor.weight * 100)}% of the rating`;
  const wholeGain = Math.round(gain);
  const gainLabel = gain < 0.5 ? 'full marks' : `${wholeGain} ${wholeGain === 1 ? 'pt' : 'pts'} to gain`;
  return { factor, maxPoints, points, gain, weightLabel, gainLabel, weightLine: `${weightLabel} · ${gainLabel}` };
};

export const ratingFactorRows = (factors: readonly RatingFactor[]): RatingFactorRow[] =>
  factors
    .map((factor, index) => ({ row: ratingFactorRow(factor), index }))
    .sort((a, b) => Math.round(b.row.gain) - Math.round(a.row.gain)
      || b.row.factor.weight - a.row.factor.weight
      || a.index - b.index)
    .map(({ row }) => row);
