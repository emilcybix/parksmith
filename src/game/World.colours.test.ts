import { describe, expect, it } from 'vitest';
import { COLOUR_SWATCHES, ENTRANCE_COLOUR_ID, SWATCH_COUNT, colourKindOf, colourSlotsFor } from './content/colours';
import { presetRecord } from './content/colourPresets';
import { ParkSession } from './session/ParkSession';
import { seedColourTestPark } from './session/colourTestPark';
import { hashState } from './save/hash';
import type { GameWorldState } from './save/state';
import { SaveError } from './save/version';
import { GameWorld } from './World';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const parkWithRides = () => {
  const world = new GameWorld(80_000);
  const cups = world.buildObject('comet-cups', { x: 3, y: 3 })!;
  const wheel = world.buildObject('aurora-wheel', { x: 8, y: 3 })!;
  const shop = world.buildObject('picnic-pocket', { x: 14, y: 3 })!;
  const bench = world.buildObject('ribbon-bench', { x: 18, y: 3 })!;
  const tree = world.buildObject('confetti-tree', { x: 22, y: 3 })!;
  return { world, cups: cups.id, wheel: wheel.id, shop: shop.id, bench: bench.id, tree: tree.id };
};

const counters = (world: GameWorld) => ({
  version: world.version, pathVersion: world.pathVersion, cash: world.cash,
  transactions: world.transactions.length, demolitions: world.demolitions,
});

describe('GameWorld colours: set, clear, read', () => {
  it('a new object has no record', () => {
    const { world, cups } = parkWithRides();
    expect(world.objectColours(cups)).toBeNull();
    expect('colours' in world.objects.get(cups)!).toBe(false);
    expect(world.objectColours(99_999)).toBeNull();
  });

  it('sets, reads back a frozen record, and clears', () => {
    const { world, cups } = parkWithRides();
    expect(world.setObjectColours(cups, [19, null])).toEqual({ ok: true, changed: true });
    expect(world.objectColours(cups)).toEqual([19, null]);
    expect(Object.isFrozen(world.objectColours(cups))).toBe(true);
    expect(world.setObjectColours(cups, [19, 4])).toEqual({ ok: true, changed: true });
    expect(world.objectColours(cups)).toEqual([19, 4]);
    expect(world.clearObjectColours(cups)).toEqual({ ok: true, changed: true });
    expect(world.objectColours(cups)).toBeNull();
    expect('colours' in world.objects.get(cups)!, 'cleared means the key is gone').toBe(false);
  });

  it('an all-null array clears, and storing it for an uncoloured object is a no-op', () => {
    const { world, cups } = parkWithRides();
    expect(world.setObjectColours(cups, [null, null])).toEqual({ ok: true, changed: false });
    world.setObjectColours(cups, [1, 2]);
    expect(world.setObjectColours(cups, [null, null])).toEqual({ ok: true, changed: true });
    expect(world.objectColours(cups)).toBeNull();
    expect(world.clearObjectColours(cups)).toEqual({ ok: true, changed: false });
  });

  it('does not alias the caller array and replaces the record (new identity) on every change', () => {
    const { world, cups } = parkWithRides();
    const input = [3, null];
    world.setObjectColours(cups, input);
    const first = world.objectColours(cups);
    input[0] = 9;
    expect(world.objectColours(cups)).toEqual([3, null]);
    world.setObjectColours(cups, [4, null]);
    expect(world.objectColours(cups)).not.toBe(first);
    expect(first, 'the old record is untouched').toEqual([3, null]);
  });

  it('an identical set keeps the same record identity (renderers diff by identity)', () => {
    const { world, cups } = parkWithRides();
    world.setObjectColours(cups, [3, 4]);
    const record = world.objectColours(cups);
    expect(world.setObjectColours(cups, [3, 4])).toEqual({ ok: true, changed: false });
    expect(world.objectColours(cups)).toBe(record);
  });

  it('each ride keeps its own record', () => {
    const { world, cups, wheel } = parkWithRides();
    world.setObjectColours(cups, [19, null]);
    world.setObjectColours(wheel, [1, 2, 3]);
    expect(world.objectColours(cups)).toEqual([19, null]);
    expect(world.objectColours(wheel)).toEqual([1, 2, 3]);
  });

  it('refuses unknown objects, non-colourable objects and invalid arrays, changing nothing', () => {
    const { world, cups, tree } = parkWithRides();
    const before = JSON.stringify(world.serialize());
    const appearance = world.appearanceVersion;
    expect(world.setObjectColours(12345, [1, 2])).toEqual({ ok: false, reason: 'unknown-object' });
    expect(world.clearObjectColours(12345)).toEqual({ ok: false, reason: 'unknown-object' });
    // Step 2 made shops and comforts colourable; trees stay fixed.
    expect(world.setObjectColours(tree, [1, 2])).toEqual({ ok: false, reason: 'not-colourable' });
    expect(world.setObjectColours(tree, [1])).toEqual({ ok: false, reason: 'not-colourable' });
    expect(world.clearObjectColours(tree)).toEqual({ ok: false, reason: 'not-colourable' });
    const invalid: unknown[] = [[1], [1, 2, 3], [], [-1, null], [SWATCH_COUNT, null], [0.5, null], [Number.NaN, null], [Infinity, null], ['1', null], null, 'ab', {}];
    for (const value of invalid) {
      expect(world.setObjectColours(cups, value as never), JSON.stringify(value)).toEqual({ ok: false, reason: 'invalid-colours' });
    }
    expect(JSON.stringify(world.serialize())).toBe(before);
    expect(world.appearanceVersion).toBe(appearance);
  });

  it('every swatch index is accepted in every slot', () => {
    const { world, wheel } = parkWithRides();
    for (const swatch of COLOUR_SWATCHES) {
      expect(world.setObjectColours(wheel, [swatch.index, swatch.index, swatch.index]).ok).toBe(true);
    }
  });
});

