import { describe, expect, it } from 'vitest';
import type { Guest } from '../guests/types';
import { GAME_CONFIG } from '../config';
import { RideSimulation } from '../rides/RideSimulation';
import { hashState } from '../save/hash';
import { assertPlainData, assertStructuredCloneSafe, auditOwnProperties } from '../save/plainData';
import type { ManagementState } from '../save/state';
import { SaveError } from '../save/version';
import { ShopSimulation } from '../shops/ShopSimulation';
import { GameWorld } from '../World';
import { ManagementSimulation } from './ManagementSimulation';

const STEP_MS = 700;

const createGuest = (id: number, overrides: Partial<Guest> = {}): Guest => ({
  id,
  position: { x: 15, y: 31 },
  currentCell: { x: 15, y: 31 },
  route: [{ x: 15, y: 31 }],
  routeIndex: 1,
  routeVersion: 0,
  state: 'wandering',
  destinationObjectId: null,
  money: 50,
  happiness: 70,
  hunger: 20,
  thirst: 20,
  toiletNeed: 20,
  energy: 80,
  preferredIntensity: 30,
  currentThought: '',
  thoughtObjectId: null,
  patienceSeconds: 60,
  lastQueueWaitSeconds: 0,
  lastRideSatisfaction: null,
  lastPurchaseSatisfaction: null,
  servicePriceLimit: null,
  recentRideIds: [],
  recentServiceIds: [],
  ageSeconds: 0,
  maximumVisitSeconds: 120,
  stateTimerSeconds: 0,
  needTimerSeconds: 0,
  color: 0xffffff,
  accent: 0xffffff,
  nausea: 0,
  warmth: 50,
  souvenirs: 0,
  activity: null,
  ...overrides,
});

/** Deterministic guest population that drifts with the step index so ratings and needs move. */
const guestsAt = (index: number): Map<number, Guest> => new Map([1, 2, 3, 4].map((id) => [
  id,
  createGuest(id, {
    happiness: 30 + ((index * 7 + id * 13) % 60),
    hunger: Math.min(100, 10 + index * 3 + id * 5),
    thirst: Math.min(100, 5 + index * 2 + id * 4),
    state: id === 1 ? 'queueing' : 'wandering',
    stateTimerSeconds: index,
    currentThought: id === 2 && index % 2 === 0 ? "I'm not paying that much." : '',
    thoughtObjectId: null,
  }),
]));

const buildWorld = (): GameWorld => {
  const world = new GameWorld();
  world.buildPaths([
    { x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 },
  ]);
  if (!world.buildObject('petal-roundabout', { x: 12, y: 27 }) || !world.buildObject('picnic-pocket', { x: 16, y: 28 })) {
    throw new Error('Test content should be placeable');
  }
  return world;
};

/** The world-side script: awkward floats on purpose (raw sums must not be rounded), a cash drain and a recovery. */
const act = (world: GameWorld, index: number): void => {
  if (index % 3 === 0) world.postTransaction(0.1 * index + 0.0713, 'Ride income', 'ride-revenue');
  if (index % 4 === 1) world.postTransaction(-(3.1337 + index * 0.0111), 'Cleaner wage', 'staff-salaries');
  if (index === 2) world.postTransaction(-0.001, 'Tiny fee', 'maintenance');
  if (index === 6) world.postTransaction(-(world.cash - GAME_CONFIG.startingCash * 0.05), 'Big spend', 'construction');
  if (index === 16) world.postTransaction(GAME_CONFIG.startingCash * 0.5, 'Grant', 'grant');
};

interface Park {
  world: GameWorld;
  rides: RideSimulation;
  shops: ShopSimulation;
  management: ManagementSimulation;
}

const createPark = (replayedSteps = 0): Park => {
  const world = buildWorld();
  for (let index = 0; index < replayedSteps; index += 1) act(world, index);
  return { world, rides: new RideSimulation(world), shops: new ShopSimulation(world), management: new ManagementSimulation(world) };
};

