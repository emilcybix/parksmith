import { describe, expect, it } from 'vitest';
import { effectiveUiScale } from '../settings/uiScale';
import {
  ALLOWED_OVERLAPS, ANCHORS, FLOATING_PANELS, MIN_LAYOUT, UI_SCALES, VIEWPORTS, anchorModel, findOverlaps, hudInsets,
  outsideViewport, overlapAllowed, rectsOverlap, supportedMatrix, type PlacedPanel,
} from './layoutModel';

// Vitest serves a stylesheet imported with ?raw as empty (CSS handling is off), and the project has no
// node typings, so the file is read through a dynamically named node:fs import.
const nodeFs = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (path: URL, encoding: 'utf8') => string };
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
/** The declaration block of the first rule that starts with this selector. */
const block = (selector: string): string => {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};
const px = (source: string, property: string): number => {
  const match = new RegExp(`${property}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(source);
  expect(match, `${property} in ${source.slice(0, 40)}`).not.toBeNull();
  return Number(match![1]);
};
const panel = (id: string, layer: PlacedPanel['layer'], x0: number, y0: number, x1: number, y1: number): PlacedPanel => ({ id, layer, x0, y0, x1, y1 });

describe('overlap rules', () => {
  it('treats touching edges and sub-pixel slivers as no overlap', () => {
    expect(rectsOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 10, y0: 0, x1: 20, y1: 10 })).toBe(false);
    expect(rectsOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 9.5, y0: 0, x1: 20, y1: 10 })).toBe(false);
    expect(rectsOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 8, y0: 8, x1: 20, y1: 20 })).toBe(true);
  });

  it('reports HUD panels that overlap and ignores allowed layers', () => {
    const a = panel('pulse-card', 'hud', 0, 0, 100, 100);
    const b = panel('ride-inspector', 'hud', 50, 50, 150, 150);
    expect(findOverlaps([a, b])).toEqual([['pulse-card', 'ride-inspector']]);
    expect(findOverlaps([a, panel('settings-panel', 'dialog', 50, 50, 150, 150)])).toEqual([]);
    expect(findOverlaps([a, panel('clock-popover', 'popover', 50, 50, 150, 150)])).toEqual([]);
  });

  it('keeps toasts out of HUD panels, and popovers off dialogs', () => {
    const hud = panel('pulse-card', 'hud', 0, 0, 100, 100);
    expect(findOverlaps([hud, panel('toast', 'toast', 50, 50, 150, 150)])).toEqual([['pulse-card', 'toast']]);
    expect(overlapAllowed(panel('clock-popover', 'popover', 0, 0, 1, 1), panel('settings-panel', 'dialog', 0, 0, 1, 1))).toBe(true);
    expect(overlapAllowed(panel('clock-popover', 'popover', 0, 0, 1, 1), panel('toast', 'toast', 0, 0, 1, 1))).toBe(true);
  });

  it('honours the allow-list in either order', () => {
    const menu = panel('menu-card', 'dialog', 0, 0, 100, 100);
    const saves = panel('saves-dialog', 'dialog', 50, 50, 150, 150);
    expect(findOverlaps([menu, saves])).toEqual([]);
    expect(findOverlaps([saves, menu])).toEqual([]);
    expect(findOverlaps([saves, panel('settings-panel', 'dialog', 60, 60, 160, 160)])).toEqual([['saves-dialog', 'settings-panel']]);
  });

  it('lists each allowed pair once, with a reason, naming known panels', () => {
    const known = new Set(FLOATING_PANELS.map((entry) => entry.id));
    const seen = new Set<string>();
    for (const entry of ALLOWED_OVERLAPS) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(known.has(entry.a) && known.has(entry.b)).toBe(true);
      const key = [entry.a, entry.b].sort().join('|');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('lists the Phase 28 paint panel as a HUD panel of its own (it takes the inspector\'s slot, so the audit checks the two never co-exist)', () => {
    expect(FLOATING_PANELS.find((entry) => entry.id === 'paint-panel')).toEqual({ id: 'paint-panel', selector: '.paint-panel', layer: 'hud' });
    expect(FLOATING_PANELS.find((entry) => entry.id === 'ride-inspector')?.selector).toBe('.ride-inspector');
  });

  it('gives every panel a unique id and selector', () => {
    expect(new Set(FLOATING_PANELS.map((entry) => entry.id)).size).toBe(FLOATING_PANELS.length);
    expect(new Set(FLOATING_PANELS.map((entry) => entry.selector)).size).toBe(FLOATING_PANELS.length);
  });
});

describe('outsideViewport', () => {
  it('names the sides that leave the screen', () => {
    expect(outsideViewport({ x0: 0, y0: 0, x1: 100, y1: 100 }, 200, 200)).toEqual([]);
    expect(outsideViewport({ x0: -5, y0: 0, x1: 100, y1: 210 }, 200, 200)).toEqual(['left', 'bottom']);
    expect(outsideViewport({ x0: -1, y0: -1, x1: 201, y1: 201 }, 200, 200)).toEqual([]);
  });
});

describe('supported viewport matrix', () => {
  const cells = supportedMatrix();

  it('covers every viewport at every UI scale', () => {
    expect(cells).toHaveLength(VIEWPORTS.length * UI_SCALES.length);
    expect(VIEWPORTS.map((v) => `${v.width}x${v.height}`)).toEqual(
      ['1024x640', '1100x690', '1280x720', '1366x768', '1440x800', '1536x864', '1920x1080'],
    );
  });

  it('keeps the layout at least as large as the minimum in every supported cell', () => {
    for (const cell of cells.filter((c) => c.viewport.tier === 'supported')) {
      expect(cell.layoutWidth, `${cell.viewport.width}x${cell.viewport.height}@${cell.scale}`).toBeGreaterThanOrEqual(MIN_LAYOUT.width - 1e-6);
      expect(cell.layoutHeight, `${cell.viewport.width}x${cell.viewport.height}@${cell.scale}`).toBeGreaterThanOrEqual(MIN_LAYOUT.height - 1e-6);
    }
  });

  it('is the stress tier only below the minimum', () => {
    for (const viewport of VIEWPORTS) {
      const below = viewport.width < MIN_LAYOUT.width || viewport.height < MIN_LAYOUT.height;
      expect(viewport.tier === 'stress').toBe(below);
    }
    expect(effectiveUiScale(130, 1024, 640)).toBe(1);
  });
});

describe('anchor model', () => {
  it('has no two docked panels overlapping, and all inside the screen, at every cell', () => {
    // The stress tier (1024x640) is checked in the browser audit with its base states only; the
    // worst-case pulse height here (map offer) does not fit under it, by design.
    for (const cell of supportedMatrix().filter((c) => c.viewport.tier === 'supported')) {
      const label = `${cell.viewport.width}x${cell.viewport.height}@${cell.scale}`;
      const panels = anchorModel(cell.layoutWidth, cell.layoutHeight);
      expect(findOverlaps(panels), label).toEqual([]);
      for (const p of panels) expect(outsideViewport(p, cell.layoutWidth, cell.layoutHeight), `${label} ${p.id}`).toEqual([]);
    }
  });

  it('keeps Park Pulse above the tallest dock where they share columns', () => {
    for (const cell of supportedMatrix().filter((c) => c.viewport.tier === 'supported')) {
      const [, dock, , pulse] = anchorModel(cell.layoutWidth, cell.layoutHeight);
      expect(pulse.y1, `${cell.viewport.width}x${cell.viewport.height}@${cell.scale}`).toBeLessThan(dock.y0);
    }
  });
});

describe('anchors match the stylesheet', () => {
  it('the right column, the rail and the dock', () => {
    const pulse = block('.pulse-card');
    expect(px(pulse, 'right')).toBe(ANCHORS.sideGutter);
    expect(px(pulse, 'top')).toBe(ANCHORS.pulseTop);
    expect(px(pulse, 'width')).toBe(ANCHORS.pulseWidth);
    const rail = block('.utility-bar');
    expect(px(rail, 'left')).toBe(ANCHORS.railLeft);
    expect(px(rail, 'top')).toBe(ANCHORS.railTop);
    expect(px(block('.utility-bar button'), 'width')).toBe(ANCHORS.railWidth);
    const dock = block('.build-dock');
    expect(px(dock, 'bottom')).toBe(ANCHORS.dockBottom);
    expect(dock).toContain(`min(${ANCHORS.dockWidthMax}px, calc(var(--ui-vw) - ${ANCHORS.dockSideReserve}px))`);
  });

  it('the developer rail height is its buttons, gaps and divider (Phase 14 added the crowd flow toggle)', () => {
    const rail = block('.utility-bar');
    const button = block('.utility-bar button');
    const divider = block('.utility-dev-divider');
    const gap = px(rail, 'gap');
    const dividerHeight = px(divider, 'height') + 2 * Number(/margin:\s*(\d+)px/.exec(divider)![1]);
    const items = ANCHORS.railButtonsDev + 1;
    expect(ANCHORS.railHeightDev).toBe(ANCHORS.railButtonsDev * px(button, 'height') + dividerHeight + (items - 1) * gap);
    // The tallest rail still ends above the smallest supported layout's bottom edge.
    expect(ANCHORS.railTop + ANCHORS.railHeightDev).toBeLessThan(MIN_LAYOUT.height);
  });

  it('the dock reserve clears the tallest dock and the hint sits on it', () => {
    expect(css).toContain(`--dock-reserve: ${ANCHORS.dockReserve}px;`);
    expect(ANCHORS.dockReserve).toBeGreaterThanOrEqual(ANCHORS.dockBottom + ANCHORS.dockHeight);
    expect(px(block('.help-hint'), 'bottom')).toBe(ANCHORS.dockReserve);
    // The hint sits on the dock, so it goes with it: a closed dock leaves no line floating over the park.
    expect(readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')).toContain('{dockOpen && <HelpHint />}');
    expect(css).toContain(`@container ui (max-height: ${ANCHORS.compactAtMostHeight}px)`);
  });

  it('Phase 36: the inspector beside Park Pulse, and the HUD insets the camera keeps the plot clear of', () => {
    const inspector = block('.ride-inspector');
    expect(px(inspector, 'right')).toBe(ANCHORS.inspectorRight);
    expect(px(inspector, 'width')).toBe(ANCHORS.inspectorWidth);
    expect(px(inspector, 'top')).toBe(ANCHORS.pulseTop);
    // The tallest dock measured in the browser (Scenery, Phase 36) still fits under the reserve.
    expect(ANCHORS.dockHeight).toBeGreaterThanOrEqual(223);
    expect(block('.cursor-readout')).toContain('bottom: calc(var(--dock-reserve) + 26px);');
    expect(hudInsets(1, false)).toEqual({ left: 58, top: 94, right: 288, bottom: ANCHORS.dockReserve });
    expect(hudInsets(1, true).right).toBe(592);
    expect(hudInsets(1.25, true)).toEqual({ left: 72.5, top: 117.5, right: 740, bottom: ANCHORS.dockReserve * 1.25 });
  });

  it('the message stack is a grid of tracks, not padding (padding would shrink the container-query box)', () => {
    const layer = block('.ui-layer');
    expect(layer).toContain('grid-template-columns: var(--band-l) minmax(0, 1fr) var(--band-r)');
    expect(layer).not.toMatch(/\n\s*padding:/);
    for (const selector of ['.toast', '.management-notifications', '.save-banner']) {
      expect(block(selector), selector).toMatch(/grid-area: \d \/ 2;/);
    }
  });
});
