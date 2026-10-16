import { GAME_CONFIG } from '../config';
import type { Cell } from '../types';
import type { CoasterSpecial, CoasterTypeDefinition } from './content';
import { analyseLiftRuns, isClimbingSegment, liftCounts, liftRuns, type LiftRunAnalysis } from './lift';
import { isShuttleLayout, isValidLaunchSpeed, shuttleProfile, shuttleTravelSeconds, type ShuttleProfile } from './shuttle';
import { coasterSpeedProfile } from './speedModel';

export { coasterSpeedProfile, coasterSpeedTrace, type CoasterSpeedTrace } from './speedModel';

export interface CoasterPiece {
  cell: Cell;
  height: number;
  special?: CoasterSpecial;
  /**
   * Segment i (this piece to the next) climbs on momentum instead of on a chain. Only `true` means
   * anything: absent, undefined or false is chained, which is what every older coaster is.
   */
  freeClimb?: boolean;
  /**
   * Phase 44: on the FIRST piece only, the launch speed (cells per second) of a shuttle layout: its presence is what
   * makes a layout a shuttle (open, out and back; shuttle.ts). Absent on every circuit.
   */
  launchSpeed?: number;
}

export type CoasterValidationFailure =
  | 'too-short'
  | 'too-long'
  | 'not-adjacent'
  | 'overlapping'
  /** Phase 38: a repeated cell closer in height than `trackClearanceLevels`. */
  | 'crossing-too-close'
  /** Phase 38: a repeated cell where one of the two pieces is a station piece, a special, or under a loop ring. */
  | 'crossing-not-allowed'
  | 'not-closed'
  | 'station-not-flat'
  | 'station-not-straight'
  | 'height-step'
  | 'height-range'
  | 'no-drop'
  | 'special-not-allowed'
  | 'special-not-straight'
  | 'special-on-station'
  | 'specials-too-close'
  | 'lift-flag-not-climbing'
  | 'lift-run-mixed'
  /** Phase 39: a wild mouse turns only on the flat (the piece and both neighbours at one height). */
  | 'mouse-turn-not-flat'
  /** Phase 39 step 2: a launch coaster needs at least one launch piece. */
  | 'launch-missing'
  /** Phase 44: a shuttle's launch speed is missing from its first piece, off the range, or on another piece. */
  | 'launch-speed-range'
  /** Phase 44: a shuttle needs a climb of 2 levels or more to turn on. */
  | 'shuttle-no-climb'
  /** Phase 44: the last piece of a shuttle (its spike top) carries no special. */
  | 'shuttle-special-at-end'
  /** Phase 44: a shuttle layout for a type that is not a shuttle type. */
  | 'shuttle-not-allowed'
  /** Designer only (checkCoasterDesign): never raised when a save loads. */
  | 'free-climb-stalls'
  /** Phase 44, designer only: the shuttle reaches the end of its track with speed to spare. */
  | 'shuttle-overshoots'
  /** Phase 44, designer only: the shuttle runs out of momentum on flat or falling track. */
  | 'shuttle-stops-flat'
  /** Phase 44, designer only: the shuttle is too slow for a loop, out or back. */
  | 'shuttle-loop-slow'
  /** Phase 44, designer only: rolling back, the shuttle crawls over a hill. */
  | 'shuttle-stalls-back';

export type CoasterValidation =
  | { ok: true }
  | { ok: false; reason: CoasterValidationFailure; pieceIndex: number | null };

/** Everything a finished layout implies: ride profile numbers plus the evidence behind them. */
export interface CoasterDerivedStats {
  pieces: number;
  turns: number;
  drops: number;
  totalDescent: number;
  biggestDrop: number;
  highestHeight: number;
  loops: number;
  boosts: number;
  topSpeed: number;
  excitement: number;
  intensity: number;
  durationSeconds: number;
  /** Seconds the train spends on each piece, from the deterministic speed profile. */
  travelSeconds: number[];
  capacity: number;
  runningCost: number;
  ticketPrice: number;
  reliability: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));
