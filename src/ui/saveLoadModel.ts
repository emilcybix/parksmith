import {
  AUTOSAVE_PREVIOUS_SLOT_ID,
  AUTOSAVE_SLOT_ID,
  DEFAULT_AUTOSAVE_NAME,
  MANUAL_SLOT_IDS,
  PREVIOUS_AUTOSAVE_LABEL,
  SAVE_NAME_MAX_LENGTH,
} from '../app/saves/constants';
import { isPreviousAutosave, slotsToDelete } from '../app/saves/autosaveGenerations';
import type {
  PersistenceStatus,
  LoadSummary,
  SaveFailureCode,
  SaveSlotId,
  SaveSlotMeta,
  SavesSnapshot,
  UnreadableCode,
  AutosaveIndicator,
  ManualSaveSlotId,
} from '../app/saves/types';
import { RECOVERY_RECOVERED_SLOT_NAME } from '../app/saves/recoveryTypes';
import { modeLabel, slotModeOf, slotRunOf } from './modeLabels';
import { runRowText } from './runCopy';
import { INPUT_CONTEXT_CAPABILITIES, isRecoveryPromptOpen, type InputContext } from './inputContext';
import type { RecoveryPhase } from '../app/saves/recoveryTypes';

/**
 * Everything the Save / Load dialog, the banner and the autosave indicator decide, kept as plain
 * functions. There is no DOM test library in this project, so a rule that lives in a component
 * is a rule nothing checks; components only render what these return.
 */

// --- Words ------------------------------------------------------------------------------------

/**
 * One sentence per failure code, written for the player: what happened and, where there is one,
 * what to do. A Record over the closed union, so adding a code to the contract fails to compile
 * here until it has words.
 */
const FAILURE_TEXT: Readonly<Record<SaveFailureCode, string>> = {
  unavailable: 'Browser storage is unavailable. Private windows and blocked site data stop saving.',
  blocked: 'Saving is blocked by another Parksmith tab. Close the other tabs and try again.',
  quota: 'Browser storage is full. Delete a save you no longer need and try again.',
  corrupt: 'This save is damaged and cannot be used.',
  'not-found': 'That save no longer exists. It may have been deleted in another tab.',
  conflict: 'Another tab changed this slot. Refresh the list and try again.',
  'unreadable-slot': 'This slot holds a save that cannot be read. Delete it first to free the slot.',
  unknown: 'Something went wrong while saving. Your park is still running.',
  'not-a-save': 'This record is not a Parksmith save.',
  'too-new': 'This save was made by a newer version of Parksmith.',
  'no-migration-path': 'This save is too old for this version of Parksmith.',
  'migration-failed': 'This save could not be upgraded to the current version.',
  'invalid-state': 'This save contains values this version cannot accept.',
  unsynced: 'The park was changing while saving. Try again in a moment.',
  'content-mismatch': 'This save uses content this version of Parksmith does not have.',
  'seal-failed': 'The save could not be prepared. Try again.',
  busy: 'Another save is still in progress. Try again in a moment.',
  deferred: 'The load waits for your answer about the run.',
  'not-ready': 'Saving is not ready yet. Try again in a moment.',
  'no-park': 'There is no park to save yet.',
  'slot-unreadable': 'This slot holds a save that cannot be read. Delete it first to free the slot.',
  'invalid-slot': 'That save slot does not exist.',
  'worker-failed': 'The background saver stopped responding. Try again.',
};

export const describeSaveFailure = (code: SaveFailureCode): string => FAILURE_TEXT[code];

/** Short chip label for an unreadable row; the long reason is the store's own `status.message`. */
const UNREADABLE_LABEL: Readonly<Record<UnreadableCode, string>> = {
  'not-a-save': 'Not a save',
  corrupt: 'Damaged',
  'too-new': 'Newer version',
  'no-migration-path': 'Too old',
  'migration-failed': 'Upgrade failed',
  'invalid-state': 'Invalid data',
  unsynced: 'Damaged',
  'content-mismatch': 'Missing content',
  'record-corrupt': 'Damaged',
  'meta-corrupt': 'Damaged',
  'payload-missing': 'Incomplete',
};

export const describeUnreadableCode = (code: UnreadableCode): string => UNREADABLE_LABEL[code];

// --- Formatting -------------------------------------------------------------------------------

const finiteOr = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

