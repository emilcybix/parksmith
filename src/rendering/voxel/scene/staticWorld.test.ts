import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { deriveCoasterStats, validateCoasterLayout } from '../../../game/coaster/design';
import type { CoasterPiece } from '../../../game/coaster/design';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { seedDevPark } from '../../../game/session/devPark';
import { ParkSession } from '../../../game/session/ParkSession';
import { footprintSize } from '../../../game/types';
import type { BuildDefinition, Cell, Rotation } from '../../../game/types';
import type { GameWorld } from '../../../game/World';
import { createModelCache } from '../blueprint/compile';
import type { ModelCache } from '../blueprint/compile';
import { SUPPORT_FOOTING_SIZE, SUPPORT_FOOTING_Z } from '../content/coaster';
import { placeholderContent, placeholderEntrance } from '../content/placeholder';
import type { Blueprint } from '../contracts/blueprint';
import { LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import { BOX_FLOATS, BoxWriter, STATIC_SLOT, TRANSFORM_FLOATS, unpackBoxWord } from '../contracts/boxes';
import type { ObjectContent } from '../contracts/content';
import { objectOutlineGroup, OUTLINE_GROUP_GROUND } from '../contracts/gbuffer';
import { MAT, PATTERN } from '../contracts/palette';
import { coasterCarSlotKey } from '../contracts/rigid';
import { chunkIndexOfCell, depthKey, PLOT_TOP_Z, visualQuarterTurn, VOXELS_PER_TILE } from '../contracts/space';
import { buildPalette } from '../palette';
import { createTransformTable } from './rigid';
import type { TransformTable } from './rigid';
import { PLACEHOLDER_CONTENT, REGISTRY_CONTENT, SceneModels, StaticWorld } from './staticWorld';
import type { SceneContent } from './staticWorld';

/**
 * The static world is the one place that turns the park into box lists the GPU never re-derives:
 * whatever it gets wrong stays wrong on screen until the next rebuild. So this file pins its
 * contracts at the voxel level rather than by counting boxes:
 * - layering (design §2): no two boxes overlap with positive volume — equal-depth overlaps z-fight
 *   on real GPUs — for the dev park and random parks, with the placeholders and with whatever
 *   content is authored right now;
 * - paths: paving and curbs cover every path cell's [0, 1) layer exactly once, and curbs stand on
 *   exactly the edges without a path beyond them, 1 voxel wide and 2 tall;
 * - fences: the legacy rule (open where a path touches the plot), posts 2×2×10 every 16 voxels and
 *   rails at z 5 and 9;
 * - plots, the entrance, coaster pieces in their own chunks, moving parts in transform slots, lights,
 *   sort order and texel bounds;
 * - which chunks a change marks dirty (design §9), and that a content failure costs one report and
 *   a placeholder, never a throw per frame.
 */

const TILE = VOXELS_PER_TILE;
const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
/** One cache per content source for the whole file: compiled models are deterministic. */
const CACHES = new Map<SceneContent, ModelCache>();
const cacheFor = (content: SceneContent): ModelCache => {
  let cache = CACHES.get(content);
  if (!cache) {
    cache = createModelCache();
    CACHES.set(content, cache);
  }
  return cache;
};

interface Built {
  world: StaticWorld;
  transforms: TransformTable;
  models: SceneModels;
  errors: string[];
}

/** A static world built from scratch on `game` (one sync, one rebuild pass). */
const build = (game: GameWorld, content: SceneContent = PLACEHOLDER_CONTENT, cache: ModelCache = cacheFor(content)): Built => {
  const errors: string[] = [];
  const transforms = createTransformTable();
  const models = new SceneModels(PALETTE, cache, content, (message) => errors.push(message));
  const world = new StaticWorld({ width: game.width, height: game.height, models, transforms });
  world.sync(game);
  world.rebuildDirty(game);
  return { world, transforms, models, errors };
};

/** A box in world voxels at the pose its slot holds (rest poses right after a rebuild). */
interface WorldBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  material: number;
  group: number;
  pattern: number;
  slot: number;
  chunk: number;
  /** A coaster car (its slot is keyed coasterCarSlotKey), parked where the rebuild put it. */
  car: boolean;
}

/** Rotates a point by a unit quaternion (the shaders' vxQuatRotate). */
const rotate = (qx: number, qy: number, qz: number, qw: number, x: number, y: number, z: number): [number, number, number] => {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
};

const EPSILON = 1e-4;

