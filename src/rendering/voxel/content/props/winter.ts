import { PATTERN } from '../../contracts/palette';
import { C } from './colours';
import { box, dome, propContent } from './kit';

/** Winter props: snowy pine, snow drift, snowman, granite boulder and the glacier rock (2x2, permanent). */

export const snowyPine = propContent((_kind, m) => {
  const deep = m(C.FOLIAGE_DARK);
  const snow = m(C.SNOW);
  return [
    box(13, 13, 0, 6, 6, 10, m(C.TIMBER), PATTERN.SPECKLE),
    ...dome(16, 16, 8, [
      { half: 13, chamfer: 5, height: 6, material: deep },
      { half: 11, chamfer: 4, height: 2, material: snow },
      { half: 10, chamfer: 4, height: 6, material: deep },
      { half: 8, chamfer: 3, height: 2, material: snow },
      { half: 7, chamfer: 3, height: 6, material: deep },
      { half: 5, chamfer: 2, height: 2, material: snow },
      { half: 3, chamfer: 1, height: 3, material: snow },
    ], deep, PATTERN.FOLIAGE),
    box(21, 27, 11, 2, 2, 2, m(C.ARCH_PINK)),
    box(10, 25, 19, 2, 2, 2, m(C.ARCH_PINK)),
  ];
});

export const snowDrift = propContent((_kind, m) => {
  const snow = m(C.SNOW);
  const packed = m(C.PACKED_SNOW);
  return [
    ...dome(15, 15, 0, [
      { half: 13, chamfer: 5, height: 3, material: packed },
      { half: 11, chamfer: 5, height: 3 },
      { half: 7, chamfer: 3, height: 2 },
    ], snow, PATTERN.SPECKLE),
    ...dome(22, 22, 0, [
      { half: 8, chamfer: 3, height: 3, material: packed },
      { half: 6, chamfer: 3, height: 2 },
    ], snow, PATTERN.SPECKLE),
  ];
});

export const snowman = propContent((_kind, m) => {
  const white = m(C.WHITE);
  const ink = m(C.INK);
  return [
    ...dome(16, 16, 0, [
      { half: 8, chamfer: 3, height: 3 },
      { half: 11, chamfer: 4, height: 4 },
      { half: 9, chamfer: 3, height: 4 },
    ], white, PATTERN.SPECKLE),
    ...dome(16, 16, 11, [
      { half: 7, chamfer: 3, height: 3 },
      { half: 8, chamfer: 3, height: 3 },
      { half: 6, chamfer: 2, height: 2 },
    ], white, PATTERN.SPECKLE),
    // The scarf, the head, the face.
    ...dome(16, 16, 19, [{ half: 7, chamfer: 3, height: 2, material: m(C.ARCH_PINK) }], white),
    box(21, 12, 15, 2, 6, 2, m(C.ARCH_PINK)),
    ...dome(16, 16, 21, [
      { half: 6, chamfer: 2, height: 3 },
      { half: 6, chamfer: 2, height: 3 },
      { half: 4, chamfer: 1, height: 2 },
    ], white, PATTERN.SPECKLE),
    box(13, 21, 25, 2, 1, 2, ink),
    box(18, 21, 25, 2, 1, 2, ink),
    box(21, 13, 25, 1, 2, 2, ink),
    box(21, 18, 25, 1, 2, 2, ink),
    box(15, 22, 23, 2, 4, 2, m(C.CARROT)),
    box(22, 15, 23, 4, 2, 2, m(C.CARROT)),
    box(15, 22, 13, 2, 2, 2, ink),
    box(15, 25, 8, 2, 1, 2, ink),
    box(22, 15, 13, 2, 2, 2, ink),
    box(25, 15, 8, 1, 2, 2, ink),
  ];
});

export const graniteBoulder = propContent((_kind, m) => {
  const rock = m(C.GRANITE);
  const snow = m(C.SNOW);
  return [
    ...dome(16, 16, 0, [
      { half: 11, chamfer: 4, height: 4 },
      { half: 13, chamfer: 5, height: 5 },
      { half: 10, chamfer: 4, height: 4 },
    ], rock, PATTERN.SPECKLE),
    ...dome(16, 16, 13, [
      { half: 9, chamfer: 4, height: 2, material: snow },
      { half: 5, chamfer: 2, height: 2, material: snow },
    ], snow, PATTERN.SPECKLE),
  ];
});

export const glacierRock = propContent((_kind, m) => {
  const granite = m(C.GRANITE);
  const ice = m(C.THIN_ICE);
  const snow = m(C.SNOW);
  return [
    ...dome(32, 32, 0, [
      { half: 26, chamfer: 9, height: 6, material: granite },
      { half: 23, chamfer: 8, height: 10, material: ice },
      { half: 19, chamfer: 7, height: 10, material: ice },
      { half: 14, chamfer: 6, height: 10, material: ice },
      { half: 10, chamfer: 4, height: 4, material: snow },
      { half: 6, chamfer: 2, height: 4, material: snow },
    ], ice, PATTERN.SPECKLE),
    box(8, 46, 6, 10, 8, 6, granite, PATTERN.SPECKLE),
  ];
});
