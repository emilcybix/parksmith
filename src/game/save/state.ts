import type { BiomeId } from '../biomes/types';
import type { TimeLock } from '../calendar/calendarMath';
import type { PropKindId } from '../maps/props';
import type { MapRecipe } from '../maps/types';
import type { WeatherState } from '../weather/types';
import type { PulseCardId } from '../cards/types';
import type { RunStateV1, RunStateV2 } from '../run/types';
import type { GameMode } from '../modes/types';
import type { BonusId } from '../profile/bonuses';
import type { CoasterSpecial } from '../coaster/content';
import type { GuestActivity, GuestState } from '../guests/types';
import type { CrowdState } from '../crowd/types';
import type {
  FinancialTotals,
  ManagementNotification,
  ManagementNotificationKind,
  ManagementNotificationSeverity,
  ManagementTransactionCategory,
  ManagementTrendPoint,
  ParkRatingSnapshot,
} from '../management/types';
import type { OnboardingStepId } from '../onboarding/types';
import type { StaffRole, StaffState, StaffTaskKind } from '../operations/types';
import type { ProgressionEvent, ResearchMilestoneId, ResearchProjectId } from '../progression/types';
import type { MaintenanceKind, RideStatus } from '../rides/types';
import type { ParkScenarioId, ScenarioEvent, ScenarioMetrics, ScenarioStatus } from '../scenarios/types';
import type { ServiceKind, ServiceStatus, WasteServiceKind } from '../shops/types';
import type { GameSpeed, Rotation, TransactionCategory } from '../types';

/**
 * The typed, plain-data image of every piece of simulation state (Phase 12, step 1).
 *
 * READ THIS BEFORE ADDING A FIELD TO ANY SIMULATION CLASS.
 *
 * Rules every state type here (and every serialize() that fills one) obeys:
 *  - Plain data only: objects, arrays, finite numbers, strings, booleans, null. No undefined
 *    values (an optional key is OMITTED and restore supplies the default), no NaN/Infinity/-0
 *    (copy numbers through `plainNumber`), no Map/Set/class instance/function.
 *  - Maps become arrays of entries in ITERATION order and restore re-inserts in that order,
 *    because the order of several Maps is simulation-relevant (guests in spawn order, world
 *    objects, ride and service runtimes: unsorted consumers sum floats and break ties in Map
 *    order). Sets are sorted arrays ONLY when their order is never observable. `GameWorld.paths`
 *    is the exception: its insertion order is history-dependent and is saved as is.
 *  - Raw values, never rounded snapshots. Every float accumulator is saved as the exact double.
 *    JSON and structured clone both round-trip finite doubles bit-exactly.
 *  - serialize() is pure: it never calls snapshot(), step(), syncWithWorld(), collectTransactions()
 *    or anything else that mutates, because a save taken mid-run must not change the run.
 *  - serialize() deep-copies: no returned array or object aliases live runtime state, and restore()
 *    deep-copies again, so one held state can be restored many times (undo ring) without ever
 *    being mutated through the simulation.
 *  - Version counters (`version`, `pathVersion`, and every `routeVersion` compared to them) are
 *    saved VERBATIM and compared only for equality, so the numeric relation between them survives.
 *  - Dangling ids are legal data: a guest's destination or recent-ride list may name a demolished
 *    object. Owners validate what they own (keys, shape, enums, finiteness, references into the
 *    world), and the cross-owner consistency pass validates the rest.
 *
 *  - Every number restore() reads is range-checked, not only finite-checked (see ranges.ts): timers,
 *    counters, needs, prices and positions have documented bounds, because an unbounded timer can hang
 *    a loop and a counter past 2^53 hands out colliding ids. A save is user-editable data.
 *
 * Every field says WHY it is saved. DERIVED data is listed in the owner's doc comment with the
 * rule that rebuilds it, so reviewers can see that nothing influencing the future is missing.
 */

/** Anything with state implements this; restore() is exact on a dirty instance and resets first. */
export interface Serializable<State> {
  /** Pure, deep-copying, plain-data. */
  serialize(): State;
  /**
   * Validates `state` completely BEFORE changing anything (throw `invalidState(...)`), then resets
   * every owned field and applies the state in place. Containers keep their identity (Maps shared
   * with other owners are cleared and refilled, never replaced), injected collaborators and
   * closures are untouched, and every derived cache keyed by a version is invalidated.
   */
  restore(state: State): void;
}

/**
 * The owners ParkSession restores, in dependency order. Producers before consumers: the world
 * first (everything refers to its ids, cells and versions), scenery (needs only the world), rides
 * and shops (runtimes keyed by world object ids; guests refer to their queues), guests,
 * operations (checks mechanic tasks against rides), then the bookkeeping owners that read the
 * others' restored values (progression, management, onboarding, scenario). The session then clears undo and
 * runs the cross-owner consistency pass; it never steps, drains events or refreshes management.
 */
export const RESTORE_ORDER = [
  'world',
  'scenery',
  'calendar',
  'weather',
  'rides',
  'shops',
  'guests',
  'operations',
  'progression',
  'management',
  'onboarding',
  'scenario',
] as const;

export type SaveOwnerKey = (typeof RESTORE_ORDER)[number];

// ---------------------------------------------------------------------------------------------
// Shared leaves
// ---------------------------------------------------------------------------------------------

