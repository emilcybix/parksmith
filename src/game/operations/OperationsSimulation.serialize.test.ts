import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import type { Guest } from '../guests/types';
import { RideSimulation } from '../rides/RideSimulation';
import { hashState } from '../save/hash';
import { assertPlainData, assertStructuredCloneSafe, auditOwnProperties, plainDeepEqual } from '../save/plainData';
import type { OperationsState } from '../save/state';
import { SaveError } from '../save/version';
import { ShopSimulation } from '../shops/ShopSimulation';
import type { Cell } from '../types';
import { GameWorld } from '../World';
import { OperationsSimulation } from './OperationsSimulation';
import type { StaffRuntime } from './types';

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

type Edit = (world: GameWorld) => void;

interface Scenario {
  world: GameWorld;
  rides: RideSimulation;
  shops: ShopSimulation;
  operations: OperationsSimulation;
  /** World edits made after construction, replayed on a twin so both worlds match. */
  edits: Edit[];
  binId: number;
  wornRideId: number;
  brokenRideId: number;
}

/** Entrance (15,31), a straight path north to y=23, one bin, a worn ride and a ride to break. */
const buildScenario = (): Scenario => {
  const world = new GameWorld();
  world.cash = 1_000_000;
  const cells: Cell[] = [];
  for (let y = 30; y >= 23; y -= 1) cells.push({ x: 15, y });
  world.buildPaths(cells);
  const bin = world.buildObject('tidy-totem', { x: 16, y: 26 });
  const worn = world.buildObject('petal-roundabout', { x: 12, y: 27 });
  const broken = world.buildObject('comet-cups', { x: 16, y: 23 });
  // A second, idle bin (built last so the ids above are unchanged) gives the Maps two entries.
  const spare = world.buildObject('tidy-totem', { x: 14, y: 24 });
  if (!bin || !worn || !broken || !spare) throw new Error('Scenario objects should be placeable');
  const rides = new RideSimulation(world);
  const shops = new ShopSimulation(world);
  const operations = new OperationsSimulation(world, rides, shops);
  return { world, rides, shops, operations, edits: [], binId: bin.id, wornRideId: worn.id, brokenRideId: broken.id };
};

const edit = (scenario: Scenario, change: Edit): void => {
  change(scenario.world);
  scenario.edits.push(change);
};

/**
 * A second, independent copy of the scenario at the same instant. GameWorld has no save yet, so
 * the twin replays the edits and copies the plain counters; ride runtimes are plain data and are
 * cloned (they are the rides owner's state and must match for mechanic invariants).
 */
const twinOf = (source: Scenario): Scenario => {
  const target = buildScenario();
  for (const change of source.edits) edit(target, change);
  target.world.cash = source.world.cash;
  target.world.tick = source.world.tick;
  expect(target.world.pathVersion, 'twin world must reach the same pathVersion').toBe(source.world.pathVersion);
  for (const [id, ride] of source.rides.rides) {
    Object.assign(target.rides.rides.get(id)!, structuredClone(ride));
  }
  return target;
};

const run = (scenario: Scenario, ticks: number, guests: Map<number, Guest> = new Map()): void => {
  for (let tick = 0; tick < ticks; tick += 1) scenario.operations.step(100, guests);
};

const runUntil = (scenario: Scenario, condition: () => boolean, limit: number, what: string): void => {
  for (let tick = 0; tick < limit && !condition(); tick += 1) scenario.operations.step(100, new Map());
  if (!condition()) throw new Error(`scenario never reached: ${what}`);
};

const salaryTransactions = (world: GameWorld, count: number) => (
  world.transactions.slice(0, count).map(({ amount, label, category, tick }) => ({ amount, label, category, tick }))
);

/**
 * Steps both scenarios in lockstep and compares the complete serialized operations state, the
 * rides' runtimes, cash and the posted transactions after EVERY tick.
 */
const expectContinuation = (
  reference: Scenario,
  restored: Scenario,
  ticks: number,
  guests?: { reference: Map<number, Guest>; restored: Map<number, Guest> },
): void => {
  const referenceBefore = reference.world.transactions.length;
  const restoredBefore = restored.world.transactions.length;
  for (let tick = 0; tick < ticks; tick += 1) {
    reference.world.tick += 1;
    restored.world.tick += 1;
    reference.operations.step(100, guests?.reference ?? new Map());
    restored.operations.step(100, guests?.restored ?? new Map());
    const a = hashState(reference.operations.serialize());
    const b = hashState(restored.operations.serialize());
    if (a !== b) {
      expect(restored.operations.serialize(), `operations diverged at continuation tick ${tick}`)
        .toEqual(reference.operations.serialize());
    }
    if (!plainDeepEqual([...reference.rides.rides.values()], [...restored.rides.rides.values()])) {
      expect([...restored.rides.rides.values()], `rides diverged at continuation tick ${tick}`)
        .toEqual([...reference.rides.rides.values()]);
    }
    expect(restored.world.cash, `cash at continuation tick ${tick}`).toBe(reference.world.cash);
    if (guests) {
      expect([...guests.restored.values()], `guests at continuation tick ${tick}`)
        .toEqual([...guests.reference.values()]);
    }
  }
  const newReference = reference.world.transactions.length - referenceBefore;
  const newRestored = restored.world.transactions.length - restoredBefore;
  expect(newRestored, 'same number of new transactions').toBe(newReference);
  expect(salaryTransactions(restored.world, newRestored)).toEqual(salaryTransactions(reference.world, newReference));
};

