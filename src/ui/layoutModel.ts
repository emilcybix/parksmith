import { UI_LAYOUT_MIN_HEIGHT, UI_LAYOUT_MIN_WIDTH, effectiveUiScale } from '../settings/uiScale';
import { SETTING_OPTIONS, type UiScale } from '../settings/schema';

/**
 * The layout guard's pure rules (Phase 18 step 3). The browser audit (`layout-audit.mjs` in the
 * scratch tools) measures real `getBoundingClientRect()`s of the panels listed here and hands the
 * rectangles to `findOverlaps` / `outsideViewport`; the same functions run in vitest against the
 * anchor model, so a rule is written once and checked twice (numbers here, pixels in the browser).
 *
 * The layer vocabulary mirrors the stacking table at the top of styles.css:
 *   hud     docked panels that share the screen and must never overlap each other
 *   toast   transient messages: above the HUD in z-order, but placed in their own free band
 *   popover a dropdown the player opened (the clock settings): closes on outside click and Esc, so it may cover the HUD and toasts
 *   dialog  modals and the settings panel: they cover the HUD on purpose (a backdrop sits behind them)
 */
export type PanelLayer = 'hud' | 'toast' | 'popover' | 'dialog';

export interface PanelDef {
  id: string;
  selector: string;
  layer: PanelLayer;
}

/** Every floating panel, by the class the markup gives it. */
export const FLOATING_PANELS: readonly PanelDef[] = [
  { id: 'brand', selector: '.top-bar .brand', layer: 'hud' },
  { id: 'top-bar-center', selector: '.top-bar .top-bar-center', layer: 'hud' },
  { id: 'cash-pill', selector: '.top-bar .cash-pill', layer: 'hud' },
  { id: 'clock-popover', selector: '.clock-popover', layer: 'popover' },
  { id: 'utility-bar', selector: '.utility-bar', layer: 'hud' },
  { id: 'coaster-panel', selector: '.coaster-panel', layer: 'hud' },
  { id: 'performance-overlay', selector: '.performance-overlay', layer: 'hud' },
  { id: 'pulse-card', selector: '.pulse-card', layer: 'hud' },
  { id: 'ride-inspector', selector: '.ride-inspector', layer: 'hud' },
  { id: 'paint-panel', selector: '.paint-panel', layer: 'hud' },
  { id: 'management-dashboard', selector: '.management-dashboard', layer: 'hud' },
  { id: 'build-dock', selector: '.build-dock', layer: 'hud' },
  { id: 'cursor-readout', selector: '.cursor-readout', layer: 'hud' },
  { id: 'help-hint', selector: '.help-hint', layer: 'hud' },
  { id: 'view-rotate', selector: '.view-rotate', layer: 'hud' },
  { id: 'clean-view-handle', selector: '.clean-view-handle', layer: 'hud' },
  { id: 'save-strip', selector: '.save-strip', layer: 'toast' },
  { id: 'save-banner', selector: '.save-banner', layer: 'toast' },
  { id: 'toast', selector: '.toast', layer: 'toast' },
  { id: 'management-notifications', selector: '.management-notifications', layer: 'toast' },
  { id: 'settings-panel', selector: '.settings-panel', layer: 'dialog' },
  { id: 'saves-dialog', selector: '.saves-dialog', layer: 'dialog' },
  { id: 'menu-card', selector: '.menu-card', layer: 'dialog' },
  { id: 'scenario-loadout', selector: '.scenario-picker', layer: 'dialog' },
  { id: 'run-screen', selector: '.run-screen', layer: 'dialog' },
  { id: 'leave-run', selector: '.leave-run', layer: 'dialog' },
  { id: 'scenario-result', selector: '.scenario-result', layer: 'dialog' },
  { id: 'recovery-dialog', selector: '.recovery-dialog', layer: 'dialog' },
];

export interface AllowedOverlap {
  a: string;
  b: string;
  reason: string;
}

/**
 * Overlaps that are intentional, each with its reason. Anything not listed here, and not covered by
 * the layer rule in `overlapAllowed`, is a finding. Keep this short: a long list means the layout is
 * wrong, not that the rule is.
 */
