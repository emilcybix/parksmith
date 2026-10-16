import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../../game/config';
import { BIOME_IDS } from '../../../game/biomes/types';
import { DEFAULT_GENERATOR_OPTIONS, GENERATOR_VERSION, generateMap, PROP_BOX_WEIGHT } from '../../../game/maps/generator';
import type { GeneratedMap } from '../../../game/maps/generator';
import { propFootprintSize } from '../../../game/maps/parse';
import { PROP_KIND_BY_ID, PROP_KINDS } from '../../../game/maps/props';
import type { MapDensity, MapRecipe } from '../../../game/maps/types';
import { GROUND_ALT, GROUND_WATER } from '../../../game/maps/types';
import { buildFirstDayRoute } from '../../../game/onboarding/routeInFrame';
import { ParkSession } from '../../../game/session/ParkSession';
import { createModelCache } from '../blueprint/compile';
import { unpackBoxWord } from '../contracts/boxes';
import { PROP_MAP_BOX_BUDGET } from '../contracts/budgets';
import { OUTLINE_GROUP_GROUND, GHOST_TINT_BULLDOZE_REFUSED } from '../contracts/gbuffer';
import type { VoxelGpuSink } from '../contracts/frame';
import { chunkIndexOfCell, GROUND_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import { gamePalette } from '../gamePalette';
import { GhostPreview } from './ghost';
import { REGISTRY_CONTENT, SceneModels } from './staticWorld';
import { VoxelScene } from './VoxelScene';

/**
 * Phase 24 step 2 (voxel): generated maps through the real scene. The generator caps prop weight per chunk and per map
 * with game-side upper bounds (PROP_BOX_WEIGHT); this proves the bounds are honest, that the caps plus the scene's own
 * overhead (terrain, gate) stay inside PROP_MAP_BOX_BUDGET for 500 seeds per biome, that sampled maps build with no content
 * failure, cover every cell with one terrain top and rebuild nothing per frame with guests walking, and that the heaviest
 * generated map found (pinned below) stays inside the budgets.
 */

const palette = gamePalette();
const cache = createModelCache();
const TILE = VOXELS_PER_TILE;
const models = new SceneModels(palette, cache, REGISTRY_CONTENT, (message, error) => { throw new Error(`${message} ${String(error)}`); });

const recipe = (biomeId: MapRecipe['biomeId'], seed: number, density: MapDensity): MapRecipe => ({
  generatorVersion: GENERATOR_VERSION, biomeId, seed, density, water: DEFAULT_GENERATOR_OPTIONS.water,
});

class Sink implements VoxelGpuSink {
  chunks: number[] = [];
  setChunk(index: number): void { this.chunks.push(index); }
  setDynamic(): void { /* allowed */ }
  setFigureRanges(): void { /* not recorded */ }
  setGhost(): void { /* not recorded */ }
  setDraft(): void { /* not recorded */ }
}

const boxesOfKind = new Map<string, number>();
for (const kind of PROP_KINDS) {
  boxesOfKind.set(kind.id, Math.max(models.propModel(kind, 0).boxCount, models.propModel(kind, 1).boxCount));
}

const sessionOf = (map: GeneratedMap): ParkSession => new ParkSession(null, [], { layout: map.layout });

const rig = (session: ParkSession) => {
  const sink = new Sink();
  const errors: string[] = [];
  const scene = new VoxelScene(session, palette, cache, { sink, content: REGISTRY_CONTENT, prewarmBudgetMs: 0, reportError: (message) => errors.push(String(message)) });
  session.world.subscribe(() => scene.syncWorld());
  let clock = 0;
  const frame = (): void => { clock += 16; scene.update(16, clock, 0.5); };
  return { scene, sink, errors, frame };
};

const chunkBoxes = (scene: VoxelScene): number[] => Array.from({ length: scene.chunkCount }, (_u, chunk) => scene.chunkBoxCount(chunk));

/** Measured prop boxes per chunk of a layout (a prop counts in its home chunk, like the scene). */
const propBoxesPerChunk = (map: GeneratedMap): number[] => {
  const chunks = new Array<number>(16).fill(0);
  for (const prop of map.layout.props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind)!;
    const [w, d] = propFootprintSize(kind, prop.rotation);
    chunks[chunkIndexOfCell(Math.min(31, prop.x + w - 1), Math.min(31, prop.y + d - 1), 32)] += boxesOfKind.get(prop.kind)!;
  }
  return chunks;
};

describe('the Seaside refresh keeps the palette stable', () => {
  it('has 162 materials and only slots 131 and 132 (Seaside grass and sand) changed rgb against the step-1 palette', () => {
    expect(palette.count).toBe(162);
    expect(palette.baseColor(131)).toBe(0x5ed6a4);
    expect(palette.baseColor(132)).toBe(0xf8d384);
    expect(palette.material(0x5ed6a4)).toBe(131);
    expect(palette.material(0xf8d384)).toBe(132);
  });
});

