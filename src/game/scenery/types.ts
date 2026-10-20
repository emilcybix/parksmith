import type { Cell, SceneryThemeId } from '../types';

export interface SceneryInfluenceReader {
  scoreAt(cell: Cell): number;
  scoreForObject(objectId: number): number;
}

export const ZERO_SCENERY_INFLUENCE: SceneryInfluenceReader = Object.freeze({
  scoreAt: () => 0,
  scoreForObject: () => 0,
});

export interface SceneryCellSnapshot {
  cell: Cell;
  score: number;
}

export interface ScenerySourceSnapshot {
  objectId: number;
  definitionId: string;
  appeal: number;
  radius: number;
  influencedCells: number;
}

export interface SceneryDestinationSnapshot {
  objectId: number;
  /** The footprint average plus `themeBonus`, capped at the maximum score (Phase 16). */
  score: number;
  choiceBonus: number;
  satisfactionBonus: number;
  /** Phase 16: the destination's theme (null for a themeless one, such as a coaster or a toilet). */
  theme: SceneryThemeId | null;
  /** Phase 16: min(maximumBonus, matching x themeAffinity); 0 when the park has no affinity or nothing matches. */
  themeBonus: number;
  /** Phase 16: how many same-theme scenery pieces reach the footprint (counted even when the affinity is off). */
  matchingSources: number;
}

/** Phase 16: one destination a candidate scenery piece would raise, and by how much. */
export interface ThemeBonusPreviewEntry {
  objectId: number;
  definitionId: string;
  /** The theme bonus now. */
  themeBonus: number;
  /** The theme bonus once the candidate is built. */
  previewBonus: number;
  /** previewBonus - themeBonus (> 0). */
  gain: number;
}

/** Phase 16: what `ScenerySimulation.previewThemeBonus` answers. Pure: nothing is built or cached. */
export interface ThemeBonusPreview {
  /** The candidate's theme (null for a themeless or unknown definition). */
  theme: SceneryThemeId | null;
  /** The park's theme-affinity share (0 = theme matching is off in this park). */
  themeAffinity: number;
  /** The rides and stalls of the candidate's theme whose bonus rises, largest gain first (ties: object id). */
  destinations: ThemeBonusPreviewEntry[];
  /** Same-theme rides and stalls the candidate reaches, whether or not their bonus rises (it may be capped or off). */
  reachedDestinations: number;
}

export interface ScenerySnapshot {
  version: number;
  sourceCount: number;
  influencedCells: number;
  connectedPathTiles: number;
  decoratedPathTiles: number;
  coveragePercent: number;
  averagePathScore: number;
  averageDestinationScore: number;
  parkScore: number;
  /** Phase 16: the park's theme-affinity share (0 = theme matching is off in this park). */
  themeAffinity: number;
  cells: SceneryCellSnapshot[];
  sources: ScenerySourceSnapshot[];
  destinations: SceneryDestinationSnapshot[];
}

/**
 * Phase 49: the one piece of scenery that would lift a ride's or stall's area score the most (`ScenerySimulation.nextStepFor`):
 * which piece, where, and the base score before and after (the theme bonus is left out, it only ever adds).
 */
export interface SceneryNextStep {
  definitionId: string;
  anchor: Cell;
  gain: number;
  scoreBefore: number;
  scoreAfter: number;
}
