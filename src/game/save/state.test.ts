import { describe, expect, it } from 'vitest';
import { hashState } from './hash';
import { assertPlainData, assertStructuredCloneSafe, plainDeepEqual } from './plainData';
import { RESTORE_ORDER, type ParkSaveV10, type Serializable } from './state';

/** The smallest complete save: it exists so the types are exercised and the contract is testable. */
const emptyTotals = { revenue: 0, expenses: 0, profit: 0, transactionCount: 0 };

const buildFixture = (): ParkSaveV10 => ({
  scenarioId: 'sunny-start',
  activeCardIds: ['grand-opening'],
  seed: 0x5eed1234,
  rules: {
    startingCash: 5000,
    lockedDefinitionIds: ['coaster-classic'],
    arrivalIntervalMultiplier: 1,
    guestBudgetMultiplier: 1,
    servicePriceToleranceMultiplier: 1,
    needDecayMultiplier: 1,
    constructionCostMultiplier: 1,
    rideOperatingCostMultiplier: 1,
    rideDispatchMultiplier: 1,
    serviceDurationMultiplier: 1,
    needReliefMultiplier: 1,
    staffSalaryMultiplier: 1,
    staffSpeedMultiplier: 1,
    wetWeatherMultiplier: 1,
    chainLiftCostMultiplier: 1,
    recolourCostMultiplier: 1,
  },
  world: {
    mapWidth: 32,
    mapHeight: 32,
    constructionCostMultiplier: 1,
    cash: 1234.5,
    tick: 7,
    parkOpen: true,
    demolitions: 0,
    nextObjectId: 2,
    nextTransactionId: 2,
    version: 3,
    pathVersion: 2,
    paths: [{ x: 15, y: 31 }, { x: 15, y: 30 }],
    objects: [{ id: 1, definitionId: 'bench', anchor: { x: 14, y: 30 }, rotation: 0 }],
    coasters: [{
      objectId: 1,
      pieces: [{ cell: { x: 1, y: 1 }, height: 0 }, { cell: { x: 2, y: 1 }, height: 2, special: 'loop' }],
      stats: {
        pieces: 2, turns: 0, drops: 0, totalDescent: 0, biggestDrop: 0, highestHeight: 2, loops: 1, boosts: 0,
        topSpeed: 1, excitement: 1, intensity: 1, durationSeconds: 10, travelSeconds: [1.5, 2.5], capacity: 4,
        runningCost: 1, ticketPrice: 4, reliability: 90,
      },
      paidCost: 300,
    }],
    transactions: [{ id: 1, amount: 0, label: 'Free item', category: 'construction', tick: 1 }],
  },
  scenery: { width: 32, height: 32, scores: [[5, 0.25]], sources: [{ objectId: 1, signature: 'bench:14:30:1:1:1:2' }] },
  rides: { elapsedSeconds: 0.7, rides: [] },
  shops: { nextCompletionEventId: 1, completionEvents: [], services: [] },
  guests: { randomState: 123456, nextGuestId: 1, totalArrivals: 0, spawnTimerSeconds: -3.25, parkRating: 50, guests: [] },
  operations: {
    elapsedSeconds: 0.7,
    happinessAccumulatorSeconds: 0.1,
    nextStaffId: 1,
    guestPopulation: 0,
    trainingLevel: { cleaner: 0, mechanic: 0 },
    bins: [],
    litter: [],
    staff: [],
  },
  progression: {
    researchPoints: 0,
    completedRideExperiences: 0,
    completedServiceExperiences: 0,
    highestParkRating: 0,
    completedProjectIds: [],
    completedMilestoneIds: [],
    lastRideCompletionCounts: [],
    lastServiceCompletionCounts: [],
    pendingEvents: [],
    nextEventId: 1,
  },
  management: {
    elapsedSeconds: 0.7,
    trendAccumulatorSeconds: 0.7,
    lastObservedCash: 1234.5,
    lastProcessedTransactionId: 1,
    latestGuestCount: 0,
    categoryTotals: {
      construction: emptyTotals, rideTickets: emptyTotals, foodSales: emptyTotals, drinkSales: emptyTotals,
      facilityRevenue: emptyTotals, rideOperations: emptyTotals, staffSalaries: emptyTotals,
      maintenance: emptyTotals, research: emptyTotals, grants: emptyTotals, refunds: emptyTotals, other: emptyTotals,
    },
    totals: emptyTotals,
    latestRating: { score: 50, factors: [] },
    trendPoints: [],
    pendingNotifications: [],
    nextNotificationId: 1,
    lastNotificationAt: [['cashLow', 12.5]],
    activeNotificationSeverities: [['cashLow', 'warning']],
    ratingMilestonesInitialized: false,
    emittedRatingMilestones: [],
  },
  calendar: { dayLengthSeconds: 720, anchorTick: 0, anchorUnits: 0, timeLock: 'auto', hoursEnabled: false, openHour: 8, closeHour: 21 },
  weather: {
    enabled: true,
    severity: 'normal',
    rngState: 12345,
    chainKind: 'cloudy',
    firstDay: 1,
    days: [{ kind: 'cloudy', slots: [{ kind: 'cloudy', intensity: 0.5 }, { kind: 'cloudy', intensity: 0.5 }, { kind: 'cloudy', intensity: 0.5 }, { kind: 'cloudy', intensity: 0.5 }] }],
  },
  onboarding: null,
  scenario: {
    scenarioId: 'sunny-start',
    status: 'running',
    elapsedSeconds: 0.7,
    sustainedSeconds: 0,
    longestSustainedSeconds: 0,
    completedAtSeconds: null,
    resultEvidence: null,
    latestMetrics: {
      cumulativeGuests: 0, guestCount: 0, parkRating: 50, averageHappiness: null, operatingProfit: 0, averageQueueSeconds: 0,
    },
    pendingEvents: [],
  },
  map: {
    id: 'meadow',
    biomeId: 'meadow',
    width: 32,
    height: 32,
    entrance: { x: 15, y: 31, facing: 'north' },
    ground: Array.from({ length: 32 }, () => '................................'),
    props: [],
    recipe: null,
  },
  mode: 'scenario',
  grant: { unlockedBuildingIds: [], bonusIds: [] },
});

