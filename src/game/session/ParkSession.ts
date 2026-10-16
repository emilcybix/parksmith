import { ParkCalendar } from '../calendar/ParkCalendar';
import type { CalendarView } from '../calendar/calendarMath';
import type { CalendarSettings } from '../calendar/ParkCalendar';
import { layoutFromState, layoutOfMapId } from '../maps/parse';
import type { MapId, MapLayout } from '../maps/types';
import { DEFAULT_MAP_ID } from '../maps/content';
import { WeatherSimulation } from '../weather/WeatherSimulation';
import type { WeatherForecastEntry, WeatherSeverity, WeatherView } from '../weather/types';
import { CARD_BY_ID, slotCostOf } from '../cards/content';
import { CardPlays, cardFaceOf, type CardPlaysLaws } from '../cards/CardPlays';
import { applyOneShot, canPlay, type OneShotHost } from '../cards/effects';
import { BUILD_BY_ID } from '../content/catalog';
import type { ActiveCardSnapshot, PulseCardDefinition, PulseCardId } from '../cards/types';
import { GuestSimulation } from '../guests/GuestSimulation';
import { ManagementSimulation } from '../management/ManagementSimulation';
import { collectOnboardingInput } from '../onboarding/collect';
import { onboardingFocusCells, type FocusProbe } from '../onboarding/focus';
import { OnboardingTracker } from '../onboarding/OnboardingTracker';
import type { OnboardingSnapshot } from '../onboarding/types';
import { OperationsSimulation } from '../operations/OperationsSimulation';
import { ProgressionSimulation } from '../progression/ProgressionSimulation';
import type { ProgressionEvent } from '../progression/types';
import { RideSimulation } from '../rides/RideSimulation';
import { ScenerySimulation } from '../scenery/ScenerySimulation';
import { ScenarioSimulation } from '../scenarios/ScenarioSimulation';
import { SCENARIO_BY_ID } from '../scenarios/content';
import {
  BIOME_RULE_KEYS,
  BONUS_ONLY_RULE_KEYS,
  OPTIONAL_RULE_KEYS,
  compileParkRules,
  crowdFeedbackOf,
  preBonusStartingCash,
  researchCostScaleOf,
  type OptionalRuleKey,
  type ParkRuleset,
} from '../scenarios/rules';
import type { ScenarioDefinition, ScenarioEvent, ScenarioSnapshot } from '../scenarios/types';
import { ShopSimulation } from '../shops/ShopSimulation';
import { footprintSize, type Cell } from '../types';
import { FACINGS, type MapEntrance } from '../maps/types';
import type { ScenarioId } from '../scenarios/types';
import { GameWorld } from '../World';
import { checkSessionConsistency, scenarioDayLengthSeconds } from '../save/consistency';
import { MAXIMUM_SAVED_AMOUNT } from '../save/ranges';
import { GAME_CONFIG } from '../config';
import { RESTORE_ORDER, type MapState, type ParkRulesetStateV14, type ParkSaveV15 } from '../save/state';
import { readGrant } from '../save/grant';
import { isRunTransition, runHash } from '../run/deck';
import { stageDefinitionOf } from '../run/stage';
import { readRunState } from '../run/validate';
import { RUN_STAGE_SCENARIO_ID, type RunState } from '../run/types';
import { SaveError } from '../save/version';
import { BONUS_CLAMPS, activeBonusSnapshotOf, compileBonusLayer, type ActiveBonusSnapshot, type BonusId } from '../profile/bonuses';
import { PROFILE_GATED_IDS, isProfileGated, normaliseGatedIds, unlockConditionText } from '../profile/unlocks';
import { PROJECT_BY_BUILD_ID, scaledResearchPoints } from '../progression/content';
import type { ResearchProjectId } from '../progression/types';
import { GAME_MODES, isGameMode, type GameMode } from '../modes/types';
import type { BuildingSnapshot } from './types';
import { CrowdSimulation } from '../crowd/CrowdSimulation';
import { flowPerMinute, isBottleneck, perLaneOf, withHysteresis } from '../crowd/bands';
import { cellIndexOf } from '../crowd/pathShape';
import { invalidateNeighborhoods, neighborhoodAt, neighborhoodsOf } from '../crowd/neighborhoods';
import { coverageOf, invalidateCoverage } from '../crowd/coverage';
import { aggregateNeighborhoods, type CrowdTileReader, type RideFacts, type ServiceFacts } from '../crowd/metrics';
import type { CrowdBand, CrowdHeatmapView, CrowdView } from '../crowd/types';

export const SANDBOX_SEED = 0x5eed1234;

/**
 * What the profile gave a park when it STARTED (Phase 22): the gated catalog entries it may build from the start and
 * the permanent bonuses compiled into its rules. Saved in the park; loading a save never reads the live profile.
 */
export interface ParkGrant {
  readonly unlockedBuildingIds: readonly string[];
  readonly bonusIds: readonly BonusId[];
}

export const EMPTY_GRANT: ParkGrant = Object.freeze({
  unlockedBuildingIds: Object.freeze([]) as readonly string[],
  bonusIds: Object.freeze([]) as readonly BonusId[],
});

/** Why a catalog entry cannot be built in this park (null = it can). */
export type BuildLock =
  | { kind: 'research'; projectId: ResearchProjectId }
  | { kind: 'scenario'; conditionName: string }
  | { kind: 'profile'; text: string };

/**
 * Construction options that only a restore needs. A normal new park passes none.
 */
export interface ParkSessionOptions {
  /**
   * The compiled ruleset to play under, used verbatim instead of recompiling it from the scenario
   * and cards. A save stores the ruleset it was playing under so a later card or scenario rebalance
   * cannot change a park in progress.
   */
  rules?: ParkRuleset;
  /** The constructor seed to report; the RNG's live state comes from the guest restore. */
  seed?: number;
  /**
   * false skips stamping the scenario's starting paths and objects into the world: a restore brings
   * the saved world (which may no longer contain them), and seeding first would only be wiped.
   */
  seedScenarioContent?: boolean;
  /**
   * A NEW park on this shipped map (Sandbox; a scenario uses its own `mapId`, default Meadow). Meadow, the
   * default, is today's park: same world, same seed, same weather.
   */
  mapId?: MapId;
  /**
   * The land of a saved or generated park (validated here; a bad one throws SaveError). Wins over `mapId`
   * and over the scenario's map; the save's ground, entrance and remaining props are used as saved.
   */
  map?: MapState;
  /**
   * A ready layout (a map built from a definition at runtime: a scenario or run map of Phase 22/23, the step-2
   * generator, a test). Its starting objects are stamped on a new park. Loses to `map`, wins over `mapId`.
   */
  layout?: MapLayout;
  /** How the park is played; default: `sandbox` without a scenario, `scenario` with one. Sandbox iff no scenario (RangeError otherwise). */
  mode?: GameMode;
  /** The profile's gift to a NEW park (unlocks, bonuses); on a restore, the grant the save holds. Default: none. */
  grant?: ParkGrant;
  /**
   * The run this park is a stage (or the frozen backdrop) of: REQUIRED when `mode` is `run`, and only then (RangeError
   * otherwise). The scenario must be the run's stage definition, the active cards must be `run.loadout` and the grant
   * must be `run.grant`.
   */
  run?: RunState;
}

const RULE_KEYS = [
  'startingCash',
  'arrivalIntervalMultiplier',
  'guestBudgetMultiplier',
  'servicePriceToleranceMultiplier',
  'needDecayMultiplier',
  'constructionCostMultiplier',
  'rideOperatingCostMultiplier',
  'rideDispatchMultiplier',
  'serviceDurationMultiplier',
  'needReliefMultiplier',
  'staffSalaryMultiplier',
  'staffSpeedMultiplier',
  'wetWeatherMultiplier',
  'chainLiftCostMultiplier',
  'recolourCostMultiplier',
] as const;

/**
 * The Phase 25 card-modifiable keys sit after `recolourCostMultiplier` and before the biome keys, and exist only when
 * they differ from 1: every park without such a card serialises byte-identically to before.
 */
const optionalKeysOf = (rules: ParkRuleset): Partial<Pick<ParkRulesetStateV14, OptionalRuleKey>> => {
  const keys: Partial<Pick<ParkRulesetStateV14, OptionalRuleKey>> = {};
  for (const key of OPTIONAL_RULE_KEYS) {
    if (rules[key] !== 1) keys[key] = rules[key];
  }
  return keys;
};

/** The biome-layer keys sit at the END of the saved ruleset and exist only when they differ from 1. */
const biomeKeysOf = (rules: ParkRuleset): Partial<Pick<ParkRulesetStateV14, (typeof BIOME_RULE_KEYS)[number]>> => {
  const keys: Partial<Pick<ParkRulesetStateV14, (typeof BIOME_RULE_KEYS)[number]>> = {};
  for (const key of BIOME_RULE_KEYS) {
    const value = rules[key];
    if (value !== undefined && value !== 1) keys[key] = value;
  }
  return keys;
};

