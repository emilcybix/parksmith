import { describe, expect, it } from 'vitest';
import { hashState } from '../save/hash';
import {
  assertPlainData,
  assertStructuredCloneSafe,
  auditOwnProperties,
  plainDeepEqual,
  type PropertyAccounting,
} from '../save/plainData';
import type { RideRuntimeState, RideSimulationState } from '../save/state';
import { SaveError } from '../save/version';
import { ParkSession } from '../session/ParkSession';
import { RideSimulation } from './RideSimulation';
import type { RideRuntime } from './types';

const STEP_MS = 100;

const place = (session: ParkSession, definitionId: string, anchor: { x: number; y: number }): number => {
  const object = session.world.buildObject(definitionId, anchor);
  if (!object) throw new Error(`fixture: ${definitionId} should be placeable at ${anchor.x},${anchor.y}`);
  return object.id;
};

interface Scenario {
  session: ParkSession;
  /** Running, with a queue and boarded timestamps. */
  runningId: number;
  /** In 'maintenance' (repair) with partial progress and a non-default ticket price. */
  maintenanceId: number;
  /** Closed by the player. */
  closedId: number;
}

/** Three rides in three different conditions, built through the public simulation API only. */
const createScenario = (): Scenario => {
  const session = new ParkSession();
  session.world.addMoney(100_000);
  // Research gates the catalog; the fixture needs three different rides at once.
  session.world.setBuildAccessPolicy(null);
  session.world.buildPaths([
    { x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 },
    { x: 16, y: 27 }, { x: 17, y: 27 },
  ]);
  const runningId = place(session, 'petal-roundabout', { x: 12, y: 27 });
  const maintenanceId = place(session, 'comet-cups', { x: 20, y: 20 });
  const closedId = place(session, 'cloud-hopper', { x: 8, y: 12 });
  session.rides.syncWithWorld();
  session.shops.syncWithWorld();
  session.operations.syncWithWorld();
  session.guests.spawnGuests(10);
  const guests = [...session.guests.guests.values()];
  for (const guest of guests.slice(0, 3)) session.rides.joinQueue(runningId, guest);
  session.rides.step(6_000, session.guests.guests);
  for (const guest of guests.slice(3, 5)) session.rides.joinQueue(runningId, guest);
  session.rides.step(1_000, session.guests.guests);
  session.rides.setTicketPrice(maintenanceId, 6.5);
  session.rides.forceBreakdown(maintenanceId, session.guests.guests);
  session.rides.beginMaintenance(maintenanceId, 'repair', session.guests.guests);
  session.rides.setMaintenanceProgress(maintenanceId, 0.4);
  session.rides.setOpen(closedId, false);
  session.rides.step(STEP_MS, session.guests.guests);
  return { session, runningId, maintenanceId, closedId };
};

const jsonRoundTrip = (state: RideSimulationState): RideSimulationState =>
  JSON.parse(JSON.stringify(state)) as RideSimulationState;

const deepCopy = <T>(value: T): T => structuredClone(value);

/** A new session whose world is a restored copy of `source`'s: the target a ride restore runs against. */
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