const round = (value: number, decimals = 1): number => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const isCardinalNeighbor = (a: Cell, b: Cell): boolean =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;

const directionBetween = (from: Cell, to: Cell): string => `${to.x - from.x},${to.y - from.y}`;

const isStraightAt = (pieces: readonly CoasterPiece[], index: number): boolean => {
  const previous = pieces[(index - 1 + pieces.length) % pieces.length];
  const next = pieces[(index + 1) % pieces.length];
  return directionBetween(previous.cell, pieces[index].cell)
    === directionBetween(pieces[index].cell, next.cell);
};

const failure = (reason: CoasterValidationFailure, pieceIndex: number | null = null): CoasterValidation =>
  ({ ok: false, reason, pieceIndex });

/**
 * Phase 38: whether piece `index` keeps its cell to itself (nothing crosses it, above or below): a station piece, a
 * loop or a boost, and the piece after a loop (the ring overhangs into it). Reads the layout as a closed ring.
 */
export const isExclusiveCoasterPiece = (pieces: readonly CoasterPiece[], index: number): boolean => {
  if (index < GAME_CONFIG.coaster.stationLength) return true;
  if (pieces[index].special !== undefined) return true;
  const previous = pieces[(index - 1 + pieces.length) % pieces.length];
  return previous?.special === 'loop';
};

/** Phase 38: whether two track pieces may share a cell: far enough apart in height, neither exclusive. */
export const trackPiecesMayCross = (lowerOrUpper: number, other: number): boolean =>
  Math.abs(lowerOrUpper - other) >= GAME_CONFIG.coaster.trackClearanceLevels;

/** Phase 38: how many cells a layout visits twice (or more: each extra visit counts). */
export const coasterCrossings = (pieces: readonly CoasterPiece[]): number => {
  const seen = new Set<string>();
  let crossings = 0;
  for (const piece of pieces) {
    const key = `${piece.cell.x},${piece.cell.y}`;
    if (seen.has(key)) crossings += 1;
    else seen.add(key);
  }
  return crossings;
};

/**
 * Geometry rules for a buildable layout: an orderly closed loop of unique, cardinally
 * chained cells; a straight, flat station at the start; heights within the coaster
 * type's limit changing one level per piece; specials the type allows, on straight
 * non-station pieces only; and at least one real drop so the train has somewhere to go.
 * World-level concerns (terrain, paths, cash) are checked at placement, not here.
 */