/** Every box of every chunk in world voxels; a rotated slot contributes its box's axis-aligned hull. */
const worldBoxes = (built: Built): WorldBox[] => {
  const boxes: WorldBox[] = [];
  for (let chunk = 0; chunk < built.world.chunkCount; chunk += 1) {
    const writer = built.world.chunkBoxes(chunk);
    const data = writer.data;
    for (let box = 0; box < writer.count; box += 1) {
      const at = box * BOX_FLOATS;
      const word = unpackBoxWord(data[at + 3]);
      const slot = data[at + 7];
      let x0 = data[at];
      let y0 = data[at + 1];
      let z0 = data[at + 2];
      let x1 = x0 + data[at + 4];
      let y1 = y0 + data[at + 5];
      let z1 = z0 + data[at + 6];
      if (slot !== STATIC_SLOT) {
        const pose = built.transforms.data.subarray((slot - 1) * TRANSFORM_FLOATS, slot * TRANSFORM_FLOATS);
        const corners = [
          [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
          [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
        ].map(([x, y, z]) => rotate(pose[4], pose[5], pose[6], pose[7], x, y, z));
        x0 = pose[0] + Math.min(...corners.map((corner) => corner[0])) + EPSILON;
        y0 = pose[1] + Math.min(...corners.map((corner) => corner[1])) + EPSILON;
        z0 = pose[2] + Math.min(...corners.map((corner) => corner[2])) + EPSILON;
        x1 = pose[0] + Math.max(...corners.map((corner) => corner[0])) - EPSILON;
        y1 = pose[1] + Math.max(...corners.map((corner) => corner[1])) - EPSILON;
        z1 = pose[2] + Math.max(...corners.map((corner) => corner[2])) - EPSILON;
      }
      const car = slot !== STATIC_SLOT && (built.transforms.keyOfSlot(slot)?.partKey ?? 0) >= coasterCarSlotKey(0);
      boxes.push({ x0, y0, z0, x1, y1, z1, material: word.material, group: word.group, pattern: word.pattern, slot, chunk, car });
    }
  }
  return boxes;
};

const describeBox = (box: WorldBox): string =>
  `[${box.x0},${box.y0},${box.z0}]–[${box.x1},${box.y1},${box.z1}] material ${box.material} group ${box.group} slot ${box.slot} chunk ${box.chunk}`;

/**
 * Pairs of boxes sharing positive volume (sweep over x), across the whole park — stricter than the
 * design's per-chunk rule, since an object's boxes straddle chunks. Coaster cars are left out: the art
 * bible keeps them level on ramps (pitch only inside loops), so a car on a stepped ramp always cuts
 * into the treads, parked or not; that is how the track is drawn to be ridden, not a layering fault.
 * Ride parts count, at the rest pose a rebuild writes. A coaster support footing on a path tile under level-2+
 * track is left out too: by design (content/coaster.ts, SUPPORT_FOOTING_Z) it stands on the grass and its lowest
 * voxel is inside the paving. Phase 16's longer catalog changed the random parks, and park 42 now has that case.
 */
const isFootingInPaving = (a: WorldBox, b: WorldBox): boolean => {
  const [paving, footing] = a.material === MAT.PAVING ? [a, b] : [b, a];
  return paving.material === MAT.PAVING && paving.group === OUTLINE_GROUP_GROUND && footing.material === MAT.STONE
    && footing.z0 === SUPPORT_FOOTING_Z && footing.x1 - footing.x0 === SUPPORT_FOOTING_SIZE && footing.y1 - footing.y0 === SUPPORT_FOOTING_SIZE
    && footing.z1 > paving.z0 && footing.z0 < paving.z1;
};

const overlaps = (boxes: readonly WorldBox[]): string[] => {
  const sorted = boxes.filter((box) => !box.car).sort((a, b) => a.x0 - b.x0);
  const found: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const a = sorted[index];
    for (let other = index + 1; other < sorted.length && sorted[other].x0 < a.x1; other += 1) {
      const b = sorted[other];
      if (a.y0 < b.y1 && b.y0 < a.y1 && a.z0 < b.z1 && b.z0 < a.z1 && !isFootingInPaving(a, b)) {
        found.push(`${describeBox(a)} overlaps ${describeBox(b)}`);
        if (found.length >= 12) return found;
      }
    }
  }
  return found;
};

class Rng {
  constructor(private state: number) {}
  next(): number {
    this.state = (this.state * 1_664_525 + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }
  int(maximum: number): number {
    return Math.floor(this.next() * maximum);
  }
  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)];
  }
}

const PLACEABLE = BUILD_CATALOG.filter((definition) => definition.kind !== 'path' && !definition.custom).map((definition) => definition.id);
const CARDINALS: readonly Cell[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

/** A closed rectangular loop: flat station, one hill, back down to 0. */
const coasterLoop = (origin: Cell, width: number, depth: number): CoasterPiece[] => {
  const ring: Cell[] = [];
  for (let x = 0; x < width; x += 1) ring.push({ x: origin.x + x, y: origin.y });
  for (let y = 1; y < depth; y += 1) ring.push({ x: origin.x + width - 1, y: origin.y + y });
  for (let x = width - 2; x >= 0; x -= 1) ring.push({ x: origin.x + x, y: origin.y + depth - 1 });
  for (let y = depth - 2; y >= 1; y -= 1) ring.push({ x: origin.x, y: origin.y + y });
  const descentStart = ring.length - 3;
  return ring.map((cell, index) => {
    let height = 0;
    if (index >= 3 && index < descentStart) height = Math.min(2, index - 2);
    else if (index >= descentStart) height = Math.max(0, ring.length - 1 - index);
    return { cell, height };
  });
};

const placeCoaster = (game: GameWorld, origin: Cell): boolean => {
  const type = COASTER_TYPE_BY_ID.get('star-chaser');
  if (!type) return false;
  const pieces = coasterLoop(origin, 6, 4);
  if (!validateCoasterLayout(pieces, type).ok) return false;
  return !('error' in game.placeCoaster(type.definitionId, pieces, deriveCoasterStats(pieces, type), 1_000));
};

/** A random park: path lines, every kind of object at random rotations (locks and cost bypassed), coasters. */
const randomPark = (seed: number): ParkSession => {
  const rng = new Rng(seed);
  const session = new ParkSession(null);
  const game = session.world;
  game.addMoney(10_000_000, 'Static world test funding');
  for (let line = 0; line < 10; line += 1) {
    const from = { x: rng.int(game.width), y: rng.int(game.height) };
    const direction = rng.pick(CARDINALS);
    const length = 3 + rng.int(10);
    game.buildPaths(Array.from({ length }, (_unused, step) => ({ x: from.x + direction.x * step, y: from.y + direction.y * step })));
  }
  for (let attempt = 0; attempt < 90; attempt += 1) {
    game.seedScenarioObject(rng.pick(PLACEABLE), { x: rng.int(game.width), y: rng.int(game.height) }, rng.int(4) as Rotation);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) placeCoaster(game, { x: 1 + rng.int(24), y: 1 + rng.int(26) });
  return session;
};

const devPark = (): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  return session;
};