describe('RideSimulation serialize', () => {
  it('captures the scenario states the tests below rely on', () => {
    const { session, runningId, maintenanceId, closedId } = createScenario();
    const running = session.rides.getRide(runningId)!;
    expect(running.status).toBe('running');
    expect(running.cycleRemainingSeconds, 'a cycle in progress').toBeGreaterThan(0);
    expect(running.queueGuestIds.length, 'a non-empty queue').toBeGreaterThan(0);
    expect(running.riderGuestIds.length).toBeGreaterThan(0);
    expect(running.boardedAtSeconds.length).toBeGreaterThan(0);
    const maintenance = session.rides.getRide(maintenanceId)!;
    expect(maintenance.status).toBe('maintenance');
    expect(maintenance.maintenanceKind).toBe('repair');
    expect(maintenance.maintenanceProgress).toBe(0.4);
    expect(maintenance.ticketPrice).toBe(6.5);
    expect(maintenance.breakdownCount).toBe(1);
    expect(session.rides.getRide(closedId)!.status).toBe('closed');
  });

  it('is plain data that survives JSON and structured clone byte-identically', () => {
    const { session } = createScenario();
    const state = session.rides.serialize();
    assertPlainData(state);
    assertStructuredCloneSafe(state);
    expect(JSON.stringify(jsonRoundTrip(state))).toBe(JSON.stringify(state));
  });

  it('never produces -0, even from a -0 accumulator', () => {
    const { session, runningId } = createScenario();
    const ride = session.rides.getRide(runningId)!;
    ride.dispatchTimerSeconds = -0;
    ride.boardedAtSeconds.push(-0 + ride.boardedAtSeconds[ride.boardedAtSeconds.length - 1]);
    const state = session.rides.serialize();
    assertPlainData(state);
    expect(Object.is(state.rides.find((entry) => entry.objectId === runningId)!.dispatchTimerSeconds, 0)).toBe(true);
  });

  it('throws on a NaN accumulator instead of writing it', () => {
    const { session, runningId } = createScenario();
    session.rides.getRide(runningId)!.lifetimeRevenue = Number.NaN;
    expect(() => session.rides.serialize()).toThrow(/lifetimeRevenue/);
  });

  it('is read-only: serialize() leaves stale throughput timestamps in the live array', () => {
    const { session, runningId } = createScenario();
    const ride = session.rides.getRide(runningId)!;
    ride.boardedAtSeconds.unshift(-100);
    const before = hashState([...session.rides.rides.values()]);
    const live = [...ride.boardedAtSeconds];
    session.rides.serialize();
    expect(hashState([...session.rides.rides.values()]), 'live runtimes are untouched').toBe(before);
    expect(ride.boardedAtSeconds, 'serialize trims a copy, never the live array').toEqual(live);
  });

  it('emits boardedAtSeconds in the canonical trimmed form, whether or not snapshot() ran first', () => {
    const { session, runningId } = createScenario();
    const ride = session.rides.getRide(runningId)!;
    // Time can advance without a ride step; the stale entry is then still in the live array.
    ride.boardedAtSeconds.unshift(-100);
    const find = (state: RideSimulationState): RideRuntimeState => state.rides.find((entry) => entry.objectId === runningId)!;
    const viaSerialize = find(session.rides.serialize());
    session.rides.snapshot(runningId); // trims the live array as a side effect
    const viaSnapshot = find(session.rides.serialize());
    expect(viaSerialize.boardedAtSeconds).toEqual(viaSnapshot.boardedAtSeconds);
    expect(viaSerialize.boardedAtSeconds).not.toContain(-100);
    expect(viaSerialize.boardedAtSeconds.length).toBeGreaterThan(0);
  });

  it('keeps Map order, not objectId order', () => {
    const { session, runningId, maintenanceId, closedId } = createScenario();
    const state = session.rides.serialize();
    expect(state.rides.map((entry) => entry.objectId)).toEqual([runningId, maintenanceId, closedId]);
    const reversed: RideSimulationState = { ...state, rides: [...state.rides].reverse() };
    const target = sessionOverRestoredWorld(session);
    target.rides.restore(reversed);
    expect([...target.rides.rides.keys()], 'an unsorted consumer sees the saved order').toEqual([closedId, maintenanceId, runningId]);
    expect(target.rides.serialize().rides.map((entry) => entry.objectId)).toEqual([closedId, maintenanceId, runningId]);
  });

  it('keeps Map order after demolish and rebuild', () => {
    const { session, runningId, maintenanceId } = createScenario();
    session.world.bulldoze({ x: 12, y: 27 });
    const rebuiltId = place(session, 'petal-roundabout', { x: 12, y: 27 });
    session.rides.syncWithWorld(session.guests.guests);
    const state = session.rides.serialize();
    const order = state.rides.map((entry) => entry.objectId);
    expect(order).not.toContain(runningId);
    expect(order[order.length - 1]).toBe(rebuiltId);
    const target = sessionOverRestoredWorld(session);
    target.rides.restore(state);
    expect([...target.rides.rides.keys()]).toEqual(order);
    expect(order).toContain(maintenanceId);
  });
});

