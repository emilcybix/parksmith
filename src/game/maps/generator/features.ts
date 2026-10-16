import { FACING_VECTORS, GROUND_ALT, GROUND_BASE, GROUND_WATER, type Facing } from '../types';
import { CELLS, SIZE, indexOf, inside, tryPlace, RESERVED_HALO, type MapDraft } from './draft';
import type { Noise } from './noise';

/**
 * The shared building blocks of the biome recipes: frame helpers, blobs, bands, water smoothing, the water cap.
 * Everything is integer; every random value is a positional hash of the map's salt.
 */

export type Side = 'N' | 'E' | 'S' | 'W';
export const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
/** The border guests walk toward when they enter facing `facing`. */
export const FAR_SIDE: Readonly<Record<Facing, Side>> = { north: 'N', east: 'E', south: 'S', west: 'W' };
export const ADJACENT_SIDES: Readonly<Record<Side, readonly [Side, Side]>> = { N: ['E', 'W'], S: ['E', 'W'], E: ['N', 'S'], W: ['N', 'S'] };

/** Distance from `side`'s border: 0 on the border row or column. */
export const sideDistance = (side: Side, x: number, y: number): number => (
  side === 'N' ? y : side === 'S' ? SIZE - 1 - y : side === 'W' ? x : SIZE - 1 - x
);
/** The coordinate along `side`'s border. */
export const sideAlong = (side: Side, x: number, y: number): number => (side === 'N' || side === 'S' ? x : y);

/** Tags for positional hashes: every feature and rule owns a distinct block so reordering code cannot change a result. */
export const TAG = {
  facing: 0x100, gate: 0x101, alt: 0x110,
  seaExtra: 0x120, seaAdj: 0x121, seaDepth: 0x122, seaBeach: 0x126, seaShore: 0x130, seaBeachEdge: 0x138, lagoon: 0x140, pier: 0x150, islet: 0x160,
  pond: 0x200, brook: 0x210, grove: 0x220, ice: 0x230, ring: 0x240, clearing: 0x250, river: 0x260, bridge: 0x270, stream: 0x280, ford: 0x290,
  wall: 0x300, pass: 0x330, paddock: 0x360, ruin: 0x390, wobble: 0x3a0,
  rules: 0x1000,
} as const;

export interface GenContext {
  readonly draft: MapDraft;
  readonly noise: Noise;
  /** 0 low, 1 normal, 2 high. */
  readonly density: 0 | 1 | 2;
  readonly water: boolean;
  readonly facing: Facing;
  /** The gate's position along its border (6..25). */
  readonly gateAlong: number;
}

/** The world cell index at lateral `l` and depth `d` of the entrance frame, or -1 outside the map. */
export const cellAt = (ctx: GenContext, l: number, d: number): number => {
  const { x, y } = ctx.draft.frame.toWorld(l, d);
  return inside(x, y) ? indexOf(x, y) : -1;
};

/** +1 when lateral grows with the along-border coordinate (north and east gates), else -1 (south and west gates). */
export const laneSign = (ctx: GenContext): 1 | -1 => (ctx.draft.frame.right.x + ctx.draft.frame.right.y > 0 ? 1 : -1);

/** The lateral (entrance frame) coordinate of the absolute along-border position `lane`. */
export const lateralOfLane = (ctx: GenContext, lane: number): number => (lane - ctx.gateAlong) * laneSign(ctx);

export const waterCount = (draft: MapDraft): number => {
  let count = 0;
  for (let index = 0; index < CELLS; index += 1) if (draft.ground[index] === GROUND_WATER) count += 1;
  return count;
};

/** Water never exceeds 30 % of the map (the cleared-area target of 640 needs land; the hand-made maps hold at most 30.4 %). */
/** At most 30 % of the map is water (of the map in progress: see draft.ts SIZE). */
export const waterCap = (): number => Math.floor((CELLS * 3) / 10);

/** Two passes of integer cellular smoothing: a cell becomes water with >= 5 of its 8 neighbours water, stops with <= 2. */
export const smoothWater = (draft: MapDraft): void => {
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Uint8Array(draft.ground);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        let around = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if ((dx !== 0 || dy !== 0) && inside(x + dx, y + dy) && draft.ground[indexOf(x + dx, y + dy)] === GROUND_WATER) around += 1;
          }
        }
        const index = indexOf(x, y);
        if (draft.ground[index] === GROUND_WATER) {
          if (around <= 2) next[index] = GROUND_BASE;
        } else if (around >= 5) {
          next[index] = GROUND_WATER;
        }
      }
    }
    draft.ground.set(next);
  }
};

