import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_CATALOG } from '../../../game/content/catalog';
import { COLOUR_SWATCHES, colourSlotsFor } from '../../../game/content/colours';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { ParkSession } from '../../../game/session/ParkSession';
import { seedColourTestPark } from '../../../game/session/colourTestPark';
import { createViewFrame, VIEW_ROTATIONS } from '../../viewRotation';
import type { ViewRotation } from '../../viewRotation';
import { createModelCache } from '../blueprint/compile';
import type { DynamicTexture, GhostState, VoxelGpuSink } from '../contracts/frame';
import { chunkIndexOfCell } from '../contracts/space';
import { buildPalette } from '../palette';
import { REGISTRY_CONTENT } from './staticWorld';
import { VoxelScene } from './VoxelScene';

/**
 * Phase 28 step 2, the frame loop: a recolour of any kind is one chunk rebuild (a coaster: exactly its chunk
 * set, once) and then nothing, also for a RUNNING coaster. Its train and riders are rigid parts of the same
 * chunk with their transform slots, so the rebuild must not pop them to rest, must send the GPU no more
 * dynamic data than an untouched twin, and must compose with every view of the map.
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));
const CACHE = createModelCache();

class Sink implements VoxelGpuSink {
  chunks: { index: number; count: number }[] = [];
  dynamics: { texture: DynamicTexture; rowStart: number; rowEnd: number }[] = [];
  ghosts: (GhostState | null)[] = [];
  transforms: Float32Array | null = null;
  setChunk(index: number, _boxes: Float32Array, count: number): void {
    this.chunks.push({ index, count });
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
  coasterIds: number[];
}

const rig = (): Rig => {
  const session = new ParkSession(null);
  expect(seedColourTestPark(session).problems).toEqual([]);
  const sink = new Sink();
  const scene = new VoxelScene(session, PALETTE, CACHE, { sink, content: REGISTRY_CONTENT, prewarmBudgetMs: 0, reportError: (message) => { throw new Error(message); } });
  session.world.subscribe(() => scene.syncWorld());
  const coasterIds = [...session.world.coasters.keys()];
  for (const id of coasterIds) session.rides.getRide(id)!.status = 'running';
  return { session, scene, sink, coasterIds };
};

let clock = 0;
let tick = 0;
/** One frame of every rig, with each coaster's cycle driven identically so twin parks run the same trains. */
const advance = (rigs: readonly Rig[]): void => {
  clock += 16;
  tick += 1;
  for (const { session, scene, coasterIds } of rigs) {
    for (const id of coasterIds) {
      const runtime = session.rides.getRide(id)!;
      const duration = session.world.coasters.get(id)!.stats.durationSeconds;
      runtime.cycleRemainingSeconds = Math.max(0.2, duration - GAME_CONFIG.coaster.stationLoadSeconds - 0.05 * tick);
    }
    scene.update(16, clock, (tick % 10) / 10);
  }
};

const hashes = (scene: VoxelScene): string[] => Array.from({ length: scene.chunkCount }, (_unused, chunk) => scene.chunkHash(chunk));
const poses = (sink: Sink): number[] => [...(sink.transforms ?? new Float32Array(0))];
const chunkSetOf = (session: ParkSession, objectId: number): number[] => (
  [...new Set(session.world.coasters.get(objectId)!.pieces.map((piece) => chunkIndexOfCell(piece.cell.x, piece.cell.y, session.world.width)))].sort((a, b) => a - b)
);
const idOf = (session: ParkSession, definitionId: string): number => {
  const object = [...session.world.objects.values()].find((candidate) => candidate.definitionId === definitionId);
  if (!object) throw new Error(`the colour test park has no ${definitionId}`);
  return object.id;
};

