import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_CATALOG } from '../../../game/content/catalog';
import { footprintSize } from '../../../game/types';
import type { Rotation } from '../../../game/types';
import { slotted, tagOfShape, materialOfShape } from '../contracts/blueprint';
import type { Blueprint, CompiledModel, CompiledPart, Vec3 } from '../contracts/blueprint';
import { BOX_FLOATS, packBoxWord, unpackBoxWord } from '../contracts/boxes';
import { RASTER_TO_EXPOSED_RATIO } from '../contracts/budgets';
import { MAT, PATTERN } from '../contracts/palette';
import { PLOT_TOP_Z, rotatePointInFootprint, visualQuarterTurn, VOXELS_PER_TILE } from '../contracts/space';
import {
  compileBlueprint,
  compileBlueprintReport,
  createModelCache,
  flattenAtRest,
  HOLLOW_MAX_BOX_GROWTH,
  rotateModel,
} from './compile';
import type { FlatModel } from './compile';
import { patternOfKey, runKeyOf, tagOfKey } from './rowRuns';
import { SAMPLE_BLUEPRINTS, SAMPLE_KIOSK, SAMPLE_TREE, SAMPLE_WHEEL } from './samples';
import { filledVoxelCount, voxelizeShapes } from './voxelize';

/**
 * The compiler's output is what the GPU draws and what every later wave builds on: the BOX layout
 * and word, pivot-relative moving parts, front-to-back order, hollowing only where it pays, exact
 * quarter turns inside the footprint (space.ts), the ghost's flat list and a cache that compiles
 * each blueprint once. Voxel-level comparisons make each promise exact rather than approximate.
 */

type VoxelMap = Map<string, number>;

/** Every voxel the boxes cover, offset by `origin`, → box word; throws on a voxel covered twice. */
const coveredVoxels = (boxes: Float32Array, count: number, origin: Vec3 = [0, 0, 0], into: VoxelMap = new Map()): VoxelMap => {
  for (let box = 0; box < count; box += 1) {
    const offset = box * BOX_FLOATS;
    const minX = boxes[offset] + origin[0];
    const minY = boxes[offset + 1] + origin[1];
    const minZ = boxes[offset + 2] + origin[2];
    for (let z = minZ; z < minZ + boxes[offset + 6]; z += 1) {
      for (let y = minY; y < minY + boxes[offset + 5]; y += 1) {
        for (let x = minX; x < minX + boxes[offset + 4]; x += 1) {
          const key = `${x},${y},${z}`;
          if (into.has(key)) throw new Error(`voxel ${key} is covered twice`);
          into.set(key, boxes[offset + 3]);
        }
      }
    }
  }
  return into;
};

/** A part's voxels at rest in model space. */
const partVoxels = (part: CompiledPart): VoxelMap => coveredVoxels(part.boxes, part.boxCount, part.pivot);

const flatVoxels = (flat: FlatModel): VoxelMap => coveredVoxels(flat.boxes, flat.boxCount);

/** Voxels with the quarter turn dropped from the word, so turned and unturned lists compare. */
const withoutTurn = (voxels: VoxelMap): VoxelMap => new Map([...voxels].map(([key, word]) => [key, word % 2_097_152]));

const mapKeys = (voxels: VoxelMap, transform: (x: number, y: number, z: number) => Vec3): VoxelMap =>
  new Map([...voxels].map(([key, word]) => [transform(...(key.split(',').map(Number) as [number, number, number])).join(','), word]));

const depthKeys = (boxes: Float32Array, count: number): number[] =>
  Array.from({ length: count }, (_unused, box) => {
    const offset = box * BOX_FLOATS;
    return boxes[offset] + boxes[offset + 4] + boxes[offset + 1] + boxes[offset + 5] + boxes[offset + 2] + boxes[offset + 6];
  });

const isFrontToBack = (boxes: Float32Array, count: number): boolean =>
  depthKeys(boxes, count).every((key, index, keys) => index === 0 || key <= keys[index - 1]);

/** [min, max] corner over a box list. */
const boundsOfBoxes = (boxes: Float32Array, count: number): [Vec3, Vec3] => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let box = 0; box < count; box += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], boxes[box * BOX_FLOATS + axis]);
      max[axis] = Math.max(max[axis], boxes[box * BOX_FLOATS + axis] + boxes[box * BOX_FLOATS + 4 + axis]);
    }
  }
  return [[min[0], min[1], min[2]], [max[0], max[1], max[2]]];
};

