import { describe, expect, it } from 'vitest';
import { hashState } from '../save/hash';
import {
  assertPlainData,
  assertStructuredCloneSafe,
  auditOwnProperties,
  plainDeepEqual,
  type PropertyAccounting,
} from '../save/plainData';
import type { ServiceRuntimeState, ShopSimulationState } from '../save/state';
import { SaveError } from '../save/version';
import { ParkSession } from '../session/ParkSession';
import { ShopSimulation } from './ShopSimulation';
import type { ServiceCompletionEvent, ServiceRuntime } from './types';

const STEP_MS = 100;

const place = (session: ParkSession, definitionId: string, anchor: { x: number; y: number }): number => {
  const object = session.world.buildObject(definitionId, anchor);
  if (!object) throw new Error(`fixture: ${definitionId} should be placeable at ${anchor.x},${anchor.y}`);
  return object.id;
};

interface Scenario {
  session: ParkSession;
  /** Drink shop: an active guest, a queue, and a completed purchase. */
  drinkId: number;
  /** Food shop with a non-default price. */
  foodId: number;
  /** Toilet with an active guest. */
  toiletId: number;
  /** Closed by the player. */
  closedId: number;
}

/** Four services in different conditions, built through the public simulation API only. */
const createScenario = (): Scenario => {
  const session = new ParkSession();
  session.world.addMoney(100_000);
  // Research gates the catalog; the fixture needs several services at once.
  session.world.setBuildAccessPolicy(null);
  session.world.buildPaths([
    { x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 },
    { x: 16, y: 27 }, { x: 17, y: 27 },
  ]);
  const drinkId = place(session, 'fizz-foundry', { x: 16, y: 28 });
  const toiletId = place(session, 'comfort-cabin', { x: 14, y: 24 });
  const foodId = place(session, 'picnic-pocket', { x: 20, y: 20 });
  const closedId = place(session, 'snack-sprint', { x: 8, y: 12 });
  session.rides.syncWithWorld();
  session.shops.syncWithWorld();
  session.operations.syncWithWorld();
  session.guests.spawnGuests(10);
  const guests = [...session.guests.guests.values()];
  const shops = session.shops;
  shops.setPrice(foodId, 8.5);
  shops.setOpen(closedId, false);
  // First wave: three drinks served one after another, so a purchase completes.
  for (const guest of guests.slice(0, 2)) shops.joinQueue(drinkId, guest);
  shops.step(STEP_MS, session.guests.guests);
  shops.step(2_600, session.guests.guests);
  // Second wave: an active guest plus a queue at the drink shop, an active toilet user, a food customer.
  for (const guest of guests.slice(2, 5)) shops.joinQueue(drinkId, guest);
  shops.joinQueue(toiletId, guests[5]);
  shops.joinQueue(foodId, guests[6]);
  shops.step(STEP_MS, session.guests.guests);
  return { session, drinkId, foodId, toiletId, closedId };
};

const jsonRoundTrip = (state: ShopSimulationState): ShopSimulationState =>
  JSON.parse(JSON.stringify(state)) as ShopSimulationState;

const deepCopy = <T>(value: T): T => structuredClone(value);

const sessionOverRestoredWorld = (source: ParkSession): ParkSession => {
  const target = new ParkSession();
  target.world.restore(source.world.serialize());
  return target;
};

const expectInvalidState = (action: () => void): SaveError => {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught instanceof SaveError, `expected SaveError, got ${String(caught)}`).toBe(true);
  expect((caught as SaveError).code).toBe('invalid-state');
  return caught as SaveError;
};

const serviceState = (state: ShopSimulationState, objectId: number): ServiceRuntimeState =>
  state.services.find((entry) => entry.objectId === objectId)!;

