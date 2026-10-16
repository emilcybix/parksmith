import { BIOME_BY_ID } from '../biomes/content';
import { deckCounts, slotsOf } from './deck';
import { RUN_BIOME_ICON, RUN_CONDITION_BY_ID } from './content';
import type { RunLevelStatus, RunSnapshot, RunState } from './types';

/** Structured UI data for a run: names, icons and numbers, never prose beyond what the content tables hold. */
export const runSnapshotOf = (run: RunState): RunSnapshot => {
  const levelsCleared = run.history.filter((entry) => entry.outcome === 'succeeded').length;
  return {
    seed: run.seed,
    difficulty: run.difficulty,
    phase: run.phase,
    levelIndex: run.levelIndex,
    levelCount: run.levels.length,
    parkLevelIndex: run.parkLevelIndex,
    levels: run.levels.map((level) => {
      const result = run.history[level.index] ?? null;
      let status: RunLevelStatus;
      if (result) status = result.outcome === 'succeeded' ? 'cleared' : result.outcome === 'failed' ? 'failed' : 'abandoned';
      else status = level.index === run.levelIndex && run.phase !== 'won' ? 'current' : 'ahead';
      const biome = BIOME_BY_ID.get(level.biomeId);
      return {
        index: level.index,
        biomeId: level.biomeId,
        biomeName: biome?.name ?? level.biomeId,
        biomeIcon: RUN_BIOME_ICON[level.biomeId],
        climateLabel: biome?.climateLabel ?? '',
        family: level.family,
        objective: structuredClone(level.objective),
        timeLimitDays: level.timeLimitDays,
        startingCash: level.startingCash,
        conditions: level.conditionIds.flatMap((id) => {
          const condition = RUN_CONDITION_BY_ID.get(id);
          return condition ? [{ id, name: condition.name, detail: condition.detail, icon: condition.icon }] : [];
        }),
        slots: slotsOf(run, level.index),
        offer: [...level.offer],
        status,
        result: result ? structuredClone(result) : null,
        recipe: { ...level.recipe },
      };
    }),
    deck: deckCounts(run.deck),
    deckSize: run.deck.length,
    usedPile: run.usedPile.map((used) => ({ ...used })),
    loadout: [...run.loadout],
    pendingOffer: run.phase === 'offer' ? [...(run.levels[run.levelIndex]?.offer ?? [])] : null,
    offerRule: { ...run.offerRule },
    consumeAt: run.consumeAt,
    slotsNow: slotsOf(run),
    outcome: run.phase === 'won' ? 'won' : run.phase === 'lost' ? 'lost' : null,
    levelsCleared,
  };
};
