import { describe, expect, it } from 'vitest';
import type { Guest } from '../guests/types';
import { RideSimulation } from '../rides/RideSimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { GameWorld } from '../World';
import { OperationsSimulation } from './OperationsSimulation';

const createGuest = (id: number, overrides: Partial<Guest> = {}): Guest => ({
  id,
  position: { x: 15, y: 28 },
  currentCell: { x: 15, y: 28 },
  route: [{ x: 15, y: 28 }],
  routeIndex: 1,
  routeVersion: 0,
  state: 'wandering',
  destinationObjectId: null,
  money: 200,
  happiness: 70,
  hunger: 90,
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
  stateTimerSeconds: 10,
  needTimerSeconds: 0,
  color: 0xffffff,
  accent: 0xffffff,
  nausea: 0,
  warmth: 50,
  souvenirs: 0,
  activity: null,
  ...overrides,
});

const connectedCells = (lastY = 24) => {
  const cells = [];
  for (let y = 30; y >= lastY; y -= 1) cells.push({ x: 15, y });
  return cells;
};

const createOperations = (world: GameWorld) => {
  const rides = new RideSimulation(world);
  const shops = new ShopSimulation(world);
  const operations = new OperationsSimulation(world, rides, shops);
  return { rides, shops, operations };
};

describe('operations waste and bins', () => {
  it('routes successful takeaway waste into a nearby bin, then spills when it is full', () => {
    const world = new GameWorld();
    world.buildPaths(connectedCells());
    const food = world.buildObject('picnic-pocket', { x: 16, y: 28 });
    const bin = world.buildObject('tidy-totem', { x: 16, y: 26 });
    if (!food || !bin) throw new Error('Service and bin should be placeable');
    const { shops, operations } = createOperations(world);
    const guest = createGuest(1);
    const guests = new Map([[guest.id, guest]]);

    for (let purchase = 0; purchase < 10; purchase += 1) {
      guest.hunger = 90;
      expect(shops.joinQueue(food.id, guest)).toBe('joined');
      shops.step(3_200, guests);
      operations.step(0, guests);
    }

    expect(operations.getBin(bin.id)?.fill).toBe(10);
    expect(operations.snapshot().cleanliness.litterUnits).toBe(0);

    guest.hunger = 90;
    shops.joinQueue(food.id, guest);
    shops.step(3_200, guests);
    operations.step(0, guests);

    expect(operations.getBin(bin.id)?.fill).toBe(10);
    expect(operations.litter.get('15,28')?.units).toBe(1);
    expect(operations.snapshot().cleanliness).toMatchObject({ binsFull: 1, dirtyPathTiles: 1, litterUnits: 1 });

    operations.step(0, guests);
    expect(operations.litter.get('15,28')?.units).toBe(1);
  });

  it('caps litter globally and relocates an invalid drop to an entrance-connected path', () => {
    const world = new GameWorld();
    world.buildPaths(connectedCells(29));
    const { operations } = createOperations(world);

    expect(operations.addLitter({ x: 20, y: 20 }, 500)).toBe(300);
    expect(operations.snapshot().cleanliness.litterUnits).toBe(300);
    expect(operations.snapshot().litter[0].cell).toEqual({ x: 15, y: 29 });
    expect(operations.addLitter({ x: 15, y: 29 }, 1)).toBe(0);
  });
});

