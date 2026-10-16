import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { PRICEY_SOUVENIR_THOUGHT } from '../guests/life';
import type { Guest } from '../guests/types';
import { RideSimulation } from '../rides/RideSimulation';
import { ScenerySimulation } from '../scenery/ScenerySimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import type { OperationsSnapshot as ParkOperationsSnapshot } from '../operations/types';
import { GameWorld } from '../World';
import { classifyTransaction, ManagementSimulation, sceneryFactorDetail } from './ManagementSimulation';

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

const guestMap = (...guests: Guest[]): Map<number, Guest> =>
  new Map(guests.map((guest) => [guest.id, guest]));

const parkOperations = (
  overrides: Partial<ParkOperationsSnapshot> = {},
): ParkOperationsSnapshot => ({
  elapsedSeconds: 0,
  cleanliness: {
    score: 100,
    litterUnits: 0,
    dirtyPathTiles: 0,
    binsTotal: 0,
    binsFull: 0,
    averageBinFillPercent: 0,
  },
  maintenance: {
    averageRideCondition: null,
    wornRides: 0,
    brokenRides: 0,
    awaitingMechanic: 0,
  },
  staff: {
    cleaners: { total: 0, busy: 0, salaryPerInterval: 12, trainingLevel: 0, trainingCost: 240 },
    mechanics: { total: 0, busy: 0, salaryPerInterval: 18, trainingLevel: 0, trainingCost: 360 },
    payrollIntervalSeconds: 30,
    capacityPerRole: 6,
    maximumTrainingLevel: 3,
  },
  litter: [],
  bins: [],
  workers: [],
  ...overrides,
});

const createSimulations = (world: GameWorld) => ({
  rides: new RideSimulation(world),
  shops: new ShopSimulation(world),
});

const createConnectedPark = () => {
  const world = new GameWorld();
  world.buildPaths([
    { x: 15, y: 30 },
    { x: 15, y: 29 },
    { x: 15, y: 28 },
    { x: 15, y: 27 },
  ]);
  const ride = world.buildObject('petal-roundabout', { x: 12, y: 27 });
  const food = world.buildObject('picnic-pocket', { x: 16, y: 28 });
  if (!ride || !food) throw new Error('Connected test content should be placeable');
  return { world, ride, food, ...createSimulations(world) };
};

