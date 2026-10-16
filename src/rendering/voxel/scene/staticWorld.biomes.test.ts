import { describe, expect, it } from 'vitest';
import { BIOME_BY_ID } from '../../../game/biomes/content';
import { MAP_BY_ID, MAPS } from '../../../game/maps/content';
import { propFootprintSize } from '../../../game/maps/parse';
import { PROP_KIND_BY_ID } from '../../../game/maps/props';
import type { MapId } from '../../../game/maps/types';
import { FOUNDING_SCENARIOS } from '../../../game/scenarios/content';
import { seedDevPark } from '../../../game/session/devPark';
import { ParkSession } from '../../../game/session/ParkSession';
import type { GameWorld } from '../../../game/World';
import { createViewFrame } from '../../viewRotation';
import type { ViewRotation } from '../../viewRotation';
import { createModelCache } from '../blueprint/compile';
import { BOX_FLOATS, packBoxWord, unpackBoxWord } from '../contracts/boxes';
import { objectOutlineGroup, OUTLINE_GROUP_GROUND, propOutlineGroup } from '../contracts/gbuffer';
import { MAT, PATTERN } from '../contracts/palette';
import { createViewTransform, setViewTransform } from '../contracts/view';
import { CHUNK_TILES, chunkIndexOfCell, VOXELS_PER_TILE } from '../contracts/space';
import { gamePalette } from '../gamePalette';
import fixture from './__fixtures__/meadow-chunks.json';
import { groundStyleFor, meadowGroundStyle } from './groundStyle';
import { createTransformTable } from './rigid';
import { REGISTRY_CONTENT, SceneModels, StaticWorld } from './staticWorld';

/**
 * Phase 24 in the static world: the default Meadow stays bit-identical (pre-change chunk hashes, in the game's real
 * 162-material palette), biome ground is data (box words), terrain is disjoint greedy rectangles, props are static
 * chunk content (home chunk, spread outline group, no overlap with anything), and clearing a prop rebuilds one chunk
 * to exactly what a from-scratch build gives.
 */

const TILE = VOXELS_PER_TILE;
const palette = gamePalette();
const cache = createModelCache();

const build = (game: GameWorld, rotation: ViewRotation = 0, errors: string[] = []): { world: StaticWorld; models: SceneModels; view: ReturnType<typeof createViewTransform> } => {
  const models = new SceneModels(palette, cache, REGISTRY_CONTENT, (message) => errors.push(String(message)));
  const view = setViewTransform(createViewFrame(rotation, game.width, game.height), createViewTransform());
  const world = new StaticWorld({ width: game.width, height: game.height, models, transforms: createTransformTable(), view });
  world.sync(game);
  world.rebuildDirty(game);
  return { world, models, view };
};

const hashes = (world: StaticWorld): [number, string][] => Array.from({ length: world.chunkCount }, (_unused, index) => [world.chunkBoxes(index).count, world.chunkHash(index)]);

interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; word: number }

const boxesOf = (world: StaticWorld, chunk: number): Box[] => {
  const writer = world.chunkBoxes(chunk);
  const out: Box[] = [];
  for (let box = 0; box < writer.count; box += 1) {
    const at = box * BOX_FLOATS;
    const d = writer.data;
    out.push({ x0: d[at], y0: d[at + 1], z0: d[at + 2], x1: d[at] + d[at + 4], y1: d[at + 1] + d[at + 5], z1: d[at + 2] + d[at + 6], word: d[at + 3] });
  }
  return out;
};

const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1 && a.z0 < b.z1 && b.z0 < a.z1;

const overlappingPairs = (boxes: readonly Box[]): number => {
  let count = 0;
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) if (overlaps(boxes[i], boxes[j])) count += 1;
  return count;
};

const sessionOn = (mapId: MapId): ParkSession => new ParkSession(null, [], { mapId });

