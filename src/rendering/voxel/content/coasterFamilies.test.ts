import { describe, expect, it } from 'vitest';
import { hillDipLayout } from '../../../game/coaster/testLayouts';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { compileBlueprint } from '../blueprint/compile';
import { BOX_FLOATS, BoxWriter, unpackBoxWord } from '../contracts/boxes';
import { MAT } from '../contracts/palette';
import { buildPalette } from '../palette';
import { coasterContent } from './coaster';

/** Phase 39 art: the wooden family's lattice bents and timber look, and the wild mouse's single car. */
const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const LAYOUT = hillDipLayout();
/** Piece 6 of the hill-and-dip stands at level 3 on a flat crest: a bent with a braced bay. */
const TALL = 6;

const boxesOf = (definitionId: string, index: number): Float32Array[] => {
  const writer = new BoxWriter(64);
  coasterContent.pieceBoxes(LAYOUT, index, BUILD_BY_ID.get(definitionId)!, palette, 1, writer);
  return Array.from({ length: writer.count }, (_unused, box) => writer.data.slice(box * BOX_FLOATS, box * BOX_FLOATS + 8));
};
const overlaps = (a: Float32Array, b: Float32Array): boolean =>
  a[0] < b[0] + b[4] && b[0] < a[0] + a[4] && a[1] < b[1] + b[5] && b[1] < a[1] + a[5] && a[2] < b[2] + b[6] && b[2] < a[2] + a[6];

describe('Phase 39: coaster family art (voxel)', () => {
  it('the wooden coaster braces every bay both ways, in timber, and no two of its boxes overlap', () => {
    expect(LAYOUT[TALL].height).toBe(3);
    const wooden = boxesOf('timber-twister', TALL);
    const steel = boxesOf('star-chaser', TALL);
    expect(wooden.length).toBeGreaterThan(steel.length);
    const materials = new Set(wooden.map((box) => unpackBoxWord(box[3]).material));
    expect(materials.has(MAT.TIMBER)).toBe(true);
    expect(materials.has(MAT.WOOD)).toBe(true);
    for (let a = 0; a < wooden.length; a += 1) {
      for (let b = a + 1; b < wooden.length; b += 1) expect(overlaps(wooden[a], wooden[b]), `boxes ${a} and ${b}`).toBe(false);
    }
  });

  it('the wild mouse lead car has a mouse face, and every family car compiles', () => {
    for (const id of ['whisker-mouse', 'timber-twister']) {
      const definition = BUILD_BY_ID.get(id)!;
      const car = compileBlueprint(coasterContent.carBlueprint(definition, 0, palette));
      expect(car.boxCount, id).toBeGreaterThan(0);
      const riders = compileBlueprint(coasterContent.riderBlueprint(definition, 0, palette));
      expect(riders.boxCount, `${id} riders`).toBeGreaterThan(0);
    }
    const mouse = compileBlueprint(coasterContent.carBlueprint(BUILD_BY_ID.get('whisker-mouse')!, 0, palette));
    const comet = compileBlueprint(coasterContent.carBlueprint(BUILD_BY_ID.get('comet-trail')!, 0, palette));
    expect(mouse.top, 'the ears stand above a plain car').toBeGreaterThan(comet.top);
  });
});
