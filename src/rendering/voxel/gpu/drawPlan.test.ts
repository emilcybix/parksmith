import { describe, expect, it } from 'vitest';
import { LIGHT_PRESET_DAY, LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import { buildBoxIndices, INDICES_PER_BOX } from '../contracts/boxes';
import type { TexelBounds } from '../contracts/frame';
import {
  boundsIntersectView,
  boxDrawIndexCount,
  boxesForLights,
  chunkNeedsCut,
  clipSizeFor,
  createVoxelGpuStats,
  figureRangeBoxes,
  indexCapacityFor,
  INDICES_PER_LIGHT,
  lightDrawIndexCount,
  lightPassActive,
  lightPresetBit,
  MIN_INDEX_CAPACITY,
  planChunkDraws,
  planWarmUp,
  resetVoxelGpuStats,
  rowsForRecords,
  SHADER_TIME_WRAP_SECONDS,
  viewOfTarget,
  WARM_DRAW_PROGRAM,
  wrapShaderSeconds,
  type ChunkDrawState,
  type TexelView,
} from './drawPlan';
import { VOXEL_PROGRAM_NAMES } from './programs';
import { SUBTEXEL_STEPS } from './shaders/geometryCommon';
import { WATER_LOOP_SECONDS } from './shaders/patterns';

/**
 * The draw plan is where the GPU pipeline's cheapest mistakes would hide: a size-0 draw that Pixi
 * turns into "draw the whole index buffer", a stale entity drawn past the live count, a chunk culled
 * while still on screen, a clip mapping that makes panning shimmer. All of it is pure, so it is
 * pinned here in Node; the pixels are verified in the browser harness.
 */

/** A deterministic stream of numbers in [0, 1), so failures reproduce. */
const randomStream = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

const bounds = (minX: number, minY: number, maxX: number, maxY: number): TexelBounds => ({ minX, minY, maxX, maxY });

const view = (minX: number, minY: number, maxX: number, maxY: number): TexelView => ({ minX, minY, maxX, maxY });

describe('box draw sizes', () => {
  it('never asks Pixi for a size-0 draw: nothing to draw means no draw at all', () => {
    for (const boxes of [0, -1, Number.NaN, -0]) {
      expect(boxDrawIndexCount(boxes, false), `boxes ${boxes}`).toBe(0);
      expect(boxDrawIndexCount(boxes, true), `boxes ${boxes} (gpuMin)`).toBe(0);
      expect(lightDrawIndexCount(boxes, false), `lights ${boxes}`).toBe(0);
    }
  });

  it('draws boxes · 18 indices, or one box under gpuMin', () => {
    expect(boxDrawIndexCount(1, false)).toBe(INDICES_PER_BOX);
    expect(boxDrawIndexCount(4_321, false)).toBe(4_321 * INDICES_PER_BOX);
    expect(boxDrawIndexCount(4_321, true), 'gpuMin keeps the draw but clamps it to one box').toBe(INDICES_PER_BOX);
    expect(lightDrawIndexCount(7, false)).toBe(7 * INDICES_PER_LIGHT);
    expect(lightDrawIndexCount(7, true)).toBe(INDICES_PER_LIGHT);
  });

  it('draws lights from the box index buffer: light i is vertices 4i..4i+3 as one quad', () => {
    const indices = buildBoxIndices(boxesForLights(9));
    for (let light = 0; light < 9; light += 1) {
      const quad = Array.from(indices.subarray(light * INDICES_PER_LIGHT, (light + 1) * INDICES_PER_LIGHT));
      const q = light * 4;
      expect(quad, `light ${light}`).toEqual([q, q + 1, q + 2, q + 2, q + 1, q + 3]);
    }
    for (const lights of [0, 1, 2, 3, 4, 1_024]) {
      expect(boxesForLights(lights) * INDICES_PER_BOX, `${lights} lights fit`).toBeGreaterThanOrEqual(lights * INDICES_PER_LIGHT);
    }
  });

  it('sizes the shared index buffer to the largest draw, by powers of two, never shrinking', () => {
    expect(indexCapacityFor(0, 0)).toBe(MIN_INDEX_CAPACITY);
    expect(indexCapacityFor(MIN_INDEX_CAPACITY, MIN_INDEX_CAPACITY)).toBe(MIN_INDEX_CAPACITY);
    expect(indexCapacityFor(MIN_INDEX_CAPACITY, MIN_INDEX_CAPACITY + 1)).toBe(MIN_INDEX_CAPACITY * 2);
    expect(indexCapacityFor(MIN_INDEX_CAPACITY * 8, 10), 'never shrinks').toBe(MIN_INDEX_CAPACITY * 8);
    const random = randomStream(3);
    for (let sample = 0; sample < 200; sample += 1) {
      const current = MIN_INDEX_CAPACITY * 2 ** Math.floor(random() * 4);
      const needed = Math.floor(random() * 200_000);
      const capacity = indexCapacityFor(current, needed);
      expect(capacity, `covers ${needed}`).toBeGreaterThanOrEqual(needed);
      expect(capacity).toBeGreaterThanOrEqual(current);
      expect(Math.log2(capacity / MIN_INDEX_CAPACITY) % 1, 'power-of-two multiple').toBe(0);
    }
  });
});

describe('figure ranges', () => {
  it('draws only live entities: records at or past the live count are stale', () => {
    expect(figureRangeBoxes(0, 100, 100, 8)).toBe(800);
    expect(figureRangeBoxes(0, 100, 60, 8), 'clamped to the live count').toBe(480);
    expect(figureRangeBoxes(80, 20, 60, 8), 'a range entirely past the live count').toBe(0);
    expect(figureRangeBoxes(50, 20, 60, 7)).toBe(70);
  });

  it('draws nothing for an empty range, an empty park or a model without template boxes', () => {
    expect(figureRangeBoxes(0, 0, 100, 8)).toBe(0);
    expect(figureRangeBoxes(0, 100, 0, 8)).toBe(0);
    expect(figureRangeBoxes(0, 100, 100, 0)).toBe(0);
  });
});

describe('chunk culling and order', () => {
  it('tests closed texel rectangles, touching edges included', () => {
    const area = view(0, 0, 100, 50);
    expect(boundsIntersectView(bounds(10, 10, 20, 20), area)).toBe(true);
    expect(boundsIntersectView(bounds(-30, -30, 0, 0), area), 'corner touch').toBe(true);
    expect(boundsIntersectView(bounds(100, 50, 140, 90), area), 'far corner touch').toBe(true);
    expect(boundsIntersectView(bounds(101, 0, 140, 50), area)).toBe(false);
    expect(boundsIntersectView(bounds(0, -40, 100, -1), area)).toBe(false);
    expect(boundsIntersectView(bounds(-500, -500, 500, 500), area), 'covers the view').toBe(true);
  });

  it('covers the whole low-res target, guard band included', () => {
    const out = view(0, 0, 0, 0);
    expect(viewOfTarget(-206, 92, 653, 413, out)).toBe(out);
    expect(out).toEqual(view(-206, 92, 447, 505));
  });

  it('keeps visible non-empty chunks, nearest (largest max y) first, ties by index', () => {
    const chunks: (ChunkDrawState | null)[] = [
      { count: 10, bounds: bounds(0, 0, 50, 40) },
      null,
      { count: 0, bounds: bounds(0, 0, 50, 90) },
      { count: 5, bounds: null },
      { count: 7, bounds: bounds(0, 20, 50, 90) },
      { count: 3, bounds: bounds(500, 500, 600, 700) },
      { count: 9, bounds: bounds(-40, 10, 10, 90) },
      { count: 2, bounds: bounds(0, 0, 10, 60) },
    ];
    const order = new Int32Array(8);
    const visible = planChunkDraws(chunks, view(-20, -20, 200, 200), order);
    expect(Array.from(order.subarray(0, visible))).toEqual([4, 6, 7, 0]);
  });

  it('matches a filter-then-sort reference on random layouts, and never writes past the order array', () => {
    const random = randomStream(11);
    for (let layout = 0; layout < 200; layout += 1) {
      const chunks: (ChunkDrawState | null)[] = [];
      const count = 1 + Math.floor(random() * 40);
      for (let index = 0; index < count; index += 1) {
        if (random() < 0.1) {
          chunks.push(null);
          continue;
        }
        const minX = Math.floor(random() * 800 - 400);
        const minY = Math.floor(random() * 800 - 400);
        chunks.push({
          count: random() < 0.15 ? 0 : 1 + Math.floor(random() * 5000),
          bounds: random() < 0.1 ? null : bounds(minX, minY, minX + Math.floor(random() * 300), minY + Math.floor(random() * 300)),
        });
      }
      const area = view(-100, -100, 100 + Math.floor(random() * 200), 100 + Math.floor(random() * 200));
      const expected = chunks
        .map((chunk, index) => ({ chunk, index }))
        .filter(({ chunk }) => chunk && chunk.count > 0 && chunk.bounds && boundsIntersectView(chunk.bounds, area))
        .sort((a, b) => (b.chunk?.bounds?.maxY ?? 0) - (a.chunk?.bounds?.maxY ?? 0) || a.index - b.index)
        .map(({ index }) => index);
      const order = new Int32Array(count);
      const visible = planChunkDraws(chunks, area, order);
      expect(Array.from(order.subarray(0, visible)), `layout ${layout}`).toEqual(expected);
      const small = new Int32Array(2);
      expect(planChunkDraws(chunks, area, small), 'capped by the order array').toBeLessThanOrEqual(2);
    }
  });
});

describe('clip mapping', () => {
  it('maps through the smallest power of two covering the target, within the viewport limit', () => {
    expect(clipSizeFor(1, 16_384)).toBe(1);
    expect(clipSizeFor(64, 16_384)).toBe(64);
    expect(clipSizeFor(65, 16_384)).toBe(128);
    expect(clipSizeFor(1_293, 16_384)).toBe(2_048);
    expect(clipSizeFor(813, 16_384)).toBe(1_024);
    expect(clipSizeFor(5_000, 4_096), 'past the limit the target size is used').toBe(5_000);
  });

  /**
   * The pan-stability argument, in float32: window = ((p − c)/size · 2 − 1 + 1) · size/2 must give
   * back p − c bit for bit for every sub-texel-snapped p and integer camera c, or a rotated edge
   * passing near a texel centre flips while the camera pans. Exact for a power-of-two size; a
   * target-sized mapping (653 wide) is not, which is why the geometry passes use clipSizeFor.
   */
  it('is exact in float32 for sub-texel-snapped positions, and a non-power-of-two size is not', () => {
    const f = Math.fround;
    const windowOf = (p: number, camera: number, size: number): number => {
      const ndc = f(f(f(f(p - camera) / size) * 2) - 1);
      return f(f(ndc + 1) * f(size / 2));
    };
    const random = randomStream(29);
    let inexactTargetSized = 0;
    for (let sample = 0; sample < 20_000; sample += 1) {
      const target = 653;
      const clip = clipSizeFor(target, 16_384);
      const camera = Math.floor(random() * 4_000 - 2_000);
      const p = camera + Math.floor(random() * target * SUBTEXEL_STEPS) / SUBTEXEL_STEPS;
      expect(windowOf(p, camera, clip), `p ${p} camera ${camera}`).toBe(p - camera);
      if (windowOf(p, camera, target) !== p - camera) inexactTargetSized += 1;
    }
    expect(inexactTargetSized, 'the rounding the power-of-two size removes').toBeGreaterThan(0);
  });
});

describe('frame inputs', () => {
  it('wraps shader time at a whole number of water loops, continuously', () => {
    expect(SHADER_TIME_WRAP_SECONDS % WATER_LOOP_SECONDS).toBe(0);
    expect(wrapShaderSeconds(0)).toBe(0);
    expect(wrapShaderSeconds(1_500)).toBeCloseTo(1.5, 9);
    expect(wrapShaderSeconds(SHADER_TIME_WRAP_SECONDS * 1_000 + 250)).toBeCloseTo(0.25, 6);
    expect(wrapShaderSeconds(SHADER_TIME_WRAP_SECONDS * 1_000 * 7 - 1)).toBeLessThan(SHADER_TIME_WRAP_SECONDS);
    // The water pattern sees fract(time / loop): identical just before and after a wrap.
    const before = wrapShaderSeconds(SHADER_TIME_WRAP_SECONDS * 1_000 - 100) / WATER_LOOP_SECONDS;
    const after = wrapShaderSeconds(SHADER_TIME_WRAP_SECONDS * 1_000 + 100) / WATER_LOOP_SECONDS;
    expect((after - (before % 1) + 1) % 1).toBeCloseTo(0.2 / WATER_LOOP_SECONDS, 6);
  });

  it('turns the preset into the lights bit the light pass keeps', () => {
    expect(lightPresetBit('day')).toBe(LIGHT_PRESET_DAY);
    expect(lightPresetBit('dusk')).toBe(LIGHT_PRESET_DUSK);
    expect(lightPresetBit('night')).toBe(LIGHT_PRESET_NIGHT);
  });

  it('counts the texture rows a record list occupies', () => {
    expect(rowsForRecords(0, 2, 256)).toBe(0);
    expect(rowsForRecords(1, 2, 256)).toBe(1);
    expect(rowsForRecords(128, 2, 256)).toBe(1);
    expect(rowsForRecords(129, 2, 256)).toBe(2);
    expect(rowsForRecords(2_048, 2, 256)).toBe(16);
  });

  it('resets every per-frame counter', () => {
    const stats = createVoxelGpuStats();
    stats.draws = 13;
    stats.boxes = 1_897;
    stats.uploadedBytes = 12_288;
    stats.chunksDrawn = 4;
    stats.chunksCulled = 2;
    stats.lights = 1;
    stats.lowTexels = 99;
    resetVoxelGpuStats(stats);
    expect(stats).toEqual(createVoxelGpuStats());
  });
});

describe('the start-up warm-up plan', () => {
  it('draws every program of the pipeline at least once, so a draw-time compile failure of any is seen', () => {
    const drawn = new Set(planWarmUp({ lights: true, shadows: true, translucent: true }).map((draw) => WARM_DRAW_PROGRAM[draw]));
    expect([...drawn].sort()).toEqual([...VOXEL_PROGRAM_NAMES].sort());
  });

  it('draws the two front-layer programs only in a translucent pipeline, between the G-buffer draws and the light pass', () => {
    const plain = planWarmUp({ lights: true, shadows: true }).map((draw) => WARM_DRAW_PROGRAM[draw]);
    expect(plain).not.toContain('worldFront');
    expect(plain).not.toContain('compositeFront');
    const translucent = planWarmUp({ lights: true, shadows: true, translucent: true });
    expect(translucent).toEqual(['world', 'cut', 'figure', 'shadow', 'draft', 'ghostXray', 'ghost', 'front', 'frontComposite', 'light', 'composite', 'upscale']);
    expect(planWarmUp({ lights: true, shadows: true, seeThrough: false, translucent: true }), 'no cutaway, no front layer').not.toContain('front');
    expect(WARM_DRAW_PROGRAM.front).toBe('worldFront');
    expect(WARM_DRAW_PROGRAM.frontComposite).toBe('compositeFront');
  });

  it('draws the ghost in both its states and in pass order, composite and upscale last', () => {
    const plan = planWarmUp({ lights: true, shadows: true });
    expect(plan).toEqual(['world', 'cut', 'figure', 'shadow', 'draft', 'ghostXray', 'ghost', 'light', 'composite', 'upscale']);
    expect(new Set(plan).size, 'each draw once').toBe(plan.length);
  });

  it('leaves out the light pass and the shadow decals once their programs are given up', () => {
    expect(planWarmUp({ lights: false, shadows: true })).not.toContain('light');
    expect(planWarmUp({ lights: true, shadows: false })).not.toContain('shadow');
    const bare = planWarmUp({ lights: false, shadows: false }).map((draw) => WARM_DRAW_PROGRAM[draw]);
    expect(bare).not.toContain('lightPass');
    expect(bare).not.toContain('figureDither');
    expect(bare).toContain('composite');
  });

  it('draws the see-through cut program once, right after the plain world, unless it was given up', () => {
    expect(planWarmUp({ lights: true, shadows: true, seeThrough: true }).slice(0, 2)).toEqual(['world', 'cut']);
    const without = planWarmUp({ lights: true, shadows: true, seeThrough: false });
    expect(without).not.toContain('cut');
    expect(without.map((draw) => WARM_DRAW_PROGRAM[draw])).not.toContain('worldCut');
    expect(WARM_DRAW_PROGRAM.cut).toBe('worldCut');
  });

  it('runs the light pass only with the full composite and while its program works', () => {
    expect(lightPassActive('full', false)).toBe(true);
    expect(lightPassActive('lite', false), 'lite has no light pools to add to').toBe(false);
    expect(lightPassActive('full', true)).toBe(false);
  });
});

describe('which chunks get the see-through cut program', () => {
  const hole = view(100, 100, 200, 200);

  it('is exactly the chunks whose bounds touch the hole grown by its margin (closed rectangles)', () => {
    expect(chunkNeedsCut(bounds(150, 150, 160, 160), hole), 'inside').toBe(true);
    expect(chunkNeedsCut(bounds(0, 0, 100, 100), hole), 'touching a corner').toBe(true);
    expect(chunkNeedsCut(bounds(201, 100, 300, 200), hole), 'just right of it').toBe(false);
    expect(chunkNeedsCut(bounds(100, 201, 200, 300), hole), 'just below it').toBe(false);
    expect(chunkNeedsCut(bounds(-50, -50, 99, 99), hole), 'just above-left').toBe(false);
  });

  it('leaves a typical park almost entirely on the discard-free program', () => {
    const chunks = Array.from({ length: 64 }, (_, index) => {
      const column = index % 8;
      const row = Math.floor(index / 8);
      return bounds(column * 256, row * 128, column * 256 + 255, row * 128 + 127);
    });
    const cut = chunks.filter((chunk) => chunkNeedsCut(chunk, view(1000, 400, 1200, 520))).length;
    expect(cut, 'a hole the size of a ride touches a handful of 64 chunks').toBeLessThanOrEqual(6);
    expect(cut).toBeGreaterThan(0);
  });

  it('counts cut draws in the stats and resets them', () => {
    const stats = createVoxelGpuStats();
    expect(stats.chunksCut).toBe(0);
    stats.chunksCut = 3;
    resetVoxelGpuStats(stats);
    expect(stats.chunksCut).toBe(0);
  });
});
