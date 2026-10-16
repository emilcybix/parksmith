import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGameCommands, type GameCommands } from '../app/gameBridge';
import { CursorReadout, ParkPulse, UtilityBar } from './Hud';
import { ANCHORS } from './layoutModel';
import { ManagementDashboard } from './ManagementDashboard';
import type { CrowdUi, NeighborhoodRow } from './neighborhoodTypes';
import { setCrowdHeatmap } from './NeighborhoodsTab';
import { useUiStore } from './store';

// The rail is measured with the developer buttons (the tallest it gets), as the layout anchor is.
vi.mock('../app/devMode', async (importOriginal) => ({ ...(await importOriginal<typeof import('../app/devMode')>()), DEVELOPER_MODE: true }));

/**
 * Phase 14 (design Q4, section 7): the crowd flow toggle, the neighborhood Park Pulse line, the pointer readout, the
 * Neighborhoods tab and the Overview line. No DOM: server markup from a patched initial store (the phase16Markup way).
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

const row = (patch: Partial<NeighborhoodRow>): NeighborhoodRow => ({
  key: 3, name: 'Clover Corner', sector: 'north-west', subtitle: 'north-west · 4 rides · 2 stalls · bottleneck at 14, 9',
  rideCount: 4, memberCount: 6, walking: 12, guests: 40, happiness: 64, hunger: 41, thirst: 52, toilet: 33, spending: 12_840,
  litter: 7, scenery: 34, queueing: 18, longestWaitSeconds: 260, demand: 30, coverage: { food: 1, drink: 0.6, toilet: 0 },
  band: 3, bandWord: 'Severe bottleneck', worst: { cell: { x: 14, y: 9 }, perMinute: 580 }, bottleneck: { x: 14, y: 9 }, ...patch,
});

const crowd = (patch: Partial<CrowdUi> = {}): CrowdUi => ({
  pulseLine: 'Clover Corner has a bottleneck',
  rows: null,
  overviewLine: 'Clover Corner has a bottleneck · see Neighborhoods',
  hover: null,
  lines: ['Clover Corner has a bottleneck', 'Litter is piling up in Clover Corner'],
  ...patch,
});

const management = (): NonNullable<Patch['management']> => {
  // The smallest snapshot the Overview needs; the Neighborhoods tab reads only `crowd`.
  return {
    guestCount: 40,
    notifications: [],
    trends: [],
    rating: { score: 70, factors: [] },
    operations: {
      averageHappiness: 70, averageQueueSeconds: 0, totalQueued: 0, rides: { open: 1, total: 1, ridersToday: 0 },
      services: { open: 0, total: 0, customersServed: 0 }, needs: { hungry: 0, thirsty: 0, toilet: 0 },
    },
    finances: { operating: { profit: 0 } },
  } as unknown as NonNullable<Patch['management']>;
};

describe('the crowd flow rail toggle', () => {
  it('a toggle beside the scenery heatmap: label, title, aria-pressed and the legend in words', () => {
    const html = renderWith({ showCrowdHeatmap: true }, <UtilityBar />);
    expect(html).toMatch(/<button class="active crowd" aria-label="Crowd flow" aria-pressed="true" aria-description="Path colours: Quiet, Normal, Busy, Severe bottleneck" title="Toggle crowd flow heatmap \(T\)" aria-keyshortcuts="t">/);
    expect(html.indexOf('aria-label="Scenery influence"')).toBeLessThan(html.indexOf('aria-label="Crowd flow"'));
    expect(renderWith({}, <UtilityBar />)).toMatch(/class="crowd" aria-label="Crowd flow" aria-pressed="false"/);
  });

  it('classic renderer: focusable, aria-disabled, never pressed, and says why', () => {
    const html = renderWith({ crowdHeatmapSupported: false, showCrowdHeatmap: true }, <UtilityBar />);
    expect(html).toMatch(/class="crowd" aria-label="Crowd flow" aria-pressed="false" aria-disabled="true"[^>]*title="Crowd flow heatmap \(voxel renderer only\)"/);
    expect(html).not.toMatch(/disabled=""/);
    // Wave 4 audit: the title is not read out next to an aria-description, so the reason leads the description.
    expect(html).toMatch(/aria-description="The crowd heatmap is drawn by the voxel renderer\. Path colours: Quiet, Normal, Busy, Severe bottleneck"/);
  });

  it('the developer rail holds the anchored number of buttons', () => {
    expect(count(renderWith({}, <UtilityBar />), /<button/g)).toBe(ANCHORS.railButtonsDev);
  });
});

describe('setCrowdHeatmap: exclusive with the scenery heatmap', () => {
  const calls: string[] = [];
  const commands = {
    setCrowdHeatmapVisible: (visible: boolean) => calls.push(`crowd:${visible}`),
    setSceneryInfluenceVisible: (visible: boolean) => calls.push(`scenery:${visible}`),
    focusNeighborhood: (key: number) => calls.push(`focus:${key}`),
  } as unknown as GameCommands;
  afterEach(() => {
    registerGameCommands(null);
    calls.length = 0;
    useUiStore.setState(useUiStore.getInitialState(), true);
  });

  it('crowd on turns scenery off (store and bridge); off leaves scenery alone', () => {
    registerGameCommands(commands);
    useUiStore.setState({ showSceneryInfluence: true });
    setCrowdHeatmap(true);
    expect(useUiStore.getState()).toMatchObject({ showSceneryInfluence: false, showCrowdHeatmap: true });
    expect(calls).toEqual(['scenery:false', 'crowd:true']);
    setCrowdHeatmap(false);
    expect(useUiStore.getState()).toMatchObject({ showSceneryInfluence: false, showCrowdHeatmap: false });
    expect(calls.at(-1)).toBe('crowd:false');
  });

  it('classic: the store stays off; the press reaches GameApp (its toast)', () => {
    registerGameCommands(commands);
    useUiStore.setState({ crowdHeatmapSupported: false, showSceneryInfluence: true });
    setCrowdHeatmap(true);
    expect(useUiStore.getState()).toMatchObject({ showSceneryInfluence: true, showCrowdHeatmap: false });
    expect(calls).toEqual(['crowd:true']);
  });
});

describe('Park Pulse: one neighborhood line in the thought slot', () => {
  const thoughts = [{ text: 'guests are hungry', count: 4, objectId: null, objectName: null }, { text: 'guests want a bin', count: 2, objectId: null, objectName: null }];

  it('takes a thought line; never a fourth line (Phase 30 widened the budget from two lines to three)', () => {
    const three = [...thoughts, { text: 'guests are thirsty', count: 2, objectId: null, objectName: null }];
    const html = renderWith({ crowd: crowd(), pulseInsights: three as Patch['pulseInsights'] }, <ParkPulse />);
    expect(count(html, /class="pulse-crowd"/g)).toBe(1);
    expect(html).toContain('<p class="pulse-crowd"><span aria-hidden="true">≋</span>Clover Corner has a bottleneck</p>');
    expect(html).toContain('guests are hungry');
    expect(html).toContain('guests want a bin');
    expect(html).not.toContain('guests are thirsty');
    expect(html).not.toContain('Litter is piling up');
  });

  it('below the capacity line: capacity + crowd, and one thought slot is kept (Phase 30)', () => {
    const view = { ceiling: 52, rideSeats: 38, rating: 61, crowdMultiplier: 1, hardMaximum: 1000, blocked: null };
    const html = renderWith({ crowd: crowd(), pulseInsights: thoughts as Patch['pulseInsights'], guestCount: 52, guestCapacity: view, atCapacity: true }, <ParkPulse />);
    const insights = html.slice(html.indexOf('<div class="pulse-insights">'), html.indexOf('</div>', html.indexOf('<div class="pulse-insights">')));
    expect(insights).toMatch(/^<div class="pulse-insights"><p class="pulse-capacity">.*<\/p><p class="pulse-crowd">.*Clover Corner has a bottleneck<\/p><p><span aria-hidden="true">✦<\/span><strong>4<\/strong> guests are hungry<\/p>$/);
    expect(insights).not.toContain('guests want a bin');
  });

  it('no crowd field: Park Pulse is as before', () => {
    const html = renderWith({ crowd: null, pulseInsights: thoughts as Patch['pulseInsights'] }, <ParkPulse />);
    expect(html).not.toContain('pulse-crowd');
    expect(html).toContain('guests want a bin');
  });
});

describe('the pointer readout over a path', () => {
  const hover = 'Busy path · 380 guests a minute · Clover Corner';
  it('pointer tool + heatmap on + a hovered path: the words and the cell', () => {
    const html = renderWith({ tool: 'pointer', hoveredCell: { x: 14, y: 9 }, showCrowdHeatmap: true, crowd: crowd({ hover }) }, <CursorReadout />);
    expect(html).toBe(`<div class="cursor-readout crowd-readout"><strong>${hover}</strong><small>14, 9</small></div>`);
  });

  it('nothing with the heatmap off, off the network or without a hovered cell', () => {
    expect(renderWith({ tool: 'pointer', hoveredCell: { x: 1, y: 1 }, showCrowdHeatmap: false, crowd: crowd({ hover }) }, <CursorReadout />)).toBe('');
    expect(renderWith({ tool: 'pointer', hoveredCell: { x: 1, y: 1 }, showCrowdHeatmap: true, crowd: crowd({ hover: null }) }, <CursorReadout />)).toBe('');
    expect(renderWith({ tool: 'pointer', hoveredCell: null, showCrowdHeatmap: true, crowd: crowd({ hover }) }, <CursorReadout />)).toBe('');
  });
});

describe('the Neighborhoods tab', () => {
  const open = (patch: Patch): string => renderWith({ managementOpen: true, managementTab: 'neighborhoods', management: management(), ...patch }, <ManagementDashboard />);

  it('a seventh tab in the tablist, selected, controlling its panel', () => {
    const html = open({ crowd: crowd({ rows: [] }) });
    expect(count(html, /role="tab"/g)).toBe(7);
    expect(html).toMatch(/id="management-tab-neighborhoods" role="tab" aria-selected="true" aria-controls="management-neighborhoods"/);
    expect(html).toMatch(/role="tabpanel" id="management-neighborhoods" aria-labelledby="management-tab-neighborhoods"/);
  });

  it('one button per row: name, subtitle, CROWD word, metric cells and coverage chips in words', () => {
    const rows = [
      row({ key: 0, name: 'Meadow Gate', subtitle: 'south · park entrance', band: 1, bandWord: 'Normal', worst: null, bottleneck: null, walking: 3 }),
      row({}),
    ];
    const html = open({ crowd: crowd({ rows, unreachedCount: 2 }) });
    expect(count(html, /<button class="neighborhood-row/g)).toBe(2);
    expect(html).toContain('<button class="neighborhood-row band-3 has-bottleneck" title="Show Clover Corner on the map">');
    expect(html.indexOf('title="Show Meadow Gate on the map"')).toBeLessThan(html.indexOf('title="Show Clover Corner on the map"'));
    expect(html).toContain('north-west · 4 rides · 2 stalls · bottleneck at 14, 9');
    expect(html).toContain('<small>CROWD</small><strong>Severe bottleneck</strong>');
    expect(html).toContain('<small>SPENT</small><strong>$12,840</strong>');
    expect(html).toContain('>Food ✓</span>');
    expect(html).toContain('>Drink 60%</span>');
    expect(html).toContain('>Toilet —</span>');
    // KPIs: NEIGHBORHOODS, BUSIEST, BOTTLENECKS, GUESTS WALKING.
    expect(html).toContain('<small>NEIGHBORHOODS</small><strong>2</strong>');
    expect(html).toContain('<small>BUSIEST</small><strong class="kpi-name">Clover Corner</strong>');
    expect(html).toContain('<small>BOTTLENECKS</small><strong>1</strong>');
    expect(html).toContain('<small>GUESTS WALKING</small><strong>15</strong>');
    // Every line the tracker has on, the legend, the advice and the unreached note.
    expect(html).toContain('Litter is piling up in Clover Corner');
    expect(html).toMatch(/<ul class="crowd-legend" aria-label="Crowd flow heatmap colours">.*Quiet.*Normal.*Busy.*Severe bottleneck.*<\/ul>/);
    expect(html).toContain('Select a row to centre the camera on it.');
    expect(html).toContain('2 buildings have no path access and belong to no neighborhood.');
  });

  it('empty park and not yet published', () => {
    const empty = open({ crowd: crowd({ rows: [], lines: [], pulseLine: null, overviewLine: null }) });
    expect(empty).toContain('Neighborhoods form around rides. This park has none yet.');
    expect(empty).toContain('Nothing stands out in any neighborhood right now.');
    expect(empty).not.toContain('Select a row');
    const waiting = open({ crowd: null });
    expect(waiting).toContain('Collecting park data…');
    expect(waiting).toContain('<small>NEIGHBORHOODS</small><strong>—</strong>');
  });
});

describe('the Overview line', () => {
  it('names the top neighborhood line as a button into the tab; absent without one', () => {
    const html = renderWith({ managementOpen: true, managementTab: 'overview', management: management(), crowd: crowd() }, <ManagementDashboard />);
    expect(html).toContain('<button class="overview-crowd-line"><i aria-hidden="true">≋</i><span>Clover Corner has a bottleneck · see Neighborhoods</span></button>');
    const none = renderWith({ managementOpen: true, managementTab: 'overview', management: management(), crowd: crowd({ overviewLine: null }) }, <ManagementDashboard />);
    expect(none).not.toContain('overview-crowd-line');
  });
});
