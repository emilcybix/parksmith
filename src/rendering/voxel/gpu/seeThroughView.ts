import { SEE_THROUGH, type SeeThroughFocus } from '../../seeThrough';
import { depthKeyFromTexture, depthToNdc, VOXELS_PER_TILE, type DepthRange } from '../contracts/space';
import type { TexelView } from './drawPlan';

/**
 * The see-through ("cutaway") volume of the voxel renderer, pure: the numbers the world-cut shader
 * reads (uSeeA, uSeeB) from the shared focus model (rendering/seeThrough.ts), the same decision as
 * plain TypeScript for the unit tests (`seeThroughCoverage`, the twin of the few GLSL lines in
 * shaders/world.ts), and the sync that writes the uniforms only when something moved.
 *
 * The volume. The focus is a footprint in cells [minX..maxX] x [minY..maxY] and a height H in voxels:
 * the voxel box X0..X1 x Y0..Y1 x 0..H. Its projection is the screen rectangle
 *   sx in [X0 - Y1, X1 - Y0],  sy in [(X0 + Y0) / 2 - H, (X1 + Y1) / 2]
 * (the box's silhouette fits inside it). A static fragment at texel t with depth key k stands at height
 * z = (k - 2 t.y) / 3 (key = x + y + z and t.y = (x + y) / 2 - z). It is cut, with coverage
 *   c = strength * (1 - smoothstep(0.4 M, M, d)),  d = distance from t to the rectangle (0 inside),
 * iff z >= floorZ (paving and plots top out at 1, so the ground is never cut and no void opens) and
 * k >= cutKey, the depth key from which something is nearer the camera than the build site:
 *   place    X1 + Y1 + H / 2   (the ghost's own bulk is never in front of itself)
 *   bulldoze X1 + Y1 + H       (the demolished object's own fragments have k <= X1 + Y1 + H: never cut)
 *   cell     X1 + Y1 + 2       (a path, the cursor, the coaster designer's cell)
 * and peek (the hold key) subtracts one cell of depth, so things beside and one cell behind open too.
 *
 * Two rungs of the same cut (shaders/world.ts): `dither` leaves a coverage-sized screen door of the
 * occluder in the G-buffer; `alpha` (translucent) removes every fragment with coverage above 0 from it
 * and draws exactly those fragments into the front layer (VoxelGpu), which the composite lights on its
 * own and mixes back over the revealed scene with weight `occluderWeight(coverage)`. `uSeeC` carries
 * the rectangle of the front layer in target texels (width 0 = dither rung this frame).
 */

/** The values the shader reads, in world texels and depth-key units. */
export interface SeeThroughUniformValues {
  /** Rectangle centre and half size, world texels. */
  ax: number;
  ay: number;
  aw: number;
  ah: number;
  /** Fragments with a depth key at or past this are in front of the build site. */
  cutKey: number;
  floorZ: number;
  /** Soft edge width, texels. */
  margin: number;
}

export const createSeeThroughValues = (): SeeThroughUniformValues => ({ ax: 0, ay: 0, aw: 0, ah: 0, cutKey: 0, floorZ: SEE_THROUGH.FLOOR_Z, margin: SEE_THROUGH.MARGIN_TEXELS });