describe('ParkSaveV10', () => {
  it('a complete save is plain data, structured-clone safe and survives a JSON round trip exactly', () => {
    const fixture = buildFixture();
    expect(() => assertPlainData(fixture), 'fixture is plain').not.toThrow();
    expect(() => assertStructuredCloneSafe(fixture), 'fixture clones').not.toThrow();
    const roundTripped: unknown = JSON.parse(JSON.stringify(fixture));
    expect(plainDeepEqual(roundTripped, fixture), 'JSON round trip is lossless').toBe(true);
    expect(hashState(roundTripped), 'hash survives the round trip').toBe(hashState(fixture));
  });

  it('keeps an omitted optional key distinct from an explicit undefined', () => {
    const fixture = buildFixture();
    expect('special' in fixture.world.coasters[0].pieces[0], 'plain track omits the key').toBe(false);
    const withUndefined = structuredClone(fixture);
    withUndefined.world.coasters[0].pieces[0].special = undefined;
    expect(() => assertPlainData(withUndefined), 'an explicit undefined is rejected').toThrow(/special/);
  });

  it('composes exactly the session fields plus one state per restore-order owner', () => {
    const keys = Object.keys(buildFixture()).sort();
    const sessionFields = ['scenarioId', 'activeCardIds', 'seed', 'rules', 'map', 'mode', 'grant'];
    expect(keys, 'the save has the session fields and every owner, nothing else')
      .toEqual([...sessionFields, ...RESTORE_ORDER].sort());
  });
});

describe('RESTORE_ORDER', () => {
  it('lists each owner once, world first and scenario last', () => {
    expect(new Set(RESTORE_ORDER).size, 'no duplicates').toBe(RESTORE_ORDER.length);
    expect(RESTORE_ORDER[0], 'world first').toBe('world');
    expect(RESTORE_ORDER[RESTORE_ORDER.length - 1], 'scenario last').toBe('scenario');
    expect(RESTORE_ORDER.indexOf('rides'), 'rides before operations').toBeLessThan(RESTORE_ORDER.indexOf('operations'));
    expect(RESTORE_ORDER.indexOf('rides'), 'rides before guests').toBeLessThan(RESTORE_ORDER.indexOf('guests'));
    expect(RESTORE_ORDER.indexOf('management'), 'management before onboarding').toBeLessThan(RESTORE_ORDER.indexOf('onboarding'));
    expect(RESTORE_ORDER.indexOf('onboarding'), 'onboarding before scenario').toBeLessThan(RESTORE_ORDER.indexOf('scenario'));
    expect(RESTORE_ORDER.indexOf('world'), 'world before management').toBeLessThan(RESTORE_ORDER.indexOf('management'));
  });
});

describe('Serializable', () => {
  it('describes an owner whose restore of its own serialize() is the identity', () => {
    class Counter implements Serializable<{ count: number }> {
      private count = 0;
      increment(): void { this.count += 1; }
      serialize(): { count: number } { return { count: this.count }; }
      restore(state: { count: number }): void { this.count = state.count; }
    }
    const original = new Counter();
    original.increment();
    const target = new Counter();
    target.restore(original.serialize());
    expect(target.serialize(), 'restore reproduces the serialized state').toEqual(original.serialize());
  });
});
