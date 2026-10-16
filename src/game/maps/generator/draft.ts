import { GAME_CONFIG } from '../../config';
import { entranceFrame, type EntranceFrame } from '../frame';
import { PROP_KIND_BY_ID, type PropKindDefinition, type PropKindId } from '../props';
import { GROUND_WATER, type MapEntrance } from '../types';
import { CHUNK_TILES, weightPerCell } from './weights';

/**
 * The mutable working copy of a generated map: ground bytes, the prop list, an occupancy grid and the caps
 * counters. `tryPlace` is the ONLY way a prop enters a draft, so the per-chunk cell cap, the per-chunk and
 * per-map box-weight caps, the prop-count cap, the reserved gate zones and the surface rule hold by construction.
 * Repair only ever removes props (`removeProp`), so it can never break a cap.
 */

/**
 * The side of the map being generated. A live binding: `generateMap` sets it for one synchronous run (32, or 64 for a
 * Phase 21 estate) and puts the classic 32 back, so every module reads the size of the map in progress. The 32 x 32
 * output is unchanged by this (the golden corpus pins it).
 */
export let SIZE: number = GAME_CONFIG.mapWidth;
export let CELLS = SIZE * SIZE;
let CHUNKS_PER_ROW = Math.ceil(SIZE / CHUNK_TILES);

/** Sets the generated map's side (see SIZE). Only `generateMap` calls it, around one run. */
export const setDraftSize = (size: number): void => {
  SIZE = size;
  CELLS = size * size;
  CHUNKS_PER_ROW = Math.ceil(size / CHUNK_TILES);
};

/** A cap of the classic map scaled by the area of the map in progress (exact on 32 x 32). */
export const areaCap = (cap: number): number => Math.round((cap * CELLS) / (GAME_CONFIG.mapWidth * GAME_CONFIG.mapHeight));

/** reserved bits: the First Day apron (no props, no water) and the halo around it (no props, no water). */
export const RESERVED_APRON = 1;
export const RESERVED_HALO = 2;

export interface DraftProp {
  readonly kind: PropKindId;
  readonly x: number;
  readonly y: number;
  /** 0 or 1 for a 2x1 prop (1 lies along y); 0 for every other kind (the parser derives a 1x1 rotation from the seed). */
  readonly rotation: 0 | 1;
}

export interface MapDraft {
  readonly gate: MapEntrance;
  readonly frame: EntranceFrame;
  /** 0 base, 1 alt, 2 water; the ground UNDER props included. */
  readonly ground: Uint8Array;
  /** Prop index + 1 per footprint cell, 0 = free. */
  readonly occupancy: Int16Array;
  /** Removed props are null (indices stay stable). */
  readonly props: Array<DraftProp | null>;
  readonly reserved: Uint8Array;
  /** Features mark regions the rules read: forest (dense trees) and far (beyond a river or mud band). */
  readonly forest: Uint8Array;
  readonly far: Uint8Array;
  readonly chunkCells: Int32Array;
  readonly chunkWeight: Int32Array;
  totalWeight: number;
  count: number;
}

export const indexOf = (x: number, y: number): number => y * SIZE + x;
export const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < SIZE && y < SIZE;
const chunkOf = (x: number, y: number): number => (y >> 3) * CHUNKS_PER_ROW + (x >> 3);

export const footprintSize = (kind: PropKindDefinition, rotation: number): readonly [number, number] => (
  rotation % 2 === 0 ? kind.footprint : [kind.footprint[1], kind.footprint[0]]
);

export const createDraft = (gate: MapEntrance): MapDraft => {
  const frame = entranceFrame(gate);
  const reserved = new Uint8Array(CELLS);
  for (let d = 0; d <= 12; d += 1) {
    for (let l = -3; l <= 4; l += 1) {
      const cell = frame.toWorld(l, d);
      if (!inside(cell.x, cell.y)) continue;
      const apron = d < GAME_CONFIG.maps.firstDayApron.depth && l >= GAME_CONFIG.maps.firstDayApron.lateral[0] && l <= GAME_CONFIG.maps.firstDayApron.lateral[1];
      reserved[indexOf(cell.x, cell.y)] |= RESERVED_HALO | (apron ? RESERVED_APRON : 0);
    }
  }
  return {
    gate,
    frame,
    ground: new Uint8Array(CELLS),
    occupancy: new Int16Array(CELLS),
    props: [],
    reserved,
    forest: new Uint8Array(CELLS),
    far: new Uint8Array(CELLS),
    chunkCells: new Int32Array(CHUNKS_PER_ROW * CHUNKS_PER_ROW),
    chunkWeight: new Int32Array(CHUNKS_PER_ROW * CHUNKS_PER_ROW),
    totalWeight: 0,
    count: 0,
  };
};

/** Calls `visit` for each footprint cell; stops early when it returns false. */
export const footprintCells = (kind: PropKindDefinition, x: number, y: number, rotation: number, visit: (cx: number, cy: number) => boolean | void): void => {
  const [w, d] = footprintSize(kind, rotation);
  for (let dy = 0; dy < d; dy += 1) {
    for (let dx = 0; dx < w; dx += 1) {
      if (visit(x + dx, y + dy) === false) return;
    }
  }
};

const isTwoByOne = (kind: PropKindDefinition): boolean => kind.footprint[0] * kind.footprint[1] === 2;