describe('management transaction classification and finance', () => {
  it('prefers explicit source categories and uses labels only for legacy fallback', () => {
    expect(classifyTransaction({
      amount: 5,
      label: 'Developer grant with a misleading label',
      category: 'ride-revenue',
    })).toBe('rideTickets');
    expect(classifyTransaction({ amount: 7, label: 'Picnic Pocket sales' })).toBe('foodSales');
    expect(classifyTransaction({ amount: 4.5, label: 'Fizz Foundry sales' })).toBe('drinkSales');
    expect(classifyTransaction({ amount: 1, label: 'Comfort Cabin sales' })).toBe('facilityRevenue');
    expect(classifyTransaction({ amount: -6, label: 'Petal Roundabout cycle operation' })).toBe('rideOperations');
    expect(classifyTransaction({ amount: -12, label: 'Cleaner wage', category: 'staff-salaries' })).toBe('staffSalaries');
    expect(classifyTransaction({ amount: -25, label: 'Ride repair', category: 'maintenance' })).toBe('maintenance');
    expect(classifyTransaction({ amount: 10, label: 'Recovered path materials' })).toBe('refunds');
  });

  it('tracks categories exactly once and separates operating profit from net cash flow', () => {
    const world = new GameWorld();
    world.postTransaction(-100, 'Foundation work', 'construction');
    world.postTransaction(20, 'Ride income', 'ride-revenue');
    world.postTransaction(7, 'Food income', 'food-revenue');
    world.postTransaction(4, 'Drink income', 'drink-revenue');
    world.postTransaction(1, 'Facility income', 'facility-revenue');
    world.postTransaction(-6, 'Ride running cost', 'ride-operations');
    world.postTransaction(-12, 'Cleaner wage', 'staff-salaries');
    world.postTransaction(-25, 'Ride repair', 'maintenance');
    world.postTransaction(50, 'Developer grant', 'grant');
    world.postTransaction(10, 'Materials refund', 'refund');
    const management = new ManagementSimulation(world);
    const { rides, shops } = createSimulations(world);

    management.step(100, new Map(), rides, shops);
    const first = management.snapshot().finances;
    expect(first).toMatchObject({ revenue: 92, expenses: 143, profit: -51, transactionCount: 10 });
    expect(first.operating).toEqual({ revenue: 32, expenses: 43, profit: -11, transactionCount: 7 });
    expect(first.categories.construction.expenses).toBe(100);
    expect(first.categories.rideTickets.revenue).toBe(20);
    expect(first.categories.foodSales.revenue).toBe(7);
    expect(first.categories.drinkSales.revenue).toBe(4);
    expect(first.categories.facilityRevenue.revenue).toBe(1);
    expect(first.categories.staffSalaries.expenses).toBe(12);
    expect(first.categories.maintenance.expenses).toBe(25);
    expect(first.categories.grants.profit).toBe(50);
    expect(first.categories.refunds.profit).toBe(10);
    expect(first.recentTransactions[0]).toMatchObject({ label: 'Materials refund', category: 'refunds' });

    management.step(100, new Map(), rides, shops);
    expect(management.snapshot().finances).toEqual(first);
  });

  it('reconciles cash exactly when more transactions arrive than the bounded world history retains', () => {
    const world = new GameWorld();
    const management = new ManagementSimulation(world);
    const { rides, shops } = createSimulations(world);
    for (let index = 0; index < 305; index += 1) {
      world.postTransaction(-1, `Construction burst ${index}`, 'construction');
    }

    management.step(100, new Map(), rides, shops);
    const finances = management.snapshot().finances;
    expect(finances.expenses).toBe(305);
    expect(finances.profit).toBe(-305);
    expect(finances.categories.construction.expenses).toBe(300);
    expect(finances.categories.other.expenses).toBe(5);
    expect(finances.lastTransactionId).toBe(305);

    management.step(100, new Map(), rides, shops);
    expect(management.snapshot().finances.expenses).toBe(305);
  });
});