describe('ShopSimulation serialize', () => {
  it('captures the scenario states the tests below rely on', () => {
    const { session, drinkId, foodId, toiletId, closedId } = createScenario();
    const drink = session.shops.getService(drinkId)!;
    expect(drink.status).toBe('serving');
    expect(drink.activeGuestId, 'an active guest').not.toBeNull();
    expect(drink.queueGuestIds.length, 'a queue').toBeGreaterThan(0);
    expect(drink.customersServed, 'a completed purchase').toBeGreaterThan(0);
    expect(session.shops.getService(toiletId)!.activeGuestId).not.toBeNull();
    expect(session.shops.getService(foodId)!.itemPrice).toBe(8.5);
    expect(session.shops.getService(closedId)!.status).toBe('closed');
    const state = session.shops.serialize();
    expect(state.completionEvents.length, 'undrained completion events').toBeGreaterThan(0);
    expect(state.nextCompletionEventId).toBeGreaterThan(1);
  });

  it('is plain data that survives JSON and structured clone byte-identically', () => {
    const { session } = createScenario();
    const state = session.shops.serialize();
    assertPlainData(state);
    assertStructuredCloneSafe(state);
    expect(JSON.stringify(jsonRoundTrip(state))).toBe(JSON.stringify(state));
  });

  it('never produces -0 and throws on NaN instead of writing it', () => {
    const { session, drinkId } = createScenario();
    const drink = session.shops.getService(drinkId)!;
    drink.lifetimeRevenue = -0;
    expect(Object.is(serviceState(session.shops.serialize(), drinkId).lifetimeRevenue, 0)).toBe(true);
    drink.satisfactionTotal = Number.NaN;
    expect(() => session.shops.serialize()).toThrow(/satisfactionTotal/);
  });

  it('is read-only and does not drain the event buffer', () => {
    const { session } = createScenario();
    const before = hashState([...session.shops.services.values()]);
    const first = session.shops.serialize();
    const second = session.shops.serialize();
    expect(hashState([...session.shops.services.values()])).toBe(before);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(session.shops.drainCompletionEvents().length, 'events are still buffered after serialize').toBe(first.completionEvents.length);
  });

  it('copies event cells and queues instead of aliasing live objects', () => {
    const { session, drinkId } = createScenario();
    const state = session.shops.serialize();
    const live = session.shops.getService(drinkId)!;
    expect(serviceState(state, drinkId).queueGuestIds).not.toBe(live.queueGuestIds);
    state.completionEvents[0].cell.x = 999;
    serviceState(state, drinkId).queueGuestIds.push(4_242);
    expect(live.queueGuestIds).not.toContain(4_242);
    expect(session.shops.serialize().completionEvents[0].cell.x).not.toBe(999);
  });

  it('keeps Map order, not objectId order', () => {
    const { session, drinkId, toiletId, foodId, closedId } = createScenario();
    const state = session.shops.serialize();
    expect(state.services.map((entry) => entry.objectId)).toEqual([drinkId, toiletId, foodId, closedId]);
    const reversed: ShopSimulationState = { ...state, services: [...state.services].reverse() };
    const target = sessionOverRestoredWorld(session);
    target.shops.restore(reversed);
    expect([...target.shops.services.keys()], 'an unsorted consumer sees the saved order').toEqual([closedId, foodId, toiletId, drinkId]);
    expect(target.shops.serialize().services.map((entry) => entry.objectId)).toEqual([closedId, foodId, toiletId, drinkId]);
  });

  it('keeps Map order after demolish and rebuild', () => {
    const { session, drinkId } = createScenario();
    session.world.bulldoze({ x: 16, y: 28 });
    const rebuiltId = place(session, 'fizz-foundry', { x: 16, y: 28 });
    session.shops.syncWithWorld(session.guests.guests);
    const order = session.shops.serialize().services.map((entry) => entry.objectId);
    expect(order).not.toContain(drinkId);
    expect(order[order.length - 1]).toBe(rebuiltId);
    const target = sessionOverRestoredWorld(session);
    target.shops.restore(session.shops.serialize());
    expect([...target.shops.services.keys()]).toEqual(order);
  });
});