export const validateCoasterLayout = (
  pieces: readonly CoasterPiece[],
  type: CoasterTypeDefinition,
): CoasterValidation => {
  const config = GAME_CONFIG.coaster;
  if (isShuttleLayout(pieces)) return validateShuttleLayout(pieces, type);
  if (pieces.length < config.minimumPieces) return failure('too-short');
  if (pieces.length > config.maximumPieces) return failure('too-long');
  const run = validatePieceRun(pieces, type);
  if (run) return run;
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (!isCardinalNeighbor(last.cell, first.cell)) return failure('not-closed');
  if (Math.abs(last.height - first.height) > 1) return failure('height-step', pieces.length - 1);
  const station = validateStation(pieces);
  if (station) return station;

  const specialIndices: number[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (!piece.special) continue;
    if (!type.allowedSpecials.includes(piece.special)) return failure('special-not-allowed', index);
    if (index < config.stationLength) return failure('special-on-station', index);
    if (!isStraightAt(pieces, index)) return failure('special-not-straight', index);
    specialIndices.push(index);
  }
  // Loops and boosts need breathing room, or their silhouettes overlap on screen.
  for (let index = 1; index <= specialIndices.length; index += 1) {
    const previous = specialIndices[index - 1];
    const current = specialIndices[index % specialIndices.length];
    const gap = index === specialIndices.length
      ? pieces.length - previous + current
      : current - previous;
    if (specialIndices.length > 1 && gap < 2) return failure('specials-too-close', current);
  }

  const highest = Math.max(...pieces.map((piece) => piece.height));
  const hasDrop = pieces.some((piece, index) => index > 0 && piece.height < pieces[index - 1].height);
  if (highest < 2 || !hasDrop) return failure('no-drop');

  // Phase 39: family rules (a steel layout never meets one).
  if (type.family === 'launch' && !pieces.some((piece) => piece.special === 'launch')) return failure('launch-missing');
  if (type.family === 'wild-mouse') {
    for (let index = 0; index < pieces.length; index += 1) {
      if (isStraightAt(pieces, index)) continue;
      const previous = pieces[(index - 1 + pieces.length) % pieces.length];
      const next = pieces[(index + 1) % pieces.length];
      if (previous.height !== pieces[index].height || next.height !== pieces[index].height) return failure('mouse-turn-not-flat', index);
    }
  }

  // Lift flags are data rules (safe at load): a flag only on a climbing segment, one mode per run.
  for (const [index, piece] of pieces.entries()) {
    if (piece.launchSpeed !== undefined) return failure('launch-speed-range', index);
    if (piece.freeClimb === true && !isClimbingSegment(pieces, index)) return failure('lift-flag-not-climbing', index);
  }
  for (const liftRun of liftRuns(pieces)) {
    for (let offset = 1; offset < liftRun.length; offset += 1) {
      const index = (liftRun.start + offset) % pieces.length;
      if ((pieces[index].freeClimb === true) !== !liftRun.chained) return failure('lift-run-mixed', index);
    }
  }
  return { ok: true };
};

/** The height cap of a type: its own, within the save's absolute cap (the launch family's own before Phase 45). */
export const coasterMaximumHeight = (type: CoasterTypeDefinition): number => {
  const config = GAME_CONFIG.coaster;
  return Math.min(type.maximumHeight, type.family === 'launch' ? config.launchMaximumHeight : config.absoluteMaximumHeight);
};

/** The station rules: the first `stationLength` pieces flat at level 0, in a straight line. */
const validateStation = (pieces: readonly CoasterPiece[]): CoasterValidation | null => {
  const config = GAME_CONFIG.coaster;
  for (let index = 0; index < config.stationLength; index += 1) {
    if (pieces[index].height !== 0) return failure('station-not-flat', index);
  }
  const stationDirection = directionBetween(pieces[0].cell, pieces[1].cell);
  for (let index = 1; index < config.stationLength; index += 1) {
    if (directionBetween(pieces[index - 1].cell, pieces[index].cell) !== stationDirection) {
      return failure('station-not-straight', index);
    }
  }
  return null;
};

/**
 * Phase 44: the rules of a shuttle layout (open, out and back): a shuttle type, the station as on a circuit, the
 * launch speed on the first piece only and on the designer's grid, no lift flags (nothing is chained), no launch
 * pieces (the station launches), no special on the last piece, and a climb of 2 levels or more. No closure.
 */
const validateShuttleLayout = (pieces: readonly CoasterPiece[], type: CoasterTypeDefinition): CoasterValidation => {
  const config = GAME_CONFIG.coaster;
  if (type.layout !== 'shuttle') return failure('shuttle-not-allowed', 0);
  if (pieces.length < config.shuttle.minimumPieces) return failure('too-short');
  if (pieces.length > config.maximumPieces) return failure('too-long');
  const run = validatePieceRun(pieces, type);
  if (run) return run;
  const station = validateStation(pieces);
  if (station) return station;
  const count = pieces.length;
  let previousSpecial = -10;
  for (const [index, piece] of pieces.entries()) {
    if (index === 0 ? !isValidLaunchSpeed(piece.launchSpeed) : piece.launchSpeed !== undefined) return failure('launch-speed-range', index);
    if (piece.freeClimb !== undefined) return failure('lift-flag-not-climbing', index);
    if (!piece.special) continue;
    if (piece.special === 'launch' || !type.allowedSpecials.includes(piece.special)) return failure('special-not-allowed', index);
    if (index < config.stationLength) return failure('special-on-station', index);
    if (index === count - 1) return failure('shuttle-special-at-end', index);
    if (!isStraightAt(pieces, index)) return failure('special-not-straight', index);
    if (index - previousSpecial < 2) return failure('specials-too-close', index);
    previousSpecial = index;
  }
  if (Math.max(...pieces.map((piece) => piece.height)) < 2) return failure('shuttle-no-climb');
  return { ok: true };
};

