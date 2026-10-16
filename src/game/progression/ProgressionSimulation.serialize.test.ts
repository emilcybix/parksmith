import { describe, expect, it } from 'vitest';
import { hashState } from '../save/hash';
import { assertPlainData, assertStructuredCloneSafe, auditOwnProperties } from '../save/plainData';
import type { ProgressionState } from '../save/state';
import { SaveError } from '../save/version';
import { RideSimulation } from '../rides/RideSimulation';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { ParkSession } from '../session/ParkSession';
import { ShopSimulation } from '../shops/ShopSimulation';
import { GameWorld } from '../World';
import { RESEARCH_PROJECTS } from './content';
import { ProgressionSimulation } from './ProgressionSimulation';

const createHarness = () => {
  const world = new GameWorld();
  const progression = new ProgressionSimulation(world);
  const rideObject = world.buildObject('petal-roundabout', { x: 3, y: 3 });
  const serviceObject = world.buildObject('picnic-pocket', { x: 10, y: 3 });
  const rides = new RideSimulation(world);
  const shops = new ShopSimulation(world);
  if (!rideObject || !serviceObject) throw new Error('Starter content should be buildable');
  const ride = rides.getRide(rideObject.id);
  const service = shops.getService(serviceObject.id);
  if (!ride || !service) throw new Error('Starter runtimes should exist');
  return { world, progression, rides, shops, ride, service };
};

