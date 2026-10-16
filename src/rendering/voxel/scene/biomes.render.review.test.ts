import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../../game/config';
import { MAPS } from '../../../game/maps/content';
import { GROUND_ALT, GROUND_WATER } from '../../../game/maps/types';
import { PROP_KIND_BY_ID } from '../../../game/maps/props';
import type { MapId } from '../../../game/maps/types';
import { buildFirstDayRoute } from '../../../game/onboarding/routeInFrame';
import { ParkSession } from '../../../game/session/ParkSession';
import type { GameWorld } from '../../../game/World';
import { createViewFrame } from '../../viewRotation';
import { resolveSeeThroughFocus } from '../../seeThrough';
import type { SeeThroughFocus } from '../../seeThrough';
import { createSeeThroughValues, seeThroughCoverage, seeThroughValuesFor } from '../gpu/seeThroughView';
import { chunkIndexOfCell } from '../contracts/space';
import { createModelCache } from '../blueprint/compile';
import { BOX_FLOATS, STATIC_SLOT, unpackBoxWord } from '../contracts/boxes';
import type { VoxelGpuSink } from '../contracts/frame';
import { objectOutlineGroup, OUTLINE_GROUP_GROUND, propOutlineGroup } from '../contracts/gbuffer';
import { CHUNK_TILES, GROUND_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import { createViewTransform, setViewTransform } from '../contracts/view';
import { gamePalette } from '../gamePalette';
import { createTransformTable } from './rigid';
import { REGISTRY_CONTENT, SceneModels, StaticWorld } from './staticWorld';
import { VoxelScene } from './VoxelScene';

/**
 * Phase 24 step 1, adversarial render review (voxel). Independent of the builders' tests:
 *  - a RUNNING park (the First Day route, guests walking, the clock moving) in every map rebuilds no chunk per frame;
 *  - the terrain top covers every cell of every map exactly once with the word of its ground kind, and no terrain box
 *    leaves its chunk (no seam and no z-fight where two ground kinds meet on a chunk border);
 *  - no prop box sinks into the terrain, and no two static boxes anywhere in the park share a voxel, also ACROSS chunk
 *    borders (a 2x2 prop whose home chunk is not the chunk it stands in) and next to the paths of a built route;
 *  - neighbouring props (8-neighbourhood) and a prop next to a built object never share an outline group, so every
 *    tree of a forest keeps its contour.
 */

const TILE = VOXELS_PER_TILE;
const palette = gamePalette();
const cache = createModelCache();

const sessionOn = (mapId: MapId): ParkSession => new ParkSession(null, [], { mapId });

const withRoute = (mapId: MapId): ParkSession => {
  const session = sessionOn(mapId);
  buildFirstDayRoute(session);
  return session;
};

class Sink implements VoxelGpuSink {
  chunks: number[] = [];
  setChunk(index: number): void { this.chunks.push(index); }
  setDynamic(): void { /* dynamic rows are allowed */ }
  setFigureRanges(): void { /* not recorded */ }
  setGhost(): void { /* not recorded */ }
  setDraft(): void { /* not recorded */ }
}

interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; word: number; chunk: number; slot: number }

const buildStatic = (game: GameWorld): StaticWorld => {
  const models = new SceneModels(palette, cache, REGISTRY_CONTENT, () => undefined);
  const view = setViewTransform(createViewFrame(0, game.width, game.height), createViewTransform());
  const world = new StaticWorld({ width: game.width, height: game.height, models, transforms: createTransformTable(), view });
  world.sync(game);
  world.rebuildDirty(game);
  return world;
};

const allBoxes = (world: StaticWorld): Box[] => {
  const out: Box[] = [];
  for (let chunk = 0; chunk < world.chunkCount; chunk += 1) {
    const writer = world.chunkBoxes(chunk);
    const d = writer.data;
    for (let box = 0; box < writer.count; box += 1) {
      const at = box * BOX_FLOATS;
      out.push({ x0: d[at], y0: d[at + 1], z0: d[at + 2], x1: d[at] + d[at + 4], y1: d[at + 1] + d[at + 5], z1: d[at + 2] + d[at + 6], word: d[at + 3], chunk, slot: d[at + 7] });
    }
  }
  return out;
};

const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1 && a.z0 < b.z1 && b.z0 < a.z1;

