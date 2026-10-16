import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { coasterBaseCost, deriveCoasterStats, type CoasterPiece } from '../../../game/coaster/design';
import { layoutFromMoves } from '../../../game/coaster/testLayouts';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { GameWorld } from '../../../game/World';
import { compileBlueprint } from '../blueprint/compile';
import { BOX_FLOATS, BoxWriter } from '../contracts/boxes';
import { COASTER_LEVEL_VOXELS } from '../contracts/space';
import { buildPalette } from '../palette';
import { coasterRailTopZ } from '../scene/coasterCars';
import { CAR_HEIGHT, TRACK_DEPTH, coasterContent } from './coaster';
import { contentFor } from './registry';

/**
 * Phase 38 render side: a piece that crosses over other track stands on no support bent of its own (its legs would
 * come down on the lower track), and every catalog `clearanceLevels` is honest against the voxel model's height.
 */
const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const comet = BUILD_BY_ID.get('comet-trail')!;
const FIGURE_EIGHT = layoutFromMoves({ x: 2, y: 5 }, 'EEEEEESSWWNNNNWWWWWSSE',
  [0, 0, 0, 1, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const UPPER = 4;

const lowestZ = (pieces: readonly CoasterPiece[], index: number, supports = true): number => {
  const writer = new BoxWriter(64);
  coasterContent.pieceBoxes(pieces, index, comet, palette, 1, writer, null, supports);
  let lowest = Number.POSITIVE_INFINITY;
  for (let box = 0; box < writer.count; box += 1) lowest = Math.min(lowest, writer.data[box * BOX_FLOATS + 2]);
  return lowest;
};

describe('Phase 38: crossing track (voxel)', () => {
  it('the upper piece of a self-crossing has no bent: nothing of it comes down to the lower train', () => {
    const lowerTrainTop = coasterRailTopZ(0) + CAR_HEIGHT;
    expect(lowestZ(FIGURE_EIGHT, UPPER)).toBeGreaterThan(lowerTrainTop);
    // The same piece in a layout without the lower pass stands on legs down to the ground.
    const plain = FIGURE_EIGHT.map((piece, index) => (index === 12 ? { ...piece, cell: { x: 40, y: 40 } } : piece));
    expect(lowestZ(plain, UPPER)).toBeLessThan(lowerTrainTop);
  });

  it('the `supports` flag (another coaster or a low object below) drops the bent too', () => {
    const lowerTrainTop = coasterRailTopZ(0) + CAR_HEIGHT;
    const plain = FIGURE_EIGHT.map((piece, index) => (index === 12 ? { ...piece, cell: { x: 40, y: 40 } } : piece));
    expect(lowestZ(plain, UPPER, false)).toBeGreaterThan(lowerTrainTop);
  });

  it('the world says which pieces have something under them', () => {
    const world = new GameWorld(100_000);
    const type = COASTER_TYPE_BY_ID.get('comet-trail')!;
    const placed = world.placeCoaster('comet-trail', FIGURE_EIGHT, deriveCoasterStats(FIGURE_EIGHT, type), coasterBaseCost(FIGURE_EIGHT, type));
    expect('error' in placed).toBe(false);
    expect(world.hasSomethingUnder(FIGURE_EIGHT[UPPER].cell, 2)).toBe(true);
    expect(world.hasSomethingUnder(FIGURE_EIGHT[12].cell, 0)).toBe(false);
    expect(world.hasSomethingUnder(FIGURE_EIGHT[5].cell, 2)).toBe(false);
  });

  it('every object track may cross is lower than the track it allows over it', () => {
    let checked = 0;
    for (const definition of BUILD_CATALOG) {
      if (definition.clearanceLevels === undefined) continue;
      const model = compileBlueprint(contentFor(definition.id).blueprint(definition, palette));
      // The lowest track allowed over it: level clearanceLevels + 1; its spine bottom, less 2 voxels of air.
      const spineBottom = coasterRailTopZ(definition.clearanceLevels + 1) - TRACK_DEPTH;
      expect(model.top, `${definition.id} (top ${model.top}) under level ${definition.clearanceLevels + 1}`).toBeLessThanOrEqual(spineBottom - 2);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(6);
    expect(COASTER_LEVEL_VOXELS).toBe(13);
  });
});