const ARM_BLUEPRINT: Blueprint = {
  id: 'test:arm',
  footprint: [1, 1],
  parts: [
    { id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [2, 2, 1], size: [10, 6, 4], material: 7, pattern: PATTERN.ROOF }] },
    { id: 'arm', pivot: [20, 20, 10], shapes: [{ kind: 'box', min: [18, 19, 10], size: [4, 2, 6], material: 9 }] },
  ],
  lights: [{ position: [4.5, 6, 3], radius: 12, color: 0xffe66d, presets: 6 }],
};

describe('compileBlueprint', () => {
  it('emits the BOX layout: model-space body, pivot-relative parts, group 0 and quarter turn 0, slot 0', () => {
    const model = compileBlueprint(ARM_BLUEPRINT);
    const [body, arm] = model.parts;
    expect(Array.from(body.boxes)).toEqual([2, 2, 1, packBoxWord(7, 0, PATTERN.ROOF, 0), 10, 6, 4, 0]);
    expect([body.id, body.pivot, body.min, body.max]).toEqual(['body', [0, 0, 0], [2, 2, 1], [12, 8, 5]]);
    expect(body.sweepRadius).toBeCloseTo(Math.hypot(12, 8, 5), 9);
    expect(Array.from(arm.boxes), 'min − pivot, default pattern PLAIN').toEqual([-2, -1, 0, packBoxWord(9, 0, PATTERN.PLAIN, 0), 4, 2, 6, 0]);
    expect([arm.id, arm.pivot, arm.min, arm.max, arm.boxCount]).toEqual(['arm', [20, 20, 10], [-2, -1, 0], [2, 1, 6], 1]);
    expect(arm.sweepRadius).toBeCloseTo(Math.hypot(2, 1, 6), 9);
    expect(model.top, 'the arm at rest reaches z 16').toBe(16);
    expect([model.blueprintId, model.footprint, model.boxCount]).toEqual(['test:arm', [1, 1], 2]);
    expect(model.lights).toEqual(ARM_BLUEPRINT.lights);
    expect(model.lights[0].position, 'lights are copied, not shared').not.toBe(ARM_BLUEPRINT.lights?.[0].position);
  });

  it.each(SAMPLE_BLUEPRINTS.map((blueprint) => [blueprint.id, blueprint] as const))(
    'covers exactly the voxels of every part of %s (minus the interior if hollowed) with disjoint boxes of their material and pattern',
    (_name, blueprint) => {
      const report = compileBlueprintReport(blueprint);
      const model = report.model;
      blueprint.parts.forEach((part, index) => {
        const grid = voxelizeShapes(part.shapes, blueprint.floorZ ?? PLOT_TOP_Z);
        const expected: VoxelMap = new Map();
        for (let k = 0; k < grid.sizeZ; k += 1) {
          for (let j = 0; j < grid.sizeY; j += 1) {
            for (let i = 0; i < grid.sizeX; i += 1) {
              const at = (k * grid.sizeY + j) * grid.sizeX + i;
              if (grid.material[at] !== 0) expected.set(`${grid.originX + i},${grid.originY + j},${grid.originZ + k}`, packBoxWord(grid.material[at], 0, grid.pattern[at], 0));
            }
          }
        }
        const { hollowed, hollowNeighbours } = report.parts[index];
        if (hollowed) {
          const directions = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, 1], ...(hollowNeighbours === 6 ? [[0, 0, -1]] : [])];
          const interior = [...expected.keys()].filter((key) => {
            const [x, y, z] = key.split(',').map(Number);
            return directions.every(([dx, dy, dz]) => expected.has(`${x + dx},${y + dy},${z + dz}`));
          });
          for (const key of interior) expected.delete(key);
        }
        const compiled = model.parts[index];
        expect(partVoxels(compiled), `${part.id}${hollowed ? ' (hollowed)' : ''}`).toEqual(expected);
        expect(compiled.boxes.length).toBe(compiled.boxCount * BOX_FLOATS);
        for (let box = 0; box < compiled.boxCount; box += 1) expect(compiled.boxes[box * BOX_FLOATS + 7], 'slot').toBe(0);
      });
      expect(model.boxCount).toBe(model.parts.reduce((sum, part) => sum + part.boxCount, 0));
    },
  );

  it('sorts every box list front-to-back by descending max-corner depth key', () => {
    for (const blueprint of SAMPLE_BLUEPRINTS) {
      const model = compileBlueprint(blueprint);
      for (const quarterTurn of [0, 1] as const) {
        const turned = rotateModel(model, quarterTurn);
        for (const part of turned.parts) expect(isFrontToBack(part.boxes, part.boxCount), `${blueprint.id} ${part.id} q${quarterTurn}`).toBe(true);
        const flat = flattenAtRest(turned);
        expect(isFrontToBack(flat.boxes, flat.boxCount), `${blueprint.id} flat q${quarterTurn}`).toBe(true);
      }
    }
  });

  it('hollows only where the solid mesh rasterises more than 3× its exposed faces and the hollow one adds < 25 % boxes', () => {
    const tree = compileBlueprintReport(SAMPLE_TREE).parts[0];
    expect(tree.solidRaster, 'the solid tree overdraws').toBeGreaterThan(RASTER_TO_EXPOSED_RATIO * tree.exposedFaces);
    expect(tree.hollowed).toBe(true);
    expect(tree.hollowBoxes).toBeLessThan(tree.solidBoxes * HOLLOW_MAX_BOX_GROWTH);
    expect([tree.boxes, tree.raster]).toEqual([tree.hollowBoxes, tree.hollowRaster]);
    expect(tree.rasterRatio).toBeLessThan(tree.solidRaster / tree.exposedFaces);

    const kiosk = compileBlueprintReport(SAMPLE_KIOSK).parts[0];
    expect(kiosk.solidRaster, 'the solid gable overdraws').toBeGreaterThan(RASTER_TO_EXPOSED_RATIO * kiosk.exposedFaces);
    expect(kiosk.hollowBoxes, 'hollowing was tried').not.toBeNull();
    expect(kiosk.hollowBoxes ?? 0, 'but it needs too many boxes').toBeGreaterThanOrEqual(kiosk.solidBoxes * HOLLOW_MAX_BOX_GROWTH);
    expect([kiosk.hollowed, kiosk.boxes, kiosk.raster]).toEqual([false, kiosk.solidBoxes, kiosk.solidRaster]);

    const block = compileBlueprintReport({
      id: 'test:block',
      footprint: [1, 1],
      parts: [{ id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [0, 0, 1], size: [20, 20, 20], material: 3 }] }],
    }).parts[0];
    expect([block.boxes, block.hollowBoxes, block.rasterRatio], 'one box is already its own surface').toEqual([1, null, 1]);

    const wheel = compileBlueprintReport(SAMPLE_WHEEL);
    expect(wheel.parts.map((part) => part.hollowNeighbours), 'the body is seen from above only; moving parts may tip').toEqual([5, ...wheel.parts.slice(1).map(() => 6)]);
  });

  it('reports what it kept: boxes, raster and voxels agree with the compiled parts', () => {
    for (const blueprint of SAMPLE_BLUEPRINTS) {
      const report = compileBlueprintReport(blueprint);
      report.parts.forEach((part, index) => {
        const compiled = report.model.parts[index];
        let raster = 0;
        for (let box = 0; box < compiled.boxCount; box += 1) {
          const [sizeX, sizeY, sizeZ] = compiled.boxes.subarray(box * BOX_FLOATS + 4, box * BOX_FLOATS + 7);
          raster += sizeX * sizeY + sizeY * sizeZ + sizeZ * sizeX;
        }
        const solidVoxels = filledVoxelCount(voxelizeShapes(blueprint.parts[index].shapes, blueprint.floorZ ?? PLOT_TOP_Z));
        expect([part.id, part.boxes, part.raster, part.voxels]).toEqual([compiled.id, compiled.boxCount, raster, solidVoxels]);
        if (!part.hollowed) expect(partVoxels(compiled).size).toBe(solidVoxels);
        expect(part.rasterRatio).toBeCloseTo(raster / part.exposedFaces, 9);
      });
    }
  });

  it('carves below floorZ, PLOT_TOP_Z by default, and keeps car models that set floorZ 0', () => {
    const post = (floorZ?: number): Blueprint => ({
      id: `test:post:${floorZ}`,
      footprint: [1, 1],
      floorZ,
      parts: [{ id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [4, 4, -3], size: [2, 2, 8], material: 5 }] }],
    });
    expect(compileBlueprint(post()).parts[0].min).toEqual([4, 4, PLOT_TOP_Z]);
    expect(compileBlueprint(post(0)).parts[0].min).toEqual([4, 4, 0]);
    expect(compileBlueprint(post(0)).parts[0].max).toEqual([6, 6, 5]);
  });

  it('compiles an empty part to no boxes and puts an empty model at its floor', () => {
    const model = compileBlueprint({
      id: 'test:empty',
      footprint: [2, 1],
      parts: [
        { id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [0, 0, 1], size: [4, 4, 4], material: 0 }] },
        { id: 'buried', pivot: [5, 5, 0], shapes: [{ kind: 'box', min: [0, 0, -9], size: [4, 4, 4], material: 3 }] },
      ],
    });
    expect(model.parts.map((part) => [part.boxCount, part.min, part.max, part.sweepRadius])).toEqual([[0, [0, 0, 0], [0, 0, 0], 0], [0, [0, 0, 0], [0, 0, 0], 0]]);
    expect([model.boxCount, model.top]).toEqual([0, PLOT_TOP_Z]);
    expect(flattenAtRest(rotateModel(model, 1)).boxCount).toBe(0);
  });

  it('rejects blueprints it cannot draw correctly, naming the blueprint and part', () => {
    const body = ARM_BLUEPRINT.parts[0];
    const arm = ARM_BLUEPRINT.parts[1];
    const variant = (overrides: Partial<Blueprint>): Blueprint => ({ ...ARM_BLUEPRINT, ...overrides });
    expect(() => compileBlueprint(variant({ parts: [] }))).toThrow(/'test:arm': needs at least the 'body' part/);
    expect(() => compileBlueprint(variant({ parts: [arm, body] }))).toThrow(/part 0 must be 'body'/);
    expect(() => compileBlueprint(variant({ parts: [body, arm, arm] }))).toThrow(/'arm' is used twice/);
    expect(() => compileBlueprint(variant({ parts: [body, { ...arm, pivot: [20.5, 20, 10] }] }))).toThrow(/part 'arm': pivot must be on integer voxels/);
    expect(() => compileBlueprint(variant({ parts: [{ ...body, pivot: [1, 0, 0] }] }))).toThrow(/body is static/);
    expect(() => compileBlueprint(variant({ footprint: [0, 1] }))).toThrow(/footprint/);
    expect(() => compileBlueprint(variant({ lights: [{ position: [0, Number.NaN, 0], radius: 4, color: 0, presets: 1 }] }))).toThrow(/light 0/);
    expect(() => compileBlueprint(variant({ parts: [body, { ...arm, shapes: [{ kind: 'box', min: [0, 0, 0], size: [1, 1, 1], material: 2048 }] }] })))
      .toThrow(/blueprint 'test:arm' part 'arm' shape 0 \(box\): material/);
  });
});

