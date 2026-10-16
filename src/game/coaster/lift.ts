import { GAME_CONFIG } from '../config';
import type { CoasterTypeDefinition } from './content';
// design.ts imports this module too; the cycle is safe because both only use each other inside functions.
import { coasterBaseCost, deriveCoasterStats, type CoasterPiece } from './design';
import { coasterSpeedTrace, creepSpeedMilli } from './speedModel';

/**
 * Lift hills. A "lift" is a maximal run of consecutive climbing segments (segment i runs from piece
 * i to piece i + 1 and climbs when the next piece is higher). Each run is either chained (the
 * steady lift speed, today's behaviour and the default) or free (it climbs on momentum). The flag
 * lives on the pieces (`freeClimb` on segment i) and is kept uniform per run by `normaliseLiftFlags`.
 */

export interface LiftRun {
  /** Index of the piece the run starts at (the first climbing segment). */
  start: number;
  /** Number of climbing segments. */
  length: number;
  /** Piece index at the crest (wraps with the loop). */
  top: number;
  chained: boolean;
}

export type LiftVerdict = 'ok' | 'slow' | 'stalls';

export interface LiftRunAnalysis extends LiftRun {
  /** Cells per second entering the run, and leaving it. */
  entrySpeed: number;
  exitSpeed: number;
  /** Segments of the run that sit on the creep floor. */
  creepSegments: number;
  verdict: LiftVerdict;
}

export type SpeedSegmentKind = 'chain' | 'free' | 'creep' | 'other';

export interface CoasterLiftView {
  /** Cells per second per segment, from the saved travel times. */
  speeds: number[];
  /** Track length per segment in cells: 1, or the loop length factor on a loop piece. */
  lengths: number[];
  kinds: SpeedSegmentKind[];
  topSpeed: number;
  creepSpeed: number;
  climbingPieces: number;
  chainedPieces: number;
  freePieces: number;
  freeRuns: number;
  /**
   * What the chain added to the build, as the ledger paid it: the build cost minus the cost of the
   * same layout with every lift free, both with the chain lift rule and the construction multiplier.
   */
  chainBuildCost: number;
  /** What the chain adds to every cycle's operating charge, with the ride operating multiplier, the way RideSimulation posts it. */
  chainRunningCost: number;
}

/** The park rules the chain's share of cost is scaled by. Each defaults to 1. */
export interface LiftCostRules {
  chainLiftCostMultiplier: number;
  constructionCostMultiplier: number;
  rideOperatingCostMultiplier: number;
}

export const isClimbingSegment = (pieces: readonly CoasterPiece[], index: number): boolean =>
  pieces[(index + 1) % pieces.length].height > pieces[index].height;

const isFree = (piece: CoasterPiece): boolean => piece.freeClimb === true;

/** Every lift of the layout, ordered by start index. A run that wraps past the last piece is kept whole. */
export const liftRuns = (pieces: readonly CoasterPiece[]): LiftRun[] => {
  const count = pieces.length;
  const runs: LiftRun[] = [];
  // Start the scan after a non-climbing segment so a run is never cut in two by the array end.
  let origin = -1;
  for (let index = 0; index < count; index += 1) {
    if (!isClimbingSegment(pieces, index)) { origin = index; break; }
  }
  if (origin < 0) return runs;
  let index = 0;
  while (index < count) {
    const segment = (origin + 1 + index) % count;
    if (!isClimbingSegment(pieces, segment)) { index += 1; continue; }
    let length = 0;
    while (index + length < count && isClimbingSegment(pieces, (origin + 1 + index + length) % count)) length += 1;
    runs.push({ start: segment, length, top: (segment + length) % count, chained: !isFree(pieces[segment]) });
    index += length;
  }
  return runs.sort((a, b) => a.start - b.start);
};

const runCovers = (run: LiftRun, pieceIndex: number, count: number): boolean =>
  ((pieceIndex - run.start + count) % count) <= run.length;

/** The run that has the piece on it (its foot, its slope or its crest), or null. */
export const liftRunAtPiece = (pieces: readonly CoasterPiece[], pieceIndex: number): LiftRun | null =>
  liftRuns(pieces).find((run) => runCovers(run, pieceIndex, pieces.length)) ?? null;

/**
 * The run a "toggle lift" action means: the one under the cursor; else the one holding the last
 * placed piece; else the last run of the layout; else null.
 */