const cellKey = (x: number, y: number): string => `${x},${y}`;

describe('static world: layering', () => {
  const parks: [string, () => ParkSession][] = [
    ['the dev park', devPark],
    ['random park 1', () => randomPark(1)],
    ['random park 7', () => randomPark(7)],
    ['random park 42', () => randomPark(42)],
    ['random park 313', () => randomPark(313)],
  ];

  it.each(parks)('no two boxes overlap in %s (placeholder content)', (_name, park) => {
    const built = build(park().world, PLACEHOLDER_CONTENT);
    expect(built.errors, 'placeholder content never fails').toEqual([]);
    expect(overlaps(worldBoxes(built)), 'boxes sharing voxels z-fight').toEqual([]);
  });

  it.each(parks)('no two boxes overlap in %s (the content authored so far)', (_name, park) => {
    const built = build(park().world, REGISTRY_CONTENT);
    expect(overlaps(worldBoxes(built)), 'content must stand on z ≥ 1 inside its plot, clear of fences, curbs and its own moving parts').toEqual([]);
  });
});

describe('static world: terrain and paths', () => {
  it('lays one grass slab and one soil slab under every chunk, 16 voxels of diorama in all', () => {
    const game = new ParkSession(null).world;
    const built = build(game);
    let grassArea = 0;
    let soilArea = 0;
    for (const box of worldBoxes(built).filter((candidate) => candidate.z1 <= 0)) {
      if (box.material === MAT.GRASS) {
        expect([box.z0, box.z1, box.pattern], 'grass is the top voxel of the terrain').toEqual([-1, 0, PATTERN.GRASS]);
        grassArea += (box.x1 - box.x0) * (box.y1 - box.y0);
      } else {
        expect([box.material, box.z0, box.z1, box.pattern], 'soil fills the rest of the 16-voxel band').toEqual([MAT.SOIL, -16, -1, PATTERN.SOIL]);
        soilArea += (box.x1 - box.x0) * (box.y1 - box.y0);
      }
      expect(box.group, 'terrain is outline group 0').toBe(OUTLINE_GROUP_GROUND);
    }
    const area = game.width * game.height * TILE * TILE;
    expect(grassArea, 'grass covers the map exactly once').toBe(area);
    expect(soilArea, 'soil covers the map exactly once').toBe(area);
  });

  it('covers every path cell once at [0, 1) and curbs exactly the edges without a path neighbour', () => {
    const session = new ParkSession(null);
    const game = session.world;
    game.addMoney(1_000_000, 'Path test funding');
    const rng = new Rng(99);
    for (let line = 0; line < 14; line += 1) {
      const from = { x: rng.int(game.width), y: rng.int(game.height) };
      const direction = rng.pick(CARDINALS);
      game.buildPaths(Array.from({ length: 2 + rng.int(9) }, (_unused, step) => ({ x: from.x + direction.x * step, y: from.y + direction.y * step })));
    }
    // A 2×2 block, a lone tile and a ring, so inner corners and T-junctions are covered too.
    game.buildPaths([{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 30, y: 1 }]);
    game.buildPaths([{ x: 20, y: 3 }, { x: 21, y: 3 }, { x: 22, y: 3 }, { x: 22, y: 4 }, { x: 22, y: 5 }, { x: 21, y: 5 }, { x: 20, y: 5 }, { x: 20, y: 4 }]);
    const built = build(game, { ...PLACEHOLDER_CONTENT, entrance: () => ({ id: 'test:no-gate', footprint: [1, 1], parts: [{ id: 'body', pivot: [0, 0, 0], shapes: [] }] }) });
    const size = game.width * TILE;
    const layer0 = new Uint8Array(size * size);
    const layer1 = new Uint8Array(size * size);
    for (const box of worldBoxes(built).filter((candidate) => candidate.z1 > 0)) {
      expect([MAT.PAVING, MAT.CURB], `only paving and curbs stand above the terrain here: ${describeBox(box)}`).toContain(box.material);
      expect(box.z0, 'paths start on the terrain').toBe(0);
      expect(box.z1, box.material === MAT.CURB ? 'curbs are 2 tall' : 'paving is 1 thick').toBe(box.material === MAT.CURB ? 2 : 1);
      if (box.material === MAT.PAVING) expect(box.pattern, 'paving carries its pattern').toBe(PATTERN.PAVING);
      for (let y = box.y0; y < box.y1; y += 1) {
        for (let x = box.x0; x < box.x1; x += 1) {
          layer0[y * size + x] += 1;
          if (box.material === MAT.CURB) layer1[y * size + x] += 1;
        }
      }
    }
    const isPath = (x: number, y: number): boolean => game.paths.has(cellKey(x, y));
    const failures: string[] = [];
    for (let vy = 0; vy < size && failures.length < 8; vy += 1) {
      for (let vx = 0; vx < size && failures.length < 8; vx += 1) {
        const cellX = Math.floor(vx / TILE);
        const cellY = Math.floor(vy / TILE);
        const localX = vx - cellX * TILE;
        const localY = vy - cellY * TILE;
        const path = isPath(cellX, cellY);
        const expected0 = path ? 1 : 0;
        const curb = path && (
          (localX === 0 && !isPath(cellX - 1, cellY)) || (localX === TILE - 1 && !isPath(cellX + 1, cellY))
          || (localY === 0 && !isPath(cellX, cellY - 1)) || (localY === TILE - 1 && !isPath(cellX, cellY + 1)));
        if (layer0[vy * size + vx] !== expected0) failures.push(`voxel ${vx},${vy},0 covered ${layer0[vy * size + vx]}× (path ${path})`);
        if (layer1[vy * size + vx] !== (curb ? 1 : 0)) failures.push(`voxel ${vx},${vy},1 curb ${layer1[vy * size + vx]} (expected ${curb})`);
      }
    }
    expect(failures, 'paving + curbs tile the path layer exactly; curbs ring exactly the open edges').toEqual([]);
  });

  it('merges paving into runs instead of one slab per tile', () => {
    const session = new ParkSession(null);
    const game = session.world;
    game.addMoney(1_000_000, 'Path test funding');
    // A 12-tile straight street inside one chunk row: interior tiles share both curbs.
    game.buildPaths(Array.from({ length: 12 }, (_unused, step) => ({ x: 4 + step, y: 12 })));
    const built = build(game);
    const paving = worldBoxes(built).filter((box) => box.material === MAT.PAVING && box.y0 >= 12 * TILE && box.y1 <= 13 * TILE);
    // The street crosses one chunk boundary (x = 8), so it is at most one run per chunk.
    expect(paving.length, 'a straight street is one paving box per chunk it crosses').toBe(2);
  });

  it('cuts curbs wherever the entrance gate stands on them', () => {
    const game = new ParkSession(null).world;
    // A gate whose posts stand on the tile's outer ring, where the curbs are.
    const gate = (): Blueprint => ({
      id: 'test:gate-on-curbs',
      footprint: [1, 1],
      parts: [{
        id: 'body',
        pivot: [0, 0, 0],
        shapes: [
          { kind: 'box', min: [0, 10, 1], size: [4, 4, 30], material: MAT.ENTRANCE_POST },
          { kind: 'box', min: [28, 10, 1], size: [4, 4, 30], material: MAT.ENTRANCE_POST },
        ],
      }],
      floorZ: 0,
    });
    const built = build(game, { ...PLACEHOLDER_CONTENT, entrance: gate }, createModelCache());
    const boxes = worldBoxes(built);
    expect(overlaps(boxes), 'the gate never shares voxels with a curb').toEqual([]);
    const entranceX = game.entrance.x * TILE;
    const entranceY = game.entrance.y * TILE;
    const westCurb = boxes.filter((box) => box.material === MAT.CURB && box.x0 === entranceX && box.y0 >= entranceY && box.y1 <= entranceY + TILE);
    expect(westCurb.map((box) => [box.y0 - entranceY, box.y1 - entranceY]).sort((a, b) => a[0] - b[0]), 'the west curb runs around the post')
      .toEqual([[0, 10], [14, 32]]);
  });
});

