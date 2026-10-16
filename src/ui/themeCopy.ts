import { BIOME_BY_ID } from '../game/biomes/content';
import type { BiomeId } from '../game/biomes/types';
import { CARD_BY_ID } from '../game/cards/content';
import { researchGrantUpside } from '../game/cards/copy';
import type { ActiveCardSnapshot } from '../game/cards/types';
import { GAME_CONFIG } from '../game/config';
import { BUILD_BY_ID } from '../game/content/catalog';
import { researchBranchOf } from '../game/progression/content';
import type { ResearchProjectId, ResearchProjectSnapshot, ResearchTier } from '../game/progression/types';
import type { SceneryDestinationSnapshot, ThemeBonusPreview } from '../game/scenery/types';
import type { SceneryThemeId } from '../game/types';

/**
 * Phase 16 copy (design 4.2 and 5): the theme chip on build cards, the theme line of the placement readout and of the
 * ride and service inspectors, the research panel's branches and tiers, and the Research Grant line of a live park.
 * Pure: every number comes from a snapshot, the catalog or GAME_CONFIG, so the words cannot drift from the rules.
 */

export const THEME_LABELS: Readonly<Record<SceneryThemeId, string>> = {
  garden: 'Garden',
  seaside: 'Seaside',
  adventure: 'Adventure',
  futuristic: 'Futuristic',
  carnival: 'Carnival',
};

/** True when the map's biome lists the theme as its local style (`BiomeDefinition.sceneryThemes`). UI only. */
export const isLocalStyle = (theme: SceneryThemeId, biomeId: BiomeId): boolean => (
  BIOME_BY_ID.get(biomeId)?.sceneryThemes.includes(theme) ?? false
);

/** The build card chip: "Seaside", or "Seaside · local style" on a map whose biome lists the theme; null when themeless. */
export const themeChipText = (theme: SceneryThemeId | null | undefined, biomeId: BiomeId): string | null => {
  if (!theme) return null;
  return isLocalStyle(theme, biomeId) ? `${THEME_LABELS[theme]} · local style` : THEME_LABELS[theme];
};

/** A theme bonus in score points: "＋4", "＋0.4" (one decimal under 1, whole points above). */
export const formatThemeBonus = (value: number): string => {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const shown = safe > 0 && safe < 1 ? Math.round(safe * 10) / 10 : Math.round(safe);
  return `＋${shown}`;
};

const maximumThemeBonus = (): number => GAME_CONFIG.scenery.themeAffinity.maximumBonus;

/** What the placement readout needs from `ScenerySimulation.previewThemeBonus`: primitives only, so the store can compare it. */
export interface PlacementThemeView {
  theme: SceneryThemeId;
  /** 0 = theme matching is off in this park. */
  themeAffinity: number;
  /** The destination that gains most (its catalog name) and the gain, or null when none gains. */
  topName: string | null;
  topGain: number;
  /** Same-theme rides and stalls in reach, whether or not their bonus rises. */
  reachedDestinations: number;
}

/** The view of a preview; null for a themeless (or non-scenery) candidate, which adds nothing to the readout. */
export const placementThemeViewOf = (preview: ThemeBonusPreview): PlacementThemeView | null => {
  if (preview.theme === null) return null;
  const top = preview.destinations[0];
  return {
    theme: preview.theme,
    themeAffinity: preview.themeAffinity,
    topName: top ? BUILD_BY_ID.get(top.definitionId)?.name ?? top.definitionId : null,
    topGain: top ? top.gain : 0,
    reachedDestinations: preview.reachedDestinations,
  };
};

export const samePlacementThemeView = (left: PlacementThemeView | null, right: PlacementThemeView | null): boolean => (
  left === right || (left !== null && right !== null
    && left.theme === right.theme && left.themeAffinity === right.themeAffinity && left.topName === right.topName
    && left.topGain === right.topGain && left.reachedDestinations === right.reachedDestinations)
);

/**
 * The tail of the placement readout ("Seaside match: ＋4 for Harbor Swings"), without the leading " · ". Null for a
 * themeless piece, and in a park without theme matching (the inspector says why; the readout stays quiet).
 */
