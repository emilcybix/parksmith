import { hash32 } from '../../weather/random';

/**
 * Integer noise for the map generator (Phase 24 step 2). No Math.random, no Date, no floating point in any result:
 * every value is a uint32 hash or an exact integer built from it, so the output is identical in every engine and
 * in every evaluation order (each random decision is a POSITIONAL hash, never a sequential stream).
 */

export const GEN_SALT = 0x6d617073; // 'maps'

/** Largest lattice cell shift in use (cells of 16). */
const MAX_SHIFT = 5;

/** SMOOTH[s][f] = floor(f*f*(3*cell - 2*f) * 256 / cell^3) for f in 0..cell: an exact integer smoothstep, 0..256. */
const SMOOTH: Int32Array[] = Array.from({ length: MAX_SHIFT + 1 }, (_, shift) => {
  const cell = 1 << shift;
  const table = new Int32Array(cell + 1);
  for (let f = 0; f <= cell; f += 1) {
    const numerator = f * f * (3 * cell - 2 * f) * 256;
    const denominator = cell * cell * cell;
    table[f] = (numerator - (numerator % denominator)) / denominator;
  }
  return table;
});

export type Octaves = readonly (readonly [shift: number, weight: number])[];
export const DEFAULT_OCTAVES: Octaves = [[4, 4], [3, 2], [2, 1]];

export interface Noise {
  /** A uint32 hash of (tag, a, b) under this map's salt. */
  h(tag: number, a: number, b: number): number;
  /** Lattice value noise at integer (x, y), 0..65535. */
  value(tag: number, x: number, y: number, shift: number): number;
  fbm(tag: number, x: number, y: number, octaves?: Octaves): number;
  /** A 1-D smooth offset in -amp..+amp along t. */
  meander(tag: number, t: number, shift: number, amp: number): number;
  /** h(tag, 0, 0) % n. */
  pick(tag: number, n: number): number;
  /** lo + h(tag, 0, 0) % (hi - lo + 1). */
  range(tag: number, lo: number, hi: number): number;
}

export const makeNoise = (salt: number): Noise => {
  const h = (tag: number, a: number, b: number): number => hash32((salt ^ tag) >>> 0, a, b);
  const lattice = (tag: number, ix: number, iy: number): number => h(tag, ix, iy) >>> 16;
  const value = (tag: number, x: number, y: number, shift: number): number => {
    const cell = 1 << shift;
    const ix = x >> shift;
    const iy = y >> shift;
    const tx = SMOOTH[shift][x & (cell - 1)];
    const ty = SMOOTH[shift][y & (cell - 1)];
    const a = lattice(tag, ix, iy);
    const b = lattice(tag, ix + 1, iy);
    const c = lattice(tag, ix, iy + 1);
    const d = lattice(tag, ix + 1, iy + 1);
    const top = a * (256 - tx) + b * tx;
    const bottom = c * (256 - tx) + d * tx;
    const total = top * (256 - ty) + bottom * ty; // < 2^32 and an exact double
    return (total - (total % 65536)) / 65536;
  };
  const fbm = (tag: number, x: number, y: number, octaves: Octaves = DEFAULT_OCTAVES): number => {
    let sum = 0;
    let weights = 0;
    octaves.forEach(([shift, weight], index) => {
      sum += weight * value(tag + index, x, y, shift);
      weights += weight;
    });
    return (sum - (sum % weights)) / weights;
  };
  return {
    h,
    value,
    fbm,
    meander: (tag, t, shift, amp) => ((value(tag, t, 0, shift) - 32768) * amp) >> 15,
    pick: (tag, n) => h(tag, 0, 0) % n,
    range: (tag, lo, hi) => lo + (h(tag, 0, 0) % (hi - lo + 1)),
  };
};
