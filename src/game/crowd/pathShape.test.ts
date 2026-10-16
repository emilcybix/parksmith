import { describe, expect, it } from 'vitest';
import { GameWorld } from '../World';
import { ParkSession } from '../session/ParkSession';
import { seedDevPark } from '../session/devPark';
import { PathShapeCache, cellIndexOf, computePathShape, invalidatePathShape, pathShapeOf, type PathSource } from './pathShape';

const W = 12;
const H = 10;

/** A map from an ASCII drawing: `#` is a path tile. */
const drawn = (rows: string[], pathVersion = 1): PathSource => {
  const paths = new Set<string>();
  rows.forEach((row, y) => [...row].forEach((char, x) => { if (char === '#') paths.add(`${x},${y}`); }));
  return { width: W, height: H, paths, pathVersion };
};
const at = (x: number, y: number): number => y * W + x;

describe('pathShape: lane width, degree, components, articulation', () => {
  it('a straight 1-wide corridor is lane width 1 everywhere; its inner tiles are cut vertices, its ends are not', () => {
    const shape = computePathShape(drawn(['', '', '..######']));
    for (let x = 2; x <= 7; x += 1) expect(shape.laneWidth[at(x, 2)], `x ${x}`).toBe(1);
    expect([shape.degree[at(2, 2)], shape.degree[at(4, 2)], shape.degree[at(7, 2)]]).toEqual([1, 2, 1]);
    expect([...shape.cells]).toEqual([2, 3, 4, 5, 6, 7].map((x) => at(x, 2)));
    expect([2, 3, 4, 5, 6, 7].map((x) => shape.articulation[at(x, 2)])).toEqual([0, 1, 1, 1, 1, 0]);
    expect(shape.laneWidth[at(0, 0)], 'off-path').toBe(0);
    expect(shape.component[at(0, 0)], 'off-path').toBe(-1);
  });

  it('the crossing of two corridors is 5/3 at its centre, degree 4, and a cut vertex', () => {
    const shape = computePathShape(drawn(['', '...#', '...#', '#######', '...#', '...#']));
    expect(shape.laneWidth[at(3, 3)]).toBeCloseTo(5 / 3, 12);
    expect(shape.degree[at(3, 3)]).toBe(4);
    expect(shape.articulation[at(3, 3)]).toBe(1);
  });

  it('a 2-wide street is lane width 2 inside and has no cut vertex; a plaza is 3 at its heart', () => {
    const street = computePathShape(drawn(['', '########', '########']));
    expect(street.laneWidth[at(3, 1)]).toBe(2);
    expect(street.laneWidth[at(0, 1)], 'the end of the street: 4 tiles / 3').toBeCloseTo(4 / 3, 12);
    expect([...street.cells].every((cell) => street.articulation[cell] === 0)).toBe(true);
    const plaza = computePathShape(drawn(['', '.#####', '.#####', '.#####', '.#####']));
    expect(plaza.laneWidth[at(3, 2)]).toBe(3);
    expect(plaza.laneWidth[at(1, 1)], 'a corner: 4 tiles / 3').toBeCloseTo(4 / 3, 12);
  });

  it('a dead end and a lone tile are clamped to lane width 1; degree counts orthogonal neighbours only', () => {
    const shape = computePathShape(drawn(['#', '', '..#.', '...#']));
    expect(shape.laneWidth[at(0, 0)]).toBe(1);
    expect(shape.degree[at(0, 0)]).toBe(0);
    // Diagonal neighbours widen the block but are not connected.
    expect(shape.degree[at(2, 2)]).toBe(0);
    expect(shape.component[at(2, 2)]).not.toBe(shape.component[at(3, 3)]);
  });

  it('a loop has no cut vertex; a plaza joined by one corridor has its join tile as a cut vertex', () => {
    const ring = computePathShape(drawn(['', '.#####', '.#...#', '.#####']));
    expect([...ring.cells].filter((cell) => ring.articulation[cell] === 1)).toEqual([]);
    const plaza = computePathShape(drawn(['', '.###', '.######', '.###']));
    expect(plaza.articulation[at(3, 2)], 'the plaza tile the corridor leaves from').toBe(1);
    expect(plaza.laneWidth[at(3, 2)]).toBeGreaterThan(1);
    expect(plaza.articulation[at(2, 2)], 'the plaza heart').toBe(0);
    expect(plaza.articulation[at(6, 2)], 'the dead end').toBe(0);
  });

  it('numbers components in ascending cell order', () => {
    const shape = computePathShape(drawn(['..##....#', '', '#']));
    expect(shape.component[at(2, 0)]).toBe(0);
    expect(shape.component[at(3, 0)]).toBe(0);
    expect(shape.component[at(8, 0)]).toBe(1);
    expect(shape.component[at(0, 2)]).toBe(2);
  });

  it('matches a brute-force cut-vertex test on the dev park, independent of path insertion order', () => {
    const session = new ParkSession(null);
    seedDevPark(session);
    const world = session.world;
    const shape = pathShapeOf(world);
    expect(shape.cells.length).toBe(world.paths.size);
    expect(shape.cells.length).toBeGreaterThan(90);
    const keys = [...world.paths];
    const reversed = computePathShape({ width: world.width, height: world.height, paths: new Set([...keys].reverse()), pathVersion: world.pathVersion });
    expect([...reversed.articulation]).toEqual([...shape.articulation]);
    const countComponents = (cells: Set<number>): number => {
      const seen = new Set<number>();
      let components = 0;
      for (const start of cells) {
        if (seen.has(start)) continue;
        components += 1;
        const queue = [start];
        seen.add(start);
        while (queue.length > 0) {
          const cell = queue.pop()!;
          const x = cell % world.width;
          for (const next of [cell - 1, cell + 1, cell - world.width, cell + world.width]) {
            const nx = next % world.width;
            if (next < 0 || Math.abs(nx - x) > 1 || !cells.has(next) || seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return components;
    };
    const all = new Set(shape.cells);
    const base = countComponents(all);
    for (const cell of shape.cells) {
      const without = new Set(all);
      without.delete(cell);
      // A cut vertex splits its component: more components without it (a lone tile only removes one).
      const split = countComponents(without) > base - (shape.degree[cell] === 0 ? 1 : 0);
      expect(shape.articulation[cell] === 1, `cell ${cell}`).toBe(split);
    }
  });
});

describe('pathShape: caching per pathVersion', () => {
  it('returns the cached shape until pathVersion moves, and recomputes after invalidate()', () => {
    const source = { ...drawn(['###']), paths: new Set(['0,0', '1,0', '2,0']) };
    const cache = new PathShapeCache();
    const first = cache.of(source);
    source.paths.add('3,0');
    expect(cache.of(source)).toBe(first);
    source.pathVersion += 1;
    const second = cache.of(source);
    expect(second).not.toBe(first);
    expect(second.cells.length).toBe(4);
    source.paths.delete('3,0');
    cache.invalidate();
    expect(cache.of(source).cells.length).toBe(3);
  });

  it('pathShapeOf keeps one cache per world; invalidatePathShape forgets it', () => {
    const world = new GameWorld();
    const shape = pathShapeOf(world);
    expect(pathShapeOf(world)).toBe(shape);
    invalidatePathShape(world);
    const again = pathShapeOf(world);
    expect(again).not.toBe(shape);
    expect([...again.cells]).toEqual([...shape.cells]);
  });

  it('ignores keys outside the map or malformed; cellIndexOf maps cells to y * width + x', () => {
    const shape = computePathShape({ width: 4, height: 4, paths: new Set(['-1,0', '4,0', '0,4', 'x', '1,1', '1.5,1']), pathVersion: 0 });
    expect([...shape.cells]).toEqual([5]);
    expect(cellIndexOf(4, 4, { x: 1, y: 1 })).toBe(5);
    expect(cellIndexOf(4, 4, { x: 4, y: 1 })).toBe(-1);
    expect(cellIndexOf(4, 4, { x: 0.5, y: 1 })).toBe(-1);
  });
});