/** Writes the uniform values of a focus (no allocation). */
export const seeThroughValuesFor = (focus: Readonly<SeeThroughFocus>, out: SeeThroughUniformValues): SeeThroughUniformValues => {
  const x0 = focus.minX * VOXELS_PER_TILE;
  const y0 = focus.minY * VOXELS_PER_TILE;
  const x1 = (focus.maxX + 1) * VOXELS_PER_TILE;
  const y1 = (focus.maxY + 1) * VOXELS_PER_TILE;
  const height = focus.heightVoxels;
  const left = x0 - y1;
  const right = x1 - y0;
  const top = (x0 + y0) / 2 - height;
  const bottom = (x1 + y1) / 2;
  out.ax = (left + right) / 2;
  out.aw = (right - left) / 2;
  out.ay = (top + bottom) / 2;
  out.ah = (bottom - top) / 2;
  const front = x1 + y1;
  let key = focus.mode === 'place' ? front + height / 2 : focus.mode === 'bulldoze' ? front + height : front + 2;
  if (focus.peek) key -= SEE_THROUGH.PEEK_DEPTH_SLACK;
  out.cutKey = key;
  out.floorZ = SEE_THROUGH.FLOOR_Z;
  out.margin = focus.peek ? SEE_THROUGH.PEEK_MARGIN_TEXELS : SEE_THROUGH.MARGIN_TEXELS;
  return out;
};

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * The shader's decision for one fragment: coverage in [0, strength], compared against the world-
 * anchored Bayer threshold (cut when coverage > threshold). `texelX/Y` are the fragment's world texel
 * (centre), `key` its depth key; `keySlack` lowers the cut key (the front layer's tolerance).
 */
export const seeThroughCoverage = (
  texelX: number,
  texelY: number,
  key: number,
  values: Readonly<SeeThroughUniformValues>,
  strength: number,
  keySlack = 0,
): number => {
  const dx = Math.max(Math.abs(texelX - values.ax) - values.aw, 0);
  const dy = Math.max(Math.abs(texelY - values.ay) - values.ah, 0);
  const distance = Math.hypot(dx, dy);
  const z = (key - 2 * texelY) / 3;
  if (z < values.floorZ || key < values.cutKey - keySlack) return 0;
  return strength * (1 - smoothstep(0.4 * values.margin, values.margin, distance));
};

/** The depth key a fragment's window depth (gl_FragCoord.z) stands for: the GLSL twin of vxDepthKeyFromTexture. */
export const depthKeyOfWindowDepth = (windowZ: number, range: DepthRange): number => depthKeyFromTexture(windowZ, range);

/** The window depth (0..1) of a depth key, as the rasteriser writes it (NDC z mapped to the depth range). */
export const windowDepthOfKey = (key: number, range: DepthRange): number => (depthToNdc(key, range) + 1) / 2;

/**
 * The front layer's capacity, texels (a 6 x 6 cell footprint with its margin and a 3 cell peek fit; one
 * target of this size is created once). A rectangle that does not fit makes that frame use the dither rung.
 */
export const FRONT_CAPACITY = { width: 640, height: 448 } as const;
/** Texels the front layer's rectangle grows by beyond the hole's margin: the ink ring of its silhouette. */
export const FRONT_INK_TEXELS = 2;

/** The front layer's rectangle in low-res target texels (origin and size, whole numbers); width 0 = none. */
export interface FrontRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const createFrontRect = (): FrontRect => ({ x: 0, y: 0, width: 0, height: 0 });

/**
 * Writes the rectangle of the target the front layer covers: the hole grown by its margin and the ink
 * ring, relative to the camera, clamped to the target. Returns whether it fits `capacity`; an empty
 * result (the hole is off screen) has width 0 and fits. Allocation-free; a camera pan by whole texels moves
 * the origin by the same whole number (the rectangle is a pure function of world texels and camera). The hole is in
 * world texels and the rectangle in target texels: Phase 55's `texelScale` (world texels per target texel) converts.
 */
export const frontRectFor = (
  frame: Readonly<SeeThroughUniformValues>,
  cameraTexelX: number,
  cameraTexelY: number,
  lowWidth: number,
  lowHeight: number,
  capacity: Readonly<{ width: number; height: number }>,
  out: FrontRect,
  texelScale = 1,
): boolean => {
  const k = texelScale;
  const minX = Math.max(0, Math.floor((frame.ax - frame.aw - frame.margin - cameraTexelX) / k) - FRONT_INK_TEXELS);
  const maxX = Math.min(lowWidth, Math.ceil((frame.ax + frame.aw + frame.margin - cameraTexelX) / k) + FRONT_INK_TEXELS);
  const minY = Math.max(0, Math.floor((frame.ay - frame.ah - frame.margin - cameraTexelY) / k) - FRONT_INK_TEXELS);
  const maxY = Math.min(lowHeight, Math.ceil((frame.ay + frame.ah + frame.margin - cameraTexelY) / k) + FRONT_INK_TEXELS);
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) {
    out.x = 0;
    out.y = 0;
    out.width = 0;
    out.height = 0;
    return true;
  }
  out.x = minX;
  out.y = minY;
  out.width = width;
  out.height = height;
  return width <= capacity.width && height <= capacity.height;
};

/**
 * The weight the lit front layer is mixed over the revealed scene with, for a cut coverage in [0, 1]:
 * 1 where nothing is cut (the building is whole), OCCLUDER_OPACITY where it is cut completely. Twin of the
 * mix in shaders/composite.ts.
 */