/**
 * The per-piece rules every layout shares: crossings (Phase 38), the height range and cardinal, one-level steps
 * between consecutive pieces. Returns the first failure, or null.
 */
const validatePieceRun = (pieces: readonly CoasterPiece[], type: CoasterTypeDefinition): CoasterValidation | null => {
  const maximumHeight = coasterMaximumHeight(type);
  // Phase 38: a cell may be visited again when the two pieces are far enough apart in height and neither keeps
  // its cell to itself (station, special, under a loop ring); `overlapping` stays for an exact repeat height.
  const seen = new Map<string, number[]>();
  for (const [index, piece] of pieces.entries()) {
    const key = `${piece.cell.x},${piece.cell.y}`;
    const earlier = seen.get(key);
    if (earlier === undefined) {
      seen.set(key, [index]);
    } else {
      for (const other of earlier) {
        if (pieces[other].height === piece.height) return failure('overlapping', index);
        if (!trackPiecesMayCross(pieces[other].height, piece.height)) return failure('crossing-too-close', index);
        if (isExclusiveCoasterPiece(pieces, other) || isExclusiveCoasterPiece(pieces, index) || type.family === 'inverted') return failure('crossing-not-allowed', index);
      }
      earlier.push(index);
    }
    if (piece.height < 0 || piece.height > maximumHeight || !Number.isInteger(piece.height)) {
      return failure('height-range', index);
    }
    if (index > 0) {
      if (!isCardinalNeighbor(pieces[index - 1].cell, piece.cell)) return failure('not-adjacent', index);
      if (Math.abs(piece.height - pieces[index - 1].height) > 1) return failure('height-step', index);
    }
  }
  return null;
};

/** The levels of a drop as intensity reads them: in full up to `tall.fullIntensityLevels`, a share past it (the identity on any drop of 4 or less). */
const dropIntensityLevels = (drop: number): number => {
  const tall = GAME_CONFIG.coaster.tall;
  return drop <= tall.fullIntensityLevels ? drop : tall.fullIntensityLevels + (drop - tall.fullIntensityLevels) * tall.tallLevelShare;
};