/** A progression with milestones, a purchase and RP left over, plus an undrained event. */
const createBusy = () => {
  const harness = createHarness();
  harness.ride.satisfactionCount = 12;
  harness.service.customersServed = 9;
  harness.progression.step(100, harness.rides, harness.shops, 72.5);
  harness.progression.grantResearchPoints(40.3);
  const purchase = harness.progression.purchase('spin-studies');
  expect(purchase.ok, 'fixture purchase succeeds').toBe(true);
  return harness;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('ProgressionSimulation serialize', () => {
  it('is plain, structured-clone safe and JSON byte identical', () => {
    const { progression } = createBusy();
    const state = progression.serialize();
    assertPlainData(state);
    assertStructuredCloneSafe(state);
    expect(JSON.stringify(clone(state)), 'JSON round trip is byte identical').toBe(JSON.stringify(state));
    expect(state.pendingEvents.length, 'the purchase event is undrained').toBeGreaterThan(0);
  });

  it('is read only: serializing twice gives the same state and does not drain events', () => {
    const { progression } = createBusy();
    const first = progression.serialize();
    const second = progression.serialize();
    expect(second).toEqual(first);
    expect(progression.drainEvents().length, 'events still pending after serialize').toBe(first.pendingEvents.length);
  });

  it('writes project ids in definition order, not Set insertion order', () => {
    const { world, progression } = createHarness();
    progression.grantResearchPoints(500);
    world.postTransaction(100_000, 'cash', 'grant');
    expect(progression.purchase('express-service').ok).toBe(true);
    expect(progression.purchase('spin-studies').ok).toBe(true);
    const order = RESEARCH_PROJECTS.map((project) => project.id);
    const ids = progression.serialize().completedProjectIds;
    expect(ids, 'definition order').toEqual(order.filter((id) => ids.includes(id)));
  });

  it('round trips: hash, deep equality and JSON route all agree', () => {
    const source = createBusy();
    const state = source.progression.serialize();
    const target = createHarness();
    target.progression.restore(state);
    expect(target.progression.serialize()).toEqual(state);
    expect(hashState(target.progression.serialize())).toBe(hashState(state));
    const viaJson = createHarness();
    viaJson.progression.restore(clone(state));
    expect(hashState(viaJson.progression.serialize())).toBe(hashState(state));
  });

  it('restoring into a dirty instance equals restoring into a fresh one', () => {
    const state = createBusy().progression.serialize();
    const dirty = createHarness();
    dirty.ride.satisfactionCount = 30;
    dirty.progression.step(100, dirty.rides, dirty.shops, 99);
    dirty.progression.grantResearchPoints(77);
    dirty.progression.restore(state);
    const fresh = createHarness();
    fresh.progression.restore(state);
    expect(dirty.progression.serialize()).toEqual(fresh.progression.serialize());
    expect(dirty.progression.snapshot().completedProjectIds).toEqual(fresh.progression.snapshot().completedProjectIds);
  });

  it('restoring an empty state clears everything a dirty instance had', () => {
    const empty = createHarness().progression.serialize();
    const dirty = createBusy();
    dirty.progression.restore(empty);
    expect(dirty.progression.serialize()).toEqual(empty);
    expect(dirty.progression.isUnlocked('comet-cups'), 'research lock is back').toBe(false);
  });

  it('keeps the completion baselines so a step after restore awards nothing for old completions', () => {
    const source = createBusy();
    const state = source.progression.serialize();
    const target = createHarness();
    target.ride.satisfactionCount = 12;
    target.service.customersServed = 9;
    target.progression.restore(state);
    const before = target.progression.serialize();
    target.progression.step(100, target.rides, target.shops, 0);
    expect(target.progression.serialize().researchPoints, 'no re-award').toBe(before.researchPoints);
    expect(target.progression.serialize().completedRideExperiences).toBe(before.completedRideExperiences);

    const unsaved = createHarness();
    unsaved.ride.satisfactionCount = 12;
    unsaved.service.customersServed = 9;
    unsaved.progression.step(100, unsaved.rides, unsaved.shops, 0);
    expect(unsaved.progression.serialize().researchPoints, 'control: without baseline points are re-awarded').toBeGreaterThan(0);
  });

  it('keeps pending events across a save and continues the event id sequence', () => {
    const source = createBusy();
    const state = source.progression.serialize();
    const target = createHarness();
    target.progression.restore(state);
    const events = target.progression.drainEvents();
    expect(events, 'undrained purchase event survives').toEqual(source.progression.drainEvents());
    target.world.postTransaction(100_000, 'cash', 'grant');
    target.progression.grantResearchPoints(100);
    expect(target.progression.purchase('express-service').ok).toBe(true);
    const next = target.progression.drainEvents();
    expect(next[0]?.id, 'ids continue after nextEventId').toBe(state.nextEventId);
  });

  it('gives a later run identical results to a never-saved run', () => {
    const drive = (harness: ReturnType<typeof createHarness>): ProgressionState => {
      harness.ride.satisfactionCount += 7;
      harness.service.customersServed += 5;
      harness.progression.step(100, harness.rides, harness.shops, 88);
      harness.progression.grantResearchPoints(3.7);
      return harness.progression.serialize();
    };
    const continuous = createBusy();
    const saved = createBusy();
    const restored = createHarness();
    restored.ride.satisfactionCount = saved.ride.satisfactionCount;
    restored.service.customersServed = saved.service.customersServed;
    restored.progression.restore(saved.progression.serialize());
    expect(drive(restored)).toEqual(drive(continuous));
  });

  it('does not change the rules-locked build policy installed by ParkSession', () => {
    const definition = SCENARIO_BY_ID.get('garden-gala');
    if (!definition) throw new Error('garden-gala exists');
    const session = new ParkSession(definition);
    const locked = definition.rules.lockedDefinitionIds ?? [];
    expect(locked.length, 'scenario locks something').toBeGreaterThan(0);
    for (const id of locked) expect(session.world.isDefinitionUnlocked(id), `${id} locked before`).toBe(false);
    session.progression.restore(createBusy().progression.serialize());
    for (const id of locked) expect(session.world.isDefinitionUnlocked(id), `${id} still locked after restore`).toBe(false);
    expect(session.world.isDefinitionUnlocked('petal-roundabout'), 'unrelated id stays available').toBe(true);
    expect(session.world.isDefinitionUnlocked('comet-cups'), 'restored research unlocks comet-cups').toBe(true);
  });
});

describe('ProgressionSimulation restore validation', () => {
  const valid = (): ProgressionState => createBusy().progression.serialize();
  const rejects = (mutate: (state: ProgressionState) => void, code?: string) => {
    const target = createBusy();
    const before = target.progression.serialize();
    const state = clone(valid());
    mutate(state);
    let thrown: unknown;
    try {
      target.progression.restore(state);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'restore throws').toBeInstanceOf(SaveError);
    if (code) expect((thrown as SaveError).code).toBe(code);
    expect(target.progression.serialize(), 'state unchanged after a refused restore').toEqual(before);
  };

  it('throws content-mismatch for unknown project and milestone ids instead of dropping them', () => {
    rejects((state) => { state.completedProjectIds.push('no-such-project' as never); }, 'content-mismatch');
    rejects((state) => { state.completedMilestoneIds.push('no-such-milestone' as never); }, 'content-mismatch');
  });

  it('rejects malformed numbers, counts and ids', () => {
    rejects((state) => { state.researchPoints = -1; }, 'invalid-state');
    rejects((state) => { state.researchPoints = Number.NaN; }, 'invalid-state');
    rejects((state) => { state.highestParkRating = 101; }, 'invalid-state');
    rejects((state) => { state.completedRideExperiences = 1.5; }, 'invalid-state');
    rejects((state) => { state.nextEventId = 0; }, 'invalid-state');
    rejects((state) => { state.researchPoints = 1e300; }, 'invalid-state');
    rejects((state) => { state.nextEventId = 2 ** 53; }, 'invalid-state');
    rejects((state) => { state.completedRideExperiences = 2 ** 53; }, 'invalid-state');
    rejects((state) => { state.lastRideCompletionCounts = [[1, -3]]; }, 'invalid-state');
    rejects((state) => { state.lastRideCompletionCounts = [[1, 1], [1, 2]]; }, 'invalid-state');
    rejects((state) => { state.lastServiceCompletionCounts = [[1, 2.5]]; }, 'invalid-state');
    rejects((state) => { (state as unknown as Record<string, unknown>).lastServiceCompletionCounts = 'x'; }, 'invalid-state');
  });

  it('rejects pending events whose id is not below nextEventId or whose content is unknown', () => {
    rejects((state) => { state.nextEventId = 1; }, 'invalid-state');
    rejects((state) => {
      const event = state.pendingEvents[0];
      if (event) event.kind = 'bogus' as never;
    }, 'invalid-state');
    rejects((state) => {
      const event = state.pendingEvents.find((candidate) => candidate.kind === 'researchCompleted');
      if (event?.kind === 'researchCompleted') event.projectId = 'ghost' as never;
    }, 'content-mismatch');
  });
});

describe('ProgressionSimulation field coverage', () => {
  /**
   * HOW TO FIX A FAILURE HERE: you added a field to ProgressionSimulation. Decide whether it
   * influences the future. If so add it to ProgressionState, serialize(), restore() and the
   * `mutators` table below. If it is a cache, collaborator or constant, list it with a reason.
   */
  const accounting = {
    serialized: [
      'researchPoints', 'completedRideExperiences', 'completedServiceExperiences', 'highestParkRating',
      'completedProjectIds', 'completedMilestoneIds', 'lastRideCompletionCounts',
      'lastServiceCompletionCounts', 'pendingEvents', 'nextEventId',
    ],
    derived: [] as string[],
    // world is injected; restore must keep the build-access policy that ParkSession wired.
    // researchCostScale (Phase 16) comes from the session's ruleset, identical in a restore target.
    config: ['world', 'researchCostScale'],
    transient: [] as string[],
  };

  type Internals = Record<string, unknown> & {
    completedProjectIds: Set<string>;
    completedMilestoneIds: Set<string>;
    lastRideCompletionCounts: Map<number, number>;
    lastServiceCompletionCounts: Map<number, number>;
    pendingEvents: unknown[];
    researchPoints: number;
    completedRideExperiences: number;
    completedServiceExperiences: number;
    highestParkRating: number;
    nextEventId: number;
  };
  const mutators: Record<string, (target: Internals) => void> = {
    researchPoints: (target) => { target.researchPoints += 1; },
    completedRideExperiences: (target) => { target.completedRideExperiences += 1; },
    completedServiceExperiences: (target) => { target.completedServiceExperiences += 1; },
    highestParkRating: (target) => { target.highestParkRating += 1; },
    completedProjectIds: (target) => { target.completedProjectIds.add('guest-flow'); },
    completedMilestoneIds: (target) => { target.completedMilestoneIds.add('experiences-250'); },
    lastRideCompletionCounts: (target) => { target.lastRideCompletionCounts.set(9_999, 1); },
    lastServiceCompletionCounts: (target) => { target.lastServiceCompletionCounts.set(9_999, 1); },
    pendingEvents: (target) => { target.pendingEvents.push({ id: 99, kind: 'milestoneReached', tick: 0, milestoneId: 'x', rewardResearchPoints: 1 }); },
    nextEventId: (target) => { target.nextEventId += 1; },
  };

  it('accounts for every own property of a live instance', () => {
    expect(auditOwnProperties(createBusy().progression, accounting)).toEqual([]);
  });

  it('proves each serialized field is read by serialize() by mutating it', () => {
    expect(Object.keys(mutators).sort(), 'every serialized field has a mutator').toEqual([...accounting.serialized].sort());
    for (const name of accounting.serialized) {
      const target = createBusy();
      const before = hashState(target.progression.serialize());
      const mutate = mutators[name];
      if (!mutate) throw new Error(`no mutator for ${name}`);
      mutate(target.progression as unknown as Internals);
      expect(hashState(target.progression.serialize()), `serialize() ignores ${name}`).not.toBe(before);
    }
  });
});
