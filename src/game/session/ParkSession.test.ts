import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { SCENARIO_BY_ID, SCENARIOS } from '../scenarios/content';
import type { ScenarioDefinition } from '../scenarios/types';
import { hashState } from '../save/hash';
import { ParkSession, SANDBOX_SEED } from './ParkSession';

const testScenario = (overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition => ({
  id: 'sunny-start',
  name: 'Test Park',
  tagline: '',
  description: '',
  seed: 4242,
  timeLimitSeconds: 5,
  objective: { id: 'crowd', name: 'Crowd', kind: 'earn', metric: 'cumulativeGuests', target: 3 },
  constraint: null,
  rules: { startingCash: 5_000, arrivalIntervalMultiplier: 1.5, lockedDefinitionIds: ['tidy-totem'] },
  setup: {
    paths: [
      { x: 15, y: 30 },
      { x: 15, y: 29 },
    ],
    objects: [{ definitionId: 'sunburst-flowers', anchor: { x: 14, y: 29 } }],
  },
  cardSlots: 2,
  difficulty: 1,
  unlockedBy: { kind: 'always' },
  rewards: { cardDraftChoices: 3, unlocks: [], bonuses: [] },
  ...overrides,
});

describe('ParkSession', () => {
  it('keeps Sandbox as a separate mode with base rules, no objectives, and no scenario snapshot', () => {
    const session = new ParkSession(null);
    expect(session.scenario).toBeNull();
    expect(session.scenarioSnapshot()).toBeNull();
    expect(session.seed).toBe(SANDBOX_SEED);
    expect(session.world.cash).toBe(GAME_CONFIG.startingCash);
    expect(session.rules.lockedDefinitionIds).toEqual([]);
    expect(session.world.isDefinitionUnlocked('tidy-totem')).toBe(true);
    const events = session.step(100);
    expect(events.scenario).toEqual([]);
  });

  it('applies compiled scenario rules: cash, arrivals, locks, and free starter content', () => {
    const session = new ParkSession(testScenario());
    expect(session.world.cash).toBe(5_000);
    expect(session.guests.arrivalIntervalMultiplier).toBe(1.5);
    expect(session.world.transactions).toHaveLength(0);
    expect(session.world.paths.has('15,30')).toBe(true);
    expect(session.world.paths.has('15,29')).toBe(true);
    expect([...session.world.objects.values()].map((object) => object.definitionId)).toEqual(['sunburst-flowers']);

    const locked = session.world.checkObjectBuild('tidy-totem', { x: 10, y: 10 });
    expect(locked).toEqual({ ok: false, reason: 'locked' });
    expect(session.world.buildObject('tidy-totem', { x: 10, y: 10 })).toBeNull();
    // Research locks still apply through the composite policy.
    expect(session.world.checkObjectBuild('comet-cups', { x: 5, y: 5 })).toEqual({ ok: false, reason: 'locked' });
    // Everything else stays buildable.
    expect(session.world.checkObjectBuild('ribbon-bench', { x: 10, y: 10 }).ok).toBe(true);
  });

  it('runs a full session to success when the objective metric is reached', () => {
    const session = new ParkSession(testScenario());
    session.guests.spawnGuests(3);
    const events = session.step(100);
    expect(events.scenario).toHaveLength(1);
    expect(events.scenario[0].kind).toBe('scenarioSucceeded');
    const snapshot = session.scenarioSnapshot();
    expect(snapshot?.status).toBe('succeeded');
    expect(snapshot?.resultEvidence).toContain('3');
  });

  it('runs a full session to a deadline failure and reports exact evidence', () => {
    const session = new ParkSession(testScenario({ timeLimitSeconds: 1 }));
    let scenarioEvents = session.step(100).scenario;
    for (let tick = 1; tick < 10 && scenarioEvents.length === 0; tick += 1) {
      scenarioEvents = session.step(100).scenario;
    }
    expect(scenarioEvents).toHaveLength(1);
    expect(scenarioEvents[0].kind).toBe('scenarioFailed');
    const snapshot = session.scenarioSnapshot();
    expect(snapshot?.status).toBe('failed');
    expect(snapshot?.elapsedSeconds).toBe(1);
    expect(snapshot?.resultEvidence).toContain('0 of 3');
  });

  it('restarts a failed park with the same seed and zero leaked state', () => {
    const definition = testScenario({ timeLimitSeconds: 1 });
    const first = new ParkSession(definition);
    first.guests.spawnGuests(2);
    first.world.buildObject('ribbon-bench', { x: 10, y: 10 });
    for (let tick = 0; tick < 12; tick += 1) first.step(100);
    expect(first.scenarioSnapshot()?.status).toBe('failed');
    expect(first.world.transactions.length).toBeGreaterThan(0);

    const restarted = new ParkSession(definition);
    expect(restarted.seed).toBe(first.seed);
    expect(restarted.world.cash).toBe(5_000);
    expect(restarted.world.tick).toBe(0);
    expect(restarted.world.transactions).toHaveLength(0);
    expect(restarted.guests.guests.size).toBe(0);
    expect(restarted.guests.totalArrivals).toBe(0);
    expect(restarted.world.objects.size).toBe(1);
    expect(restarted.scenarioSnapshot()?.status).toBe('running');
    expect(restarted.scenarioSnapshot()?.elapsedSeconds).toBe(0);
    expect(restarted.management.snapshot().finances.transactionCount).toBe(0);

    // Determinism: two fresh sessions from the same definition evolve identically.
    const twin = new ParkSession(definition);
    for (let tick = 0; tick < 8; tick += 1) {
      restarted.step(100);
      twin.step(100);
    }
    expect(twin.world.cash).toBe(restarted.world.cash);
    expect(twin.guests.totalArrivals).toBe(restarted.guests.totalArrivals);
    expect(twin.scenarioSnapshot()).toEqual(restarted.scenarioSnapshot());
  });

  it('locks a card loadout into the compiled ruleset and reports the active cards', () => {
    const session = new ParkSession(testScenario(), ['grand-opening', 'local-contractors']);
    expect(session.cardsSnapshot().map((card) => card.id)).toEqual(['grand-opening', 'local-contractors']);
    // Scenario arrivals 1.5 × Grand Opening 0.8 = 1.2
    expect(session.rules.arrivalIntervalMultiplier).toBeCloseTo(1.2, 3);
    expect(session.guests.arrivalIntervalMultiplier).toBeCloseTo(1.2, 3);
    expect(session.rules.guestBudgetMultiplier).toBe(0.85);
    expect(session.rules.constructionCostMultiplier).toBe(0.8);
    // Slots cap the loadout, duplicates and unknown ids are dropped, sandbox stays card-free.
    const overloaded = new ParkSession(
      testScenario(),
      ['grand-opening', 'grand-opening', 'nonsense-card', 'velvet-ropes', 'lean-crew'] as never,
    );
    expect(overloaded.cardsSnapshot().map((card) => card.id)).toEqual(['grand-opening', 'velvet-ropes']);
    const sandbox = new ParkSession(null, ['grand-opening']);
    expect(sandbox.cardsSnapshot()).toEqual([]);
    expect(sandbox.rules.arrivalIntervalMultiplier).toBe(1);
  });

  it('feeds construction cost multipliers into build prices, funds checks, and refunds', () => {
    const session = new ParkSession(testScenario({
      rules: { startingCash: 1_000, constructionCostMultiplier: 0.8 },
    }), ['local-contractors']);
    // 0.8 (scenario) × 0.8 (Local Contractors) = 0.64
    expect(session.rules.constructionCostMultiplier).toBeCloseTo(0.64, 3);
    expect(session.world.pathCost).toBe(Math.round(GAME_CONFIG.pathCost * 0.64));
    const bench = session.world.buildObject('ribbon-bench', { x: 10, y: 10 });
    expect(bench).not.toBeNull();
    expect(session.world.cash).toBe(1_000 - Math.round(55 * 0.64));
    const refund = session.world.bulldoze({ x: 10, y: 10 });
    expect(refund.refund).toBe(Math.floor(Math.round(55 * 0.64) * GAME_CONFIG.bulldozeRefundRate));
    // Funds check uses the effective cost: petal-roundabout at 1150 × 0.64 = 736 ≤ cash.
    expect(session.world.checkObjectBuild('petal-roundabout', { x: 5, y: 5 }).ok).toBe(true);
  });

  it('scales guest budgets and need growth through the ruleset', () => {
    const base = new ParkSession(testScenario({ rules: {} }));
    const boosted = new ParkSession(testScenario({
      rules: { guestBudgetMultiplier: 2, needDecayMultiplier: 2 },
    }));
    base.guests.spawnGuests(1);
    boosted.guests.spawnGuests(1);
    const baseGuest = [...base.guests.guests.values()][0];
    const boostedGuest = [...boosted.guests.guests.values()][0];
    // Same seed → same random roll, so the doubled budget is exactly 2× (up to rounding).
    expect(boostedGuest.money).toBeGreaterThanOrEqual(baseGuest.money * 2 - 1);
    expect(boostedGuest.money).toBeLessThanOrEqual(baseGuest.money * 2 + 1);

    const baseHunger = baseGuest.hunger;
    const boostedHunger = boostedGuest.hunger;
    for (let tick = 0; tick < 20; tick += 1) {
      base.guests.step(100);
      boosted.guests.step(100);
    }
    expect(boostedGuest.hunger - boostedHunger)
      .toBeCloseTo((baseGuest.hunger - baseHunger) * 2, 5);
  });

  it('scales ride operating cost and dispatch wait through the ruleset', () => {
    const buildPark = (cards: readonly string[]): ParkSession => {
      const session = new ParkSession(testScenario({
        rules: { startingCash: 10_000 },
        setup: {
          paths: [
            { x: 15, y: 30 },
            { x: 15, y: 29 },
            { x: 15, y: 28 },
            { x: 15, y: 27 },
          ],
          objects: [{ definitionId: 'petal-roundabout', anchor: { x: 12, y: 27 } }],
        },
      }), cards as never);
      return session;
    };
    const base = buildPark([]);
    const quick = buildPark(['quick-turnaround']);
    const ride = (session: ParkSession) => [...session.rides.rides.values()][0];
    const board = (session: ParkSession) => {
      session.guests.spawnGuests(1);
      const guest = [...session.guests.guests.values()][0];
      guest.currentCell = { x: 15, y: 28 };
      guest.position = { x: 15, y: 28 };
      expect(session.rides.joinQueue(ride(session).objectId, guest)).toBe('joined');
    };
    board(base);
    board(quick);
    // One queued guest under capacity: base waits 6s to dispatch, Quick Turnaround 3.6s.
    for (let tick = 0; tick < 40; tick += 1) {
      base.rides.step(100, base.guests.guests);
      quick.rides.step(100, quick.guests.guests);
    }
    expect(ride(quick).status).toBe('running');
    expect(ride(base).status).toBe('waiting');

    // Run base to cycle completion and compare operating expense scaling.
    for (let tick = 0; tick < 700; tick += 1) {
      base.rides.step(100, base.guests.guests);
      quick.rides.step(100, quick.guests.guests);
    }
    const baseOperations = base.world.transactions.find((t) => t.category === 'ride-operations');
    const quickOperations = quick.world.transactions.find((t) => t.category === 'ride-operations');
    expect(baseOperations).toBeDefined();
    expect(quickOperations).toBeDefined();
    expect(Math.abs(quickOperations!.amount)).toBeCloseTo(Math.abs(baseOperations!.amount) * 1.25, 5);
  });

  it('lets Hungry Tourists guests accept a price the base park rejects', () => {
    const buildChoice = (cards: readonly string[]): { selected: number | null; drinkId: number } => {
      const session = new ParkSession(testScenario({
        rules: { startingCash: 10_000 },
        setup: {
          paths: [
            { x: 15, y: 30 },
            { x: 15, y: 29 },
            { x: 15, y: 28 },
            { x: 15, y: 27 },
          ],
          objects: [{ definitionId: 'fizz-foundry', anchor: { x: 16, y: 28 } }],
        },
      }), cards as never);
      const drink = [...session.world.objects.values()][0];
      session.shops.setPrice(drink.id, 8);
      session.guests.spawnGuests(1);
      const guest = [...session.guests.guests.values()][0];
      guest.thirst = 88;
      guest.hunger = 0;
      guest.toiletNeed = 0;
      guest.energy = 100;
      guest.money = 60;
      guest.maximumVisitSeconds = 1_000;
      session.guests.step(800);
      return { selected: guest.destinationObjectId, drinkId: drink.id };
    };
    const base = buildChoice([]);
    const tolerant = buildChoice(['hungry-tourists']);
    expect(base.selected).toBeNull();
    expect(tolerant.selected).toBe(tolerant.drinkId);
  });

  it('scales staff wages through the ruleset', () => {
    const session = new ParkSession(testScenario({ rules: { startingCash: 10_000 } }), ['lean-crew']);
    expect(session.rules.staffSalaryMultiplier).toBe(0.65);
    session.operations.hireStaff('cleaner');
    const wage = session.world.transactions.find((t) => t.category === 'staff-salaries');
    expect(wage).toBeDefined();
    expect(Math.abs(wage!.amount))
      .toBeCloseTo(GAME_CONFIG.operations.cleaner.salaryPerInterval * 0.65, 5);
  });

  it('lists every placed building with the owning simulation\'s own numbers', () => {
    const session = new ParkSession(null);
    const world = session.world;
    for (let y = 30; y >= 20; y -= 1) world.buildPaths([{ x: 15, y }]);
    // Seeded rather than bought: research locks are irrelevant to what the overview reports.
    const ride = world.seedScenarioObject('petal-roundabout', { x: 16, y: 22 })!;
    const coach = world.seedScenarioObject('bumble-coach', { x: 11, y: 22 }, 1)!;
    const shop = world.seedScenarioObject('picnic-pocket', { x: 13, y: 27 })!;
    const bin = world.seedScenarioObject('tidy-totem', { x: 16, y: 28 })!;
    const tree = world.seedScenarioObject('confetti-tree', { x: 16, y: 29 })!;
    session.rides.syncWithWorld();
    session.shops.syncWithWorld();
    session.operations.syncWithWorld();
    session.scenery.syncWithWorld();

    const rows = new Map(session.buildingsSnapshot().map((row) => [row.objectId, row]));
    expect(rows.size).toBe(5);

    const rideRow = rows.get(ride.id)!;
    expect(rideRow.group).toBe('ride');
    expect(rideRow.open).toBe(session.rides.snapshot(ride.id)!.open);
    expect(rideRow.price).toBe(session.rides.snapshot(ride.id)!.ticketPrice);
    expect(rideRow.condition).toBe(100);
    expect(rideRow.detail).toContain('capacity 12');

    // A rotated building reports the footprint it actually occupies.
    expect(rows.get(coach.id)!.footprint).toEqual([2, 4]);

    const shopRow = rows.get(shop.id)!;
    expect(shopRow.group).toBe('food');
    expect(shopRow.price).toBe(session.shops.snapshot(shop.id)!.itemPrice);
    expect(shopRow.condition).toBeNull();

    expect(rows.get(bin.id)!.group).toBe('bin');
    expect(rows.get(bin.id)!.detail).toBe('0/10 full');
    expect(rows.get(tree.id)!.group).toBe('scenery');
    expect(rows.get(tree.id)!.detail).toBe('+18 appeal · radius 4');
    expect(rows.get(tree.id)!.revenue).toBeNull();
  });

  it('ships scenarios whose setup, rules, and seeds are valid against the real catalog', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(3);
    for (const definition of SCENARIOS) {
      expect(SCENARIO_BY_ID.get(definition.id)).toBe(definition);
      expect(definition.timeLimitSeconds).toBeGreaterThan(0);
      expect(definition.objective.target).toBeGreaterThan(0);
      expect(Number.isInteger(definition.seed)).toBe(true);
      const session = new ParkSession(definition);
      expect(session.world.cash).toBe(definition.rules.startingCash ?? GAME_CONFIG.startingCash);
      expect(session.world.transactions).toHaveLength(0);
      for (const path of definition.setup.paths) {
        expect(session.world.paths.has(`${path.x},${path.y}`)).toBe(true);
      }
      expect(session.world.objects.size).toBe(definition.setup.objects.length);
      expect(session.scenarioSnapshot()?.status).toBe('running');
      session.step(100);
      expect(session.scenarioSnapshot()?.status).toBe('running');
    }
  });
});

