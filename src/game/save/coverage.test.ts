import { describe, expect, it } from 'vitest';
import { PathNetwork } from '../navigation/PathNetwork';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { OPTIONAL_RULE_KEYS, PHASE14_RULE_KEYS, PHASE16_RULE_KEYS } from '../scenarios/rules';
import { CrowdSimulation } from '../crowd/CrowdSimulation';
import { ParkSession } from '../session/ParkSession';
import { seedDevPark } from '../session/devPark';
import { testStageSession } from '../run/testSupport';
import { SimulationClock } from '../SimulationClock';
import { auditOwnProperties, type PropertyAccounting } from './plainData';
import type { WeatherDayState, WeatherSlotState, WeatherState } from '../weather/types';
import type {
  BinState,
  CoasterPieceState,
  CoasterRecordState,
  CalendarState,
  GameWorldState,
  GuestRecordState,
  GuestSimulationState,
  LitterPileState,
  ManagementState,
  OnboardingCompletionState,
  OnboardingState,
  OperationsState,
  ParkRulesetStateV14,
  CardPlaysState,
  CrowdState,
  ParkSaveV14,
  MapState,
  PropState,
  PlacedObjectState,
  ProgressionState,
  RideRuntimeState,
  RideSimulationState,
  SceneryState,
  ScenarioState,
  ServiceRuntimeState,
  ShopSimulationState,
  SimulationClockState,
  StaffTaskState,
  StaffWorkerState,
  TransactionState,
} from './state';

/**
 * The field-coverage guard. A simulation class that gains a property fails this file until someone
 * decides which of four things it is: serialized (written into the save), derived (rebuilt or
 * invalidated by restore), config (injected, identical in a restore target) or transient (telemetry,
 * listeners, cache keys). That decision is the whole point: a silently unsaved field is the one bug
 * class the determinism hash cannot always see (it hashes what serialize() writes).
 *
 * Two independent nets:
 *  1. auditOwnProperties over every owner class and over the plain runtime records, against the
 *     tables below (ES `#private` fields are invisible to this walk, so simulation classes must
 *     not use them; the last test greps for them);
 *  2. `Record<keyof State, true>` tables, which make adding or renaming a state field a COMPILE
 *     error until the table is updated, compared at runtime with the keys serialize() really emits.
 */

/** Runs a few hundred ticks so lazily created fields exist. */
const livingSession = (): ParkSession => {
  const session = new ParkSession(SCENARIO_BY_ID.get('sunny-start')!, ['grand-opening']);
  session.world.buildPaths([{ x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 }]);
  session.world.buildObject('petal-roundabout', { x: 16, y: 26 });
  session.syncWithWorld();
  for (let tick = 0; tick < 250; tick += 1) session.step(100);
  return session;
};

const populatedDevPark = (): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  session.guests.spawnGuests(150);
  for (let tick = 0; tick < 500; tick += 1) session.step(100);
  return session;
};

const audit = (name: string, subject: object, accounting: PropertyAccounting): void => {
  expect(auditOwnProperties(subject, accounting), `${name} has unaccounted fields`).toEqual([]);
};

