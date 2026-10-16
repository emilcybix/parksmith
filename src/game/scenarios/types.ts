import type { MapId } from '../maps/types';
import type { BonusId } from '../profile/bonuses';
import type { Cell } from '../types';
import type { ParkRuleset } from './rules';

export type ScenarioId =
  | 'sunny-start'
  | 'penny-lane'
  | 'garden-gala'
  | 'starlight-finale'
  | 'boardwalk-breeze'
  | 'canyon-caravan'
  | 'frost-fair'
  | 'ruins-rush'
  | 'harvest-festival'
  /** Phase 21: the first estate scenario (Meadow Estate, own land). */
  | 'room-to-grow';

/** The one scenario id every stage of a run carries (ScenarioDefinition.id, ScenarioState.scenarioId, save.scenarioId). */
export const RUN_STAGE_SCENARIO_ID = 'the-map-stage' as const;
export type RunStageScenarioId = typeof RUN_STAGE_SCENARIO_ID;
/** The id a park's scenario may carry: a shipped scenario or the generated stage of a run (Phase 23). */
export type ParkScenarioId = ScenarioId | RunStageScenarioId;

/** How hard a scenario is meant to be (a label for the browser; it changes no rule). */
export type ScenarioDifficulty = 1 | 2 | 3 | 4;

export const SCENARIO_DIFFICULTY_LABELS: Readonly<Record<ScenarioDifficulty, string>> = {
  1: 'Relaxed',
  2: 'Steady',
  3: 'Tricky',
  4: 'Tough',
};

/**
 * When a scenario is playable in Scenario mode. Only scenario clears: never a card, a bonus or a building
 * (the "no requirement" rule; a test walks the graph from a fresh profile).
 */
export type ScenarioUnlockCondition =
  | { kind: 'always' }
  | { kind: 'clear-any'; scenarioIds: readonly ScenarioId[] };

/** What the first clear of a scenario grants for good. */
export interface ScenarioRewards {
  /** Reward card choices offered after clearing the park (Phase 8B/8C). */
  cardDraftChoices: number;
  /** Profile-gated catalog ids granted on the first clear. */
  unlocks: readonly string[];
  /** Permanent bonuses granted on the first clear. */
  bonuses: readonly BonusId[];
}

/** Metrics objectives can evaluate. All come from simulation or management state, never UI text. */
export type ObjectiveMetric =
  | 'cumulativeGuests'
  | 'guestCount'
  | 'parkRating'
  | 'averageHappiness'
  | 'operatingProfit'
  | 'averageQueueSeconds'
  /** Phase 21: parcels of land the park owns (fed only on a map with restricted land). */
  | 'ownedParcels';

export type ObjectiveComparison = 'atLeast' | 'atMost';

interface ObjectiveBase {
  id: string;
  name: string;
  metric: ObjectiveMetric;
  target: number;
}

export type ObjectiveDefinition =
  /** Succeeds the moment an instantaneous metric reaches the target. */
  | (ObjectiveBase & { kind: 'reach' })
  /** Succeeds when an accumulating metric (visitors, profit) reaches the target. */
  | (ObjectiveBase & { kind: 'earn' })
  /** Succeeds after the metric satisfies the comparison continuously for the duration. */
  | (ObjectiveBase & { kind: 'sustain'; comparison: ObjectiveComparison; durationSeconds: number });

export interface ScenarioConstraintCopy {
  name: string;
  detail: string;
}

export interface ScenarioSetup {
  paths: readonly Cell[];
  objects: readonly { definitionId: string; anchor: Cell }[];
}

export interface ScenarioDefinition {
  id: ParkScenarioId;
  name: string;
  tagline: string;
  description: string;
  seed: number;
  /** The map this scenario is played on (Phase 24); absent = the Meadow Garden, today's park. The map sets the size. */
  mapId?: MapId;
  /**
   * Phase 21: the land the park starts with, overriding the map's own `ownedArea` (null = the whole map; a parcel-aligned
   * inclusive rectangle containing the gate). Absent = the map's.
   */
  ownedArea?: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } | null;
  /** The one canonical deadline; the simulation counts seconds. */
  timeLimitSeconds: number;
  /** Set only when the author wrote the deadline in days (see defineScenario); timeLimitSeconds is derived from it. */
  timeLimitDays?: number;
  objective: ObjectiveDefinition;
  /** Display copy for the mechanical condition carried by `rules`. Never parsed by logic. */
  constraint: ScenarioConstraintCopy | null;
  rules: Partial<ParkRuleset>;
  setup: ScenarioSetup;
  /** Pulse Card slots this scenario allows (Phase 8B). */
  cardSlots: number;
  /** Label for the scenario browser (Phase 22). */
  difficulty: ScenarioDifficulty;
  /** When the scenario opens in Scenario mode (Phase 22). */
  unlockedBy: ScenarioUnlockCondition;
  /** Card draft size and the lasting rewards of the first clear. */
  rewards: ScenarioRewards;
}

/** A scenario that ships in the browser: its id is one of the nine, never the run stage's. */
export type ShippedScenarioDefinition = ScenarioDefinition & { id: ScenarioId };

export type ScenarioStatus = 'running' | 'succeeded' | 'failed';

export interface ScenarioMetrics {
  cumulativeGuests: number;
  guestCount: number;
  parkRating: number;
  averageHappiness: number | null;
  operatingProfit: number;
  averageQueueSeconds: number;
  /** Phase 21: present only when the park's land is restricted (so every older scenario save keeps its exact metrics). */
  ownedParcels?: number;
}

export interface ObjectiveProgressSnapshot {
  id: string;
  name: string;
  kind: ObjectiveDefinition['kind'];
  metric: ObjectiveMetric;
  comparison: ObjectiveComparison;
  target: number;
  current: number | null;
  progressPercent: number;
  sustainedSeconds: number;
  requiredSustainSeconds: number;
  longestSustainedSeconds: number;
  /** Linear projection of the final value at the deadline; null before evidence exists. */
  projectedValue: number | null;
  onPace: boolean;
}

export interface ScenarioSnapshot {
  scenarioId: ParkScenarioId;
  name: string;
  status: ScenarioStatus;
  elapsedSeconds: number;
  timeLimitSeconds: number;
  /** The deadline in days when the scenario is written in days, else null. */
  timeLimitDays: number | null;
  remainingSeconds: number;
  /** Time left in park days (one decimal) at the fixed scenario day length. */
  remainingDays: number;
  objective: ObjectiveProgressSnapshot;
  constraint: ScenarioConstraintCopy | null;
  lockedDefinitionIds: string[];
  cardSlots: number;
  seed: number;
  completedAtSeconds: number | null;
  /** Exact numeric evidence for the final result; null while running. */
  resultEvidence: string | null;
}

export interface ScenarioEvent {
  kind: 'scenarioSucceeded' | 'scenarioFailed';
  scenarioId: ParkScenarioId;
  atSeconds: number;
  evidence: string;
}

/** Simulation-facing labels used to build evidence strings. UI keeps its own richer copy. */
export const METRIC_LABELS: Readonly<Record<ObjectiveMetric, string>> = {
  cumulativeGuests: 'total visitors',
  guestCount: 'guests in the park',
  parkRating: 'park rating',
  averageHappiness: 'average happiness',
  operatingProfit: 'operating profit',
  averageQueueSeconds: 'average queue seconds',
  ownedParcels: 'parcels of land owned',
};
