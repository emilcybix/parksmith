import type { CoasterPiece } from './design';
import {
  HILL_DIP_MOVES, OVAL_MOVES, ZIGZAG_MOVES, hillDipLayout, layoutFromMoves, longestLayout, loopOvalLayout, ovalLayout, tallLayout,
  zigzagLayout,
} from './testLayouts';

/**
 * Phase 58: the layouts the intensity formula is measured and pinned on (`coasterIntensity.review.test.ts`,
 * `intensity.test.ts`). `band` is the intensity the layout should land in: family coasters (low, small drops, wide
 * turns or gentle S-bends) under the nausea floor of 45, mid layouts like the owner's 45-55, and thrill layouts (3
 * levels and more, loops, elements) above every one of those. The numbers behind the bands: BALANCE_NOTES.md
 * ("Phase 58: coaster intensity").
 */
export type IntensityGroup = 'family' | 'owner' | 'mid' | 'thrill';

export interface IntensityFixture {
  readonly name: string;
  readonly group: IntensityGroup;
  readonly typeId: string;
  readonly pieces: () => CoasterPiece[];
  readonly band: readonly [number, number];
}

type Specials = Parameters<typeof layoutFromMoves>[3];

const zeros = (count: number): number[] => Array.from({ length: count }, () => 0);
const heights = (start: readonly number[], count: number): number[] => [...start, ...zeros(count - start.length)];

/** An oval with an S-bend on each long side: a one-piece step aside (two turns the opposite way, one piece apart). */
const S_BEND_MOVES = `${'E'.repeat(4)}S${'E'.repeat(4)}${'S'.repeat(3)}${'W'.repeat(4)}N${'W'.repeat(4)}${'N'.repeat(3)}`;

/** A longer oval with two S-bends on the way out, four straights between them. */
const WIDE_S_MOVES = `${'E'.repeat(6)}S${'E'.repeat(4)}S${'E'.repeat(4)}${'S'.repeat(4)}${'W'.repeat(14)}${'N'.repeat(6)}`;

export const INTENSITY_FIXTURES: readonly IntensityFixture[] = [
  // Family: ground level plus one, or two, with 1-level drops.
  {
    name: 'kiddie oval (height 1, one 1-level drop)', group: 'family', typeId: 'comet-trail', band: [20, 35],
    pieces: () => layoutFromMoves({ x: 4, y: 4 }, OVAL_MOVES, heights([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1], 24)),
  },
  {
    name: 'family oval (height 2, two 1-level drops)', group: 'family', typeId: 'comet-trail', band: [25, 40],
    pieces: () => layoutFromMoves({ x: 4, y: 4 }, OVAL_MOVES, heights([0, 0, 0, 1, 2, 2, 2, 1, 1, 1, 1], 24)),
  },
  {
    name: 'family hills (three 1-level drops, wide turns)', group: 'family', typeId: 'comet-trail', band: [25, 40],
    pieces: () => layoutFromMoves({ x: 4, y: 4 }, HILL_DIP_MOVES, heights([0, 0, 0, 1, 2, 2, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1], 32)),
  },
  {
    name: 'family S-bends (height 1, gentle S-curves)', group: 'family', typeId: 'comet-trail', band: [25, 40],
    pieces: () => layoutFromMoves({ x: 4, y: 4 }, S_BEND_MOVES, heights([0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], S_BEND_MOVES.length)),
  },
  {
    name: 'family wide S (height 2, 1-level drops, wide S-curves)', group: 'family', typeId: 'comet-trail', band: [25, 40],
    pieces: () => layoutFromMoves({ x: 4, y: 4 }, WIDE_S_MOVES, heights([0, 0, 0, 1, 2, 2, 2, 1, 1, 1, 1, 1, 2, 2, 1, 1, 1], WIDE_S_MOVES.length)),
  },
  // The owner's report (2026-10-20): highest point 2, two small drops (3 levels in all), turns all the way.
  {
    name: "owner's layout (height 2, drops of 2 and 1, zig-zag)", group: 'owner', typeId: 'comet-trail', band: [45, 55],
    pieces: () => layoutFromMoves({ x: 4, y: 4 }, ZIGZAG_MOVES, heights([0, 0, 0, 0, 1, 2, 2, 1, 0, 0, 1, 1, 0], 32)),
  },
  // Mid: the existing pinned layouts.
  { name: 'oval (one 2-level drop)', group: 'mid', typeId: 'comet-trail', band: [30, 45], pieces: () => ovalLayout() },
  { name: 'zig-zag (height 3, turns on every piece)', group: 'mid', typeId: 'star-chaser', band: [40, 55], pieces: () => zigzagLayout() },
  { name: 'hill and dip (3-level drop and two 2s)', group: 'thrill', typeId: 'star-chaser', band: [60, 75], pieces: () => hillDipLayout() },
  // Thrill.
  { name: 'tall (one 4-level drop)', group: 'thrill', typeId: 'skyline-serpent', band: [60, 75], pieces: () => tallLayout() },
  { name: 'loops and a boost', group: 'thrill', typeId: 'skyline-serpent', band: [60, 75], pieces: () => loopOvalLayout() },
  { name: 'longest (sawtooth 0-4, 40 corners)', group: 'thrill', typeId: 'skyline-serpent', band: [95, 100], pieces: () => longestLayout() },
  {
    name: 'elements (3-level drop, corkscrew, zero-g roll)', group: 'thrill', typeId: 'skyline-serpent', band: [65, 80],
    pieces: () => layoutFromMoves({ x: 2, y: 2 }, `${'E'.repeat(10)}${'S'.repeat(4)}${'W'.repeat(10)}${'N'.repeat(4)}`,
      [0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 2, 1, 0], { 16: 'corkscrew', 20: 'zero-g-roll' } as unknown as Specials),
  },
  {
    name: 'hyper (one 10-level drop)', group: 'thrill', typeId: 'titan-hyper', band: [85, 100],
    pieces: () => layoutFromMoves({ x: 2, y: 2 }, `${'E'.repeat(18)}SS${'W'.repeat(18)}NN`,
      [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 1, 0]),
  },
];
