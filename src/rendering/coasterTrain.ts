import type { CoasterPiece } from '../game/coaster/design';
import { GAME_CONFIG } from '../game/config';
import { isShuttleLayout, shuttleHeadIndex, shuttleProfileFor } from '../game/coaster/shuttle';

/** What the train's timing reads from a coaster record (`GameWorld.coasters`). */
export interface CoasterTimingRecord {
  readonly pieces: readonly CoasterPiece[];
  readonly stats: {
    readonly durationSeconds: number;
    readonly travelSeconds: readonly number[];
  };
}

/**
 * Fractional piece index of the train's lead car, honouring the speed profile: the train waits at
 * the end of the station while it loads, then each segment takes the seconds the deterministic
 * physics sweep assigned to it — slow up the lift, fast down the drops. Renderer-agnostic: each
 * renderer maps the index onto its own track geometry.
 *
 * `travelSeconds[i]` is the segment from piece i to piece i + 1 (`coasterSpeedProfile` derives the
 * speed from the height change towards the next piece). The train leaves from piece
 * `stationLength − 1`, so its k-th segment is `(parked + k) % n`. The first version indexed the
 * table by k instead, which applied every segment's time two pieces late: the lift was taken at
 * cruising speed and the station crawled.
 *
 * The result is unwrapped (parked … parked + n); callers wrap it onto the loop.
 * `cycleRemainingSeconds` is null while the ride is not running.
 */
export const coasterHeadIndex = (
  record: CoasterTimingRecord,
  cycleRemainingSeconds: number | null,
): number => {
  const parkedIndex = GAME_CONFIG.coaster.stationLength - 1;
  if (cycleRemainingSeconds === null) return parkedIndex;
  const travel = record.stats.travelSeconds;
  const pieceCount = record.pieces.length;
  if (travel.length !== pieceCount) return parkedIndex;
  const elapsed = record.stats.durationSeconds - cycleRemainingSeconds - GAME_CONFIG.coaster.stationLoadSeconds;
  if (elapsed <= 0) return parkedIndex;
  // Phase 44: a shuttle goes out and comes back, on its own timeline stretched over the saved ride time.
  if (isShuttleLayout(record.pieces)) {
    const riding = record.stats.durationSeconds - GAME_CONFIG.coaster.stationLoadSeconds;
    const total = shuttleProfileFor(record.pieces).totalSeconds;
    return shuttleHeadIndex(record.pieces, elapsed, total > 0 && riding > 0 ? riding / total : 1);
  }
  let remaining = elapsed;
  for (let step = 0; step < pieceCount; step += 1) {
    const seconds = travel[(parkedIndex + step) % pieceCount];
    if (remaining < seconds) return parkedIndex + step + remaining / seconds;
    remaining -= seconds;
  }
  return parkedIndex;
};

/**
 * The cycle's remaining seconds at `stepFraction` of the way into the next fixed step.
 *
 * `cycleRemainingSeconds` only changes once per simulation step (10 Hz), so a train placed straight
 * from it moves in 10 Hz jumps while guests and ride parts glide. The ride is deterministic, so the
 * remaining time `stepFraction` steps from now is simply that much less: the train is drawn at the
 * simulation's true time instead of lagging up to a step behind it. `stepFraction` is measured in
 * simulation time (SimulationClock scales it by the game speed), so 2x and 4x need no extra factor,
 * and a paused clock freezes it. The clamp keeps a cycle that is about to end at the parked
 * position and one that just started at its first, so the train never moves backwards across a
 * step, a cycle start or the wrap.
 */
export const coasterInterpolatedRemaining = (
  cycleRemainingSeconds: number,
  durationSeconds: number,
  stepFraction: number,
): number => {
  const fraction = stepFraction > 0 ? Math.min(stepFraction, 1) : 0;
  const remaining = cycleRemainingSeconds - (fraction * GAME_CONFIG.fixedStepMs) / 1000;
  return Math.min(durationSeconds, Math.max(0, remaining));
};