const stepPark = (park: Park, index: number): void => {
  act(park.world, index);
  park.management.step(STEP_MS, guestsAt(index), park.rides, park.shops);
};

const runPark = (steps: number): Park => {
  const park = createPark();
  for (let index = 0; index < steps; index += 1) stepPark(park, index);
  return park;
};

/** A fresh park whose WORLD matches `runPark(steps)` but whose management was never stepped. */
const restoredPark = (state: ManagementState, steps: number): Park => {
  const park = createPark(steps);
  park.management.restore(state);
  return park;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const containsNegativeZero = (value: unknown): boolean => {
  if (typeof value === 'number') return Object.is(value, -0);
  if (Array.isArray(value)) return value.some(containsNegativeZero);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(containsNegativeZero);
  return false;
};

describe('ManagementSimulation serialize', () => {
  it('is plain, structured-clone safe, JSON byte identical and free of -0', () => {
    const park = runPark(25);
    // round() yields -0 for tiny negatives; plant one in every place it can reach to prove normalisation.
    const live = park.management as unknown as {
      trendPoints: Array<{ profit: number }>;
      latestRating: { score: number; factors: Array<{ contribution: number }> };
      categoryTotals: { other: { profit: number } };
    };
    const point = live.trendPoints[0];
    const factor = live.latestRating.factors[0];
    if (!point || !factor) throw new Error('fixture has trend points and factors');
    point.profit = -0;
    factor.contribution = -0;
    live.categoryTotals.other.profit = -0;
    expect(containsNegativeZero(live), 'premise: live instance holds -0').toBe(true);
    const state = park.management.serialize();
    assertPlainData(state);
    assertStructuredCloneSafe(state);
    expect(containsNegativeZero(state), 'no -0 in the saved state').toBe(false);
    expect(JSON.stringify(clone(state))).toBe(JSON.stringify(state));
  });

  it('is read only: it neither collects transactions nor drains notifications', () => {
    const park = runPark(10);
    park.world.postTransaction(25, 'Late income', 'ride-revenue');
    const before = park.management.serialize();
    const again = park.management.serialize();
    expect(again).toEqual(before);
    expect(before.lastProcessedTransactionId, 'late transaction still uncollected').toBeLessThan(
      Math.max(...park.world.transactions.map((transaction) => transaction.id)),
    );
    expect(before.pendingNotifications.length, 'notifications stay pending').toBeGreaterThan(0);
  });

  it('round trips with equal hash, via JSON as well', () => {
    const source = runPark(25);
    const state = source.management.serialize();
    const target = restoredPark(state, 25);
    expect(target.management.serialize()).toEqual(state);
    expect(hashState(target.management.serialize())).toBe(hashState(state));
    const viaJson = restoredPark(clone(state), 25);
    expect(hashState(viaJson.management.serialize())).toBe(hashState(state));
  });

  it('restores into a dirty instance exactly as into a fresh one', () => {
    const state = runPark(25).management.serialize();
    const dirty = runPark(40);
    dirty.management.restore(state);
    const fresh = restoredPark(state, 25);
    expect(dirty.management.serialize()).toEqual(fresh.management.serialize());
  });

  it('restoring the initial state wipes a dirty instance back to constructor defaults', () => {
    const initial = createPark().management.serialize();
    const dirty = runPark(25);
    dirty.management.restore(initial);
    expect(dirty.management.serialize()).toEqual(initial);
  });

  it('saves before the first step: milestones uninitialised and trends empty', () => {
    const source = createPark();
    const state = source.management.serialize();
    expect(state.ratingMilestonesInitialized).toBe(false);
    expect(state.trendPoints).toEqual([]);
    const target = restoredPark(clone(state), 0);
    expect(target.management.serialize()).toEqual(state);
    for (let index = 0; index < 12; index += 1) {
      stepPark(source, index);
      stepPark(target, index);
    }
    expect(target.management.serialize()).toEqual(source.management.serialize());
  });

  it('continues identically to a never-saved run, with snapshot() taken at identical moments', () => {
    const continuous = runPark(18);
    const state = continuous.management.serialize();
    const restored = restoredPark(state, 18);
    for (let index = 18; index < 60; index += 1) {
      stepPark(continuous, index);
      stepPark(restored, index);
      if (index % 5 === 0) {
        expect(restored.management.snapshot(), `snapshot at step ${index}`).toEqual(continuous.management.snapshot());
      }
      if (index === 40) {
        expect(restored.management.consumeNotifications()).toEqual(continuous.management.consumeNotifications());
      }
    }
    expect(restored.management.serialize()).toEqual(continuous.management.serialize());
  });

  it('keeps an uncollected research purchase behind the world cursor and collects it exactly once later', () => {
    const source = runPark(10);
    source.world.postTransaction(-120, 'Spin Studies research', 'research');
    const state = source.management.serialize();
    const target = createPark(10);
    target.world.postTransaction(-120, 'Spin Studies research', 'research');
    target.management.restore(state);
    expect(target.management.serialize().lastProcessedTransactionId).toBe(state.lastProcessedTransactionId);
    stepPark(source, 10);
    stepPark(target, 10);
    expect(target.management.serialize()).toEqual(source.management.serialize());
    expect(target.management.serialize().categoryTotals.research.expenses, 'counted once').toBe(120);
  });

  it('saves mid cooldown with hysteresis severity active and does not re-fire on restore', () => {
    const source = runPark(20);
    const state = source.management.serialize();
    expect(state.lastNotificationAt.length, 'cooldown timestamps exist').toBeGreaterThan(0);
    expect(state.activeNotificationSeverities.length, 'a severity is active').toBeGreaterThan(0);
    const target = restoredPark(state, 20);
    expect(target.management.serialize().lastNotificationAt).toEqual(state.lastNotificationAt);
    expect(target.management.serialize().activeNotificationSeverities).toEqual(state.activeNotificationSeverities);
    expect(target.management.serialize().pendingNotifications, 'restore itself fires nothing').toEqual(state.pendingNotifications);
    expect(target.management.serialize().trendPoints, 'restore itself pushes no trend point').toEqual(state.trendPoints);
  });

  it('saves raw unrounded totals, not the rounded snapshot', () => {
    const source = runPark(25);
    const state = source.management.serialize();
    const raw = state.categoryTotals.rideTickets.revenue;
    expect(raw, 'fixture has sub-cent precision').not.toBe(Math.round(raw * 100) / 100);
    expect(source.management.snapshot().finances.categories.rideTickets.revenue).toBe(Math.round(raw * 100) / 100);
    const target = restoredPark(clone(state), 25);
    expect(target.management.serialize().categoryTotals.rideTickets.revenue, 'precision survives').toBe(raw);
  });

  it('records no phantom other cash flow when world cash equals lastObservedCash', () => {
    const source = runPark(25);
    const state = source.management.serialize();
    expect(state.lastObservedCash).toBe(source.world.cash);
    const target = restoredPark(state, 25);
    const before = target.management.serialize().categoryTotals.other;
    target.management.snapshot();
    expect(target.management.serialize().categoryTotals.other).toEqual(before);
    expect(target.management.serialize().totals).toEqual(state.totals);
  });

  it('preserves a devPark-style baseline where lastObservedCash differs from world cash', () => {
    const source = runPark(12);
    source.world.cash += 5_000;
    const state = source.management.serialize();
    expect(state.lastObservedCash).not.toBe(source.world.cash);
    const target = createPark(12);
    target.world.cash = source.world.cash;
    target.management.restore(state);
    expect(target.management.serialize().lastObservedCash).toBe(state.lastObservedCash);
    stepPark(source, 12);
    stepPark(target, 12);
    expect(target.management.serialize()).toEqual(source.management.serialize());
    expect(target.management.serialize().categoryTotals.other.profit, 'the jump lands in other').toBeGreaterThan(4_999);
  });

  it('documents that latest operations sections are empty between restore and the next step', () => {
    const source = runPark(25);
    const target = restoredPark(source.management.serialize(), 25);
    const snapshot = target.management.snapshot();
    expect(snapshot.operations.rides.total).toBe(0);
    expect(snapshot.parkOperations.litter).toEqual([]);
    expect(snapshot.parkScenery.sourceCount).toBe(0);
    stepPark(target, 25);
    expect(target.management.snapshot().operations.rides.total, 'next step refills them').toBe(1);
  });
});

describe('ManagementSimulation restore validation', () => {
  const rejects = (mutate: (state: ManagementState) => void) => {
    const target = runPark(20);
    const before = target.management.serialize();
    const state = clone(before);
    mutate(state);
    let thrown: unknown;
    try {
      target.management.restore(state);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'restore throws').toBeInstanceOf(SaveError);
    expect((thrown as SaveError).code).toBe('invalid-state');
    expect(target.management.serialize(), 'unchanged after refusal').toEqual(before);
  };

  it('rejects malformed scalars and totals', () => {
    rejects((state) => { state.elapsedSeconds = -1; });
    rejects((state) => { state.lastObservedCash = Number.NaN; });
    rejects((state) => { state.lastProcessedTransactionId = 1.5; });
    rejects((state) => { state.latestGuestCount = -2; });
    rejects((state) => { state.totals.revenue = Number.POSITIVE_INFINITY; });
    rejects((state) => { state.ratingMilestonesInitialized = 'yes' as never; });
    // Implausible magnitudes: finite, but far outside anything a park can reach.
    rejects((state) => { state.elapsedSeconds = 1e300; });
    rejects((state) => { state.trendAccumulatorSeconds = 1e300; });
    rejects((state) => { state.lastObservedCash = 1e300; });
    rejects((state) => { state.totals.revenue = -1e300; });
    rejects((state) => { state.lastProcessedTransactionId = 2 ** 53; });
    rejects((state) => { state.nextNotificationId = 2 ** 53; });
    rejects((state) => { state.latestRating.score = 1e9; });
    rejects((state) => { state.latestRating.score = -1; });
  });

  it('rejects category tables without exactly the 12 keys', () => {
    rejects((state) => { delete (state.categoryTotals as Partial<ManagementState['categoryTotals']>).other; });
    rejects((state) => { (state.categoryTotals as Record<string, unknown>).bogus = state.categoryTotals.other; });
    rejects((state) => { state.categoryTotals.grants.profit = Number.NaN; });
  });

  it('rejects unknown kinds and severities, bad ids and oversize collections', () => {
    rejects((state) => { state.lastNotificationAt = [['mystery' as never, 1]]; });
    rejects((state) => { state.activeNotificationSeverities = [['cashLow', 'dire' as never]]; });
    rejects((state) => { state.lastNotificationAt = [['cashLow', 1], ['cashLow', 2]]; });
    rejects((state) => {
      const notification = state.pendingNotifications[0];
      if (notification) notification.id = state.nextNotificationId;
    });
    rejects((state) => {
      const notification = state.pendingNotifications[0];
      if (notification) notification.kind = 'nope' as never;
    });
    rejects((state) => { state.nextNotificationId = 0; });
    rejects((state) => {
      const point = state.trendPoints[0];
      if (!point) throw new Error('fixture has trend points');
      state.trendPoints = Array.from({ length: 121 }, () => ({ ...point }));
    });
    rejects((state) => {
      const notification = state.pendingNotifications[0];
      if (!notification) throw new Error('fixture has notifications');
      state.nextNotificationId = 100;
      state.pendingNotifications = Array.from({ length: 21 }, (_, index) => ({ ...notification, id: index + 1 }));
    });
    rejects((state) => { state.emittedRatingMilestones = [50, 60]; });
    rejects((state) => { state.latestRating.factors = [{ key: 'luck' as never, label: '', score: 1, weight: 1, contribution: 1, detail: '' }]; });
    rejects((state) => {
      const point = state.trendPoints[0];
      if (point) point.cash = Number.NaN;
    });
  });
});

describe('ManagementSimulation field coverage', () => {
  /**
   * HOW TO FIX A FAILURE HERE: you added a field to ManagementSimulation. If it influences the
   * future, add it to ManagementState, serialize(), restore() and the `mutators` table; if it is
   * a cache, a collaborator or a view refilled by step(), list it below with the reason.
   */
  const accounting = {
    serialized: [
      'elapsedSeconds', 'trendAccumulatorSeconds', 'lastObservedCash', 'lastProcessedTransactionId',
      'latestGuestCount', 'categoryTotals', 'totals', 'latestRating', 'trendPoints',
      'pendingNotifications', 'nextNotificationId', 'lastNotificationAt', 'activeNotificationSeverities',
      'ratingMilestonesInitialized', 'emittedRatingMilestones',
    ],
    // Connectivity cache: invalidated to -1/empty on restore and rebuilt by the next rating computation.
    // latest* views are re-supplied by every step(), so snapshot() shows empty sections until then.
    derived: [
      'connectivityWorldVersion', 'connectivityPathVersion', 'connectedObjectIds',
      'entranceConnectedPathCount', 'entranceConnectedTip', 'latestOperations', 'latestParkOperations', 'latestScenery',
    ],
    // world is injected; restore must not touch it.
    config: ['world'],
    transient: [] as string[],
  };
  interface Internals {
    elapsedSeconds: number;
    trendAccumulatorSeconds: number;
    lastObservedCash: number;
    lastProcessedTransactionId: number;
    latestGuestCount: number;
    categoryTotals: ManagementState['categoryTotals'];
    totals: ManagementState['totals'];
    latestRating: ManagementState['latestRating'];
    trendPoints: ManagementState['trendPoints'];
    pendingNotifications: ManagementState['pendingNotifications'];
    nextNotificationId: number;
    lastNotificationAt: Map<string, number>;
    activeNotificationSeverities: Map<string, string>;
    ratingMilestonesInitialized: boolean;
    emittedRatingMilestones: Set<number>;
  }
  const mutators: Record<string, (target: Internals) => void> = {
    elapsedSeconds: (target) => { target.elapsedSeconds += 1; },
    trendAccumulatorSeconds: (target) => { target.trendAccumulatorSeconds += 1; },
    lastObservedCash: (target) => { target.lastObservedCash += 1; },
    lastProcessedTransactionId: (target) => { target.lastProcessedTransactionId += 1; },
    latestGuestCount: (target) => { target.latestGuestCount += 1; },
    categoryTotals: (target) => { target.categoryTotals.other.revenue += 1; },
    totals: (target) => { target.totals.expenses += 1; },
    latestRating: (target) => { target.latestRating.score += 1; },
    trendPoints: (target) => { const point = target.trendPoints[0]; if (point) point.cash += 1; },
    pendingNotifications: (target) => { const item = target.pendingNotifications[0]; if (item) item.title += '!'; },
    nextNotificationId: (target) => { target.nextNotificationId += 1; },
    lastNotificationAt: (target) => { target.lastNotificationAt.set('parkStalled', 3); },
    activeNotificationSeverities: (target) => { target.activeNotificationSeverities.set('parkStalled', 'critical'); },
    ratingMilestonesInitialized: (target) => { target.ratingMilestonesInitialized = !target.ratingMilestonesInitialized; },
    emittedRatingMilestones: (target) => { target.emittedRatingMilestones.add(85); target.emittedRatingMilestones.add(50); },
  };

  it('accounts for every own property of a live instance', () => {
    expect(auditOwnProperties(runPark(10).management, accounting)).toEqual([]);
  });

  it('proves each serialized field is read by serialize() by mutating it', () => {
    expect(Object.keys(mutators).sort()).toEqual([...accounting.serialized].sort());
    for (const name of accounting.serialized) {
      const park = runPark(25);
      const before = hashState(park.management.serialize());
      const mutate = mutators[name];
      if (!mutate) throw new Error(`no mutator for ${name}`);
      mutate(park.management as unknown as Internals);
      expect(hashState(park.management.serialize()), `serialize() ignores ${name}`).not.toBe(before);
    }
  });
});