/**
 * The placement rules: inside the map; free; not in the apron or halo; on the kind's surface (land or water);
 * caps (chunk cells, chunk weight, map weight, prop count); a 2x1 prop never 4-adjacent to another 2x1 prop (the
 * ASCII parser pairs `L` greedily) and a 2x2 prop never 4-adjacent to another 2x2 (keeps the squares unambiguous).
 */
export const tryPlace = (draft: MapDraft, kindId: PropKindId, x: number, y: number, rotation: 0 | 1 = 0): boolean => {
  const kind = PROP_KIND_BY_ID.get(kindId) as PropKindDefinition;
  if (draft.count >= areaCap(GAME_CONFIG.maps.generator.maxGeneratedProps)) return false;
  const cellWeight = weightPerCell(kindId);
  const footprintArea = kind.footprint[0] * kind.footprint[1];
  if (draft.totalWeight + cellWeight * footprintArea > areaCap(GAME_CONFIG.maps.generator.mapPropWeightCap)) return false;
  const addCells = new Map<number, number>();
  let ok = true;
  footprintCells(kind, x, y, rotation, (cx, cy) => {
    if (!inside(cx, cy)) { ok = false; return false; }
    const index = indexOf(cx, cy);
    if (draft.occupancy[index] !== 0 || draft.reserved[index] !== 0) { ok = false; return false; }
    if ((draft.ground[index] === GROUND_WATER) !== (kind.surface === 'water')) { ok = false; return false; }
    const chunk = chunkOf(cx, cy);
    addCells.set(chunk, (addCells.get(chunk) ?? 0) + 1);
    return true;
  });
  if (!ok) return false;
  for (const [chunk, cells] of addCells) {
    if (draft.chunkCells[chunk] + cells > GAME_CONFIG.maps.maxPropCellsPerChunk) return false;
    if (draft.chunkWeight[chunk] + cells * cellWeight > GAME_CONFIG.maps.generator.chunkPropWeightCap) return false;
  }
  if (footprintArea > 1) {
    // No other prop of the same footprint class 4-adjacent to this footprint.
    footprintCells(kind, x, y, rotation, (cx, cy) => {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inside(nx, ny)) continue;
        const other = draft.occupancy[indexOf(nx, ny)];
        if (other === 0) continue;
        const otherProp = draft.props[other - 1];
        if (!otherProp) continue;
        const otherKind = PROP_KIND_BY_ID.get(otherProp.kind) as PropKindDefinition;
        const sameClass = isTwoByOne(kind) ? isTwoByOne(otherKind) : (otherKind.footprint[0] === 2 && otherKind.footprint[1] === 2);
        if (sameClass) { ok = false; return false; }
      }
      return true;
    });
    if (!ok) return false;
  }
  const index = draft.props.length;
  draft.props.push({ kind: kindId, x, y, rotation: kind.footprint[0] === kind.footprint[1] ? 0 : rotation });
  footprintCells(kind, x, y, rotation, (cx, cy) => { draft.occupancy[indexOf(cx, cy)] = index + 1; });
  for (const [chunk, cells] of addCells) {
    draft.chunkCells[chunk] += cells;
    draft.chunkWeight[chunk] += cells * cellWeight;
  }
  draft.totalWeight += cellWeight * footprintArea;
  draft.count += 1;
  return true;
};

/** Removes a prop and releases its caps. */
export const removeProp = (draft: MapDraft, index: number): void => {
  const prop = draft.props[index];
  if (!prop) return;
  const kind = PROP_KIND_BY_ID.get(prop.kind) as PropKindDefinition;
  const cellWeight = weightPerCell(prop.kind);
  footprintCells(kind, prop.x, prop.y, prop.rotation, (cx, cy) => {
    draft.occupancy[indexOf(cx, cy)] = 0;
    const chunk = chunkOf(cx, cy);
    draft.chunkCells[chunk] -= 1;
    draft.chunkWeight[chunk] -= cellWeight;
    draft.totalWeight -= cellWeight;
  });
  draft.props[index] = null;
  draft.count -= 1;
};

/** Reachability from the gate: 4-connected cells that are not water and not (blocked by a prop that `blocks`). */
export const reachable = (draft: MapDraft, blocks: (propIndex: number) => boolean): number => {
  const seen = new Uint8Array(CELLS);
  const stack = [indexOf(draft.gate.x, draft.gate.y)];
  seen[stack[0]] = 1;
  let count = 0;
  while (stack.length > 0) {
    const index = stack.pop() as number;
    count += 1;
    const x = index % SIZE;
    const y = (index - x) / SIZE;
    const next = [x > 0 ? index - 1 : -1, x < SIZE - 1 ? index + 1 : -1, y > 0 ? index - SIZE : -1, y < SIZE - 1 ? index + SIZE : -1];
    for (const candidate of next) {
      if (candidate < 0 || seen[candidate] || draft.ground[candidate] === GROUND_WATER) continue;
      const owner = draft.occupancy[candidate];
      if (owner !== 0 && blocks(owner - 1)) continue;
      seen[candidate] = 1;
      stack.push(candidate);
    }
  }
  return count;
};

export const isClearable = (prop: DraftProp): boolean => (PROP_KIND_BY_ID.get(prop.kind) as PropKindDefinition).clearCost !== null;

export const openArea = (draft: MapDraft): number => reachable(draft, () => true);
export const clearedArea = (draft: MapDraft): number => reachable(draft, (index) => !isClearable(draft.props[index] as DraftProp));
