import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from '../game/content/catalog';
import { sceneryFactorDetail } from '../game/management/ManagementSimulation';
import type { SceneryDestinationSnapshot, ScenerySnapshot } from '../game/scenery/types';
import { ParkSession } from '../game/session/ParkSession';
import { GAME_CONFIG } from '../game/config';
import { BuildDock, CursorReadout, RideInspector, ServiceInspector } from './Hud';
import { ManagementDashboard } from './ManagementDashboard';
import { useUiStore } from './store';
import { DEFAULT_WEATHER_UI } from './weatherModel';

/**
 * Phase 16 (design 4.2, 5): the theme chip on build cards, the theme match in the placement readout, the theme line of
 * the ride and service inspectors, the research panel's branches, tiers and findings, and the scenery factor's live
 * detail. The tests have no DOM: the markup is rendered on the server from a patched initial store.
 */

type Patch = Partial<ReturnType<typeof useUiStore.getState>>;
const renderWith = (patch: Patch, element: React.JSX.Element): string => {
  const seed = useUiStore.getInitialState() as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) saved[key] = seed[key];
  Object.assign(seed, patch);
  try {
    return renderToStaticMarkup(element);
  } finally {
    Object.assign(seed, saved);
  }
};

const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;
const MAX = `＋${GAME_CONFIG.scenery.themeAffinity.maximumBonus}`;

/** A fresh park with one object of `definitionId` at the first cell that takes it. */
const parkWith = (definitionId: string): { session: ParkSession; objectId: number } => {
  const session = new ParkSession(null);
  for (let y = 2; y < 40; y += 1) {
    for (let x = 2; x < 40; x += 1) {
      const object = session.world.buildObject(definitionId, { x, y });
      if (!object) continue;
      session.rides.syncWithWorld();
      session.shops.syncWithWorld();
      return { session, objectId: object.id };
    }
  }
  throw new Error(`${definitionId} found no free cell`);
};

const sceneryWith = (destination: Partial<SceneryDestinationSnapshot> & { objectId: number }, themeAffinity: number): ScenerySnapshot => ({
  version: 1, sourceCount: 2, influencedCells: 10, connectedPathTiles: 0, decoratedPathTiles: 0, coveragePercent: 0,
  averagePathScore: 0, averageDestinationScore: 20, parkScore: 20, themeAffinity, cells: [], sources: [],
  destinations: [{ score: 20, choiceBonus: 1, satisfactionBonus: 1, theme: null, themeBonus: 0, matchingSources: 0, ...destination }],
});