describe('rotateModel', () => {
  it('lands every catalog footprint on 32 · footprintSize(definition, rotation)', () => {
    const footprints = new Map(BUILD_CATALOG.map((definition) => [definition.footprint.join('×'), definition]));
    expect(footprints.size, 'the catalog has several footprint shapes').toBeGreaterThan(3);
    for (const definition of footprints.values()) {
      const width = definition.footprint[0] * VOXELS_PER_TILE;
      const depth = definition.footprint[1] * VOXELS_PER_TILE;
      const model = compileBlueprint({
        id: `test:footprint:${definition.id}`,
        footprint: definition.footprint,
        parts: [
          { id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [0, 0, 1], size: [width, depth, 3], material: 4 }] },
          { id: 'top', pivot: [width / 2, depth / 2, 4], shapes: [{ kind: 'box', min: [0, 0, 4], size: [width, depth, 2], material: 5 }] },
        ],
      });
      for (const rotation of [0, 1, 2, 3] as Rotation[]) {
        const turned = rotateModel(model, visualQuarterTurn(rotation));
        const [tilesX, tilesY] = footprintSize(definition, rotation);
        const expectedMax: Vec3 = [tilesX * VOXELS_PER_TILE, tilesY * VOXELS_PER_TILE, 4];
        expect(turned.footprint, `${definition.id} r${rotation}`).toEqual(footprintSize(definition, rotation));
        expect([turned.parts[0].min, turned.parts[0].max], `${definition.id} r${rotation} body`).toEqual([[0, 0, 1], expectedMax]);
        const flat = flattenAtRest(turned);
        expect(boundsOfBoxes(flat.boxes, flat.boxCount), `${definition.id} r${rotation} with the moving part at rest`)
          .toEqual([[0, 0, 1], [expectedMax[0], expectedMax[1], 6]]);
      }
    }
  });

  it('turns twice into the 180° turn of every voxel, pivot and light', () => {
    for (const blueprint of [...SAMPLE_BLUEPRINTS, ARM_BLUEPRINT]) {
      const model = compileBlueprint(blueprint);
      const width = model.footprint[0] * VOXELS_PER_TILE;
      const depth = model.footprint[1] * VOXELS_PER_TILE;
      expect(rotateModel(model, 0), 'a zero turn is the model itself').toBe(model);
      const twice = rotateModel(rotateModel(model, 1), 1);
      expect(twice.footprint).toEqual(model.footprint);
      expect(withoutTurn(flatVoxels(flattenAtRest(twice))), blueprint.id)
        .toEqual(mapKeys(flatVoxels(flattenAtRest(model)), (x, y, z) => [width - 1 - x, depth - 1 - y, z]));
      twice.parts.slice(1).forEach((part, index) => {
        const pivot = model.parts[index + 1].pivot;
        expect(part.pivot, `${blueprint.id} ${part.id}`).toEqual([width - pivot[0], depth - pivot[1], pivot[2]]);
      });
      twice.lights.forEach((light, index) => {
        const [x, y, z] = model.lights[index].position;
        expect(light.position).toEqual([width - x, depth - y, z]);
      });
      for (let box = 0; box < twice.parts[0].boxCount; box += 1) expect(unpackBoxWord(twice.parts[0].boxes[box * BOX_FLOATS + 3]).quarterTurn).toBe(2);
    }
  });

  it('turns the front (+y) faces into world +x faces, moving parts included', () => {
    for (const blueprint of [SAMPLE_KIOSK, SAMPLE_WHEEL]) {
      const model = compileBlueprint(blueprint);
      const width = model.footprint[0] * VOXELS_PER_TILE;
      const exposedOn = (voxels: VoxelMap, dx: number, dy: number): Set<string> => new Set([...voxels.keys()].filter((key) => {
        const [x, y, z] = key.split(',').map(Number);
        return !voxels.has(`${x + dx},${y + dy},${z}`);
      }));
      const front = exposedOn(flatVoxels(flattenAtRest(model)), 0, 1);
      const turned = exposedOn(flatVoxels(flattenAtRest(rotateModel(model, 1))), 1, 0);
      expect(turned, blueprint.id).toEqual(new Set([...front].map((key) => {
        const [x, y, z] = key.split(',').map(Number);
        return `${y},${width - 1 - x},${z}`;
      })));
    }
    // The kiosk's window is on its front, so a quarter turn shows it on the +x side.
    const window = compileBlueprint(SAMPLE_KIOSK).parts[0];
    const glassAt = (part: CompiledPart): VoxelMap => new Map([...partVoxels(part)].filter(([, word]) => unpackBoxWord(word).material === MAT.GLASS));
    const glass = glassAt(window);
    const turnedGlass = glassAt(rotateModel(compileBlueprint(SAMPLE_KIOSK), 1).parts[0]);
    expect([...glass.keys()].every((key) => key.split(',')[1] === '59')).toBe(true);
    expect([...turnedGlass.keys()].every((key) => key.split(',')[0] === '59')).toBe(true);
  });

  it('turns moving parts about their pivot so the model turns as one rigid piece at rest', () => {
    for (const blueprint of [SAMPLE_WHEEL, ARM_BLUEPRINT]) {
      const model = compileBlueprint(blueprint);
      const width = model.footprint[0] * VOXELS_PER_TILE;
      const turned = rotateModel(model, 1);
      expect(withoutTurn(flatVoxels(flattenAtRest(turned))))
        .toEqual(mapKeys(flatVoxels(flattenAtRest(model)), (x, y, z) => [y, width - 1 - x, z]));
      turned.parts.forEach((part, index) => {
        const original = model.parts[index];
        const pivot = index === 0 ? { x: 0, y: 0 } : rotatePointInFootprint(original.pivot[0], original.pivot[1], 1, width);
        expect(part.pivot).toEqual([pivot.x, pivot.y, original.pivot[2]]);
        if (index > 0) expect(part.sweepRadius, 'a turn about the pivot keeps the sweep').toBeCloseTo(original.sweepRadius, 9);
        const words = (compiled: CompiledPart): number[] =>
          Array.from({ length: compiled.boxCount }, (_unused, box) => compiled.boxes[box * BOX_FLOATS + 3]).sort((a, b) => a - b);
        expect(words(part).map((word) => unpackBoxWord(word)), 'material, pattern and group kept; quarter turn 1')
          .toEqual(words(original).map((word) => ({ ...unpackBoxWord(word), quarterTurn: 1 })));
      });
    }
    const arm = rotateModel(compileBlueprint(ARM_BLUEPRINT), 1).parts[1];
    expect(Array.from(arm.boxes), '(x, y) → (y, −x) about the pivot').toEqual([-1, -2, 0, packBoxWord(9, 0, 0, 1), 2, 4, 6, 0]);
    expect([arm.min, arm.max]).toEqual([[-1, -2, 0], [1, 2, 6]]);
  });
});

