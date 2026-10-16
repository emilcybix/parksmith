import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from './coaster/content';
import { coasterBaseCost, deriveCoasterStats } from './coaster/design';
import type { CoasterPiece } from './coaster/design';
import { BUILD_BY_ID } from './content/catalog';
import { PROJECT_BY_BUILD_ID } from './progression/content';
import { hashState } from './save/hash';
import type { GameWorldState } from './save/state';
import { assertPlainData, assertStructuredCloneSafe, auditOwnProperties } from './save/plainData';
import { SaveError } from './save/version';
import { SCENARIO_BY_ID } from './scenarios/content';
import { ParkSession } from './session/ParkSession';
import type { Rotation } from './types';
import { GameWorld } from './World';

const SERPENT = COASTER_TYPE_BY_ID.get('skyline-serpent')!;

/** A 20-piece loop from (10,10) to (17,13); height 2 along the top, so a walkway fits under it. */
const rectangularLoop = (): CoasterPiece[] => {
  const pieces: CoasterPiece[] = [];
  for (let x = 10; x <= 17; x += 1) pieces.push({ cell: { x, y: 10 }, height: 0 });
  for (let y = 11; y <= 13; y += 1) pieces.push({ cell: { x: 17, y }, height: 0 });
  for (let x = 16; x >= 10; x -= 1) pieces.push({ cell: { x, y: 13 }, height: 0 });
  for (let y = 12; y >= 11; y -= 1) pieces.push({ cell: { x: 10, y }, height: 0 });
  const heights = [0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
  const withHeights = pieces.map((piece, index) => ({ ...piece, height: heights[index] }));
  withHeights[8].special = 'loop';
  withHeights[14].special = 'boost';
  return withHeights;
};

/** A world with history: out-of-order paths, objects, a coaster, a demolition and a free purchase. */
const busyWorld = (): GameWorld => {
  const world = new GameWorld(60_000);
  world.buildPaths([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }]);
  world.bulldoze({ x: 1, y: 1 });
  world.buildPaths([{ x: 1, y: 1 }]);
  world.buildObject('petal-roundabout', { x: 3, y: 3 }, 1);
  world.buildObject('picnic-pocket', { x: 7, y: 5 });
  world.buildObject('ribbon-bench', { x: 6, y: 8 });
  world.buildObject('lollipop-lamp', { x: 8, y: 8 });
  world.bulldoze({ x: 8, y: 8 });
  const pieces = rectangularLoop();
  world.placeCoaster('skyline-serpent', pieces, deriveCoasterStats(pieces, SERPENT), coasterBaseCost(pieces, SERPENT));
  world.buildPaths([{ x: 15, y: 10 }]);
  world.postTransaction(-0, 'Free sample', 'other');
  world.addMoney(123.456, 'Grant');
  world.advanceTick();
  world.advanceTick();
  world.setParkOpen(false);
  return world;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const expectInvalid = (action: () => void, label: string): void => {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught, `${label} must throw`).toBeInstanceOf(SaveError);
  expect((caught as SaveError).code, label).toBe('invalid-state');
};

const probeGrid = (world: GameWorld): string => {
  const roundabout = BUILD_BY_ID.get('petal-roundabout')!;
  const bench = BUILD_BY_ID.get('ribbon-bench')!;
  const rows: string[] = [];
  for (let y = 0; y < world.height; y += 1) {
    for (let x = 0; x < world.width; x += 1) {
      const cell = { x, y };
      rows.push([
        world.objectAt(cell)?.id ?? '-',
        world.canPlace(roundabout, cell),
        world.canPlace(roundabout, cell, 1),
        world.canPlace(bench, cell),
        world.canPlacePath(cell),
        world.canPlaceCoasterPiece({ cell, height: 0 }),
        world.canPlaceCoasterPiece({ cell, height: 2 }),
      ].join(':'));
    }
  }
  return rows.join('|');
};