describe('GameWorld colours are cosmetic: no version, no cash, no transaction', () => {
  it('leaves version, pathVersion, cash, transactions and demolitions alone', () => {
    const { world, cups, wheel } = parkWithRides();
    const before = counters(world);
    world.setObjectColours(cups, [19, null]);
    world.setObjectColours(wheel, [1, 2, 3]);
    world.clearObjectColours(cups);
    expect(counters(world)).toEqual(before);
  });

  it('bumps appearanceVersion once per change, not for a no-op or a refusal', () => {
    const { world, cups, shop } = parkWithRides();
    const start = world.appearanceVersion;
    world.setObjectColours(cups, [1, null]);
    expect(world.appearanceVersion).toBe(start + 1);
    world.setObjectColours(cups, [1, null]);
    world.clearObjectColours(shop);
    world.setObjectColours(cups, [99, null]);
    expect(world.appearanceVersion).toBe(start + 1);
    world.clearObjectColours(cups);
    expect(world.appearanceVersion).toBe(start + 2);
    world.clearObjectColours(cups);
    expect(world.appearanceVersion).toBe(start + 2);
  });

  it('notifies listeners once per change, once per batch, and not at all for a no-op', () => {
    const { world, cups, wheel } = parkWithRides();
    let calls = 0;
    world.subscribe(() => { calls += 1; });
    world.setObjectColours(cups, [1, null]);
    expect(calls).toBe(1);
    world.setObjectColours(cups, [1, null]);
    expect(calls, 'no-op').toBe(1);
    world.batch(() => {
      world.setObjectColours(cups, [2, null]);
      world.setObjectColours(wheel, [1, 2, 3]);
      world.clearObjectColours(cups);
    });
    expect(calls, 'a batch notifies once').toBe(2);
    world.batch(() => { world.setObjectColours(cups, [null, null]); });
    expect(calls, 'a batch of no-ops notifies nobody').toBe(2);
  });

  it('building and bulldozing still bump version, and bulldozing removes the record with the object', () => {
    const { world, cups } = parkWithRides();
    world.setObjectColours(cups, [19, null]);
    const anchor = world.objects.get(cups)!.anchor;
    expect(world.bulldoze(anchor).removed).toBe(true);
    expect(world.objectColours(cups)).toBeNull();
    const rebuilt = world.buildObject('comet-cups', anchor)!;
    expect(rebuilt.id).not.toBe(cups);
    expect(world.objectColours(rebuilt.id), 'a rebuilt ride starts with the defaults').toBeNull();
  });
});

