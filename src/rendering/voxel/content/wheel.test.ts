import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { footprintSize } from '../../../game/types';
import type { BuildDefinition } from '../../../game/types';
import { compileBlueprint, flattenAtRest, rotateModel } from '../blueprint/compile';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import type { CompiledModel, CompiledPart } from '../contracts/blueprint';
import { BOX_FLOATS, TRANSFORM_FLOATS, unpackBoxWord } from '../contracts/boxes';
import { BOX_BUDGET } from '../contracts/budgets';
import type { ObjectContent } from '../contracts/content';
import { MAT } from '../contracts/palette';
import { restPose } from '../contracts/rigid';
import type { PartPose, RideMotionState } from '../contracts/rigid';
import { PLOT_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';
import { buildPalette } from '../palette';
import { createTransformTable, writeRotatedPartTransform } from '../scene/rigid';
import type { TransformTable } from '../scene/rigid';
import {
  CLOUD_HOPPER_CAR_REST_Z,
  CLOUD_HOPPER_CAR_TRAVEL,
  CLOUD_HOPPER_MAST_TOP_Z,
  cloudHopper,
  cloudHopperHeight,
} from './dropTower';
import {
  auroraWheel,
  WHEEL_CABIN_COUNT,
  WHEEL_CABIN_PIVOTS,
  WHEEL_HUB,
  WHEEL_OUTER_RADIUS,
  WHEEL_SPIN_RADIANS_PER_MS,
  wheelCabinPartId,
} from './wheel';

/**
 * The two bespoke tall rides of this module pair, the aurora wheel and the cloud hopper, checked
 * against the art bible (design §12) and the content rules the compiler cannot see: budgets and
 * limits, footprint bounds at rest and over a whole ride cycle, parts that never overlap, a front
 * the camera can see, drivers that pose parts the way the classic rides move, and colours that
 * only come from the palette.
 *
 * Moving parts are posed exactly as the scene poses them: the driver writes a model-space pose,
 * scene/rigid.ts `writeRotatedPartTransform` composes it with the quarter turn into a transform
 * slot, and the shader's quaternion rotation (vxQuatRotate) places every part-local point.
 */

/** Art bible: a ride tops out at 150 voxels, and its swept volume stays 2 voxels inside the plot. */
const RIDE_TOP_LIMIT = 150;
const SWEPT_MARGIN = 2;
/** Art bible light radii: ride bulbs 16, lit windows 28, lamps 64. */
const ART_BIBLE_LIGHT_RADII: readonly number[] = [16, 28, 64];
/** Materials that glow, shimmer or turn to glass: content may only use them as MAT ids. */
const FLAGGED_MATERIALS_ALLOWED: readonly number[] = [MAT.BULB, MAT.LAMP_GLOW, MAT.GLASS, MAT.WINDOW_GLOW];
const EVENING = LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT;

const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

const definitionOf = (id: string): BuildDefinition => {
  const definition = BUILD_BY_ID.get(id);
  if (!definition) throw new Error(`the catalog has no '${id}'`);
  return definition;
};

const running = (spin: number, progress: number): RideMotionState =>
  ({ spin, motion: 1, progress, elapsedMs: 0, status: 'running' });

const stopped = (spin: number, progress: number): RideMotionState =>
  ({ spin, motion: 0, progress, elapsedMs: 0, status: 'closed' });

interface RideCase {
  readonly definition: BuildDefinition;
  readonly content: ObjectContent;
  /** Motion states through one whole cycle of the ride's moving parts. */
  readonly cycle: readonly RideMotionState[];
}

/** One full turn of the wheel, in spin-ms. */
const WHEEL_TURN_MS = (2 * Math.PI) / WHEEL_SPIN_RADIANS_PER_MS;

const RIDES: readonly RideCase[] = [
  {
    definition: definitionOf('aurora-wheel'),
    content: auroraWheel,
    // 97 steps, which does not divide the cabins' 30° spacing, so the samples do not all repeat
    // the same few symmetric angles.
    cycle: Array.from({ length: 97 }, (_unused, index) => running((index / 97) * WHEEL_TURN_MS, 0)),
  },
  {
    definition: definitionOf('cloud-hopper'),
    content: cloudHopper,
    cycle: Array.from({ length: 201 }, (_unused, index) => running(0, index / 200)),
  },
];

const QUARTER_TURNS: readonly QuarterTurn[] = [0, 1];

const compiled = new Map<string, CompiledModel>();

/** The ride's model at a quarter turn, as ModelCache.model would hand it to the scene. */
const modelOf = (ride: RideCase, quarterTurn: QuarterTurn): CompiledModel => {
  const key = `${ride.definition.id}:${quarterTurn}`;
  let model = compiled.get(key);
  if (!model) {
    model = rotateModel(compileBlueprint(ride.content.blueprint(ride.definition, palette)), quarterTurn);
    compiled.set(key, model);
  }
  return model;
};

/** Calls `visit` with every voxel of `count` boxes in BOX layout, in the boxes' own coordinates. */
const forEachVoxel = (
  boxes: Float32Array,
  count: number,
  visit: (x: number, y: number, z: number, material: number) => void,
): void => {
  for (let offset = 0; offset < count * BOX_FLOATS; offset += BOX_FLOATS) {
    const material = unpackBoxWord(boxes[offset + 3]).material;
    const [x0, y0, z0] = [boxes[offset], boxes[offset + 1], boxes[offset + 2]];
    for (let z = z0; z < z0 + boxes[offset + 6]; z += 1) {
      for (let y = y0; y < y0 + boxes[offset + 5]; y += 1) {
        for (let x = x0; x < x0 + boxes[offset + 4]; x += 1) visit(x, y, z, material);
      }
    }
  }
};

/** Voxel key for a set; coordinates may be negative (part-local voxels) down to −512. */
const voxelKey = (x: number, y: number, z: number): number => ((z + 512) * 1024 + (y + 512)) * 1024 + (x + 512);

const volumeOf = (part: CompiledPart): number => {
  let volume = 0;
  for (let offset = 0; offset < part.boxCount * BOX_FLOATS; offset += BOX_FLOATS) {
    volume += part.boxes[offset + 4] * part.boxes[offset + 5] * part.boxes[offset + 6];
  }
  return volume;
};

const occupancyOf = (boxes: Float32Array, count: number): Set<number> => {
  const occupied = new Set<number>();
  forEachVoxel(boxes, count, (x, y, z) => occupied.add(voxelKey(x, y, z)));
  return occupied;
};

type Quaternion = readonly [number, number, number, number];
type Vector = readonly [number, number, number];

/** gpu/shaders/common.ts vxQuatRotate, in TypeScript. */
const rotate = (q: Quaternion, v: Vector): Vector => {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]);
  const ty = 2 * (q[2] * v[0] - q[0] * v[2]);
  const tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + (q[1] * tz - q[2] * ty),
    v[1] + q[3] * ty + (q[2] * tx - q[0] * tz),
    v[2] + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
};

