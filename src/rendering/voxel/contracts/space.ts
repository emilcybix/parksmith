import type { Cell, Rotation } from '../../../game/types';

/**
 * Voxel space: the one coordinate contract every voxel module shares.
 *
 * A tile is 32 voxels on a side, and one voxel step projects to exactly one texel of the low-res
 * target along the 2:1 diamond: +x → (+1, +½), +y → (−1, +½), +z → (0, −1). That makes a voxel
 * texel the same unit as a legacy world pixel (`cellToWorld` in isometric.ts), so picking, focus and
 * every overlay keep working in the coordinates they already use. The factors are rational on
 * purpose: box corners on integer voxels land on integer x and integer-or-half y, all edges are
 * vertical or slope ±½, and no pixel centre ever lies exactly on an edge — the rasteriser has no
 * ties to break, so a still camera draws the same texels every frame.
 *
 * Handedness: screen right × screen up points INTO the screen, so the picture is the mirror image
 * of a right-handed world. Anything asymmetric (text on a sign, which hand holds a tool) must be
 * judged on screen — in the preview tool — never by model-space intuition.
 */

export const VOXELS_PER_TILE = 32;

/**
 * Vertical layering. Static sources own disjoint voxel slabs so no two boxes are ever coplanar
 * and overlapping (equal-depth overlaps z-fight on real GPUs): terrain owns z < 0, paving and plot
 * slabs own [0, 1), and anything standing on a path or plot starts at z = 1.
 */
export const SOIL_DEPTH = 16;
export const GROUND_TOP_Z = 0;
export const PATH_TOP_Z = 1;
export const PLOT_TOP_Z = 1;
/** One coaster height level, in voxels (legacy COASTER_ELEVATION_PX). */
export const COASTER_LEVEL_VOXELS = 13;

/** Texel x of a voxel-space point (identical to legacy world px). */
export const projectX = (vx: number, vy: number): number => vx - vy;

/** Texel y of a voxel-space point (identical to legacy world px; z lifts it up the screen). */
export const projectY = (vx: number, vy: number, vz: number): number => (vx + vy) / 2 - vz;

/**
 * Depth key: larger is nearer the camera. The projection's null vector is (1, 1, 1), so every
 * point on one view ray shares a texel and this sum orders them exactly.
 */
export const depthKey = (vx: number, vy: number, vz: number): number => vx + vy + vz;

export interface DepthRange {
  readonly min: number;
  readonly max: number;
}

/** Depth-key range covering a map of `width` × `height` tiles with generous head- and footroom. */
export const depthRangeFor = (width: number, height: number): DepthRange => ({
  min: -512,
  max: VOXELS_PER_TILE * (width + height) + 1024,
});

/** NDC z for the depth test `LESS` with clear depth 1: nearer (larger key) maps to smaller z. */
export const depthToNdc = (key: number, range: DepthRange): number =>
  1 - 2 * (key - range.min) / (range.max - range.min);

/** Depth key back from a sampled depth-texture value in [0, 1]. 1 is the cleared background. */
export const depthKeyFromTexture = (value: number, range: DepthRange): number =>
  range.min + (1 - value) * (range.max - range.min);

export interface VoxelPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Voxel-space point seen at world texel (sx, sy) with depth key `key`. The composite pass uses
 * the GLSL twin of this to know the true height of every texel (contact shadow, light pools).
 */
export const fromTexelAndDepth = (sx: number, sy: number, key: number): VoxelPoint => {
  const sum = (sy + key) / 1.5;
  return { x: (sum + sx) / 2, y: (sum - sx) / 2, z: key - sum };
};

/**
 * Depth-key change per texel step (right, down) on each axis-aligned face. A neighbour that
 * continues the same plane differs by exactly this much, so every depth-edge test must compare
 * against it — a raw threshold of 2 would flag every flat top face.
 */