/**
 * Snapshot undo's reason to exist: a demolition destroys per-object runtime state (price, the
 * player's open/closed intent, condition, revenue, breakdown history) that no inverse operation can
 * recompute. Only a whole-park snapshot brings it back, so this guards the one promise the
 * Phase 11 single-gesture undo had to refuse ("demolition can't be undone yet").
 */
describe('a demolished ride comes back from a snapshot', () => {
  const runningParkWithRide = (): { session: ParkSession; rideId: number } => {
    const session = new ParkSession(null);
    for (let index = 0; index < 8; index += 1) session.world.buildPaths([{ x: 15, y: 30 - index }]);
    const ride = session.world.buildObject('moonpetal-carousel', { x: 16, y: 26 })!;
    session.syncWithWorld();
    session.guests.spawnGuests(10);
    session.rides.setTicketPrice(ride.id, 7);
    session.rides.setOpen(ride.id, false);
    for (let step = 0; step < 600; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    // State only the ride itself holds: wear, takings and a breakdown in progress.
    const runtime = session.rides.getRide(ride.id)!;
    runtime.condition = 63.5;
    runtime.lifetimeRevenue = 1_234;
    runtime.broken = true;
    runtime.breakdownCount = 2;
    runtime.repairsCompleted = 1;
    session.rides.setOpen(ride.id, false);
    for (let step = 0; step < 100; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    return { session, rideId: ride.id };
  };

  it('returns with its ticket price, open intent, condition, revenue and breakdown state intact', () => {
    const { session, rideId } = runningParkWithRide();
    session.syncWithWorld();
    const before = session.serialize();
    const rideBefore = structuredClone(session.rides.getRide(rideId)!);
    expect(rideBefore.ticketPrice, 'the fixture must carry non-default runtime state').toBe(7);
    expect(rideBefore.open).toBe(false);
    expect(rideBefore.condition, 'worn').toBeLessThan(100);
    expect(rideBefore.breakdownCount).toBe(2);
    expect(rideBefore.lifetimeRevenue).toBe(1_234);

    // The gesture: demolish the ride, then let the park run on, as it would before the player notices.
    const target = session.world.objects.get(rideId)!.anchor;
    session.world.bulldoze(target);
    session.syncWithWorld();
    for (let step = 0; step < 50; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(session.rides.getRide(rideId), 'the ride is really gone before the rewind').toBeUndefined();

    const rewound = ParkSession.fromState(before);
    const rideAfter = rewound.rides.getRide(rideId)!;
    expect(rideAfter, 'the demolished ride exists again').toBeDefined();
    for (const field of ['ticketPrice', 'open', 'status', 'condition', 'reliability', 'broken', 'pendingBreakdown', 'breakdownCount', 'lifetimeRevenue', 'ridersToday', 'completedCycles', 'repairsCompleted', 'maintenanceKind'] as const) {
      expect(rideAfter[field], `ride.${field} survives the rewind`).toEqual(rideBefore[field]);
    }
    expect(rideAfter, 'every runtime field, not just the listed ones').toEqual(rideBefore);
  });

  it('rewinds to exactly the state hash of the moment before the gesture', () => {
    const { session, rideId } = runningParkWithRide();
    session.syncWithWorld();
    const before = session.serialize();
    const hashBefore = hashState(before);
    session.world.bulldoze(session.world.objects.get(rideId)!.anchor);
    session.syncWithWorld();
    for (let step = 0; step < 50; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(hashState(session.serialize()), 'the park moved on').not.toBe(hashBefore);

    const rewound = ParkSession.fromState(before);
    expect(hashState(rewound.serialize()), 'fromState of the snapshot reproduces the pre-gesture hash').toBe(hashBefore);
    expect(hashState(before), 'restoring never mutates the snapshot, so it can be restored again').toBe(hashBefore);
    expect(hashState(ParkSession.fromState(before).serialize())).toBe(hashBefore);
  });
});

/**
 * PA-028 end to end: the stall notice has to reach the player through the real simulation, and —
 * far more importantly — has to stay silent through an ordinary opening. A critical alarm that
 * cries wolf at minute four is worse than none, because it teaches the player to ignore it.
 */
describe('park stall notice', () => {
  const stallNotices = (session: ParkSession): string[] => {
    session.refreshManagement();
    return session.management.snapshot().notifications
      .filter((notification) => notification.kind === 'parkStalled')
      .map((notification) => notification.message);
  };

  it('stays silent on a fresh park that can still afford a ride', () => {
    const session = new ParkSession(null);
    for (let step = 0; step < 40; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(stallNotices(session)).toEqual([]);
  });

  it('stays silent on three closed rides just before opening', () => {
    const session = new ParkSession(null);
    const { world } = session;
    for (let index = 0; index < 10; index += 1) world.buildPaths([{ x: 15, y: 30 - index }]);
    world.buildObject('moonpetal-carousel', { x: 16, y: 26 });
    world.buildObject('petal-roundabout', { x: 11, y: 26 });
    world.setParkOpen(false);
    for (const ride of session.rides.rides.values()) session.rides.setOpen(ride.objectId, false);
    // Down to pocket change, everything shut, nothing running: minute four, not a dead end.
    world.addMoney(500 - world.cash, 'test');
    for (let step = 0; step < 40; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(world.cash).toBeLessThan(900);
    expect(stallNotices(session)).toEqual([]);
  });

  it('stays silent while a stranded ride could still be connected for a tile', () => {
    const session = new ParkSession(null);
    const { world } = session;
    world.buildObject('moonpetal-carousel', { x: 4, y: 4 });
    world.addMoney(50 - world.cash, 'test');
    for (let step = 0; step < 40; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(stallNotices(session)).toEqual([]);
  });

  it('announces a park with no ride, no crowd and no way to buy one — exactly once', () => {
    const session = new ParkSession(null);
    const { world } = session;
    for (let index = 0; index < 6; index += 1) world.buildPaths([{ x: 15, y: 30 - index }]);
    world.addMoney(-world.cash - 200, 'test');
    for (let step = 0; step < 40; step += 1) session.step(GAME_CONFIG.fixedStepMs);

    const notices = stallNotices(session);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('cannot recover');
    expect(notices[0]).toContain('Parks menu');

    // Held, not repeated, however long the park sits there.
    for (let step = 0; step < 900; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(stallNotices(session)).toHaveLength(1);
  });

  it('fires by itself as the last guests drain out of a park that can no longer earn', () => {
    // The commonest way into the trap is not a jump but a slow leak: a shop, a crowd, no ride and
    // no cash. While guests remain the shop can still earn, so the notice must stay quiet — and
    // then fire on its own once they have all gone home, with nothing in the world having changed.
    const session = new ParkSession(null);
    const { world } = session;
    for (let index = 0; index < 4; index += 1) world.buildPaths([{ x: 15, y: 30 - index }]);
    const shop = world.buildObject('lemon-light', { x: 16, y: 29 });
    expect(shop).not.toBeNull();
    world.addMoney(-world.cash + 40, 'test');
    session.guests.spawnGuests(6);
    for (let step = 0; step < 20; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(session.guests.guests.size).toBeGreaterThan(0);
    expect(stallNotices(session)).toEqual([]);

    // Cut their visits short so the drain finishes inside the test. This touches guests only:
    // the park keeps its shop, its paths and its $40 for the rest of the run.
    for (const guest of session.guests.guests.values()) guest.maximumVisitSeconds = 1;
    const cashBefore = world.cash;
    const objectsBefore = world.objects.size;
    for (let step = 0; step < 600 && session.guests.guests.size > 0; step += 1) {
      session.step(GAME_CONFIG.fixedStepMs);
    }
    expect(session.guests.guests.size, 'the crowd never drained, so the test proves nothing').toBe(0);
    expect(world.cash).toBe(cashBefore);
    expect(world.objects.size).toBe(objectsBefore);

    const notices = stallNotices(session);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('$40 will not build one');
  });

  it('clears and can announce again once the park has been rescued and stalls anew', () => {
    const session = new ParkSession(null);
    const { world } = session;
    world.addMoney(-world.cash - 200, 'test');
    for (let step = 0; step < 40; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(stallNotices(session)).toHaveLength(1);

    // A rescue: enough for a ride again, so the alarm has to disarm.
    world.addMoney(5_000, 'rescue');
    for (let step = 0; step < 600; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    world.addMoney(-world.cash - 100, 'relapse');
    for (let step = 0; step < 40; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(stallNotices(session).length, 'the alarm latched instead of re-arming').toBeGreaterThan(1);
  });
});
