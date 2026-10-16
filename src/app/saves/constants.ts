import type { ManualSaveSlotId } from './types';

/**
 * Every tunable of the save layer in one place, so a balance or UX decision ("autosave every two
 * minutes", "ten manual slots") is a one-line change that tests and the UI can both import.
 * Real-time values are wall-clock seconds measured from frame deltas, never simulation time: an
 * autosave interval that stretched with game speed would save a 3x park every 40 real seconds.
 */

// --- Slots ------------------------------------------------------------------------------------

/** The rolling autosave slot: the newest autosave generation. */
export const AUTOSAVE_SLOT_ID = 'autosave';

/**
 * Phase 31: the previous autosave generation. Every autosave write moves the current autosave here in
 * the same transaction, so a bad write can cost at most one generation. Read-only for the player:
 * listed and loadable as 'Previous autosave', never a manual or quick-save target.
 */
export const AUTOSAVE_PREVIOUS_SLOT_ID = 'autosave-previous';

/** Both autosave generations, newest first: the order every reader falls back in. */
export const AUTOSAVE_SLOT_IDS = [AUTOSAVE_SLOT_ID, AUTOSAVE_PREVIOUS_SLOT_ID] as const;

/** What the Save / Load dialog, Continue and the recovery offer call the previous generation. */
export const PREVIOUS_AUTOSAVE_LABEL = 'Previous autosave';

/** All manual slot ids in display order; length equals MAX_MANUAL_SLOTS (a test asserts it). */
export const MANUAL_SLOT_IDS: readonly ManualSaveSlotId[] = [
  'manual-1', 'manual-2', 'manual-3', 'manual-4', 'manual-5',
  'manual-6', 'manual-7', 'manual-8', 'manual-9', 'manual-10',
];

/** How many manual slots exist: manual-1 .. manual-N. Growing this is a UI-only change. */
export const MAX_MANUAL_SLOTS = 10;

/** Longest accepted slot name after trimming; longer input is cut, not rejected. */
export const SAVE_NAME_MAX_LENGTH = 40;

export const DEFAULT_AUTOSAVE_NAME = 'Autosave';
export const DEFAULT_SANDBOX_NAME = 'Sandbox park';

// --- Autosave cadence (real-time) -------------------------------------------------------------

/** While the park runs and has changed, an autosave is due this often. */
export const AUTOSAVE_INTERVAL_SECONDS = 120;

/**
 * Floor between two AUTOSAVE writes, whatever triggered them (interval, safe point, hide). Manual
 * saves ignore it: a player pressing Ctrl+S twice means it.
 */
export const AUTOSAVE_MIN_GAP_SECONDS = 20;

/**
 * Park start is a safe point, but it is deliberately not instantaneous: starting a new park would
 * otherwise overwrite the autosave of the previous one within the same frame, leaving no time to
 * notice a misclick and press Load. This long after start (or after loading) the first autosave
 * is due, as soon as the park is dirty.
 */
export const START_AUTOSAVE_DELAY_SECONDS = 15;

/** A hidden tab is autosaved if dirty, at most this often (visibilitychange fires on every switch). */
export const HIDDEN_AUTOSAVE_MIN_GAP_SECONDS = 5;

/**
 * "Unsaved changes" for the load confirmation: world edits always count; pure simulation progress
 * counts only past this many simulated seconds since the last successful save to ANY slot. Without
 * a grace the flag would be true ten times a second in a running park and the confirmation would
 * be noise.
 */
export const UNSAVED_PROGRESS_SIMULATED_SECONDS = 30;

// --- Off-frame work ---------------------------------------------------------------------------

/** requestIdleCallback timeout of the no-worker fallback: save at the latest this long after asking. */
export const IDLE_TIMEOUT_MS = 2_000;

/** A persist job the worker has not answered in this long is declared failed and the writer replaced. */
export const WORKER_JOB_TIMEOUT_MS = 30_000;

/**
 * Budget for the main-thread part of a save (serialize + postMessage structured clone), measured
 * in the real-browser check. Above it the contract says report, do not silently ship a hitch.
 */
export const MAIN_THREAD_SAVE_BUDGET_MS = 8;

// --- UI timings -------------------------------------------------------------------------------

/** How long the "Autosaved" indicator stays visible. */
export const AUTOSAVE_INDICATOR_VISIBLE_MS = 2_500;

/** How long a save/load/delete notice (toast) stays visible. */
export const SAVE_NOTICE_VISIBLE_MS = 4_000;

// --- IndexedDB --------------------------------------------------------------------------------

export const SAVE_DB_NAME = 'parksmith-saves';
/** Bump with an upgrade branch in the store's onupgradeneeded; never rewrite old branches. */
export const SAVE_DB_VERSION = 1;
/** Metadata store: small records, listed without touching payloads. */
export const SLOTS_STORE_NAME = 'slots';
/** Payload store: one large ParkSave (or raw unreadable record) per slot id. */
export const PAYLOADS_STORE_NAME = 'payloads';

/** Tabs tell each other that the slot list changed, so open dialogs refresh. */
export const SAVE_BROADCAST_CHANNEL_NAME = 'parksmith-saves-changed';
