import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { layoutOfMapId } from '../maps/parse';
import { compileParkRules } from '../scenarios/rules';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { hashState } from '../save/hash';
import { createParkSave } from '../save/version';
import { migrateSave } from '../save/migrate';
import { TO_SCHEMA_14 } from '../save/schema14TestSupport';
import { ParkSession } from '../session/ParkSession';
import { GameWorld } from '../World';
import { LandOwnership, checkOwnedParcels } from './LandOwnership';
import {
  isLegalMapSize,
  parcelCentre,
  parcelDistance,
  parcelGridOf,
  parcelIndexOfCell,
  parcelNeighbours,
  parcelPrice,
  parcelRect,
  parcelsOfRect,
} from './parcels';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 21: land ownership and buying. Deterministic coverage of the parcel rules, the price, buildability, the ledger,
 * the save (owned set, the optional keys, migration 13 -> 14) and the simulation limits on the Meadow Estate.
 */

const ESTATE = layoutOfMapId('meadow-estate');
const estateWorld = (cash = 100_000, landCostMultiplier = 1): GameWorld => new GameWorld(cash, 1, ESTATE, { landCostMultiplier });
const step = (session: ParkSession, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
};
/** The parcel just north of the starting area's middle (column 3, row 4): for sale at the start. */
const NORTH = 4 * 8 + 3;
/** The parcel north of that one (column 3, row 3): not next to owned land at the start. */
const FAR_NORTH = 3 * 8 + 3;

describe('parcel geometry and sizes', () => {
  it('a map is whole 8-cell parcels from 32 to 64 a side', () => {
    expect(GAME_CONFIG.land.parcelSize).toBe(8);
    for (const [w, h, legal] of [[32, 32, true], [64, 64, true], [48, 40, true], [36, 32, false], [24, 24, false], [72, 64, false], [32.5, 32, false]] as const) {
      expect(isLegalMapSize(w, h), `${w} x ${h}`).toBe(legal);
    }
  });

  it('indexes parcels row-major, with rectangles, centres, neighbours and Chebyshev distance', () => {
    const grid = parcelGridOf(64, 64);
    expect([grid.columns, grid.rows, grid.count]).toEqual([8, 8, 64]);
    expect(parcelIndexOfCell(grid, 31, 63)).toBe(59);
    expect(parcelRect(grid, 59)).toEqual({ x0: 24, y0: 56, x1: 31, y1: 63 });
    expect(parcelCentre(grid, 59)).toEqual({ x: 28, y: 60 });
    expect(parcelNeighbours(grid, 0)).toEqual([1, 8]);
    expect(parcelNeighbours(grid, 59)).toEqual([51, 60, 58]);
    expect(parcelDistance(grid, 59, 0)).toBe(7);
    expect(parcelsOfRect(grid, { x0: 16, y0: 40, x1: 47, y1: 63 })).toEqual([42, 43, 44, 45, 50, 51, 52, 53, 58, 59, 60, 61]);
    expect(parcelsOfRect(grid, { x0: 16, y0: 40, x1: 46, y1: 63 }), 'not whole parcels').toBeNull();
  });

  it('a saved owned list must be ascending parcel indices holding the gate parcel, in one connected area', () => {
    const grid = parcelGridOf(64, 64);
    expect(checkOwnedParcels(grid, 59, [51, 59])).toBeNull();
    expect(checkOwnedParcels(grid, 59, [])).toMatch(/empty/);
    expect(checkOwnedParcels(grid, 59, [59, 51])).toMatch(/ascending/);
    expect(checkOwnedParcels(grid, 59, [51, 51, 59])).toMatch(/ascending/);
    expect(checkOwnedParcels(grid, 59, [51])).toMatch(/gate/);
    expect(checkOwnedParcels(grid, 59, [0, 59])).toMatch(/connected/);
    expect(checkOwnedParcels(grid, 59, [59, 64])).toMatch(/parcel index/);
    expect(checkOwnedParcels(grid, 59, [1.5, 59])).toMatch(/parcel index/);
    expect(checkOwnedParcels(grid, 59, 'all')).toMatch(/array/);
  });
});

