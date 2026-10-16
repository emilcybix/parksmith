import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STRATEGIES } from '../balance/strategies';
import { runStrategy } from '../balance/strategyBot';
import { BUILD_BY_ID } from '../content/catalog';
import { generateMap, recipeOf } from '../maps/generator';
import { buildPropPark } from '../performanceHarness';
import { ParkSession } from '../session/ParkSession';
import { seedDevPark } from '../session/devPark';
import type { Cell } from '../types';
import { GameWorld } from '../World';
import { BIOME_WORDS, NAME_SUFFIXES } from './names';
import {
  deriveNeighborhoods,
  invalidateNeighborhoods,
  neighborhoodAt,
  neighborhoodsOf,
  type NeighborhoodMap,
} from './neighborhoods';

const REPORT = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.NEIGHBORHOOD_REPORT === '1';

const column = (x: number, from: number, to: number): Cell[] => {
  const cells: Cell[] = [];
  for (let y = from; y <= to; y += 1) cells.push({ x, y });
  return cells;
};
const row = (y: number, from: number, to: number): Cell[] => {
  const cells: Cell[] = [];
  for (let x = from; x <= to; x += 1) cells.push({ x, y });
  return cells;
};
const keyAt = (map: NeighborhoodMap, x: number, y: number): number => map.territory[y * map.width + x];
const listOf = (map: NeighborhoodMap): string => map.neighborhoods.map((hood) => `${hood.key}:${hood.name}:${hood.rideIds.join('+')}`).join(' ');
const sameTerritory = (left: NeighborhoodMap, right: NeighborhoodMap): boolean => left.territory.every((key, index) => right.territory[index] === key);

/**
 * Meadow (gate 15,31 facing north), a spine x = 15 from y = 13 to 31 and a west branch along y = 31.
 * Ride 1 east of the spine at y 26..28, ride 2 west at y 25..27 (joins 1: centre 4 away, same path); ride 3 at the
 * north end (13..15, 12 away: its own leader); ride 4 beside an island path within 6 of ride 1 (no shared component:
 * its own leader).
 */
const handPark = (): GameWorld => {
  const world = new GameWorld(1_000_000);
  world.seedScenarioPaths([...column(15, 13, 31), ...row(31, 5, 14), { x: 22, y: 23 }]);
  expect(world.seedScenarioObject('moonpetal-carousel', { x: 16, y: 26 })?.id).toBe(1);
  expect(world.seedScenarioObject('moonpetal-carousel', { x: 12, y: 25 })?.id).toBe(2);
  expect(world.seedScenarioObject('moonpetal-carousel', { x: 16, y: 13 })?.id).toBe(3);
  expect(world.seedScenarioObject('moonpetal-carousel', { x: 19, y: 22 })?.id).toBe(4);
  return world;
};

