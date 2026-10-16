import type { Shape } from '../../contracts/blueprint';
import { PATTERN } from '../../contracts/palette';
import { C } from './colours';
import { box, dome, propContent } from './kit';

/** Autumn Forest props: maple, golden birch, pumpkin patch, toadstools, fallen log (2x1) and the stone wall (permanent). */

export const mapleTree = propContent((_kind, m) => {
  const red = m(C.MAPLE_RED);
  const orange = m(C.MAPLE_ORANGE);
  return [
    box(11, 11, 0, 10, 10, 2, m(C.TIMBER), PATTERN.SPECKLE),
    box(13, 13, 2, 6, 6, 14, m(C.TIMBER), PATTERN.SPECKLE),
    ...dome(16, 16, 14, [
      { half: 8, chamfer: 3, height: 4, material: red },
      { half: 11, chamfer: 4, height: 5, material: red },
      { half: 11, chamfer: 4, height: 5, material: orange },
      { half: 9, chamfer: 3, height: 4, material: orange },
      { half: 5, chamfer: 2, height: 3, material: orange },
    ], red, PATTERN.FOLIAGE),
    box(12, 26, 18, 3, 2, 2, orange),
    box(26, 12, 23, 2, 3, 2, m(C.SIGN)),
  ];
});

export const goldenBirch = propContent((_kind, m) => {
  const white = m(C.WHITE);
  const ink = m(C.INK);
  const gold = m(C.BIRCH_GOLD);
  const shapes: Shape[] = [
    box(13, 13, 0, 6, 6, 3, m(C.TIMBER), PATTERN.SPECKLE),
    box(14, 14, 3, 4, 4, 26, white, PATTERN.SPECKLE),
    box(14, 18, 6, 3, 1, 1, ink),
    box(17, 18, 12, 1, 1, 2, ink),
    box(14, 18, 18, 3, 1, 1, ink),
    box(18, 14, 9, 1, 3, 1, ink),
    box(18, 15, 15, 1, 2, 2, ink),
    box(18, 14, 22, 1, 3, 1, ink),
    ...dome(16, 16, 20, [
      { half: 7, chamfer: 3, height: 4 },
      { half: 10, chamfer: 4, height: 5 },
      { half: 9, chamfer: 3, height: 5 },
      { half: 6, chamfer: 2, height: 4 },
      { half: 3, chamfer: 1, height: 2 },
    ], gold, PATTERN.FOLIAGE),
  ];
  return shapes;
});

export const pumpkinPatch = propContent((_kind, m) => {
  const orange = m(C.MAPLE_ORANGE);
  const green = m(C.FOLIAGE);
  const shapes: Shape[] = [];
  const pumpkin = (cx: number, cy: number, scale: number): void => {
    shapes.push(...dome(cx, cy, 0, [
      { half: 4 + scale, chamfer: 2, height: 2 },
      { half: 5 + scale, chamfer: 2, height: 3 + scale },
      { half: 4 + scale, chamfer: 2, height: 2 },
    ], orange, PATTERN.STRIPES));
    shapes.push(box(cx - 1, cy - 1, 7 + scale, 2, 2, 2, green));
  };
  pumpkin(10, 11, 1);
  pumpkin(22, 13, 0);
  pumpkin(15, 22, 1);
  shapes.push(box(8, 4, 0, 18, 2, 1, green, PATTERN.FOLIAGE));
  shapes.push(box(26, 6, 0, 2, 16, 1, green, PATTERN.FOLIAGE));
  return shapes;
});

export const toadstools = propContent((_kind, m) => {
  const red = m(C.MAPLE_RED);
  const white = m(C.WHITE);
  const shapes: Shape[] = [];
  const mushroom = (cx: number, cy: number, half: number, stem: number): void => {
    shapes.push(box(cx - 1, cy - 1, 0, 3, 3, stem, white, PATTERN.SPECKLE));
    shapes.push(...dome(cx, cy, stem, [
      { half, chamfer: 2, height: 2 },
      { half: half - 2, chamfer: 1, height: 2 },
    ], red, PATTERN.SPECKLE));
    shapes.push(box(cx - 1, cy + half - 1, stem + 1, 2, 2, 2, white));
    shapes.push(box(cx + half - 1, cy - 2, stem + 2, 2, 2, 2, white));
  };
  mushroom(10, 11, 5, 5);
  mushroom(22, 12, 4, 4);
  mushroom(16, 22, 6, 7);
  mushroom(25, 24, 3, 3);
  return shapes;
});

export const fallenLog = propContent((_kind, m) => {
  return [
    { kind: 'cylinder', base: [4, 16, 7], radius: 7, length: 56, axis: 'x', material: m(C.TIMBER), pattern: PATTERN.PLANKS } as Shape,
    { kind: 'cylinder', base: [58, 16, 7], radius: 5, length: 3, axis: 'x', material: m(C.WOOD), pattern: PATTERN.SPECKLE } as Shape,
    box(12, 11, 13, 6, 8, 2, m(C.MECHANIC), PATTERN.FOLIAGE),
    box(26, 13, 14, 8, 6, 2, m(C.TRACK), PATTERN.FOLIAGE),
    box(40, 11, 13, 6, 8, 2, m(C.MECHANIC), PATTERN.FOLIAGE),
    box(20, 22, 0, 5, 4, 1, m(C.TRACK)),
    box(46, 4, 0, 5, 4, 1, m(C.MECHANIC)),
    box(6, 12, 13, 4, 6, 2, m(C.FOLIAGE), PATTERN.FOLIAGE),
  ];
});

export const stoneWall = propContent((_kind, m) => {
  const stone = m(C.STONE);
  return [
    // A full-tile dry-stone course so a run of walls reads as one wall.
    box(0, 0, 0, 32, 32, 8, stone, PATTERN.BRICK),
    box(0, 0, 8, 32, 32, 6, stone, PATTERN.BRICK),
    box(4, 5, 14, 9, 8, 2, m(C.FOLIAGE_DARK), PATTERN.FOLIAGE),
    box(19, 18, 14, 9, 9, 2, m(C.FOLIAGE_DARK), PATTERN.FOLIAGE),
  ];
});