describe('GameWorld serialize', () => {
  it('is plain data, structured-clone safe and free of aliasing', () => {
    const world = busyWorld();
    const state = world.serialize();
    assertPlainData(state);
    assertStructuredCloneSafe(state);
    state.paths[0].x = 99;
    state.objects[0].anchor.x = 99;
    state.coasters[0].pieces[0].cell.x = 99;
    state.coasters[0].stats.travelSeconds[0] = 99;
    state.transactions[0].amount = 99;
    expect(world.entrance.x, 'entrance is never aliased').toBe(15);
    expect(world.objects.get(1)!.anchor.x).toBe(3);
    expect([...world.coasters.values()][0].pieces[0].cell.x).toBe(10);
    expect(world.transactions[0].amount).not.toBe(99);
  });

  it('is read-only: nothing changes and no listener fires', () => {
    const world = busyWorld();
    let notified = 0;
    world.subscribe(() => { notified += 1; });
    const version = world.version;
    const first = JSON.stringify(world.serialize());
    expect(JSON.stringify(world.serialize())).toBe(first);
    expect(world.version).toBe(version);
    expect(notified).toBe(0);
  });

  it('never writes -0, even for a free purchase', () => {
    const world = new GameWorld(1000);
    world.postTransaction(-0, 'Free', 'other');
    const state = world.serialize();
    expect(Object.is(state.transactions[0].amount, -0), 'amount normalised at the source').toBe(false);
    expect(Object.is(world.transactions[0].amount, -0), 'the live ledger is clean too').toBe(false);
    expect(Object.is(world.cash, -0)).toBe(false);
    const coasterWorld = new GameWorld(1000);
    const pieces = rectangularLoop();
    coasterWorld.placeCoaster('skyline-serpent', pieces, deriveCoasterStats(pieces, SERPENT), 0);
    expect(Object.is(coasterWorld.transactions[0].amount, -0), 'free coaster').toBe(false);
    assertPlainData(coasterWorld.serialize());
  });

  it('keeps path insertion order (not sorted), object order and the next object id', () => {
    const world = new GameWorld(60_000);
    world.buildPaths([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }]);
    world.bulldoze({ x: 1, y: 1 });
    world.buildPaths([{ x: 1, y: 1 }]);
    world.buildObject('picnic-pocket', { x: 7, y: 5 });
    const newest = world.buildObject('ribbon-bench', { x: 6, y: 8 })!;
    world.bulldoze({ x: 6, y: 8 });
    const expectedPaths = ['15,31', '2,1', '3,1', '1,1'];
    expect([...world.paths]).toEqual(expectedPaths);
    const state = world.serialize();
    expect(state.paths.map(({ x, y }) => `${x},${y}`), 'insertion order in the save').toEqual(expectedPaths);
    const target = new GameWorld(60_000);
    target.restore(clone(state));
    expect([...target.paths], 'restored insertion order').toEqual(expectedPaths);
    expect([...target.paths]).not.toEqual([...target.paths].sort());
    expect([...target.objects.keys()]).toEqual([1]);
    const next = target.buildObject('ribbon-bench', { x: 6, y: 8 })!;
    expect(next.id, 'ids continue from the generator, not from max(id)+1').toBe(newest.id + 1);
  });

  it('caps transactions at 300, newest first, and restore keeps the array identity', () => {
    const world = new GameWorld(1000);
    for (let index = 0; index < 305; index += 1) world.postTransaction(index + 1, `T${index}`, 'grant');
    const state = world.serialize();
    expect(state.transactions).toHaveLength(300);
    expect(state.transactions[0].label).toBe('T304');
    expect(state.transactions[0].id).toBe(305);
    expect(state.transactions[299].id).toBe(6);
    const target = new GameWorld(1000);
    target.postTransaction(1, 'old', 'other');
    const array = target.transactions;
    target.restore(clone(state));
    expect(target.transactions, 'same array identity').toBe(array);
    expect(target.transactions).toHaveLength(300);
    target.postTransaction(1, 'next', 'other');
    expect(target.transactions[0].id, 'transaction id continues').toBe(306);
    expect(target.transactions).toHaveLength(300);
  });
});

