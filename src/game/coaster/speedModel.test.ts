import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { COASTER_TYPE_BY_ID } from './content';
import { coasterSpeedProfile, coasterSpeedTrace, deriveCoasterStats } from './design';
import type { CoasterPiece } from './design';
import { liftRuns } from './lift';
import { integerSquareRoot, creepSpeedMilli } from './speedModel';
import {
  hillDipFreeLayout, hillDipLayout, loopOvalLayout, ovalLayout, randomCircuit, tallFreeLayout, tallLayout,
  withFreeLifts, zigzagLayout,
} from './testLayouts';

const CREEP = 1.2;
const LAYOUTS: ReadonlyArray<readonly [string, () => CoasterPiece[]]> = [
  ['oval', () => ovalLayout()],
  ['zigzag', () => zigzagLayout()],
  ['hill-dip', () => hillDipLayout()],
  ['loop-oval', () => loopOvalLayout()],
  ['tall', () => tallLayout()],
];

/** Seeded flags: each run is free with probability one half, uniform per run. */
const randomFreeFlags = (pieces: CoasterPiece[], seed: number): CoasterPiece[] => {
  let state = seed >>> 0;
  const next = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  const picks = liftRuns(pieces).flatMap((_run, index) => (next() < 0.5 ? [index] : []));
  return withFreeLifts(pieces, picks);
};

