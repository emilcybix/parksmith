import type { Blueprint, CompiledModel, CompiledPart, LightSource, Vec3 } from '../contracts/blueprint';
import { BOX_FLOATS, packBoxWord, STATIC_SLOT, withQuarterTurn } from '../contracts/boxes';
import { RASTER_TO_EXPOSED_RATIO } from '../contracts/budgets';
import { PLOT_TOP_Z, rotateBoxInFootprint, rotatePointInFootprint, VOXELS_PER_TILE } from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';
import { MESH_BOX_STRIDE, meshRuns, rasterArea } from './greedyMesh';
import type { MeshBoxes } from './greedyMesh';
import { countExposedFaces, hollowRuns } from './hollow';
import type { HollowNeighbours } from './hollow';
import { materialOfKey, patternOfKey, runsFromGrid, runVoxelCount, solidRowsOf, tagOfKey } from './rowRuns';
import { voxelizeShapes } from './voxelize';

/**
 * Blueprint → boxes (contracts/blueprint.ts): voxelize each part, greedy-mesh into disjoint boxes,
 * hollow where it pays, sort front-to-back.
 *
 * Per part:
 *   1. voxelize (voxelize.ts): shapes in order into a dense grid; voxel (i, j, k) is filled when its
 *      centre (i + ½, j + ½, k + ½) is inside a shape; voxels below `floorZ` are carved;
 *   2. row runs → greedy mesh (rowRuns.ts, greedyMesh.ts): disjoint boxes of one (material, pattern);
 *   3. hollow (hollow.ts) when the mesh rasterises more than RASTER_TO_EXPOSED_RATIO × the exposed
 *      faces, keeping the hollow mesh only if it has fewer than 25 % more boxes (and less raster);
 *   4. front-to-back: descending max-corner depth key (maxX + maxY + maxZ), so a real GPU's early-Z
 *      rejects what the first boxes already hide;
 *   5. BOX layout (contracts/boxes.ts) with word packBoxWord(material, 0, pattern, 0) and field 7 = colour slot tag (0 = fixed).
 *      The body (part 0) stays in model space; parts 1+ are emitted relative to their pivot.
 *
 * Everything here runs once per blueprint and quarter turn, behind the ModelCache, so it may
 * allocate; the cache lookups the frame loop makes allocate nothing.
 */

/** The hollow mesh must add fewer than this share of boxes (design §8: < 25 %). */
export const HOLLOW_MAX_BOX_GROWTH = 1.25;

/** Most boxes one part may have: the front-to-back sort packs the box index into 21 bits. */
const MAX_PART_BOXES = 2 ** 21;

/** What compiling one part cost and produced; content tests assert budgets on it. */
export interface PartCompileReport {
  id: string;
  /** Filled voxels of the part, before hollowing. */
  voxels: number;
  /** Exposed +x/+y/+z voxel faces: the texels a perfect mesh would rasterise. */
  exposedFaces: number;
  /** The solid (un-hollowed) mesh. */
  solidBoxes: number;
  solidRaster: number;
  /** The hollow mesh; null when the solid mesh was already within RASTER_TO_EXPOSED_RATIO. */
  hollowBoxes: number | null;
  hollowRaster: number | null;
  /** Interior test used if hollowing was tried: 5 for the body, 6 for moving parts. */
  hollowNeighbours: HollowNeighbours;
  hollowed: boolean;
  /** The mesh that was kept. */
  boxes: number;
  raster: number;
  /** raster / exposedFaces of the kept mesh (0 for an empty part). */
  rasterRatio: number;
  milliseconds: number;
}

export interface CompileReport {
  model: CompiledModel;
  parts: PartCompileReport[];
  milliseconds: number;
}

const ZERO: Vec3 = [0, 0, 0];