export const ALLOWED_OVERLAPS: readonly AllowedOverlap[] = [
  { a: 'saves-dialog', b: 'menu-card', reason: 'Save / Load opened from the menu sits above it (z 45 over 39).' },
  { a: 'settings-panel', b: 'menu-card', reason: 'Settings opened from the menu sits above it (z 42 over 39).' },
  { a: 'scenario-loadout', b: 'menu-card', reason: 'The Scenario loadout opened from the menu sits above it (z 40 over 39).' },
  { a: 'run-screen', b: 'menu-card', reason: 'The Map opened from the pause menu sits above it (z 40 over 39).' },
  { a: 'leave-run', b: 'menu-card', reason: 'The leave-run question raised from the menu sits above it (z 40 over 39, later in the page).' },
  { a: 'leave-run', b: 'run-screen', reason: 'The leave-run question raised over the run map sits above it (z 40 and later in the page).' },
  { a: 'recovery-dialog', b: 'menu-card', reason: 'The recovery prompt is the first decision and sits above every overlay (z 50).' },
];

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
const ALLOWED_KEYS: ReadonlySet<string> = new Set(ALLOWED_OVERLAPS.map((entry) => pairKey(entry.a, entry.b)));

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlacedPanel extends Rect {
  id: string;
  layer: PanelLayer;
}

/** Sub-pixel rounding and shadows are not overlaps: the rectangles must intersect by more than this. */
export const OVERLAP_TOLERANCE = 1;

export const rectsOverlap = (a: Rect, b: Rect, tolerance = OVERLAP_TOLERANCE): boolean => (
  Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > tolerance
  && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > tolerance
);

/**
 * Whether two panels may share pixels. Dialogs sit over the HUD and toasts on purpose (they have a
 * backdrop); a toast over a plain HUD panel is not allowed, because toasts own a free band; two
 * panels on the same layer must be listed in `ALLOWED_OVERLAPS`.
 */
export const overlapAllowed = (a: PlacedPanel, b: PlacedPanel): boolean => {
  if (ALLOWED_KEYS.has(pairKey(a.id, b.id))) return true;
  if (a.layer === 'dialog' && b.layer !== 'dialog') return true;
  if (b.layer === 'dialog' && a.layer !== 'dialog') return true;
  // A popover covers HUD panels and toasts, never a dialog (it closes before one opens).
  if (a.layer === 'popover' && (b.layer === 'hud' || b.layer === 'toast')) return true;
  if (b.layer === 'popover' && (a.layer === 'hud' || a.layer === 'toast')) return true;
  return false;
};

export const findOverlaps = (panels: readonly PlacedPanel[]): Array<[string, string]> => {
  const found: Array<[string, string]> = [];
  for (let i = 0; i < panels.length; i += 1) {
    for (let j = i + 1; j < panels.length; j += 1) {
      const a = panels[i];
      const b = panels[j];
      if (rectsOverlap(a, b) && !overlapAllowed(a, b)) found.push([a.id, b.id]);
    }
  }
  return found;
};

/** Sides on which a rectangle leaves the viewport (empty when it fits, within the tolerance). */
export const outsideViewport = (rect: Rect, width: number, height: number, tolerance = 1): Array<'left' | 'top' | 'right' | 'bottom'> => {
  const sides: Array<'left' | 'top' | 'right' | 'bottom'> = [];
  if (rect.x0 < -tolerance) sides.push('left');
  if (rect.y0 < -tolerance) sides.push('top');
  if (rect.x1 > width + tolerance) sides.push('right');
  if (rect.y1 > height + tolerance) sides.push('bottom');
  return sides;
};

/* ── The supported viewport matrix ────────────────────────────────────────────────────────────── */

export interface Viewport {
  width: number;
  height: number;
  /** `supported` viewports must pass every state; `stress` ones must pass the base states only. */
  tier: 'supported' | 'stress';
}

export const VIEWPORTS: readonly Viewport[] = [
  { width: 1024, height: 640, tier: 'stress' },
  { width: 1100, height: 690, tier: 'supported' },
  { width: 1280, height: 720, tier: 'supported' },
  { width: 1366, height: 768, tier: 'supported' },
  { width: 1440, height: 800, tier: 'supported' },
  { width: 1536, height: 864, tier: 'supported' },
  { width: 1920, height: 1080, tier: 'supported' },
];

export const UI_SCALES: readonly UiScale[] = SETTING_OPTIONS.uiScale;

export interface MatrixCell {
  viewport: Viewport;
  scale: UiScale;
  /** The scale the UI layer really uses after the cap. */
  effective: number;
  /** The UI layer's size in its own (zoomed) pixels, which is what the CSS lays out in. */
  layoutWidth: number;
  layoutHeight: number;
}

export const supportedMatrix = (): MatrixCell[] => {
  const cells: MatrixCell[] = [];
  for (const viewport of VIEWPORTS) {
    for (const scale of UI_SCALES) {
      const effective = effectiveUiScale(scale, viewport.width, viewport.height);
      cells.push({
        viewport,
        scale,
        effective,
        layoutWidth: viewport.width / effective,
        layoutHeight: viewport.height / effective,
      });
    }
  }
  return cells;
};

/* ── The anchor model ─────────────────────────────────────────────────────────────────────────── */