describe('deriveNeighborhoods on a hand-built park', () => {
  it('clusters rides by leader in id order, requiring a shared path component', () => {
    const map = deriveNeighborhoods(handPark());
    expect(map.neighborhoods.map((hood) => [hood.key, hood.rideIds])).toEqual([[0, []], [1, [1, 2]], [3, [3]], [4, [4]]]);
    expect(map.neighborhoods[0].name).toBe('Meadow Gate');
    expect(map.unreached).toEqual([]);
  });

  it('spreads territory from the access tiles; the gate stops after 4 steps; ties go to the lower key', () => {
    const map = deriveNeighborhoods(handPark());
    // Gate row: 11..14 within 4 steps of the gate, 10 and beyond belong to ride 1's cluster (via the spine).
    expect(keyAt(map, 15, 31)).toBe(0);
    expect(keyAt(map, 15, 30)).toBe(0);
    expect(keyAt(map, 11, 31)).toBe(0);
    expect(keyAt(map, 10, 31)).toBe(1);
    expect(keyAt(map, 5, 31)).toBe(1);
    // Between ride 1's top access (15, 25) and ride 3's bottom access (15, 15): (15, 20) is 5 from both -> key 1.
    expect(keyAt(map, 15, 20)).toBe(1);
    expect(keyAt(map, 15, 19)).toBe(3);
    expect(keyAt(map, 22, 23)).toBe(4);
    expect(keyAt(map, 0, 0)).toBe(-1);
    const tiles = map.neighborhoods.reduce((sum, hood) => sum + hood.tiles.length, 0);
    expect(tiles).toBe(map.pathCells.length);
    expect(neighborhoodAt(map, { x: 22, y: 23 })?.key).toBe(4);
    expect(neighborhoodAt(map, { x: 40, y: 0 })).toBeNull();
  });

  it('assigns services, bins and benches by their access tile, scenery by the nearest territory tile; the rest is unreached', () => {
    const world = handPark();
    const bench = world.seedScenarioObject('ribbon-bench', { x: 14, y: 19 })!;
    const bin = world.seedScenarioObject('tidy-totem', { x: 14, y: 30 })!;
    const tree = world.seedScenarioObject('confetti-tree', { x: 9, y: 17 })!;
    const lonely = world.seedScenarioObject('snack-sprint', { x: 26, y: 4 })!;
    const map = deriveNeighborhoods(world);
    expect(map.memberOf.get(bench.id)).toBe(3);
    expect(map.memberOf.get(bin.id)).toBe(0);
    // Nearest territory tile to (9, 17): (15, 17) at 6 steps vs (9, 31) at 14.
    expect(map.memberOf.get(tree.id)).toBe(3);
    expect(map.unreached).toEqual([lonely.id]);
    expect(map.neighborhoods.find((hood) => hood.key === 3)?.memberIds).toEqual([bench.id, tree.id]);
  });

  it('a leader whose access tiles all belong to an older cluster folds into it (no tile-less neighborhood)', () => {
    const world = new GameWorld(1_000_000);
    world.seedScenarioPaths(column(15, 21, 31));
    world.seedScenarioObject('moonpetal-carousel', { x: 16, y: 26 }); // 1, leader
    world.seedScenarioObject('moonpetal-carousel', { x: 16, y: 21 }); // 2, joins 1 (5 away)
    world.seedScenarioObject('moonpetal-carousel', { x: 12, y: 19 }); // 3, 7 from 1: would lead, but its only access (15, 21) is 2's
    const map = deriveNeighborhoods(world);
    expect(map.neighborhoods.map((hood) => [hood.key, hood.rideIds])).toEqual([[0, []], [1, [1, 2, 3]]]);
    expect(map.memberOf.get(3)).toBe(1);
  });

  it('an empty park, or one with no reachable ride, has no neighborhoods', () => {
    const world = new GameWorld(1_000_000);
    world.seedScenarioPaths(column(15, 20, 31));
    const stall = world.seedScenarioObject('snack-sprint', { x: 16, y: 25 })!;
    const map = deriveNeighborhoods(world);
    expect(map.neighborhoods).toEqual([]);
    expect(map.unreached).toEqual([stall.id]);
  });

  it('is deterministic and cached per world version; invalidate drops the cache', () => {
    const world = handPark();
    const first = neighborhoodsOf(world);
    expect(neighborhoodsOf(world)).toBe(first);
    expect(deriveNeighborhoods(world)).toEqual(first);
    invalidateNeighborhoods(world);
    const again = neighborhoodsOf(world);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
    world.seedScenarioObject('ribbon-bench', { x: 14, y: 19 });
    expect(neighborhoodsOf(world)).not.toBe(again);
  });

  it('removing a follower ride renames nothing; removing a leader re-clusters its followers', () => {
    const world = handPark();
    const before = deriveNeighborhoods(world);
    world.demolishObject(2);
    const follower = deriveNeighborhoods(world);
    expect(follower.neighborhoods.map((hood) => [hood.key, hood.name])).toEqual(before.neighborhoods.map((hood) => [hood.key, hood.name]));
    world.seedScenarioObject('moonpetal-carousel', { x: 12, y: 25 });
    world.demolishObject(1);
    const leader = deriveNeighborhoods(world);
    // The follower that was rebuilt (id 5) now leads; the others keep key and name.
    expect(leader.neighborhoods.map((hood) => hood.key)).toEqual([0, 3, 4, 5]);
    for (const key of [0, 3, 4]) {
      expect(leader.neighborhoods.find((hood) => hood.key === key)?.name).toBe(before.neighborhoods.find((hood) => hood.key === key)?.name);
    }
  });

  it('gives the sector of the territory centroid and focuses the territory tile nearest it', () => {
    const map = deriveNeighborhoods(handPark());
    const north = map.neighborhoods.find((hood) => hood.key === 3)!;
    expect(north.sector).toBe('centre');
    expect(north.focus.x).toBe(15);
    expect(map.territory[north.focus.y * map.width + north.focus.x]).toBe(3);
    expect(map.neighborhoods[0].sector).toBe('south');
  });
});

