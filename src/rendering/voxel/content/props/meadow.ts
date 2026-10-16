import { PATTERN } from '../../contracts/palette';
import { C } from './colours';
import { box, dome, propContent } from './kit';
import type { Shape } from '../../contracts/blueprint';

/**
 * Meadow props: oak, shrub, boulder, mossy log (2x1) and the great oak (2x2, permanent). Soft lawn colours, a few
 * pink blossoms so the candy look survives in a green park.
 */

export const oakTree = propContent((_kind, m) => {
  const leaf = m(C.FOLIAGE);
  const deep = m(C.FOLIAGE_DARK);
  const wood = m(C.WOOD);
  return [
    box(11, 11, 0, 10, 10, 2, m(C.TIMBER), PATTERN.SPECKLE),
    box(13, 13, 2, 6, 6, 14, wood, PATTERN.SPECKLE),
    ...dome(16, 16, 14, [
      { half: 8, chamfer: 3, height: 4, material: deep },
      { half: 11, chamfer: 4, height: 5, material: deep },
      { half: 11, chamfer: 4, height: 5 },
      { half: 9, chamfer: 3, height: 4 },
      { half: 5, chamfer: 2, height: 3 },
    ], leaf, PATTERN.FOLIAGE),
    // Blossoms on the camera-facing sides of the crown.
    box(11, 26, 19, 2, 2, 2, m(C.FLOWER_PINK)),
    box(19, 26, 25, 2, 2, 2, m(C.WHITE)),
    box(26, 12, 21, 2, 2, 2, m(C.FLOWER_PINK)),
  ];
});

export const shrub = propContent((_kind, m) => {
  const deep = m(C.FOLIAGE_DARK);
  const pink = m(C.FLOWER_PINK);
  return [
    ...dome(16, 16, 0, [
      { half: 10, chamfer: 3, height: 4 },
      { half: 12, chamfer: 4, height: 4 },
      { half: 9, chamfer: 3, height: 3 },
      { half: 5, chamfer: 2, height: 2 },
    ], deep, PATTERN.FOLIAGE),
    box(9, 26, 4, 2, 2, 2, pink),
    box(20, 27, 6, 2, 2, 2, pink),
    box(25, 17, 5, 2, 2, 2, pink),
    box(14, 14, 11, 2, 2, 2, pink),
  ];
});

export const meadowBoulder = propContent((_kind, m) => {
  const stone = m(C.STONE);
  return [
    ...dome(16, 16, 0, [
      { half: 11, chamfer: 4, height: 4 },
      { half: 12, chamfer: 5, height: 5 },
      { half: 10, chamfer: 4, height: 4 },
      { half: 6, chamfer: 3, height: 3 },
    ], stone, PATTERN.SPECKLE),
    // Moss on the top and a green fringe down the back-left.
    box(10, 10, 13, 12, 12, 2, m(C.FOLIAGE), PATTERN.FOLIAGE),
    box(5, 20, 2, 3, 6, 3, m(C.FOLIAGE), PATTERN.FOLIAGE),
  ];
});

export const mossyLog = propContent((_kind, m) => {
  const timber = m(C.TIMBER);
  const long: Shape = { kind: 'cylinder', base: [4, 16, 7], radius: 7, length: 56, axis: 'x', material: timber, pattern: PATTERN.PLANKS };
  return [
    long,
    // The sawn end ring and a stump knot.
    { kind: 'cylinder', base: [58, 16, 7], radius: 5, length: 3, axis: 'x', material: m(C.WOOD), pattern: PATTERN.SPECKLE },
    box(14, 11, 12, 30, 10, 3, m(C.FOLIAGE), PATTERN.FOLIAGE),
    box(46, 14, 13, 8, 6, 2, m(C.FOLIAGE_DARK), PATTERN.FOLIAGE),
    box(8, 13, 13, 4, 5, 2, m(C.FLOWER_PINK)),
  ];
});

export const greatOak = propContent((_kind, m) => {
  const leaf = m(C.FOLIAGE);
  const deep = m(C.FOLIAGE_DARK);
  const timber = m(C.TIMBER);
  return [
    box(22, 22, 0, 20, 20, 4, timber, PATTERN.SPECKLE),
    box(26, 26, 4, 12, 12, 22, timber, PATTERN.SPECKLE),
    ...dome(32, 32, 22, [
      { half: 15, chamfer: 5, height: 6, material: deep },
      { half: 22, chamfer: 8, height: 7, material: deep },
      { half: 25, chamfer: 9, height: 8, material: deep },
      { half: 24, chamfer: 9, height: 8 },
      { half: 19, chamfer: 7, height: 6 },
      { half: 12, chamfer: 5, height: 5 },
    ], leaf, PATTERN.FOLIAGE),
    box(16, 56, 32, 3, 3, 3, m(C.FLOWER_PINK)),
    box(40, 57, 40, 3, 3, 3, m(C.WHITE)),
    box(56, 30, 36, 3, 3, 3, m(C.FLOWER_PINK)),
    box(52, 44, 28, 3, 3, 3, m(C.WHITE)),
  ];
});
