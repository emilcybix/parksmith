import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import type { BuildDefinition } from '../../../game/types';
import { footprintSize } from '../../../game/types';
import { compileBlueprint, compileBlueprintReport, flattenAtRest, rotateModel } from '../blueprint/compile';
import { LIGHT_PRESET_DAY, LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import type { CompiledModel, CompiledPart, Vec3 } from '../contracts/blueprint';
import { BOX_FLOATS, TRANSFORM_FLOATS, unpackBoxWord } from '../contracts/boxes';
import { BOX_BUDGET } from '../contracts/budgets';
import { MAT, MAT_COLOR } from '../contracts/palette';
import type { PartDriver, PartPose, RideMotionState } from '../contracts/rigid';
import { PLOT_TOP_Z, projectX, projectY, VOXELS_PER_TILE } from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';
import { buildPalette } from '../palette';
import { createTransformTable, writeRotatedPartTransform } from '../scene/rigid';
import {
  buildMoonpetalCarousel,
  CAROUSEL_BOB_VOXELS,
  CAROUSEL_CENTRE,
  CAROUSEL_FOOTPRINT,
  CAROUSEL_GALLERY,
  CAROUSEL_HORSE_COUNT,
  CAROUSEL_HORSES,
  CAROUSEL_RADIANS_PER_SPIN_MS,
  CAROUSEL_ROTOR_PART_ID,
  carouselAngle,
  carouselHorsePartId,
  moonpetalCarousel,
} from './carousel';

/**
 * The carousel is a model other code only ever sees compiled, posed and drawn, so its promises
 * are pinned here where a bad edit would otherwise only show up on screen: it compiles inside the
 * bespoke-ride budget, stays on its plot at rest and through a whole ride cycle, never lets a
 * moving part share a voxel with anything at rest, keeps the stripes and the boarding step where
 * the camera sees them at both visual quarter turns, and turns like the classic carousel.
 */

const DEFINITION_IDS = ['moonpetal-carousel'] as const;
const QUARTER_TURNS: readonly QuarterTurn[] = [0, 1];
/** Art bible (design §12): rides top out at 150 voxels. */
const RIDE_TOP_LIMIT = 150;
/** The ride fence stands in the plot's outer 2 voxels; swept volumes stay inside the footprint minus 2. */
const FENCE_BAND = 2;
const RIDE_BULB_LIGHT_RADIUS = 16;
const WINDOW_LIGHT_RADIUS = 28;
const EVENING = LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT;
/** One full turn of the rotor, in spin-ms. */
const ROTOR_PERIOD = (Math.PI * 2) / CAROUSEL_RADIANS_PER_SPIN_MS;
/** Idle (legacy RIDE_IDLE_MOTION), half way and running. */
const MOTIONS: readonly number[] = [0.14, 0.5, 1];
const SPIN_SAMPLES = 240;

const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

const definitionOf = (id: string): BuildDefinition => {
  const definition = BUILD_BY_ID.get(id);
  if (!definition) throw new Error(`catalog has no '${id}'`);
  return definition;
};

const modelOf = (id: string, quarterTurn: QuarterTurn): CompiledModel =>
  rotateModel(compileBlueprint(buildMoonpetalCarousel(definitionOf(id), palette)), quarterTurn);

const motionState = (spin: number, motion: number): RideMotionState =>
  ({ spin, motion, progress: 0, elapsedMs: 0, status: motion > 0 ? 'running' : 'closed' });

const freshPose = (): PartPose => ({ dx: 7, dy: 7, dz: 7, qx: 0.5, qy: 0.5, qz: 0.5, qw: 0.5 });

const driverOf = (partId: string): PartDriver => {
  const driver = moonpetalCarousel.drivers?.[partId];
  if (!driver) throw new Error(`no driver for part '${partId}'`);
  return driver;
};

/** Every spin value the sweep tests visit: a full rotor turn, plus far-off spins (long sessions). */
const sweepSpins = (): number[] => [
  ...Array.from({ length: SPIN_SAMPLES }, (_unused, index) => (index / SPIN_SAMPLES) * ROTOR_PERIOD + 1.5),
  1e7 + 333,
  4.2e8 + 17,
];

/** q ⊗ v ⊗ q⁻¹ for a unit quaternion (the vertex shader's vxQuatRotate). */
const rotate = (qx: number, qy: number, qz: number, qw: number, x: number, y: number, z: number): Vec3 => {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
};

interface WorldPose {
  pivot: Vec3;
  rotation: readonly [number, number, number, number];
}

/** One transform slot, rewritten for every pose (a table per pose would allocate 4096 slots each time). */
const TABLE = createTransformTable();
const SLOT = TABLE.slotFor(1, 1);

/** The world transform the scene writes for a part of a turned model (placement origin 0). */
const worldPoseOf = (part: CompiledPart, quarterTurn: QuarterTurn, pose: PartPose): WorldPose => {
  writeRotatedPartTransform(TABLE, SLOT, 0, 0, 0, quarterTurn, part.pivot, pose);
  const at = (SLOT - 1) * TRANSFORM_FLOATS;
  const data = TABLE.data;
  return { pivot: [data[at], data[at + 1], data[at + 2]], rotation: [data[at + 4], data[at + 5], data[at + 6], data[at + 7]] };
};

/** A part-local point placed by a world pose. */
const place = (world: WorldPose, x: number, y: number, z: number): Vec3 => {
  const [qx, qy, qz, qw] = world.rotation;
  const turned = rotate(qx, qy, qz, qw, x, y, z);
  return [world.pivot[0] + turned[0], world.pivot[1] + turned[1], world.pivot[2] + turned[2]];
};

/** All eight corners of every box of a part, placed by a world pose. */
const placedCorners = (part: CompiledPart, world: WorldPose): Vec3[] => {
  const corners: Vec3[] = [];
  for (let box = 0; box < part.boxCount; box += 1) {
    const at = box * BOX_FLOATS;
    for (let corner = 0; corner < 8; corner += 1) {
      corners.push(place(
        world,
        part.boxes[at] + (corner & 1 ? part.boxes[at + 4] : 0),
        part.boxes[at + 1] + (corner & 2 ? part.boxes[at + 5] : 0),
        part.boxes[at + 2] + (corner & 4 ? part.boxes[at + 6] : 0),
      ));
    }
  }
  return corners;
};

/** Every voxel a box list covers (offset by `origin`), as integer keys, counting repeats. */
const voxelsOf = (boxes: Float32Array, count: number, origin: Vec3, into: Set<number>): number => {
  let visited = 0;
  for (let box = 0; box < count; box += 1) {
    const at = box * BOX_FLOATS;
    const minX = boxes[at] + origin[0];
    const minY = boxes[at + 1] + origin[1];
    const minZ = boxes[at + 2] + origin[2];
    for (let z = minZ; z < minZ + boxes[at + 6]; z += 1) {
      for (let y = minY; y < minY + boxes[at + 5]; y += 1) {
        for (let x = minX; x < minX + boxes[at + 4]; x += 1) {
          into.add((z * 256 + y) * 256 + x);
          visited += 1;
        }
      }
    }
  }
  return visited;
};

/** Model-space bounds of a box list, [min, max]. */
const boundsOf = (boxes: Float32Array, count: number, keep: (at: number) => boolean = () => true): [Vec3, Vec3] => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let box = 0; box < count; box += 1) {
    const at = box * BOX_FLOATS;
    if (!keep(at)) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], boxes[at + axis]);
      max[axis] = Math.max(max[axis], boxes[at + axis] + boxes[at + 4 + axis]);
    }
  }
  return [[min[0], min[1], min[2]], [max[0], max[1], max[2]]];
};

