import { BUILD_BY_ID } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import { PathNetwork } from '../navigation/PathNetwork';
import type { RideSimulation } from '../rides/RideSimulation';
import { ZERO_SCENERY_INFLUENCE, type SceneryInfluenceReader } from '../scenery/types';
import type { ShopSimulation } from '../shops/ShopSimulation';
import type { ServiceKind } from '../shops/types';
import type { Cell, PlacedObject } from '../types';
import type { GameWorld } from '../World';
import { neutralConditions, type ParkConditions } from '../weather/types';
import { invalidState } from '../save/version';
import { MAXIMUM_SAVED_COUNTER, MAXIMUM_SAVED_PRICE, MAXIMUM_SAVED_SECONDS, requireNumberInRange } from '../save/ranges';
import { plainNumber } from '../save/plainData';
import type { CellState, GuestRecordState, GuestSimulationState, Serializable } from '../save/state';
import { GUEST_ACTIVITIES, GUEST_FLOURISHES, type Guest, type GuestActivity, type GuestPause, type GuestSeat, type GuestSnapshot, type GuestState, type ThoughtInsight } from './types';
import { SOUVENIR_KINDS, type SouvenirKind } from '../types';
import {
  ALL_SOUVENIR_BITS,
  COMPLAINT_THOUGHTS,
  PRICEY_SOUVENIR_THOUGHT,
  SOUVENIR_THOUGHT,
  THOUGHTS,
  holdsSouvenir,
  isDryUnderUmbrella,
  isExposed,
  isSoaked,
  pauseSeconds,
  setThought,
  souvenirBit,
  souvenirDesire,
  souvenirPriceLimit,
  startPause,
  targetWarmth,
} from './life';
import { NEUTRAL_CROWD_READER } from '../crowd/CrowdSimulation';
import type { CrowdFlowReader } from '../crowd/types';

/**
 * What a guest simulation reads from the crowd field. `strength` scales the severe-tile happiness loss (a
 * `CrowdSimulation` carries its ruleset strength; a bare reader whose `isSevereAt` can be true counts as strength 1).
 */
export type GuestCrowdReader = CrowdFlowReader & { readonly strength?: number };

interface RideDestination {
  object: PlacedObject;
  accessCells: Cell[];
  /** Under a roof (the catalog's openAir === false): preferred in the rain. Computed once per world change. */
  covered: boolean;
}

interface ServiceDestination {
  object: PlacedObject;
  accessCells: Cell[];
  kind: ServiceKind;
  /** Warm food or cold treats, for the weather bias; null for everything else. */
  temperature: 'warm' | 'cold' | null;
  /** Phase 29: the keepsake a souvenir stall sells; null for every other service. */
  souvenir: SouvenirKind | null;
}

/** Phase 29: a bench guests can sit on (two seats), reached from its path access cells. */
interface BenchDestination {
  object: PlacedObject;
  accessCells: Cell[];
}

/** Phase 29: scenery a guest may stop to admire, with the reach of its appeal. */
interface SceneryLandmark {
  object: PlacedObject;
  appeal: number;
  radius: number;
  centreX: number;
  centreY: number;
}

interface DestinationChoice {
  kind: 'ride' | 'service';
  destination: RideDestination | ServiceDestination;
  utility: number;
  servicePriceLimit: number | null;
}

class SeededRandom {
  constructor(private state: number) {}
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  /** The whole generator is this one uint32, so saving it is saving the RNG. */
  getState(): number {
    return this.state;
  }

  setState(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value >= 0x1_0000_0000) {
      throw new RangeError(`SeededRandom state must be a uint32, received ${value}`);
    }
    this.state = value;
  }
}

const OWNER = 'GuestSimulation';

/**
 * Every GuestState, as a record so adding a state to the union without listing it here is a compile
 * error: an unknown state would otherwise freeze a restored guest silently (no branch in step()).
 */
const GUEST_STATE_MEMBERS: Record<GuestState, true> = {
  entering: true,
  wandering: true,
  walkingToRide: true,
  queueing: true,
  riding: true,
  walkingToShop: true,
  queueingForShop: true,
  shopping: true,
  usingFacility: true,
  leaving: true,
  walkingToBench: true,
  resting: true,
  pausing: true,
};

const seatBit = (seat: GuestSeat): number => (seat === 'seatLeft' ? 1 : 2);
const isSeat = (activity: GuestActivity): activity is GuestSeat => activity === 'seatLeft' || activity === 'seatRight';

const MAXIMUM_RECENT_IDS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireFinite = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidState(OWNER, path, 'must be a finite number');
  return value;
};

const requireInteger = (value: unknown, path: string, minimum: number, maximum = MAXIMUM_SAVED_COUNTER): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidState(OWNER, path, `must be an integer in ${minimum}..${maximum}`);
  }
  return value;
};

const requireNullableRange = (value: unknown, path: string, minimum: number, maximum: number): number | null =>
  value === null ? null : requireNumberInRange(OWNER, value, path, minimum, maximum);

/** The map's extent, for the bound checks of a restore (never a literal: the map carries its own size). */
interface MapBounds {
  readonly width: number;
  readonly height: number;
}

const requireCell = (value: unknown, path: string, integer: boolean, bounds: MapBounds): CellState => {
  if (!isRecord(value)) throw invalidState(OWNER, path, 'must be a cell object');
  // Inside the map: an off-map guest (or one at 1e300) would walk or render forever and never
  // be found by any path query. Positions are float but always stay on the grid's extent.
  const x = requireNumberInRange(OWNER, value.x, `${path}.x`, 0, bounds.width - 1);
  const y = requireNumberInRange(OWNER, value.y, `${path}.y`, 0, bounds.height - 1);
  if (integer && (!Number.isInteger(x) || !Number.isInteger(y))) throw invalidState(OWNER, path, 'must have integer coordinates');
  return { x, y };
};

const requireRecentIds = (value: unknown, path: string): number[] => {
  if (!Array.isArray(value)) throw invalidState(OWNER, path, 'must be an array');
  if (value.length > MAXIMUM_RECENT_IDS) throw invalidState(OWNER, path, `must hold at most ${MAXIMUM_RECENT_IDS} ids`);
  return value.map((id, index) => requireInteger(id, `${path}[${index}]`, 0));
};

/** Validates one saved guest and returns a fresh deep copy (no aliasing with the held state). */
const readGuestRecord = (value: unknown, path: string, bounds: MapBounds): Guest => {
  if (!isRecord(value)) throw invalidState(OWNER, path, 'must be an object');
  const id = requireInteger(value.id, `${path}.id`, 1);
  if (!Array.isArray(value.route)) throw invalidState(OWNER, `${path}.route`, 'must be an array');
  const route = value.route.map((cell, index) => requireCell(cell, `${path}.route[${index}]`, true, bounds));
  const routeIndex = requireInteger(value.routeIndex, `${path}.routeIndex`, 0);
  if (routeIndex > route.length) throw invalidState(OWNER, `${path}.routeIndex`, `must be at most route.length (${route.length})`);
  // A route is a walk on the 4-connected grid; a teleporting step would let a guest cross the map
  // in one tick and no path query would ever have produced it.
  for (let step = 1; step < route.length; step += 1) {
    if (Math.abs(route[step].x - route[step - 1].x) + Math.abs(route[step].y - route[step - 1].y) !== 1) {
      throw invalidState(OWNER, `${path}.route[${step}]`, 'is not adjacent to the previous route cell');
    }
  }
  const state = value.state;
  if (typeof state !== 'string' || !Object.prototype.hasOwnProperty.call(GUEST_STATE_MEMBERS, state)) {
    throw invalidState(OWNER, `${path}.state`, `is not a known guest state (${String(state)})`);
  }
  const destinationObjectId = value.destinationObjectId === null
    ? null
    : requireInteger(value.destinationObjectId, `${path}.destinationObjectId`, 0);
  if (typeof value.currentThought !== 'string') throw invalidState(OWNER, `${path}.currentThought`, 'must be a string');
  // Phase 30: an optional key (absent = null), validated like destinationObjectId; it may name a demolished object.
  const thoughtObjectId = value.thoughtObjectId === undefined || value.thoughtObjectId === null
    ? null
    : requireInteger(value.thoughtObjectId, `${path}.thoughtObjectId`, 0);
  const activity = value.activity;
  if (activity !== null && (typeof activity !== 'string' || !(GUEST_ACTIVITIES as readonly string[]).includes(activity))) {
    throw invalidState(OWNER, `${path}.activity`, `is not a known activity (${String(activity)})`);
  }
  // The activity belongs to its state: a pause to 'pausing', a seat to the bench states, a flourish (or nothing) to
  // 'wandering', nothing to anything else.
  const benchState = state === 'walkingToBench' || state === 'resting';
  if (state === 'pausing' ? (activity === null || isSeat(activity as GuestActivity))
    : benchState ? (activity === null || !isSeat(activity as GuestActivity))
      : state === 'wandering' ? (activity !== null && !(GUEST_FLOURISHES as readonly string[]).includes(activity as string))
        : activity !== null) {
    throw invalidState(OWNER, `${path}.activity`, `does not fit the state ${String(state)} (${String(activity)})`);
  }
  const position = requireCell(value.position, `${path}.position`, false, bounds);
  const currentCell = requireCell(value.currentCell, `${path}.currentCell`, true, bounds);
  if (Math.abs(position.x - currentCell.x) > 1 || Math.abs(position.y - currentCell.y) > 1) {
    throw invalidState(OWNER, `${path}.position`, 'is more than one cell away from currentCell');
  }
  return {
    id,
    position,
    currentCell,
    route,
    routeIndex,
    routeVersion: requireInteger(value.routeVersion, `${path}.routeVersion`, 0),
    state: state as GuestState,
    destinationObjectId,
    money: requireNumberInRange(OWNER, value.money, `${path}.money`, 0, MAXIMUM_SAVED_PRICE),
    happiness: requireNumberInRange(OWNER, value.happiness, `${path}.happiness`, 0, 100),
    hunger: requireNumberInRange(OWNER, value.hunger, `${path}.hunger`, 0, 100),
    thirst: requireNumberInRange(OWNER, value.thirst, `${path}.thirst`, 0, 100),
    toiletNeed: requireNumberInRange(OWNER, value.toiletNeed, `${path}.toiletNeed`, 0, 100),
    energy: requireNumberInRange(OWNER, value.energy, `${path}.energy`, 0, 100),
    preferredIntensity: requireNumberInRange(OWNER, value.preferredIntensity, `${path}.preferredIntensity`, 0, 100),
    currentThought: value.currentThought,
    thoughtObjectId,
    patienceSeconds: requireNumberInRange(OWNER, value.patienceSeconds, `${path}.patienceSeconds`, 0, MAXIMUM_SAVED_SECONDS),
    lastQueueWaitSeconds: requireNumberInRange(OWNER, value.lastQueueWaitSeconds, `${path}.lastQueueWaitSeconds`, 0, MAXIMUM_SAVED_SECONDS),
    lastRideSatisfaction: requireNullableRange(value.lastRideSatisfaction, `${path}.lastRideSatisfaction`, 0, 100),
    lastPurchaseSatisfaction: requireNullableRange(value.lastPurchaseSatisfaction, `${path}.lastPurchaseSatisfaction`, 0, 100),
    servicePriceLimit: requireNullableRange(value.servicePriceLimit, `${path}.servicePriceLimit`, 0, MAXIMUM_SAVED_PRICE),
    recentRideIds: requireRecentIds(value.recentRideIds, `${path}.recentRideIds`),
    recentServiceIds: requireRecentIds(value.recentServiceIds, `${path}.recentServiceIds`),
    ageSeconds: requireNumberInRange(OWNER, value.ageSeconds, `${path}.ageSeconds`, 0, MAXIMUM_SAVED_SECONDS),
    maximumVisitSeconds: requireNumberInRange(OWNER, value.maximumVisitSeconds, `${path}.maximumVisitSeconds`, 1, GAME_CONFIG.guests.maximumVisitSeconds),
    stateTimerSeconds: requireNumberInRange(OWNER, value.stateTimerSeconds, `${path}.stateTimerSeconds`, 0, MAXIMUM_SAVED_SECONDS),
    needTimerSeconds: requireNumberInRange(OWNER, value.needTimerSeconds, `${path}.needTimerSeconds`, 0, MAXIMUM_SAVED_SECONDS),
    color: requireInteger(value.color, `${path}.color`, 0, 0xffffff),
    accent: requireInteger(value.accent, `${path}.accent`, 0, 0xffffff),
    nausea: requireNumberInRange(OWNER, value.nausea, `${path}.nausea`, 0, 100),
    warmth: requireNumberInRange(OWNER, value.warmth, `${path}.warmth`, 0, 100),
    souvenirs: requireInteger(value.souvenirs, `${path}.souvenirs`, 0, ALL_SOUVENIR_BITS),
    activity: activity as GuestActivity | null,
  };
};

