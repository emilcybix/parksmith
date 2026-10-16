import type { FigureRange } from './figures';

/**
 * The seam between the pure scene (VoxelScene: everything that turns the park into typed arrays)
 * and the GPU (VoxelGpu: Pixi resources and passes). VoxelScene runs unmounted in Node with a
 * recording sink, so the frame-cost, construction-cost and incremental-equals-from-scratch guards
 * work exactly like the legacy renderer's.
 */

export type DynamicTexture = 'figures' | 'transforms' | 'litter' | 'lights';

/** Screen-space bounds in texels of the CURRENT VIEW (for culling a chunk or a moving part's sweep). */
export interface TexelBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Point lights for the dusk/night light pass, two texels each in a 256-wide texture:
 *   texel 0: x, y, z (world voxels), radius
 *   texel 1: r, g, b (0..1, sRGB), preset bitmask (blueprint.ts LIGHT_PRESET_*)
 */
export const LIGHT_TEXELS = 2;
export const LIGHT_FLOATS = LIGHT_TEXELS * 4;
export const LIGHT_TEX_WIDTH = 256;
export const LIGHT_CAPACITY = 1024;

export interface GhostState {
  /** Model-local boxes (BOX layout), all parts flattened at rest, keyed by (definition, rotation). */
  boxes: Float32Array;
  boxCount: number;
  /** World voxel origin of the rotated footprint's minimum corner. */
  originX: number;
  originY: number;
  originZ: number;
  coverage: number;
  tint: number;
  /** How much of `tint` is mixed into the model's own colours (GHOST_TINT_MIX, or less for a coloured valid ghost). */
  tintMix: number;
  /**
   * The model's footprint and height in world voxels from its origin (see-through cutaway, design: the
   * ghost's volume). Computed once per model box list; 0 for a ghost without boxes.
   */
  extentX: number;
  extentY: number;
  heightVoxels: number;
}

export interface VoxelGpuSink {
  /** A static chunk's complete box list after a rebuild (null bounds = empty chunk). */
  setChunk(index: number, boxes: Float32Array, boxCount: number, bounds: TexelBounds | null): void;
  /**
   * Rows [rowStart, rowEnd) of a dynamic texture's CPU copy changed; `count` records are live.
   * Records ≥ count are never drawn. rowStart === rowEnd means only the count changed.
   */
  setDynamic(texture: DynamicTexture, data: Float32Array, count: number, rowStart: number, rowEnd: number): void;
  setFigureRanges(ranges: readonly FigureRange[]): void;
  /** Null clears the ghost. Uploads happen only when `boxes` changes identity. */
  setGhost(ghost: GhostState | null): void;
  /**
   * The coaster layout being designed, as one more dithered ghost (a second slot: the placement
   * ghost keeps working while a draft exists). Boxes are in WORLD voxels, so origin is (0, 0, 0).
   */
  setDraft(draft: GhostState | null): void;
}

/** Scene-side counters, reset at the start of every VoxelScene.update(). */
export interface VoxelSceneStats {
  chunksRebuilt: number;
  boxesEmitted: number;
  dynamicRowsStaged: number;
  bytesStaged: number;
  blueprintsCompiled: number;
  /** Phase 26: chunks re-sorted and re-sent by the last view turn (`VoxelScene.setView`); reset by the next update. */
  chunksReordered: number;
}

/** A sink that ignores everything (unmounted renderers, tests that only count). */
export const NULL_GPU_SINK: VoxelGpuSink = {
  setChunk: () => undefined,
  setDynamic: () => undefined,
  setFigureRanges: () => undefined,
  setGhost: () => undefined,
  setDraft: () => undefined,
};