describe('static world: plots and fences', () => {
  it('lays a plot slab in the plot tint under every object except coasters', () => {
    const session = devPark();
    const built = build(session.world);
    const boxes = worldBoxes(built);
    for (const object of session.world.objects.values()) {
      const definition = BUILD_BY_ID.get(object.definitionId) as BuildDefinition;
      const plots = boxes.filter((box) => box.z0 === 0 && box.z1 === PLOT_TOP_Z && box.material === PALETTE.plotTint(definition.color)
        && box.x0 === object.anchor.x * TILE && box.y0 === object.anchor.y * TILE);
      if (session.world.coasters.has(object.id)) {
        expect(plots, 'coasters have no plot').toHaveLength(0);
        continue;
      }
      const [wide, deep] = footprintSize(definition, object.rotation);
      expect(plots.map((box) => [box.x1 - box.x0, box.y1 - box.y0, box.group]), `${definition.id} stands on its whole plot`)
        .toEqual([[wide * TILE, deep * TILE, OUTLINE_GROUP_GROUND]]);
    }
  });

  it('fences a ride on every plot edge without a path beyond it, with posts every 16 voxels and rails at z 5 and 9', () => {
    const session = new ParkSession(null);
    const game = session.world;
    game.addMoney(1_000_000, 'Fence test funding');
    const anchor = { x: 10, y: 10 };
    expect(game.seedScenarioObject('petal-roundabout', anchor), 'the ride fits').not.toBeNull();
    // Paths touch the west edge of the plot's first two rows and the north edge of its middle column.
    game.buildPaths([{ x: 9, y: 10 }, { x: 9, y: 11 }, { x: 11, y: 9 }]);
    const built = build(game);
    const object = [...game.objects.values()][0];
    const group = objectOutlineGroup(object.id);
    const fence = worldBoxes(built).filter((box) => box.group === group && (box.material === MAT.FENCE_POST || box.material === MAT.FENCE_RAIL));
    for (const box of fence) {
      if (box.material === MAT.FENCE_POST) {
        expect([box.x1 - box.x0, box.y1 - box.y0, box.z0, box.z1], 'posts are 2×2×10 on the plot').toEqual([2, 2, PLOT_TOP_Z, PLOT_TOP_Z + 10]);
      } else {
        expect([box.z0, box.z1 - box.z0], 'rails are 1 voxel at z 5 or 9').toEqual([box.z0 === 5 ? 5 : 9, 1]);
        expect(Math.min(box.x1 - box.x0, box.y1 - box.y0), 'rails are 1 voxel thick').toBe(1);
      }
    }
    const x0 = anchor.x * TILE;
    const y0 = anchor.y * TILE;
    const x1 = x0 + 3 * TILE;
    const y1 = y0 + 3 * TILE;
    /** Fence voxels at height z along one side's outer voxel line, as a set of positions along it. */
    const along = (side: 'north' | 'south' | 'west' | 'east', z: number): Set<number> => {
      const found = new Set<number>();
      for (const box of fence) {
        if (z < box.z0 || z >= box.z1) continue;
        const onLine = side === 'north' ? box.y0 <= y0 && box.y1 > y0
          : side === 'south' ? box.y0 <= y1 - 1 && box.y1 > y1 - 1
            : side === 'west' ? box.x0 <= x0 && box.x1 > x0 : box.x0 <= x1 - 1 && box.x1 > x1 - 1;
        if (!onLine) continue;
        const [from, to] = side === 'north' || side === 'south' ? [box.x0 - x0, box.x1 - x0] : [box.y0 - y0, box.y1 - y0];
        for (let position = from; position < to; position += 1) found.add(position);
      }
      return found;
    };
    const span = (from: number, to: number): number[] => Array.from({ length: to - from }, (_unused, index) => from + index);
    // Rails (with the posts between them) close every fenced edge completely at both rail heights.
    for (const z of [5, 9]) {
      const south = along('south', z);
      const east = along('east', z);
      expect(span(0, 96).every((position) => south.has(position)), `the south side is closed at z ${z}`).toBe(true);
      expect(span(0, 96).every((position) => east.has(position)), `the east side is closed at z ${z}`).toBe(true);
      const west = along('west', z);
      expect(span(2, 62).some((position) => west.has(position)), `the west side is open where the paths touch (z ${z})`).toBe(false);
      expect(span(64, 96).every((position) => west.has(position)), `the west side's last cell is fenced (z ${z})`).toBe(true);
      const north = along('north', z);
      expect(span(34, 62).some((position) => north.has(position)), `the north side is open at its middle cell (z ${z})`).toBe(false);
      expect(span(0, 32).every((position) => north.has(position)) && span(64, 96).every((position) => north.has(position)),
        `the north side's outer cells are fenced (z ${z})`).toBe(true);
    }
    // Posts every 16 voxels along a closed side (and at its far end), like the legacy posts per edge.
    const southPosts = fence.filter((box) => box.material === MAT.FENCE_POST && box.y1 === y1).map((box) => box.x0 - x0).sort((a, b) => a - b);
    expect(southPosts, 'south posts every 16 voxels').toEqual([0, 16, 32, 48, 64, 80, 94]);
  });

  it('leaves non-ride plots unfenced', () => {
    const game = new ParkSession(null).world;
    game.seedScenarioObject('picnic-pocket', { x: 4, y: 4 });
    const built = build(game);
    const fence = worldBoxes(built).filter((box) => box.material === MAT.FENCE_POST || box.material === MAT.FENCE_RAIL);
    expect(fence, 'shops have no fence').toHaveLength(0);
  });
});