describe('generated maps: box weights are honest', () => {
  it('every kind\'s measured boxes (worst quarter turn) are within its PROP_BOX_WEIGHT, and the two new Seaside kinds are small', () => {
    for (const kind of PROP_KINDS) expect(boxesOfKind.get(kind.id)!, kind.id).toBeLessThanOrEqual(PROP_BOX_WEIGHT[kind.id]);
    expect(boxesOfKind.get('tide-rock')!).toBeLessThanOrEqual(40);
    expect(boxesOfKind.get('boardwalk-pier')!).toBeLessThanOrEqual(40);
  });
});

describe('generated maps: budgets by construction', () => {
  it('500 seeds per biome at normal and high density: measured prop boxes plus the scene overhead stay inside PROP_MAP_BOX_BUDGET', () => {
    // Overhead (terrain, the gate, empty chunks) = scene boxes minus prop boxes, measured on real scenes, per chunk and per map.
    let overheadChunk = 0;
    let overheadMap = 0;
    for (const biomeId of BIOME_IDS) {
      for (const seed of [11, 4242, 987_654_321]) {
        const map = generateMap(recipe(biomeId, seed, 'normal'));
        const { scene, frame } = rig(sessionOf(map));
        frame();
        const props = propBoxesPerChunk(map);
        const boxes = chunkBoxes(scene);
        for (let chunk = 0; chunk < boxes.length; chunk += 1) overheadChunk = Math.max(overheadChunk, boxes[chunk] - props[chunk]);
        overheadMap = Math.max(overheadMap, boxes.reduce((a, b) => a + b, 0) - props.reduce((a, b) => a + b, 0));
      }
    }
    // The gate adds about 112 to its chunk; terrain of a mixed chunk a few boxes more.
    expect(overheadChunk, 'terrain and gate overhead per chunk').toBeLessThanOrEqual(200);
    let worstChunk = 0;
    let worstTotal = 0;
    let worstRecipe = '';
    for (const biomeId of BIOME_IDS) {
      for (const density of ['normal', 'high'] as const) {
        for (let seed = 1; seed <= 500; seed += 1) {
          const map = generateMap(recipe(biomeId, seed, density));
          const props = propBoxesPerChunk(map);
          const heaviest = Math.max(...props);
          const total = props.reduce((a, b) => a + b, 0);
          expect(heaviest + overheadChunk, `${biomeId} ${density} #${seed} heaviest chunk`).toBeLessThanOrEqual(PROP_MAP_BOX_BUDGET.heaviestChunk);
          expect(total + overheadMap, `${biomeId} ${density} #${seed} total`).toBeLessThanOrEqual(PROP_MAP_BOX_BUDGET.total);
          if (heaviest > worstChunk) { worstChunk = heaviest; worstRecipe = `${biomeId} ${density} #${seed}`; }
          worstTotal = Math.max(worstTotal, total);
        }
      }
    }
    expect(worstRecipe, 'the heaviest generated chunk is a Seaside map at high density (measured 1 424 prop boxes)').toMatch(/^seaside/);
    expect(worstChunk).toBeLessThanOrEqual(1_450);
    expect(worstTotal).toBeLessThanOrEqual(8_400);
  }, 240_000);

  it('30 seeds per biome through the real scene: no content failure, one terrain top per cell, total, heaviest chunk and a one-chunk rebuild within budget', () => {
    for (const biomeId of BIOME_IDS) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const density = (['low', 'normal', 'high'] as const)[seed % 3];
        const map = generateMap(recipe(biomeId, seed * 7919, density));
        const session = sessionOf(map);
        const { scene, errors, frame } = rig(session);
        frame();
        expect(errors, `${biomeId} #${seed}`).toEqual([]);
        const boxes = chunkBoxes(scene);
        expect(boxes.reduce((a, b) => a + b, 0), `${biomeId} #${seed} total`).toBeLessThanOrEqual(PROP_MAP_BOX_BUDGET.total);
        expect(Math.max(...boxes), `${biomeId} #${seed} heaviest chunk`).toBeLessThanOrEqual(PROP_MAP_BOX_BUDGET.heaviestChunk);
        // A one-chunk rebuild (what clearing a prop costs) stays quick.
        const heavy = boxes.indexOf(Math.max(...boxes));
        const samples: number[] = [];
        for (let run = 0; run < 5; run += 1) {
          (scene as unknown as { staticWorld: { dirty: Uint8Array } }).staticWorld.dirty[heavy] = 1;
          const start = performance.now();
          frame();
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        expect(samples[2], `${biomeId} #${seed} rebuild`).toBeLessThanOrEqual(PROP_MAP_BOX_BUDGET.rebuildMs * 2);
      }
    }
  }, 240_000);

  it('every terrain cell of a generated map has exactly one top of its own ground kind (a coast, a river and islets leave no hole or double)', () => {
    for (const biomeId of BIOME_IDS) {
      for (const seed of [3, 1234]) {
        const map = generateMap(recipe(biomeId, seed, 'normal'));
        const session = sessionOf(map);
        const { scene, frame } = rig(session);
        frame();
        const staticWorld = (scene as unknown as { staticWorld: { chunkBoxes(i: number): { count: number; data: Float32Array } } }).staticWorld;
        const cover = new Uint8Array(32 * 32);
        const wordAt = new Float64Array(32 * 32);
        for (let chunk = 0; chunk < scene.chunkCount; chunk += 1) {
          const { count, data } = staticWorld.chunkBoxes(chunk);
          for (let box = 0; box < count; box += 1) {
            const at = box * 8;
            const word = unpackBoxWord(data[at + 3]);
            if (word.group !== OUTLINE_GROUP_GROUND) continue;
            if (!(data[at + 2] === GROUND_TOP_Z - 1 && data[at + 6] === 1)) continue;
            for (let y = data[at + 1] / TILE; y < (data[at + 1] + data[at + 5]) / TILE; y += 1) {
              for (let x = data[at] / TILE; x < (data[at] + data[at + 4]) / TILE; x += 1) { cover[y * 32 + x] += 1; wordAt[y * 32 + x] = data[at + 3]; }
            }
          }
        }
        expect([...cover].filter((count) => count !== 1).length, `${biomeId} #${seed} cells covered 0 or 2+ times`).toBe(0);
        const ground = session.world.map.ground;
        const words = new Map<number, Set<number>>();
        for (let cell = 0; cell < 1024; cell += 1) (words.get(ground[cell]) ?? words.set(ground[cell], new Set()).get(ground[cell])!).add(wordAt[cell]);
        for (const [kind, set] of words) expect(set.size, `${biomeId} #${seed} ground kind ${kind}`).toBe(1);
        if (words.has(GROUND_WATER) && words.has(0)) expect([...words.get(GROUND_WATER)!][0]).not.toBe([...words.get(0)!][0]);
        if (words.has(GROUND_ALT) && words.has(0) && session.world.map.biome.ground.alt.rgb !== session.world.map.biome.ground.base.rgb) {
          expect([...words.get(GROUND_ALT)!][0]).not.toBe([...words.get(0)!][0]);
        }
      }
    }
  }, 60_000);
});