describe('management operations and park rating', () => {
  it('publishes a ready-to-render operations summary without duplicating runtime scans in the UI', () => {
    const { world, ride, food, rides, shops } = createConnectedPark();
    const first = createGuest(1, {
      state: 'queueing',
      destinationObjectId: ride.id,
      happiness: 80,
      hunger: 80,
      stateTimerSeconds: 12,
    });
    const second = createGuest(2, {
      state: 'queueingForShop',
      destinationObjectId: food.id,
      happiness: 60,
      thirst: 80,
      toiletNeed: 80,
      stateTimerSeconds: 4,
    });
    const rideRuntime = rides.getRide(ride.id)!;
    const serviceRuntime = shops.getService(food.id)!;
    rideRuntime.queueGuestIds.push(first.id);
    rideRuntime.ridersToday = 4;
    serviceRuntime.queueGuestIds.push(second.id);
    serviceRuntime.customersServed = 3;
    const management = new ManagementSimulation(world);

    management.step(100, guestMap(first, second), rides, shops);

    expect(management.snapshot().operations).toEqual({
      averageHappiness: 70,
      averageQueueSeconds: 8,
      totalQueued: 2,
      rides: { open: 1, total: 1, queued: 1, ridersToday: 4 },
      services: { open: 1, total: 1, queued: 1, customersServed: 3 },
      needs: { hungry: 1, thirsty: 1, toilet: 1 },
      // Phase 30: the comfort counts ride along (guest life is on by default; both guests are comfortable).
      comfort: { tired: 0, queasy: 0, hot: 0, cold: 0, soaked: 0, resting: 0, sickPiles: 0 },
    });
  });

  describe('Phase 30: comfort counts', () => {
    const life = GAME_CONFIG.guestLife;
    const rain = { weatherKind: 'rain' as const, weatherIntensity: 0.6 };

    it('counts tired, queasy, hot, cold and resting guests at the guest simulation thresholds, in one pass', () => {
      const { world, rides, shops } = createConnectedPark();
      const tired = createGuest(1, { energy: life.bench.seekEnergy - 1 });
      const awake = createGuest(2, { energy: life.bench.seekEnergy });
      const queasy = createGuest(3, { nausea: life.nausea.queasy });
      const settled = createGuest(4, { nausea: life.nausea.queasy - 1 });
      const hot = createGuest(5, { warmth: life.warmth.hot });
      const cold = createGuest(6, { warmth: life.warmth.cold });
      const mild = createGuest(7, { warmth: life.warmth.cold + 1 });
      const resting = createGuest(8, { state: 'resting', energy: 10 });
      const management = new ManagementSimulation(world);
      management.step(100, guestMap(tired, awake, queasy, settled, hot, cold, mild, resting), rides, shops);
      // The resting guest is also tired: the counts are independent flags, not a partition.
      expect(management.snapshot().operations.comfort).toEqual({ tired: 2, queasy: 1, hot: 1, cold: 1, soaked: 0, resting: 1, sickPiles: 0 });
    });

    it('counts a guest as soaked only in the rain the session passes, and never with an umbrella or indoors', () => {
      const { world, rides, shops } = createConnectedPark();
      const outside = createGuest(1);
      const umbrella = createGuest(2, { souvenirs: 1 }); // bit 0 = umbrella (SOUVENIR_KINDS order)
      const inside = createGuest(3, { state: 'riding' });
      const management = new ManagementSimulation(world);
      management.step(100, guestMap(outside, umbrella, inside), rides, shops, parkOperations(), undefined, rain);
      expect(management.snapshot().operations.comfort?.soaked).toBe(1);
      // No conditions (the default): nobody counts as soaked, whatever the weather is doing.
      management.step(100, guestMap(outside, umbrella, inside), rides, shops);
      expect(management.snapshot().operations.comfort?.soaked).toBe(0);
      management.step(100, guestMap(outside), rides, shops, parkOperations(), undefined, { weatherKind: 'sunny', weatherIntensity: 1 });
      expect(management.snapshot().operations.comfort?.soaked).toBe(0);
    });

    it('counts the litter piles someone was sick on from the operations snapshot', () => {
      const { world, rides, shops } = createConnectedPark();
      const management = new ManagementSimulation(world);
      const litter = [
        { cell: { x: 15, y: 28 }, units: 2, assignedCleanerId: null, sick: true },
        { cell: { x: 15, y: 29 }, units: 1, assignedCleanerId: null, sick: false },
        { cell: { x: 15, y: 30 }, units: 1, assignedCleanerId: null, sick: true },
      ];
      management.step(100, new Map(), rides, shops, parkOperations({ litter }));
      expect(management.snapshot().operations.comfort?.sickPiles).toBe(2);
      // The snapshot is a copy: mutating it leaves the next snapshot alone.
      const snapshot = management.snapshot();
      snapshot.operations.comfort!.sickPiles = 99;
      expect(management.snapshot().operations.comfort?.sickPiles).toBe(2);
    });

    it('is absent while the guest-life switch is off, so a park that never lived Phase 29 observes nothing new', () => {
      const { world, rides, shops } = createConnectedPark();
      const management = new ManagementSimulation(world);
      const switchable = life as { enabled: boolean };
      switchable.enabled = false;
      try {
        management.step(100, guestMap(createGuest(1, { energy: 5 })), rides, shops);
        expect('comfort' in management.snapshot().operations).toBe(false);
      } finally {
        switchable.enabled = true;
      }
      management.step(100, guestMap(createGuest(1, { energy: 5 })), rides, shops);
      expect(management.snapshot().operations.comfort?.tired).toBe(1);
    });

    it('counts a pricey souvenir as a price complaint in the value factor', () => {
      const { world, rides, shops } = createConnectedPark();
      const management = new ManagementSimulation(world);
      const sulking = createGuest(1, { currentThought: PRICEY_SOUVENIR_THOUGHT, thoughtObjectId: 7 });
      const content = createGuest(2, { currentThought: 'What a lovely day.' });
      management.step(100, guestMap(sulking, content), rides, shops);
      const value = management.snapshot().rating.factors.find((factor) => factor.key === 'value');
      expect(value?.detail).toContain('1 current guest price complaints');
    });
  });

  it('produces finite, explainable factors with neutral baselines when there are no guests or samples', () => {
    const world = new GameWorld();
    const { rides, shops } = createSimulations(world);
    const management = new ManagementSimulation(world);
    management.step(0, new Map(), rides, shops);

    const snapshot = management.snapshot();
    expect(snapshot.guestCount).toBe(0);
    expect(snapshot.operations.averageHappiness).toBeNull();
    expect(snapshot.rating.factors).toHaveLength(11);
    expect(snapshot.rating.factors.every((factor) =>
      Number.isFinite(factor.score) && Number.isFinite(factor.contribution) && factor.detail.length > 0,
    )).toBe(true);
    expect(snapshot.rating.score).toBeGreaterThanOrEqual(0);
    expect(snapshot.rating.score).toBeLessThanOrEqual(100);
    expect(JSON.stringify(snapshot)).not.toContain('NaN');
  });

  it('scores physical entrance connectivity and keeps cash health out of reputation', () => {
    const { world, rides, shops } = createConnectedPark();
    const guest = createGuest(1, { happiness: 88, hunger: 8, thirst: 8, toiletNeed: 8 });
    rides.rides.forEach((ride) => {
      ride.satisfactionTotal = 90;
      ride.satisfactionCount = 1;
    });
    shops.services.forEach((service) => {
      service.satisfactionTotal = 84;
      service.satisfactionCount = 1;
    });
    const management = new ManagementSimulation(world);
    management.step(100, guestMap(guest), rides, shops);
    const before = management.snapshot();
    const accessibility = before.rating.factors.find((factor) => factor.key === 'accessibility');
    expect(accessibility?.score).toBe(100);
    expect(before.rating.factors.some((factor) => factor.key === ('cashHealth' as never))).toBe(false);

    world.addMoney(-world.cash - 500, 'Test cash withdrawal');
    management.step(100, guestMap(guest), rides, shops);
    const after = management.snapshot();
    expect(after.rating).toEqual(before.rating);
  });

  it('gives inaccessible guest content an accessibility score of zero', () => {
    const world = new GameWorld();
    expect(world.buildObject('petal-roundabout', { x: 2, y: 2 })).not.toBeNull();
    const { rides, shops } = createSimulations(world);
    const management = new ManagementSimulation(world);
    management.step(100, new Map(), rides, shops);
    expect(management.snapshot().rating.factors.find((factor) => factor.key === 'accessibility')?.score).toBe(0);
  });

  it('does not reward closed or disconnected content as park variety or size', () => {
    const { world, ride, rides, shops } = createConnectedPark();
    expect(world.buildObject('fizz-foundry', { x: 2, y: 2 })).not.toBeNull();
    shops.syncWithWorld();
    rides.setOpen(ride.id, false);
    const management = new ManagementSimulation(world);

    management.step(100, new Map(), rides, shops);
    const closedVariety = management.snapshot().rating.factors.find((factor) => factor.key === 'contentVariety')!;
    const closedSize = management.snapshot().rating.factors.find((factor) => factor.key === 'parkSize')!;
    expect(closedVariety.detail).toBe('0 ride types and 1 service types.');
    expect(closedSize.detail).toContain('1 reachable open guest destinations');

    rides.setOpen(ride.id, true);
    management.step(100, new Map(), rides, shops);
    const openVariety = management.snapshot().rating.factors.find((factor) => factor.key === 'contentVariety')!;
    const openSize = management.snapshot().rating.factors.find((factor) => factor.key === 'parkSize')!;
    expect(openVariety.score).toBeGreaterThan(closedVariety.score);
    expect(openSize.score).toBeGreaterThan(closedSize.score);
  });

  it('turns decorated surroundings into a higher scenery factor and park rating', () => {
    const { world, rides, shops } = createConnectedPark();
    const scenerySimulation = new ScenerySimulation(world);
    const management = new ManagementSimulation(world);

    management.step(100, new Map(), rides, shops, undefined, scenerySimulation.snapshot());
    const plain = management.snapshot();
    const plainFactor = plain.rating.factors.find((factor) => factor.key === 'scenery')!;
    expect(plainFactor.score).toBe(0);
    expect(plainFactor.detail).toBe('0 of 5 connected path tiles decorated; 0 scenery sources.');

    expect(world.buildObject('ripple-fountain', { x: 16, y: 25 })).not.toBeNull();
    expect(world.buildObject('confetti-tree', { x: 14, y: 30 })).not.toBeNull();
    management.step(100, new Map(), rides, shops, undefined, scenerySimulation.snapshot());
    const decorated = management.snapshot();
    const decoratedFactor = decorated.rating.factors.find((factor) => factor.key === 'scenery')!;

    expect(decoratedFactor.score).toBeGreaterThan(0);
    expect(decoratedFactor.contribution).toBeGreaterThan(plainFactor.contribution);
    expect(decorated.rating.score).toBeGreaterThan(plain.rating.score);
    expect(decorated.parkScenery.sourceCount).toBe(2);
    expect(decorated.parkScenery.decoratedPathTiles).toBeGreaterThan(0);
  });

  it('makes dirt and breakdowns visible in operations, reputation, trends, and alerts', () => {
    const { world, ride, rides, shops } = createConnectedPark();
    const runtime = rides.getRide(ride.id)!;
    runtime.condition = 24;
    runtime.broken = true;
    runtime.status = 'broken';
    const management = new ManagementSimulation(world);
    const dirtyOperations = parkOperations({
      cleanliness: {
        score: 32,
        litterUnits: 14,
        dirtyPathTiles: 5,
        binsTotal: 2,
        binsFull: 1,
        averageBinFillPercent: 75,
      },
      maintenance: {
        averageRideCondition: 24,
        wornRides: 0,
        brokenRides: 1,
        awaitingMechanic: 1,
      },
    });

    management.step(100, new Map(), rides, shops, dirtyOperations);
    const snapshot = management.snapshot();

    expect(snapshot.operations.rides.open).toBe(0);
    expect(snapshot.parkOperations.cleanliness.score).toBe(32);
    expect(snapshot.rating.factors.find((factor) => factor.key === 'cleanliness')?.score).toBe(32);
    expect(snapshot.rating.factors.find((factor) => factor.key === 'reliability')?.score).toBe(0);
    expect(snapshot.trends.at(-1)).toMatchObject({ cleanliness: 32, reliability: 0 });
    expect(management.consumeNotifications()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'cleanlinessLow' }),
      expect.objectContaining({ kind: 'binsFull' }),
      expect.objectContaining({ kind: 'ridesBroken' }),
    ]));
  });

  it('keeps chronological management trends bounded to the configured history', () => {
    const world = new GameWorld();
    const { rides, shops } = createSimulations(world);
    const management = new ManagementSimulation(world);
    for (let index = 0; index < 130; index += 1) management.step(5_000, new Map(), rides, shops);

    const trends = management.snapshot().trends;
    expect(trends).toHaveLength(120);
    expect(trends[0].timeSeconds).toBeLessThan(trends.at(-1)!.timeSeconds);
    expect(trends.every((point) => Number.isFinite(point.parkRating) && Number.isFinite(point.profit))).toBe(true);
  });
});