describe('names', () => {
  it('are unique, biome-aware, and stable for a ride rebuilt on the same anchor', () => {
    const world = handPark();
    const map = deriveNeighborhoods(world);
    const names = map.neighborhoods.map((hood) => hood.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names.slice(1)) {
      const [word, suffix] = name.split(' ');
      expect(BIOME_WORDS.meadow).toContain(word);
      expect(NAME_SUFFIXES).toContain(suffix);
    }
    const name3 = map.neighborhoods.find((hood) => hood.key === 3)!.name;
    world.demolishObject(3);
    const rebuilt = world.seedScenarioObject('moonpetal-carousel', { x: 16, y: 13 })!;
    expect(deriveNeighborhoods(world).neighborhoods.find((hood) => hood.key === rebuilt.id)?.name).toBe(name3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Stability property (design Q3): the dev park, three strategy final parks, two generated maps.

interface Park { readonly name: string; readonly session: ParkSession }

const parks = (): Park[] => {
  const list: Park[] = [];
  const dev = new ParkSession(null);
  seedDevPark(dev);
  dev.syncWithWorld();
  list.push({ name: 'dev park', session: dev });
  const spy = vi.spyOn(ParkSession.prototype, 'syncWithWorld');
  for (const strategy of STRATEGIES) {
    // Ten park minutes builds the strategy's final layout (measured: the same neighborhoods as at 45 minutes).
    runStrategy(strategy, { minutes: 10, window: [0, 10] });
    list.push({ name: `strategy ${strategy.id}`, session: spy.mock.contexts.at(-1) as ParkSession });
  }
  spy.mockRestore();
  list.push({ name: 'generated meadow high', session: buildPropPark({ layout: generateMap(recipeOf('meadow', 2475515309, { density: 'high' })).layout }).session });
  list.push({ name: 'generated autumn-forest high', session: buildPropPark({ layout: generateMap(recipeOf('autumn-forest', 45298323, { density: 'high' })).layout }).session });
  return list;
};

const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/**
 * The structure the list depends on: the path partition (excluding `skip`) and, per ride, whether it has access and
 * which components it touches (canonical label: the lowest cell of the component without `skip`).
 */
const structureOf = (world: GameWorld, map: NeighborhoodMap, skip: number): string => {
  const lowest = new Map<number, number>();
  for (const cell of map.pathCells) {
    if (cell === skip) continue;
    const component = map.component[cell];
    if (!lowest.has(component)) lowest.set(component, cell);
  }
  const labelOf = (cell: number): string => String(lowest.get(map.component[cell]) ?? 'new');
  const partition = [...map.pathCells].filter((cell) => cell !== skip).map(labelOf).join(',');
  const isPath = new Set(map.pathCells);
  const rides = [...world.objects.values()]
    .filter((object) => BUILD_BY_ID.get(object.definitionId)?.kind === 'ride')
    .sort((left, right) => left.id - right.id)
    .map((object) => {
      const footprint = world.objectFootprint(object);
      const under = new Set(footprint.map((cell) => cell.y * map.width + cell.x));
      const labels = new Set<string>();
      for (const cell of footprint) {
        for (const [dx, dy] of D4) {
          const x = cell.x + dx;
          const y = cell.y + dy;
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          const index = y * map.width + x;
          if (isPath.has(index) && !under.has(index)) labels.add(labelOf(index));
        }
      }
      return `${object.id}:${[...labels].sort().join('/')}`;
    });
  return `${partition}|${rides.join(' ')}`;
};

const report: string[] = [];

describe('stability over real parks', () => {
  let all: Park[] = [];
  beforeAll(() => {
    all = parks();
  });

  afterAll(() => {
    if (REPORT) console.log(report.join('\n'));
  });

  it('measures each park (neighborhood counts and derivation cost)', () => {
    for (const { name, session } of all) {
      const world = session.world;
      const started = performance.now();
      let map = deriveNeighborhoods(world);
      for (let index = 0; index < 9; index += 1) map = deriveNeighborhoods(world);
      const ms = (performance.now() - started) / 10;
      expect(map.neighborhoods.length).toBeGreaterThanOrEqual(2);
      expect(map.neighborhoods[0].key).toBe(0);
      const keys = map.neighborhoods.map((hood) => hood.key);
      expect(keys).toEqual([...keys].sort((left, right) => left - right));
      expect(new Set(map.neighborhoods.map((hood) => hood.name)).size).toBe(keys.length);
      const words = BIOME_WORDS[world.biome.id];
      for (const hood of map.neighborhoods) expect(words).toContain(hood.name.split(' ')[0]);
      report.push(`${name}: ${map.neighborhoods.length} neighborhoods (${map.neighborhoods.map((hood) => `${hood.name} ${hood.rideIds.length}r/${hood.tiles.length}t`).join(', ')}); derive ${ms.toFixed(3)} ms`);
    }
  });

  it('the dev park matches the design measurement (4 neighborhoods + gate; 4/4/3/2 rides)', () => {
    const map = deriveNeighborhoods(all[0].session.world);
    expect(map.neighborhoods.map((hood) => hood.rideIds.length)).toEqual([0, 4, 4, 3, 2]);
    expect(map.neighborhoods.map((hood) => hood.tiles.length)).toEqual([5, 21, 38, 32, 15]);
  });

  it('40 bench placements per park change 0 names and 0 territory tiles; bins, scenery and stalls likewise', () => {
    for (const { name, session } of all) {
      const world = session.world;
      const base = deriveNeighborhoods(world);
      const baseList = listOf(base);
      const counts: Record<string, number> = {};
      for (const [definitionId, limit, stride] of [['ribbon-bench', 40, 3], ['tidy-totem', 10, 7], ['confetti-tree', 10, 5], ['snack-sprint', 6, 5], ['comfort-cabin', 4, 6]] as const) {
        let placed = 0;
        for (let y = 0; y < world.height && placed < limit; y += 1) {
          for (let x = (y * 5) % stride; x < world.width && placed < limit; x += stride) {
            const object = world.seedScenarioObject(definitionId, { x, y });
            if (!object) continue;
            placed += 1;
            const after = deriveNeighborhoods(world);
            expect(listOf(after), `${name}: ${definitionId} at ${x},${y}`).toBe(baseList);
            expect(sameTerritory(base, after), `${name}: ${definitionId} at ${x},${y} moved territory`).toBe(true);
            world.demolishObject(object.id);
          }
        }
        counts[definitionId] = placed;
      }
      expect(counts['ribbon-bench'], name).toBe(40);
      report.push(`${name}: placements ${JSON.stringify(counts)}: 0 list changes, 0 territory changes`);
    }
  });

  it('adding or removing one path tile changes the list only when it joins or splits components (or a ride gains or loses access)', () => {
    for (const { name, session } of all) {
      const world = session.world;
      const base = deriveNeighborhoods(world);
      const baseList = listOf(base);
      let neutral = 0;
      let structural = 0;
      // Additions: free cells beside the network, sampled.
      const candidates: Cell[] = [];
      for (const cell of base.pathCells) {
        const x = cell % base.width;
        const y = Math.floor(cell / base.width);
        for (const [dx, dy] of D4) {
          const next = { x: x + dx, y: y + dy };
          if (world.canPlacePath(next) && !candidates.some((other) => other.x === next.x && other.y === next.y)) candidates.push(next);
        }
      }
      for (const cell of candidates.filter((_, index) => index % 3 === 0).slice(0, 25)) {
        const index = cell.y * world.width + cell.x;
        world.seedScenarioPaths([cell]);
        const after = deriveNeighborhoods(world);
        if (structureOf(world, after, index) === structureOf(world, base, index)) {
          neutral += 1;
          expect(listOf(after), `${name}: path added at ${cell.x},${cell.y}`).toBe(baseList);
        } else structural += 1;
        world.bulldoze(cell);
      }
      // Removals: path tiles other than the gate, sampled.
      const entrance = world.entrance.y * world.width + world.entrance.x;
      for (const index of [...base.pathCells].filter((cell) => cell !== entrance).filter((_, at) => at % 4 === 1).slice(0, 25)) {
        const cell = { x: index % world.width, y: Math.floor(index / world.width) };
        world.bulldoze(cell);
        const after = deriveNeighborhoods(world);
        if (structureOf(world, after, index) === structureOf(world, base, index)) {
          neutral += 1;
          expect(listOf(after), `${name}: path removed at ${cell.x},${cell.y}`).toBe(baseList);
        } else structural += 1;
        world.seedScenarioPaths([cell]);
      }
      expect(listOf(deriveNeighborhoods(world))).toBe(baseList);
      expect(neutral, name).toBeGreaterThan(0);
      report.push(`${name}: path edits ${neutral} neutral (list unchanged), ${structural} structural`);
    }
  });

  it('adding a ride never renames or renumbers an existing neighborhood', () => {
    for (const { name, session } of all) {
      const world = session.world;
      const base = deriveNeighborhoods(world);
      let placed = 0;
      for (let y = 0; y < world.height - 2 && placed < 12; y += 2) {
        for (let x = (y * 3) % 5; x < world.width - 2 && placed < 12; x += 5) {
          const ride = world.seedScenarioObject('moonpetal-carousel', { x, y });
          if (!ride) continue;
          placed += 1;
          const after = deriveNeighborhoods(world);
          for (const hood of base.neighborhoods) {
            const kept = after.neighborhoods.find((other) => other.key === hood.key);
            expect(kept?.name, `${name}: ride at ${x},${y}`).toBe(hood.name);
            expect(kept?.rideIds.filter((id) => id !== ride.id)).toEqual(hood.rideIds);
          }
          const home = after.memberOf.get(ride.id);
          if (home !== undefined && !base.neighborhoods.some((hood) => hood.key === home)) expect(home).toBe(ride.id);
          world.demolishObject(ride.id);
        }
      }
      expect(placed, name).toBeGreaterThan(0);
    }
  });
});