describe('static world: models, moving parts, coasters, lights', () => {
  /** A 1×1 lamp-like model with a moving arm and a light, for pinning placement. */
  const armBlueprint = (definition: BuildDefinition): Blueprint => ({
    id: `test:arm:${definition.id}`,
    footprint: definition.footprint,
    parts: [
      { id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [4, 4, 1], size: [4, 4, 10], material: MAT.STEEL }] },
      { id: 'arm', pivot: [16, 6, 12], shapes: [{ kind: 'box', min: [12, 4, 11], size: [8, 4, 2], material: MAT.WOOD }] },
    ],
    lights: [{ position: [6, 20, 9], radius: 20, color: 0xffcc00, presets: LIGHT_PRESET_NIGHT }],
  });
  const armContent: ObjectContent = { blueprint: (definition) => armBlueprint(definition) };
  const content: SceneContent = { ...PLACEHOLDER_CONTENT, objectContent: () => armContent };

  it.each([0, 1, 2, 3] as const)('places a model at 32 · anchor with its moving parts in slots at rest (rotation %i)', (rotation) => {
    const game = new ParkSession(null).world;
    const object = game.seedScenarioObject('bumble-coach', { x: 5, y: 6 }, rotation);
    expect(object, 'the object fits').not.toBeNull();
    const built = build(game, content, createModelCache());
    const placement = built.world.placements.get(object!.id);
    expect(placement, 'the object is placed').toBeDefined();
    expect([placement!.originX, placement!.originY, placement!.quarterTurn], 'origin and visual quarter turn').toEqual([5 * TILE, 6 * TILE, visualQuarterTurn(rotation)]);
    expect(placement!.parts.map((part) => part.partId), 'the arm moves').toEqual(['arm']);
    const slot = placement!.parts[0].slot;
    expect(built.transforms.keyOfSlot(slot), 'the slot is keyed (object, part index)').toEqual({ objectId: object!.id, partKey: 1 });
    // At rest, the arm lands exactly where the flattened (all-at-rest) model puts it.
    const definition = BUILD_BY_ID.get('bumble-coach')!;
    const flat = built.models.objectFlat(definition, visualQuarterTurn(rotation));
    const expected = new Set<string>();
    for (let box = 0; box < flat.boxCount; box += 1) {
      const at = box * BOX_FLOATS;
      expected.add([flat.boxes[at] + 5 * TILE, flat.boxes[at + 1] + 6 * TILE, flat.boxes[at + 2], flat.boxes[at + 4], flat.boxes[at + 5], flat.boxes[at + 6]].join(','));
    }
    const group = objectOutlineGroup(object!.id);
    const placed = new Set(worldBoxes(built).filter((box) => box.group === group)
      .map((box) => [Math.round(box.x0), Math.round(box.y0), Math.round(box.z0), Math.round(box.x1 - box.x0), Math.round(box.y1 - box.y0), Math.round(box.z1 - box.z0)].join(',')));
    for (const box of expected) expect(placed.has(box), `model box ${box} is in the chunk`).toBe(true);
    // The light is the turned model's, moved by the origin only.
    const model = built.models.objectModel(definition, visualQuarterTurn(rotation));
    const lights = built.world.lights[placement!.homeChunk];
    expect(lights.count, 'one light').toBe(1);
    expect([...lights.data.subarray(0, 4)], 'light position and radius').toEqual([
      5 * TILE + model.lights[0].position[0], 6 * TILE + model.lights[0].position[1], model.lights[0].position[2], 20,
    ]);
    expect(lights.data[7], 'light presets').toBe(LIGHT_PRESET_NIGHT);
    expect(built.world.objectTop(object!.id), 'badges sit above the model top').toBe(model.top);
  });

  it('keeps every coaster piece in its own chunk and the train with the station', () => {
    const game = new ParkSession(null).world;
    game.addMoney(1_000_000, 'Coaster test funding');
    // Straddles the chunk boundary at x = 8 and y = 8.
    expect(placeCoaster(game, { x: 5, y: 6 }), 'the coaster fits').toBe(true);
    const record = [...game.coasters.values()][0];
    const built = build(game);
    const group = objectOutlineGroup(record.objectId);
    const staticBoxes = worldBoxes(built).filter((box) => box.group === group && box.slot === STATIC_SLOT);
    for (const box of staticBoxes) {
      const cellX = Math.floor((box.x0 + box.x1) / 2 / TILE);
      const cellY = Math.floor((box.y0 + box.y1) / 2 / TILE);
      expect(box.chunk, `track box ${describeBox(box)} lives in the chunk of its piece`).toBe(chunkIndexOfCell(cellX, cellY, game.width));
    }
    const train = built.world.trains.get(record.objectId);
    expect(train, 'the train is placed').toBeDefined();
    const station = chunkIndexOfCell(record.pieces[0].cell.x, record.pieces[0].cell.y, game.width);
    expect(train!.homeChunk, 'the train lives with the station').toBe(station);
    const cars = COASTER_TYPE_BY_ID.get('star-chaser')!.trainCars;
    for (let car = 0; car < cars; car += 1) {
      const slot = built.transforms.slotFor(record.objectId, coasterCarSlotKey(car));
      expect(worldBoxes(built).some((box) => box.slot === slot && box.chunk === station), `car ${car} is drawn through its slot`).toBe(true);
    }
    expect(built.world.objectTop(record.objectId), 'a coaster has a badge height').toBeGreaterThan(0);
  });

  it('sorts every chunk front to back with the ground last, and bounds every box', () => {
    const session = devPark();
    const built = build(session.world, REGISTRY_CONTENT);
    for (let chunk = 0; chunk < built.world.chunkCount; chunk += 1) {
      const writer = built.world.chunkBoxes(chunk);
      const data = writer.data;
      let seenGround = false;
      let previous = Number.POSITIVE_INFINITY;
      for (let box = 0; box < writer.count; box += 1) {
        const at = box * BOX_FLOATS;
        const ground = unpackBoxWord(data[at + 3]).group === OUTLINE_GROUP_GROUND;
        if (ground && !seenGround) {
          seenGround = true;
          previous = Number.POSITIVE_INFINITY;
        }
        expect(ground || !seenGround, `chunk ${chunk}: nothing follows the ground`).toBe(true);
        let x1 = data[at] + data[at + 4];
        let y1 = data[at + 1] + data[at + 5];
        let z1 = data[at + 2] + data[at + 6];
        const slot = data[at + 7];
        if (slot !== STATIC_SLOT) {
          const pose = (slot - 1) * TRANSFORM_FLOATS;
          x1 += built.transforms.data[pose];
          y1 += built.transforms.data[pose + 1];
          z1 += built.transforms.data[pose + 2];
        }
        const key = Math.round(depthKey(x1, y1, z1));
        expect(key <= previous, `chunk ${chunk} box ${box}: descending max-corner depth`).toBe(true);
        previous = key;
      }
    }
    for (const box of worldBoxes(built)) {
      const bounds = built.world.chunkBounds(box.chunk);
      expect(bounds, `chunk ${box.chunk} has bounds`).not.toBeNull();
      const inside = box.x0 - box.y1 >= bounds!.minX - 1e-3 && box.x1 - box.y0 <= bounds!.maxX + 1e-3
        && (box.x0 + box.y0) / 2 - box.z1 >= bounds!.minY - 1e-3 && (box.x1 + box.y1) / 2 - box.z0 <= bounds!.maxY + 1e-3;
      expect(inside, `${describeBox(box)} projects inside its chunk bounds`).toBe(true);
    }
  });
});