const newPose = (): PartPose => ({ dx: 0, dy: 0, dz: 0, qx: 0, qy: 0, qz: 0, qw: 1 });

/**
 * Poses every moving part of the model for `state` through the scene's own composition (object
 * origin 0, so world voxels are the rotated model's own) and hands each part's world pivot and
 * orientation to `visit`.
 */
const posePartsFor = (
  ride: RideCase,
  model: CompiledModel,
  quarterTurn: QuarterTurn,
  table: TransformTable,
  state: RideMotionState,
  visit: (part: CompiledPart, partIndex: number, pivot: Vector, rotation: Quaternion) => void,
): void => {
  const pose = newPose();
  model.parts.forEach((part, partIndex) => {
    if (partIndex === 0) return;
    const slot = table.slotFor(1, partIndex);
    restPose(pose);
    ride.content.drivers?.[part.id]?.(state, pose);
    writeRotatedPartTransform(table, slot, 0, 0, 0, quarterTurn, part.pivot, pose);
    const at = (slot - 1) * TRANSFORM_FLOATS;
    const data = table.data;
    visit(part, partIndex, [data[at], data[at + 1], data[at + 2]], [data[at + 4], data[at + 5], data[at + 6], data[at + 7]]);
  });
};

/** Voxels of a part with no filled neighbour along some axis: 1-voxel slivers. */
const sliverCount = (part: CompiledPart): number => {
  const filled = occupancyOf(part.boxes, part.boxCount);
  let slivers = 0;
  forEachVoxel(part.boxes, part.boxCount, (x, y, z) => {
    const alongX = filled.has(voxelKey(x - 1, y, z)) || filled.has(voxelKey(x + 1, y, z));
    const alongY = filled.has(voxelKey(x, y - 1, z)) || filled.has(voxelKey(x, y + 1, z));
    const alongZ = filled.has(voxelKey(x, y, z - 1)) || filled.has(voxelKey(x, y, z + 1));
    if (!alongX || !alongY || !alongZ) slivers += 1;
  });
  return slivers;
};