/** No water in the halo around the First Day apron, and the gate itself is base ground. */
export const clearHalo = (draft: MapDraft): void => {
  for (let index = 0; index < CELLS; index += 1) {
    if ((draft.reserved[index] & RESERVED_HALO) !== 0 && draft.ground[index] === GROUND_WATER) draft.ground[index] = GROUND_BASE;
  }
  draft.ground[indexOf(draft.gate.x, draft.gate.y)] = GROUND_BASE;
};

/**
 * Builds a water feature at full strength first and then with the depth parameter reduced one step at a time (at
 * most 8 steps) until the water covers at most 30 % of the map. `build(shrink)` must start from all-base ground.
 */
export const withWaterCap = (draft: MapDraft, build: (shrink: number) => void): void => {
  for (let shrink = 0; shrink <= 8; shrink += 1) {
    draft.ground.fill(GROUND_BASE);
    build(shrink);
    if (waterCount(draft) <= waterCap()) return;
  }
};

/** Cells of a wobbly disc around (cx, cy) with mean radius r (integers only): d2 * 256 <= r * r * (192 + noise 0..127). */
export const blobCells = (noise: Noise, tag: number, cx: number, cy: number, r: number): number[] => {
  const cells: number[] = [];
  for (let y = cy - r - 2; y <= cy + r + 2; y += 1) {
    for (let x = cx - r - 2; x <= cx + r + 2; x += 1) {
      if (!inside(x, y)) continue;
      const dx = x - cx;
      const dy = y - cy;
      const factor = 192 + (noise.fbm(tag, x + 64, y + 64) >> 9);
      if ((dx * dx + dy * dy) * 256 <= r * r * factor) cells.push(indexOf(x, y));
    }
  }
  return cells;
};

/** Marks `ground` for every base cell within Chebyshev distance `radius` of water as alt (a sand rim). */
export const rimWithAlt = (draft: MapDraft, radius: number): void => {
  const rim: number[] = [];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const index = indexOf(x, y);
      if (draft.ground[index] !== GROUND_BASE) continue;
      let near = false;
      for (let dy = -radius; dy <= radius && !near; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (inside(x + dx, y + dy) && draft.ground[indexOf(x + dx, y + dy)] === GROUND_WATER) { near = true; break; }
        }
      }
      if (near) rim.push(index);
    }
  }
  for (const index of rim) draft.ground[index] = GROUND_ALT;
};

/**
 * A meandering band across the whole map perpendicular to the inward axis: for each lane the band covers depths
 * centre(l) .. centre(l) + width - 1; lanes whose centres differ are joined so the band stays 4-connected.
 * `skip(laneAbsolute)` leaves a gap (a bridge or a ford). Returns the cells.
 */
export const bandAcross = (ctx: GenContext, centre: (lane: number) => number, width: number, skip: (lane: number) => boolean): number[] => {
  const cells: number[] = [];
  let previous: number | null = null;
  for (let lane = 0; lane < SIZE; lane += 1) {
    const l = lateralOfLane(ctx, lane);
    const c = centre(lane);
    const from = previous === null ? c : Math.min(previous, c);
    const to = previous === null ? c : Math.max(previous, c);
    previous = c;
    if (skip(lane)) continue;
    for (let d = from; d <= to + width - 1; d += 1) {
      const index = cellAt(ctx, l, d);
      if (index >= 0) cells.push(index);
    }
  }
  return cells;
};

/** Places `kind` on each cell of a line in the entrance frame (lateral l, depth from..to) that accepts it. */
export const placeLine = (ctx: GenContext, kind: Parameters<typeof tryPlace>[1], cells: ReadonlyArray<readonly [number, number]>): void => {
  for (const [l, d] of cells) {
    const { x, y } = ctx.draft.frame.toWorld(l, d);
    if (inside(x, y)) tryPlace(ctx.draft, kind, x, y);
  }
};

export const facingVector = (facing: Facing): Readonly<{ x: number; y: number }> => FACING_VECTORS[facing];