describe('management notifications', () => {
  it('emits upward rating milestones once, but never for the initial baseline', () => {
    const world = new GameWorld();
    const { rides, shops } = createSimulations(world);
    const management = new ManagementSimulation(world);
    management.step(100, new Map(), rides, shops);
    expect(management.consumeNotifications().some((notification) =>
      notification.kind.startsWith('ratingMilestone'),
    )).toBe(false);

    world.buildPaths([
      { x: 15, y: 30 },
      { x: 15, y: 29 },
      { x: 15, y: 28 },
      { x: 15, y: 27 },
    ]);
    const ride = world.buildObject('petal-roundabout', { x: 12, y: 27 });
    const food = world.buildObject('picnic-pocket', { x: 16, y: 28 });
    if (!ride || !food) throw new Error('Milestone test content should be placeable');
    rides.syncWithWorld();
    shops.syncWithWorld();
    rides.getRide(ride.id)!.satisfactionTotal = 100;
    rides.getRide(ride.id)!.satisfactionCount = 1;
    shops.getService(food.id)!.satisfactionTotal = 100;
    shops.getService(food.id)!.satisfactionCount = 1;
    const guest = createGuest(1, { happiness: 100, hunger: 0, thirst: 0, toiletNeed: 0 });

    management.step(100, guestMap(guest), rides, shops);
    const milestones = management.consumeNotifications()
      .filter((notification) => notification.kind.startsWith('ratingMilestone'));
    expect(milestones.map((notification) => notification.kind)).toEqual([
      'ratingMilestone50',
      'ratingMilestone70',
    ]);
    expect(milestones.every((notification) => notification.severity === 'info')).toBe(true);

    management.step(100, guestMap(guest), rides, shops);
    expect(management.consumeNotifications().some((notification) =>
      notification.kind.startsWith('ratingMilestone'),
    )).toBe(false);
  });

  it('deduplicates active needs and respects cooldown after a condition clears', () => {
    const world = new GameWorld();
    const { rides, shops } = createSimulations(world);
    const management = new ManagementSimulation(world);
    const guest = createGuest(1, { thirst: 90 });
    const guests = guestMap(guest);

    management.step(100, guests, rides, shops);
    expect(management.consumeNotifications().filter((notification) => notification.kind === 'unmetDrink')).toHaveLength(1);
    management.step(100_000, guests, rides, shops);
    expect(management.consumeNotifications().filter((notification) => notification.kind === 'unmetDrink')).toHaveLength(0);

    guest.thirst = 10;
    management.step(100, guests, rides, shops);
    guest.thirst = 90;
    management.step(100, guests, rides, shops);
    expect(management.consumeNotifications().filter((notification) => notification.kind === 'unmetDrink')).toHaveLength(1);
  });

  /**
   * Behaviour, at concrete cash values, deliberately without importing the threshold constant:
   * a test that derives its input from the constant it is checking passes for any value of that
   * constant and therefore checks nothing. If a balance pass moves starting cash far enough that
   * $4,000 counts as a low reserve, this test should fail loudly and be re-read.
   */
  it('warns as cash runs out, escalates when it goes negative, and re-arms afterwards', () => {
    const world = new GameWorld();
    const { rides, shops } = createSimulations(world);
    const management = new ManagementSimulation(world);
    const setCash = (amount: number): void => {
      world.addMoney(amount - world.cash, 'Test cash adjustment');
    };
    const cashEvents = (stepMs = 100): { kind: string; severity: string }[] => {
      management.step(stepMs, new Map(), rides, shops);
      return management.consumeNotifications()
        .filter((notification) => notification.kind === 'cashLow' || notification.kind === 'cashNegative')
        .map((notification) => ({ kind: notification.kind, severity: notification.severity }));
    };

    setCash(4_000);
    expect(cashEvents(), 'a healthy reserve raised an alarm').toEqual([]);

    setCash(50);
    expect(cashEvents(), 'a nearly empty till stayed silent')
      .toEqual([{ kind: 'cashLow', severity: 'warning' }]);

    setCash(20);
    expect(cashEvents(), 'the same warning repeated while cash kept falling').toEqual([]);

    setCash(-1);
    expect(cashEvents(), 'going into debt was not escalated')
      .toEqual([{ kind: 'cashNegative', severity: 'critical' }]);

    // Recovering well clear of the threshold has to disarm both, or the warning never fires again.
    setCash(4_000);
    expect(cashEvents(100_000), 'recovery kept an alarm active').toEqual([]);

    setCash(50);
    expect(cashEvents(), 'the warning latched instead of re-arming')
      .toEqual([{ kind: 'cashLow', severity: 'warning' }]);
  });

  it('reports overcrowding and a sustained rating fall from deterministic simulation time', () => {
    const { world, food, rides, shops } = createConnectedPark();
    const management = new ManagementSimulation(world);
    const guest = createGuest(1, { happiness: 95, hunger: 5, thirst: 5, toiletNeed: 5 });
    const guests = guestMap(guest);
    management.step(100, guests, rides, shops);
    management.consumeNotifications();

    shops.getService(food.id)!.queueGuestIds = [1, 2, 3, 4, 5, 6, 7, 8];
    management.step(100, guests, rides, shops);
    expect(management.consumeNotifications()).toContainEqual(expect.objectContaining({
      kind: 'queuesOvercrowded', severity: 'warning',
    }));

    shops.getService(food.id)!.queueGuestIds = [];
    guest.happiness = 0;
    guest.hunger = 100;
    guest.thirst = 100;
    guest.toiletNeed = 100;
    management.step(15_100, guests, rides, shops);
    expect(management.consumeNotifications()).toContainEqual(expect.objectContaining({
      kind: 'ratingFalling',
    }));
  });
});

