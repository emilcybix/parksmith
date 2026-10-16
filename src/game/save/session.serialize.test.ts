import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { ParkSession } from '../session/ParkSession';
import { seedDevPark } from '../session/devPark';
import { SimulationClock } from '../SimulationClock';
import { DETERMINISM_FIXTURES } from './determinismFixtures';
import { stepOnce, viaJson } from './determinismHarness';
import { hashState } from './hash';
import { assertPlainData, assertStructuredCloneSafe, findPlainDataViolation } from './plainData';
import type { ParkSaveV7 } from './state';
import { SAVE_CONTENT_VERSION, SAVE_SCHEMA_VERSION, SaveError, createParkSave, type ParkSave } from './version';
import { sessionFromSave } from '../session/fromSave';

const fixtureAt = (name: string, tick: number): ParkSession => {
  const fixture = DETERMINISM_FIXTURES.find((entry) => entry.name.startsWith(name))!;
  const session = fixture.build();
  for (let step = 0; step < tick; step += 1) {
    fixture.act(session, step);
    stepOnce(session);
  }
  fixture.act(session, tick);
  return session;
};

const expectSaveError = (action: () => unknown, code: string): SaveError => {
  try {
    action();
  } catch (error) {
    expect(error, 'a load failure must be a SaveError, never a raw exception').toBeInstanceOf(SaveError);
    expect((error as SaveError).code).toBe(code);
    return error as SaveError;
  }
  throw new Error(`expected SaveError ${code}, but nothing was thrown`);
};

describe('a full 1,000-guest save is plain data', () => {
  const dev = fixtureAt('dev park', 400);
  const state = dev.serialize();

  it('passes the plain-data walker, structured clone and JSON round trip', () => {
    expect(state.guests.guests.length).toBe(1000);
    expect(findPlainDataViolation(state)).toBeNull();
    assertPlainData(state);
    assertStructuredCloneSafe(state);
    expect(hashState(viaJson(state))).toBe(hashState(state));
  });

  it('contains no function, Container, Graphics, DOM node, Map, Set, undefined, NaN or class instance anywhere', () => {
    const problems: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === undefined) problems.push(`${path}: undefined`);
      else if (typeof value === 'function') problems.push(`${path}: function`);
      else if (typeof value === 'number' && !Number.isFinite(value)) problems.push(`${path}: non-finite`);
      else if (typeof value === 'number' && Object.is(value, -0)) problems.push(`${path}: -0`);
      else if (typeof value === 'object' && value !== null) {
        const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name;
        if (!Array.isArray(value) && name !== 'Object') problems.push(`${path}: ${String(name)}`);
        if (value instanceof Map || value instanceof Set) problems.push(`${path}: collection`);
        if (/Container|Graphics|Sprite|Texture|HTML|Element|Node/.test(String(name))) problems.push(`${path}: renderer or DOM`);
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
        if (Object.getOwnPropertySymbols(value).length > 0) problems.push(`${path}: symbol keys`);
      }
    };
    walk(state, '$');
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it('a save holding a renderer-like or non-plain value is rejected by the walker', () => {
    class Container { children: unknown[] = []; }
    for (const bad of [new Container(), new Map(), new Set(), () => 1, Number.NaN, undefined]) {
      expect(findPlainDataViolation({ ...state, injected: bad }), `${String(bad)} must be rejected`).not.toBeNull();
    }
  });
});