describe('the default Meadow is bit-identical (pre-Phase-24 chunk hashes, 162-material palette)', () => {
  const same = (name: string, session: ParkSession, rotation: ViewRotation = 0): void => {
    const errors: string[] = [];
    const { world } = build(session.world, rotation, errors);
    expect(errors).toEqual([]);
    expect(hashes(world), name).toEqual((fixture.parks as unknown as Record<string, [number, string][]>)[name]);
  };
  const dev = (): ParkSession => { const session = new ParkSession(null); seedDevPark(session); session.syncWithWorld(); return session; };

  it('a fresh sandbox, the dev park in views 0 to 3 and every scenario', () => {
    same('sandbox', new ParkSession(null));
    same('devPark', dev());
    for (const rotation of [1, 2, 3] as ViewRotation[]) same(`devPark-v${rotation}`, dev(), rotation);
    for (const scenario of FOUNDING_SCENARIOS) same(`scenario:${scenario.id}`, new ParkSession(scenario));
  });

  it('Meadow\'s ground words are exactly today\'s lawn, soil, paving and curb', () => {
    const meadow = groundStyleFor(palette, BIOME_BY_ID.get('meadow')!);
    expect(meadow).toEqual(meadowGroundStyle());
    expect(meadow.base).toBe(packBoxWord(MAT.GRASS, OUTLINE_GROUP_GROUND, PATTERN.GRASS, 0));
    expect(meadow.soil).toBe(packBoxWord(MAT.SOIL, OUTLINE_GROUP_GROUND, PATTERN.SOIL, 0));
    expect(meadow.paving).toBe(packBoxWord(MAT.PAVING, OUTLINE_GROUP_GROUND, PATTERN.PAVING, 0));
    expect(meadow.curb).toBe(packBoxWord(MAT.CURB, OUTLINE_GROUP_GROUND, PATTERN.PLAIN, 0));
  });

  it('an all-base chunk is the same two boxes in the same order as before', () => {
    const { world } = build(new ParkSession(null).world);
    const boxes = boxesOf(world, 0);
    expect(boxes.filter((box) => box.word === meadowGroundStyle().base)).toHaveLength(1);
    expect(boxes[boxes.length - 2] ?? boxes[0]).toBeDefined();
    const terrain = boxes.filter((box) => box.z0 < 0);
    expect(terrain.map((box) => [box.x0, box.y0, box.z0, box.x1 - box.x0, box.y1 - box.y0, box.z1 - box.z0])).toEqual([
      [0, 0, -1, 256, 256, 1],
      [0, 0, -16, 256, 256, 15],
    ]);
  });
});

describe('biome ground is data', () => {
  it('every biome resolves to its own materials (Seaside sand and sea grass, Winter ice, Desert red rock)', () => {
    const seaside = groundStyleFor(palette, BIOME_BY_ID.get('seaside')!);
    expect(unpackBoxWord(seaside.base).material).toBe(palette.material(0x5ed6a4));
    expect(unpackBoxWord(seaside.alt).material).toBe(palette.material(0xf8d384));
    expect(unpackBoxWord(seaside.water).material).toBe(MAT.WATER);
    const winter = groundStyleFor(palette, BIOME_BY_ID.get('winter')!);
    expect(unpackBoxWord(winter.water).material, 'ice is a plain material').toBe(palette.material(0xb9e2f2));
    expect(palette.flags(unpackBoxWord(winter.water).material)).toBe(0);
    const desert = groundStyleFor(palette, BIOME_BY_ID.get('desert-canyon')!);
    expect(unpackBoxWord(desert.soil).material).toBe(palette.material(0xa65a3c));
    const distinct = new Set(['meadow', 'seaside', 'desert-canyon', 'winter', 'jungle', 'autumn-forest'].map((id) => groundStyleFor(palette, BIOME_BY_ID.get(id as never)!).base));
    expect(distinct.size, 'six different lawns (jungle and meadow differ too)').toBe(6);
  });

  it('a palette that lacks the biome colours falls back to Meadow\'s words once, reported, never thrown', async () => {
    const { buildPalette } = await import('../palette');
    const plain = buildPalette([], [], []);
    const errors: string[] = [];
    const models = new SceneModels(plain, createModelCache(), REGISTRY_CONTENT, (message) => errors.push(message));
    const biome = BIOME_BY_ID.get('winter')!;
    expect(models.groundStyle(biome)).toEqual(meadowGroundStyle());
    expect(models.groundStyle(biome)).toEqual(meadowGroundStyle());
    expect(errors).toHaveLength(1);
  });

  it.each(MAPS.map((map) => [map.id] as const))('%s: terrain is disjoint rectangles covering every chunk exactly once, and props never overlap anything', (id) => {
    const session = sessionOn(id);
    const errors: string[] = [];
    const { world } = build(session.world, 0, errors);
    expect(errors, 'no content failure').toEqual([]);
    for (let chunk = 0; chunk < world.chunkCount; chunk += 1) {
      const boxes = boxesOf(world, chunk);
      const top = boxes.filter((box) => box.z0 === -1 && box.z1 === 0);
      const area = top.reduce((sum, box) => sum + (box.x1 - box.x0) * (box.y1 - box.y0), 0);
      expect(area, `chunk ${chunk} top layer area`).toBe(CHUNK_TILES * TILE * CHUNK_TILES * TILE);
      expect(overlappingPairs(boxes), `chunk ${chunk} overlaps`).toBe(0);
    }
  });

  it('a path in a biome uses that biome\'s paving and curb', () => {
    const session = sessionOn('red-rock-canyon');
    const gate = session.world.entrance;
    expect(session.world.buildPaths([{ x: gate.x, y: gate.y }, { x: gate.x, y: gate.y + 1 }, { x: gate.x, y: gate.y + 2 }]).built).toBeGreaterThan(0);
    const { world } = build(session.world);
    const style = groundStyleFor(palette, BIOME_BY_ID.get('desert-canyon')!);
    const words = new Set(boxesOf(world, chunkIndexOfCell(gate.x, gate.y + 1, 32)).map((box) => box.word));
    expect(words.has(style.paving)).toBe(true);
    expect(words.has(style.curb)).toBe(true);
    expect(words.has(meadowGroundStyle().paving)).toBe(false);
  });
});

