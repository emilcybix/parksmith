import { vi, describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { seedDevPark } from '../../../game/session/devPark';
import { ParkSession } from '../../../game/session/ParkSession';
import type { Cell, Rotation } from '../../../game/types';
import type { GameWorld } from '../../../game/World';
import { createViewFrame, rectToView, VIEW_ROTATIONS, type ViewRotation, type XY } from '../../viewRotation';
import { createModelCache } from '../blueprint/compile';
import { BOX_FLOATS, BOX_TEX_WIDTH, BOX_TEXELS, STATIC_SLOT } from '../contracts/boxes';
import type { GhostState, TexelBounds, VoxelGpuSink } from '../contracts/frame';
import type { DynamicTexture } from '../contracts/frame';
import { FIGURE_FLOATS } from '../contracts/figures';
import { OUTLINE_GROUP_GROUND } from '../contracts/gbuffer';
import { VOXELS_PER_TILE } from '../contracts/space';
import {
  createViewTransform, headingInView, quarterTurnsOfTransform, setViewTransform, vectorToViewVoxel, voxelToView,
} from '../contracts/view';
import { buildPalette } from '../palette';
import { COASTER_CAR_POSE_FLOATS, createCoasterCarPoses, placeCoasterCars } from './coasterCars';
import { headingOf } from './figures';
import { PLACEHOLDER_CONTENT, REGISTRY_CONTENT } from './staticWorld';
import type { SceneContent, StaticWorld } from './staticWorld';
import { VoxelScene } from './VoxelScene';

/**
 * Phase 16: this test was calibrated on a park without theme affinity and is not about themes, so it runs with the
 * affinity share at 0 (any non-zero share shifts guest choices and so who litters where and when guests arrive).
 */
vi.mock('../../../game/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../game/config')>();
  const config = actual.GAME_CONFIG;
  return {
    ...actual,
    GAME_CONFIG: { ...config, scenery: { ...config.scenery, themeAffinity: { ...config.scenery.themeAffinity, share: 0 } } },
  };
});


/**
 * Phase 26 step 2, the scene side: a view turn rebuilds nothing, re-sorts and re-sends the chunks, keeps the
 * sort and the bounds exact for every view, equals a from-scratch build in the same view, and every dynamic
 * system (ghost, figures, trains) lands where the rotation maths says.
 */

const TILE = VOXELS_PER_TILE;
const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const CACHE = createModelCache();
const KIB = 1024;

class Sink implements VoxelGpuSink {
  chunks: { index: number; count: number; bounds: TexelBounds | null }[] = [];
  dynamics: { texture: DynamicTexture; count: number; rowStart: number; rowEnd: number }[] = [];
  figures: Float32Array | null = null;
  figureCount = 0;
  ghost: GhostState | null = null;
  setChunk(index: number, _boxes: Float32Array, count: number, bounds: TexelBounds | null): void {
    this.chunks.push({ index, count, bounds: bounds ? { ...bounds } : null });
  }
  setDynamic(texture: DynamicTexture, data: Float32Array, count: number, rowStart: number, rowEnd: number): void {
    this.dynamics.push({ texture, count, rowStart, rowEnd });
    if (texture === 'figures') {
      this.figures = data;
      this.figureCount = count;
    }
  }
  setFigureRanges(): void {}
  setGhost(ghost: GhostState | null): void { this.ghost = ghost === null ? null : { ...ghost }; }
  setDraft(): void {}
  clear(): void {
    this.chunks = [];
    this.dynamics = [];
  }
}

const sceneFor = (session: ParkSession, sink: VoxelGpuSink, content: SceneContent = REGISTRY_CONTENT): VoxelScene =>
  new VoxelScene(session, PALETTE, CACHE, { sink, content, prewarmBudgetMs: 0, reportError: () => undefined });

const devPark = (): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  return session;
};

let clock = 0;
const frame = (scene: VoxelScene, stepFraction = 0.5): void => {
  clock += 16;
  scene.update(16, clock, stepFraction);
};

const frameOf = (rotation: ViewRotation, session: ParkSession) => createViewFrame(rotation, session.world.width, session.world.height);

const staticWorldOf = (scene: VoxelScene): StaticWorld => (scene as unknown as { staticWorld: StaticWorld }).staticWorld;

const hashes = (scene: VoxelScene): string[] => Array.from({ length: scene.chunkCount }, (_unused, chunk) => scene.chunkHash(chunk));

const nonEmptyChunks = (scene: VoxelScene): number[] =>
  Array.from({ length: scene.chunkCount }, (_unused, chunk) => chunk).filter((chunk) => scene.chunkBoxCount(chunk) > 0);