const roundTrip = (source: Scenario): { target: Scenario; state: OperationsState } => {
  const state = source.operations.serialize();
  const target = twinOf(source);
  target.operations.restore(JSON.parse(JSON.stringify(state)) as OperationsState);
  return { target, state };
};

const breakRide = (scenario: Scenario): void => {
  const ride = scenario.rides.getRide(scenario.brokenRideId)!;
  ride.condition = 55;
  ride.broken = true;
  ride.status = 'broken';
};

const wearRideWhileRunning = (scenario: Scenario): void => {
  const ride = scenario.rides.getRide(scenario.wornRideId)!;
  ride.condition = 20;
  ride.status = 'running';
  ride.cycleRemainingSeconds = 100_000;
};

const workerOf = (scenario: Scenario, id: number): StaffRuntime => scenario.operations.staff.get(id)!;

/** Every kind of staff state at once: emptyBin, cleanLitter, repair (started), inspect (waiting). */
const richScenario = (): Scenario => {
  const scenario = buildScenario();
  const { operations } = scenario;
  breakRide(scenario);
  wearRideWhileRunning(scenario);
  operations.getBin(scenario.binId)!.fill = 10;
  operations.addLitter({ x: 15, y: 29 }, 3);
  operations.addLitter({ x: 15, y: 25 }, 2);
  operations.hireStaff('cleaner');
  operations.hireStaff('cleaner');
  operations.hireStaff('mechanic');
  operations.hireStaff('mechanic');
  operations.trainStaff('cleaner');
  operations.step(0, new Map());
  runUntil(
    scenario,
    () => workerOf(scenario, 3).state === 'working' && workerOf(scenario, 4).state === 'waiting',
    200,
    'mechanic 3 repairing and mechanic 4 waiting',
  );
  return scenario;
};