describe('GameWorld colours in a save', () => {
  it('serialize omits the key for an uncoloured object and copies the record for a coloured one', () => {
    const { world, cups, wheel } = parkWithRides();
    world.setObjectColours(cups, [19, null]);
    const state = world.serialize();
    expect(state.objects.find((o) => o.id === cups)!.colours).toEqual([19, null]);
    expect(state.objects.find((o) => o.id === wheel)).not.toHaveProperty('colours');
    expect(state.objects.filter((o) => 'colours' in o).length).toBe(1);
    state.objects.find((o) => o.id === cups)!.colours![0] = 7;
    expect(world.objectColours(cups), 'the state is a copy').toEqual([19, null]);
  });

  it('round-trips through JSON and restores frozen records', () => {
    const { world, cups, wheel } = parkWithRides();
    world.setObjectColours(cups, [19, 3]);
    world.setObjectColours(wheel, [null, 5, null]);
    const target = new GameWorld(80_000);
    target.restore(clone(world.serialize()));
    expect(target.objectColours(cups)).toEqual([19, 3]);
    expect(target.objectColours(wheel)).toEqual([null, 5, null]);
    expect(Object.isFrozen(target.objectColours(cups))).toBe(true);
    expect(hashState(target.serialize())).toBe(hashState(world.serialize()));
  });

  it('restore replaces every record (a recoloured world restored from an uncoloured state has none)', () => {
    const { world, cups } = parkWithRides();
    const plain = clone(world.serialize());
    world.setObjectColours(cups, [19, 3]);
    world.restore(plain);
    expect(world.objectColours(cups)).toBeNull();
    expect('colours' in world.objects.get(cups)!).toBe(false);
  });

  it('restore bumps appearanceVersion (undo needs the stamp to move) but leaves version as saved', () => {
    const { world, cups } = parkWithRides();
    const state = clone(world.serialize());
    world.setObjectColours(cups, [1, 1]);
    const appearance = world.appearanceVersion;
    world.restore(state);
    expect(world.appearanceVersion).toBe(appearance + 1);
    expect(world.version).toBe(state.version);
  });

  it('a rejected restore changes neither the records nor appearanceVersion', () => {
    const { world, cups } = parkWithRides();
    world.setObjectColours(cups, [4, 5]);
    const appearance = world.appearanceVersion;
    const bad = clone(world.serialize()) as GameWorldState;
    bad.objects[0].rotation = 7 as never;
    expect(() => world.restore(bad)).toThrow(SaveError);
    expect(world.objectColours(cups)).toEqual([4, 5]);
    expect(world.appearanceVersion).toBe(appearance);
  });

  it('two parks identical except one recolour have different world hashes', () => {
    const a = parkWithRides();
    const b = parkWithRides();
    expect(hashState(a.world.serialize())).toBe(hashState(b.world.serialize()));
    b.world.setObjectColours(b.cups, [19, null]);
    expect(hashState(a.world.serialize())).not.toBe(hashState(b.world.serialize()));
    b.world.clearObjectColours(b.cups);
    expect(hashState(a.world.serialize()), 'reset gives back the exact uncoloured state').toBe(hashState(b.world.serialize()));
  });
});

