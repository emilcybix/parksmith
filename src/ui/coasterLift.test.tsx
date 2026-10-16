import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { describeCoasterLift } from '../game/coaster/lift';
import { COASTER_TYPE_BY_ID } from '../game/coaster/content';
import { coasterSpeedProfile } from '../game/coaster/design';
import { hillDipLayout, withFreeLifts } from '../game/coaster/testLayouts';
import { CoasterSpeedStrip } from './CoasterSpeedStrip';
import { chainCostLine, speedStripModel, SPEED_STRIP_MIN_SCALE } from './coasterSpeedStripModel';
import { liftRowModels, liftSummary } from './coasterLiftRowsModel';
import type { DraftLiftRun } from './store';
import { CoasterLiftRows } from './CoasterLiftRows';

const type = COASTER_TYPE_BY_ID.get('star-chaser')!;
const viewOf = (free: boolean) => {
  const pieces = free ? withFreeLifts(hillDipLayout(), [1, 2, 3]) : hillDipLayout();
  const profile = coasterSpeedProfile(pieces);
  return describeCoasterLift(pieces, profile.travelSeconds, type, 1);
};

describe('speedStripModel', () => {
  it('lays one bar per segment, widths summing to the strip, heights bounded', () => {
    const view = viewOf(true);
    const model = speedStripModel(view, 220, 36);
    expect(model.bars).toHaveLength(view.speeds.length);
    const last = model.bars[model.bars.length - 1];
    expect(last.x + last.w).toBeCloseTo(220, 6);
    for (const bar of model.bars) {
      expect(bar.h).toBeGreaterThanOrEqual(1);
      expect(bar.h).toBeLessThanOrEqual(36);
    }
    expect(model.scale).toBe(Math.max(view.topSpeed, SPEED_STRIP_MIN_SCALE));
  });

  it('is deterministic and marks free climbs and creep, chained ones stay steady', () => {
    const free = speedStripModel(viewOf(true), 220, 36);
    expect(speedStripModel(viewOf(true), 220, 36)).toEqual(free);
    expect(free.bars.some((bar) => bar.kind === 'free' || bar.kind === 'creep')).toBe(true);
    const chained = speedStripModel(viewOf(false), 220, 36);
    expect(chained.bars.some((bar) => bar.kind === 'free' || bar.kind === 'creep')).toBe(false);
    expect(chained.bars.some((bar) => bar.kind === 'chain')).toBe(true);
    expect(chained.summary).toContain('no free climbs');
    expect(free.summary).toMatch(/3 free climbs/);
  });

  it('free climbs slow down on the way up: the top of a free hill is slower than its foot', () => {
    const view = viewOf(true);
    const freeIndexes = view.kinds.flatMap((kind, index) => (kind === 'free' || kind === 'creep' ? [index] : []));
    expect(freeIndexes.length).toBeGreaterThan(0);
    // Within a run of free segments, speed never rises.
    freeIndexes.forEach((index) => {
      if (freeIndexes.includes(index - 1)) expect(view.speeds[index]).toBeLessThanOrEqual(view.speeds[index - 1] + 1e-9);
    });
  });
});

describe('chainCostLine', () => {
  it('names chained pieces and costs, or says every hill is free', () => {
    const line = chainCostLine(viewOf(false));
    expect(line).toMatch(/^Chain lift on \d+ of \d+ climbing pieces · \$[\d,]+ of the build · \$\d+\.\d{2}\/cycle$/);
    const allFree = describeCoasterLift(withFreeLifts(hillDipLayout()), coasterSpeedProfile(withFreeLifts(hillDipLayout())).travelSeconds, type, 1);
    expect(chainCostLine(allFree)).toBe('No chain lift: every hill climbs free.');
  });
});

describe('CoasterSpeedStrip', () => {
  it('renders an accessible svg with a bar per segment and the creep line', () => {
    const view = viewOf(true);
    const html = renderToStaticMarkup(<CoasterSpeedStrip view={view} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Speed from');
    expect((html.match(/<rect/g) ?? []).length).toBe(view.speeds.length);
    expect(html).toContain('speed-creep');
  });
});

describe('lift rows model', () => {
  const runs: DraftLiftRun[] = [
    { start: 3, length: 3, chained: true, verdict: 'ok' },
    { start: 10, length: 1, chained: false, verdict: 'slow' },
    { start: 20, length: 4, chained: false, verdict: 'stalls' },
  ];
  it('labels, badges and summarises', () => {
    const rows = liftRowModels(runs);
    expect(rows.map((row) => row.label)).toEqual(['Hill 1 · 3 pcs', 'Hill 2 · 1 pc', 'Hill 3 · 4 pcs']);
    expect(rows.map((row) => row.badge)).toEqual([null, 'crawls', 'too long']);
    expect(rows.map((row) => row.badgeTone)).toEqual([null, 'amber', 'red']);
    expect(liftSummary(runs)).toBe('1 chained / 2 free climbs');
    expect(liftSummary([])).toBeNull();
  });
});

describe('CoasterLiftRows', () => {
  const keys = {};
  it('shows a row per lift with aria-pressed and the verdict badge', () => {
    const html = renderToStaticMarkup(<CoasterLiftRows keys={keys} chainSavings={80} runs={[
      { start: 3, length: 3, chained: true, verdict: 'ok' },
      { start: 12, length: 2, chained: false, verdict: 'slow' },
    ]} />);
    expect(html).toContain('LIFT HILLS');
    expect(html).toContain('aria-label="Hill 1 · 3 pcs: chain lift"');
    expect(html).toContain('aria-label="Hill 2 · 2 pcs: free climb"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('crawls');
    expect(html).toContain('Free climbs save $80');
    expect(html).toContain('aria-keyshortcuts="l"');
  });
  it('shows nothing without a climb', () => {
    expect(renderToStaticMarkup(<CoasterLiftRows keys={keys} chainSavings={0} runs={[]} />)).toBe('');
  });
});