describe('static world: dirty tracking', () => {
  const dirtyChunks = (world: StaticWorld): number[] =>
    Array.from({ length: world.chunkCount }, (_unused, index) => index).filter((index) => world.dirty[index] === 1);

  it('marks nothing for changes that are not geometry (money, park open, a new tick)', () => {
    const session = devPark();
    const built = build(session.world);
    session.world.addMoney(500, 'Grant');
    session.world.setParkOpen(!session.world.parkOpen);
    session.world.advanceTick();
    built.world.sync(session.world);
    expect(dirtyChunks(built.world), 'world.version is not a geometry key').toEqual([]);
  });

  it('marks only a decoration\'s own chunk', () => {
    const session = devPark();
    const built = build(session.world);
    const placed = session.world.seedScenarioObject('confetti-tree', { x: 26, y: 26 });
    expect(placed, 'the tree fits').not.toBeNull();
    built.world.sync(session.world);
    expect(dirtyChunks(built.world), 'one chunk').toEqual([chunkIndexOfCell(26, 26, session.world.width)]);
  });

  it('marks a path tile\'s chunk, its path neighbours\' chunks and the chunks of rides whose fence it touches', () => {
    const session = new ParkSession(null);
    const game = session.world;
    game.addMoney(1_000_000, 'Dirty test funding');
    // A ride whose home chunk (its front-most cell, 9,9) differs from the new tile's chunk (0).
    game.seedScenarioObject('petal-roundabout', { x: 7, y: 7 });
    game.buildPaths([{ x: 6, y: 9 }, { x: 5, y: 9 }]);
    const built = build(game);
    game.buildPaths([{ x: 6, y: 8 }]);
    built.world.sync(game);
    const expected = new Set([
      chunkIndexOfCell(6, 8, game.width),
      chunkIndexOfCell(6, 9, game.width),
      chunkIndexOfCell(9, 9, game.width),
    ]);
    expect(dirtyChunks(built.world), 'own chunk, curb neighbours, fence').toEqual([...expected].sort((a, b) => a - b));
    // A tile one cell away from the plot does not touch the fence.
    built.world.rebuildDirty(game);
    game.buildPaths([{ x: 4, y: 9 }]);
    built.world.sync(game);
    expect(dirtyChunks(built.world), 'a tile away from any plot marks its own chunk').toEqual([chunkIndexOfCell(4, 9, game.width)]);
  });

  it('marks every chunk a coaster touches when it comes and goes', () => {
    const game = new ParkSession(null).world;
    game.addMoney(1_000_000, 'Coaster test funding');
    const built = build(game);
    expect(placeCoaster(game, { x: 5, y: 6 }), 'the coaster fits').toBe(true);
    built.world.sync(game);
    const record = [...game.coasters.values()][0];
    const touched = [...new Set(record.pieces.map((piece) => chunkIndexOfCell(piece.cell.x, piece.cell.y, game.width)))].sort((a, b) => a - b);
    expect(dirtyChunks(built.world), 'every piece chunk').toEqual(touched);
    built.world.rebuildDirty(game);
    game.bulldoze(record.pieces[4].cell);
    built.world.sync(game);
    expect(dirtyChunks(built.world), 'every piece chunk again on removal').toEqual(touched);
  });
});

