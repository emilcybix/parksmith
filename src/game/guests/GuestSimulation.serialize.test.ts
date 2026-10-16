import { describe, expect, it } from 'vitest';
import { GuestSimulation } from './GuestSimulation';
import type { Guest, GuestState } from './types';
import { RideSimulation } from '../rides/RideSimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { ParkSession } from '../session/ParkSession';
import { GameWorld } from '../World';
import { GAME_CONFIG } from '../config';
import { hashState } from '../save/hash';
import { assertPlainData, assertStructuredCloneSafe, auditOwnProperties, plainDeepEqual } from '../save/plainData';
import { SaveError } from '../save/version';
import type { GuestSimulationState } from '../save/state';

const STEP_MS = 100;

/** A sandbox park with a ride, a drink shop and a comfort facility reachable from the entrance. */
const createPark = (): ParkSession => {
  const session = new ParkSession();
  session.world.buildPaths([
    { x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 },
    { x: 16, y: 27 }, { x: 17, y: 27 }, { x: 14, y: 26 }, { x: 13, y: 26 },
  ]);
  for (const [definitionId, anchor] of [
    ['petal-roundabout', { x: 12, y: 27 }],
    ['fizz-foundry', { x: 16, y: 28 }],
    ['comfort-cabin', { x: 14, y: 24 }],
  ] as const) {
    if (!session.world.buildObject(definitionId, anchor)) throw new Error(`fixture: ${definitionId} should be placeable`);
  }
  session.rides.syncWithWorld();
  session.shops.syncWithWorld();
  session.operations.syncWithWorld();
  return session;
};

const runTicks = (session: ParkSession, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick += 1) session.step(STEP_MS);
};

const createBusyPark = (ticks = 400): ParkSession => {
  const session = createPark();
  session.guests.spawnGuests(12);
  runTicks(session, ticks);
  return session;
};

const jsonRoundTrip = (state: GuestSimulationState): GuestSimulationState =>
  JSON.parse(JSON.stringify(state)) as GuestSimulationState;

const freshSimulation = (seed = 7): GuestSimulation => {
  const world = new GameWorld();
  return new GuestSimulation(world, new RideSimulation(world), new ShopSimulation(world), seed);
};

const expectInvalidState = (action: () => void): void => {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught instanceof SaveError, `expected SaveError, got ${String(caught)}`).toBe(true);
  expect((caught as SaveError).code).toBe('invalid-state');
};