export const occluderWeight = (coverage: number): number => 1 - coverage * (1 - SEE_THROUGH.OCCLUDER_OPACITY);

/**
 * Whether the translucent rung's G-buffer pass keeps a fragment (coverage 0): the twin of the
 * `seeCut > seeThreshold` discard with the threshold at 0. `seeThroughCoverage` is the coverage.
 */
export const keptInMainBuffer = (coverage: number): boolean => !(coverage > 0);

/**
 * Whether the front layer holds a fragment: the exact complement of `keptInMainBuffer` for a fragment
 * whose key is at least SEE_THROUGH.KEY_SLACK clear of the cut key, and also true for a fragment within the
 * slack below it (it is then in both layers, which is harmless and is what keeps rounding from losing it).
 */
export const heldInFrontLayer = (
  texelX: number,
  texelY: number,
  key: number,
  values: Readonly<SeeThroughUniformValues>,
  strength: number,
): boolean => seeThroughCoverage(texelX, texelY, key, values, strength, SEE_THROUGH.KEY_SLACK) > 0;

/** What `VoxelFrameInput.seeThrough` carries: one object the renderer reuses, `revision` moves when a value does. */
export interface SeeThroughFrame extends SeeThroughUniformValues {
  revision: number;
  /** 0 = off (the cut program is never bound), 1 = fully cut. */
  strength: number;
}

export const createSeeThroughFrame = (): SeeThroughFrame => ({ ...createSeeThroughValues(), revision: 0, strength: 0 });

/** The rectangle of the hole grown by its margin, in world texels: a chunk outside it cannot be touched by the cut. */
export const seeThroughView = (frame: Readonly<SeeThroughUniformValues>, out: TexelView): TexelView => {
  out.minX = frame.ax - frame.aw - frame.margin;
  out.maxX = frame.ax + frame.aw + frame.margin;
  out.minY = frame.ay - frame.ah - frame.margin;
  out.maxY = frame.ay + frame.ah + frame.margin;
  return out;
};

export interface SeeThroughUniformTarget {
  uSeeA: Float32Array;
  uSeeB: Float32Array;
  /** The front layer's rectangle: origin x, origin y, width, height (width 0 = dither rung). */
  uSeeC: Float32Array;
}

/** Writes the uniforms from a frame and the front rectangle (null = none; no allocation). */
export const writeSeeThroughUniforms = (target: SeeThroughUniformTarget, frame: Readonly<SeeThroughFrame>, rect: Readonly<FrontRect> | null = null): void => {
  const c = target.uSeeC;
  c[0] = rect === null ? 0 : rect.x;
  c[1] = rect === null ? 0 : rect.y;
  c[2] = rect === null ? 0 : rect.width;
  c[3] = rect === null ? 0 : rect.height;
  const a = target.uSeeA;
  a[0] = frame.ax;
  a[1] = frame.ay;
  a[2] = frame.aw;
  a[3] = frame.ah;
  const b = target.uSeeB;
  b[0] = frame.cutKey;
  b[1] = frame.floorZ;
  b[2] = frame.margin;
  b[3] = frame.strength;
};

/**
 * Remembers which revision and which front rectangle the uniforms hold (the same pattern as
 * WeatherUniformSync): a still frame, camera included, writes nothing; a camera pan with the hole open
 * writes once per frame because the rectangle moves with it.
 */
export class SeeThroughUniformSync {
  private applied = Number.NaN;
  private x = Number.NaN;
  private y = 0;
  private width = 0;
  private height = 0;
  /** How many times `sync` wrote (diagnostics, tests). */
  writes = 0;

  /** Writes when `frame.revision` or the rectangle differs from the applied one; returns whether it did. */
  sync(target: SeeThroughUniformTarget, frame: Readonly<SeeThroughFrame>, rect: Readonly<FrontRect> | null = null): boolean {
    const x = rect === null ? 0 : rect.x;
    const y = rect === null ? 0 : rect.y;
    const width = rect === null ? 0 : rect.width;
    const height = rect === null ? 0 : rect.height;
    if (frame.revision === this.applied && x === this.x && y === this.y && width === this.width && height === this.height) return false;
    this.applied = frame.revision;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.writes += 1;
    writeSeeThroughUniforms(target, frame, rect);
    return true;
  }

  /** The next `sync` writes (a rebuilt pipeline). */
  invalidate(): void {
    this.applied = Number.NaN;
    this.x = Number.NaN;
  }
}