/** The bonus-layer keys sit after the biome keys and exist only when non-zero. */
const bonusKeysOf = (rules: ParkRuleset): Partial<Pick<ParkRulesetStateV14, (typeof BONUS_ONLY_RULE_KEYS)[number]>> => {
  const keys: Partial<Pick<ParkRulesetStateV14, (typeof BONUS_ONLY_RULE_KEYS)[number]>> = {};
  if (rules.startingResearchPoints !== undefined && rules.startingResearchPoints > 0) keys.startingResearchPoints = rules.startingResearchPoints;
  if (rules.extraCardSlots !== undefined && rules.extraCardSlots > 0) keys.extraCardSlots = rules.extraCardSlots;
  return keys;
};

/**
 * The Phase 16 base-layer keys sit after the bonus keys (the LAST keys of a saved ruleset) and exist only when
 * non-neutral (affinity not 0, scale not 1): every park before Phase 16, and every park under a neutral config,
 * serialises byte-identically to before.
 */
const phase16KeysOf = (rules: ParkRuleset): Partial<Pick<ParkRulesetStateV14, 'themeAffinity' | 'researchCostScale'>> => {
  const keys: Partial<Pick<ParkRulesetStateV14, 'themeAffinity' | 'researchCostScale'>> = {};
  if (rules.themeAffinity !== undefined && rules.themeAffinity !== 0) keys.themeAffinity = rules.themeAffinity;
  if (rules.researchCostScale !== undefined && rules.researchCostScale !== 1) keys.researchCostScale = rules.researchCostScale;
  return keys;
};

/**
 * The Phase 14 base-layer key sits after the Phase 16 keys (the LAST key of a saved ruleset) and exists only when not 0:
 * every park before Phase 14, and every park under a config with feedback 0, serialises byte-identically to before.
 */
const phase14KeysOf = (rules: ParkRuleset): Partial<Pick<ParkRulesetStateV14, 'crowdFeedback'>> => (
  rules.crowdFeedback !== undefined && rules.crowdFeedback !== 0 ? { crowdFeedback: rules.crowdFeedback } : {}
);

/** Field-by-field copy: a spread of the live object could drag a future non-plain field into a save. */
const toPlainRuleset = (rules: ParkRuleset): ParkRulesetStateV14 => ({
  startingCash: rules.startingCash,
  lockedDefinitionIds: [...rules.lockedDefinitionIds],
  arrivalIntervalMultiplier: rules.arrivalIntervalMultiplier,
  guestBudgetMultiplier: rules.guestBudgetMultiplier,
  servicePriceToleranceMultiplier: rules.servicePriceToleranceMultiplier,
  needDecayMultiplier: rules.needDecayMultiplier,
  constructionCostMultiplier: rules.constructionCostMultiplier,
  rideOperatingCostMultiplier: rules.rideOperatingCostMultiplier,
  rideDispatchMultiplier: rules.rideDispatchMultiplier,
  serviceDurationMultiplier: rules.serviceDurationMultiplier,
  needReliefMultiplier: rules.needReliefMultiplier,
  staffSalaryMultiplier: rules.staffSalaryMultiplier,
  staffSpeedMultiplier: rules.staffSpeedMultiplier,
  wetWeatherMultiplier: rules.wetWeatherMultiplier,
  chainLiftCostMultiplier: rules.chainLiftCostMultiplier,
  recolourCostMultiplier: rules.recolourCostMultiplier,
  ...optionalKeysOf(rules),
  ...biomeKeysOf(rules),
  ...bonusKeysOf(rules),
  ...phase16KeysOf(rules),
  ...phase14KeysOf(rules),
});

/** What a saved Phase 16 or Phase 14 key may hold (the compile clamps of GAME_CONFIG; a save outside them is refused). */
const PHASE16_SAVED_BOUNDS = {
  maximumThemeAffinity: GAME_CONFIG.scenery.themeAffinity.maximumShare,
  researchCostScale: GAME_CONFIG.research.costScaleBounds,
  maximumCrowdFeedback: GAME_CONFIG.crowd.maximumFeedback,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** Validates the saved ruleset's shape; the values are used as saved (never clamped or rebuilt). */
const fromPlainRuleset = (state: unknown): ParkRuleset => {
  if (!isRecord(state)) throw new SaveError('invalid-state', 'ParkSession cannot restore: rules is not an object');
  const numbers = {} as Record<(typeof RULE_KEYS)[number], number>;
  for (const key of RULE_KEYS) {
    const value = state[key];
    // Multipliers scale intervals, costs and speeds, so zero or negative values divide by zero or
    // run time backwards; startingCash is money and may be any finite amount within the cap.
    const minimum = key === 'startingCash' ? 0 : 0.01;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > (key === 'startingCash' ? MAXIMUM_SAVED_AMOUNT : 100)) {
      throw new SaveError('invalid-state', `ParkSession cannot restore: rules.${key} is not a finite number in a sane range`);
    }
    numbers[key] = value;
  }
  // The Phase 25 keys: absent = 1; present = a finite number in 0.01..100 (an explicit 1 is the same ruleset).
  const optional = {} as Record<OptionalRuleKey, number>;
  for (const key of OPTIONAL_RULE_KEYS) {
    if (!(key in state)) {
      optional[key] = 1;
      continue;
    }
    const value = state[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.01 || value > 100) {
      throw new SaveError('invalid-state', `ParkSession cannot restore: rules.${key} is not a finite number in 0.01..100`);
    }
    optional[key] = value;
  }
  const locked = state.lockedDefinitionIds;
  if (!Array.isArray(locked) || locked.some((id) => typeof id !== 'string')) {
    throw new SaveError('invalid-state', 'ParkSession cannot restore: rules.lockedDefinitionIds is not a string array');
  }
  // The biome layer (schema 8): absent = 1, present = a finite number in 0.5..2; an exact 1 is cosmetic and dropped.
  const biome: Partial<Record<(typeof BIOME_RULE_KEYS)[number], number>> = {};
  for (const key of BIOME_RULE_KEYS) {
    if (!(key in state)) continue;
    const value = state[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 2) {
      throw new SaveError('invalid-state', `ParkSession cannot restore: rules.${key} is not a finite number in 0.5..2`);
    }
    if (value !== 1) biome[key] = value;
  }
  // The bonus layer (schema 10): absent = 0. Present = a whole number in range; anything else is refused.
  const bonus: Partial<Record<(typeof BONUS_ONLY_RULE_KEYS)[number], number>> = {};
  if ('startingResearchPoints' in state) {
    const value = state.startingResearchPoints;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > BONUS_CLAMPS.maxResearchPoints) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: rules.startingResearchPoints is not an integer in 1..30');
    }
    bonus.startingResearchPoints = value;
  }
  if ('extraCardSlots' in state) {
    if (state.extraCardSlots !== BONUS_CLAMPS.maxExtraCardSlots) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: rules.extraCardSlots is not exactly 1');
    }
    bonus.extraCardSlots = state.extraCardSlots;
  }
  // Phase 16 (content version 3): absent = neutral (affinity 0, scale 1); present = finite and within the config
  // bounds, anything else is refused. An explicit neutral value is the same ruleset and is dropped.
  const phase16: Partial<Pick<ParkRuleset, 'themeAffinity' | 'researchCostScale'>> = {};
  if ('themeAffinity' in state) {
    const value = state.themeAffinity;
    const maximum = PHASE16_SAVED_BOUNDS.maximumThemeAffinity;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
      throw new SaveError('invalid-state', `ParkSession cannot restore: rules.themeAffinity is not a finite number in 0..${maximum}`);
    }
    if (value !== 0) phase16.themeAffinity = value;
  }
  if ('researchCostScale' in state) {
    const value = state.researchCostScale;
    const { minimum, maximum } = PHASE16_SAVED_BOUNDS.researchCostScale;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new SaveError('invalid-state', `ParkSession cannot restore: rules.researchCostScale is not a finite number in ${minimum}..${maximum}`);
    }
    if (value !== 1) phase16.researchCostScale = value;
  }
  // Phase 14 (content version 4): absent = 0 = off; present = finite in 0..maximumFeedback, an explicit 0 is the same
  // ruleset and is dropped; anything else is refused.
  const phase14: Partial<Pick<ParkRuleset, 'crowdFeedback'>> = {};
  if ('crowdFeedback' in state) {
    const value = state.crowdFeedback;
    const maximum = PHASE16_SAVED_BOUNDS.maximumCrowdFeedback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
      throw new SaveError('invalid-state', `ParkSession cannot restore: rules.crowdFeedback is not a finite number in 0..${maximum}`);
    }
    if (value !== 0) phase14.crowdFeedback = value;
  }
  return Object.freeze({
    ...numbers,
    ...optional,
    lockedDefinitionIds: Object.freeze([...(locked as string[])]),
    ...biome,
    ...bonus,
    ...phase16,
    ...phase14,
  });
};