describe('cleaners and guest cleanliness', () => {
  it('prioritizes a full bin, reserves tasks, then removes litter one unit at a time', () => {
    const world = new GameWorld();
    world.buildPaths(connectedCells());
    const bin = world.buildObject('tidy-totem', { x: 16, y: 26 });
    if (!bin) throw new Error('Bin should be placeable');
    const { operations } = createOperations(world);
    operations.getBin(bin.id)!.fill = 10;
    operations.addLitter({ x: 15, y: 29 }, 2);
    const first = operations.hireStaff('cleaner')!;
    const second = operations.hireStaff('cleaner')!;

    operations.step(0, new Map());
    expect(first.task).toMatchObject({ kind: 'emptyBin', targetObjectId: bin.id });
    expect(second.task).toMatchObject({ kind: 'cleanLitter' });
    expect(operations.getBin(bin.id)?.assignedCleanerId).toBe(first.id);
    expect(operations.litter.get('15,29')?.assignedCleanerId).toBe(second.id);

    operations.step(6_000, new Map());
    expect(operations.getBin(bin.id)?.fill).toBe(0);
    expect(operations.litter.has('15,29')).toBe(false);
    expect(first.state).toBe('idle');
    expect(second.state).toBe('idle');
  });

  it('does not assign disconnected work and releases stale work when a path is removed', () => {
    const world = new GameWorld();
    world.buildPaths(connectedCells(28));
    world.buildPaths([{ x: 2, y: 2 }]);
    const { operations } = createOperations(world);
    operations.addLitter({ x: 2, y: 2 }, 1);
    const cleaner = operations.hireStaff('cleaner')!;

    operations.step(0, new Map());
    expect(cleaner.task).toBeNull();

    operations.addLitter({ x: 15, y: 28 }, 1);
    operations.step(0, new Map());
    expect(cleaner.task?.kind).toBe('cleanLitter');
    world.bulldoze({ x: 15, y: 28 });
    operations.step(0, new Map());
    expect(cleaner.task).toBeNull();
    expect(operations.litter.has('15,28')).toBe(false);
  });

  it('applies bounded local happiness loss and publishes an explainable cleanliness score', () => {
    const world = new GameWorld();
    world.buildPaths(connectedCells(28));
    const { operations } = createOperations(world);
    const guest = createGuest(1, { currentCell: { x: 15, y: 28 }, happiness: 70 });
    operations.addLitter({ x: 15, y: 28 }, 3);

    operations.step(4_000, new Map([[guest.id, guest]]));

    expect(guest.happiness).toBeCloseTo(68.8);
    expect(guest.currentThought).toBe('This area is messy.');
    // Phase 30: the litter thought is not a complaint about a building, so a stale complaint link is cleared with it.
    const linked = createGuest(2, { currentCell: { x: 15, y: 28 }, currentThought: 'This queue is taking forever.', thoughtObjectId: 42 });
    operations.step(4_000, new Map([[linked.id, linked]]));
    expect(linked.currentThought).toBe('This area is messy.');
    expect(linked.thoughtObjectId).toBeNull();
    expect(operations.snapshot().cleanliness).toMatchObject({
      score: 37.5,
      litterUnits: 3,
      dirtyPathTiles: 1,
    });
  });
});