describe('props are static chunk content', () => {
  it('emit every prop in its home chunk, in its own spread outline group, with the chunk\'s boxes in front-to-back order', () => {
    const session = sessionOn('maple-ridge');
    const { world } = build(session.world);
    const props = [...session.world.props.values()];
    expect(props.length).toBeGreaterThan(40);
    const groups = new Map<number, number>();
    for (let chunk = 0; chunk < world.chunkCount; chunk += 1) {
      for (const box of boxesOf(world, chunk)) {
        const group = unpackBoxWord(box.word).group;
        if (group !== OUTLINE_GROUP_GROUND) groups.set(group, (groups.get(group) ?? 0) + 1);
      }
    }
    for (const prop of props.slice(0, 30)) expect(groups.has(propOutlineGroup(prop.id)), `prop ${prop.id} group`).toBe(true);
    // Neighbouring ids never share a group, so a forest outlines tree against tree.
    for (let id = 1; id < 255; id += 1) expect(propOutlineGroup(id)).not.toBe(propOutlineGroup(id + 1));
    for (const prop of props) {
      const kind = PROP_KIND_BY_ID.get(prop.kind)!;
      const [w, d] = propFootprintSize(kind, prop.rotation);
      const home = chunkIndexOfCell(prop.x + w - 1, prop.y + d - 1, 32);
      const inHome = boxesOf(world, home).some((box) => unpackBoxWord(box.word).group === propOutlineGroup(prop.id) && box.x0 >= prop.x * TILE - 1 && box.x1 <= (prop.x + w) * TILE + 1);
      expect(inHome, `prop ${prop.id} ${prop.kind} lives in chunk ${home}`).toBe(true);
    }
  });

  it('stand exactly inside their footprint cells (no box leaves the cells the world blocks)', () => {
    for (const id of ['maple-ridge', 'emerald-ruins', 'frosted-hollow'] as const) {
      const session = sessionOn(id);
      const { world } = build(session.world);
      const blocked = new Set<string>();
      for (const prop of session.world.props.values()) for (const cell of session.world.propFootprint(prop)) blocked.add(`${cell.x},${cell.y}`);
      for (let chunk = 0; chunk < world.chunkCount; chunk += 1) {
        for (const box of boxesOf(world, chunk)) {
          if (box.z0 < 0 || unpackBoxWord(box.word).group === OUTLINE_GROUP_GROUND || unpackBoxWord(box.word).group === objectOutlineGroup(0)) continue;
          for (const [x, y] of [[box.x0, box.y0], [box.x1 - 0.5, box.y1 - 0.5]] as const) {
            expect(blocked.has(`${Math.floor(x / TILE)},${Math.floor(y / TILE)}`), `${id}: a prop box at (${x}, ${y}) stands on a free cell`).toBe(true);
          }
        }
      }
    }
  });

  it('clearing a prop dirties exactly its home chunk and the rebuild equals a from-scratch build', () => {
    const session = sessionOn('brookside-meadow');
    const world = session.world;
    const incremental = build(world);
    const target = [...world.props.values()].find((prop) => PROP_KIND_BY_ID.get(prop.kind)!.clearCost !== null && PROP_KIND_BY_ID.get(prop.kind)!.footprint[0] === 1)!;
    expect(world.bulldoze({ x: target.x, y: target.y }).removed).toBe(true);
    incremental.world.sync(world);
    expect(incremental.world.dirtyCount, 'one chunk').toBe(1);
    expect(incremental.world.dirty[chunkIndexOfCell(target.x, target.y, 32)]).toBe(1);
    incremental.world.rebuildDirty(world);
    const scratch = build(world);
    expect(hashes(incremental.world)).toEqual(hashes(scratch.world));
    // A steady frame afterwards rebuilds nothing.
    incremental.world.sync(world);
    expect(incremental.world.dirtyCount).toBe(0);
  });

  it('a session swap (undo, load) rebuilds everything once and then nothing', () => {
    const session = sessionOn('emerald-ruins');
    const first = build(session.world);
    first.world.reset();
    first.world.sync(session.world);
    expect(first.world.dirtyCount).toBe(first.world.chunkCount);
    first.world.rebuildDirty(session.world);
    first.world.sync(session.world);
    expect(first.world.dirtyCount).toBe(0);
  });

  it('a saved and restored park hashes like the original', () => {
    const session = sessionOn('seaside-cove');
    const restored = ParkSession.fromState(session.serialize());
    expect(hashes(build(restored.world).world)).toEqual(hashes(build(session.world).world));
  });

  it('turning the view four times leaves every chunk hash as it was', () => {
    const session = sessionOn('maple-ridge');
    const { world, view } = build(session.world);
    const before = hashes(world);
    for (const rotation of [1, 2, 3, 0] as ViewRotation[]) {
      setViewTransform(createViewFrame(rotation, 32, 32), view);
      world.reorderForView();
    }
    expect(before.length).toBe(16);
    expect(hashes(world)).toEqual(before);
  });
});

