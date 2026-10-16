import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import type { BuildDefinition } from '../../../game/types';
import { compileBlueprint, flattenAtRest, rotateModel } from '../blueprint/compile';
import { MESH_BOX_STRIDE, meshRuns } from '../blueprint/greedyMesh';
import type { MeshBoxes } from '../blueprint/greedyMesh';
import { hollowRuns } from '../blueprint/hollow';
import { runsFromGrid, solidRowsOf } from '../blueprint/rowRuns';
import { materialAt, voxelizeShapes } from '../blueprint/voxelize';
import { materialOfShape } from '../contracts/blueprint';
import type { Blueprint, CompiledModel } from '../contracts/blueprint';
import { BOX_FLOATS } from '../contracts/boxes';
import { BOX_BUDGET } from '../contracts/budgets';
import type { ObjectContent } from '../contracts/content';
import { MAT, MATERIAL_EMPTY, MATERIAL_FLAG_EMISSIVE } from '../contracts/palette';
import { PLOT_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';
import { buildPalette } from '../palette';
import * as themed from './themedScenery';

/**
 * Phase 16 themed scenery (themedScenery.ts), held to the rules of the existing scenery (scenery.test.ts) at both quarter
 * turns: each blueprint compiles, fits its footprint, stays under the scenery top, is one solid piece on the plot that
 * hollowing does not change (the hollow.test check), uses only its catalog colour, accent and existing materials, and the
 * two landmarks are pinned by box count.
 *
 * The catalog entries land in parallel (Phase 16 wave 1), so a definition missing from the catalog is stood in by the
 * design's entry (id, footprint, colour, accent), and the palette is built over the catalog plus those stand-ins: the
 * blueprints only read those four fields.
 */

interface ThemedSpec {
  id: string;
  content: ObjectContent;
  footprint: readonly [number, number];
  color: number;
  accent: number;
  budget: number;
  lights: number;
}

/** The scenery top: the confetti tree's and lantern maple's limit, the tallest in scenery.test.ts. */
const SCENERY_TOP_LIMIT = 60;

const SPECS: readonly ThemedSpec[] = [
  { id: 'bunting-mast', content: themed.buntingMast, footprint: [1, 1], color: 0xef6f8f, accent: 0xffd166, budget: BOX_BUDGET.tree, lights: 0 },
  { id: 'shell-planter', content: themed.shellPlanter, footprint: [1, 1], color: 0x7fc8e8, accent: 0xfff0f5, budget: BOX_BUDGET.tree, lights: 0 },
  { id: 'tiki-torch', content: themed.tikiTorch, footprint: [1, 1], color: 0xe4572e, accent: 0xffd166, budget: BOX_BUDGET.tree, lights: 1 },
  { id: 'jungle-idol', content: themed.jungleIdol, footprint: [1, 1], color: 0x48786b, accent: 0x8ee3c5, budget: BOX_BUDGET.tree, lights: 0 },
  { id: 'neon-pylon', content: themed.neonPylon, footprint: [1, 1], color: 0x1b7f79, accent: 0x61e7d3, budget: BOX_BUDGET.tree, lights: 0 },
  { id: 'harbor-lighthouse', content: themed.harborLighthouse, footprint: [2, 2], color: 0x4c9fd4, accent: 0xfff0c8, budget: BOX_BUDGET.tree, lights: 1 },
  { id: 'orbit-globe', content: themed.orbitGlobe, footprint: [2, 2], color: 0x8f7cf7, accent: 0x61e7d3, budget: BOX_BUDGET.tree, lights: 0 },
];

const TEMPLATE = BUILD_BY_ID.get('sunburst-flowers') as BuildDefinition;

const definitionOf = (spec: ThemedSpec): BuildDefinition => BUILD_BY_ID.get(spec.id) ?? {
  ...TEMPLATE,
  id: spec.id,
  name: spec.id,
  footprint: spec.footprint,
  color: spec.color,
  accent: spec.accent,
};

const palette = buildPalette(
  [...BUILD_CATALOG, ...SPECS.filter((spec) => !BUILD_BY_ID.has(spec.id)).map(definitionOf)],
  GUEST_COLORS,
  GUEST_ACCENTS,
);
const QUARTER_TURNS: readonly QuarterTurn[] = [0, 1];

const blueprintOf = (spec: ThemedSpec): Blueprint => spec.content.blueprint(definitionOf(spec), palette);
const modelOf = (spec: ThemedSpec, quarterTurn: QuarterTurn): CompiledModel => rotateModel(compileBlueprint(blueprintOf(spec)), quarterTurn);

/** Voxel key for coordinates in [0, 256). */
const KEY_RANGE = 256;
const keyOf = (x: number, y: number, z: number): number => x + KEY_RANGE * (y + KEY_RANGE * z);
const coordinatesOf = (key: number): [number, number, number] =>
  [key % KEY_RANGE, Math.floor(key / KEY_RANGE) % KEY_RANGE, Math.floor(key / (KEY_RANGE * KEY_RANGE))];

/** Every solid voxel of the blueprint's parts, before hollowing (the model's real volume). */
const solidVoxelsOf = (blueprint: Blueprint): Map<number, number> => {
  const voxels = new Map<number, number>();
  for (const part of blueprint.parts) {
    const grid = voxelizeShapes(part.shapes, blueprint.floorZ ?? PLOT_TOP_Z, part.id);
    for (let z = grid.originZ; z < grid.originZ + grid.sizeZ; z += 1) {
      for (let y = grid.originY; y < grid.originY + grid.sizeY; y += 1) {
        for (let x = grid.originX; x < grid.originX + grid.sizeX; x += 1) {
          const material = materialAt(grid, x, y, z);
          if (material !== MATERIAL_EMPTY) voxels.set(keyOf(x, y, z), material);
        }
      }
    }
  }
  return voxels;
};

/** The voxels no face-connected path links to a voxel on the plot's top layer. */
const floatingVoxelsOf = (solid: ReadonlyMap<number, number>): number[] => {
  const reached = new Set<number>();
  const pending: number[] = [];
  for (const key of solid.keys()) {
    if (coordinatesOf(key)[2] !== PLOT_TOP_Z) continue;
    reached.add(key);
    pending.push(key);
  }
  const steps: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    const [x, y, z] = coordinatesOf(key);
    for (const [dx, dy, dz] of steps) {
      const [nx, ny, nz] = [x + dx, y + dy, z + dz];
      if (Math.min(nx, ny, nz) < 0 || Math.max(nx, ny, nz) >= KEY_RANGE) continue;
      const next = keyOf(nx, ny, nz);
      if (!solid.has(next) || reached.has(next)) continue;
      reached.add(next);
      pending.push(next);
    }
  }
  return [...solid.keys()].filter((key) => !reached.has(key));
};