describe('the price', () => {
  it('grows with the land owned, costs more by the gate and less far away, scales with the multiplier and rounds to $10', () => {
    const { basePrice, perOwnedParcel, nearPremium, perStep, farFloor, roundTo } = GAME_CONFIG.land.price;
    expect(parcelPrice(12, 0, 1)).toBe(Math.round(((basePrice + perOwnedParcel * 12) * (1 + nearPremium)) / roundTo) * roundTo);
    expect(parcelPrice(13, 1, 1)).toBeGreaterThan(parcelPrice(12, 1, 1));
    expect(parcelPrice(12, 1, 1)).toBeGreaterThan(parcelPrice(12, 4, 1));
    expect(parcelPrice(12, 20, 1), 'the far floor').toBe(Math.round(((basePrice + perOwnedParcel * 12) * farFloor) / roundTo) * roundTo);
    expect(parcelPrice(12, 1, 0.5)).toBe(Math.round(((basePrice + perOwnedParcel * 12) * (1 + nearPremium - perStep) * 0.5) / roundTo) * roundTo);
    for (let owned = 1; owned < 64; owned += 1) {
      for (let distance = 0; distance < 8; distance += 1) expect(parcelPrice(owned, distance, 1) % roundTo).toBe(0);
    }
  });

  it('the card-modifiable landCostMultiplier reaches the price (compiled, clamped, saved only when not 1)', () => {
    const rules = compileParkRules(undefined, [{ landCostMultiplier: 0.75 }]);
    expect(rules.landCostMultiplier).toBe(0.75);
    expect(compileParkRules().landCostMultiplier).toBe(1);
    const scenario = SCENARIO_BY_ID.get('room-to-grow')!;
    const cheap = new ParkSession(scenario, [], { rules: compileParkRules(scenario.rules, [{ landCostMultiplier: 0.75 }]) });
    const plain = new ParkSession(scenario);
    const distance = parcelDistance(plain.world.land.grid, NORTH, plain.world.land.gateParcel);
    expect(plain.world.parcelPrice(NORTH)).toBe(parcelPrice(12, distance, 1));
    expect(cheap.world.parcelPrice(NORTH)).toBe(parcelPrice(12, distance, 0.75));
    expect(cheap.serialize().rules.landCostMultiplier).toBe(0.75);
    expect('landCostMultiplier' in plain.serialize().rules).toBe(false);
  });
});