describe('RideSimulation restore', () => {
  it('round-trips into a fresh instance with equal state and hash, also through JSON', () => {
    const { session } = createScenario();
    const state = session.rides.serialize();
    const target = sessionOverRestoredWorld(session);
    target.rides.restore(state);
    expect(plainDeepEqual(target.rides.serialize(), state)).toBe(true);
    expect(hashState(target.rides.serialize())).toBe(hashState(state));
    const viaJson = sessionOverRestoredWorld(session);
    viaJson.rides.restore(jsonRoundTrip(state));
    expect(hashState(viaJson.rides.serialize())).toBe(hashState(state));
    expect(target.rides.getRide(state.rides[0].objectId)).toEqual(session.rides.getRide(state.rides[0].objectId));
  });

  it('resets a dirty instance completely', () => {
    const { session, runningId, maintenanceId } = createScenario();
    const state = session.rides.serialize();
    const fresh = sessionOverRestoredWorld(session);
    fresh.rides.restore(state);

    const dirty = sessionOverRestoredWorld(session);
    // The session was constructed over an empty world; sync creates the default runtimes a
    // constructor over a populated world would have made. Then make them differ and advance the clock.
    dirty.rides.syncWithWorld();
    expect(dirty.rides.rides.size).toBe(state.rides.length);
    dirty.guests.spawnGuests(3);
    dirty.rides.setTicketPrice(runningId, 9);
    dirty.rides.setOpen(maintenanceId, false);
    dirty.rides.step(30_000, dirty.guests.guests);
    dirty.rides.getRide(runningId)!.ridersToday = 999;
    expect(dirty.rides.getRide(runningId)!.ridersToday).toBe(999);
    expect(dirty.rides.serialize().elapsedSeconds).toBeGreaterThan(0);
    expect(hashState(dirty.rides.serialize())).not.toBe(hashState(state));
    dirty.rides.restore(state);
    expect(plainDeepEqual(dirty.rides.serialize(), fresh.rides.serialize())).toBe(true);
    expect(hashState(dirty.rides.serialize())).toBe(hashState(state));
  });

  it('replaces runtime objects and never aliases the held state', () => {
    const { session, runningId } = createScenario();
    const held = session.rides.serialize();
    const snapshotOfHeld = deepCopy(held);
    const target = sessionOverRestoredWorld(session);
    target.rides.restore(held);
    const first = target.rides.getRide(runningId)!;
    first.queueGuestIds.push(12345);
    first.boardedAtSeconds.push(1e6);
    first.riderGuestIds.length = 0;
    target.rides.step(10_000, target.guests.guests);
    expect(held, 'stepping and mutating the sim never writes through to the held state').toEqual(snapshotOfHeld);
    target.rides.restore(held);
    const second = target.rides.getRide(runningId)!;
    expect(second).not.toBe(first);
    expect(second.queueGuestIds).not.toBe(held.rides[0].queueGuestIds);
    second.queueGuestIds.push(777);
    target.rides.restore(held);
    expect(held).toEqual(snapshotOfHeld);
    expect(hashState(target.rides.serialize())).toBe(hashState(snapshotOfHeld));
  });

  it('keeps ridersToday as a lifetime counter and the breakdown hash inputs exactly', () => {
    const { session, runningId, maintenanceId } = createScenario();
    const source = session.rides.getRide(runningId)!;
    source.ridersToday = 41;
    source.completedCycles = 17;
    source.breakdownCount = 3;
    const target = sessionOverRestoredWorld(session);
    target.rides.restore(session.rides.serialize());
    const restored = target.rides.getRide(runningId)!;
    expect([restored.ridersToday, restored.completedCycles, restored.breakdownCount]).toEqual([41, 17, 3]);
    expect(restored.objectId).toBe(runningId);
    expect(target.rides.getRide(maintenanceId)!.maintenanceKind).toBe('repair');
  });

  it('does not call syncWithWorld or release anybody', () => {
    const { session } = createScenario();
    const guestsBefore = hashState([...session.guests.guests.values()]);
    const target = sessionOverRestoredWorld(session);
    let syncCalls = 0;
    const original = target.rides.syncWithWorld.bind(target.rides);
    target.rides.syncWithWorld = (guests) => { syncCalls += 1; original(guests); };
    target.rides.restore(session.rides.serialize());
    expect(syncCalls).toBe(0);
    expect(hashState([...session.guests.guests.values()])).toBe(guestsBefore);
  });

  describe('refuses malformed state and leaves the simulation unchanged', () => {
    const cases: Array<[string, (state: RideSimulationState) => void, RegExp]> = [
      ['a missing ride', (state) => { state.rides.pop(); }, /no runtime for world ride/],
      ['an extra object id that is not in the world', (state) => { state.rides[0].objectId = 9_999; }, /not in the world/],
      ['an extra ride entry', (state) => { state.rides.push({ ...state.rides[0], objectId: 9_998 }); }, /not in the world/],
      ['a duplicate objectId', (state) => { state.rides[1].objectId = state.rides[0].objectId; }, /repeats ride/],
      ['a NaN accumulator', (state) => { state.rides[0].dispatchTimerSeconds = Number.NaN; }, /dispatchTimerSeconds/],
      ['an infinite accumulator', (state) => { state.rides[0].lifetimeRevenue = Number.POSITIVE_INFINITY; }, /lifetimeRevenue/],
      ['an unknown status', (state) => { (state.rides[0] as { status: string }).status = 'exploding'; }, /status/],
      ['an unknown maintenance kind', (state) => { (state.rides[1] as { maintenanceKind: string | null }).maintenanceKind = 'polish'; }, /maintenanceKind/],
      ['maintenance status without a kind', (state) => { state.rides[1].maintenanceKind = null; }, /disagrees with status/],
      ['a maintenance kind without the status', (state) => { state.rides[0].maintenanceKind = 'repair'; }, /disagrees with status/],
      ['descending boardedAtSeconds', (state) => { state.rides[0].boardedAtSeconds = [3, 2]; }, /ascending/],
      ['condition above 100', (state) => { state.rides[0].condition = 101; }, /condition/],
      ['negative condition', (state) => { state.rides[0].condition = -1; }, /condition/],
      ['maintenanceProgress above 1', (state) => { state.rides[1].maintenanceProgress = 1.5; }, /maintenanceProgress/],
      ['a duplicated queue id', (state) => { state.rides[0].queueGuestIds = [4, 4]; }, /repeats guest id/],
      ['a guest both queued and riding', (state) => {
        state.rides[0].queueGuestIds = [1];
        state.rides[0].riderGuestIds = [1];
      }, /also in the queue/],
      ['a fractional breakdown count', (state) => { state.rides[0].breakdownCount = 1.5; }, /whole number/],
      ['a non-boolean open flag', (state) => { (state.rides[0] as unknown as { open: unknown }).open = 'yes'; }, /boolean/],
      ['a non-array rides field', (state) => { (state as unknown as { rides: unknown }).rides = {}; }, /rides/],
      ['an elapsedSeconds of 1e300', (state) => { state.elapsedSeconds = 1e300; }, /elapsedSeconds/],
      ['a cycleRemainingSeconds of 1e300 (a ride stuck for ever)', (state) => { state.rides[0].cycleRemainingSeconds = 1e300; }, /cycleRemainingSeconds/],
      ['a dispatch timer of 1e300', (state) => { state.rides[0].dispatchTimerSeconds = 1e300; }, /dispatchTimerSeconds/],
      ['a ticket price of 1e9', (state) => { state.rides[0].ticketPrice = 1e9; }, /ticketPrice/],
      ['a completedCycles of 2^53', (state) => { state.rides[0].completedCycles = 2 ** 53; }, /completedCycles/],
      ['a boarding timestamp of 1e300', (state) => { state.rides[0].boardedAtSeconds = [1e300]; }, /boardedAtSeconds/],
      ['a negative elapsedSeconds', (state) => { state.elapsedSeconds = -1; }, /elapsedSeconds/],
    ];
    for (const [name, corrupt, pattern] of cases) {
      it(`rejects ${name}`, () => {
        const { session } = createScenario();
        const target = sessionOverRestoredWorld(session);
        target.rides.restore(session.rides.serialize());
        target.rides.step(5_000, target.guests.guests);
        const before = JSON.stringify(target.rides.serialize());
        const keysBefore = [...target.rides.rides.keys()];
        const bad = deepCopy(session.rides.serialize());
        corrupt(bad);
        const error = expectInvalidState(() => target.rides.restore(bad));
        expect(error.message).toMatch(pattern);
        expect(JSON.stringify(target.rides.serialize()), 'a refused restore changes nothing').toBe(before);
        expect([...target.rides.rides.keys()]).toEqual(keysBefore);
      });
    }

    it('rejects an object of the wrong kind (a shop id in the ride list)', () => {
      const { session } = createScenario();
      const shopId = place(session, 'fizz-foundry', { x: 16, y: 28 });
      session.rides.syncWithWorld(session.guests.guests);
      const target = sessionOverRestoredWorld(session);
      const bad = deepCopy(session.rides.serialize());
      bad.rides[0].objectId = shopId;
      expect(expectInvalidState(() => target.rides.restore(bad)).message).toMatch(/not a ride/);
    });

    it('rejects a non-object state', () => {
      const { session } = createScenario();
      expectInvalidState(() => session.rides.restore(null as unknown as RideSimulationState));
    });
  });
});