// ---- the hollow.test.ts picture check: the hollow mesh must show exactly what the solid mesh shows.

type Signs = readonly [number, number, number];
interface Window { minU: number; minV: number; width: number; height: number }

const boxRange = (mesh: MeshBoxes, box: number, signs: Signs, axis: number): [number, number] => {
  const low = mesh.data[box * MESH_BOX_STRIDE + axis];
  const high = mesh.data[box * MESH_BOX_STRIDE + 3 + axis];
  return signs[axis] > 0 ? [low, high] : [-high, -low];
};

const windowOf = (mesh: MeshBoxes, signs: Signs): Window => {
  let [minU, maxU, minV, maxV] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let box = 0; box < mesh.count; box += 1) {
    const [[x0, x1], [y0, y1], [z0, z1]] = [0, 1, 2].map((axis) => boxRange(mesh, box, signs, axis));
    minU = Math.min(minU, x0 - y1);
    maxU = Math.max(maxU, x1 - y0);
    minV = Math.min(minV, (x0 + y0) / 2 - z1);
    maxV = Math.max(maxV, (x1 + y1) / 2 - z0);
  }
  return { minU: Math.floor(minU) - 1, minV: Math.floor(minV) - 1, width: Math.ceil(maxU - minU) + 3, height: Math.ceil(maxV - minV) + 3 };
};