describe('staff payroll and mechanics', () => {
  it('charges the first shift and deterministic payroll while closed, but never on a zero step', () => {
    const oneStepWorld = new GameWorld();
    const oneStep = createOperations(oneStepWorld).operations;
    const cashBefore = oneStepWorld.cash;
    oneStep.hireStaff('cleaner');
    expect(oneStepWorld.cash).toBe(cashBefore - 12);
    oneStep.step(0, new Map());
    expect(oneStepWorld.cash).toBe(cashBefore - 12);
    oneStepWorld.setParkOpen(false);
    oneStep.step(30_000, new Map());

    const fixedWorld = new GameWorld();
    const fixed = createOperations(fixedWorld).operations;
    fixed.hireStaff('cleaner');
    fixedWorld.setParkOpen(false);
    for (let tick = 0; tick < 300; tick += 1) fixed.step(100, new Map());

    expect(oneStepWorld.cash).toBe(cashBefore - 24);
    expect(fixedWorld.cash).toBe(oneStepWorld.cash);
    expect(oneStepWorld.transactions.filter((transaction) => transaction.category === 'staff-salaries')).toHaveLength(2);
    expect(fixedWorld.transactions.filter((transaction) => transaction.category === 'staff-salaries')).toHaveLength(2);
  });

  it('repairs a broken ride before inspecting a more worn ride and posts maintenance once', () => {
    const world = new GameWorld();
    world.buildPaths(connectedCells(23));
    const wornObject = world.buildObject('petal-roundabout', { x: 12, y: 27 });
    const brokenObject = world.buildObject('comet-cups', { x: 16, y: 23 });
    if (!wornObject || !brokenObject) throw new Error('Rides should be placeable');
    const { rides, operations } = createOperations(world);
    const worn = rides.getRide(wornObject.id)!;
    const broken = rides.getRide(brokenObject.id)!;
    worn.condition = 20;
    broken.condition = 55;
    broken.broken = true;
    broken.status = 'broken';
    const mechanic = operations.hireStaff('mechanic')!;
    const cashAfterHire = world.cash;

    operations.step(0, new Map());
    expect(mechanic.task).toMatchObject({ kind: 'repairRide', targetObjectId: brokenObject.id });
    expect(operations.snapshot().maintenance).toMatchObject({ brokenRides: 1, awaitingMechanic: 0 });

    operations.step(20_000, new Map());

    expect(broken.broken).toBe(false);
    expect(broken.condition).toBe(90);
    expect(broken.repairsCompleted).toBe(1);
    expect(world.cash).toBe(cashAfterHire - 44);
    expect(world.transactions.filter((transaction) => transaction.category === 'maintenance')).toHaveLength(1);
    expect(mechanic.task).toBeNull();
  });

  it('cancels and releases a reserved task when its worker is fired', () => {
    const world = new GameWorld();
    world.buildPaths(connectedCells(28));
    const { operations } = createOperations(world);
    operations.addLitter({ x: 15, y: 28 }, 2);
    const cleaner = operations.hireStaff('cleaner')!;
    operations.step(0, new Map());
    expect(operations.litter.get('15,28')?.assignedCleanerId).toBe(cleaner.id);

    expect(operations.fireStaff('cleaner')?.id).toBe(cleaner.id);
    expect(operations.litter.get('15,28')?.assignedCleanerId).toBeNull();
    expect(operations.snapshot().staff.cleaners.total).toBe(0);
  });
});

describe('staff scaling and training', () => {
  it('grows the crew cap with the crowd instead of a fixed ceiling', () => {
    const world = new GameWorld();
    world.buildPaths(connectedCells());
    const { operations } = createOperations(world);

    expect(operations.staffCapacity()).toBe(6);
    for (let index = 0; index < 6; index += 1) expect(operations.hireStaff('cleaner')).not.toBeNull();
    expect(operations.hireStaff('cleaner')).toBeNull();

    // A busier park earns more crew room: one extra hire per 100 guests.
    const guests = new Map<number, Guest>();
    for (let id = 1; id <= 250; id += 1) guests.set(id, createGuest(id));
    operations.step(100, guests);
    expect(operations.staffCapacity()).toBe(8);
    expect(operations.hireStaff('cleaner')).not.toBeNull();
    expect(operations.hireStaff('cleaner')).not.toBeNull();
    expect(operations.hireStaff('cleaner')).toBeNull();
    // Roles have separate room, and mechanics were untouched by cleaner hiring.
    expect(operations.hireStaff('mechanic')).not.toBeNull();
  });

  it('trains a crew for cash, making it work faster and cost more', () => {
    const world = new GameWorld();
    world.buildPaths(connectedCells());
    const { operations } = createOperations(world);
    const guests = new Map<number, Guest>();

    // Training needs someone to train.
    expect(operations.trainStaff('cleaner')).toEqual({ ok: false, reason: 'noStaff' });
    operations.hireStaff('cleaner');
    const untrainedSalary = operations.snapshot().staff.cleaners.salaryPerInterval;

    const cost = operations.trainingCost('cleaner')!;
    const cashBefore = world.cash;
    expect(operations.trainStaff('cleaner')).toEqual({ ok: true, level: 1, cost });
    expect(world.cash).toBe(cashBefore - cost);
    expect(world.transactions[0].category).toBe('staff-salaries');

    const trained = operations.snapshot().staff.cleaners;
    expect(trained.trainingLevel).toBe(1);
    expect(trained.salaryPerInterval).toBeGreaterThan(untrainedSalary);
    // Each level costs more than the last, and the crew tops out.
    expect(operations.trainingCost('cleaner')).toBeGreaterThan(cost);
    operations.trainStaff('cleaner');
    operations.trainStaff('cleaner');
    expect(operations.staffTrainingLevel('cleaner')).toBe(3);
    expect(operations.trainingCost('cleaner')).toBeNull();
    expect(operations.trainStaff('cleaner')).toEqual({ ok: false, reason: 'maxLevel' });

    // A trained cleaner clears the same litter pile faster.
    operations.addLitter({ x: 15, y: 28 }, 4);
    operations.step(100, guests);
    const trainedTask = operations.snapshot().workers[0].task;
    expect(trainedTask?.kind).toBe('cleanLitter');

    const plainWorld = new GameWorld();
    plainWorld.buildPaths(connectedCells());
    const plain = createOperations(plainWorld);
    plain.operations.hireStaff('cleaner');
    plain.operations.addLitter({ x: 15, y: 28 }, 4);
    plain.operations.step(100, guests);

    const secondsToClear = (simulation: OperationsSimulation): number => {
      let seconds = 0;
      const localGuests = new Map<number, Guest>();
      while (simulation.snapshot().cleanliness.litterUnits > 0 && seconds < 200) {
        simulation.step(100, localGuests);
        seconds += 0.1;
      }
      return Math.round(seconds * 10) / 10;
    };
    expect(secondsToClear(operations)).toBeLessThan(secondsToClear(plain.operations));
  });

  it('refuses training the park cannot pay for', () => {
    const world = new GameWorld();
    world.buildPaths(connectedCells());
    const { operations } = createOperations(world);
    operations.hireStaff('mechanic');
    world.cash = 10;
    expect(operations.trainStaff('mechanic')).toEqual({ ok: false, reason: 'funds' });
    expect(operations.staffTrainingLevel('mechanic')).toBe(0);
  });
});