/** Rejects blueprints the renderer could not draw correctly, naming the blueprint and the part. */
const validateBlueprint = (blueprint: Blueprint): void => {
  const name = `blueprint '${blueprint.id}'`;
  if (typeof blueprint.id !== 'string' || blueprint.id.length === 0) throw new Error('blueprint: id must be a non-empty string');
  const [width, depth] = blueprint.footprint;
  // Number.isInteger is also false for anything that is not a number (JSON blueprints are untyped).
  if (!Number.isInteger(width) || !Number.isInteger(depth) || width < 1 || depth < 1) {
    throw new Error(`${name}: footprint must be two positive integers (got ${String(blueprint.footprint)})`);
  }
  if (blueprint.parts.length === 0) throw new Error(`${name}: needs at least the 'body' part`);
  if (blueprint.parts[0].id !== 'body') throw new Error(`${name}: part 0 must be 'body' (got '${blueprint.parts[0].id}')`);
  const seen = new Set<string>();
  blueprint.parts.forEach((part, index) => {
    if (seen.has(part.id)) throw new Error(`${name}: part id '${part.id}' is used twice`);
    seen.add(part.id);
    if (!part.pivot.every((component) => Number.isInteger(component))) {
      throw new Error(`${name} part '${part.id}': pivot must be on integer voxels (got ${part.pivot.join(', ')})`);
    }
    if (index === 0 && part.pivot.some((component) => component !== 0)) {
      throw new Error(`${name}: the body is static and stays in model space; its pivot must be [0, 0, 0]`);
    }
  });
  (blueprint.lights ?? []).forEach((light, index) => {
    const values = [...light.position, light.radius, light.color, light.presets];
    if (!values.every(Number.isFinite) || light.radius < 0) throw new Error(`${name}: light ${index} has a non-finite or negative value`);
  });
};

/**
 * Sorts boxes (BOX layout) front-to-back into a new array: descending max-corner depth key, ties
 * in their original order. The key and the index share one float64 so a numeric typed-array sort
 * does the work without a comparator.
 */
export const sortFrontToBack = (boxes: Float32Array, count: number): Float32Array => {
  if (count >= MAX_PART_BOXES) throw new Error(`sortFrontToBack: ${count} boxes exceed the ${MAX_PART_BOXES}-box limit`);
  const order = new Float64Array(count);
  for (let box = 0; box < count; box += 1) {
    const offset = box * BOX_FLOATS;
    const depth = boxes[offset] + boxes[offset + 4] + boxes[offset + 1] + boxes[offset + 5] + boxes[offset + 2] + boxes[offset + 6];
    order[box] = box - depth * MAX_PART_BOXES;
  }
  order.sort();
  const sorted = new Float32Array(count * BOX_FLOATS);
  for (let rank = 0; rank < count; rank += 1) {
    const packed = order[rank];
    const from = (packed - Math.floor(packed / MAX_PART_BOXES) * MAX_PART_BOXES) * BOX_FLOATS;
    const to = rank * BOX_FLOATS;
    for (let field = 0; field < BOX_FLOATS; field += 1) sorted[to + field] = boxes[from + field];
  }
  return sorted;
};

interface Bounds {
  min: Vec3;
  max: Vec3;
  sweepRadius: number;
}