const materialOf = (boxes: Float32Array, at: number): number => unpackBoxWord(boxes[at + 3]).material;

/** Material of the highest body voxel over the column (x, y), or 0. */
const topMaterialAt = (body: CompiledPart, x: number, y: number): number => {
  let top = -Infinity;
  let material = 0;
  for (let box = 0; box < body.boxCount; box += 1) {
    const at = box * BOX_FLOATS;
    const inside = x >= body.boxes[at] && x < body.boxes[at] + body.boxes[at + 4]
      && y >= body.boxes[at + 1] && y < body.boxes[at + 1] + body.boxes[at + 5];
    const boxTop = body.boxes[at + 2] + body.boxes[at + 6];
    if (inside && boxTop > top) {
      top = boxTop;
      material = materialOf(body.boxes, at);
    }
  }
  return material;
};

describe.each(DEFINITION_IDS)('moonpetal carousel content (%s)', (definitionId) => {
  const definition = definitionOf(definitionId);
  const color = palette.material(definition.color);
  const accent = palette.material(definition.accent);
  const movingPartIds = [CAROUSEL_ROTOR_PART_ID, ...Array.from({ length: CAROUSEL_HORSE_COUNT }, (_unused, index) => carouselHorsePartId(index))];

  it('is authored for the catalog footprint, with a driver for every moving part', () => {
    expect(definition.footprint, 'the model is laid out for a 3×3 plot').toEqual(CAROUSEL_FOOTPRINT);
    const blueprint = buildMoonpetalCarousel(definition, palette);
    expect(blueprint.parts.map((part) => part.id), 'parts').toEqual(['body', ...movingPartIds]);
    expect(Object.keys(moonpetalCarousel.drivers ?? {}).sort(), 'drivers').toEqual([...movingPartIds].sort());
    expect(blueprint.id, 'the blueprint id names the builder and the definition').toContain(definition.id);
  });

  it('builds and compiles deterministically', () => {
    const first = buildMoonpetalCarousel(definition, palette);
    const second = moonpetalCarousel.blueprint(definition, palette);
    expect(second, 'two builds of the same definition').toEqual(first);
    const compiledFirst = compileBlueprint(first);
    const compiledSecond = compileBlueprint(second);
    compiledFirst.parts.forEach((part, index) => {
      expect(Array.from(compiledSecond.parts[index].boxes), `part ${part.id} boxes`).toEqual(Array.from(part.boxes));
    });
  });

  it.each(QUARTER_TURNS)('compiles inside the bespoke-ride box budget and the art-bible height (quarter turn %i)', (quarterTurn) => {
    const report = compileBlueprintReport(buildMoonpetalCarousel(definition, palette));
    const model = rotateModel(report.model, quarterTurn);
    const ratios = report.parts.map((part) => `${part.id} ${part.rasterRatio.toFixed(2)}`).join(', ');
    // Raster/exposed is reported, not gated (contracts/budgets.ts): box counts are the gate.
    expect(model.boxCount, `boxes (raster/exposed: ${ratios})`).toBeLessThanOrEqual(BOX_BUDGET.bespokeRide);
    expect(model.top, 'top').toBeLessThanOrEqual(RIDE_TOP_LIMIT);
    expect(model.parts.every((part) => part.boxCount > 0), 'every part has boxes').toBe(true);
  });

  it.each(QUARTER_TURNS)('stays on its plot at rest, clear of the fence band (quarter turn %i)', (quarterTurn) => {
    const model = modelOf(definitionId, quarterTurn);
    const [tilesX, tilesY] = footprintSize(definition, quarterTurn);
    const flat = flattenAtRest(model);
    const [min, max] = boundsOf(flat.boxes, flat.boxCount);
    expect(min[0], 'min x').toBeGreaterThanOrEqual(FENCE_BAND);
    expect(min[1], 'min y').toBeGreaterThanOrEqual(FENCE_BAND);
    expect(max[0], 'max x').toBeLessThanOrEqual(tilesX * VOXELS_PER_TILE - FENCE_BAND);
    expect(max[1], 'max y').toBeLessThanOrEqual(tilesY * VOXELS_PER_TILE - FENCE_BAND);
    expect(min[2], 'nothing reaches into the plot slab').toBeGreaterThanOrEqual(PLOT_TOP_Z);
  });

  it.each(QUARTER_TURNS)('never lets two parts share a voxel at rest (quarter turn %i)', (quarterTurn) => {
    const model = modelOf(definitionId, quarterTurn);
    let perPart = 0;
    for (const part of model.parts) perPart += voxelsOf(part.boxes, part.boxCount, part.pivot, new Set());
    const flat = flattenAtRest(model);
    const union = new Set<number>();
    const visited = voxelsOf(flat.boxes, flat.boxCount, [0, 0, 0], union);
    expect(visited, 'the flat list covers every part voxel once').toBe(perPart);
    expect(union.size, 'union of all parts at rest = sum of the parts (no overlap, no z-fighting)').toBe(perPart);
  });

  it('keeps the gallery free of static voxels, so the moving parts have room to turn', () => {
    const body = modelOf(definitionId, 0).parts[0];
    let intruders = 0;
    const voxels = new Set<number>();
    voxelsOf(body.boxes, body.boxCount, [0, 0, 0], voxels);
    for (const key of voxels) {
      const x = (key % 256) + 0.5 - CAROUSEL_CENTRE;
      const y = (Math.floor(key / 256) % 256) + 0.5 - CAROUSEL_CENTRE;
      const z = Math.floor(key / 65_536) + 0.5;
      const radius = Math.hypot(x, y);
      const inGallery = z > CAROUSEL_GALLERY.floorZ && z < CAROUSEL_GALLERY.ceilingZ
        && radius > CAROUSEL_GALLERY.innerRadius - 1 && radius < CAROUSEL_GALLERY.outerRadius + 1;
      if (inGallery) intruders += 1;
    }
    expect(intruders, 'static voxels inside the gallery').toBe(0);
  });

  it.each(QUARTER_TURNS)('sweeps its moving parts only through the gallery, inside the plot minus 2 (quarter turn %i)', (quarterTurn) => {
    const model = modelOf(definitionId, quarterTurn);
    const [tilesX, tilesY] = footprintSize(definition, quarterTurn);
    const pose = freshPose();
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    let radiusLow = Infinity;
    let radiusHigh = -Infinity;
    for (const motion of MOTIONS) {
      for (const spin of sweepSpins()) {
        model.parts.forEach((part, index) => {
          if (index === 0) return;
          driverOf(part.id)(motionState(spin, motion), pose);
          for (const [x, y, z] of placedCorners(part, worldPoseOf(part, quarterTurn, pose))) {
            low[0] = Math.min(low[0], x);
            low[1] = Math.min(low[1], y);
            low[2] = Math.min(low[2], z);
            high[0] = Math.max(high[0], x);
            high[1] = Math.max(high[1], y);
            high[2] = Math.max(high[2], z);
            const radius = Math.hypot(x - CAROUSEL_CENTRE, y - CAROUSEL_CENTRE);
            radiusLow = Math.min(radiusLow, radius);
            radiusHigh = Math.max(radiusHigh, radius);
          }
        });
      }
    }
    const tolerance = 1e-4;
    expect(low[0], 'swept min x').toBeGreaterThanOrEqual(FENCE_BAND);
    expect(low[1], 'swept min y').toBeGreaterThanOrEqual(FENCE_BAND);
    expect(high[0], 'swept max x').toBeLessThanOrEqual(tilesX * VOXELS_PER_TILE - FENCE_BAND);
    expect(high[1], 'swept max y').toBeLessThanOrEqual(tilesY * VOXELS_PER_TILE - FENCE_BAND);
    expect(low[2], 'nothing sinks into the deck').toBeGreaterThanOrEqual(CAROUSEL_GALLERY.floorZ - tolerance);
    expect(high[2], 'nothing rises into the canopy').toBeLessThanOrEqual(CAROUSEL_GALLERY.ceilingZ + tolerance);
    expect(radiusLow, 'nothing sweeps into the drum').toBeGreaterThanOrEqual(CAROUSEL_GALLERY.innerRadius);
    expect(radiusHigh, 'nothing sweeps into the valance').toBeLessThanOrEqual(CAROUSEL_GALLERY.outerRadius);
  });

  it.each(QUARTER_TURNS)('carries every horse on its own pole, facing its direction of travel (quarter turn %i)', (quarterTurn) => {
    const model = modelOf(definitionId, quarterTurn);
    const rotor = model.parts.find((part) => part.id === CAROUSEL_ROTOR_PART_ID);
    if (!rotor) throw new Error('no rotor part');
    const turn = (x: number, y: number): [number, number] => (quarterTurn === 0 ? [x, y] : [y, -x]);
    const rotorPose = freshPose();
    const horsePose = freshPose();
    for (const spin of sweepSpins().filter((_spin, index) => index % 8 === 0)) {
      driverOf(CAROUSEL_ROTOR_PART_ID)(motionState(spin, 1), rotorPose);
      const rotorWorld = worldPoseOf(rotor, quarterTurn, rotorPose);
      CAROUSEL_HORSES.forEach((horse, index) => {
        const part = model.parts.find((candidate) => candidate.id === carouselHorsePartId(index));
        if (!part) throw new Error(`no part for horse ${index}`);
        driverOf(part.id)(motionState(spin, 1), horsePose);
        const horseWorld = worldPoseOf(part, quarterTurn, horsePose);
        // Pole centre and channel centre, in each part's turned, pivot-relative coordinates.
        const [localX, localY] = turn(horse.poleX - CAROUSEL_CENTRE, horse.poleY - CAROUSEL_CENTRE);
        const pole = place(rotorWorld, localX, localY, 10);
        const channel = place(horseWorld, localX, localY, 10);
        expect(Math.hypot(pole[0] - channel[0], pole[1] - channel[1]), `horse ${index} stays on its pole at spin ${spin}`).toBeLessThan(1e-3);
        // Forward (the heading's axis, turned with the model) against the tangent at the pole.
        const headingAngle = (horse.heading * Math.PI) / 2;
        const [forwardX, forwardY] = turn(Math.cos(headingAngle), Math.sin(headingAngle));
        const forward = rotate(...horseWorld.rotation, forwardX, forwardY, 0);
        const radialX = pole[0] - CAROUSEL_CENTRE;
        const radialY = pole[1] - CAROUSEL_CENTRE;
        const tangent = [-radialY / Math.hypot(radialX, radialY), radialX / Math.hypot(radialX, radialY)];
        expect(forward[0] * tangent[0] + forward[1] * tangent[1], `horse ${index} faces its travel at spin ${spin}`).toBeGreaterThan(0.9999);
      });
    }
  });

  it('rests every part while the machine has never moved, and poses with unit quaternions when it has', () => {
    const pose = freshPose();
    for (const partId of movingPartIds) {
      for (const spin of [0, 730, 5_000, 1e7]) {
        driverOf(partId)(motionState(spin, 0), pose);
        expect(pose, `${partId} rests at motion 0, spin ${spin}`).toEqual({ dx: 0, dy: 0, dz: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
      }
      for (const motion of MOTIONS) {
        for (const spin of sweepSpins()) {
          driverOf(partId)(motionState(spin, motion), pose);
          const length = Math.hypot(pose.qx, pose.qy, pose.qz, pose.qw);
          expect(Math.abs(length - 1), `${partId} quaternion length at spin ${spin}`).toBeLessThan(1e-9);
          expect([pose.qx, pose.qy], `${partId} turns about +z only`).toEqual([0, 0]);
        }
      }
    }
  });

  it('turns the rotor at the legacy rate, clockwise on screen at both quarter turns', () => {
    const pose = freshPose();
    driverOf(CAROUSEL_ROTOR_PART_ID)(motionState(1_000, 1), pose);
    expect(2 * Math.atan2(pose.qz, pose.qw), 'rotor angle').toBeCloseTo(1_000 * CAROUSEL_RADIANS_PER_SPIN_MS, 9);
    expect(carouselAngle(ROTOR_PERIOD * 3 + 100), 'angle wraps to one turn').toBeCloseTo(100 * CAROUSEL_RADIANS_PER_SPIN_MS, 6);
    for (const quarterTurn of QUARTER_TURNS) {
      const model = modelOf(definitionId, quarterTurn);
      const rotor = model.parts[1];
      const centre = [projectX(CAROUSEL_CENTRE, CAROUSEL_CENTRE), projectY(CAROUSEL_CENTRE, CAROUSEL_CENTRE, 10)];
      const screenAt = (spin: number): [number, number] => {
        driverOf(CAROUSEL_ROTOR_PART_ID)(motionState(spin, 1), pose);
        const [localX, localY] = quarterTurn === 0
          ? [CAROUSEL_HORSES[0].poleX - CAROUSEL_CENTRE, CAROUSEL_HORSES[0].poleY - CAROUSEL_CENTRE]
          : [CAROUSEL_HORSES[0].poleY - CAROUSEL_CENTRE, CAROUSEL_CENTRE - CAROUSEL_HORSES[0].poleX];
        const [x, y, z] = place(worldPoseOf(rotor, quarterTurn, pose), localX, localY, 5);
        return [projectX(x, y) - centre[0], projectY(x, y, z) - centre[1]];
      };
      for (const spin of [500, 2_500, 4_500, 6_500]) {
        const [x, y] = screenAt(spin);
        const [nextX, nextY] = screenAt(spin + 20);
        // Screen y points down, so a positive cross product is clockwise.
        expect(x * (nextY - y) - y * (nextX - x), `clockwise at quarter turn ${quarterTurn}, spin ${spin}`).toBeGreaterThan(0);
      }
    }
  });

  it('bobs every horse in whole voxels, up to ±2 while running, out of phase with its neighbours', () => {
    const pose = freshPose();
    const running = new Set<number>();
    const idle = new Set<number>();
    let outOfPhase = 0;
    for (const spin of sweepSpins()) {
      const heights = new Set<number>();
      for (let index = 0; index < CAROUSEL_HORSE_COUNT; index += 1) {
        driverOf(carouselHorsePartId(index))(motionState(spin, 1), pose);
        expect(Number.isInteger(pose.dz), 'whole-voxel bob').toBe(true);
        running.add(pose.dz);
        heights.add(pose.dz);
        driverOf(carouselHorsePartId(index))(motionState(spin, 0.14), pose);
        idle.add(pose.dz);
      }
      if (heights.size > 1) outOfPhase += 1;
    }
    expect(Math.max(...running), 'running bob reaches the top of the stroke').toBe(CAROUSEL_BOB_VOXELS);
    expect(Math.min(...running), 'and the bottom').toBe(-CAROUSEL_BOB_VOXELS);
    expect(Math.max(...[...idle].map(Math.abs)), 'idling bob is a third of the stroke').toBeLessThanOrEqual(1);
    expect(outOfPhase, 'samples where the horses are at different heights').toBeGreaterThan(SPIN_SAMPLES * 0.9);
  });

  it.each(QUARTER_TURNS)('shows the front step on a camera-facing edge (quarter turn %i)', (quarterTurn) => {
    const body = modelOf(definitionId, quarterTurn).parts[0];
    const isStep = (at: number): boolean => materialOf(body.boxes, at) === MAT.TIMBER;
    const isLow = (at: number): boolean => body.boxes[at + 2] < PLOT_TOP_Z + 4;
    const [, stepMax] = boundsOf(body.boxes, body.boxCount, isStep);
    const [, lowMax] = boundsOf(body.boxes, body.boxCount, isLow);
    // The front (model +y) is world +y at quarter turn 0 and world +x at quarter turn 1.
    const frontAxis = quarterTurn === 0 ? 1 : 0;
    expect(Number.isFinite(stepMax[frontAxis]), 'the step exists').toBe(true);
    expect(stepMax[frontAxis], 'the step is the frontmost thing at platform height').toBe(lowMax[frontAxis]);
    expect(stepMax[frontAxis], 'and ends on the plot\'s front edge minus the fence band').toBe(VOXELS_PER_TILE * CAROUSEL_FOOTPRINT[1] - FENCE_BAND);
  });

  it.each(QUARTER_TURNS)('stripes the canopy in the ride colour and accent, a colour wedge facing the camera (quarter turn %i)', (quarterTurn) => {
    const body = modelOf(definitionId, quarterTurn).parts[0];
    const at = (angleDegrees: number, radius: number): number => {
      const angle = (angleDegrees * Math.PI) / 180;
      return topMaterialAt(body, Math.floor(CAROUSEL_CENTRE + Math.cos(angle) * radius), Math.floor(CAROUSEL_CENTRE + Math.sin(angle) * radius));
    };
    for (const radius of [20, 30, 40]) {
      // World 45° points straight down the screen, at either quarter turn.
      for (const angle of [45, 135, 225, 315]) expect(at(angle, radius), `ride colour at ${angle}°, radius ${radius}`).toBe(color);
      for (const angle of [0, 90, 180, 270]) expect(at(angle, radius), `accent at ${angle}°, radius ${radius}`).toBe(accent);
    }
  });

  it('colours only through the palette: the ride colour, its accent and fixed materials', () => {
    const model = modelOf(definitionId, 0);
    const used = new Set<number>();
    for (const part of model.parts) {
      for (let box = 0; box < part.boxCount; box += 1) used.add(materialOf(part.boxes, box * BOX_FLOATS));
    }
    expect([...used].sort((a, b) => a - b), 'materials').toEqual(
      [color, accent, MAT.WOOD, MAT.TIMBER, MAT.GLASS, MAT.BULB, MAT.RAIL, MAT.WHITE].sort((a, b) => a - b),
    );
    expect(palette.flags(color), 'ride colour is plain').toBe(0);
    expect(palette.flags(accent), 'accent is plain').toBe(0);
    const glowing = [...used].filter((material) => palette.flags(material) !== 0).sort((a, b) => a - b);
    expect(glowing, 'only the bulbs and the mirror glass glow').toEqual([MAT.GLASS, MAT.BULB].sort((a, b) => a - b));
    const moving = new Set<number>();
    for (const part of model.parts.slice(1)) {
      for (let box = 0; box < part.boxCount; box += 1) moving.add(materialOf(part.boxes, box * BOX_FLOATS));
    }
    expect([...moving].sort((a, b) => a - b), 'horse and pole materials').toEqual([color, MAT.RAIL, MAT.WHITE].sort((a, b) => a - b));
  });

  it('declares a light for every other bulb and one for the mirrored drum, with art-bible radii', () => {
    const model = modelOf(definitionId, 0);
    const body = model.parts[0];
    const bulbs: Vec3[] = [];
    let bulbVoxels = 0;
    for (let box = 0; box < body.boxCount; box += 1) {
      const at = box * BOX_FLOATS;
      if (materialOf(body.boxes, at) !== MAT.BULB) continue;
      bulbVoxels += body.boxes[at + 4] * body.boxes[at + 5] * body.boxes[at + 6];
      bulbs.push([body.boxes[at] + body.boxes[at + 4] / 2, body.boxes[at + 1] + body.boxes[at + 5] / 2, body.boxes[at + 2] + body.boxes[at + 6] / 2]);
    }
    expect(bulbVoxels, '24 whole 2×2×2 bulbs').toBe(24 * 8);
    const bulbLights = model.lights.filter((light) => light.radius === RIDE_BULB_LIGHT_RADIUS);
    const windowLights = model.lights.filter((light) => light.radius === WINDOW_LIGHT_RADIUS);
    expect(bulbLights.length, 'bulb lights').toBe(12);
    expect(windowLights.length, 'drum light').toBe(1);
    expect(bulbLights.length + windowLights.length, 'no other lights').toBe(model.lights.length);
    for (const light of model.lights) {
      expect(light.presets, 'lit at dusk and night only').toBe(EVENING);
      expect(light.presets & LIGHT_PRESET_DAY, 'not by day').toBe(0);
      expect(light.position[0], 'light x on the plot').toBeGreaterThanOrEqual(0);
      expect(light.position[0], 'light x on the plot').toBeLessThanOrEqual(VOXELS_PER_TILE * CAROUSEL_FOOTPRINT[0]);
      expect(light.position[1], 'light y on the plot').toBeGreaterThanOrEqual(0);
      expect(light.position[1], 'light y on the plot').toBeLessThanOrEqual(VOXELS_PER_TILE * CAROUSEL_FOOTPRINT[1]);
    }
    for (const light of bulbLights) {
      expect(light.color, 'bulb light colour').toBe(MAT_COLOR.BULB);
      const nearest = Math.min(...bulbs.map((bulb) => Math.hypot(bulb[0] - light.position[0], bulb[1] - light.position[1], bulb[2] - light.position[2])));
      expect(nearest, 'a bulb light sits at a bulb').toBeLessThan(2);
    }
    expect(windowLights[0].color, 'drum light colour').toBe(MAT_COLOR.WINDOW_GLOW);
  });

  it('keeps every horse box model within 30° of its tangent at rest', () => {
    expect(CAROUSEL_HORSES.length, 'horses').toBe(CAROUSEL_HORSE_COUNT);
    for (const [index, horse] of CAROUSEL_HORSES.entries()) {
      expect(Math.abs(horse.yaw), `horse ${index} yaw`).toBeLessThanOrEqual((31 * Math.PI) / 180);
      expect(Number.isInteger(horse.poleX) && Number.isInteger(horse.poleY), `horse ${index} pole on whole voxels`).toBe(true);
    }
    expect(CAROUSEL_HORSES.filter((horse) => Math.abs(horse.yaw) < 1e-9).length, 'two horses sit exactly on their tangent').toBe(2);
  });
});