const copyCell = ({ x, y }: Cell, path: string): CellState => ({
  x: plainNumber(x, `${path}.x`),
  y: plainNumber(y, `${path}.y`),
});

const nullablePlain = (value: number | null, path: string): number | null =>
  value === null ? null : plainNumber(value, path);

const keyOf = ({ x, y }: Cell): string => `${x},${y}`;
const safeMultiplier = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.min(4, Math.max(0.25, value)) : 1;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/** Why the guest ceiling is 0 (Phase 11, PA-009), checked in this order; null when guests can arrive. */
export type GuestCapacityBlock = 'park-closed' | 'after-hours' | 'too-few-paths' | 'no-open-ride' | null;

/** The guest ceiling and its parts, as `GuestSimulation.capacityView()` reads them (Phase 11, PA-009). */
export interface GuestCapacityView {
  /** Exactly what `updateArrivals` compares the guest count against; 0 when `blocked`. */
  ceiling: number;
  /** Σ `rideProfile.capacity` of the open, reachable rides ("ride seats" in the UI). */
  rideSeats: number;
  /** The park rating the formula used (0..100). */
  rating: number;
  /** The card-driven crowd capacity multiplier; 1 unless rules or cards change it. */
  crowdMultiplier: number;
  /** `GAME_CONFIG.guests.maximum`. */
  hardMaximum: number;
  blocked: GuestCapacityBlock;
}

