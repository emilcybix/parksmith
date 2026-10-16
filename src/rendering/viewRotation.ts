import type { Cell, Rotation } from '../game/types';

/**
 * Phase 26: the orientation maths of the rotated map view. Pure (no Pixi, no DOM, no store): the
 * simulation never sees it, renderers and the shared input mapping use it.
 *
 * `q + 1` turns the map 90 degrees clockwise on screen about its centre. View coordinates always span
 * the view map [0, W') x [0, H') (W' = H and H' = W for odd q), so the map stays centred. Every
 * function returns its inputs untouched for q = 0, so view 0 is bit-identical to the unrotated game.
 *
 * Two coordinate spaces: cell-index space (integers, or index-centred fractions; index i is the point
 * i + 1/2) and point space (continuous; cell (cx, cy) covers [cx, cx + 1) x [cy, cy + 1)). Vectors
 * (directions, tangents, frame axes) take the linear part only, and z is never touched.
 */

/** Quarter turns of the whole map view; q + 1 turns the map 90 degrees clockwise on screen. */
export type ViewRotation = 0 | 1 | 2 | 3;

export const VIEW_ROTATIONS: readonly ViewRotation[] = [0, 1, 2, 3];

export const isViewRotation = (value: unknown): value is ViewRotation =>
  value === 0 || value === 1 || value === 2 || value === 3;

/** The rotation plus the WORLD map size it pivots about (cells). */
export interface ViewFrame {
  readonly rotation: ViewRotation;
  readonly width: number;
  readonly height: number;
}

/** Renderers keep one of these and mutate it (no per-frame allocation). */
export interface MutableViewFrame {
  rotation: ViewRotation;
  width: number;
  height: number;
}

export const IDENTITY_VIEW_FRAME: ViewFrame = Object.freeze({ rotation: 0, width: 0, height: 0 });

export const createViewFrame = (rotation: ViewRotation = 0, width = 0, height = 0): MutableViewFrame => ({
  rotation,
  width,
  height,
});

export const turnView = (rotation: ViewRotation, step: 1 | -1): ViewRotation =>
  ((rotation + step + 4) & 3) as ViewRotation;

export const viewMapSize = (frame: ViewFrame): { width: number; height: number } =>
  (frame.rotation & 1) === 0
    ? { width: frame.width, height: frame.height }
    : { width: frame.height, height: frame.width };

export interface XY {
  x: number;
  y: number;
}

const set = (out: XY, x: number, y: number): XY => {
  out.x = x;
  out.y = y;
  return out;
};

// ---- cell-index space ----------------------------------------------------------------------------

export const cellToView = (frame: ViewFrame, x: number, y: number, out: XY): XY => {
  const { width: w, height: h } = frame;
  switch (frame.rotation) {
    case 1: return set(out, h - 1 - y, x);
    case 2: return set(out, w - 1 - x, h - 1 - y);
    case 3: return set(out, y, w - 1 - x);
    default: return set(out, x, y);
  }
};

export const cellFromView = (frame: ViewFrame, u: number, v: number, out: XY): XY => {
  const { width: w, height: h } = frame;
  switch (frame.rotation) {
    case 1: return set(out, v, h - 1 - u);
    case 2: return set(out, w - 1 - u, h - 1 - v);
    case 3: return set(out, w - 1 - v, u);
    default: return set(out, u, v);
  }
};

const scratch: XY = { x: 0, y: 0 };

export const toViewCell = (frame: ViewFrame, cell: Cell): Cell => {
  if (frame.rotation === 0) return cell;
  cellToView(frame, cell.x, cell.y, scratch);
  return { x: scratch.x, y: scratch.y };
};

export const fromViewCell = (frame: ViewFrame, cell: Cell): Cell => {
  if (frame.rotation === 0) return cell;
  cellFromView(frame, cell.x, cell.y, scratch);
  return { x: scratch.x, y: scratch.y };
};

// ---- point space ---------------------------------------------------------------------------------

export const pointToView = (frame: ViewFrame, x: number, y: number, out: XY): XY => {
  const { width: w, height: h } = frame;
  switch (frame.rotation) {
    case 1: return set(out, h - y, x);
    case 2: return set(out, w - x, h - y);
    case 3: return set(out, y, w - x);
    default: return set(out, x, y);
  }
};

export const pointFromView = (frame: ViewFrame, u: number, v: number, out: XY): XY => {
  const { width: w, height: h } = frame;
  switch (frame.rotation) {
    case 1: return set(out, v, h - u);
    case 2: return set(out, w - u, h - v);
    case 3: return set(out, w - v, u);
    default: return set(out, u, v);
  }
};

// ---- vectors -------------------------------------------------------------------------------------

export const vectorToView = (rotation: ViewRotation, dx: number, dy: number, out: XY): XY => {
  switch (rotation) {
    case 1: return set(out, -dy, dx);
    case 2: return set(out, -dx, -dy);
    case 3: return set(out, dy, -dx);
    default: return set(out, dx, dy);
  }
};

export const vectorFromView = (rotation: ViewRotation, du: number, dv: number, out: XY): XY => {
  switch (rotation) {
    case 1: return set(out, dv, -du);
    case 2: return set(out, -du, -dv);
    case 3: return set(out, -dv, du);
    default: return set(out, du, dv);
  }
};

// ---- buildings and footprints --------------------------------------------------------------------

/** A building with world rotation r as drawn in view q: (r + q) & 3. */
export const rotationInView = (rotation: Rotation, view: ViewRotation): Rotation =>
  ((rotation + view) & 3) as Rotation;

export interface CellRect {
  x: number;
  y: number;
  width: number;
  depth: number;
}

/** World footprint rect to view rect: anchor = min corner, size swapped on odd turns. */
export const rectToView = (
  frame: ViewFrame,
  x: number,
  y: number,
  width: number,
  depth: number,
  out: CellRect,
): CellRect => {
  if (frame.rotation === 0) {
    out.x = x;
    out.y = y;
    out.width = width;
    out.depth = depth;
    return out;
  }
  cellToView(frame, x, y, scratch);
  const ax = scratch.x;
  const ay = scratch.y;
  cellToView(frame, x + width - 1, y + depth - 1, scratch);
  out.x = Math.min(ax, scratch.x);
  out.y = Math.min(ay, scratch.y);
  const odd = (frame.rotation & 1) === 1;
  out.width = odd ? depth : width;
  out.depth = odd ? width : depth;
  return out;
};

/** Screen direction (CSS degrees clockwise from up) that world north (-y) points to: 45 + 90q. */
export const compassAngle = (rotation: ViewRotation): number => 45 + 90 * rotation;
