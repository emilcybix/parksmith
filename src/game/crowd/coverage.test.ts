import { describe, expect, it } from 'vitest';
import type { Cell } from '../types';
import { GameWorld } from '../World';
import { computeCoverage, coverageOf, coverageShare, invalidateCoverage, type ServiceOpenState } from './coverage';

const column = (x: number, from: number, to: number): Cell[] => Array.from({ length: to - from + 1 }, (_, index) => ({ x, y: from + index }));
const tilesOf = (world: GameWorld, cells: readonly Cell[]): Int32Array => Int32Array.from(cells.map((cell) => cell.y * world.width + cell.x));

/** A spine x = 15, y 5..31 (27 tiles); a food stall at its south end (access (15, 30)). */
const park = (): { world: GameWorld; food: ServiceOpenState } => {
  const world = new GameWorld(1_000_000);
  world.seedScenarioPaths(column(15, 5, 31));
  const stall = world.seedScenarioObject('snack-sprint', { x: 16, y: 30 })!;
  return { world, food: { objectId: stall.id, kind: 'food', open: true } };
};

describe('service coverage', () => {
  it('covers path tiles within 16 path steps of an open service of that kind', () => {
    const { world, food } = park();
    const coverage = computeCoverage(world, [food]);
    const spine = column(15, 5, 31);
    const covered = spine.filter((cell) => coverage.covered.food[cell.y * world.width + cell.x] === 1).map((cell) => cell.y);
    expect(covered).toEqual(Array.from({ length: 31 - 14 + 1 }, (_, index) => 14 + index));
    expect(coverage.openServices).toEqual({ food: 1, drink: 0, toilet: 0 });
    // Shares: full near the stall, partial over the whole spine, none for other kinds, 0 for no tiles.
    expect(coverageShare(coverage, tilesOf(world, column(15, 20, 31)))).toEqual({ food: 1, drink: 0, toilet: 0 });
    expect(coverageShare(coverage, tilesOf(world, spine)).food).toBeCloseTo(18 / 27, 10);
    expect(coverageShare(coverage, tilesOf(world, column(15, 5, 13))).food).toBe(0);
    expect(coverageShare(coverage, new Int32Array(0))).toEqual({ food: 0, drink: 0, toilet: 0 });
  });

  it('ignores closed services, unknown objects, and services without path access', () => {
    const { world, food } = park();
    const remote = world.seedScenarioObject('comfort-cabin', { x: 3, y: 3 })!;
    const coverage = computeCoverage(world, [{ ...food, open: false }, { objectId: remote.id, kind: 'toilet', open: true }, { objectId: 999, kind: 'drink', open: true }]);
    expect(coverage.openServices).toEqual({ food: 0, drink: 0, toilet: 0 });
    expect(coverage.covered.food.every((value) => value === 0)).toBe(true);
    expect(coverage.covered.toilet.every((value) => value === 0)).toBe(true);
  });

  it('respects a custom reach and walks the path network, not the grid', () => {
    const world = new GameWorld(1_000_000);
    // A U: down x = 10, along y = 20, up x = 14; a toilet at the top of the left arm.
    world.seedScenarioPaths([...column(10, 10, 20), { x: 11, y: 20 }, { x: 12, y: 20 }, { x: 13, y: 20 }, ...column(14, 10, 20)]);
    const toilet = world.seedScenarioObject('comfort-cabin', { x: 8, y: 9 })!;
    const coverage = computeCoverage(world, [{ objectId: toilet.id, kind: 'toilet', open: true }], 6);
    const at = (x: number, y: number): number => coverage.covered.toilet[y * world.width + x];
    // The cabin (8..9, 9..10) touches the path at (10, 10) only. (14, 10) is 4 cells away on the grid but 24 steps
    // along the U.
    expect(at(10, 10)).toBe(1);
    expect(at(10, 16)).toBe(1);
    expect(at(10, 17)).toBe(0);
    expect(at(14, 10)).toBe(0);
  });

  it('is cached per world, path version and open-service signature', () => {
    const { world, food } = park();
    const first = coverageOf(world, [food]);
    expect(coverageOf(world, [{ ...food }])).toBe(first);
    const closed = coverageOf(world, [{ ...food, open: false }]);
    expect(closed).not.toBe(first);
    expect(closed.openServices.food).toBe(0);
    const reopened = coverageOf(world, [food]);
    expect(reopened).toEqual(first);
    world.seedScenarioPaths([{ x: 16, y: 5 }]);
    const moved = coverageOf(world, [food]);
    expect(moved).not.toBe(reopened);
    invalidateCoverage(world);
    expect(coverageOf(world, [food])).not.toBe(moved);
  });
});
