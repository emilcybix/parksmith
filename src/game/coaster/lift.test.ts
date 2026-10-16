import { describe, expect, it } from 'vitest';
import type { CoasterPiece } from './design';
import {
  analyseLiftRuns, describeCoasterLift, isClimbingSegment, liftRunAtPiece, liftRunForTarget, liftRuns,
  normaliseLiftFlags, setLiftRunChained, toggleLiftRun,
} from './lift';
import { COASTER_TYPE_BY_ID } from './content';
import { GAME_CONFIG } from '../config';
import {
  hillDipLayout, hillDipFreeLayout, layoutFromMoves, OVAL_MOVES, ovalLayout, randomCircuit, withFreeLifts, zigzagLayout,
} from './testLayouts';

const free = (pieces: readonly CoasterPiece[]): number[] =>
  pieces.flatMap((piece, index) => (piece.freeClimb === true ? [index] : []));

describe('lift run detection', () => {
  it('finds a single run starting on the station', () => {
    expect(liftRuns(ovalLayout())).toEqual([{ start: 2, length: 2, top: 4, chained: true }]);
  });

  it('finds separate climbs of the zig-zag and the hill-dip, in start order', () => {
    expect(liftRuns(zigzagLayout()).map((run) => [run.start, run.length])).toEqual([[3, 1], [5, 1], [7, 1]]);
    expect(liftRuns(hillDipLayout()).map((run) => [run.start, run.length, run.top])).toEqual([[2, 3, 5], [9, 3, 12], [15, 1, 16], [20, 1, 21]]);
  });

  it('a run knows its mode from its first segment', () => {
    expect(liftRuns(hillDipFreeLayout()).map((run) => run.chained)).toEqual([true, false, false, false]);
  });

  it('liftRunAtPiece covers the foot, the slope and the crest, and nothing else', () => {
    const pieces = ovalLayout();
    expect([2, 3, 4].map((index) => liftRunAtPiece(pieces, index)?.start)).toEqual([2, 2, 2]);
    expect([0, 1, 5, 6, 10].map((index) => liftRunAtPiece(pieces, index))).toEqual([null, null, null, null, null]);
  });

  it('a flat layout has no run and a wrap-around climb is kept whole', () => {
    const flat = ovalLayout().map((piece) => ({ ...piece, height: 0 }));
    expect(liftRuns(flat)).toEqual([]);
    // Heights 0,0,...,0,1,2 then the loop wraps down: the climb at the end is one run that does not wrap.
    const wrapped = ovalLayout().map((piece, index, all) => ({ ...piece, height: index >= all.length - 2 ? index - (all.length - 3) : 0 }));
    const runs = liftRuns(wrapped);
    expect(runs).toEqual([{ start: 21, length: 2, top: 23, chained: true }]);
    expect(isClimbingSegment(wrapped, 23)).toBe(false);
  });

  it('never throws or loops on random circuits and every run is made of climbing segments', () => {
    let seen = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const pieces = randomCircuit(seed, 16, 6);
      if (!pieces) continue;
      seen += 1;
      for (const run of liftRuns(pieces)) {
        for (let offset = 0; offset < run.length; offset += 1) {
          expect(isClimbingSegment(pieces, (run.start + offset) % pieces.length)).toBe(true);
        }
        expect(isClimbingSegment(pieces, run.top), 'the run is maximal').toBe(false);
        expect(isClimbingSegment(pieces, (run.start - 1 + pieces.length) % pieces.length), 'the run is maximal behind').toBe(false);
      }
    }
    expect(seen).toBeGreaterThan(20);
  });
});

describe('normaliseLiftFlags', () => {
  it('clears a flag on a segment that does not climb', () => {
    const pieces = ovalLayout();
    pieces[0].freeClimb = true;
    pieces[6].freeClimb = true;
    expect(normaliseLiftFlags(pieces)).toBe(true);
    expect(free(pieces)).toEqual([]);
    expect('freeClimb' in pieces[0], 'the key itself is gone, not set to false').toBe(false);
  });

  it('every segment of a run takes the mode of its first segment', () => {
    const pieces = ovalLayout();
    pieces[2].freeClimb = true;
    expect(normaliseLiftFlags(pieces)).toBe(true);
    expect(free(pieces)).toEqual([2, 3]);
    delete pieces[2].freeClimb;
    pieces[3].freeClimb = true;
    normaliseLiftFlags(pieces);
    expect(free(pieces), 'first segment chained wins').toEqual([]);
  });

  it('a piece appended to a free run inherits it and a new run starts chained', () => {
    const pieces = hillDipFreeLayout().slice(0, 12);
    normaliseLiftFlags(pieces);
    expect(free(pieces)).toEqual([9, 10]);
    pieces.push({ cell: { x: 99, y: 1 }, height: 3 });
    normaliseLiftFlags(pieces);
    expect(free(pieces)).toEqual([9, 10, 11]);
    pieces.push({ cell: { x: 99, y: 2 }, height: 2 }, { cell: { x: 99, y: 3 }, height: 3 });
    normaliseLiftFlags(pieces);
    expect(liftRuns(pieces).map((run) => run.chained)).toEqual([true, false, true]);
  });

  it('is idempotent and changes nothing on a normal layout', () => {
    const pieces = hillDipFreeLayout();
    const before = JSON.stringify(pieces);
    expect(normaliseLiftFlags(pieces)).toBe(false);
    expect(JSON.stringify(pieces)).toBe(before);
  });
});

