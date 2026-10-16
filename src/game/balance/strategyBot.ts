import { BUILD_BY_ID } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import { entranceFrame, type EntranceFrame } from '../maps/frame';
import type { MapId } from '../maps/types';
import type { StaffRole } from '../operations/types';
import { RESEARCH_PROJECTS } from '../progression/content';
import type { ResearchProjectId } from '../progression/types';
import type { ParkRuleset } from '../scenarios/rules';
import { placeAlongSpine, type BotPlacement } from '../scenarios/bot/scenarioBot';
import { ParkSession } from '../session/ParkSession';

/**
 * Test support (not imported by the app): the Phase 16 sandbox strategy bots (design section 2). A strategy is a
 * scripted player on a NEW Sandbox park: an opening build along a path spine from the gate (in the entrance frame, like
 * the Phase 22 scenario bot, whose `placeAlongSpine` it reuses), a cash-gated build queue checked every 30 s, research
 * bought by priority as soon as it is affordable, and staff hired at set times. It records a per-second trace and the
 * health measures of design section 2 over park minutes 35 to 45.
 */

/** A piece placed at an explicit cell of the entrance frame (scenery beside a ride; it needs no path). */
export interface CellPlacement {
  readonly definitionId: string;
  readonly at: readonly [l: number, d: number];
}

export type StrategyPlacement = BotPlacement | CellPlacement;

/** One queue entry: built in one go once cash covers its whole cost plus the reserve. */
export type StrategyQueueEntry = StrategyPlacement | readonly StrategyPlacement[];

export interface StrategyHire {
  readonly atSeconds: number;
  readonly role: StaffRole;
}

export interface StrategyDefinition {
  readonly id: string;
  readonly name: string;
  /** The path spine from the gate (lateral 0, depth 1..spineDepth). */
  readonly spineDepth: number;
  readonly opening: readonly StrategyPlacement[];
  readonly queue: readonly StrategyQueueEntry[];
  /** Research bought first, in this order; after it the rest of the tree in catalog order (see `researchRest`). */
  readonly research: readonly ResearchProjectId[];
  readonly hires: readonly StrategyHire[];
}

/** The Phase 16 ruleset keys a strategy run may set (through the `ParkSession` `rules` option). */
export interface StrategyRuleOverrides {
  readonly themeAffinity?: number;
  readonly researchCostScale?: number;
}

export interface StrategyRunOptions {
  readonly mapId?: MapId;
  /** The park seed; default: the map's own (today's park on Meadow). */
  readonly seed?: number;
  /** Merged into the ruleset the new park would compile; absent = the default ruleset, untouched. */
  readonly rules?: StrategyRuleOverrides;
  /** Park minutes to run (default 45). */
  readonly minutes?: number;
  /** The health window in park minutes (default 35 to 45). */
  readonly window?: readonly [from: number, to: number];
  /** Cash kept back by the build queue and by research (default 400). */
  readonly reserve?: number;
  /** After the priority list, keep buying the rest of the tree in catalog order (default true). */
  readonly researchRest?: boolean;
  /** Seconds between build-queue checks (default 30). */
  readonly queueIntervalSeconds?: number;
  /** Steadiness is measured from this park minute to the end (default 5: after the opening crowd arrives). */
  readonly steadyFrom?: number;
}

export interface StrategySample {
  readonly seconds: number;
  readonly cash: number;
  readonly guests: number;
  readonly rating: number;
  readonly happiness: number;
  readonly researchPoints: number;
  /** Every research point earned so far (held plus spent). */
  readonly researchPointsEarned: number;
  readonly sceneryScore: number;
  readonly operatingProfit: number;
}

export interface StrategyResult {
  readonly strategyId: string;
  readonly mapId: MapId;
  readonly seed: number;
  readonly rules: StrategyRuleOverrides;
  readonly openingSpend: number;
  readonly minimumCash: number;
  readonly finalCash: number;
  readonly window: {
    readonly rating: number;
    readonly happiness: number;
    readonly guests: number;
    /** The standard deviation of per-second happiness over the window (steadiness). */
    readonly happinessSpread: number;
    readonly sceneryScore: number;
    readonly operatingProfit: number;
  };
  /** Standard deviations of per-second happiness and rating from `steadyFrom` to the end: low = a steady park. */
  readonly steadiness: { readonly happiness: number; readonly rating: number };
  /** When each project was bought (park seconds), in purchase order. */
  readonly purchases: ReadonlyArray<{ readonly projectId: ResearchProjectId; readonly atSeconds: number; readonly researchPoints: number }>;
  /** Ride ticket revenue per ride rider over the whole run. */
  readonly revenuePerRider: number;
  readonly built: ReadonlyArray<{ readonly definitionId: string; readonly atSeconds: number }>;
  /** Every placement that could not be built; `essentialSkips` are the ones that are not scenery. */
  readonly skipped: readonly string[];
  readonly essentialSkips: readonly string[];
  /** Queue entries never reached (cash never covered them). */
  readonly unbuiltQueue: readonly string[];
  readonly samples: readonly StrategySample[];
}