/** A run park must say what its run says: the loadout, the grant, the seed and the map recipe of the park's level. */
const checkRunPark = (state: ParkSaveV15, run: RunState, grant: ParkGrant): void => {
  const level = run.levels[run.parkLevelIndex];
  if (JSON.stringify(state.activeCardIds) !== JSON.stringify(run.loadout)) {
    throw new SaveError('invalid-state', "ParkSession cannot restore: activeCardIds differ from the run's loadout");
  }
  if (JSON.stringify(grant) !== JSON.stringify(run.grant)) {
    throw new SaveError('invalid-state', "ParkSession cannot restore: the park's grant differs from the run's grant");
  }
  if (state.seed !== level.parkSeed) throw new SaveError('invalid-state', "ParkSession cannot restore: the park seed differs from the run level's");
  if (JSON.stringify(state.map.recipe) !== JSON.stringify(level.recipe)) {
    throw new SaveError('invalid-state', "ParkSession cannot restore: the map's recipe differs from the run level's");
  }
};

/** Between stages the park on screen is the finished (or never started) one: its scenario must say so. */
const checkRunBackdrop = (session: ParkSession, run: RunState): void => {
  const status = session.scenario?.currentStatus;
  const elapsed = session.scenarioSnapshot()?.elapsedSeconds ?? 0;
  const fresh = run.phase === 'offer' || run.phase === 'loadout' ? run.parkLevelIndex === run.levelIndex : false;
  const expected: string | null = run.phase === 'won' ? 'succeeded'
    : run.phase === 'offer' || run.phase === 'loadout' ? (fresh ? 'running' : 'succeeded')
      : run.phase === 'lost' && run.history[run.history.length - 1]?.outcome === 'failed' ? 'failed' : null;
  if (expected !== null && status !== expected) {
    throw new SaveError('invalid-state', `ParkSession cannot restore: the run is ${run.phase} but its park is ${String(status)}`);
  }
  if (fresh && elapsed !== 0) throw new SaveError('invalid-state', 'ParkSession cannot restore: a park that has not started has time on its clock');
};

/** The calendar and weather choices a player makes (undo keeps them across a rewind). */
export interface ParkSettings extends CalendarSettings {
  weatherEnabled: boolean;
  weatherSeverity: WeatherSeverity;
}

export interface SessionStepEvents {
  progression: ProgressionEvent[];
  scenario: ScenarioEvent[];
}

/** Cards in order while their running slot cost fits `slots` (a rare takes two slots, Phase 25). */
const fitSlots = (cards: readonly PulseCardDefinition[], slots: number): PulseCardDefinition[] => {
  const fitted: PulseCardDefinition[] = [];
  let used = 0;
  for (const card of cards) {
    if (used + card.slotCost > slots) break;
    used += card.slotCost;
    fitted.push(card);
  }
  return fitted;
};

/** What ParkSession.playCard answers (design 3.2). */
export type PlayCardResult =
  | { ok: true; summary: string }
  | { ok: false; reason: 'not-a-run' | 'unknown' | 'not-in-loadout' | 'not-one-shot' | 'already-played' | 'not-playable'; hint?: string };

/**
 * Heatmap revisions are unique in the process (not per session), so a renderer holding a view of a swapped-out session
 * never mistakes a new session's first view for the one it already drew.
 */
let nextCrowdRevision = 1;

/** One hovered path tile (the CursorReadout line): its displayed band, flow and neighborhood name. */
export interface CrowdHover {
  band: CrowdBand;
  perMinute: number;
  bottleneck: boolean;
  neighborhoodName: string | null;
}

/**
 * Phase 14 presentation memory of a session (never saved, never read by the simulation): the displayed band of every
 * path tile with its hysteresis (`withHysteresis`, design Q1), the heatmap view and its revision, and the memoised
 * `CrowdView`. Refreshed at most once per tick and path version; a revision moves only when a displayed band (or the
 * set of path tiles) changes.
 */
class CrowdDisplay {
  /** Displayed band per cell, -1 = none (off-path or not yet seen). */
  private readonly memory: Int8Array;
  private refreshedTick = -1;
  private refreshedShape: object | null = null;
  private revision = 0;
  private heatmap: CrowdHeatmapView | null = null;
  private view: CrowdView | null = null;
  private viewTick = -1;
  private viewWorldVersion = -1;
  private viewPathVersion = -1;

  constructor(cellCount: number) {
    this.memory = new Int8Array(cellCount).fill(-1);
  }

  /** Brings the displayed bands up to `tick` (one pass over the path tiles; nothing when already there). */
  refresh(crowd: CrowdSimulation, tick: number): void {
    const shape = crowd.shape();
    if (tick === this.refreshedTick && shape === this.refreshedShape) return;
    let changed = this.revision === 0;
    if (shape !== this.refreshedShape) {
      // Forget the cells that are no longer paths (a rebuilt tile starts without memory).
      for (let index = 0; index < this.memory.length; index += 1) {
        if (this.memory[index] >= 0 && !(shape.laneWidth[index] > 0)) {
          this.memory[index] = -1;
          changed = true;
        }
      }
    }
    const { cells, laneWidth } = shape;
    for (let at = 0; at < cells.length; at += 1) {
      const cell = cells[at];
      const previous = this.memory[cell];
      const band = withHysteresis(previous < 0 ? null : (previous as CrowdBand), perLaneOf(flowPerMinute(crowd.pressureAt(cell)), laneWidth[cell]));
      if (band !== previous) {
        this.memory[cell] = band;
        changed = true;
      }
    }
    this.refreshedTick = tick;
    this.refreshedShape = shape;
    if (changed) {
      this.revision = nextCrowdRevision;
      nextCrowdRevision += 1;
      this.heatmap = null;
    }
  }

  /** The displayed band of a cell index (quiet when unknown). Call `refresh` first. */
  bandAt(cell: number): CrowdBand {
    const band = cell >= 0 && cell < this.memory.length ? this.memory[cell] : -1;
    return band < 0 ? 0 : (band as CrowdBand);
  }

  reader(crowd: CrowdSimulation): CrowdTileReader {
    const shape = crowd.shape();
    return {
      bandAt: (cell) => this.bandAt(cell),
      perMinuteAt: (cell) => flowPerMinute(crowd.pressureAt(cell)),
      bottleneckAt: (cell) => isBottleneck(this.bandAt(cell), shape, cell),
    };
  }

  /** Every path tile with its displayed band, ascending cell; the same object until the revision moves. */
  heatmapView(crowd: CrowdSimulation): CrowdHeatmapView {
    if (this.heatmap === null) {
      const { cells } = crowd.shape();
      const width = crowd.width;
      const viewCells: Array<{ x: number; y: number }> = [];
      const bands: CrowdBand[] = [];
      for (let at = 0; at < cells.length; at += 1) {
        const cell = cells[at];
        viewCells.push({ x: cell % width, y: Math.floor(cell / width) });
        bands.push(this.bandAt(cell));
      }
      this.heatmap = Object.freeze({ revision: this.revision, cells: Object.freeze(viewCells), bands: Object.freeze(bands) });
    }
    return this.heatmap;
  }

  memoisedView(tick: number, worldVersion: number, pathVersion: number): CrowdView | null {
    return this.view !== null && this.viewTick === tick && this.viewWorldVersion === worldVersion && this.viewPathVersion === pathVersion
      ? this.view
      : null;
  }

  remember(view: CrowdView, worldVersion: number, pathVersion: number): CrowdView {
    this.view = view;
    this.viewTick = view.tick;
    this.viewWorldVersion = worldVersion;
    this.viewPathVersion = pathVersion;
    return view;
  }

  /** Forget the memoised view and shape (an in-place restore: a restored world carries its saved versions verbatim). */
  invalidate(): void {
    this.view = null;
    this.viewTick = -1;
    this.refreshedTick = -1;
    this.refreshedShape = null;
  }
}

/** Sessions restored with a scenario result already latched (see `ParkSession.resultFromSave`). */
const RESULT_FROM_SAVE = new WeakSet<ParkSession>();

/**
 * One playable park: a world, every simulation wired to it, and (optionally) the
 * scenario being played. Starting or restarting a scenario simply constructs a new
 * session, so cash, guests, queues, timers, and transactions can never leak between
 * parks. Passing no definition creates the objective-free Sandbox.
 */
export class ParkSession {
  readonly rules: ParkRuleset;
  /** How the park is played. Sandbox if and only if there is no scenario definition. */
  readonly mode: GameMode;
  /** Normalised: gated ids only (catalog order), applied bonuses only (mode-filtered, canonical order). Saved as `grant`. */
  readonly grant: ParkGrant;
  private runState: RunState | null;
  readonly seed: number;
  readonly activeCards: readonly PulseCardDefinition[];
  readonly world: GameWorld;
  /** The land (ground, biome, entrance, size): immutable for the life of the session. */
  readonly map: MapLayout;
  readonly scenery: ScenerySimulation;
  /** Day number and time of day: a pure function of `world.tick` plus a tiny anchor; it never steps. */
  readonly calendar: ParkCalendar;
  /** Seeded weather and the per-tick park conditions (arrival rate, effects); saved as plain data. */
  readonly weather: WeatherSimulation;
  readonly rides: RideSimulation;
  readonly shops: ShopSimulation;
  readonly guests: GuestSimulation;
  readonly operations: OperationsSimulation;
  readonly progression: ProgressionSimulation;
  readonly management: ManagementSimulation;
  /** First Day progression; Sandbox only (null in a scenario park). */
  readonly onboarding: OnboardingTracker | null;
  readonly scenario: ScenarioSimulation | null;
  /** The one-shot ledger (Phase 25): exists exactly in mode `run`, saved as `plays`. */
  readonly plays: CardPlays | null;
  /**
   * The rolling crowd flow of every path tile (Phase 14). It runs in every park; its strength is the ruleset's
   * `crowdFeedback`. With feedback on it is saved as `crowd` (exactly then); with it off it is display only.
   */
  readonly crowd: CrowdSimulation;
  /** Presentation memory of the crowd (bands with hysteresis, heatmap revision, memoised view); never saved. */
  private readonly crowdDisplay: CrowdDisplay;