describe('GameWorld restore normalises hostile colour records (never refuses)', () => {
  const restoreWith = (colours: unknown, definitionId = 'comet-cups') => {
    const world = new GameWorld(80_000);
    const object = world.buildObject(definitionId, { x: 3, y: 3 })!;
    const state = clone(world.serialize()) as GameWorldState;
    (state.objects.find((o) => o.id === object.id) as { colours?: unknown }).colours = colours;
    const target = new GameWorld(80_000);
    target.restore(clone(state));
    return target.objectColours(object.id);
  };

  it('keeps a valid record', () => {
    expect(restoreWith([19, null])).toEqual([19, null]);
  });

  it('pads a short record and truncates a long one', () => {
    expect(restoreWith([19])).toEqual([19, null]);
    expect(restoreWith([null, 4, 7, 8])).toEqual([null, 4]);
  });

  it('turns invalid entries into the default and an all-default result into no record', () => {
    expect(restoreWith([-1, 21])).toBeNull();
    expect(restoreWith([1.5, 'x'])).toBeNull();
    expect(restoreWith([1e300, 3])).toEqual([null, 3]);
    expect(restoreWith([2 ** 53, 3])).toEqual([null, 3]);
    expect(restoreWith([{}, [1]])).toBeNull();
    expect(restoreWith([true, false])).toBeNull();
  });

  it('drops a record that is not an array', () => {
    for (const value of [null, 5, 'ab', {}, { length: 2, 0: 1 }, true]) expect(restoreWith(value), JSON.stringify(value)).toBeNull();
  });

  it('drops a record on a definition that is not colourable (a tree)', () => {
    expect(restoreWith([1, 2], 'confetti-tree')).toBeNull();
    expect(restoreWith([1], 'confetti-tree')).toBeNull();
  });

  it('keeps and normalises records on the step-2 kinds (stall, comfort, scenery, coaster pieces are objects too)', () => {
    expect(restoreWith([1, 2], 'picnic-pocket')).toEqual([1, 2]);
    expect(restoreWith([1], 'lollipop-lamp')).toEqual([1, null]);
    expect(restoreWith([1, 2, 3], 'ribbon-bench')).toEqual([1, 2]);
    expect(restoreWith([5, 6], 'ripple-fountain'), 'the fountain has one slot').toEqual([5]);
  });
});

describe('step 2: coasters, stalls, scenery and comforts are objects with records too', () => {
  const placed = () => {
    const world = new GameWorld(250_000);
    const ids = {
      shop: world.buildObject('picnic-pocket', { x: 3, y: 3 })!.id,
      bench: world.buildObject('ribbon-bench', { x: 7, y: 3 })!.id,
      lamp: world.buildObject('lollipop-lamp', { x: 9, y: 3 })!.id,
      flowers: world.buildObject('sunburst-flowers', { x: 11, y: 3 })!.id,
      fountain: world.buildObject('ripple-fountain', { x: 13, y: 3 })!.id,
      tree: world.buildObject('confetti-tree', { x: 17, y: 3 })!.id,
    };
    return { world, ...ids };
  };

  it('sets, reads and clears each kind with its own slot count', () => {
    const { world, shop, bench, lamp, flowers, fountain } = placed();
    expect(world.setObjectColours(shop, [19, 6])).toEqual({ ok: true, changed: true });
    expect(world.setObjectColours(bench, [1, null])).toEqual({ ok: true, changed: true });
    expect(world.setObjectColours(lamp, [null, 4])).toEqual({ ok: true, changed: true });
    expect(world.setObjectColours(flowers, [7, 8])).toEqual({ ok: true, changed: true });
    expect(world.setObjectColours(fountain, [20])).toEqual({ ok: true, changed: true });
    expect(world.setObjectColours(fountain, [20, 1]), 'the fountain has one slot').toEqual({ ok: false, reason: 'invalid-colours' });
    expect(world.objectColours(shop)).toEqual([19, 6]);
    expect(world.objectColours(fountain)).toEqual([20]);
    expect(world.clearObjectColours(shop)).toEqual({ ok: true, changed: true });
    expect(world.objectColours(shop)).toBeNull();
  });

  it('a tree is refused (trees stay fixed)', () => {
    const { world, tree } = placed();
    expect(world.setObjectColours(tree, [1, 2])).toEqual({ ok: false, reason: 'not-colourable' });
  });

  it('a coaster records four slots on its object and keeps its pieces and stats', () => {
    const session = new ParkSession(null);
    const park = seedColourTestPark(session);
    expect(park.problems).toEqual([]);
    const coasterId = [...session.world.coasters.keys()][0];
    const before = JSON.stringify(session.world.coasters.get(coasterId));
    expect(session.world.setObjectColours(coasterId, [19, null, 4, 12])).toEqual({ ok: true, changed: true });
    expect(session.world.setObjectColours(coasterId, [19, null])).toEqual({ ok: false, reason: 'invalid-colours' });
    expect(session.world.objectColours(coasterId)).toEqual([19, null, 4, 12]);
    expect(JSON.stringify(session.world.coasters.get(coasterId))).toBe(before);
    const restored = ParkSession.fromState(clone(session.serialize()));
    expect(restored.world.objectColours(coasterId)).toEqual([19, null, 4, 12]);
  });
});

