import { BOX_FLOATS, OUTLINE_GROUP_LIMIT, packBoxWord } from '../contracts/boxes';
import type { BoxWriter } from '../contracts/boxes';
import type { LitterEmitter } from '../contracts/content';
import { MAT_COLOR, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { PATH_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';

/**
 * Litter piles on path cells (design §12: cup 2×2×3, wrapper 3×3×1): upright cups and flat wrappers
 * lying on the paving, scattered around the cell centre by a hash of the cell and more of them the
 * more units the pile holds.
 *
 * A pile grows the way the legacy one does (WorldRenderer draws it scaled by 0.8 + min(0.8,
 * units · 0.09)), but by adding pieces instead of scaling them: voxels have one size. The piece count
 * follows the scale's AREA — two pieces for one unit, like the legacy art's one wrapper and one cup,
 * up to eight at full scale — and each piece lands a little farther out than the one before, so a
 * pile spreads as it grows while every piece already lying there stays put: piece i depends only on
 * the cell and on pieces 0..i−1, never on the unit count. Piles change whenever a guest drops
 * something or a cleaner sweeps, so the emitter allocates nothing: candidates come from a stateless
 * integer hash, and overlaps are checked against the pile's own boxes already in `out`.
 */

/** Cup (art bible): upright, 2×2 and 3 voxels tall. */
export const LITTER_CUP_SIZE: readonly [number, number, number] = [2, 2, 3];
/** Wrapper (art bible): flat, 3×3 and 1 voxel tall. */
export const LITTER_WRAPPER_SIZE: readonly [number, number, number] = [3, 3, 1];

/**
 * The square (tile-local voxels, both axes) every piece stays inside: the entrance gate's walkway
 * between its plinths (x from 8 to 23, the gate being centred on 15.5), used on both axes of every
 * path tile. It keeps clear of everything the static world stands on a path tile: the 1-voxel curb
 * ring, coaster supports 11 voxels off the tile centre, and the gate's plinths. Litter is dynamic
 * geometry drawn over the static chunks, so sharing a voxel with any of them would z-fight.
 */
export const LITTER_AREA_MIN = 8;
export const LITTER_AREA_MAX = 23;

/** Free voxels kept between any two pieces, so neighbouring pieces never merge into one blob. */
export const LITTER_PIECE_GAP = 1;

/**
 * Litter is not an object, but it takes an outline group of its own (not the ground's 0) so the
 * composite draws a one-texel id contour around every piece where it meets the paving: a 1-voxel
 * wrapper has no silhouette edge (contracts/gbuffer.ts: a 1-voxel step stays unoutlined), and the
 * contour does what the legacy art's stroke did. Objects with this group (ids 254, 509, …) stand on
 * plots, never inside a path tile's litter square, so no piece ever touches one.
 */
export const LITTER_OUTLINE_GROUP = OUTLINE_GROUP_LIMIT - 1;

/** WorldRenderer's legacy pile scale: 0.8 + min(0.8, units · 0.09). */
const LEGACY_BASE_SCALE = 0.8;
const LEGACY_MAX_GROWTH = 0.8;
const LEGACY_GROWTH_PER_UNIT = 0.09;
/** Pieces of a pile at the legacy base scale: one wrapper and one cup, like the legacy art. */
const PIECES_AT_BASE_SCALE = 2;

/** The legacy pile's drawing scale for `units`. */
export const litterScale = (units: number): number =>
  LEGACY_BASE_SCALE + Math.min(LEGACY_MAX_GROWTH, Math.max(0, units) * LEGACY_GROWTH_PER_UNIT);

/** Pieces a pile of `units` shows: two at the base scale, growing with the scale's area to eight. */
export const litterPieceCount = (units: number): number =>
  units <= 0 ? 0 : Math.round(PIECES_AT_BASE_SCALE * (litterScale(units) / LEGACY_BASE_SCALE) ** 2);

/**
 * How far (voxels, both axes) from the middle of the litter square piece i may land: the first
 * pieces cluster in the middle, later ones spread out to the square's edge.
 */
const FIRST_SCATTER = 2;
const SCATTER_STEP = 1.5;
const MAX_SCATTER = Math.floor((LITTER_AREA_MAX - LITTER_AREA_MIN) / 2);
/** Random candidates tried per piece before a deterministic scan of the whole square. */
const ATTEMPTS = 24;
/** Hashes one piece draws: its kind, its candidates, and where its scan starts. */
const HASHES_PER_PIECE = ATTEMPTS + 2;
/** A piece's corner inside the square packed as (y << 8) | x (square-local); NOT_PLACED if none. */
const NOT_PLACED = -1;

/** murmur3's 32-bit finaliser: every input bit flips about half the output bits. */
const finalize = (value: number): number => {
  let hash = value | 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85eb_ca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2_ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

const cellSeed = (cellX: number, cellY: number): number =>
  finalize(Math.imul(cellX, 0x9e37_79b1) ^ Math.imul(cellY + 0x632b_e5ab, 0x85eb_ca77));

/**
 * Hash of one decision about piece `piece` of a pile: `slot` 0 picks its kind, 1..ATTEMPTS its
 * candidates, ATTEMPTS + 1 its scan start. Slots never overlap between pieces, so no two decisions
 * share a hash.
 */
const pieceHash = (seed: number, piece: number, slot: number): number =>
  finalize(seed ^ Math.imul(piece * HASHES_PER_PIECE + slot + 1, 0x27d4_eb2f));

/**
 * Cup or wrapper. The first two pieces are one of each, so even the smallest pile shows both, as the
 * legacy art did; which comes first, and every later kind, is up to the hash.
 */
const isCup = (seed: number, piece: number): boolean => {
  if (piece === 1) return (pieceHash(seed, 0, 0) & 1) === 0;
  return (pieceHash(seed, piece, 0) & 1) === 1;
};

/** Whether a square piece at world (x, y) of side `size` keeps LITTER_PIECE_GAP from the pile's boxes. */
const fits = (out: BoxWriter, firstBox: number, x: number, y: number, size: number): boolean => {
  const data = out.data;
  for (let box = firstBox; box < out.count; box += 1) {
    const at = box * BOX_FLOATS;
    const otherX = data[at];
    const otherY = data[at + 1];
    if (x < otherX + data[at + 4] + LITTER_PIECE_GAP && otherX < x + size + LITTER_PIECE_GAP
      && y < otherY + data[at + 5] + LITTER_PIECE_GAP && otherY < y + size + LITTER_PIECE_GAP) {
      return false;
    }
  }
  return true;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Where piece `piece` of side `size` goes in the square whose minimum corner is world (minX, minY):
 * hashed candidates within the piece's scatter of the middle first, then — when the pile is crowded —
 * the first free corner of a scan from a hashed start. Returns the packed square-local corner.
 */
const findCorner = (out: BoxWriter, firstBox: number, seed: number, piece: number, size: number, minX: number, minY: number): number => {
  const corners = LITTER_AREA_MAX - LITTER_AREA_MIN - size + 1;
  const middle = (corners - 1) >> 1;
  const scatter = Math.floor(Math.min(MAX_SCATTER, FIRST_SCATTER + piece * SCATTER_STEP));
  const span = 2 * scatter + 1;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const hash = pieceHash(seed, piece, attempt);
    const x = clamp(middle + ((hash & 0xffff) % span) - scatter, 0, corners - 1);
    const y = clamp(middle + ((hash >>> 16) % span) - scatter, 0, corners - 1);
    if (fits(out, firstBox, minX + x, minY + y, size)) return (y << 8) | x;
  }
  const start = pieceHash(seed, piece, ATTEMPTS + 1) % (corners * corners);
  for (let step = 0; step < corners * corners; step += 1) {
    const index = (start + step) % (corners * corners);
    const x = index % corners;
    const y = Math.floor(index / corners);
    if (fits(out, firstBox, minX + x, minY + y, size)) return (y << 8) | x;
  }
  return NOT_PLACED;
};

/**
 * The pile at path cell (cellX, cellY), appended to `out` in world voxels. Deterministic from the
 * cell and the unit count; colours come through the palette like every plain content colour. A
 * wrapper that finds no room in a crowded pile drops as a cup instead, which needs a smaller gap.
 */
/**
 * Phase 29: what someone being sick leaves — a flat, lumpy puddle in the middle of the litter square, a bigger and a
 * smaller patch, laid down before the pieces so they scatter around it.
 */
export const SICK_COLOUR = 0xe8d44d;

const sickPuddle = (minX: number, minY: number, palette: Palette, out: BoxWriter): void => {
  const word = packBoxWord(palette.material(SICK_COLOUR), LITTER_OUTLINE_GROUP, PATTERN.PLAIN, 0);
  out.push(minX + 4, minY + 5, PATH_TOP_Z, 6, 4, 1, word);
  out.push(minX + 6, minY + 9, PATH_TOP_Z, 3, 2, 1, word);
};

export const litterEmitter: LitterEmitter = (cellX, cellY, units, palette, out, sick = false) => {
  const count = litterPieceCount(units);
  if (count === 0) return;
  const cupWord = packBoxWord(palette.material(MAT_COLOR.LITTER_CUP), LITTER_OUTLINE_GROUP, PATTERN.PLAIN, 0);
  const wrapperWord = packBoxWord(palette.material(MAT_COLOR.LITTER_WRAPPER), LITTER_OUTLINE_GROUP, PATTERN.PLAIN, 0);
  const minX = cellX * VOXELS_PER_TILE + LITTER_AREA_MIN;
  const minY = cellY * VOXELS_PER_TILE + LITTER_AREA_MIN;
  const seed = cellSeed(cellX, cellY);
  const firstBox = out.count;
  // The puddle goes in first, inside the pile's own boxes, so every piece keeps its gap from it.
  if (sick) sickPuddle(minX, minY, palette, out);
  for (let piece = 0; piece < count; piece += 1) {
    let cup = isCup(seed, piece);
    let corner = findCorner(out, firstBox, seed, piece, cup ? LITTER_CUP_SIZE[0] : LITTER_WRAPPER_SIZE[0], minX, minY);
    if (corner === NOT_PLACED && !cup) {
      cup = true;
      corner = findCorner(out, firstBox, seed, piece, LITTER_CUP_SIZE[0], minX, minY);
    }
    if (corner === NOT_PLACED) continue;
    const size = cup ? LITTER_CUP_SIZE : LITTER_WRAPPER_SIZE;
    out.push(minX + (corner & 0xff), minY + (corner >>> 8), PATH_TOP_Z, size[0], size[1], size[2], cup ? cupWord : wrapperWord);
  }
};
