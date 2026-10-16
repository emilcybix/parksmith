import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { COLOUR_SWATCHES, colourSlotsFor } from '../../../game/content/colours';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { seedDevPark } from '../../../game/session/devPark';
import { ParkSession } from '../../../game/session/ParkSession';
import type { BuildDefinition } from '../../../game/types';
import { createViewFrame, VIEW_ROTATIONS } from '../../viewRotation';
import type { ViewRotation } from '../../viewRotation';
import { createModelCache } from '../blueprint/compile';
import type { DynamicTexture, GhostState, TexelBounds, VoxelGpuSink } from '../contracts/frame';
import { TRANSFORM_FLOATS } from '../contracts/boxes';
import { buildPalette } from '../palette';
import { REGISTRY_CONTENT, SceneModels } from './staticWorld';
import { VoxelScene } from './VoxelScene';

/**
 * Phase 28 step 1, the frame loop: a recolour is one chunk rebuild and then nothing, also for a
 * RUNNING ride. Its moving parts live in the same chunk with their transform slots, so the rebuild
 * must not pop them to rest (they are posed in the same frame), must not touch the ghost of a
 * selected definition (defaults until step 2), and must compose with every view of the map.
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));
const CACHE = createModelCache();

class Sink implements VoxelGpuSink {
  chunks: { index: number; count: number; bounds: TexelBounds | null }[] = [];
  dynamics: { texture: DynamicTexture; rowStart: number; rowEnd: number }[] = [];
  ghosts: (GhostState | null)[] = [];
  transforms: Float32Array | null = null;
  setChunk(index: number, _boxes: Float32Array, count: number, bounds: TexelBounds | null): void {
    this.chunks.push({ index, count, bounds: bounds ? { ...bounds } : null });
  }
  setDynamic(texture: DynamicTexture, data: Float32Array, _count: number, rowStart: number, rowEnd: number): void {
    this.dynamics.push({ texture, rowStart, rowEnd });
    if (texture === 'transforms') this.transforms = data;
  }
  setFigureRanges(): void {}
  setGhost(ghost: GhostState | null): void { this.ghosts.push(ghost === null ? null : { ...ghost }); }
  setDraft(): void {}
  clear(): void {
    this.chunks = [];
    this.dynamics = [];
    this.ghosts = [];
  }
}

interface Rig {
  session: ParkSession;
  scene: VoxelScene;
  sink: Sink;
}

const rig = (session: ParkSession): Rig => {
  const sink = new Sink();
  const scene = new VoxelScene(session, PALETTE, CACHE, { sink, content: REGISTRY_CONTENT, prewarmBudgetMs: 0, reportError: (message) => { throw new Error(message); } });
  session.world.subscribe(() => scene.syncWorld());
  return { session, scene, sink };
};

/** A dev park with guests riding, so the rides run (their parts are away from rest). */
const runningPark = (): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  session.guests.spawnGuests(120);
  for (let step = 0; step < 300; step += 1) session.step(GAME_CONFIG.fixedStepMs);
  return session;
};

let clock = 0;
const advance = (rigs: readonly Rig[]): void => {
  clock += 16;
  for (const { session, scene } of rigs) {
    session.step(GAME_CONFIG.fixedStepMs);
    scene.update(16, clock, 0.5);
  }
};

const idOf = (session: ParkSession, definitionId: string): number => {
  const object = [...session.world.objects.values()].find((candidate) => candidate.definitionId === definitionId);
  if (!object) throw new Error(`the dev park has no ${definitionId}`);
  return object.id;
};

const hashes = (scene: VoxelScene): string[] => Array.from({ length: scene.chunkCount }, (_unused, chunk) => scene.chunkHash(chunk));
const poses = (sink: Sink): number[] => [...(sink.transforms ?? new Float32Array(0))];

