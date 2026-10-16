import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { COLOUR_SWATCHES, colourSlotsFor, ENTRANCE_COLOUR_ID, type ObjectColours } from '../../../game/content/colours';
import { COLOUR_PRESETS, presetRecord } from '../../../game/content/colourPresets';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { coasterBaseCost, deriveCoasterStats } from '../../../game/coaster/design';
import { longestLayout } from '../../../game/coaster/testLayouts';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { ParkSession } from '../../../game/session/ParkSession';
import { seedColourTestPark } from '../../../game/session/colourTestPark';
import type { BuildDefinition, Cell } from '../../../game/types';
import { createModelCache } from '../blueprint/compile';
import { BOX_FLOATS, unpackBoxWord } from '../contracts/boxes';
import type { DynamicTexture, GhostState, VoxelGpuSink } from '../contracts/frame';
import { chunkIndexOfCell } from '../contracts/space';
import { MAT, MATERIAL_FLAG_EMISSIVE, MATERIAL_FLAG_GLASS, MATERIAL_FLAG_NO_OUTLINE, MATERIAL_FLAG_SHADOW, MATERIAL_FLAG_WATER } from '../contracts/palette';
import { buildPalette } from '../palette';
import { createTransformTable } from './rigid';
import { REGISTRY_CONTENT, SceneModels, StaticWorld } from './staticWorld';
import { VoxelScene } from './VoxelScene';

