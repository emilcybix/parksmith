import type { ViewFrame, ViewRotation, XY } from '../../viewRotation';
import { VOXELS_PER_TILE } from './space';

/**
 * Phase 26: the voxel view transform. The data stays in WORLD voxels; the vertex stages map a world
 * voxel (x, y, z) to a VIEW voxel with an exact integer 2x2 matrix plus an offset, and the rest of the
 * pipeline runs in view voxels exactly as it always did (design-step2.md sections 0, 3).
 *
 *   u = c*x - s*y + ox,  v = s*x + c*y + oy,  z unchanged
 *
 * With W = width x 32 and H = height x 32 (the WORLD map size in voxels):
 *   q 0: (c, s, ox, oy) = ( 1,  0, 0, 0)   (u, v) = (x, y)
 *   q 1: (c, s, ox, oy) = ( 0,  1, H, 0)   (u, v) = (H - y, x)
 *   q 2: (c, s, ox, oy) = (-1,  0, W, H)   (u, v) = (W - x, H - y)
 *   q 3: (c, s, ox, oy) = ( 0, -1, 0, W)   (u, v) = (y, W - x)
 *
 * Every value is an integer (-1, 0, 1, or a multiple of 32), so integer corners stay integers and view
 * 0 is bit-identical (1*x - 0*y + 0 == x). `uView` on the GPU is (c, s, ox, oy). The CPU twins here are
 * the spec for the GLSL twins in gpu/shaders/common.ts.
 */
export interface ViewTransform {
  rotation: ViewRotation;
  c: number;
  s: number;
  ox: number;
  oy: number;
  /** Bumped only when a value moved: the GPU writes its uniform only then. */
  revision: number;
}

export const createViewTransform = (): ViewTransform => ({ rotation: 0, c: 1, s: 0, ox: 0, oy: 0, revision: 0 });

/** Writes the frame's transform (map size from frame.width / height in tiles); bumps `revision` only if a value moved. */
export const setViewTransform = (frame: ViewFrame, out: ViewTransform): ViewTransform => {
  const w = frame.width * VOXELS_PER_TILE;
  const h = frame.height * VOXELS_PER_TILE;
  let c = 1;
  let s = 0;
  let ox = 0;
  let oy = 0;
  switch (frame.rotation) {
    case 1: c = 0; s = 1; ox = h; oy = 0; break;
    case 2: c = -1; s = 0; ox = w; oy = h; break;
    case 3: c = 0; s = -1; ox = 0; oy = w; break;
    default: break;
  }
  if (out.rotation !== frame.rotation || out.c !== c || out.s !== s || out.ox !== ox || out.oy !== oy) {
    out.rotation = frame.rotation;
    out.c = c;
    out.s = s;
    out.ox = ox;
    out.oy = oy;
    out.revision += 1;
  }
  return out;
};

/** Normalises -0 so that view 0 and exact zeros compare equal under Object.is. */
const plus = (value: number): number => value + 0;

export const voxelToView = (t: Readonly<ViewTransform>, x: number, y: number, out: XY): XY => {
  out.x = plus(t.c * x - t.s * y + t.ox);
  out.y = plus(t.s * x + t.c * y + t.oy);
  return out;
};

export const voxelFromView = (t: Readonly<ViewTransform>, u: number, v: number, out: XY): XY => {
  const du = u - t.ox;
  const dv = v - t.oy;
  out.x = plus(t.c * du + t.s * dv);
  out.y = plus(-t.s * du + t.c * dv);
  return out;
};

/** A vector takes the linear part only. */
export const vectorToViewVoxel = (t: Readonly<ViewTransform>, dx: number, dy: number, out: XY): XY => {
  out.x = plus(t.c * dx - t.s * dy);
  out.y = plus(t.s * dx + t.c * dy);
  return out;
};

/** The heading (0..3 = +x, +y, -x, -y) of a figure facing `heading` in the world, as seen in the view. */
export const headingInView = (heading: number, rotation: ViewRotation): number => (heading + rotation) & 3;

/**
 * World-space half-voxel shift along VIEW +x: the top-face pattern cell offset, (0.5*c, -0.5*s).
 * Writes into `out` (x, y); z is always 0.
 */
export const patternCellShift = (t: Readonly<ViewTransform>, out: XY): XY => {
  out.x = plus(0.5 * t.c);
  out.y = plus(-0.5 * t.s);
  return out;
};

/**
 * The quarter turns a transform stands for, decoded from (c, s) exactly as the figure vertex stage does
 * (`c > 0.5 ? 0 : s > 0.5 ? 1 : c < -0.5 ? 2 : 3`), so a figure's heading turns to `(heading + turn) & 3`.
 */
export const quarterTurnsOfTransform = (t: Readonly<ViewTransform>): ViewRotation =>
  t.c > 0.5 ? 0 : t.s > 0.5 ? 1 : t.c < -0.5 ? 2 : 3;
