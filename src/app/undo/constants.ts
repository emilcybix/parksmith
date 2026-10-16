import type { UndoStatus } from './types';

/**
 * Every tunable of snapshot undo in one place, so a product decision ("twenty steps", "confirm
 * past a minute") is a one-line change that tests and the UI both import. Each number is explained
 * by a measurement in DESIGN.md (1,000 guests, headless Chromium, voxel renderer).
 */

// --- Ring size --------------------------------------------------------------------------------

/**
 * The most steps a chain of undos can walk back. Twenty covers "I built a whole street and want
 * the first tile back" without making the ring a second save system. Snapshots are plain objects:
 * measured at 1.16 MB retained per 1,000-guest snapshot (a JSON string of the same state is
 * 1.99 MB and costs 6.6 ms to produce at 1x), 30 KB for the dev park with no guests.
 */
export const UNDO_MAX_DEPTH = 20;

/** The memory budget never evicts below this many entries, whatever the park weighs. */
export const UNDO_MIN_DEPTH = 3;

/**
 * Soft budget for all retained snapshots. At the guest cap (1.2 MB each) it holds 16 entries, in a
 * park of a few hundred guests the depth cap binds first. The oldest entries go first.
 */
export const UNDO_MEMORY_BUDGET_BYTES = 20 * 1024 * 1024;

/** Heuristic retained size of an entry: a park's own state plus what each guest adds. Calibrated from the measurements above with a margin. */
export const UNDO_ESTIMATED_BYTES_BASE = 60 * 1024;
export const UNDO_ESTIMATED_BYTES_PER_GUEST = 1200;

// --- Telling the player ----------------------------------------------------------------------

/**
 * A rewind longer than this (simulated seconds) needs a second press. Under it a misclick fix is
 * one keystroke; over it the player is about to lose a minute of income and decisions they may
 * not remember making. One minute is ten real seconds at 6x.
 */
export const UNDO_CONFIRM_REWIND_SECONDS = 60;

/** Past this the confirmation wording is stronger ("this is a long way back"). */
export const UNDO_STRONG_WARNING_SECONDS = 300;

/** How long the armed state waits for the second press before it expires. */
export const UNDO_CONFIRM_WINDOW_MS = 4_000;

/**
 * A second press sooner than this after arming is a double-click or a key bounce, not a decision:
 * it is ignored (the control stays armed, the window does not restart). Without a floor the
 * confirmation does nothing against the accidental double-click it exists for.
 */
export const UNDO_CONFIRM_MIN_GAP_MS = 500;

/** Below this many simulated seconds the label is just "Undo" (nothing noticeable goes back). */
export const UNDO_MIN_LABELLED_REWIND_SECONDS = 1;

// --- Budgets (measured, asserted by the real-browser check, not enforced at runtime) ----------

/** Main-thread budget of one capture at 1x; measured median 2 ms, max 4.6 ms at 1,000 guests. */
export const UNDO_CAPTURE_BUDGET_MS = 8;

/** Main-thread budget of the restore (fromState plus swap) at 1x on the voxel renderer. */
export const UNDO_RESTORE_BUDGET_MS = 30;

// --- Words ------------------------------------------------------------------------------------

export const UNDO_BUTTON_LABEL = 'Undo';
export const UNDO_EMPTY_MESSAGE = 'Nothing to undo yet';
export const UNDO_SCENARIO_ENDED_MESSAGE = 'The scenario is over, so nothing can be rewound';
export const UNDO_BUSY_MESSAGE = 'Undo is unavailable while a park is loading';
export const UNDO_FAILED_MESSAGE = 'That step could not be rewound; the park is unchanged';
export const UNDO_SHORTCUT = 'Ctrl+Z';

/** The status before the first gesture, and the one every clear returns to. */
export const EMPTY_UNDO_STATUS: UndoStatus = {
  canUndo: false,
  depth: 0,
  maxDepth: UNDO_MAX_DEPTH,
  label: UNDO_BUTTON_LABEL,
  tooltip: `${UNDO_EMPTY_MESSAGE} (${UNDO_SHORTCUT})`,
  target: null,
  kind: null,
  rewindSeconds: 0,
  cashAfterUndo: null,
  needsConfirmation: false,
  armed: false,
  reason: 'empty',
  message: UNDO_EMPTY_MESSAGE,
};
