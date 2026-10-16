import { BIOME_BY_ID } from '../biomes/content';
import { entranceFrame } from '../maps/frame';
import { GENERATOR_VERSION } from '../maps/recipe';
import { generateMap } from '../maps/generator';
import type { MapEntrance, MapLayout } from '../maps/types';
import { SaveError } from '../save/version';
import { defineScenario } from '../scenarios/content';
import { RUN_STAGE_SCENARIO_ID, type ScenarioDefinition, type ScenarioDifficulty } from '../scenarios/types';
import { RUN_CONDITION_BY_ID, RUN_FAMILY_COPY, RUN_STAGE_DESCRIPTION, combinedConditionRules } from './content';
import type { RunState } from './types';

/**
 * A run's stage (Phase 23): the ScenarioDefinition a level plays under and its generated map. The ruleset layers
 * compile as everywhere else: base -> biome (the map) -> scenario (this definition: level cash + conditions) ->
 * bonuses (the run's grant snapshot, mode `run`) -> cards (the loadout) -> clamps.
 */

const difficultyLabelOf = (levelIndex: number): ScenarioDifficulty => (
  levelIndex <= 0 ? 1 : levelIndex <= 2 ? 2 : levelIndex === 3 ? 3 : 4
);

/**
 * The cash a level starts with: its planned cash minus the debt the stage before it left (one-shot costs still pending
 * when it resolved, design 3.6), never below 0. A pure function of the run, so a restore and rewardEligible agree.
 */
export const levelStartingCashOf = (run: RunState, levelIndex: number): number => {
  const level = run.levels[levelIndex];
  if (!level) throw new RangeError(`the run has no level ${levelIndex + 1}`);
  const debt = levelIndex > 0 ? run.history[levelIndex - 1]?.unpaidDebt ?? 0 : 0;
  return Math.max(0, level.startingCash - debt);
};

/** `entrance` is the generated map's gate (the setup stub starts there); a restore passes the saved map's gate. */
export const stageDefinitionOf = (run: RunState, levelIndex: number, entrance: MapEntrance): ScenarioDefinition => {
  const level = run.levels[levelIndex];
  if (!level) throw new RangeError(`the run has no level ${levelIndex + 1}`);
  const frame = entranceFrame(entrance);
  const conditions = level.conditionIds.flatMap((id) => {
    const condition = RUN_CONDITION_BY_ID.get(id);
    return condition ? [condition] : [];
  });
  const biome = BIOME_BY_ID.get(level.biomeId);
  return defineScenario({
    id: RUN_STAGE_SCENARIO_ID,
    name: `Level ${levelIndex + 1} · ${biome?.name ?? level.biomeId}`,
    tagline: RUN_FAMILY_COPY[level.family].tagline,
    description: RUN_STAGE_DESCRIPTION,
    seed: level.parkSeed,
    timeLimitDays: level.timeLimitDays,
    objective: level.objective,
    constraint: conditions.length === 0
      ? null
      : { name: conditions.map((condition) => condition.name).join(' · '), detail: conditions.map((condition) => condition.detail).join(' ') },
    rules: { startingCash: levelStartingCashOf(run, levelIndex), ...combinedConditionRules(level.conditionIds) },
    setup: { paths: [1, 2, 3].map((depth) => frame.toWorld(0, depth)), objects: [] },
    cardSlots: level.slots,
    difficulty: difficultyLabelOf(levelIndex),
    unlockedBy: { kind: 'always' },
    rewards: { cardDraftChoices: 0, unlocks: [], bonuses: [] },
  });
};

/**
 * The generated map and the definition of a level. A recipe from another generator version cannot be reproduced by
 * this build: that is a `content-mismatch` the app shows (the run ends as abandoned, no loss counted).
 */
export const buildStage = (run: RunState, levelIndex: number): { definition: ScenarioDefinition; layout: MapLayout } => {
  const level = run.levels[levelIndex];
  if (!level) throw new RangeError(`the run has no level ${levelIndex + 1}`);
  if (level.recipe.generatorVersion !== GENERATOR_VERSION) {
    throw new SaveError('content-mismatch', "This run's next park was made by another version of the map generator; start a new run.");
  }
  const { layout } = generateMap(level.recipe);
  return { definition: stageDefinitionOf(run, levelIndex, layout.entrance), layout };
};