export const liftRunForTarget = (pieces: readonly CoasterPiece[], hoveredIndex: number | null): LiftRun | null => {
  const runs = liftRuns(pieces);
  if (hoveredIndex !== null && hoveredIndex >= 0 && hoveredIndex < pieces.length) {
    const hovered = runs.find((run) => runCovers(run, hoveredIndex, pieces.length));
    if (hovered) return hovered;
  }
  const last = runs.find((run) => runCovers(run, pieces.length - 1, pieces.length));
  return last ?? runs[runs.length - 1] ?? null;
};

const setFlag = (piece: CoasterPiece, free: boolean): boolean => {
  if (free) {
    if (piece.freeClimb === true) return false;
    piece.freeClimb = true;
    return true;
  }
  if (piece.freeClimb === undefined) return false;
  delete piece.freeClimb;
  return true;
};

/** Sets every segment of the run that starts at `runStart` to chained or free. Returns whether anything changed. */
export const setLiftRunChained = (pieces: CoasterPiece[], runStart: number, chained: boolean): boolean => {
  const run = liftRuns(pieces).find((candidate) => candidate.start === runStart);
  if (!run) return false;
  let changed = false;
  for (let offset = 0; offset < run.length; offset += 1) {
    if (setFlag(pieces[(run.start + offset) % pieces.length], !chained)) changed = true;
  }
  return changed;
};

/** Flips the run the piece belongs to. Returns the run after the toggle, or null when the piece has none. */
export const toggleLiftRun = (pieces: CoasterPiece[], pieceIndex: number): LiftRun | null => {
  const run = liftRunAtPiece(pieces, pieceIndex);
  if (!run) return null;
  setLiftRunChained(pieces, run.start, !run.chained);
  return liftRunAtPiece(pieces, pieceIndex);
};

/**
 * Makes the flags describe real lifts again after an edit: a segment that does not climb loses its
 * flag, and every segment of a run takes the mode of the run's first segment (so a piece appended
 * to a run inherits it, and a new run starts chained). Returns whether anything changed.
 */
export const normaliseLiftFlags = (pieces: CoasterPiece[]): boolean => {
  let changed = false;
  const inRun = new Array<boolean>(pieces.length).fill(false);
  for (const run of liftRuns(pieces)) {
    const free = isFree(pieces[run.start]);
    for (let offset = 0; offset < run.length; offset += 1) {
      const index = (run.start + offset) % pieces.length;
      inRun[index] = true;
      if (setFlag(pieces[index], free)) changed = true;
    }
  }
  pieces.forEach((piece, index) => {
    if (!inRun[index] && setFlag(piece, false)) changed = true;
  });
  return changed;
};

/**
 * Per-run speeds from the model, with a verdict for free runs that crawl (see `maxCreepSegments`).
 * The creep count that decides "stalls" is per climb, not per run: free runs split only by flat
 * track add up (a flat piece gives back a quarter of a cell per second, nowhere near a fresh start),
 * so a stairway of one-step lifts is refused like the same climb in one run. A drop, a chained
 * climb or a boost starts the count again.
 */
export const analyseLiftRuns = (pieces: readonly CoasterPiece[]): LiftRunAnalysis[] => {
  const runs = liftRuns(pieces);
  if (runs.length === 0) return [];
  const trace = coasterSpeedTrace(pieces);
  const count = pieces.length;
  const maxCreep = GAME_CONFIG.coaster.lift.maxCreepSegments;
  const runOfSegment = new Array<number>(count).fill(-1);
  runs.forEach((run, runIndex) => {
    for (let offset = 0; offset < run.length; offset += 1) runOfSegment[(run.start + offset) % count] = runIndex;
  });
  // Highest count of crawling segments on the climb, reached inside each run.
  const climbCreep = new Array<number>(runs.length).fill(0);
  let origin = -1;
  for (let index = 0; index < count; index += 1) {
    if (pieces[(index + 1) % count].height < pieces[index].height) { origin = index; break; }
  }
  let creepOnClimb = 0;
  for (let step = 1; step <= count; step += 1) {
    const segment = (origin + step + count) % count;
    if (pieces[segment].special === 'boost' || pieces[segment].special === 'launch') creepOnClimb = 0;
    const heightChange = pieces[(segment + 1) % count].height - pieces[segment].height;
    if (heightChange < 0) creepOnClimb = 0;
    else if (heightChange > 0) {
      if (!isFree(pieces[segment])) creepOnClimb = 0;
      else if (trace.creepHits[segment]) creepOnClimb += 1;
      const runIndex = runOfSegment[segment];
      if (runIndex >= 0) climbCreep[runIndex] = Math.max(climbCreep[runIndex], creepOnClimb);
    }
  }
  return runs.map((run, runIndex) => {
    let creepSegments = 0;
    for (let offset = 0; offset < run.length; offset += 1) {
      if (trace.creepHits[(run.start + offset) % count]) creepSegments += 1;
    }
    const verdict: LiftVerdict = run.chained || creepSegments === 0
      ? 'ok'
      : climbCreep[runIndex] <= maxCreep ? 'slow' : 'stalls';
    return {
      ...run,
      entrySpeed: trace.exitSpeeds[(run.start - 1 + count) % count],
      exitSpeed: trace.exitSpeeds[(run.start + run.length - 1) % count],
      creepSegments,
      verdict,
    };
  });
};