describe('OperationsSimulation serialize', () => {
  it('writes plain, structured-clone-safe, JSON-stable data covering every kind of worker state', () => {
    const scenario = richScenario();
    const state = scenario.operations.serialize();
    assertPlainData(state);
    assertStructuredCloneSafe(state);
    expect(plainDeepEqual(JSON.parse(JSON.stringify(state)), state), 'JSON round trip is byte identical').toBe(true);
    expect(state.staff.map((worker) => worker.state)).toContain('waiting');
    expect(state.staff.map((worker) => worker.state)).toContain('working');
    expect(state.staff.some((worker) => worker.task?.maintenanceStarted === true)).toBe(true);
    expect(state.staff.some((worker) => worker.task?.kind === 'emptyBin')).toBe(true);
    expect(state.staff.some((worker) => worker.task?.kind === 'cleanLitter')).toBe(true);
    expect(state.trainingLevel).toEqual({ cleaner: 1, mechanic: 0 });
    expect(Object.keys(state.bins[0]), 'capacity is derived, not saved').not.toContain('capacity');
  });

  it('is pure: serializing neither changes state nor reorders the Maps', () => {
    const scenario = richScenario();
    const first = scenario.operations.serialize();
    const orderBefore = [...scenario.operations.litter.keys()];
    const second = scenario.operations.serialize();
    expect(plainDeepEqual(first, second)).toBe(true);
    expect([...scenario.operations.litter.keys()]).toEqual(orderBefore);
    expect(scenario.operations.navigation.getPathVersion(), 'serialize does not sync navigation').toBe(
      scenario.operations.navigation.getPathVersion(),
    );
  });

  it('serialize does not touch the navigation cache even when the world moved on', () => {
    const scenario = buildScenario();
    const before = scenario.operations.navigation.getPathVersion();
    scenario.world.buildPaths([{ x: 14, y: 30 }]);
    scenario.operations.serialize();
    expect(scenario.operations.navigation.getPathVersion()).toBe(before);
  });

  it('round trips: restoring into a fresh twin gives equal state, equal hash, and a no-op sync', () => {
    const source = richScenario();
    const { target, state } = roundTrip(source);
    const again = target.operations.serialize();
    expect(again).toEqual(state);
    expect(hashState(again)).toBe(hashState(state));
  });

  it('restoring into a dirty instance equals restoring into a fresh one, keeping container identity', () => {
    const source = richScenario();
    const state = source.operations.serialize();
    const fresh = twinOf(source);
    fresh.operations.restore(state);

    const dirty = twinOf(source);
    dirty.operations.hireStaff('cleaner');
    dirty.operations.hireStaff('cleaner');
    dirty.operations.addLitter({ x: 15, y: 27 }, 4);
    dirty.operations.getBin(dirty.binId)!.fill = 3;
    dirty.operations.trainStaff('cleaner');
    dirty.operations.trainStaff('cleaner');
    dirty.operations.step(0, new Map());
    run(dirty, 30);
    const { bins, litter, staff, navigation } = dirty.operations;
    dirty.operations.restore(state);
    expect(dirty.operations.bins).toBe(bins);
    expect(dirty.operations.litter).toBe(litter);
    expect(dirty.operations.staff).toBe(staff);
    expect(dirty.operations.navigation).toBe(navigation);
    expect(dirty.operations.serialize()).toEqual(fresh.operations.serialize());
    expect(hashState(dirty.operations.serialize())).toBe(hashState(state));
    expect(dirty.operations.staffTrainingLevel('cleaner')).toBe(1);
  });

  it('restore posts nothing and touches no ride', () => {
    const source = richScenario();
    const target = twinOf(source);
    const cash = target.world.cash;
    const transactions = target.world.transactions.length;
    const ridesBefore = hashState([...target.rides.rides.values()].map((ride) => structuredClone(ride)), { normalizeNegativeZero: true });
    target.operations.restore(source.operations.serialize());
    expect(target.world.cash).toBe(cash);
    expect(target.world.transactions.length).toBe(transactions);
    expect(hashState([...target.rides.rides.values()].map((ride) => structuredClone(ride)), { normalizeNegativeZero: true })).toBe(ridesBefore);
  });

  it('continues a rich mixed state identically for 400 ticks (assignments, repair, inspection, payroll)', () => {
    const source = richScenario();
    const { target } = roundTrip(source);
    expectContinuation(source, target, 400);
    expect(source.operations.serialize().staff.length).toBe(4);
  });

  it('continues a cleaner caught mid-walk', () => {
    const source = buildScenario();
    source.operations.getBin(source.binId)!.fill = 10;
    source.operations.hireStaff('cleaner');
    source.operations.step(0, new Map());
    run(source, 3);
    const worker = workerOf(source, 1);
    expect(worker.state).toBe('walking');
    expect(Number.isInteger(worker.position.y), 'caught between cells').toBe(false);
    const { target } = roundTrip(source);
    expect(workerOf(target, 1).position).toEqual(worker.position);
    expect(workerOf(target, 1).route).toEqual(worker.route);
    expectContinuation(source, target, 120);
  });

  it('continues a mechanic waiting for a running ride', () => {
    const source = buildScenario();
    wearRideWhileRunning(source);
    source.operations.hireStaff('mechanic');
    source.operations.step(0, new Map());
    runUntil(source, () => workerOf(source, 1).state === 'waiting', 200, 'waiting mechanic');
    expect(workerOf(source, 1).task?.maintenanceStarted).toBe(false);
    const { target } = roundTrip(source);
    expect(workerOf(target, 1).state).toBe('waiting');
    // Let the ride go idle in both worlds: the mechanic must start work on the same tick.
    for (const scenario of [source, target]) scenario.rides.getRide(scenario.wornRideId)!.status = 'idle';
    expectContinuation(source, target, 150);
    expect(source.rides.getRide(source.wornRideId)!.inspectionsCompleted).toBe(1);
  });

  it('continues a mechanic mid-repair with maintenanceStarted', () => {
    const source = buildScenario();
    breakRide(source);
    source.operations.hireStaff('mechanic');
    source.operations.step(0, new Map());
    runUntil(source, () => workerOf(source, 1).state === 'working', 200, 'working mechanic');
    run(source, 20);
    const task = workerOf(source, 1).task!;
    expect(task.maintenanceStarted).toBe(true);
    expect(task.workRemainingSeconds).toBeLessThan(task.workDurationSeconds);
    const { target } = roundTrip(source);
    expectContinuation(source, target, 160);
    expect(source.rides.getRide(source.brokenRideId)!.repairsCompleted).toBe(1);
  });

  it('keeps a stale route (routeVersion behind pathVersion) and reroutes like the reference', () => {
    const source = buildScenario();
    source.operations.addLitter({ x: 15, y: 24 }, 2);
    source.operations.hireStaff('cleaner');
    source.operations.step(0, new Map());
    run(source, 4);
    expect(workerOf(source, 1).state).toBe('walking');
    edit(source, (world) => { world.buildPaths([{ x: 14, y: 30 }, { x: 14, y: 29 }]); });
    const worker = workerOf(source, 1);
    expect(worker.routeVersion, 'edit left the route stale').not.toBe(source.world.pathVersion);
    const { target, state } = roundTrip(source);
    expect(workerOf(target, 1).routeVersion, 'never fixed on restore').toBe(worker.routeVersion);
    expect(target.operations.serialize()).toEqual(state);
    expectContinuation(source, target, 160);
    expect(source.operations.litter.size, 'pile was cleaned').toBe(0);
  });

  it('keeps a partially cleaned pile and its assignment', () => {
    const source = buildScenario();
    source.operations.addLitter({ x: 15, y: 29 }, 4);
    source.operations.hireStaff('cleaner');
    source.operations.step(0, new Map());
    runUntil(source, () => (source.operations.litter.get('15,29')?.units ?? 9) === 3, 200, 'one unit cleaned');
    expect(source.operations.litter.get('15,29')?.assignedCleanerId).toBe(1);
    const { target } = roundTrip(source);
    expect(target.operations.litter.get('15,29')).toEqual({ cell: { x: 15, y: 29 }, units: 3, assignedCleanerId: 1, sick: false });
    expectContinuation(source, target, 80);
    expect(source.operations.litter.size).toBe(0);
  });

  it('Phase 29: keeps a sick pile sick (the flag is written only for it), and cleaning it clears it', () => {
    const source = buildScenario();
    expect(source.operations.addSick({ x: 15, y: 28 })).toBe(GAME_CONFIG.operations.litter.sickUnits);
    source.operations.addLitter({ x: 15, y: 25 }, 1);
    expect(source.operations.litter.get('15,28')).toMatchObject({ units: GAME_CONFIG.operations.litter.sickUnits, sick: true });
    const { target, state } = roundTrip(source);
    expect(state.litter.map((pile) => 'sick' in pile)).toEqual([true, false]);
    expect(target.operations.litter.get('15,28')?.sick).toBe(true);
    expect(target.operations.litter.get('15,25')?.sick).toBe(false);
    expect(target.operations.snapshot().litter.map((pile) => pile.sick)).toEqual([false, true]);
    // A sick pile with litter dropped on it stays sick.
    source.operations.addLitter({ x: 15, y: 28 }, 1);
    expect(source.operations.litter.get('15,28')?.sick).toBe(true);
    source.operations.hireStaff('cleaner');
    source.operations.step(0, new Map());
    runUntil(source, () => source.operations.litter.size === 0, 2_000, 'every pile cleaned');
    expect(() => target.operations.restore({ ...state, litter: [{ ...state.litter[0], sick: false as unknown as true }] })).toThrow(/sick/);
  });

  it('keeps a full bin with its assigned cleaner and the litter Map order', () => {
    const source = buildScenario();
    source.operations.getBin(source.binId)!.fill = 10;
    source.operations.addLitter({ x: 15, y: 29 }, 1);
    source.operations.addLitter({ x: 15, y: 25 }, 1);
    source.operations.addLitter({ x: 15, y: 27 }, 1);
    source.operations.hireStaff('cleaner');
    source.operations.step(0, new Map());
    const { target, state } = roundTrip(source);
    expect(state.litter.map((pile) => pile.cell.y), 'insertion order, not sorted order').toEqual([29, 25, 27]);
    expect([...target.operations.litter.keys()]).toEqual(['15,29', '15,25', '15,27']);
    expect(target.operations.getBin(target.binId)).toMatchObject({ fill: 10, assignedCleanerId: 1, capacity: 10 });
    expectContinuation(source, target, 300);
  });

  it('never reuses the id of a fired highest-id worker', () => {
    const source = buildScenario();
    for (let count = 0; count < 3; count += 1) source.operations.hireStaff('cleaner');
    expect(source.operations.fireStaff('cleaner')?.id).toBe(3);
    const state = source.operations.serialize();
    expect(Math.max(...state.staff.map((worker) => worker.id))).toBe(2);
    expect(state.nextStaffId).toBe(4);
    const { target } = roundTrip(source);
    expect(target.operations.hireStaff('cleaner')?.id).toBe(source.operations.hireStaff('cleaner')?.id);
    expect(target.operations.serialize()).toEqual(source.operations.serialize());
  });

  it('keeps training levels: wages, work time and walking speed continue identically', () => {
    const source = buildScenario();
    source.operations.hireStaff('cleaner');
    source.operations.hireStaff('mechanic');
    source.operations.trainStaff('cleaner');
    source.operations.trainStaff('cleaner');
    source.operations.trainStaff('mechanic');
    source.operations.getBin(source.binId)!.fill = 10;
    breakRide(source);
    source.operations.step(0, new Map());
    const { target } = roundTrip(source);
    expect(target.operations.staffTrainingLevel('cleaner')).toBe(2);
    expect(target.operations.staffTrainingLevel('mechanic')).toBe(1);
    expect(target.operations.snapshot().staff).toEqual(source.operations.snapshot().staff);
    expectContinuation(source, target, 400);
  });

  it('keeps payroll mid-interval: the same wages post on the same ticks', () => {
    const source = buildScenario();
    source.operations.hireStaff('cleaner');
    source.operations.hireStaff('mechanic');
    run(source, 250);
    const { target, state } = roundTrip(source);
    expect(state.staff[0].payrollRemainingSeconds).toBeGreaterThan(0);
    expect(state.staff[0].payrollRemainingSeconds).toBeLessThan(30);
    const before = source.world.transactions.length;
    expectContinuation(source, target, 400);
    const posted = source.world.transactions.slice(0, source.world.transactions.length - before);
    expect(posted.filter((transaction) => transaction.category === 'staff-salaries').length, 'wages posted').toBeGreaterThan(0);
  });

  it('keeps the guest happiness interval remainder so the penalty lands on the same tick', () => {
    const source = buildScenario();
    source.operations.addLitter({ x: 15, y: 29 }, 2);
    const guestsReference = new Map([[1, createGuest(1, { currentCell: { x: 15, y: 29 } })]]);
    run(source, 35, guestsReference);
    expect(source.operations.serialize().happinessAccumulatorSeconds).toBeGreaterThan(3);
    const { target } = roundTrip(source);
    const guestsRestored = new Map([...guestsReference].map(([id, guest]) => [id, structuredClone(guest)]));
    const happinessBefore = guestsReference.get(1)!.happiness;
    expectContinuation(source, target, 10, { reference: guestsReference, restored: guestsRestored });
    expect(guestsReference.get(1)!.happiness, 'the penalty fired during the continuation').toBeLessThan(happinessBefore);
  });

  it('keeps guestPopulation, so hire gating is right before the first step', () => {
    const source = buildScenario();
    const crowd = new Map<number, Guest>();
    for (let id = 1; id <= 250; id += 1) crowd.set(id, createGuest(id));
    source.operations.step(100, crowd);
    while (source.operations.hireStaff('cleaner')) { /* hire up to the crowd-scaled cap */ }
    expect(source.operations.staffCapacity()).toBe(8);
    expect(source.operations.hireBlock('cleaner')).toEqual({ reason: 'capacity', capacity: 8 });
    const { target } = roundTrip(source);
    expect(target.operations.staffCapacity()).toBe(8);
    expect(target.operations.hireBlock('cleaner')).toEqual({ reason: 'capacity', capacity: 8 });
    expect(target.operations.hireBlock('mechanic')).toBeNull();
  });

  it('restores an empty operations state', () => {
    const source = buildScenario();
    const dirty = buildScenario();
    dirty.operations.hireStaff('cleaner');
    dirty.operations.addLitter({ x: 15, y: 28 }, 1);
    dirty.operations.restore(source.operations.serialize());
    expect(dirty.operations.serialize()).toEqual(source.operations.serialize());
    expect(dirty.operations.staff.size).toBe(0);
    expect(dirty.operations.litter.size).toBe(0);
  });
});