describe('setLiftRunChained, toggleLiftRun and liftRunForTarget', () => {
  it('sets a whole run free and chained again without leaving a false behind', () => {
    const pieces = hillDipLayout();
    expect(setLiftRunChained(pieces, 9, false)).toBe(true);
    expect(free(pieces)).toEqual([9, 10, 11]);
    expect(setLiftRunChained(pieces, 9, false), 'already free').toBe(false);
    expect(setLiftRunChained(pieces, 9, true)).toBe(true);
    expect(free(pieces)).toEqual([]);
    expect(pieces.every((piece) => !('freeClimb' in piece))).toBe(true);
    expect(setLiftRunChained(pieces, 4, false), 'no run starts at 4').toBe(false);
  });

  it('toggles the run under a piece and reports the run afterwards', () => {
    const pieces = hillDipLayout();
    expect(toggleLiftRun(pieces, 11)?.chained).toBe(false);
    expect(free(pieces)).toEqual([9, 10, 11]);
    expect(toggleLiftRun(pieces, 9)?.chained).toBe(true);
    expect(free(pieces)).toEqual([]);
    expect(toggleLiftRun(pieces, 7), 'a drop piece has no run').toBeNull();
  });

  it('the target is the hovered run, else the run of the last piece, else the last run, else none', () => {
    const pieces = hillDipLayout();
    expect(liftRunForTarget(pieces, 10)?.start).toBe(9);
    expect(liftRunForTarget(pieces, 7)?.start, 'hovering a drop falls back to the last run').toBe(20);
    expect(liftRunForTarget(pieces, null)?.start).toBe(20);
    const draft = hillDipLayout().slice(0, 12);
    expect(liftRunForTarget(draft, null)?.start, 'the run ending at the last piece').toBe(9);
    expect(liftRunForTarget(draft.slice(0, 2), null)).toBeNull();
  });
});

describe('analyseLiftRuns and describeCoasterLift', () => {
  it('chained runs are ok, a free run out of the station is slow, a long one stalls', () => {
    expect(analyseLiftRuns(ovalLayout()).map((run) => run.verdict)).toEqual(['ok']);
    const slow = ovalLayout();
    setLiftRunChained(slow, 2, false);
    const [run] = analyseLiftRuns(slow);
    expect(run.verdict).toBe('slow');
    expect(run.creepSegments).toBe(1);
    expect(run.entrySpeed).toBeCloseTo(2.4, 5);
    expect(run.exitSpeed).toBeCloseTo(1.2, 5);
  });

  it('counts crawling segments per climb: flats between free runs add up, a drop starts again', () => {
    const maxCreep = GAME_CONFIG.coaster.lift.maxCreepSegments;
    // 0-1-2, flat, 2-3: two one-creep runs split by a flat are one climb with two crawling segments.
    const flatSplit = withFreeLifts(layoutFromMoves({ x: 4, y: 4 }, OVAL_MOVES,
      [0, 0, 0, 1, 2, 2, 3, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(analyseLiftRuns(flatSplit).map((run) => [run.creepSegments, run.verdict])).toEqual([[1, 'slow'], [1, 'slow']]);
    expect(maxCreep).toBe(2);
    // Three one-creep climbs with a drop before each of the later two: three creeps in all, each climb still only slow.
    const dropSplit = withFreeLifts(layoutFromMoves({ x: 4, y: 4 }, OVAL_MOVES,
      [0, 0, 0, 1, 2, 1, 1, 2, 3, 2, 2, 3, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0]));
    const runs = analyseLiftRuns(dropSplit);
    expect(runs.reduce((total, run) => total + run.creepSegments, 0)).toBeGreaterThan(maxCreep);
    expect(runs.map((run) => run.verdict)).toEqual(['slow', 'slow', 'slow']);
  });

  it('describes a built coaster from its saved travel times', () => {
    const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
    const pieces = hillDipFreeLayout();
    const travel = pieces.map(() => 0.5);
    const view = describeCoasterLift(pieces, travel, type, 1);
    expect(view.climbingPieces).toBe(8);
    expect(view.chainedPieces).toBe(3);
    expect(view.freePieces).toBe(5);
    expect(view.freeRuns).toBe(3);
    expect(view.chainBuildCost).toBe(3 * 40);
    expect(view.chainRunningCost).toBeCloseTo(0.24, 5);
    expect(view.kinds.filter((kind) => kind === 'chain').length).toBe(3);
    expect(view.speeds.every((speed) => speed === 2)).toBe(true);
    expect(describeCoasterLift(pieces, travel, type, 1.5).chainBuildCost).toBe(3 * 60);
    // The cost share is what the ledger charges: construction and operating multipliers applied.
    const scaled = describeCoasterLift(pieces, travel, type, { constructionCostMultiplier: 0.5, rideOperatingCostMultiplier: 2 });
    expect(scaled.chainBuildCost).toBe(60);
    expect(scaled.chainRunningCost).toBeCloseTo(0.48, 5);
    expect(describeCoasterLift(withFreeLifts(hillDipLayout()), travel, type, 1)).toMatchObject({ chainBuildCost: 0, chainRunningCost: 0 });
  });
});
