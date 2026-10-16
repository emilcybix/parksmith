import type { Shape } from '../../contracts/blueprint';
import { PATTERN } from '../../contracts/palette';
import { C } from './colours';
import { box, dome, propContent } from './kit';

/** Jungle props: kapok tree, fern, jungle bloom, mossy rock and the temple ruin (2x2, permanent). */

export const kapokTree = propContent((_kind, m) => {
  const leaf = m(C.JUNGLE_LEAF);
  return [
    box(10, 10, 0, 12, 12, 3, m(C.WOOD), PATTERN.SPECKLE),
    box(13, 13, 3, 6, 6, 34, m(C.WOOD), PATTERN.SPECKLE),
    ...dome(16, 16, 32, [
      { half: 8, chamfer: 3, height: 3 },
      { half: 14, chamfer: 5, height: 5 },
      { half: 15, chamfer: 6, height: 4 },
      { half: 11, chamfer: 4, height: 3, material: m(C.FOLIAGE) },
      { half: 6, chamfer: 2, height: 2, material: m(C.FOLIAGE) },
    ], leaf, PATTERN.FOLIAGE),
    // A hanging vine and a blossom.
    box(24, 24, 26, 2, 2, 10, m(C.FOLIAGE), PATTERN.FOLIAGE),
    box(9, 27, 33, 3, 3, 3, m(C.FLOWER_PINK)),
  ];
});

export const fern = propContent((_kind, m) => {
  const leaf = m(C.JUNGLE_LEAF);
  const light = m(C.FOLIAGE);
  const shapes: Shape[] = [
    box(4, 14, 0, 24, 4, 2, leaf, PATTERN.FOLIAGE),
    box(14, 4, 0, 4, 24, 2, leaf, PATTERN.FOLIAGE),
    box(8, 14, 2, 16, 4, 2, light, PATTERN.FOLIAGE),
    box(14, 8, 2, 4, 16, 2, light, PATTERN.FOLIAGE),
    ...dome(16, 16, 2, [{ half: 5, chamfer: 2, height: 6 }], leaf, PATTERN.FOLIAGE),
  ];
  // Four diagonal fronds, stepping down as they leave the crown.
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    for (let step = 0; step < 3; step += 1) {
      const reach = 4 + 3 * step;
      shapes.push(box(sx < 0 ? 16 - reach - 4 : 16 + reach, sy < 0 ? 16 - reach - 4 : 16 + reach, 0, 4, 4, 4 - step, step === 0 ? light : leaf, PATTERN.FOLIAGE));
    }
  }
  return shapes;
});

export const jungleBloom = propContent((_kind, m) => {
  const leaf = m(C.JUNGLE_LEAF);
  const pink = m(C.FLOWER_PINK);
  return [
    ...dome(16, 16, 0, [
      { half: 11, chamfer: 4, height: 3 },
      { half: 7, chamfer: 3, height: 2 },
    ], leaf, PATTERN.FOLIAGE),
    box(15, 15, 5, 3, 3, 8, leaf, PATTERN.FOLIAGE),
    ...dome(16, 16, 12, [
      { half: 10, chamfer: 3, height: 2, material: pink },
      { half: 8, chamfer: 3, height: 2, material: pink },
      { half: 5, chamfer: 2, height: 1, material: pink },
    ], pink),
    box(13, 13, 17, 6, 6, 2, m(C.BLOOM_YELLOW)),
  ];
});

export const mossyRock = propContent((_kind, m) => {
  const stone = m(C.STONE);
  const moss = m(C.FOLIAGE);
  return [
    ...dome(15, 17, 0, [
      { half: 12, chamfer: 5, height: 5 },
      { half: 13, chamfer: 5, height: 5 },
      { half: 10, chamfer: 4, height: 4 },
    ], stone, PATTERN.SPECKLE),
    ...dome(18, 14, 14, [
      { half: 7, chamfer: 3, height: 3 },
    ], stone, PATTERN.SPECKLE),
    box(6, 6, 12, 14, 12, 2, moss, PATTERN.FOLIAGE),
    box(17, 11, 17, 8, 6, 2, moss, PATTERN.FOLIAGE),
    box(4, 22, 3, 3, 7, 5, moss, PATTERN.FOLIAGE),
  ];
});

export const templeRuin = propContent((_kind, m) => {
  const ruin = m(C.RUIN_STONE);
  const vine = m(C.JUNGLE_LEAF);
  return [
    box(4, 4, 0, 56, 56, 6, ruin, PATTERN.BRICK),
    box(10, 10, 6, 44, 44, 6, ruin, PATTERN.BRICK),
    // The upper tier is broken: a third missing.
    box(16, 16, 12, 32, 20, 8, ruin, PATTERN.BRICK),
    box(16, 36, 12, 18, 12, 5, ruin, PATTERN.BRICK),
    box(26, 22, 20, 14, 14, 6, ruin, PATTERN.BRICK),
    // Corner posts, one snapped.
    box(6, 6, 6, 5, 5, 14, ruin, PATTERN.BRICK),
    box(53, 6, 6, 5, 5, 8, ruin, PATTERN.BRICK),
    box(6, 53, 6, 5, 5, 12, ruin, PATTERN.BRICK),
    box(53, 53, 6, 5, 5, 16, ruin, PATTERN.BRICK),
    // The dark doorway on the front steps.
    box(26, 54, 1, 12, 6, 12, m(C.INK)),
    box(54, 26, 1, 6, 12, 12, m(C.INK)),
    // Vines and moss.
    box(8, 4, 6, 3, 4, 10, vine, PATTERN.FOLIAGE),
    box(40, 4, 6, 3, 4, 7, vine, PATTERN.FOLIAGE),
    box(4, 40, 6, 4, 3, 9, vine, PATTERN.FOLIAGE),
    box(20, 18, 20, 12, 8, 2, vine, PATTERN.FOLIAGE),
    box(28, 24, 26, 10, 8, 2, vine, PATTERN.FOLIAGE),
    box(30, 49, 12, 8, 3, 2, vine, PATTERN.FOLIAGE),
  ];
});