/** Overlapping pairs over the whole park, bucketed by tile so it stays fast; each pair counted once. */
const parkOverlaps = (all: readonly Box[], propGroups: ReadonlySet<number>): string[] => {
  // Rigid parts (a carousel's rotor) are in their own local space: only static boxes are compared, and only pairs where
  // one side is a prop box (what Phase 24 added; the objects' own art is the earlier phases' business).
  const boxes = all.filter((box) => box.slot === STATIC_SLOT);
  const buckets = new Map<number, number[]>();
  boxes.forEach((box, index) => {
    for (let ty = Math.floor(box.y0 / TILE); ty <= Math.floor((box.y1 - 0.001) / TILE); ty += 1) {
      for (let tx = Math.floor(box.x0 / TILE); tx <= Math.floor((box.x1 - 0.001) / TILE); tx += 1) {
        const key = ty * 1000 + tx;
        const list = buckets.get(key) ?? [];
        list.push(index);
        buckets.set(key, list);
      }
    }
  });
  const seen = new Set<string>();
  const found: string[] = [];
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = boxes[list[i]];
        const b = boxes[list[j]];
        const key = `${Math.min(list[i], list[j])}:${Math.max(list[i], list[j])}`;
        if (seen.has(key) || !overlaps(a, b)) continue;
        if (!propGroups.has(unpackBoxWord(a.word).group) && !propGroups.has(unpackBoxWord(b.word).group)) continue;
        if (unpackBoxWord(a.word).group === unpackBoxWord(b.word).group) continue;
        seen.add(key);
        found.push(`chunk ${a.chunk} [${a.x0},${a.y0},${a.z0}..${a.x1},${a.y1},${a.z1}] g${unpackBoxWord(a.word).group} x chunk ${b.chunk} [${b.x0},${b.y0},${b.z0}..${b.x1},${b.y1},${b.z1}] g${unpackBoxWord(b.word).group}`);
      }
    }
  }
  return found;
};

describe('Phase 24 render review: a running park in every biome rebuilds nothing per frame', () => {
  it.each(MAPS.map((map) => [map.id] as const))('%s: route built, 200 guests walking, 12 frames with the clock running: 0 chunks rebuilt, 0 sent', (mapId) => {
    const session = withRoute(mapId);
    session.guests.spawnGuests(200);
    for (let step = 0; step < 120; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    const sink = new Sink();
    const errors: string[] = [];
    const scene = new VoxelScene(session, palette, cache, { sink, content: REGISTRY_CONTENT, prewarmBudgetMs: 0, reportError: (message) => errors.push(String(message)) });
    session.world.subscribe(() => scene.syncWorld());
    let clock = 0;
    const frame = (): void => { clock += 16; scene.update(16, clock, 0.5); };
    frame();
    frame();
    sink.chunks = [];
    const rebuilt: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      session.step(GAME_CONFIG.fixedStepMs);
      frame();
      rebuilt.push(scene.stats.chunksRebuilt);
    }
    expect(session.guests.guests.size, 'guests are in the park').toBeGreaterThan(0);
    expect(rebuilt).toEqual(new Array(12).fill(0));
    expect(sink.chunks).toEqual([]);
    expect(errors).toEqual([]);
  }, 30_000);
});

