import { LIGHT_PRESET_DAY, LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import { INDICES_PER_BOX } from '../contracts/boxes';
import type { TexelBounds } from '../contracts/frame';
import type { LightPresetName } from '../lightPresets';
import type { VoxelProgramName } from './programs';
import { WATER_LOOP_SECONDS } from './shaders/patterns';

/**
 * The pure decisions behind every voxel draw: what is visible, in which order, and how many indices
 * each draw may use. Kept free of Pixi so Node tests can pin the rules that matter most:
 * - Pixi draws the WHOLE index buffer when a draw's size is 0, so a zero count must skip the draw
 *   (an empty figure list would otherwise redraw every stale entity);
 * - every box draw starts at index 0 with size = boxes · 18, so the shared index buffer only has to
 *   cover the largest single draw;
 * - visible chunks go nearest first, so real GPUs reject hidden fragments early.
 */

/** Indices one light quad uses from the shared box index buffer (vertices 4i..4i+3). */
export const INDICES_PER_LIGHT = 6;

/** Smallest shared index buffer, in boxes (covers a typical chunk; grown by powers of two). */
export const MIN_INDEX_CAPACITY = 4096;

/** Low-res target side in the harness-only GPU-minimal mode (design §5, `&voxelGpu=min`). */
export const GPU_MIN_TARGET_SIZE = 64;

/**
 * The ghost's x-ray pass (design §5): the parts of the ghost that existing geometry hides are drawn
 * again, sparser and as a flat tint, with the depth test inverted.
 */
export const GHOST_XRAY_COVERAGE = 0.25;
export const GHOST_XRAY_TINT_MIX = 1;

/**
 * uTime wraps here, on the CPU, so float32 keeps sub-millisecond steps however long the park runs.
 * A whole number of WATER loops, so the animated patterns never jump at the wrap.
 */
export const SHADER_TIME_WRAP_SECONDS = WATER_LOOP_SECONDS * 300;

export const wrapShaderSeconds = (elapsedMs: number): number => {
  const seconds = (elapsedMs / 1000) % SHADER_TIME_WRAP_SECONDS;
  return seconds < 0 ? seconds + SHADER_TIME_WRAP_SECONDS : seconds;
};

/** A light's preset bitmask (contracts/blueprint.ts LIGHT_PRESET_*) bit for the active preset. */
export const lightPresetBit = (preset: LightPresetName): number =>
  preset === 'day' ? LIGHT_PRESET_DAY : preset === 'dusk' ? LIGHT_PRESET_DUSK : LIGHT_PRESET_NIGHT;

/**
 * Viewport side the geometry passes map through: the smallest power of two covering the target.
 * Mapping world − camera to clip space by a power of two (and back by the viewport transform) is
 * exact for sub-texel-snapped positions, so rasterisation never depends on the camera texel. The
 * viewport may overhang the target (nothing is drawn there); past the GPU's viewport limit the
 * target's own size is used and only that exactness is lost.
 */
export const clipSizeFor = (size: number, maxViewport: number): number => {
  let clip = 1;
  while (clip < size) clip *= 2;
  return clip <= maxViewport ? clip : size;
};

/** Texture rows `count` records of `texelsPerRecord` texels need in a `width`-texel-wide texture. */
export const rowsForRecords = (count: number, texelsPerRecord: number, width: number): number =>
  Math.ceil(Math.max(0, count) * texelsPerRecord / width);

/** The world-texel rectangle a frame covers (the low-res target, guard band included). */
export interface TexelView {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Writes the view of a low-res target whose texel (0, 0) is world texel (cameraX, cameraY), `scale` world texels per
 * target texel (Phase 55).
 */
export const viewOfTarget = (cameraX: number, cameraY: number, width: number, height: number, out: TexelView, scale = 1): TexelView => {
  out.minX = cameraX;
  out.minY = cameraY;
  out.maxX = cameraX + width * scale;
  out.maxY = cameraY + height * scale;
  return out;
};

/** Conservative overlap of closed texel rectangles. */
export const boundsIntersectView = (bounds: Readonly<TexelBounds>, view: Readonly<TexelView>): boolean =>
  bounds.maxX >= view.minX && bounds.minX <= view.maxX && bounds.maxY >= view.minY && bounds.minY <= view.maxY;

/**
 * Whether a chunk's draw must use the world-cut program: its screen bounds touch the see-through
 * hole (the rectangle grown by its margin, seeThroughView.ts `seeThroughView`). Every other chunk
 * keeps the discard-free opaque program, so early-Z and hidden-surface removal stay on for them.
 */
export const chunkNeedsCut = (bounds: Readonly<TexelBounds>, cutView: Readonly<TexelView>): boolean =>
  boundsIntersectView(bounds, cutView);

export interface ChunkDrawState {
  readonly count: number;
  readonly bounds: Readonly<TexelBounds> | null;
}

/**
 * Nearest first: a chunk's bounds reach down to its ground diamond's bottom vertex (plus the soil
 * band), and that texel row grows with chunkX + chunkY exactly like the depth key, whatever stands
 * on the chunk. Ties keep index order, so the plan is deterministic.
 */
const isNearer = (a: Readonly<TexelBounds>, aIndex: number, b: Readonly<TexelBounds>, bIndex: number): boolean =>
  a.maxY > b.maxY || (a.maxY === b.maxY && aIndex < bIndex);

/**
 * Fills `order` with the indices of the non-empty chunks that overlap the view, nearest first, and
 * returns how many there are. Allocation-free (insertion sort over ≤ a few dozen chunks).
 */
export const planChunkDraws = (
  chunks: readonly (ChunkDrawState | null | undefined)[],
  view: Readonly<TexelView>,
  order: Int32Array,
): number => {
  let visible = 0;
  for (let index = 0; index < chunks.length && visible < order.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk || chunk.count <= 0 || chunk.bounds === null || !boundsIntersectView(chunk.bounds, view)) continue;
    const bounds = chunk.bounds;
    let at = visible;
    while (at > 0) {
      const previous = chunks[order[at - 1]] as ChunkDrawState;
      if (!isNearer(bounds, index, previous.bounds as TexelBounds, order[at - 1])) break;
      order[at] = order[at - 1];
      at -= 1;
    }
    order[at] = index;
    visible += 1;
  }
  return visible;
};

/**
 * Index count of a box draw: 0 means "do not draw at all" (never pass size 0 to Pixi). The
 * harness-only GPU-minimal mode keeps every draw but clamps it to one box.
 */
export const boxDrawIndexCount = (boxes: number, gpuMin: boolean): number => {
  if (!(boxes > 0)) return 0;
  return (gpuMin ? 1 : Math.floor(boxes)) * INDICES_PER_BOX;
};

/** Index count of the light-pass draw (one quad per light), with the same rules. */
export const lightDrawIndexCount = (lights: number, gpuMin: boolean): number => {
  if (!(lights > 0)) return 0;
  return (gpuMin ? 1 : Math.floor(lights)) * INDICES_PER_LIGHT;
};

/** Boxes of index buffer a light draw of `lights` quads needs. */
export const boxesForLights = (lights: number): number => Math.ceil(Math.max(0, lights) * INDICES_PER_LIGHT / INDICES_PER_BOX);

/** Capacity (boxes) the shared index buffer needs: never shrinks, grows to a power of two. */
export const indexCapacityFor = (current: number, needed: number): number => {
  let capacity = Math.max(MIN_INDEX_CAPACITY, current);
  while (capacity < needed) capacity *= 2;
  return capacity;
};

/**
 * Boxes of one figure range draw: the range clamped to the live entity count (records at or past
 * the count are stale and must never be drawn), times the model's template box count.
 */
export const figureRangeBoxes = (firstEntity: number, entityCount: number, liveCount: number, boxesPerEntity: number): number => {
  if (boxesPerEntity <= 0 || entityCount <= 0 || firstEntity >= liveCount) return 0;
  return (Math.min(firstEntity + entityCount, liveCount) - Math.max(0, firstEntity)) * boxesPerEntity;
};

/**
 * The start-up warm-up (VoxelGpu.warmUp): one minimal real draw of EVERY program with its real
 * state, because a driver's shader compiler may only fail at the first draw ("Error compiling
 * dynamic pixel executable") and most programs have nothing to draw when the first frame is built
 * (no guests, ghost, draft or lights yet). Linking proves nothing about that.
 */
export type WarmDraw = 'world' | 'cut' | 'figure' | 'shadow' | 'draft' | 'ghostXray' | 'ghost' | 'front' | 'frontComposite' | 'light' | 'composite' | 'upscale';

/** The program each warm-up draw exercises (the plan must cover them all, see drawPlan.test.ts). */
export const WARM_DRAW_PROGRAM: Readonly<Record<WarmDraw, VoxelProgramName>> = {
  world: 'worldOpaque',
  cut: 'worldCut',
  figure: 'figureOpaque',
  shadow: 'figureDither',
  draft: 'worldDither',
  ghostXray: 'worldDither',
  ghost: 'worldDither',
  front: 'worldFront',
  frontComposite: 'compositeFront',
  light: 'lightPass',
  composite: 'composite',
  upscale: 'upscale',
};

export interface WarmPlanOptions {
  /** The light pass runs at all (not with the lite composite, nor after it failed). */
  lights: boolean;
  /** The figure shadow decals are drawn (not after their program failed). */
  shadows: boolean;
  /** The see-through cutaway's program is in use (default true; not after its program failed). */
  seeThrough?: boolean;
  /** The translucent see-through's front layer is built (its two programs are in use). Default false. */
  translucent?: boolean;
}

/**
 * The draws of a warm-up, in pass order. The ghost's x-ray state (depth func GREATER, no depth
 * write) is its own entry: it is a different pipeline state of the same program. Programs the
 * pipeline gave up on are not drawn, so a retry after degrading is judged on what it still uses.
 */
export const planWarmUp = ({ lights, shadows, seeThrough = true, translucent = false }: WarmPlanOptions): readonly WarmDraw[] => {
  const plan: WarmDraw[] = ['world'];
  if (seeThrough) plan.push('cut');
  plan.push('figure');
  if (shadows) plan.push('shadow');
  plan.push('draft', 'ghostXray', 'ghost');
  // The front layer's geometry and its own light pass run right after the G-buffer, before the light pass.
  if (seeThrough && translucent) plan.push('front', 'frontComposite');
  if (lights) plan.push('light');
  plan.push('composite', 'upscale');
  return plan;
};

/** Whether the light pass runs: the lite composite has no light pools to add them to. */
export const lightPassActive = (compositeVariant: 'full' | 'lite', skipLights: boolean): boolean =>
  compositeVariant === 'full' && !skipLights;

/** What one frame of the voxel pipeline did, for the performance overlay and the harness gates. */
export interface VoxelGpuStats {
  /** Draw calls (every encoder.draw of the frame, fullscreen passes included). */
  draws: number;
  chunksDrawn: number;
  chunksCulled: number;
  /** Chunk draws that used the see-through cut program this frame (0 while the effect is off). */
  chunksCut: number;
  /** Chunk draws into the front layer this frame (0 unless the translucent see-through is open). */
  frontDraws: number;
  /** Texels of the front layer's rectangle that were lit this frame (0 = no front layer). */
  frontTexels: number;
  /** Times the see-through uniforms were written this frame (0 on a frame where nothing moved). */
  seeThroughWrites: number;
  /** Times uView was written for this frame (1 on the frame after a turn, 0 on every steady frame). */
  viewWrites: number;
  /** Boxes submitted; ×12 is the vertex-invocation proxy of design §13. */
  boxes: number;
  lights: number;
  /** Bytes sent to data textures: dirty rows, plus whole textures after growth or a context restore. */
  uploadedBytes: number;
  /** Texels of the low-res G-buffer (and of the composite). */
  lowTexels: number;
}

export const createVoxelGpuStats = (): VoxelGpuStats => ({
  draws: 0,
  chunksDrawn: 0,
  chunksCulled: 0,
  chunksCut: 0,
  frontDraws: 0,
  frontTexels: 0,
  seeThroughWrites: 0,
  viewWrites: 0,
  boxes: 0,
  lights: 0,
  uploadedBytes: 0,
  lowTexels: 0,
});

export const resetVoxelGpuStats = (stats: VoxelGpuStats): void => {
  stats.draws = 0;
  stats.chunksDrawn = 0;
  stats.chunksCulled = 0;
  stats.chunksCut = 0;
  stats.frontDraws = 0;
  stats.frontTexels = 0;
  stats.seeThroughWrites = 0;
  stats.viewWrites = 0;
  stats.boxes = 0;
  stats.lights = 0;
  stats.uploadedBytes = 0;
  stats.lowTexels = 0;
};
