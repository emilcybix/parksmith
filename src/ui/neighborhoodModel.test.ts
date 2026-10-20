import { describe, expect, it } from 'vitest';
import { CROWD_NOTICE_PRIORITY, type CrowdNoticeLine } from '../app/crowdNotice';
import type { CrowdTile, CrowdView, NeighborhoodMetrics, NeighborhoodView } from '../game/crowd/types';
import * as model from './neighborhoodModel';
import {
  ADVICE_WORDS, BAND_WORDS, bandWord, buildCrowdUi, buildNeighborhoodRows, coverageChips, crowdHoverLine, crowdNoticeText,
  crowdHoverText, crowdUiEqual, groupedNoticeText, hoverLitterText, groupNoticeLines, neighborhoodKpis, neighborhoodMetricCells, neighborhoodSubtitle, overviewLineOf, perMinuteText, unreachedLine,
} from './neighborhoodModel';

const metrics = (patch: Partial<NeighborhoodMetrics> = {}): NeighborhoodMetrics => ({
  guests: 0, happiness: null, hunger: null, thirst: null, toilet: null, spending: 0, litter: 0, scenery: 0, queueing: 0,
  longestWaitSeconds: null, demand: 0, coverage: { food: 1, drink: 1, toilet: 1 }, bands: [20, 0, 0, 0], ...patch,
});

const hood = (key: number, name: string, patch: Partial<NeighborhoodView> = {}, m: Partial<NeighborhoodMetrics> = {}): NeighborhoodView => ({
  key, name, sector: 'north-west', rideIds: key === 0 ? [] : [key, key + 1], memberIds: [], tileCount: 20, focus: { x: 1, y: 1 },
  metrics: metrics(m), worst: null, ...patch,
});

const tile = (key: number, band: CrowdTile['band'], perMinute: number, bottleneck: boolean, cell = { x: 14, y: 9 }): CrowdTile => ({
  cell, band, perMinute, bottleneck, neighborhoodKey: key,
});

const view = (neighborhoods: NeighborhoodView[], bottlenecks: CrowdTile[] = [], patch: Partial<CrowdView> = {}): CrowdView => ({
  tick: 0, neighborhoods, bottlenecks, walking: 0, feedback: false, ...patch,
});

/** Every string the model can produce for a player, for the copy test. */
const everyLine = (): string[] => {
  const kinds = CROWD_NOTICE_PRIORITY;
  return [
    ...kinds.map((kind) => crowdNoticeText(kind, 'Clover Corner')),
    ...kinds.map((kind) => overviewLineOf(crowdNoticeText(kind, 'Clover Corner'))!),
    ...kinds.flatMap((kind) => [groupedNoticeText(kind, ['Clover Corner', 'Oak Row']), groupedNoticeText(kind, ['A', 'B', 'C', 'D', 'E'])]),
    model.NEIGHBORHOODS_EMPTY, model.NEIGHBORHOODS_ADVICE, model.NEIGHBORHOODS_NOTICED_EMPTY, model.NEIGHBORHOODS_TITLE,
    model.NEIGHBORHOODS_KICKER, model.NEIGHBORHOODS_NOTICED_KICKER, model.NEIGHBORHOODS_TAB_LABEL,
    model.CROWD_TOGGLE_LABEL, model.CROWD_TOGGLE_TITLE, model.CROWD_TOGGLE_CLASSIC_TITLE, model.CROWD_LEGEND_TEXT, model.CROWD_CLASSIC_TOAST,
    unreachedLine(1)!, unreachedLine(4)!,
    ...([0, 1, 2, 3] as const).flatMap((band) => [crowdHoverLine({ band, perMinute: 380, bottleneck: band === 3 }, 'Clover Corner'), bandWord(band, false)]),
    ...coverageChips({ food: 1, drink: 0.4, toilet: 0 }).flatMap((chip) => [chip.text, chip.title]),
  ];
};

