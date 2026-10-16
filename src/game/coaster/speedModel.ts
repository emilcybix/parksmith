import { GAME_CONFIG } from '../config';
import type { CoasterPiece } from './design';

/**
 * The coaster speed model: a deterministic sweep around the loop. A chained climb hauls the train
 * at the steady lift speed; a FREE climb runs on momentum in fixed-point integer maths (speed
 * squared falls with the height gained, never below a creep floor, so there is no stall state);
 * drops accelerate, flats bleed toward cruise, loops scrub and boosts launch.
 *
 * Segment i runs from piece i to piece i + 1 (wrapping), the indexing of `travelSeconds[i]`,
 * `freeClimb` and the centre line's `chained[i]`.
 *
 * Every statement of the chained path is today's float arithmetic in today's order, so a layout
 * without a free climb produces bit-identical numbers (chainedEquivalence.test.ts proves it
 * against a frozen copy of the old code).
 */

export interface CoasterSpeedTrace {
  /** Identical to `coasterSpeedProfile(pieces).travelSeconds`. */
  travelSeconds: number[];
  /** Cells per second held on segment i (before the loop length factor). */
  segmentSpeeds: number[];
  /** Cells per second after segment i. */
  exitSpeeds: number[];
  /** True on a free climbing segment whose exit speed sits on the creep floor. */
  creepHits: boolean[];
  /** The creep floor in cells per second. */
  creepSpeed: number;
}

const round = (value: number, decimals = 1): number => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

/** Exact integer square root of a non-negative integer below 2^53 (corrects any Math.sqrt rounding). */
export const integerSquareRoot = (value: number): number => {
  let root = Math.floor(Math.sqrt(value));
  while (root * root > value) root -= 1;
  while ((root + 1) * (root + 1) <= value) root += 1;
  return root;
};

/** The creep floor in milli-cells per second. */
export const creepSpeedMilli = (): number => {
  const lift = GAME_CONFIG.coaster.lift;
  return Math.floor(Math.round(GAME_CONFIG.coaster.speed.maximum * lift.speedScale) * lift.creepPermille / 1000);
};

interface Sweep {
  trace: CoasterSpeedTrace;
  topSpeedRaw: number;
  total: number;
}

const sweep = (pieces: readonly CoasterPiece[]): Sweep => {
  const speedConfig = GAME_CONFIG.coaster.speed;
  const liftConfig = GAME_CONFIG.coaster.lift;
  const scale = liftConfig.speedScale;
  const creepMilli = creepSpeedMilli();
  let speed: number = speedConfig.cruise;
  let topSpeed = speed;
  const travelSeconds: number[] = [];
  const segmentSpeeds: number[] = [];
  const exitSpeeds: number[] = [];
  const creepHits: boolean[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const current = pieces[index];
    const next = pieces[(index + 1) % pieces.length];
    if (current.special === 'boost') speed = Math.max(speed, speedConfig.boost);
    if (current.special === 'launch') speed = Math.max(speed, speedConfig.launch);
    if (current.special === 'loop') speed = Math.max(speedConfig.minimum, speed - speedConfig.loopDrag);
    const heightChange = next.height - current.height;
    let segmentSpeed: number;
    let hit = false;
    if (heightChange > 0 && current.freeClimb === true) {
      // Free climb, all integers: speed squared (milli-cells/s squared) loses a fixed amount per level.
      const entry = Math.round(speed * scale);
      const raw = entry * entry - liftConfig.freeClimbLossPerLevel * heightChange;
      const floor = creepMilli * creepMilli;
      hit = raw < floor;
      const exit = integerSquareRoot(hit ? floor : raw);
      const held = Math.max(creepMilli, (entry + exit) >> 1);
      speed = exit / scale;
      segmentSpeed = held / scale;
    } else {
      if (heightChange > 0) speed = speedConfig.lift;
      else if (heightChange < 0) {
        speed = Math.min(speedConfig.maximum, speed + -heightChange * speedConfig.dropBoostPerLevel);
      } else {
        speed = speed > speedConfig.cruise
          ? Math.max(speedConfig.cruise, speed - speedConfig.flatDrag)
          : Math.min(speedConfig.cruise, speed + speedConfig.flatDrag);
      }
      segmentSpeed = speed;
    }
    topSpeed = Math.max(topSpeed, speed);
    // A loop piece carries the loop's whole circumference, not just one cell of track.
    travelSeconds.push((1 / segmentSpeed) * (current.special === 'loop' ? speedConfig.loopLengthFactor : 1));
    segmentSpeeds.push(segmentSpeed);
    exitSpeeds.push(speed);
    creepHits.push(hit);
  }
  return {
    trace: { travelSeconds, segmentSpeeds, exitSpeeds, creepHits, creepSpeed: creepMilli / scale },
    topSpeedRaw: topSpeed,
    total: travelSeconds.reduce((total, seconds) => total + seconds, 0),
  };
};

/** The ride profile numbers (the shape the stats, the train animation and the golden test pin). */
export const coasterSpeedProfile = (
  pieces: readonly CoasterPiece[],
): { travelSeconds: number[]; topSpeed: number; totalTravelSeconds: number } => {
  const result = sweep(pieces);
  return {
    travelSeconds: result.trace.travelSeconds,
    topSpeed: round(result.topSpeedRaw),
    totalTravelSeconds: result.total,
  };
};

/** The sweep with its per-segment speeds, for the designer's checks and the inspector's strip. */
export const coasterSpeedTrace = (pieces: readonly CoasterPiece[]): CoasterSpeedTrace => sweep(pieces).trace;
