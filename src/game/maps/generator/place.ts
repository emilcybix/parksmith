import { PROP_KIND_BY_ID, type PropKindDefinition, type PropKindId } from '../props';
import { GROUND_ALT, GROUND_BASE, GROUND_WATER } from '../types';
import { CELLS, SIZE, indexOf, inside, tryPlace, type MapDraft } from './draft';
import type { Noise } from './noise';

/**
 * Rule-driven prop placement (Phase 24 step 2): noise-masked clusters, blue-noise spacing and per-kind rules, all
 * integer. Candidate cells are visited in the order of a positional hash (never row by row), so hitting a cap does
 * not bias a map toward its first rows. Every prop still goes through `tryPlace`.
 */

export type Zone =
  | 'base' | 'alt' | 'land'
  /** land within 1 cell of water */ | 'shore'
  /** land within 2 cells of water */ | 'near-water'
  | 'forest' | 'open' | 'near' | 'far'
  /** an alt cell with a base cell next to it (the line where a beach meets the grass) */ | 'beach-edge';

export type Triple = readonly [low: number, normal: number, high: number];

export interface PropRule {
  readonly kind: PropKindId;
  readonly zone: Zone;
  /** Acceptance chance per eligible cell, per mille, by density. */
  readonly perMille: Triple;
  /** Only the cells of the strongest `keep` per mille of the value noise (cluster size `shift`) are eligible. */
  readonly cluster: null | { readonly shift: 2 | 3 | 4; readonly keep: number };
  /** Minimum Chebyshev distance between anchors of this rule's kind (blue noise); 0 = none. */
  readonly spacing: number;
  readonly maxCount: Triple | null;
}

/** Per-mille helpers: low is about 0.6x normal and high about 1.4x. */
export const scaled = (normal: number): Triple => [Math.round(normal * 0.6), normal, Math.min(1000, Math.round(normal * 1.4))];

export interface Zones {
  readonly shore: Uint8Array;
  readonly nearWater: Uint8Array;
  readonly beachEdge: Uint8Array;
}

export const computeZones = (draft: MapDraft): Zones => {
  const shore = new Uint8Array(CELLS);
  const nearWater = new Uint8Array(CELLS);
  const beachEdge = new Uint8Array(CELLS);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const index = indexOf(x, y);
      if (draft.ground[index] === GROUND_WATER) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (!inside(x + dx, y + dy) || draft.ground[indexOf(x + dx, y + dy)] !== GROUND_WATER) continue;
          nearWater[index] = 1;
          if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) shore[index] = 1;
        }
      }
      if (draft.ground[index] === GROUND_ALT) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (inside(x + dx, y + dy) && draft.ground[indexOf(x + dx, y + dy)] === GROUND_BASE) beachEdge[index] = 1;
        }
      }
    }
  }
  return { shore, nearWater, beachEdge };
};

const inZone = (draft: MapDraft, zones: Zones, zone: Zone, index: number): boolean => {
  const ground = draft.ground[index];
  if (ground === GROUND_WATER) return false;
  switch (zone) {
    case 'base': return ground === GROUND_BASE;
    case 'alt': return ground === GROUND_ALT;
    case 'land': return true;
    case 'shore': return zones.shore[index] === 1;
    case 'near-water': return zones.nearWater[index] === 1;
    case 'forest': return draft.forest[index] === 1;
    case 'open': return draft.forest[index] === 0;
    case 'near': return draft.far[index] === 0;
    case 'far': return draft.far[index] === 1;
    case 'beach-edge': return zones.beachEdge[index] === 1;
    default: return false;
  }
};

/** Indices 0..CELLS-1 ordered by a positional hash (ascending), ties by index. */
export const shuffledCells = (noise: Noise, tag: number): number[] => {
  const keys = new Uint32Array(CELLS);
  for (let index = 0; index < CELLS; index += 1) keys[index] = noise.h(tag, index, 7);
  return Array.from({ length: CELLS }, (_, index) => index).sort((a, b) => (keys[a] - keys[b]) || (a - b));
};

/** The strongest `perMille` of `eligible` cells by `score` (descending, ties by index) as a 0/1 mask. */
export const topFraction = (score: (index: number) => number, eligible: (index: number) => boolean, perMille: number): Uint8Array => {
  const mask = new Uint8Array(CELLS);
  const cells: number[] = [];
  const values = new Int32Array(CELLS);
  for (let index = 0; index < CELLS; index += 1) {
    if (!eligible(index)) continue;
    values[index] = score(index);
    cells.push(index);
  }
  cells.sort((a, b) => (values[b] - values[a]) || (a - b));
  const keep = Math.floor((cells.length * perMille) / 1000);
  for (let at = 0; at < keep; at += 1) mask[cells[at]] = 1;
  return mask;
};

export const placeRules = (draft: MapDraft, noise: Noise, zones: Zones, rules: readonly PropRule[], density: 0 | 1 | 2, tagBase: number): void => {
  // 2x2 kinds first, then 2x1, then 1x1; within a class, table order.
  const area = (rule: PropRule): number => {
    const kind = PROP_KIND_BY_ID.get(rule.kind) as PropKindDefinition;
    return kind.footprint[0] * kind.footprint[1];
  };
  const ordered = rules.map((rule, index) => ({ rule, index })).sort((a, b) => (area(b.rule) - area(a.rule)) || (a.index - b.index));
  for (const { rule, index: ruleIndex } of ordered) {
    const kind = PROP_KIND_BY_ID.get(rule.kind) as PropKindDefinition;
    const tag = tagBase + ruleIndex * 8;
    const footprintArea = kind.footprint[0] * kind.footprint[1];
    const chance = rule.perMille[density];
    if (chance <= 0) continue;
    const limit = rule.maxCount === null ? Infinity : rule.maxCount[density];
    const clusterMask = rule.cluster === null
      ? null
      : topFraction(
        (cell) => noise.value(tag + 1, cell % SIZE, Math.floor(cell / SIZE), (rule.cluster as { shift: number }).shift),
        (cell) => inZone(draft, zones, rule.zone, cell),
        rule.cluster.keep,
      );
    const anchors: Array<[number, number]> = [];
    const minimumSeparation = footprintArea === 4 ? 3 : footprintArea === 2 ? 2 : 0;
    const spacing = Math.max(rule.spacing, minimumSeparation);
    for (const cell of shuffledCells(noise, tag + 2)) {
      if (anchors.length >= limit) break;
      const x = cell % SIZE;
      const y = (cell - x) / SIZE;
      if (!inZone(draft, zones, rule.zone, cell)) continue;
      if (clusterMask !== null && clusterMask[cell] === 0) continue;
      if (noise.h(tag + 3, x, y) % 1000 >= chance) continue;
      if (spacing > 0 && anchors.some(([ax, ay]) => Math.max(Math.abs(ax - x), Math.abs(ay - y)) < spacing)) continue;
      const rotation = (footprintArea === 2 ? noise.h(tag + 4, x, y) & 1 : 0) as 0 | 1;
      if (tryPlace(draft, rule.kind, x, y, rotation)) anchors.push([x, y]);
    }
  }
};