describe('ParkSession.serialize / fromState / fromSave', () => {
  it('serialize is pure: repeated calls return equal, unaliased data and do not move the session', () => {
    const session = fixtureAt('hand-driven', 330);
    const first = session.serialize();
    const second = session.serialize();
    expect(second).toEqual(first);
    expect(second.guests.guests[0].position).not.toBe(first.guests.guests[0].position);
    first.guests.guests[0].position.x += 99;
    first.world.paths.pop();
    expect(session.serialize(), 'mutating a returned save must not touch the live session').toEqual(second);
  });

  it('restores into a fresh session with a ready, unsubscribed world, and never steps or drains', () => {
    const source = fixtureAt('hand-driven', 800);
    const state = source.serialize();
    expect(state.progression.pendingEvents.length).toBeGreaterThan(0);
    const restored = ParkSession.fromState(viaJson(state));
    expect(restored.progression.drainEvents().length, 'pending events survive and are still there to drain').toBe(state.progression.pendingEvents.length);
    expect(restored.world.tick).toBe(state.world.tick);
  });

  it('uses the saved ruleset, not a recompile, and keeps rules-locked ids locked', () => {
    const definition = SCENARIO_BY_ID.get('garden-gala')!;
    const original = new ParkSession(definition, ['hungry-tourists', 'lean-crew']);
    const state = viaJson(original.serialize());
    state.rules.staffSalaryMultiplier = 1.234;
    const restored = ParkSession.fromState(state);
    expect(restored.rules.staffSalaryMultiplier, 'the saved rules win over a rebuild from ids').toBe(1.234);
    expect(restored.world.isDefinitionUnlocked('tidy-totem'), 'rules lock survives').toBe(false);
    expect(restored.activeCards.map((card) => card.id)).toEqual(['hungry-tourists', 'lean-crew']);
    expect(restored.scenario).not.toBeNull();
  });

  it('does not seed scenario content on top of the saved world', () => {
    const definition = SCENARIO_BY_ID.get('garden-gala')!;
    const original = new ParkSession(definition);
    const flowers = [...original.world.objects.values()].find((object) => object.definitionId === 'sunburst-flowers')!;
    original.world.bulldoze(flowers.anchor);
    original.syncWithWorld();
    const restored = ParkSession.fromState(viaJson(original.serialize()));
    expect([...restored.world.objects.values()].some((object) => object.definitionId === 'sunburst-flowers')).toBe(false);
  });

  it('restores in place into a dirty session of the same park exactly (the in-place rewind the renderer equivalence tests use)', () => {
    const fixture = DETERMINISM_FIXTURES.find((entry) => entry.name.startsWith('hand-driven'))!;
    const session = fixtureAt('hand-driven', 240);
    const saved = viaJson(session.serialize());
    for (let step = 240; step < 700; step += 1) {
      if (step > 240) fixture.act(session, step);
      stepOnce(session);
    }
    session.restoreState(saved);
    session.syncWithWorld();
    expect(hashState(session.serialize()), 'in-place restore reproduces the saved state exactly').toBe(hashState(saved));
    const twin = ParkSession.fromState(saved);
    for (let step = 240; step < 600; step += 1) {
      if (step > 240) { fixture.act(session, step); fixture.act(twin, step); }
      stepOnce(session);
      stepOnce(twin);
    }
    expect(hashState(session.serialize())).toBe(hashState(twin.serialize()));
  });

  it('refuses an in-place restore from a different scenario or ruleset', () => {
    const session = new ParkSession(SCENARIO_BY_ID.get('sunny-start')!);
    const other = new ParkSession(SCENARIO_BY_ID.get('penny-lane')!).serialize();
    expectSaveError(() => session.restoreState(other), 'invalid-state');
    const tweaked = session.serialize();
    tweaked.rules.guestBudgetMultiplier = 2;
    expectSaveError(() => session.restoreState(tweaked), 'invalid-state');
  });

  it('wraps the clock and tour node in the envelope, and speed does not touch the session state', () => {
    const session = fixtureAt('dev park', 100);
    const state = session.serialize();
    const slow = new SimulationClock(() => undefined);
    const fast = new SimulationClock(() => undefined);
    fast.setSpeed(4);
    const slowSave = createParkSave(state, { clock: slow.serialize(), tourNodeId: 'opener' }, 1_700_000_000_000);
    const fastSave = createParkSave(state, { clock: fast.serialize(), tourNodeId: null }, 1_700_000_000_000);
    expect(slowSave.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(slowSave.contentVersion).toBe(SAVE_CONTENT_VERSION);
    expect(slowSave.savedAtTick).toBe(state.world.tick);
    expect(hashState(slowSave.state), 'speed is app state, not park state').toBe(hashState(fastSave.state));
    expect(fastSave.app.clock.speed).toBe(4);
    const loaded = sessionFromSave(JSON.parse(JSON.stringify(slowSave)));
    expect(loaded.save.app.tourNodeId).toBe('opener');
    expect(hashState(loaded.session.serialize())).toBe(hashState(state));
  });
});

describe('First Day onboarding in the save', () => {
  const latched = (): ParkSession => {
    const session = new ParkSession(null);
    session.world.buildPaths([{ x: 15, y: 31 }, { x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 }, { x: 15, y: 25 }]);
    session.world.buildObject('petal-roundabout', { x: 16, y: 26 });
    session.syncWithWorld();
    for (let tick = 0; tick < 30; tick += 1) stepOnce(session);
    session.onboarding!.skipStep('first-drink');
    return session;
  };

  it('a sandbox serializes an onboarding object and a scenario park serializes null', () => {
    const sandbox = latched().serialize();
    expect(sandbox.onboarding?.completed.map((entry) => entry.id)).toEqual(['lay-path', 'first-ride']);
    expect(sandbox.onboarding?.skipped).toEqual(['first-drink']);
    expect(new ParkSession(SCENARIO_BY_ID.get('sunny-start')!).serialize().onboarding).toBeNull();
    expect(new ParkSession(SCENARIO_BY_ID.get('sunny-start')!).onboarding).toBeNull();
  });

  it('survives the full JSON round trip with an equal hash and an equal ledger, then continues identically', () => {
    const source = latched();
    const state = viaJson(source.serialize());
    const restored = ParkSession.fromState(state);
    expect(hashState(restored.serialize())).toBe(hashState(state));
    expect(restored.onboarding!.snapshot()).toEqual(source.onboarding!.snapshot());
    for (let tick = 0; tick < 300; tick += 1) { stepOnce(source); stepOnce(restored); }
    expect(hashState(restored.serialize())).toBe(hashState(source.serialize()));
  });

  it('the hash covers the onboarding state', () => {
    const state = latched().serialize();
    const tampered = viaJson(state);
    tampered.onboarding!.completed[0].tick += 1;
    expect(hashState(tampered)).not.toBe(hashState(state));
  });

  it('refuses a null onboarding in a sandbox and an onboarding object in a scenario park', () => {
    const sandbox = viaJson(new ParkSession(null).serialize());
    sandbox.onboarding = null;
    expectSaveError(() => ParkSession.fromState(sandbox), 'invalid-state');
    const scenario = viaJson(new ParkSession(SCENARIO_BY_ID.get('sunny-start')!).serialize());
    scenario.onboarding = viaJson(new ParkSession(null).serialize()).onboarding;
    expectSaveError(() => ParkSession.fromState(scenario), 'invalid-state');
  });

  it('refuses a missing onboarding key and corrupt onboarding contents with a SaveError', () => {
    const missing = viaJson(new ParkSession(null).serialize()) as unknown as Record<string, unknown>;
    delete missing.onboarding;
    expectSaveError(() => ParkSession.fromState(missing as unknown as ParkSaveV7), 'invalid-state');
    const unknown = viaJson(latched().serialize());
    unknown.onboarding!.completed[0].id = 'no-such-step' as never;
    expectSaveError(() => ParkSession.fromState(unknown), 'content-mismatch');
    const flipped = viaJson(latched().serialize());
    (flipped.onboarding as unknown as { dismissed: unknown }).dismissed = 'no';
    expectSaveError(() => ParkSession.fromState(flipped), 'invalid-state');
  });

  it('consistency: a completion stamped after the world tick is refused', () => {
    const state = viaJson(latched().serialize());
    state.onboarding!.completed[0].tick = state.world.tick + 1;
    const error = expectSaveError(() => ParkSession.fromState(state), 'invalid-state');
    expect(error.message).toMatch(/onboarding\.completed\[0\]\.tick/);
  });

  it('an in-place restore rewinds the ledger of a dirty session', () => {
    const session = latched();
    const saved = viaJson(session.serialize());
    session.onboarding!.dismissAll();
    session.restoreState(saved);
    expect(session.onboarding!.serialize()).toEqual(saved.onboarding);
  });

  it('the dev park starts with its hints dismissed', () => {
    const session = new ParkSession(null);
    seedDevPark(session);
    expect(session.onboarding!.snapshot().dismissed).toBe(true);
  });
});

describe('unreadable saves are surfaced as typed errors', () => {
  const base = (): ParkSave => createParkSave(new ParkSession(null).serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);

  it('not a save, too new, too old, corrupt', () => {
    expectSaveError(() => sessionFromSave(null), 'not-a-save');
    expectSaveError(() => sessionFromSave({ nothing: true }), 'not-a-save');
    expectSaveError(() => sessionFromSave({ ...base(), schemaVersion: SAVE_SCHEMA_VERSION + 1 }), 'too-new');
    expectSaveError(() => sessionFromSave({ ...base(), schemaVersion: 0 }), 'no-migration-path');
    expectSaveError(() => sessionFromSave({ ...base(), state: { nope: 1 } }), 'corrupt');
    expectSaveError(() => sessionFromSave({ ...base(), app: undefined }), 'corrupt');
  });

  it('unknown scenario, unknown card, scenario/state mismatch', () => {
    const state = (): ParkSaveV7 => viaJson(new ParkSession(SCENARIO_BY_ID.get('sunny-start')!, ['grand-opening']).serialize());
    const unknownScenario = state();
    (unknownScenario as { scenarioId: string }).scenarioId = 'no-such-scenario';
    expectSaveError(() => ParkSession.fromState(unknownScenario), 'content-mismatch');
    const unknownCard = state();
    (unknownCard.activeCardIds as string[]).push('no-such-card');
    expectSaveError(() => ParkSession.fromState(unknownCard), 'content-mismatch');
    const missingScenarioState = state();
    missingScenarioState.scenario = null;
    expectSaveError(() => ParkSession.fromState(missingScenarioState), 'invalid-state');
    const sandboxWithScenario = viaJson(new ParkSession(null).serialize());
    sandboxWithScenario.scenario = state().scenario;
    expectSaveError(() => ParkSession.fromState(sandboxWithScenario), 'invalid-state');
  });

  it('the cost multiplier of the rules and of the world must agree', () => {
    const state = viaJson(new ParkSession(null).serialize());
    state.world.constructionCostMultiplier = 0.5;
    expectSaveError(() => ParkSession.fromState(state), 'invalid-state');
  });
});

describe('serialize refuses a session that lags behind a world edit (the save point must verify itself)', () => {
  /** A small sandbox with every runtime kind present: ride, service, bin and scenery. */
  const parkWithEverything = (): ParkSession => {
    const session = new ParkSession(null);
    const cells = [];
    for (let y = 31; y >= 20; y -= 1) cells.push({ x: 15, y });
    session.world.buildPaths(cells);
    expect(session.world.buildObject('petal-roundabout', { x: 16, y: 26 }), 'ride placed').not.toBeNull();
    expect(session.world.buildObject('picnic-pocket', { x: 16, y: 22 }), 'service placed').not.toBeNull();
    expect(session.world.buildObject('tidy-totem', { x: 14, y: 29 }), 'bin placed').not.toBeNull();
    expect(session.world.buildObject('lollipop-lamp', { x: 14, y: 25 }), 'scenery placed').not.toBeNull();
    session.syncWithWorld();
    session.guests.spawnGuests(20);
    for (let tick = 0; tick < 50; tick += 1) stepOnce(session);
    return session;
  };
  const objectNamed = (session: ParkSession, definitionId: string) => (
    [...session.world.objects.values()].find((object) => object.definitionId === definitionId)!
  );

  const edits: Array<[string, (session: ParkSession) => void, RegExp]> = [
    ['scenery built', (session) => { expect(session.world.buildObject('lollipop-lamp', { x: 14, y: 23 }), 'placed').not.toBeNull(); }, /scenery/],
    ['a ride built', (session) => { expect(session.world.buildObject('moonpetal-carousel', { x: 16, y: 29 }), 'placed').not.toBeNull(); }, /rides|scenery/],
    ['a ride bulldozed', (session) => { session.world.bulldoze(objectNamed(session, 'petal-roundabout').anchor); }, /rides|scenery/],
    ['a service bulldozed', (session) => { session.world.bulldoze(objectNamed(session, 'picnic-pocket').anchor); }, /shops|scenery/],
    ['scenery bulldozed', (session) => { session.world.bulldoze(objectNamed(session, 'lollipop-lamp').anchor); }, /scenery/],
    ['a bin bulldozed', (session) => { session.world.bulldoze(objectNamed(session, 'tidy-totem').anchor); }, /operations|scenery/],
  ];

  it.each(edits)('throws a typed unsynced error after %s, and the save works again once synced', (_name, change, pattern) => {
    const session = parkWithEverything();
    expect(() => session.serialize(), 'a synced session serializes').not.toThrow();
    change(session);
    const error = expectSaveError(() => session.serialize(), 'unsynced');
    expect(error.message, 'names the lagging owner and the remedy').toMatch(pattern);
    expect(error.message).toMatch(/syncWithWorld/);
    session.syncWithWorld();
    const state = viaJson(session.serialize());
    expect(hashState(ParkSession.fromState(state).serialize()), 'and the save loads exactly').toBe(hashState(state));
  });

  it('a failed serialize changes nothing: the run continues exactly like one that never tried', () => {
    const attempted = parkWithEverything();
    const control = parkWithEverything();
    attempted.world.buildObject('lollipop-lamp', { x: 14, y: 23 });
    control.world.buildObject('lollipop-lamp', { x: 14, y: 23 });
    expectSaveError(() => attempted.serialize(), 'unsynced');
    attempted.syncWithWorld();
    control.syncWithWorld();
    for (let tick = 0; tick < 100; tick += 1) {
      stepOnce(attempted);
      stepOnce(control);
    }
    expect(hashState(attempted.serialize())).toBe(hashState(control.serialize()));
  });

  it('a version bump that changes nothing (park opened or closed) is not mistaken for an unsynced edit', () => {
    const session = parkWithEverything();
    session.world.setParkOpen(false);
    expect(() => session.serialize()).not.toThrow();
  });

  it('a bare path edit is accepted: no owner caches paths by version in a way a save can miss', () => {
    const session = parkWithEverything();
    session.world.bulldoze({ x: 15, y: 21 });
    const state = viaJson(session.serialize());
    expect(hashState(ParkSession.fromState(state).serialize())).toBe(hashState(state));
  });
});

describe('the management dashboard right after a load', () => {
  it('is empty until refreshManagement runs (the loader must call it), and refreshing never changes the run', () => {
    const original = fixtureAt('hand-driven', 330);
    const control = fixtureAt('hand-driven', 330);
    const loaded = ParkSession.fromState(viaJson(original.serialize()));
    expect(loaded.management.snapshot().operations.rides.total, 'latestOperations is not saved, so a bare load shows no rides').toBe(0);
    expect(original.management.snapshot().operations.rides.total, 'the live park has some').toBeGreaterThan(0);

    loaded.refreshManagement();
    expect(loaded.management.snapshot().operations.rides.total, 'one refresh restores the dashboard').toBe(original.management.snapshot().operations.rides.total);
    expect(loaded.management.snapshot().operations.averageHappiness, 'and the happiness figure').toBe(original.management.snapshot().operations.averageHappiness);

    for (let tick = 0; tick < 200; tick += 1) {
      stepOnce(loaded);
      stepOnce(control);
    }
    expect(hashState(loaded.serialize()), 'the refresh the loader performs does not change the continuation').toBe(hashState(control.serialize()));
  });
});

describe('rules in a save are range-checked', () => {
  const rejectsRule = (key: string, value: number): void => {
    const state = viaJson(new ParkSession(null).serialize());
    (state.rules as unknown as Record<string, number>)[key] = value;
    if (key === 'constructionCostMultiplier') state.world.constructionCostMultiplier = value;
    expectSaveError(() => ParkSession.fromState(state), 'invalid-state');
  };

  it.each([
    ['arrivalIntervalMultiplier', -1],
    ['arrivalIntervalMultiplier', 0],
    ['staffSalaryMultiplier', -1],
    ['rideDispatchMultiplier', 1e300],
    ['needDecayMultiplier', 0],
    ['constructionCostMultiplier', -2],
    ['startingCash', -5],
    ['startingCash', 1e300],
  ])('refuses %s = %s', (key, value) => rejectsRule(key, value));
});

describe('fromSave reports content drift without refusing', () => {
  it('says "none" for a save from this build', () => {
    const save = createParkSave(new ParkSession(null).serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
    expect(sessionFromSave(JSON.parse(JSON.stringify(save))).contentDrift).toBe('none');
  });

  it('says "newer" when the save claims a later balance generation, and still loads it', () => {
    const save = createParkSave(new ParkSession(null).serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
    const loaded = sessionFromSave({ ...JSON.parse(JSON.stringify(save)), contentVersion: SAVE_CONTENT_VERSION + 1 });
    expect(loaded.contentDrift).toBe('newer');
  });
});

describe('cross-owner consistency', () => {
  const crowded = (): ParkSaveV7 => viaJson(fixtureAt('dev park', 333).serialize());

  it('a healthy save passes at every tested tick (checked by every other test) and rejects each cross-owner break', () => {
    const cases: Array<[string, (state: ParkSaveV7) => void]> = [
      ['ride queue names a guest who does not exist', (state) => { state.rides.rides[0].queueGuestIds.push(999_999); }],
      ['a guest is in two ride queues', (state) => {
        const ride = state.rides.rides.find((entry) => entry.queueGuestIds.length > 0)!;
        const other = state.rides.rides.find((entry) => entry !== ride)!;
        other.queueGuestIds.push(ride.queueGuestIds[0]);
      }],
      ['a queueing guest is in no queue', (state) => {
        const ride = state.rides.rides.find((entry) => entry.queueGuestIds.length > 0)!;
        ride.queueGuestIds.shift();
      }],
      ['a shop queue names a missing guest', (state) => { state.shops.services[0].queueGuestIds.push(888_888); }],
      ['nextGuestId reuses an id', (state) => { state.guests.nextGuestId = 5; }],
      ['nextStaffId reuses an id', (state) => { state.operations.nextStaffId = 1; }],
      ['management has processed a transaction from the future', (state) => { state.management.lastProcessedTransactionId = state.world.nextTransactionId + 4; }],
      ['a pending progression event is newer than the generator', (state) => {
        state.progression.pendingEvents.push({ id: state.progression.nextEventId + 3, kind: 'milestoneReached', tick: 1, milestoneId: 'experiences-25', rewardResearchPoints: 1 });
      }],
    ];
    for (const [label, corrupt] of cases) {
      const state = crowded();
      corrupt(state);
      const error = expectSaveError(() => ParkSession.fromState(state), 'invalid-state');
      expect(error.message.length, label).toBeGreaterThan(10);
    }
  });

  it('removeAll() followed by an immediate save is the one tolerated dangling-id case', () => {
    const session = fixtureAt('dev park', 333);
    session.guests.removeAll();
    const restored = ParkSession.fromState(viaJson(session.serialize()));
    expect(restored.guests.guests.size).toBe(0);
  });
});

describe('every leaf of a save is validated: flipping its type is refused with a SaveError, never a raw exception', () => {
  const state = viaJson(fixtureAt('hand-driven', 330).serialize());

  const leaves = (): Array<{ path: Array<string | number>; shape: string }> => {
    const found = new Map<string, { path: Array<string | number>; shape: string }>();
    const walk = (value: unknown, path: Array<string | number>): void => {
      if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) walk(child, [...path, Array.isArray(value) ? Number(key) : key]);
        return;
      }
      const shape = path.map((part) => (typeof part === 'number' ? '[]' : `.${part}`)).join('');
      if (!found.has(shape)) found.set(shape, { path, shape });
    };
    walk(state, []);
    return [...found.values()];
  };

  it('covers over two hundred distinct fields', () => {
    expect(leaves().length).toBeGreaterThan(200);
  });

  it('refuses type flips; reports fields no owner validates', () => {
    const accepted: string[] = [];
    for (const { path, shape } of leaves()) {
      const copy = viaJson(state);
      let parent: Record<string | number, unknown> = copy as unknown as Record<string | number, unknown>;
      for (const part of path.slice(0, -1)) parent = parent[part] as Record<string | number, unknown>;
      const key = path[path.length - 1];
      const original = parent[key];
      parent[key] = typeof original === 'string' ? 12345 : typeof original === 'number' ? 'corrupt' : typeof original === 'boolean' ? 'corrupt' : { corrupt: true };
      try {
        ParkSession.fromState(copy);
        accepted.push(shape);
      } catch (error) {
        expect(error, `${shape} produced a raw exception instead of a SaveError`).toBeInstanceOf(SaveError);
      }
    }
    // Free-text and purely cosmetic fields may legitimately accept a wrong type today; anything
    // simulation-relevant being accepted is a validation gap to close in the owner.
    expect(accepted).toEqual([]);
  });

  it('refuses a missing field and a null where a value is required', () => {
    const accepted: string[] = [];
    for (const { path, shape } of leaves()) {
      const copy = viaJson(state);
      let parent: Record<string | number, unknown> = copy as unknown as Record<string | number, unknown>;
      for (const part of path.slice(0, -1)) parent = parent[part] as Record<string | number, unknown>;
      const key = path[path.length - 1];
      if (Array.isArray(parent)) continue;
      if (parent[key] === null) continue;
      delete parent[key];
      try {
        ParkSession.fromState(copy);
        accepted.push(shape);
      } catch (error) {
        expect(error, `${shape} produced a raw exception instead of a SaveError`).toBeInstanceOf(SaveError);
      }
    }
    // Phase 16 (content version 3): the two base-layer ruleset keys are optional by design. A save without them is a
    // pre-Phase-16 park (absent = affinity 0, cost scale 1), so deleting one is a legitimate older shape, not a gap.
    // Phase 30: a guest's `thoughtObjectId` is written only while a complaint names a building; absent = null.
    // Phase 40: `frontAccess` is optional the same way (absent = every side, a pre-Phase-40 park).
    expect(accepted).toEqual(['.rules.themeAffinity', '.rules.researchCostScale', '.rules.frontAccess', '.guests.guests[].thoughtObjectId']);
  });
});

describe('measurements: the 1,000-guest developer park', () => {
  it('serializes, restores and stays within loose budgets (numbers are printed for the record)', () => {
    const session = fixtureAt('dev park', 600);
    const time = <Value>(action: () => Value, runs: number): { value: Value; ms: number } => {
      let value!: Value;
      const times: number[] = [];
      for (let run = 0; run < runs; run += 1) {
        const start = performance.now();
        value = action();
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      return { value, ms: times[Math.floor(times.length / 2)] };
    };
    time(() => session.serialize(), 3);
    const serialize = time(() => session.serialize(), 15);
    const text = JSON.stringify(serialize.value);
    const stringify = time(() => JSON.stringify(serialize.value), 15);
    const parse = time(() => JSON.parse(text) as ParkSaveV7, 15);
    const restore = time(() => ParkSession.fromState(parse.value), 15);
    const step = time(() => session.step(GAME_CONFIG.fixedStepMs), 15);
    const bytes = new TextEncoder().encode(text).length;
    console.info(`MEASURE guests=${session.guests.guests.size} bytes=${bytes} serializeMs=${serialize.ms.toFixed(2)} stringifyMs=${stringify.ms.toFixed(2)} parseMs=${parse.ms.toFixed(2)} restoreMs=${restore.ms.toFixed(2)} stepMs=${step.ms.toFixed(2)}`);
    expect(bytes, 'a 1,000-guest save stays below 4 MB').toBeLessThan(4_000_000);
    expect(serialize.ms, 'serialize is a deep copy only').toBeLessThan(200);
    expect(restore.ms).toBeLessThan(500);
  });
});