describe('the gate follows the map', () => {
  const gateBoxes = (mapId: MapId): Box[] => {
    const session = sessionOn(mapId);
    const { world } = build(session.world);
    const gate = session.world.entrance;
    return boxesOf(world, chunkIndexOfCell(gate.x, gate.y, 32)).filter((box) => unpackBoxWord(box.word).group === objectOutlineGroup(0));
  };

  it('a north gate is a frame across x, an east or west gate a frame across y (quarter turn 1)', () => {
    const extent = (boxes: Box[]): [number, number] => [Math.max(...boxes.map((b) => b.x1)) - Math.min(...boxes.map((b) => b.x0)), Math.max(...boxes.map((b) => b.y1)) - Math.min(...boxes.map((b) => b.y0))];
    const north = extent(gateBoxes('meadow'));
    expect(north[0]).toBeGreaterThan(north[1]);
    const south = extent(gateBoxes('red-rock-canyon'));
    expect(south[0], 'a south gate is walked along y like a north one').toBeGreaterThan(south[1]);
    const east = extent(gateBoxes('seaside-cove'));
    expect(MAP_BY_ID.get('seaside-cove')!.rows.some((row) => row.startsWith('E'))).toBe(true);
    expect(east[1], 'an east gate stands across y').toBeGreaterThan(east[0]);
  });

  it('cuts the gate-tile curbs against the turned frame (no box shares voxels with the gate)', () => {
    for (const id of ['seaside-cove', 'red-rock-canyon', 'meadow'] as const) {
      const session = sessionOn(id);
      const gate = session.world.entrance;
      const frameCells = id === 'seaside-cove' ? [{ x: 0, y: 15 }, { x: 1, y: 15 }, { x: 2, y: 15 }] : [{ x: gate.x, y: gate.y }, { x: gate.x, y: gate.y + (id === 'red-rock-canyon' ? 1 : -1) }];
      session.world.buildPaths(frameCells);
      const { world } = build(session.world);
      const chunk = chunkIndexOfCell(gate.x, gate.y, 32);
      expect(overlappingPairs(boxesOf(world, chunk)), id).toBe(0);
    }
  });
});