  constructor(
    readonly scenarioDefinition: ScenarioDefinition | null = null,
    selectedCardIds: readonly PulseCardId[] = [],
    options: ParkSessionOptions = {},
  ) {
    // Sandbox stays card-free, loadouts never exceed the scenario's slots, and the
    // loadout locks here for the whole park: cards cannot change mid-run.
    // The land first: its biome contributes to the ruleset and its seed to a new Sandbox.
    this.map = options.map
      ? layoutFromState(options.map)
      : options.layout ?? layoutOfMapId(options.mapId ?? scenarioDefinition?.mapId ?? DEFAULT_MAP_ID);
    this.mode = options.mode ?? (scenarioDefinition === null ? 'sandbox' : 'scenario');
    if (!isGameMode(this.mode)) throw new RangeError(`ParkSession: unknown game mode ${String(this.mode)}`);
    if ((this.mode === 'sandbox') !== (scenarioDefinition === null)) {
      throw new RangeError(`ParkSession: mode '${this.mode}' does not fit ${scenarioDefinition === null ? 'a park without' : 'a park with'} a scenario (Sandbox if and only if no scenario)`);
    }
    if ((this.mode === 'run') !== (options.run !== undefined)) {
      throw new RangeError(`ParkSession: a run is required exactly in mode 'run' (mode '${this.mode}'${options.run === undefined ? ' without a run' : ' with a run'})`);
    }
    if ((scenarioDefinition?.id === RUN_STAGE_SCENARIO_ID) !== (this.mode === 'run')) {
      throw new RangeError(`ParkSession: the run stage scenario belongs to mode 'run' only (mode '${this.mode}')`);
    }
    // The profile layer: a new park compiles its bonuses into the ruleset; a restore uses the ruleset as saved.
    const bonusLayer = compileBonusLayer(
      options.grant?.bonusIds ?? [],
      this.mode,
      preBonusStartingCash(scenarioDefinition?.rules),
    );
    this.grant = Object.freeze({
      unlockedBuildingIds: Object.freeze(normaliseGatedIds(options.grant?.unlockedBuildingIds ?? [])),
      bonusIds: Object.freeze([...bonusLayer.appliedBonusIds]),
    });
    const extraSlots = options.rules ? options.rules.extraCardSlots ?? 0 : bonusLayer.extraCardSlots;
    this.activeCards = scenarioDefinition
      ? fitSlots(
        [...new Set(selectedCardIds)]
          .map((cardId) => CARD_BY_ID.get(cardId))
          .filter((card): card is PulseCardDefinition => card !== undefined),
        scenarioDefinition.cardSlots + extraSlots,
      )
      : [];
    this.rules = options.rules ?? compileParkRules(
      scenarioDefinition?.rules,
      this.activeCards.map((card) => card.modifiers),
      this.map.biome.rules,
      bonusLayer,
    );
    if (options.run !== undefined) {
      if (JSON.stringify([this.activeCards.map((card) => card.id), this.grant.unlockedBuildingIds, this.grant.bonusIds])
        !== JSON.stringify([options.run.loadout, options.run.grant.unlockedBuildingIds, options.run.grant.bonusIds])) {
        throw new RangeError("ParkSession: the active cards and the grant must be the run's loadout and grant");
      }
    }
    this.runState = options.run ?? null;
    this.plays = this.mode === 'run' ? new CardPlays() : null;
    this.seed = options.seed ?? scenarioDefinition?.seed ?? this.map.seed ?? SANDBOX_SEED;
    this.world = new GameWorld(this.rules.startingCash, this.rules.constructionCostMultiplier, this.map, {
      // Phase 21: a scenario may override the map's starting owned area; the land price follows the ruleset.
      ...(scenarioDefinition?.ownedArea !== undefined ? { ownedArea: scenarioDefinition.ownedArea } : {}),
      landCostMultiplier: this.rules.landCostMultiplier,
    });
    if (options.seedScenarioContent !== false) {
      // The map's free starting content first, then the scenario's (both without cost or transactions).
      const starting = this.map.startingObjects;
      this.world.seedScenarioPaths(starting.paths);
      for (const object of starting.objects) this.world.seedScenarioObject(object.definitionId, object.anchor, object.rotation ?? 0);
      if (scenarioDefinition) {
        this.world.seedScenarioPaths(scenarioDefinition.setup.paths);
        for (const object of scenarioDefinition.setup.objects) {
          this.world.seedScenarioObject(object.definitionId, object.anchor);
        }
      }
    }
    this.scenery = new ScenerySimulation(this.world, this.rules);
    // A Scenario or run park plays the default day scaled by the day-length rule (exactly 720 s at 1); the Sandbox
    // keeps its own clock. The deadline (`timeLimitSeconds`) is in seconds and never moves.
    this.calendar = new ParkCalendar(
      () => this.world.tick,
      scenarioDefinition === null,
      scenarioDefinition === null ? GAME_CONFIG.calendar.defaultDayLengthSeconds : scenarioDayLengthSeconds(this.rules.dayLengthMultiplier),
    );
    // A NEW sandbox starts with its biome's clock; the player's switches win afterwards and are saved as today.
    if (scenarioDefinition === null && options.rules === undefined) this.applySandboxDefaults();
    this.weather = new WeatherSimulation(
      this.seed,
      this.calendar,
      {
        wetWeatherMultiplier: this.rules.wetWeatherMultiplier,
        weatherEffectMultiplier: this.rules.weatherEffectMultiplier,
        nightArrivalMultiplier: this.rules.nightArrivalMultiplier,
      },
      () => this.world.tick,
      { mix: this.map.biome.weatherMix, temperature: this.map.biome.temperature },
    );
    this.world.setGateSchedule(this.weather.conditions);
    this.rides = new RideSimulation(this.world, this.scenery, this.rules);
    this.rides.setConditions(this.weather.conditions);
    this.shops = new ShopSimulation(this.world, this.scenery, this.rules);
    this.guests = new GuestSimulation(this.world, this.rides, this.shops, this.seed, this.scenery);
    this.guests.applyRules(this.rules);
    this.guests.setConditions(this.weather.conditions);
    this.crowd = new CrowdSimulation(this.world, crowdFeedbackOf(this.rules));
    this.guests.setCrowd(this.crowd);
    this.crowdDisplay = new CrowdDisplay(this.world.width * this.world.height);
    this.operations = new OperationsSimulation(this.world, this.rides, this.shops, this.rules);
    this.progression = new ProgressionSimulation(this.world, researchCostScaleOf(this.rules));
    // A new park starts with the research points a permanent bonus grants; a restore brings the saved progression.
    // The bonus is saved in base RP (1..30) and granted at the park's research cost scale (Phase 16; exact at scale 1).
    if (options.rules === undefined && (this.rules.startingResearchPoints ?? 0) > 0) {
      this.progression.grantResearchPoints(
        scaledResearchPoints(this.rules.startingResearchPoints ?? 0, this.progression.researchCostScale),
      );
    }
    // Gated entries the grant does not hold are locked in this park (the profile snapshot is taken at park start).
    const granted = new Set(this.grant.unlockedBuildingIds);
    const profileLocked = new Set(PROFILE_GATED_IDS.filter((id) => !granted.has(id)));
    if (this.rules.lockedDefinitionIds.length > 0 || profileLocked.size > 0) {
      const locked = new Set(this.rules.lockedDefinitionIds);
      this.world.setBuildAccessPolicy({
        isUnlocked: (definitionId) => !locked.has(definitionId) && !profileLocked.has(definitionId) && this.progression.isUnlocked(definitionId),
      });
    }
    this.management = new ManagementSimulation(this.world);
    this.onboarding = scenarioDefinition ? null : new OnboardingTracker();
    this.scenario = scenarioDefinition ? new ScenarioSimulation(scenarioDefinition) : null;
    this.rides.syncWithWorld();
    this.shops.syncWithWorld();
    this.operations.syncWithWorld();
  }

  /**
   * True when this session was restored from a save whose scenario had already ended (succeeded or failed). Such a result
   * exists only because a file says so: "never trust a save for profile rewards" (Phase 22) makes it ineligible for any
   * reward (see rewardEligible). A result reached live in this session is never marked. Provenance, not park state: it is
   * kept outside the instance (`RESULT_FROM_SAVE`), so it is not saved, not hashed and not part of the session's graph.
   */
  get resultFromSave(): boolean {
    return RESULT_FROM_SAVE.has(this);
  }

