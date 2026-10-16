import type { BuildDefinition } from '../../../game/types';
import type { Blueprint, Shape } from '../contracts/blueprint';
import type { ObjectContent } from '../contracts/content';
import { MAT, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { PLOT_TOP_Z } from '../contracts/space';
import { slotTagger } from './colourTags';
import { footprintCentre } from './scenery';

/**
 * Amenities: the ribbon bench and the tidy totem (a bin), authored against the art bible
 * (design §12) and BOX_BUDGET.benchOrBin.
 *
 * Both have a front, and it is on model +y: the camera sees model +y at both quarter turns (world
 * +y at turn 0, world +x at turn 1; space.ts), so the side a guest uses — the bench's seat, the
 * bin's slot — is always the side that shows. Colours follow the legacy art: the catalog colour on
 * the body (bench seat, bin), the accent on the trim (bench back, bin lid and band).
 */

/** Art bible: seat top 8, back top 15, length 18–20, depth 6. */
const BENCH_LENGTH = 20;
const BENCH_DEPTH = 6;
const BENCH_SEAT_TOP = 8;
const BENCH_SEAT_THICKNESS = 2;
const BENCH_BACK_BOTTOM = 10;
const BENCH_BACK_TOP = 15;
const BENCH_BACK_DEPTH = 2;
/**
 * Steel frame: 2×2 posts flush with the bench's ends, the rear pair carrying the back, the front
 * pair the seat's front edge. Flush ends leave no 1-voxel sliver of back beyond the frame.
 */
const BENCH_POST = 2;

export const ribbonBench: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    // Phase 28: seat planks are colour slot 'primary', the backrest 'secondary'.
    const tag = slotTagger(definition.id);
    const left = centreX - BENCH_LENGTH / 2;
    const right = centreX + BENCH_LENGTH / 2 - BENCH_POST;
    const rear = centreY - BENCH_DEPTH / 2;
    const front = centreY + BENCH_DEPTH / 2 - BENCH_POST;
    const seatBottom = BENCH_SEAT_TOP - BENCH_SEAT_THICKNESS;
    const post = (x: number, y: number, top: number): Shape => ({
      kind: 'box',
      min: [x, y, PLOT_TOP_Z],
      size: [BENCH_POST, BENCH_POST, top - PLOT_TOP_Z],
      material: MAT.STEEL,
    });
    return {
      id: `amenity-bench:${definition.id}`,
      footprint: definition.footprint,
      parts: [{
        id: 'body',
        pivot: [0, 0, 0],
        shapes: [
          {
            kind: 'box',
            min: [left, rear, seatBottom],
            size: [BENCH_LENGTH, BENCH_DEPTH, BENCH_SEAT_THICKNESS],
            material: tag('primary', palette.material(definition.color)),
            pattern: PATTERN.PLANKS,
          },
          {
            kind: 'box',
            min: [left, rear, BENCH_BACK_BOTTOM],
            size: [BENCH_LENGTH, BENCH_BACK_DEPTH, BENCH_BACK_TOP - BENCH_BACK_BOTTOM],
            material: tag('secondary', palette.material(definition.accent)),
            pattern: PATTERN.PLANKS,
          },
          post(left, rear, BENCH_BACK_TOP),
          post(right, rear, BENCH_BACK_TOP),
          post(left, front, seatBottom),
          post(right, front, seatBottom),
        ],
      }],
    };
  },
};

/** Art bible: bin 8×8×16 plus a 2-voxel lid. */
const BIN_SIZE = 8;
const BIN_BODY_HEIGHT = 16;
const BIN_LID_HEIGHT = 2;
/**
 * An accent band round the upper body holds the slot: ink on the dark catalog colour barely shows,
 * ink on the light accent reads from across the park (legacy: a dark slot near the top).
 */
const BIN_BAND_BOTTOM = 11;
const BIN_BAND_HEIGHT = 4;
/** The slot on the front face: 4 wide, 2 high, centred, inside the band. */
const BIN_SLOT_WIDTH = 4;
const BIN_SLOT_BOTTOM = 12;
const BIN_SLOT_HEIGHT = 2;

export const tidyTotem: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    // Phase 28: the body is colour slot 'primary', the band and lid 'secondary'.
    const tag = slotTagger(definition.id);
    const trim = tag('secondary', palette.material(definition.accent));
    const minX = centreX - BIN_SIZE / 2;
    const minY = centreY - BIN_SIZE / 2;
    const bodyTop = PLOT_TOP_Z + BIN_BODY_HEIGHT;
    return {
      id: `amenity-bin:${definition.id}`,
      footprint: definition.footprint,
      parts: [{
        id: 'body',
        pivot: [0, 0, 0],
        shapes: [
          { kind: 'box', min: [minX, minY, PLOT_TOP_Z], size: [BIN_SIZE, BIN_SIZE, BIN_BODY_HEIGHT], material: tag('primary', palette.material(definition.color)) },
          { kind: 'box', min: [minX, minY, BIN_BAND_BOTTOM], size: [BIN_SIZE, BIN_SIZE, BIN_BAND_HEIGHT], material: trim },
          { kind: 'box', min: [minX, minY, bodyTop], size: [BIN_SIZE, BIN_SIZE, BIN_LID_HEIGHT], material: trim },
          // One voxel deep in the front (+y) face.
          {
            kind: 'box',
            min: [centreX - BIN_SLOT_WIDTH / 2, minY + BIN_SIZE - 1, BIN_SLOT_BOTTOM],
            size: [BIN_SLOT_WIDTH, 1, BIN_SLOT_HEIGHT],
            material: MAT.INK,
          },
        ],
      }],
    };
  },
};