describe('RideSimulation continuation', () => {
  /** Drives only the owners under test, identically for both sessions (no operations, no management). */
  const advance = (session: ParkSession, ticks: number): Array<Array<[number, number, boolean, boolean]>> => {
    const timeline: Array<Array<[number, number, boolean, boolean]>> = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      session.world.advanceTick();
      // Phase 14: the crowd field decays at the start of every real tick; without it the walkers' entries pile up
      // until the slow-down acts, which no real park does.
      session.crowd.beginTick();
      session.guests.step(STEP_MS);
      session.rides.step(STEP_MS, session.guests.guests);
      session.shops.step(STEP_MS, session.guests.guests);
      session.shops.drainCompletionEvents();
      timeline.push([...session.rides.rides.values()]
        .sort((left, right) => left.objectId - right.objectId)
        .map((ride) => [ride.objectId, ride.breakdownCount, ride.broken, ride.pendingBreakdown] as [number, number, boolean, boolean]));
    }
    return timeline;
  };

  it('continues identically after restore, including the breakdown timeline', () => {
    const { session, runningId } = createScenario();
    // Wear the running ride down so a breakdown roll happens inside the window.
    session.rides.getRide(runningId)!.condition = 21;
    for (let tick = 0; tick < 200; tick += 1) {
      session.world.advanceTick();
      session.crowd.beginTick();
      session.guests.step(STEP_MS);
      session.rides.step(STEP_MS, session.guests.guests);
    }
    const savedRides = session.rides.serialize();
    const target = sessionOverRestoredWorld(session);
    // The crowd field is part of a park's state (Phase 14); the walkers' speed reads it.
    target.crowd.restore(session.crowd.serialize());
    target.rides.restore(jsonRoundTrip(savedRides));
    target.shops.restore(session.shops.serialize());
    target.guests.restore(session.guests.serialize());

    const original = advance(session, 1_500);
    const restored = advance(target, 1_500);
    expect(restored, 'breakdown timeline (objectId, breakdownCount, broken, pendingBreakdown)').toEqual(original);
    expect(session.rides.getRide(runningId)!.completedCycles, 'the window must contain ride cycles').toBeGreaterThan(
      savedRides.rides.find((entry) => entry.objectId === runningId)!.completedCycles,
    );
    expect(JSON.stringify(target.rides.serialize())).toBe(JSON.stringify(session.rides.serialize()));
    expect(hashState(target.guests.serialize())).toBe(hashState(session.guests.serialize()));
    expect(target.world.cash).toBe(session.world.cash);
    expect(hashState(session.rides.serialize()), 'the run actually changed the state').not.toBe(hashState(savedRides));
    expect(original.some((tick) => tick.some(([, count]) => count > 0)), 'at least one breakdown happened').toBe(true);
  });
});