describe('OperationsSimulation restore validation', () => {
  type Mutation = [string, (state: OperationsState) => void];

  const cases: Mutation[] = [
    ['duplicate staff id', (state) => { state.staff[1].id = state.staff[0].id; }],
    ['nextStaffId not above max id', (state) => { state.nextStaffId = Math.max(...state.staff.map((worker) => worker.id)); }],
    ['nextStaffId zero', (state) => { state.nextStaffId = 0; }],
    ['unknown role', (state) => { (state.staff[0] as unknown as Record<string, unknown>).role = 'janitor'; }],
    ['unknown staff state', (state) => { (state.staff[0] as unknown as Record<string, unknown>).state = 'dancing'; }],
    ['unknown task kind', (state) => { (state.staff[0].task as unknown as Record<string, unknown>).kind = 'paint'; }],
    ['idle with a task', (state) => { state.staff[0].state = 'idle'; }],
    ['walking without a task', (state) => { state.staff[0].task = null; }],
    ['waiting cleaner', (state) => { state.staff[0].state = 'waiting'; }],
    ['waiting mechanic that started', (state) => { state.staff[3].task!.maintenanceStarted = true; }],
    ['working mechanic that has not started', (state) => { state.staff[2].task!.maintenanceStarted = false; }],
    ['empty route', (state) => { state.staff[0].route = []; }],
    ['routeIndex beyond route', (state) => { state.staff[0].routeIndex = state.staff[0].route.length + 1; }],
    ['negative routeIndex', (state) => { state.staff[0].routeIndex = -1; }],
    ['fractional routeVersion', (state) => { state.staff[0].routeVersion = 0.5; }],
    ['NaN payroll', (state) => { state.staff[0].payrollRemainingSeconds = Number.NaN; }],
    ['Infinity position', (state) => { state.staff[0].position.x = Number.POSITIVE_INFINITY; }],
    ['fractional route cell', (state) => { state.staff[0].route[0].x = 0.5; }],
    ['NaN task work', (state) => { state.staff[0].task!.workRemainingSeconds = Number.NaN; }],
    ['cleaner role with a ride task', (state) => { state.staff[0].task!.kind = 'repairRide'; }],
    ['emptyBin without a target', (state) => { state.staff[0].task!.targetObjectId = null; }],
    ['cleaner with maintenanceStarted', (state) => { state.staff[0].task!.maintenanceStarted = true; }],
    ['training level above maximum', (state) => { state.trainingLevel.cleaner = 4; }],
    ['fractional training level', (state) => { state.trainingLevel.mechanic = 1.5; }],
    ['negative elapsedSeconds is allowed to be finite only: string', (state) => { (state as unknown as Record<string, unknown>).elapsedSeconds = '12'; }],
    ['negative guestPopulation', (state) => { state.guestPopulation = -1; }],
    ['bin that is not in the world', (state) => { state.bins[0].objectId = 987_654; }],
    ['bin that is a ride', (state) => { state.bins[0].objectId = state.staff[2].task!.targetObjectId!; }],
    ['duplicate bin', (state) => { state.bins.push({ ...state.bins[0] }); }],
    ['bin fill above capacity', (state) => { state.bins[0].fill = 11; }],
    ['fractional bin fill', (state) => { state.bins[0].fill = 2.5; }],
    ['negative bin fill', (state) => { state.bins[0].fill = -1; }],
    ['zero litter units', (state) => { state.litter[0].units = 0; }],
    ['fractional litter units', (state) => { state.litter[0].units = 1.5; }],
    ['duplicate litter cell', (state) => { state.litter[1].cell = { ...state.litter[0].cell }; }],
    ['litter above the global cap', (state) => { state.litter[0].units = 301; }],
    ['bin assigned to a missing worker', (state) => { state.bins[0].assignedCleanerId = 77; }],
    ['bin assigned to a worker doing something else', (state) => { state.bins[0].assignedCleanerId = state.staff[1].id; }],
    ['bin assignment dropped while its cleaner still targets it', (state) => { state.bins[0].assignedCleanerId = null; }],
    ['pile assigned to a missing worker', (state) => { state.litter[0].assignedCleanerId = 77; }],
    ['pile assignment dropped while its cleaner still targets it', (state) => { state.litter[0].assignedCleanerId = null; }],
    ['pile assigned to a mechanic', (state) => { state.litter[1].assignedCleanerId = state.staff[2].id; }],
    ['started maintenance on a missing ride', (state) => { state.staff[2].task!.targetObjectId = 987_654; }],
    ['started inspection while the ride is under repair', (state) => { state.staff[2].task!.kind = 'inspectRide'; }],
    ['two mechanics on one ride', (state) => { state.staff[3].task!.targetObjectId = state.staff[2].task!.targetObjectId; }],
    ['ride maintained by someone outside the crew', (state) => {
      state.staff[2].task!.maintenanceStarted = false;
      state.staff[2].state = 'walking';
    }],
    // Unbounded accumulators: each of these used to be accepted and then hang or flood the step.
    ['happiness accumulator of 1e300 (an endless drain loop)', (state) => { state.happinessAccumulatorSeconds = 1e300; }],
    ['happiness accumulator of 2^31', (state) => { state.happinessAccumulatorSeconds = 2 ** 31; }],
    ['happiness accumulator above one interval', (state) => { state.happinessAccumulatorSeconds = 4.5; }],
    ['negative happiness accumulator', (state) => { state.happinessAccumulatorSeconds = -1; }],
    ['payroll countdown of -1e7 (half a million salaries in one step)', (state) => { state.staff[0].payrollRemainingSeconds = -1e7; }],
    ['payroll countdown of -1e300', (state) => { state.staff[0].payrollRemainingSeconds = -1e300; }],
    ['payroll countdown above one interval', (state) => { state.staff[0].payrollRemainingSeconds = 31; }],
    ['elapsedSeconds of 1e300', (state) => { state.elapsedSeconds = 1e300; }],
    ['nextStaffId of 2^53 (id + 1 === id)', (state) => { state.nextStaffId = 2 ** 53; }],
    ['staff position off the map', (state) => { state.staff[0].position.x = -50; }],
    ['staff position at 1e300', (state) => { state.staff[0].position.y = 1e300; }],
    ['staff route cell off the map', (state) => { state.staff[0].route[0].x = 4000; }],
    ['task work of 1e300 seconds', (state) => { state.staff[0].task!.workRemainingSeconds = 1e300; }],
    ['negative task work', (state) => { state.staff[0].task!.workRemainingSeconds = -1; }],
    ['staff not an array', (state) => { (state as unknown as Record<string, unknown>).staff = {}; }],
    ['trainingLevel missing', (state) => { delete (state as unknown as Record<string, unknown>).trainingLevel; }],
  ];

  it('rejects every malformed payload with invalid-state, naming it, and mutates nothing', () => {
    const source = richScenario();
    const base = source.operations.serialize();
    // Sanity: the base has the shape the table relies on.
    expect(base.staff.map((worker) => worker.role)).toEqual(['cleaner', 'cleaner', 'mechanic', 'mechanic']);
    expect(base.litter.length).toBeGreaterThanOrEqual(2);
    expect(base.staff[0].task?.kind, 'cleaner 1 has the bin').toBe('emptyBin');
    expect(base.staff[1].task?.kind, 'cleaner 2 has a pile').toBe('cleanLitter');
    const target = twinOf(source);
    target.operations.restore(base);
    const before = target.operations.serialize();
    const ridesBefore = hashState([...target.rides.rides.values()].map((ride) => structuredClone(ride)), { normalizeNegativeZero: true });

    for (const [name, mutate] of cases) {
      const copy = structuredClone(base);
      mutate(copy);
      let thrown: unknown;
      try { target.operations.restore(copy); } catch (error) { thrown = error; }
      expect(thrown, `${name}: throws`).toBeInstanceOf(SaveError);
      expect((thrown as SaveError).code, `${name}: code`).toBe('invalid-state');
      expect((thrown as SaveError).message, `${name}: names the owner`).toContain('OperationsSimulation');
      expect(target.operations.serialize(), `${name}: nothing mutated`).toEqual(before);
    }
    expect(hashState([...target.rides.rides.values()].map((ride) => structuredClone(ride)), { normalizeNegativeZero: true }), 'rides untouched').toBe(ridesBefore);
    expect(() => target.operations.restore(null as unknown as OperationsState)).toThrow(SaveError);
    expect(() => target.operations.restore(undefined as unknown as OperationsState)).toThrow(SaveError);
  });
});

