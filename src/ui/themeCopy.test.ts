import { describe, expect, it } from 'vitest';
import { BIOMES } from '../game/biomes/content';
import { CARD_BY_ID, PULSE_CARDS } from '../game/cards/content';
import { newParkResearchCostScale, researchGrantUpside } from '../game/cards/copy';
import type { ActiveCardSnapshot } from '../game/cards/types';
import { GAME_CONFIG } from '../game/config';
import { BUILD_CATALOG } from '../game/content/catalog';
import { RESEARCH_MILESTONES, RESEARCH_PROJECTS } from '../game/progression/content';
import { ProgressionSimulation } from '../game/progression/ProgressionSimulation';
import type { ThemeBonusPreview } from '../game/scenery/types';
import { SCENERY_THEME_IDS } from '../game/types';
import { GameWorld } from '../game/World';
import {
  findingRewardText,
  formatThemeBonus,
  inspectorThemeLine,
  isLocalStyle,
  placementThemeLine,
  placementThemeViewOf,
  RESEARCH_TIER_LABELS,
  researchBranches,
  researchBranchLine,
  researchCardFaces,
  samePlacementThemeView,
  THEME_LABELS,
  themeChipText,
  type PlacementThemeView,
} from './themeCopy';

/** Phase 16 (design 4.2, 5): the pure copy behind the theme chip, the placement and inspector lines, and the research panel. */

const MAX = `＋${GAME_CONFIG.scenery.themeAffinity.maximumBonus}`;

describe('theme chip', () => {
  it('names every theme, and reads "local style" exactly where the biome lists the theme', () => {
    for (const theme of SCENERY_THEME_IDS) expect(THEME_LABELS[theme].length).toBeGreaterThan(0);
    for (const biome of BIOMES) {
      for (const theme of SCENERY_THEME_IDS) {
        const local = biome.sceneryThemes.includes(theme);
        expect(isLocalStyle(theme, biome.id), `${biome.id} ${theme}`).toBe(local);
        expect(themeChipText(theme, biome.id)).toBe(local ? `${THEME_LABELS[theme]} · local style` : THEME_LABELS[theme]);
      }
    }
    expect(themeChipText('seaside', 'seaside')).toBe('Seaside · local style');
    expect(themeChipText('seaside', 'meadow')).toBe('Seaside');
  });

  it('is absent for a themeless piece, and present on every themed ride, stall and scenery card', () => {
    expect(themeChipText(undefined, 'meadow')).toBeNull();
    expect(themeChipText(null, 'meadow')).toBeNull();
    const themed = BUILD_CATALOG.filter((definition) => definition.theme !== undefined);
    expect(themed.length).toBeGreaterThan(0);
    for (const definition of themed) expect(themeChipText(definition.theme, 'meadow'), definition.id).not.toBeNull();
  });
});