  /** The run this park belongs to (mode `run` only). Constant inside a stage: it changes only through `advanceRun`. */
  get run(): RunState | null {
    return this.runState;
  }

  /**
   * The one way the run moves while a session lives: the result of acceptOffer, resolveStage or abandonRun (see
   * isRunTransition). Needs no world sync (the run is not world state). RangeError for anything else.
   */
  advanceRun(next: RunState): void {
    if (this.runState === null) throw new RangeError('ParkSession.advanceRun: this park is not part of a run');
    if (!isRunTransition(this.runState, next)) throw new RangeError('ParkSession.advanceRun: not a legal run transition');
    // Settling this park's stage: the result must carry exactly the ledger's plays and debt (else a save of the backdrop
    // would be refused on load, see CardPlaysLaws.settled).
    if (this.runState.phase === 'stage' && this.plays !== null) {
      const last = next.history[next.history.length - 1];
      if (JSON.stringify(last.playedCardIds) !== JSON.stringify(this.plays.playedIds(this.runState.loadout)) || last.unpaidDebt !== this.plays.unpaidTotal()) {
        throw new RangeError("ParkSession.advanceRun: the stage result's plays or debt differ from the park's one-shot ledger");
      }
    }
    this.runState = structuredClone(next);
  }

  /** Why this catalog entry cannot be built here, or null. Research is the old gate; `scenario` a rules lock; `profile` an unlock. */
  buildLockOf(definitionId: string): BuildLock | null {
    if (isProfileGated(definitionId) && !this.grant.unlockedBuildingIds.includes(definitionId)) {
      return { kind: 'profile', text: unlockConditionText(definitionId) };
    }
    if (this.rules.lockedDefinitionIds.includes(definitionId)) {
      return { kind: 'scenario', conditionName: this.scenarioDefinition?.constraint?.name ?? 'Scenario rules' };
    }
    const projectId = PROJECT_BY_BUILD_ID.get(definitionId);
    if (projectId !== undefined && !this.progression.isUnlocked(definitionId)) return { kind: 'research', projectId };
    return null;
  }

  /** Gated ids this park does not hold, with their unlock condition (for the HUD). Allocates; read it at park start. */
  profileLocks(): ReadonlyArray<{ definitionId: string; text: string }> {
    return PROFILE_GATED_IDS
      .filter((id) => !this.grant.unlockedBuildingIds.includes(id))
      .map((definitionId) => ({ definitionId, text: unlockConditionText(definitionId) }));
  }

  activeBonusesSnapshot(): ActiveBonusSnapshot[] {
    return activeBonusSnapshotOf(this.grant.bonusIds);
  }

  /** The biome's sandbox clock (day length preset, time-of-day lock), applied once to a new Sandbox. Meadow's are today's. */
  private applySandboxDefaults(): void {
    const defaults = this.map.biome.sandboxDefaults;
    const preset = GAME_CONFIG.calendar.dayLengthPresets.find((candidate) => candidate.id === defaults.dayLengthPresetId);
    if (preset && preset.seconds !== this.calendar.dayLengthSeconds) this.calendar.setDayLength(preset.seconds);
    if (defaults.timeLock !== this.calendar.timeLock) this.calendar.setTimeLock(defaults.timeLock);
  }

  /**
   * Brings every owner's world-derived cache up to date after a world edit, in the same order the
   * app's world-changed handler uses. A save is only exact after this ran for every edit, because
   * serialize() deliberately never syncs (a sync at save time would apply edits at a different
   * moment than the never-saved run does). The app calls this from the same place today, and
   * serialize() now throws a SaveError('unsynced') if it did not run, so an autosave can never
   * write a save that restore would reject.
   */
  syncWithWorld(): void {
    this.scenery.syncWithWorld();
    this.rides.syncWithWorld(this.guests.guests);
    this.shops.syncWithWorld(this.guests.guests);
    this.operations.syncWithWorld();
  }

  /**
   * The plain-data image of the whole park (the session part of a save; the envelope with the clock
   * is `createParkSave`). Pure: nothing here steps, syncs, drains an event buffer or refreshes
   * management, so a session that is saved mid-run continues exactly like one that is not. Only
   * legal between steps, and after `syncWithWorld` for any edit: otherwise it throws
   * SaveError('unsynced') instead of writing a save that could never be loaded.
   */
  serialize(): ParkSaveV15 {
    this.assertSynchronized();
    const state: ParkSaveV15 = {
      scenarioId: this.scenarioDefinition?.id ?? null,
      activeCardIds: this.activeCards.map((card) => card.id),
      seed: this.seed,
      rules: toPlainRuleset(this.rules),
      world: this.world.serialize(),
      scenery: this.scenery.serialize(),
      calendar: this.calendar.serialize(),
      weather: this.weather.serialize(),
      rides: this.rides.serialize(),
      shops: this.shops.serialize(),
      guests: this.guests.serialize(),
      // Schema 13: the crowd field right after the guests, EXACTLY when the ruleset has feedback (only then can it
      // change the future); every park without the rule keeps the schema 12 keys byte for byte.
      ...(this.crowd.feedback ? { crowd: this.crowd.serialize() } : {}),
      operations: this.operations.serialize(),
      progression: this.progression.serialize(),
      management: this.management.serialize(),
      onboarding: this.onboarding?.serialize() ?? null,
      scenario: this.scenario?.serialize() ?? null,
      map: this.world.serializeMap(),
      mode: this.mode,
      grant: { unlockedBuildingIds: [...this.grant.unlockedBuildingIds], bonusIds: [...this.grant.bonusIds] },
    };
    // Schema 12: the one-shot ledger, then the run as the LAST key; both exist only in mode `run`, so Sandbox and Scenario
    // states are byte-identical to schema 10.
    if (this.plays !== null) state.plays = this.plays.serialize();
    if (this.runState !== null) state.run = structuredClone(this.runState);
    return state;
  }

