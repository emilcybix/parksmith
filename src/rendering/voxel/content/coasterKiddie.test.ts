import { describe, expect, it } from 'vitest';
import { INTENSITY_FIXTURES } from '../../../game/coaster/intensityFixtures';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { BOX_FLOATS, BoxWriter, unpackBoxWord } from '../contracts/boxes';
import { VOXELS_PER_TILE } from '../contracts/space';
import { buildPalette } from '../palette';
import { coasterContent, coasterLook } from './coaster';

/** Phase 58: a circuit that only climbs to height 1 (a kiddie coaster) draws its track and stands on its supports. */
const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

describe('Phase 58: a height-1 coaster (voxel)', () => {
  it.each(['comet-trail', 'whisker-mouse', 'timber-twister'])('%s: every piece draws inside its tile; the raised ones on supports', (id) => {
    const definition = BUILD_BY_ID.get(id)!;
    const supportMaterial = coasterLook(definition, palette, { rail: 0, tie: 0, spine: 0, support: 0 }).support;
    const pieces = INTENSITY_FIXTURES.find((entry) => entry.name.startsWith('kiddie oval'))!.pieces();
    for (const [index, piece] of pieces.entries()) {
      const writer = new BoxWriter(64);
      coasterContent.pieceBoxes(pieces, index, definition, palette, 1, writer);
      expect(writer.count, `piece ${index}`).toBeGreaterThan(0);
      let supports = 0;
      for (let box = 0; box < writer.count; box += 1) {
        const at = box * BOX_FLOATS;
        const [x, y, , , w, d] = writer.data.slice(at, at + 6);
        expect(x >= piece.cell.x * VOXELS_PER_TILE && x + w <= (piece.cell.x + 1) * VOXELS_PER_TILE, `piece ${index} box ${box} x`).toBe(true);
        expect(y >= piece.cell.y * VOXELS_PER_TILE && y + d <= (piece.cell.y + 1) * VOXELS_PER_TILE, `piece ${index} box ${box} y`).toBe(true);
        if (unpackBoxWord(writer.data[at + 3]).material === supportMaterial) supports += 1;
      }
      const raised = piece.height === 1 && pieces[(index + 1) % pieces.length].height === 1 && pieces[(index - 1 + pieces.length) % pieces.length].height === 1;
      if (raised) expect(supports, `piece ${index} stands on a support`).toBeGreaterThan(0);
    }
  });
});