describe.each(RIDES)('$definition.id content', (ride) => {
  const { definition } = ride;

  it('builds the same blueprint and model every time, under an id of its own', () => {
    const first = ride.content.blueprint(definition, palette);
    const second = ride.content.blueprint(definition, palette);
    expect(second, 'two builds of one definition are equal').toEqual(first);
    expect(first.id, 'the blueprint id names the definition').toContain(definition.id);
    const boxesOf = (model: CompiledModel): number[][] => model.parts.map((part) => Array.from(part.boxes));
    expect(boxesOf(compileBlueprint(second)), 'two compiles are box-for-box equal').toEqual(boxesOf(compileBlueprint(first)));
  });

  it('has a driver for every moving part and for nothing else', () => {
    const partIds = modelOf(ride, 0).parts.slice(1).map((part) => part.id).sort();
    expect(partIds.length, 'the ride has moving parts').toBeGreaterThan(0);
    expect(Object.keys(ride.content.drivers ?? {}).sort(), 'driver ids are the moving part ids').toEqual(partIds);
  });

  it('colours only through the palette: its catalog colours and the fixed materials', () => {
    const materials = new Set<number>();
    for (const part of modelOf(ride, 0).parts) forEachVoxel(part.boxes, part.boxCount, (_x, _y, _z, material) => materials.add(material));
    expect(materials.has(palette.material(definition.color)), 'the catalog colour shows').toBe(true);
    expect(materials.has(palette.material(definition.accent)), 'the catalog accent shows').toBe(true);
    for (const material of materials) {
      expect(material, 'a palette material').toBeLessThan(palette.count);
      if (palette.flags(material) !== 0) expect(FLAGGED_MATERIALS_ALLOWED, `flagged material ${material}`).toContain(material);
    }
  });

  it('holds every moving part at rest while the machine is stopped', () => {
    const pose = newPose();
    const rest = newPose();
    for (const [partId, driver] of Object.entries(ride.content.drivers ?? {})) {
      for (const state of [stopped(0, 0), stopped(12_345, 0.55), stopped(987_654.5, 0.7)]) {
        pose.dx = 5;
        pose.qw = 0.5;
        driver(state, pose);
        expect(pose, `${partId} at spin ${state.spin}, progress ${state.progress}`).toEqual(rest);
      }
    }
  });

  it('writes unit quaternions through a whole cycle', () => {
    const pose = newPose();
    for (const state of ride.cycle) {
      for (const [partId, driver] of Object.entries(ride.content.drivers ?? {})) {
        driver(state, pose);
        const length = Math.hypot(pose.qx, pose.qy, pose.qz, pose.qw);
        expect(length, `${partId} at spin ${state.spin}, progress ${state.progress}`).toBeCloseTo(1, 12);
      }
    }
  });

  it('keeps every moving part at least 2 voxels thick along every axis', () => {
    for (const part of modelOf(ride, 0).parts.slice(1)) {
      expect(sliverCount(part), `${part.id} has no 1-voxel slivers`).toBe(0);
    }
  });

  describe.each(QUARTER_TURNS)('at quarter turn %i', (quarterTurn) => {
    const [tilesWide, tilesDeep] = footprintSize(definition, quarterTurn);
    const width = tilesWide * VOXELS_PER_TILE;
    const depth = tilesDeep * VOXELS_PER_TILE;

    it('compiles within the bespoke-ride box budget and under the art-bible top', () => {
      const model = modelOf(ride, quarterTurn);
      expect(model.boxCount, 'boxes').toBeLessThanOrEqual(BOX_BUDGET.bespokeRide);
      expect(model.top, 'top at rest').toBeLessThanOrEqual(RIDE_TOP_LIMIT);
      expect(model.footprint, 'footprint of the turned model').toEqual([tilesWide, tilesDeep]);
    });

    it('stays inside its footprint at rest, clear of the fence ring', () => {
      const flat = flattenAtRest(modelOf(ride, quarterTurn));
      let outside = 0;
      forEachVoxel(flat.boxes, flat.boxCount, (x, y, z) => {
        if (x < SWEPT_MARGIN || y < SWEPT_MARGIN || x >= width - SWEPT_MARGIN || y >= depth - SWEPT_MARGIN || z < PLOT_TOP_Z) outside += 1;
      });
      expect(outside, `voxels outside [${SWEPT_MARGIN}, footprint − ${SWEPT_MARGIN}) or below the plot top`).toBe(0);
    });

    it('keeps its moving parts clear of the body and of each other at rest', () => {
      const model = modelOf(ride, quarterTurn);
      const flat = flattenAtRest(model);
      const partVoxels = model.parts.reduce((sum, part) => sum + volumeOf(part), 0);
      expect(occupancyOf(flat.boxes, flat.boxCount).size, 'at-rest voxel union = sum of the parts').toBe(partVoxels);
    });

    it('sweeps its moving parts inside the footprint minus 2 voxels and under the top through a whole cycle', () => {
      const model = modelOf(ride, quarterTurn);
      const table = createTransformTable();
      const low = [Infinity, Infinity, Infinity];
      const high = [-Infinity, -Infinity, -Infinity];
      for (const state of ride.cycle) {
        posePartsFor(ride, model, quarterTurn, table, state, (part, _partIndex, pivot, rotation) => {
          for (let offset = 0; offset < part.boxCount * BOX_FLOATS; offset += BOX_FLOATS) {
            for (let corner = 0; corner < 8; corner += 1) {
              const local: Vector = [
                part.boxes[offset] + (corner & 1 ? part.boxes[offset + 4] : 0),
                part.boxes[offset + 1] + (corner & 2 ? part.boxes[offset + 5] : 0),
                part.boxes[offset + 2] + (corner & 4 ? part.boxes[offset + 6] : 0),
              ];
              const turned = rotate(rotation, local);
              for (let axis = 0; axis < 3; axis += 1) {
                low[axis] = Math.min(low[axis], pivot[axis] + turned[axis]);
                high[axis] = Math.max(high[axis], pivot[axis] + turned[axis]);
              }
            }
          }
        });
      }
      expect(low[0], 'swept min x').toBeGreaterThanOrEqual(SWEPT_MARGIN);
      expect(low[1], 'swept min y').toBeGreaterThanOrEqual(SWEPT_MARGIN);
      expect(high[0], 'swept max x').toBeLessThanOrEqual(width - SWEPT_MARGIN);
      expect(high[1], 'swept max y').toBeLessThanOrEqual(depth - SWEPT_MARGIN);
      expect(low[2], 'swept min z (never into the plot)').toBeGreaterThanOrEqual(PLOT_TOP_Z);
      expect(high[2], 'swept max z').toBeLessThanOrEqual(RIDE_TOP_LIMIT);
    });

    it('never runs a moving part into the body or into another moving part', () => {
      // Every moving voxel's centre, posed as the scene poses it, must land in a voxel that neither
      // the body nor another moving part holds at that moment.
      const model = modelOf(ride, quarterTurn);
      const height = RIDE_TOP_LIMIT + 8;
      const cellOf = (x: number, y: number, z: number): number =>
        (x < 0 || y < 0 || z < 0 || x >= width || y >= depth || z >= height ? -1 : (z * depth + y) * width + x);
      const body = new Uint8Array(width * depth * height);
      const bodyPart = model.parts[0];
      forEachVoxel(bodyPart.boxes, bodyPart.boxCount, (x, y, z) => { body[cellOf(x, y, z)] = 1; });
      const stamp = new Int32Array(body.length);
      const owner = new Int16Array(body.length);
      const table = createTransformTable();
      let outside = 0;
      const collisions = new Map<string, number>();
      ride.cycle.forEach((state, sample) => {
        posePartsFor(ride, model, quarterTurn, table, state, (part, partIndex, pivot, rotation) => {
          forEachVoxel(part.boxes, part.boxCount, (x, y, z) => {
            const turned = rotate(rotation, [x + 0.5, y + 0.5, z + 0.5]);
            const cell = cellOf(
              Math.floor(pivot[0] + turned[0]),
              Math.floor(pivot[1] + turned[1]),
              Math.floor(pivot[2] + turned[2]),
            );
            if (cell < 0) {
              outside += 1;
              return;
            }
            let other: string | null = null;
            if (body[cell] === 1) other = 'body';
            else if (stamp[cell] === sample + 1 && owner[cell] !== partIndex) other = model.parts[owner[cell]].id;
            if (other !== null) {
              const pair = `${part.id} × ${other}`;
              collisions.set(pair, (collisions.get(pair) ?? 0) + 1);
              return;
            }
            stamp[cell] = sample + 1;
            owner[cell] = partIndex;
          });
        });
      });
      expect(outside, 'moving voxels outside the footprint').toBe(0);
      expect([...collisions.entries()], 'colliding voxels by part pair over the cycle').toEqual([]);
    });

    it('shows its front window on a face the camera sees', () => {
      // The front feature is the operator booth's lit window: the body's only glass, on the model's
      // front (+y) face, which quarter turn 0 shows as world +y and quarter turn 1 as world +x.
      const model = modelOf(ride, quarterTurn);
      const flat = flattenAtRest(model);
      const occupied = occupancyOf(flat.boxes, flat.boxCount);
      const [stepX, stepY] = quarterTurn === 0 ? [0, 1] : [1, 0];
      let windowVoxels = 0;
      let covered = 0;
      const body = model.parts[0];
      forEachVoxel(body.boxes, body.boxCount, (x, y, z, material) => {
        if (material !== MAT.GLASS) return;
        windowVoxels += 1;
        if (occupied.has(voxelKey(x + stepX, y + stepY, z))) covered += 1;
      });
      expect(windowVoxels, 'the body has a front window').toBeGreaterThan(0);
      expect(covered, `window voxels covered on their world ${quarterTurn === 0 ? '+y' : '+x'} face`).toBe(0);
    });

    it('declares evening lights with art-bible radii inside the footprint', () => {
      const model = modelOf(ride, quarterTurn);
      expect(model.lights.length, 'lights').toBeGreaterThan(0);
      for (const light of model.lights) {
        const [x, y, z] = light.position;
        expect(ART_BIBLE_LIGHT_RADII, `light at ${light.position.join(', ')}`).toContain(light.radius);
        expect(light.presets & EVENING, 'on at dusk and night').toBe(EVENING);
        expect(x >= 0 && x <= width && y >= 0 && y <= depth && z >= PLOT_TOP_Z && z <= RIDE_TOP_LIMIT, `light at ${x}, ${y}, ${z} inside the plot`).toBe(true);
      }
    });
  });
});

