import type { CoasterPiece } from './design';
import { liftRuns, setLiftRunChained } from './lift';

/**
 * Hand-made coaster layouts shared by the coaster tests (game, centre line, voxel track, train,
 * classic drawing). A layout is written as a start cell, a string of unit moves (E +x, W -x, S +y,
 * N -y; the last move returns to the start cell, so a closed loop of n pieces has n moves) and one
 * height per piece.
 */
export const layoutFromMoves = (
  start: { x: number; y: number },
  moves: string,
  heights: readonly number[],
  specials: Readonly<Record<number, 'loop' | 'boost' | 'launch'>> = {},
): CoasterPiece[] => {
  const pieces: CoasterPiece[] = [];
  let x = start.x;
  let y = start.y;
  for (let index = 0; index < moves.length; index += 1) {
    const special = specials[index];
    pieces.push(special
      ? { cell: { x, y }, height: heights[index] ?? 0, special }
      : { cell: { x, y }, height: heights[index] ?? 0 });
    const move = moves[index];
    if (move === 'E') x += 1;
    else if (move === 'W') x -= 1;
    else if (move === 'S') y += 1;
    else if (move === 'N') y -= 1;
  }
  return pieces;
};

/** 24 pieces, a plain oval: a hill along the top and a drop. Valid for every coaster type. */
export const OVAL_MOVES = `${'E'.repeat(8)}${'S'.repeat(4)}${'W'.repeat(8)}${'N'.repeat(4)}`;
export const OVAL_HEIGHTS: readonly number[] = [
  0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
export const ovalLayout = (start = { x: 4, y: 4 }): CoasterPiece[] =>
  layoutFromMoves(start, OVAL_MOVES, OVAL_HEIGHTS);

/**
 * 32 pieces: a straight station, a stair-step zig-zag (a turn on every piece, left then right)
 * that climbs and falls, and a straight return.
 */
export const ZIGZAG_MOVES = `${'E'.repeat(4)}${'SE'.repeat(5)}${'S'.repeat(2)}${'W'.repeat(9)}${'N'.repeat(7)}`;
export const ZIGZAG_HEIGHTS: readonly number[] = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
export const zigzagLayout = (start = { x: 4, y: 4 }): CoasterPiece[] =>
  layoutFromMoves(start, ZIGZAG_MOVES, ZIGZAG_HEIGHTS);

/** 32 pieces: a tall hill, a dip between two crests, and a low final hill. Heights 0 to 3. */
export const HILL_DIP_MOVES = `${'E'.repeat(12)}${'S'.repeat(4)}${'W'.repeat(12)}${'N'.repeat(4)}`;
export const HILL_DIP_HEIGHTS: readonly number[] = [
  0, 0, 0, 1, 2, 3, 3, 2, 1, 0, 1, 2, 3, 2, 1, 1, 2, 2, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
export const hillDipLayout = (start = { x: 4, y: 4 }): CoasterPiece[] =>
  layoutFromMoves(start, HILL_DIP_MOVES, HILL_DIP_HEIGHTS);

/**
 * The layout with some lifts set free: `which` is 'all' or the indexes (in start order) of the lifts to free.
 * Everything else stays chained.
 */
export const withFreeLifts = (pieces: CoasterPiece[], which: 'all' | readonly number[] = 'all'): CoasterPiece[] => {
  liftRuns(pieces).forEach((run, index) => {
    if (which === 'all' || which.includes(index)) setLiftRunChained(pieces, run.start, false);
  });
  return pieces;
};

/** The hill-dip with the lift out of the station chained and both hills after the dips free (the intended play). */
export const hillDipFreeLayout = (start = { x: 4, y: 4 }): CoasterPiece[] =>
  withFreeLifts(hillDipLayout(start), [1, 2, 3]);

/**
 * The hill-dip mirrored so its station row is the SOUTH row: starting at (x, 5) the station runs along
 * y = 5, right next to the dev park's north street (y = 6), so guests can reach and ride it.
 * `free` frees the three hills after the drops (the intended play); otherwise every lift is chained.
 */
export const hillDipNorthLayout = (free: boolean, start = { x: 8, y: 5 }): CoasterPiece[] => {
  const pieces = layoutFromMoves(start, HILL_DIP_MOVES.replace(/[SN]/g, (move) => (move === 'S' ? 'N' : 'S')), HILL_DIP_HEIGHTS);
  return free ? withFreeLifts(pieces, [1, 2, 3]) : pieces;
};

/** 24 pieces: a station and a single 4-level climb (heights 0 to 4), valid for the Skyline Serpent only. */
export const TALL_HEIGHTS: readonly number[] = [
  0, 0, 0, 1, 2, 3, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
export const tallLayout = (start = { x: 4, y: 4 }): CoasterPiece[] => layoutFromMoves(start, OVAL_MOVES, TALL_HEIGHTS);
/** The tall layout with its 4-level climb out of the station set free: three of its four segments would crawl. */
export const tallFreeLayout = (start = { x: 4, y: 4 }): CoasterPiece[] => withFreeLifts(tallLayout(start));

/** The oval with a loop on straight pieces 5 and 15 and a boost on 19 (type permitting). */
export const loopOvalLayout = (start = { x: 4, y: 4 }): CoasterPiece[] =>
  layoutFromMoves(start, OVAL_MOVES, OVAL_HEIGHTS, { 5: 'loop', 14: 'loop', 18: 'boost' });

/**
 * The longest coaster the designer allows (64 pieces): a station, a staircase of single-tile turns
 * down the middle (a corner on every piece), a long straight, the same staircase back and a
 * straight home, with a sawtooth of hills 0 to 4 under all of it. Valid for the skyline-serpent only
 * (height 4). 40 of the 64 pieces are corners.
 */
export const LONGEST_MOVES = `${'E'.repeat(3)}${'SE'.repeat(10)}${'S'.repeat(9)}${'WN'.repeat(10)}${'W'.repeat(3)}${'N'.repeat(9)}`;
const longestHeights = (): number[] => {
  const wave = [1, 2, 3, 4, 3, 2, 1, 0];
  const heights = Array.from({ length: LONGEST_MOVES.length }, (_unused, index) => (index < 3 ? 0 : wave[(index - 3) % 8]));
  // Come back down to the station level before the loop closes.
  heights[LONGEST_MOVES.length - 3] = 2;
  heights[LONGEST_MOVES.length - 2] = 1;
  heights[LONGEST_MOVES.length - 1] = 0;
  return heights;
};
export const LONGEST_HEIGHTS: readonly number[] = longestHeights();
export const longestLayout = (start = { x: 2, y: 2 }): CoasterPiece[] => layoutFromMoves(start, LONGEST_MOVES, LONGEST_HEIGHTS);

/** Seeded random generator for the fuzz layouts. */
const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * A random self-avoiding closed circuit of `target` pieces (even, at least 4) on a small `size` x `size` grid, found by
 * backtracking (null when none turns up within the search budget). Heights 0 to 4 change by at most one level per piece,
 * and about three in ten straight pieces after the station carry a loop (never two in a row). A shape for property tests, not a valid coaster.
 */
export const randomCircuit = (seed: number, target: number, size: number): CoasterPiece[] | null => {
  const next = seededRandom(seed);
  const used = new Set<number>();
  const path: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  let budget = 20000;
  const key = (x: number, y: number): number => (x + 20) * 100 + (y + 20);
  used.add(key(0, 0));
  const walk = (): boolean => {
    if (budget-- <= 0) return false;
    const head = path[path.length - 1];
    if (path.length === target) return Math.abs(head.x) + Math.abs(head.y) === 1;
    const order = [0, 1, 2, 3].sort(() => next() - 0.5);
    for (const d of order) {
      const x = head.x + DIRS[d][0];
      const y = head.y + DIRS[d][1];
      if (x < 0 || y < 0 || x >= size || y >= size || used.has(key(x, y))) continue;
      path.push({ x, y });
      used.add(key(x, y));
      if (walk()) return true;
      path.pop();
      used.delete(key(x, y));
    }
    return false;
  };
  if (!walk()) return null;
  const heights: number[] = [];
  let height = 0;
  for (let index = 0; index < path.length; index += 1) {
    const roll = next();
    if (index >= 3) height = Math.min(4, Math.max(0, height + (roll < 0.35 ? -1 : roll > 0.65 ? 1 : 0)));
    heights.push(height);
  }
  let lastSpecial = -10;
  // Lower the higher of any two neighbours more than a level apart (round the circuit) until none is: valid steps.
  for (let changed = true; changed;) {
    changed = false;
    for (let index = 0; index < heights.length; index += 1) {
      const after = (index + 1) % heights.length;
      if (heights[index] - heights[after] > 1) { heights[index] = heights[after] + 1; changed = true; }
      else if (heights[after] - heights[index] > 1) { heights[after] = heights[index] + 1; changed = true; }
    }
  }
  return path.map((cell, index): CoasterPiece => {
    const straight = (() => {
      const before = path[(index + path.length - 1) % path.length];
      const after = path[(index + 1) % path.length];
      return after.x - cell.x === cell.x - before.x && after.y - cell.y === cell.y - before.y;
    })();
    const piece: CoasterPiece = { cell: { x: cell.x + 3, y: cell.y + 3 }, height: heights[index] };
    // Like a valid layout: never on the station, at least one plain piece between two specials.
    if (straight && index > 3 && index - lastSpecial >= 2 && next() < 0.3) {
      piece.special = 'loop';
      lastSpecial = index;
    }
    return piece;
  });
};


/** Phase 39 step 2: the oval with a launch on piece 3, the first straight after the station (valid for the launch family). */
export const launchOvalLayout = (start = { x: 4, y: 4 }): CoasterPiece[] =>
  layoutFromMoves(start, OVAL_MOVES, OVAL_HEIGHTS, { 3: 'launch' });
