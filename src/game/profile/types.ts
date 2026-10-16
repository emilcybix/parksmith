import type { PulseCardId } from '../cards/types';
import type { GameMode } from '../modes/types';
import type { RunDifficulty } from '../run/types';
import type { ScenarioId } from '../scenarios/types';
import type { TourNodeId } from '../tour/types';
import type { BonusId } from './bonuses';

export const PROFILE_VERSION = 2;

/** Why and how a scenario was first cleared. */
export type FirstClearVia = 'scenario' | 'run' | 'tour-conversion';

export interface ScenarioRecord {
  clears: number;
  attempts: number;
  /** Fastest clear in park seconds; null = cleared before records existed (the Park Tour conversion). */
  bestClearSeconds: number | null;
  /** Best objective progress 0..100 of any attempt (100 once cleared). */
  bestProgressPercent: number;
  firstClearVia: FirstClearVia | null;
}

export interface ModeStats {
  parksStarted: number;
  wins: number;
  losses: number;
}

/** A one-time message the menu shows (cleared by `dismissNotice`). */
export interface ProfileNotice {
  kind: 'tour-converted';
  clearedScenarioIds: ScenarioId[];
  bonusIds: BonusId[];
  unlockedBuildingIds: string[];
}

export interface ProfileTourSlice {
  ownedCardIds: PulseCardId[];
  unlockedNodeIds: TourNodeId[];
  completedNodeIds: TourNodeId[];
  /** Bumped by a tour reset so a reset made in one tab wins over another tab's older progress. */
  epoch: number;
}

export interface ProfileUiFlags {
  /** Legacy (Phase 23): the Parks map was opened for the player once on a first run. Kept and merged, never read. */
  mapSeen: boolean;
  /** The one-time "Ready for The Map?" offer (formerly the Park Tour offer) has been shown once in Park Pulse. */
  tourOffered: boolean;
}

/** The Map's run statistics (Phase 23). Optional on disk: absent reads as zeros. */
export interface ProfileRunsSlice {
  started: number;
  victories: Record<RunDifficulty, number>;
  losses: Record<RunDifficulty, number>;
  /** Levels cleared in the best run, 0..levelCount, per difficulty. */
  bestLevel: Record<RunDifficulty, number>;
  /** The last 32 recorded run keys: a run result is recorded once. */
  recentRunKeys: string[];
}

/** The persisted profile (`parksmith-profile`). Everything is keyed by stable ids; unknown ids are dropped on read. */
export interface ProfileV2 {
  version: 2;
  /** Cards ever earned (as v1). */
  discoveredCardIds: PulseCardId[];
  /** The Park Tour route and its card collection (as v1, plus `epoch`). */
  tour: ProfileTourSlice;
  ui: ProfileUiFlags;
  scenarios: Partial<Record<ScenarioId, ScenarioRecord>>;
  /** Profile-gated catalog ids; catalog order. */
  unlockedBuildingIds: string[];
  /** Earned permanent bonuses; canonical order. Never lost. */
  bonusIds: BonusId[];
  useBonuses: Record<GameMode, boolean>;
  stats: Record<GameMode, ModeStats>;
  notice: ProfileNotice | null;
  /** Serialized after `notice`. */
  runs: ProfileRunsSlice;
}

export type ProfilePersistence = 'ok' | 'unavailable' | 'read-only';

export interface ProfileSnapshot {
  /** Bumps on every change (a UI memo key). */
  revision: number;
  persistence: ProfilePersistence;
  clearedScenarioIds: ScenarioId[];
  records: Partial<Record<ScenarioId, ScenarioRecord>>;
  unlockedBuildingIds: string[];
  /** STARTING_CARD_IDS plus discovered: the Scenario-mode loadout pool. */
  collectionCardIds: PulseCardId[];
  discoveredCardIds: PulseCardId[];
  bonusIds: BonusId[];
  useBonuses: Record<GameMode, boolean>;
  stats: Record<GameMode, ModeStats>;
  notice: ProfileNotice | null;
  runs: ProfileRunsSlice;
}

export interface ScenarioResultInput {
  scenarioId: ScenarioId;
  mode: 'scenario' | 'run';
  outcome: 'succeeded' | 'failed';
  atSeconds: number;
  progressPercent: number;
}

export interface ScenarioRewardResult {
  scenarioId: ScenarioId;
  outcome: 'succeeded' | 'failed';
  firstClear: boolean;
  newlyUnlockedBuildingIds: string[];
  newlyEarnedBonusIds: BonusId[];
  newlyAvailableScenarioIds: ScenarioId[];
  /** Previous best clear time (null if none) and whether this run beat it. */
  previousBestSeconds: number | null;
  newBest: boolean;
  /** false when the reward re-verification refused (a hand-edited park): nothing was granted. */
  eligible: boolean;
}

export interface RunResultInput {
  /** `runKeyOf(run)`: the idempotency key. */
  runKey: string;
  difficulty: RunDifficulty;
  outcome: 'won' | 'lost';
  /** Levels cleared, 0..levelCount. */
  levelsCleared: number;
  /** Every card that joined the run's deck. */
  deckCardIds: PulseCardId[];
}

export interface RunRewardResult {
  /** false when the run was not eligible (a hand-edited run): nothing but the start was counted. */
  eligible: boolean;
  /** This run key was recorded before: nothing changed now. */
  alreadyRecorded: boolean;
  outcome: 'won' | 'lost';
  /** Cards of the deck that were not in the collection before (a victory only). */
  newlyDiscoveredCardIds: PulseCardId[];
  newlyUnlockedDifficulties: RunDifficulty[];
  newBestLevel: boolean;
  previousBestLevel: number;
  bestLevel: number;
}
