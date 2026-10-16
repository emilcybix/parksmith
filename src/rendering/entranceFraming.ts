import type { Cell } from '../game/types';
import { cellToView, viewMapSize } from './viewRotation';
import type { ViewFrame, XY } from './viewRotation';

/**
 * Phase 24: where "Center camera on the park entrance" looks, for ANY gate position. Pure (no Pixi, no DOM),
 * shared by the voxel camera and the classic renderer so both frame a map the same way.
 *
 * The long-standing framing (Meadow, view 0) puts a point of the park 11 cells in front of the gate at 18 % of the
 * screen height, with the gate below it: it relies on the gate being at the BOTTOM of the picture. So the rule is
 * stated in VIEW coordinates: when the gate cell lies on the view's south edge (view row H' - 1) the legacy
 * framing applies relative to it, an anchor view cell one half past the gate's column and 11 rows above its row whose top vertex goes to
 * (0.5 w, 0.18 h); in every other view (and for any gate on another edge) the gate is somewhere else in the
 * picture and the midpoint between the gate's cell middle and the map centre is centred instead, which keeps the
 * gate and the park's heart on screen whatever edge the gate stands on.
 *
 * Meadow's gate is in column 15 of the last row of a 32 x 32 map: in view 0 the anchor is exactly the cell both renderers
 * centred on before this phase (column 15.5, row 20), so every Meadow camera position is bit-identical (pinned by the identity tests).
 */

/** How far in front of the gate (in cells, along the view's up direction) the anchor lies. */
export const ENTRANCE_ANCHOR_DEPTH = 11;
/** The anchor's top vertex goes to this fraction of the screen height. */
export const ENTRANCE_ANCHOR_HEIGHT_FRACTION = 0.18;

export type EntranceFocus =
  /** Put this VIEW cell's top vertex at (0.5 w, ENTRANCE_ANCHOR_HEIGHT_FRACTION h). */
  | { readonly mode: 'anchor'; readonly viewX: number; readonly viewY: number }
  /** Centre the midpoint of the gate's cell middle and the map centre (both in the view). */
  | { readonly mode: 'midpoint' };

const MIDPOINT: EntranceFocus = Object.freeze({ mode: 'midpoint' });

const scratch: XY = { x: 0, y: 0 };

/** The focus rule for a gate (WORLD cell) seen through `frame`. Allocates only the anchor result. */
export const entranceFocus = (frame: ViewFrame, entrance: Cell): EntranceFocus => {
  const gate = cellToView(frame, entrance.x, entrance.y, scratch);
  const size = viewMapSize(frame);
  if (gate.y === size.height - 1) {
    return { mode: 'anchor', viewX: gate.x + 0.5, viewY: gate.y - ENTRANCE_ANCHOR_DEPTH };
  }
  return MIDPOINT;
};
