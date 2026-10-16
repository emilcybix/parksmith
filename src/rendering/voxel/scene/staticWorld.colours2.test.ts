import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 40: these pins are of the renderer (or of the park it draws), frozen before buildings had fronts; with front-only
 * access on, the dev park's stalls turn toward their paths and draw differently. The renderer is not what moved, so the
 * pins run with the rule off (the turn itself is pinned in game/frontAccess.test.ts).
 */
vi.mock('../../../game/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../game/config')>();
  return { ...actual, GAME_CONFIG: { ...actual.GAME_CONFIG, access: { ...actual.GAME_CONFIG.access, frontOnly: false } } };
});
import { BUILD_BY_ID, BUILD_CATALOG, PHASE29_DEFINITION_IDS, PHASE39_DEFINITION_IDS } from '../../../game/content/catalog';
import { coasterBaseCost, deriveCoasterStats } from '../../../game/coaster/design';
import { layoutFromMoves, ovalLayout } from '../../../game/coaster/testLayouts';
import {
  COLOUR_SWATCHES,
  COLOURABLE_DEFINITION_IDS,
  colourKindOf,
  colourSlotsFor,
  ENTRANCE_COLOUR_ID,
  type ColourKind,
} from '../../../game/content/colours';
import { COLOUR_PRESETS } from '../../../game/content/colourPresets';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { ParkSession } from '../../../game/session/ParkSession';
import { PROFILE_GATED_IDS } from '../../../game/profile/unlocks';
import { seedColourTestPark } from '../../../game/session/colourTestPark';
import { createModelCache } from '../blueprint/compile';
import chunkFixture from '../content/__fixtures__/extended-park-chunks-pre-step2.json';
import { BOX_FLOATS, unpackBoxWord } from '../contracts/boxes';
import { chunkIndexOfCell, visualQuarterTurn } from '../contracts/space';
import { buildPalette } from '../palette';
import { createTransformTable } from './rigid';
import { REGISTRY_CONTENT, SceneModels, StaticWorld } from './staticWorld';

/**
 * Phase 28 step 2: a recolour of ANY colourable kind is a data change of that object. Pinned on the extended
 * colour test park (the dev park plus a Comet Trail across the x = 8 chunk border, a Skyline Serpent across
 * x = 24 and a Ripple Fountain; game/session/colourTestPark.ts) with the real content:
 * - nothing moves for defaults: every chunk hashes to what it hashed before step 2 (a frozen fixture);
 * - per kind x slot x swatch: the object's chunk(s) rebuild once, box counts never change, extents, order,
 *   outline groups, patterns and transform slots stay, and only the material byte of that slot's boxes moves;
 * - a coaster rebuilds EXACTLY the chunks its pieces touch (its train and riders live in the station chunk,
 *   which is in the set), each once, and nothing else is dirty;
 * - the gate rebuilds the entrance chunk only; a whole-park preset rebuilds each chunk that holds something
 *   colourable once, and Candy (or a clear) gives the default hashes back.
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));
const CACHE = createModelCache();
/** Teal, Cream and Ink: three different swatches, none the default of more than a handful of slots. */
const SWATCHES = [19, 6, 13] as const;
/** The colourable Phase 16 entries: 3 rides, 2 stalls and 7 themed scenery pieces. */
const PHASE16_COLOURABLE_IDS: readonly string[] = [
  'puddle-jumpers', 'rocket-pendulum', 'temple-trek', 'pretzel-pram', 'coconut-cove',
  'bunting-mast', 'shell-planter', 'harbor-lighthouse', 'tiki-torch', 'jungle-idol', 'neon-pylon', 'orbit-globe',
];

/**
 * `gated: true` (the default) adds the profile-gated colourable entries (Phase 22: Tiki Tumbler, Cactus Cooler, Cocoa Chalet)
 * and the Phase 16 entries to the park in free cells, so every colourable kind has an object to recolour. The identity test uses `gated: false`:
 * the park whose chunk hashes the fixture froze before step 2.
 */
