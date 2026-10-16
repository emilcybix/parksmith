import { PATTERN } from '../../contracts/palette';
import { C } from './colours';
import { box, dome, propContent } from './kit';

/** Desert Canyon props: saguaro, barrel cactus, red boulder, canyon wall (permanent), rock spire (2x2, permanent). */

export const saguaro = propContent((_kind, m) => {
  const cactus = m(C.CACTUS);
  return [
    box(13, 13, 0, 6, 6, 40, cactus, PATTERN.SPECKLE),
    box(14, 14, 40, 4, 4, 2, cactus, PATTERN.SPECKLE),
    // Left arm: out, then up.
    box(5, 14, 16, 9, 4, 4, cactus, PATTERN.SPECKLE),
    box(5, 14, 20, 4, 4, 12, cactus, PATTERN.SPECKLE),
    box(5, 15, 32, 4, 2, 2, cactus, PATTERN.SPECKLE),
    // Right arm, a little higher.
    box(18, 14, 24, 9, 4, 4, cactus, PATTERN.SPECKLE),
    box(23, 14, 28, 4, 4, 8, cactus, PATTERN.SPECKLE),
    box(23, 15, 36, 4, 2, 2, cactus, PATTERN.SPECKLE),
    box(15, 15, 42, 2, 2, 3, m(C.FLOWER_PINK)),
    box(14, 18, 30, 2, 2, 2, m(C.FLOWER_PINK)),
  ];
});

export const barrelCactus = propContent((_kind, m) => {
  const cactus = m(C.CACTUS);
  return [
    ...dome(16, 16, 0, [
      { half: 8, chamfer: 3, height: 3 },
      { half: 10, chamfer: 4, height: 6 },
      { half: 8, chamfer: 3, height: 4 },
      { half: 4, chamfer: 1, height: 1 },
    ], cactus, PATTERN.STRIPES),
    box(13, 13, 14, 6, 6, 2, m(C.ARCH_PINK)),
    box(15, 15, 16, 2, 2, 2, m(C.FLOWER_PINK)),
  ];
});

export const redBoulder = propContent((_kind, m) => {
  const rock = m(C.CANYON_ROCK);
  const strata = m(C.CANYON_STRATA);
  return [
    ...dome(16, 16, 0, [
      { half: 11, chamfer: 4, height: 4, material: strata },
      { half: 13, chamfer: 5, height: 5, material: rock },
      { half: 12, chamfer: 5, height: 4, material: strata },
      { half: 9, chamfer: 4, height: 4, material: rock },
      { half: 5, chamfer: 2, height: 3, material: strata },
    ], rock, PATTERN.SOIL),
  ];
});

export const canyonWall = propContent((_kind, m) => {
  const rock = m(C.CANYON_ROCK);
  const strata = m(C.CANYON_STRATA);
  return [
    // A full-tile block in banded strata with a ragged top, so a run of them reads as one ridge.
    box(0, 0, 0, 32, 32, 14, strata, PATTERN.SOIL),
    box(0, 0, 14, 32, 32, 6, rock, PATTERN.SOIL),
    box(0, 0, 20, 32, 20, 6, strata, PATTERN.SOIL),
    box(0, 0, 26, 22, 20, 6, rock, PATTERN.SOIL),
    box(6, 4, 32, 12, 10, 4, strata, PATTERN.SOIL),
    box(22, 20, 20, 10, 12, 4, rock, PATTERN.SOIL),
  ];
});

export const rockSpire = propContent((_kind, m) => {
  const rock = m(C.CANYON_ROCK);
  const floor = m(C.RED_ROCK_FLOOR);
  return [
    ...dome(32, 32, 0, [
      { half: 27, chamfer: 9, height: 8, material: floor },
      { half: 24, chamfer: 8, height: 8, material: rock },
      { half: 21, chamfer: 8, height: 9, material: floor },
      { half: 17, chamfer: 6, height: 9, material: rock },
      { half: 13, chamfer: 5, height: 8, material: floor },
      { half: 9, chamfer: 4, height: 7, material: rock },
      { half: 5, chamfer: 2, height: 5, material: floor },
    ], rock, PATTERN.SOIL),
  ];
});