/**
 * The docked panels' fixed numbers, in UI-layer pixels. They are copied from styles.css and a test
 * (layoutModel.test.ts) reads the stylesheet and fails when they drift, so this model is the pure
 * twin of the browser audit: it computes where the anchored panels sit at a given layout size and
 * proves the base layout never overlaps, at every cell of the supported matrix. The heights are the
 * tallest the audit measured (Park Pulse with the First Day card or the map offer; the tallest dock).
 */
export const ANCHORS = {
  sideGutter: 18,
  railLeft: 18,
  railTop: 96,
  railWidth: 40,
  /**
   * The rail with the developer buttons: the tallest it gets (96 to 667). Phase 14 re-measured it in the browser: six
   * player buttons (menu, grid, performance, scenery, crowd flow, settings), the divider and six developer buttons, 40px
   * each with a 7px gap (the old 477 predated the developer weather button).
   */
  railHeightDev: 571,
  /** Buttons on the developer rail (`railHeightDev` is these, their gaps and the 7px divider). */
  railButtonsDev: 12,
  pulseTop: 94,
  pulseWidth: 270,
  /** Park Pulse with First Day, as measured at heights above `compactBelowHeight`. */
  pulseHeight: 369,
  /** The same content after the short-screen tightening (about 45px); the map offer is the tallest case. */
  pulseHeightCompact: 337,
  compactAtMostHeight: 720,
  dockBottom: 17,
  dockWidthMax: 1010,
  dockSideReserve: 190,
  /**
   * The tallest dock. Phase 36 measured it in headless Chromium (Liberation fonts): the Scenery category, where a
   * research-locked card with a two-line name (Harbor Lighthouse) and the Phase 33 requirement line is 126 px tall, makes
   * the dock 223 px (Rides 212, Shops 196, the rest 189). It was 204 (Rides with a tool armed) before Phases 29 and 33.
   */
  dockHeight: 223,
  /** --dock-reserve: from the bottom edge to the top of the tallest dock, plus a gap. */
  dockReserve: 251,
  /** The ride / service inspector beside Park Pulse (`.ride-inspector`: right 300, width 292). */
  inspectorRight: 300,
  inspectorWidth: 292,
  /** Narrow layouts (container width at most this) use the stacked top bar; below the supported range. */
  narrowMaxWidth: 820,
} as const;

/** The rail, the dock and Park Pulse rectangles, in UI-layer pixels, for a layout of the given size. */
export const anchorModel = (layoutWidth: number, layoutHeight: number): PlacedPanel[] => {
  const a = ANCHORS;
  const dockWidth = Math.min(a.dockWidthMax, layoutWidth - a.dockSideReserve);
  const dockX0 = (layoutWidth - dockWidth) / 2;
  const compact = layoutHeight <= a.compactAtMostHeight;
  return [
    { id: 'utility-bar', layer: 'hud', x0: a.railLeft, y0: a.railTop, x1: a.railLeft + a.railWidth, y1: a.railTop + a.railHeightDev },
    {
      id: 'build-dock', layer: 'hud',
      x0: dockX0, x1: dockX0 + dockWidth, y1: layoutHeight - a.dockBottom, y0: layoutHeight - a.dockBottom - a.dockHeight,
    },
    {
      id: 'pulse-card', layer: 'hud',
      x0: layoutWidth - a.sideGutter - a.pulseWidth, x1: layoutWidth - a.sideGutter,
      y0: a.pulseTop, y1: a.pulseTop + (compact ? a.pulseHeightCompact : a.pulseHeight),
    },
  ];
};

/** The smallest layout the UI is laid out for (UI-layer pixels); `uiScale.ts` caps the scale to keep it. */
export const MIN_LAYOUT = { width: UI_LAYOUT_MIN_WIDTH, height: UI_LAYOUT_MIN_HEIGHT } as const;

/** CSS px of the world view the HUD covers on each side (the renderer's `ViewInsets`). */
export interface HudInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Phase 36: how much of the world view the docked HUD covers, in CSS px at UI zoom `zoom`: the rail on the left, the
 * top bar (down to Park Pulse's top), Park Pulse's column on the right (and the inspector beside it when `inspector`),
 * and the dock reserve at the bottom. The voxel camera keeps a plot cell inside what is left when the player pans, and
 * a focus (a complaint link, a Buildings row) puts the building in the middle of what is left instead of under a panel.
 * A rectangle per side, so it is generous where the dock is narrower than the screen.
 */
export const hudInsets = (zoom: number, inspector: boolean): HudInsets => {
  const a = ANCHORS;
  return {
    left: (a.railLeft + a.railWidth) * zoom,
    top: a.pulseTop * zoom,
    right: (inspector ? a.inspectorRight + a.inspectorWidth : a.sideGutter + a.pulseWidth) * zoom,
    bottom: a.dockReserve * zoom,
  };
};