describe('own-property accounting of every owner', () => {
  const session = livingSession();

  it('GameWorld', () => {
    audit('GameWorld', session.world, {
      // Schema 14: `land` (the owned parcels) is written only when restricted.
      serialized: ['paths', 'objects', 'coasters', 'transactions', 'cash', 'tick', 'parkOpen', 'demolitions', 'nextObjectId', 'nextTransactionId', 'version', 'pathVersion', 'gateRecord', 'land'],
      // Schema 8: the map layer is the `map` key of the save (serializeMap); `props` holds the REMAINING props and `propGrid` is rebuilt from them.
      derived: ['trackLayers', 'occupancy', 'props', 'propGrid'],
      config: ['width', 'height', 'entrance', 'entranceFacing', 'map', 'constructionCostMultiplier', 'buildAccessPolicy', 'gateSchedule', 'landCostMultiplier', 'frontAccess'],
      transient: ['listeners', 'batchDepth', 'batchedChange', 'appearanceCounter', 'propRevisionCounter', 'landRevisionCounter'],
      optional: ['startingCash'],
    });
  });

  it('GuestSimulation', () => {
    audit('GuestSimulation', session.guests, {
      serialized: ['guests', 'random', 'nextGuestId', 'totalArrivalsCount', 'spawnTimerSeconds', 'parkRating'],
      derived: ['navigation', 'destinationWorldVersion', 'rideDestinations', 'serviceDestinations', 'benchDestinations', 'landmarks', 'benchSeats'],
      // `crowd` is the session's CrowdSimulation (Phase 14), saved by the session as `crowd` when feedback is on.
      config: ['arrivalIntervalMultiplierValue', 'guestBudgetMultiplier', 'servicePriceToleranceMultiplier', 'needDecayMultiplier', 'hungerRateMultiplier', 'thirstRateMultiplier', 'crowdCapacityMultiplier', 'scenery', 'world', 'rides', 'shops', 'conditions', 'crowd'],
      // Phase 29: the sick cells of the current tick, drained by the session in the same tick.
      transient: ['sickCells'],
    });
  });

  it('RideSimulation', () => {
    audit('RideSimulation', session.rides, { serialized: ['rides', 'elapsedSeconds'], derived: [], config: ['world', 'scenery', 'rules', 'conditions'], transient: [] });
  });

  it('ShopSimulation', () => {
    audit('ShopSimulation', session.shops, { serialized: ['services', 'completionEvents', 'nextCompletionEventId'], derived: [], config: ['world', 'scenery', 'rules'], transient: [] });
  });

  it('OperationsSimulation', () => {
    audit('OperationsSimulation', session.operations, {
      serialized: ['bins', 'litter', 'staff', 'elapsedSeconds', 'happinessAccumulatorSeconds', 'nextStaffId', 'guestPopulation', 'trainingLevel'],
      derived: ['navigation'],
      config: ['world', 'rides', 'shops', 'rules'],
      transient: [],
    });
  });

  it('ScenerySimulation', () => {
    audit('ScenerySimulation', session.scenery, {
      serialized: ['scores'],
      derived: ['sources', 'objectScores', 'lastWorldVersion', 'lastPathVersion', 'latestSnapshot'],
      config: ['world', 'rules', 'themeAffinity'],
      transient: ['cacheVersion'],
    });
  });

  it('ProgressionSimulation', () => {
    audit('ProgressionSimulation', session.progression, {
      serialized: ['researchPoints', 'completedRideExperiences', 'completedServiceExperiences', 'highestParkRating', 'completedProjectIds', 'completedMilestoneIds', 'lastRideCompletionCounts', 'lastServiceCompletionCounts', 'pendingEvents', 'nextEventId'],
      derived: [],
      config: ['world', 'researchCostScale'],
      transient: [],
    });
  });

  it('ManagementSimulation', () => {
    audit('ManagementSimulation', session.management, {
      serialized: ['elapsedSeconds', 'trendAccumulatorSeconds', 'lastObservedCash', 'lastProcessedTransactionId', 'latestGuestCount', 'categoryTotals', 'totals', 'latestRating', 'trendPoints', 'pendingNotifications', 'nextNotificationId', 'lastNotificationAt', 'activeNotificationSeverities', 'ratingMilestonesInitialized', 'emittedRatingMilestones'],
      derived: ['connectivityWorldVersion', 'connectivityPathVersion', 'connectedObjectIds', 'entranceConnectedPathCount', 'entranceConnectedTip', 'latestOperations', 'latestParkOperations', 'latestScenery'],
      config: ['world'],
      transient: [],
    });
  });

  it('OnboardingTracker', () => {
    audit('OnboardingTracker', new ParkSession(null).onboarding!, {
      serialized: ['dismissed', 'completed', 'skipped', 'sawLitter'],
      derived: [],
      config: [],
      transient: [],
    });
  });

  it('ScenarioSimulation', () => {
    audit('ScenarioSimulation', session.scenario!, {
      serialized: ['status', 'elapsedSeconds', 'sustainedSeconds', 'longestSustainedSeconds', 'completedAtSeconds', 'resultEvidence', 'latestMetrics', 'pendingEvents'],
      derived: ['lockedDefinitionIds'],
      config: ['definition'],
      transient: [],
    });
  });

  it('PathNetwork, SeededRandom, SimulationClock', () => {
    audit('PathNetwork', session.guests.navigation, {
      serialized: [],
      derived: ['pathVersion', 'paths', 'destinationFields', 'componentByCell'],
      config: [],
      transient: ['requests'],
    });
    expect(session.guests.navigation).toBeInstanceOf(PathNetwork);
    audit('SeededRandom', (session.guests as unknown as { random: object }).random, { serialized: ['state'], derived: [], config: [], transient: [] });
    audit('SimulationClock', new SimulationClock(() => undefined), {
      serialized: ['speed', 'simulationTimeMs'],
      derived: [],
      config: ['onStep'],
      transient: ['accumulator', 'lastStepDurationMs', 'stepsLastFrame'],
    });
  });

  it('ParkCalendar', () => {
    audit('ParkCalendar', session.calendar, {
      serialized: ['dayLengthSeconds', 'anchorTick', 'anchorUnits', 'timeLock', 'hoursEnabled', 'openHour', 'closeHour'],
      derived: [],
      config: ['getTick', 'editable'],
      transient: [],
    });
  });

  it('WeatherSimulation', () => {
    audit('WeatherSimulation', session.weather, {
      serialized: ['enabled', 'severity', 'random', 'chainKind', 'firstDay', 'days'],
      derived: ['conditions'],
      config: ['seed', 'calendar', 'rules', 'getTick', 'climate'],
      transient: [],
    });
    audit('WeatherRandom', (session.weather as unknown as { random: object }).random, { serialized: ['state'], derived: [], config: [], transient: [] });
  });

  it('ParkSession', () => {
    audit('ParkSession', session, {
      // `crowd` is saved exactly when the ruleset has feedback (Phase 14, schema 13); `crowdDisplay` is presentation.
      serialized: ['scenarioDefinition', 'rules', 'seed', 'activeCards', 'mode', 'grant', 'runState', 'plays', 'crowd'],
      derived: [],
      config: ['world', 'map', 'scenery', 'calendar', 'weather', 'rides', 'shops', 'guests', 'operations', 'progression', 'management', 'onboarding', 'scenario'],
      transient: ['crowdDisplay'],
    });
  });

  it('CrowdSimulation', () => {
    expect(session.crowd).toBeInstanceOf(CrowdSimulation);
    audit('CrowdSimulation', session.crowd, {
      serialized: ['pressure'],
      derived: ['shapes'],
      // The strength is the ruleset's crowdFeedback (identical in a restore target); the rest is GAME_CONFIG read once.
      config: ['world', 'width', 'height', 'feedbackStrength', 'loadOnePressure', 'severePressure', 'constants'],
      transient: [],
    });
  });
});

