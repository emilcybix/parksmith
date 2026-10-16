import type { UndoStatus } from '../app/undo/types';

/**
 * What the dock's undo button shows, as plain functions of `UndoStatus` (no DOM test library
 * exists, so a rule inside a component is a rule nothing checks). The wording itself (label,
 * tooltip, message) is produced by the undo ring so the button, the toast and the keyboard always
 * agree; this file only decides how that wording is presented.
 */

export interface UndoButtonModel {
  className: string;
  /** Visible text. Straight from the status: "Undo", "Undo · rewinds 42 s", "Confirm rewind 3 min 20 s". */
  label: string;
  /** Native tooltip: the status sentence, which already names the shortcut and the balance after. */
  title: string;
  /** The label plus what it takes back and how many steps follow, so the glyph-only parts are not lost. */
  ariaLabel: string;
  /**
   * The number of steps a chain of undos can walk, shown as a small badge. Null for one step (the
   * count would add nothing) and whenever the control is disabled.
   */
  depthBadge: number | null;
  /** The button stays clickable when unavailable so a press says why; this is the semantic state. */
  disabled: boolean;
  armed: boolean;
}

const stepsText = (depth: number): string => (depth === 1 ? '1 step available' : `${depth} steps available`);

export const describeUndoButton = (status: UndoStatus): UndoButtonModel => {
  const className = ['undo-tab', status.canUndo ? '' : 'unavailable', status.armed ? 'armed' : ''].filter(Boolean).join(' ');
  let ariaLabel: string;
  if (!status.canUndo) {
    ariaLabel = status.message === '' ? `${status.label}, unavailable` : `${status.label}, unavailable: ${status.message}`;
  } else if (status.armed) {
    ariaLabel = `${status.label}. Press again to confirm. ${status.target ?? ''}`.trim();
  } else {
    const target = status.target === null ? '' : `: ${status.target}`;
    ariaLabel = `${status.label}${target}. ${stepsText(status.depth)}`;
  }
  return {
    className,
    label: status.label,
    title: status.tooltip,
    ariaLabel,
    depthBadge: status.canUndo && status.depth > 1 ? status.depth : null,
    disabled: !status.canUndo,
    armed: status.armed,
  };
};
