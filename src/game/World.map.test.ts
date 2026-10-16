import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from './content/catalog';
import { MAP_BY_ID } from './maps/content';
import { layoutOfMap, layoutOfMapId } from './maps/parse';
import { PROP_KIND_BY_ID } from './maps/props';
import { GROUND_WATER, type PropPlacement } from './maps/types';
import { classifyTransaction } from './management/ManagementSimulation';
import { SaveError } from './save/version';
import { ParkSession } from './session/ParkSession';
import { GameWorld } from './World';

const BROOK = layoutOfMapId('brookside-meadow');
const CANYON = layoutOfMapId('red-rock-canyon');

const firstProp = (layout: typeof BROOK, kind: string): PropPlacement => {
  const found = layout.props.find((prop) => prop.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
};
const firstWater = (layout: typeof BROOK) => {
  const index = layout.ground.findIndex((value) => value === GROUND_WATER);
  return { x: index % layout.width, y: Math.floor(index / layout.width) };
};
/** The nearest cell with nothing on it (no prop, no water), for contrast cases. */
const openCell = (world: GameWorld) => ({ x: world.entrance.x, y: world.entrance.y - 2 });

describe('GameWorld map layer', () => {
  it('reads the entrance, size and facing from the map (no literal)', () => {
    const world = new GameWorld(5000, 1, CANYON);
    expect(world.entrance).toEqual({ x: 16, y: 0 });
    expect(world.entranceFacing).toBe('south');
    expect(world.paths.has('16,0')).toBe(true);
    expect(world.objectAt(world.entrance)).toBeUndefined();
    expect(world.biome.id).toBe('desert-canyon');
    expect(world.map).toBe(CANYON);
    const seaside = new GameWorld(5000, 1, layoutOfMapId('seaside-cove'));
    expect(seaside.entrance).toEqual({ x: 0, y: 15 });
    expect(seaside.entranceFacing).toBe('east');
  });

  it('refuses paths on a prop and on water, builds beside them, and keeps the entrance a path', () => {
    const world = new GameWorld(5000, 1, BROOK);
    const tree = firstProp(BROOK, 'oak-tree');
    const water = firstWater(BROOK);
    expect(world.isObstructed(tree)).toBe(true);
    expect(world.isObstructed(water)).toBe(true);
    expect(world.canPlacePath(tree)).toBe(false);
    expect(world.canPlacePath(water)).toBe(false);
    const result = world.buildPaths([tree, water, { x: 15, y: 30 }]);
    expect(result.built).toBe(1);
    expect(result.added).toEqual([{ x: 15, y: 30 }]);
    expect(world.seedScenarioPaths([tree, water])).toBe(0);
    expect(world.groundAt(water)).toBe(GROUND_WATER);
    expect(world.obstacleAt(water)).toEqual({ kind: 'water' });
    const obstacle = world.obstacleAt(tree);
    expect(obstacle?.kind).toBe('prop');
    expect(obstacle && obstacle.kind === 'prop' ? obstacle.cost : -1).toBe(60);
    expect(world.obstacleAt(openCell(world))).toBeNull();
  });

  it('refuses an object whose footprint touches a prop with the typed reason obstacle; blocked keeps meaning path, object and off-map', () => {
    const world = new GameWorld(5000, 1, BROOK);
    const tree = firstProp(BROOK, 'oak-tree');
    // picnic-pocket is a small shop; anchor it so its footprint covers the tree.
    const onTree = world.checkObjectBuild('picnic-pocket', tree);
    expect(onTree).toEqual({ ok: false, reason: 'obstacle' });
    expect(world.buildObject('picnic-pocket', tree)).toBeNull();
    expect(world.canPlace(BUILD_BY_ID.get('picnic-pocket')!, tree)).toBe(false);
    expect(world.checkObjectBuild('picnic-pocket', { x: 15, y: 25 }).ok).toBe(true);
    world.buildPaths([{ x: 15, y: 25 }]);
    expect(world.checkObjectBuild('picnic-pocket', { x: 15, y: 25 })).toEqual({ ok: false, reason: 'blocked' });
    expect(world.checkObjectBuild('picnic-pocket', { x: -3, y: 5 })).toEqual({ ok: false, reason: 'blocked' });
    // Both a path/object conflict and a prop: blocked wins (it is the harder reason).
    const beside = { x: tree.x - 1, y: tree.y };
    if (!world.isObstructed(beside)) {
      world.buildPaths([beside]);
      expect(world.checkObjectBuild('picnic-pocket', beside)).toEqual({ ok: false, reason: 'blocked' });
    }
  });

  it('refuses coaster pieces on a prop at any height', () => {
    const world = new GameWorld(5000, 1, BROOK);
    const tree = firstProp(BROOK, 'oak-tree');
    expect(world.canPlaceCoasterPiece({ cell: tree, height: 0 })).toBe(false);
    expect(world.canPlaceCoasterPiece({ cell: tree, height: 3 })).toBe(false);
    expect(world.canPlaceCoasterPiece({ cell: firstWater(BROOK), height: 4 })).toBe(false);
    expect(world.canPlaceCoasterPiece({ cell: openCell(world), height: 0 })).toBe(true);
  });

  it('clears a prop for its price: ledger row, cost x multiplier, version and prop revision, no demolition', () => {
    const world = new GameWorld(5000, 1.5, BROOK);
    const tree = firstProp(BROOK, 'oak-tree');
    const version = world.version;
    const revision = world.propRevision;
    let notified = 0;
    world.subscribe(() => { notified += 1; });
    expect(world.clearCost(tree)).toBe(90);
    expect(world.checkClear(tree)).toMatchObject({ ok: true, cost: 90 });
    const result = world.bulldoze(tree);
    expect(result).toEqual({ removed: true, refund: 0, label: 'Oak tree', cost: 90 });
    expect(world.cash).toBe(5000 - 90);
    expect(world.transactions[0]).toMatchObject({ amount: -90, label: 'Cleared Oak tree', category: 'land-clearing' });
    expect(world.props.has(tree.id)).toBe(false);
    expect(world.propAt(tree)).toBeUndefined();
    expect(world.isObstructed(tree)).toBe(false);
    expect(world.version).toBe(version + 1);
    expect(world.propRevision).toBe(revision + 1);
    expect(world.demolitions).toBe(0);
    expect(notified).toBe(1);
    // The cleared cell is buildable now, and clearing it again does nothing.
    expect(world.canPlacePath(tree)).toBe(true);
    expect(world.bulldoze(tree)).toEqual({ removed: false, refund: 0, label: null });
    expect(world.checkClear(tree)).toEqual({ ok: false, reason: 'none', cost: null });
  });

  it('a permanent prop and a short purse refuse with typed reasons and change nothing', () => {
    const world = new GameWorld(50, 1, BROOK);
    const oak = firstProp(BROOK, 'great-oak');
    const tree = firstProp(BROOK, 'oak-tree');
    const before = JSON.stringify([world.cash, world.version, world.propRevision, world.transactions, [...world.props.keys()]]);
    expect(world.bulldoze(oak)).toEqual({ removed: false, refund: 0, label: null, refused: 'permanent' });
    expect(world.checkClear({ x: oak.x + 1, y: oak.y + 1 })).toEqual({ ok: false, reason: 'permanent', cost: null });
    expect(world.bulldoze(tree)).toEqual({ removed: false, refund: 0, label: null, refused: 'funds' });
    expect(world.checkClear(tree)).toEqual({ ok: false, reason: 'funds', cost: 60 });
    expect(world.bulldoze(firstWater(BROOK))).toEqual({ removed: false, refund: 0, label: null });
    expect(JSON.stringify([world.cash, world.version, world.propRevision, world.transactions, [...world.props.keys()]])).toBe(before);
  });

  it('bulldoze keeps its order: the entrance is refused, then path, then object, then prop', () => {
    const world = new GameWorld(5000, 1, CANYON);
    expect(world.bulldoze(world.entrance)).toEqual({ removed: false, refund: 0, label: null });
    world.buildPaths([{ x: 16, y: 1 }]);
    expect(world.bulldoze({ x: 16, y: 1 })).toMatchObject({ removed: true, label: 'a path tile' });
    expect(world.demolitions).toBe(1);
    const boulder = firstProp(CANYON, 'red-boulder');
    expect(world.bulldoze(boulder)).toMatchObject({ removed: true, cost: 180, label: 'Red boulder' });
    expect(world.demolitions, 'clearing a prop is not a demolition').toBe(1);
  });

  it('a 2x1 log clears from either of its cells and frees both', () => {
    const world = new GameWorld(5000, 1, BROOK);
    const log = firstProp(BROOK, 'mossy-log');
    const cells = world.propFootprint(log);
    expect(cells.length).toBe(2);
    expect(world.propAt(cells[1])?.id).toBe(log.id);
    expect(world.bulldoze(cells[1])).toMatchObject({ removed: true, cost: 35 });
    for (const cell of cells) expect(world.isObstructed(cell)).toBe(false);
  });

  it('the ledger category is reported under Construction (no new management category)', () => {
    expect(classifyTransaction({ amount: -60, label: 'Cleared Oak tree', category: 'land-clearing' })).toBe('construction');
    const session = new ParkSession(null, [], { mapId: 'brookside-meadow' });
    const tree = firstProp(session.map, 'oak-tree');
    session.world.bulldoze(tree);
    session.syncWithWorld();
    for (let tick = 0; tick < 20; tick += 1) session.step(100);
    const totals = session.management.snapshot().finances.categories;
    // Phase 21 added `land` (its own category for parcel purchases) and Phase 29 `souvenirSales`; clearing still reports
    // under Construction.
    expect(Object.keys(totals).length, 'twelve categories plus land and souvenirs').toBe(14);
    expect(totals.land.transactionCount).toBe(0);
    expect(totals.construction.expenses).toBeGreaterThanOrEqual(60);
  });

  it('serializeMap keeps the remaining props only; restoreMap brings back the saved ones and bumps the revision', () => {
    const world = new GameWorld(5000, 1, BROOK);
    const saved = world.serializeMap();
    expect(saved.props.length).toBe(BROOK.props.length);
    const tree = firstProp(BROOK, 'oak-tree');
    world.bulldoze(tree);
    const after = world.serializeMap();
    expect(after.props.length).toBe(BROOK.props.length - 1);
    expect(after.props.some((prop) => prop.id === tree.id)).toBe(false);
    expect(after.props.map((prop) => prop.id)).toEqual([...after.props.map((prop) => prop.id)].sort((a, b) => a - b));
    const revision = world.propRevision;
    world.restoreMap(saved);
    expect(world.propRevision).toBe(revision + 1);
    expect(world.props.has(tree.id)).toBe(true);
    expect(world.isObstructed(tree)).toBe(true);
    expect([...world.props.keys()]).toEqual(BROOK.props.map((prop) => prop.id));
    // Pure: serializing twice is identical and does not alias live state.
    const again = world.serializeMap();
    again.props[0].x = 99;
    expect(world.serializeMap().props[0].x).not.toBe(99);
  });

  it('restoreMap refuses a different land and hostile props without touching the world', () => {
    const world = new GameWorld(5000, 1, BROOK);
    const state = world.serializeMap();
    const before = JSON.stringify(world.serializeMap());
    const bad: Array<[string, (s: ReturnType<GameWorld['serializeMap']>) => void]> = [
      ['another map', (s) => { s.id = 'seaside-cove'; }],
      ['another ground', (s) => { s.ground[0] = `~${s.ground[0].slice(1)}`; }],
      ['another entrance', (s) => { s.entrance = { x: 14, y: 31, facing: 'north' }; }],
      ['a prop of another biome', (s) => { s.props[0].kind = 'palm-tree'; }],
      ['a prop on water', (s) => { const water = firstWater(BROOK); s.props[0].x = water.x; s.props[0].y = water.y; }],
    ];
    for (const [name, change] of bad) {
      const copy = structuredClone(state);
      change(copy);
      expect(() => world.restoreMap(copy), name).toThrow(SaveError);
      expect(JSON.stringify(world.serializeMap()), name).toBe(before);
    }
  });

  it('world.restore refuses a path, an object or a coaster piece on a prop', () => {
    const source = new GameWorld(5000, 1, BROOK);
    const empty = new GameWorld(5000, 1, layoutOfMap(MAP_BY_ID.get('meadow')!));
    const tree = firstProp(BROOK, 'oak-tree');
    // A world state written on the empty meadow puts a path where the brook map has an oak.
    empty.buildPaths([{ x: tree.x, y: tree.y }]);
    expect(() => source.restore(empty.serialize())).toThrow(/prop or water/);
    const withObject = new GameWorld(5000, 1, layoutOfMap(MAP_BY_ID.get('meadow')!));
    withObject.buildObject('picnic-pocket', { x: tree.x, y: tree.y });
    expect(() => source.restore(withObject.serialize())).toThrow(/prop or water/);
    // And the proof the check is about the land: the same state restores on the empty meadow.
    expect(() => new GameWorld(5000, 1, layoutOfMap(MAP_BY_ID.get('meadow')!)).restore(withObject.serialize())).not.toThrow();
  });

  it('every prop kind the maps use has a price consistent with its clearCost (rounded per multiplier)', () => {
    for (const multiplier of [0.5, 1, 1.25, 2]) {
      const world = new GameWorld(5000, multiplier, CANYON);
      for (const prop of CANYON.props) {
        const base = PROP_KIND_BY_ID.get(prop.kind)!.clearCost;
        expect(world.clearCost(prop)).toBe(base === null ? null : Math.round(base * multiplier));
      }
    }
  });
});
