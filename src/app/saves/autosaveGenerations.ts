import { AUTOSAVE_PREVIOUS_SLOT_ID, AUTOSAVE_SLOT_ID, DEFAULT_AUTOSAVE_NAME, PREVIOUS_AUTOSAVE_LABEL } from './constants';
import type { AutosaveGeneration, AutosaveSlotId, SaveSlotId, SaveSlotMeta } from './types';

/**
 * Phase 31: the one place that knows there are two autosave generations. Every reader that means "the
 * autosave" (SaveManager, crash recovery and Resume, the start screen's Continue and preview, `latestSave`,
 * the run slots) goes through these pure functions, so they all fall back the same way: the newest
 * generation that is readable, else the previous one. Pure and dependency-free (the save worker does not
 * import it, but nothing here would cost it much either).
 */

export const isAutosaveSlotId = (id: unknown): id is AutosaveSlotId => id === AUTOSAVE_SLOT_ID || id === AUTOSAVE_PREVIOUS_SLOT_ID;

/** 'current' for the autosave slot, 'previous' for the generation before it, null for every other slot. */
export const autosaveGeneration = (id: string): AutosaveGeneration | null => (
  id === AUTOSAVE_SLOT_ID ? 'current' : id === AUTOSAVE_PREVIOUS_SLOT_ID ? 'previous' : null
);

export const isPreviousAutosave = (id: string): boolean => id === AUTOSAVE_PREVIOUS_SLOT_ID;

/** A slot that was readable when it was listed; an unreadable record is never offered to continue or resume. */
export const isReadableSlot = (meta: SaveSlotMeta): boolean => meta.status.state === 'ok' && Number.isFinite(meta.savedAt);

export interface AutosaveGenerations {
  current: SaveSlotMeta | null;
  previous: SaveSlotMeta | null;
}

/** The two generation rows as listed, readable or not (null = the slot is empty). */
export const autosaveGenerations = (slots: readonly SaveSlotMeta[]): AutosaveGenerations => ({
  current: slots.find((meta) => meta.id === AUTOSAVE_SLOT_ID) ?? null,
  previous: slots.find((meta) => meta.id === AUTOSAVE_PREVIOUS_SLOT_ID) ?? null,
});

/**
 * The autosave to resume or continue: the current generation when it is readable, else the previous one
 * when IT is readable (the current one is unreadable, or was quarantined away to a manual slot), else
 * null. Never the previous generation while the current one is readable, whatever the clocks say: the
 * current one is by construction the later write.
 */
export const resumableAutosave = (slots: readonly SaveSlotMeta[]): SaveSlotMeta | null => {
  const { current, previous } = autosaveGenerations(slots);
  if (current !== null && isReadableSlot(current)) return current;
  if (previous !== null && isReadableSlot(previous)) return previous;
  return null;
};

/**
 * Every slot a player can continue from: the readable slots, with at most ONE autosave generation (the
 * one `resumableAutosave` picks), so "the latest save" never means an older copy of the park the
 * current autosave already holds. Order is the input's (callers sort).
 */
export const continuableSlots = (slots: readonly SaveSlotMeta[]): SaveSlotMeta[] => {
  const autosave = resumableAutosave(slots);
  return slots.filter((meta) => isReadableSlot(meta) && (!isAutosaveSlotId(meta.id) || meta === autosave));
};

/** What a row, the Continue card or a notice calls an autosave: "Autosave" or "Previous autosave"; a manual save by its name. */
export const autosaveLabel = (meta: Pick<SaveSlotMeta, 'id' | 'name'>): string => {
  const generation = autosaveGeneration(meta.id);
  if (generation === 'previous') return PREVIOUS_AUTOSAVE_LABEL;
  if (generation === 'current') return DEFAULT_AUTOSAVE_NAME;
  return meta.name;
};

/**
 * The name a notice uses for a slot: its own name, except an autosave generation still carrying the default
 * name, which is called by its place ("Autosave", "Previous autosave") so the two never read the same.
 */
export const slotDisplayName = (meta: Pick<SaveSlotMeta, 'id' | 'name'>): string => (
  isAutosaveSlotId(meta.id) && meta.name === DEFAULT_AUTOSAVE_NAME ? autosaveLabel(meta) : meta.name
);

/**
 * The deletion policy (Phase 31, an orchestrator default open for the owner): deleting the autosave
 * deletes BOTH generations, because a player who deletes it wants that park gone, and keeping the previous
 * generation would make Continue bring back an older copy of it. Except when the autosave is unreadable:
 * then only the damaged record goes, and the previous generation stays as the fallback it exists to be.
 * Deleting the previous generation deletes only it. Every other slot deletes only itself. Previous first,
 * so a failure half-way never leaves an older copy behind a deleted newer one.
 */
export const slotsToDelete = (id: SaveSlotId, slots: readonly SaveSlotMeta[]): SaveSlotId[] => {
  if (id !== AUTOSAVE_SLOT_ID) return [id];
  const { current, previous } = autosaveGenerations(slots);
  if (previous === null || current === null || current.status.state !== 'ok') return [id];
  return [AUTOSAVE_PREVIOUS_SLOT_ID, AUTOSAVE_SLOT_ID];
};