describe('connectivity tip', () => {
  it('is null with no path beyond the gate, and a farthest connected tile once one is laid', () => {
    const world = new GameWorld();
    const management = new ManagementSimulation(world);
    expect(management.connectivity().tip).toBeNull();
    world.buildPaths([{ x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }]);
    const first = management.connectivity();
    expect(first.pathTiles).toBe(3);
    expect(first.tip).toEqual({ x: 15, y: 28 });
    // Cached for the same world version: the very same cell comes back.
    expect(management.connectivity().tip).toBe(first.tip);
  });

  it('ignores a path that is not joined to the gate', () => {
    const world = new GameWorld();
    const management = new ManagementSimulation(world);
    world.buildPaths([{ x: 5, y: 5 }, { x: 5, y: 6 }]);
    expect(management.connectivity().tip).toBeNull();
  });
});

describe('Phase 16: the scenery factor display detail', () => {
  it('says the score is the average appeal around the rides and services, and names the path fallback as one', () => {
    const paths = new GameWorld();
    paths.buildPaths([{ x: 15, y: 30 }, { x: 15, y: 29 }]);
    const pathScenery = new ScenerySimulation(paths);
    expect(sceneryFactorDetail(pathScenery.snapshot())).toBe(`No rides or services yet: scored on decorated paths (0 of ${pathScenery.snapshot().connectedPathTiles}).`);
    expect(paths.buildObject('confetti-tree', { x: 14, y: 30 })).not.toBeNull();
    expect(sceneryFactorDetail(pathScenery.snapshot())).toMatch(/^No rides or services yet: scored on decorated paths \(\d+ of \d+\)\.$/);

    const { world } = createConnectedPark();
    const scenery = new ScenerySimulation(world);
    expect(sceneryFactorDetail(scenery.snapshot())).toBe('Average scenery appeal around your 2 rides and services; 0 scenery pieces.');
    expect(world.buildObject('confetti-tree', { x: 14, y: 30 })).not.toBeNull();
    expect(sceneryFactorDetail(scenery.snapshot())).toBe('Average scenery appeal around your 2 rides and services; 1 scenery piece.');
    const one = { ...scenery.snapshot(), destinations: scenery.snapshot().destinations.slice(0, 1) };
    expect(sceneryFactorDetail(one)).toBe('Average scenery appeal around your 1 ride or service; 1 scenery piece.');
  });
});
