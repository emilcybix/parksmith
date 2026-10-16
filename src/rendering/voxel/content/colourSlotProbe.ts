import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { COLOUR_SWATCHES, colourSlotsFor, ENTRANCE_COLOUR_ID, type ColourSlotId } from '../../../game/content/colours';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import type { CoasterPiece } from '../../../game/coaster/design';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { compileBlueprint, flattenAtRest } from '../blueprint/compile';
import { BOX_FLOATS, BoxWriter } from '../contracts/boxes';
import { buildPalette } from '../palette';
import { coasterContent } from './coaster';
import { contentFor, entranceBlueprint } from './registry';

/**
 * Test support (never imported by the renderer): which colour slots does the VOXEL art of a definition really
 * repaint? The classic renderer has its own paint ids (rideArt.ts, classic coaster palette); a cross-check test
 * asserts that for every colourable id both renderers repaint exactly the slots `colourSlotsFor` declares.
 *
 * - a compiled model (rides, stalls, facilities, comforts, scenery, the gate): the slots whose tag some box carries;
 * - a coaster: the tags its cars carry, plus every slot whose paint table moves a box of the track of a probe layout
 *   (a station, raised pieces with supports, a loop).
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));

/** A probe layout with a station, hills (supports), and a loop. */
const PROBE_PIECES: readonly CoasterPiece[] = (() => {
  const pieces: CoasterPiece[] = [];
  let x = 2;
  let y = 6;
  const moves = 'EEEEEEENNNWWWWWWWSSS';
  const heights = [0, 0, 0, 1, 2, 3, 4, 4, 4, 3, 2, 2, 2, 1, 1, 0, 0, 0, 0, 0];
  for (let index = 0; index < moves.length; index += 1) {
    pieces.push({ cell: { x, y }, height: heights[index], ...(index === 5 ? { special: 'boost' as const } : index === 11 ? { special: 'loop' as const } : {}) });
    const move = moves[index];
    if (move === 'E') x += 1; else if (move === 'W') x -= 1; else if (move === 'S') y += 1; else y -= 1;
  }
  return pieces;
})();

const trackBoxes = (definitionId: string, paint: Uint8Array | null): Float32Array => {
  const definition = BUILD_BY_ID.get(definitionId);
  if (!definition) throw new Error(`no catalog entry ${definitionId}`);
  const writer = new BoxWriter(1024);
  for (let index = 0; index < PROBE_PIECES.length; index += 1) coasterContent.pieceBoxes(PROBE_PIECES, index, definition, PALETTE, 7, writer, paint);
  return writer.data.slice(0, writer.count * BOX_FLOATS);
};

/** The slot ids the voxel art of `definitionId` (or ENTRANCE_COLOUR_ID) repaints, in slot-table order. */
export const voxelPaintedSlots = (definitionId: string): readonly ColourSlotId[] => {
  const slots = colourSlotsFor(definitionId);
  const tags = new Set<number>();
  const collect = (flat: { boxCount: number; tags: Uint8Array | null }): void => {
    if (flat.tags) for (let box = 0; box < flat.boxCount; box += 1) tags.add(flat.tags[box]);
  };
  const definition = BUILD_BY_ID.get(definitionId);
  if (definitionId === ENTRANCE_COLOUR_ID) {
    collect(flattenAtRest(compileBlueprint(entranceBlueprint(PALETTE))));
  } else if (definition?.custom === 'coaster') {
    const cars = COASTER_TYPE_BY_ID.get(definitionId)?.trainCars ?? 0;
    for (let car = 0; car < cars; car += 1) collect(flattenAtRest(compileBlueprint(coasterContent.carBlueprint(definition, car, PALETTE))));
    const base = trackBoxes(definitionId, null);
    for (const slot of slots) {
      for (const swatch of [7, 8]) {
        const paint = new Uint8Array(8);
        paint[slot.tag] = PALETTE.material(COLOUR_SWATCHES[swatch].rgb);
        const painted = trackBoxes(definitionId, paint);
        for (let at = 3; at < base.length; at += BOX_FLOATS) if (painted[at] !== base[at]) tags.add(slot.tag);
      }
    }
  } else if (definition) {
    collect(flattenAtRest(compileBlueprint(contentFor(definitionId).blueprint(definition, PALETTE))));
  }
  return slots.filter((slot) => tags.has(slot.tag)).map((slot) => slot.id);
};