describe('build card theme chip', () => {
  it('every themed scenery card carries its chip; the biome\'s own theme reads "local style"', () => {
    const scenery = BUILD_CATALOG.filter((definition) => definition.category === 'scenery');
    const html = renderWith({ activeCategory: 'scenery', weatherUi: { ...DEFAULT_WEATHER_UI, biomeId: 'meadow' } }, <BuildDock />);
    expect(count(html, /class="build-theme-chip/g)).toBe(scenery.filter((definition) => definition.theme).length);
    expect(count(html, /class="build-theme-chip local"/g)).toBe(scenery.filter((definition) => definition.theme === 'garden').length);
    expect(html).toContain('title="Garden · local style"><span class="sr-only">Theme: </span>Garden<span aria-hidden="true"> ★</span><span class="sr-only"> · local style</span>');
    expect(html).toContain('<span class="sr-only">Theme: </span>Carnival</em>');
    const seaside = renderWith({ activeCategory: 'scenery', weatherUi: { ...DEFAULT_WEATHER_UI, biomeId: 'seaside' } }, <BuildDock />);
    expect(seaside).toContain('Seaside · local style');
    expect(seaside).not.toContain('Garden · local style');
  });

  it('the chip shares the price row (after the price, outside the copy), so a themed card gains no line', () => {
    const html = renderWith({ activeCategory: 'rides', weatherUi: { ...DEFAULT_WEATHER_UI, biomeId: 'meadow' } }, <BuildDock />);
    expect(html).toMatch(/<span class="build-price">\$[\d,]+<\/span><em class="build-theme-chip( local)?" title="[^"]+"><span class="sr-only">Theme: <\/span>/);
    expect(html).not.toMatch(/<span class="build-copy">(?:(?!<\/span><span class="build-price">).)*build-theme-chip/);
    const themedRides = BUILD_CATALOG.filter((definition) => definition.category === 'rides' && definition.theme).length;
    expect(count(html, /class="build-theme-chip/g)).toBe(themedRides);
  });
});

describe('placement readout theme match', () => {
  const base: Patch = { hoveredCell: { x: 4, y: 5 }, tool: 'build', selectedDefinitionId: 'bunting-mast' };

  it('names the destination that gains most, after the appeal line', () => {
    const html = renderWith({
      ...base,
      previewTheme: { theme: 'carnival', themeAffinity: 0.3, topName: 'Moonpetal Carousel', topGain: 4, reachedDestinations: 1 },
    }, <CursorReadout />);
    expect(html).toContain('appeal within 4 tiles<span class="cursor-theme"> · Carnival match: ＋4 for Moonpetal Carousel</span>');
  });

  it('says when no ride or stall of the theme is in reach', () => {
    const html = renderWith({
      ...base,
      previewTheme: { theme: 'carnival', themeAffinity: 0.3, topName: null, topGain: 0, reachedDestinations: 0 },
    }, <CursorReadout />);
    expect(html).toContain(' · no Carnival ride or stall in reach');
  });

  it('adds nothing without a preview, for a preview of another theme, or with matching off', () => {
    expect(renderWith(base, <CursorReadout />)).not.toContain('cursor-theme');
    expect(renderWith({ ...base, previewTheme: { theme: 'garden', themeAffinity: 0.3, topName: 'Comet Cups', topGain: 2, reachedDestinations: 1 } }, <CursorReadout />)).not.toContain('cursor-theme');
    expect(renderWith({ ...base, previewTheme: { theme: 'carnival', themeAffinity: 0, topName: null, topGain: 0, reachedDestinations: 1 } }, <CursorReadout />)).not.toContain('cursor-theme');
  });
});

describe('inspector theme line', () => {
  it('a themed ride shows its bonus, its matching pieces and the maximum', () => {
    const { session, objectId } = parkWith('moonpetal-carousel');
    const ride = session.rides.snapshot(objectId)!;
    const html = renderWith({
      selectedRide: ride,
      scenery: sceneryWith({ objectId, theme: 'carnival', themeBonus: 6, matchingSources: 2 }, 0.3),
    }, <RideInspector />);
    expect(html).toContain(`<p class="scenery-theme-line">Theme · Carnival: ＋6 from 2 carnival pieces (max ${MAX})</p>`);
    // The bonus grid stays the block's last child (a11y.css darkens its small print through that selector).
    expect(html).toMatch(/<p class="scenery-theme-line">[^<]*<\/p><div><span><small>CHOICE BONUS/);
  });

  it('invites matching scenery when none reaches, and an old park says matching is off', () => {
    const { session, objectId } = parkWith('moonpetal-carousel');
    const ride = session.rides.snapshot(objectId)!;
    const none = renderWith({ selectedRide: ride, scenery: sceneryWith({ objectId, theme: 'carnival' }, 0.3) }, <RideInspector />);
    expect(none).toContain(`Theme · Carnival: add carnival scenery within reach for up to ${MAX}`);
    const old = renderWith({ selectedRide: ride, scenery: sceneryWith({ objectId, theme: 'carnival', matchingSources: 2 }, 0) }, <RideInspector />);
    expect(old).toContain('Theme matching is off in this park (saved before themes)');
  });

  it('a themed stall shows the line too; a themeless one does not', () => {
    const { session, objectId } = parkWith('fizz-foundry');
    const service = session.shops.snapshot(objectId)!;
    const html = renderWith({ selectedService: service, scenery: sceneryWith({ objectId, theme: 'carnival', themeBonus: 1, matchingSources: 1 }, 0.3) }, <ServiceInspector />);
    expect(html).toContain(`Theme · Carnival: ＋1 from 1 carnival piece (max ${MAX})`);
    const toilet = BUILD_CATALOG.find((definition) => definition.stats?.serviceType === 'toilet' && !definition.theme)!;
    const plain = parkWith(toilet.id);
    const toiletHtml = renderWith({ selectedService: plain.session.shops.snapshot(plain.objectId)!, scenery: sceneryWith({ objectId: plain.objectId }, 0.3) }, <ServiceInspector />);
    expect(toiletHtml).toContain('AREA SCENERY');
    expect(toiletHtml).not.toContain('scenery-theme-line');
  });
});

describe('management dashboard', () => {
  const session = new ParkSession(null);
  const management = session.management.snapshot();
  const progression = session.progression.snapshot();

  it('the research tab groups the projects by branch, with tiers, effective RP and findings', () => {
    const html = renderWith({ managementOpen: true, managementTab: 'research', management, progression }, <ManagementDashboard />);
    expect(count(html, /class="management-section research-category research-branch"/g)).toBe(4);
    expect(count(html, /Tier 1 · opener/g)).toBe(4);
    expect(count(html, /class="research-tier tier-/g)).toBe(progression.projects.length);
    expect(html).toContain('aria-labelledby="research-branch-garden-appeal"');
    expect(html).toContain('Opens with Garden Appeal, then Seaside Styling, Adventure Styling or Future Styling.');
    expect(count(html, /Finding: \+\d+ RP/g)).toBe(progression.milestones.length);
    expect(html).not.toContain('Reward: +');
    for (const project of progression.projects) expect(html).toContain(`<strong>${project.researchPointCost} RP</strong>`);
  });

  it('the scenery factor reads the live scenery snapshot, while the saved detail keeps its words', () => {
    const factor = management.rating.factors.find((candidate) => candidate.key === 'scenery')!;
    const live = sceneryFactorDetail(management.parkScenery);
    expect(live).not.toBe(factor.detail);
    const html = renderWith({ managementOpen: true, managementTab: 'overview', management }, <ManagementDashboard />);
    expect(html).toContain(`<small>${live}</small>`);
    expect(html).not.toContain(factor.detail);
    expect(factor.detail).toMatch(/connected path tiles decorated; \d+ scenery sources\.$/);
  });
});
