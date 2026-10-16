import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_CATALOG } from '../../../game/content/catalog';
import { MAPS } from '../../../game/maps/content';
import { PROP_KIND_BY_ID } from '../../../game/maps/props';
import type { MapId } from '../../../game/maps/types';
import { ParkSession } from '../../../game/session/ParkSession';
import type { BuildDefinition, Cell } from '../../../game/types';
import { createModelCache } from '../blueprint/compile';
import { BOX_BUDGET, MAX_PARK_BOX_BUDGET, PROP_MAP_BOX_BUDGET } from '../contracts/budgets';
import type { DynamicTexture, VoxelGpuSink } from '../contracts/frame';
import { chunkIndexOfCell } from '../contracts/space';
import { createSeeThroughValues, seeThroughCoverage, seeThroughValuesFor } from '../gpu/seeThroughView';
import { gamePalette } from '../gamePalette';
import { propOutlineGroup } from '../contracts/gbuffer';
import { unpackBoxWord } from '../contracts/boxes';
import { REGISTRY_CONTENT, SceneModels } from './staticWorld';
import { VoxelScene } from './VoxelScene';

/**
 * Phase 24 props through the whole scene: a steady frame on a prop-heavy map rebuilds nothing (no per-frame churn), a clear
 * rebuilds exactly one chunk once, a session swap rebuilds everything once, and the heaviest maps stay inside the
 * measured PROP_MAP_BOX_BUDGET (with the worst park a player can build on them inside MAX_PARK_BOX_BUDGET).
 */

const palette = gamePalette();
const cache = createModelCache();

class Sink implements VoxelGpuSink {
  chunks: { index: number; count: number }[] = [];
  bytes = 0;
  setChunk(index: number, _boxes: Float32Array, boxCount: number): void { this.chunks.push({ index, count: boxCount }); }
  setDynamic(_texture: DynamicTexture, _data: Float32Array, _count: number, rowStart: number, rowEnd: number): void { this.bytes += (rowEnd - rowStart) * 4096; }
  setFigureRanges(): void { /* not recorded */ }
  setGhost(): void { /* not recorded */ }
  setDraft(): void { /* not recorded */ }
}

let clock = 0;
const frame = (scene: VoxelScene): void => { clock += 16; scene.update(16, clock, 0.5); };

const rig = (session: ParkSession): { scene: VoxelScene; sink: Sink; errors: string[] } => {
  const sink = new Sink();
  const errors: string[] = [];
  const scene = new VoxelScene(session, palette, cache, { sink, content: REGISTRY_CONTENT, prewarmBudgetMs: 0, reportError: (message) => errors.push(message) });
  session.world.subscribe(() => scene.syncWorld());
  return { scene, sink, errors };
};

const total = (scene: VoxelScene): number => Array.from({ length: scene.chunkCount }, (_u, chunk) => scene.chunkBoxCount(chunk)).reduce((a, b) => a + b, 0);
const heaviest = (scene: VoxelScene): number => Math.max(...Array.from({ length: scene.chunkCount }, (_u, chunk) => scene.chunkBoxCount(chunk)));

const sessionOn = (mapId: MapId): ParkSession => new ParkSession(null, [], { mapId });