describe('scene: recolouring a running ride (Phase 28)', () => {
  it.each(['aurora-wheel', 'moonpetal-carousel', 'harbor-swings', 'petal-roundabout'])(
    'rebuilds exactly the ride\'s home chunk once, poses its parts in that same frame, then rebuilds nothing (%s)',
    (definitionId) => {
      const recoloured = rig(runningPark());
      const untouched = rig(runningPark());
      for (let index = 0; index < 6; index += 1) advance([recoloured, untouched]);
      expect(poses(recoloured.sink), 'the two parks run identically before the recolour').toEqual(poses(untouched.sink));
      const objectId = idOf(recoloured.session, definitionId);
      const slots = colourSlotsFor(definitionId);
      const stillBefore = hashes(recoloured.scene);
      recoloured.sink.clear();
      untouched.sink.clear();
      expect(recoloured.session.world.setObjectColours(objectId, slots.map((_slot, index) => 19 - 6 * index)).ok).toBe(true);

      advance([recoloured, untouched]);
      expect(recoloured.scene.stats.chunksRebuilt, 'one chunk').toBe(1);
      expect(untouched.scene.stats.chunksRebuilt).toBe(0);
      expect(recoloured.sink.chunks, 'sent once').toHaveLength(1);
      const home = recoloured.sink.chunks[0].index;
      const after = hashes(recoloured.scene);
      after.forEach((hash, chunk) => {
        if (chunk === home) expect(hash, 'the home chunk changed').not.toBe(stillBefore[chunk]);
        else expect(hash, `chunk ${chunk} is untouched`).toBe(stillBefore[chunk]);
      });
      expect(recoloured.scene.chunkBoxCount(home), 'the same boxes').toBe(untouched.scene.chunkBoxCount(home));
      expect(poses(recoloured.sink), 'parts are in their driver poses in the rebuild frame, not at rest').toEqual(poses(untouched.sink));
      const moving = poses(recoloured.sink);
      let restPoses = 0;
      let totalPoses = 0;
      for (let slot = 0; slot * TRANSFORM_FLOATS < moving.length; slot += 1) {
        const at = slot * TRANSFORM_FLOATS;
        if (moving[at + 3] === 0 && moving[at + 4] === 0 && moving[at + 5] === 0 && moving[at + 6] === 0 && moving[at + 7] === 0) continue;
        totalPoses += 1;
        if (moving[at + 4] === 0 && moving[at + 5] === 0 && moving[at + 6] === 0 && moving[at + 7] === 1) restPoses += 1;
      }
      expect(totalPoses, 'transform slots in use').toBeGreaterThan(0);
      expect(restPoses, 'running rides turn: not every part is at rest').toBeLessThan(totalPoses);

      recoloured.sink.clear();
      for (let index = 0; index < 20; index += 1) {
        advance([recoloured, untouched]);
        expect(recoloured.scene.stats.chunksRebuilt, `steady frame ${index}`).toBe(0);
        expect(poses(recoloured.sink), `steady frame ${index}: motion identical to a never-recoloured park`).toEqual(poses(untouched.sink));
      }
      expect(recoloured.sink.chunks, 'no chunk staged in the steady frames').toEqual([]);
    },
  );

  it('rebuilds once for a reset and once for a repeat that changes nothing: zero', () => {
    const { session, scene, sink } = rig(runningPark());
    for (let index = 0; index < 3; index += 1) advance([{ session, scene, sink }]);
    const objectId = idOf(session, 'comet-cups');
    session.world.setObjectColours(objectId, [19, null]);
    advance([{ session, scene, sink }]);
    expect(scene.stats.chunksRebuilt).toBe(1);
    session.world.setObjectColours(objectId, [19, null]);
    advance([{ session, scene, sink }]);
    expect(scene.stats.chunksRebuilt, 'the same colours again').toBe(0);
    session.world.clearObjectColours(objectId);
    advance([{ session, scene, sink }]);
    expect(scene.stats.chunksRebuilt, 'reset').toBe(1);
    advance([{ session, scene, sink }]);
    expect(scene.stats.chunksRebuilt).toBe(0);
  });
});

describe('scene: recolour composes with the map view and the ghost (Phase 28)', () => {
  it.each(VIEW_ROTATIONS.map((rotation) => [rotation] as const))('in view %i a recolour equals a from-scratch scene in that view, and a later turn rebuilds nothing', (rotation) => {
    const live = rig(runningPark());
    live.scene.setView(createViewFrame(rotation as ViewRotation, live.session.world.width, live.session.world.height));
    advance([live]);
    const objectId = idOf(live.session, 'moonpetal-carousel');
    live.session.world.setObjectColours(objectId, [3, 13, 6]);
    advance([live]);
    expect(live.scene.stats.chunksRebuilt).toBe(1);

    const fresh = rig(live.session);
    fresh.scene.setView(createViewFrame(rotation as ViewRotation, live.session.world.width, live.session.world.height));
    advance([fresh]);
    expect(hashes(live.scene), 'chunk boxes, order and bounds equal a fresh build in the same view').toEqual(hashes(fresh.scene));

    // Turn the view: nothing rebuilds, and the result still equals a fresh build in the new view.
    const next = ((rotation + 1) % 4) as ViewRotation;
    live.scene.setView(createViewFrame(next, live.session.world.width, live.session.world.height));
    fresh.scene.setView(createViewFrame(next, live.session.world.width, live.session.world.height));
    expect(live.scene.stats.chunksRebuilt).toBe(0);
    advance([live, fresh]);
    expect(hashes(live.scene)).toEqual(hashes(fresh.scene));
  });

  it('leaves the ghost of a selected definition at its default colours and uploads it no more often', () => {
    const { session, scene, sink } = rig(new ParkSession(null));
    advance([{ session, scene, sink }]);
    const definition = BUILD_BY_ID.get('moonpetal-carousel') as BuildDefinition;
    const placed = session.world.seedScenarioObject('moonpetal-carousel', { x: 12, y: 12 });
    expect(placed).not.toBeNull();
    const cells = session.world.footprintCells(definition, { x: 4, y: 4 }, 0);
    scene.setPreview(cells, definition, true, false, 0);
    advance([{ session, scene, sink }]);
    const ghost = sink.ghosts.at(-1)!;
    const uploads = sink.ghosts.length;
    const models = new SceneModels(PALETTE, CACHE, REGISTRY_CONTENT, () => undefined);
    expect(ghost.boxes, 'the cached default model').toBe(models.objectFlat(definition, 0).boxes);
    session.world.setObjectColours(placed!.id, [0, 1, 2]);
    advance([{ session, scene, sink }]);
    scene.setPreview(cells, definition, true, false, 0);
    advance([{ session, scene, sink }]);
    expect(sink.ghosts, 'recolouring a placed ride sends the ghost nothing new').toHaveLength(uploads);
    expect(sink.ghosts.at(-1)!.boxes).toBe(models.objectFlat(definition, 0).boxes);
  });
});