const isCellPlacement = (placement: StrategyPlacement): placement is CellPlacement => 'at' in placement;

const entriesOf = (entry: StrategyQueueEntry): readonly StrategyPlacement[] => (
  Array.isArray(entry) ? entry as readonly StrategyPlacement[] : [entry as StrategyPlacement]
);

const isScenery = (definitionId: string): boolean => BUILD_BY_ID.get(definitionId)?.kind === 'scenery';

const placeAtCell = (session: ParkSession, frame: EntranceFrame, placement: CellPlacement, skipped: string[]): boolean => {
  const { world } = session;
  const definition = BUILD_BY_ID.get(placement.definitionId);
  if (!definition) { skipped.push(`${placement.definitionId}: unknown`); return false; }
  const [w, h] = definition.footprint;
  const [l, d] = placement.at;
  const anchor = frame.rectToWorld(l, d, w, h);
  const check = world.checkObjectBuild(placement.definitionId, anchor, frame.rotation);
  if (!check.ok && check.reason === 'obstacle') {
    for (const cell of world.footprintCells(definition, anchor, frame.rotation)) if (world.propAt(cell)) world.bulldoze(cell);
  }
  if (!world.buildObject(placement.definitionId, anchor, frame.rotation)) {
    skipped.push(`${placement.definitionId}: blocked at (${l}, ${d})`);
    return false;
  }
  session.syncWithWorld();
  return true;
};

const place = (session: ParkSession, frame: EntranceFrame, placement: StrategyPlacement, skipped: string[]): boolean => {
  if (isCellPlacement(placement)) return placeAtCell(session, frame, placement, skipped);
  const before = skipped.length;
  placeAlongSpine(session, frame, placement, skipped);
  return skipped.length === before;
};

/**
 * A new park built by `build`, with `overrides` merged into the ruleset it compiles. `build(rules)` must construct the
 * park exactly as the game would with `rules` absent. With overrides the park is built twice: once to compile its
 * ruleset, then with the merged ruleset (the `rules` option), redoing the two things a new park does only without that
 * option: a Sandbox's biome clock defaults, and the starting research points of a bonus.
 */
export const sessionWithRules = (
  build: (rules?: ParkRuleset) => ParkSession,
  overrides?: StrategyRuleOverrides,
): ParkSession => {
  const fresh = build();
  if (overrides === undefined || Object.keys(overrides).length === 0) return fresh;
  const rules = Object.freeze({ ...fresh.rules, ...overrides }) as ParkRuleset;
  const session = build(rules);
  if (session.scenarioDefinition === null) {
    const defaults = session.map.biome.sandboxDefaults;
    const preset = GAME_CONFIG.calendar.dayLengthPresets.find((candidate) => candidate.id === defaults.dayLengthPresetId);
    if (preset && preset.seconds !== session.calendar.dayLengthSeconds) session.calendar.setDayLength(preset.seconds);
    if (defaults.timeLock !== session.calendar.timeLock) session.calendar.setTimeLock(defaults.timeLock);
  }
  const startingPoints = fresh.progression.snapshot().researchPoints;
  if (startingPoints > 0) session.progression.grantResearchPoints(startingPoints);
  return session;
};

/** A NEW Sandbox park on `mapId` (default Meadow) with `seed` and the rule overrides. */
export const newStrategyPark = (options: Pick<StrategyRunOptions, 'mapId' | 'seed' | 'rules'> = {}): ParkSession => (
  sessionWithRules((rules) => new ParkSession(null, [], {
    ...(options.mapId === undefined ? {} : { mapId: options.mapId }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(rules === undefined ? {} : { rules }),
  }), options.rules)
);

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);