describe('ShopSimulation restore', () => {
  it('round-trips into a fresh instance with equal state and hash, also through JSON', () => {
    const { session, drinkId } = createScenario();
    const state = session.shops.serialize();
    const target = sessionOverRestoredWorld(session);
    target.shops.restore(state);
    expect(plainDeepEqual(target.shops.serialize(), state)).toBe(true);
    expect(hashState(target.shops.serialize())).toBe(hashState(state));
    const viaJson = sessionOverRestoredWorld(session);
    viaJson.shops.restore(jsonRoundTrip(state));
    expect(hashState(viaJson.shops.serialize())).toBe(hashState(state));
    expect(target.shops.getService(drinkId)).toEqual(session.shops.getService(drinkId));
  });

  it('resets a dirty instance completely, including events and the id generator', () => {
    const { session, drinkId, closedId } = createScenario();
    const state = session.shops.serialize();
    const fresh = sessionOverRestoredWorld(session);
    fresh.shops.restore(state);

    const dirty = sessionOverRestoredWorld(session);
    // The session was constructed over an empty world; sync creates the default runtimes a
    // constructor over a populated world would have made.
    dirty.shops.syncWithWorld();
    expect(dirty.shops.services.size).toBe(state.services.length);
    dirty.guests.spawnGuests(4);
    const guests = [...dirty.guests.guests.values()];
    dirty.shops.joinQueue(drinkId, guests[0]);
    dirty.shops.setOpen(closedId, true);
    dirty.shops.setPrice(drinkId, 2);
    dirty.shops.step(10_000, dirty.guests.guests);
    expect(dirty.shops.serialize().completionEvents.length, 'the dirty instance holds its own events').toBeGreaterThan(0);
    expect(hashState(dirty.shops.serialize())).not.toBe(hashState(state));
    dirty.shops.restore(state);
    expect(plainDeepEqual(dirty.shops.serialize(), fresh.shops.serialize())).toBe(true);
    expect(hashState(dirty.shops.serialize())).toBe(hashState(state));
  });

  it('restores an empty event buffer and a fresh counter when the save had none', () => {
    const { session } = createScenario();
    const state = deepCopy(session.shops.serialize());
    state.completionEvents = [];
    state.nextCompletionEventId = 1;
    const target = sessionOverRestoredWorld(session);
    target.shops.restore(state);
    expect(target.shops.drainCompletionEvents()).toEqual([]);
    expect(target.shops.serialize().nextCompletionEventId).toBe(1);
  });

  it('keeps the saved serviceTimeSeconds even when the target ruleset differs', () => {
    const { session, drinkId } = createScenario();
    const state = session.shops.serialize();
    const world = sessionOverRestoredWorld(session).world;
    const slow = new ShopSimulation(world, undefined, { serviceDurationMultiplier: 3, needReliefMultiplier: 1 });
    expect(slow.getService(drinkId)!.serviceTimeSeconds, 'the constructor default differs').not.toBe(serviceState(state, drinkId).serviceTimeSeconds);
    slow.restore(state);
    expect(slow.getService(drinkId)!.serviceTimeSeconds).toBe(serviceState(state, drinkId).serviceTimeSeconds);
  });

  it('never aliases the held state', () => {
    const { session, drinkId } = createScenario();
    const held = session.shops.serialize();
    const snapshotOfHeld = deepCopy(held);
    const target = sessionOverRestoredWorld(session);
    target.shops.restore(held);
    const first = target.shops.getService(drinkId)!;
    first.queueGuestIds.push(12_345);
    first.activeGuestId = null;
    target.shops.step(10_000, target.guests.guests);
    target.shops.drainCompletionEvents();
    expect(held, 'stepping and mutating the sim never writes through to the held state').toEqual(snapshotOfHeld);
    target.shops.restore(held);
    const second = target.shops.getService(drinkId)!;
    expect(second).not.toBe(first);
    second.queueGuestIds.push(777);
    target.shops.drainCompletionEvents();
    target.shops.restore(held);
    expect(held).toEqual(snapshotOfHeld);
    expect(hashState(target.shops.serialize())).toBe(hashState(snapshotOfHeld));
  });

  it('does not call syncWithWorld or release anybody', () => {
    const { session } = createScenario();
    const guestsBefore = hashState([...session.guests.guests.values()]);
    const target = sessionOverRestoredWorld(session);
    let syncCalls = 0;
    const original = target.shops.syncWithWorld.bind(target.shops);
    target.shops.syncWithWorld = (guests) => { syncCalls += 1; original(guests); };
    target.shops.restore(session.shops.serialize());
    expect(syncCalls).toBe(0);
    expect(hashState([...session.guests.guests.values()])).toBe(guestsBefore);
  });

  describe('refuses malformed state and leaves the simulation unchanged', () => {
    const cases: Array<[string, (state: ShopSimulationState) => void, RegExp]> = [
      ['a missing service', (state) => { state.services.pop(); }, /no runtime for world service/],
      ['a service that is not in the world', (state) => { state.services[0].objectId = 9_999; }, /not in the world/],
      ['an extra service entry', (state) => { state.services.push({ ...state.services[0], objectId: 9_998 }); }, /not in the world/],
      ['a duplicate objectId', (state) => { state.services[1].objectId = state.services[0].objectId; }, /repeats service/],
      ['a definitionId that does not match the world object', (state) => { state.services[0].definitionId = 'lemon-light'; }, /definitionId/],
      ['a kind that does not match the catalog', (state) => { state.services[0].kind = 'food'; }, /\.kind/],
      ['an unknown status', (state) => { (state.services[0] as { status: string }).status = 'exploding'; }, /status/],
      ['a NaN accumulator', (state) => { state.services[0].serviceRemainingSeconds = Number.NaN; }, /serviceRemainingSeconds/],
      ['an infinite price', (state) => { state.services[0].itemPrice = Number.POSITIVE_INFINITY; }, /itemPrice/],
      ['a negative lifetime revenue', (state) => { state.services[0].lifetimeRevenue = -5; }, /lifetimeRevenue/],
      ['a guest in two queues', (state) => {
        state.services[0].queueGuestIds = [1];
        state.services[1].queueGuestIds = [1];
      }, /already at/],
      ['a guest both queued and active', (state) => {
        state.services[0].queueGuestIds = [1];
        state.services[0].activeGuestId = 1;
      }, /already at/],
      ['a duplicated queue id', (state) => { state.services[0].queueGuestIds = [3, 3]; }, /already at/],
      ['a fractional active guest id', (state) => { state.services[0].activeGuestId = 1.5; }, /whole number/],
      ['an unknown event kind', (state) => { (state.completionEvents[0] as { kind: string }).kind = 'toilet'; }, /kind/],
      ['an event id at or above nextCompletionEventId', (state) => {
        state.completionEvents[0].id = state.nextCompletionEventId;
      }, /nextCompletionEventId/],
      ['duplicate event ids', (state) => { state.completionEvents[1].id = state.completionEvents[0].id; }, /repeats event id/],
      ['a NaN event cell', (state) => { state.completionEvents[0].cell.x = Number.NaN; }, /cell\.x/],
      ['a zero nextCompletionEventId', (state) => { state.nextCompletionEventId = 0; }, /nextCompletionEventId/],
      ['a non-boolean open flag', (state) => { (state.services[0] as unknown as { open: unknown }).open = 1; }, /boolean/],
      ['an item price of 1e9', (state) => { state.services[0].itemPrice = 1e9; }, /itemPrice/],
      ['a service time of 1e300', (state) => { state.services[0].serviceTimeSeconds = 1e300; }, /serviceTimeSeconds/],
      ['a service countdown of 1e300', (state) => { state.services[0].serviceRemainingSeconds = 1e300; }, /serviceRemainingSeconds/],
      ['a customersServed of 2^53', (state) => { state.services[0].customersServed = 2 ** 53; }, /customersServed/],
      ['an event cell off the map', (state) => { state.completionEvents[0].cell.x = -50; }, /cell\.x/],
      ['a nextCompletionEventId of 2^53', (state) => { state.nextCompletionEventId = 2 ** 53; }, /nextCompletionEventId/],
      ['a non-array services field', (state) => { (state as unknown as { services: unknown }).services = {}; }, /services/],
    ];
    for (const [name, corrupt, pattern] of cases) {
      it(`rejects ${name}`, () => {
        const { session, drinkId, foodId } = createScenario();
        // Two completed purchases so the event cases have an index 1 to corrupt.
        const guests = [...session.guests.guests.values()];
        session.shops.joinQueue(foodId, guests[8]);
        session.shops.step(10_000, session.guests.guests);
        session.shops.joinQueue(drinkId, guests[9]);
        session.shops.step(10_000, session.guests.guests);
        const good = session.shops.serialize();
        expect(good.completionEvents.length, 'fixture needs at least two events').toBeGreaterThan(1);
        const target = sessionOverRestoredWorld(session);
        target.shops.restore(good);
        const before = JSON.stringify(target.shops.serialize());
        const keysBefore = [...target.shops.services.keys()];
        const bad = deepCopy(good);
        corrupt(bad);
        const error = expectInvalidState(() => target.shops.restore(bad));
        expect(error.message).toMatch(pattern);
        expect(JSON.stringify(target.shops.serialize()), 'a refused restore changes nothing').toBe(before);
        expect([...target.shops.services.keys()]).toEqual(keysBefore);
      });
    }

    it('rejects a ride in the service list', () => {
      const { session } = createScenario();
      const rideId = place(session, 'petal-roundabout', { x: 12, y: 3 });
      const target = sessionOverRestoredWorld(session);
      const bad = deepCopy(session.shops.serialize());
      bad.services[0].objectId = rideId;
      expect(expectInvalidState(() => target.shops.restore(bad)).message).toMatch(/not a service/);
    });

    it('rejects a non-object state', () => {
      const { session } = createScenario();
      expectInvalidState(() => session.shops.restore(null as unknown as ShopSimulationState));
    });
  });
});