describe('copy: Park Pulse describes, never prescribes', () => {
  it('no line contains an imperative or advice word (whole words, any case)', () => {
    const banned = new RegExp(`\\b(${ADVICE_WORDS.map((word) => word.replace(' ', '\\s+')).join('|')})\\b`, 'i');
    const lines = everyLine();
    expect(lines.length).toBeGreaterThan(30);
    for (const line of lines) expect(line, line).not.toMatch(banned);
  });

  it('the banned list is the design list', () => {
    expect([...ADVICE_WORDS]).toEqual(['build', 'add', 'place', 'widen', 'move', 'hire', 'should', 'try', 'consider', 'need to']);
  });

  it('the design lines, word for word', () => {
    expect(CROWD_NOTICE_PRIORITY.map((kind) => crowdNoticeText(kind, 'Clover Corner'))).toEqual([
      'Clover Corner has a bottleneck',
      'Clover Corner is becoming crowded',
      'Clover Corner has no toilet within reach',
      'Clover Corner has no food within reach',
      'Clover Corner has nothing to drink within reach',
      'Guests in Clover Corner are unhappy',
      'Litter outpaces your cleaners: bins near Clover Corner would help',
      'Litter is piling up in Clover Corner',
    ]);
    expect(groupedNoticeText('litterOutpaces', ['Clover Corner', 'Oak Row'])).toBe('Litter outpaces your cleaners: bins near Clover Corner and Oak Row would help');
    expect(overviewLineOf('Clover Corner has a bottleneck')).toBe('Clover Corner has a bottleneck · see Neighborhoods');
    expect(overviewLineOf(null)).toBeNull();
    expect(BAND_WORDS).toEqual(['Quiet', 'Normal', 'Busy', 'Severe bottleneck']);
    expect(unreachedLine(0)).toBeNull();
    expect(unreachedLine(3)).toBe('3 buildings have no path access and belong to no neighborhood.');
    expect(unreachedLine(1)).toBe('1 building has no path access and belongs to no neighborhood.');
  });

  it('hover readout: band, flow and name in words; no name off any neighborhood', () => {
    expect(crowdHoverLine({ band: 2, perMinute: 379.6, bottleneck: false }, 'Clover Corner')).toBe('Busy path · 380 guests a minute · Clover Corner');
    expect(crowdHoverLine({ band: 0, perMinute: 1.2, bottleneck: false }, null)).toBe('Quiet path · 1 guest a minute');
    expect(crowdHoverLine({ band: 3, perMinute: 610, bottleneck: true }, 'Oak Row')).toBe('Bottleneck path · 610 guests a minute · Oak Row');
    expect(crowdHoverLine({ band: 3, perMinute: 610, bottleneck: false }, 'Oak Row')).toBe('Severe path · 610 guests a minute · Oak Row');
    expect(perMinuteText(-3)).toBe('0 guests a minute');
    expect(crowdHoverText({ band: 2, perMinute: 380, bottleneck: false, neighborhoodName: 'Clover Corner' })).toBe('Busy path · 380 guests a minute · Clover Corner');
    expect(crowdHoverText({ band: 1, perMinute: 90, bottleneck: false, neighborhoodName: null })).toBe('Normal path · 90 guests a minute');
    expect(crowdHoverText(null)).toBeNull();
  });

  it('Phase 49: the hover readout ends with what lies on the tile, vomit by name', () => {
    const tileAt = { band: 1 as const, perMinute: 90, bottleneck: false, neighborhoodName: null };
    expect(crowdHoverText({ ...tileAt, litterUnits: 0, sick: false })).toBe('Normal path · 90 guests a minute');
    expect(crowdHoverText({ ...tileAt, litterUnits: 4, sick: false })).toBe('Normal path · 90 guests a minute · 4 litter');
    expect(crowdHoverText({ ...tileAt, litterUnits: 3, sick: true })).toBe('Normal path · 90 guests a minute · vomit');
    expect(crowdHoverText({ ...tileAt, litterUnits: 5, sick: true })).toBe('Normal path · 90 guests a minute · vomit and 2 litter');
    expect(hoverLitterText(1, true), 'a sick pile half swept is still vomit').toBe('vomit');
  });
});