describe('Phase 24 render review: terrain seams and z-fighting', () => {
  it.each(MAPS.map((map) => [map.id] as const))('%s: every cell has exactly one terrain top of its own ground kind, inside its own chunk', (mapId) => {
    const session = sessionOn(mapId);
    const world = buildStatic(session.world);
    const boxes = allBoxes(world);
    // Phase 21: sized from the map (an estate is 64 x 64, eight chunks a row).
    const { width, height } = session.world;
    const chunksAcross = Math.ceil(width / CHUNK_TILES);
    const cover = new Uint8Array(width * height);
    const wordAt = new Float64Array(width * height);
    const leaks: string[] = [];
    for (const box of boxes) {
      if (unpackBoxWord(box.word).group !== OUTLINE_GROUP_GROUND) continue;
      if (!(box.z0 === GROUND_TOP_Z - 1 && box.z1 === GROUND_TOP_Z)) continue;
      const cx0 = (box.chunk % chunksAcross) * CHUNK_TILES * TILE;
      const cy0 = Math.floor(box.chunk / chunksAcross) * CHUNK_TILES * TILE;
      if (box.x0 < cx0 || box.y0 < cy0 || box.x1 > cx0 + CHUNK_TILES * TILE || box.y1 > cy0 + CHUNK_TILES * TILE) leaks.push(`chunk ${box.chunk}`);
      for (let y = box.y0 / TILE; y < box.y1 / TILE; y += 1) {
        for (let x = box.x0 / TILE; x < box.x1 / TILE; x += 1) {
          cover[y * width + x] += 1;
          wordAt[y * width + x] = box.word;
        }
      }
    }
    expect(leaks, 'terrain boxes stay inside their chunk').toEqual([]);
    expect([...cover].filter((count) => count !== 1).length, 'cells covered 0 or 2+ times').toBe(0);
    // The word follows the ground kind: equal kinds give equal words, different kinds different words (Meadow's alt is
    // its lawn by design, so only base vs water and, where alt differs, base vs alt must differ).
    const ground = session.world.map.ground;
    const byKind = new Map<number, Set<number>>();
    for (let cell = 0; cell < width * height; cell += 1) {
      const set = byKind.get(ground[cell]) ?? new Set<number>();
      set.add(wordAt[cell]);
      byKind.set(ground[cell], set);
    }
    for (const [kind, words] of byKind) expect(words.size, `ground kind ${kind} has one word`).toBe(1);
    const base = [...(byKind.get(0) ?? [])][0];
    if (byKind.has(GROUND_WATER)) expect([...byKind.get(GROUND_WATER)!][0], 'water differs from the open ground').not.toBe(base);
    if (byKind.has(GROUND_ALT) && session.world.map.biome.ground.alt.rgb !== session.world.map.biome.ground.base.rgb) {
      expect([...byKind.get(GROUND_ALT)!][0], 'the second ground differs from the open ground').not.toBe(base);
    }
  });

  it.each(MAPS.map((map) => [map.id] as const))('%s with the First Day route: no prop sinks into the terrain and no two static boxes share a voxel anywhere, across chunk borders too', (mapId) => {
    const session = withRoute(mapId);
    const world = buildStatic(session.world);
    const boxes = allBoxes(world);
    const sunk = boxes.filter((box) => {
      const group = unpackBoxWord(box.word).group;
      return group !== OUTLINE_GROUP_GROUND && box.z0 < GROUND_TOP_Z;
    }).filter((box) => {
      // Objects stand on a plot slab that may start at the ground top; only props are judged here.
      const tx = Math.floor(box.x0 / TILE);
      const ty = Math.floor(box.y0 / TILE);
      return session.world.propAt({ x: tx, y: ty }) !== undefined;
    });
    expect(sunk.length, 'prop boxes below the ground top').toBe(0);
    const propGroups = new Set([...session.world.props.values()].map((prop) => propOutlineGroup(prop.id)));
    expect(parkOverlaps(boxes, propGroups).slice(0, 5)).toEqual([]);
  }, 30_000);
});