/** Park time, not wall-clock time: "12m 05s" under an hour, "1h 05m" after. */
export const formatPlaytime = (seconds: number): string => {
  const total = Math.max(0, Math.floor(finiteOr(seconds, 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
};

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Under this a save reads as "just now"; seconds-level precision is noise in a list of saves. */
const JUST_NOW_MS = 45 * SECOND_MS;

/**
 * Relative time for the list, with the absolute time on the row's title. `now` is a parameter so
 * the result is deterministic. A save from "the future" (clock changed, other machine) reads as
 * just now rather than as a negative duration.
 */
export const formatLastPlayed = (savedAt: number, now: number): string => {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return 'unknown';
  const elapsed = now - savedAt;
  if (elapsed < JUST_NOW_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.max(1, Math.round(elapsed / MINUTE_MS))} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  if (elapsed < 2 * DAY_MS) return 'yesterday';
  if (elapsed < 30 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)} days ago`;
  return new Date(savedAt).toISOString().slice(0, 10);
};

export const formatCash = (cash: number): string => `$${Math.round(finiteOr(cash, 0)).toLocaleString('en-US')}`;

/**
 * Trims, collapses inner whitespace and cuts to the limit (the contract cuts rather than rejects).
 * Null means "nothing usable": the caller keeps the old name instead of saving an empty one.
 */
export const sanitizeSaveName = (raw: string): string | null => {
  const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, SAVE_NAME_MAX_LENGTH).trim();
  return cleaned.length > 0 ? cleaned : null;
};

// --- Rows -------------------------------------------------------------------------------------

export interface SlotRow {
  slotId: SaveSlotId;
  kind: 'auto' | 'manual';
  /** "Autosave", "Previous autosave" or "Slot 3": the fixed name of the place, whatever the save inside is called. */
  label: string;
  /** Null for an empty slot. */
  meta: SaveSlotMeta | null;
}

const manualLabel = (slotId: ManualSaveSlotId): string => `Slot ${slotId.slice('manual-'.length)}`;

/**
 * Autosave first, then the previous autosave generation when one exists (Phase 31: loadable and deletable,
 * never a save target, and no empty row for it, since nothing can be saved there), then every manual slot
 * in order whether it holds a save or not (an empty slot is where Save goes), then any record with an id
 * this build does not know. The store lists such orphans as unreadable; dropping them here would hide a
 * record the player may want to delete.
 */
export const buildSlotRows = (slots: readonly SaveSlotMeta[]): SlotRow[] => {
  const byId = new Map<string, SaveSlotMeta>();
  for (const meta of slots) byId.set(meta.id, meta);
  const rows: SlotRow[] = [{ slotId: AUTOSAVE_SLOT_ID, kind: 'auto', label: DEFAULT_AUTOSAVE_NAME, meta: byId.get(AUTOSAVE_SLOT_ID) ?? null }];
  const previous = byId.get(AUTOSAVE_PREVIOUS_SLOT_ID);
  if (previous !== undefined) rows.push({ slotId: AUTOSAVE_PREVIOUS_SLOT_ID, kind: 'auto', label: PREVIOUS_AUTOSAVE_LABEL, meta: previous });
  for (const slotId of MANUAL_SLOT_IDS) {
    rows.push({ slotId, kind: 'manual', label: manualLabel(slotId), meta: byId.get(slotId) ?? null });
  }
  const known = new Set<string>(rows.map((row) => row.slotId));
  for (const meta of slots) {
    if (known.has(meta.id)) continue;
    known.add(meta.id);
    rows.push({ slotId: meta.id, kind: meta.kind, label: String(meta.id), meta });
  }
  return rows;
};

/** The mode chip of a readable row ("Sandbox", "Scenario", "The Map"); null for an empty or unreadable slot. */
export const rowModeLabel = (meta: SaveSlotMeta | null): string | null => (
  meta === null || meta.status.state !== 'ok' ? null : modeLabel(slotModeOf(meta))
);

/**
 * The second quiet line of a readable row after the mode chip: "Meadow Garden · Meadow", or for a park on The Map the
 * run it belongs to, "level 3/5 · seed 1234 · Standard" (Phase 23). Null `fallback` parts are the caller's map and biome.
 */
export const rowPlaceText = (meta: SaveSlotMeta, fallback: string): string => {
  const run = slotModeOf(meta) === 'run' ? slotRunOf(meta) : null;
  return run === null ? fallback : runRowText(run);
};

/**
 * The name a row shows: the save's own name, except the autosave (one slot for every mode) which says whose park it
 * holds: "Autosave · Scenario", and the previous generation "Previous autosave · Scenario" (Phase 31). A renamed
 * autosave keeps its name in both generations.
 */
export const rowDisplayName = (row: SlotRow): string => {
  const meta = row.meta;
  if (meta === null) return row.kind === 'auto' ? 'No autosave yet' : `Empty ${row.label.toLowerCase()}`;
  const mode = rowModeLabel(meta);
  if (row.kind !== 'auto' || meta.name !== DEFAULT_AUTOSAVE_NAME) return meta.name;
  const place = isPreviousAutosave(row.slotId) ? PREVIOUS_AUTOSAVE_LABEL : meta.name;
  return mode !== null ? `${place} · ${mode}` : place;
};

/** The short tag at the start of a row: "AUTO", "PREV" for the previous autosave, "SLOT 3". */
export const rowTag = (row: SlotRow): string => (
  isPreviousAutosave(row.slotId) ? 'PREV' : row.kind === 'auto' ? 'AUTO' : row.label.toUpperCase()
);

/**
 * The question before a delete. Deleting the readable autosave also deletes the previous generation
 * (`slotsToDelete`), and the question says so.
 */
export const describeDeleteConfirm = (slotId: SaveSlotId, slots: readonly SaveSlotMeta[]): string => {
  const meta = slots.find((slot) => slot.id === slotId) ?? null;
  const name = meta === null ? 'this slot' : isPreviousAutosave(slotId) && meta.name === DEFAULT_AUTOSAVE_NAME ? PREVIOUS_AUTOSAVE_LABEL : meta.name;
  if (meta !== null && isUnreadable(meta)) return `Delete ${name}? The damaged record is removed for good.`;
  return slotsToDelete(slotId, slots).length > 1
    ? `Delete ${name} and the previous autosave? This cannot be undone.`
    : `Delete ${name}? This cannot be undone.`;
};

export const isManualSlotId = (id: SaveSlotId): id is ManualSaveSlotId => (MANUAL_SLOT_IDS as readonly string[]).includes(id);

export const isUnreadable = (meta: SaveSlotMeta | null): boolean => meta !== null && meta.status.state === 'unreadable';

export interface RowActions {
  canSave: boolean;
  saveHint: string;
  showSave: boolean;
  canLoad: boolean;
  loadHint: string;
  showRename: boolean;
  canRename: boolean;
  canDelete: boolean;
}

export interface RowContext {
  /** Any save, load, rename or delete in flight: the manager serializes them, so the buttons wait too. */
  busy: boolean;
  persistenceUnavailable: boolean;
}

/**
 * What a row offers. Unreadable rows offer Delete and nothing else: Save is disabled (the manager
 * would refuse anyway) so a damaged record is never overwritten by a mis-click, and Load would
 * only fail again.
 */
export const rowActions = (row: SlotRow, context: RowContext): RowActions => {
  const meta = row.meta;
  const unreadable = isUnreadable(meta);
  const showSave = row.kind === 'manual';
  let saveHint = `Save the current park to ${row.label}`;
  let canSave = showSave && !context.busy;
  if (unreadable) {
    canSave = false;
    saveHint = 'This slot holds a save that cannot be read. Delete it before saving here.';
  } else if (context.persistenceUnavailable) {
    canSave = false;
    saveHint = 'Saving is unavailable right now';
  } else if (meta !== null) {
    saveHint = `Replace ${meta.name} with the current park`;
  }
  const canLoad = meta !== null && !unreadable && !context.busy;
  return {
    showSave,
    canSave,
    saveHint,
    canLoad,
    loadHint: unreadable ? 'This save cannot be read' : meta === null ? 'Nothing saved here' : `Load ${meta.name}`,
    showRename: row.kind === 'manual' && meta !== null && !unreadable,
    canRename: !context.busy,
    canDelete: meta !== null && !context.busy,
  };
};

// --- Inline confirmations ---------------------------------------------------------------------

/**
 * One inline interaction at a time. Confirmations live in the row, not in nested modals: a modal
 * on a modal has its own Escape and focus rules, and the project already had three bugs from
 * exactly that.
 */
export type RowInteraction =
  | { kind: 'none' }
  | { kind: 'confirm-overwrite'; slotId: SaveSlotId }
  | { kind: 'confirm-delete'; slotId: SaveSlotId }
  | { kind: 'confirm-load'; slotId: SaveSlotId }
  | { kind: 'rename'; slotId: SaveSlotId; draft: string };

export type InteractionAction =
  | { type: 'confirm-overwrite'; slotId: SaveSlotId }
  | { type: 'confirm-delete'; slotId: SaveSlotId }
  | { type: 'confirm-load'; slotId: SaveSlotId }
  | { type: 'rename-start'; slotId: SaveSlotId; name: string }
  | { type: 'rename-edit'; draft: string }
  | { type: 'cancel' }
  /** The slot list changed under the dialog: drop an interaction whose slot is gone. */
  | { type: 'slots-changed'; slots: readonly SaveSlotMeta[] };

export const NO_INTERACTION: RowInteraction = { kind: 'none' };

export const interactionReducer = (state: RowInteraction, action: InteractionAction): RowInteraction => {
  switch (action.type) {
    case 'confirm-overwrite':
    case 'confirm-delete':
    case 'confirm-load':
      return { kind: action.type, slotId: action.slotId };
    case 'rename-start':
      return { kind: 'rename', slotId: action.slotId, draft: action.name.slice(0, SAVE_NAME_MAX_LENGTH) };
    case 'rename-edit':
      return state.kind === 'rename' ? { ...state, draft: action.draft.slice(0, SAVE_NAME_MAX_LENGTH) } : state;
    case 'cancel':
      return NO_INTERACTION;
    case 'slots-changed': {
      if (state.kind === 'none') return state;
      const slotId = state.slotId;
      // Overwrite targets may be empty slots turned occupied, but never an interaction on a slot
      // that vanished: a delete or load confirmation on nothing would act on the wrong save.
      return action.slots.some((meta) => meta.id === slotId) ? state : NO_INTERACTION;
    }
  }
};

/** Escape peels one layer: an open inline interaction first, the dialog only when none is open. */
export const escapeStep = (state: RowInteraction): 'cancel-interaction' | 'close-dialog' => (
  state.kind === 'none' ? 'close-dialog' : 'cancel-interaction'
);

export type SavePlan = 'blocked' | 'save-now' | 'confirm-overwrite';

/** An empty slot saves at once; an occupied one asks first; an unreadable one never saves. */
export const planSave = (row: SlotRow): SavePlan => {
  if (isUnreadable(row.meta)) return 'blocked';
  return row.meta === null ? 'save-now' : 'confirm-overwrite';
};

export type LoadPlan = 'blocked' | 'load-now' | 'confirm-load';

/** Loading replaces the live park, so unsaved changes get a question; a clean park does not. */
export const planLoad = (row: SlotRow, unsavedChanges: boolean): LoadPlan => {
  if (row.meta === null || isUnreadable(row.meta)) return 'blocked';
  return unsavedChanges ? 'confirm-load' : 'load-now';
};

/** Slot-name outcome of a rename commit: null means "no call": empty or unchanged. */
export const planRename = (draft: string, currentName: string): string | null => {
  const name = sanitizeSaveName(draft);
  return name === null || name === currentName ? null : name;
};

/** The toast after a successful load. Older or newer balance is worth a word: the park may play differently. */
export const describeLoadResult = (summary: Pick<LoadSummary, 'name' | 'contentDrift'>): string => {
  if (summary.contentDrift === 'older') return `Loaded ${summary.name}. It was saved under an older balance.`;
  if (summary.contentDrift === 'newer') return `Loaded ${summary.name}. It was saved under a newer balance.`;
  return `Loaded ${summary.name}`;
};

// --- Banner, indicator, notices ---------------------------------------------------------------

const PERSISTENCE_REASON: Readonly<Record<'unavailable' | 'blocked' | 'quota', string>> = {
  unavailable: 'private or blocked browser storage',
  blocked: 'close other Parksmith tabs',
  quota: 'storage is full: delete a save in Save / Load',
};

export interface BannerModel {
  message: string;
  /** Only the dialog's own copy ignores dismissal; the page banner honours it. */
  canRetry: boolean;
}

/**
 * The persistence-unavailable banner. Null while persistence is fine, still being checked (the
 * first moment must not flash a failure), or dismissed. The reason is mapped from the code, not
 * from the raw message, which can be a browser's internal DOMException text.
 */
export const describePersistenceBanner = (persistence: PersistenceStatus, ignoreDismissal = false): BannerModel | null => {
  if (persistence.state !== 'unavailable') return null;
  if (persistence.bannerDismissed && !ignoreDismissal) return null;
  const reason = persistence.code === null ? 'storage error' : PERSISTENCE_REASON[persistence.code];
  return {
    message: `Saving is unavailable (${reason}). Your park keeps running, but progress will not be saved.`,
    canRetry: true,
  };
};

export interface AutosavePauseModel {
  cause: 'unreadable-slot' | 'other-tab';
  message: string;
}

/**
 * Autosave is suspended for two reasons the snapshot does not distinguish: the autosave slot holds
 * an unreadable record, or another tab took it over. The slot list can tell them apart, which
 * decides the action: delete the record, or take the slot back.
 */
export const describeAutosavePause = (saves: SavesSnapshot, recoveryPhase: RecoveryPhase = 'idle'): AutosavePauseModel | null => {
  // A hold for the recovery prompt is not a fault the player can fix here; it has its own words.
  if (isRecoveryPromptOpen(recoveryPhase)) return null;
  if (saves.autosave.state !== 'suspended' || saves.persistence.state === 'unavailable') return null;
  const autosave = saves.slots.find((slot) => slot.id === AUTOSAVE_SLOT_ID);
  if (isUnreadable(autosave ?? null)) {
    return {
      cause: 'unreadable-slot',
      message: 'Autosave paused: the autosave slot holds an unreadable save. Delete it in Save / Load to resume.',
    };
  }
  return {
    cause: 'other-tab',
    message: 'Autosave paused: another Parksmith tab is saving over the autosave slot.',
  };
};

/**
 * The autosave line of the dialog footer. While the recovery prompt is unresolved autosave is held
 * so the old autosave cannot be overwritten; saying so keeps "Autosave is paused" from reading
 * as a fault. Not a banner: the prompt itself already explains it.
 */
export const describeAutosaveFooter = (state: SavesSnapshot['autosave']['state'], recoveryPhase: RecoveryPhase): string => {
  if (isRecoveryPromptOpen(recoveryPhase)) return 'Autosave is held until you decide about the interrupted park.';
  return state === 'off' ? 'Autosave is off.' : state === 'suspended' ? 'Autosave is paused.' : 'Autosave is on.';
};

/**
 * The manual slot "Not now" fills with the interrupted park's autosave. Matched by name because
 * that is all the store records (the player may rename it, which ends the hint, as it should).
 */
export const isRecoveredSlot = (row: Pick<SlotRow, 'kind' | 'meta'>): boolean => (
  row.kind === 'manual' && row.meta !== null && row.meta.name === RECOVERY_RECOVERED_SLOT_NAME
);

/** "Saving…" is held back this long so a save that finishes in a blink does not flicker. */
export const SAVING_INDICATOR_DELAY_MS = 400;

export const indicatorLabel = (indicator: AutosaveIndicator): string => {
  switch (indicator) {
    case 'saving': return 'Saving…';
    case 'saved': return 'Autosaved';
    case 'failed': return 'Autosave failed';
    case 'hidden': return '';
  }
};

/** How long to wait before showing an indicator: only a save in flight is held back. */
export const indicatorDelayMs = (indicator: AutosaveIndicator): number => (
  indicator === 'saving' ? SAVING_INDICATOR_DELAY_MS : 0
);

// --- Keyboard ---------------------------------------------------------------------------------

export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

export type QuickSaveShortcut = 'ignore' | 'suppress' | 'quick-save' | 'open-dialog';

/**
 * Ctrl+S / Cmd+S. The browser's Save Page dialog must never open over the game, so the combination
 * is always swallowed, except in a text field where the player is typing. It saves only where a
 * park is being played (the layers that keep view input); behind a modal it is swallowed and does
 * nothing, and a held key does not hammer the store.
 */
export const planQuickSaveShortcut = (
  event: ShortcutKey,
  context: InputContext,
  quickSaveSlotId: ManualSaveSlotId | null,
): QuickSaveShortcut => {
  if (event.key.toLowerCase() !== 's') return 'ignore';
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return 'ignore';
  if (context === 'textInput') return 'ignore';
  if (event.repeat || !INPUT_CONTEXT_CAPABILITIES[context].view) return 'suppress';
  return quickSaveSlotId === null ? 'open-dialog' : 'quick-save';
};