export const GUEST_COLORS: readonly number[] =[0xff6f91, 0x61d6c4, 0x8f7cf7, 0xffb454, 0x4ea8de, 0xef709d];
export const GUEST_ACCENTS: readonly number[] = [0xfff0a8, 0xffffff, 0xbff5e5, 0xffd2df];
const CARDINALS: readonly Cell[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
/** Phase 14 (design Q2): what a moving guest on a severe tile thinks when nothing fresher applies. */
export const CROWDED_THOUGHT = "It's so crowded here.";
/** Phase 29: the status of a guest on their way to a bench seat. */
const SEEKING_BENCH_THOUGHT = 'Looking for somewhere to sit.';
/** Phase 30: the one Park Pulse line for every keepsake thought. */
export const SOUVENIR_INSIGHT = 'guests are enjoying their souvenirs.';
const INSIGHT_TEXT = new Map<string, string>([
  ['I could use a drink.', 'guests want something to drink.'],
  ['I am getting hungry.', 'guests are getting hungry.'],
  ['I need a toilet.', 'guests need a toilet.'],
  ["I'm not paying that much.", 'guests think a price is too high.'],
  ["I can't afford that anymore.", 'guests think a price is too high.'],
  ['This queue is taking forever.', 'guests are frustrated by a long queue.'],
  ["I can't find anything to drink.", 'guests cannot find a drink stall.'],
  ["I can't find anything to eat.", 'guests cannot find food.'],
  ["I can't find a toilet.", 'guests cannot find a toilet.'],
  ['That snack hit the spot!', 'guests enjoyed their food.'],
  ['That was refreshing!', 'guests enjoyed their drinks.'],
  ['Much better.', 'guests are happy with the facilities.'],
  ['That facility could be better.', 'guests are unhappy with a facility.'],
  ["I'm too thirsty to stay.", 'guests are leaving because they are thirsty.'],
  ['I need to find food elsewhere.', 'guests are leaving because they could not find food.'],
  ["I couldn't find a toilet.", 'guests are leaving because they could not find a toilet.'],
  ['What a lovely spot.', 'guests enjoy the scenery here.'],
  [CROWDED_THOUGHT, 'guests find the paths too crowded'],
  [THOUGHTS.queasy, 'guests feel queasy after intense rides.'],
  [THOUGHTS.vomit, 'guests are being sick after intense rides.'],
  [THOUGHTS.afterVomit, 'guests are being sick after intense rides.'],
  [THOUGHTS.hot, 'guests are too hot: cold drinks and sun hats help.'],
  [THOUGHTS.cold, 'guests are cold: warm food and drinks help.'],
  [THOUGHTS.soaked, 'guests are getting soaked: umbrellas help.'],
  [THOUGHTS.sick, 'guests found vomit on a path.'],
  [THOUGHTS.noBench, 'guests want benches to rest on.'],
  [THOUGHTS.balloonLost, 'guests lost their balloons.'],
  [THOUGHTS.admire, 'guests enjoy the scenery here.'],
  [THOUGHTS.photo, 'guests are taking photos of the scenery.'],
  [THOUGHTS.watchRide, 'guests stop to watch the rides.'],
  [THOUGHTS.rested, 'guests are resting on benches.'],
  // Phase 30: the five keepsake lines, the glow wand at night and the dry-under-umbrella line read as one signal.
  [THOUGHTS.glowing, SOUVENIR_INSIGHT],
  [THOUGHTS.dryUnderUmbrella, SOUVENIR_INSIGHT],
  ...SOUVENIR_KINDS.map((kind): [string, string] => [SOUVENIR_THOUGHT[kind], SOUVENIR_INSIGHT]),
  [PRICEY_SOUVENIR_THOUGHT, 'guests found their souvenirs pricey.'],
]);

/**
 * Phase 30: status thoughts that describe what a guest is doing rather than how the park is doing, never summarised
 * ("2 Time for a little sit down." would be noise). The pre-Phase-29 statuses are matched by prefix in
 * `isStatusThought`; these are the Phase 29 ones (their texts are exact).
 */
const STATUS_THOUGHTS: ReadonlySet<string> = new Set([
  'Taking a look around.',
  'What should I see first?',
  SEEKING_BENCH_THOUGHT,
  THOUGHTS.sitDown,
  THOUGHTS.recovered,
]);

const isStatusThought = (thought: string): boolean => (
  thought.startsWith('Heading for ') || thought.startsWith('Riding ')
  || thought.startsWith('Queueing ') || thought.startsWith('Picking up ')
  || thought.startsWith('Getting a refreshing ') || thought.startsWith('Using the comfort ')
  || thought.startsWith('Picking out ')
  || STATUS_THOUGHTS.has(thought)
);

/** The intensity bands of the build cards (src/ui/buildFilterModel.ts rideBandOf: gentle below 25, family below 60). */
const LIKES_GENTLE_BELOW = 25;
const LIKES_FAMILY_BELOW = 60;
const likesBand = (preferredIntensity: number): GuestSnapshot['likes'] => (
  preferredIntensity < LIKES_GENTLE_BELOW ? 'gentle' : preferredIntensity < LIKES_FAMILY_BELOW ? 'family' : 'thrill'
);

const SOUVENIR_NAMES: Readonly<Record<SouvenirKind, string>> = {
  umbrella: 'Umbrella', hat: 'Sun hat', balloon: 'Balloon', plush: 'Plush toy', glowWand: 'Glow wand',
};

const PAUSE_LABELS: Readonly<Record<GuestActivity, string>> = {
  seatLeft: 'Resting on a bench',
  seatRight: 'Resting on a bench',
  admire: 'Admiring the scenery',
  watchRide: 'Watching a ride',
  photo: 'Taking a photo',
  cheer: 'Cheering after a ride',
  queasy: 'Feeling queasy',
  vomit: 'Being sick',
  fanSelf: 'Fanning themself',
  shiver: 'Shivering',
  sulk: 'Sulking about a queue',
  eat: 'Eating',
  drink: 'Having a drink',
  balloonLost: 'Watching a balloon float away',
  showOff: 'Showing off a souvenir',
};

export class GuestSimulation implements Serializable<GuestSimulationState> {
  readonly guests = new Map<number, Guest>();
  readonly navigation = new PathNetwork();
  private readonly random: SeededRandom;
  private nextGuestId = 1;
  private totalArrivalsCount = 0;
  private arrivalIntervalMultiplierValue = 1;
  private guestBudgetMultiplier = 1;
  private servicePriceToleranceMultiplier = 1;
  private needDecayMultiplier = 1;
  /** Biome layer (Phase 24): scales how fast hunger and thirst grow. 1 = neutral (Meadow). Config, not saved. */
  private hungerRateMultiplier = 1;
  private thirstRateMultiplier = 1;
  /** Phase 25: scales the organic guest potential (the crowd the park holds). 1 = neutral. Config, not saved. */
  private crowdCapacityMultiplier = 1;
  private spawnTimerSeconds = 1;
  private parkRating = 50;
  private destinationWorldVersion = -1;
  private rideDestinations: RideDestination[] = [];
  private serviceDestinations: ServiceDestination[] = [];
  /** Phase 29: benches and admirable scenery, rebuilt with the destinations. */
  private benchDestinations: BenchDestination[] = [];
  private landmarks: SceneryLandmark[] = [];
  /** Phase 29: taken seats per bench id (bit 1 left, bit 2 right), rebuilt at the start of every step. Derived. */
  private readonly benchSeats = new Map<number, number>();
  /** Phase 29: cells where a guest was sick this step, drained by the session into litter. Never outlives a step. */
  private sickCells: Cell[] = [];
  private readonly scenery: SceneryInfluenceReader;
  /** The shared per-tick park conditions (arrival rate, heat, rain biases); neutral until a session wires them. */
  private conditions: ParkConditions = neutralConditions();
  /**
   * Phase 14: the crowd flow field (entries, the walking-speed factor, the severe test). Neutral until a session wires
   * its `CrowdSimulation` (`setCrowd`), so a standalone GuestSimulation is bit-identical to before.
   */
  private crowd: GuestCrowdReader = NEUTRAL_CROWD_READER;

  constructor(
    private readonly world: GameWorld,
    private readonly rides: RideSimulation,
    private readonly shops: ShopSimulation,
    seedOrScenery: number | SceneryInfluenceReader = 0x5eed1234,
    scenery: SceneryInfluenceReader = ZERO_SCENERY_INFLUENCE,
  ) {
    const seed = typeof seedOrScenery === 'number' ? seedOrScenery : 0x5eed1234;
    this.scenery = typeof seedOrScenery === 'number' ? scenery : seedOrScenery;
    this.random = new SeededRandom(seed);
  }

  step(stepMs: number): void {
    const deltaSeconds = stepMs / 1000;
    this.navigation.sync(this.world.paths, this.world.pathVersion);
    this.refreshDestinations();
    this.updateArrivals(deltaSeconds);
    this.rebuildBenchSeats();

    for (const guest of [...this.guests.values()]) {
      guest.ageSeconds += deltaSeconds;
      guest.stateTimerSeconds += deltaSeconds;
      guest.needTimerSeconds += deltaSeconds;
      if (guest.needTimerSeconds >= GAME_CONFIG.guests.needUpdateSeconds) {
        this.updateNeeds(guest, guest.needTimerSeconds);
        guest.needTimerSeconds = 0;
      }

      const completingActivity = guest.state === 'riding' || guest.state === 'shopping' || guest.state === 'usingFacility';
      if (!this.world.gateOpen && guest.state !== 'leaving' && !completingActivity) this.sendHome(guest, 'The park is closing.');
      if (guest.state !== 'leaving' && !completingActivity && this.shouldLeave(guest)) this.sendHome(guest, this.leavingThought(guest));

      const showingPostActivityThought = guest.state === 'wandering'
        && guest.routeIndex >= guest.route.length
        && guest.stateTimerSeconds < GAME_CONFIG.guests.postActivityDecisionSeconds;
      if (showingPostActivityThought) continue;
      if (guest.state === 'entering' && guest.stateTimerSeconds >= 0.7) this.chooseDestination(guest);
      else if (guest.state === 'walkingToRide' || guest.state === 'walkingToShop'
        || guest.state === 'wandering' || guest.state === 'leaving' || guest.state === 'walkingToBench') this.walk(guest, deltaSeconds);
      else if (guest.state === 'pausing') this.updatePause(guest);
      else if (guest.state === 'resting') this.updateResting(guest, deltaSeconds);
      else if (guest.state === 'queueing') this.updateQueueing(guest);
      else if (guest.state === 'queueingForShop') this.updateShopQueueing(guest);
    }
  }

  spawnGuests(count: number): number {
    let spawned = 0;
    for (let index = 0; index < count && this.guests.size < GAME_CONFIG.guests.maximum; index += 1) {
      const id = this.nextGuestId++;
      const entrance = { ...this.world.entrance };
      this.guests.set(id, {
        id,
        position: { ...entrance },
        currentCell: { ...entrance },
        route: [entrance],
        routeIndex: 1,
        routeVersion: this.world.pathVersion,
        state: 'entering',
        destinationObjectId: null,
        money: Math.round((35 + this.random.next() * 65) * this.guestBudgetMultiplier),
        happiness: Math.round(70 + this.random.next() * 18),
        hunger: Math.round(6 + this.random.next() * 24),
        thirst: Math.round(8 + this.random.next() * 27),
        toiletNeed: Math.round(5 + this.random.next() * 30),
        energy: Math.round(72 + this.random.next() * 25),
        preferredIntensity: this.rollPreferredIntensity(),
        currentThought: 'What should I see first?',
        thoughtObjectId: null,
        patienceSeconds: Math.round(28 + this.random.next() * 62),
        lastQueueWaitSeconds: 0,
        lastRideSatisfaction: null,
        lastPurchaseSatisfaction: null,
        servicePriceLimit: null,
        recentRideIds: [],
        recentServiceIds: [],
        ageSeconds: 0,
        maximumVisitSeconds: GAME_CONFIG.guests.minimumVisitSeconds + this.random.next() * GAME_CONFIG.guests.variableVisitSeconds,
        stateTimerSeconds: 0,
        needTimerSeconds: this.random.next(),
        color: GUEST_COLORS[id % GUEST_COLORS.length],
        accent: GUEST_ACCENTS[id % GUEST_ACCENTS.length],
        nausea: 0,
        warmth: GAME_CONFIG.guestLife.warmth.neutral,
        souvenirs: 0,
        activity: null,
      });
      spawned += 1;
    }
    this.totalArrivalsCount += spawned;
    return spawned;
  }

  /**
   * Guests arrive in three taste clusters rather than a flat spread, so gentle,
   * family, and thrill rides each have a real audience: ~35% gentle (12–36),
   * ~40% family (35–65), ~25% thrill seekers (62–95).
   */
  private rollPreferredIntensity(): number {
    const roll = this.random.next();
    if (roll < 0.35) return Math.round(12 + this.random.next() * 24);
    if (roll < 0.75) return Math.round(35 + this.random.next() * 30);
    return Math.round(62 + this.random.next() * 33);
  }

  /**
   * PURE: never syncs navigation, refreshes destinations or draws from the RNG, so saving mid-run
   * cannot change the run. Guests come out in Map order (= spawn order = RNG draw order in step()).
   * Every field is an explicit literal: a field added to GuestRecordState without a line here fails
   * to compile, and the field-coverage test catches one added to Guest.
   */
  serialize(): GuestSimulationState {
    const guests: GuestRecordState[] = [];
    for (const guest of this.guests.values()) {
      const path = `guests[${guest.id}]`;
      guests.push({
        id: guest.id,
        position: copyCell(guest.position, `${path}.position`),
        currentCell: copyCell(guest.currentCell, `${path}.currentCell`),
        route: guest.route.map((cell, index) => copyCell(cell, `${path}.route[${index}]`)),
        routeIndex: guest.routeIndex,
        routeVersion: plainNumber(guest.routeVersion, `${path}.routeVersion`),
        state: guest.state,
        destinationObjectId: guest.destinationObjectId,
        money: plainNumber(guest.money, `${path}.money`),
        happiness: plainNumber(guest.happiness, `${path}.happiness`),
        hunger: plainNumber(guest.hunger, `${path}.hunger`),
        thirst: plainNumber(guest.thirst, `${path}.thirst`),
        toiletNeed: plainNumber(guest.toiletNeed, `${path}.toiletNeed`),
        energy: plainNumber(guest.energy, `${path}.energy`),
        preferredIntensity: plainNumber(guest.preferredIntensity, `${path}.preferredIntensity`),
        currentThought: guest.currentThought,
        // Phase 30: only a complaint carries the key, so a park with no complaint is saved exactly as before.
        ...(guest.thoughtObjectId === null ? {} : { thoughtObjectId: guest.thoughtObjectId }),
        patienceSeconds: plainNumber(guest.patienceSeconds, `${path}.patienceSeconds`),
        lastQueueWaitSeconds: plainNumber(guest.lastQueueWaitSeconds, `${path}.lastQueueWaitSeconds`),
        lastRideSatisfaction: nullablePlain(guest.lastRideSatisfaction, `${path}.lastRideSatisfaction`),
        lastPurchaseSatisfaction: nullablePlain(guest.lastPurchaseSatisfaction, `${path}.lastPurchaseSatisfaction`),
        servicePriceLimit: nullablePlain(guest.servicePriceLimit, `${path}.servicePriceLimit`),
        recentRideIds: [...guest.recentRideIds],
        recentServiceIds: [...guest.recentServiceIds],
        ageSeconds: plainNumber(guest.ageSeconds, `${path}.ageSeconds`),
        maximumVisitSeconds: plainNumber(guest.maximumVisitSeconds, `${path}.maximumVisitSeconds`),
        stateTimerSeconds: plainNumber(guest.stateTimerSeconds, `${path}.stateTimerSeconds`),
        needTimerSeconds: plainNumber(guest.needTimerSeconds, `${path}.needTimerSeconds`),
        color: guest.color,
        accent: guest.accent,
        nausea: plainNumber(guest.nausea, `${path}.nausea`),
        warmth: plainNumber(guest.warmth, `${path}.warmth`),
        souvenirs: guest.souvenirs,
        activity: guest.activity,
      });
    }
    return {
      randomState: this.random.getState(),
      nextGuestId: this.nextGuestId,
      totalArrivals: this.totalArrivalsCount,
      // May be negative at the guest cap: never clamped, it decides which tick spawns.
      spawnTimerSeconds: plainNumber(this.spawnTimerSeconds, 'spawnTimerSeconds'),
      parkRating: plainNumber(this.parkRating, 'parkRating'),
      guests,
    };
  }

  /**
   * Validates everything first (mutating nothing), then applies. The guest Map keeps its identity
   * because rides, shops, operations and management share it by reference. Ruleset multipliers,
   * world, rides, shops and scenery are config and are left alone. Dangling object ids are legal and
   * queue/guest consistency is the session-level check's job.
   */
  restore(state: GuestSimulationState): void {
    if (!isRecord(state)) throw invalidState(OWNER, '$', 'must be an object');
    const randomState = state.randomState;
    if (typeof randomState !== 'number' || !Number.isInteger(randomState) || randomState < 0 || randomState >= 0x1_0000_0000) {
      throw invalidState(OWNER, 'randomState', 'must be an integer in 0..2^32-1');
    }
    if (!Array.isArray(state.guests)) throw invalidState(OWNER, 'guests', 'must be an array');
    const restored: Guest[] = [];
    let previousId = 0;
    state.guests.forEach((record: unknown, index) => {
      const guest = readGuestRecord(record, `guests[${index}]`, this.world);
      if (guest.id <= previousId) {
        throw invalidState(OWNER, `guests[${index}].id`, `must be strictly ascending (${guest.id} after ${previousId})`);
      }
      previousId = guest.id;
      restored.push(guest);
    });
    const nextGuestId = requireInteger(state.nextGuestId, 'nextGuestId', 1);
    if (nextGuestId <= previousId) throw invalidState(OWNER, 'nextGuestId', `must exceed the highest guest id (${previousId})`);
    const totalArrivals = requireInteger(state.totalArrivals, 'totalArrivals', 0);
    // Negative is legal (the countdown runs below zero at the guest cap), but bounded: it is only
    // ever incremented back by a step, so -1e300 would block spawning for good.
    const spawnTimerSeconds = requireNumberInRange(OWNER, state.spawnTimerSeconds, 'spawnTimerSeconds', -MAXIMUM_SAVED_SECONDS, MAXIMUM_SAVED_SECONDS);
    const parkRating = requireFinite(state.parkRating, 'parkRating');
    if (parkRating < 0 || parkRating > 100) throw invalidState(OWNER, 'parkRating', 'must be within 0..100');

    this.guests.clear();
    for (const guest of restored) this.guests.set(guest.id, guest);
    this.random.setState(randomState);
    this.nextGuestId = nextGuestId;
    this.totalArrivalsCount = totalArrivals;
    this.spawnTimerSeconds = spawnTimerSeconds;
    this.parkRating = parkRating;
    this.destinationWorldVersion = -1;
    this.rideDestinations = [];
    this.serviceDestinations = [];
    this.benchDestinations = [];
    this.landmarks = [];
    this.sickCells = [];
    this.navigation.invalidate();
  }

  /** Every guest who has ever entered this park, including developer spawns. */
  get totalArrivals(): number {
    return this.totalArrivalsCount;
  }

  get arrivalIntervalMultiplier(): number {
    return this.arrivalIntervalMultiplierValue;
  }

  /** Session-rule hook: applies the compiled park ruleset's guest-facing multipliers. */
  applyRules(rules: {
    arrivalIntervalMultiplier: number;
    guestBudgetMultiplier: number;
    servicePriceToleranceMultiplier: number;
    needDecayMultiplier: number;
    hungerRateMultiplier?: number;
    thirstRateMultiplier?: number;
    crowdCapacityMultiplier?: number;
  }): void {
    this.arrivalIntervalMultiplierValue = safeMultiplier(rules.arrivalIntervalMultiplier);
    this.guestBudgetMultiplier = safeMultiplier(rules.guestBudgetMultiplier);
    this.servicePriceToleranceMultiplier = safeMultiplier(rules.servicePriceToleranceMultiplier);
    this.needDecayMultiplier = safeMultiplier(rules.needDecayMultiplier);
    this.hungerRateMultiplier = safeMultiplier(rules.hungerRateMultiplier ?? 1);
    this.thirstRateMultiplier = safeMultiplier(rules.thirstRateMultiplier ?? 1);
    this.crowdCapacityMultiplier = safeMultiplier(rules.crowdCapacityMultiplier ?? 1);
  }

  /**
   * One-shot card primitive (Phase 25, the cheer card): adds `delta` to the happiness of every guest who is not leaving
   * (id order), clamped to 0..100. Draws nothing. Returns how many guests it touched.
   */
  adjustHappiness(delta: number): number {
    if (!Number.isFinite(delta)) return 0;
    let touched = 0;
    for (const guest of this.guests.values()) {
      if (guest.state === 'leaving') continue;
      guest.happiness = clamp(guest.happiness + delta, 0, 100);
      touched += 1;
    }
    return touched;
  }

  /** Shares the session's conditions object, which the weather owner overwrites in place every tick. */
  setConditions(conditions: ParkConditions): void {
    this.conditions = conditions;
  }

  /** Phase 14: the session's crowd field (config, not saved here: the session saves the field itself). */
  setCrowd(reader: GuestCrowdReader): void {
    this.crowd = reader;
  }

  setParkRating(score: number): void {
    if (!Number.isFinite(score)) return;
    this.parkRating = clamp(score, 0, 100);
  }

  organicGuestPotential(): number {
    return this.capacityView().ceiling;
  }

  /**
   * The guest ceiling `updateArrivals` enforces, with its parts and why it is 0 when it is (Phase 11, PA-009). Like
   * `organicGuestPotential`, it first syncs the navigation graph and the destination list, both derived caches the
   * determinism harness ignores (rebuilding them early gives what `step()` would), so a ride built while paused
   * counts at once. Never changes saved state.
   */
  capacityView(): GuestCapacityView {
    this.navigation.sync(this.world.paths, this.world.pathVersion);
    this.refreshDestinations();
    return this.capacityParts();
  }

  removeAll(): void { this.guests.clear(); }

  /**
   * What at least two guests think right now, summarised for Park Pulse, most common first. Phase 30: a complaint line
   * links to the building its guests complain about, when it still stands (one line per building; see `byBuilding`).
   */
  thoughtInsights(limit = 5, byBuilding = true): ThoughtInsight[] {
    // Phase 30 (review fix): with `byBuilding`, complaints that link a standing building group per building as well as
    // per summary, so a price complaint at a ride and one at a stall are two lines, each linking its own building.
    // Without it (the determinism harness's observable, kept as it was), one group per summary links its most named
    // building (ties: lower id).
    const groups = new Map<string, { text: string; count: number; objects: Map<number, number> }>();
    for (const guest of this.guests.values()) {
      const thought = guest.currentThought;
      if (isStatusThought(thought)) continue;
      const summary = INSIGHT_TEXT.get(thought) ?? thought;
      const objectId = this.complaintObjectId(guest);
      const key = byBuilding && objectId !== null ? `${summary}\u0000${objectId}` : summary;
      let group = groups.get(key);
      if (!group) {
        group = { text: summary, count: 0, objects: new Map() };
        groups.set(key, group);
      }
      group.count += 1;
      if (objectId !== null) group.objects.set(objectId, (group.objects.get(objectId) ?? 0) + 1);
    }
    return [...groups.values()]
      .map((group): ThoughtInsight => {
        let objectId: number | null = null;
        let most = 0;
        for (const [id, count] of group.objects) {
          if (count > most || (count === most && objectId !== null && id < objectId)) {
            objectId = id;
            most = count;
          }
        }
        return { text: group.text, count: group.count, objectId, objectName: this.objectName(objectId) };
      })
      .filter((insight) => insight.count >= 2)
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text) || (a.objectId ?? -1) - (b.objectId ?? -1))
      .slice(0, limit);
  }

  /**
   * Phase 30: the guest nearest to `cell` (by distance from their position, which the renderer draws on that cell's
   * ground point) within `radius` cells, or null. Guests whose figure is not drawn (riding, shopping, in a facility)
   * are skipped; ties go to the lower id. A pure read: no RNG, no state change.
   */
  guestNear(cell: Cell, radius = 0.75): number | null {
    let best: number | null = null;
    let nearest = radius;
    for (const guest of this.guests.values()) {
      if (!isExposed(guest.state)) continue;
      const distance = Math.hypot(guest.position.x - cell.x, guest.position.y - cell.y);
      if (distance < nearest || (distance === nearest && best !== null && guest.id < best)) {
        best = guest.id;
        nearest = distance;
      }
    }
    return best;
  }

  /**
   * Phase 30 (review fix): a guest resting on the bench `objectId` (lowest id when both seats are taken), or null. The
   * figure is drawn on the bench while the guest's position stays on the access cell beside it, so a click on the
   * bench itself must find the sitter here rather than by distance. A pure read.
   */
  restingGuestOn(objectId: number): number | null {
    let best: number | null = null;
    for (const guest of this.guests.values()) {
      if (guest.state === 'resting' && guest.destinationObjectId === objectId && (best === null || guest.id < best)) best = guest.id;
    }
    return best;
  }

  /** Phase 30: the guest inspector's view of one guest, or null when the guest has left. Pure. */
  guestSnapshot(id: number): GuestSnapshot | null {
    const guest = this.guests.get(id);
    if (!guest) return null;
    const life = GAME_CONFIG.guestLife;
    const thoughtObjectId = this.complaintObjectId(guest);
    return {
      id: guest.id,
      state: guest.state,
      doing: this.doingLabel(guest),
      thought: guest.currentThought,
      thoughtObjectId,
      thoughtObjectName: this.objectName(thoughtObjectId),
      destinationObjectId: guest.destinationObjectId,
      destinationName: this.objectName(guest.destinationObjectId),
      happiness: guest.happiness,
      money: guest.money,
      hunger: guest.hunger,
      thirst: guest.thirst,
      toiletNeed: guest.toiletNeed,
      energy: guest.energy,
      nausea: guest.nausea,
      warmth: guest.warmth,
      likes: likesBand(guest.preferredIntensity),
      souvenirs: SOUVENIR_KINDS.filter((kind) => holdsSouvenir(guest, kind)).map((kind) => SOUVENIR_NAMES[kind]),
      tired: guest.energy < life.bench.seekEnergy,
      queasy: guest.nausea >= life.nausea.queasy,
      hot: guest.warmth >= life.warmth.hot,
      cold: guest.warmth <= life.warmth.cold,
      soaked: isSoaked(guest, this.conditions),
      position: { x: guest.position.x, y: guest.position.y },
      ageSeconds: guest.ageSeconds,
    };
  }

  /** The building a complaint is about, when the thought is a complaint and the building still stands; else null. */
  private complaintObjectId(guest: Guest): number | null {
    const id = guest.thoughtObjectId;
    if (id === null || !COMPLAINT_THOUGHTS.has(guest.currentThought) || !this.world.objects.has(id)) return null;
    return id;
  }

  private objectName(objectId: number | null): string | null {
    if (objectId === null) return null;
    const object = this.world.objects.get(objectId);
    return object ? BUILD_BY_ID.get(object.definitionId)?.name ?? null : null;
  }

  private doingLabel(guest: Guest): string {
    const destination = this.objectName(guest.destinationObjectId);
    switch (guest.state) {
      case 'entering': return 'Just arrived';
      case 'wandering': return guest.activity !== null ? PAUSE_LABELS[guest.activity] : 'Wandering';
      case 'walkingToRide': return `Heading for ${destination ?? 'a ride'}`;
      case 'walkingToShop': return `Heading for ${destination ?? 'a stall'}`;
      case 'walkingToBench': return 'Heading for a bench';
      case 'queueing': return `Queueing for ${destination ?? 'a ride'}`;
      case 'riding': return `Riding ${destination ?? 'a ride'}`;
      case 'queueingForShop': return `Queueing at ${destination ?? 'a stall'}`;
      case 'shopping': return `Buying at ${destination ?? 'a stall'}`;
      case 'usingFacility': return `Using ${destination ?? 'a facility'}`;
      case 'leaving': return 'Heading home';
      case 'resting': return 'Resting on a bench';
      case 'pausing': return guest.activity !== null ? PAUSE_LABELS[guest.activity] : 'Pausing';
    }
  }

  private updateArrivals(deltaSeconds: number): void {
    const openRideCount = this.openRideDestinations().length;
    if (!this.world.gateOpen || openRideCount === 0 || this.world.paths.size < 3) return;
    // The countdown drains at the arrival rate (arrival curve times weather), so a busy afternoon
    // shortens the wait and a storm stretches it at once; neutral conditions drain at exactly 1.
    this.spawnTimerSeconds -= deltaSeconds * this.conditions.arrivalRate;
    if (this.spawnTimerSeconds > 0 || this.guests.size >= this.calculateOrganicGuestPotential()) return;
    this.spawnGuests(1);
    const attractionInterval = Math.max(
      GAME_CONFIG.guests.minimumSpawnIntervalSeconds,
      GAME_CONFIG.guests.baseSpawnIntervalSeconds - openRideCount * GAME_CONFIG.guests.spawnRideBonusSeconds,
    );
    const reputationMultiplier = 1.25 - this.parkRating / 100 * 0.6;
    const interval = Math.max(
      GAME_CONFIG.guests.minimumSpawnIntervalSeconds,
      attractionInterval * reputationMultiplier * this.arrivalIntervalMultiplierValue,
    );
    this.spawnTimerSeconds = interval * (0.78 + this.random.next() * 0.44);
  }

  private openRideDestinations(): RideDestination[] {
    return this.rideDestinations.filter((destination) =>
      this.rides.isAvailable(destination.object.id),
    );
  }

  private calculateOrganicGuestPotential(): number {
    return this.capacityParts().ceiling;
  }

  /**
   * The guest ceiling and the parts it is made of (Phase 11, PA-009): the one place the arithmetic lives, shared by
   * `updateArrivals` (through `calculateOrganicGuestPotential`) and `capacityView`. The operation order is the
   * pre-Phase-11 one, bit for bit. A pure read of the derived caches: it draws no random numbers and writes nothing.
   */
  private capacityParts(): GuestCapacityView {
    const hardMaximum = GAME_CONFIG.guests.maximum;
    const rating = this.parkRating;
    const crowdMultiplier = this.crowdCapacityMultiplier;
    const openRides = this.openRideDestinations();
    const blocked: GuestCapacityBlock = !this.world.parkOpen ? 'park-closed'
      : !this.world.gateOpen ? 'after-hours'
        : this.world.paths.size < 3 ? 'too-few-paths'
          : openRides.length === 0 ? 'no-open-ride'
            : null;
    const attractionCapacity = openRides.reduce((total, destination) =>
      total + (this.world.rideProfile(destination.object.id)?.capacity ?? 1), 0);
    if (blocked !== null) return { ceiling: 0, rideSeats: attractionCapacity, rating, crowdMultiplier, hardMaximum, blocked };
    const reputationDemand = 0.45 + rating / 100;
    const ceiling = Math.min(
      hardMaximum,
      Math.floor((8 + attractionCapacity * 2.2) * reputationDemand * crowdMultiplier),
    );
    return { ceiling, rideSeats: attractionCapacity, rating, crowdMultiplier, hardMaximum, blocked: null };
  }

  private refreshDestinations(): void {
    if (this.destinationWorldVersion === this.world.version) return;
    this.destinationWorldVersion = this.world.version;
    this.rideDestinations = [];
    this.serviceDestinations = [];
    this.benchDestinations = [];
    this.landmarks = [];
    for (const object of this.world.objects.values()) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (definition?.kind === 'scenery' && definition.stats?.sceneryAppeal !== undefined) {
        const cells = this.world.objectFootprint(object);
        this.landmarks.push({
          object,
          appeal: definition.stats.sceneryAppeal,
          radius: definition.stats.sceneryRadius ?? 3,
          centreX: cells.reduce((sum, cell) => sum + cell.x, 0) / Math.max(1, cells.length),
          centreY: cells.reduce((sum, cell) => sum + cell.y, 0) / Math.max(1, cells.length),
        });
        continue;
      }
      const bench = GAME_CONFIG.guestLife.enabled && definition?.kind === 'amenity' && definition.stats?.amenityType === undefined;
      if (!definition || (definition.kind !== 'ride' && !definition.stats?.serviceType && !bench)) continue;
      const footprintCells = this.world.objectFootprint(object);
      const footprint = new Set(footprintCells.map(keyOf));
      const access = new Map<string, Cell>();
      for (const occupied of footprintCells) {
        for (const direction of CARDINALS) {
          const cell = { x: occupied.x + direction.x, y: occupied.y + direction.y };
          if (!footprint.has(keyOf(cell)) && this.world.paths.has(keyOf(cell))) access.set(keyOf(cell), cell);
        }
      }
      const reachableAccess = [...access.values()].filter((cell) =>
        this.navigation.findRoute(this.world.entrance, cell) !== null,
      );
      if (reachableAccess.length === 0) continue;
      if (definition.kind === 'ride') this.rideDestinations.push({ object, accessCells: reachableAccess, covered: definition.openAir === false });
      else if (bench) this.benchDestinations.push({ object, accessCells: reachableAccess });
      else if (definition.stats?.serviceType) {
        this.serviceDestinations.push({
          object,
          accessCells: reachableAccess,
          kind: definition.stats.serviceType,
          temperature: definition.serves ?? null,
          souvenir: definition.stats.souvenir ?? null,
        });
      }
    }
  }

  /**
   * The guest decides what to do next. `allowLife` (Phase 29) lets them first stop for a moment of their own — fanning
   * themself, shivering, sitting on a bench, admiring the scenery — which is never offered right after such a moment.
   */
  private chooseDestination(guest: Guest, allowLife = true): void {
    guest.activity = null;
    if (!this.navigation.contains(guest.currentCell)) {
      this.sendHome(guest, "I can't find the path.");
      return;
    }
    if (allowLife && this.tryLifeActivity(guest)) return;
    let best: DestinationChoice | null = null;
    let rejectedForPrice = false;
    for (const destination of this.rideDestinations) {
      const profile = this.world.rideProfile(destination.object.id);
      if (!profile) continue;
      const ride = this.rides.getRide(destination.object.id);
      if (!ride || !this.rides.isAvailable(destination.object.id)) continue;
      const distance = this.nearestAccessDistance(guest.currentCell, destination.accessCells);
      if (distance === null) continue;
      const intensity = profile.intensity;
      const excitement = profile.excitement;
      const preferenceMatch = 1 - Math.abs(intensity - guest.preferredIntensity) / 100;
      const repeatPenalty = guest.recentRideIds.includes(destination.object.id) ? 28 : 0;
      const queuePenalty = this.rides.estimatedWaitSeconds(destination.object.id) * 0.55;
      const pricePenalty = ride.ticketPrice * 1.6;
      const willingnessToPay = 2 + excitement * 0.12 + preferenceMatch * 4 + this.random.next() * 2;
      if (guest.money < ride.ticketPrice || ride.ticketPrice > willingnessToPay) {
        rejectedForPrice = true;
        continue;
      }
      // Phase 29: a queasy guest steers clear of intense rides.
      const nauseaPenalty = guest.nausea * GAME_CONFIG.guestLife.nausea.rideAversion * intensity / 100;
      const utility = excitement * 0.55 + preferenceMatch * 34 - (distance + 1) * 0.9
        - queuePenalty - pricePenalty - repeatPenalty - nauseaPenalty + this.random.next() * 12
        + this.scenery.scoreForObject(destination.object.id) * GAME_CONFIG.scenery.rideChoiceWeight
        + (destination.covered ? this.conditions.coveredRideBonus : this.conditions.openAirRideBonus);
      if (!best || utility > best.utility) {
        best = { kind: 'ride', destination, utility, servicePriceLimit: null };
      }
    }

    const demandedServices = (['food', 'drink', 'toilet'] as const)
      .filter((kind) => this.needForService(guest, kind) >= this.demandThreshold(guest, kind));
    const rejectedServiceKinds = new Set<ServiceKind>();
    const viableServiceKinds = new Set<ServiceKind>();
    for (const destination of this.serviceDestinations) {
      const service = this.shops.getService(destination.object.id);
      if (!service?.open) continue;
      if (destination.kind === 'souvenir') {
        // Phase 29: a keepsake is a want, never a need, so a refusal is no price complaint and no unmet need.
        const souvenir = this.souvenirChoice(guest, destination, service.itemPrice);
        if (souvenir && (!best || souvenir.utility > best.utility)) best = souvenir;
        continue;
      }
      const need = this.needForService(guest, destination.kind);
      if (need < this.demandThreshold(guest, destination.kind)) continue;
      const distance = this.nearestAccessDistance(guest.currentCell, destination.accessCells);
      if (distance === null) continue;
      const personalityValue = (guest.preferredIntensity - 50) * 0.012;
      const willingnessToPay = (destination.kind === 'food'
        ? 5 + need * 0.06 + personalityValue
        : destination.kind === 'drink'
          ? 3 + need * 0.05 + personalityValue
          : 0.5 + need * 0.025 + personalityValue * 0.25) * this.servicePriceToleranceMultiplier;
      if (guest.money < service.itemPrice || service.itemPrice > willingnessToPay) {
        rejectedServiceKinds.add(destination.kind);
        rejectedForPrice = true;
        continue;
      }
      viableServiceKinds.add(destination.kind);
      const repeatPenalty = guest.recentServiceIds.includes(destination.object.id) ? 18 : 0;
      const urgentBonus = need >= 80 ? 25 : 0;
      const utility = need * 1.2 + urgentBonus - (distance + 1) * 0.75
        - this.shops.estimatedWaitSeconds(destination.object.id) * 0.65
        - service.itemPrice * 1.4 - repeatPenalty + this.random.next() * 8
        + this.scenery.scoreForObject(destination.object.id) * GAME_CONFIG.scenery.serviceChoiceWeight
        + (destination.temperature === 'warm' ? this.conditions.warmFoodBonus
          : destination.temperature === 'cold' ? this.conditions.coldTreatBonus : 0)
        + this.comfortBonus(guest, destination.temperature);
      if (!best || utility > best.utility) {
        best = { kind: 'service', destination, utility, servicePriceLimit: willingnessToPay };
      }
    }
    const urgentUnmetKind = [...demandedServices]
      .sort((left, right) => this.needForService(guest, right) - this.needForService(guest, left))
      .find((kind) => this.needForService(guest, kind) >= 72 && !viableServiceKinds.has(kind));
    if (urgentUnmetKind) {
      this.wander(
        guest,
        rejectedServiceKinds.has(urgentUnmetKind)
          ? "I'm not paying that much."
          : this.missingServiceThought(urgentUnmetKind),
      );
      return;
    }
    if (best) {
      // The full route array is only materialized for the destination the guest commits to.
      const route = this.navigation.findNearestRoute(guest.currentCell, best.destination.accessCells);
      if (route) {
        guest.destinationObjectId = best.destination.object.id;
        guest.servicePriceLimit = best.servicePriceLimit;
        guest.state = best.kind === 'ride' ? 'walkingToRide' : 'walkingToShop';
        const fallbackName = best.kind === 'ride' ? 'a ride' : 'a service';
        setThought(guest, `Heading for ${BUILD_BY_ID.get(best.destination.object.definitionId)?.name ?? fallbackName}.`);
        this.assignRoute(guest, route);
        return;
      }
    }
    const missingKind = demandedServices
      .filter((kind) => !rejectedServiceKinds.has(kind))
      .sort((left, right) => this.needForService(guest, right) - this.needForService(guest, left))[0];
    const thought = rejectedForPrice
      ? "I'm not paying that much."
      : missingKind
        ? this.missingServiceThought(missingKind)
        : 'Taking a look around.';
    this.wander(guest, thought);
  }

  /** Phase 29: the utility of a souvenir stall to this guest, or null when they do not want or cannot afford it. */
  private souvenirChoice(guest: Guest, destination: ServiceDestination, price: number): DestinationChoice | null {
    if (destination.souvenir === null) return null;
    const config = GAME_CONFIG.guestLife.souvenir;
    const desire = souvenirDesire(guest, destination.souvenir, this.conditions);
    if (desire <= 0) return null;
    const limit = souvenirPriceLimit(destination.souvenir, desire) * this.servicePriceToleranceMultiplier;
    if (guest.money < price + config.reserve || price > limit) return null;
    const distance = this.nearestAccessDistance(guest.currentCell, destination.accessCells);
    if (distance === null) return null;
    const repeatPenalty = guest.recentServiceIds.includes(destination.object.id) ? 18 : 0;
    const utility = desire - (distance + 1) * 0.75
      - this.shops.estimatedWaitSeconds(destination.object.id) * 0.65
      - price * 1.4 - repeatPenalty + this.random.next() * 8
      + this.scenery.scoreForObject(destination.object.id) * GAME_CONFIG.scenery.serviceChoiceWeight;
    return { kind: 'service', destination, utility, servicePriceLimit: limit };
  }

  /** Phase 29: a cold treat is worth more to a hot guest and a warm one to a cold guest. */
  private comfortBonus(guest: Guest, temperature: 'warm' | 'cold' | null): number {
    const warmth = GAME_CONFIG.guestLife.warmth;
    if (temperature === 'cold' && guest.warmth >= warmth.hot) return warmth.comfortServiceBonus;
    if (temperature === 'warm' && guest.warmth <= warmth.cold) return warmth.comfortServiceBonus;
    return 0;
  }

  /**
   * Phase 29: a moment of the guest's own at a decision point, tried in this order: a hot guest fans themself and a cold
   * one shivers, a tired one heads for a free bench seat, and one on a lovely spot stops to admire (or photograph) the
   * scenery or watch a running ride. True when the guest is now busy with it.
   */
  private tryLifeActivity(guest: Guest): boolean {
    const life = GAME_CONFIG.guestLife;
    if (!life.enabled) return false;
    // Phase 30: a pressing need comes first; the guest with a bursting bladder never sits down on the way.
    const ceiling = life.lifeNeedCeiling;
    if (guest.hunger >= ceiling.hunger || guest.thirst >= ceiling.thirst || guest.toiletNeed >= ceiling.toiletNeed) return false;
    if (guest.warmth >= life.warmth.hot && this.random.next() < life.warmth.pauseChance) {
      startPause(guest, 'fanSelf', THOUGHTS.hot);
      return true;
    }
    if (guest.warmth <= life.warmth.cold && this.random.next() < life.warmth.pauseChance) {
      startPause(guest, 'shiver', THOUGHTS.cold);
      return true;
    }
    return this.trySeekBench(guest) || this.tryAdmire(guest);
  }

  private trySeekBench(guest: Guest): boolean {
    const bench = GAME_CONFIG.guestLife.bench;
    if (guest.energy >= bench.seekEnergy || this.benchDestinations.length === 0) return false;
    if (guest.energy >= bench.seekChanceEnergy && this.random.next() >= bench.seekChance) return false;
    let best: { destination: BenchDestination; distance: number; taken: number } | null = null;
    for (const destination of this.benchDestinations) {
      const taken = this.benchSeats.get(destination.object.id) ?? 0;
      if (taken === 3) continue;
      const distance = this.nearestAccessDistance(guest.currentCell, destination.accessCells);
      if (distance === null || distance > bench.maximumDistance) continue;
      if (!best || distance < best.distance) best = { destination, distance, taken };
    }
    if (!best) return false;
    const route = this.navigation.findNearestRoute(guest.currentCell, best.destination.accessCells);
    if (!route) return false;
    const seat: GuestSeat = (best.taken & seatBit('seatLeft')) === 0 ? 'seatLeft' : 'seatRight';
    this.benchSeats.set(best.destination.object.id, best.taken | seatBit(seat));
    guest.state = 'walkingToBench';
    guest.destinationObjectId = best.destination.object.id;
    guest.servicePriceLimit = null;
    setThought(guest, SEEKING_BENCH_THOUGHT);
    this.assignRoute(guest, route);
    guest.activity = seat;
    return true;
  }

  private tryAdmire(guest: Guest): boolean {
    const admire = GAME_CONFIG.guestLife.admire;
    if (this.landmarks.length > 0 && this.scenery.scoreAt(guest.currentCell) >= admire.sceneryScore
      && this.random.next() < admire.chance) {
      let best: SceneryLandmark | null = null;
      let bestValue = 0;
      for (const landmark of this.landmarks) {
        const distance = Math.hypot(landmark.centreX - guest.currentCell.x, landmark.centreY - guest.currentCell.y);
        if (distance > landmark.radius) continue;
        const value = landmark.appeal / (1 + distance);
        if (value > bestValue) {
          best = landmark;
          bestValue = value;
        }
      }
      if (best) {
        const photo = best.appeal >= admire.photoAppeal;
        startPause(guest, photo ? 'photo' : 'admire', photo ? THOUGHTS.photo : THOUGHTS.admire, best.object.id);
        guest.happiness = Math.min(100, guest.happiness + admire.happiness);
        return true;
      }
    }
    if (this.rideDestinations.length === 0 || this.random.next() >= admire.watchRideChance) return false;
    let watched: RideDestination | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const destination of this.rideDestinations) {
      if (this.rides.getRide(destination.object.id)?.status !== 'running') continue;
      for (const cell of this.world.objectFootprint(destination.object)) {
        const distance = Math.max(Math.abs(cell.x - guest.currentCell.x), Math.abs(cell.y - guest.currentCell.y));
        if (distance <= admire.watchRideDistance && distance < nearest) {
          watched = destination;
          nearest = distance;
        }
      }
    }
    if (!watched) return false;
    startPause(guest, 'watchRide', THOUGHTS.watchRide, watched.object.id);
    return true;
  }

  /** Phase 29: who sits where, from the guests themselves (a seat is reserved from the moment a guest heads for it). */
  private rebuildBenchSeats(): void {
    this.benchSeats.clear();
    if (this.benchDestinations.length === 0) return;
    for (const guest of this.guests.values()) {
      if ((guest.state !== 'walkingToBench' && guest.state !== 'resting') || guest.destinationObjectId === null
        || guest.activity === null || !isSeat(guest.activity)) continue;
      const id = guest.destinationObjectId;
      this.benchSeats.set(id, (this.benchSeats.get(id) ?? 0) | seatBit(guest.activity));
    }
  }

  /** Phase 29: a pause runs its course, then the guest decides afresh (a queasy one may be sick first). */
  private updatePause(guest: Guest): void {
    const activity = guest.activity;
    if (activity === null || isSeat(activity)) {
      this.finishActivity(guest, null);
      return;
    }
    if (guest.stateTimerSeconds < pauseSeconds(activity as GuestPause)) return;
    if (activity === 'queasy') {
      if (guest.nausea >= GAME_CONFIG.guestLife.nausea.vomit) this.beSick(guest);
      else this.finishActivity(guest, THOUGHTS.recovered);
    } else if (activity === 'vomit') {
      this.finishActivity(guest, THOUGHTS.afterVomit);
    } else if (activity === 'sulk') {
      guest.activity = null;
      // Phase 30: the complaint keeps naming its queue (startPause kept the id; wander keeps it for the same text).
      this.wander(guest, 'This queue is taking forever.', guest.thoughtObjectId);
    } else {
      this.finishActivity(guest, null);
    }
  }

  /** Phase 29: sitting on a bench gives energy (and a little cheer) back until the guest feels rested. */
  private updateResting(guest: Guest, deltaSeconds: number): void {
    const bench = GAME_CONFIG.guestLife.bench;
    if (guest.destinationObjectId === null || !this.world.objects.has(guest.destinationObjectId)) {
      this.finishActivity(guest, null);
      return;
    }
    guest.energy = Math.min(100, guest.energy + bench.energyPerSecond * deltaSeconds);
    if (guest.happiness < bench.maximumHappiness) {
      guest.happiness = Math.min(bench.maximumHappiness, guest.happiness + bench.happinessPerSecond * deltaSeconds);
    }
    const seconds = guest.stateTimerSeconds;
    if (seconds >= bench.maximumSeconds || (seconds >= bench.minimumSeconds && guest.energy >= bench.restedEnergy)) {
      this.finishActivity(guest, THOUGHTS.rested);
    }
  }

  private beSick(guest: Guest): void {
    const nausea = GAME_CONFIG.guestLife.nausea;
    startPause(guest, 'vomit', THOUGHTS.vomit);
    guest.nausea = nausea.afterVomit;
    guest.happiness = Math.max(0, guest.happiness - nausea.vomitHappiness);
    this.sickCells.push({ ...guest.currentCell });
  }

  /**
   * Ends a pause or a rest. A guest whose tile was bulldozed meanwhile steps onto the nearest path the entrance still
   * reaches (as a walker would); then they decide what to do next, without another pause of their own.
   */
  private finishActivity(guest: Guest, thought: string | null): void {
    guest.activity = null;
    guest.destinationObjectId = null;
    if (thought !== null) setThought(guest, thought);
    if (!this.navigation.contains(guest.currentCell)) {
      const safePath = this.nearestEntranceConnectedPath(guest.position);
      if (!safePath) {
        this.guests.delete(guest.id);
        return;
      }
      guest.currentCell = { ...safePath };
      guest.position = { ...safePath };
    }
    guest.state = 'wandering';
    this.chooseDestination(guest, false);
  }

  /**
   * Phase 29: the cells guests were sick on since the last call (the session turns them into litter). The contract:
   * the session drains it right after every `step` (ParkSession.step), so the list never outlives a tick or reaches a
   * save, and `restore` empties it. A GuestSimulation stepped on its own (tests) accumulates the cells until someone
   * drains them; nothing in this class reads them.
   */
  drainSickCells(): Cell[] {
    const cells = this.sickCells;
    this.sickCells = [];
    return cells;
  }

  /** Walks the guest somewhere random with `thought`; Phase 30: `thoughtObjectId` links a complaint to its building. */
  private wander(guest: Guest, thought = 'Taking a look around.', thoughtObjectId: number | null = null): void {
    guest.activity = null;
    guest.servicePriceLimit = null;
    const reachable = this.navigation.connectedCells(guest.currentCell);
    for (let attempt = 0; attempt < 8 && reachable.length > 1; attempt += 1) {
      const goal = reachable[Math.floor(this.random.next() * reachable.length)];
      const route = this.navigation.findRoute(guest.currentCell, goal);
      if (route && route.length > 1) {
        guest.state = 'wandering';
        guest.destinationObjectId = null;
        setThought(guest, thought, thoughtObjectId);
        this.assignRoute(guest, route);
        return;
      }
    }
    this.sendHome(guest, "There isn't much I can reach.");
  }

  private sendHome(guest: Guest, thought: string): void {
    guest.activity = null;
    if (guest.state === 'queueing' && guest.destinationObjectId !== null) {
      this.rides.leaveQueue(guest.destinationObjectId, guest.id);
    }
    if (guest.state === 'queueingForShop' && guest.destinationObjectId !== null) {
      this.shops.leaveQueue(guest.destinationObjectId, guest.id);
    }
    guest.state = 'leaving';
    guest.destinationObjectId = null;
    guest.servicePriceLimit = null;
    setThought(guest, thought);
    const route = this.navigation.findRoute(guest.currentCell, this.world.entrance);
    if (route) this.assignRoute(guest, route);
    else if (guest.currentCell.x === this.world.entrance.x && guest.currentCell.y === this.world.entrance.y) {
      guest.route = [{ ...this.world.entrance }];
      guest.routeIndex = 1;
      guest.stateTimerSeconds = 0;
    } else {
      guest.route = [];
      guest.routeIndex = 0;
      guest.routeVersion = this.world.pathVersion;
      guest.stateTimerSeconds = 0;
      setThought(guest, "I can't reach the exit.");
    }
  }

  private assignRoute(guest: Guest, route: Cell[]): void {
    guest.route = route;
    guest.routeIndex = Math.min(1, route.length);
    guest.routeVersion = this.world.pathVersion;
    guest.stateTimerSeconds = 0;
  }

  private walk(guest: Guest, deltaSeconds: number): void {
    if (guest.routeVersion !== this.world.pathVersion) {
      const safePath = this.nearestEntranceConnectedPath(guest.position);
      if (!safePath) {
        this.guests.delete(guest.id);
        return;
      }
      guest.currentCell = { ...safePath };
      guest.position = { ...safePath };
      if (guest.state === 'leaving') this.sendHome(guest, guest.currentThought);
      else this.chooseDestination(guest);
      return;
    }
    if (guest.state === 'leaving' && guest.route.length === 0) {
      if (guest.stateTimerSeconds >= 3) this.guests.delete(guest.id);
      return;
    }
    if (guest.routeIndex >= guest.route.length) {
      this.arrive(guest);
      return;
    }
    const target = guest.route[guest.routeIndex];
    const dx = target.x - guest.position.x;
    const dy = target.y - guest.position.y;
    const distance = Math.hypot(dx, dy);
    // Phase 14 (design Q2): the step onto `target` is slowed by its crowd factor, the literal 1 below load 1 (an IEEE
    // multiply by 1 is exact, so a park below the threshold walks exactly as before).
    const movement = GAME_CONFIG.guests.walkingCellsPerSecond * deltaSeconds * this.conditions.walkSpeedFactor
      * this.crowd.speedFactorAt(target);
    if (distance <= movement) {
      guest.position = { ...target };
      guest.currentCell = { ...target };
      guest.routeIndex += 1;
      // The tile-entry moment of a guest walking a route (the only source of crowd flow).
      this.crowd.noteEntry(target);
      if (guest.routeIndex >= guest.route.length) this.arrive(guest);
    } else {
      guest.position.x += dx / distance * movement;
      guest.position.y += dy / distance * movement;
    }
  }

  private arrive(guest: Guest): void {
    guest.stateTimerSeconds = 0;
    if (guest.state === 'leaving') {
      if (guest.currentCell.x === this.world.entrance.x && guest.currentCell.y === this.world.entrance.y) this.guests.delete(guest.id);
      else this.sendHome(guest, guest.currentThought);
      return;
    }
    if (guest.state === 'walkingToRide' && guest.destinationObjectId !== null) {
      const destinationId = guest.destinationObjectId;
      if (!this.world.objects.has(destinationId)) {
        this.chooseDestination(guest);
        return;
      }
      const result = this.rides.joinQueue(destinationId, guest);
      if (result === 'joined') return;
      guest.destinationObjectId = null;
      guest.state = 'wandering';
      guest.stateTimerSeconds = 0;
      // Phase 30: the complaint names the ride (the Pulse and the inspector link to it).
      setThought(guest, result === 'unaffordable'
        ? "I'm not paying that much."
        : result === 'full'
          ? 'That queue is completely full.'
          : 'That ride is closed.', destinationId);
      guest.happiness = Math.max(0, guest.happiness - 2);
      return;
    }
    if (guest.state === 'walkingToBench') {
      if (guest.destinationObjectId === null || !this.world.objects.has(guest.destinationObjectId)
        || guest.activity === null || !isSeat(guest.activity)) {
        this.chooseDestination(guest, false);
        return;
      }
      guest.state = 'resting';
      setThought(guest, THOUGHTS.sitDown);
      return;
    }
    if (guest.state === 'walkingToShop' && guest.destinationObjectId !== null) {
      const destinationId = guest.destinationObjectId;
      if (!this.world.objects.has(destinationId)) {
        this.chooseDestination(guest);
        return;
      }
      const result = this.shops.joinQueue(destinationId, guest);
      if (result === 'joined') {
        if (!guest.recentServiceIds.includes(destinationId)) guest.recentServiceIds.unshift(destinationId);
        guest.recentServiceIds = guest.recentServiceIds.slice(0, 3);
        return;
      }
      guest.destinationObjectId = null;
      guest.servicePriceLimit = null;
      guest.state = 'wandering';
      guest.stateTimerSeconds = 0;
      setThought(guest, result === 'unaffordable'
        ? "I'm not paying that much."
        : result === 'full'
          ? 'That service queue is completely full.'
          : 'That service is closed.', destinationId);
      guest.happiness = Math.max(0, guest.happiness - 2);
      return;
    }
    this.chooseDestination(guest);
  }

  private updateQueueing(guest: Guest): void {
    const destinationId = guest.destinationObjectId;
    if (destinationId === null) {
      guest.state = 'wandering';
      return;
    }
    guest.lastQueueWaitSeconds = guest.stateTimerSeconds;
    const estimatedWait = this.rides.estimatedWaitSeconds(destinationId);
    if (guest.stateTimerSeconds <= guest.patienceSeconds && estimatedWait <= guest.patienceSeconds * 1.35) return;
    this.rides.leaveQueue(destinationId, guest.id);
    if (!GAME_CONFIG.guestLife.enabled) {
      guest.state = 'wandering';
      guest.destinationObjectId = null;
      setThought(guest, 'This queue is taking forever.', destinationId);
      guest.happiness = Math.max(0, guest.happiness - 6);
      guest.stateTimerSeconds = 0;
      this.wander(guest, 'This queue is taking forever.', destinationId);
      return;
    }
    guest.happiness = Math.max(0, guest.happiness - 6);
    // Phase 29: a stomp of frustration first; the sulk then sends the guest wandering. Phase 30: naming the ride.
    startPause(guest, 'sulk', 'This queue is taking forever.', null, destinationId);
  }

  private updateShopQueueing(guest: Guest): void {
    const destinationId = guest.destinationObjectId;
    if (destinationId === null) {
      guest.state = 'wandering';
      return;
    }
    const destination = this.serviceDestinations.find((candidate) => candidate.object.id === destinationId);
    const isAtReachableAccess = destination?.accessCells.some((cell) => keyOf(cell) === keyOf(guest.currentCell)) ?? false;
    if (!destination || !this.navigation.contains(guest.currentCell) || !isAtReachableAccess) {
      this.shops.leaveQueue(destinationId, guest.id);
      const safePath = this.nearestEntranceConnectedPath(guest.position);
      if (!safePath) {
        this.guests.delete(guest.id);
        return;
      }
      guest.position = { ...safePath };
      guest.currentCell = { ...safePath };
      guest.routeVersion = this.world.pathVersion;
      this.chooseDestination(guest);
      return;
    }
    guest.lastQueueWaitSeconds = guest.stateTimerSeconds;
    const estimatedWait = this.shops.estimatedWaitSeconds(destinationId, guest.id);
    if (guest.stateTimerSeconds <= guest.patienceSeconds
      && estimatedWait <= guest.patienceSeconds * GAME_CONFIG.services.queuePatienceMultiplier) return;
    this.shops.leaveQueue(destinationId, guest.id);
    guest.happiness = Math.max(0, guest.happiness - 5);
    if (GAME_CONFIG.guestLife.enabled) startPause(guest, 'sulk', 'This queue is taking forever.', null, destinationId);
    else this.wander(guest, 'This queue is taking forever.', destinationId);
  }

  private updateNeeds(guest: Guest, seconds: number): void {
    const life = GAME_CONFIG.guestLife;
    // Phase 29: the stomach settles and the guest's warmth drifts toward the park's (hat and umbrella soften it).
    if (guest.nausea > 0) guest.nausea = Math.max(0, guest.nausea - life.nausea.decayPerSecond * seconds);
    if (life.enabled) {
      guest.warmth = clamp(guest.warmth + (targetWarmth(guest, this.conditions) - guest.warmth) * Math.min(1, life.warmth.driftPerSecond * seconds), 0, 100);
    }
    const hot = guest.warmth >= life.warmth.hot;
    const cold = guest.warmth <= life.warmth.cold;
    const needSeconds = seconds * this.needDecayMultiplier;
    guest.hunger = Math.min(100, guest.hunger + GAME_CONFIG.guests.hungerPerSecond * needSeconds * this.hungerRateMultiplier);
    guest.thirst = Math.min(100, guest.thirst + GAME_CONFIG.guests.thirstPerSecond * needSeconds * this.conditions.thirstFactor * this.thirstRateMultiplier
      * (hot ? life.warmth.hotThirstFactor : 1));
    guest.toiletNeed = Math.min(100, guest.toiletNeed + GAME_CONFIG.guests.toiletNeedPerSecond * needSeconds);
    guest.energy = Math.max(0, guest.energy - GAME_CONFIG.guests.energyPerSecond * seconds);
    const sceneryScore = guest.state === 'leaving' ? 0 : this.scenery.scoreAt(guest.currentCell);
    this.applySceneryAmbience(guest, sceneryScore, seconds);
    const exposed = isExposed(guest.state);
    const soaked = isSoaked(guest, this.conditions);
    // Phase 30: the positive counterpart of soaked, for the thought cascade only.
    const dry = isDryUnderUmbrella(guest, this.conditions);
    const glowing = life.enabled && this.conditions.night && holdsSouvenir(guest, 'glowWand');
    if (life.enabled && guest.state !== 'leaving') this.applyLifeMood(guest, seconds, hot, cold, soaked, glowing);
    if (life.enabled && exposed && holdsSouvenir(guest, 'balloon') && this.random.next() < life.souvenir.balloonLossPerSecond * seconds) {
      guest.souvenirs &= ~souvenirBit('balloon');
      guest.happiness = Math.max(0, guest.happiness - life.souvenir.balloonLossHappiness);
      if (guest.state === 'wandering') startPause(guest, 'balloonLost', THOUGHTS.balloonLost);
      // Phase 30 (review fix): a sulking guest keeps the queue complaint, whose id the sulk's end passes on (the
      // balloon is still gone and the mood still drops).
      else if (guest.activity !== 'sulk') setThought(guest, THOUGHTS.balloonLost);
    }
    // Phase 14 (design Q2): a moving guest on a severe tile loses happiness (feedback parks only; never runs below
    // the threshold, so those parks compute exactly the old floats).
    const crowded = this.isMoving(guest) && this.crowd.isSevereAt(guest.currentCell);
    if (crowded) {
      const loss = GAME_CONFIG.crowd.severeHappinessPerSecond * (this.crowd.strength ?? 1) * seconds;
      guest.happiness = Math.max(0, guest.happiness - loss);
    }
    if (guest.state !== 'entering' && guest.state !== 'wandering') return;
    const hasFreshActionableThought = guest.stateTimerSeconds < 6 && (
      guest.currentThought.startsWith("I can't find")
      || guest.currentThought.startsWith("I'm not paying")
      || guest.currentThought === 'This queue is taking forever.'
      || guest.currentThought === 'That snack hit the spot!'
      || guest.currentThought === 'That was refreshing!'
      || guest.currentThought === 'Much better.'
    );
    if (hasFreshActionableThought) return;
    // None of these is a complaint about a building, so each clears the link (setThought).
    if (guest.toiletNeed > 78) setThought(guest, 'I need a toilet.');
    else if (guest.thirst > 72) setThought(guest, 'I could use a drink.');
    else if (guest.hunger > 76) setThought(guest, 'I am getting hungry.');
    else if (guest.energy < 24) setThought(guest, life.enabled && this.benchDestinations.length === 0 ? THOUGHTS.noBench : 'My feet need a rest.');
    else if (hot) setThought(guest, THOUGHTS.hot);
    else if (cold) setThought(guest, THOUGHTS.cold);
    else if (soaked) setThought(guest, THOUGHTS.soaked);
    else if (crowded) setThought(guest, CROWDED_THOUGHT);
    // Phase 30 (review fix): the new umbrella line never replaces a live complaint, so a price or queue complaint
    // keeps counting in the value factor exactly as it did before the line existed (glowing and scenery: Phase 29).
    else if (dry && !COMPLAINT_THOUGHTS.has(guest.currentThought)) setThought(guest, THOUGHTS.dryUnderUmbrella);
    else if (glowing) setThought(guest, THOUGHTS.glowing);
    else if (sceneryScore >= GAME_CONFIG.scenery.ambientThoughtThreshold) setThought(guest, 'What a lovely spot.');
  }

  /**
   * Phase 29: heat, cold and rain without an umbrella wear the mood down; a balloon, a plush and a glow wand at night
   * lift it, up to a ceiling (keepsakes comfort, they do not replace rides).
   */
  private applyLifeMood(guest: Guest, seconds: number, hot: boolean, cold: boolean, soaked: boolean, glowing: boolean): void {
    const life = GAME_CONFIG.guestLife;
    let loss = 0;
    if (hot) loss += life.warmth.hotHappinessPerSecond;
    if (cold) loss += life.warmth.coldHappinessPerSecond;
    if (soaked) loss += life.rain.soakedHappinessPerSecond * this.conditions.weatherIntensity;
    if (loss > 0) guest.happiness = Math.max(0, guest.happiness - loss * seconds);
    const souvenir = life.souvenir;
    let gain = 0;
    if (holdsSouvenir(guest, 'balloon')) gain += souvenir.balloonHappinessPerSecond;
    if (holdsSouvenir(guest, 'plush')) gain += souvenir.plushHappinessPerSecond;
    if (glowing) gain += souvenir.glowHappinessPerSecond;
    if (gain > 0 && guest.happiness < souvenir.maximumHappiness) {
      guest.happiness = Math.min(souvenir.maximumHappiness, guest.happiness + gain * seconds);
    }
  }

  // Pleasant surroundings lift the mood of guests who are still enjoying the park, mirroring
  // the litter penalty. The ceiling keeps scenery a supporting comfort rather than a substitute
  // for rides and services.
  private applySceneryAmbience(guest: Guest, sceneryScore: number, seconds: number): void {
    const threshold = GAME_CONFIG.scenery.ambientHappinessThreshold;
    if (sceneryScore <= threshold || guest.happiness >= GAME_CONFIG.scenery.maximumAmbientHappiness) return;
    const strength = Math.min(1, (sceneryScore - threshold) / (GAME_CONFIG.scenery.maximumScore - threshold));
    const gain = strength * GAME_CONFIG.scenery.ambientHappinessPerSecond * seconds;
    guest.happiness = Math.min(GAME_CONFIG.scenery.maximumAmbientHappiness, guest.happiness + gain);
  }

  /**
   * Walking a route right now (the states `walk` moves, with steps left): the guests a jam holds up. Phase 30: a guest
   * on their way to a bench too (a state that exists only with guest life on, so the switch off is unchanged).
   */
  private isMoving(guest: Guest): boolean {
    return (guest.state === 'walkingToRide' || guest.state === 'walkingToShop' || guest.state === 'wandering' || guest.state === 'leaving'
      || guest.state === 'walkingToBench')
      && guest.routeIndex < guest.route.length;
  }

  private shouldLeave(guest: Guest): boolean {
    const leave = GAME_CONFIG.guests.leaveNeedThresholds;
    return guest.ageSeconds >= guest.maximumVisitSeconds || guest.thirst >= leave.thirst || guest.hunger >= leave.hunger
      || guest.toiletNeed >= leave.toiletNeed || guest.energy <= 8;
  }

  private leavingThought(guest: Guest): string {
    const leave = GAME_CONFIG.guests.leaveNeedThresholds;
    if (guest.thirst >= leave.thirst) return "I'm too thirsty to stay.";
    if (guest.hunger >= leave.hunger) return "I need to find food elsewhere.";
    if (guest.toiletNeed >= leave.toiletNeed) return "I couldn't find a toilet.";
    if (guest.energy <= 8) return "It's time to head home.";
    return 'What a day — time to go home.';
  }

  private needForService(guest: Guest, kind: ServiceKind): number {
    if (kind === 'food') return guest.hunger;
    if (kind === 'drink') return guest.thirst;
    if (kind === 'souvenir') return 0;
    return guest.toiletNeed;
  }

  /** The need at which a guest looks for a service; Phase 29: a queasy stomach puts food off. */
  private demandThreshold(guest: Guest, kind: ServiceKind): number {
    const threshold = this.serviceThreshold(kind);
    return kind === 'food' && guest.nausea > 0 ? threshold + guest.nausea * GAME_CONFIG.guestLife.nausea.foodAversion : threshold;
  }

  private serviceThreshold(kind: ServiceKind): number {
    if (kind === 'food') return GAME_CONFIG.services.foodDecisionThreshold;
    if (kind === 'drink') return GAME_CONFIG.services.drinkDecisionThreshold;
    if (kind === 'souvenir') return Number.POSITIVE_INFINITY;
    return GAME_CONFIG.services.toiletDecisionThreshold;
  }

  private missingServiceThought(kind: ServiceKind): string {
    if (kind === 'food') return "I can't find anything to eat.";
    if (kind === 'drink') return "I can't find anything to drink.";
    if (kind === 'souvenir') return 'Taking a look around.';
    return "I can't find a toilet.";
  }

  private nearestAccessDistance(start: Cell, accessCells: readonly Cell[]): number | null {
    let best: number | null = null;
    for (const cell of accessCells) {
      const distance = this.navigation.routeDistance(start, cell);
      if (distance !== null && (best === null || distance < best)) {
        best = distance;
        if (distance <= 1) break;
      }
    }
    return best;
  }

  private nearestEntranceConnectedPath(origin: Cell): Cell | null {
    const connected = this.navigation.connectedCells(this.world.entrance);
    let best: Cell | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const cell of connected) {
      const nextDistance = Math.abs(cell.x - origin.x) + Math.abs(cell.y - origin.y);
      if (nextDistance >= distance) continue;
      best = cell;
      distance = nextDistance;
    }
    return best ? { ...best } : null;
  }
}
