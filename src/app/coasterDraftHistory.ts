/**
 * The designer's own undo stack for lift toggles. Ctrl+Z, Undo, Esc and right-click all step back
 * "one thing" in the designer: a toggle made after the newest piece is that thing, otherwise it is
 * the newest piece. Pure, so the rule is testable without the app.
 */

export interface LiftToggleEntry {
  /** How many pieces the draft had when the toggle was made. */
  pieceCount: number;
  /** Piece index of the first segment of the toggled run. */
  runStart: number;
}

export type LiftToggleHistory = readonly LiftToggleEntry[];

export const EMPTY_LIFT_HISTORY: LiftToggleHistory = [];

/** Upper bound so a player mashing L cannot grow the stack without limit. */
export const MAX_LIFT_HISTORY = 64;

export const recordLiftToggle = (history: LiftToggleHistory, entry: LiftToggleEntry): LiftToggleHistory =>
  [...history, entry].slice(-MAX_LIFT_HISTORY);

export type DraftUndoStep =
  | { kind: 'revert-toggle'; entry: LiftToggleEntry; history: LiftToggleHistory }
  | { kind: 'pop-piece'; history: LiftToggleHistory };

/** What one undo step does for a draft with `pieceCount` pieces. */
export const planDraftUndo = (history: LiftToggleHistory, pieceCount: number): DraftUndoStep => {
  const top = history[history.length - 1];
  if (top && top.pieceCount === pieceCount) {
    return { kind: 'revert-toggle', entry: top, history: history.slice(0, -1) };
  }
  // Popping a piece takes the pieces after a toggle with it; those entries describe a layout that is gone.
  return { kind: 'pop-piece', history: history.filter((entry) => entry.pieceCount <= pieceCount - 1) };
};
