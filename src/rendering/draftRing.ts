import { openLayoutRing } from '../game/coaster/centreLine';
import type { CoasterPiece } from '../game/coaster/design';

/**
 * `openLayoutRing` for drawing: the same ring, but every real piece keeps its `freeClimb` flag
 * (the game's ring copy drops it), so an open draft shows a chain strip only on chained climbs,
 * exactly like the built coaster (Phase 27 step 4). The scratch lead-in and run-out stay level.
 */
export const openDraftRing = (pieces: readonly CoasterPiece[]): CoasterPiece[] => {
  const ring = openLayoutRing(pieces);
  for (let index = 0; index < pieces.length; index += 1) {
    if (pieces[index].freeClimb === true) ring[index + 1].freeClimb = true;
  }
  return ring;
};