describe('GameWorld restore', () => {
  it('round trips through JSON byte-identically, with equal hashes', () => {
    const source = busyWorld();
    const state = source.serialize();
    const target = new GameWorld(60_000);
    target.restore(JSON.parse(JSON.stringify(state)) as GameWorldState);
    expect(JSON.stringify(target.serialize())).toBe(JSON.stringify(state));
    expect(hashState(target.serialize())).toBe(hashState(state));
    expect(target.serialize()).toEqual(state);
  });

  it('rebuilds occupancy and coaster heights so the public API agrees with the source world', () => {
    const source = busyWorld();
    const target = new GameWorld(60_000);
    target.restore(clone(source.serialize()));
    expect(probeGrid(target)).toBe(probeGrid(source));
    expect(target.objectAt(target.entrance), 'entrance occupancy 0 stays hidden').toBeUndefined();
    expect(target.canPlacePath({ x: 16, y: 10 }), 'walkway under elevated track').toBe(true);
    expect(target.canPlacePath({ x: 12, y: 10 }), 'low track blocks walkways').toBe(false);
    const coasterId = [...source.coasters.keys()][0];
    expect(target.rideProfile(coasterId), 'coaster ride profile').toEqual(source.rideProfile(coasterId));
  });

  it('re-creates special as a present undefined key for plain track, like placeCoaster', () => {
    const source = busyWorld();
    const target = new GameWorld(60_000);
    target.restore(clone(source.serialize()));
    const [record] = [...target.coasters.values()];
    const [liveRecord] = [...source.coasters.values()];
    expect(Object.keys(record.pieces[0])).toEqual(Object.keys(liveRecord.pieces[0]));
    expect('special' in record.pieces[0]).toBe(true);
    expect(record.pieces[0].special).toBeUndefined();
    expect(record.pieces[8].special).toBe('loop');
    const saved = source.serialize().coasters[0].pieces;
    expect('special' in saved[0], 'absent in the save').toBe(false);
  });

  it('resets a dirty world completely, taking counters and versions from the save', () => {
    const source = busyWorld();
    const state = clone(source.serialize());
    const dirty = new ParkSession(SCENARIO_BY_ID.get('garden-gala')!).world;
    dirty.buildPaths([{ x: 20, y: 20 }]);
    dirty.buildObject('picnic-pocket', { x: 25, y: 25 });
    dirty.addMoney(77, 'noise');
    for (let index = 0; index < 10; index += 1) dirty.advanceTick();
    expect(dirty.serialize().objects.length, 'scenario content seeded').toBeGreaterThan(1);
    const fresh = new GameWorld(60_000);
    fresh.restore(clone(state));
    dirty.restore(clone(state));
    expect(JSON.stringify(dirty.serialize())).toBe(JSON.stringify(fresh.serialize()));
    expect(dirty.version).toBe(source.version);
    expect(dirty.pathVersion).toBe(source.pathVersion);
    expect(dirty.demolitions).toBe(source.demolitions);
    expect(dirty.tick).toBe(source.tick);
    expect(dirty.parkOpen).toBe(false);
    expect(dirty.cash).toBe(source.cash);
    expect(probeGrid(dirty), 'no occupancy survives from the dirty world').toBe(probeGrid(source));
    expect(dirty.buildObject('lollipop-lamp', { x: 25, y: 25 })!.id, 'nextObjectId from the save')
      .toBe(source.buildObject('lollipop-lamp', { x: 25, y: 25 })!.id);
  });

  it('keeps the build-access closure and the cost multiplier of the target', () => {
    const session = new ParkSession(SCENARIO_BY_ID.get('garden-gala')!);
    const researchLocked = [...PROJECT_BY_BUILD_ID.keys()][0];
    expect(session.world.isDefinitionUnlocked('tidy-totem'), 'rules lock before').toBe(false);
    expect(session.world.isDefinitionUnlocked(researchLocked), 'research lock before').toBe(false);
    session.world.restore(clone(busyWorld().serialize()));
    expect(session.world.isDefinitionUnlocked('tidy-totem'), 'rules lock survives restore').toBe(false);
    expect(session.world.isDefinitionUnlocked(researchLocked), 'research lock survives restore').toBe(false);
    expect(session.world.isDefinitionUnlocked('picnic-pocket')).toBe(true);
    expect(session.world.constructionMultiplier).toBe(1);
  });

  it('notifies listeners exactly once and leaves version as saved', () => {
    const source = busyWorld();
    const state = clone(source.serialize());
    const target = new GameWorld(60_000);
    let notified = 0;
    let versionSeen = -1;
    target.subscribe(() => { notified += 1; versionSeen = target.version; });
    target.restore(state);
    expect(notified).toBe(1);
    expect(versionSeen).toBe(state.version);
    expect(target.version).toBe(state.version);
  });

  it('throws inside an open batch on both serialize and restore', () => {
    const world = busyWorld();
    const state = world.serialize();
    world.batch(() => {
      expect(() => world.serialize()).toThrow(/batch/);
      expectInvalid(() => world.restore(state), 'restore in a batch');
    });
    expect(() => world.serialize()).not.toThrow();
  });

  it('rejects an invalid payload without touching the world', () => {
    const world = busyWorld();
    const good = world.serialize();
    const withCoasterId = good.coasters[0].objectId;
    const table: Array<[string, (state: GameWorldState) => void]> = [
      ['NaN cash', (state) => { state.cash = Number.NaN; }],
      ['infinite cash', (state) => { state.cash = Number.POSITIVE_INFINITY; }],
      ['fractional tick', (state) => { state.tick = 1.5; }],
      ['negative demolitions', (state) => { state.demolitions = -1; }],
      ['nextObjectId at or below an id', (state) => { state.nextObjectId = state.objects[state.objects.length - 1].id; }],
      ['duplicate object ids', (state) => { state.objects[1].id = state.objects[0].id; }],
      ['unsorted object ids', (state) => { state.objects.reverse(); }],
      ['unknown definitionId', (state) => { state.objects[0].definitionId = 'no-such-thing'; }],
      ['a path as an object', (state) => { state.objects[0].definitionId = 'sunstone-path'; }],
      ['bad rotation', (state) => { state.objects[0].rotation = 7 as Rotation; }],
      ['overlapping footprints', (state) => { state.objects[1].anchor = { ...state.objects[0].anchor }; }],
      ['footprint off the map', (state) => { state.objects[0].anchor = { x: 31, y: 31 }; }],
      ['out-of-bounds path', (state) => { state.paths.push({ x: 40, y: 2 }); }],
      ['fractional path cell', (state) => { state.paths.push({ x: 2.5, y: 2 }); }],
      ['duplicate path', (state) => { state.paths.push({ ...state.paths[1] }); }],
      ['entrance missing', (state) => { state.paths = state.paths.filter(({ x, y }) => !(x === 15 && y === 31)); }],
      ['path under a plain object', (state) => { state.paths.push({ ...state.objects[0].anchor }); }],
      ['coaster record without object', (state) => { state.objects = state.objects.filter((object) => object.id !== withCoasterId); }],
      ['coaster object without record', (state) => { state.coasters = []; }],
      ['record for a non-coaster', (state) => { state.coasters[0].objectId = state.objects[0].id; }],
      ['too few coaster pieces', (state) => { state.coasters[0].pieces.length = 3; }],
      ['coaster height out of range', (state) => { state.coasters[0].pieces[3].height = 5; }],
      ['coaster bad special', (state) => { state.coasters[0].pieces[2].special = 'warp' as 'loop'; }],
      ['coaster stat NaN', (state) => { state.coasters[0].stats.excitement = Number.NaN; }],
      ['coaster piece off the map', (state) => { state.coasters[0].pieces[1].cell = { x: -1, y: 0 }; }],
      ['low track over a path', (state) => { state.paths.push({ ...state.coasters[0].pieces[1].cell }); }],
      ['wrong mapWidth', (state) => { state.mapWidth = 16; }],
      ['wrong mapHeight', (state) => { state.mapHeight = 16; }],
      ['wrong multiplier', (state) => { state.constructionCostMultiplier = 0.5; }],
      ['301 transactions', (state) => {
        state.nextTransactionId = 1000;
        state.transactions = Array.from({ length: 301 }, (_, index) => ({
          id: 900 - index, amount: 1, label: 'x', category: 'other' as const, tick: 0,
        }));
      }],
      ['ascending transaction ids', (state) => { state.transactions.reverse(); }],
      ['transaction id >= next id', (state) => { state.nextTransactionId = 2; }],
      ['unknown category', (state) => { state.transactions[0].category = 'toString' as 'other'; }],
      ['paths not an array', (state) => { (state as unknown as Record<string, unknown>).paths = null; }],
      // A coaster must be a layout the designer could have produced, with stats that fit it.
      ['coaster cells swapped (not a chain)', (state) => {
        const { pieces } = state.coasters[0];
        [pieces[2].cell, pieces[5].cell] = [pieces[5].cell, pieces[2].cell];
      }],
      ['coaster with a 0-to-3 height jump', (state) => { state.coasters[0].pieces[3].height = 3; }],
      ['coaster with every piece at height 3', (state) => { for (const piece of state.coasters[0].pieces) piece.height = 3; }],
      ['coaster special the type does not allow', (state) => {
        state.objects.find((object) => object.id === state.coasters[0].objectId)!.definitionId = 'comet-trail';
      }],
      ['coaster excitement of 1e9', (state) => { state.coasters[0].stats.excitement = 1e9; }],
      ['coaster capacity of 1e6', (state) => { state.coasters[0].stats.capacity = 1e6; }],
      ['coaster capacity of 0', (state) => { state.coasters[0].stats.capacity = 0; }],
      ['coaster capacity of -3', (state) => { state.coasters[0].stats.capacity = -3; }],
      ['coaster ticket price of -50', (state) => { state.coasters[0].stats.ticketPrice = -50; }],
      ['coaster top speed of 1e9', (state) => { state.coasters[0].stats.topSpeed = 1e9; }],
      ['coaster travelSeconds shorter than the pieces', (state) => { state.coasters[0].stats.travelSeconds = [1]; }],
      ['coaster travelSeconds with a zero entry', (state) => { state.coasters[0].stats.travelSeconds[4] = 0; }],
      ['coaster stats.turns that the layout does not have', (state) => { state.coasters[0].stats.turns += 1; }],
      ['coaster stats.loops that the layout does not have', (state) => { state.coasters[0].stats.loops = 0; }],
      ['coaster stats.biggestDrop that the layout does not have', (state) => { state.coasters[0].stats.biggestDrop += 1; }],
      ['coaster paidCost of 1e300', (state) => { state.coasters[0].paidCost = 1e300; }],
      ['cash of 1e300', (state) => { state.cash = 1e300; }],
      ['nextObjectId of 2^53', (state) => { state.nextObjectId = 2 ** 53; }],
      ['nextTransactionId of 2^53', (state) => { state.nextTransactionId = 2 ** 53; }],
      ['tick of 2^53', (state) => { state.tick = 2 ** 53; }],
      ['version of 1e300', (state) => { state.version = 1e300; }],
      ['pathVersion of 2^31 + 1', (state) => { state.pathVersion = 2 ** 31 + 1; }],
      ['transaction amount of 1e300', (state) => { state.transactions[0].amount = 1e300; }],
      ['transaction from the future', (state) => { state.transactions[0].tick = state.tick + 1; }],
    ];
    const before = JSON.stringify(world.serialize());
    for (const [label, corrupt] of table) {
      const state = clone(good);
      corrupt(state);
      expectInvalid(() => world.restore(state), label);
      expect(JSON.stringify(world.serialize()), `${label} left the world untouched`).toBe(before);
    }
    expect(table.length).toBeGreaterThan(50);
  });
});

