import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { registerGameCommands } from '../app/gameBridge';
import { ParkSession } from '../game/session/ParkSession';
import { BuildDock, TopBar } from './Hud';
import { researchRequirementLine } from './hudLockModel';
import { ManagementDashboard } from './ManagementDashboard';
import { parkTitleOf } from './modeLabels';
import { DEFAULT_WEATHER_UI } from './weatherModel';
import { useUiStore } from './store';

/**
 * Phase 33 (Readability Pass 2): the locked card's requirement line, the Shops tab, the Overview's Land KPI, the
 * weather popover's guest lines and the park name in the top bar. No DOM: the markup is rendered on the server from a
 * patched initial store (the phase30Markup pattern).
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

const session = new ParkSession(null);
const progression = session.progression.snapshot();
const management = session.management.snapshot();

afterEach(() => registerGameCommands(null));

describe('locked build cards state their exact requirements', () => {
  it('a research-locked ride card adds the project terms under "Requires", and the title carries them too', () => {
    const html = renderWith({ activeCategory: 'rides', progression }, <BuildDock />);
    const spin = progression.projects.find((project) => project.id === 'spin-studies')!;
    const line = researchRequirementLine(spin);
    expect(html).toContain(`Requires Spin Studies</em><em class="build-lock-needs">${line}</em>`);
    expect(html).toContain(`title="Research Spin Studies to build Comet Cups: ${line}"`);
    // Every research-locked card has exactly one requirement line, and is marked so its description gives up a line.
    const locked = progression.projects.filter((project) => project.status !== 'completed').flatMap((project) => project.unlockDefinitionIds);
    const lockedRides = locked.filter((id) => html.includes(`data-definition-id="${id}"`));
    expect((html.match(/class="build-lock-needs"/g) ?? []).length).toBe(lockedRides.length);
    expect((html.match(/needs-research/g) ?? []).length).toBe(lockedRides.length);
  });

  it('an unlocked card has no requirement line', () => {
    const html = renderWith({ activeCategory: 'rides', progression: { ...progression, unlockedDefinitionIds: progression.projects.flatMap((project) => project.unlockDefinitionIds).concat(progression.unlockedDefinitionIds) } }, <BuildDock />);
    expect(html).not.toContain('build-lock-needs');
  });
});

describe('the Shops tab', () => {
  it('the build tab that holds food, drinks and souvenir stalls is called Shops, and its filter rail follows', () => {
    const html = renderWith({ activeCategory: 'shops' }, <BuildDock />);
    expect(html).toContain('<span aria-hidden="true">◒</span>Shops</button>');
    expect(html).not.toContain('Treats');
    expect(html).toContain('aria-label="Filter shops"');
  });
});

describe('Overview: the Land KPI', () => {
  const overview = (patch: Patch): string => renderWith({ managementOpen: true, managementTab: 'overview', management, ...patch }, <ManagementDashboard />);

  it('an estate shows parcels owned of the total and the cheapest next price', () => {
    const html = overview({ land: { ownedParcels: 12, totalParcels: 64, forSaleParcels: 9, cheapestPrice: 1230 } });
    expect(html).toContain('<div class="management-kpis with-land">');
    expect(html).toContain('<span class="land-kpi" title="12 of 64 parcels owned · from $1,230"><small>LAND PARCELS</small><strong>12 <small class="kpi-of">/ 64</small></strong><em class="kpi-note">from $1,230</em></span>');
  });

  it('a wholly owned park has no Land KPI', () => {
    const html = overview({ land: null });
    expect(html).toContain('<div class="management-kpis">');
    expect(html).not.toContain('LAND');
  });
});

describe('the weather popover teaches the guest-life effects', () => {
  it('lists the rain and night lines under the forecast, never in the Pulse', () => {
    const weatherUi = { ...DEFAULT_WEATHER_UI, weatherKind: 'rain' as const, sellingSouvenirs: ['umbrella' as const, 'balloon' as const, 'plush' as const, 'glowWand' as const] };
    const html = renderWith({ clockPopoverOpen: true, weatherUi }, <TopBar />);
    expect(html).toContain('<p class="clock-help weather-guest-line">Rain: guests without an umbrella get soaked and unhappy; umbrellas sell.</p>');
    expect(html).toContain('<p class="clock-help weather-guest-line">Night: guests get cold; warm drinks and glow wands sell.</p>');
    expect(html.indexOf('climate-line')).toBeLessThan(html.indexOf('weather-guest-line'));
  });

  it('a plain day adds nothing', () => {
    expect(renderWith({ clockPopoverOpen: true }, <TopBar />)).not.toContain('weather-guest-line');
  });
});

describe('the park name in the top bar', () => {
  it('replaces the fixed "Garden Gate" subtitle with the park on screen', () => {
    const html = renderWith({ parkTitle: 'Sunny Start' }, <TopBar />);
    expect(html).toContain('<strong>Parksmith</strong><small title="Sunny Start">Sunny Start</small>');
    expect(html).not.toContain('Garden Gate');
    expect(renderWith({ parkTitle: '' }, <TopBar />)).toContain('<strong>Parksmith</strong></span>');
  });

  it('names a scenario, a Map level, or the Sandbox map', () => {
    expect(parkTitleOf({ mode: 'scenario', scenarioName: 'Sunny Start', mapName: 'Meadow Garden' })).toBe('Sunny Start');
    expect(parkTitleOf({ mode: 'run', scenarioName: 'Level 3 · Seaside', mapName: 'Generated map' })).toBe('Level 3 · Seaside');
    expect(parkTitleOf({ mode: 'sandbox', scenarioName: null, mapName: 'Meadow Estate' })).toBe('Meadow Estate');
    expect(parkTitleOf({ mode: 'sandbox', scenarioName: null, mapName: session.map.name })).toBe('Meadow Garden');
  });
});
