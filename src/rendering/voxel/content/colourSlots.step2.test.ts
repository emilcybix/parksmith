import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG, PHASE29_DEFINITION_IDS } from '../../../game/content/catalog';
import {
  COLOUR_SLOT_TAG,
  COLOUR_SLOTS,
  COLOUR_SWATCHES,
  COLOURABLE_DEFINITION_IDS,
  colourKindOf,
  colourSlotsFor,
  ENTRANCE_COLOUR_ID,
  RIDE_COLOUR_SLOTS,
} from '../../../game/content/colours';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import type { CoasterPiece } from '../../../game/coaster/design';
import { GAME_CONFIG } from '../../../game/config';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { longestLayout } from '../../../game/coaster/testLayouts';
import { seedDevPark } from '../../../game/session/devPark';
import { ParkSession } from '../../../game/session/ParkSession';
import type { BuildDefinition } from '../../../game/types';
import { compileBlueprint, flattenAtRest, rotateModel } from '../blueprint/compile';
import type { CompiledModel } from '../contracts/blueprint';
import { BOX_FLOATS, BoxWriter, unpackBoxWord } from '../contracts/boxes';
import { MAT } from '../contracts/palette';
import { buildPalette } from '../palette';
import fixture from './__fixtures__/objects-boxes-pre-step2.json';
import { coasterContent, paintedMaterial } from './coaster';
import { voxelPaintedSlots } from './colourSlotProbe';
import { contentFor, entranceBlueprint } from './registry';

/**
 * Phase 28 step 2, voxel content: every newly colourable kind (shops, facilities, bench, bin, lamp, flowers,
 * fountain, the three coasters' cars and track, the entrance gate) tags the shapes of its colour slots, and
 * tagging changes NOTHING a player sees until a swatch is chosen.
 *
 * - Compiled identity: fields 0-6 of every box of every model, car, rider, coupling and every track piece
 *   hash to what the code produced BEFORE step 2 (`__fixtures__/objects-boxes-pre-step2.json`, captured from
 *   the unchanged compiler; scratch phase28/baseline2). Tags live in field 7 and do not take part.
 * - Census: how many boxes each slot owns per model is pinned; a tag sits only on the slot's default material;
 *   no box of a tagged slot's default material is left untagged; every declared slot of a model-tagged kind is
 *   tagged, and nothing is tagged that the slot table does not declare.
 * - Track (procedural, no tags): the per-tag paint table changes materials only, never a box, and only the boxes
 *   of the slot it names; fixed words (chain, brake, chevrons, bulbs, stone, posts, footings) never move.
 * - The slot tables agree with the art: every slot's default is a plain palette material, and its tag is its
 *   position in the table, for the flat rides too (step 1's COLOUR_SLOT_TAG is pinned against it).
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));

const definitionOf = (id: string): BuildDefinition => {
  const definition = BUILD_BY_ID.get(id);
  if (!definition) throw new Error(`no catalog entry ${id}`);
  return definition;
};

const COASTER_IDS = ['comet-trail', 'star-chaser', 'skyline-serpent'] as const;
/** Everything colourable that a compiled model carries tags for: not the flat rides (step 1), not the coaster track. */
const OBJECT_IDS = COLOURABLE_DEFINITION_IDS.filter((id) => {
  const kind = colourKindOf(id);
  return kind === 'stall' || kind === 'comfort' || kind === 'scenery';
});