/** Bounds of boxes in their own coordinates, and the farthest box corner from the origin. */
const boundsOf = (boxes: Float32Array, count: number): Bounds => {
  if (count === 0) return { min: ZERO, max: ZERO, sweepRadius: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let radiusSquared = 0;
  for (let box = 0; box < count; box += 1) {
    const offset = box * BOX_FLOATS;
    const x0 = boxes[offset];
    const y0 = boxes[offset + 1];
    const z0 = boxes[offset + 2];
    const x1 = x0 + boxes[offset + 4];
    const y1 = y0 + boxes[offset + 5];
    const z1 = z0 + boxes[offset + 6];
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    minZ = Math.min(minZ, z0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
    maxZ = Math.max(maxZ, z1);
    // The farthest corner of a box from the origin takes the larger |coordinate| on every axis.
    const farX = Math.max(Math.abs(x0), Math.abs(x1));
    const farY = Math.max(Math.abs(y0), Math.abs(y1));
    const farZ = Math.max(Math.abs(z0), Math.abs(z1));
    radiusSquared = Math.max(radiusSquared, farX * farX + farY * farY + farZ * farZ);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], sweepRadius: Math.sqrt(radiusSquared) };
};

/** Mesh boxes → BOX layout relative to `pivot`, front-to-back. */
const packMesh = (mesh: MeshBoxes, pivot: Vec3): Float32Array => {
  const unsorted = new Float32Array(mesh.count * BOX_FLOATS);
  for (let box = 0; box < mesh.count; box += 1) {
    const from = box * MESH_BOX_STRIDE;
    const to = box * BOX_FLOATS;
    const key = mesh.data[from + 6];
    unsorted[to] = mesh.data[from] - pivot[0];
    unsorted[to + 1] = mesh.data[from + 1] - pivot[1];
    unsorted[to + 2] = mesh.data[from + 2] - pivot[2];
    unsorted[to + 3] = packBoxWord(materialOfKey(key), 0, patternOfKey(key), 0);
    unsorted[to + 4] = mesh.data[from + 3] - mesh.data[from];
    unsorted[to + 5] = mesh.data[from + 4] - mesh.data[from + 1];
    unsorted[to + 6] = mesh.data[from + 5] - mesh.data[from + 2];
    // Field 7 carries the colour slot tag (0 = fixed); every consumer overwrites it with the transform slot.
    unsorted[to + 7] = tagOfKey(key);
  }
  return sortFrontToBack(unsorted, mesh.count);
};

const partFrom = (id: string, pivot: Vec3, boxes: Float32Array, boxCount: number): CompiledPart => {
  const bounds = boundsOf(boxes, boxCount);
  return { id, pivot, boxes, boxCount, min: bounds.min, max: bounds.max, sweepRadius: bounds.sweepRadius };
};

const copyLight = (light: LightSource): LightSource => ({
  position: [light.position[0], light.position[1], light.position[2]],
  radius: light.radius,
  color: light.color,
  presets: light.presets,
});

/** Highest z of the model at rest: the body's top and every moving part's top above its pivot. */
const topOf = (parts: readonly CompiledPart[], floorZ: number): number => {
  let top = -Infinity;
  for (const part of parts) if (part.boxCount > 0) top = Math.max(top, part.pivot[2] + part.max[2]);
  return top === -Infinity ? floorZ : top;
};

/** Compiles a blueprint and reports what every part cost (voxels, boxes, raster, hollowing, ms). */
export const compileBlueprintReport = (blueprint: Blueprint): CompileReport => {
  const started = performance.now();
  validateBlueprint(blueprint);
  const floorZ = blueprint.floorZ ?? PLOT_TOP_Z;
  const parts: CompiledPart[] = [];
  const reports: PartCompileReport[] = [];
  blueprint.parts.forEach((part, index) => {
    const partStarted = performance.now();
    const grid = voxelizeShapes(part.shapes, floorZ, `blueprint '${blueprint.id}' part '${part.id}'`);
    const runs = runsFromGrid(grid);
    const solid = solidRowsOf(runs);
    const exposed = countExposedFaces(solid).total;
    const solidMesh = meshRuns(runs);
    const solidRaster = rasterArea(solidMesh);
    const hollowNeighbours: HollowNeighbours = index === 0 ? 5 : 6;
    let kept = solidMesh;
    let keptRaster = solidRaster;
    let hollowBoxes: number | null = null;
    let hollowRaster: number | null = null;
    if (solidRaster > RASTER_TO_EXPOSED_RATIO * exposed) {
      const hollowMesh = meshRuns(hollowRuns(runs, solid, hollowNeighbours));
      hollowBoxes = hollowMesh.count;
      hollowRaster = rasterArea(hollowMesh);
      if (hollowMesh.count < solidMesh.count * HOLLOW_MAX_BOX_GROWTH && hollowRaster < solidRaster) {
        kept = hollowMesh;
        keptRaster = hollowRaster;
      }
    }
    const pivot: Vec3 = index === 0 ? ZERO : [part.pivot[0], part.pivot[1], part.pivot[2]];
    parts.push(partFrom(part.id, pivot, packMesh(kept, pivot), kept.count));
    reports.push({
      id: part.id,
      voxels: runVoxelCount(runs),
      exposedFaces: exposed,
      solidBoxes: solidMesh.count,
      solidRaster,
      hollowBoxes,
      hollowRaster,
      hollowNeighbours,
      hollowed: kept !== solidMesh,
      boxes: kept.count,
      raster: keptRaster,
      rasterRatio: exposed > 0 ? keptRaster / exposed : 0,
      milliseconds: performance.now() - partStarted,
    });
  });
  const model: CompiledModel = {
    blueprintId: blueprint.id,
    footprint: [blueprint.footprint[0], blueprint.footprint[1]],
    parts,
    lights: (blueprint.lights ?? []).map(copyLight),
    top: topOf(parts, floorZ),
    boxCount: parts.reduce((sum, part) => sum + part.boxCount, 0),
  };
  return { model, parts: reports, milliseconds: performance.now() - started };
};

export const compileBlueprint = (blueprint: Blueprint): CompiledModel => compileBlueprintReport(blueprint).model;

/**
 * One box list turned a quarter: `footprintWidth` > 0 turns model-space boxes inside the footprint
 * (rotateBoxInFootprint); 0 turns pivot-relative boxes by the linear part alone, (x, y) → (y, −x),
 * which is the same formula with W = 0. The box words take the turn so directional patterns follow.
 */
const rotateBoxes = (boxes: Float32Array, count: number, footprintWidth: number): Float32Array => {
  const turned = new Float32Array(count * BOX_FLOATS);
  for (let box = 0; box < count; box += 1) {
    const offset = box * BOX_FLOATS;
    const rotated = rotateBoxInFootprint(boxes[offset], boxes[offset + 1], boxes[offset + 4], boxes[offset + 5], 1, footprintWidth);
    const word = boxes[offset + 3];
    turned[offset] = rotated.minX;
    turned[offset + 1] = rotated.minY;
    turned[offset + 2] = boxes[offset + 2];
    turned[offset + 3] = withQuarterTurn(word, (((word >>> 21) & 3) + 1) & 3);
    turned[offset + 4] = rotated.sizeX;
    turned[offset + 5] = rotated.sizeY;
    turned[offset + 6] = boxes[offset + 6];
    turned[offset + 7] = boxes[offset + 7];
  }
  return sortFrontToBack(turned, count);
};

/**
 * Exact visual quarter turn of a compiled model inside its footprint (space.ts): q = 1 maps model
 * (x, y) to (y, W − x) with W = 32 · footprint[0]. The body's boxes turn inside the footprint;
 * every moving part's pivot turns the same way and its pivot-relative boxes turn about the pivot
 * by the linear part, so at rest each voxel lands exactly where the turned body voxel would
 * (scene/rigid.ts `writeRotatedPartTransform` poses such parts). Light positions turn too, so a
 * consumer only ever adds the placement origin. The result's footprint is the turned one
 * (footprintSize for odd rotations), so turning it again is a 180° turn. Boxes are re-sorted
 * front-to-back, and q = 0 returns the model itself.
 */
export const rotateModel = (model: CompiledModel, quarterTurn: QuarterTurn): CompiledModel => {
  if (quarterTurn === 0) return model;
  const width = VOXELS_PER_TILE * model.footprint[0];
  const parts = model.parts.map((part, index): CompiledPart => {
    if (index === 0) return partFrom(part.id, ZERO, rotateBoxes(part.boxes, part.boxCount, width), part.boxCount);
    const pivot = rotatePointInFootprint(part.pivot[0], part.pivot[1], 1, width);
    return partFrom(part.id, [pivot.x, pivot.y, part.pivot[2]], rotateBoxes(part.boxes, part.boxCount, 0), part.boxCount);
  });
  const lights = model.lights.map((light): LightSource => {
    const position = rotatePointInFootprint(light.position[0], light.position[1], 1, width);
    return { ...copyLight(light), position: [position.x, position.y, light.position[2]] };
  });
  return {
    blueprintId: model.blueprintId,
    footprint: [model.footprint[1], model.footprint[0]],
    parts,
    lights,
    top: model.top,
    boxCount: model.boxCount,
  };
};

/** Every part at rest, in model space, slot 0 — the ghost preview and at-rest checks. */
export interface FlatModel {
  boxes: Float32Array;
  boxCount: number;
  /**
   * Phase 28: the colour slot tag of every box (0 = fixed), aligned with `boxes` after the front-to-back sort, or
   * null when no box is tagged. A flat list's field 7 holds the transform slot (always 0), so the tags live
   * here: a recoloured ghost, car or gate is the same list with the tagged boxes' material bytes swapped.
   */
  tags: Uint8Array | null;
}

/**
 * Every part at rest in one model-space list: the body as it is, each moving part's boxes moved
 * back by its pivot, all slot 0, sorted front-to-back like any other box list.
 */
export const flattenAtRest = (model: CompiledModel): FlatModel => {
  const boxCount = model.parts.reduce((sum, part) => sum + part.boxCount, 0);
  const flat = new Float32Array(boxCount * BOX_FLOATS);
  let to = 0;
  for (const part of model.parts) {
    const [pivotX, pivotY, pivotZ] = part.pivot;
    for (let from = 0; from < part.boxCount * BOX_FLOATS; from += BOX_FLOATS, to += BOX_FLOATS) {
      flat[to] = part.boxes[from] + pivotX;
      flat[to + 1] = part.boxes[from + 1] + pivotY;
      flat[to + 2] = part.boxes[from + 2] + pivotZ;
      flat[to + 3] = part.boxes[from + 3];
      flat[to + 4] = part.boxes[from + 4];
      flat[to + 5] = part.boxes[from + 5];
      flat[to + 6] = part.boxes[from + 6];
      // Field 7 carries the colour slot tag through the sort (it never takes part in the order) and is
      // reset to the static slot below, so `boxes` is byte-identical to a model without tags.
      flat[to + 7] = part.boxes[from + 7];
    }
  }
  const boxes = sortFrontToBack(flat, boxCount);
  let tags: Uint8Array | null = null;
  for (let box = 0; box < boxCount; box += 1) {
    const at = box * BOX_FLOATS + 7;
    const tag = boxes[at];
    if (tag !== 0) {
      tags ??= new Uint8Array(boxCount);
      tags[box] = tag;
    }
    boxes[at] = STATIC_SLOT;
  }
  return { boxes, boxCount, tags };
};

/**
 * Compiled models by (blueprint id, quarter turn). Survives session swaps; compiles synchronously on
 * a miss, and `prewarm` spends at most `budgetMs` per call compiling ahead of need.
 */
export interface ModelCache {
  model(blueprint: Blueprint, quarterTurn: QuarterTurn): CompiledModel;
  flat(blueprint: Blueprint, quarterTurn: QuarterTurn): FlatModel;
  isReady(blueprintId: string, quarterTurn: QuarterTurn): boolean;
  /** Compiles queued blueprints (both quarter turns) until the budget is spent; returns how many remain. */
  prewarm(queue: readonly Blueprint[], budgetMs: number): number;
  readonly compiledCount: number;
}

interface CacheEntry {
  models: [CompiledModel | null, CompiledModel | null];
  flats: [FlatModel | null, FlatModel | null];
}

/**
 * The cache the renderer owns (one per renderer, never a module-level instance, so tests and
 * remounts start clean). Keyed by blueprint id, which contracts/blueprint.ts makes unique per
 * builder and parameters. Quarter turn 0 is compiled; quarter turn 1 is rotateModel of it; flat
 * models are built on first use. Hits return the same objects every time (the ghost upload keys on
 * the identity of `flat(...).boxes`) and allocate nothing.
 */
class BlueprintModelCache implements ModelCache {
  private readonly entries = new Map<string, CacheEntry>();
  private compiled = 0;

  get compiledCount(): number {
    return this.compiled;
  }

  model(blueprint: Blueprint, quarterTurn: QuarterTurn): CompiledModel {
    const entry = this.entryFor(blueprint);
    const cached = entry.models[quarterTurn];
    if (cached !== null) return cached;
    const base = entry.models[0] ?? this.compileInto(entry, blueprint);
    const turned = rotateModel(base, quarterTurn);
    entry.models[quarterTurn] = turned;
    return turned;
  }

  flat(blueprint: Blueprint, quarterTurn: QuarterTurn): FlatModel {
    const entry = this.entryFor(blueprint);
    const cached = entry.flats[quarterTurn];
    if (cached !== null) return cached;
    const flat = flattenAtRest(this.model(blueprint, quarterTurn));
    entry.flats[quarterTurn] = flat;
    return flat;
  }

  isReady(blueprintId: string, quarterTurn: QuarterTurn): boolean {
    const entry = this.entries.get(blueprintId);
    return entry !== undefined && entry.models[quarterTurn] !== null;
  }

  /**
   * The clock is read between blueprints only, so a blueprint always finishes once started, and
   * with any positive budget the first one not yet ready always starts: every call makes progress
   * even when a single compile is longer than the slice.
   */
  prewarm(queue: readonly Blueprint[], budgetMs: number): number {
    const started = performance.now();
    let compiledHere = 0;
    let remaining = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const blueprint = queue[index];
      if (this.isReady(blueprint.id, 0) && this.isReady(blueprint.id, 1)) continue;
      if (budgetMs > 0 && (compiledHere === 0 || performance.now() - started < budgetMs)) {
        this.model(blueprint, 0);
        this.model(blueprint, 1);
        compiledHere += 1;
      } else {
        remaining += 1;
      }
    }
    return remaining;
  }

  private entryFor(blueprint: Blueprint): CacheEntry {
    let entry = this.entries.get(blueprint.id);
    if (entry === undefined) {
      entry = { models: [null, null], flats: [null, null] };
      this.entries.set(blueprint.id, entry);
    }
    return entry;
  }

  private compileInto(entry: CacheEntry, blueprint: Blueprint): CompiledModel {
    const model = compileBlueprint(blueprint);
    this.compiled += 1;
    entry.models[0] = model;
    return model;
  }
}

export const createModelCache = (): ModelCache => new BlueprintModelCache();