describe('flattenAtRest', () => {
  it('puts every part at rest into one model-space list, all slot 0', () => {
    const flat = flattenAtRest(compileBlueprint(ARM_BLUEPRINT));
    expect(flat.boxCount).toBe(2);
    expect(Array.from(flat.boxes.subarray(0, BOX_FLOATS)), 'the arm back at its authored place, nearer the camera, first').toEqual([18, 19, 10, packBoxWord(9, 0, 0, 0), 4, 2, 6, 0]);
    for (const blueprint of SAMPLE_BLUEPRINTS) {
      const model = compileBlueprint(blueprint);
      const flatModel = flattenAtRest(model);
      expect(flatModel.boxCount, blueprint.id).toBe(model.boxCount);
      const union: VoxelMap = new Map();
      for (const part of model.parts) coveredVoxels(part.boxes, part.boxCount, part.pivot, union);
      expect(flatVoxels(flatModel), `${blueprint.id}: no two parts overlap at rest`).toEqual(union);
    }
  });
});

describe('model cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('compiles each blueprint once and returns the same objects on every hit', () => {
    const cache = createModelCache();
    expect(cache.isReady(SAMPLE_TREE.id, 0)).toBe(false);
    const model = cache.model(SAMPLE_TREE, 0);
    expect(cache.model(SAMPLE_TREE, 0)).toBe(model);
    expect(cache.model({ ...SAMPLE_TREE }, 0), 'keyed by id: content may build a new object per call').toBe(model);
    const turned = cache.model(SAMPLE_TREE, 1);
    expect(turned).toEqual(rotateModel(model, 1));
    expect(cache.model(SAMPLE_TREE, 1)).toBe(turned);
    expect(cache.compiledCount, 'quarter turn 1 is derived, not recompiled').toBe(1);
    const flat = cache.flat(SAMPLE_TREE, 1);
    expect(cache.flat(SAMPLE_TREE, 1)).toBe(flat);
    expect(flat).toEqual(flattenAtRest(turned));
    expect([cache.isReady(SAMPLE_TREE.id, 0), cache.isReady(SAMPLE_TREE.id, 1), cache.isReady(SAMPLE_KIOSK.id, 0)]).toEqual([true, true, false]);
    const flatFirst = createModelCache();
    flatFirst.flat(SAMPLE_KIOSK, 1);
    expect([flatFirst.compiledCount, flatFirst.isReady(SAMPLE_KIOSK.id, 0), flatFirst.isReady(SAMPLE_KIOSK.id, 1)]).toEqual([1, true, true]);
    expect(createModelCache().compiledCount, 'caches share nothing').toBe(0);
  });

  it('prewarms both quarter turns, at least one blueprint per call, until the budget is spent', () => {
    const queue: Blueprint[] = [SAMPLE_TREE, SAMPLE_KIOSK, ARM_BLUEPRINT, SAMPLE_TREE];
    const cache = createModelCache();
    expect(cache.prewarm(queue, 0), 'no budget, no work').toBe(4);
    expect(cache.compiledCount).toBe(0);

    // A clock that jumps a second per reading: the budget is spent after the first blueprint.
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 1_000));
    expect(cache.prewarm(queue, 4), 'the tree compiled (and is then ready the second time); the kiosk and the arm wait').toBe(2);
    expect([cache.isReady(SAMPLE_TREE.id, 0), cache.isReady(SAMPLE_TREE.id, 1), cache.isReady(SAMPLE_KIOSK.id, 0)]).toEqual([true, true, false]);
    expect(cache.prewarm(queue, 4)).toBe(1);
    expect(cache.prewarm(queue, 4)).toBe(0);
    expect(cache.compiledCount).toBe(3);

    // A stopped clock never runs out: everything in one call, then nothing left to do.
    vi.spyOn(performance, 'now').mockImplementation(() => 5);
    const fresh = createModelCache();
    fresh.model(SAMPLE_WHEEL, 0);
    expect(fresh.prewarm([SAMPLE_WHEEL, ...queue], 4)).toBe(0);
    expect(fresh.isReady(SAMPLE_WHEEL.id, 1), 'the missing quarter turn is filled in').toBe(true);
    expect([fresh.compiledCount, fresh.prewarm(queue, 4)]).toEqual([4, 0]);
  });
});