describe('owning and buying land', () => {
  it('a 32 x 32 map is wholly owned: nothing for sale, nothing saved, every cell buildable as before', () => {
    const world = new GameWorld();
    expect(world.land.restricted).toBe(false);
    expect(world.land.ownedCount).toBe(16);
    expect(world.land.forSale()).toEqual([]);
    expect(world.checkParcelPurchase(0)).toMatchObject({ ok: false, reason: 'unrestricted' });
    expect('land' in world.serialize()).toBe(false);
    expect(world.heart).toEqual({ x: 15.5, y: 15.5 });
  });

  it('the estate starts with the 12 parcels around the gate; only parcels touching owned land are for sale', () => {
    const world = estateWorld();
    expect(world.land.restricted).toBe(true);
    expect(world.land.ownedParcels()).toEqual([42, 43, 44, 45, 50, 51, 52, 53, 58, 59, 60, 61]);
    expect(world.land.forSale()).toEqual([34, 35, 36, 37, 41, 46, 49, 54, 57, 62]);
    expect(world.isOwned({ x: 31, y: 63 })).toBe(true);
    expect(world.isOwned({ x: 15, y: 63 })).toBe(false);
    expect(world.heart).toEqual({ x: 31.5, y: 51.5 });
    expect(world.checkParcelPurchase(FAR_NORTH)).toMatchObject({ ok: false, reason: 'not-adjacent' });
    expect(world.checkParcelPurchase(59)).toMatchObject({ ok: false, reason: 'owned' });
    expect(world.checkParcelPurchase(64)).toMatchObject({ ok: false, reason: 'outside', price: null });
  });

  it('a purchase is a land-purchase transaction, makes the parcel buildable and opens the next one', () => {
    const world = estateWorld(10_000);
    // An open cell of the parcel (no prop, no water).
    const rect = parcelRect(world.land.grid, NORTH);
    const cell = Array.from({ length: 64 }, (_, index) => ({ x: rect.x0 + (index % 8), y: rect.y0 + Math.floor(index / 8) }))
      .find((candidate) => !world.isObstructed(candidate))!;
    expect(world.isOwned(cell)).toBe(false);
    expect(world.canPlacePath(cell)).toBe(false);
    const price = world.parcelPrice(NORTH);
    const revision = world.landRevision;
    const version = world.version;
    expect(world.buyParcel(NORTH)).toEqual({ ok: true, parcel: NORTH, price });
    expect(world.cash).toBe(10_000 - price);
    expect(world.transactions[0]).toMatchObject({ amount: -price, category: 'land-purchase', label: 'Bought a parcel of land' });
    expect(world.landRevision).toBe(revision + 1);
    expect(world.version).toBe(version + 1);
    expect(world.canPlacePath(cell)).toBe(true);
    expect(world.land.isForSale(FAR_NORTH)).toBe(true);
    expect(world.parcelPrice(FAR_NORTH), 'the next parcel costs more: one more owned').toBeGreaterThan(parcelPrice(12, parcelDistance(world.land.grid, FAR_NORTH, 59), 1));
  });

  it('too little cash refuses with the price and changes nothing', () => {
    const world = estateWorld(100);
    const before = JSON.stringify(world.serialize());
    const check = world.buyParcel(NORTH);
    expect(check).toMatchObject({ ok: false, reason: 'funds', price: world.parcelPrice(NORTH) });
    expect(JSON.stringify(world.serialize())).toBe(before);
  });

  it('nothing is built, laid or cleared on land the park does not own, and the refusal says why', () => {
    const world = estateWorld();
    expect(world.canPlacePath({ x: 10, y: 60 })).toBe(false);
    expect(world.buildPaths([{ x: 10, y: 60 }])).toMatchObject({ built: 0 });
    expect(world.checkObjectBuild('picnic-pocket', { x: 10, y: 60 })).toEqual({ ok: false, reason: 'unowned' });
    // A footprint that straddles the fence (x 15 unowned, x 16 owned) is unowned too.
    expect(world.checkObjectBuild('picnic-pocket', { x: 15, y: 60 })).toEqual({ ok: false, reason: 'unowned' });
    expect(world.checkObjectBuild('picnic-pocket', { x: 16, y: 60 })).toMatchObject({ ok: true });
    expect(world.canPlaceCoasterPiece({ cell: { x: 10, y: 60 }, height: 0 })).toBe(false);
    const prop = [...world.props.values()].find((candidate) => !world.isOwned(candidate) && world.clearCost(candidate) !== null)!;
    expect(world.checkClear(prop)).toMatchObject({ ok: false, reason: 'unowned' });
    expect(world.bulldoze(prop)).toMatchObject({ removed: false, refused: 'unowned' });
  });

  it('owned land only grows: buying every parcel in turn reaches the whole map, never a disconnected one', () => {
    const world = estateWorld(10_000_000);
    let bought = 0;
    for (let offer = world.land.forSale(); offer.length > 0; offer = world.land.forSale()) {
      for (const parcel of offer) if (world.buyParcel(parcel).ok) bought += 1;
      expect(checkOwnedParcels(world.land.grid, world.land.gateParcel, world.land.ownedParcels())).toBeNull();
    }
    expect(bought).toBe(52);
    expect(world.land.ownedCount).toBe(64);
    expect(world.land.forSale()).toEqual([]);
    expect(world.land.restricted, 'still an estate: the owned set is saved').toBe(true);
  });

  it('a scenario can override the starting area; a misaligned or gate-less area is a programming error', () => {
    expect(new GameWorld(0, 1, ESTATE, { ownedArea: null }).land.restricted).toBe(false);
    expect(new GameWorld(0, 1, ESTATE, { ownedArea: { x0: 24, y0: 56, x1: 31, y1: 63 } }).land.ownedCount).toBe(1);
    expect(() => new GameWorld(0, 1, ESTATE, { ownedArea: { x0: 24, y0: 56, x1: 30, y1: 63 } })).toThrow(/whole parcels/);
    expect(() => new GameWorld(0, 1, ESTATE, { ownedArea: { x0: 0, y0: 0, x1: 7, y1: 7 } })).toThrow(/gate/);
  });

  it('LandOwnership: a wholly owned grid owns every cell and its bounds are the map', () => {
    const land = new LandOwnership(32, 32, { x: 15, y: 31 }, null);
    expect(land.isCellOwned(0, 0)).toBe(true);
    expect(land.ownedBounds()).toEqual({ x0: 0, y0: 0, x1: 31, y1: 31 });
  });
});