describe('ShopSimulation continuation', () => {
  /** Drives only the owners under test, identically for both sessions (no operations, no management). */
  const advance = (session: ParkSession, ticks: number): ServiceCompletionEvent[][] => {
    const drained: ServiceCompletionEvent[][] = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      session.world.advanceTick();
      // Phase 14: the crowd field decays at the start of every real tick (see RideSimulation.serialize.test.ts).
      session.crowd.beginTick();
      session.guests.step(STEP_MS);
      session.rides.step(STEP_MS, session.guests.guests);
      session.shops.step(STEP_MS, session.guests.guests);
      // Drained every tenth tick so buffered events and ids also cross the boundary between drains.
      drained.push(tick % 10 === 9 ? session.shops.drainCompletionEvents() : []);
    }
    return drained;
  };

  it('continues identically after restore, including drained event ids', () => {
    const { session } = createScenario();
    for (const guest of session.guests.guests.values()) {
      guest.hunger = 90;
      guest.thirst = 90;
      guest.toiletNeed = 90;
    }
    for (let tick = 0; tick < 100; tick += 1) {
      session.world.advanceTick();
      session.crowd.beginTick();
      session.guests.step(STEP_MS);
      session.shops.step(STEP_MS, session.guests.guests);
    }
    const saved = session.shops.serialize();
    const servedAtSave = saved.services.reduce((sum, entry) => sum + entry.customersServed, 0);
    const target = sessionOverRestoredWorld(session);
    target.rides.restore(session.rides.serialize());
    target.shops.restore(jsonRoundTrip(saved));
    target.guests.restore(session.guests.serialize());
    target.crowd.restore(session.crowd.serialize());

    const original = advance(session, 1_500);
    const restored = advance(target, 1_500);
    expect(restored, 'drained completion events (ids, guests, cells) per tick').toEqual(original);
    expect(original.flat().length, 'the window must complete purchases').toBeGreaterThan(0);
    expect(JSON.stringify(target.shops.serialize())).toBe(JSON.stringify(session.shops.serialize()));
    expect(hashState(target.guests.serialize())).toBe(hashState(session.guests.serialize()));
    expect(target.world.cash).toBe(session.world.cash);
    const servedAfter = session.shops.serialize().services.reduce((sum, entry) => sum + entry.customersServed, 0);
    expect(servedAfter, 'the run actually served customers').toBeGreaterThan(servedAtSave);
  });
});