/** Deterministic ride profile from pure track shape — no randomness, no world state. */
export const deriveCoasterStats = (
  pieces: readonly CoasterPiece[],
  type: CoasterTypeDefinition,
): CoasterDerivedStats => {
  const specials = GAME_CONFIG.coaster.specials;
  if (isShuttleLayout(pieces)) return deriveShuttleStats(pieces, type, shuttleProfile(pieces));
  let turns = 0;
  let steepTurnPairs = 0;
  let previousTurnIndex = -10;
  let totalDescent = 0;
  let drops = 0;
  let biggestDrop = 0;
  let currentDrop = 0;
  // The loop wraps: the segment after the last piece is the first piece again.
  for (let index = 0; index < pieces.length; index += 1) {
    const previous = pieces[(index - 1 + pieces.length) % pieces.length];
    const current = pieces[index];
    const next = pieces[(index + 1) % pieces.length];
    const inbound = directionBetween(previous.cell, current.cell);
    const outbound = directionBetween(current.cell, next.cell);
    if (inbound !== outbound) {
      turns += 1;
      if (index - previousTurnIndex <= 2) steepTurnPairs += 1;
      previousTurnIndex = index;
    }
    const heightChange = next.height - current.height;
    if (heightChange < 0) {
      currentDrop += -heightChange;
      totalDescent += -heightChange;
    } else if (currentDrop > 0) {
      drops += 1;
      biggestDrop = Math.max(biggestDrop, currentDrop);
      currentDrop = 0;
    }
  }
  if (currentDrop > 0) {
    drops += 1;
    biggestDrop = Math.max(biggestDrop, currentDrop);
  }
  const highestHeight = Math.max(...pieces.map((piece) => piece.height));
  const loops = pieces.filter((piece) => piece.special === 'loop').length;
  const boosts = pieces.filter((piece) => piece.special === 'boost').length;
  // Phase 39 step 2: not a saved stat (adding a key would change every coaster's record); 0 on every older layout.
  const launches = pieces.filter((piece) => piece.special === 'launch').length;
  const speed = coasterSpeedProfile(pieces);

  // Free climbs add a bounded bonus; a layout without one takes the exact expressions it always did.
  const lift = GAME_CONFIG.coaster.lift;
  const { free: freePieces, freeRuns } = liftCounts(pieces);
  // Phase 39: the family's weights; `steel` is exactly the numbers every coaster had before families.
  const family = GAME_CONFIG.coaster.families[type.family];
  const airtime = family.airtimeDrops > 0 ? Math.min(family.airtimeDrops, drops) * family.airtimePerDrop : 0;
  const rawExcitement = 16 + pieces.length * 0.5 + turns * family.turn + totalDescent * family.descent + highestHeight * 3
    + loops * specials.loop.excitement + boosts * specials.boost.excitement
    + (speed.topSpeed - GAME_CONFIG.coaster.speed.cruise) * 2.5
    + airtime
    + launches * specials.launch.excitement;
  const rawIntensity = 8 + dropIntensityLevels(biggestDrop) * family.biggestDrop + totalDescent * 2.5 + steepTurnPairs * family.steepTurns
    + loops * specials.loop.intensity + boosts * specials.boost.intensity
    + speed.topSpeed * 1.2
    + launches * specials.launch.intensity;
  // Phase 38: each crossing is a near miss (capped); a layout without one takes the exact expressions it always did.
  const crossings = coasterCrossings(pieces);
  const crossing = GAME_CONFIG.coaster.crossing;
  const withCrossings = crossings > 0
    ? rawExcitement + Math.min(crossing.maximumCounted, crossings) * crossing.excitement
    : rawExcitement;
  const excitement = round(clamp(
    freeRuns > 0 ? withCrossings + Math.min(lift.maxFreeExcitement, lift.freeRunExcitement * freeRuns) : withCrossings,
    0,
    100,
  ));
  const intensity = round(clamp(
    freeRuns > 0 ? rawIntensity + Math.min(lift.maxFreeIntensity, lift.freeRunIntensity * freeRuns) : rawIntensity,
    0,
    100,
  ));
  const baseRunningCost = 4 + pieces.length * 0.12 + loops * 0.8 + boosts * 0.5 + launches * 1.2;
  return {
    pieces: pieces.length,
    turns,
    drops,
    totalDescent,
    biggestDrop,
    highestHeight,
    loops,
    boosts,
    topSpeed: speed.topSpeed,
    excitement,
    intensity,
    durationSeconds: round(speed.totalTravelSeconds + GAME_CONFIG.coaster.stationLoadSeconds),
    travelSeconds: speed.travelSeconds,
    capacity: type.trainCapacity,
    runningCost: freePieces > 0
      ? round(baseRunningCost - freePieces * lift.chainRunningCostPerPiece, 2)
      : round(baseRunningCost, 2),
    ticketPrice: Math.round((3 + excitement * 0.07) * 2) / 2,
    reliability: freeRuns > 0
      ? Math.max(0, type.reliability - Math.min(lift.maxFreeReliabilityLoss, lift.freeRunReliabilityLoss * freeRuns))
      : type.reliability,
  };
};

