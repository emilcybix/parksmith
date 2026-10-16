import type { BiomeId } from '../biomes/types';
import type { PulseCardId } from '../cards/types';
import type { MapRecipe } from '../maps/types';
import type { ParkRuleset } from '../scenarios/rules';
import type { ObjectiveDefinition } from '../scenarios/types';
import type { ParkGrantState } from '../save/state';

export { RUN_STAGE_SCENARIO_ID, type ParkScenarioId, type RunStageScenarioId } from '../scenarios/types';

/**
 * The Map (Phase 23): run state as plain data. Pure types and constants; the rules live in the sibling modules.
 * Everything is PROVISIONAL balance (BALANCE_NOTES) except the shapes.
 */

/**
 * The save format of a RunState. Bumped when the run's shape changes (with a save migration). Version 2 (Phase 25, save
 * schema 12): the plan key `unplayedOneShots` and, per finished level, `playedCardIds` and `unpaidDebt`.
 */
export const RUN_FORMAT_VERSION = 2;

/**
 * Bumped whenever `planRun` / `createRun` output changes for any (seed, difficulty): a number in GAME_CONFIG.run, a
 * table, a condition, a family copy or the generator. A golden digest pins it (run/determinism.test.ts), like
 * GENERATOR_VERSION. "A seed is the same run" holds within one plan version. Version 2 (Phase 23 balance review): crowd
 * only on levels 1 and 2, spirits holds that grow with the level and the difficulty, level 5 draws visitors or profit.
 * Version 3 (Phase 25): the 48-card pool, rarity, the keyed weighted draw, opposing pairs kept out of offers, the derived
 * dead-card rule. Version 4 (Phase 25 difficulty retune, design 7.1): deadlines and cash per difficulty, Relaxed is the
 * old Standard, Standard and Tough have shorter deadlines and higher targets.
 */
export const RUN_PLAN_VERSION = 4;

export type RunDifficulty = 'relaxed' | 'standard' | 'tough';
export const RUN_DIFFICULTIES: readonly RunDifficulty[] = ['relaxed', 'standard', 'tough'];
export const isRunDifficulty = (value: unknown): value is RunDifficulty => (
  value === 'relaxed' || value === 'standard' || value === 'tough'
);

export const RUN_DIFFICULTY_LABELS: Readonly<Record<RunDifficulty, string>> = {
  relaxed: 'Relaxed',
  standard: 'Standard',
  tough: 'Tough',
};

export type RunPhase = 'offer' | 'loadout' | 'stage' | 'won' | 'lost';
export const RUN_PHASES: readonly RunPhase[] = ['offer', 'loadout', 'stage', 'won', 'lost'];

export type RunConsumeAt = 'stage-start' | 'stage-clear';
/** What happens to a one-shot card left unplayed when its stage resolves: back to the deck, or used up like a stage card. */
export type RunUnplayedOneShots = 'return' | 'consume';
export const RUN_UNPLAYED_ONE_SHOTS: readonly RunUnplayedOneShots[] = ['return', 'consume'];
export type RunOfferRule = { kind: 'all' } | { kind: 'pick'; pick: number };

export type RunObjectiveFamily = 'visitors' | 'profit' | 'crowd' | 'spirits';
export const RUN_OBJECTIVE_FAMILIES: readonly RunObjectiveFamily[] = ['visitors', 'profit', 'crowd', 'spirits'];

export type RunConditionId =
  | 'quiet-season' | 'dusty-gears' | 'big-appetites' | 'thin-wallets' | 'dear-timber'
  | 'slow-service' | 'short-staffed' | 'wet-spell' | 'bin-strike';

export interface RunConditionDefinition {
  id: RunConditionId;
  name: string;
  detail: string;
  icon: string;
  /** Multipliers and/or lockedDefinitionIds only; conditions compose by multiplying into the stage rules. */
  rules: Partial<ParkRuleset>;
  /** 1-based level number from which the condition may be drawn. */
  minLevel: number;
  excludedBiomes: readonly BiomeId[];
  /** Families this condition is never combined with (conflict protection: it would make the objective unreachable). */
  excludedFamilies: readonly RunObjectiveFamily[];
}

export interface RunLevelState {
  /** 0-based; equals the position in `levels`. */
  index: number;
  biomeId: BiomeId;
  /** The accepted recipe (its generatorVersion is recorded). */
  recipe: MapRecipe;
  /** The stage ParkSession seed (guests and weather). */
  parkSeed: number;
  family: RunObjectiveFamily;
  /** id `run-<family>`. */
  objective: ObjectiveDefinition;
  /** A multiple of 0.25, at most 30. */
  timeLimitDays: number;
  startingCash: number;
  conditionIds: RunConditionId[];
  /** Base slots (the grant's extra slot is added at use, see `slotsOf`). */
  slots: number;
  /** Offered before this level, canonical card order. */
  offer: PulseCardId[];
}

export interface RunUsedCard { cardId: PulseCardId; levelIndex: number }

