import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { footprintSize } from '../../../game/types';
import type { BuildDefinition } from '../../../game/types';
import { compileBlueprint, compileBlueprintReport, flattenAtRest, rotateModel } from '../blueprint/compile';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import type { Blueprint, CompiledModel, CompiledPart, Shape } from '../contracts/blueprint';
import { BOX_FLOATS, PATTERN_LIMIT, TRANSFORM_FLOATS, unpackBoxWord } from '../contracts/boxes';
import { BOX_BUDGET } from '../contracts/budgets';
import { MAT, MAT_COLOR } from '../contracts/palette';
import type { PartPose, RideMotionState } from '../contracts/rigid';
import { PLOT_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';
import { buildPalette } from '../palette';
import { createTransformTable, writeRotatedPartTransform } from '../scene/rigid';
import { GENERIC_RIDE_IDS, genericRide } from './genericRide';

/**
 * The flat rides are content, so what they must guarantee is what the renderer cannot check for
 * them: every catalog id compiles inside BOX_BUDGET.genericRide, stands inside its plot — clear of
 * the fence's 2-voxel band — at rest AND through a whole ride cycle posed by its own drivers
 * through the scene's rigid composition, never puts two parts on one voxel at rest (the compiler
 * cannot see that, and coplanar overlaps z-fight), never drives a part through the body, keeps its
 * front — the operator booth's lit window — on a face the camera sees at both quarter turns, and
 * gives every moving part a driver that rests at motion 0 and writes unit quaternions.
 */

const RIDE_IDS = [
  'petal-roundabout', 'comet-cups', 'bumble-coach', 'harbor-swings', 'splash-rings', 'gale-spinner', 'thunder-drum',
  // Phase 16.
  'puddle-jumpers', 'rocket-pendulum', 'temple-trek',
] as const;
const QUARTER_TURNS: readonly QuarterTurn[] = [0, 1];

/** Art bible: rides top out at 150 voxels. */
const RIDE_TOP_LIMIT = 150;
/** Ride fences own the plot's outer 2-voxel band (staticWorld.ts); nothing of a ride may enter it. */
const FENCE_BAND = 2;
/** Radii the art bible gives ride bulbs and lit windows. */
const BULB_LIGHT_RADIUS = 16;
const WINDOW_LIGHT_RADIUS = 28;
const EVENING = LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT;
/** Emissive, glass, water and shadow materials may only appear as these fixed ids. */
const FLAGGED_MATERIALS: ReadonlySet<number> = new Set([MAT.LAMP_GLOW, MAT.BULB, MAT.GLASS, MAT.WINDOW_GLOW, MAT.WATER, MAT.SHADOW]);

/**
 * A ride cycle: 40 s of motion-weighted spin covers at least four turns of every motion the rides
 * have (the slowest, splash-rings' lap, takes 10.5 s), sampled every 20 ms — 3° of the fastest
 * rotor — at idle, half and full motion.
 */
const CYCLE_SPIN_MS = 40_000;
const CYCLE_SAMPLES = 2_000;
const CYCLE_MOTIONS: readonly number[] = [0.14, 0.6, 1];
/** Poses per motion for the voxel-level collision check (every 250 ms of spin). */
const COLLISION_SAMPLES = 160;
const EPSILON = 1e-3;

const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

const definitionOf = (id: string): BuildDefinition => {
  const definition = BUILD_CATALOG.find((entry) => entry.id === id);
  if (!definition) throw new Error(`catalog has no '${id}'`);
  return definition;
};

/** A ride id nobody designed: the builder's generic spinner must still hold every promise. */
const MYSTERY_RIDE: BuildDefinition = { ...definitionOf('petal-roundabout'), id: 'mystery-spinner', name: 'Mystery Spinner' };

const compiled = new Map<string, CompiledModel>();

const blueprintOf = (definition: BuildDefinition): Blueprint => genericRide.blueprint(definition, palette);

/** The model as the scene gets it from ModelCache.model(blueprint, q): compiled, then turned. */
const modelOf = (definition: BuildDefinition, quarterTurn: QuarterTurn): CompiledModel => {
  let base = compiled.get(definition.id);
  if (!base) {
    base = compileBlueprint(blueprintOf(definition));
    compiled.set(definition.id, base);
  }
  return rotateModel(base, quarterTurn);
};

/** Plot size in voxels at a quarter turn (footprintSize for the matching rotation). */
const plotOf = (definition: BuildDefinition, quarterTurn: QuarterTurn): { width: number; depth: number } => {
  const [tilesX, tilesY] = footprintSize(definition, quarterTurn);
  return { width: tilesX * VOXELS_PER_TILE, depth: tilesY * VOXELS_PER_TILE };
};

// ------------------------------------------------------------------ voxel helpers

type Vector = readonly [number, number, number];
type Quaternion = readonly [number, number, number, number];

/** gpu/shaders/common.ts vxQuatRotate, in TypeScript. */
const rotate = (q: Quaternion, x: number, y: number, z: number): Vector => {
  const tx = 2 * (q[1] * z - q[2] * y);
  const ty = 2 * (q[2] * x - q[0] * z);
  const tz = 2 * (q[0] * y - q[1] * x);
  return [
    x + q[3] * tx + (q[1] * tz - q[2] * ty),
    y + q[3] * ty + (q[2] * tx - q[0] * tz),
    z + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
};

/** Calls `visit` for every voxel of every box, offset by (dx, dy, dz). */
const forEachVoxel = (
  boxes: Float32Array,
  count: number,
  dx: number,
  dy: number,
  dz: number,
  visit: (x: number, y: number, z: number, material: number) => void,
): void => {
  for (let box = 0; box < count; box += 1) {
    const at = box * BOX_FLOATS;
    const material = unpackBoxWord(boxes[at + 3]).material;
    const x0 = boxes[at] + dx;
    const y0 = boxes[at + 1] + dy;
    const z0 = boxes[at + 2] + dz;
    for (let z = z0; z < z0 + boxes[at + 6]; z += 1) {
      for (let y = y0; y < y0 + boxes[at + 5]; y += 1) {
        for (let x = x0; x < x0 + boxes[at + 4]; x += 1) visit(x, y, z, material);
      }
    }
  }
};

/** Material per voxel over [0, width) × [0, depth) × [0, RIDE_TOP_LIMIT + 16); 0 is empty. */
class VoxelGrid {
  readonly cells: Uint8Array;
  readonly height = RIDE_TOP_LIMIT + 16;

  constructor(readonly width: number, readonly depth: number) {
    this.cells = new Uint8Array(width * depth * this.height);
  }

  inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.width && y < this.depth && z < this.height;
  }

  at(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? this.cells[(z * this.depth + y) * this.width + x] : 0;
  }

  set(x: number, y: number, z: number, material: number): void {
    if (this.inside(x, y, z)) this.cells[(z * this.depth + y) * this.width + x] = material;
  }
}

/** Unique box corners of a part, relative to its pivot. */
const cornersOf = (part: CompiledPart): Vector[] => {
  const seen = new Set<string>();
  const corners: Vector[] = [];
  for (let box = 0; box < part.boxCount; box += 1) {
    const at = box * BOX_FLOATS;
    for (const x of [part.boxes[at], part.boxes[at] + part.boxes[at + 4]]) {
      for (const y of [part.boxes[at + 1], part.boxes[at + 1] + part.boxes[at + 5]]) {
        for (const z of [part.boxes[at + 2], part.boxes[at + 2] + part.boxes[at + 6]]) {
          const key = `${x},${y},${z}`;
          if (seen.has(key)) continue;
          seen.add(key);
          corners.push([x, y, z]);
        }
      }
    }
  }
  return corners;
};

/** Voxel centres of a part, relative to its pivot. */
const centresOf = (part: CompiledPart): Vector[] => {
  const centres: Vector[] = [];
  forEachVoxel(part.boxes, part.boxCount, 0, 0, 0, (x, y, z) => centres.push([x + 0.5, y + 0.5, z + 0.5]));
  return centres;
};

const motionState = (spin: number, motion: number): RideMotionState =>
  ({ spin, motion, progress: 0, elapsedMs: 0, status: motion > 0 ? 'running' : 'closed' });

const freshPose = (): PartPose => ({ dx: Number.NaN, dy: Number.NaN, dz: Number.NaN, qx: Number.NaN, qy: Number.NaN, qz: Number.NaN, qw: Number.NaN });

/** One transform slot, reused by every pose the tests compose. */
const TABLE = createTransformTable();
const SLOT = TABLE.slotFor(1, 1);

/**
 * World pose of a turned model's part, placed at the origin, exactly as the scene composes it
 * (scene/rigid.ts writeRotatedPartTransform, read back as the float32 record the GPU gets).
 */
const worldPose = (quarterTurn: QuarterTurn, part: CompiledPart, pose: PartPose): { pivot: Vector; rotation: Quaternion } => {
  writeRotatedPartTransform(TABLE, SLOT, 0, 0, 0, quarterTurn, part.pivot, pose);
  const at = (SLOT - 1) * TRANSFORM_FLOATS;
  const data = TABLE.data;
  return { pivot: [data[at], data[at + 1], data[at + 2]], rotation: [data[at + 4], data[at + 5], data[at + 6], data[at + 7]] };
};

/** Every pose the cycle samples for one driver, as (spin, motion) pairs. */
const cyclePoses = (samples: number): { spin: number; motion: number }[] => {
  const poses: { spin: number; motion: number }[] = [];
  for (const motion of CYCLE_MOTIONS) {
    for (let sample = 0; sample < samples; sample += 1) poses.push({ spin: (sample / samples) * CYCLE_SPIN_MS, motion });
  }
  return poses;
};

const driverOf = (partId: string) => {
  const driver = genericRide.drivers?.[partId];
  if (!driver) throw new Error(`no driver for part '${partId}'`);
  return driver;
};

// ------------------------------------------------------------------ tests

describe('generic flat rides: catalog coverage', () => {
  it('designs every ride the registry sends to this builder', () => {
    expect([...GENERIC_RIDE_IDS].sort(), 'ids with their own parameters').toEqual([...RIDE_IDS].sort());
    for (const id of RIDE_IDS) expect(definitionOf(id).kind, `${id} is a ride`).toBe('ride');
  });

  it('gives each ride its own silhouette and a unique blueprint id', () => {
    const ids = new Set<string>();
    const signatures = new Set<string>();
    for (const id of RIDE_IDS) {
      const blueprint = blueprintOf(definitionOf(id));
      ids.add(blueprint.id);
      signatures.add(blueprint.parts.map((part) => `${part.id}:${part.shapes.length}`).join('|'));
      expect(blueprint.id, `${id} blueprint id names the definition`).toContain(id);
    }
    expect(ids.size, 'blueprint ids are unique').toBe(RIDE_IDS.length);
    expect(signatures.size, 'no two rides share a part layout').toBe(RIDE_IDS.length);
  });

  it('builds the generic spinner for an id without a design', () => {
    const blueprint = blueprintOf(MYSTERY_RIDE);
    expect(blueprint.id, 'fallback blueprint id').toBe('flat-ride:generic:mystery-spinner');
    expect(blueprint.parts.length, 'body and rotor').toBe(2);
  });
});

for (const definition of [...RIDE_IDS.map(definitionOf), MYSTERY_RIDE]) {
  const id = definition.id;
  describe(`generic flat ride '${id}'`, () => {
    it('is deterministic: two builds and two compiles are equal', () => {
      const first = blueprintOf(definition);
      const second = genericRide.blueprint(definition, buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS));
      expect(second, 'same definition and palette give the same blueprint').toEqual(first);
      const one = compileBlueprint(first);
      const two = compileBlueprint(second);
      expect(two.parts.map((part) => Array.from(part.boxes)), 'same boxes').toEqual(one.parts.map((part) => Array.from(part.boxes)));
    });

    it('fits its box budget and the art bible\'s ride height', () => {
      const report = compileBlueprintReport(blueprintOf(definition));
      expect(report.model.boxCount, `${id} boxes (budget ${BOX_BUDGET.genericRide})`).toBeLessThanOrEqual(BOX_BUDGET.genericRide);
      expect(report.model.top, `${id} top`).toBeLessThanOrEqual(RIDE_TOP_LIMIT);
      for (const part of report.parts) expect(part.boxes, `${id} part '${part.id}' has boxes`).toBeGreaterThan(0);
    });

    for (const quarterTurn of QUARTER_TURNS) {
      describe(`quarter turn ${quarterTurn}`, () => {
        it('compiles and stands inside the plot, clear of the fence band, at rest', () => {
          const model = modelOf(definition, quarterTurn);
          const { width, depth } = plotOf(definition, quarterTurn);
          expect(model.footprint, 'turned footprint').toEqual(footprintSize(definition, quarterTurn));
          const flat = flattenAtRest(model);
          let minX = Infinity;
          let minY = Infinity;
          let minZ = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          let maxZ = -Infinity;
          for (let box = 0; box < flat.boxCount; box += 1) {
            const at = box * BOX_FLOATS;
            minX = Math.min(minX, flat.boxes[at]);
            minY = Math.min(minY, flat.boxes[at + 1]);
            minZ = Math.min(minZ, flat.boxes[at + 2]);
            maxX = Math.max(maxX, flat.boxes[at] + flat.boxes[at + 4]);
            maxY = Math.max(maxY, flat.boxes[at + 1] + flat.boxes[at + 5]);
            maxZ = Math.max(maxZ, flat.boxes[at + 2] + flat.boxes[at + 6]);
          }
          expect(minX, 'min x').toBeGreaterThanOrEqual(FENCE_BAND);
          expect(minY, 'min y').toBeGreaterThanOrEqual(FENCE_BAND);
          expect(maxX, 'max x').toBeLessThanOrEqual(width - FENCE_BAND);
          expect(maxY, 'max y').toBeLessThanOrEqual(depth - FENCE_BAND);
          expect(minZ, 'nothing below the plot top').toBeGreaterThanOrEqual(PLOT_TOP_Z);
          expect(maxZ, 'top').toBeLessThanOrEqual(RIDE_TOP_LIMIT);
          expect(model.top, 'model top').toBe(maxZ);
        });

        it('keeps every moving part inside the plot minus the fence band through a whole cycle', () => {
          const model = modelOf(definition, quarterTurn);
          const { width, depth } = plotOf(definition, quarterTurn);
          const pose = freshPose();
          for (const part of model.parts.slice(1)) {
            const corners = cornersOf(part);
            const driver = driverOf(part.id);
            let minX = Infinity;
            let minY = Infinity;
            let minZ = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let maxZ = -Infinity;
            for (const { spin, motion } of cyclePoses(CYCLE_SAMPLES)) {
              driver(motionState(spin, motion), pose);
              const { pivot, rotation } = worldPose(quarterTurn, part, pose);
              for (const [x, y, z] of corners) {
                const [rx, ry, rz] = rotate(rotation, x, y, z);
                minX = Math.min(minX, pivot[0] + rx);
                minY = Math.min(minY, pivot[1] + ry);
                minZ = Math.min(minZ, pivot[2] + rz);
                maxX = Math.max(maxX, pivot[0] + rx);
                maxY = Math.max(maxY, pivot[1] + ry);
                maxZ = Math.max(maxZ, pivot[2] + rz);
              }
            }
            const label = `${id} part '${part.id}' sweep`;
            expect(minX, `${label} min x`).toBeGreaterThanOrEqual(FENCE_BAND - EPSILON);
            expect(minY, `${label} min y`).toBeGreaterThanOrEqual(FENCE_BAND - EPSILON);
            expect(maxX, `${label} max x`).toBeLessThanOrEqual(width - FENCE_BAND + EPSILON);
            expect(maxY, `${label} max y`).toBeLessThanOrEqual(depth - FENCE_BAND + EPSILON);
            expect(minZ, `${label} min z`).toBeGreaterThanOrEqual(PLOT_TOP_Z - EPSILON);
            expect(maxZ, `${label} max z`).toBeLessThanOrEqual(RIDE_TOP_LIMIT + EPSILON);
          }
        });

        it('never puts two parts on one voxel at rest', () => {
          const model = modelOf(definition, quarterTurn);
          let sum = 0;
          for (const part of model.parts) {
            forEachVoxel(part.boxes, part.boxCount, 0, 0, 0, () => {
              sum += 1;
            });
          }
          // Each part's boxes are disjoint (greedy mesh), so the at-rest union only loses voxels two parts share.
          const flat = flattenAtRest(model);
          const union = new Set<number>();
          forEachVoxel(flat.boxes, flat.boxCount, 0, 0, 0, (x, y, z) => union.add((z * 512 + y) * 512 + x));
          expect(union.size, `${id}: flattenAtRest union vs the sum of per-part voxels`).toBe(sum);
        });

        it('drives no part through the body or through another part while running', () => {
          const model = modelOf(definition, quarterTurn);
          const { width, depth } = plotOf(definition, quarterTurn);
          const body = new VoxelGrid(width, depth);
          const bodyPart = model.parts[0];
          forEachVoxel(bodyPart.boxes, bodyPart.boxCount, 0, 0, 0, (x, y, z) => body.set(x, y, z, 1));
          const moving = model.parts.slice(1).map((part) => ({ part, centres: centresOf(part), driver: driverOf(part.id) }));
          const claimed = new VoxelGrid(width, depth);
          const cells = new Int32Array(3 * Math.max(0, ...moving.map(({ centres }) => centres.length)));
          const pose = freshPose();
          const collisions: string[] = [];
          cyclePoses(COLLISION_SAMPLES).forEach(({ spin, motion }, sample) => {
            // Each sample stamps its own id into `claimed`, so the grid only needs clearing when stamps wrap.
            const stamp = (sample % 254) + 1;
            if (stamp === 1) claimed.cells.fill(0);
            for (const { part, centres, driver } of moving) {
              driver(motionState(spin, motion), pose);
              const { pivot, rotation } = worldPose(quarterTurn, part, pose);
              centres.forEach(([x, y, z], index) => {
                const [rx, ry, rz] = rotate(rotation, x, y, z);
                const cellX = Math.floor(pivot[0] + rx);
                const cellY = Math.floor(pivot[1] + ry);
                const cellZ = Math.floor(pivot[2] + rz);
                cells[3 * index] = cellX;
                cells[3 * index + 1] = cellY;
                cells[3 * index + 2] = cellZ;
                if (collisions.length >= 5) return;
                if (body.at(cellX, cellY, cellZ) !== 0) {
                  collisions.push(`${part.id} hits the body at (${cellX}, ${cellY}, ${cellZ}), spin ${spin}, motion ${motion}`);
                } else if (claimed.at(cellX, cellY, cellZ) === stamp) {
                  collisions.push(`${part.id} hits another part at (${cellX}, ${cellY}, ${cellZ}), spin ${spin}, motion ${motion}`);
                }
              });
              // A part only claims its cells after its own check, so it never collides with itself.
              for (let index = 0; index < centres.length; index += 1) {
                claimed.set(cells[3 * index], cells[3 * index + 1], cells[3 * index + 2], stamp);
              }
            }
          });
          expect(collisions, `${id} collisions`).toEqual([]);
        });

        it('keeps its front — the booth\'s lit window — on a face the camera sees', () => {
          const model = modelOf(definition, quarterTurn);
          const { width, depth } = plotOf(definition, quarterTurn);
          const grid = new VoxelGrid(width, depth);
          const flat = flattenAtRest(model);
          forEachVoxel(flat.boxes, flat.boxCount, 0, 0, 0, (x, y, z, material) => grid.set(x, y, z, material));
          // Model +y is the front: world +y at quarter turn 0, world +x at quarter turn 1.
          const [frontX, frontY] = quarterTurn === 0 ? [0, 1] : [1, 0];
          let windowVoxels = 0;
          let facingFront = 0;
          let facingElsewhere = 0;
          let seen = 0;
          forEachVoxel(flat.boxes, flat.boxCount, 0, 0, 0, (x, y, z, material) => {
            if (material !== MAT.WINDOW_GLOW) return;
            windowVoxels += 1;
            // The other visible side (world +x at quarter turn 0, +y at 1) is a model side, never the front.
            if (grid.at(x + frontY, y + frontX, z) === 0) facingElsewhere += 1;
            if (grid.at(x + frontX, y + frontY, z) !== 0) return;
            facingFront += 1;
            // March from the exposed face toward the camera, along (1, 1, 1): nothing may block it.
            let blocked = false;
            for (let step = 1; step < 4 * RIDE_TOP_LIMIT && !blocked; step += 1) {
              const t = step * 0.25;
              const px = Math.floor(x + 0.5 + frontX * 0.5 + t);
              const py = Math.floor(y + 0.5 + frontY * 0.5 + t);
              const pz = Math.floor(z + 0.5 + t);
              if (!grid.inside(px, py, pz)) break;
              blocked = grid.at(px, py, pz) !== 0;
            }
            if (!blocked) seen += 1;
          });
          expect(windowVoxels, `${id} has a lit booth window`).toBeGreaterThan(0);
          expect(facingFront, `${id} window faces exposed toward world ${quarterTurn === 0 ? '+y' : '+x'}`).toBeGreaterThanOrEqual(12);
          expect(facingElsewhere, `${id} window never faces the other visible side`).toBe(0);
          expect(seen, `${id} window faces the camera sees`).toBeGreaterThanOrEqual(12);
        });

        it('declares ride bulbs and the booth window as evening lights at their emitters, inside the plot', () => {
          const model = modelOf(definition, quarterTurn);
          const { width, depth } = plotOf(definition, quarterTurn);
          const body = model.parts[0];
          const emitters: Vector[] = [];
          forEachVoxel(body.boxes, body.boxCount, 0, 0, 0, (x, y, z, material) => {
            if (material === MAT.BULB || material === MAT.WINDOW_GLOW) emitters.push([x + 0.5, y + 0.5, z + 0.5]);
          });
          expect(model.lights.length, `${id} lights`).toBeGreaterThanOrEqual(2);
          expect(model.lights.length, `${id} lights stay few`).toBeLessThanOrEqual(8);
          expect(model.lights.filter((light) => light.radius === WINDOW_LIGHT_RADIUS).length, 'one booth window light').toBe(1);
          for (const light of model.lights) {
            const [x, y, z] = light.position;
            expect([BULB_LIGHT_RADIUS, WINDOW_LIGHT_RADIUS], `${id} light radius`).toContain(light.radius);
            expect(light.color, `${id} light colour`).toBe(light.radius === BULB_LIGHT_RADIUS ? MAT_COLOR.BULB : MAT_COLOR.WINDOW_GLOW);
            expect(light.presets, `${id} lights glow at dusk and night only`).toBe(EVENING);
            expect(x >= 0 && x <= width && y >= 0 && y <= depth && z >= PLOT_TOP_Z && z <= model.top, `${id} light (${x}, ${y}, ${z}) inside the plot`).toBe(true);
            const nearest = Math.min(...emitters.map(([ex, ey, ez]) => Math.hypot(ex - x, ey - y, ez - z)));
            expect(nearest, `${id} light (${x}, ${y}, ${z}) sits at a static bulb or window`).toBeLessThanOrEqual(2.5);
          }
        });
      });
    }

    it('colours only through the palette: its catalog colours, guest shirts and fixed materials', () => {
      const model = modelOf(definition, 0);
      const color = palette.material(definition.color);
      const accent = palette.material(definition.accent);
      const counts = new Map<number, number>();
      for (const part of model.parts) {
        for (let box = 0; box < part.boxCount; box += 1) {
          const at = box * BOX_FLOATS;
          const word = unpackBoxWord(part.boxes[at + 3]);
          const voxels = part.boxes[at + 4] * part.boxes[at + 5] * part.boxes[at + 6];
          counts.set(word.material, (counts.get(word.material) ?? 0) + voxels);
          expect(word.pattern, 'pattern id').toBeLessThan(PATTERN_LIMIT);
          if (palette.flags(word.material) !== 0) expect(FLAGGED_MATERIALS.has(word.material), `flagged material ${word.material} is a MAT id`).toBe(true);
        }
      }
      const fixed = new Set<number>(Object.values(MAT));
      const shirts = new Set(GUEST_COLORS.map((rgb) => palette.material(rgb)));
      for (const material of counts.keys()) {
        expect(material === color || material === accent || fixed.has(material) || shirts.has(material), `${id} material ${material} comes from the palette's known colours`).toBe(true);
      }
      expect(counts.get(color) ?? 0, `${id} shows its catalog colour`).toBeGreaterThanOrEqual(1_000);
      expect(counts.get(accent) ?? 0, `${id} shows its accent`).toBeGreaterThanOrEqual(300);
      expect(counts.get(MAT.BULB) ?? 0, `${id} has ride bulbs`).toBeGreaterThan(0);
    });

    it('authors moving parts at least 2 voxels thick in both cross-section axes', () => {
      const thin: string[] = [];
      const check = (shape: Shape, part: string): void => {
        if (shape.material === 0) return;
        const where = `${part} ${shape.kind}`;
        switch (shape.kind) {
          case 'box':
            if (shape.size.some((size) => size < 2)) thin.push(`${where} size ${shape.size.join('×')}`);
            break;
          case 'cylinder':
            if (shape.radius < 1 || shape.length < 2) thin.push(`${where} r ${shape.radius} length ${shape.length}`);
            break;
          case 'cone':
            if (shape.radius < 1 || shape.height < 2) thin.push(`${where} r ${shape.radius} height ${shape.height}`);
            break;
          case 'ellipsoid':
            if (shape.radii.some((radius) => radius < 1)) thin.push(`${where} radii ${shape.radii.join(', ')}`);
            break;
          case 'ring':
            if (shape.thickness < 2 || shape.width < 2) thin.push(`${where} thickness ${shape.thickness} width ${shape.width}`);
            break;
          case 'segment':
            if (shape.radius < 1.2) thin.push(`${where} radius ${shape.radius}`);
            break;
          case 'gable':
            thin.push(`${where}: no gables on moving parts`);
            break;
        }
      };
      for (const part of blueprintOf(definition).parts.slice(1)) for (const shape of part.shapes) check(shape, part.id);
      expect(thin, `${id} thin moving features`).toEqual([]);
    });

    it('gives every moving part an integer pivot and a driver that rests at motion 0 and writes unit quaternions', () => {
      const blueprint = blueprintOf(definition);
      const pose = freshPose();
      for (const part of blueprint.parts.slice(1)) {
        expect(part.pivot.every((value) => Number.isInteger(value)), `${part.id} pivot on whole voxels`).toBe(true);
        const driver = driverOf(part.id);
        for (const spin of [0, 1_234.5, 987_654]) {
          driver(motionState(spin, 0), pose);
          expect(pose, `${part.id} rests at motion 0 (spin ${spin})`).toEqual({ dx: 0, dy: 0, dz: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
        }
        for (const { spin, motion } of cyclePoses(97)) {
          driver(motionState(spin + 0.37, motion), pose);
          const length = Math.hypot(pose.qx, pose.qy, pose.qz, pose.qw);
          expect(Math.abs(length - 1), `${part.id} unit quaternion at spin ${spin}`).toBeLessThan(1e-9);
          expect([pose.dx, pose.dy, pose.dz].every(Number.isFinite), `${part.id} finite offset`).toBe(true);
        }
      }
    });
  });
}

describe('generic flat ride drivers', () => {
  it('drive only parts the builder makes', () => {
    const partIds = new Set<string>();
    for (const definition of [...RIDE_IDS.map(definitionOf), MYSTERY_RIDE]) {
      for (const part of blueprintOf(definition).parts.slice(1)) partIds.add(part.id);
    }
    expect(Object.keys(genericRide.drivers ?? {}).sort(), 'one driver per moving part').toEqual([...partIds].sort());
  });

  it('turn each ride at its legacy speed', () => {
    const pose = freshPose();
    const angleAboutZ = (partId: string, spin: number): number => {
      driverOf(partId)(motionState(spin, 1), pose);
      return 2 * Math.atan2(pose.qz, pose.qw);
    };
    const legacy: Record<string, number> = {
      'petal-roundabout:rotor': 0.0011,
      'comet-cups:turntable': 0.0009,
      'harbor-swings:crown': 0.0016,
    };
    for (const [partId, speed] of Object.entries(legacy)) {
      expect(angleAboutZ(partId, 1_000), `${partId} angle after 1 s of spin`).toBeCloseTo(speed * 1_000, 9);
    }
    driverOf('gale-spinner:arm')(motionState(1_000, 1), pose);
    expect(2 * Math.atan2(pose.qy, pose.qw), 'gale arm about +y').toBeCloseTo(1.3, 9);
  });
});

describe('Phase 16 flat ride drivers', () => {
  it('swings the rocket pendulum about +y, never more than 0.5 rad either side and never over the top', () => {
    const pose = freshPose();
    const driver = driverOf('rocket-pendulum:arm');
    let widest = 0;
    let crossed = { left: false, right: false };
    for (let spin = 0; spin < CYCLE_SPIN_MS; spin += 7) {
      driver(motionState(spin, 1), pose);
      expect([pose.qx, pose.qz, pose.dx, pose.dy, pose.dz], 'about +y through the pivot only').toEqual([0, 0, 0, 0, 0]);
      const angle = 2 * Math.atan2(pose.qy, pose.qw);
      widest = Math.max(widest, Math.abs(angle));
      if (angle < -0.45) crossed = { ...crossed, left: true };
      if (angle > 0.45) crossed = { ...crossed, right: true };
    }
    expect(widest, 'amplitude').toBeLessThanOrEqual(0.5 + 1e-9);
    expect(crossed, 'it swings to both sides').toEqual({ left: true, right: true });
    driver(motionState(1_000, 0.5), pose);
    expect(Math.abs(2 * Math.atan2(pose.qy, pose.qw)), 'half motion: half the swing').toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it('hops the puddle jumpers off their pads and only ever upward, carried round with the pads', () => {
    const pose = freshPose();
    const pads = freshPose();
    let highest = 0;
    for (let spin = 0; spin < CYCLE_SPIN_MS; spin += 11) {
      driverOf('puddle-jumpers:pads')(motionState(spin, 1), pads);
      for (let frog = 0; frog < 4; frog += 1) {
        driverOf(`puddle-jumpers:frog-${frog}`)(motionState(spin, 1), pose);
        expect(pose.dz, 'never below the pad').toBeGreaterThanOrEqual(0);
        expect(pose.qz, 'turns with the pads').toBeCloseTo(pads.qz, 12);
        expect(pose.qw, 'turns with the pads').toBeCloseTo(pads.qw, 12);
        highest = Math.max(highest, pose.dz);
      }
    }
    expect(highest, 'a real hop').toBeGreaterThan(5);
  });
});