describe('OperationsSimulation timer loops are bounded even if state is corrupt', () => {
  it('a happiness accumulator far above the interval cannot hang a step', () => {
    const scenario = richScenario();
    (scenario.operations as unknown as { happinessAccumulatorSeconds: number }).happinessAccumulatorSeconds = 1e300;
    const started = Date.now();
    scenario.operations.step(100, new Map());
    expect(Date.now() - started, 'the step returns promptly instead of looping forever').toBeLessThan(5_000);
  });

  it('a hugely overdue payroll pays a bounded number of salaries in one step', () => {
    const scenario = richScenario();
    const worker = [...scenario.operations.staff.values()][0];
    worker.payrollRemainingSeconds = -1e12;
    // The history array is capped at 300 entries, so count postings through the id generator.
    const before = scenario.world.serialize().nextTransactionId;
    scenario.operations.step(100, new Map());
    const posted = scenario.world.serialize().nextTransactionId - before;
    expect(posted, 'salary postings are capped').toBeLessThanOrEqual(1_001);
    expect(posted, 'and the loop did run, so the guard (not an early exit) is what stopped it').toBeGreaterThan(100);
  });
});

describe('OperationsSimulation field coverage guard', () => {
  /**
   * HOW TO FIX A FAILURE HERE: you added (or renamed) a field on OperationsSimulation or on one of
   * its record types (StaffRuntime, StaffTaskRuntime, BinRuntime, LitterPileRuntime). Decide:
   *  - it influences future behaviour and cannot be re-derived: add it to the matching state type
   *    in src/game/save/state.ts, write it in serialize(), validate and read it in restore(), and
   *    list it here (`serialized` or the record's allowlist) so the mutation proof covers it;
   *  - it is a cache rebuilt by restore: list it under `derived` with the rebuild named;
   *  - it is injected configuration: list it under `config`.
   */
  const accounting = {
    serialized: [
      'elapsedSeconds', 'happinessAccumulatorSeconds', 'nextStaffId', 'guestPopulation',
      'trainingLevel', 'bins', 'litter', 'staff',
    ],
    // navigation: invalidated and re-synced by restore (BFS fields are rebuilt lazily).
    derived: ['navigation'],
    config: ['world', 'rides', 'shops', 'rules'],
    // Phase 49: the running waste tally (the Staff window's capacity read); never read by the simulation, never saved.
    transient: ['wasteCounts'] as string[],
  };

  /** Fields of the runtime records that serialize() deliberately does not write, and why. */
  const derivedRecordFields: Record<string, string[]> = {
    bin: ['capacity'], // derived from the catalog (binCapacityOf) on restore
    pile: [],
    worker: [],
    task: [],
  };

  /** Returns a copy of `value` with its first leaf changed. */
  const perturbed = (value: unknown): unknown => {
    if (typeof value === 'number') return value + 1;
    if (typeof value === 'boolean') return !value;
    if (typeof value === 'string') return `${value}-changed`;
    if (value === null) return 12_345;
    if (Array.isArray(value)) {
      const copy = structuredClone(value);
      copy[0] = perturbed(copy[0]);
      return copy;
    }
    const copy = structuredClone(value) as Record<string, unknown>;
    const first = Object.keys(copy)[0];
    copy[first] = perturbed(copy[first]);
    return copy;
  };

  const expectFieldsRead = (
    scenario: Scenario,
    kind: string,
    record: Record<string, unknown>,
    ignore: readonly string[],
  ): void => {
    for (const key of Object.keys(record)) {
      const before = hashState(scenario.operations.serialize());
      const original = record[key];
      record[key] = perturbed(original);
      const after = hashState(scenario.operations.serialize());
      record[key] = original;
      if (ignore.includes(key)) {
        expect(after, `${kind}.${key} is allowlisted as derived but serialize() reads it: move it to the state`).toBe(before);
      } else {
        expect(after, `serialize() ignores ${kind}.${key}: add it to the state type, serialize() and restore()`).not.toBe(before);
      }
    }
  };

  it('accounts for every own property exactly once', () => {
    expect(auditOwnProperties(richScenario().operations, accounting), 'see the HOW TO FIX comment in this describe').toEqual([]);
  });

  it('proves every serialized top-level field is read by serialize()', () => {
    const scenario = richScenario();
    const instance = scenario.operations as unknown as Record<string, unknown>;
    for (const name of accounting.serialized) {
      const before = hashState(scenario.operations.serialize());
      const original = instance[name];
      if (original instanceof Map) {
        const entries = [...original.entries()];
        expect(entries.length, `${name} needs at least two entries in the rich scenario`).toBeGreaterThan(1);
        original.delete(entries[0][0]);
        original.set(entries[0][0], entries[0][1]); // same content, new iteration order
        expect(hashState(scenario.operations.serialize()), `serialize() ignores the iteration order of ${name}`).not.toBe(before);
        original.clear();
        for (const [key, value] of entries) original.set(key, value);
        original.delete(entries[0][0]);
        expect(hashState(scenario.operations.serialize()), `serialize() ignores removing from ${name}`).not.toBe(before);
        original.clear();
        for (const [key, value] of entries) original.set(key, value);
      } else {
        instance[name] = perturbed(original);
        const after = hashState(scenario.operations.serialize());
        instance[name] = original;
        expect(after, `serialize() ignores '${name}'`).not.toBe(before);
      }
      expect(hashState(scenario.operations.serialize()), `${name} was put back`).toBe(before);
    }
  });

  it('proves every field of the bin, pile, worker and task records is read (or allowlisted as derived)', () => {
    const scenario = richScenario();
    const { operations } = scenario;
    const bin = operations.getBin(scenario.binId)!;
    const pile = [...operations.litter.values()].find((candidate) => candidate.assignedCleanerId !== null)!;
    const worker = [...operations.staff.values()].find((candidate) => candidate.role === 'mechanic' && candidate.task?.maintenanceStarted)!;
    expect(Object.keys(bin).sort()).toEqual(['assignedCleanerId', 'capacity', 'fill', 'objectId']);
    expect(Object.keys(worker.task!)).toHaveLength(6);
    // A null field must be exercised while non-null too.
    bin.assignedCleanerId = bin.assignedCleanerId ?? 1;
    expectFieldsRead(scenario, 'bin', bin as unknown as Record<string, unknown>, derivedRecordFields.bin);
    expectFieldsRead(scenario, 'pile', pile as unknown as Record<string, unknown>, derivedRecordFields.pile);
    expectFieldsRead(scenario, 'worker', worker as unknown as Record<string, unknown>, derivedRecordFields.worker);
    expectFieldsRead(scenario, 'task', worker.task as unknown as Record<string, unknown>, derivedRecordFields.task);
    const walker = [...operations.staff.values()].find((candidate) => candidate.role === 'cleaner')!;
    expectFieldsRead(scenario, 'cleaner', walker as unknown as Record<string, unknown>, []);
  });
});