describe('ShopSimulation field coverage', () => {
  /**
   * Every own property of the simulation, classified once. A new field fails the audit below until
   * it is listed here: if it influences the future it must be written by serialize() and read by
   * restore() (and added to ShopSimulationState in src/game/save/state.ts); if it is derived,
   * config or transient it is listed with the reason.
   */
  const ACCOUNTING: PropertyAccounting = {
    serialized: ['services', 'completionEvents', 'nextCompletionEventId'],
    derived: [],
    // Injected collaborators; restore targets are built over the same restored world and ruleset.
    config: ['world', 'scenery', 'rules'],
    transient: [],
  };

  it('accounts for every own property of ShopSimulation', () => {
    const { session } = createScenario();
    expect(
      auditOwnProperties(session.shops, ACCOUNTING),
      'A field was added to or removed from ShopSimulation. Serialize it (ShopSimulationState in src/game/save/state.ts, serialize() and restore()) or list it in ACCOUNTING with the reason it need not be saved.',
    ).toEqual([]);
  });

  it('serializes exactly the keys of ServiceRuntime and ServiceCompletionEvent', () => {
    const { session, drinkId } = createScenario();
    const state = session.shops.serialize();
    expect(
      Object.keys(serviceState(state, drinkId)).sort(),
      'ServiceRuntime and ServiceRuntimeState disagree: a runtime field must be serialized (or removed from the runtime).',
    ).toEqual(Object.keys(session.shops.getService(drinkId)!).sort());
    const liveEvent = (session.shops as unknown as { completionEvents: ServiceCompletionEvent[] }).completionEvents[0];
    expect(
      Object.keys(state.completionEvents[0]).sort(),
      'ServiceCompletionEvent and ServiceCompletionEventState disagree: serialize the new event field.',
    ).toEqual(Object.keys(liveEvent).sort());
  });

  const mutate = (service: ServiceRuntime, key: keyof ServiceRuntime): void => {
    const current = service[key];
    if (typeof current === 'number') (service as unknown as Record<string, unknown>)[key] = current + 1;
    else if (typeof current === 'boolean') (service as unknown as Record<string, unknown>)[key] = !current;
    else if (key === 'status') service.status = service.status === 'closed' ? 'idle' : 'closed';
    else if (key === 'kind') service.kind = service.kind === 'food' ? 'drink' : 'food';
    else if (key === 'definitionId') service.definitionId = `${service.definitionId}-x`;
    else if (key === 'activeGuestId') service.activeGuestId = (service.activeGuestId ?? 0) + 1;
    else if (Array.isArray(current)) (current as number[]).push(424_242);
    else throw new Error(`Add a mutation for ServiceRuntime.${key} to the coverage test.`);
  };

  it('changes the serialized output when ANY service field changes', () => {
    const { session, drinkId } = createScenario();
    const service = session.shops.getService(drinkId)!;
    for (const key of Object.keys(service) as Array<keyof ServiceRuntime>) {
      const before = JSON.stringify(session.shops.serialize());
      const original = deepCopy(service);
      mutate(service, key);
      expect(
        JSON.stringify(session.shops.serialize()),
        `ServiceRuntime.${key} is not reflected in serialize(): a save would silently lose it`,
      ).not.toBe(before);
      Object.assign(service, original);
    }
  });

  it('changes the serialized output when the id generator or an event field changes', () => {
    const { session } = createScenario();
    const internals = session.shops as unknown as { nextCompletionEventId: number; completionEvents: ServiceCompletionEvent[] };
    const before = JSON.stringify(session.shops.serialize());
    internals.nextCompletionEventId += 1;
    expect(JSON.stringify(session.shops.serialize())).not.toBe(before);
    internals.nextCompletionEventId -= 1;
    for (const key of Object.keys(internals.completionEvents[0]) as Array<keyof ServiceCompletionEvent>) {
      const event = internals.completionEvents[0];
      const original = deepCopy(event);
      if (key === 'cell') event.cell = { x: event.cell.x + 1, y: event.cell.y };
      else if (key === 'kind') event.kind = event.kind === 'food' ? 'drink' : 'food';
      else event[key] = event[key] + 1;
      expect(
        JSON.stringify(session.shops.serialize()),
        `ServiceCompletionEvent.${key} is not reflected in serialize()`,
      ).not.toBe(before);
      Object.assign(event, original);
    }
    expect(JSON.stringify(session.shops.serialize())).toBe(before);
  });

  it('round-trips every service field through restore', () => {
    const { session } = createScenario();
    const state = session.shops.serialize();
    const target = sessionOverRestoredWorld(session);
    target.shops.restore(state);
    for (const entry of state.services) {
      const runtime = target.shops.getService(entry.objectId)!;
      for (const key of Object.keys(entry) as Array<keyof ServiceRuntimeState>) {
        expect(runtime[key], `ServiceRuntime.${key} of service ${entry.objectId} did not survive restore`).toEqual(entry[key]);
      }
    }
  });
});