/** Counts the climbing segments by mode. A run counts as free when its first segment is. */
export const liftCounts = (pieces: readonly CoasterPiece[]): {
  climbing: number; chained: number; free: number; freeRuns: number;
} => {
  let climbing = 0;
  let free = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    if (!isClimbingSegment(pieces, index)) continue;
    climbing += 1;
    if (isFree(pieces[index])) free += 1;
  }
  const freeRuns = liftRuns(pieces).filter((run) => !run.chained).length;
  return { climbing, chained: climbing - free, free, freeRuns };
};

/** The layout with every climbing segment free (a copy; the input is untouched). */
const allFreeCopy = (pieces: readonly CoasterPiece[]): CoasterPiece[] => pieces.map((piece, index) => {
  const copy: CoasterPiece = { ...piece, cell: { ...piece.cell } };
  if (isClimbingSegment(pieces, index)) copy.freeClimb = true;
  return copy;
});

/** The per-cycle charge RideSimulation posts for a running cost (rounded to cents). */
const postedRunningCost = (runningCost: number, multiplier: number): number =>
  Math.round(runningCost * multiplier * 100) / 100;

/**
 * What the inspector shows for a built coaster: speeds from its SAVED travel times, plus the chain's
 * share of cost under the park's rules (a bare number is the chain lift rule alone, the others 1).
 */
export const describeCoasterLift = (
  pieces: readonly CoasterPiece[],
  travelSeconds: readonly number[],
  type: CoasterTypeDefinition,
  rules: number | Partial<LiftCostRules> = {},
): CoasterLiftView => {
  const config = GAME_CONFIG.coaster;
  const ruleSet: LiftCostRules = {
    chainLiftCostMultiplier: 1,
    constructionCostMultiplier: 1,
    rideOperatingCostMultiplier: 1,
    ...(typeof rules === 'number' ? { chainLiftCostMultiplier: rules } : rules),
  };
  const creepSpeed = creepSpeedMilli() / config.lift.speedScale;
  const counts = liftCounts(pieces);
  const speeds: number[] = [];
  const lengths: number[] = [];
  const kinds: SpeedSegmentKind[] = [];
  let topSpeed = 0;
  pieces.forEach((piece, index) => {
    const length = piece.special === 'loop' ? config.speed.loopLengthFactor : 1;
    const speed = length / travelSeconds[index];
    speeds.push(speed);
    lengths.push(length);
    topSpeed = Math.max(topSpeed, speed);
    let kind: SpeedSegmentKind = 'other';
    if (isClimbingSegment(pieces, index)) {
      if (!isFree(piece)) kind = 'chain';
      else kind = speed <= creepSpeed + 1e-6 ? 'creep' : 'free';
    }
    kinds.push(kind);
  });
  let chainBuildCost = 0;
  let chainRunningCost = 0;
  if (counts.chained > 0) {
    const free = allFreeCopy(pieces);
    const built = (layout: readonly CoasterPiece[]): number =>
      Math.round(coasterBaseCost(layout, type, ruleSet.chainLiftCostMultiplier) * ruleSet.constructionCostMultiplier);
    chainBuildCost = built(pieces) - built(free);
    chainRunningCost = Math.round((
      postedRunningCost(deriveCoasterStats(pieces, type).runningCost, ruleSet.rideOperatingCostMultiplier)
      - postedRunningCost(deriveCoasterStats(free, type).runningCost, ruleSet.rideOperatingCostMultiplier)
    ) * 100) / 100;
  }
  return {
    speeds,
    lengths,
    kinds,
    topSpeed,
    creepSpeed,
    climbingPieces: counts.climbing,
    chainedPieces: counts.chained,
    freePieces: counts.free,
    freeRuns: counts.freeRuns,
    chainBuildCost,
    chainRunningCost,
  };
};
