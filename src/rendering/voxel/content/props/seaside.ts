import type { Shape } from '../../contracts/blueprint';
import { PATTERN } from '../../contracts/palette';
import { C } from './colours';
import { box, dome, propContent, segment } from './kit';

/** Seaside props: palm, dune grass, driftwood (2x1), the sea stack (2x2, permanent), the tide rock and the boardwalk pier (permanent, stands on water). Sun-bleached, with a pink accent. */

export const palmTree = propContent((_kind, m) => {
  const trunk = m(C.PALM_TRUNK);
  const frond = m(C.FOLIAGE);
  const shapes: Shape[] = [
    box(11, 12, 0, 9, 9, 3, trunk, PATTERN.SPECKLE),
    // A trunk that leans a voxel or two toward +x every step, in rings.
    box(13, 14, 3, 6, 6, 8, trunk, PATTERN.SPECKLE),
    box(14, 14, 11, 6, 6, 8, m(C.TIMBER), PATTERN.SPECKLE),
    box(15, 14, 19, 5, 5, 8, trunk, PATTERN.SPECKLE),
    box(16, 14, 27, 5, 5, 5, m(C.TIMBER), PATTERN.SPECKLE),
    // The crown: a hub and four drooping fronds, each a fat segment.
    ...dome(18, 16, 31, [{ half: 4, chamfer: 1, height: 3 }], frond, PATTERN.FOLIAGE),
    segment([18, 16, 33], [3, 16, 27], 2.2, frond, PATTERN.FOLIAGE),
    segment([18, 16, 33], [30, 16, 27], 2.2, frond, PATTERN.FOLIAGE),
    segment([18, 16, 33], [18, 3, 27], 2.2, frond, PATTERN.FOLIAGE),
    segment([18, 16, 33], [18, 29, 27], 2.2, frond, PATTERN.FOLIAGE),
    segment([18, 16, 34], [18, 16, 38], 1.5, frond, PATTERN.FOLIAGE),
    // Coconuts under the hub.
    box(15, 18, 29, 3, 3, 3, m(C.TIMBER)),
    box(20, 14, 29, 3, 3, 3, m(C.TIMBER)),
  ];
  return shapes;
});

export const duneGrass = propContent((_kind, m) => {
  const sand = m(C.SAND);
  const grass = m(C.FOLIAGE);
  return [
    ...dome(16, 16, 0, [
      { half: 10, chamfer: 4, height: 1 },
      { half: 8, chamfer: 3, height: 2 },
      { half: 5, chamfer: 2, height: 1 },
    ], sand, PATTERN.SPECKLE),
    segment([16, 16, 4], [8, 12, 13], 1.4, grass),
    segment([16, 16, 4], [23, 12, 14], 1.4, grass),
    segment([16, 16, 4], [12, 24, 12], 1.4, grass),
    segment([16, 16, 4], [22, 23, 13], 1.4, grass),
    segment([16, 16, 4], [16, 14, 16], 1.4, grass),
    box(15, 23, 1, 2, 3, 2, m(C.FLOWER_PINK)),
  ];
});

export const driftwood = propContent((_kind, m) => {
  const wood = m(C.DRIFTWOOD);
  const dark = m(C.TIMBER);
  return [
    { kind: 'cylinder', base: [4, 15, 5], radius: 5, length: 52, axis: 'x', material: wood, pattern: PATTERN.PLANKS } as Shape,
    { kind: 'cylinder', base: [54, 15, 5], radius: 4, length: 4, axis: 'x', material: dark, pattern: PATTERN.SPECKLE } as Shape,
    segment([24, 15, 6], [40, 24, 17], 2.4, wood, PATTERN.PLANKS),
    segment([36, 15, 6], [52, 8, 15], 2, wood, PATTERN.PLANKS),
    box(10, 20, 0, 6, 4, 2, dark, PATTERN.SPECKLE),
    box(44, 21, 0, 8, 4, 2, dark, PATTERN.SPECKLE),
  ];
});

export const seaStack = propContent((_kind, m) => {
  const rock = m(C.SEA_ROCK);
  return [
    ...dome(32, 32, 0, [
      { half: 25, chamfer: 9, height: 8 },
      { half: 21, chamfer: 8, height: 10 },
      { half: 17, chamfer: 7, height: 12 },
      { half: 13, chamfer: 5, height: 10 },
      { half: 10, chamfer: 4, height: 8 },
    ], rock, PATTERN.SPECKLE),
    // A white crest of sea-bird droppings and foam.
    ...dome(32, 32, 48, [
      { half: 9, chamfer: 4, height: 3, material: m(C.WHITE) },
      { half: 5, chamfer: 2, height: 3, material: m(C.WHITE) },
    ], m(C.WHITE), PATTERN.SPECKLE),
    box(50, 30, 6, 3, 8, 4, m(C.WHITE)),
  ];
});

/** A low wet rock: two stepped layers of sea-rock with a white foam collar and a pale cap. */
export const tideRock = propContent((_kind, m) => {
  const rock = m(C.SEA_ROCK);
  const white = m(C.WHITE);
  return [
    ...dome(16, 16, 0, [
      { half: 12, chamfer: 5, height: 3, material: white },
      { half: 10, chamfer: 4, height: 4 },
      { half: 7, chamfer: 3, height: 4 },
      { half: 4, chamfer: 2, height: 2 },
    ], rock, PATTERN.SPECKLE),
    box(19, 12, 10, 3, 3, 1, white),
  ];
});

/**
 * One cell of boardwalk: a full-cell plank deck (neighbouring cells join into one walkway whichever way it runs), on four
 * posts, with a rope bollard at each of two corners. Stands on water at z 0, so the posts show above the surface.
 */
export const boardwalkPier = propContent((_kind, m) => {
  const plank = m(C.WOOD);
  const post = m(C.TIMBER);
  return [
    box(2, 2, 0, 4, 4, 5, post, PATTERN.SPECKLE),
    box(26, 2, 0, 4, 4, 5, post, PATTERN.SPECKLE),
    box(2, 26, 0, 4, 4, 5, post, PATTERN.SPECKLE),
    box(26, 26, 0, 4, 4, 5, post, PATTERN.SPECKLE),
    box(0, 0, 5, 32, 32, 3, plank, PATTERN.PLANKS),
    box(1, 1, 8, 3, 3, 3, post),
    box(28, 28, 8, 3, 3, 3, post),
  ];
});