describe('generated maps: a running park rebuilds nothing', () => {
  it.each(BIOME_IDS.map((id) => [id] as const))('%s (high density): the First Day route, 300 guests walking, 12 frames: 0 chunks rebuilt and none sent', (biomeId) => {
    const map = generateMap(recipe(biomeId, 20_241_012, 'high'));
    const session = sessionOf(map);
    buildFirstDayRoute(session);
    session.guests.spawnGuests(300);
    for (let step = 0; step < 120; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    const { scene, sink, errors, frame } = rig(session);
    frame();
    frame();
    sink.chunks = [];
    for (let index = 0; index < 12; index += 1) {
      session.step(GAME_CONFIG.fixedStepMs);
      frame();
      expect(scene.stats.chunksRebuilt, `frame ${index}`).toBe(0);
    }
    expect(session.guests.guests.size).toBeGreaterThan(0);
    expect(sink.chunks).toEqual([]);
    expect(errors).toEqual([]);
  }, 30_000);
});

describe('the new Seaside kinds in the scene', () => {
  it('a pier stands on water at the ground top with its own model; the bulldozer refuses it (slate) and a tide rock is clearable (red)', () => {
    const session = new ParkSession(null, [], { mapId: 'seaside-cove' });
    const pier = [...session.world.props.values()].find((prop) => prop.kind === 'boardwalk-pier')!;
    const rock = [...session.world.props.values()].find((prop) => prop.kind === 'tide-rock')!;
    expect(pier, 'the refreshed Seaside Cove has a pier').toBeDefined();
    expect(rock, 'and tide rocks').toBeDefined();
    expect(session.world.map.ground[pier.y * session.world.width + pier.x], 'the pier stands on water').toBe(GROUND_WATER);
    const flat = models.propFlat(PROP_KIND_BY_ID.get('boardwalk-pier')!, 0);
    const ghost = new GhostPreview();
    ghost.set([{ x: pier.x, y: pier.y }], null, false, true, 0);
    const state = ghost.resolve(session.world, models)!;
    expect(state.boxCount).toBe(flat.boxCount);
    expect([state.originX, state.originY, state.originZ]).toEqual([pier.x * TILE, pier.y * TILE, GROUND_TOP_Z]);
    expect(state.tint).toBe(GHOST_TINT_BULLDOZE_REFUSED);
    expect(state.heightVoxels).toBeGreaterThan(0);
    const clearable = new GhostPreview();
    clearable.set([{ x: rock.x, y: rock.y }], null, true, true, 0);
    expect(clearable.resolve(session.world, models)!.boxCount).toBeGreaterThan(0);
  });
});