/** Z-buffer picture (depth, run key and face per sample, two samples per texel per axis) seen from `signs`. */
const pictureOf = (mesh: MeshBoxes, signs: Signs, window: Window): string[] => {
  const scale = 2;
  const width = window.width * scale;
  const height = window.height * scale;
  const depth = new Float64Array(width * height).fill(-Infinity);
  const sample: string[] = new Array<string>(width * height).fill('');
  for (let box = 0; box < mesh.count; box += 1) {
    const [[x0, x1], [y0, y1], [z0, z1]] = [0, 1, 2].map((axis) => boxRange(mesh, box, signs, axis));
    const fromI = Math.max(0, Math.floor((x0 - y1 - window.minU) * scale));
    const toI = Math.min(width, Math.ceil((x1 - y0 - window.minU) * scale));
    const fromJ = Math.max(0, Math.floor(((x0 + y0) / 2 - z1 - window.minV) * scale));
    const toJ = Math.min(height, Math.ceil(((x1 + y1) / 2 - z0 - window.minV) * scale));
    for (let j = fromJ; j < toJ; j += 1) {
      const v = window.minV + (j + 0.5) / scale;
      for (let i = fromI; i < toI; i += 1) {
        const u = window.minU + (i + 0.5) / scale;
        let best = -Infinity;
        let face = -1;
        const topX = (2 * (v + z1) + u) / 2;
        const topY = (2 * (v + z1) - u) / 2;
        if (topX >= x0 && topX < x1 && topY >= y0 && topY < y1) [best, face] = [topX + topY + z1, 0];
        const sideY = x1 - u;
        const sideZ = (x1 + sideY) / 2 - v;
        if (sideY >= y0 && sideY < y1 && sideZ >= z0 && sideZ < z1 && x1 + sideY + sideZ > best) [best, face] = [x1 + sideY + sideZ, 1];
        const frontX = u + y1;
        const frontZ = (frontX + y1) / 2 - v;
        if (frontX >= x0 && frontX < x1 && frontZ >= z0 && frontZ < z1 && frontX + y1 + frontZ > best) [best, face] = [frontX + y1 + frontZ, 2];
        const at = j * width + i;
        if (face >= 0 && best > depth[at]) {
          depth[at] = best;
          sample[at] = `${best}/${mesh.data[box * MESH_BOX_STRIDE + 6]}/${face}`;
        }
      }
    }
  }
  return sample;
};

/** The four view directions of the rotated map, always from above (the body's 5-neighbour hollowing). */
const VIEWS: readonly Signs[] = [[1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1]];

describe.each(SPECS)('$id', (spec) => {
  const definition = definitionOf(spec);

  it('is a static single body named for its definition, deterministic, with the expected lights', () => {
    const blueprint = blueprintOf(spec);
    expect(spec.content.drivers, `${spec.id} has no drivers`).toBeUndefined();
    expect(blueprint.parts.map((part) => part.id)).toEqual(['body']);
    expect(blueprint.footprint).toEqual(definition.footprint);
    expect(blueprint.id).toMatch(new RegExp(`^scenery-[a-z]+:${spec.id}$`));
    expect(blueprintOf(spec), `${spec.id} rebuilds identically`).toEqual(blueprint);
    expect(blueprint.lights ?? [], `${spec.id} lights`).toHaveLength(spec.lights);
  });

  it.each(QUARTER_TURNS)('compiles within its box budget, inside its footprint and under the scenery top at quarter turn %i', (quarterTurn) => {
    const model = modelOf(spec, quarterTurn);
    expect(model.boxCount, `${spec.id} q${quarterTurn} boxes`).toBeGreaterThan(0);
    expect(model.boxCount, `${spec.id} q${quarterTurn} boxes <= ${spec.budget}`).toBeLessThanOrEqual(spec.budget);
    const flat = flattenAtRest(model);
    const limitX = VOXELS_PER_TILE * model.footprint[0];
    const limitY = VOXELS_PER_TILE * model.footprint[1];
    for (let box = 0; box < flat.boxCount; box += 1) {
      const [x, y, z, , sizeX, sizeY, sizeZ] = flat.boxes.subarray(box * BOX_FLOATS, box * BOX_FLOATS + 7);
      const where = `${spec.id} q${quarterTurn} box [${x}, ${y}, ${z}]`;
      expect(Math.min(x, y), `${where} inside the footprint`).toBeGreaterThanOrEqual(0);
      expect(x + sizeX, `${where} x <= ${limitX}`).toBeLessThanOrEqual(limitX);
      expect(y + sizeY, `${where} y <= ${limitY}`).toBeLessThanOrEqual(limitY);
      expect(z, `${where} stands on the plot`).toBeGreaterThanOrEqual(PLOT_TOP_Z);
      expect(z + sizeZ, `${where} under the scenery top`).toBeLessThanOrEqual(SCENERY_TOP_LIMIT);
    }
    expect(model.top).toBeLessThanOrEqual(SCENERY_TOP_LIMIT);
  });

  it('is one solid piece standing on the plot (no voxel floats)', () => {
    const solid = solidVoxelsOf(blueprintOf(spec));
    const floating = floatingVoxelsOf(solid);
    expect(floating.slice(0, 5).map(coordinatesOf), `${spec.id}: ${floating.length} floating voxels`).toEqual([]);
  });

  it('keeps the same first surface after hollowing in all four view directions (hollow.test check)', () => {
    const blueprint = blueprintOf(spec);
    const runs = runsFromGrid(voxelizeShapes(blueprint.parts[0].shapes, blueprint.floorZ ?? PLOT_TOP_Z, spec.id));
    const solidMesh = meshRuns(runs);
    const hollowMesh = meshRuns(hollowRuns(runs, solidRowsOf(runs), 5));
    for (const signs of VIEWS) {
      const window = windowOf(solidMesh, signs);
      const solid = pictureOf(solidMesh, signs, window);
      const hollow = pictureOf(hollowMesh, signs, window);
      const first = solid.findIndex((value, index) => value !== hollow[index]);
      expect(first, `${spec.id} view ${signs.join(',')}`).toBe(-1);
    }
  });

  it('uses only its catalog colour, its accent and existing materials, and shows both colours', () => {
    const color = palette.material(definition.color);
    const accent = palette.material(definition.accent);
    const allowed = new Set<number>([color, accent, MATERIAL_EMPTY, ...Object.values(MAT)]);
    const blueprint = blueprintOf(spec);
    const used = new Set(blueprint.parts.flatMap((part) => part.shapes.map((shape) => materialOfShape(shape.material))));
    for (const material of used) expect(allowed.has(material), `${spec.id} material ${material}`).toBe(true);
    const solid = new Set(solidVoxelsOf(blueprint).values());
    expect(solid.has(color), `${spec.id} shows its colour`).toBe(true);
    expect(solid.has(accent), `${spec.id} shows its accent`).toBe(true);
  });
});