describe('rows', () => {
  it('one row per neighborhood in view order with its metrics, walking and words', () => {
    const v = view([
      hood(0, 'Meadow Gate', { sector: 'south' }, { guests: 4 }),
      hood(3, 'Clover Corner', { memberIds: [10, 11, 12], worst: tile(3, 3, 580, true) }, {
        guests: 40, happiness: 61.4, spending: 1234.4, litter: 3, scenery: 12.6, queueing: 7, longestWaitSeconds: 95, demand: 15,
        coverage: { food: 1, drink: 0.5, toilet: 0 }, bands: [10, 4, 4, 2],
      }),
      hood(9, 'Oak Row', { worst: tile(9, 1, 12, false) }, { bands: [15, 5, 0, 0] }),
    ], [tile(3, 3, 580, true)], { walkingByKey: { 0: 2, 3: 11 } });
    const rows = buildNeighborhoodRows(v, { isStall: (id) => id !== 12 });
    expect(rows.map((row) => row.key)).toEqual([0, 3, 9]);
    const [gate, clover, oak] = rows;
    expect(gate.subtitle).toBe('south · park entrance');
    expect(gate.walking).toBe(2);
    expect(clover).toMatchObject({
      name: 'Clover Corner', rideCount: 2, memberCount: 3, walking: 11, guests: 40, happiness: 61.4, band: 3,
      bandWord: 'Severe bottleneck', worst: { cell: { x: 14, y: 9 }, perMinute: 580 }, bottleneck: { x: 14, y: 9 },
      coverage: { food: 1, drink: 0.5, toilet: 0 },
    });
    expect(clover.subtitle).toBe('north-west · 2 rides · 2 stalls · bottleneck at 14, 9');
    expect(oak).toMatchObject({ walking: 0, band: 1, bandWord: 'Normal', worst: null, bottleneck: null });
    expect(oak.subtitle).toBe('north-west · 2 rides');
  });

  it('a severe tile without a structural cause is "Severe", not a bottleneck; the bottleneck list is a fallback', () => {
    const plain = buildNeighborhoodRows(view([hood(3, 'A', { worst: tile(3, 3, 500, false) }, { bands: [19, 0, 0, 1] })]));
    expect(plain[0]).toMatchObject({ band: 3, bandWord: 'Severe', bottleneck: null, worst: { perMinute: 500 } });
    const listed = buildNeighborhoodRows(view(
      [hood(3, 'A', { worst: tile(3, 3, 70, false, { x: 1, y: 2 }) }, { bands: [18, 0, 0, 2] })],
      [tile(3, 3, 50, true, { x: 6, y: 7 })],
    ));
    expect(listed[0]).toMatchObject({ bandWord: 'Severe bottleneck', bottleneck: { x: 6, y: 7 }, worst: { cell: { x: 1, y: 2 } } });
  });

  it('rows never alias the view (a later view cannot mutate a published row)', () => {
    const worst = tile(3, 2, 30, false);
    const source = hood(3, 'A', { worst }, { bands: [10, 0, 10, 0] });
    const [row] = buildNeighborhoodRows(view([source]));
    worst.cell.x = 99;
    source.metrics.coverage.food = 0;
    expect(row.worst!.cell.x).toBe(14);
    expect(row.coverage.food).toBe(1);
  });

  it('subtitle without a stall predicate counts no stalls', () => {
    expect(neighborhoodSubtitle({ key: 4, sector: 'east', rideIds: [4] }, 0, null)).toBe('east · 1 ride');
  });

  it('KPIs: count, busiest (worst band, then flow), neighborhoods with a bottleneck, walking sum', () => {
    const rows = buildNeighborhoodRows(view([
      hood(0, 'Gate'),
      hood(3, 'A', { worst: tile(3, 2, 30, false) }, { bands: [10, 0, 10, 0] }),
      hood(5, 'B', { worst: tile(5, 2, 40, false) }, { bands: [10, 0, 10, 0] }),
    ], [], { walkingByKey: { 0: 1, 3: 2, 5: 3 } }));
    expect(neighborhoodKpis(rows)).toEqual({ count: 3, busiest: 'B', bottlenecks: 0, walking: 6 });
    expect(neighborhoodKpis(buildNeighborhoodRows(view([hood(0, 'Gate')])))).toMatchObject({ busiest: null });
    expect(neighborhoodKpis([])).toEqual({ count: 0, busiest: null, bottlenecks: 0, walking: 0 });
  });

  it('coverage chips in words', () => {
    expect(coverageChips({ food: 1, drink: 0.6, toilet: 0 }).map((chip) => chip.text)).toEqual(['Food ✓', 'Drink 60%', 'Toilet —']);
    expect(coverageChips({ food: 0.999, drink: 0.001, toilet: 0 }).map((chip) => chip.text)).toEqual(['Food 99%', 'Drink 1%', 'Toilet —']);
  });

  it('metric cells in design order with dashes for missing means', () => {
    const [row] = buildNeighborhoodRows(view([hood(3, 'A', {}, { guests: 3, spending: 12_840, longestWaitSeconds: 260, queueing: 4 })]));
    const cells = neighborhoodMetricCells(row);
    expect(cells.map((cell) => cell.label)).toEqual(['GUESTS', 'HAPPY', 'HUNGER', 'THIRST', 'TOILET', 'SPENT', 'LITTER', 'SCENERY', 'QUEUE', 'DEMAND']);
    expect(cells.find((cell) => cell.label === 'HAPPY')!.value).toBe('—');
    expect(cells.find((cell) => cell.label === 'SPENT')!.value).toBe('$12,840');
    expect(cells.find((cell) => cell.label === 'QUEUE')!.title).toBe('4 queueing, longest wait 4 min');
  });
});