describe('aurora wheel', () => {
  const [ride] = RIDES;
  const drivers = auroraWheel.drivers ?? {};
  const model = modelOf(ride, 0);
  const [hubX, hubY, hubZ] = WHEEL_HUB;

  it('stands the disc in the plane of the plot\'s long axis with a radius of at most 56', () => {
    const [tilesWide, tilesDeep] = ride.definition.footprint;
    expect(tilesWide, 'model x is the long axis').toBeGreaterThan(tilesDeep);
    const wheel = model.parts.find((part) => part.id === 'wheel');
    if (!wheel) throw new Error('no wheel part');
    expect(wheel.pivot, 'the wheel turns about the hub').toEqual(WHEEL_HUB);
    let farthest = 0;
    forEachVoxel(wheel.boxes, wheel.boxCount, (x, _y, z) => {
      farthest = Math.max(farthest, Math.hypot(x + 0.5, z + 0.5));
    });
    expect(farthest, 'largest voxel-centre radius in the x–z plane').toBeLessThanOrEqual(WHEEL_OUTER_RADIUS);
    expect(WHEEL_OUTER_RADIUS, 'art bible radius').toBeLessThanOrEqual(56);
  });

  it('turns the wheel about model y at the legacy 0.00045 rad per spin-ms, clockwise on screen', () => {
    const pose = newPose();
    for (const spin of [1, 700, 5_000, 123_456]) {
      drivers.wheel(running(spin, 0), pose);
      expect([pose.dx, pose.dy, pose.dz, pose.qx, pose.qz], 'a pure turn about y').toEqual([0, 0, 0, 0, 0]);
      const angle = 2 * Math.atan2(pose.qy, pose.qw);
      const expected = spin * 0.00045;
      expect(Math.cos(angle), `cos of the angle at spin ${spin}`).toBeCloseTo(Math.cos(expected), 9);
      expect(Math.sin(angle), `sin of the angle at spin ${spin}`).toBeCloseTo(Math.sin(expected), 9);
    }
    // A small positive turn carries the rim's top toward +x: clockwise on screen, like the classic wheel.
    drivers.wheel(running(100, 0), pose);
    const top = rotate([pose.qx, pose.qy, pose.qz, pose.qw], [0, 0, 50]);
    expect(top[0], 'the top of the rim moves toward +x').toBeGreaterThan(0);
  });

  it('keeps every cabin level on the rim point it hangs from', () => {
    const pose = newPose();
    const wheelPose = newPose();
    expect(WHEEL_CABIN_PIVOTS.length, 'cabins').toBe(WHEEL_CABIN_COUNT);
    for (const spin of [0, 333, 2_500, 9_999, 77_777]) {
      const state = running(spin, 0);
      drivers.wheel(state, wheelPose);
      const rotation: Quaternion = [wheelPose.qx, wheelPose.qy, wheelPose.qz, wheelPose.qw];
      WHEEL_CABIN_PIVOTS.forEach((pivot, index) => {
        drivers[wheelCabinPartId(index)](state, pose);
        expect([pose.qx, pose.qy, pose.qz, pose.qw], `cabin ${index} stays level`).toEqual([0, 0, 0, 1]);
        // Where the wheel's own rotation carries the cabin's rim point.
        const rim = rotate(rotation, [pivot[0] - hubX, pivot[1] - hubY, pivot[2] - hubZ]);
        expect(pivot[0] + pose.dx, `cabin ${index} x at spin ${spin}`).toBeCloseTo(hubX + rim[0], 9);
        expect(pivot[1] + pose.dy, `cabin ${index} y at spin ${spin}`).toBeCloseTo(hubY + rim[1], 9);
        expect(pivot[2] + pose.dz, `cabin ${index} z at spin ${spin}`).toBeCloseTo(hubZ + rim[2], 9);
      });
    }
  });
});