/** Compile-time exhaustive: every key of the state type must be listed or this file does not compile. */
type KeyTable<State> = Record<keyof State, true>;
const keysOf = <State extends object>(table: KeyTable<State>): string[] => Object.keys(table).sort();
const emitted = (value: object): string[] => Object.keys(value).sort();

const TABLES = {
  save: keysOf<ParkSaveV14>({ crowd: true, plays: true, run: true, mode: true, grant: true, scenarioId: true, activeCardIds: true, seed: true, rules: true, world: true, scenery: true, calendar: true, weather: true, rides: true, shops: true, guests: true, operations: true, progression: true, management: true, onboarding: true, scenario: true, map: true }),
  crowd: keysOf<CrowdState>({ version: true, pressure: true }),
  plays: keysOf<CardPlaysState>({ played: true, pending: true }),
  played: keysOf<CardPlaysState['played'][number]>({ cardId: true, tick: true }),
  pending: keysOf<CardPlaysState['pending'][number]>({ cardId: true, dueTick: true, amount: true, label: true, category: true }),
  calendar: keysOf<CalendarState>({ dayLengthSeconds: true, anchorTick: true, anchorUnits: true, timeLock: true, hoursEnabled: true, openHour: true, closeHour: true }),
  weather: keysOf<WeatherState>({ enabled: true, severity: true, rngState: true, chainKind: true, firstDay: true, days: true }),
  weatherDay: keysOf<WeatherDayState>({ kind: true, slots: true }),
  weatherSlot: keysOf<WeatherSlotState>({ kind: true, intensity: true }),
  world: keysOf<GameWorldState>({ mapWidth: true, mapHeight: true, constructionCostMultiplier: true, cash: true, tick: true, parkOpen: true, demolitions: true, nextObjectId: true, nextTransactionId: true, version: true, pathVersion: true, gateColours: true, land: true, paths: true, objects: true, coasters: true, transactions: true }),
  /** Every key an object can carry; `colours` only when at least one slot is recoloured (schema 6). */
  object: keysOf<Required<PlacedObjectState>>({ id: true, definitionId: true, anchor: true, rotation: true, colours: true }),
  rules: keysOf<ParkRulesetStateV14>({ startingCash: true, lockedDefinitionIds: true, arrivalIntervalMultiplier: true, guestBudgetMultiplier: true, servicePriceToleranceMultiplier: true, needDecayMultiplier: true, constructionCostMultiplier: true, rideOperatingCostMultiplier: true, rideDispatchMultiplier: true, serviceDurationMultiplier: true, needReliefMultiplier: true, staffSalaryMultiplier: true, staffSpeedMultiplier: true, wetWeatherMultiplier: true, chainLiftCostMultiplier: true, recolourCostMultiplier: true, weatherEffectMultiplier: true, nightArrivalMultiplier: true, dayLengthMultiplier: true, crowdCapacityMultiplier: true, litterImpactMultiplier: true, breakdownRateMultiplier: true, sceneryAppealMultiplier: true, landCostMultiplier: true, hungerRateMultiplier: true, thirstRateMultiplier: true, startingResearchPoints: true, extraCardSlots: true, themeAffinity: true, researchCostScale: true, crowdFeedback: true, frontAccess: true }),
  map: keysOf<MapState>({ id: true, biomeId: true, width: true, height: true, entrance: true, ground: true, props: true, recipe: true }),
  prop: keysOf<PropState>({ id: true, kind: true, x: true, y: true, rotation: true }),
  /** Every key a piece can carry; `special` and `freeClimb` only when set. */
  coasterPiece: keysOf<Required<CoasterPieceState>>({ cell: true, height: true, special: true, freeClimb: true }),
  coaster: keysOf<CoasterRecordState>({ objectId: true, pieces: true, stats: true, paidCost: true }),
  transaction: keysOf<TransactionState>({ id: true, amount: true, label: true, category: true, tick: true }),
  clock: keysOf<SimulationClockState>({ speed: true, simulationTimeMs: true }),
  guests: keysOf<GuestSimulationState>({ randomState: true, nextGuestId: true, totalArrivals: true, spawnTimerSeconds: true, parkRating: true, guests: true }),
  guest: keysOf<GuestRecordState>({ id: true, position: true, currentCell: true, route: true, routeIndex: true, routeVersion: true, state: true, destinationObjectId: true, money: true, happiness: true, hunger: true, thirst: true, toiletNeed: true, energy: true, preferredIntensity: true, currentThought: true, patienceSeconds: true, lastQueueWaitSeconds: true, lastRideSatisfaction: true, lastPurchaseSatisfaction: true, servicePriceLimit: true, recentRideIds: true, recentServiceIds: true, ageSeconds: true, maximumVisitSeconds: true, stateTimerSeconds: true, needTimerSeconds: true, color: true, accent: true, nausea: true, warmth: true, souvenirs: true, activity: true, thoughtObjectId: true }),
  rides: keysOf<RideSimulationState>({ elapsedSeconds: true, rides: true }),
  ride: keysOf<RideRuntimeState>({ objectId: true, open: true, status: true, ticketPrice: true, queueGuestIds: true, riderGuestIds: true, dispatchTimerSeconds: true, cycleRemainingSeconds: true, lifetimeRevenue: true, lifetimeOperatingCost: true, ridersToday: true, completedCycles: true, satisfactionTotal: true, satisfactionCount: true, boardedAtSeconds: true, condition: true, reliability: true, broken: true, pendingBreakdown: true, breakdownCount: true, inspectionsCompleted: true, repairsCompleted: true, lifetimeMaintenanceCost: true, maintenanceKind: true, maintenanceProgress: true }),
  shops: keysOf<ShopSimulationState>({ nextCompletionEventId: true, completionEvents: true, services: true }),
  service: keysOf<ServiceRuntimeState>({ objectId: true, definitionId: true, kind: true, open: true, status: true, itemPrice: true, serviceTimeSeconds: true, queueGuestIds: true, activeGuestId: true, serviceRemainingSeconds: true, customersServed: true, lifetimeRevenue: true, satisfactionTotal: true, satisfactionCount: true }),
  operations: keysOf<OperationsState>({ elapsedSeconds: true, happinessAccumulatorSeconds: true, nextStaffId: true, guestPopulation: true, trainingLevel: true, bins: true, litter: true, staff: true }),
  staff: keysOf<StaffWorkerState>({ id: true, role: true, state: true, position: true, currentCell: true, route: true, routeIndex: true, routeVersion: true, task: true, payrollRemainingSeconds: true }),
  task: keysOf<StaffTaskState>({ kind: true, targetObjectId: true, targetCell: true, workRemainingSeconds: true, workDurationSeconds: true, maintenanceStarted: true }),
  bin: keysOf<BinState>({ objectId: true, fill: true, assignedCleanerId: true }),
  litter: keysOf<LitterPileState>({ cell: true, units: true, assignedCleanerId: true, sick: true }),
  scenery: keysOf<SceneryState>({ width: true, height: true, scores: true, sources: true }),
  progression: keysOf<ProgressionState>({ researchPoints: true, completedRideExperiences: true, completedServiceExperiences: true, highestParkRating: true, completedProjectIds: true, completedMilestoneIds: true, lastRideCompletionCounts: true, lastServiceCompletionCounts: true, pendingEvents: true, nextEventId: true }),
  management: keysOf<ManagementState>({ elapsedSeconds: true, trendAccumulatorSeconds: true, lastObservedCash: true, lastProcessedTransactionId: true, latestGuestCount: true, categoryTotals: true, totals: true, latestRating: true, trendPoints: true, pendingNotifications: true, nextNotificationId: true, lastNotificationAt: true, activeNotificationSeverities: true, ratingMilestonesInitialized: true, emittedRatingMilestones: true }),
  onboarding: keysOf<OnboardingState>({ dismissed: true, completed: true, skipped: true, sawLitter: true }),
  completion: keysOf<OnboardingCompletionState>({ id: true, tick: true, evidence: true }),
  scenario: keysOf<ScenarioState>({ scenarioId: true, status: true, elapsedSeconds: true, sustainedSeconds: true, longestSustainedSeconds: true, completedAtSeconds: true, resultEvidence: true, latestMetrics: true, pendingEvents: true }),
};

