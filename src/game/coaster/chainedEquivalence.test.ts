import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import type { Cell } from '../types';
import { COASTER_TYPE_BY_ID, type CoasterTypeDefinition } from './content';
import { coasterBaseCost, coasterSpeedProfile, deriveCoasterStats } from './design';
import type { CoasterDerivedStats, CoasterPiece } from './design';
import { hillDipLayout, loopOvalLayout, longestLayout, ovalLayout, randomCircuit, zigzagLayout } from './testLayouts';

/**
 * Chained equivalence (Phase 27 step 4). Lift hills added a free climb, but a coaster without one must
 * keep every number bit for bit. This file freezes a VERBATIM COPY of the coaster speed profile, the
 * derived stats and the base cost as they were before the change, and compares them with the live
 * code using Object.is on every number, on the five golden layouts, the longest layout and
 * random circuits. Never "fix" the copy: if the live code differs, the live code is wrong.
 */

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));
const round = (value: number, decimals = 1): number => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const directionBetween = (from: Cell, to: Cell): string => `${to.x - from.x},${to.y - from.y}`;


const legacySpeedProfile = (
  pieces: readonly CoasterPiece[],
): { travelSeconds: number[]; topSpeed: number; totalTravelSeconds: number } => {
  const speedConfig = GAME_CONFIG.coaster.speed;
  let speed: number = speedConfig.cruise;
  let topSpeed = speed;
  const travelSeconds: number[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const current = pieces[index];
    const next = pieces[(index + 1) % pieces.length];
    if (current.special === 'boost') speed = Math.max(speed, speedConfig.boost);
    if (current.special === 'loop') speed = Math.max(speedConfig.minimum, speed - speedConfig.loopDrag);
    const heightChange = next.height - current.height;
    if (heightChange > 0) speed = speedConfig.lift;
    else if (heightChange < 0) {
      speed = Math.min(speedConfig.maximum, speed + -heightChange * speedConfig.dropBoostPerLevel);
    } else {
      speed = speed > speedConfig.cruise
        ? Math.max(speedConfig.cruise, speed - speedConfig.flatDrag)
        : Math.min(speedConfig.cruise, speed + speedConfig.flatDrag);
    }
    topSpeed = Math.max(topSpeed, speed);
    // A loop piece carries the loop's whole circumference, not just one cell of track.
    travelSeconds.push((1 / speed) * (current.special === 'loop' ? speedConfig.loopLengthFactor : 1));
  }
  return {
    travelSeconds,
    topSpeed: round(topSpeed),
    totalTravelSeconds: travelSeconds.reduce((total, seconds) => total + seconds, 0),
  };
};

/** Deterministic ride profile from pure track shape — no randomness, no world state. */
const legacyDeriveStats = (
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
  const speed = legacySpeedProfile(pieces);

  const excitement = round(clamp(
    16 + pieces.length * 0.5 + turns * 1.5 + totalDescent * 4.5 + highestHeight * 3
      + loops * specials.loop.excitement + boosts * specials.boost.excitement
      + (speed.topSpeed - GAME_CONFIG.coaster.speed.cruise) * 2.5,
    0,
    100,
  ));
  const intensity = round(clamp(
    8 + biggestDrop * 10 + totalDescent * 2.5 + steepTurnPairs * 2.2
      + loops * specials.loop.intensity + boosts * specials.boost.intensity
      + speed.topSpeed * 1.2,
    0,
    100,
  ));
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
    runningCost: round(4 + pieces.length * 0.12 + loops * 0.8 + boosts * 0.5, 2),
    ticketPrice: Math.round((3 + excitement * 0.07) * 2) / 2,
    reliability: type.reliability,
  };
};


/** Base construction cost before the session's construction multiplier. */
const legacyBaseCost = (
  pieces: readonly CoasterPiece[],
  type: CoasterTypeDefinition,
): number =>
  type.stationCost
  + pieces.length * type.pieceCost
  + pieces.reduce((total, piece) => total + piece.height, 0) * type.heightCostPerLevel
  + pieces.reduce((total, piece) => total
    + (piece.special ? GAME_CONFIG.coaster.specials[piece.special].cost : 0), 0);


const same = (actual: unknown, expected: unknown, path: string): void => {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number');
    expect(Object.is(actual, expected), `${path}: ${String(actual)} vs ${String(expected)}`).toBe(true);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, `${path} length`).toBe(expected.length);
    expected.forEach((value, index) => same((actual as unknown[])[index], value, `${path}[${index}]`));
  } else {
    expect(actual, path).toEqual(expected);
  }
};

const CASES: ReadonlyArray<{ name: string; typeId: string; pieces: () => CoasterPiece[] }> = [
  { name: 'oval-comet', typeId: 'comet-trail', pieces: () => ovalLayout() },
  { name: 'oval-chaser', typeId: 'star-chaser', pieces: () => ovalLayout() },
  { name: 'zigzag-chaser', typeId: 'star-chaser', pieces: () => zigzagLayout() },
  { name: 'hilldip-serpent', typeId: 'skyline-serpent', pieces: () => hillDipLayout() },
  { name: 'loops-serpent', typeId: 'skyline-serpent', pieces: () => loopOvalLayout() },
  { name: 'longest-serpent', typeId: 'skyline-serpent', pieces: () => longestLayout() },
];

const compare = (name: string, pieces: CoasterPiece[], type: CoasterTypeDefinition): void => {
  const legacyProfile = legacySpeedProfile(pieces);
  const profile = coasterSpeedProfile(pieces);
  expect(Object.keys(profile), `${name} profile keys`).toEqual(Object.keys(legacyProfile));
  same(profile, legacyProfile, `${name} profile`);
  const legacyStats = legacyDeriveStats(pieces, type);
  const stats = deriveCoasterStats(pieces, type);
  expect(Object.keys(stats), `${name} stats keys`).toEqual(Object.keys(legacyStats));
  expect(JSON.stringify(stats), `${name} stats JSON`).toBe(JSON.stringify(legacyStats));
  same(stats, legacyStats as CoasterDerivedStats, `${name} stats`);
  expect(coasterBaseCost(pieces, type), `${name} cost`).toBe(legacyBaseCost(pieces, type));
  expect(coasterBaseCost(pieces, type, 1), `${name} cost at multiplier 1`).toBe(legacyBaseCost(pieces, type));
};

describe('chained equivalence with the pre-lift-hill code', () => {
  for (const entry of CASES) {
    it(`${entry.name}: profile, stats and cost are bit-identical`, () => {
      compare(entry.name, entry.pieces(), COASTER_TYPE_BY_ID.get(entry.typeId)!);
    });
  }

  it('500 random circuits (valid and not) match number for number', () => {
    const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
    let checked = 0;
    for (let seed = 1; seed <= 500; seed += 1) {
      const pieces = randomCircuit(seed, 12 + (seed % 5) * 4, 8);
      if (!pieces) continue;
      checked += 1;
      compare(`seed ${seed}`, pieces, type);
    }
    expect(checked).toBeGreaterThan(100);
  });
});