/**
 * Phase 44: a shuttle's stats. Geometry is read open (no segment from the last piece back to the first), and the
 * ride is out and back: every climb is ridden down again backward, so it counts as a drop (`drops`, `totalDescent`,
 * `biggestDrop` stay pure geometry, which restore re-derives). The station launch counts as one launch; riding the
 * track backward adds `shuttle.backwardExcitement` / `backwardIntensity`. No chain anywhere.
 */
const deriveShuttleStats = (
  pieces: readonly CoasterPiece[],
  type: CoasterTypeDefinition,
  profile: ShuttleProfile,
): CoasterDerivedStats => {
  const config = GAME_CONFIG.coaster;
  const specials = config.specials;
  const count = pieces.length;
  let turns = 0;
  let steepTurnPairs = 0;
  let previousTurnIndex = -10;
  for (let index = 1; index < count - 1; index += 1) {
    if (directionBetween(pieces[index - 1].cell, pieces[index].cell) !== directionBetween(pieces[index].cell, pieces[index + 1].cell)) {
      turns += 1;
      if (index - previousTurnIndex <= 2) steepTurnPairs += 1;
      previousTurnIndex = index;
    }
  }
  let drops = 0;
  let totalDescent = 0;
  let biggestDrop = 0;
  // A run of falls going out, and a run of climbs (a drop on the way back).
  let fall = 0;
  let climb = 0;
  const closeRuns = (): void => {
    for (const run of [fall, climb]) {
      if (run <= 0) continue;
      drops += 1;
      biggestDrop = Math.max(biggestDrop, run);
    }
  };
  for (let index = 0; index < count - 1; index += 1) {
    const change = pieces[index + 1].height - pieces[index].height;
    totalDescent += Math.abs(change);
    if (change < 0) {
      if (climb > 0) { closeRuns(); climb = 0; fall = 0; }
      fall += -change;
    } else if (change > 0) {
      if (fall > 0) { closeRuns(); fall = 0; climb = 0; }
      climb += change;
    } else if (fall > 0 || climb > 0) {
      closeRuns();
      fall = 0;
      climb = 0;
    }
  }
  closeRuns();
  const highestHeight = Math.max(...pieces.map((piece) => piece.height));
  const loops = pieces.filter((piece) => piece.special === 'loop').length;
  const boosts = pieces.filter((piece) => piece.special === 'boost').length;
  const family = config.families[type.family];
  const shuttle = config.shuttle;
  const rawExcitement = 16 + count * 0.5 + turns * family.turn + totalDescent * family.descent + highestHeight * 3
    + loops * specials.loop.excitement * 2 + boosts * specials.boost.excitement
    + (profile.topSpeed - config.speed.cruise) * 2.5
    + specials.launch.excitement + shuttle.backwardExcitement;
  const rawIntensity = 8 + dropIntensityLevels(biggestDrop) * family.biggestDrop + totalDescent * 2.5 + steepTurnPairs * family.steepTurns
    + loops * specials.loop.intensity * 2 + boosts * specials.boost.intensity
    + profile.topSpeed * 1.2
    + specials.launch.intensity + shuttle.backwardIntensity;
  const crossings = coasterCrossings(pieces);
  const excitement = round(clamp(rawExcitement + Math.min(config.crossing.maximumCounted, crossings) * config.crossing.excitement, 0, 100));
  const intensity = round(clamp(rawIntensity, 0, 100));
  return {
    pieces: count,
    turns,
    drops,
    totalDescent,
    biggestDrop,
    highestHeight,
    loops,
    boosts,
    topSpeed: profile.topSpeed,
    excitement,
    intensity,
    durationSeconds: round(profile.totalSeconds + config.stationLoadSeconds),
    travelSeconds: shuttleTravelSeconds(profile),
    capacity: type.trainCapacity,
    runningCost: round(4 + count * 0.12 + loops * 0.8 + boosts * 0.5 + 1.2, 2),
    ticketPrice: Math.round((3 + excitement * 0.07) * 2) / 2,
    reliability: type.reliability,
  };
};