describe('static world: content failures', () => {
  const failing = (what: 'build' | 'compile'): SceneContent => ({
    ...PLACEHOLDER_CONTENT,
    objectContent: (definitionId: string) => definitionId !== 'confetti-tree' ? placeholderContent() : {
      blueprint: (): Blueprint => {
        if (what === 'build') throw new Error('the tree builder exploded');
        // Compiles to an error: part 0 must be the body.
        return { id: 'test:broken-tree', footprint: [1, 1], parts: [{ id: 'crown', pivot: [0, 0, 0], shapes: [] }] };
      },
    },
  });

  it.each(['build', 'compile'] as const)('a blueprint that fails to %s is reported once and drawn as its placeholder', (what) => {
    const game = new ParkSession(null).world;
    game.seedScenarioObject('confetti-tree', { x: 3, y: 3 });
    game.seedScenarioObject('confetti-tree', { x: 5, y: 3 });
    const built = build(game, failing(what), createModelCache());
    expect(built.errors, 'one report for the failing blueprint').toHaveLength(1);
    expect(built.errors[0], 'the report names the definition').toContain('confetti-tree');
    const definition = BUILD_BY_ID.get('confetti-tree')!;
    const placeholder = placeholderContent().blueprint(definition, PALETTE);
    const trees = [...game.objects.values()];
    for (const tree of trees) {
      const placement = built.world.placements.get(tree.id);
      expect(placement?.fromContent, 'the placeholder stands in').toBe(false);
    }
    // Rebuilding again (every frame would) reports nothing more.
    built.world.markAllDirty();
    built.world.rebuildDirty(game);
    expect(built.errors, 'still one report').toHaveLength(1);
    expect(built.models.objectModel(definition, 0).blueprintId, 'the placeholder model is used').toBe(placeholder.id);
  });

  it('falls back per coaster piece, for the cars and for the entrance', () => {
    const content: SceneContent = {
      ...PLACEHOLDER_CONTENT,
      coaster: () => ({
        pieceBoxes: (pieces, index, definition, palette, outlineGroup, out) => {
          if (index === 2) throw new Error('piece 2 exploded');
          PLACEHOLDER_CONTENT.coaster().pieceBoxes(pieces, index, definition, palette, outlineGroup, out);
        },
        carBlueprint: () => {
          throw new Error('no cars');
        },
        riderBlueprint: PLACEHOLDER_CONTENT.coaster().riderBlueprint,
        couplingBlueprint: PLACEHOLDER_CONTENT.coaster().couplingBlueprint,
      }),
      entrance: () => {
        throw new Error('no gate');
      },
    };
    const game = new ParkSession(null).world;
    game.addMoney(1_000_000, 'Coaster test funding');
    expect(placeCoaster(game, { x: 5, y: 6 }), 'the coaster fits').toBe(true);
    const built = build(game, content, createModelCache());
    expect(built.errors.length, 'one report each: the track, the cars, the gate').toBe(3);
    expect(overlaps(worldBoxes(built)), 'fallbacks still layer').toEqual([]);
    const gate = placeholderEntrance(PALETTE);
    expect(built.models.entranceModel().blueprintId, 'the placeholder gate').toBe(gate.id);
  });

  it('falls back per litter pile', () => {
    const errors: string[] = [];
    const content: SceneContent = {
      ...PLACEHOLDER_CONTENT,
      litter: () => (_cellX, _cellY, units, _palette, out) => {
        out.push(0, 0, 1, 1, 1, 1, 0);
        if (units > 3) throw new Error('too much litter');
      },
    };
    const models = new SceneModels(PALETTE, createModelCache(), content, (message) => errors.push(message));
    const out = new BoxWriter(4);
    models.litterBoxes(3, 4, 5, out);
    models.litterBoxes(6, 4, 7, out);
    expect(errors, 'one report').toHaveLength(1);
    const placeholder = new BoxWriter(4);
    PLACEHOLDER_CONTENT.litter()(3, 4, 5, PALETTE, placeholder);
    PLACEHOLDER_CONTENT.litter()(6, 4, 7, PALETTE, placeholder);
    expect([...out.data.subarray(0, out.count * BOX_FLOATS)], 'the half-written pile is dropped and the placeholder drawn')
      .toEqual([...placeholder.data.subarray(0, placeholder.count * BOX_FLOATS)]);
  });
});