describe('RideSimulation pendingBreakdown', () => {
  it('keeps a breakdown that was flagged while the ride runs, and delivers it after restore like the original', () => {
    const { session, runningId } = createScenario();
    const ride = session.rides.getRide(runningId)!;
    expect(ride.status, 'the ride is running, so a forced breakdown can only be flagged').toBe('running');
    expect(session.rides.forceBreakdown(runningId, session.guests.guests), 'the breakdown was accepted').toBe(true);
    expect(ride.pendingBreakdown, 'flagged, not yet broken').toBe(true);
    expect(ride.broken).toBe(false);

    const saved = session.rides.serialize();
    expect(saved.rides.find((entry) => entry.objectId === runningId)!.pendingBreakdown, 'written to the save').toBe(true);
    const target = sessionOverRestoredWorld(session);
    target.rides.restore(jsonRoundTrip(saved));
    target.shops.restore(session.shops.serialize());
    target.guests.restore(session.guests.serialize());
    expect(target.rides.getRide(runningId)!.pendingBreakdown, 'restored as set, not reset to false').toBe(true);

    // Dropping the flag changes WHEN the ride breaks: run both until the original breaks.
    for (const current of [session, target]) {
      for (let tick = 0; tick < 1_500; tick += 1) {
        current.world.advanceTick();
        current.guests.step(STEP_MS);
        current.rides.step(STEP_MS, current.guests.guests);
        current.shops.step(STEP_MS, current.guests.guests);
        current.shops.drainCompletionEvents();
      }
    }
    expect(session.rides.getRide(runningId)!.breakdownCount, 'the original ride did break').toBeGreaterThan(0);
    expect(JSON.stringify(target.rides.serialize()), 'the restored ride followed the same history').toBe(JSON.stringify(session.rides.serialize()));
  });
});