const setup = (options: { gated?: boolean } = {}) => {
  const gated = options.gated ?? true;
  const session = new ParkSession(null, [], gated ? { grant: { unlockedBuildingIds: PROFILE_GATED_IDS, bonusIds: [] } } : {});
  const report = seedColourTestPark(session);
  expect(report.problems, 'the colour test park seeds cleanly').toEqual([]);
  const game = session.world;
  if (gated) {
    game.addMoney(1_000_000);
    for (const id of PROFILE_GATED_IDS.filter((candidate) => colourSlotsFor(candidate).length > 0)) {
      const free = (() => {
        for (let y = 0; y < game.height; y += 1) {
          for (let x = 0; x < game.width; x += 1) if (game.checkObjectBuild(id, { x, y }, 0).ok) return { x, y };
        }
        return null;
      })();
      expect(free, `a free cell for ${id}`).not.toBeNull();
      expect(game.buildObject(id, free!), `${id} is placed`).not.toBeNull();
    }
    // Phase 16: its colourable entries are not in the colour test park; seed one of each (locks and cost bypassed).
    const present = new Set([...game.objects.values()].map((object) => object.definitionId));
    // Phase 29: its stalls are not in the colour test park either.
    for (const id of [...PHASE16_COLOURABLE_IDS, ...PHASE29_DEFINITION_IDS].filter((candidate) => !present.has(candidate))) {
      let placed = false;
      for (let y = 0; y < game.height && !placed; y += 1) {
        for (let x = 0; x < game.width && !placed; x += 1) placed = game.seedScenarioObject(id, { x, y }, 0) !== null;
      }
      expect(placed, `${id} is placed`).toBe(true);
    }
    // Phase 39: one oval of each new coaster family where it fits (research lock lifted for the placement only).
    game.setBuildAccessPolicy(null);
    for (const id of PHASE39_DEFINITION_IDS) {
      const type = COASTER_TYPE_BY_ID.get(id)!;
      let placed = false;
      for (let y = 0; y + 5 <= game.height && !placed; y += 1) {
        for (let x = 0; x + 9 <= game.width && !placed; x += 1) {
          // The launch coaster takes a compact 6 x 2 loop: the colour park has no 9 x 5 space left after the other two.
          // It must still cross a chunk edge (the recolour test below checks several chunks rebuild).
          if (type.family === 'launch' && Math.floor(x / 8) === Math.floor((x + 5) / 8) && Math.floor(y / 8) === Math.floor((y + 1) / 8)) continue;
          const pieces = type.family === 'launch'
            ? layoutFromMoves({ x, y }, 'EEEEESWWWWWN', [0, 0, 0, 1, 2, 2, 1, 0, 0, 0, 0, 0], { 3: 'launch' })
            : ovalLayout({ x, y });
          const result = game.placeCoaster(id, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
          placed = !('error' in result);
          if ('error' in result && result.error !== 'blocked') throw new Error(`${id}: ${result.error}`);
        }
      }
      expect(placed, `${id} is placed`).toBe(true);
    }
  }
  const transforms = createTransformTable();
  const models = new SceneModels(PALETTE, CACHE, REGISTRY_CONTENT, (message, error) => { throw new Error(`${message} ${String(error)}`); });
  const world = new StaticWorld({ width: game.width, height: game.height, models, transforms });
  world.sync(game);
  world.rebuildDirty(game);
  const hashes = (): string[] => Array.from({ length: world.chunkCount }, (_unused, index) => world.chunkHash(index));
  const counts = (): number[] => Array.from({ length: world.chunkCount }, (_unused, index) => world.chunkBoxes(index).count);
  const rebuild = (): number => {
    world.sync(game);
    return world.rebuildDirty(game);
  };
  /** Rebuilds what is dirty and returns the indices of the chunks it rebuilt, in order. */
  const rebuildReport = (): number[] => {
    const count = rebuild();
    return Array.from(world.rebuiltChunks.slice(0, count));
  };
  return { session, game, world, models, transforms, hashes, counts, rebuild, rebuildReport };
};
type Rig = ReturnType<typeof setup>;

const copyChunk = (world: StaticWorld, index: number): Float32Array => {
  const writer = world.chunkBoxes(index);
  return writer.data.slice(0, writer.count * BOX_FLOATS);
};

const copyAll = (rig: Rig): Float32Array[] => Array.from({ length: rig.world.chunkCount }, (_unused, index) => copyChunk(rig.world, index));

/** The first placed object of each colourable definition in the park. */
const objectsByDefinition = (rig: Rig): Map<string, number> => {
  const found = new Map<string, number>();
  for (const object of rig.game.objects.values()) if (!found.has(object.definitionId)) found.set(object.definitionId, object.id);
  return found;
};

/** Per tag, the boxes of an object's model at its turn (a non-coaster) or of its cars (a coaster). */
const modelTagCounts = (rig: Rig, objectId: number): number[] => {
  const object = rig.game.objects.get(objectId)!;
  const definition = BUILD_BY_ID.get(object.definitionId)!;
  const counts = new Array<number>(8).fill(0);
  if (definition.custom === 'coaster') {
    const cars = COASTER_TYPE_BY_ID.get(definition.id)?.trainCars ?? 0;
    for (let car = 0; car < cars; car += 1) {
      const tags = rig.models.carFlat(definition, car).tags;
      for (let box = 0; box < rig.models.carFlat(definition, car).boxCount; box += 1) counts[tags ? tags[box] : 0] += 1;
    }
    return counts;
  }
  for (const part of rig.models.objectModel(definition, visualQuarterTurn(object.rotation)).parts) {
    for (let box = 0; box < part.boxCount; box += 1) counts[part.boxes[box * BOX_FLOATS + 7]] += 1;
  }
  return counts;
};

/** How many boxes between two chunk copies differ, and a fail message for any field that may not. */
const diffChunks = (before: Float32Array, after: Float32Array, name: string): number => {
  expect(after.length, `${name}: a recolour never changes a box count`).toBe(before.length);
  let changed = 0;
  for (let box = 0; box < before.length / BOX_FLOATS; box += 1) {
    const at = box * BOX_FLOATS;
    for (const field of [0, 1, 2, 4, 5, 6, 7]) {
      if (after[at + field] !== before[at + field]) throw new Error(`${name} box ${box} field ${field}: ${before[at + field]} -> ${after[at + field]}`);
    }
    const was = unpackBoxWord(before[at + 3]);
    const now = unpackBoxWord(after[at + 3]);
    expect([now.group, now.pattern, now.quarterTurn], `${name}: group, pattern and turn are the box`).toEqual([was.group, was.pattern, was.quarterTurn]);
    if (now.material !== was.material) changed += 1;
  }
  return changed;
};

const swatchMaterial = (swatch: number): number => PALETTE.material(COLOUR_SWATCHES[swatch].rgb);

/** A record that paints only slot `slotIndex` with `swatch`. */
const onlySlot = (slots: number, slotIndex: number, swatch: number): (number | null)[] => Array.from({ length: slots }, (_unused, index) => (index === slotIndex ? swatch : null));

describe('recolour of every colourable kind in the static world (Phase 28 step 2)', () => {
  it('draws every default exactly as before step 2 (extended park, REGISTRY content)', () => {
    const { world, hashes, counts, game } = setup({ gated: false });
    expect(world.chunkCount).toBe(chunkFixture.chunkCount);
    expect(counts()).toEqual(chunkFixture.boxes);
    expect(counts().reduce((sum, count) => sum + count, 0)).toBe(chunkFixture.totalBoxes);
    expect(hashes()).toEqual(chunkFixture.hashes);
    for (const coaster of chunkFixture.coasters) {
      const record = [...game.coasters.values()].find((candidate) => game.objects.get(candidate.objectId)?.definitionId === coaster.definitionId)!;
      const set = [...new Set(record.pieces.map((piece) => chunkIndexOfCell(piece.cell.x, piece.cell.y, game.width)))].sort((a, b) => a - b);
      expect(set, `${coaster.definitionId}: chunk set`).toEqual(coaster.chunks);
    }
  });

  it('has an object of every colourable kind to recolour', () => {
    const rig = setup();
    const found = objectsByDefinition(rig);
    const kinds = new Set<ColourKind>();
    for (const id of COLOURABLE_DEFINITION_IDS) {
      expect(found.has(id), `the park has a ${id}`).toBe(true);
      kinds.add(colourKindOf(id)!);
    }
    expect([...kinds].sort()).toEqual(['coaster', 'comfort', 'ride', 'scenery', 'stall']);
  });

  const NON_COASTER = COLOURABLE_DEFINITION_IDS.filter((id) => colourKindOf(id) !== 'coaster');
  it.each(NON_COASTER)('%s: every slot x 3 swatches rebuilds only its home chunk once and repaints only that slot\'s boxes', (id) => {
    const rig = setup();
    const objectId = objectsByDefinition(rig).get(id)!;
    const home = rig.world.placements.get(objectId)!.homeChunk;
    const slots = colourSlotsFor(id);
    const tagCounts = modelTagCounts(rig, objectId);
    const before = copyChunk(rig.world, home);
    const baseHashes = rig.hashes();
    const baseCounts = rig.counts();
    const transformKeys = (): string[] => [...rig.world.placements.values()].flatMap((placement) => placement.parts.map((part) => `${placement.objectId}:${part.partId}:${part.slot}`)).sort();
    const slotsBefore = transformKeys();
    slots.forEach((slot, slotIndex) => {
      for (const swatch of SWATCHES) {
        expect(rig.game.setObjectColours(objectId, onlySlot(slots.length, slotIndex, swatch)).ok).toBe(true);
        rig.world.sync(rig.game);
        expect(rig.world.dirtyCount, `${id}/${slot.id}: one chunk dirty`).toBe(1);
        expect(rig.world.rebuildDirty(rig.game)).toBe(1);
        expect(rig.world.rebuiltChunks[0]).toBe(home);
        expect(rig.counts(), 'box counts of every chunk are unchanged').toEqual(baseCounts);
        const changed = diffChunks(before, copyChunk(rig.world, home), `${id}/${slot.id}/${swatch}`);
        const expected = swatchMaterial(swatch) === PALETTE.material(slot.defaultRgb) ? 0 : tagCounts[slot.tag];
        expect(changed, `${id}/${slot.id}/${swatch}: exactly the slot's boxes change material`).toBe(expected);
        if (expected > 0) expect(rig.hashes()[home]).not.toBe(baseHashes[home]);
        rig.hashes().forEach((hash, chunk) => {
          if (chunk !== home) expect(hash, `chunk ${chunk} untouched`).toBe(baseHashes[chunk]);
        });
        expect(transformKeys(), 'transform slots stay').toEqual(slotsBefore);
      }
    });
    // Every slot at once, then a reset: the default chunk is back, byte for byte.
    expect(rig.game.setObjectColours(objectId, slots.map(() => 19)).ok).toBe(true);
    expect(rig.rebuild()).toBe(1);
    rig.game.clearObjectColours(objectId);
    expect(rig.rebuild()).toBe(1);
    expect(rig.hashes()).toEqual(baseHashes);
    expect(copyChunk(rig.world, home)).toEqual(before);
  });

  const COASTERS = COLOURABLE_DEFINITION_IDS.filter((id) => colourKindOf(id) === 'coaster');
  it.each(COASTERS)('%s: a recolour rebuilds exactly the chunks its pieces touch, once each, and repaints only its slot\'s boxes', (id) => {
    const rig = setup();
    const objectId = objectsByDefinition(rig).get(id)!;
    const record = rig.game.coasters.get(objectId)!;
    const set = [...new Set(record.pieces.map((piece) => chunkIndexOfCell(piece.cell.x, piece.cell.y, rig.game.width)))].sort((a, b) => a - b);
    expect(set.length, 'a coaster spans several chunks').toBeGreaterThan(1);
    const slots = colourSlotsFor(id);
    const baseHashes = rig.hashes();
    const baseCounts = rig.counts();
    const before = copyAll(rig);
    slots.forEach((slot, slotIndex) => {
      for (const swatch of SWATCHES) {
        expect(rig.game.setObjectColours(objectId, onlySlot(slots.length, slotIndex, swatch)).ok).toBe(true);
        rig.world.sync(rig.game);
        const dirty = Array.from({ length: rig.world.chunkCount }, (_unused, chunk) => chunk).filter((chunk) => rig.world.dirty[chunk] === 1);
        expect(dirty, `${id}/${slot.id}: exactly the coaster's chunk set is dirty`).toEqual(set);
        expect(rig.world.rebuildDirty(rig.game), 'each rebuilt once').toBe(set.length);
        expect(Array.from(rig.world.rebuiltChunks.slice(0, set.length)), 'in index order, no repeats').toEqual(set);
        expect(rig.counts(), 'box counts unchanged').toEqual(baseCounts);
        let changed = 0;
        copyAll(rig).forEach((after, chunk) => {
          const diff = diffChunks(before[chunk], after, `${id}/${slot.id}/${swatch} chunk ${chunk}`);
          if (!set.includes(chunk)) expect(diff, `chunk ${chunk} outside the set`).toBe(0);
          changed += diff;
        });
        // Every box that moved is the slot's: the train's tagged boxes plus the track words the slot names.
        const trainBoxes = modelTagCounts(rig, objectId)[slot.tag];
        if (slot.id === 'primary' || slot.id === 'secondary') expect(changed, `${id}/${slot.id}`).toBeGreaterThanOrEqual(swatchMaterial(swatch) === PALETTE.material(slot.defaultRgb) ? 0 : trainBoxes);
        else expect(changed, `${id}/${slot.id}: track words change`).toBeGreaterThan(0);
        if (slot.id === 'secondary') expect(changed, 'seats are on the cars only').toBe(swatchMaterial(swatch) === PALETTE.material(slot.defaultRgb) ? 0 : trainBoxes);
      }
    });
    rig.game.setObjectColours(objectId, slots.map(() => 19));
    expect(rig.rebuild()).toBe(set.length);
    rig.game.clearObjectColours(objectId);
    expect(rig.rebuild()).toBe(set.length);
    expect(rig.hashes(), 'a reset gives the default chunks back').toEqual(baseHashes);
    // Nothing else is dirty and a repeat rebuilds nothing.
    expect(rig.rebuild()).toBe(0);
  });

  it('a recoloured coaster keeps its train: transform slots stay and the riders keep their guests\' colours', () => {
    const rig = setup();
    const objectId = objectsByDefinition(rig).get('star-chaser')!;
    const keys = (): string[] => {
      const out: string[] = [];
      for (let slot = 1; slot < 4096; slot += 1) {
        const key = rig.transforms.keyOfSlot(slot);
        if (key && key.objectId === objectId) out.push(`${slot}:${key.partKey}`);
      }
      return out;
    };
    const before = keys();
    expect(before.length, 'cars, riders and couplings hold slots').toBeGreaterThan(10);
    rig.game.setObjectColours(objectId, [19, 6, 13, 0]);
    rig.rebuild();
    expect(keys()).toEqual(before);
  });

  it('the gate: only the entrance chunk rebuilds, once, and only the gate\'s three slots repaint', () => {
    const rig = setup();
    const entranceChunk = chunkIndexOfCell(rig.game.entrance.x, rig.game.entrance.y, rig.game.width);
    expect(entranceChunk).toBe(13);
    const baseHashes = rig.hashes();
    const baseCounts = rig.counts();
    const before = copyChunk(rig.world, entranceChunk);
    const flat = rig.models.entranceFlat();
    const tagCounts = new Array<number>(8).fill(0);
    for (let box = 0; box < flat.boxCount; box += 1) tagCounts[flat.tags![box]] += 1;
    expect(tagCounts.slice(1, 4)).toEqual([22, 43, 4]);
    const slots = colourSlotsFor(ENTRANCE_COLOUR_ID);
    slots.forEach((slot, slotIndex) => {
      for (const swatch of SWATCHES) {
        expect(rig.game.setGateColours(onlySlot(slots.length, slotIndex, swatch)).ok).toBe(true);
        rig.world.sync(rig.game);
        expect(rig.world.dirtyCount, `gate/${slot.id}`).toBe(1);
        expect(rig.world.dirty[entranceChunk]).toBe(1);
        expect(rig.world.rebuildDirty(rig.game)).toBe(1);
        expect(rig.counts()).toEqual(baseCounts);
        const changed = diffChunks(before, copyChunk(rig.world, entranceChunk), `gate/${slot.id}/${swatch}`);
        expect(changed).toBe(swatchMaterial(swatch) === PALETTE.material(slot.defaultRgb) ? 0 : tagCounts[slot.tag]);
        rig.hashes().forEach((hash, chunk) => {
          if (chunk !== entranceChunk) expect(hash).toBe(baseHashes[chunk]);
        });
      }
    });
    rig.game.clearGateColours();
    expect(rig.rebuild()).toBe(1);
    expect(rig.hashes()).toEqual(baseHashes);
    expect(rig.rebuild(), 'a repeat or an equal record rebuilds nothing').toBe(0);
    rig.game.setGateColours([19, null, null]);
    expect(rig.rebuild()).toBe(1);
    rig.game.setGateColours([19, null, null]);
    expect(rig.rebuild()).toBe(0);
  });

  it('a gate record that is a different object with the same values (a restore) rebuilds nothing', () => {
    const rig = setup();
    rig.game.setGateColours([5, 6, 7]);
    expect(rig.rebuild()).toBe(1);
    rig.session.syncWithWorld();
    rig.session.restoreState(rig.session.serialize());
    rig.session.syncWithWorld();
    expect(rig.session.world.gateColours).toEqual([5, 6, 7]);
    expect(rig.rebuild()).toBe(0);
  });

  it.each(COLOUR_PRESETS.map((preset) => [preset.id] as const))('the %s preset on the whole park rebuilds each chunk with something colourable once, then Candy restores the defaults', (presetId) => {
    const rig = setup();
    const baseHashes = rig.hashes();
    const baseCounts = rig.counts();
    // The chunks that hold something colourable: homes, coaster sets and the entrance chunk.
    const expected = new Set<number>([chunkIndexOfCell(rig.game.entrance.x, rig.game.entrance.y, rig.game.width)]);
    for (const object of rig.game.objects.values()) {
      if (colourSlotsFor(object.definitionId).length === 0) continue;
      const coaster = rig.game.coasters.get(object.id);
      if (coaster) for (const piece of coaster.pieces) expected.add(chunkIndexOfCell(piece.cell.x, piece.cell.y, rig.game.width));
      else expected.add(rig.world.placements.get(object.id)!.homeChunk);
    }
    const result = rig.game.applyPresetToPark(presetId);
    const rebuilt = rig.rebuildReport();
    if (presetId === 'candy') {
      expect(result.changedCount, 'Candy is today\'s defaults: nothing changes').toBe(0);
      expect(rebuilt).toEqual([]);
      return;
    }
    expect(result.changedCount).toBeGreaterThan(40);
    expect(rebuilt, 'each chunk with a colourable object, once').toEqual([...expected].sort((a, b) => a - b));
    expect(rig.counts(), 'box counts unchanged').toEqual(baseCounts);
    expect(rig.hashes()).not.toEqual(baseHashes);
    rig.game.applyPresetToPark('candy');
    expect(rig.rebuildReport()).toEqual([...expected].sort((a, b) => a - b));
    expect(rig.hashes(), 'Candy gives every default chunk back').toEqual(baseHashes);
    expect(rig.rebuild()).toBe(0);
  });

  it('an unknown or all-default record repaints nothing: tables are null and the chunk is the default', () => {
    const rig = setup();
    const scratch = new Uint8Array(8);
    expect(rig.models.slotTable('star-chaser', null, scratch)).toBeNull();
    expect(rig.models.slotTable('star-chaser', [null, null, null, null], scratch)).toBeNull();
    expect(rig.models.slotTable('picnic-pocket', [99, null], scratch), 'a swatch the palette lacks').toBeNull();
    expect(rig.models.slotTable('confetti-tree', [3, 3], scratch), 'trees have no slots').toBeNull();
    const table = rig.models.slotTable('star-chaser', [19, null, 6, 13], scratch)!;
    expect([table[1], table[2], table[3], table[4]]).toEqual([swatchMaterial(19), 0, swatchMaterial(6), swatchMaterial(13)]);
  });
});