describe('serialized shape equals the declared state types', () => {
  const dev = populatedDevPark();
  // A mechanic with a task, a bin and a litter pile exist in a run with these.
  dev.operations.addLitter({ x: 15, y: 25 }, 3);
  for (let tick = 0; tick < 200 && ![...dev.operations.staff.values()].some((worker) => worker.task); tick += 1) dev.step(100);
  const save = dev.serialize();

  it('the session envelope and each owner', () => {
    expect(emitted(save), '`plays` and `run` only in mode run (schemas 11 and 12); `crowd` only with rules.crowdFeedback (schema 13, every new park)').toEqual(TABLES.save.filter((key) => key !== 'run' && key !== 'plays'));
    expect(emitted(save.crowd!)).toEqual(TABLES.crowd);
    expect(save.crowd!.pressure.length, 'a living park has flow on its paths').toBeGreaterThan(0);
    expect(emitted(save.rules), '`hungerRateMultiplier` and `thirstRateMultiplier` only when a biome changes them (schema 8), the two bonus keys only when a permanent bonus grants them (schema 10), the seven Phase 25 keys only when != 1, the two Phase 16 keys only when the config is non-neutral (phase16Rules.test.ts)').toEqual(TABLES.rules.filter((key) => key !== 'hungerRateMultiplier' && key !== 'thirstRateMultiplier' && key !== 'startingResearchPoints' && key !== 'extraCardSlots' && !(OPTIONAL_RULE_KEYS as readonly string[]).includes(key) && (([...PHASE16_RULE_KEYS, ...PHASE14_RULE_KEYS] as readonly string[]).includes(key) ? key in save.rules : true)));
    expect(save.rules.crowdFeedback, 'a new park compiles the Phase 14 key').toBe(1);
    expect(emitted(save.map)).toEqual(TABLES.map);
    expect(emitted(save.world), '`gateColours` only when the gate is recoloured (schema 7), `land` only on restricted land (schema 14)').toEqual(TABLES.world.filter((key) => key !== 'gateColours' && key !== 'land'));
    expect(emitted(save.guests)).toEqual(TABLES.guests);
    expect(emitted(save.rides)).toEqual(TABLES.rides);
    expect(emitted(save.shops)).toEqual(TABLES.shops);
    expect(emitted(save.operations)).toEqual(TABLES.operations);
    expect(emitted(save.scenery)).toEqual(TABLES.scenery);
    expect(emitted(save.calendar)).toEqual(TABLES.calendar);
    expect(emitted(save.weather)).toEqual(TABLES.weather);
    expect(save.weather.days.length).toBeGreaterThan(0);
    for (const day of save.weather.days) {
      expect(emitted(day)).toEqual(TABLES.weatherDay);
      for (const slot of day.slots) expect(emitted(slot)).toEqual(TABLES.weatherSlot);
    }
    expect(emitted(save.progression)).toEqual(TABLES.progression);
    expect(emitted(save.management)).toEqual(TABLES.management);
    expect(emitted(livingSession().serialize().scenario!)).toEqual(TABLES.scenario);
    expect(livingSession().serialize().onboarding, 'a scenario park has no onboarding').toBeNull();
    expect(emitted(save.onboarding!)).toEqual(TABLES.onboarding);
    expect(emitted(new SimulationClock(() => undefined).serialize())).toEqual(TABLES.clock);
  });

  it('a run stage (schema 12) emits `plays` and `run`, and the one-shot ledger emits exactly its table keys', () => {
    const { session } = testStageSession({ seed: 2, cardIds: ['bridging-loan'] });
    expect(session.playCard('bridging-loan')).toMatchObject({ ok: true });
    session.syncWithWorld();
    const state = session.serialize();
    expect(emitted(state)).toEqual(TABLES.save);
    expect(emitted(state.plays!)).toEqual(TABLES.plays);
    expect(state.plays!.played).toHaveLength(1);
    expect(state.plays!.pending).toHaveLength(1);
    for (const entry of state.plays!.played) expect(emitted(entry)).toEqual(TABLES.played);
    for (const entry of state.plays!.pending) expect(emitted(entry)).toEqual(TABLES.pending);
    audit('CardPlays', session.plays!, { serialized: ['played', 'pending'], derived: [], config: [], transient: [] });
  });

  it('a recoloured object (schema 6) emits exactly the table keys, an uncoloured one omits `colours`', () => {
    const park = populatedDevPark();
    const ride = [...park.world.objects.values()].find((object) => object.definitionId === 'comet-cups')!;
    expect(park.world.setObjectColours(ride.id, [19, null])).toEqual({ ok: true, changed: true });
    const objects = park.serialize().world.objects;
    expect(emitted(objects.find((object) => object.id === ride.id)!)).toEqual(TABLES.object);
    expect(objects.filter((object) => 'colours' in object).length).toBe(1);
    expect(Object.keys(park.world.objects.get(ride.id)!).sort()).toEqual(TABLES.object);
  });

  it('a recoloured gate (schema 7) adds exactly the `gateColours` key to the world state; clearing removes it', () => {
    const park = populatedDevPark();
    expect(park.world.setGateColours([19, null, 13])).toEqual({ ok: true, changed: true });
    expect(emitted(park.serialize().world)).toEqual(TABLES.world.filter((key) => key !== 'land'));
    expect(park.serialize().world.gateColours).toEqual([19, null, 13]);
    expect(park.world.clearGateColours()).toEqual({ ok: true, changed: true });
    expect(emitted(park.serialize().world)).toEqual(TABLES.world.filter((key) => key !== 'gateColours' && key !== 'land'));
  });

  it('the onboarding completion records', () => {
    const sandbox = new ParkSession(null);
    sandbox.onboarding!.step({
      tick: 10, connectedPathTiles: 8, rides: [], services: [], totalArrivals: 60,
      operatingProfit: 150.5, litterUnits: 0, cleaners: 0, parkRating: 75,
    });
    const completed = sandbox.serialize().onboarding!.completed;
    expect(completed.length, 'four numeric steps latched').toBe(4);
    for (const entry of completed) expect(emitted(entry)).toEqual(TABLES.completion);
  });

  it('every record', () => {
    expect(save.guests.guests.length).toBeGreaterThan(50);
    // Phase 30: `thoughtObjectId` is written only for a guest whose complaint names a building.
    for (const guest of save.guests.guests) expect(emitted(guest)).toEqual(TABLES.guest.filter((key) => key !== 'thoughtObjectId' || 'thoughtObjectId' in guest));
    expect(save.guests.guests.some((guest) => 'thoughtObjectId' in guest), 'a populated dev park has a complaint about a building').toBe(true);
    for (const ride of save.rides.rides) expect(emitted(ride)).toEqual(TABLES.ride);
    for (const service of save.shops.services) expect(emitted(service)).toEqual(TABLES.service);
    for (const worker of save.operations.staff) expect(emitted(worker)).toEqual(TABLES.staff);
    expect(save.operations.staff.some((worker) => worker.task !== null), 'a worker with a task').toBe(true);
    for (const worker of save.operations.staff) if (worker.task) expect(emitted(worker.task)).toEqual(TABLES.task);
    for (const bin of save.operations.bins) expect(emitted(bin)).toEqual(TABLES.bin);
    expect(save.operations.litter.length).toBeGreaterThan(0);
    // Phase 29: `sick` is written only for a pile someone was sick on.
    for (const pile of save.operations.litter) expect(emitted(pile)).toEqual(TABLES.litter.filter((key) => key !== 'sick' || 'sick' in pile));
    const plainObjectKeys = TABLES.object.filter((key) => key !== 'colours');
    for (const object of save.world.objects) expect(emitted(object)).toEqual(plainObjectKeys);
    expect(save.world.coasters.length).toBe(1);
    for (const coaster of save.world.coasters) {
      expect(emitted(coaster)).toEqual(TABLES.coaster);
      for (const piece of coaster.pieces) {
        expect(emitted(piece).every((key) => TABLES.coasterPiece.includes(key))).toBe(true);
        expect('freeClimb' in piece, 'a chained piece has no flag key').toBe(false);
      }
    }
    for (const transaction of save.world.transactions) expect(emitted(transaction)).toEqual(TABLES.transaction);
  });

  it('runtime records carry no key the state lacks (bin capacity is the one derived field)', () => {
    const live = [...dev.guests.guests.values()][0];
    expect(Object.keys(live).sort()).toEqual(TABLES.guest);
    expect(Object.keys([...dev.rides.rides.values()][0]).sort()).toEqual(TABLES.ride);
    expect(Object.keys([...dev.shops.services.values()][0]).sort()).toEqual(TABLES.service);
    const worker = [...dev.operations.staff.values()].find((entry) => entry.task)!;
    expect(Object.keys(worker).sort()).toEqual(TABLES.staff);
    expect(Object.keys(worker.task!).sort()).toEqual(TABLES.task);
    expect(Object.keys([...dev.operations.bins.values()][0]).sort()).toEqual([...TABLES.bin, 'capacity'].sort());
    expect(Object.keys([...dev.operations.litter.values()][0]).sort()).toEqual(TABLES.litter);
    expect(Object.keys([...dev.world.objects.values()][0]).sort()).toEqual(TABLES.object.filter((key) => key !== 'colours'));
    expect(Object.keys([...dev.world.coasters.values()][0]).sort()).toEqual(TABLES.coaster);
    expect(Object.keys(dev.world.transactions[0]).sort()).toEqual(TABLES.transaction);
  });
});

describe('no invisible state', () => {
  const sources = import.meta.glob<string>(
    ['../*.ts', '../{guests,rides,shops,operations,scenery,progression,management,scenarios,navigation,session,build,calendar,weather,crowd}/*.ts', '!../**/*.test.ts'],
    { query: '?raw', import: 'default', eager: true },
  );

  it('simulation classes use TypeScript private, never ES #private (the audit cannot see #fields)', () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /^\s+(?:static\s+)?(?:readonly\s+)?#[A-Za-z_]\w*\s*[=:;(]/m.test(text))
      .map(([path]) => path);
    expect(Object.keys(sources).length, 'glob found the simulation sources').toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