export interface CellState {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------------------------
// GameWorld (src/game/World.ts) and SimulationClock (src/game/SimulationClock.ts)
// ---------------------------------------------------------------------------------------------

export interface PlacedObjectState {
  /** Integer >= 1 (0 is the entrance sentinel in the occupancy grid). Unique, strictly ascending. */
  id: number;
  /** Key into the build catalog; an unknown id fails the restore loudly instead of skipping silently. */
  definitionId: string;
  anchor: CellState;
  /** 0..3 quarter turns; only footprint orientation depends on it. */
  rotation: Rotation;
  /**
   * Schema 6. Omitted unless at least one slot is recoloured. Aligned with colourSlotsFor(definitionId):
   * a swatch index (COLOUR_SWATCHES) or null for the slot default. Cosmetic: no simulation owner reads
   * it. Restore normalises instead of refusing (a bad entry becomes the default; see
   * normaliseObjectColours), because it cannot desync any owner.
   */
  colours?: (number | null)[];
}

export interface CoasterPieceState {
  cell: CellState;
  /** Integer 0..10 (Phase 45; 0..4 before Phase 39). Part of the layout the renderer and the train animation read. */
  height: number;
  /** Omitted for plain track, never `undefined`. Restore re-creates the in-memory `special: undefined`. */
  special?: CoasterSpecial;
  /** Schema 5. Written only when true: segment i to i+1 climbs without a chain. Absent = chained. */
  freeClimb?: true;
  /** Schema 17 (Phase 44). Only on the first piece of a shuttle layout: its launch speed, cells per second. */
  launchSpeed?: number;
}

/**
 * Derived coaster numbers, saved VERBATIM although deriveCoasterStats could recompute them: they
 * were computed under the constants of the build date, and ride profile, train animation and ride
 * duration read them. Re-deriving on load would silently rebalance old saves.
 */
export interface CoasterStatsState {
  pieces: number;
  turns: number;
  drops: number;
  totalDescent: number;
  biggestDrop: number;
  highestHeight: number;
  loops: number;
  boosts: number;
  topSpeed: number;
  excitement: number;
  intensity: number;
  durationSeconds: number;
  travelSeconds: number[];
  capacity: number;
  runningCost: number;
  ticketPrice: number;
  reliability: number;
}

export interface CoasterRecordState {
  /** Must exist in `objects` and be the key of the coaster record. */
  objectId: number;
  /** ORDER IS SEMANTIC: index 0 starts the station and the loop wraps. */
  pieces: CoasterPieceState[];
  stats: CoasterStatsState;
  /** Cash actually charged after the cost multiplier: the bulldoze refund and demolition value read it. */
  paidCost: number;
}

export interface TransactionState {
  id: number;
  /** Normalised: the world may produce -0 for a free item, a save never contains it. */
  amount: number;
  label: string;
  category: TransactionCategory;
  tick: number;
}

/**
 * Schema 14 (Phase 21). `parcelSize` echoes GAME_CONFIG.land.parcelSize (a mismatch is refused). `owned` is the
 * strictly ascending list of owned parcel indices (row-major over the map's parcel grid): non-empty, holding the gate's
 * parcel and edge-connected; every path, object and coaster piece stands on an owned parcel.
 */
export interface LandState {
  parcelSize: number;
  owned: number[];
}

/**
 * DERIVED and rebuilt on restore, never saved: `occupancy` (the ground occupant: entrance -> 0, then every
 * non-coaster object's footprint in id order; overlap fails the restore) and `trackLayers` (Phase 38: every coaster
 * piece per cell, lowest first; a crossing closer than the clearance, or over an object the track does not clear,
 * fails the restore). CONFIG, untouched: `width`, `height`, `entrance`, the cost multiplier,
 * `buildAccessPolicy`. TRANSIENT, untouched: `listeners`, `batchDepth`, `batchedChange`
 * (serialize and restore throw if a batch is open: half a gesture must not be captured).
 */
export interface GameWorldState {
  /** Echoes of CONFIG the target must agree with; a mismatch means a different build of the map. */
  mapWidth: number;
  mapHeight: number;
  /** Echo of the ruleset value the world was built with; refunds and the next purchase depend on it. */
  constructionCostMultiplier: number;

  /** Float accumulator of every transaction; never recomputed (history is capped, dev park sets it directly). */
  cash: number;
  /** Park age in ticks; transactions, progression events and figure history are stamped with it. */
  tick: number;
  parkOpen: boolean;
  /** Monotone counter the construction undo compares; keeps its coupling with undo.clear() coherent. */
  demolitions: number;
  /** Cannot be derived: demolishing the newest object leaves max(id) + 1 below the generator. */
  nextObjectId: number;
  /** Cannot be derived: history is capped at 300 and management's last processed id depends on it. */
  nextTransactionId: number;
  /** Cache key other owners compare for equality (scenery, management, guest destinations). */
  version: number;
  /** Guests and staff hold `routeVersion`s compared to it: the relation must survive restore. */
  pathVersion: number;
  /**
   * Schema 7. The entrance gate's colours, a park-level record aligned with colourSlotsFor('park-entrance')
   * (arch, sign, posts). Omitted unless at least one slot is recoloured. Cosmetic: restore normalises it
   * (a bad entry becomes the default) and no simulation owner reads it.
   */
  gateColours?: (number | null)[];
  /**
   * Schema 14 (Phase 21). The owned land of a park whose map is not wholly owned: present exactly when ownership is
   * restricted (a wholly owned park, every park before Phase 21, has no key). See LandState.
   */
  land?: LandState;