describe('static world: prewarm queue', () => {
  it('queues the gate, then the world\'s blueprints smallest first, then the catalog, then coaster cars', () => {
    const session = devPark();
    const queue = SceneModels.prewarmQueueFor(session.world);
    expect(queue[0].definition, 'the gate first').toBeNull();
    const objects = queue.filter((task) => task.definition !== null && !task.definition.custom).map((task) => task.definition as BuildDefinition);
    const inWorld = new Set([...session.world.objects.values()].map((object) => object.definitionId));
    const firstOutside = objects.findIndex((definition) => !inWorld.has(definition.id));
    const worldPart = objects.slice(0, firstOutside === -1 ? objects.length : firstOutside);
    expect(worldPart.every((definition) => inWorld.has(definition.id)), 'the world first').toBe(true);
    const areas = worldPart.map((definition) => definition.footprint[0] * definition.footprint[1]);
    expect(areas, 'smallest first').toEqual([...areas].sort((a, b) => a - b));
    expect(new Set(objects.map((definition) => definition.id)).size, 'each definition once').toBe(objects.length);
    const cars = queue.filter((task) => task.definition?.custom === 'coaster');
    // Per coaster type: every car, every car's riders, and one coupling.
    expect(cars.length, 'every car, its riders and the coupling of every coaster type').toBe(
      BUILD_CATALOG.filter((definition) => definition.custom === 'coaster')
        .reduce((sum, definition) => sum + 2 * (COASTER_TYPE_BY_ID.get(definition.id)?.trainCars ?? 0) + 1, 0),
    );
    expect(queue.indexOf(cars[0]) > queue.indexOf(queue.filter((task) => task.definition && !task.definition.custom).at(-1)!),
      'cars last').toBe(true);
  });

  it('compiles through the queue in slices and never twice', () => {
    const cache = createModelCache();
    const models = new SceneModels(PALETTE, cache, PLACEHOLDER_CONTENT, () => undefined);
    models.setPrewarmQueue(SceneModels.prewarmQueueFor(new ParkSession(null).world));
    let guard = 0;
    while (models.prewarmRemaining > 0 && guard < 1_000) {
      models.prewarm(4);
      guard += 1;
    }
    expect(models.prewarmRemaining, 'the queue drains').toBe(0);
    const compiled = cache.compiledCount;
    models.setPrewarmQueue(SceneModels.prewarmQueueFor(new ParkSession(null).world));
    while (models.prewarmRemaining > 0) models.prewarm(4);
    expect(cache.compiledCount, 'a second pass finds everything ready').toBe(compiled);
  });
});