describe('cloud hopper', () => {
  const [, ride] = RIDES;
  const drive = (cloudHopper.drivers ?? {}).car;
  const model = modelOf(ride, 0);

  it('follows the legacy cycle: hold, smoothstep climb, hang, cubic drop, one rebound', () => {
    const expectations: readonly [number, number][] = [
      [0, 0],
      [0.06, 0],
      [0.28, 0.5],
      [0.5, 1],
      [0.6, 1],
      [0.67, 1 - 0.5 ** 3],
      [0.72, 0],
      [0.77, 0.14],
      [0.9, 0],
      [1, 0],
    ];
    for (const [progress, height] of expectations) {
      expect(cloudHopperHeight(progress), `height at progress ${progress}`).toBeCloseTo(height, 9);
    }
  });

  it('lifts the car along z only, by the legacy 104 voxels of travel', () => {
    const pose = newPose();
    for (const state of ride.cycle) {
      drive(state, pose);
      expect([pose.dx, pose.dy, pose.qx, pose.qy, pose.qz, pose.qw], `progress ${state.progress}`).toEqual([0, 0, 0, 0, 0, 1]);
      expect(pose.dz, `height at progress ${state.progress}`).toBeCloseTo(CLOUD_HOPPER_CAR_TRAVEL * cloudHopperHeight(state.progress), 9);
    }
  });

  it('rests the car 6 voxels above the plot and keeps it under the winch house at the top', () => {
    const car = model.parts.find((part) => part.id === 'car');
    if (!car) throw new Error('no car part');
    expect(car.pivot[2] + car.min[2], 'car bottom at rest').toBe(CLOUD_HOPPER_CAR_REST_Z);
    expect(CLOUD_HOPPER_CAR_REST_Z, 'legacy rest height').toBe(PLOT_TOP_Z + 6);
    const topOfTravel = car.pivot[2] + car.max[2] + CLOUD_HOPPER_CAR_TRAVEL;
    expect(topOfTravel, 'car top at the top of its travel, with a visible gap under the house').toBeLessThanOrEqual(CLOUD_HOPPER_MAST_TOP_Z - 2);
  });

  it('crowns the mast with a glowing beacon and its light', () => {
    const body = model.parts[0];
    let beaconTop = -Infinity;
    forEachVoxel(body.boxes, body.boxCount, (_x, _y, z, material) => {
      if (material === MAT.LAMP_GLOW) beaconTop = Math.max(beaconTop, z + 1);
    });
    expect(beaconTop, 'the beacon glows above the mast').toBeGreaterThan(CLOUD_HOPPER_MAST_TOP_Z);
    const beaconLight = model.lights.find((light) => light.position[2] > CLOUD_HOPPER_MAST_TOP_Z);
    expect(beaconLight?.radius, 'the beacon lights like a ride bulb').toBe(16);
  });
});
