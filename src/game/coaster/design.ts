import { GAME_CONFIG } from '../config';
import type { Cell } from '../types';
import type { CoasterSpecial, CoasterTypeDefinition } from './content';
import { analyseLiftRuns, isClimbingSegment, liftCounts, liftRuns, type LiftRunAnalysis } from './lift';
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
}

export type CoasterValidationFailure =
  | 'too-short'
  | 'too-long'
  | 'not-adjacent'
  | 'overlapping'
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
  /** Designer only (checkCoasterDesign): never raised when a save loads. */
  | 'free-climb-stalls';

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
  if (pieces.length < config.minimumPieces) return failure('too-short');
  if (pieces.length > config.maximumPieces) return failure('too-long');

  const maximumHeight = Math.min(type.maximumHeight, config.absoluteMaximumHeight);
  const seen = new Set<string>();
  for (const [index, piece] of pieces.entries()) {
    const key = `${piece.cell.x},${piece.cell.y}`;
    if (seen.has(key)) return failure('overlapping', index);
    seen.add(key);
    if (piece.height < 0 || piece.height > maximumHeight || !Number.isInteger(piece.height)) {
      return failure('height-range', index);
    }
    if (index > 0) {
      if (!isCardinalNeighbor(pieces[index - 1].cell, piece.cell)) return failure('not-adjacent', index);
      if (Math.abs(piece.height - pieces[index - 1].height) > 1) return failure('height-step', index);
    }
  }
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (!isCardinalNeighbor(last.cell, first.cell)) return failure('not-closed');
  if (Math.abs(last.height - first.height) > 1) return failure('height-step', pieces.length - 1);

  for (let index = 0; index < config.stationLength; index += 1) {
    if (pieces[index].height !== 0) return failure('station-not-flat', index);
  }
  const stationDirection = directionBetween(pieces[0].cell, pieces[1].cell);
  for (let index = 1; index < config.stationLength; index += 1) {
    if (directionBetween(pieces[index - 1].cell, pieces[index].cell) !== stationDirection) {
      return failure('station-not-straight', index);
    }
  }

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

  // Lift flags are data rules (safe at load): a flag only on a climbing segment, one mode per run.
  for (const [index, piece] of pieces.entries()) {
    if (piece.freeClimb === true && !isClimbingSegment(pieces, index)) return failure('lift-flag-not-climbing', index);
  }
  for (const run of liftRuns(pieces)) {
    for (let offset = 1; offset < run.length; offset += 1) {
      const index = (run.start + offset) % pieces.length;
      if ((pieces[index].freeClimb === true) !== !run.chained) return failure('lift-run-mixed', index);
    }
  }
  return { ok: true };
};

/** Deterministic ride profile from pure track shape — no randomness, no world state. */
export const deriveCoasterStats = (
  pieces: readonly CoasterPiece[],
  type: CoasterTypeDefinition,
): CoasterDerivedStats => {
  const specials = GAME_CONFIG.coaster.specials;
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
  const speed = coasterSpeedProfile(pieces);

  // Free climbs add a bounded bonus; a layout without one takes the exact expressions it always did.
  const lift = GAME_CONFIG.coaster.lift;
  const { free: freePieces, freeRuns } = liftCounts(pieces);
  const rawExcitement = 16 + pieces.length * 0.5 + turns * 1.5 + totalDescent * 4.5 + highestHeight * 3
    + loops * specials.loop.excitement + boosts * specials.boost.excitement
    + (speed.topSpeed - GAME_CONFIG.coaster.speed.cruise) * 2.5;
  const rawIntensity = 8 + biggestDrop * 10 + totalDescent * 2.5 + steepTurnPairs * 2.2
    + loops * specials.loop.intensity + boosts * specials.boost.intensity
    + speed.topSpeed * 1.2;
  const excitement = round(clamp(
    freeRuns > 0 ? rawExcitement + Math.min(lift.maxFreeExcitement, lift.freeRunExcitement * freeRuns) : rawExcitement,
    0,
    100,
  ));
  const intensity = round(clamp(
    freeRuns > 0 ? rawIntensity + Math.min(lift.maxFreeIntensity, lift.freeRunIntensity * freeRuns) : rawIntensity,
    0,
    100,
  ));
  const baseRunningCost = 4 + pieces.length * 0.12 + loops * 0.8 + boosts * 0.5;
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

export const COASTER_VALIDATION_TEXT: Readonly<Record<CoasterValidationFailure, string>> = {
  'too-short': `Lay at least ${GAME_CONFIG.coaster.minimumPieces} track pieces.`,
  'too-long': `Maximum ${GAME_CONFIG.coaster.maximumPieces} track pieces.`,
  'not-adjacent': 'Track pieces must connect side by side.',
  overlapping: 'The track crosses itself.',
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
  'free-climb-stalls': 'Free climb too long: the train would crawl. Chain this hill.',
};