const sha16 = async (data: Float32Array, count: number): Promise<string> => {
  const geometry = new Float32Array(count * 7);
  for (let box = 0; box < count; box += 1) for (let field = 0; field < 7; field += 1) geometry[box * 7 + field] = data[box * BOX_FLOATS + field];
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', geometry));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const partsSha = (model: CompiledModel): Promise<string[]> =>
  Promise.all(model.parts.map(async (part) => `${part.id}:${part.boxCount}:${await sha16(part.boxes, part.boxCount)}`));

const modelOf = (id: string): CompiledModel => compileBlueprint(contentFor(id).blueprint(definitionOf(id), PALETTE));
const gateModel = (): CompiledModel => compileBlueprint(entranceBlueprint(PALETTE));

interface Tagged {
  boxes: Float32Array;
  count: number;
  tags: Uint8Array | null;
}

const taggedOf = (model: CompiledModel): Tagged => {
  const flat = flattenAtRest(model);
  return { boxes: flat.boxes, count: flat.boxCount, tags: flat.tags };
};

/** Boxes per tag (index = tag), and the set of materials each tag sits on. */
const census = (tagged: Tagged): { counts: number[]; materials: Map<number, Set<number>> } => {
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  const materials = new Map<number, Set<number>>();
  for (let box = 0; box < tagged.count; box += 1) {
    const tag = tagged.tags ? tagged.tags[box] : 0;
    counts[tag] += 1;
    if (tag === 0) continue;
    const set = materials.get(tag) ?? new Set<number>();
    set.add(unpackBoxWord(tagged.boxes[box * BOX_FLOATS + 3]).material);
    materials.set(tag, set);
  }
  return { counts, materials };
};

/** Tagged boxes per slot (primary, secondary, ...) at quarter turn 0, pinned. */
const OBJECT_CENSUS: Readonly<Record<string, readonly number[]>> = {
  'picnic-pocket': [44, 52],
  'fizz-foundry': [47, 52],
  'glacier-scoop': [44, 52],
  'lemon-light': [47, 52],
  'waffle-windmill': [44, 52],
  'snack-sprint': [36, 36],
  // Phase 22 (profile-gated); their fixture entries were captured when the stalls were added.
  'cactus-cooler': [39, 36],
  'cocoa-chalet': [44, 52],
  'comfort-cabin': [51, 59],
  'comfort-pavilion': [62, 75],
  'ribbon-bench': [2, 1],
  'tidy-totem': [2, 6],
  'lollipop-lamp': [2, 1],
  'sunburst-flowers': [30, 21],
  'ripple-fountain': [115],
  // Phase 16: their fixture entries were captured when they were added (the themed scenery from themedScenery.ts).
  'pretzel-pram': [36, 36],
  'coconut-cove': [47, 52],
  'bunting-mast': [30, 18],
  'shell-planter': [160, 63],
  'harbor-lighthouse': [119, 102],
  'tiki-torch': [12],
  'jungle-idol': [5, 6],
  'neon-pylon': [4, 14],
  'orbit-globe': [215, 146],
  // Phase 29: pinned when the souvenir stalls and the warm drink barrow were added.
  'brolly-booth': [44, 37],
  'hat-hutch': [39, 36],
  'balloon-bouquet': [45, 37],
  'plushie-parlour': [44, 52],
  'glow-cart': [36, 37],
  'bean-barrow': [39, 36],
};
const GATE_CENSUS = [22, 43, 4];
/** Per car of each coaster type: [primary, secondary, total boxes]. */
const CAR_CENSUS: Readonly<Record<string, readonly (readonly [number, number, number])[]>> = {
  'comet-trail': [[10, 10, 37], [5, 7, 27], [5, 7, 27], [5, 7, 27]],
  'star-chaser': [[15, 17, 45], [5, 16, 32], [5, 16, 32], [5, 16, 32], [5, 16, 32]],
  'skyline-serpent': [[18, 10, 46], [10, 10, 31], [10, 10, 31], [10, 10, 31], [10, 10, 31], [13, 11, 35]],
};

describe('slot tables and the art agree', () => {
  it('every colourable definition has a plain palette material for every slot default, tags are positions', () => {
    for (const [id, slots] of Object.entries(COLOUR_SLOTS)) {
      slots.forEach((slot, index) => {
        expect(slot.tag, `${id}/${slot.id}`).toBe(index + 1);
        const material = PALETTE.material(slot.defaultRgb);
        expect(PALETTE.baseColor(material), `${id}/${slot.id}`).toBe(slot.defaultRgb);
        expect(PALETTE.flags(material), `${id}/${slot.id}: slot materials never glow, shimmer or turn to glass`).toBe(0);
      });
    }
  });

  it('the flat rides keep step 1 tags (primary 1, secondary 2, trim 3)', () => {
    for (const [id, slots] of Object.entries(RIDE_COLOUR_SLOTS)) {
      for (const slot of slots) expect(COLOUR_SLOT_TAG[slot.id], `${id}/${slot.id}`).toBe(slot.tag);
    }
  });

  it('the voxel art repaints exactly the slots each table declares, for every colourable id (rides, coasters, stalls, comforts, scenery, the gate)', () => {
    for (const [id, slots] of Object.entries(COLOUR_SLOTS)) {
      expect(voxelPaintedSlots(id), id).toEqual(slots.map((slot) => slot.id));
    }
  });

  it('covers every colourable kind: rides (step 1), coasters, stalls, comforts, scenery and the gate', () => {
    expect(colourSlotsFor(ENTRANCE_COLOUR_ID).map((slot) => slot.id)).toEqual(['primary', 'secondary', 'trim']);
    expect(OBJECT_IDS.slice().sort()).toEqual(Object.keys(OBJECT_CENSUS).sort());
    expect([...COASTER_IDS].sort()).toEqual(COLOURABLE_DEFINITION_IDS.filter((id) => colourKindOf(id) === 'coaster').sort());
  });
});

describe('compiled identity: tagging changes no box', () => {
  // Phase 29's stalls came after step 2: they have no "before" to be identical to.
  it.each(OBJECT_IDS.filter((id) => !PHASE29_DEFINITION_IDS.includes(id)))('%s compiles to the boxes it compiled to before step 2, at both quarter turns and flat', async (id) => {
    const q0 = modelOf(id);
    const q1 = rotateModel(q0, 1);
    const expected = (fixture.objects as Record<string, { q0: string[]; q1: string[]; flat: string[]; lights: number }>)[id];
    expect(await partsSha(q0), `${id} q0`).toEqual(expected.q0);
    expect(await partsSha(q1), `${id} q1`).toEqual(expected.q1);
    const flat0 = flattenAtRest(q0);
    const flat1 = flattenAtRest(q1);
    expect([`${flat0.boxCount}:${await sha16(flat0.boxes, flat0.boxCount)}`, `${flat1.boxCount}:${await sha16(flat1.boxes, flat1.boxCount)}`], `${id} flat`).toEqual(expected.flat);
    expect(q0.lights.length).toBe(expected.lights);
    for (let box = 0; box < flat0.boxCount; box += 1) expect(flat0.boxes[box * BOX_FLOATS + 7], 'a flat list is static: slot 0').toBe(0);
  });

  it('the entrance gate compiles to the boxes it compiled to before step 2', async () => {
    const model = gateModel();
    expect(await partsSha(model)).toEqual(fixture.entrance.q0);
    const flat = flattenAtRest(model);
    expect(`${flat.boxCount}:${await sha16(flat.boxes, flat.boxCount)}`).toBe(fixture.entrance.flat);
    expect(model.lights.length).toBe(fixture.entrance.lights);
  });

  it.each(COASTER_IDS)('%s cars, riders and couplings compile to the boxes they compiled to before step 2', async (id) => {
    const definition = definitionOf(id);
    const expected = (fixture.cars as Record<string, Record<string, string | number>>)[id];
    const cars = COASTER_TYPE_BY_ID.get(id)?.trainCars ?? 0;
    expect(cars).toBe(expected.carCount);
    for (let car = 0; car < cars; car += 1) {
      const flat = flattenAtRest(compileBlueprint(coasterContent.carBlueprint(definition, car, PALETTE)));
      expect(`${flat.boxCount}:${await sha16(flat.boxes, flat.boxCount)}`, `${id} car ${car}`).toBe(expected[`car${car}`]);
      const riders = flattenAtRest(compileBlueprint(coasterContent.riderBlueprint(definition, car, PALETTE)));
      expect(`${riders.boxCount}:${await sha16(riders.boxes, riders.boxCount)}`, `${id} riders ${car}`).toBe(expected[`rider${car}`]);
      expect(riders.tags, 'riders are guests: never tagged').toBeNull();
    }
    const coupling = flattenAtRest(compileBlueprint(coasterContent.couplingBlueprint(definition, PALETTE)));
    expect(`${coupling.boxCount}:${await sha16(coupling.boxes, coupling.boxCount)}`).toBe(expected.coupling);
    expect(coupling.tags, 'the coupling is fixed').toBeNull();
  });
});

describe('tag census: each slot owns exactly its parts, on its default material', () => {
  const check = (name: string, id: string, tagged: Tagged, expectedCounts: readonly number[]): void => {
    const slots = colourSlotsFor(id);
    const { counts, materials } = census(tagged);
    slots.forEach((slot, index) => {
      if (index >= expectedCounts.length) return;
      expect(counts[slot.tag], `${name}/${slot.id}`).toBe(expectedCounts[index]);
      expect([...(materials.get(slot.tag) ?? [])], `${name}/${slot.id}: one material, the slot default`).toEqual([PALETTE.material(slot.defaultRgb)]);
    });
    for (let tag = 1; tag < counts.length; tag += 1) {
      if (tag > expectedCounts.length) expect(counts[tag], `${name}: tag ${tag} is not a tagged slot of this model`).toBe(0);
    }
    // Nothing of a tagged slot's default material is left untagged: a stray box would not follow its slot.
    const tagMaterials = new Set(slots.slice(0, expectedCounts.length).map((slot) => PALETTE.material(slot.defaultRgb)));
    for (let box = 0; box < tagged.count; box += 1) {
      const tag = tagged.tags ? tagged.tags[box] : 0;
      if (tag !== 0) continue;
      const material = unpackBoxWord(tagged.boxes[box * BOX_FLOATS + 3]).material;
      expect(tagMaterials.has(material), `${name}: box ${box} has a slot default material but no tag`).toBe(false);
    }
  };

  it.each(OBJECT_IDS)('%s', (id) => check(id, id, taggedOf(modelOf(id)), OBJECT_CENSUS[id]));

  it('the gate: arch and lantern housings, sign board, posts and plinths', () => {
    check('gate', ENTRANCE_COLOUR_ID, taggedOf(gateModel()), GATE_CENSUS);
  });

  it.each(COASTER_IDS)('%s cars: train (primary) and seats (secondary) only', (id) => {
    const definition = definitionOf(id);
    CAR_CENSUS[id].forEach(([primary, secondary, total], car) => {
      const flat = flattenAtRest(compileBlueprint(coasterContent.carBlueprint(definition, car, PALETTE)));
      expect(flat.boxCount, `${id} car ${car}`).toBe(total);
      check(`${id} car ${car}`, id, { boxes: flat.boxes, count: flat.boxCount, tags: flat.tags }, [primary, secondary]);
    });
  });

  it('never tags steel, wood, glass, bulbs, glow, water, stone or riders', () => {
    const fixedMaterials = new Set<number>([MAT.STEEL, MAT.STEEL_LIGHT, MAT.WOOD, MAT.TIMBER, MAT.CONCRETE, MAT.STONE, MAT.WATER, MAT.GLASS, MAT.WINDOW_GLOW, MAT.BULB, MAT.LAMP_GLOW, MAT.WHITE, MAT.INK, MAT.SKIN_1, MAT.SKIN_2, MAT.SKIN_3, MAT.SKIN_4, MAT.HAIR_BLOND, MAT.HAIR_BROWN, MAT.HAIR_DARK, MAT.TRAIN]);
    const models: [string, Tagged][] = [['gate', taggedOf(gateModel())], ...OBJECT_IDS.map((id): [string, Tagged] => [id, taggedOf(modelOf(id))])];
    for (const id of COASTER_IDS) models.push([`${id} car`, taggedOf(compileBlueprint(coasterContent.carBlueprint(definitionOf(id), 0, PALETTE)))]);
    for (const [name, tagged] of models) {
      for (let box = 0; box < tagged.count; box += 1) {
        if (!tagged.tags || tagged.tags[box] === 0) continue;
        const material = unpackBoxWord(tagged.boxes[box * BOX_FLOATS + 3]).material;
        expect(fixedMaterials.has(material), `${name}: a tagged box on fixed material ${material}`).toBe(false);
      }
    }
  });

  it('a definition without a slot gets an untagged model (the tagger never invents a slot)', () => {
    const unknown: BuildDefinition = { ...definitionOf('picnic-pocket'), id: 'mystery-stall' };
    expect(colourSlotsFor(unknown.id)).toHaveLength(0);
    const flat = flattenAtRest(compileBlueprint(contentFor('picnic-pocket').blueprint(unknown, PALETTE)));
    expect(flat.tags).toBeNull();
    const car = flattenAtRest(compileBlueprint(coasterContent.carBlueprint({ ...definitionOf('star-chaser'), id: 'mystery-coaster' }, 0, PALETTE)));
    expect(car.tags).toBeNull();
  });
});

// ---- Track -----------------------------------------------------------------------------------------

const walk = (start: { x: number; y: number }, moves: string, heights: readonly number[], specials: Readonly<Record<number, CoasterPiece['special']>> = {}): CoasterPiece[] => {
  const pieces: CoasterPiece[] = [];
  let x = start.x;
  let y = start.y;
  for (let index = 0; index < moves.length; index += 1) {
    const special = specials[index];
    pieces.push({ cell: { x, y }, height: heights[index] ?? 0, ...(special ? { special } : {}) });
    const move = moves[index];
    if (move === 'E') x += 1; else if (move === 'W') x -= 1; else if (move === 'S') y += 1; else y -= 1;
  }
  return pieces;
};

const devPieces = (): readonly CoasterPiece[] => {
  const session = new ParkSession(null);
  seedDevPark(session);
  const [record] = session.world.coasters.values();
  return record.pieces;
};

const LAYOUTS: readonly { name: string; definitionId: string; pieces: () => readonly CoasterPiece[] }[] = [
  ...COASTER_IDS.map((id) => ({ name: `dev park as ${id}`, definitionId: id, pieces: devPieces })),
  { name: 'longest serpentine', definitionId: 'skyline-serpent', pieces: longestLayout },
  { name: 'turns and hills', definitionId: 'comet-trail', pieces: () => walk({ x: 2, y: 4 }, 'EEENENEESSSWWWWWWN', [0, 0, 0, 1, 2, 2, 2, 1, 1, 2, 2, 2, 1, 1, 0, 0, 0, 0]) },
  { name: 'summit, loop and ramped boost', definitionId: 'skyline-serpent', pieces: () => walk({ x: 2, y: 6 }, 'EEEEEEENNNWWWWWWWSSS', [0, 0, 0, 1, 2, 3, 4, 4, 4, 3, 2, 2, 2, 1, 1, 0, 0, 0, 0, 0], { 5: 'boost', 11: 'loop' }) },
  { name: 'loop after a drop', definitionId: 'star-chaser', pieces: () => walk({ x: 2, y: 5 }, 'EEEEEENNWWWWWWSS', [0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 2, 2, 1, 0, 0, 0], { 10: 'loop' }) },
  { name: 'station turning in from the far side', definitionId: 'comet-trail', pieces: () => walk({ x: 3, y: 8 }, 'NNEESSSWWWNE', [0, 0, 0, 1, 2, 2, 2, 1, 1, 1, 1, 0]) },
  { name: 'station turning off at both ends', definitionId: 'star-chaser', pieces: () => walk({ x: 3, y: 5 }, 'EENNNWWWSSES', [0, 0, 0, 1, 2, 2, 2, 2, 1, 1, 0, 0]) },
];

const MASK_MATERIAL = 255;

/** The boxes of every piece of a layout, one list per piece. */
const trackOf = (definition: BuildDefinition, pieces: readonly CoasterPiece[], paint: Uint8Array | null): Float32Array[] => {
  const lists: Float32Array[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const writer = new BoxWriter(256);
    coasterContent.pieceBoxes(pieces, index, definition, PALETTE, 7, writer, paint);
    lists.push(writer.data.slice(0, writer.count * BOX_FLOATS));
  }
  return lists;
};

const tableOf = (entries: Readonly<Record<number, number>>): Uint8Array => {
  const table = new Uint8Array(8);
  for (const [tag, swatch] of Object.entries(entries)) table[Number(tag)] = PALETTE.material(COLOUR_SWATCHES[swatch].rgb);
  return table;
};

describe('track: the paint table changes materials, never boxes', () => {
  it.each(LAYOUTS.map((layout) => [layout.name, layout] as const))('%s: default pieces hash to the pre-step-2 track, and any paint keeps every box', { timeout: 60_000 }, async (name, layout) => {
    const definition = definitionOf(layout.definitionId);
    const pieces = layout.pieces();
    const expected = (fixture.track as Record<string, { pieces: number; boxes: number; perPiece: string[] }>)[name];
    expect(pieces.length).toBe(expected.pieces);
    const base = trackOf(definition, pieces, null);
    const perPiece = await Promise.all(base.map(async (list) => `${list.length / BOX_FLOATS}:${await sha16(list, list.length / BOX_FLOATS)}`));
    expect(perPiece, `${name}: default track`).toEqual(expected.perPiece);
    expect(base.reduce((sum, list) => sum + list.length / BOX_FLOATS, 0)).toBe(expected.boxes);
    // The same pieces with an all-zero table (a record whose swatches the palette lacks) are the defaults.
    expect(trackOf(definition, pieces, new Uint8Array(8))).toEqual(base);

    // Deterministic random records (40, fewer on the 64-piece layout): only material bytes move.
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed >>> 8;
    };
    const rounds = pieces.length > 30 ? 6 : 40;
    for (let round = 0; round < rounds; round += 1) {
      const table = tableOf({ 1: next() % 21, 2: next() % 21, 3: next() % 21, 4: next() % 21 });
      const painted = trackOf(definition, pieces, table);
      painted.forEach((list, index) => {
        expect(list.length, `${name} piece ${index}: box count`).toBe(base[index].length);
        for (let box = 0; box < list.length / BOX_FLOATS; box += 1) {
          const at = box * BOX_FLOATS;
          for (const field of [0, 1, 2, 4, 5, 6, 7]) expect(list[at + field], `${name} piece ${index} box ${box} field ${field}`).toBe(base[index][at + field]);
          expect(list[at + 3] - (list[at + 3] & MASK_MATERIAL), `${name} piece ${index} box ${box}: group, pattern and turn`).toBe(base[index][at + 3] - (base[index][at + 3] & MASK_MATERIAL));
        }
      });
    }
  });

  it.each(COASTER_IDS)('%s: each slot repaints only its own words, and fixed words never move', (id) => {
    const definition = definitionOf(id);
    const pieces = devPieces();
    const stationLength = Math.min(GAME_CONFIG.coaster.stationLength, pieces.length);
    const base = trackOf(definition, pieces, null);
    const accent = PALETTE.material(definition.accent);
    const color = PALETTE.material(definition.color);
    const supportMaterials = new Set<number>(
      id === 'comet-trail' ? [MAT.WOOD, MAT.TRACK, MAT.TIMBER] : id === 'star-chaser' ? [PALETTE.material(definition.color), MAT.PANTS_DARK, MAT.STEEL] : [PALETTE.material(definition.color), MAT.INK, MAT.STEEL_LIGHT],
    );
    const PAINT = 7; // Rose: the default of no coaster slot
    const slotTable = (tag: number): Uint8Array => tableOf({ [tag]: PAINT });
    const changed = (table: Uint8Array): { piece: number; was: number; now: number }[] => {
      const out: { piece: number; was: number; now: number }[] = [];
      trackOf(definition, pieces, table).forEach((list, piece) => {
        for (let box = 0; box < list.length / BOX_FLOATS; box += 1) {
          const was = base[piece][box * BOX_FLOATS + 3] & MASK_MATERIAL;
          const now = list[box * BOX_FLOATS + 3] & MASK_MATERIAL;
          if (was !== now) out.push({ piece, was, now });
        }
      });
      return out;
    };
    const painted = PALETTE.material(COLOUR_SWATCHES[PAINT].rgb);
    // Rails: the running rails, the station's platform edge, valance and queue gate (the type's accent word).
    const rails = changed(slotTable(3));
    expect(rails.length, 'rails change').toBeGreaterThan(0);
    for (const entry of rails) expect([entry.was, entry.now], 'only the accent word becomes the swatch').toEqual([accent, painted]);
    // Supports: bents, spine and ties.
    const supports = changed(slotTable(4));
    expect(supports.length, 'supports, spine and ties change').toBeGreaterThan(0);
    for (const entry of supports) {
      expect(supportMaterials.has(entry.was), `a support/spine/tie word (${entry.was})`).toBe(true);
      expect(entry.now).toBe(painted);
    }
    // Train (primary): only the station canopy stripes, in the station pieces.
    const canopy = changed(slotTable(1));
    expect(canopy.length, 'the station canopy follows the train colour').toBeGreaterThan(0);
    for (const entry of canopy) {
      expect(entry.piece, 'canopy boxes are in station pieces').toBeLessThan(stationLength);
      expect([entry.was, entry.now]).toEqual([color, painted]);
    }
    // Seats (secondary): nothing on the track.
    expect(changed(slotTable(2)), 'seats paint cars only').toEqual([]);
    // Everything at once: fixed words never move.
    const everything = tableOf({ 1: PAINT, 2: PAINT, 3: PAINT, 4: PAINT });
    const fixed = new Set<number>([MAT.STONE, MAT.FENCE_RAIL, MAT.CONCRETE, MAT.BULB, MAT.FENCE_POST]);
    trackOf(definition, pieces, everything).forEach((list, piece) => {
      for (let box = 0; box < list.length / BOX_FLOATS; box += 1) {
        const was = base[piece][box * BOX_FLOATS + 3] & MASK_MATERIAL;
        if (fixed.has(was)) expect(list[box * BOX_FLOATS + 3] & MASK_MATERIAL, `piece ${piece} box ${box}: fixed word ${was}`).toBe(was);
      }
    });
    // The canopy posts and dispatch post of the station are steel on every type and stay steel: on a
    // level-0 station piece nothing else is steel, so no steel box there may change.
    if (id === 'star-chaser') {
      trackOf(definition, pieces, everything).forEach((list, piece) => {
        if (piece >= stationLength || pieces[piece].height !== 0) return;
        for (let box = 0; box < list.length / BOX_FLOATS; box += 1) {
          if ((base[piece][box * BOX_FLOATS + 3] & MASK_MATERIAL) === MAT.STEEL) expect(list[box * BOX_FLOATS + 3] & MASK_MATERIAL, `station post ${piece}/${box}`).toBe(MAT.STEEL);
        }
      });
    }
  });

  it('paintedMaterial reads the slot by id: absent slots, absent tables and default entries give 0', () => {
    const table = tableOf({ 3: 5, 4: 7 });
    expect(paintedMaterial('star-chaser', table, 'rail')).toBe(PALETTE.material(COLOUR_SWATCHES[5].rgb));
    expect(paintedMaterial('star-chaser', table, 'support')).toBe(PALETTE.material(COLOUR_SWATCHES[7].rgb));
    expect(paintedMaterial('star-chaser', table, 'primary')).toBe(0);
    expect(paintedMaterial('star-chaser', table, 'trim')).toBe(0);
    expect(paintedMaterial('star-chaser', null, 'rail')).toBe(0);
    expect(paintedMaterial('mystery-coaster', table, 'rail')).toBe(0);
  });
});