const spread = (values: readonly number[]): number => {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Runs `strategy` on a new Sandbox park and measures it (design section 2). Deterministic for the same options. */
export const runStrategy = (strategy: StrategyDefinition, options: StrategyRunOptions = {}): StrategyResult => {
  const session = newStrategyPark(options);
  const { world } = session;
  const frame = entranceFrame({ ...world.entrance, facing: world.entranceFacing });
  const reserve = options.reserve ?? 400;
  const minutes = options.minutes ?? 45;
  const [windowFrom, windowTo] = options.window ?? [35, 45];
  const queueInterval = options.queueIntervalSeconds ?? 30;
  const startCash = world.cash;
  const skipped: string[] = [];
  const built: Array<{ definitionId: string; atSeconds: number }> = [];

  // The opening: the spine (props on it cleared, as a player would), the buildings, the staff hired at 0.
  const spine = [];
  for (let depth = 1; depth <= strategy.spineDepth; depth += 1) {
    const cell = frame.toWorld(0, depth);
    if (world.propAt(cell)) world.bulldoze(cell);
    spine.push(cell);
  }
  world.buildPaths(spine);
  session.syncWithWorld();
  for (const placement of strategy.opening) {
    if (place(session, frame, placement, skipped)) built.push({ definitionId: placement.definitionId, atSeconds: 0 });
  }
  const hires = [...strategy.hires].sort((left, right) => left.atSeconds - right.atSeconds);
  let nextHire = 0;
  while (nextHire < hires.length && hires[nextHire].atSeconds <= 0) {
    session.operations.hireStaff(hires[nextHire].role);
    nextHire += 1;
  }
  const openingSpend = startCash - world.cash;

  const researchOrder: ResearchProjectId[] = [...strategy.research];
  if (options.researchRest ?? true) {
    for (const project of RESEARCH_PROJECTS) if (!researchOrder.includes(project.id)) researchOrder.push(project.id);
  }
  const purchases: Array<{ projectId: ResearchProjectId; atSeconds: number; researchPoints: number }> = [];
  let researchSpent = 0;

  const ticksPerSecond = Math.round(1000 / GAME_CONFIG.fixedStepMs);
  const totalSeconds = minutes * 60;
  let queueIndex = 0;
  let minimumCash = world.cash;
  const samples: StrategySample[] = [];

  for (let second = 1; second <= totalSeconds; second += 1) {
    for (let tick = 0; tick < ticksPerSecond; tick += 1) {
      session.step(GAME_CONFIG.fixedStepMs);
      minimumCash = Math.min(minimumCash, world.cash);
    }
    while (nextHire < hires.length && hires[nextHire].atSeconds <= second) {
      session.operations.hireStaff(hires[nextHire].role);
      nextHire += 1;
    }
    // Research: the first project in priority order that is neither done nor locked (a prerequisite or milestone
    // missing) is the one saved for; it is bought once its RP is held and cash covers it plus the reserve.
    const progression = session.progression.snapshot();
    for (const projectId of researchOrder) {
      const project = progression.projects.find((candidate) => candidate.id === projectId);
      if (!project || project.status === 'completed' || project.status === 'locked') continue;
      if (project.researchPointsRemaining <= 0 && world.cash >= project.cashCost + reserve) {
        const bought = session.progression.purchase(projectId);
        if (bought.ok) {
          purchases.push({ projectId, atSeconds: second, researchPoints: bought.researchPointsSpent });
          researchSpent += bought.researchPointsSpent;
        }
      }
      break;
    }
    if (second % queueInterval === 0 && queueIndex < strategy.queue.length) {
      const entry = entriesOf(strategy.queue[queueIndex]);
      const cost = entry.reduce((sum, placement) => sum + (BUILD_BY_ID.get(placement.definitionId)?.buildCost ?? 0), 0);
      if (world.cash >= cost + reserve) {
        for (const placement of entry) {
          if (place(session, frame, placement, skipped)) built.push({ definitionId: placement.definitionId, atSeconds: second });
        }
        queueIndex += 1;
      }
    }
    minimumCash = Math.min(minimumCash, world.cash);
    const management = session.management.snapshot();
    const researchPoints = session.progression.snapshot().researchPoints;
    samples.push({
      seconds: second,
      cash: round2(world.cash),
      guests: management.guestCount,
      rating: management.rating.score,
      happiness: management.operations.averageHappiness ?? 0,
      researchPoints,
      researchPointsEarned: round2(researchPoints + researchSpent),
      sceneryScore: management.parkScenery.parkScore,
      operatingProfit: round2(management.finances.operating.profit),
    });
  }

  const inWindow = samples.filter((sample) => sample.seconds > windowFrom * 60 && sample.seconds <= windowTo * 60);
  const steady = samples.filter((sample) => sample.seconds > (options.steadyFrom ?? 5) * 60);
  const profitAt = (minute: number): number => samples.find((sample) => sample.seconds === minute * 60)?.operatingProfit ?? 0;
  const finances = session.management.snapshot().finances;
  const riders = session.progression.snapshot().completedRideExperiences;
  return {
    strategyId: strategy.id,
    mapId: session.map.id as MapId,
    seed: session.seed,
    rules: { ...options.rules },
    openingSpend: round2(openingSpend),
    minimumCash: round2(minimumCash),
    finalCash: round2(world.cash),
    window: {
      rating: round2(mean(inWindow.map((sample) => sample.rating))),
      happiness: round2(mean(inWindow.map((sample) => sample.happiness))),
      guests: round2(mean(inWindow.map((sample) => sample.guests))),
      happinessSpread: round2(spread(inWindow.map((sample) => sample.happiness))),
      sceneryScore: round2(mean(inWindow.map((sample) => sample.sceneryScore))),
      operatingProfit: round2(profitAt(windowTo) - profitAt(windowFrom)),
    },
    steadiness: {
      happiness: round2(spread(steady.map((sample) => sample.happiness))),
      rating: round2(spread(steady.map((sample) => sample.rating))),
    },
    purchases,
    revenuePerRider: riders > 0 ? round2(finances.categories.rideTickets.revenue / riders) : 0,
    built,
    skipped,
    essentialSkips: skipped.filter((entry) => !isScenery(entry.split(':')[0])),
    unbuiltQueue: strategy.queue.slice(queueIndex).flatMap((entry) => entriesOf(entry).map((placement) => placement.definitionId)),
    samples,
  };
};

/** The health requirement of design section 2: the reasons a result fails it (empty = healthy). */
export const healthFailures = (result: StrategyResult): string[] => {
  const failures: string[] = [];
  if (result.minimumCash < 0) failures.push(`lowest cash ${result.minimumCash} < 0`);
  if (result.window.rating < 60) failures.push(`mean rating ${result.window.rating} < 60`);
  if (result.window.happiness < 60) failures.push(`mean happiness ${result.window.happiness} < 60`);
  if (result.window.guests < 50) failures.push(`mean guests ${result.window.guests} < 50`);
  if (result.window.operatingProfit <= 0) failures.push(`operating profit ${result.window.operatingProfit} <= 0`);
  if (result.essentialSkips.length > 0) failures.push(`skipped ${result.essentialSkips.join(', ')}`);
  const unbuiltEssential = result.unbuiltQueue.filter((id) => !isScenery(id));
  if (unbuiltEssential.length > 0) failures.push(`never built ${unbuiltEssential.join(', ')}`);
  return failures;
};

/** Research points earned by park second `seconds` (held plus spent). */
export const researchEarnedBy = (result: StrategyResult, seconds: number): number => (
  result.samples.find((sample) => sample.seconds === seconds)?.researchPointsEarned ?? 0
);

/** One line per result for tables and the sweep. */
export const formatStrategyRow = (result: StrategyResult): string => {
  const first = result.purchases[0];
  return [
    result.strategyId,
    result.mapId,
    `seed ${result.seed}`,
    `affinity ${result.rules.themeAffinity ?? 'default'}`,
    `scale ${result.rules.researchCostScale ?? 'default'}`,
    `open ${Math.round(result.openingSpend)}`,
    `min cash ${Math.round(result.minimumCash)}`,
    `rating ${result.window.rating}`,
    `happy ${result.window.happiness} (sd ${result.window.happinessSpread})`,
    `guests ${result.window.guests}`,
    `steadiness happy ${result.steadiness.happiness} rating ${result.steadiness.rating}`,
    `op profit ${Math.round(result.window.operatingProfit)}`,
    `scenery ${result.window.sceneryScore}`,
    `rev/rider ${result.revenuePerRider}`,
    `first research ${first ? `${first.projectId}@${(first.atSeconds / 60).toFixed(1)}m` : '-'}`,
    `projects ${result.purchases.length}`,
    `RP@12m ${Math.round(researchEarnedBy(result, 720))}`,
    `RP@45m ${Math.round(result.samples[result.samples.length - 1]?.researchPointsEarned ?? 0)}`,
    `final cash ${Math.round(result.finalCash)}`,
    `skips ${result.essentialSkips.length === 0 ? '-' : result.essentialSkips.join(';')}`,
    `unbuilt ${result.unbuiltQueue.length === 0 ? '-' : result.unbuiltQueue.join(';')}`,
    `health ${healthFailures(result).join('; ') || 'ok'}`,
  ].join(' | ');
};