describe('placement readout line', () => {
  const view = (patch: Partial<PlacementThemeView> = {}): PlacementThemeView => ({
    theme: 'carnival', themeAffinity: 0.3, topName: 'Moonpetal Carousel', topGain: 4.2, reachedDestinations: 2, ...patch,
  });

  it('names the destination that gains most and by how much', () => {
    expect(placementThemeLine(view())).toBe('Carnival match: ＋4 for Moonpetal Carousel');
    expect(placementThemeLine(view({ topGain: 0.36 }))).toBe('Carnival match: ＋0.4 for Moonpetal Carousel');
  });

  it('says when nothing of the theme is in reach, and when everything in reach is already at the maximum', () => {
    expect(placementThemeLine(view({ topName: null, topGain: 0, reachedDestinations: 0 }))).toBe('no Carnival ride or stall in reach');
    expect(placementThemeLine(view({ topName: null, topGain: 0, reachedDestinations: 1 }))).toBe(`Carnival rides and stalls in reach are at the ${MAX} maximum`);
  });

  it('adds nothing for a themeless piece or in a park without theme matching', () => {
    expect(placementThemeLine(null)).toBeNull();
    expect(placementThemeLine(view({ themeAffinity: 0 }))).toBeNull();
  });

  it('builds its view from a preview: the first (largest) destination, by catalog name', () => {
    const preview: ThemeBonusPreview = {
      theme: 'carnival',
      themeAffinity: 0.3,
      destinations: [
        { objectId: 7, definitionId: 'moonpetal-carousel', themeBonus: 1, previewBonus: 3.5, gain: 2.5 },
        { objectId: 3, definitionId: 'comet-cups', themeBonus: 0, previewBonus: 1, gain: 1 },
      ],
      reachedDestinations: 3,
    };
    const built = placementThemeViewOf(preview);
    expect(built).toEqual({ theme: 'carnival', themeAffinity: 0.3, topName: 'Moonpetal Carousel', topGain: 2.5, reachedDestinations: 3 });
    expect(placementThemeViewOf({ theme: null, themeAffinity: 0.3, destinations: [], reachedDestinations: 0 })).toBeNull();
    expect(samePlacementThemeView(built, placementThemeViewOf(preview))).toBe(true);
    expect(samePlacementThemeView(built, { ...built!, topGain: 2 })).toBe(false);
    expect(samePlacementThemeView(null, null)).toBe(true);
    expect(samePlacementThemeView(built, null)).toBe(false);
  });

  it('formats bonuses as whole points, with one decimal under one point', () => {
    expect(formatThemeBonus(6)).toBe('＋6');
    expect(formatThemeBonus(6.4)).toBe('＋6');
    expect(formatThemeBonus(0.04)).toBe('＋0');
    expect(formatThemeBonus(0.25)).toBe('＋0.3');
    expect(formatThemeBonus(-1)).toBe('＋0');
    expect(formatThemeBonus(Number.NaN)).toBe('＋0');
  });
});

describe('inspector theme line', () => {
  it('counts the matching pieces and states the maximum from the config', () => {
    expect(inspectorThemeLine('carnival', { themeBonus: 6, matchingSources: 2 }, 0.3)).toBe(`Theme · Carnival: ＋6 from 2 carnival pieces (max ${MAX})`);
    expect(inspectorThemeLine('seaside', { themeBonus: 1.2, matchingSources: 1 }, 0.3)).toBe(`Theme · Seaside: ＋1 from 1 seaside piece (max ${MAX})`);
  });

  it('invites matching scenery when none reaches, says when matching is off, and is absent without a theme', () => {
    expect(inspectorThemeLine('carnival', { themeBonus: 0, matchingSources: 0 }, 0.3)).toBe(`Theme · Carnival: add carnival scenery within reach for up to ${MAX}`);
    expect(inspectorThemeLine('carnival', undefined, 0.3)).toBe(`Theme · Carnival: add carnival scenery within reach for up to ${MAX}`);
    expect(inspectorThemeLine('carnival', { themeBonus: 0, matchingSources: 2 }, 0)).toBe('Theme matching is off in this park (saved before themes)');
    expect(inspectorThemeLine(undefined, { themeBonus: 0, matchingSources: 0 }, 0.3)).toBeNull();
  });
});