describe('saving the land', () => {
  it('the world writes `land` only when restricted and restores it exactly; a bought parcel survives the round trip', () => {
    const world = estateWorld();
    world.buyParcel(NORTH);
    world.buildPaths([{ x: 28, y: 39 }, { x: 28, y: 38 }]);
    const state = JSON.parse(JSON.stringify(world.serialize()));
    expect(state.land).toEqual({ parcelSize: 8, owned: [35, 42, 43, 44, 45, 50, 51, 52, 53, 58, 59, 60, 61] });
    const twin = estateWorld();
    twin.restore(state);
    expect(twin.land.ownedParcels()).toEqual(world.land.ownedParcels());
    expect(JSON.stringify(twin.serialize())).toBe(JSON.stringify(world.serialize()));
  });

  it.each([
    ['a path on unowned land', (state: Record<string, unknown> & { paths: unknown[] }) => { state.paths.push({ x: 2, y: 60 }); }, /does not own/],
    ['an object on unowned land', (state: Record<string, unknown> & { objects: unknown[]; nextObjectId: number }) => {
      state.objects.push({ id: state.nextObjectId, definitionId: 'picnic-pocket', anchor: { x: 2, y: 60 }, rotation: 0 });
      state.nextObjectId += 1;
    }, /does not own/],
    ['a wrong parcel size', (state: Record<string, unknown> & { land: { parcelSize: number } }) => { state.land.parcelSize = 4; }, /parcelSize/],
    ['an owned list without the gate', (state: Record<string, unknown> & { land: { owned: number[] } }) => { state.land.owned = [42]; }, /gate/],
    ['a disconnected owned list', (state: Record<string, unknown> & { land: { owned: number[] } }) => { state.land.owned = [0, ...state.land.owned]; }, /connected/],
    ['land that is not an object', (state: Record<string, unknown>) => { state.land = 7; }, /land/],
  ] as const)('restore refuses %s and changes nothing', (_name, mutate, match) => {
    const world = estateWorld();
    const state = JSON.parse(JSON.stringify(world.serialize()));
    (mutate as (value: unknown) => void)(state);
    const twin = estateWorld();
    const before = JSON.stringify(twin.serialize());
    expect(() => twin.restore(state)).toThrow(match);
    expect(JSON.stringify(twin.serialize())).toBe(before);
  });

  it('an estate park saves, loads and continues exactly like the park that never saved (and the land category appears once used)', () => {
    const scenario = SCENARIO_BY_ID.get('room-to-grow')!;
    const live = new ParkSession(scenario);
    live.world.buyParcel(NORTH);
    live.world.buildPaths([{ x: 31, y: 59 }, { x: 31, y: 58 }]);
    live.syncWithWorld();
    step(live, 120);
    const state = live.serialize();
    expect(state.world.land?.owned.length).toBe(13);
    expect(state.management.categoryTotals.land?.transactionCount).toBe(1);
    expect(state.scenario?.latestMetrics.ownedParcels).toBe(13);
    const save = JSON.parse(JSON.stringify(createParkSave(state, { clock: { speed: 1, simulationTimeMs: 12_000 }, tourNodeId: null }, 1)));
    const { session: loaded } = sessionFromSave(save);
    expect(hashState(loaded.serialize())).toBe(hashState(state));
    step(live, 300);
    step(loaded, 300);
    expect(hashState(loaded.serialize())).toBe(hashState(live.serialize()));
  });

  it('a park that never bought land saves none of the Phase 21 keys', () => {
    const state = new ParkSession(SCENARIO_BY_ID.get('sunny-start')!).serialize();
    expect('land' in state.world).toBe(false);
    expect('land' in state.management.categoryTotals).toBe(false);
    expect('ownedParcels' in state.scenario!.latestMetrics).toBe(false);
    expect('landCostMultiplier' in state.rules).toBe(false);
  });
});