describe('the entrance gate record', () => {
  it('starts as null, sets and clears like an object record, frozen, free and cosmetic', () => {
    const world = new GameWorld(80_000);
    const before = counters(world);
    expect(world.gateColours).toBeNull();
    expect(world.setGateColours([19, null, 13])).toEqual({ ok: true, changed: true });
    expect(world.gateColours).toEqual([19, null, 13]);
    expect(Object.isFrozen(world.gateColours)).toBe(true);
    expect(world.setGateColours([19, null, 13])).toEqual({ ok: true, changed: false });
    expect(world.setGateColours([null, null, null])).toEqual({ ok: true, changed: true });
    expect(world.gateColours, 'all-default is no record').toBeNull();
    expect(world.clearGateColours()).toEqual({ ok: true, changed: false });
    world.setGateColours([1, 2, 3]);
    expect(world.clearGateColours()).toEqual({ ok: true, changed: true });
    expect(world.gateColours).toBeNull();
    expect(counters(world), 'no version, cash or transaction').toEqual(before);
  });

  it('refuses invalid records and changes nothing', () => {
    const world = new GameWorld(80_000);
    world.setGateColours([1, 2, 3]);
    const appearance = world.appearanceVersion;
    const invalid: unknown[] = [[1], [1, 2], [1, 2, 3, 4], [], [-1, null, null], [21, null, null], [0.5, null, null], [Number.NaN, null, null], ['1', null, null], null, 'abc', {}];
    for (const value of invalid) expect(world.setGateColours(value as never), JSON.stringify(value)).toEqual({ ok: false, reason: 'invalid-colours' });
    expect(world.gateColours).toEqual([1, 2, 3]);
    expect(world.appearanceVersion).toBe(appearance);
  });

  it('bumps appearanceVersion once per change, notifies once per change or batch, never bumps version', () => {
    const world = new GameWorld(80_000);
    const cups = world.buildObject('comet-cups', { x: 3, y: 3 })!.id;
    let calls = 0;
    world.subscribe(() => { calls += 1; });
    const start = world.appearanceVersion;
    const version = world.version;
    world.setGateColours([1, null, null]);
    expect(world.appearanceVersion).toBe(start + 1);
    expect(calls).toBe(1);
    world.setGateColours([1, null, null]);
    expect(calls, 'no-op').toBe(1);
    world.batch(() => {
      world.setGateColours([2, null, null]);
      world.setObjectColours(cups, [3, null]);
      world.clearGateColours();
    });
    expect(calls, 'one notification for the batch').toBe(2);
    expect(world.version).toBe(version);
  });

  it('is saved only when set, round-trips through JSON and is replaced by restore', () => {
    const world = new GameWorld(80_000);
    expect(world.serialize()).not.toHaveProperty('gateColours');
    world.setGateColours([19, null, 13]);
    const state = clone(world.serialize());
    expect(state.gateColours).toEqual([19, null, 13]);
    state.gateColours![0] = 5;
    expect(world.gateColours, 'the state is a copy').toEqual([19, null, 13]);
    const target = new GameWorld(80_000);
    target.restore(clone(world.serialize()));
    expect(target.gateColours).toEqual([19, null, 13]);
    expect(Object.isFrozen(target.gateColours)).toBe(true);
    expect(hashState(target.serialize())).toBe(hashState(world.serialize()));
    const plain = clone(new GameWorld(80_000).serialize());
    target.restore(plain);
    expect(target.gateColours, 'restoring an uncoloured state clears the gate').toBeNull();
  });

  it('restore normalises a hostile gate record and never refuses', () => {
    const restoreGate = (value: unknown): readonly (number | null)[] | null => {
      const state = clone(new GameWorld(80_000).serialize()) as unknown as Record<string, unknown>;
      state.gateColours = value;
      const target = new GameWorld(80_000);
      target.restore(clone(state) as unknown as GameWorldState);
      return target.gateColours;
    };
    expect(restoreGate([4, null, 7])).toEqual([4, null, 7]);
    expect(restoreGate([4])).toEqual([4, null, null]);
    expect(restoreGate([4, 5, 6, 7, 8])).toEqual([4, 5, 6]);
    expect(restoreGate([-1, 99, 1.5])).toBeNull();
    expect(restoreGate(['x', {}, [1]])).toBeNull();
    for (const value of [null, 5, 'abc', {}, { 0: 1, length: 3 }, true]) expect(restoreGate(value), JSON.stringify(value)).toBeNull();
  });

  it('two parks identical except the gate colour hash differently; resetting gives the same hash back', () => {
    const a = new GameWorld(80_000);
    const b = new GameWorld(80_000);
    expect(hashState(a.serialize())).toBe(hashState(b.serialize()));
    b.setGateColours([19, null, null]);
    expect(hashState(a.serialize())).not.toBe(hashState(b.serialize()));
    b.clearGateColours();
    expect(hashState(a.serialize())).toBe(hashState(b.serialize()));
  });
});