export const placementThemeLine = (view: PlacementThemeView | null): string | null => {
  if (view === null || view.themeAffinity <= 0) return null;
  const label = THEME_LABELS[view.theme];
  if (view.topName !== null) return `${label} match: ${formatThemeBonus(view.topGain)} for ${view.topName}`;
  if (view.reachedDestinations > 0) {
    return `${label} rides and stalls in reach are at the ${formatThemeBonus(maximumThemeBonus())} maximum`;
  }
  return `no ${label} ride or stall in reach`;
};

/**
 * The inspector line of the "AREA SCENERY" block: "Theme · Carnival: ＋6 from 2 carnival pieces (max ＋10)", the
 * invitation when nothing matches, or the off note for a park saved before themes. Null for a themeless ride or stall.
 */
export const inspectorThemeLine = (
  theme: SceneryThemeId | null | undefined,
  destination: Pick<SceneryDestinationSnapshot, 'themeBonus' | 'matchingSources'> | undefined,
  themeAffinity: number,
): string | null => {
  if (!theme) return null;
  if (themeAffinity <= 0) return 'Theme matching is off in this park (saved before themes)';
  const label = THEME_LABELS[theme];
  const word = label.toLowerCase();
  const maximum = formatThemeBonus(maximumThemeBonus());
  const sources = destination?.matchingSources ?? 0;
  if (sources > 0) {
    return `Theme · ${label}: ${formatThemeBonus(destination?.themeBonus ?? 0)} from ${sources} ${word} ${sources === 1 ? 'piece' : 'pieces'} (max ${maximum})`;
  }
  return `Theme · ${label}: add ${word} scenery within reach for up to ${maximum}`;
};

// --- Research (design 5) ---

export const RESEARCH_TIER_LABELS: Readonly<Record<ResearchTier, string>> = {
  1: 'Tier 1 · opener',
  2: 'Tier 2',
  3: 'Tier 3',
};

export interface ResearchBranch {
  /** The tier-1 opener the branch grows from. */
  id: ResearchProjectId;
  name: string;
  /** Opener first, then by tier; equal tiers keep the tree's order. */
  projects: ResearchProjectSnapshot[];
}

/** The research projects grouped by the opener their prerequisite chain starts from, in the tree's opener order. */
export const researchBranches = (projects: readonly ResearchProjectSnapshot[]): ResearchBranch[] => {
  const branches = new Map<ResearchProjectId, ResearchProjectSnapshot[]>();
  for (const project of projects) {
    const branch = researchBranchOf(project.id);
    const list = branches.get(branch);
    if (list) list.push(project);
    else branches.set(branch, [project]);
  }
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return [...branches.entries()].map(([id, list]) => ({
    id,
    name: names.get(id) ?? id,
    projects: list
      .map((project, index) => ({ project, index }))
      .sort((left, right) => left.project.tier - right.project.tier || left.index - right.index)
      .map(({ project }) => project),
  }));
};

/** A milestone's reward, read as a finding (milestones are small findings since Phase 16, never scaled). */
export const findingRewardText = (points: number): string => `Finding: +${points} RP`;

/**
 * The live park's card faces with the Research Grant line re-printed at the park's own research cost scale. Card
 * definitions print it at the new-park scale; a park saved before the scale existed grants base points, and its hand
 * must say so. Unchanged cards are returned as they are.
 */
export const researchCardFaces = (cards: readonly ActiveCardSnapshot[], researchCostScale: number): ActiveCardSnapshot[] => cards.map((card) => {
  const definition = CARD_BY_ID.get(card.id);
  if (!definition || definition.kind !== 'one-shot' || definition.effect.kind !== 'research') return card;
  const upside = researchGrantUpside(definition.effect.points, researchCostScale);
  return upside === card.upside ? card : { ...card, upside };
});

/** Where a branch leads: "Opens with Family Favorites, then Water Works or Temple Expeditions." (plus tier 3 when it has one). */
export const researchBranchLine = (branch: ResearchBranch): string => {
  const names = (tier: ResearchTier): string[] => branch.projects.filter((project) => project.tier === tier).map((project) => project.name);
  const either = (list: readonly string[]): string => (
    list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`
  );
  const second = names(2);
  const third = names(3);
  if (second.length === 0) return 'A single project.';
  const tail = third.length > 0 ? `; at tier 3, ${either(third)}` : '';
  return `Opens with ${branch.name}, then ${either(second)}${tail}.`;
};