describe('GuestSimulation serialize/restore', () => {
  it('produces plain data that survives JSON and structured clone byte-identically', () => {
    const { guests } = createBusyPark();
    const state = guests.serialize();
    expect(state.guests.length, 'scenario should have guests').toBeGreaterThan(5);
    assertPlainData(state);
    assertStructuredCloneSafe(state);
    expect(JSON.stringify(jsonRoundTrip(state))).toBe(JSON.stringify(state));
  });

  it('round-trips into a fresh instance with equal state and hash, also through JSON', () => {
    const source = createBusyPark().guests;
    const state = source.serialize();
    const target = freshSimulation();
    target.restore(state);
    expect(plainDeepEqual(target.serialize(), state)).toBe(true);
    expect(hashState(target.serialize())).toBe(hashState(state));
    const viaJson = freshSimulation(99);
    viaJson.restore(jsonRoundTrip(state));
    expect(hashState(viaJson.serialize())).toBe(hashState(state));
  });

  it('is pure: serializing does not change later behaviour or state', () => {
    const a = createBusyPark(200);
    const b = createBusyPark(200);
    for (let tick = 0; tick < 100; tick += 1) {
      a.guests.serialize();
      a.step(STEP_MS);
      b.step(STEP_MS);
    }
    expect(hashState(a.guests.serialize())).toBe(hashState(b.guests.serialize()));
  });

  it('resets a dirty simulation completely, same as restoring into a fresh one', () => {
    const state = createBusyPark().guests.serialize();
    const dirty = createBusyPark(150).guests;
    dirty.setParkRating(3);
    dirty.removeAll();
    dirty.spawnGuests(4);
    dirty.restore(state);
    expect(plainDeepEqual(dirty.serialize(), state)).toBe(true);
    expect(dirty.guests.size).toBe(state.guests.length);
  });

  it('keeps the guest Map identity shared with other owners and its insertion order', () => {
    const source = createBusyPark().guests;
    const state = source.serialize();
    const target = freshSimulation();
    const shared = target.guests;
    target.spawnGuests(3);
    target.restore(state);
    expect(target.guests, 'restore must clear and refill the same Map').toBe(shared);
    expect([...shared.keys()]).toEqual(state.guests.map((guest) => guest.id));
  });

  it('never aliases the held state, restored guests, or position/currentCell/route cells', () => {
    const state = createBusyPark().guests.serialize();
    const held = structuredClone(state);
    const first = freshSimulation();
    const second = freshSimulation();
    first.restore(state);
    second.restore(state);
    for (const guest of first.guests.values()) {
      expect(guest.position).not.toBe(guest.currentCell);
      for (const cell of guest.route) {
        expect(guest.position).not.toBe(cell);
        expect(guest.currentCell).not.toBe(cell);
      }
      guest.position.x += 0.25;
      guest.currentCell.y += 1;
      guest.route.forEach((cell) => { cell.x += 1; });
      guest.route.push({ x: 0, y: 0 });
      guest.recentRideIds.push(42);
      guest.recentServiceIds.push(43);
      guest.money += 1;
    }
    expect(state, 'mutating restored guests changed the held state').toEqual(held);
    expect(second.serialize(), 'a second restore of the same state was affected').toEqual(held);
    const serialized = second.serialize();
    for (const record of serialized.guests) {
      expect(record.position).not.toBe(record.currentCell);
      record.position.x += 1;
      record.route.forEach((cell) => { cell.y += 1; });
      record.recentRideIds.push(9);
    }
    expect(second.serialize(), 'mutating a serialized copy changed the live guests').toEqual(held);
  });

  it('does not reissue ids after removeAll and preserves counters across restore', () => {
    const park = createPark();
    park.guests.spawnGuests(5);
    park.guests.removeAll();
    const state = park.guests.serialize();
    expect(state.guests).toEqual([]);
    expect(state.nextGuestId).toBe(6);
    expect(state.totalArrivals).toBe(5);
    const target = freshSimulation();
    target.restore(state);
    target.spawnGuests(1);
    expect([...target.guests.keys()], 'ids must continue after the removed ones').toEqual([6]);
    expect(target.totalArrivals).toBe(6);
  });

  it('restores a negative spawn timer at the guest cap exactly', () => {
    const park = createPark();
    park.guests.spawnGuests(GAME_CONFIG.guests.maximum);
    runTicks(park, 30);
    const state = park.guests.serialize();
    expect(state.spawnTimerSeconds, 'timer keeps counting down while capped').toBeLessThan(0);
    const target = freshSimulation();
    target.restore(jsonRoundTrip(state));
    expect(Object.is(target.serialize().spawnTimerSeconds, state.spawnTimerSeconds)).toBe(true);
  });

  it('restores guests in every GuestState with cosmetics and behavioural thoughts verbatim', () => {
    const states: GuestState[] = [
      'entering', 'wandering', 'walkingToRide', 'queueing', 'riding',
      'walkingToShop', 'queueingForShop', 'shopping', 'usingFacility', 'leaving',
    ];
    const source = createPark().guests;
    source.spawnGuests(states.length);
    [...source.guests.values()].forEach((guest: Guest, index) => {
      guest.state = states[index];
      guest.color = 0x123456 + index;
      guest.accent = 0xabcdef - index;
      guest.currentThought = index % 2 === 0 ? 'Heading for Petal Roundabout — sounds fun!' : "I'm not paying that much.";
      guest.position = { x: 15.123456789012 - index / 7, y: 30 - index / 3 };
      // Restore requires a guest to stand within one cell of its current cell.
      guest.currentCell = { x: Math.round(guest.position.x), y: Math.round(guest.position.y) };
      guest.recentRideIds = [3, 2, 1].slice(0, index % 4);
      guest.lastRideSatisfaction = index % 2 === 0 ? null : 61.5;
      guest.servicePriceLimit = index % 3 === 0 ? 4.25 : null;
    });
    const state = source.serialize();
    const target = freshSimulation();
    target.restore(jsonRoundTrip(state));
    expect(target.serialize()).toEqual(state);
    expect([...target.guests.values()].map((guest) => guest.state)).toEqual(states);
  });

  it('normalises -0 and keeps parkRating without clamping or recomputing', () => {
    const source = freshSimulation();
    source.spawnGuests(1);
    const guest = [...source.guests.values()][0];
    guest.money = -0;
    guest.position = { x: -0, y: 1.5 };
    source.setParkRating(37.123456789);
    const state = source.serialize();
    expect(Object.is(state.guests[0].money, 0)).toBe(true);
    expect(Object.is(state.guests[0].position.x, 0)).toBe(true);
    expect(state.parkRating).toBe(37.123456789);
  });

  it('continues identically after restore into a dirty simulation for 600 ticks', () => {
    const reference = createPark();
    const restored = createPark();
    for (const session of [reference, restored]) {
      session.guests.spawnGuests(6);
      runTicks(session, 3);
    }
    const held = jsonRoundTrip(reference.guests.serialize());
    // Dirty the restore target: other guests, other RNG position, other counters.
    restored.guests.removeAll();
    restored.guests.spawnGuests(9);
    restored.guests.setParkRating(1);
    restored.guests.restore(held);
    for (let tick = 0; tick < 600; tick += 1) {
      reference.step(STEP_MS);
      restored.step(STEP_MS);
      if (tick % 50 === 0) {
        expect(
          hashState(restored.guests.serialize()),
          `guests diverged at tick ${tick}`,
        ).toBe(hashState(reference.guests.serialize()));
      }
    }
    expect(restored.guests.serialize()).toEqual(reference.guests.serialize());
    expect(restored.guests.totalArrivals).toBe(reference.guests.totalArrivals);
    expect(restored.world.cash).toBe(reference.world.cash);
  });

  it('drops stale navigation caches so a restored guest sees the current world (H1)', () => {
    const park = createBusyPark(100);
    const state = park.guests.serialize();
    const target = createPark();
    target.guests.spawnGuests(2);
    runTicks(target, 5); // fills the target's PathNetwork caches at the current path version
    target.guests.restore(state);
    expect(target.guests.navigation.getPathVersion(), 'caches must be invalidated').not.toBe(target.world.pathVersion);
    target.step(STEP_MS);
    expect(target.guests.navigation.getPathVersion()).toBe(target.world.pathVersion);
  });

  describe('invalid payloads', () => {
    const base = (): GuestSimulationState => {
      const source = createPark().guests;
      source.spawnGuests(3);
      return source.serialize();
    };
    const cases: Array<[string, (state: GuestSimulationState) => void]> = [
      ['unknown state', (state) => { (state.guests[1] as { state: string }).state = 'dancing'; }],
      ['routeIndex beyond route', (state) => { state.guests[0].routeIndex = state.guests[0].route.length + 1; }],
      ['negative routeIndex', (state) => { state.guests[0].routeIndex = -1; }],
      ['duplicate id', (state) => { state.guests[1].id = state.guests[0].id; }],
      ['descending ids', (state) => { state.guests.reverse(); }],
      ['id zero', (state) => { state.guests[0].id = 0; }],
      ['nextGuestId not above max id', (state) => { state.nextGuestId = state.guests[2].id; }],
      ['NaN money', (state) => { state.guests[0].money = Number.NaN; }],
      ['randomState 2**32', (state) => { state.randomState = 2 ** 32; }],
      ['fractional randomState', (state) => { state.randomState = 1.5; }],
      ['parkRating 150', (state) => { state.parkRating = 150; }],
      ['fractional route cell', (state) => { state.guests[0].route[0].x = 1.5; }],
      ['fractional currentCell', (state) => { state.guests[0].currentCell.y = 0.5; }],
      ['infinite position', (state) => { state.guests[0].position.x = Number.POSITIVE_INFINITY; }],
      ['four recent rides', (state) => { state.guests[0].recentRideIds = [1, 2, 3, 4]; }],
      ['undefined nullable field', (state) => { (state.guests[0] as { servicePriceLimit: unknown }).servicePriceLimit = undefined; }],
      // Phase 30: the optional complaint link must be a non-negative integer when present.
      ['fractional thoughtObjectId', (state) => { state.guests[0].thoughtObjectId = 1.5; }],
      ['negative thoughtObjectId', (state) => { state.guests[0].thoughtObjectId = -1; }],
      ['thoughtObjectId that is a string', (state) => { (state.guests[0] as { thoughtObjectId: unknown }).thoughtObjectId = '3'; }],
      ['fractional totalArrivals', (state) => { state.totalArrivals = 2.5; }],
      ['negative totalArrivals', (state) => { state.totalArrivals = -1; }],
      ['NaN spawn timer', (state) => { state.spawnTimerSeconds = Number.NaN; }],
      // Range checks: each of these was accepted before, and ran (off-map guests, 1e9 happiness...).
      ['position off the map (-50,-50)', (state) => { state.guests[0].position = { x: -50, y: -50 }; }],
      ['position at 1e300', (state) => { state.guests[0].position = { x: 1e300, y: 1e300 }; }],
      ['currentCell off the map', (state) => { state.guests[0].currentCell = { x: 400, y: 3 }; }],
      ['position far from currentCell', (state) => { state.guests[0].position = { x: 3, y: 3 }; }],
      ['route that teleports between cells', (state) => { state.guests[0].route = [{ x: 15, y: 31 }, { x: 3, y: 3 }]; state.guests[0].routeIndex = 1; }],
      ['route cell off the map', (state) => { state.guests[0].route = [{ x: -1, y: 31 }]; state.guests[0].routeIndex = 0; }],
      ['happiness of 1e9', (state) => { state.guests[0].happiness = 1e9; }],
      ['negative hunger', (state) => { state.guests[0].hunger = -1e9; }],
      ['thirst above 100', (state) => { state.guests[0].thirst = 100.5; }],
      ['energy above 100', (state) => { state.guests[0].energy = 101; }],
      ['money of 1e9', (state) => { state.guests[0].money = 1e9; }],
      ['negative money', (state) => { state.guests[0].money = -3; }],
      ['negative patience', (state) => { state.guests[0].patienceSeconds = -1; }],
      ['maximumVisitSeconds of 0', (state) => { state.guests[0].maximumVisitSeconds = 0; }],
      ['maximumVisitSeconds above the game maximum', (state) => { state.guests[0].maximumVisitSeconds = 1e6; }],
      ['negative servicePriceLimit', (state) => { state.guests[0].servicePriceLimit = -5; }],
      ['ride satisfaction above 100', (state) => { state.guests[0].lastRideSatisfaction = 500; }],
      ['purchase satisfaction below 0', (state) => { state.guests[0].lastPurchaseSatisfaction = -1; }],
      ['age of 1e300 seconds', (state) => { state.guests[0].ageSeconds = 1e300; }],
      ['state timer of 1e300 seconds', (state) => { state.guests[0].stateTimerSeconds = 1e300; }],
      ['fractional colour', (state) => { state.guests[0].color = 1.5; }],
      ['nextGuestId of 2^53 (new guests would collide)', (state) => { state.nextGuestId = 2 ** 53; }],
      ['nextGuestId of 1e308', (state) => { state.nextGuestId = 1e308; }],
      ['totalArrivals of 1e300', (state) => { state.totalArrivals = 1e300; }],
      ['spawn timer of -1e300 (spawning blocked for good)', (state) => { state.spawnTimerSeconds = -1e300; }],
      ['guests not an array', (state) => { (state as { guests: unknown }).guests = {}; }],
    ];
    it.each(cases)('rejects %s and leaves the target untouched', (_name, corrupt) => {
      const target = createBusyPark(60).guests;
      const before = target.serialize();
      const heldBefore = JSON.stringify(before);
      const state = base();
      corrupt(state);
      expectInvalidState(() => target.restore(state));
      expect(JSON.stringify(target.serialize()), 'a rejected restore must not mutate').toBe(heldBefore);
    });

    it('accepts negative spawn timers and dangling object ids', () => {
      const state = base();
      state.spawnTimerSeconds = -1234.5;
      state.guests[0].destinationObjectId = 99999;
      state.guests[0].recentRideIds = [98765];
      freshSimulation().restore(state);
    });

    it('Phase 30: thoughtObjectId is written only when set, restores absent or null as null, and keeps a dangling id', () => {
      const source = createPark().guests;
      source.spawnGuests(3);
      const [first, second] = [...source.guests.values()];
      first.currentThought = 'This queue is taking forever.';
      first.thoughtObjectId = 42;
      const state = source.serialize();
      expect('thoughtObjectId' in state.guests[0]).toBe(true);
      expect(state.guests[0].thoughtObjectId).toBe(42);
      expect('thoughtObjectId' in state.guests[1], 'no complaint, no key').toBe(false);
      const target = freshSimulation();
      target.restore(jsonRoundTrip(state));
      expect(target.guests.get(first.id)?.thoughtObjectId, 'a dangling id is legal data').toBe(42);
      expect(target.guests.get(second.id)?.thoughtObjectId).toBeNull();
      (state.guests[1] as { thoughtObjectId: unknown }).thoughtObjectId = null;
      const explicitNull = freshSimulation();
      explicitNull.restore(state);
      expect(explicitNull.guests.get(second.id)?.thoughtObjectId).toBeNull();
      expect('thoughtObjectId' in explicitNull.serialize().guests[1], 'an explicit null is not written back').toBe(false);
    });
  });

  describe('field coverage guard', () => {
    // Every own property of a live GuestSimulation must be listed here. If this test fails after you
    // added a field: decide whether it influences the future. If yes, add it to GuestSimulationState
    // (src/game/save/state.ts), write it in serialize(), validate and apply it in restore(), and list
    // it under `serialized`. If it is a cache, list it under `derived` and reset it in restore().
    const accounting = {
      serialized: ['guests', 'random', 'nextGuestId', 'totalArrivalsCount', 'spawnTimerSeconds', 'parkRating'],
      derived: ['navigation', 'destinationWorldVersion', 'rideDestinations', 'serviceDestinations', 'benchDestinations', 'landmarks', 'benchSeats'],
      // Ruleset multipliers come from applyRules(), which already ran on the restore target.
      config: [
        'world', 'rides', 'shops', 'scenery', 'arrivalIntervalMultiplierValue', 'guestBudgetMultiplier',
        'servicePriceToleranceMultiplier', 'needDecayMultiplier', 'hungerRateMultiplier', 'thirstRateMultiplier', 'crowdCapacityMultiplier',
        // The session's shared per-tick conditions object (weather owns and refreshes it; never saved).
        'conditions',
        // Phase 14: the session's crowd field reader (the session saves the field itself as `crowd`).
        'crowd',
      ],
      // Phase 29: where guests were sick this tick, drained by the session within the same tick (empty between ticks).
      transient: ['sickCells'] as string[],
    };

    it('accounts for every own property of the simulation', () => {
      expect(auditOwnProperties(createBusyPark(50).guests, accounting)).toEqual([]);
    });

    it('changes the serialized output when each serialized simulation field changes', () => {
      const mutations: Record<string, (simulation: GuestSimulation) => void> = {
        guests: (simulation) => { simulation.spawnGuests(1); },
        random: (simulation) => { simulation.spawnGuests(1); simulation.guests.clear(); },
        nextGuestId: (simulation) => { simulation.spawnGuests(1); simulation.guests.clear(); },
        totalArrivalsCount: (simulation) => { simulation.spawnGuests(1); simulation.guests.clear(); },
        spawnTimerSeconds: (simulation) => { (simulation as unknown as { spawnTimerSeconds: number }).spawnTimerSeconds -= 0.5; },
        parkRating: (simulation) => { simulation.setParkRating(11); },
      };
      expect(Object.keys(mutations).sort()).toEqual([...accounting.serialized].sort());
      for (const [field, mutate] of Object.entries(mutations)) {
        const simulation = createBusyPark(30).guests;
        const before = JSON.stringify(simulation.serialize());
        mutate(simulation);
        expect(JSON.stringify(simulation.serialize()), `field '${field}' is not reflected in serialize()`).not.toBe(before);
      }
    });

    it('serializes every field of a Guest, and each one changes the output', () => {
      const simulation = createBusyPark(30).guests;
      const guest = [...simulation.guests.values()][0];
      const keys = Object.keys(guest);
      // Phase 30: `thoughtObjectId` is an optional key, written only while a complaint names a building.
      const expectedKeys = keys.filter((key) => key !== 'thoughtObjectId' || guest.thoughtObjectId !== null).sort();
      expect(Object.keys(simulation.serialize().guests[0]).sort(), 'Guest and GuestRecordState keys differ').toEqual(expectedKeys);
      for (const key of keys) {
        const clone = freshSimulation();
        clone.restore(simulation.serialize());
        const target = clone.guests.get(guest.id) as unknown as Record<string, unknown>;
        const before = JSON.stringify(clone.serialize());
        const value = target[key];
        if (typeof value === 'number') target[key] = value + 1;
        else if (typeof value === 'string') target[key] = `${value}!`;
        else if (value === null) target[key] = 5;
        else if (Array.isArray(value)) target[key] = [...value, key === 'route' ? { x: 1, y: 1 } : 77];
        else target[key] = { x: 123, y: 456 };
        expect(JSON.stringify(clone.serialize()), `Guest.${key} is not reflected in serialize()`).not.toBe(before);
      }
    });
  });
});
