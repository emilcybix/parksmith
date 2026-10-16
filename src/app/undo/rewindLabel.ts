import { UNDO_BUTTON_LABEL, UNDO_MIN_LABELLED_REWIND_SECONDS } from './constants';

/**
 * Words for how far an undo rewinds the park. Pure functions, so the table in DESIGN.md is one
 * test and the button, the tooltip and the toast cannot disagree about a duration.
 *
 * Simulated seconds, not wall seconds, because that is what the player loses. The two largest
 * units are shown and a zero minor unit is dropped ("3 min", not "3 min 0 s").
 */
export const formatRewind = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole} s`;
  if (whole < 3_600) {
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
};

/** The enabled button: "Undo · rewinds 42 s", or just "Undo" when nothing noticeable goes back. */
export const undoButtonLabel = (rewindSeconds: number): string =>
  rewindSeconds < UNDO_MIN_LABELLED_REWIND_SECONDS
    ? UNDO_BUTTON_LABEL
    : `${UNDO_BUTTON_LABEL} · rewinds ${formatRewind(rewindSeconds)}`;

/** The armed button, which asks for the second press. */
export const confirmButtonLabel = (rewindSeconds: number): string =>
  `Confirm rewind ${formatRewind(rewindSeconds)}`;

/** Whole simulated seconds between a snapshot and now; never negative. */
export const rewindSecondsBetween = (snapshotTimeMs: number, nowTimeMs: number): number =>
  Math.max(0, Math.floor((nowTimeMs - snapshotTimeMs) / 1_000));
