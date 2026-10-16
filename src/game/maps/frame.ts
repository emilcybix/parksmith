import type { Cell } from '../types';
import { FACING_VECTORS, type MapEntrance } from './types';

/**
 * The entrance frame: coordinates relative to the gate, so a route (the First Day pacing route, a test, a
 * generator) is written once and works on every map. `l` (lateral) grows to the RIGHT of the inward direction
 * as seen walking in; `d` (depth) counts cells inward from the gate (0 = the gate itself).
 *
 * forward = the facing vector, right = (-forward.y, forward.x). Meadow (gate (15, 31) facing north): forward
 * (0, -1), right (1, 0), so toWorld(l, d) = (15 + l, 31 - d) and the pacing route's x 13..18 is l -2..+3.
 */
export interface EntranceFrame {
  readonly forward: Readonly<{ x: number; y: number }>;
  readonly right: Readonly<{ x: number; y: number }>;
  /** Quarter turns that map an object's unrotated [w, d] footprint (w along x) onto (lateral, depth): 0 for a north or south gate, 1 for east or west. */
  readonly rotation: 0 | 1;
  /** The world cell at lateral `l` and depth `d`. */
  toWorld(l: number, d: number): Cell;
  /**
   * The min corner (the anchor of an unrotated or quarter-turned footprint) of a w (lateral) by h (depth)
   * rectangle whose cell nearest the gate and leftmost is (l, d). Pass the object's footprint in frame terms
   * (w along the lateral axis) and its `rotation` from this frame.
   */
  rectToWorld(l: number, d: number, w: number, h: number): Cell;
}

export const entranceFrame = (entrance: MapEntrance): EntranceFrame => {
  const forward = FACING_VECTORS[entrance.facing];
  const right = { x: -forward.y, y: forward.x };
  const toWorld = (l: number, d: number): Cell => ({
    x: entrance.x + forward.x * d + right.x * l,
    y: entrance.y + forward.y * d + right.y * l,
  });
  return {
    forward,
    right,
    rotation: entrance.facing === 'north' || entrance.facing === 'south' ? 0 : 1,
    toWorld,
    rectToWorld: (l, d, w, h) => {
      const near = toWorld(l, d);
      const far = toWorld(l + w - 1, d + h - 1);
      return { x: Math.min(near.x, far.x), y: Math.min(near.y, far.y) };
    },
  };
};