export interface RunLevelResult {
  levelIndex: number;
  outcome: 'succeeded' | 'failed' | 'abandoned';
  /** Park seconds (0 for an abandon outside a stage). */
  atSeconds: number;
  /** ScenarioSimulation's evidence string. */
  evidence: string | null;
  /** The loadout played. */
  cardIds: PulseCardId[];
  /** Run format 2: the one-shots of `cardIds` played in the stage (distinct, loadout order); [] outside a stage. */
  playedCardIds: PulseCardId[];
  /**
   * Run format 2: the deferred one-shot costs still pending when the stage resolved (integer dollars >= 0; 0 outside a
   * stage). They come off the next level's starting cash (stageDefinitionOf); after the last level they are forgiven.
   */
  unpaidDebt: number;
}

/** Run format 1 (save schema 11): no one-shot policy and no plays in the history. Only the 11 -> 12 migration reads it. */
export interface RunStateV1 extends Omit<RunStateV2, 'version' | 'unplayedOneShots' | 'history'> {
  version: 1;
  history: Array<Omit<RunLevelResult, 'playedCardIds' | 'unpaidDebt'>>;
}

export interface RunStateV2 {
  version: 2;
  planVersion: number;
  seed: number;
  difficulty: RunDifficulty;
  consumeAt: RunConsumeAt;
  offerRule: RunOfferRule;
  /** A plan key (GAME_CONFIG.run.unplayedOneShots at run start): unplayed one-shots return to the deck or are used up. */
  unplayedOneShots: RunUnplayedOneShots;
  /** Profile snapshot at run start, mode 'run'. */
  grant: ParkGrantState;
  /** Fixed at run start. */
  levels: RunLevelState[];
  /** Canonical order. */
  starterDeck: PulseCardId[];
  /** The current level (offered / loading / playing / ended on). */
  levelIndex: number;
  /** The level the session's park belongs to. */
  parkLevelIndex: number;
  phase: RunPhase;
  /** A multiset in canonical order (PULSE_CARDS order, copies adjacent). */
  deck: PulseCardId[];
  /** Play order. */
  usedPile: RunUsedCard[];
  /** The cards of the park's level (distinct; [] before the first stage). */
  loadout: PulseCardId[];
  /** Level indices whose offer was accepted, ascending. */
  offersSeen: number[];
  /** One per finished level, ascending. */
  history: RunLevelResult[];
}
export type RunState = RunStateV2;

export interface RunPlanInput { seed: number; difficulty: RunDifficulty }

/** Everything in a run that does not depend on a generated map or on the player: planRun's output. */
export interface RunPlanLevel extends Omit<RunLevelState, 'recipe'> {
  /** The density the level's map is asked for (after the difficulty step). */
  density: 'low' | 'normal' | 'high';
}
export interface RunPlan {
  planVersion: number;
  seed: number;
  difficulty: RunDifficulty;
  consumeAt: RunConsumeAt;
  offerRule: RunOfferRule;
  starterDeck: PulseCardId[];
  levels: RunPlanLevel[];
}

export type RunRefusalReason = 'wrong-phase' | 'not-in-deck' | 'duplicate' | 'too-many' | 'bad-pick' | 'unknown-card';
export type RunRefusal = { ok: false; reason: RunRefusalReason };
export type RunStep = { ok: true; run: RunState } | RunRefusal;

export interface RunSummary {
  /**
   * The run's plan version (Phase 25), so a slot row can tell a run planned by an older build. Written by runSummaryOf;
   * optional because slot metadata written before Phase 25 has none (app/saves/runMeta.ts accepts it as 1..0xffff).
   */
  planVersion?: number;
  seed: number;
  difficulty: RunDifficulty;
  /** 1-based level of the run now (the level offered, loading, playing or ended on). */
  levelNumber: number;
  levelCount: number;
  biomeId: BiomeId;
  phase: RunPhase;
  levelsCleared: number;
}

export type RunLevelStatus = 'cleared' | 'current' | 'ahead' | 'failed' | 'abandoned';

export interface RunSnapshotLevel {
  index: number;
  biomeId: BiomeId;
  biomeName: string;
  biomeIcon: string;
  climateLabel: string;
  family: RunObjectiveFamily;
  objective: ObjectiveDefinition;
  timeLimitDays: number;
  startingCash: number;
  conditions: Array<{ id: RunConditionId; name: string; detail: string; icon: string }>;
  /** Slots including the grant's extra slot. */
  slots: number;
  offer: PulseCardId[];
  status: RunLevelStatus;
  result: RunLevelResult | null;
  recipe: MapRecipe;
}

export interface RunSnapshot {
  seed: number;
  difficulty: RunDifficulty;
  phase: RunPhase;
  levelIndex: number;
  levelCount: number;
  parkLevelIndex: number;
  levels: RunSnapshotLevel[];
  deck: Array<{ cardId: PulseCardId; count: number }>;
  deckSize: number;
  usedPile: RunUsedCard[];
  loadout: PulseCardId[];
  /** Phase 'offer': what accepting adds. */
  pendingOffer: PulseCardId[] | null;
  offerRule: RunOfferRule;
  consumeAt: RunConsumeAt;
  /** Slots for the current level. */
  slotsNow: number;
  outcome: 'won' | 'lost' | null;
  levelsCleared: number;
}

export interface RunOutcome {
  outcome: 'won' | 'lost';
  levelsCleared: number;
  /** Every card that joined the deck over the run (starter and accepted offers), distinct, canonical order. */
  deckCardIds: PulseCardId[];
}
