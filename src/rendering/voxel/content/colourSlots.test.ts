import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { COLOUR_SLOT_TAG, COLOUR_SWATCHES, colourSlotsFor, isColourable, RIDE_COLOUR_SLOTS } from '../../../game/content/colours';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import type { BuildDefinition } from '../../../game/types';
import { compileBlueprint, rotateModel } from '../blueprint/compile';
import type { CompiledModel, CompiledPart } from '../contracts/blueprint';
import { BOX_FLOATS, unpackBoxWord } from '../contracts/boxes';
import { MAT } from '../contracts/palette';
import { buildPalette } from '../palette';
import fixture from './__fixtures__/ride-boxes-pre-colours.json';
import { contentFor } from './registry';

/**
 * Phase 28 step 1, voxel content: every flat ride tags the shapes of its colour slots, and tagging
 * changes NOTHING a player sees until a swatch is chosen.
 *
 * - Compiled identity: fields 0-6 of every box of every ride, at all four turns, hash to what the
 *   code produced BEFORE tags existed (`__fixtures__/ride-boxes-pre-colours.json`, captured from the
 *   unchanged compiler). Field 7 is 0 or a declared tag.
 * - Census: the number of boxes each tag owns per ride is pinned (they are the baseline "slotOwned"
 *   counts), every ride tags exactly the slots `colourSlotsFor` declares, and a tag only ever sits
 *   on the material its slot defaults to; nothing fixed (steel, wood, glass, bulbs, riders) is tagged.
 */

const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));

const RIDE_IDS = Object.keys(RIDE_COLOUR_SLOTS);

const definitionOf = (id: string): BuildDefinition => {
  const definition = BUILD_BY_ID.get(id);
  if (!definition) throw new Error(`no catalog entry ${id}`);
  return definition;
};

const q0Of = (id: string): CompiledModel => compileBlueprint(contentFor(id).blueprint(definitionOf(id), palette));