describe('the free-climb model', () => {
  it('the creep floor is 1.2 cells per second', () => {
    expect(creepSpeedMilli()).toBe(1200);
    expect(coasterSpeedTrace(ovalLayout()).creepSpeed).toBe(CREEP);
  });

  it('integerSquareRoot is exact', () => {
    for (const value of [0, 1, 2, 3, 4, 15, 16, 17, 1_440_000, 35_999_999, 36_000_000, 2 ** 52 - 1]) {
      const root = integerSquareRoot(value);
      expect(root * root).toBeLessThanOrEqual(value);
      expect((root + 1) * (root + 1)).toBeGreaterThan(value);
    }
  });

  it('is deterministic: 1000 runs over the layouts and random circuits with random free flags give equal output', () => {
    const subjects: CoasterPiece[][] = [];
    for (const [, make] of LAYOUTS) { subjects.push(withFreeLifts(make())); subjects.push(randomFreeFlags(make(), 7)); }
    for (let seed = 1; seed <= 50; seed += 1) {
      const pieces = randomCircuit(seed, 16, 6);
      if (pieces) subjects.push(randomFreeFlags(pieces, seed));
    }
    expect(subjects.length).toBeGreaterThan(30);
    const reference = subjects.map((pieces) => JSON.stringify([coasterSpeedTrace(pieces), coasterSpeedProfile(pieces)]));
    for (let run = 0; run < 1000; run += 1) {
      const again = subjects.map((pieces) => JSON.stringify([coasterSpeedTrace(pieces), coasterSpeedProfile(pieces)]));
      expect(again).toEqual(reference);
    }
  });

  it('the trace and the profile agree', () => {
    for (const pieces of [hillDipFreeLayout(), withFreeLifts(zigzagLayout())]) {
      expect(coasterSpeedTrace(pieces).travelSeconds).toEqual(coasterSpeedProfile(pieces).travelSeconds);
    }
  });

  it('never stalls: every free climbing segment holds at least the creep speed, so every travel time is finite and bounded', () => {
    const subjects: CoasterPiece[][] = LAYOUTS.map(([, make]) => withFreeLifts(make()));
    for (let seed = 1; seed <= 60; seed += 1) {
      const pieces = randomCircuit(seed, 20, 7);
      if (pieces) subjects.push(withFreeLifts(pieces));
    }
    for (const pieces of subjects) {
      const trace = coasterSpeedTrace(pieces);
      pieces.forEach((piece, index) => {
        const climbing = pieces[(index + 1) % pieces.length].height > piece.height;
        if (climbing && piece.freeClimb === true) {
          expect(trace.segmentSpeeds[index]).toBeGreaterThanOrEqual(CREEP);
          expect(trace.exitSpeeds[index]).toBeGreaterThanOrEqual(CREEP);
        }
        expect(Number.isFinite(trace.travelSeconds[index])).toBe(true);
        expect(trace.travelSeconds[index]).toBeGreaterThan(0);
        expect(trace.travelSeconds[index]).toBeLessThanOrEqual((1 / 1.1) * GAME_CONFIG.coaster.speed.loopLengthFactor + 1e-9);
      });
    }
  });

  it('a climb entered below the creep floor is lifted to it (a loop right before a free hill)', () => {
    const cell = (x: number) => ({ x, y: 0 });
    const heights = [0, 0, 0, 1, 2, 3, 4, 3, 2, 1, 0, 0];
    const pieces: CoasterPiece[] = heights.map((height, index) => ({ cell: cell(index), height }));
    pieces.slice(3, 6).forEach((piece) => { piece.freeClimb = true; });
    pieces[5].special = 'loop';
    const trace = coasterSpeedTrace(pieces);
    // Piece 5 is a free climb with a loop in front of it: 1.2 - 0.6 is below the minimum 1.1.
    expect(trace.creepHits[5]).toBe(true);
    expect(trace.segmentSpeeds[5]).toBe(CREEP);
    expect(trace.travelSeconds[5]).toBeCloseTo((1 / CREEP) * 3, 12);
  });

  it('slows monotonically inside a free run, strictly until the floor, and never gains speed on a climb', () => {
    for (const pieces of [tallFreeLayout(), withFreeLifts(hillDipLayout()), withFreeLifts(zigzagLayout())]) {
      const trace = coasterSpeedTrace(pieces);
      for (const run of liftRuns(pieces)) {
        for (let offset = 0; offset < run.length; offset += 1) {
          const index = (run.start + offset) % pieces.length;
          const before = trace.exitSpeeds[(index - 1 + pieces.length) % pieces.length];
          const exit = trace.exitSpeeds[index];
          expect(exit).toBeLessThanOrEqual(before);
          if (offset > 0) {
            const previous = trace.exitSpeeds[(index - 1 + pieces.length) % pieces.length];
            if (previous > CREEP) expect(exit).toBeLessThan(previous);
            else expect(exit).toBe(CREEP);
          }
        }
      }
    }
  });

  it('a taller climb arrives slower: crest speed falls with the height gained', () => {
    const crest = (pieces: CoasterPiece[]): number => {
      const [run] = liftRuns(pieces);
      return coasterSpeedTrace(pieces).exitSpeeds[run.start + run.length - 1];
    };
    const low = withFreeLifts(ovalLayout());
    const tall = tallFreeLayout();
    expect(crest(tall)).toBeLessThanOrEqual(crest(low));
    expect(crest(low)).toBeLessThan(GAME_CONFIG.coaster.speed.cruise);
  });

  it('speeds up again on the way down: the drop after a free crest is faster than the crest', () => {
    const pieces = hillDipFreeLayout();
    const trace = coasterSpeedTrace(pieces);
    // Hill 2 (run 9..11) crests at piece 12; the drop starts there.
    expect(trace.exitSpeeds[12]).toBeGreaterThan(trace.exitSpeeds[11]);
    expect(trace.exitSpeeds[12]).toBeLessThanOrEqual(GAME_CONFIG.coaster.speed.maximum);
  });

  it('free from a standstill lengthens the cycle, free after a drop shortens it', () => {
    const cycle = (pieces: CoasterPiece[]): number => coasterSpeedProfile(pieces).totalTravelSeconds;
    expect(cycle(withFreeLifts(ovalLayout()))).toBeGreaterThan(cycle(ovalLayout()));
    expect(cycle(withFreeLifts(zigzagLayout()))).toBeGreaterThan(cycle(zigzagLayout()));
    expect(cycle(hillDipFreeLayout())).toBeLessThan(cycle(hillDipLayout()));
  });

  it('top speed comes from the model: a free climb never raises it and the crest speed feeds the drop', () => {
    for (const [, make] of LAYOUTS) {
      expect(coasterSpeedProfile(withFreeLifts(make())).topSpeed).toBeLessThanOrEqual(coasterSpeedProfile(make()).topSpeed);
    }
    const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
    expect(deriveCoasterStats(tallFreeLayout(), type).topSpeed).toBe(deriveCoasterStats(tallLayout(), type).topSpeed);
  });

  it('pins the hill-dip with its post-drop hills free (exact seconds per piece)', () => {
    expect(coasterSpeedTrace(hillDipFreeLayout()).travelSeconds).toEqual(
      [0.4166666666666667, 0.4166666666666667, 0.625, 0.625, 0.625, 0.5405405405405405, 0.26666666666666666,
        0.17699115044247787, 0.16666666666666666, 0.17158544955387783, 0.18271514708569342, 0.196347928529354,
        0.16666666666666666, 0.16666666666666666, 0.17391304347826086, 0.17953321364452424, 0.19455252918287938,
        0.16666666666666666, 0.16666666666666666, 0.17391304347826086, 0.17953321364452424, 0.16666666666666666,
        0.17391304347826086, 0.18181818181818182, 0.19047619047619047, 0.2, 0.21052631578947367, 0.2222222222222222,
        0.23529411764705882, 0.25, 0.26666666666666666, 0.2857142857142857],
    );
  });
});