describe('RideSimulation field coverage', () => {
  /**
   * Every own property of the simulation, classified once. A new field fails the audit below until
   * it is listed here: if it influences the future it must be written by serialize() and read by
   * restore() (and added to RideSimulationState in src/game/save/state.ts); if it is derived,
   * config or transient it is listed with the reason.
   */
  const ACCOUNTING: PropertyAccounting = {
    serialized: ['rides', 'elapsedSeconds'],
    derived: [],
    // Injected collaborators; restore targets are built over the same restored world and ruleset.
    config: ['world', 'scenery', 'rules', 'conditions'],
    transient: [],
  };

  it('accounts for every own property of RideSimulation', () => {
    const { session } = createScenario();
    expect(
      auditOwnProperties(session.rides, ACCOUNTING),
      'A field was added to or removed from RideSimulation. Serialize it (RideSimulationState in src/game/save/state.ts, serialize() and restore()) or list it in ACCOUNTING with the reason it need not be saved.',
    ).toEqual([]);
  });

  it('serializes exactly the keys of RideRuntime and RideRuntimeState (no runtime field is forgotten)', () => {
    const { session, runningId } = createScenario();
    const runtimeKeys = Object.keys(session.rides.getRide(runningId)!).sort();
    const serialized = session.rides.serialize().rides[0];
    expect(
      Object.keys(serialized).sort(),
      'RideRuntime and RideRuntimeState disagree: a runtime field must be serialized (or removed from the runtime).',
    ).toEqual(runtimeKeys);
  });

  /** Changes one runtime field to a different valid-looking value. */
  const mutate = (ride: RideRuntime, key: keyof RideRuntime, elapsedSeconds: number): void => {
    const current = ride[key];
    if (typeof current === 'number') (ride as unknown as Record<string, unknown>)[key] = current + 1;
    else if (typeof current === 'boolean') (ride as unknown as Record<string, unknown>)[key] = !current;
    else if (key === 'status') ride.status = ride.status === 'closed' ? 'idle' : 'closed';
    else if (key === 'maintenanceKind') ride.maintenanceKind = ride.maintenanceKind === 'repair' ? 'inspection' : 'repair';
    else if (key === 'boardedAtSeconds') ride.boardedAtSeconds.push(elapsedSeconds + 1);
    else if (Array.isArray(current)) (current as number[]).push(424_242);
    else throw new Error(`Add a mutation for RideRuntime.${key} to the coverage test.`);
  };

  it('changes the serialized output when ANY runtime field changes', () => {
    const { session, runningId } = createScenario();
    const ride = session.rides.getRide(runningId)!;
    for (const key of Object.keys(ride) as Array<keyof RideRuntime>) {
      const before = JSON.stringify(session.rides.serialize());
      const original = deepCopy(ride);
      mutate(ride, key, session.rides.serialize().elapsedSeconds);
      expect(
        JSON.stringify(session.rides.serialize()),
        `RideRuntime.${key} is not reflected in serialize(): a save would silently lose it`,
      ).not.toBe(before);
      Object.assign(ride, original);
    }
  });

  it('round-trips every runtime field through restore', () => {
    const { session } = createScenario();
    const state = session.rides.serialize();
    const target = sessionOverRestoredWorld(session);
    target.rides.restore(state);
    for (const entry of state.rides) {
      const runtime = target.rides.getRide(entry.objectId)!;
      for (const key of Object.keys(entry) as Array<keyof RideRuntimeState>) {
        expect(runtime[key], `RideRuntime.${key} of ride ${entry.objectId} did not survive restore`).toEqual(entry[key]);
      }
    }
  });
});

describe('RideSimulation constructed standalone', () => {
  it('restores into a bare simulation over a restored world and keeps config references', () => {
    const { session } = createScenario();
    const world = sessionOverRestoredWorld(session).world;
    const bare = new RideSimulation(world);
    bare.restore(session.rides.serialize());
    expect(hashState(bare.serialize())).toBe(hashState(session.rides.serialize()));
  });
});