  /**
   * Refuses to serialize a session whose owners lag behind a world edit. Without this, an autosave
   * taken between `world.buildObject(...)` and `syncWithWorld()` writes a save that restore rejects
   * ("rides has no runtime for world ride 67"), and that failure only shows at LOAD time, after the
   * previous good save may already have been replaced. Checking here moves the failure to the one
   * moment where nothing has been lost yet. It deliberately does not sync on the caller's behalf:
   * a sync here would apply the edit at a different moment than a never-saved run does and would
   * change the float history of the scenery scores.
   */
  private assertSynchronized(): void {
    const unsynced = (owner: string, detail: string): never => {
      throw new SaveError(
        'unsynced',
        `ParkSession cannot serialize: ${owner} is out of date with the world (${detail}); call syncWithWorld() after every world edit before saving`,
      );
    };
    if (!this.scenery.isSyncedWithWorld()) unsynced('scenery', 'the world changed since its last sync');
    let rides = 0;
    let services = 0;
    let bins = 0;
    for (const object of this.world.objects.values()) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition) continue;
      if (definition.kind === 'ride') {
        rides += 1;
        if (!this.rides.rides.has(object.id)) unsynced('rides', `world ride ${object.id} has no runtime`);
      }
      if (definition.stats?.serviceType) {
        services += 1;
        if (!this.shops.services.has(object.id)) unsynced('shops', `world service ${object.id} has no runtime`);
      }
      if (definition.stats?.amenityType === 'bin') {
        bins += 1;
        if (!this.operations.bins.has(object.id)) unsynced('operations', `world bin ${object.id} has no runtime`);
      }
    }
    // The counts catch the other direction: a runtime whose object was demolished.
    if (this.rides.rides.size !== rides) unsynced('rides', `${this.rides.rides.size} runtimes for ${rides} world rides`);
    if (this.shops.services.size !== services) unsynced('shops', `${this.shops.services.size} runtimes for ${services} world services`);
    if (this.operations.bins.size !== bins) unsynced('operations', `${this.operations.bins.size} bins for ${bins} world bins`);
  }

  /**
   * Builds a fresh session and restores a saved state into it. A fresh instance (never the live
   * park) is what makes a failed load harmless: on any error the half-built session is simply
   * dropped. Every failure is a SaveError; nothing here steps the simulation.
   */
  static fromState(state: ParkSaveV15): ParkSession {
    try {
      return ParkSession.buildFromState(state);
    } catch (error) {
      if (error instanceof SaveError) throw error;
      throw new SaveError(
        'invalid-state',
        `The save could not be restored: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  // Phase 34: the migration entry point (`fromSave`) moved to `fromSave.ts` as `sessionFromSave`, so the migration
  // chain is not imported by this class and stays out of the main chunk.

  private static buildFromState(state: ParkSaveV15): ParkSession {
    if (!isRecord(state)) throw new SaveError('corrupt', 'The save state is not an object.');
    const scenarioId = state.scenarioId;
    if (scenarioId !== null && typeof scenarioId !== 'string') throw new SaveError('corrupt', 'The save state has no valid scenarioId.');
    if (!isGameMode(state.mode)) {
      throw new SaveError('invalid-state', `ParkSession cannot restore: mode is not one of ${GAME_MODES.join(', ')}`);
    }
    if ((state.mode === 'sandbox') !== (scenarioId === null)) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: mode and scenarioId disagree (Sandbox if and only if no scenario)');
    }
    // Schema 11: the run key exists in mode `run` and nowhere else; a run park is a stage of its run.
    if (Object.hasOwn(state, 'run') !== (state.mode === 'run')) {
      throw new SaveError('invalid-state', "ParkSession cannot restore: a run state exists exactly in mode 'run'");
    }
    // Schema 12: so does the one-shot ledger.
    if (Object.hasOwn(state, 'plays') !== (state.mode === 'run')) {
      throw new SaveError('invalid-state', "ParkSession cannot restore: the one-shot ledger (plays) exists exactly in mode 'run'");
    }
    if ((scenarioId === RUN_STAGE_SCENARIO_ID) !== (state.mode === 'run')) {
      throw new SaveError('invalid-state', "ParkSession cannot restore: the run stage scenario belongs to mode 'run' only");
    }
    let definition: ScenarioDefinition | null = null;
    let run: RunState | undefined;
    if (state.mode === 'run') {
      run = readRunState(state.run);
      const entrance = isRecord(state.map) ? state.map.entrance : undefined;
      if (!isRecord(entrance) || !Number.isInteger(entrance.x) || !Number.isInteger(entrance.y) || !FACINGS.includes(entrance.facing as never)) {
        throw new SaveError('invalid-state', 'ParkSession cannot restore: map.entrance is missing or malformed');
      }
      definition = stageDefinitionOf(run, run.parkLevelIndex, entrance as unknown as MapEntrance);
    } else if (scenarioId !== null) {
      definition = SCENARIO_BY_ID.get(scenarioId as ScenarioId) ?? null;
      if (!definition) {
        throw new SaveError('content-mismatch', `This save belongs to scenario '${scenarioId}', which this version of the game does not have.`);
      }
    }
    const grant = readGrant(state.grant, state.mode);
    if ((state.scenario === null) !== (scenarioId === null)) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: scenario state must exist exactly when scenarioId does');
    }
    if ((state.onboarding === null) !== (scenarioId !== null)) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: onboarding state must exist exactly when scenarioId does not');
    }
    if (!Array.isArray(state.activeCardIds) || state.activeCardIds.some((id) => typeof id !== 'string')) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: activeCardIds is not a string array');
    }
    for (const cardId of state.activeCardIds) {
      if (!CARD_BY_ID.has(cardId)) {
        throw new SaveError('content-mismatch', `This save uses Pulse Card '${cardId}', which this version of the game does not have.`);
      }
    }
    for (const key of RESTORE_ORDER) {
      const value = state[key];
      const allowedNull = key === 'scenario' || key === 'onboarding';
      if (!(isRecord(value) || (allowedNull && value === null))) {
        throw new SaveError('invalid-state', `ParkSession cannot restore: ${key} is missing or not an object`);
      }
    }
    if (typeof state.seed !== 'number' || !Number.isFinite(state.seed)) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: seed is not a finite number');
    }
    const rules = fromPlainRuleset(state.rules);
    const slotCost = state.activeCardIds.reduce((sum, cardId) => sum + slotCostOf(cardId), 0);
    if (slotCost > (definition?.cardSlots ?? 0) + (rules.extraCardSlots ?? 0)) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: activeCardIds cost more than the card slots plus the bonus slots');
    }
    if (rules.constructionCostMultiplier !== state.world.constructionCostMultiplier) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: rules and world disagree on constructionCostMultiplier');
    }
    // Cross-owner references first, on the plain data: a bad save is refused before anything is built.
    checkSessionConsistency(state);
    if (!isRecord(state.map)) throw new SaveError('invalid-state', 'ParkSession cannot restore: map is missing or not an object');
    if (run !== undefined) checkRunPark(state, run, grant);
    const session = new ParkSession(definition, state.activeCardIds, {
      rules,
      seed: state.seed,
      seedScenarioContent: false,
      map: state.map,
      mode: state.mode,
      grant,
      run,
    });
    if (session.activeCards.length !== state.activeCardIds.length) {
      throw new SaveError('content-mismatch', 'The saved Pulse Card loadout no longer fits this scenario\'s card slots.');
    }
    session.restoreState(state);
    if (run !== undefined) checkRunBackdrop(session, run);
    const restoredStatus = session.scenarioSnapshot()?.status;
    if (restoredStatus !== undefined && restoredStatus !== 'running') RESULT_FROM_SAVE.add(session);
    return session;
  }

  /**
   * Restores every owner in `RESTORE_ORDER` into THIS session, which must play the same scenario
   * under the same ruleset (the tests use it as an in-place rewind; the app's snapshot undo swaps to a fresh `fromState` session instead, see GameApp). It never steps, syncs, drains events or
   * refreshes management: any of those would move state a save already holds. The world notifies
   * its listeners during its own restore, before the other owners have restored, so a session with
   * subscribers must be re-synced by the caller afterwards; `fromState` builds an unsubscribed
   * session and has no such window. Not atomic if an owner rejects the state half-way: callers that
   * need atomicity use `fromState`.
   */
  restoreState(state: ParkSaveV15): void {
    if ((state.scenarioId ?? null) !== (this.scenarioDefinition?.id ?? null)) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: the save is for a different scenario than this session');
    }
    if (state.mode !== this.mode || JSON.stringify(state.grant) !== JSON.stringify({ unlockedBuildingIds: [...this.grant.unlockedBuildingIds], bonusIds: [...this.grant.bonusIds] })) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: the save was played in a different mode or with a different grant than this session');
    }
    if (this.runState !== null && (state.run === undefined || runHash(state.run) !== runHash(this.runState))) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: the save belongs to another run state than this session');
    }
    // Compared in normalised form (an explicit biome key of exactly 1 is the same ruleset as an absent one).
    if (JSON.stringify(toPlainRuleset(fromPlainRuleset(state.rules))) !== JSON.stringify(toPlainRuleset(this.rules))) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: the save was played under a different ruleset than this session');
    }
    // The land first: the world's own validation then checks paths, objects and track against the saved props.
    this.world.restoreMap(state.map);
    this.world.restore(state.world);
    this.scenery.restore(state.scenery);
    this.calendar.restore(state.calendar);
    this.weather.restore(state.weather);
    this.rides.restore(state.rides);
    this.shops.restore(state.shops);
    this.guests.restore(state.guests);
    // Schema 13: the crowd field exists exactly when the ruleset has feedback (`checkCrowdLaw` checks it on the plain
    // data for `fromState`; an in-place restore checks it here). A rule-off park keeps its display field.
    if (this.crowd.feedback) {
      if (!isRecord(state.crowd)) throw new SaveError('invalid-state', 'ParkSession cannot restore: crowd is missing although rules.crowdFeedback is on');
      this.crowd.restore(state.crowd);
    } else if (state.crowd !== undefined) {
      throw new SaveError('invalid-state', 'ParkSession cannot restore: crowd exists although rules.crowdFeedback is absent');
    }
    // Derived per world version: a restored world carries its saved versions verbatim, so the caches are dropped.
    this.crowd.invalidateShape();
    invalidateNeighborhoods(this.world);
    invalidateCoverage(this.world);
    this.crowdDisplay.invalidate();
    this.operations.restore(state.operations);
    this.progression.restore(state.progression);
    this.management.restore(state.management);
    if (this.onboarding && state.onboarding) this.onboarding.restore(state.onboarding);
    if (this.scenario && state.scenario) this.scenario.restore(state.scenario);
    if (this.plays !== null) {
      if (!isRecord(state.plays)) throw new SaveError('invalid-state', 'ParkSession cannot restore: plays is missing or not an object');
      this.plays.restore(state.plays, this.playsLaws());
    } else if (state.plays !== undefined) {
      throw new SaveError('invalid-state', "ParkSession cannot restore: the one-shot ledger (plays) exists exactly in mode 'run'");
    }
  }

  /** What the saved ledger must agree with: the run's loadout, the world tick and, on a backdrop, the stage's result. */
  private playsLaws(): CardPlaysLaws {
    const run = this.runState;
    if (run === null) throw new SaveError('invalid-state', 'ParkSession cannot restore: a one-shot ledger without a run');
    const result = run.history[run.parkLevelIndex];
    return {
      loadout: run.loadout,
      worldTick: this.world.tick,
      liveStage: run.phase === 'stage',
      settled: result ? { playedCardIds: result.playedCardIds, unpaidDebt: result.unpaidDebt } : null,
    };
  }

  step(stepMs: number): SessionStepEvents {
    this.world.advanceTick();
    // Deferred one-shot costs fall due first (Phase 25). Only a live stage's ledger runs: a backdrop's pending costs were
    // settled as the run's debt when the stage resolved.
    if (this.plays !== null && this.runState?.phase === 'stage') this.plays.step(this.world.tick, this.world);
    // Conditions first, so every owner sees the same weather and gate within a tick.
    this.weather.step(this.world.tick);
    // Phase 14: the crowd field decays once per tick before the guests walk (their entries and factors read it live).
    this.crowd.beginTick();
    this.guests.step(stepMs);
    // Phase 29: where guests were sick this tick becomes litter at once (the queue never outlives the tick or a save).
    for (const cell of this.guests.drainSickCells()) this.operations.addSick(cell);
    this.rides.step(stepMs, this.guests.guests);
    this.shops.step(stepMs, this.guests.guests);
    this.operations.step(stepMs, this.guests.guests);
    this.management.step(
      stepMs,
      this.guests.guests,
      this.rides,
      this.shops,
      this.operations.snapshot(),
      this.scenery.snapshot(),
      this.weather.conditions,
    );
    const managementSnapshot = this.management.snapshot();
    const parkRating = managementSnapshot.rating.score;
    this.progression.step(stepMs, this.rides, this.shops, parkRating);
    this.guests.setParkRating(parkRating);
    // Every 10th tick (1 s of sim time): tick-based so a restored run evaluates on the same ticks.
    if (this.onboarding && this.world.tick % 10 === 0) {
      this.onboarding.step(collectOnboardingInput(
        this.world, this.rides, this.shops, this.guests, this.management, managementSnapshot,
      ));
    }
    this.scenario?.step(stepMs, {
      cumulativeGuests: this.guests.totalArrivals,
      guestCount: this.guests.guests.size,
      parkRating,
      averageHappiness: managementSnapshot.operations.averageHappiness,
      operatingProfit: managementSnapshot.finances.operating.profit,
      averageQueueSeconds: managementSnapshot.operations.averageQueueSeconds,
      // Phase 21: only a park with restricted land carries the metric (older scenario saves keep their exact shape).
      ...(this.world.land.restricted ? { ownedParcels: this.world.land.ownedCount } : {}),
    });
    return {
      progression: this.progression.drainEvents(),
      scenario: this.scenario?.drainEvents() ?? [],
    };
  }

  /**
   * One First Day evaluation outside the 10-tick cadence. The cadence needs time to pass, so a
   * player who builds while paused would see the card stand still until they resume. Callers run
   * `refreshManagement()` first; evaluation is idempotent, sticky and a pure read of the snapshot.
   */
  evaluateOnboardingNow(): void {
    if (!this.onboarding) return;
    this.onboarding.step(collectOnboardingInput(
      this.world, this.rides, this.shops, this.guests, this.management, this.management.snapshot(),
    ));
  }

  /** Day, clock and phase now (tick may carry the interpolation fraction). Read-only. */
  calendarView(tick: number = this.world.tick): CalendarView {
    return this.calendar.view(tick);
  }

  /** The weather now (tick may carry the step fraction), into a view the caller owns. Allocation-free. */
  weatherViewInto(out: WeatherView, tick: number = this.world.tick): WeatherView {
    return this.weather.viewInto(out, tick);
  }

  /** The next slots of weather (empty when weather is off). Allocates; read it at a low rate. */
  weatherForecast(count = 8, tick: number = this.world.tick): WeatherForecastEntry[] {
    return this.weather.forecast(count, tick);
  }

  /** Sandbox switches. Each refuses (returns false) in a scenario park, whose weather and hours are fixed. */
  setWeatherEnabled(enabled: boolean): boolean {
    if (this.scenarioDefinition !== null || typeof enabled !== 'boolean') return false;
    this.weather.setEnabled(enabled);
    return true;
  }

  setWeatherSeverity(severity: WeatherSeverity): boolean {
    if (this.scenarioDefinition !== null || !(severity in GAME_CONFIG.weather.severityScale)) return false;
    this.weather.setSeverity(severity);
    return true;
  }

  setOpeningHours(enabled: boolean, open: number, close: number): boolean {
    if (!this.calendar.setOpeningHours(enabled, open, close)) return false;
    this.weather.refresh();
    return true;
  }

  /** The player's settings as one value: what an undo carries across a rewind. */
  settings(): ParkSettings {
    return { ...this.calendar.serialize(), weatherEnabled: this.weather.enabled, weatherSeverity: this.weather.severity };
  }

  /**
   * Undo rewinds the park, but how the player chose to play (day length, fixed time, opening hours,
   * weather switches) survives it. Called on the session an undo swapped in, with the live
   * session's settings. It never touches the drawn weather days, so a rewind cannot create a
   * forecast the player did not see.
   */
  adoptSettings(live: ParkSettings): void {
    this.calendar.adoptSettings(live);
    if (this.scenarioDefinition === null) {
      this.weather.enabled = live.weatherEnabled;
      this.weather.severity = live.weatherSeverity;
    }
    this.weather.refresh();
  }

  /** Recomputes management state without advancing time, for immediate UI refreshes. */
  refreshManagement(): void {
    this.management.step(
      0,
      this.guests.guests,
      this.rides,
      this.shops,
      this.operations.snapshot(),
      this.scenery.snapshot(),
      this.weather.conditions,
    );
    this.guests.setParkRating(this.management.snapshot().rating.score);
  }

  /**
   * Phase 14: the crowd and neighborhood picture (design Q4) for the dashboard, Park Pulse and the camera focus.
   * Memoised per tick and world version (the 250 ms UI cadence asks again between ticks for free). A pure read of the
   * owners: never steps, syncs or touches saved state (the scenery is read only while it is in sync with the world),
   * so a park that is looked at continues exactly like one that is not.
   */
  crowdView(): CrowdView {
    const tick = this.world.tick;
    const memo = this.crowdDisplay.memoisedView(tick, this.world.version, this.world.pathVersion);
    if (memo !== null) return memo;
    this.crowdDisplay.refresh(this.crowd, tick);
    const map = neighborhoodsOf(this.world);
    const services: ServiceFacts[] = [];
    for (const service of this.shops.services.values()) {
      services.push({
        objectId: service.objectId,
        kind: service.kind,
        open: service.open,
        queueLength: service.queueGuestIds.length,
        estimatedWaitSeconds: this.shops.estimatedWaitSeconds(service.objectId),
        lifetimeRevenue: service.lifetimeRevenue,
      });
    }
    const sceneryInSync = this.scenery.isSyncedWithWorld();
    const aggregate = aggregateNeighborhoods(this.world, map, {
      guests: this.guests.guests.values(),
      ride: (objectId): RideFacts | null => {
        const ride = this.rides.rides.get(objectId);
        return ride ? { queueLength: ride.queueGuestIds.length, estimatedWaitSeconds: this.rides.estimatedWaitSeconds(objectId), lifetimeRevenue: ride.lifetimeRevenue } : null;
      },
      services,
      litter: this.operations.litter.values(),
      sceneryScoreAt: (cell) => (sceneryInSync ? this.scenery.scoreAt(cell) : 0),
      crowd: this.crowdDisplay.reader(this.crowd),
    });
    const walkingByKey: Record<number, number> = {};
    for (const [key, count] of aggregate.walkingByKey) walkingByKey[key] = count;
    const open = coverageOf(this.world, services).openServices;
    return this.crowdDisplay.remember({
      tick,
      neighborhoods: aggregate.neighborhoods,
      bottlenecks: aggregate.bottlenecks,
      walking: aggregate.walking,
      feedback: this.crowd.feedback,
      walkingByKey,
      unreached: aggregate.unreached.length,
      openServices: { food: open.food, drink: open.drink, toilet: open.toilet },
    }, this.world.version, this.world.pathVersion);
  }

  /**
   * Phase 14: what the crowd heatmap draws, every path tile with its displayed band (hysteresis). Returns `previous`
   * itself when nothing displayed changed (same revision), so a renderer can skip the redraw by identity or revision.
   * Revisions are unique in the process, never reused by another session.
   */
  crowdHeatmap(previous: Readonly<CrowdHeatmapView> | null = null): Readonly<CrowdHeatmapView> {
    this.crowdDisplay.refresh(this.crowd, this.world.tick);
    const view = this.crowdDisplay.heatmapView(this.crowd);
    return previous !== null && previous.revision === view.revision ? previous : view;
  }

  /** Phase 14: the hovered path tile for the CursorReadout (null off the path network or off the map). */
  crowdHoverAt(cell: Readonly<Cell>): CrowdHover | null {
    const index = cellIndexOf(this.world.width, this.world.height, cell);
    if (index < 0) return null;
    this.crowdDisplay.refresh(this.crowd, this.world.tick);
    const shape = this.crowd.shape();
    if (!(shape.laneWidth[index] > 0)) return null;
    const band = this.crowdDisplay.bandAt(index);
    return {
      band,
      perMinute: flowPerMinute(this.crowd.pressureAt(index)),
      bottleneck: isBottleneck(band, shape, index),
      neighborhoodName: neighborhoodAt(neighborhoodsOf(this.world), cell)?.name ?? null,
    };
  }

  /**
   * Every placed building in one comparable list for the estate overview. Ride, service, bin,
   * and scenery numbers are read from the simulation that owns them, so the overview can never
   * disagree with an inspector.
   */
  buildingsSnapshot(): BuildingSnapshot[] {
    const bins = new Map(this.operations.snapshot().bins.map((bin) => [bin.objectId, bin]));
    const rows: BuildingSnapshot[] = [];
    for (const object of [...this.world.objects.values()].sort((left, right) => left.id - right.id)) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition) continue;
      const base = {
        objectId: object.id,
        definitionId: definition.id,
        name: definition.name,
        icon: definition.icon,
        kind: definition.kind,
        anchor: { ...object.anchor },
        footprint: footprintSize(definition, object.rotation),
      };
      if (definition.kind === 'ride') {
        const ride = this.rides.snapshot(object.id);
        if (!ride) continue;
        const coaster = ride.coaster;
        rows.push({
          ...base,
          group: 'ride',
          open: ride.open,
          status: ride.status,
          price: ride.ticketPrice,
          queueLength: ride.queueLength,
          waitSeconds: ride.estimatedWaitSeconds,
          served: ride.ridersToday,
          throughputPerHour: ride.throughputPerHour,
          revenue: ride.lifetimeRevenue,
          satisfaction: ride.satisfaction,
          condition: ride.condition,
          sceneryScore: ride.sceneryScore,
          detail: coaster
            ? `${coaster.pieces} pieces · ${coaster.drops} drops · excitement ${Math.round(ride.excitement)}`
            : `capacity ${ride.capacity} · ${Math.round(ride.rideDurationSeconds)}s · excitement ${Math.round(ride.excitement)}`,
        });
        continue;
      }
      if (definition.stats?.serviceType) {
        const service = this.shops.snapshot(object.id);
        if (!service) continue;
        rows.push({
          ...base,
          group: service.kind,
          open: service.open,
          status: service.status,
          price: service.itemPrice,
          queueLength: service.queueLength,
          waitSeconds: service.estimatedWaitSeconds,
          served: service.customersServed,
          throughputPerHour: null,
          revenue: service.lifetimeRevenue,
          satisfaction: service.satisfaction,
          condition: null,
          sceneryScore: service.sceneryScore,
          detail: `${service.serviceTimeSeconds.toFixed(1)}s per guest · relieves ${definition.stats.needRelief ?? 0}`,
        });
        continue;
      }
      const bin = bins.get(object.id);
      const quiet = {
        ...base,
        open: null,
        status: null,
        price: null,
        queueLength: null,
        waitSeconds: null,
        served: null,
        throughputPerHour: null,
        revenue: null,
        satisfaction: null,
        condition: null,
      };
      if (bin) {
        rows.push({
          ...quiet,
          group: 'bin',
          sceneryScore: null,
          detail: `${bin.fill}/${bin.capacity} full${bin.full ? ' · needs a cleaner' : ''}`,
        });
        continue;
      }
      if (definition.kind === 'scenery') {
        rows.push({
          ...quiet,
          group: 'scenery',
          sceneryScore: this.scenery.scoreForObject(object.id),
          detail: `+${definition.stats?.sceneryAppeal ?? 0} appeal · radius ${definition.stats?.sceneryRadius ?? 0}`,
        });
        continue;
      }
      rows.push({ ...quiet, group: 'other', sceneryScore: null, detail: definition.description });
    }
    return rows;
  }

  scenarioSnapshot(): ScenarioSnapshot | null {
    return this.scenario?.snapshot() ?? null;
  }

  onboardingSnapshot(): OnboardingSnapshot | null {
    return this.onboarding?.snapshot() ?? null;
  }

  /**
   * Where the current First Day hint wants the player to look: one cell or one footprint, at most
   * nine cells, empty when there is no current step or nothing to point at. Read-only; the app
   * asks at 4 Hz at most, so the scans below may stay simple.
   */
  onboardingFocus(): readonly Cell[] {
    const stepId = this.onboarding?.currentStepId() ?? null;
    if (stepId === null) return [];
    const connectivity = this.management.connectivity();
    const footprintOf = (objectId: number): readonly Cell[] | null => {
      const object = this.world.objects.get(objectId);
      return object ? this.world.objectFootprint(object) : null;
    };
    const probe: FocusProbe = {
      entrance: this.world.entrance,
      connectedPathTiles: connectivity.pathTiles,
      connectedTip: connectivity.tip,
      unconnectedRide: () => {
        for (const ride of this.rides.rides.values()) {
          if (!connectivity.objectIds.has(ride.objectId)) return footprintOf(ride.objectId);
        }
        return null;
      },
      defaultPricedRide: () => {
        for (const ride of this.rides.rides.values()) {
          const profile = this.world.rideProfile(ride.objectId);
          if (connectivity.objectIds.has(ride.objectId) && profile && ride.ticketPrice === profile.ticketPrice) {
            return footprintOf(ride.objectId);
          }
        }
        return null;
      },
      worstLitter: () => {
        let worst: { cell: Cell; units: number } | null = null;
        for (const pile of this.operations.litter.values()) {
          if (pile.units <= 0) continue;
          if (worst === null || pile.units > worst.units
            || (pile.units === worst.units && (pile.cell.y - worst.cell.y || pile.cell.x - worst.cell.x) < 0)) {
            worst = pile;
          }
        }
        return worst ? { x: worst.cell.x, y: worst.cell.y } : null;
      },
      brokenRide: () => {
        for (const ride of this.rides.rides.values()) {
          if (ride.broken) return footprintOf(ride.objectId);
        }
        return null;
      },
    };
    return onboardingFocusCells(stepId, probe);
  }

  /**
   * Plays a one-shot card of this run stage (Phase 25, design 3.2): between steps, once per card per stage. Never changes
   * the rules, the active cards or the run; the effect goes through the owners' own methods and `world.postTransaction`
   * (so `world.version` does not move: the app's undo stamp counts plays itself), and a deferred cost goes to `plays`.
   */
  playCard(cardId: string): PlayCardResult {
    if (this.plays === null || this.runState === null) return { ok: false, reason: 'not-a-run' };
    const card = CARD_BY_ID.get(cardId as PulseCardId);
    if (!card) return { ok: false, reason: 'unknown' };
    if (!this.activeCards.some((active) => active.id === card.id)) return { ok: false, reason: 'not-in-loadout' };
    if (card.kind !== 'one-shot') return { ok: false, reason: 'not-one-shot' };
    if (this.plays.hasPlayed(card.id)) return { ok: false, reason: 'already-played' };
    const host = this.oneShotHost();
    const check = canPlay(card.effect, host);
    if (!check.ok) return { ok: false, reason: 'not-playable', hint: check.hint };
    const outcome = applyOneShot(card.effect, host, card.name);
    this.plays.record(card.id, this.world.tick);
    if (outcome.deferred !== null) this.plays.schedule({ cardId: card.id, ...outcome.deferred });
    return { ok: true, summary: outcome.summary };
  }

  /** The session's owners as the structural host the one-shot effects run against (cards/effects.ts). */
  private oneShotHost(): OneShotHost {
    return {
      levelRunning: () => this.runState?.phase === 'stage' && this.scenario?.currentStatus === 'running',
      cash: () => this.world.cash,
      tick: () => this.world.tick,
      postTransaction: (amount, label, category) => this.world.postTransaction(amount, label, category),
      grantResearchPoints: (points) => this.progression.grantResearchPoints(points),
      researchCostScale: () => this.progression.researchCostScale,
      brokenRideCount: () => this.rides.repairableCount(),
      serviceableRideCount: () => this.rides.serviceableCount(),
      repairBroken: () => this.rides.repairBroken(this.guests.guests),
      serviceAll: () => this.rides.serviceAll(this.guests.guests),
      litterCount: () => this.operations.litter.size,
      usedBinCount: () => this.operations.usedBinCount(),
      sweepLitter: () => this.operations.sweepLitter(),
      emptyBins: () => this.operations.emptyBins(),
      rewriteForecast: (kind, count, intensity) => this.weather.rewriteForecast(kind, count, intensity, this.world.tick),
      guestCount: () => this.guests.guests.size,
      guestMaximum: () => GAME_CONFIG.guests.maximum,
      spawnGuests: (count) => this.guests.spawnGuests(count),
      adjustHappiness: (delta) => this.guests.adjustHappiness(delta),
    };
  }

  cardsSnapshot(): ActiveCardSnapshot[] {
    const host = this.plays !== null ? this.oneShotHost() : null;
    const ticksPerSecond = 1000 / GAME_CONFIG.fixedStepMs;
    return this.activeCards.map((card): ActiveCardSnapshot => {
      const base = cardFaceOf(card);
      if (card.kind === 'stage') {
        return { ...base, playState: 'stage', playedAtSeconds: null, playable: false, hint: null, pending: null };
      }
      const playedTick = this.plays?.playedTick(card.id) ?? null;
      if (playedTick !== null) {
        const pending = this.plays?.pendingOf(card.id) ?? null;
        return {
          ...base,
          playState: 'played',
          playedAtSeconds: playedTick / ticksPerSecond,
          playable: false,
          hint: null,
          pending: pending === null ? null : { amount: pending.amount, dueInSeconds: Math.max(0, pending.dueTick - this.world.tick) / ticksPerSecond, label: pending.label },
        };
      }
      const check = host === null ? { ok: false as const, hint: 'One-shot cards are played on The Map' } : canPlay(card.effect, host);
      return { ...base, playState: 'ready', playedAtSeconds: null, playable: check.ok, hint: check.ok ? null : check.hint, pending: null };
    });
  }
}