describe('props in the scene', () => {
  it('a steady frame on a prop-heavy map rebuilds nothing and sends no chunk', () => {
    const session = sessionOn('maple-ridge');
    const { scene, sink, errors } = rig(session);
    frame(scene);
    frame(scene);
    sink.chunks = [];
    for (let index = 0; index < 20; index += 1) {
      frame(scene);
      expect(scene.stats.chunksRebuilt, `frame ${index}`).toBe(0);
    }
    expect(sink.chunks).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('clearing a prop rebuilds exactly its home chunk, once', () => {
    const session = sessionOn('frosted-hollow');
    const { scene, sink } = rig(session);
    frame(scene);
    sink.chunks = [];
    const prop = [...session.world.props.values()].find((candidate) => PROP_KIND_BY_ID.get(candidate.kind)!.clearCost !== null && PROP_KIND_BY_ID.get(candidate.kind)!.footprint[0] === 1)!;
    const before = scene.chunkBoxCount(chunkIndexOfCell(prop.x, prop.y, 32));
    expect(session.world.bulldoze({ x: prop.x, y: prop.y }).removed).toBe(true);
    frame(scene);
    expect(sink.chunks.map((call) => call.index)).toEqual([chunkIndexOfCell(prop.x, prop.y, 32)]);
    expect(scene.chunkBoxCount(chunkIndexOfCell(prop.x, prop.y, 32)), 'the prop\'s boxes are gone').toBeLessThan(before);
    frame(scene);
    expect(scene.stats.chunksRebuilt).toBe(0);
  });

  it('undo (a restored session swapped in) rebuilds every chunk once and brings the prop back', () => {
    const session = sessionOn('emerald-ruins');
    const { scene, sink } = rig(session);
    frame(scene);
    const snapshot = session.serialize();
    const prop = [...session.world.props.values()].find((candidate) => PROP_KIND_BY_ID.get(candidate.kind)!.clearCost !== null)!;
    session.world.bulldoze({ x: prop.x, y: prop.y });
    frame(scene);
    const cleared = total(scene);
    const restored = ParkSession.fromState(snapshot);
    restored.world.subscribe(() => scene.syncWorld());
    scene.setSession(restored);
    sink.chunks = [];
    frame(scene);
    expect(scene.stats.chunksRebuilt).toBe(scene.chunkCount);
    expect(total(scene), 'the cleared prop is back').toBeGreaterThan(cleared);
    frame(scene);
    expect(scene.stats.chunksRebuilt).toBe(0);
  });
});

describe('see-through works on props (the cut is geometry, a prop is ordinary static boxes)', () => {
  it('cuts the boxes of a prop standing in front of a build site and leaves a far one alone', () => {
    const session = sessionOn('red-rock-canyon');
    const { scene } = rig(session);
    frame(scene);
    // A site of 3x3 cells right behind (toward -x, -y) a saguaro: a boulder or tree in front of it is in the cut volume.
    const prop = [...session.world.props.values()].find((candidate) => candidate.kind === 'saguaro')!;
    const focus = { minX: prop.x - 3, minY: prop.y - 3, maxX: prop.x - 1, maxY: prop.y - 1, mode: 'place' as const, peek: false, heightVoxels: 40 };
    const values = seeThroughValuesFor(focus, createSeeThroughValues());
    const coverageOf = (propId: number, chunkOfCell: number): number => {
      let best = 0;
      const writer = (scene as unknown as { staticWorld: { chunkBoxes(i: number): { count: number; data: Float32Array } } }).staticWorld.chunkBoxes(chunkOfCell);
      for (let box = 0; box < writer.count; box += 1) {
        const at = box * 8;
        if (unpackBoxWord(writer.data[at + 3]).group !== propOutlineGroup(propId)) continue;
        const x = writer.data[at] + writer.data[at + 4] / 2;
        const y = writer.data[at + 1] + writer.data[at + 5] / 2;
        const z = writer.data[at + 2] + writer.data[at + 6];
        best = Math.max(best, seeThroughCoverage(x - y, (x + y) / 2 - z, x + y + z, values, 1));
      }
      return best;
    };
    expect(coverageOf(prop.id, chunkIndexOfCell(prop.x, prop.y, 32)), 'the saguaro in front of the site fades').toBeGreaterThan(0);
    const far = [...session.world.props.values()].reduce((best, candidate) => (candidate.x + candidate.y < best.x + best.y ? candidate : best));
    expect(coverageOf(far.id, chunkIndexOfCell(far.x, far.y, 32)), 'a prop behind it does not').toBe(0);
  });
});

describe('prop map box budgets (measured)', () => {
  const heaviestRide = (): BuildDefinition => {
    const models = new SceneModels(palette, cache, REGISTRY_CONTENT, () => undefined);
    let best: { definition: BuildDefinition; boxes: number } | null = null;
    for (const definition of BUILD_CATALOG) {
      if (definition.kind !== 'ride' || definition.custom || definition.footprint[0] !== 3 || definition.footprint[1] !== 3) continue;
      const boxes = Math.max(models.objectModel(definition, 0).boxCount, models.objectModel(definition, 1).boxCount);
      if (!best || boxes > best.boxes) best = { definition, boxes };
    }
    return best!.definition;
  };

  /** A path grid every fourth row and column and the heaviest 3x3 ride on every plot between that props and water leave free. */
  const worstPark = (mapId: MapId): ParkSession => {
    const session = sessionOn(mapId);
    const world = session.world;
    world.addMoney(10_000_000, 'Max park funding');
    const paths: Cell[] = [];
    for (let y = 0; y < world.height; y += 1) for (let x = 0; x < world.width; x += 1) if (x % 4 === 3 || y % 4 === 3) paths.push({ x, y });
    world.buildPaths(paths);
    const ride = heaviestRide();
    for (let y = 0; y + 3 <= world.height; y += 4) for (let x = 0; x + 3 <= world.width; x += 4) world.seedScenarioObject(ride.id, { x, y }, 0);
    return session;
  };

  const measure = (mapId: MapId): { total: number; heaviest: number; rebuildMs: number } => {
    const session = sessionOn(mapId);
    const { scene } = rig(session);
    frame(scene);
    const heavyChunk = Array.from({ length: scene.chunkCount }, (_u, chunk) => chunk).sort((a, b) => scene.chunkBoxCount(b) - scene.chunkBoxCount(a))[0];
    const samples: number[] = [];
    for (let run = 0; run < 15; run += 1) {
      // Rebuild the heaviest chunk through the same path a clear takes: dirty it and run one frame.
      (scene as unknown as { staticWorld: { dirty: Uint8Array } }).staticWorld.dirty[heavyChunk] = 1;
      const start = performance.now();
      frame(scene);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { total: total(scene), heaviest: heaviest(scene), rebuildMs: samples[7] };
  };

  it('keeps every shipped map and the worst park a player can build on it inside the measured budgets', () => {
    for (const map of MAPS) {
      const result = measure(map.id);
      // Phase 21: the map-wide budgets are per 32 x 32 of area (an estate has four times the chunks); per chunk is unchanged.
      const area = (map.width * map.height) / 1024;
      expect(result.total, `${map.id} total`).toBeLessThanOrEqual(PROP_MAP_BOX_BUDGET.total * area);
      expect(result.heaviest, `${map.id} heaviest chunk`).toBeLessThanOrEqual(PROP_MAP_BOX_BUDGET.heaviestChunk);
      expect(result.rebuildMs, `${map.id} one-chunk rebuild`).toBeLessThanOrEqual(PROP_MAP_BOX_BUDGET.rebuildMs);
      if (map.id === 'meadow') continue;
      const worst = rig(worstPark(map.id));
      frame(worst.scene);
      const boxes = total(worst.scene);
      expect(boxes, `${map.id} worst park`).toBeLessThanOrEqual(PROP_MAP_BOX_BUDGET.worstPark * area);
      expect(boxes).toBeLessThanOrEqual(MAX_PARK_BOX_BUDGET * area);
    }
  });

  it('keeps a full chunk of the densest allowed forest inside the heaviest-chunk budget (40 prop cells of the costliest kinds)', () => {
    const costliest = Math.max(BOX_BUDGET.prop, BOX_BUDGET.propLong / 2, BOX_BUDGET.propLarge / 4);
    expect(GAME_CONFIG.maps.maxPropCellsPerChunk * costliest, 'a chunk at the validator\'s density cap and the kind budgets').toBeLessThanOrEqual(5_000);
  });
});
