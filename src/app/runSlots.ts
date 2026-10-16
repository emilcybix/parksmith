import type { SaveSlotMeta } from './saves/types';
import { slotMode } from './saves/mapMeta';
import { autosaveGenerations, continuableSlots } from './saves/autosaveGenerations';

/** A run that can still be continued: a readable save of mode `run` whose run has not ended. */
export const isContinuableRunSlot = (meta: SaveSlotMeta): boolean => (
  meta.status.state === 'ok'
  && slotMode(meta) === 'run'
  && meta.run !== undefined
  && meta.run.phase !== 'won'
  && meta.run.phase !== 'lost'
);

/**
 * The run a new park would destroy from the start screen: the autosave is the one slot every new park writes, so a run in
 * progress that only it holds is at stake. Phase 31: either autosave generation (the current one first), because a new
 * park's first autosave rotates the current one into the previous slot and pushes the previous one out. Null when no
 * autosave generation holds an unfinished run, or when `loadSlotId` is that autosave itself or another save of the same
 * run (same seed and difficulty): continuing the run is not leaving it.
 */
export const autosavedRunAtStake = (slots: readonly SaveSlotMeta[], loadSlotId?: string): SaveSlotMeta | null => {
  const { current, previous } = autosaveGenerations(slots);
  const autosave = [current, previous].find((meta) => meta !== null && isContinuableRunSlot(meta)) ?? null;
  if (autosave === null || autosave.run === undefined) return null;
  if (loadSlotId === undefined) return autosave;
  if (loadSlotId === autosave.id) return null;
  const target = slots.find((meta) => meta.id === loadSlotId);
  if (target?.run !== undefined && target.run.seed === autosave.run.seed && target.run.difficulty === autosave.run.difficulty) return null;
  return autosave;
};

/**
 * "Continue run": the newest readable save of mode `run` that holds a run in progress (the autosave wins a tie, since it is
 * the one the game keeps current). A finished run is not continued; its result screen is the end.
 */
export const latestRunSlot = (slots: readonly SaveSlotMeta[]): SaveSlotMeta | null => {
  let best: SaveSlotMeta | null = null;
  // Phase 31: one autosave generation at most, the newest readable one (`continuableSlots`).
  for (const meta of continuableSlots(slots)) {
    if (!isContinuableRunSlot(meta)) continue;
    if (best === null || meta.savedAt > best.savedAt || (meta.savedAt === best.savedAt && meta.kind === 'auto' && best.kind !== 'auto')) best = meta;
  }
  return best;
};