describe('research panel copy', () => {
  const projects = (scale = 1) => new ProgressionSimulation(new GameWorld(), scale).snapshot().projects;

  it('groups every project under its opener, opener first and tiers rising, in the tree order of the openers', () => {
    const branches = researchBranches(projects());
    expect(branches.map((branch) => branch.id)).toEqual(RESEARCH_PROJECTS.filter((project) => project.tier === 1).map((project) => project.id));
    expect(branches.flatMap((branch) => branch.projects).length).toBe(RESEARCH_PROJECTS.length);
    for (const branch of branches) {
      expect(branch.projects[0].id).toBe(branch.id);
      expect(branch.projects[0].tier).toBe(1);
      expect(branch.projects.filter((project) => project.tier === 1)).toHaveLength(1);
      const tiers = branch.projects.map((project) => project.tier);
      expect(tiers).toEqual([...tiers].sort());
    }
    const spin = branches.find((branch) => branch.id === 'spin-studies')!;
    expect(spin.projects.map((project) => project.id)).toEqual(['spin-studies', 'vertical-motion', 'tight-turns', 'skyline-engineering', 'thrill-engineering', 'launch-lab']);
    expect(branches.find((branch) => branch.id === 'garden-appeal')!.projects).toHaveLength(4);
  });

  it('says where a branch leads, by name', () => {
    const branches = researchBranches(projects());
    const family = branches.find((branch) => branch.id === 'family-favorites')!;
    expect(researchBranchLine(family)).toBe('Opens with Family Favorites, then Water Works, Temple Expeditions or Timber Framing.');
    const garden = branches.find((branch) => branch.id === 'garden-appeal')!;
    expect(researchBranchLine(garden)).toBe('Opens with Garden Appeal, then Seaside Styling, Adventure Styling or Future Styling.');
    const spin = branches.find((branch) => branch.id === 'spin-studies')!;
    expect(researchBranchLine(spin)).toBe('Opens with Spin Studies, then Vertical Motion or Tight Turns; at tier 3, Skyline Engineering, Thrill Engineering or Launch Lab.');
  });

  it('labels tiers and reads milestone rewards as findings', () => {
    expect(RESEARCH_TIER_LABELS[1]).toBe('Tier 1 · opener');
    expect(findingRewardText(RESEARCH_MILESTONES[0].rewardResearchPoints)).toBe(`Finding: +${RESEARCH_MILESTONES[0].rewardResearchPoints} RP`);
  });

  it('shows the effective RP the snapshot carries, and branches do not depend on the scale', () => {
    const scaled = researchBranches(projects(10));
    expect(scaled.map((branch) => branch.projects.map((project) => project.id))).toEqual(researchBranches(projects()).map((branch) => branch.projects.map((project) => project.id)));
    const spin = scaled[0].projects[0];
    expect(spin.researchPointCost).toBe(RESEARCH_PROJECTS.find((project) => project.id === spin.id)!.researchPointCost * 10);
  });
});

describe('Research Grant copy', () => {
  const grant = CARD_BY_ID.get('research-grant')!;
  const points = grant.kind === 'one-shot' && grant.effect.kind === 'research' ? grant.effect.points : NaN;
  const face = (patch: Partial<ActiveCardSnapshot> = {}): ActiveCardSnapshot => ({
    id: grant.id, name: grant.name, icon: grant.icon, upside: grant.upside, downside: grant.downside, kind: grant.kind, rarity: grant.rarity,
    slotCost: grant.slotCost, playState: 'ready', playedAtSeconds: null, playable: true, hint: null, pending: null, ...patch,
  });

  it('the card prints the points a NEW park is granted (base x its research cost scale)', () => {
    expect(Number.isFinite(points)).toBe(true);
    expect(grant.upside).toBe(researchGrantUpside(points, newParkResearchCostScale()));
    expect(grant.upside).toBe(`${Math.round(points * newParkResearchCostScale())} research points now`);
  });

  it('a live park re-prints it at its own scale; other cards are passed through untouched', () => {
    const other = PULSE_CARDS.find((card) => card.kind === 'one-shot' && card.effect.kind !== 'research')!;
    const otherFace = { ...face(), id: other.id, upside: other.upside };
    const [old, untouched] = researchCardFaces([face(), otherFace], 1);
    expect(old.upside).toBe(`${points} research points now`);
    expect(untouched).toBe(otherFace);
    expect(researchCardFaces([face()], 10)[0].upside).toBe(`${points * 10} research points now`);
    const same = face({ upside: researchGrantUpside(points, 10) });
    expect(researchCardFaces([same], 10)[0]).toBe(same);
  });
});