describe('Phase 24 render review: outlines between neighbours', () => {
  it.each(MAPS.map((map) => [map.id] as const))('%s: no two touching props (8-neighbourhood) share an outline group', (mapId) => {
    const world = sessionOn(mapId).world;
    const owner = new Map<string, number>();
    for (const prop of world.props.values()) for (const cell of world.propFootprint(prop)) owner.set(`${cell.x},${cell.y}`, prop.id);
    const clashes: string[] = [];
    for (const [key, id] of owner) {
      const [x, y] = key.split(',').map(Number);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const other = owner.get(`${x + dx},${y + dy}`);
          if (other === undefined || other === id) continue;
          if (propOutlineGroup(other) === propOutlineGroup(id)) clashes.push(`${id}@${key} vs ${other}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it.each(MAPS.map((map) => [map.id] as const))('%s with the First Day route: no built object shares an outline group with a prop it touches', (mapId) => {
    const world = withRoute(mapId).world;
    const clashes: string[] = [];
    for (const object of world.objects.values()) {
      for (const cell of world.objectFootprint(object)) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const prop = world.propAt({ x: cell.x + dx, y: cell.y + dy });
            if (prop && propOutlineGroup(prop.id) === objectOutlineGroup(object.id)) clashes.push(`${object.definitionId}#${object.id} vs ${prop.kind}#${prop.id}`);
          }
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});

/** Not an assertion on a map: the arithmetic behind the spread outline group, so a future map that crosses it is caught by the test above. */
describe('Phase 24 render review: propOutlineGroup arithmetic', () => {
  it('ids 255 apart share a group (a map with more than 255 props can put two such props side by side)', () => {
    expect(propOutlineGroup(1)).toBe(propOutlineGroup(256));
    const maxProps = Math.max(...MAPS.map((map) => sessionOn(map.id).world.props.size));
    // Record the densest shipped map so a reader sees how close the shipped maps are to the wrap.
    expect(maxProps).toBeGreaterThan(0);
    expect(PROP_KIND_BY_ID.size).toBe(32);
  });
});

/**
 * FINDING (voxel, reproduced in the real UI: phase24/rev/sheet-cut-voxel.png). Hovering a prop with the bulldozer opens the
 * cutaway with the height of the ghost volume, and a prop has no bulldoze ghost (ghost.ts resolveBulldoze only knows placed
 * objects), so the height is 0 and the cut key sits at the prop's own front corner: the boulder the player is about to pay
 * to clear is cut out of the picture (a canyon wall shows a carved hole), and nothing tints it the way a marked ride is
 * tinted. FIXED: ghost.ts resolveBulldozeProp gives a prop under the bulldozer its own ghost (the prop's model in place,
 * red for a clear that will happen, slate for a refused one), so the cutaway learns the prop's height and keeps it.
 */
describe('Phase 24 render review: the bulldozer hover keeps the prop it targets', () => {
  const rigScene = (session: ParkSession): VoxelScene => new VoxelScene(session, palette, cache, { sink: new Sink(), content: REGISTRY_CONTENT, prewarmBudgetMs: 0 });

  it('a bulldoze preview over a prop has a ghost volume (like a placed object under the bulldozer)', () => {
    const session = sessionOn('red-rock-canyon');
    const scene = rigScene(session);
    scene.update(16, 16, 0.5);
    const boulder = [...session.world.props.values()].find((prop) => prop.kind === 'red-boulder')!;
    scene.setPreview([{ x: boulder.x, y: boulder.y }], null, true, true, 0);
    scene.update(16, 32, 0.5);
    expect(scene.ghostVolume.active).toBe(true);
  });

  it('no box of the hovered prop is cut by the bulldozer cutaway (inputs exactly as VoxelRenderer.updateSeeThrough passes them)', () => {
    const session = sessionOn('red-rock-canyon');
    const scene = rigScene(session);
    scene.update(16, 16, 0.5);
    for (const kind of ['red-boulder', 'saguaro', 'canyon-wall'] as const) {
      const prop = [...session.world.props.values()].find((candidate) => candidate.kind === kind)!;
      const cell = { x: prop.x, y: prop.y };
      scene.setPreview([cell], null, true, true, 0);
      scene.update(16, 32, 0.5);
      const volume = scene.ghostVolume;
      const focus: SeeThroughFocus = { minX: 0, minY: 0, maxX: 0, maxY: 0, mode: 'cell', peek: false, heightVoxels: 0 };
      expect(resolveSeeThroughFocus({ armed: true, peek: false }, cell, [cell], 'bulldoze', volume.active ? volume.heightVoxels : 0, focus)).toBe(true);
      const values = seeThroughValuesFor(focus, createSeeThroughValues());
      const writer = (scene as unknown as { staticWorld: StaticWorld }).staticWorld.chunkBoxes(chunkIndexOfCell(prop.x, prop.y, 32));
      let worst = 0;
      for (let box = 0; box < writer.count; box += 1) {
        const at = box * BOX_FLOATS;
        if (unpackBoxWord(writer.data[at + 3]).group !== propOutlineGroup(prop.id)) continue;
        // The box's top front corner (the fragment nearest the camera).
        const x = writer.data[at] + writer.data[at + 4];
        const y = writer.data[at + 1] + writer.data[at + 5];
        const z = writer.data[at + 2] + writer.data[at + 6];
        worst = Math.max(worst, seeThroughCoverage(x - y, (x + y) / 2 - z, x + y + z, values, 1));
      }
      expect(worst, `${kind}: coverage of its own boxes`).toBe(0);
    }
  });
});
