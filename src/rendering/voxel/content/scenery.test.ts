import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import type { BuildDefinition } from '../../../game/types';
import { compileBlueprint, flattenAtRest, rotateModel } from '../blueprint/compile';
import type { FlatModel } from '../blueprint/compile';
import { materialAt, voxelizeShapes } from '../blueprint/voxelize';
import { LIGHT_PRESET_DAY, LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import type { Blueprint, CompiledModel, Shape } from '../contracts/blueprint';
import { BOX_FLOATS, unpackBoxWord } from '../contracts/boxes';
import { BOX_BUDGET } from '../contracts/budgets';
import type { ObjectContent } from '../contracts/content';
import { FACE_TOP, FACE_X, FACE_Y } from '../contracts/gbuffer';
import {
  MAT,
  MATERIAL_EMPTY,
  MATERIAL_FLAG_EMISSIVE,
  MATERIAL_FLAG_GLASS,
  MATERIAL_FLAG_SHADOW,
  MATERIAL_FLAG_WATER,
  PATTERN,
} from '../contracts/palette';
import { PLOT_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';
import { buildPalette } from '../palette';
import { ribbonBench, tidyTotem } from './amenities';
import { confettiTree, lanternMaple, lollipopLamp, rippleFountain, sunburstFlowers } from './scenery';

/**
 * Scenery and amenities are held to the art bible (design §12) and the box budgets
 * (contracts/budgets.ts) at both quarter turns, the way the renderer draws them: compiled, turned
 * by rotateModel, flattened at rest. What the camera actually sees is checked with a CPU twin of
 * the GPU's one-texel-per-voxel rasterisation, because "the front shows" and "the catalog colours
 * show" are statements about the picture, not about model space (the picture is mirror-imaged,
 * space.ts). Box counts are the gate; raster/exposed is only reported by the compiler.
 *
 * The picture cannot show everything: a gap under an overhang, or a part floating one voxel off
 * its support, may be out of the camera's sight. Those are caught in the blueprint's solid voxels:
 * every model must be one face-connected piece standing on the plot.
 */

const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const QUARTER_TURNS: readonly QuarterTurn[] = [0, 1];

/** Each catalog colour must cover at least this share of the visible texels at both turns. */
const COLOUR_IDENTITY_SHARE = 0.05;

interface FrontFeature {
  /** What the feature is, for messages. */
  what: string;
  materials: (definition: BuildDefinition) => readonly number[];
  /** Texels of those materials on the face model +y turns into (world +y at q0, +x at q1). */
  texels: number;
  /** The feature is a flat box face whose exact size the art bible fixes. */
  exact: boolean;
}

interface ModelSpec {
  id: string;
  content: ObjectContent;
  budget: number;
  /** Highest z at rest the art bible allows. */
  topLimit: number;
  /** Fixed materials the model may use besides its catalog colour and accent. */
  fixed: readonly number[];
  front: FrontFeature;
  /**
   * What a quarter turn does to the model: nothing ('quarter-turn'), turns it into its mirror image
   * ('mirror'), or moves its front to the other visible side ('front').
   */
  symmetry: 'quarter-turn' | 'mirror' | 'front';
  lights: number;
}

const colorOf = (definition: BuildDefinition): number => palette.material(definition.color);
const accentOf = (definition: BuildDefinition): number => palette.material(definition.accent);

const SPECS: readonly ModelSpec[] = [
  {
    id: 'confetti-tree',
    content: confettiTree,
    budget: BOX_BUDGET.tree,
    topLimit: 60,
    fixed: [MAT.TIMBER, MAT.FOLIAGE, MAT.WHITE],
    front: { what: 'the candy-coloured accent lobe', materials: (definition) => [accentOf(definition)], texels: 100, exact: false },
    symmetry: 'mirror',
    lights: 0,
  },
  {
    id: 'lantern-maple',
    content: lanternMaple,
    budget: BOX_BUDGET.tree,
    topLimit: 60,
    // The darker tier is thunder drum's red, already in every park's palette; the glow bands are the lamp's material.
    fixed: [MAT.TIMBER, MAT.LAMP_GLOW, palette.material(0xc0392b)],
    front: { what: 'the paper lanterns', materials: (definition) => [accentOf(definition)], texels: 12, exact: false },
    symmetry: 'mirror',
    lights: 0,
  },
  {
    id: 'lollipop-lamp',
    content: lollipopLamp,
    budget: BOX_BUDGET.lampOrFlowers,
    topLimit: 50,
    fixed: [MAT.LAMP_GLOW],
    front: { what: 'the glowing globe', materials: () => [MAT.LAMP_GLOW], texels: 16, exact: false },
    symmetry: 'quarter-turn',
    lights: 1,
  },
  {
    id: 'sunburst-flowers',
    content: sunburstFlowers,
    budget: BOX_BUDGET.lampOrFlowers,
    topLimit: 10,
    fixed: [MAT.FLOWER_PINK],
    front: { what: 'the blossoms', materials: (definition) => [accentOf(definition), MAT.FLOWER_PINK], texels: 32, exact: false },
    symmetry: 'quarter-turn',
    lights: 0,
  },
  {
    id: 'ripple-fountain',
    content: rippleFountain,
    budget: BOX_BUDGET.fountain,
    topLimit: 40,
    fixed: [MAT.STONE, MAT.WATER, MAT.WHITE],
    front: { what: 'the jet and its arcs', materials: (definition) => [accentOf(definition)], texels: 150, exact: false },
    symmetry: 'quarter-turn',
    lights: 0,
  },
  {
    id: 'ribbon-bench',
    content: ribbonBench,
    budget: BOX_BUDGET.benchOrBin,
    topLimit: 15,
    fixed: [MAT.STEEL],
    // The seat's whole front edge: 20 long × 2 thick.
    front: { what: 'the seat front', materials: (definition) => [colorOf(definition)], texels: 40, exact: true },
    symmetry: 'front',
    lights: 0,
  },
  {
    id: 'tidy-totem',
    content: tidyTotem,
    budget: BOX_BUDGET.benchOrBin,
    topLimit: 19,
    fixed: [MAT.INK],
    // The slot: 4 wide × 2 high.
    front: { what: 'the slot', materials: () => [MAT.INK], texels: 8, exact: true },
    symmetry: 'front',
    lights: 0,
  },
];

const definitionOf = (id: string): BuildDefinition => {
  const definition = BUILD_BY_ID.get(id);
  if (definition === undefined) throw new Error(`catalog has no '${id}'`);
  return definition;
};

const blueprintOf = (spec: ModelSpec): Blueprint => spec.content.blueprint(definitionOf(spec.id), palette);

const modelOf = (spec: ModelSpec, quarterTurn: QuarterTurn): CompiledModel =>
  rotateModel(compileBlueprint(blueprintOf(spec)), quarterTurn);

interface Box {
  min: [number, number, number];
  max: [number, number, number];
  material: number;
  pattern: number;
}

const boxesOf = (flat: Pick<FlatModel, 'boxes' | 'boxCount'>): Box[] => {
  const boxes: Box[] = [];
  for (let box = 0; box < flat.boxCount; box += 1) {
    const at = box * BOX_FLOATS;
    const data = flat.boxes;
    const word = unpackBoxWord(data[at + 3]);
    boxes.push({
      min: [data[at], data[at + 1], data[at + 2]],
      max: [data[at] + data[at + 4], data[at + 1] + data[at + 5], data[at + 2] + data[at + 6]],
      material: word.material,
      pattern: word.pattern,
    });
  }
  return boxes;
};

/** Voxel key for coordinates in [0, 256). */
const KEY_RANGE = 256;
const keyOf = (x: number, y: number, z: number): number => x + KEY_RANGE * (y + KEY_RANGE * z);
const coordinatesOf = (key: number): [number, number, number] =>
  [key % KEY_RANGE, Math.floor(key / KEY_RANGE) % KEY_RANGE, Math.floor(key / (KEY_RANGE * KEY_RANGE))];

/** The material of every voxel the boxes cover (later boxes win, which only matters if they overlap). */
const voxelsOf = (boxes: readonly Box[]): Map<number, number> => {
  const voxels = new Map<number, number>();
  for (const box of boxes) {
    for (let z = box.min[2]; z < box.max[2]; z += 1) {
      for (let y = box.min[1]; y < box.max[1]; y += 1) {
        for (let x = box.min[0]; x < box.max[0]; x += 1) voxels.set(keyOf(x, y, z), box.material);
      }
    }
  }
  return voxels;
};

/**
 * Every solid voxel of the blueprint at rest, before the compiler hollows it, turned the way
 * rotateModel turns boxes: q = 1 takes the cell [x, x + 1) × [y, y + 1) to [y, y + 1) × [W − 1 − x,
 * W − x) (space.ts). Hollowing drops hidden voxels, so the compiled boxes alone can look like a
 * shell with no floor; this is the model's real volume.
 */
const solidVoxelsOf = (blueprint: Blueprint, quarterTurn: QuarterTurn): Map<number, number> => {
  const width = VOXELS_PER_TILE * blueprint.footprint[0];
  const voxels = new Map<number, number>();
  for (const part of blueprint.parts) {
    const grid = voxelizeShapes(part.shapes, blueprint.floorZ ?? PLOT_TOP_Z, part.id);
    for (let z = grid.originZ; z < grid.originZ + grid.sizeZ; z += 1) {
      for (let y = grid.originY; y < grid.originY + grid.sizeY; y += 1) {
        for (let x = grid.originX; x < grid.originX + grid.sizeX; x += 1) {
          const material = materialAt(grid, x, y, z);
          if (material === MATERIAL_EMPTY) continue;
          voxels.set(quarterTurn === 0 ? keyOf(x, y, z) : keyOf(y, width - 1 - x, z), material);
        }
      }
    }
  }
  return voxels;
};

const FACE_NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** The voxels no face-connected path through `solid` links to a voxel on the plot's top layer. */
const floatingVoxelsOf = (solid: ReadonlyMap<number, number>): number[] => {
  const reached = new Set<number>();
  const pending: number[] = [];
  for (const key of solid.keys()) {
    if (coordinatesOf(key)[2] !== PLOT_TOP_Z) continue;
    reached.add(key);
    pending.push(key);
  }
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    const [x, y, z] = coordinatesOf(key);
    for (const [dx, dy, dz] of FACE_NEIGHBOURS) {
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

const volumeOf = (box: Box): number => (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);

const sortedEntries = (voxels: ReadonlyMap<number, number>): [number, number][] =>
  [...voxels.entries()].sort((a, b) => a[0] - b[0]);

interface Extent {
  min: [number, number, number];
  max: [number, number, number];
  count: number;
}

/** Bounds (max exclusive) of the voxels whose material passes `keep`. */
const extentOf = (voxels: ReadonlyMap<number, number>, keep: (material: number, x: number, y: number, z: number) => boolean): Extent => {
  const extent: Extent = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], count: 0 };
  for (const [key, material] of voxels) {
    const [x, y, z] = coordinatesOf(key);
    if (!keep(material, x, y, z)) continue;
    extent.count += 1;
    [x, y, z].forEach((value, axis) => {
      extent.min[axis] = Math.min(extent.min[axis], value);
      extent.max[axis] = Math.max(extent.max[axis], value + 1);
    });
  }
  return extent;
};

const sizeOf = (extent: Extent): [number, number, number] =>
  [extent.max[0] - extent.min[0], extent.max[1] - extent.min[1], extent.max[2] - extent.min[2]];

/** One visible texel: its material, the face it lies on, and the voxel just inside that face. */
interface Texel {
  material: number;
  face: number;
  voxel: [number, number, number];
}

/**
 * The visible texels at one texel per voxel step — the GPU's rasterisation (space.ts): each box's
 * three camera-facing faces, the nearest depth key winning at every texel centre. Texel centres
 * never lie on an edge, so the half-open tests (and the floors that find each texel's voxel) are
 * exact.
 */
const pictureOf = (model: CompiledModel): Texel[] => {
  const boxes = boxesOf(flattenAtRest(model));
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const { min, max } of boxes) {
    minU = Math.min(minU, min[0] - max[1]);
    maxU = Math.max(maxU, max[0] - min[1]);
    minV = Math.min(minV, (min[0] + min[1]) / 2 - max[2]);
    maxV = Math.max(maxV, (max[0] + max[1]) / 2 - min[2]);
  }
  const originU = Math.floor(minU);
  const originV = Math.floor(minV);
  const width = Math.ceil(maxU) - originU;
  const height = Math.ceil(maxV) - originV;
  const depth = new Float64Array(width * height).fill(-Infinity);
  const texels: (Texel | undefined)[] = new Array<Texel | undefined>(width * height).fill(undefined);
  for (const box of boxes) {
    const [x0, y0, z0] = box.min;
    const [x1, y1, z1] = box.max;
    for (let row = Math.floor((x0 + y0) / 2 - z1) - originV; row < Math.ceil((x1 + y1) / 2 - z0) - originV; row += 1) {
      const v = originV + row + 0.5;
      for (let column = Math.floor(x0 - y1) - originU; column < Math.ceil(x1 - y0) - originU; column += 1) {
        const u = originU + column + 0.5;
        let best = -Infinity;
        let texel: Texel | undefined;
        const sum = 2 * (v + z1);
        const topX = (sum + u) / 2;
        const topY = (sum - u) / 2;
        if (topX >= x0 && topX < x1 && topY >= y0 && topY < y1) {
          best = sum + z1;
          texel = { material: box.material, face: FACE_TOP, voxel: [Math.floor(topX), Math.floor(topY), z1 - 1] };
        }
        const sideY = x1 - u;
        const sideZ = (x1 + sideY) / 2 - v;
        if (sideY >= y0 && sideY < y1 && sideZ >= z0 && sideZ < z1 && x1 + sideY + sideZ > best) {
          best = x1 + sideY + sideZ;
          texel = { material: box.material, face: FACE_X, voxel: [x1 - 1, Math.floor(sideY), Math.floor(sideZ)] };
        }
        const frontX = u + y1;
        const frontZ = (frontX + y1) / 2 - v;
        if (frontX >= x0 && frontX < x1 && frontZ >= z0 && frontZ < z1 && frontX + y1 + frontZ > best) {
          best = frontX + y1 + frontZ;
          texel = { material: box.material, face: FACE_Y, voxel: [Math.floor(frontX), y1 - 1, Math.floor(frontZ)] };
        }
        const at = row * width + column;
        if (texel !== undefined && best > depth[at]) {
          depth[at] = best;
          texels[at] = texel;
        }
      }
    }
  }
  return texels.filter((texel): texel is Texel => texel !== undefined);
};

const countTexels = (picture: readonly Texel[], keep: (texel: Texel) => boolean): number =>
  picture.reduce((count, texel) => count + (keep(texel) ? 1 : 0), 0);

/** Texels of any of `materials` on `face`. */
const texelsOn = (picture: readonly Texel[], materials: readonly number[], face: number): number =>
  countTexels(picture, (texel) => texel.face === face && materials.includes(texel.material));

/** The world face model +y (the front) turns into: +y at quarter turn 0, +x at quarter turn 1. */
const frontFaceOf = (quarterTurn: QuarterTurn): number => (quarterTurn === 0 ? FACE_Y : FACE_X);

describe.each(SPECS)('$id', (spec) => {
  const definition = definitionOf(spec.id);

  it('is static: one body part and no drivers (scenery has no ride motion to follow)', () => {
    const blueprint = blueprintOf(spec);
    expect(spec.content.drivers, `${spec.id} declares no part drivers`).toBeUndefined();
    expect(blueprint.parts.map((part) => part.id), `${spec.id} is a single static body`).toEqual(['body']);
    expect(blueprint.footprint, `${spec.id} keeps the catalog footprint`).toEqual(definition.footprint);
    expect(blueprint.id, `${spec.id}'s blueprint id names its definition`).toMatch(new RegExp(`:${spec.id}$`));
  });

  it('is deterministic: two builds give the same blueprint and the same boxes', () => {
    const first = blueprintOf(spec);
    const second = blueprintOf(spec);
    expect(second, `${spec.id} blueprint`).toEqual(first);
    for (const quarterTurn of QUARTER_TURNS) {
      const a = flattenAtRest(rotateModel(compileBlueprint(first), quarterTurn));
      const b = flattenAtRest(rotateModel(compileBlueprint(second), quarterTurn));
      expect(b.boxCount, `${spec.id} q${quarterTurn} box count`).toBe(a.boxCount);
      expect(Array.from(b.boxes), `${spec.id} q${quarterTurn} boxes`).toEqual(Array.from(a.boxes));
    }
  });

  it.each(QUARTER_TURNS)('compiles within its box budget at quarter turn %i', (quarterTurn) => {
    const model = modelOf(spec, quarterTurn);
    expect(model.boxCount, `${spec.id} q${quarterTurn} boxes ≤ ${spec.budget}`).toBeLessThanOrEqual(spec.budget);
    expect(model.boxCount, `${spec.id} q${quarterTurn} has geometry`).toBeGreaterThan(0);
  });

  it.each(QUARTER_TURNS)('stays inside its footprint and under the art-bible top at quarter turn %i', (quarterTurn) => {
    const model = modelOf(spec, quarterTurn);
    const [width, depth] = model.footprint;
    const limitX = VOXELS_PER_TILE * width;
    const limitY = VOXELS_PER_TILE * depth;
    for (const box of boxesOf(flattenAtRest(model))) {
      const where = `${spec.id} q${quarterTurn} box [${box.min}]–[${box.max}]`;
      expect(box.min[0], `${where} x ≥ 0`).toBeGreaterThanOrEqual(0);
      expect(box.min[1], `${where} y ≥ 0`).toBeGreaterThanOrEqual(0);
      expect(box.max[0], `${where} x ≤ ${limitX}`).toBeLessThanOrEqual(limitX);
      expect(box.max[1], `${where} y ≤ ${limitY}`).toBeLessThanOrEqual(limitY);
      expect(box.min[2], `${where} stands on the plot`).toBeGreaterThanOrEqual(PLOT_TOP_Z);
      expect(box.max[2], `${where} under the art-bible top ${spec.topLimit}`).toBeLessThanOrEqual(spec.topLimit);
    }
    expect(model.top, `${spec.id} q${quarterTurn} top`).toBeLessThanOrEqual(spec.topLimit);
  });

  it.each(QUARTER_TURNS)('has no overlapping voxels at rest at quarter turn %i', (quarterTurn) => {
    // The compiler does not check that parts at rest keep apart (overlaps z-fight): the union of the
    // flattened model must hold exactly as many voxels as all parts' boxes together.
    const model = modelOf(spec, quarterTurn);
    const union = voxelsOf(boxesOf(flattenAtRest(model))).size;
    const perPart = model.parts.reduce((sum, part) =>
      sum + boxesOf({ boxes: part.boxes, boxCount: part.boxCount }).reduce((partSum, box) => partSum + volumeOf(box), 0), 0);
    expect(union, `${spec.id} q${quarterTurn} union of ${model.parts.length} parts`).toBe(perPart);
  });

  it.each(QUARTER_TURNS)('is one piece standing on the plot at quarter turn %i', (quarterTurn) => {
    // Every voxel connects through faces to the plot's top layer, so nothing floats even where the
    // camera would not see the gap. The compiled boxes may only drop hidden voxels of this volume.
    const solid = solidVoxelsOf(blueprintOf(spec), quarterTurn);
    const floating = floatingVoxelsOf(solid);
    const sample = (keys: readonly number[]): string => keys.slice(0, 4).map((key) => `(${coordinatesOf(key)})`).join(' ');
    expect(floating.length, `${spec.id} q${quarterTurn}: voxels not connected to the plot, e.g. ${sample(floating)}`).toBe(0);
    const compiled = voxelsOf(boxesOf(flattenAtRest(modelOf(spec, quarterTurn))));
    const strays = [...compiled].filter(([key, material]) => solid.get(key) !== material).map(([key]) => key);
    expect(strays.length, `${spec.id} q${quarterTurn}: compiled voxels outside the blueprint's solid, e.g. ${sample(strays)}`).toBe(0);
  });

  it.each(QUARTER_TURNS)('shows its front feature on the front face at quarter turn %i', (quarterTurn) => {
    const picture = pictureOf(modelOf(spec, quarterTurn));
    const shown = texelsOn(picture, spec.front.materials(definition), frontFaceOf(quarterTurn));
    const message = `${spec.id} q${quarterTurn}: ${spec.front.what} on the visible front face`;
    if (spec.front.exact) expect(shown, message).toBe(spec.front.texels);
    else expect(shown, message).toBeGreaterThanOrEqual(spec.front.texels);
  });

  it.each(QUARTER_TURNS)('shows both catalog colours at quarter turn %i', (quarterTurn) => {
    const picture = pictureOf(modelOf(spec, quarterTurn));
    for (const [name, material] of [['colour', colorOf(definition)], ['accent', accentOf(definition)]] as const) {
      const share = countTexels(picture, (texel) => texel.material === material) / picture.length;
      expect(share, `${spec.id} q${quarterTurn}: catalog ${name} share of ${picture.length} texels`).toBeGreaterThanOrEqual(COLOUR_IDENTITY_SHARE);
    }
  });

  it('keeps every side in view: a quarter turn changes it only as its symmetry allows', () => {
    const turn0 = voxelsOf(boxesOf(flattenAtRest(modelOf(spec, 0))));
    const turn1 = voxelsOf(boxesOf(flattenAtRest(modelOf(spec, 1))));
    if (spec.symmetry === 'quarter-turn') {
      expect(sortedEntries(turn1), `${spec.id} is unchanged by a quarter turn`).toEqual(sortedEntries(turn0));
    } else if (spec.symmetry === 'mirror') {
      // Mirror-symmetric about the model y axis: turn 1 is turn 0 with world x and y swapped, which
      // on screen is the left-right mirror image.
      const swapped = new Map<number, number>();
      for (const [key, material] of turn0) {
        const [x, y, z] = coordinatesOf(key);
        swapped.set(keyOf(y, x, z), material);
      }
      expect(sortedEntries(turn1), `${spec.id} turn 1 is the mirror image of turn 0`).toEqual(sortedEntries(swapped));
    } else {
      const front = spec.front.materials(definition);
      const picture0 = pictureOf(modelOf(spec, 0));
      const picture1 = pictureOf(modelOf(spec, 1));
      expect(texelsOn(picture1, front, FACE_X), `${spec.id}: the front moves from world +y to +x`)
        .toBe(texelsOn(picture0, front, FACE_Y));
    }
  });

  it('uses only palette materials, and glows or holds water only where it should', () => {
    const allowed = new Set([colorOf(definition), accentOf(definition), ...spec.fixed]);
    const used = new Set(boxesOf(flattenAtRest(modelOf(spec, 0))).map((box) => box.material));
    for (const material of used) {
      expect(allowed.has(material), `${spec.id} material ${material} is its colour, accent or an allowed MAT`).toBe(true);
      expect(material, `${spec.id} draws no empty material`).not.toBe(MATERIAL_EMPTY);
      const flags = palette.flags(material);
      expect(flags & (MATERIAL_FLAG_GLASS | MATERIAL_FLAG_SHADOW), `${spec.id} material ${material} is not glass or a shadow`).toBe(0);
      if ((flags & MATERIAL_FLAG_EMISSIVE) !== 0) expect(['lollipop-lamp', 'lantern-maple'], `only the lamp and the maple's lantern bands glow (${spec.id}, material ${material})`).toContain(spec.id);
      if ((flags & MATERIAL_FLAG_WATER) !== 0) expect(spec.id, `only the fountain holds water (material ${material})`).toBe('ripple-fountain');
    }
    for (const material of spec.fixed) expect(used.has(material), `${spec.id} uses fixed material ${material}`).toBe(true);
  });

  it(`declares ${spec.lights} light(s)`, () => {
    expect(blueprintOf(spec).lights ?? [], `${spec.id} lights`).toHaveLength(spec.lights);
  });
});

describe('blueprint ids', () => {
  it('are unique per builder and definition', () => {
    const ids = SPECS.map((spec) => blueprintOf(spec).id);
    expect(new Set(ids).size, `ids ${ids.join(', ')}`).toBe(ids.length);
  });
});

describe('art bible (design §12)', () => {
  const specOf = (id: string): ModelSpec => {
    const spec = SPECS.find((candidate) => candidate.id === id);
    if (spec === undefined) throw new Error(`no spec for '${id}'`);
    return spec;
  };
  const voxelsFor = (id: string, quarterTurn: QuarterTurn = 0): Map<number, number> =>
    voxelsOf(boxesOf(flattenAtRest(modelOf(specOf(id), quarterTurn))));

  it('confetti tree: trunk 4×4 showing up to z 26, crown radii 12–14 around z ≈ 40, top ≤ 60, three FOLIAGE lobes', () => {
    const definition = definitionOf('confetti-tree');
    const voxels = voxelsFor('confetti-tree');
    const trunk = extentOf(voxels, (material) => material === MAT.TIMBER);
    expect(sizeOf(trunk).slice(0, 2), 'trunk cross-section').toEqual([4, 4]);
    expect(trunk.min[2], 'trunk from the plot').toBe(PLOT_TOP_Z);
    const crown = extentOf(voxels, (material) => material !== MAT.TIMBER);
    // The trunk runs on, hidden, into the crown so the crown rests on it; what shows of it ends at 26.
    const solidTrunk = extentOf(solidVoxelsOf(confettiTree.blueprint(definition, palette), 0), (material) => material === MAT.TIMBER);
    expect(solidTrunk.max[2], 'the trunk reaches up into the crown').toBeGreaterThan(crown.min[2]);
    for (const quarterTurn of QUARTER_TURNS) {
      const shown = pictureOf(modelOf(specOf('confetti-tree'), quarterTurn)).filter((texel) => texel.material === MAT.TIMBER);
      expect(shown.length, `q${quarterTurn} the trunk shows`).toBeGreaterThan(0);
      const highest = Math.max(...shown.map((texel) => texel.voxel[2]));
      expect(highest, `q${quarterTurn} highest visible trunk voxel, under z 26`).toBeLessThan(26);
    }
    const centre = VOXELS_PER_TILE / 2;
    for (const axis of [0, 1]) {
      const radius = Math.max(centre - crown.min[axis], crown.max[axis] - centre);
      expect(radius, `crown radius along ${'xy'[axis]}`).toBeGreaterThanOrEqual(12);
      expect(radius, `crown radius along ${'xy'[axis]}`).toBeLessThanOrEqual(14);
    }
    expect(Math.abs((crown.min[2] + crown.max[2]) / 2 - 40), 'crown centred near z 40').toBeLessThanOrEqual(3);
    expect(crown.max[2], 'tree top').toBeLessThanOrEqual(60);
    const lobes = confettiTree.blueprint(definition, palette).parts[0].shapes.filter((shape) => shape.kind === 'ellipsoid');
    expect(lobes.map((lobe) => lobe.material).sort(), 'lobes in colour, accent and FOLIAGE')
      .toEqual([colorOf(definition), accentOf(definition), MAT.FOLIAGE].sort());
    for (const lobe of lobes) expect(lobe.pattern, `lobe ${lobe.material} pattern`).toBe(PATTERN.FOLIAGE);
  });

  it('lollipop lamp: pole 2×2 up to z 44, lantern 6×6×6 at z 44–50 with an emissive core, light radius 64 after dusk', () => {
    const definition = definitionOf('lollipop-lamp');
    for (const quarterTurn of QUARTER_TURNS) {
      const voxels = voxelsFor('lollipop-lamp', quarterTurn);
      const pole = extentOf(voxels, (material, _x, _y, z) => material === colorOf(definition) && z >= 4);
      expect(sizeOf(pole).slice(0, 2), `q${quarterTurn} pole cross-section above the foot`).toEqual([2, 2]);
      expect(pole.max[2], `q${quarterTurn} pole top`).toBe(44);
      const lantern = extentOf(voxels, (material) => material === MAT.LAMP_GLOW || material === accentOf(definition));
      expect(sizeOf(lantern), `q${quarterTurn} lantern size`).toEqual([6, 6, 6]);
      expect([lantern.min[2], lantern.max[2]], `q${quarterTurn} lantern height`).toEqual([44, 50]);
      expect(palette.flags(MAT.LAMP_GLOW) & MATERIAL_FLAG_EMISSIVE, 'the core glows').not.toBe(0);
      const model = modelOf(specOf('lollipop-lamp'), quarterTurn);
      expect(model.lights, `q${quarterTurn} one light`).toHaveLength(1);
      const [light] = model.lights;
      expect(light.radius, 'light radius').toBe(64);
      expect(light.presets, 'on at dusk and night, off by day').toBe(LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT);
      expect(light.presets & LIGHT_PRESET_DAY, 'off by day').toBe(0);
      light.position.forEach((value, axis) => {
        expect(value, `q${quarterTurn} light inside the lantern on axis ${'xyz'[axis]}`).toBeGreaterThanOrEqual(lantern.min[axis]);
        expect(value, `q${quarterTurn} light inside the lantern on axis ${'xyz'[axis]}`).toBeLessThanOrEqual(lantern.max[axis]);
      });
    }
  });

  it('sunburst flowers: a low FOLIAGE bed ≤ 10 with accent and pink blossoms on top', () => {
    const definition = definitionOf('sunburst-flowers');
    const voxels = voxelsFor('sunburst-flowers');
    const bed = extentOf(voxels, (material) => material === colorOf(definition));
    const blossoms = extentOf(voxels, (material) => material === accentOf(definition) || material === MAT.FLOWER_PINK);
    expect(blossoms.min[2], 'blossoms sit on the bed top').toBe(bed.max[2]);
    expect(Math.max(bed.max[2], blossoms.max[2]), 'flowers ≤ 10').toBeLessThanOrEqual(10);
    expect(extentOf(voxels, (material) => material === MAT.FLOWER_PINK).count, 'pink blossoms').toBeGreaterThan(0);
    expect(extentOf(voxels, (material) => material === accentOf(definition)).count, 'accent blossoms').toBeGreaterThan(0);
    const [bedShape] = sunburstFlowers.blueprint(definition, palette).parts[0].shapes;
    expect(bedShape.pattern, 'bed pattern').toBe(PATTERN.FOLIAGE);
  });

  it('confetti and blossom hearts sit on an even x + y, so each 2×2 top shows as a dot, not a stripe', () => {
    // A top face shows only every other voxel along the x = y diagonal (contracts/palette.ts), so a
    // 2×2 top on an odd corner rasterises as a 4×1 stripe. A quarter turn keeps the corner's parity.
    type BoxShape = Extract<Shape, { kind: 'box' }>;
    for (const id of ['confetti-tree', 'sunburst-flowers']) {
      const dots = blueprintOf(specOf(id)).parts
        .flatMap((part) => part.shapes)
        .filter((shape): shape is BoxShape => shape.kind === 'box' && shape.size[0] === 2 && shape.size[1] === 2);
      expect(dots.length, `${id} has 2×2 decorations`).toBeGreaterThan(0);
      for (const dot of dots) expect((dot.min[0] + dot.min[1]) % 2, `${id} 2×2 at (${dot.min})`).toBe(0);
    }
  });

  it('ripple fountain: rim 6 high, WATER basin with the WATER pattern, jet ≤ 40 in accent water', () => {
    const definition = definitionOf('ripple-fountain');
    const voxels = voxelsFor('ripple-fountain');
    const centre = VOXELS_PER_TILE;
    const distance = (x: number, y: number): number => Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
    const rim = extentOf(voxels, (material, x, y) =>
      distance(x, y) >= 25 && material !== MAT.WATER && material !== accentOf(definition));
    expect([rim.min[2], rim.max[2]], 'rim from the plot, 6 high').toEqual([PLOT_TOP_Z, PLOT_TOP_Z + 6]);
    // The basin: water outside the raised bowl (which holds its own pool).
    const basin = extentOf(voxels, (material, x, y) => material === MAT.WATER && distance(x, y) > 12);
    expect(basin.min[2], 'basin water starts on the plot').toBe(PLOT_TOP_Z);
    expect(basin.max[2], 'basin water below the rim top').toBeLessThan(rim.max[2]);
    const jet = extentOf(voxels, (material) => material === accentOf(definition) || material === MAT.WHITE);
    expect(jet.max[2], 'jet ≤ 40').toBeLessThanOrEqual(40);
    for (const box of boxesOf(flattenAtRest(modelOf(specOf('ripple-fountain'), 0)))) {
      if (box.material === MAT.WATER || box.material === accentOf(definition)) {
        expect(box.pattern, `water box material ${box.material} pattern`).toBe(PATTERN.WATER);
      }
    }
    // The raised bowl reads as a bowl, not a thin hoop: its catalog-colour wall shows on the side
    // faces at each of its three layers (z 15–17). Water shows only its top; a WATER side face would
    // be water poking out through a wall.
    for (const quarterTurn of QUARTER_TURNS) {
      const picture = pictureOf(modelOf(specOf('ripple-fountain'), quarterTurn));
      for (let z = 15; z < 18; z += 1) {
        const wall = countTexels(picture, ({ material, face, voxel }) => material === colorOf(definition)
          && face !== FACE_TOP && voxel[2] === z && distance(voxel[0], voxel[1]) < 12);
        expect(wall, `q${quarterTurn} bowl wall texels at z ${z}`).toBeGreaterThanOrEqual(20);
      }
      const waterSides = countTexels(picture, (texel) => texel.material === MAT.WATER && texel.face !== FACE_TOP);
      expect(waterSides, `q${quarterTurn} water side-face texels`).toBe(0);
    }
  });

  it('ribbon bench: seat top 8, back top 15, length 18–20, depth 6, the seat facing model +y', () => {
    const definition = definitionOf('ribbon-bench');
    const voxels = voxelsFor('ribbon-bench');
    const seat = extentOf(voxels, (material) => material === colorOf(definition));
    const back = extentOf(voxels, (material) => material === accentOf(definition));
    expect(seat.max[2], 'seat top').toBe(8);
    expect(back.max[2], 'back top').toBe(15);
    const [length, depth] = sizeOf(seat);
    expect(length, 'bench length').toBeGreaterThanOrEqual(18);
    expect(length, 'bench length').toBeLessThanOrEqual(20);
    expect(depth, 'bench depth').toBe(6);
    expect(back.min[1], 'the back stands at the rear of the seat').toBe(seat.min[1]);
    expect(back.max[1], 'the back leaves the seat front free').toBeLessThan(seat.max[1]);
  });

  it('tidy totem: bin 8×8×16 plus a 2-voxel lid, the slot on the front face', () => {
    const definition = definitionOf('tidy-totem');
    const voxels = voxelsFor('tidy-totem');
    const bin = extentOf(voxels, () => true);
    expect(sizeOf(bin), 'bin size').toEqual([8, 8, 18]);
    expect(bin.min[2], 'bin on the plot').toBe(PLOT_TOP_Z);
    const body = extentOf(voxels, (material) => material === colorOf(definition));
    expect(body.max[2], 'body 16 high').toBe(PLOT_TOP_Z + 16);
    const lid = extentOf(voxels, (material, _x, _y, z) => material === accentOf(definition) && z >= PLOT_TOP_Z + 16);
    expect([lid.min[2], lid.max[2]], 'lid 2 high on the body').toEqual([PLOT_TOP_Z + 16, PLOT_TOP_Z + 18]);
    const slot = extentOf(voxels, (material) => material === MAT.INK);
    expect(slot.max[1], 'slot on the front (+y) face').toBe(bin.max[1]);
  });
});
