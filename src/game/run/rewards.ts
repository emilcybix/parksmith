import { PULSE_CARDS } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { RUN_PLAN_VERSION, type RunOutcome, type RunState } from './types';
import { createRun, plannedPartHash } from './deck';

/** The end of a run as the profile sees it, or null while the run goes on. */
export const runOutcomeOf = (run: RunState): RunOutcome | null => {
  if (run.phase !== 'won' && run.phase !== 'lost') return null;
  const held = new Set<PulseCardId>([...run.deck, ...run.usedPile.map((used) => used.cardId), ...run.starterDeck]);
  return {
    outcome: run.phase,
    levelsCleared: run.history.filter((entry) => entry.outcome === 'succeeded').length,
    deckCardIds: PULSE_CARDS.map((card) => card.id).filter((id) => held.has(id)),
  };
};

/**
 * "Never trust a save for profile rewards": a run earns rewards only when its planned part is exactly what this build
 * plans for (seed, difficulty): the levels, the maps, the objectives, the conditions, the starter deck, the offers and
 * the rules of the run. A hand-edited run (an easier target, a longer deadline) plays but is never rewarded.
 */
export const runRewardEligible = (run: RunState): boolean => {
  try {
    if (run.planVersion !== RUN_PLAN_VERSION) return false;
    const canonical = createRun({ seed: run.seed, difficulty: run.difficulty, grant: run.grant });
    return plannedPartHash(canonical) === plannedPartHash(run);
  } catch {
    return false;
  }
};