/** sha256 (first 16 hex digits) of fields 0-6 of every box of a part, as the frozen fixture was captured. */
const geometrySha = async (part: CompiledPart): Promise<string> => {
  const geometry = new Float32Array(part.boxCount * 7);
  for (let box = 0; box < part.boxCount; box += 1) {
    for (let field = 0; field < 7; field += 1) geometry[box * 7 + field] = part.boxes[box * BOX_FLOATS + field];
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', geometry));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const forEachBox = (model: CompiledModel, visit: (part: CompiledPart, box: number, tag: number, material: number) => void): void => {
  for (const part of model.parts) {
    for (let box = 0; box < part.boxCount; box += 1) {
      visit(part, box, part.boxes[box * BOX_FLOATS + 7], unpackBoxWord(part.boxes[box * BOX_FLOATS + 3]).material);
    }
  }
};

/** Tagged boxes per tag at quarter turn 0: the baseline `slotOwned` census plus the trim colours. */
const TAGGED_BOXES: Readonly<Record<string, readonly [primary: number, secondary: number, trim: number]>> = {
  'petal-roundabout': [362, 441, 0],
  'comet-cups': [186, 188, 0],
  'cloud-hopper': [68, 14, 0],
  'aurora-wheel': [423, 266, 6],
  'moonpetal-carousel': [709, 596, 40],
  'bumble-coach': [28, 8, 0],
  'harbor-swings': [197, 160, 152],
  'splash-rings': [101, 38, 0],
  'gale-spinner': [130, 67, 0],
  'thunder-drum': [251, 196, 0],
  // Phase 22 (profile-gated): its fixture entry was captured when the ride was added, not before tags existed.
  'tiki-tumbler': [168, 159, 0],
  // Phase 16: their fixture entries were captured when the rides were added (post-colour, like the tiki).
  'puddle-jumpers': [193, 156, 0],
  'rocket-pendulum': [538, 207, 0],
  'temple-trek': [3, 28, 0],
};

describe('colour slot tags on the ride blueprints', () => {
  it('covers every colourable ride and nothing else', () => {
    expect([...RIDE_IDS].sort()).toEqual(Object.keys(TAGGED_BOXES).sort());
    expect(Object.keys(fixture.rides).sort()).toEqual([...RIDE_IDS].sort());
    const catalogRides = BUILD_CATALOG.filter((definition) => definition.kind === 'ride' && definition.custom !== 'coaster').map((definition) => definition.id);
    expect(catalogRides.sort()).toEqual([...RIDE_IDS].sort());
  });

  it.each(RIDE_IDS)('%s compiles to the boxes it compiled to before tags existed, at every quarter turn', async (id) => {
    const q0 = q0Of(id);
    const q1 = rotateModel(q0, 1);
    const q2 = rotateModel(q1, 1);
    const q3 = rotateModel(q2, 1);
    const expected = (fixture.rides as Record<string, Record<string, string[]>>)[id];
    for (const [quarter, model] of [q0, q1, q2, q3].entries()) {
      const actual = await Promise.all(model.parts.map(async (part) => `${part.id}:${part.boxCount}:${await geometrySha(part)}`));
      expect(actual, `${id} q${quarter}`).toEqual(expected[`q${quarter}`]);
    }
  });

  it.each(RIDE_IDS)('%s tags exactly its slots, only on the slot default material, with the pinned census', (id) => {
    const slots = colourSlotsFor(id);
    const model = q0Of(id);
    const counts = new Map<number, number>();
    const materialOfTag = new Map<number, Set<number>>();
    forEachBox(model, (_part, _box, tag, material) => {
      expect(Number.isInteger(tag) && tag >= 0 && tag <= 3, `${id}: field 7 is a declared tag (got ${tag})`).toBe(true);
      if (tag === 0) return;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
      materialOfTag.set(tag, (materialOfTag.get(tag) ?? new Set()).add(material));
    });
    expect([...counts.keys()].sort(), `${id}: the tags present are the declared slots`).toEqual(slots.map((slot) => COLOUR_SLOT_TAG[slot.id]).sort());
    slots.forEach((slot) => {
      const tag = COLOUR_SLOT_TAG[slot.id];
      expect([...(materialOfTag.get(tag) ?? [])], `${id}/${slot.id}: one material per slot`).toEqual([palette.material(slot.defaultRgb)]);
      expect(palette.flags(palette.material(slot.defaultRgb)), `${id}/${slot.id}: slot materials never glow, shimmer or turn to glass`).toBe(0);
    });
    const [primary, secondary, trim] = TAGGED_BOXES[id];
    expect([counts.get(COLOUR_SLOT_TAG.primary) ?? 0, counts.get(COLOUR_SLOT_TAG.secondary) ?? 0, counts.get(COLOUR_SLOT_TAG.trim) ?? 0]).toEqual([primary, secondary, trim]);
  });

  it('never tags steel, wood, glass, bulbs, glow or riders', () => {
    const fixedMaterials = new Set<number>([MAT.STEEL, MAT.STEEL_LIGHT, MAT.WOOD, MAT.TIMBER, MAT.CONCRETE, MAT.STONE, MAT.WATER, MAT.GLASS, MAT.WINDOW_GLOW, MAT.BULB, MAT.LAMP_GLOW, MAT.WHITE, MAT.SKIN_1, MAT.SKIN_2, MAT.SKIN_3, MAT.SKIN_4, MAT.HAIR_BLOND, MAT.HAIR_BROWN, MAT.HAIR_DARK]);
    for (const id of RIDE_IDS) {
      forEachBox(q0Of(id), (_part, _box, tag, material) => {
        if (tag !== 0) expect(fixedMaterials.has(material), `${id}: a tagged box on fixed material ${material}`).toBe(false);
      });
    }
  });

  it('keeps the comet-cups rider shirt that shares the primary colour untagged', () => {
    const shirt = palette.material(GUEST_COLORS[2]);
    expect(shirt, 'the shirt and the ride colour are the same palette material').toBe(palette.material(definitionOf('comet-cups').color));
    let untaggedShirts = 0;
    forEachBox(q0Of('comet-cups'), (_part, _box, tag, material) => {
      if (material === shirt && tag === 0) untaggedShirts += 1;
    });
    expect(untaggedShirts).toBeGreaterThan(0);
  });

  it('leaves a ride without slots untagged (the generic spinner stands in for unknown ids)', () => {
    const unknown: BuildDefinition = { ...definitionOf('petal-roundabout'), id: 'mystery-ride' };
    expect(isColourable(unknown.id)).toBe(false);
    const model = compileBlueprint(contentFor(unknown.id).blueprint(unknown, palette));
    forEachBox(model, (_part, _box, tag) => expect(tag).toBe(0));
  });

  it('every swatch has an unflagged voxel material, and swatches only append to the palette', () => {
    for (const swatch of COLOUR_SWATCHES) {
      const material = palette.material(swatch.rgb);
      expect(palette.baseColor(material), swatch.id).toBe(swatch.rgb);
      expect(palette.flags(material), `${swatch.id} is plain`).toBe(0);
    }
    const plain = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
    expect(palette.count, 'nine retuned swatches cost one material each (palette.test.ts pins the bytes)').toBe(plain.count + 9);
    for (let material = 1; material < plain.count; material += 1) expect(palette.baseColor(material)).toBe(plain.baseColor(material));
  });
});