/**
 * Base construction cost before the session's construction multiplier. The piece prices already
 * contain a chain on every climbing segment: a free segment gets the chain's share back, and the
 * chained ones pay it scaled by the park's chain lift rule (1 = the price a chained coaster always had).
 */
export const coasterBaseCost = (
  pieces: readonly CoasterPiece[],
  type: CoasterTypeDefinition,
  chainLiftCostMultiplier = 1,
): number => {
  const chainCost = GAME_CONFIG.coaster.lift.chainCostPerPiece;
  if (isShuttleLayout(pieces)) {
    // Phase 44: the station launch instead of any chain (every climbing segment gets the chain's share back).
    let climbing = 0;
    for (let index = 0; index < pieces.length - 1; index += 1) if (pieces[index + 1].height > pieces[index].height) climbing += 1;
    return type.stationCost
      + pieces.length * type.pieceCost
      + pieces.reduce((total, piece) => total + piece.height, 0) * type.heightCostPerLevel
      + pieces.reduce((total, piece) => total + (piece.special ? GAME_CONFIG.coaster.specials[piece.special].cost : 0), 0)
      + GAME_CONFIG.coaster.specials.launch.cost
      - climbing * chainCost;
  }
  const counts = liftCounts(pieces);
  return type.stationCost
    + pieces.length * type.pieceCost
    + pieces.reduce((total, piece) => total + piece.height, 0) * type.heightCostPerLevel
    + pieces.reduce((total, piece) => total
      + (piece.special ? GAME_CONFIG.coaster.specials[piece.special].cost : 0), 0)
    - counts.climbing * chainCost
    + counts.chained * Math.round(chainCost * chainLiftCostMultiplier);
};

export const COASTER_LIFT_SLOW_TEXT = 'Slow climb: the train crawls near the top. A chain keeps it moving.';

export interface CoasterDesignCheck {
  /** Geometry, lift flags and the stall rule. */
  validation: CoasterValidation;
  /** A free climb that crawls but is still allowed; null when there is nothing to warn about. */
  warning: string | null;
  warningRunStart: number | null;
  runs: LiftRunAnalysis[];
}

/**
 * The designer's check: `validateCoasterLayout` plus the balance-dependent rule that a free climb
 * which would sit on the creep floor for more than `maxCreepSegments` segments is refused. Kept out of
 * validateCoasterLayout on purpose: a later retune must never make a saved park fail to load.
 */
export const checkCoasterDesign = (
  pieces: readonly CoasterPiece[],
  type: CoasterTypeDefinition,
): CoasterDesignCheck => {
  const validation = validateCoasterLayout(pieces, type);
  if (!validation.ok) return { validation, warning: null, warningRunStart: null, runs: [] };
  if (isShuttleLayout(pieces)) return checkShuttleDesign(pieces);
  const runs = analyseLiftRuns(pieces);
  const stalls = runs.find((run) => run.verdict === 'stalls');
  if (stalls) return { validation: failure('free-climb-stalls', stalls.start), warning: null, warningRunStart: null, runs };
  const slow = runs.find((run) => run.verdict === 'slow');
  return {
    validation,
    warning: slow ? COASTER_LIFT_SLOW_TEXT : null,
    warningRunStart: slow ? slow.start : null,
    runs,
  };
};

export const SHUTTLE_EARLY_TURN_TEXT = 'The train turns back before the end of the track.';