/**
 * PA-028. Wages bill whether or not the park is open — deliberately, so keeping the gates shut is
 * not a free way to build. That only works if a park cannot take on a crew it has no way to pay:
 * hiring at $0 used to succeed and charge the first shift anyway, straight into debt.
 */
describe('hiring requires the wages to be covered', () => {
  const park = (cash: number) => {
    const world = new GameWorld(cash);
    world.buildPaths(connectedCells());
    return { world, ...createOperations(world) };
  };

  it('refuses a hire the park cannot pay for, and says what it needs', () => {
    const { operations } = park(0);
    const block = operations.hireBlock('cleaner');
    expect(block).toEqual({ reason: 'funds', required: expect.any(Number), available: 0 });
    expect(operations.hireStaff('cleaner')).toBeNull();
    expect(operations.snapshot().workers).toHaveLength(0);
  });

  it('never lets a hire be the thing that pushes the park into debt', () => {
    const { world, operations } = park(20);
    // Measured after the fixture paths are paid for, not from the constructor figure.
    const before = world.cash;
    expect(operations.hireStaff('cleaner')).toBeNull();
    expect(world.cash).toBe(before);
  });

  it('counts the existing crew, so the last affordable hire is the last one paid for', () => {
    const { world, operations } = park(200);
    let hired = 0;
    while (operations.hireStaff('cleaner') !== null) hired += 1;
    expect(hired).toBeGreaterThan(0);
    // Whatever it stopped at, one more shift for the whole crew is still covered.
    const crewShift = operations.snapshot().staff.cleaners.total
      * operations.snapshot().staff.cleaners.salaryPerInterval;
    expect(world.cash).toBeGreaterThanOrEqual(crewShift);
  });

  it('still reports a full crew as a capacity problem, not a money one', () => {
    const { operations } = park(100_000);
    for (let index = 0; index < 6; index += 1) expect(operations.hireStaff('cleaner')).not.toBeNull();
    expect(operations.hireBlock('cleaner')).toEqual({ reason: 'capacity', capacity: 6 });
  });

  it('lets a well-funded park hire freely', () => {
    const { operations } = park(100_000);
    expect(operations.hireBlock('mechanic')).toBeNull();
    expect(operations.hireStaff('mechanic')).not.toBeNull();
  });
});
