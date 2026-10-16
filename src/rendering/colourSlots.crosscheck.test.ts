import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../game/content/catalog';
import {
  COLOUR_SLOTS, COLOUR_SWATCHES, COLOURABLE_DEFINITION_IDS, ENTRANCE_COLOUR_ID, colourKindOf, colourSlotsFor, type ObjectColours,
} from '../game/content/colours';
import { GUEST_ACCENTS, GUEST_COLORS } from '../game/guests/GuestSimulation';
import { Container } from 'pixi.js';
import { classicCoasterPalette } from './classicCoaster';
import { createObjectArt, drawEntranceArt } from './classicObjectArt';
import { classicTrainSpec } from './classicTrain';
import { createRideArt } from './rideArt';
import { fingerprintNode } from './sceneFingerprint';
import { voxelPaintedSlots } from './voxel/content/colourSlotProbe';
import { buildPalette } from './voxel/palette';

/**
 * Phase 28 step 2: the two renderers read ONE slot table. For every colourable definition (and the gate), the
 * slots the voxel art repaints (blueprint tags, the coaster cars and the track's paint table), the slots the
 * classic art repaints (what changes when the slot is recoloured) and the slots `colourSlotsFor` declares are
 * the same list, in the same order; and every slot default is a colour both renderers can draw (an existing
 * voxel palette material, a literal of the classic art).
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));
const SENTINELS = [COLOUR_SWATCHES.find((swatch) => swatch.id === 'lagoon')!, COLOUR_SWATCHES.find((swatch) => swatch.id === 'cherry')!];

const record = (id: string, index: number, swatch: number): ObjectColours => (
  Object.freeze(colourSlotsFor(id).map((_slot, at) => (at === index ? swatch : null)))
);

/** What a classic drawing of `id` looks like in the shape of a string; coasters are the palette, the train and nothing else. */
const classicLook = (id: string, colours: ObjectColours | null): string => {
  const definition = BUILD_BY_ID.get(id);
  if (id === ENTRANCE_COLOUR_ID) {
    const group = new Container();
    drawEntranceArt(group, colours);
    const text = fingerprintNode(group);
    group.destroy({ children: true, context: true });
    return text;
  }
  if (!definition) throw new Error(id);
  if (definition.custom === 'coaster') {
    return JSON.stringify([classicCoasterPalette(id, definition.color, colours), classicTrainSpec(id, colours)]);
  }
  const art = definition.kind === 'ride' ? createRideArt(definition, 0, colours).container : createObjectArt(definition, colours);
  const text = fingerprintNode(art);
  art.destroy({ children: true, context: true });
  return text;
};

/** The slots whose recolour (with either sentinel swatch that is not the slot default) changes the classic art. */
const classicPaintedSlots = (id: string): string[] => {
  const base = classicLook(id, null);
  return colourSlotsFor(id).flatMap((slot, index) => {
    const swatch = SENTINELS.find((candidate) => candidate.rgb !== slot.defaultRgb)!;
    return classicLook(id, record(id, index, swatch.index)) === base ? [] : [slot.id];
  });
};

const ALL_IDS = [...COLOURABLE_DEFINITION_IDS, ENTRANCE_COLOUR_ID];

/** Phase 16 rides with no classic builder: the legacy generic spinner draws them in the catalog colours. */
const PHASE16_CLASSIC_GENERIC_RIDES: ReadonlySet<string> = new Set(['puddle-jumpers', 'rocket-pendulum', 'temple-trek']);

describe('both renderers repaint the slots the table declares', () => {
  it('covers 51 catalog definitions and the gate, every one with at least one slot and unique slot ids and tags', () => {
    // 29 before Phase 16, plus its 3 rides, 2 stalls and 7 themed scenery pieces, Phase 29's 6 stalls and Phase 39's 4 coasters.
    expect(COLOURABLE_DEFINITION_IDS).toHaveLength(51);
    expect(Object.keys(COLOUR_SLOTS)).toHaveLength(52);
    for (const id of ALL_IDS) {
      const slots = colourSlotsFor(id);
      expect(slots.length, id).toBeGreaterThanOrEqual(1);
      expect(new Set(slots.map((slot) => slot.id)).size, `${id} unique ids`).toBe(slots.length);
      expect(slots.map((slot) => slot.tag), `${id} positional tags`).toEqual(slots.map((_slot, index) => index + 1));
      expect(colourKindOf(id), id).not.toBeNull();
    }
    for (const id of COLOURABLE_DEFINITION_IDS) expect(BUILD_BY_ID.has(id), `${id} is a catalog id`).toBe(true);
  });

  it.each(ALL_IDS)('%s: voxel slots = classic slots = declared slots', (id) => {
    const declared = colourSlotsFor(id).map((slot) => slot.id);
    expect(voxelPaintedSlots(id), `${id} voxel`).toEqual(declared);
    // The classic renderer is legacy (frozen since 2026-10-13): the Phase 16 rides draw through its generic spinner,
    // which ignores a colour record, so they recolour in the voxel renderer only.
    expect(classicPaintedSlots(id), `${id} classic`).toEqual(PHASE16_CLASSIC_GENERIC_RIDES.has(id) ? [] : declared);
  });

  it('every slot default resolves to an existing voxel palette material (a catalog colour, a swatch or a plot tint)', () => {
    for (const id of ALL_IDS) {
      for (const slot of colourSlotsFor(id)) {
        const material = PALETTE.material(slot.defaultRgb);
        expect(material, `${id}/${slot.id} 0x${slot.defaultRgb.toString(16)}`).toBeGreaterThan(0);
      }
    }
  });

  it('trees and paths stay fixed in both renderers: not colourable, no slot, no recolour', () => {
    for (const id of ['confetti-tree', 'sunstone-path']) {
      expect(colourSlotsFor(id)).toHaveLength(0);
      expect(colourKindOf(id)).toBeNull();
    }
    expect(voxelPaintedSlots('confetti-tree')).toEqual([]);
  });
});