/** Phase 44: the shuttle's designer checks (balance-dependent, so never at load): see `shuttleProfile`. */
const checkShuttleDesign = (pieces: readonly CoasterPiece[]): CoasterDesignCheck => {
  const profile = shuttleProfile(pieces);
  const refuse = (reason: CoasterValidationFailure, at: number | null): CoasterDesignCheck =>
    ({ validation: failure(reason, at), warning: null, warningRunStart: null, runs: [] });
  if (profile.outcome === 'overshoots') return refuse('shuttle-overshoots', pieces.length - 1);
  if (profile.outcome === 'stops-flat') return refuse('shuttle-stops-flat', profile.turnSegment);
  if (profile.outcome === 'loop-slow') return refuse('shuttle-loop-slow', null);
  if (profile.returnCreepSegments > GAME_CONFIG.coaster.shuttle.maxReturnCreepSegments) return refuse('shuttle-stalls-back', null);
  // Track past the turnaround is never ridden: allowed (the player's choice), but said.
  let lastClimbStart = pieces.length - 2;
  while (lastClimbStart > 0 && pieces[lastClimbStart].height > pieces[lastClimbStart - 1].height) lastClimbStart -= 1;
  const early = profile.turnSegment < lastClimbStart;
  return {
    validation: { ok: true },
    warning: early ? SHUTTLE_EARLY_TURN_TEXT : null,
    warningRunStart: early ? profile.turnSegment : null,
    runs: [],
  };
};

export const COASTER_VALIDATION_TEXT: Readonly<Record<CoasterValidationFailure, string>> = {
  'too-short': `Lay at least ${GAME_CONFIG.coaster.minimumPieces} track pieces.`,
  'too-long': `Maximum ${GAME_CONFIG.coaster.maximumPieces} track pieces.`,
  'not-adjacent': 'Track pieces must connect side by side.',
  overlapping: 'The track crosses itself at the same height.',
  'crossing-too-close': `Too close to the track below: ${GAME_CONFIG.coaster.trackClearanceLevels} levels needed.`,
  'crossing-not-allowed': 'Stations, loops, boosts and hanging track cannot be crossed over or under.',
  'not-closed': 'Bring the loop back to the station.',
  'station-not-flat': 'The first 3 pieces are the station — keep them at ground level.',
  'station-not-straight': 'The station must be a straight run.',
  'height-step': 'The track can only climb or fall one level per piece.',
  'height-range': 'The track is higher than this coaster type allows.',
  'no-drop': 'Add a hill of height 2+ and a drop so the train can run.',
  'special-not-allowed': 'This coaster type cannot fit that special piece.',
  'special-not-straight': 'Special pieces need a straight stretch of track.',
  'special-on-station': 'Special pieces cannot sit on the station.',
  'specials-too-close': 'Leave at least one plain piece between special pieces.',
  'lift-flag-not-climbing': 'Only climbing track can be chain-free.',
  'lift-run-mixed': 'A hill is either all chain or all free.',
  'mouse-turn-not-flat': 'Wild mouse turns must be flat: climb and drop on the straights.',
  'launch-missing': 'A launch coaster needs a launch: put one on a straight after the station.',
  'free-climb-stalls': 'Free climb too long: the train would crawl. Chain this hill.',
  'launch-speed-range': `Launch speed must be ${GAME_CONFIG.coaster.shuttle.launchSpeed.minimum}–${GAME_CONFIG.coaster.shuttle.launchSpeed.maximum}, set at the station.`,
  'shuttle-no-climb': 'Build a climb of height 2+ for the train to turn on.',
  'shuttle-special-at-end': 'The end of the track cannot carry a special piece.',
  'shuttle-not-allowed': 'This coaster type runs on a closed circuit.',
  'shuttle-overshoots': 'Too fast: the train would run off the end. Lower the launch or build the climb higher.',
  'shuttle-stops-flat': 'Too slow: the train stops on level track. Raise the launch or end on a climb.',
  'shuttle-loop-slow': 'Too slow for the loop. Raise the launch speed.',
  'shuttle-stalls-back': 'Rolling back, the train crawls over a hill. Lower that hill or raise the launch.',
};