describe('sample blueprints', () => {
  it('stay inside their footprint and under the art bible heights', () => {
    const heights: Record<string, number> = { 'sample:carousel': 150, 'sample:wheel': 150, 'sample:tree': 60, 'sample:kiosk': 58 };
    for (const blueprint of SAMPLE_BLUEPRINTS) {
      const model: CompiledModel = compileBlueprint(blueprint);
      const flat = flattenAtRest(model);
      const [min, max] = boundsOfBoxes(flat.boxes, flat.boxCount);
      expect(min, blueprint.id).toEqual([expect.any(Number), expect.any(Number), PLOT_TOP_Z]);
      expect(Math.min(min[0], min[1]), blueprint.id).toBeGreaterThanOrEqual(0);
      expect([max[0] <= model.footprint[0] * VOXELS_PER_TILE, max[1] <= model.footprint[1] * VOXELS_PER_TILE], blueprint.id).toEqual([true, true]);
      expect(model.top, blueprint.id).toBe(max[2]);
      expect(model.top, blueprint.id).toBeLessThanOrEqual(heights[blueprint.id]);
    }
  });
});

describe('colour slot tags (Phase 28)', () => {
  const TAGGED: Blueprint = {
    id: 'test:tagged',
    footprint: [1, 1],
    parts: [
      {
        id: 'body',
        pivot: [0, 0, 0],
        shapes: [
          { kind: 'box', min: [2, 2, 1], size: [10, 6, 4], material: slotted(7, 1), pattern: PATTERN.ROOF },
          // Touches the first box and has the SAME palette material and pattern, but another slot.
          { kind: 'box', min: [12, 2, 1], size: [6, 6, 4], material: slotted(7, 2), pattern: PATTERN.ROOF },
          // Same material and pattern again but fixed: still its own box.
          { kind: 'box', min: [18, 2, 1], size: [6, 6, 4], material: 7, pattern: PATTERN.ROOF },
        ],
      },
      { id: 'arm', pivot: [20, 20, 10], shapes: [{ kind: 'box', min: [18, 19, 10], size: [4, 2, 6], material: slotted(9, 3) }] },
    ],
  };
  const PLAIN: Blueprint = {
    ...TAGGED,
    id: 'test:plain',
    parts: TAGGED.parts.map((part) => ({ ...part, shapes: part.shapes.map((shape) => ({ ...shape, material: materialOfShape(shape.material) })) })),
  };
  const tagsOf = (part: CompiledPart): number[] => Array.from({ length: part.boxCount }, (_unused, box) => part.boxes[box * BOX_FLOATS + 7]);

  it('encodes and decodes the tag in the shape material and in the run key', () => {
    expect(slotted(7, 3)).toBe(7 + 3 * 256);
    expect(materialOfShape(slotted(7, 3))).toBe(7);
    expect(tagOfShape(slotted(7, 3))).toBe(3);
    expect(tagOfShape(7)).toBe(0);
    expect(() => slotted(7, 0)).toThrow(/tag/);
    expect(() => slotted(7, 8)).toThrow(/tag/);
    expect(() => slotted(0, 1)).toThrow(/material/);
    const key = runKeyOf(200, PATTERN.BRICK | (5 << 5));
    expect([key & 255, patternOfKey(key), tagOfKey(key)]).toEqual([200, PATTERN.BRICK, 5]);
    expect([patternOfKey(runKeyOf(9, 31)), tagOfKey(runKeyOf(9, 31))]).toEqual([31, 0]);
  });

  it('carries the tag in field 7 of every tagged box and never merges across tags', () => {
    const model = compileBlueprint(TAGGED);
    const body = model.parts[0];
    expect(tagsOf(body).sort()).toEqual([0, 1, 2]);
    expect(body.boxCount).toBe(3);
    expect(tagsOf(model.parts[1])).toEqual([3]);
    for (const part of model.parts) {
      for (let box = 0; box < part.boxCount; box += 1) {
        const word = unpackBoxWord(part.boxes[box * BOX_FLOATS + 3]);
        expect(word.material, 'the word holds the palette material, never the tag').toBeLessThan(256);
        expect(word.material).toBe(part.id === 'body' ? 7 : 9);
      }
    }
  });

  it('compiles to the same geometry as the untagged blueprint where slots do not touch fixed boxes of their material', () => {
    // 7 | 7 | 7 merge into one 18+6 long box untagged; tagged they stay three.
    const plain = compileBlueprint(PLAIN);
    expect(plain.parts[0].boxCount).toBe(1);
    const independent: Blueprint = {
      ...TAGGED,
      id: 'test:independent',
      parts: [{ id: 'body', pivot: [0, 0, 0], shapes: [
        { kind: 'box', min: [2, 2, 1], size: [10, 6, 4], material: slotted(7, 1), pattern: PATTERN.ROOF },
        { kind: 'box', min: [12, 2, 1], size: [6, 6, 4], material: slotted(8, 2), pattern: PATTERN.ROOF },
      ] }],
    };
    const untaggedTwin: Blueprint = { ...independent, id: 'test:independent-plain', parts: [{ ...independent.parts[0], shapes: independent.parts[0].shapes.map((shape) => ({ ...shape, material: materialOfShape(shape.material) })) }] };
    const a = compileBlueprint(independent).parts[0];
    const b = compileBlueprint(untaggedTwin).parts[0];
    expect(a.boxCount).toBe(b.boxCount);
    for (let box = 0; box < a.boxCount; box += 1) {
      for (let field = 0; field < 7; field += 1) expect(a.boxes[box * BOX_FLOATS + field]).toBe(b.boxes[box * BOX_FLOATS + field]);
    }
  });

  it('keeps tags through the front-to-back sort, a quarter turn and every part', () => {
    const model = compileBlueprint(TAGGED);
    const turned = rotateModel(model, 1);
    const twice = rotateModel(turned, 1);
    for (const candidate of [turned, twice]) {
      expect(tagsOf(candidate.parts[0]).sort()).toEqual([0, 1, 2]);
      expect(tagsOf(candidate.parts[1])).toEqual([3]);
      expect(isFrontToBack(candidate.parts[0].boxes, candidate.parts[0].boxCount)).toBe(true);
    }
    // The tag follows its box: material 7 boxes keep the order of their tags under the sort.
    const byTag = (part: CompiledPart): Map<number, number> => new Map(Array.from({ length: part.boxCount }, (_unused, box) => [part.boxes[box * BOX_FLOATS + 7], part.boxes[box * BOX_FLOATS + 4] * part.boxes[box * BOX_FLOATS + 5]]));
    expect([...byTag(model.parts[0])].sort()).toEqual([[0, 36], [1, 60], [2, 36]]);
    expect([...byTag(turned.parts[0])].sort()).toEqual([[0, 36], [1, 60], [2, 36]]);
  });

  it('flattens to static boxes (the ghost never carries a tag)', () => {
    const flat = flattenAtRest(compileBlueprint(TAGGED));
    for (let box = 0; box < flat.boxCount; box += 1) expect(flat.boxes[box * BOX_FLOATS + 7]).toBe(0);
  });
});