const bytesOf = (boxes: number): number => Math.ceil(boxes * BOX_TEXELS / BOX_TEX_WIDTH) * BOX_TEX_WIDTH * 16;

describe('scene: view turn', () => {
  it.each(VIEW_ROTATIONS.map((q) => [q] as const))(
    'a steady dev-park frame with 300 guests rebuilds nothing and sends no chunk in view %i',
    (rotation) => {
      const session = devPark();
      session.guests.spawnGuests(300);
      for (let step = 0; step < 100; step += 1) session.step(GAME_CONFIG.fixedStepMs);
      const sink = new Sink();
      const scene = sceneFor(session, sink);
      scene.setView(frameOf(rotation, session));
      frame(scene);
      frame(scene);
      sink.clear();
      for (let index = 0; index < 10; index += 1) {
        session.step(GAME_CONFIG.fixedStepMs);
        frame(scene, index / 10);
        expect(scene.stats.chunksRebuilt, `frame ${index}: no chunk rebuilt`).toBe(0);
        expect(scene.stats.chunksReordered, `frame ${index}: no chunk reordered`).toBe(0);
        expect(scene.stats.bytesStaged, `frame ${index}: ${scene.stats.bytesStaged} bytes staged`).toBeLessThanOrEqual(64 * KIB);
      }
      expect(sink.chunks, 'no chunk was sent').toEqual([]);
    },
  );

  it('a turn rebuilds 0 chunks and re-sends exactly the non-empty chunks, once, with their boxes x 32 bytes', () => {
    const session = devPark();
    const sink = new Sink();
    const scene = sceneFor(session, sink);
    frame(scene);
    const live = nonEmptyChunks(scene);
    const boxes = live.reduce((total, chunk) => total + scene.chunkBoxCount(chunk), 0);
    for (const rotation of [1, 2, 3, 0, 3, 1] as const) {
      sink.clear();
      scene.setView(frameOf(rotation, session));
      expect(scene.stats.chunksRebuilt).toBe(0);
      expect(scene.stats.chunksReordered).toBe(live.length);
      expect(sink.chunks.map((call) => call.index)).toEqual(live);
      expect(sink.chunks.reduce((total, call) => total + call.count, 0), 'the same boxes').toBe(boxes);
      expect(scene.stats.bytesStaged).toBe(live.reduce((total, chunk) => total + bytesOf(scene.chunkBoxCount(chunk)), 0));
      expect(sink.chunks.every((call) => call.bounds !== null)).toBe(true);
      // The next frame has nothing to do with it.
      frame(scene);
      expect(scene.stats.chunksReordered).toBe(0);
      expect(scene.stats.chunksRebuilt).toBe(0);
    }
    // The same view again costs nothing at all.
    sink.clear();
    scene.setView(frameOf(1, session));
    expect(sink.chunks).toEqual([]);
    expect(scene.stats.chunksReordered).toBe(0);
  });

  it('writes the transform revision once per change, never on a repeat or on frames', () => {
    const session = devPark();
    const scene = sceneFor(session, new Sink());
    const base = scene.view.revision;
    scene.setView(frameOf(2, session));
    expect(scene.view.revision).toBe(base + 1);
    scene.setView(frameOf(2, session));
    frame(scene);
    frame(scene);
    expect(scene.view.revision).toBe(base + 1);
  });

  for (const [name, content] of [['placeholder content', PLACEHOLDER_CONTENT], ['the content authored so far', REGISTRY_CONTENT]] as const) {
    it(`sorts every chunk front to back by the VIEW depth key and the ground last, in every view (${name})`, () => {
      const session = devPark();
      const scene = sceneFor(session, new Sink(), content);
      frame(scene);
      const world = staticWorldOf(scene);
      for (const rotation of [0, 1, 2, 3, 1, 0] as const) {
        scene.setView(frameOf(rotation, session));
        const t = scene.view;
        for (let chunk = 0; chunk < scene.chunkCount; chunk += 1) {
          const writer = world.chunkBoxes(chunk);
          let previousRank = -1;
          let previousKey = Number.POSITIVE_INFINITY;
          for (let box = 0; box < writer.count; box += 1) {
            const at = box * BOX_FLOATS;
            if (writer.data[at + 7] !== STATIC_SLOT) continue;
            const x0 = writer.data[at];
            const y0 = writer.data[at + 1];
            const x1 = x0 + writer.data[at + 4];
            const y1 = y0 + writer.data[at + 5];
            const z1 = writer.data[at + 2] + writer.data[at + 6];
            const a = voxelToView(t, x0, y0, { x: 0, y: 0 });
            const b = voxelToView(t, x1, y1, { x: 0, y: 0 });
            const key = Math.round(Math.max(a.x, b.x) + Math.max(a.y, b.y) + z1);
            const ground = ((writer.data[at + 3] >>> 8) & 255) === OUTLINE_GROUP_GROUND ? 1 : 0;
            expect(ground, `view ${rotation}, chunk ${chunk}, box ${box}: ground after everything else`).toBeGreaterThanOrEqual(previousRank);
            if (ground !== previousRank) previousKey = Number.POSITIVE_INFINITY;
            expect(key, `view ${rotation}, chunk ${chunk}, box ${box}: nearest first`).toBeLessThanOrEqual(previousKey);
            previousRank = ground;
            previousKey = key;
          }
        }
      }
    });

    it(`bounds hold every static box as seen in the view, exactly for chunks without moving volumes (${name})`, () => {
      const session = devPark();
      const scene = sceneFor(session, new Sink(), content);
      frame(scene);
      const world = staticWorldOf(scene);
      let exact = 0;
      for (const rotation of VIEW_ROTATIONS) {
        scene.setView(frameOf(rotation, session));
        const t = scene.view;
        for (let chunk = 0; chunk < scene.chunkCount; chunk += 1) {
          const bounds = world.chunkBounds(chunk);
          const writer = world.chunkBoxes(chunk);
          if (writer.count === 0) {
            expect(bounds).toBeNull();
            continue;
          }
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          let moving = false;
          for (let box = 0; box < writer.count; box += 1) {
            const at = box * BOX_FLOATS;
            if (writer.data[at + 7] !== STATIC_SLOT) {
              moving = true;
              continue;
            }
            const x0 = writer.data[at];
            const y0 = writer.data[at + 1];
            const z0 = writer.data[at + 2];
            const x1 = x0 + writer.data[at + 4];
            const y1 = y0 + writer.data[at + 5];
            const z1 = z0 + writer.data[at + 6];
            // All eight corners, projected through the view and then the 2:1 diamond.
            for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
              const p = voxelToView(t, x, y, { x: 0, y: 0 });
              for (const z of [z0, z1]) {
                minX = Math.min(minX, p.x - p.y);
                maxX = Math.max(maxX, p.x - p.y);
                minY = Math.min(minY, (p.x + p.y) / 2 - z);
                maxY = Math.max(maxY, (p.x + p.y) / 2 - z);
              }
            }
          }
          expect(bounds, `view ${rotation} chunk ${chunk}`).not.toBeNull();
          const b = bounds as TexelBounds;
          expect(b.minX).toBeLessThanOrEqual(minX);
          expect(b.maxX).toBeGreaterThanOrEqual(maxX);
          expect(b.minY).toBeLessThanOrEqual(minY);
          expect(b.maxY).toBeGreaterThanOrEqual(maxY);
          const sweeps = (world as unknown as { boundsStore: { sweeps: number[] }[] }).boundsStore[chunk].sweeps;
          if (!moving && sweeps.length === 0) {
            exact += 1;
            expect([b.minX, b.maxX, b.minY, b.maxY], `view ${rotation} chunk ${chunk}: exact`).toEqual([minX, maxX, minY, maxY]);
          }
        }
      }
      expect(exact, 'some chunks without moving volumes were checked exactly').toBeGreaterThan(0);
    });
  }

  it('turning back gives the identical chunk data (hashes) of view 0, through any route', () => {
    const session = devPark();
    const scene = sceneFor(session, new Sink());
    frame(scene);
    const first = hashes(scene);
    for (const rotation of [3, 1, 2, 3, 0] as const) scene.setView(frameOf(rotation, session));
    expect(hashes(scene)).toEqual(first);
  });

  it.each(VIEW_ROTATIONS.map((q) => [q] as const))(
    'incremental equals from scratch in view %i, through edits before and after the turn',
    (rotation) => {
      const session = devPark();
      session.world.addMoney(5_000_000, 'test');
      const scene = sceneFor(session, new Sink());
      session.world.subscribe(() => scene.syncWorld());
      frame(scene);
      const edit = (world: GameWorld, cell: Cell, definitionId: string, rotationOfBuild: Rotation): void => {
        world.seedScenarioObject(definitionId, cell, rotationOfBuild);
      };
      edit(session.world, { x: 25, y: 12 }, 'confetti-tree', 0);
      frame(scene);
      scene.setView(frameOf(rotation, session));
      edit(session.world, { x: 2, y: 3 }, 'lollipop-lamp', 1);
      session.world.buildPaths([{ x: 20, y: 28 }, { x: 21, y: 28 }]);
      frame(scene);
      scene.setView(frameOf(((rotation + 1) & 3) as ViewRotation, session));
      scene.setView(frameOf(rotation, session));
      frame(scene);
      const fresh = sceneFor(session, new Sink());
      fresh.setView(frameOf(rotation, session));
      fresh.update(16, 16, 0);
      expect(hashes(scene)).toEqual(hashes(fresh));
    },
  );

  it('an edit after a turn rebuilds exactly one chunk, sorted for the current view', () => {
    const session = devPark();
    const sink = new Sink();
    const scene = sceneFor(session, sink);
    session.world.subscribe(() => scene.syncWorld());
    frame(scene);
    scene.setView(frameOf(2, session));
    sink.clear();
    const cell: Cell = { x: 25, y: 12 };
    expect(session.world.buildObject('confetti-tree', cell)).not.toBeNull();
    frame(scene);
    expect(scene.stats.chunksRebuilt).toBe(1);
    expect(scene.stats.chunksReordered).toBe(0);
    expect(sink.chunks).toHaveLength(1);
    const fresh = sceneFor(session, new Sink());
    fresh.setView(frameOf(2, session));
    fresh.update(16, 16, 0);
    const chunk = sink.chunks[0].index;
    expect(scene.chunkHash(chunk)).toBe(fresh.chunkHash(chunk));
  });

  it('a chunk waiting for a rebuild is not reordered (the rebuild builds it for the new view)', () => {
    const session = devPark();
    const sink = new Sink();
    const scene = sceneFor(session, sink);
    session.world.subscribe(() => scene.syncWorld());
    frame(scene);
    session.world.buildObject('confetti-tree', { x: 25, y: 12 });
    scene.syncWorld();
    sink.clear();
    // The edit is not applied yet: update has not run.
    scene.setView(frameOf(1, session));
    expect(scene.stats.chunksReordered).toBeLessThan(nonEmptyChunks(scene).length + 1);
    frame(scene);
    const fresh = sceneFor(session, new Sink());
    fresh.setView(frameOf(1, session));
    fresh.update(16, 16, 0);
    expect(hashes(scene)).toEqual(hashes(fresh));
  });

  it('a session swap to another size follows the new map in the transform', () => {
    const session = devPark();
    const scene = sceneFor(session, new Sink());
    frame(scene);
    scene.setView(frameOf(1, session));
    expect(scene.view.ox).toBe(session.world.height * TILE);
    const other = new ParkSession(null);
    scene.setSession(other);
    scene.setView(createViewFrame(1, other.world.width, other.world.height));
    expect(scene.view.ox).toBe(other.world.height * TILE);
    frame(scene);
    expect(scene.stats.chunksRebuilt).toBeGreaterThan(0);
  });
});

