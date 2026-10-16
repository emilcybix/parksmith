import type { CoasterLiftView, SpeedSegmentKind } from '../game/coaster/lift';

/** A speed bar is never scaled against less than this, so a slow coaster does not look fast. */
export const SPEED_STRIP_MIN_SCALE = 6;

export interface SpeedStripBar {
  x: number;
  w: number;
  /** Bar height in px, at least 1 so a crawl is still visible. */
  h: number;
  kind: SpeedSegmentKind;
}

export interface SpeedStripModel {
  bars: SpeedStripBar[];
  /** Y of the creep floor line, measured from the top of the strip. */
  creepY: number;
  scale: number;
  summary: string;
}

const formatSpeed = (value: number): string => (Math.round(value * 10) / 10).toString();

/**
 * Lays the per-segment speeds out as bars: width follows the track distance (a loop counts three
 * cells), height follows the speed against the faster of the top speed and `SPEED_STRIP_MIN_SCALE`.
 * Pure, so the strip's maths is tested without a DOM.
 */
export const speedStripModel = (view: CoasterLiftView, widthPx: number, heightPx: number): SpeedStripModel => {
  const total = view.lengths.reduce((sum, length) => sum + length, 0);
  const scale = Math.max(view.topSpeed, SPEED_STRIP_MIN_SCALE);
  const bars: SpeedStripBar[] = [];
  let cursor = 0;
  view.speeds.forEach((speed, index) => {
    const w = total > 0 ? (view.lengths[index] / total) * widthPx : 0;
    const h = Math.max(1, Math.min(heightPx, (speed / scale) * heightPx));
    bars.push({ x: cursor, w, h, kind: view.kinds[index] });
    cursor += w;
  });
  const slowest = view.speeds.length > 0 ? Math.min(...view.speeds) : 0;
  const free = view.freeRuns;
  return {
    bars,
    creepY: heightPx - (view.creepSpeed / scale) * heightPx,
    scale,
    summary: `Speed from ${formatSpeed(slowest)} to ${formatSpeed(view.topSpeed)} cells per second; `
      + `${free === 0 ? 'no free climbs' : `${free} free climb${free === 1 ? '' : 's'}`}`,
  };
};

const money = (value: number): string => `$${Math.round(value).toLocaleString()}`;

/** The cost line under the strip. */
export const chainCostLine = (view: CoasterLiftView): string => {
  if (view.climbingPieces === 0) return 'No climbs: nothing to chain.';
  if (view.chainedPieces === 0) return 'No chain lift: every hill climbs free.';
  return `Chain lift on ${view.chainedPieces} of ${view.climbingPieces} climbing pieces`
    + ` · ${money(view.chainBuildCost)} of the build · $${view.chainRunningCost.toFixed(2)}/cycle`;
};