  /**
   * INSERTION order of the path Set, entrance included, NOT sorted: a bulldoze-and-rebuild re-adds
   * at the end, the order is history-dependent and the PathNetwork copies it.
   */
  paths: CellState[];
  /** Ascending id = Map iteration order = placement order. */
  objects: PlacedObjectState[];
  /** Ascending objectId, a subset of `objects`. */
  coasters: CoasterRecordState[];
  /** Newest first, at most 300: exactly the in-memory array order. */
  transactions: TransactionState[];
}

/**
 * Only what the save needs of the clock; lives in the app envelope (the clock belongs to GameApp,
 * not to ParkSession). `accumulator` restarts at 0 (it only decides when the next fixed step fires
 * and render interpolation, never a result), and `lastStepDurationMs` / `stepsLastFrame` are
 * telemetry. `onStep` is a closure over the app's current session and is never recreated.
 */
export interface SimulationClockState {
  speed: GameSpeed;
  /** Integer-valued; no simulation consumer today, kept because the plan lists "simulation time". */
  simulationTimeMs: number;
}

// ---------------------------------------------------------------------------------------------
// GuestSimulation (src/game/guests/GuestSimulation.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Every field of the runtime Guest, 1:1 and with the same names so a save is greppable against
 * the type (includes the fields rides and shops mutate: toiletNeed, lastPurchaseSatisfaction,
 * servicePriceLimit, recentRideIds ...). `position`, `currentCell` and each route cell are
 * separate objects at runtime (position is mutated in place) and must stay unaliased.
 */
export interface GuestRecordState {
  /** Map key; strictly ascending in iteration order. */
  id: number;
  /** Float cell coordinates accumulated step by step: bit-exact value matters. */
  position: CellState;
  currentCell: CellState;
  /** Full planned route, integer cells; not re-derivable (goal is not stored, ties depend on history). */
  route: CellState[];
  /** 0..route.length. */
  routeIndex: number;
  /** Compared with world.pathVersion; verbatim so a stale route is still stale after restore. */
  routeVersion: number;
  state: GuestState;
  destinationObjectId: number | null;
  money: number;
  happiness: number;
  hunger: number;
  thirst: number;
  toiletNeed: number;
  energy: number;
  preferredIntensity: number;
  /** Behavioural: branch conditions and management counters read it, so saved verbatim. */
  currentThought: string;
  /**
   * Phase 30 (still schema 15): the building `currentThought` complains about (a COMPLAINT_THOUGHTS line), written only
   * when non-null, so a park with no complaint is byte-identical. Absent or null restores as null; otherwise a
   * non-negative integer (may name a demolished object, like recentRideIds). Nothing in the simulation reads it.
   */
  thoughtObjectId?: number;
  patienceSeconds: number;
  lastQueueWaitSeconds: number;
  lastRideSatisfaction: number | null;
  lastPurchaseSatisfaction: number | null;
  servicePriceLimit: number | null;
  /** Most recent first, at most 3; may name demolished rides. */
  recentRideIds: number[];
  recentServiceIds: number[];
  ageSeconds: number;
  maximumVisitSeconds: number;
  stateTimerSeconds: number;
  needTimerSeconds: number;
  /** Cosmetic, persisted so a palette reorder in a later build does not repaint old guests. */
  color: number;
  accent: number;
  /** Schema 15 (Phase 29): 0..100. */
  nausea: number;
  /** Schema 15 (Phase 29): 0..100, 50 = comfortable. */
  warmth: number;
  /** Schema 15 (Phase 29): souvenir bits (SOUVENIR_KINDS order), 0..31. */
  souvenirs: number;
  /** Schema 15 (Phase 29): non-null exactly in 'pausing' (a pause) and 'walkingToBench' / 'resting' (a seat). */
  activity: GuestActivity | null;
}

/**
 * DERIVED and reset on restore: `navigation` (PathNetwork, invalidated), `destinationWorldVersion`
 * (-1), `rideDestinations`, `serviceDestinations` (empty; they hold stale PlacedObject references).
 * CONFIG, untouched: the four ruleset multipliers, `world`, `rides`, `shops`, `scenery`.
 */
export interface GuestSimulationState {
  /** The seeded LCG's current uint32 state; the seed itself is irrelevant once this exists. */
  randomState: number;
  /** Id generator; never reset by removeAll(), and ride/shop/ops hold guest ids. */
  nextGuestId: number;
  /** Feeds scenario objectives; counts developer spawns too. Saved separately from nextGuestId. */
  totalArrivals: number;
  /** Float countdown deciding which tick spawns; may be arbitrarily negative at the cap. Never clamp. */
  spawnTimerSeconds: number;
  /** One-tick-lagged copy pushed in from management; not recomputable. */
  parkRating: number;
  /** Map iteration order = spawn order = RNG draw order inside step(). */
  guests: GuestRecordState[];
}

// ---------------------------------------------------------------------------------------------
// RideSimulation (src/game/rides/RideSimulation.ts)
// ---------------------------------------------------------------------------------------------

export interface RideRuntimeState {
  /** Map key; a live world object whose definition kind is 'ride'. */
  objectId: number;
  /** Player intent. */
  open: boolean;
  /** Not derivable: 'running' depends on the cycle clock and flips are order-dependent inside a step. */
  status: RideStatus;
  ticketPrice: number;
  /** FIFO, order-significant (dispatch splices from the front). Guest ids. */
  queueGuestIds: number[];
  /** Order drives the float accumulation order in completeCycle. Guest ids. */
  riderGuestIds: number[];
  dispatchTimerSeconds: number;
  cycleRemainingSeconds: number;
  lifetimeRevenue: number;
  lifetimeOperatingCost: number;
  /** Never reset despite the name (a lifetime counter); the undo probe and management read it. */
  ridersToday: number;
  /** Input to the deterministic breakdown hash. */
  completedCycles: number;
  satisfactionTotal: number;
  satisfactionCount: number;
  /** Ascending timestamps in `elapsedSeconds` units, already trimmed to the last 60 s. */
  boardedAtSeconds: number[];
  condition: number;
  reliability: number;
  broken: boolean;
  pendingBreakdown: boolean;
  /** Input to the deterministic breakdown hash. */
  breakdownCount: number;
  inspectionsCompleted: number;
  repairsCompleted: number;
  lifetimeMaintenanceCost: number;
  /** Mirrors a mechanic's task in operations; the two must be restored together. */
  maintenanceKind: MaintenanceKind | null;
  maintenanceProgress: number;
}

/**
 * No RNG and no id generator exist here (breakdown rolls are a pure hash of objectId,
 * completedCycles and breakdownCount). `dispatchWaitSeconds` and snapshots are derived on read.
 * CONFIG: `world`, `scenery`, `rules` (dispatch and operating-cost multipliers are read live).
 */
export interface RideSimulationState {
  /** Float accumulator compared with boardedAtSeconds; never recomputed from the tick count. */
  elapsedSeconds: number;
  /** Map iteration order, which can differ from objectId order after a demolish and rebuild. */
  rides: RideRuntimeState[];
}

// ---------------------------------------------------------------------------------------------
// ShopSimulation (src/game/shops/ShopSimulation.ts)
// ---------------------------------------------------------------------------------------------

export interface ServiceRuntimeState {
  /** Map key; a live world object with a serviceType. */
  objectId: number;
  /** Validated copy of the world object's definition id (restore throws on mismatch). */
  definitionId: string;
  /** Validated copy of the catalog kind. */
  kind: ServiceKind;
  open: boolean;
  status: ServiceStatus;
  itemPrice: number;
  /** Frozen at creation as catalog duration x ruleset multiplier; the saved value wins over a changed catalog. */
  serviceTimeSeconds: number;
  /** FIFO. Guest ids of guests in state 'queueingForShop' with this destination. */
  queueGuestIds: number[];
  /** A 'shopping' or 'usingFacility' guest with this destination, or null. */
  activeGuestId: number | null;
  serviceRemainingSeconds: number;
  customersServed: number;
  lifetimeRevenue: number;
  satisfactionTotal: number;
  satisfactionCount: number;
}

export interface ServiceCompletionEventState {
  id: number;
  serviceObjectId: number;
  guestId: number;
  kind: WasteServiceKind;
  cell: CellState;
}

export interface ShopSimulationState {
  /** Id generator observable through event ids. */
  nextCompletionEventId: number;
  /**
   * Normally empty at a tick boundary (operations drains it inside the same step); saved anyway so
   * a save taken between shops.step and operations.step, or by a test, is exact.
   */
  completionEvents: ServiceCompletionEventState[];
  /** Map iteration order. */
  services: ServiceRuntimeState[];
}

// ---------------------------------------------------------------------------------------------
// OperationsSimulation (src/game/operations/OperationsSimulation.ts)
// ---------------------------------------------------------------------------------------------

export interface StaffTaskState {
  kind: StaffTaskKind;
  /** null for cleanLitter; bin id for emptyBin; ride id for inspectRide / repairRide. */
  targetObjectId: number | null;
  /** Access cell or pile cell; rewritten on reroute. */
  targetCell: CellState;
  workRemainingSeconds: number;
  /** Frozen at assignment (training level may change mid-task); drives progress ratios. */
  workDurationSeconds: number;
  /** True once rides.beginMaintenance returned 'started'; mirrors the ride's maintenanceKind. */
  maintenanceStarted: boolean;
}

/** Named StaffWorkerState because `StaffState` is already the activity union in operations/types. */
export interface StaffWorkerState {
  /** Map key; unique, ascending (hire order). */
  id: number;
  role: StaffRole;
  state: StaffState;
  position: CellState;
  currentCell: CellState;
  /** Includes the origin as element 0; not re-derivable (planned at an older version and position). */
  route: CellState[];
  routeIndex: number;
  /**
   * Verbatim, like guests. A player path edit between steps legitimately leaves
   * routeVersion !== world.pathVersion, and the next step must reroute exactly as the reference
   * run does. Restore must never "fix" a mismatch.
   */
  routeVersion: number;
  task: StaffTaskState | null;
  /** Float countdown deciding which tick wages post. */
  payrollRemainingSeconds: number;
}

export interface LitterPileState {
  /** The Map key "x,y" is rebuilt from this cell, never trusted from the save. */
  cell: CellState;
  /** Positive integer; the global cap is GAME_CONFIG.operations.litter.maximumUnits. */
  units: number;
  assignedCleanerId: number | null;
  /** Schema 15 (Phase 29): someone was sick here. Written only when true. */
  sick?: true;
}

export interface BinState {
  /** A live world object whose definition has amenityType 'bin'. */
  objectId: number;
  /** Integer 0..capacity. `capacity` itself is DERIVED from the catalog on restore. */
  fill: number;
  assignedCleanerId: number | null;
}

/**
 * DERIVED and reset on restore: `navigation` (invalidated), bin `capacity`, the litter Map key.
 * TRANSIENT: `wasteCounts` (Phase 49: the running waste tally behind `wasteTally()`; never saved, a restore starts at 0).
 * CONFIG: `world`, `rides`, `shops`, `rules`. snapshot() is a lossy UI projection and is not the
 * save.
 */
export interface OperationsState {
  elapsedSeconds: number;
  /** Remainder of the 4 s guest-happiness interval; decides which tick the next penalty fires on. */
  happinessAccumulatorSeconds: number;
  /** Id generator; cannot be derived from max(id) + 1 because firing the newest worker lowers it. */
  nextStaffId: number;
  /** Last guests.size seen in step(); gates hiring between steps. */
  guestPopulation: number;
  /** Mutated in place at runtime; wages, work time and walking speed depend on it. */
  trainingLevel: { cleaner: number; mechanic: number };
  /** Map iteration orders are preserved for all three (assignCleaner iterates bins and litter unsorted). */
  bins: BinState[];
  litter: LitterPileState[];
  staff: StaffWorkerState[];
}

// ---------------------------------------------------------------------------------------------
// ScenerySimulation (src/game/scenery/ScenerySimulation.ts)
// ---------------------------------------------------------------------------------------------

export interface ScenerySourceSignatureState {
  objectId: number;
  /** definitionId:anchor:footprint:appeal:radius, exactly as the runtime builds it. */
  signature: string;
}

/**
 * The score field is the only real state: it is a running sum maintained by add/subtract, history
 * dependent at the 1e-15 level, so a from-scratch rebuild is mathematically equal but not
 * bit-equal. DERIVED and rebuilt: `sources` (descriptors and influence arrays, without applying
 * them), `objectScores`, `latestSnapshot`, `lastWorldVersion` / `lastPathVersion` (set to -1).
 * TRANSIENT: `cacheVersion` (monotone render cache key; never saved, never reset).
 */
export interface SceneryState {
  /** Grid the field was built for; restore throws if the world disagrees. */
  width: number;
  height: number;
  /** Non-zero entries only, ascending index: [cellIndex, exact double > 0]. */
  scores: Array<[number, number]>;
  /**
   * The sources the scores were accumulated from, ascending objectId. A mismatch against what the
   * restored world and catalog produce means the save was written under different content; restore
   * throws content-mismatch instead of keeping scores that no longer add up.
   */
  sources: ScenerySourceSignatureState[];
}

// ---------------------------------------------------------------------------------------------
// ProgressionSimulation, ManagementSimulation, ScenarioSimulation
// ---------------------------------------------------------------------------------------------

/**
 * DERIVED: `completedExperiences`. CONFIG: `world`, content tables. restore must NOT re-register the
 * world's build-access policy (the session's closure over the rules-locked ids must survive).
 */
export interface ProgressionState {
  researchPoints: number;
  completedRideExperiences: number;
  completedServiceExperiences: number;
  /** Running maximum of the rating seen; not derivable. */
  highestParkRating: number;
  /** Definition order (not Set insertion order) so a save is canonical; unknown ids throw. */
  completedProjectIds: ResearchProjectId[];
  /** Cannot be recomputed: the reward was already paid. */
  completedMilestoneIds: ResearchMilestoneId[];
  /**
   * [objectId, last seen satisfactionCount] in Map order. If lost, the first step re-awards every
   * lifetime completion. A demolished ride keeps its entry until the next step prunes it.
   */
  lastRideCompletionCounts: Array<[number, number]>;
  lastServiceCompletionCounts: Array<[number, number]>;
  /** Normally empty; purchase() fills it between ticks, and dropping it swallows a toast and a notification. */
  pendingEvents: ProgressionEvent[];
  nextEventId: number;
}

/**
 * Deliberately NOT saved: `latestOperations`, `latestParkOperations`, `latestScenery` (re-supplied
 * by the next step; between restore and that step snapshot() shows empty sections, which is
 * documented and handled by the UI's refresh) and the connectivity cache (`connectivityWorldVersion`
 * / `connectivityPathVersion` reset to -1, `connectedObjectIds` cleared, `entranceConnectedPathCount`
 * 0, `entranceConnectedTip` null, rebuilt by the next rating computation). CONFIG: `world`, MANAGEMENT_CONFIG.
 */
export interface ManagementState {
  elapsedSeconds: number;
  /** Carry of the 5 s trend interval. */
  trendAccumulatorSeconds: number;
  /** Baseline for reconciling direct cash changes; must come from the same instant as the world. */
  lastObservedCash: number;
  /** Filter for unseen transactions; resetting it would re-count the whole 300-row history. */
  lastProcessedTransactionId: number;
  latestGuestCount: number;
  /**
   * Raw unrounded sums for exactly the 12 categories, plus `land` (schema 14, Phase 21) only once a parcel has been
   * bought, so every park without a land purchase keeps its exact 12 keys; snapshot() rounds, the save must not.
   */
  categoryTotals: Record<Exclude<ManagementTransactionCategory, 'land' | 'souvenirSales'>, FinancialTotals>
    & { land?: FinancialTotals; souvenirSales?: FinancialTotals };
  totals: FinancialTotals;
  /** The previous score feeds rating-milestone crossing before it is recomputed. */
  latestRating: ParkRatingSnapshot;
  /** Up to 120 points; the falling-rating notification reads them. */
  trendPoints: ManagementTrendPoint[];
  /** Capped at 20 and never drained by the app today, so they accumulate and are user-visible. */
  pendingNotifications: ManagementNotification[];
  nextNotificationId: number;
  /** [kind, seconds] cooldown timestamps, Map order. */
  lastNotificationAt: Array<[ManagementNotificationKind, number]>;
  /** Hysteresis memory deciding thresholds and whether a notification re-fires. */
  activeNotificationSeverities: Array<[ManagementNotificationKind, ManagementNotificationSeverity]>;
  /** false until the first step; a pre-first-step save must restore false and empty trends. */
  ratingMilestonesInitialized: boolean;
  /** Sorted ascending. */
  emittedRatingMilestones: number[];
}

/** One latched First Day step. Written once, never changed: completion is sticky. */
export interface OnboardingCompletionState {
  id: OnboardingStepId;
  /** Integer world tick of the evaluation that latched it (<= the saved world tick). */
  tick: number;
  /** The observed value that satisfied the step; fractional for profit and rating. */
  evidence: number;
}

/**
 * Everything the First Day tracker owns; it has no derived or config fields. The whole object is
 * null in a scenario park, exactly when `scenarioId` is.
 */
export interface OnboardingState {
  /** Player (or the dev park) switched the hints off for this park; permanent. */
  dismissed: boolean;
  /** Latch order; ticks never decrease. Unknown ids fail with content-mismatch. */
  completed: OnboardingCompletionState[];
  /** Player skipped these; a skipped step still latches if its evidence arrives. */
  skipped: OnboardingStepId[];
  /** Litter was seen at some evaluation; the litter branch of "Fix a problem" needs it. */
  sawLitter: boolean;
}

/** DERIVED/CONFIG: `definition` (resolved by id), `lockedDefinitionIds` (display copy). */
export interface ScenarioState {
  /** Validated equal to the session's scenario definition id. */
  scenarioId: ParkScenarioId;
  /** Latch; step() returns early when not running, and the result event must never fire twice. */
  status: ScenarioStatus;
  elapsedSeconds: number;
  sustainedSeconds: number;
  longestSustainedSeconds: number;
  completedAtSeconds: number | null;
  resultEvidence: string | null;
  /** Replaced every step even after the latch; objectiveSnapshot() reads it. */
  latestMetrics: ScenarioMetrics;
  /** Normally empty between ticks; carried so a latch event is never lost. */
  pendingEvents: ScenarioEvent[];
}

// ---------------------------------------------------------------------------------------------
// ParkSession-level fields and the whole save
// ---------------------------------------------------------------------------------------------

/** ParkRuleset without readonly/frozen, copied by value. */
export interface ParkRulesetState {
  startingCash: number;
  /** Order preserved. */
  lockedDefinitionIds: string[];
  arrivalIntervalMultiplier: number;
  guestBudgetMultiplier: number;
  servicePriceToleranceMultiplier: number;
  needDecayMultiplier: number;
  constructionCostMultiplier: number;
  rideOperatingCostMultiplier: number;
  rideDispatchMultiplier: number;
  serviceDurationMultiplier: number;
  needReliefMultiplier: number;
  staffSalaryMultiplier: number;
  staffSpeedMultiplier: number;
  /** Scales the rain and storm columns of the weather chain for days drawn from now on. */
  wetWeatherMultiplier: number;
  /** Scales the construction cost of chain lifts (schema 5). */
  chainLiftCostMultiplier: number;
  /** Scales what a recolour costs in a Scenario or on The Map (schema 7; the per-mode config is 0 by default). */
  recolourCostMultiplier: number;
  /*
   * Phase 25, the seven card-modifiable multipliers: written only when != 1 (after `recolourCostMultiplier`, before the
   * biome keys), so every park without such a card keeps its exact `rules` object and no rules migration exists.
   * Absent = 1; present = a finite number in 0.01..100 other than 1 (an explicit 1 is normalised away on restore).
   */
  weatherEffectMultiplier?: number;
  nightArrivalMultiplier?: number;
  dayLengthMultiplier?: number;
  crowdCapacityMultiplier?: number;
  litterImpactMultiplier?: number;
  breakdownRateMultiplier?: number;
  sceneryAppealMultiplier?: number;
  /**
   * Schema 8, biome layer. Written ONLY when the value is not 1, so a Meadow park and every park written before
   * schema 8 keep their exact `rules` object. Absent = 1; present = a finite number in 0.5..2.
   */
  hungerRateMultiplier?: number;
  thirstRateMultiplier?: number;
  /**
   * Schema 10, profile-bonus layer, after the biome keys. Written ONLY when a permanent bonus grants it, so every
   * ruleset without bonuses (every park written before schema 10) keeps its exact object.
   * `startingResearchPoints`: an integer 1..30; `extraCardSlots`: exactly 1.
   */
  startingResearchPoints?: number;
  extraCardSlots?: number;
  /**
   * Phase 16 (schema 12, content version 3), base layer, after the bonus keys. Written ONLY when non-neutral, so every
   * park written before Phase 16 (and every park compiled under a neutral config) keeps its exact object.
   * `themeAffinity`: absent = 0 (no theme affinity); present = a finite number in 0..0.5.
   * `researchCostScale`: absent = 1 (base RP costs); present = a finite number in 1..20. An explicit neutral value is
   * normalised away on restore; anything outside is refused. Base RP units are unchanged
   * everywhere they are saved (`startingResearchPoints` stays 1..30, progression points are effective points).
   */
  themeAffinity?: number;
  researchCostScale?: number;
}

/** What the profile gave a park when it started (schema 10); validated strictly on restore. */
export interface ParkGrantState {
  /** Profile-gated catalog ids this park may build from the start; catalog order, unique, each gated. */
  unlockedBuildingIds: string[];
  /** Permanent bonuses compiled into this park's rules; canonical order, unique, each allowed in `mode`. */
  bonusIds: BonusId[];
}

/**
 * The park calendar (src/game/calendar). The day and the time of day are a pure function of the
 * world tick plus this state: it only exists so a sandbox day-length change keeps the clock
 * continuous. Present in every park (scenario parks keep the default length).
 */
export interface CalendarState {
  /** Integer, 60..7200 simulation seconds per day. */
  dayLengthSeconds: number;
  /** Integer >= 0 and <= the saved world tick: the tick the anchor position was taken at. */
  anchorTick: number;
  /** Integer >= 0: calendar position at `anchorTick`, in 1e-6 day. */
  anchorUnits: number;
  /** Sandbox look setting: pins the displayed time of day (the day count keeps running). */
  timeLock: TimeLock;
  /** Sandbox: opening hours on. Off means the gate is open around the clock. */
  hoursEnabled: boolean;
  /** Integer opening and closing hour on the raw clock (open < close, at least minSpan apart). */
  openHour: number;
  closeHour: number;
}

// ---------------------------------------------------------------------------------------------
// The map layer (src/game/maps, owned by GameWorld; the save key is `map`, schema 8)
// ---------------------------------------------------------------------------------------------

/** One REMAINING prop (cleared ones are gone). Ids are the stable row-major ids of the map; ascending, never reused. */
export interface PropState {
  /** Integer 1..MAXIMUM_SAVED_COUNTER, strictly ascending. */
  id: number;
  /** An unknown kind fails with content-mismatch; a kind of another biome with invalid-state. */
  kind: PropKindId;
  /** Anchor: the min corner of the footprint. Integers inside the map. */
  x: number;
  y: number;
  /** 0..3; for a 2x1 prop an odd turn lies along y, otherwise it only varies the look. */
  rotation: Rotation;
}

/**
 * The land a park was played on, saved so a later edit of a shipped map (or of the step-2 generator) can never
 * change a park in progress, and generated maps need no regeneration on load. `world` stays byte-identical for
 * every Meadow park; the props are NOT placed objects (see ARCHITECTURE.md, Biomes and maps).
 */
export interface MapState {
  /** A shipped map id, or any [a-z0-9-]{1,64} (a saved or generated map; the UI says 'Custom map'). */
  id: string;
  /** An unknown biome fails with content-mismatch, like an unknown scenario. */
  biomeId: BiomeId;
  /** 32 x 32 until Phase 21; anything else is refused naming Phase 21. */
  width: number;
  height: number;
  /** On the border, not on a corner, `facing` = the inward direction of that border, on ground that is not water. */
  entrance: { x: number; y: number; facing: 'north' | 'east' | 'south' | 'west' };
  /** `height` rows of `width` characters from '.' (base), ',' (alt) and '~' (water); props are NOT in the rows. */
  ground: string[];
  /** The REMAINING props, ascending id, at most GAME_CONFIG.maps.maxSavedProps (checked before iterating). */
  props: PropState[];
  /**
   * Schema 9, written last: how a generated map was made (biome, seed, generator version, options), null for a
   * hand-made map. Informational: restore validates it and never regenerates (the stored ground and props win).
   */
  recipe: MapRecipe | null;
}

/**
 * Version 9 of the park state: version 8 plus `map.recipe` (written last inside `map`: null for a hand-made map, else
 * the generator recipe; migration 8->9 sets null).
 *
 * Version 8 of the park state: version 7 plus the `map` layer (written LAST) and, only when a biome changes
 * them, `rules.hungerRateMultiplier` / `rules.thirstRateMultiplier` (migration 7->8: the Meadow map, no new rule
 * keys, since an absent key reads as 1).
 *
 * Version 7 of the park state: ParkSession's own fields plus one state per owner.
 * Version 6 is the same shape without `world.gateColours` and `rules.recolourCostMultiplier`
 * (migration 6->7: the gate has the default colours and recolouring costs the default multiplier 1).
 * Version 5 is the same shape without `colours` on placed objects (migration 5->6: every object has the
 * default colours).
 * Version 4 is the same shape without `freeClimb` on coaster pieces and `rules.chainLiftCostMultiplier`
 * (migration 4->5: every old piece is chained). Version 3 is the same shape without `weather`, the
 * opening-hours fields of `calendar` and `rules.wetWeatherMultiplier`
 * (migration 3->4 adds them with defaults), version 2 additionally lacks `calendar` (migration 2->3),
 * version 1 also lacks `onboarding` (migration 1->2). No older shape has a type of its own because
 * nothing outside the migrations reads it).
 *
 * The compiled ruleset is stored (not only the scenario and card ids): card multipliers multiply
 * in loadout order before a three-decimal round, balance changes to cards must not change a park
 * already in progress, and owners bake ruleset values at creation (service duration). The ids are
 * still stored because scenario definitions and cards are looked up by id for display, objectives
 * and the build-access closure. NOT saved, on purpose: construction undo (replaced by snapshots in
 * step 3), UI selection and inspectors, renderer state, and the tour profile.
 */
export interface ParkSaveV9 {
  /** null = Sandbox. An unknown id fails with content-mismatch; it is never dropped. */
  scenarioId: ParkScenarioId | null;
  /** Ordered, already de-duplicated and truncated to the scenario's slots. Unknown ids fail. */
  activeCardIds: PulseCardId[];
  /** Constructor seed (the RNG's current state is in guests.randomState). Used to rebuild a fresh session. */
  seed: number;
  rules: ParkRulesetState;
  world: GameWorldState;
  scenery: SceneryState;
  calendar: CalendarState;
  weather: WeatherState;
  rides: RideSimulationState;
  shops: ShopSimulationState;
  guests: GuestSimulationState;
  operations: OperationsState;
  progression: ProgressionState;
  management: ManagementState;
  /** null if and only if scenarioId is non-null: First Day applies to the Sandbox only. */
  onboarding: OnboardingState | null;
  /** null if and only if scenarioId is null. */
  scenario: ScenarioState | null;
  /** Schema 8. The land: ground, entrance and the remaining props. Written last. */
  map: MapState;
}

/**
 * Schema 10 (Phase 22) is schema 9 plus two keys written last, after `map`: the game mode and the profile grant
 * (migration 9->10: `sandbox` or `scenario` by scenarioId, an empty grant). The rules may carry the two bonus-layer keys.
 */
export interface ParkSaveV10 extends ParkSaveV9 {
  mode: GameMode;
  grant: ParkGrantState;
}

/**
 * Schema 11 (Phase 23) is schema 10 plus one optional key written LAST: `run`, the run a stage of The Map belongs to. It
 * exists if and only if `mode` is `run`, so Sandbox and Scenario states are byte-identical to schema 10 (migration 10->11:
 * a hand-edited `run` key is dropped and the interim Park Tour `run` parks become Scenario parks).
 */
export interface ParkSaveV11 extends ParkSaveV10 {
  run?: RunStateV1;
}

/**
 * The one-shot ledger of a run park (Phase 25, `src/game/cards/CardPlays.ts`). Run mode only: it is not an owner in
 * `RESTORE_ORDER` (that would add a key to every Sandbox and Scenario save); the session restores it explicitly after
 * `scenario`, like the schema-11 `run` key.
 */
export interface CardPlaysState {
  /** Every one-shot played in this park, in play order: distinct, in the run's loadout, `tick` <= the world tick. */
  played: Array<{ cardId: PulseCardId; tick: number }>;
  /**
   * Deferred one-shot costs not yet applied, ascending by `dueTick` (then insertion). `amount` is negative integer
   * dollars; a live stage never holds an entry that is already due (the session applies them at the start of a step).
   */
  pending: Array<{ cardId: PulseCardId; dueTick: number; amount: number; label: string; category: 'other' | 'maintenance' }>;
}

/**
 * Schema 12 (Phase 25) is schema 11 plus the one-shot ledger `plays`, written after `grant` and before `run` (`run` stays
 * last). Both exist if and only if `mode` is `run`, so Sandbox and Scenario states are byte-identical to schema 11
 * (migration 11->12: a run park gets an empty ledger and run format 2; any other park is unchanged).
 */
export interface ParkSaveV12 extends ParkSaveV10 {
  plays?: CardPlaysState;
  run?: RunStateV2;
}

/** The saved crowd pressure field (Phase 14, schema 13); the type lives with the crowd contract. */
export type { CrowdState } from '../crowd/types';

/**
 * The ruleset of schema 13 (Phase 14, content version 4): schema 12 plus the base-layer key `crowdFeedback`, written LAST
 * (after the Phase 16 keys) and ONLY when not 0, so every park written before Phase 14 (and every park compiled under
 * a config with feedback 0) keeps its exact `rules` object. Absent = 0 = off; present = a finite number in
 * (0, GAME_CONFIG.crowd.maximumFeedback]. An explicit 0 is normalised away on restore; anything else is refused.
 * A separate interface (not a new member of ParkRulesetState) so the schema-12 tables stay exactly what schema 12 wrote.
 */
export interface ParkRulesetStateV13 extends ParkRulesetState {
  crowdFeedback?: number;
}

/**
 * Schema 13 (Phase 14) is schema 12 plus the optional top-level `crowd` key: the rolling pressure field
 * (`src/game/crowd/CrowdSimulation.ts`), sparse `[cellIndex, value]` pairs ascending by cell, integer values in
 * 1..2^31-1. It exists EXACTLY when `rules.crowdFeedback` is present (`checkCrowdLaw` in consistency.ts), because only
 * then can the field change the future; a park without the rule keeps its field outside the save. Not an owner in
 * `RESTORE_ORDER` (that would add a key to every save): the session restores it explicitly after `guests`. Migration
 * 12->13 is the identity, so every schema-12 park is byte-identical at schema 13.
 */
export interface ParkSaveV13 extends ParkSaveV12 {
  rules: ParkRulesetStateV13;
  crowd?: CrowdState;
}

/**
 * The ruleset of schema 14 (Phase 21): schema 13 plus the card-modifiable `landCostMultiplier`, written like the Phase 25
 * keys (only when != 1, right after `sceneryAppealMultiplier`), so every park without a land price change keeps its exact
 * `rules` object. Absent = 1; present = a finite number in 0.01..100 other than 1.
 */
export interface ParkRulesetStateV14 extends ParkRulesetStateV13 {
  landCostMultiplier?: number;
  /** Phase 40 (schema 16): front-only access, written LAST and only when on (exactly 1). Absent = every side. */
  frontAccess?: 1;
}

/**
 * Schema 14 (Phase 21, land expansion) is schema 13 plus four optional keys, each written only when it carries
 * something, so every park without restricted land is byte-identical at schema 14: `world.land` (the owned parcels of a
 * park whose map is not wholly owned, see LandState), `rules.landCostMultiplier`, `management.categoryTotals.land` (once a
 * parcel was bought) and `scenario.latestMetrics.ownedParcels` (on restricted land). Maps may now be 32 to 64 cells a
 * side in whole parcels. Migration 13->14 is the identity (it drops hand-edited Phase 21 keys a schema-13 build ignored).
 */
export interface ParkSaveV14 extends ParkSaveV13 {
  rules: ParkRulesetStateV14;
}

/**
 * Schema 15 (Phase 29, guest life and souvenirs) is schema 14 with four more fields on every guest (`nausea`, `warmth`,
 * `souvenirs`, `activity`, see GuestRecordState), three new guest states ('walkingToBench', 'resting', 'pausing'), the
 * optional `sick` flag on a litter pile (written only when true) and the optional `management.categoryTotals.souvenirSales`
 * (once a souvenir was sold). Migration 14->15 gives every saved guest the neutral values (no nausea, comfortable, no
 * souvenirs, no activity). Phase 30 adds the optional guest key `thoughtObjectId` (written only when a complaint names
 * a building) without a schema bump: a schema-15 save without it loads as before, and one with it loads on any
 * schema-15 reader that ignores unknown keys.
 */
export type ParkSaveV15 = ParkSaveV14;

/**
 * Schema 16 (Phase 40, building fronts) is schema 15 plus the optional ruleset key `frontAccess` (exactly 1, written
 * last, only when on; see ParkRuleset). Rotations 2 and 3 now draw the building facing that way (a picture change, not
 * a state change). Migration 15->16 is the identity apart from dropping a hand-edited `rules.frontAccess`, which a
 * schema-15 build ignored: every schema-15 park keeps every side and is byte-identical at schema 16.
 */
export type ParkSaveV16 = ParkSaveV15;

/** @deprecated use ParkSaveV14. Kept so code outside src/game keeps compiling. */
export type ParkSaveV8 = ParkSaveV14;
/** @deprecated use ParkSaveV14. Kept so code outside src/game keeps compiling. */
export type ParkSaveV7 = ParkSaveV14;
/** @deprecated use ParkSaveV14. Kept so code outside src/game keeps compiling. */
export type ParkSaveV6 = ParkSaveV14;
/** @deprecated use ParkSaveV14. Kept so code outside src/game keeps compiling. */
export type ParkSaveV5 = ParkSaveV14;
/** @deprecated use ParkSaveV14. Kept so code outside src/game keeps compiling. */
export type ParkSaveV4 = ParkSaveV14;