describe('migration 13 -> 14 (land)', () => {
  const fixtures = import.meta.glob<Record<string, unknown>>('../save/fixtures/v13/park-v13-*.json', { import: 'default', eager: true });
  type Envelope = { schemaVersion: number; stateHash: string; state: Record<string, unknown> & { world: Record<string, unknown>; rules: Record<string, unknown> } };

  it('keeps every schema-13 park byte for byte (state and hash)', () => {
    const names = Object.keys(fixtures);
    expect(names.length).toBe(3);
    for (const name of names) {
      const stored = structuredClone(fixtures[name]) as unknown as Envelope;
      expect(stored.schemaVersion, name).toBe(13);
      const migrated = migrateSave(stored, TO_SCHEMA_14);
      expect(migrated.schemaVersion, name).toBe(14);
      expect(JSON.stringify(migrated.state), name).toBe(JSON.stringify(stored.state));
      expect(migrated.stateHash, name).toBe(stored.stateHash);
    }
  });

  it('drops hand-edited Phase 21 keys a schema-13 build ignored, keeping key order', () => {
    const stored = structuredClone(Object.values(fixtures)[0]) as unknown as Envelope;
    const original = JSON.stringify(stored.state);
    stored.state.world.land = { parcelSize: 8, owned: [0] };
    stored.state.rules.landCostMultiplier = 0.5;
    stored.stateHash = hashState(stored.state);
    const migrated = migrateSave(stored, TO_SCHEMA_14);
    expect(JSON.stringify(migrated.state)).toBe(original);
  });
});

describe('the simulation respects the land', () => {
  it('guests walk only on owned land, and the scenery heatmap shows owned cells only', () => {
    const scenario = SCENARIO_BY_ID.get('room-to-grow')!;
    const session = new ParkSession(scenario);
    const { world } = session;
    world.addMoney(50_000);
    const spine = Array.from({ length: 18 }, (_, index) => ({ x: 31, y: 59 - index }));
    world.buildPaths(spine);
    world.buildObject('moonpetal-carousel', { x: 32, y: 52 });
    world.buildObject('picnic-pocket', { x: 29, y: 50 });
    // A lamp right at the fence: its glow spills over the rail, the heatmap must not.
    world.buildObject('lollipop-lamp', { x: 16, y: 45 });
    session.syncWithWorld();
    step(session, 900);
    expect(session.guests.guests.size).toBeGreaterThan(0);
    for (const guest of session.guests.guests.values()) {
      const cell = { x: Math.round(guest.position.x), y: Math.round(guest.position.y) };
      expect(world.isOwned(cell), `guest ${guest.id} at ${cell.x},${cell.y}`).toBe(true);
    }
    const heat = session.scenery.snapshot().cells;
    expect(heat.length).toBeGreaterThan(0);
    for (const entry of heat) expect(world.isOwned(entry.cell)).toBe(true);
  });
});