describe('recolourBatch (a paint gesture) and applyPresetToPark (a whole-park preset): one notification', () => {
  const populated = () => {
    const session = new ParkSession(null);
    const park = seedColourTestPark(session);
    return { session, world: session.world, ...park };
  };

  it('applies a mixed edit list, counts what changed and notifies once', () => {
    const { world } = populated();
    const [a, b] = [...world.objects.values()].filter((o) => o.definitionId === 'picnic-pocket' || o.definitionId === 'ribbon-bench').map((o) => o.id);
    let calls = 0;
    world.subscribe(() => { calls += 1; });
    const appearance = world.appearanceVersion;
    const version = world.version;
    const cash = world.cash;
    const result = world.recolourBatch([
      { objectId: a, colours: world.objects.get(a)!.definitionId === 'picnic-pocket' ? [19, null] : [19, null] },
      { objectId: b, colours: [3, 4] },
      { gate: true, colours: [7, null, null] },
    ]);
    expect(result.changedObjectIds).toEqual([a, b]);
    expect(result.gateChanged).toBe(true);
    expect(result.changedCount).toBe(3);
    expect(result.refused).toEqual([]);
    expect(calls, 'one notification for the whole batch').toBe(1);
    expect(world.appearanceVersion, 'appearanceVersion moves once per changed record').toBe(appearance + 3);
    expect(world.version).toBe(version);
    expect(world.cash).toBe(cash);
  });

  it('edits that change nothing are not counted and do not notify; refusals are reported and do not stop the rest', () => {
    const { world } = populated();
    const shop = [...world.objects.values()].find((o) => o.definitionId === 'picnic-pocket')!.id;
    const tree = [...world.objects.values()].find((o) => o.definitionId === 'confetti-tree')!.id;
    let calls = 0;
    world.subscribe(() => { calls += 1; });
    const none = world.recolourBatch([{ objectId: shop, colours: null }, { gate: true, colours: null }]);
    expect(none).toEqual({ changedObjectIds: [], gateChanged: false, changedCount: 0, refused: [] });
    expect(calls).toBe(0);
    const mixed = world.recolourBatch([
      { objectId: 99_999, colours: [1, 2] },
      { objectId: tree, colours: [1, 2] },
      { objectId: shop, colours: [1] },
      { objectId: shop, colours: [1, 2] },
      { objectId: shop, colours: [1, 2] },
    ]);
    expect(mixed.refused).toEqual([
      { index: 0, reason: 'unknown-object' }, { index: 1, reason: 'not-colourable' }, { index: 2, reason: 'invalid-colours' },
    ]);
    expect(mixed.changedObjectIds, 'the second identical edit changes nothing').toEqual([shop]);
    expect(world.objectColours(shop)).toEqual([1, 2]);
    expect(calls).toBe(1);
  });

  it('every kind and the gate: a preset on the whole park is ONE batch, then every colourable object has its record', () => {
    const { world } = populated();
    const colourable = [...world.objects.values()].filter((o) => colourSlotsFor(o.definitionId).length > 0);
    expect(colourable.length).toBeGreaterThan(40);
    expect(new Set(colourable.map((o) => colourKindOf(o.definitionId))), 'rides, coasters, stalls, comforts and scenery are all there').toEqual(
      new Set(['ride', 'coaster', 'stall', 'comfort', 'scenery']),
    );
    let calls = 0;
    world.subscribe(() => { calls += 1; });
    const result = world.applyPresetToPark('seaside');
    expect(calls, 'one notification').toBe(1);
    expect(result.gateChanged).toBe(true);
    expect(result.changedObjectIds.length, 'every colourable object changed (Seaside differs from every default)').toBe(colourable.length);
    expect(result.changedCount).toBe(colourable.length + 1);
    expect(result.refused).toEqual([]);
    for (const object of colourable) expect(world.objectColours(object.id), object.definitionId).toEqual(presetRecord(object.definitionId, 'seaside'));
    expect(world.gateColours).toEqual(presetRecord(ENTRANCE_COLOUR_ID, 'seaside'));
    for (const object of world.objects.values()) {
      if (colourSlotsFor(object.definitionId).length === 0) expect('colours' in object, `${object.definitionId} is untouched`).toBe(false);
    }
  });

  it('applying the same preset again changes nothing (not counted, no notification); Candy resets everything', () => {
    const { world } = populated();
    world.applyPresetToPark('midnight');
    let calls = 0;
    world.subscribe(() => { calls += 1; });
    expect(world.applyPresetToPark('midnight').changedCount).toBe(0);
    expect(calls).toBe(0);
    const reset = world.applyPresetToPark('candy');
    expect(reset.changedCount).toBeGreaterThan(40);
    expect(calls).toBe(1);
    for (const object of world.objects.values()) expect('colours' in object).toBe(false);
    expect(world.gateColours).toBeNull();
  });

  it('a preset replaces what an object had, and an unknown preset changes nothing', () => {
    const { world } = populated();
    const star = [...world.coasters.keys()][0];
    world.setObjectColours(star, [1, 2, 3, 4]);
    world.applyPresetToPark('candy');
    expect(world.objectColours(star)).toBeNull();
    expect(world.applyPresetToPark('nope' as never)).toEqual({ changedObjectIds: [], gateChanged: false, changedCount: 0, refused: [] });
  });

  it('a whole-park preset round-trips through a save', () => {
    const { session, world } = populated();
    world.applyPresetToPark('autumn');
    const state = clone(session.serialize());
    const loaded = ParkSession.fromState(state);
    for (const object of world.objects.values()) expect(loaded.world.objectColours(object.id), object.definitionId).toEqual(world.objectColours(object.id));
    expect(loaded.world.gateColours).toEqual(world.gateColours);
    expect(hashState(loaded.serialize())).toBe(hashState(session.serialize()));
  });

  it('placement plus colour in one batch notifies once and bulldozing removes the record with the object', () => {
    const world = new GameWorld(80_000);
    let calls = 0;
    world.subscribe(() => { calls += 1; });
    const placed = world.batch(() => {
      const object = world.buildObject('picnic-pocket', { x: 3, y: 3 })!;
      world.setObjectColours(object.id, [19, null]);
      return object;
    });
    expect(calls).toBe(1);
    expect(world.objectColours(placed.id)).toEqual([19, null]);
    expect(world.bulldoze(placed.anchor).removed).toBe(true);
    expect(world.objectColours(placed.id)).toBeNull();
  });
});