describe('buildCrowdUi', () => {
  const v = view([hood(3, 'Clover Corner', { worst: tile(3, 3, 60, true) })], [tile(3, 3, 60, true)]);
  const active: CrowdNoticeLine[] = [
    { key: 3, name: 'Clover Corner', kind: 'bottleneck' },
    { key: 3, name: 'Clover Corner', kind: 'litter' },
  ];

  it('one Pulse line (the first), the Overview line, every line for the dashboard', () => {
    const ui = buildCrowdUi({ view: v, active, rowsOpen: false, hover: null });
    expect(ui).toEqual({
      pulseLine: 'Clover Corner has a bottleneck',
      rows: null,
      overviewLine: 'Clover Corner has a bottleneck · see Neighborhoods',
      hover: null,
      lines: ['Clover Corner has a bottleneck', 'Litter is piling up in Clover Corner'],
      noticed: ['Clover Corner has a bottleneck', 'Litter is piling up in Clover Corner'],
      unreachedCount: 0,
    });
  });

  it('the dashboard groups lines by kind (Wave 4 audit: 8 to 13 lines at 1,000 guests on the dev park)', () => {
    const names = ['Meadow Gate', 'Hawthorn Row', 'Willow Green', 'Buttercup Corner', 'Willow Court'];
    const many: CrowdNoticeLine[] = [
      ...names.map((name, key) => ({ key, name, kind: 'bottleneck' as const })),
      ...[0, 3, 4].map((key) => ({ key, name: names[key], kind: 'crowded' as const })),
      { key: 1, name: names[1], kind: 'unhappy' },
    ];
    const ui = buildCrowdUi({ view: v, active: many, rowsOpen: false, hover: null });
    expect(ui.lines).toHaveLength(9);
    expect(ui.pulseLine).toBe('Meadow Gate has a bottleneck');
    expect(ui.noticed).toEqual([
      'Meadow Gate, Hawthorn Row, Willow Green and 2 other neighborhoods have a bottleneck',
      'Meadow Gate, Buttercup Corner and Willow Court are becoming crowded',
      'Guests in Hawthorn Row are unhappy',
    ]);
    expect(groupNoticeLines([])).toEqual([]);
    expect(groupedNoticeText('litter', ['A', 'B'])).toBe('Litter is piling up in A and B');
    expect(groupedNoticeText('noDrink', ['A', 'B', 'C', 'D'])).toBe('A, B, C and D have nothing to drink within reach');
  });

  it('rows only while the tab is open; nothing without a view', () => {
    expect(buildCrowdUi({ view: v, active: [], rowsOpen: true, hover: 'x', unreachedCount: 2 })).toMatchObject({ pulseLine: null, overviewLine: null, hover: 'x', unreachedCount: 2 });
    expect(buildCrowdUi({ view: v, active: [], rowsOpen: true, hover: null }).rows).toHaveLength(1);
    expect(buildCrowdUi({ view: null, active: [], rowsOpen: true, hover: null }).rows).toBeNull();
    // The unreached count comes from the view unless overridden.
    expect(buildCrowdUi({ view: { ...v, unreached: 3 }, active: [], rowsOpen: false, hover: null }).unreachedCount).toBe(3);
  });

  it('structural equality for the store write', () => {
    const a = buildCrowdUi({ view: v, active, rowsOpen: true, hover: null });
    const b = buildCrowdUi({ view: v, active, rowsOpen: true, hover: null });
    expect(crowdUiEqual(a, b)).toBe(true);
    expect(crowdUiEqual(a, { ...b, hover: 'Busy path' })).toBe(false);
    expect(crowdUiEqual(null, null)).toBe(true);
    expect(crowdUiEqual(a, null)).toBe(false);
  });
});