describe('themed scenery module', () => {
  it('exports exactly the seven blueprints and no drivers (the globe is static)', () => {
    expect(Object.keys(themed).sort()).toEqual(
      ['buntingMast', 'harborLighthouse', 'jungleIdol', 'neonPylon', 'orbitGlobe', 'shellPlanter', 'tikiTorch'],
    );
  });

  it('gives the lighthouse an emissive lamp room with its light inside it', () => {
    const spec = SPECS.find((candidate) => candidate.id === 'harbor-lighthouse') as ThemedSpec;
    const blueprint = blueprintOf(spec);
    const solid = solidVoxelsOf(blueprint);
    const glowing = [...solid.entries()].filter(([, material]) => (palette.flags(material) & MATERIAL_FLAG_EMISSIVE) !== 0);
    expect(glowing.length, 'lamp-room voxels').toBeGreaterThan(200);
    const [light] = blueprint.lights ?? [];
    const lampZ = glowing.map(([key]) => coordinatesOf(key)[2]);
    expect(light.position[2]).toBeGreaterThanOrEqual(Math.min(...lampZ));
    expect(light.position[2]).toBeLessThanOrEqual(Math.max(...lampZ) + 1);
  });

  /**
   * Box counts at quarter turns 0 and 1, measured: a change here is a change of a model (update it on purpose). The two
   * landmarks must stay told apart by count as well as by shape.
   */
  const BOX_COUNTS: Readonly<Record<string, readonly [number, number]>> = {
    'bunting-mast': [185, 185],
    'shell-planter': [276, 276],
    'tiki-torch': [98, 98],
    'jungle-idol': [64, 64],
    'neon-pylon': [21, 21],
    'harbor-lighthouse': [482, 482],
    'orbit-globe': [445, 445],
  };

  it('pins every piece by box count, and the two landmarks are distinguishable', () => {
    const counts = Object.fromEntries(SPECS.map((spec) => [spec.id, QUARTER_TURNS.map((quarterTurn) => modelOf(spec, quarterTurn).boxCount)]));
    expect(counts).toEqual(BOX_COUNTS);
    expect(counts['harbor-lighthouse']).not.toEqual(counts['orbit-globe']);
  });
});