describe('GameWorld field coverage', () => {
  /**
   * If this fails, a field was added to (or removed from) GameWorld. Decide which list it
   * belongs in: if it influences the future it must be written by serialize(), read back by
   * restore(), added to GameWorldState in src/game/save/state.ts, and given a mutator below.
   */
  it('accounts for every own field and proves serialized ones are read by serialize()', () => {
    const world = busyWorld();
    const serialized = [
      'paths', 'objects', 'coasters', 'transactions', 'cash', 'tick', 'parkOpen', 'demolitions',
      'nextObjectId', 'nextTransactionId', 'version', 'pathVersion', 'constructionCostMultiplier',
      // Schema 7: the gate's park-level colour record (written as `gateColours`).
      'gateRecord',
      // Schema 14 (Phase 21): the owned parcels, written as `land` only when the land is restricted.
      'land',
    ];
    expect(auditOwnProperties(world, {
      serialized,
      // Rebuilt by restore from objects and coaster pieces.
      // Phase 24: the live props and their grid belong to the `map` key of the save (serializeMap / restoreMap), not to this state.
      derived: ['occupancy', 'trackLayers', 'props', 'propGrid'],
      // Constants of the map and injected collaborators; the target is built with the same ones.
      // Phase 40: `frontAccess` comes from the ruleset (ParkSession sets it), like the build access policy.
      config: ['width', 'height', 'entrance', 'entranceFacing', 'map', 'buildAccessPolicy', 'gateSchedule', 'landCostMultiplier', 'frontAccess'],
      // Subscribers, an open batch and the edit counters (Phase 28 appearance, Phase 24 props, Phase 21 land: transient stamps) are never part of a park.
      transient: ['listeners', 'batchDepth', 'batchedChange', 'appearanceCounter', 'propRevisionCounter', 'landRevisionCounter'],
    }), 'GameWorld gained or lost a field: update serialize(), restore(), GameWorldState and this test').toEqual([]);

    const internals = (target: GameWorld) => target as unknown as Record<string, number>;
    const mutators: Record<string, (target: GameWorld) => void> = {
      paths: (target) => { target.paths.add('9,9'); },
      objects: (target) => { target.objects.set(900, { id: 900, definitionId: 'picnic-pocket', anchor: { x: 0, y: 0 }, rotation: 0 }); },
      coasters: (target) => { target.coasters.clear(); },
      transactions: (target) => { target.transactions.pop(); },
      cash: (target) => { target.cash += 1; },
      tick: (target) => { target.tick += 1; },
      parkOpen: (target) => { target.parkOpen = !target.parkOpen; },
      demolitions: (target) => { target.demolitions += 1; },
      nextObjectId: (target) => { internals(target).nextObjectId += 1; },
      nextTransactionId: (target) => { internals(target).nextTransactionId += 1; },
      version: (target) => { target.version += 1; },
      pathVersion: (target) => { target.pathVersion += 1; },
      constructionCostMultiplier: (target) => { internals(target).constructionCostMultiplier += 1; },
      gateRecord: (target) => { target.setGateColours([19, null, null]); },
      land: (target) => { target.land.assign(target.land.ownedParcels()); },
    };
    const baseline = JSON.stringify(world.serialize());
    for (const field of serialized) {
      expect(mutators[field], `add a mutator for serialized field '${field}'`).toBeTypeOf('function');
      const changed = busyWorld();
      mutators[field](changed);
      expect(JSON.stringify(changed.serialize()), `serialize() must read '${field}'`).not.toBe(baseline);
    }
  });
});