describe('scene: recolouring a running coaster (Phase 28 step 2)', () => {
  it.each(['star-chaser', 'comet-trail', 'skyline-serpent'])(
    'rebuilds exactly the %s chunk set once, poses the train in that same frame, then rebuilds nothing and stages no more than an untouched twin',
    (definitionId) => {
      const recoloured = rig();
      const untouched = rig();
      for (let index = 0; index < 8; index += 1) advance([recoloured, untouched]);
      expect(poses(recoloured.sink), 'the twins run identically before the recolour').toEqual(poses(untouched.sink));
      const objectId = idOf(recoloured.session, definitionId);
      const set = chunkSetOf(recoloured.session, objectId);
      expect(set.length).toBeGreaterThan(1);
      const stillBefore = hashes(recoloured.scene);
      recoloured.sink.clear();
      untouched.sink.clear();
      expect(recoloured.session.world.setObjectColours(objectId, [19, 6, 13, 0]).ok).toBe(true);

      advance([recoloured, untouched]);
      expect(recoloured.scene.stats.chunksRebuilt, 'exactly its chunk set').toBe(set.length);
      expect(untouched.scene.stats.chunksRebuilt).toBe(0);
      expect(recoloured.sink.chunks.map((chunk) => chunk.index).sort((a, b) => a - b), 'each chunk sent once').toEqual(set);
      const after = hashes(recoloured.scene);
      after.forEach((hash, chunk) => {
        if (set.includes(chunk)) expect(hash, `chunk ${chunk} of the set changed`).not.toBe(stillBefore[chunk]);
        else expect(hash, `chunk ${chunk} is untouched`).toBe(stillBefore[chunk]);
      });
      for (const chunk of set) expect(recoloured.scene.chunkBoxCount(chunk), 'the same boxes').toBe(untouched.scene.chunkBoxCount(chunk));
      expect(poses(recoloured.sink), 'the train is in its driver pose in the rebuild frame, not at rest').toEqual(poses(untouched.sink));

      recoloured.sink.clear();
      untouched.sink.clear();
      for (let index = 0; index < 30; index += 1) {
        advance([recoloured, untouched]);
        expect(recoloured.scene.stats.chunksRebuilt, `steady frame ${index}`).toBe(0);
        expect(recoloured.scene.stats.bytesStaged, `steady frame ${index}: stages what an untouched twin stages`).toBe(untouched.scene.stats.bytesStaged);
        expect(poses(recoloured.sink), `steady frame ${index}: the train moves exactly as in a never-recoloured park`).toEqual(poses(untouched.sink));
      }
      expect(recoloured.sink.chunks, 'no chunk staged in the steady frames').toEqual([]);
      expect(recoloured.sink.dynamics.map((entry) => entry.texture), 'the same dynamic uploads as the twin').toEqual(untouched.sink.dynamics.map((entry) => entry.texture));
    },
  );

  it('with every kind recoloured (coasters, stalls, comforts, scenery, the gate, rides) steady frames rebuild nothing and stage nothing a twin does not', () => {
    const recoloured = rig();
    const untouched = rig();
    for (let index = 0; index < 4; index += 1) advance([recoloured, untouched]);
    const world = recoloured.session.world;
    const edits = [...world.objects.values()].filter((object) => colourSlotsFor(object.definitionId).length > 0)
      .map((object) => ({ objectId: object.id, colours: colourSlotsFor(object.definitionId).map((_slot, index) => (index * 5 + 2) % 21) }));
    const batch = world.recolourBatch([...edits, { gate: true, colours: [3, 13, 6] }]);
    expect(batch.changedCount).toBeGreaterThan(40);
    advance([recoloured, untouched]);
    expect(recoloured.scene.stats.chunksRebuilt, 'every chunk that holds something colourable, once').toBeGreaterThan(5);
    expect(poses(recoloured.sink)).toEqual(poses(untouched.sink));
    recoloured.sink.clear();
    for (let index = 0; index < 40; index += 1) {
      advance([recoloured, untouched]);
      expect(recoloured.scene.stats.chunksRebuilt, `steady frame ${index}`).toBe(0);
      expect(recoloured.scene.stats.bytesStaged).toBe(untouched.scene.stats.bytesStaged);
      expect(poses(recoloured.sink)).toEqual(poses(untouched.sink));
    }
    expect(recoloured.sink.chunks).toEqual([]);
    // Resetting every record rebuilds once and gives the untouched park's chunks back.
    world.applyPresetToPark('candy');
    advance([recoloured, untouched]);
    expect(hashes(recoloured.scene)).toEqual(hashes(untouched.scene));
    advance([recoloured, untouched]);
    expect(recoloured.scene.stats.chunksRebuilt).toBe(0);
  });

  it('a whole-park preset rebuilds each chunk once in one frame and a repeat of it rebuilds nothing', () => {
    const park = rig();
    const { session, scene, sink } = park;
    const twin = rig();
    for (let index = 0; index < 3; index += 1) advance([park, twin]);
    sink.clear();
    session.world.applyPresetToPark('midnight');
    advance([park, twin]);
    const rebuilt = scene.stats.chunksRebuilt;
    expect(rebuilt).toBeGreaterThan(5);
    expect(sink.chunks.length, 'one send per rebuilt chunk').toBe(rebuilt);
    expect(new Set(sink.chunks.map((chunk) => chunk.index)).size, 'no chunk twice').toBe(rebuilt);
    expect(session.world.applyPresetToPark('midnight').changedCount, 'the same preset again changes nothing').toBe(0);
    advance([park, twin]);
    expect(scene.stats.chunksRebuilt).toBe(0);
  });
});

describe('scene: recolour of the new kinds composes with the map view (Phase 28 step 2)', () => {
  it.each(VIEW_ROTATIONS.map((rotation) => [rotation] as const))('in view %i a recolour of a coaster and the gate equals a from-scratch scene, and a later turn rebuilds nothing', (rotation) => {
    const live = rig();
    live.scene.setView(createViewFrame(rotation as ViewRotation, live.session.world.width, live.session.world.height));
    advance([live]);
    live.session.world.setObjectColours(idOf(live.session, 'star-chaser'), [3, 13, 6, 0]);
    live.session.world.setObjectColours(idOf(live.session, 'picnic-pocket'), [19, 6]);
    live.session.world.setGateColours([null, 6, 13]);
    advance([live]);
    expect(live.scene.stats.chunksRebuilt).toBeGreaterThan(1);

    const fresher = rig();
    fresher.session.restoreState(live.session.serialize());
    fresher.session.syncWithWorld();
    fresher.scene.setSession(fresher.session);
    fresher.scene.setView(createViewFrame(rotation as ViewRotation, live.session.world.width, live.session.world.height));
    advance([fresher]);
    expect(hashes(live.scene), 'chunk boxes, order and bounds equal a fresh build in the same view').toEqual(hashes(fresher.scene));

    const next = ((rotation + 1) % 4) as ViewRotation;
    live.scene.setView(createViewFrame(next, live.session.world.width, live.session.world.height));
    fresher.scene.setView(createViewFrame(next, live.session.world.width, live.session.world.height));
    expect(live.scene.stats.chunksRebuilt).toBe(0);
    advance([live, fresher]);
    expect(hashes(live.scene)).toEqual(hashes(fresher.scene));
  });
});