/**
 * Phase 28 step 2, adversarial render review (not a builder test):
 * - the LONGEST coaster layout (64 pieces, the serpentine of coaster/testLayouts.ts) running in a full VoxelScene:
 *   every slot recolour rebuilds exactly its chunk set, once, in one frame; box counts equal a never-recoloured twin;
 *   steady frames rebuild and stage nothing the twin does not, and the train keeps the twin's pose;
 * - the ghost: validity flips and cursor moves with the same colour choice upload nothing (only uniforms move);
 *   alternating a bulldoze ghost of a recoloured object with a coloured build ghost of the same model never shows
 *   stale paint (the copy buffer is shared).
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));
const CACHE = createModelCache();

class Sink implements VoxelGpuSink {
  chunks: { index: number; count: number }[] = [];
  ghosts: (GhostState | null)[] = [];
  transforms: Float32Array | null = null;
  setChunk(index: number, _boxes: Float32Array, count: number): void {
    this.chunks.push({ index, count });
  }
  setDynamic(texture: DynamicTexture, data: Float32Array): void {
    if (texture === 'transforms') this.transforms = data;
  }
  setFigureRanges(): void {}
  setGhost(ghost: GhostState | null): void {
    this.ghosts.push(ghost === null ? null : { ...ghost });
  }
  setDraft(): void {}
  clear(): void {
    this.chunks = [];
    this.ghosts = [];
  }
}

interface Rig { session: ParkSession; scene: VoxelScene; sink: Sink; coasterId: number }

const serpentineRig = (): Rig => {
  const session = new ParkSession(null);
  const game = session.world;
  game.setBuildAccessPolicy(null);
  (game as unknown as { cash: number }).cash = 1e9;
  const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
  const pieces = longestLayout();
  expect(pieces.length).toBe(64);
  const placed = game.placeCoaster(type.definitionId, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
  if ('error' in placed) throw new Error(JSON.stringify(placed));
  session.syncWithWorld();
  const sink = new Sink();
  const scene = new VoxelScene(session, PALETTE, CACHE, { sink, content: REGISTRY_CONTENT, prewarmBudgetMs: 0, reportError: (message) => { throw new Error(message); } });
  game.subscribe(() => scene.syncWorld());
  const coasterId = [...game.coasters.keys()][0];
  session.rides.getRide(coasterId)!.status = 'running';
  return { session, scene, sink, coasterId };
};

let clock = 0;
let tick = 0;
const advance = (rigs: readonly Rig[]): void => {
  clock += 16;
  tick += 1;
  for (const { session, scene, coasterId } of rigs) {
    const runtime = session.rides.getRide(coasterId)!;
    const duration = session.world.coasters.get(coasterId)!.stats.durationSeconds;
    runtime.cycleRemainingSeconds = Math.max(0.2, duration - GAME_CONFIG.coaster.stationLoadSeconds - 0.05 * tick);
    scene.update(16, clock, (tick % 10) / 10);
  }
};
const hashes = (scene: VoxelScene): string[] => Array.from({ length: scene.chunkCount }, (_unused, chunk) => scene.chunkHash(chunk));
const counts = (scene: VoxelScene): number[] => Array.from({ length: scene.chunkCount }, (_unused, chunk) => scene.chunkBoxCount(chunk));
const poses = (sink: Sink): number[] => [...(sink.transforms ?? new Float32Array(0))];

describe('review: the 64-piece serpentine, recoloured while it runs', () => {
  it('each slot recolour rebuilds exactly its chunk set once, then nothing; counts and train poses equal a twin', () => {
    const painted = serpentineRig();
    const twin = serpentineRig();
    for (let index = 0; index < 6; index += 1) advance([painted, twin]);
    const record = painted.session.world.coasters.get(painted.coasterId)!;
    const set = [...new Set(record.pieces.map((piece) => chunkIndexOfCell(piece.cell.x, piece.cell.y, painted.session.world.width)))].sort((a, b) => a - b);
    expect(set.length, 'the longest layout spans several chunks').toBeGreaterThanOrEqual(4);
    const baseHashes = hashes(painted.scene);
    const baseCounts = counts(twin.scene);
    const slots = colourSlotsFor('skyline-serpent');
    const records: ObjectColours[] = [
      ...slots.map((_slot, index) => slots.map((_unused, at) => (at === index ? 0 : null))),
      slots.map(() => 13),
      [19, 6, 13, 0],
    ];
    for (const colours of records) {
      painted.sink.clear();
      expect(painted.session.world.setObjectColours(painted.coasterId, colours).ok).toBe(true);
      advance([painted, twin]);
      expect(painted.scene.stats.chunksRebuilt, `${JSON.stringify(colours)}: exactly the chunk set`).toBe(set.length);
      expect(painted.sink.chunks.map((chunk) => chunk.index).sort((a, b) => a - b), 'each chunk sent once').toEqual(set);
      expect(counts(painted.scene), 'box counts are the twin\'s').toEqual(baseCounts);
      expect(poses(painted.sink), 'the train keeps the twin\'s pose in the rebuild frame').toEqual(poses(twin.sink));
      hashes(painted.scene).forEach((hash, chunk) => {
        if (!set.includes(chunk)) expect(hash, `chunk ${chunk} outside the set`).toBe(baseHashes[chunk]);
      });
      painted.sink.clear();
      for (let index = 0; index < 12; index += 1) {
        advance([painted, twin]);
        expect(painted.scene.stats.chunksRebuilt, `steady frame ${index}`).toBe(0);
        expect(painted.scene.stats.bytesStaged, `steady frame ${index} stages what the twin stages`).toBe(twin.scene.stats.bytesStaged);
      }
      expect(painted.sink.chunks).toEqual([]);
      expect(poses(painted.sink)).toEqual(poses(twin.sink));
    }
    painted.session.world.clearObjectColours(painted.coasterId);
    advance([painted, twin]);
    expect(painted.scene.stats.chunksRebuilt).toBe(set.length);
    expect(hashes(painted.scene), 'a reset gives the twin\'s chunks back').toEqual(hashes(twin.scene));
  });
});

const definitionOf = (id: string): BuildDefinition => BUILD_BY_ID.get(id)!;
const cellsFor = (definition: BuildDefinition, x: number, y: number): Cell[] => {
  const cells: Cell[] = [];
  for (let dy = 0; dy < definition.footprint[1]; dy += 1) for (let dx = 0; dx < definition.footprint[0]; dx += 1) cells.push({ x: x + dx, y: y + dy });
  return cells;
};

const parkScene = () => {
  const session = new ParkSession(null);
  expect(seedColourTestPark(session).problems).toEqual([]);
  const sink = new Sink();
  const scene = new VoxelScene(session, PALETTE, CACHE, { sink, content: REGISTRY_CONTENT, prewarmBudgetMs: 0, reportError: (message) => { throw new Error(message); } });
  session.world.subscribe(() => scene.syncWorld());
  let time = 0;
  const frame = (): number => {
    time += 16;
    scene.update(16, time, 0);
    return scene.stats.bytesStaged;
  };
  frame();
  return { session, scene, sink, frame };
};

describe('review: ghost colour identity under validity flips and alternation', () => {
  it('a valid/invalid flip and cursor moves with the same colour choice upload nothing; the tint still follows validity', () => {
    const { scene, sink, frame } = parkScene();
    const definition = definitionOf('picnic-pocket');
    const record: ObjectColours = Object.freeze([0, 13]);
    scene.setPreview(cellsFor(definition, 4, 4), definition, true, false, 0, record);
    const firstBytes = frame();
    const idle = frame();
    expect(firstBytes, 'the first coloured ghost uploads its list').toBeGreaterThan(idle);
    const valid = sink.ghosts.at(-1)!;
    scene.setPreview(cellsFor(definition, 5, 4), definition, false, false, 0, [0, 13]);
    expect(frame(), 'invalid with an equal record: uniforms only (what an idle frame stages)').toBe(idle);
    const invalid = sink.ghosts.at(-1)!;
    expect(invalid.boxes).toBe(valid.boxes);
    expect(invalid.tint, 'validity still shows').not.toBe(valid.tint);
    expect(invalid.coverage).not.toBe(valid.coverage);
    scene.setPreview(cellsFor(definition, 6, 4), definition, true, false, 0, [0, 13]);
    expect(frame()).toBe(idle);
    expect(sink.ghosts.at(-1)!.boxes).toBe(valid.boxes);
  });

  it('alternating a bulldoze ghost of a recoloured stall with a differently coloured build ghost of the same model never shows stale paint', () => {
    const { session, scene, sink, frame } = parkScene();
    const world = session.world;
    const stall = [...world.objects.values()].find((object) => object.definitionId === 'picnic-pocket' && object.rotation === 0)
      ?? [...world.objects.values()].find((object) => object.definitionId === 'picnic-pocket')!;
    const definition = definitionOf('picnic-pocket');
    expect(world.setObjectColours(stall.id, [19, 6]).ok).toBe(true);
    frame();
    const materialsOf = (ghost: GhostState): number[] => Array.from({ length: ghost.boxCount }, (_unused, box) => unpackBoxWord(ghost.boxes[box * BOX_FLOATS + 3]).material);
    const teal = PALETTE.material(COLOUR_SWATCHES[19].rgb);
    const cherry = PALETTE.material(COLOUR_SWATCHES[0].rgb);
    const sequence: { bulldoze: boolean; expectMaterial: number }[] = [
      { bulldoze: true, expectMaterial: teal },
      { bulldoze: false, expectMaterial: cherry },
      { bulldoze: true, expectMaterial: teal },
      { bulldoze: false, expectMaterial: cherry },
    ];
    const seen: Float32Array[] = [];
    for (const step of sequence) {
      if (step.bulldoze) scene.setPreview([{ ...stall.anchor }], null, true, true, 0, null);
      else scene.setPreview(cellsFor(definition, 4, 4), definition, true, false, stall.rotation, [0, null]);
      frame();
      const ghost = sink.ghosts.at(-1)!;
      expect(ghost, 'a ghost is drawn').not.toBeNull();
      const materials = materialsOf(ghost);
      expect(materials.includes(step.expectMaterial), `${step.bulldoze ? 'bulldoze' : 'build'} ghost shows its own paint`).toBe(true);
      if (step.bulldoze) expect(materials.includes(cherry), 'no Cherry left over from the build ghost').toBe(false);
      else expect(materials.includes(teal), 'no Teal left over from the bulldoze ghost').toBe(false);
      seen.push(ghost.boxes);
    }
    // Every change of choice was a new identity (so the GPU re-uploaded): no two consecutive lists are the same.
    for (let index = 1; index < seen.length; index += 1) expect(seen[index]).not.toBe(seen[index - 1]);
  });
});

describe('review: lights, glow, chain, brake, stone and water never take paint (every coaster, the gate, the lamp, every preset)', () => {
  const FIXED = new Set<number>([MAT.FENCE_RAIL, MAT.CONCRETE, MAT.BULB, MAT.LAMP_GLOW, MAT.FENCE_POST, MAT.STONE, MAT.WINDOW_GLOW, MAT.GLASS, MAT.WATER]);
  const RECORDS: { name: string; record: (definitionId: string) => ObjectColours | null }[] = [
    ...[19, 13, 6, 4].map((swatch) => ({ name: `all ${COLOUR_SWATCHES[swatch].name}`, record: (definitionId: string) => colourSlotsFor(definitionId).map(() => swatch) })),
    ...COLOUR_PRESETS.map((preset) => ({ name: preset.id, record: (definitionId: string) => presetRecord(definitionId, preset.id) })),
  ];

  it('per box: a fixed material stays, and no box gains or loses a material flag (glow, glass, water, outline, shadow)', () => {
    const session = new ParkSession(null);
    expect(seedColourTestPark(session).problems).toEqual([]);
    const game = session.world;
    const models = new SceneModels(PALETTE, CACHE, REGISTRY_CONTENT, (message, error) => { throw new Error(`${message} ${String(error)}`); });
    const world = new StaticWorld({ width: game.width, height: game.height, models, transforms: createTransformTable() });
    world.sync(game);
    world.rebuildDirty(game);
    const snapshot = (): Float32Array[] => Array.from({ length: world.chunkCount }, (_unused, index) => {
      const writer = world.chunkBoxes(index);
      return writer.data.slice(0, writer.count * BOX_FLOATS);
    });
    const before = snapshot();
    const emissive = (material: number): number => PALETTE.flags(material) & (MATERIAL_FLAG_EMISSIVE | MATERIAL_FLAG_GLASS | MATERIAL_FLAG_WATER | MATERIAL_FLAG_NO_OUTLINE | MATERIAL_FLAG_SHADOW);
    let fixedSeen = 0;
    for (const { name, record } of RECORDS) {
      game.batch(() => {
        for (const object of game.objects.values()) {
          const colours = record(object.definitionId);
          if (colours && colourSlotsFor(object.definitionId).length > 0) game.setObjectColours(object.id, colours);
          else game.clearObjectColours(object.id);
        }
        const gate = record(ENTRANCE_COLOUR_ID);
        if (gate) game.setGateColours(gate); else game.clearGateColours();
      });
      world.sync(game);
      world.rebuildDirty(game);
      const after = snapshot();
      after.forEach((boxes, chunk) => {
        expect(boxes.length, `${name}: chunk ${chunk} box count`).toBe(before[chunk].length);
        for (let box = 0; box < boxes.length / BOX_FLOATS; box += 1) {
          const was = unpackBoxWord(before[chunk][box * BOX_FLOATS + 3]).material;
          const now = unpackBoxWord(boxes[box * BOX_FLOATS + 3]).material;
          if (FIXED.has(was)) {
            fixedSeen += 1;
            if (now !== was) throw new Error(`${name}: chunk ${chunk} box ${box}: fixed material ${was} repainted to ${now}`);
          }
          if (emissive(now) !== emissive(was)) throw new Error(`${name}: chunk ${chunk} box ${box}: material flags (emissive, glass, water, outline, shadow) moved (${was} -> ${now})`);
        }
      });
    }
    expect(fixedSeen, 'the probe saw the fixed parts').toBeGreaterThan(1000);
  });
});
