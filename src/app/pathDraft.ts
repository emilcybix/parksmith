import type { Cell } from '../game/types';
import { lineCells } from './lineCells';

/**
 * Phase 37: grows a path draft along the pointer's straight line from `from` (the draft's last cell) to `to`, cell by
 * cell. A cell already in the draft cuts the draft back to it ("snake" backtracking): every cell after it is dropped,
 * so pulling the pointer back takes the path back with it and the player can steer round an obstacle without letting
 * go. A fast move that crosses the trail cuts at the first trail cell it meets and grows on from there. Existing world
 * paths are not draft cells, so crossing them is unaffected. Mutates `draft`; afterwards its last cell is `to`.
 */
export const extendPathDraft = (draft: Cell[], from: Cell, to: Cell): void => {
  for (const next of lineCells(from, to).slice(1)) {
    const index = draft.findIndex((cell) => cell.x === next.x && cell.y === next.y);
    if (index >= 0) draft.length = index + 1;
    else draft.push(next);
  }
};

/** The draft cells that cannot take a path (`open` says which can), in draft order: what the preview draws red. */
export const blockedDraftCells = (draft: readonly Cell[], open: (cell: Cell) => boolean): Cell[] => (
  draft.filter((cell) => !open(cell))
);