export const PLANE_GRADIENT_TOP: readonly [number, number] = [0, 2];
export const PLANE_GRADIENT_X: readonly [number, number] = [-1.5, -1];
export const PLANE_GRADIENT_Y: readonly [number, number] = [1.5, -1];

/**
 * A screen-space offset of something standing on the ground, re-expressed as a move inside the
 * ground plane. Offsetting in texels while keeping depth would sink the model (ΔY texels down at
 * constant depth is (ΔY/3, ΔY/3, −2ΔY/3) voxels); this keeps its feet on the paving. Δdepth = 2·ΔY.
 */
export const groundOffsetForTexelOffset = (dsx: number, dsy: number): { dvx: number; dvy: number } => ({
  dvx: dsy + dsx / 2,
  dvy: dsy - dsx / 2,
});

/** Voxel coordinates of a cell's minimum corner (the tile diamond's top vertex on screen). */
export const cellOriginVoxel = (cell: Cell): { x: number; y: number } => ({
  x: cell.x * VOXELS_PER_TILE,
  y: cell.y * VOXELS_PER_TILE,
});

/** Voxel coordinates of a (possibly fractional) cell position's centre — where figures stand. */
export const cellCentreVoxel = (cell: Cell): { x: number; y: number } => ({
  x: cell.x * VOXELS_PER_TILE + VOXELS_PER_TILE / 2,
  y: cell.y * VOXELS_PER_TILE + VOXELS_PER_TILE / 2,
});

/**
 * Rotation is footprint orientation only (types.ts), so r and r + 2 are the same world model. Models
 * are authored with their front on model +y (screen lower-left in view 0); a visual quarter turn puts
 * it on world +x (screen lower-right in view 0). The map view turns (Phase 26, contracts/view.ts), so
 * every side of a model is seen from some view: a turned view shows its real back, never a mirror.
 */
export type QuarterTurn = 0 | 1;
export const visualQuarterTurn = (rotation: Rotation): QuarterTurn => (rotation % 2) as QuarterTurn;

/**
 * Quarter turn of a point inside a model footprint `footprintWidth` voxels wide along model x.
 * q = 1 maps model +y to world +x: (x, y) → (y, W − x). The rotated footprint is D × W, which is
 * `footprintSize(definition, rotation)` for every odd rotation.
 */
export const rotatePointInFootprint = (
  x: number,
  y: number,
  quarterTurn: QuarterTurn,
  footprintWidth: number,
): { x: number; y: number } =>
  quarterTurn === 0 ? { x, y } : { x: y, y: footprintWidth - x };

/** The same quarter turn for an axis-aligned box given by its minimum corner and size. */
export const rotateBoxInFootprint = (
  minX: number,
  minY: number,
  sizeX: number,
  sizeY: number,
  quarterTurn: QuarterTurn,
  footprintWidth: number,
): { minX: number; minY: number; sizeX: number; sizeY: number } =>
  quarterTurn === 0
    ? { minX, minY, sizeX, sizeY }
    : { minX: minY, minY: footprintWidth - minX - sizeX, sizeX: sizeY, sizeY: sizeX };

/** Unit quaternion (x, y, z, w) of the visual quarter turn about +z: −90° maps +y to +x. */
export const quarterTurnQuaternion = (quarterTurn: QuarterTurn): readonly [number, number, number, number] =>
  quarterTurn === 0 ? [0, 0, 0, 1] : [0, 0, -Math.SQRT1_2, Math.SQRT1_2];

/**
 * Static world chunks: 8×8 tiles. A 32×32 park is 16 chunks; each is rebuilt and uploaded on its
 * own when construction touches it, and culled on its own when it is off screen.
 */
export const CHUNK_TILES = 8;

export const chunkCountFor = (width: number, height: number): number =>
  Math.ceil(width / CHUNK_TILES) * Math.ceil(height / CHUNK_TILES);

export const chunkIndexOfCell = (x: number, y: number, width: number): number =>
  Math.floor(y / CHUNK_TILES) * Math.ceil(width / CHUNK_TILES) + Math.floor(x / CHUNK_TILES);