describe('scene: the dynamic systems through the rotation maths', () => {
  const t = createViewTransform();
  const out: XY = { x: 0, y: 0 };

  it('the ghost keeps its WORLD rotation and origin; its footprint turns with the map exactly as rectToView says', () => {
    const session = devPark();
    const sink = new Sink();
    const scene = sceneFor(session, sink);
    const definition = BUILD_BY_ID.get('moonpetal-carousel')!;
    frame(scene);
    for (const buildRotation of [0, 1, 2, 3] as const) {
      scene.setPreview([{ x: 12, y: 5 }], definition, true, false, buildRotation);
      frame(scene);
      const ghost = sink.ghost as GhostState;
      expect(ghost).not.toBeNull();
      const world = { x: ghost.originX, y: ghost.originY, w: ghost.extentX, d: ghost.extentY };
      for (const rotation of VIEW_ROTATIONS) {
        const viewFrame = createViewFrame(rotation, session.world.width, session.world.height);
        scene.setView(viewFrame);
        setViewTransform(viewFrame, t);
        frame(scene);
        const turned = sink.ghost as GhostState;
        expect([turned.originX, turned.originY, turned.extentX, turned.extentY], 'the ghost data is world data in every view')
          .toEqual([world.x, world.y, world.w, world.d]);
        // The world footprint rect, through the voxel transform, is the view rect rectToView gives.
        const a = voxelToView(t, world.x, world.y, { x: 0, y: 0 });
        const b = voxelToView(t, world.x + world.w, world.y + world.d, { x: 0, y: 0 });
        const rect = rectToView(viewFrame, world.x / TILE, world.y / TILE, world.w / TILE, world.d / TILE, { x: 0, y: 0, width: 0, depth: 0 });
        expect([Math.min(a.x, b.x), Math.min(a.y, b.y)], `view ${rotation}: min corner`).toEqual([rect.x * TILE, rect.y * TILE]);
        expect([Math.abs(a.x - b.x), Math.abs(a.y - b.y)], `view ${rotation}: size`).toEqual([rect.width * TILE, rect.depth * TILE]);
      }
      scene.setView(createViewFrame(0, session.world.width, session.world.height));
    }
  });

  it('figures stay in world voxels; the heading a view reads equals the direction the guest walks in view space', () => {
    const session = devPark();
    session.guests.spawnGuests(120);
    for (let step = 0; step < 150; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    const sink = new Sink();
    const scene = sceneFor(session, sink);
    frame(scene, 0);
    const read = (): { x: number; y: number; heading: number }[] => {
      const records: { x: number; y: number; heading: number }[] = [];
      const data = sink.figures as Float32Array;
      for (let index = 0; index < sink.figureCount; index += 1) {
        const at = index * FIGURE_FLOATS;
        records.push({ x: data[at], y: data[at + 1], heading: data[at + 3] });
      }
      return records;
    };
    const before = read();
    // Only the guests walk on (Phase 29: with rides and stalls stepping too, a guest boarding or being served inside the
    // window hides a figure and shifts every record after it, which made the count a coin flip on any behaviour change).
    // No arrivals either (the weather owner is not stepped here, so the rate stays 0).
    session.weather.conditions.arrivalRate = 0;
    for (let step = 0; step < 4; step += 1) {
      session.world.advanceTick();
      session.guests.step(GAME_CONFIG.fixedStepMs);
    }
    frame(scene, 0.5);
    const after = read();
    expect(after.length).toBe(before.length);
    let walkers = 0;
    for (const rotation of VIEW_ROTATIONS) {
      const viewFrame = createViewFrame(rotation, session.world.width, session.world.height);
      setViewTransform(viewFrame, t);
      const turn = quarterTurnsOfTransform(t);
      expect(turn, 'the shader decodes the turn from (c, s)').toBe(rotation);
      for (let index = 0; index < before.length; index += 1) {
        const dx = after[index].x - before[index].x;
        const dy = after[index].y - before[index].y;
        if (Math.abs(dx) + Math.abs(dy) < 4 || Math.abs(dx) === Math.abs(dy)) continue;
        if (headingOf(dx, dy) !== after[index].heading) continue;
        walkers += 1;
        vectorToViewVoxel(t, dx, dy, out);
        expect(headingOf(out.x, out.y), `view ${rotation}: guest ${index} faces its walking direction in view space`)
          .toBe(headingInView(after[index].heading, rotation));
      }
    }
    expect(walkers, 'some guests walked').toBeGreaterThan(0);
  });

  it('coaster trains: every car, along the whole lap, stays inside its home chunk bounds in every view (no culling of a visible train)', () => {
    const session = devPark();
    const scene = sceneFor(session, new Sink());
    frame(scene);
    const world = staticWorldOf(scene);
    const trains = [...world.trains.values()];
    expect(trains.length, 'the dev park has a coaster').toBeGreaterThan(0);
    for (const rotation of VIEW_ROTATIONS) {
      const viewFrame = frameOf(rotation, session);
      scene.setView(viewFrame);
      const view = scene.view;
      for (const train of trains) {
        const bounds = world.chunkBounds(train.homeChunk) as TexelBounds;
        const poses = createCoasterCarPoses(train.carCount);
        const total = train.record.pieces.length;
        for (let head = 0; head < total * 4; head += 1) {
          placeCoasterCars(train.record, head / 4, train.carCount, poses);
          for (let car = 0; car < poses.count; car += 1) {
            const at = car * COASTER_CAR_POSE_FLOATS;
            const p = voxelToView(view, poses.data[at], poses.data[at + 1], { x: 0, y: 0 });
            const texelX = p.x - p.y;
            const texelY = (p.x + p.y) / 2 - poses.data[at + 2];
            expect(texelX, `view ${rotation} head ${head} car ${car}: x`).toBeGreaterThanOrEqual(bounds.minX);
            expect(texelX).toBeLessThanOrEqual(bounds.maxX);
            expect(texelY, `view ${rotation} head ${head} car ${car}: y`).toBeGreaterThanOrEqual(bounds.minY);
            expect(texelY).toBeLessThanOrEqual(bounds.maxY);
          }
        }
      }
    }
  });
});
