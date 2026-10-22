import { Container, Graphics, GraphicsContext } from 'pixi.js';
import { BUILD_BY_ID } from '../../../game/content/catalog';
import type { ParkSession } from '../../../game/session/ParkSession';
import { footprintSize } from '../../../game/types';
import { TILE_HEIGHT, TILE_WIDTH } from '../../isometric';
import { cellToView, createViewFrame, type MutableViewFrame, type ViewFrame, type XY } from '../../viewRotation';
import { sameViewFrame } from './overlays';

/**
 * Pixel badges above placed objects, drawn into the voxel overlay target: a fill bar for a rubbish
 * bin (hidden while empty, green → red when full) and an alert for a ride that is broken (red '!')
 * or under maintenance (amber wrench), or for a ride or service with no path from the gate (Phase 11,
 * PA-024: a slate disc with a "no entry" bar, static because it is a standing condition, not an alarm).
 * Priority: broken > maintenance > no access. They mirror the classic renderer's bin indicators and ride
 * alerts, redrawn for a low-res target: whole-texel geometry from Graphics rects, opaque (the
 * composite dithers by alpha, and a dithered 1-texel glyph is unreadable), no Pixi Text.
 *
 * Nothing is rebuilt per frame. The shapes are four shared GraphicsContexts built once; each badge
 * is a Container holding Graphics that point at them, so a frame only toggles `visible`, sets whole
 * texel positions and scales the one-texel bar to its height. A bin bar growing is a scale change,
 * not a redraw. The bob of an alert is two whole-texel steps (no scale animation, which would
 * resample the glyph).
 *
 * `version` changes only when a badge's picture actually changes (appears, vanishes, bar height,
 * colour, position, bob step), so the renderer re-renders the overlay target on those frames alone.
 * Data is read straight from the simulations' live maps (the same cheap path the figure packer
 * uses), never from `operations.snapshot()`, and without allocating.
 *
 * View rotation (Phase 26): a badge's anchor is the object's footprint centre (a fractional cell-index
 * point, from WORLD data) mapped with `cellToView`, and its height is the object's top (world z, unchanged by
 * the turn). `setView` re-places every shown badge in view space at once and bumps `version` once.
 */

export const BIN_BAR_MAX_TEXELS = 12;
/** Bob period: the alert sits one texel higher on every other step. */
export const ALERT_BOB_STEP_MS = 400;

const COLOR_INK = 0x173f3b;
const COLOR_WHITE = 0xffffff;
const COLOR_BIN_OK = 0x58d9ad;
const COLOR_BIN_FULL = 0xff6277;
const COLOR_BROKEN = 0xff6277;
const COLOR_MAINTENANCE = 0xf4b94e;
/** Phase 11 (PA-024): a slate disc, distinct in hue from the red and amber alarms. */
const COLOR_NO_ACCESS = 0x8fa6bd;

/** Clearance (texels) between an object's top and the foot of its badge. */
const BIN_CLEARANCE = 3;
const ALERT_CLEARANCE = 9;

/** Row widths of a pixel disc, top to bottom, each row centred on x = 0. */
const DISC_INNER = [4, 8, 10, 12, 12, 12, 12, 12, 12, 10, 8, 4];
const DISC_OUTER = [6, 10, 12, 14, 14, 14, 14, 14, 14, 14, 14, 12, 10, 6];

/** '!' (2 wide) and an open-end spanner (6 wide): '#' is ink, rows top to bottom. */
const GLYPH_BROKEN = ['##', '##', '##', '##', '##', '..', '##', '##'];
const GLYPH_MAINTENANCE = ['##..##', '##..##', '######', '.####.', '..##..', '..##..', '..##..', '..##..'];
/** The "no entry" bar (8 × 2): a silhouette unlike '!' and the spanner. */
const GLYPH_NO_ACCESS = ['########', '########'];

const paintDisc = (graphic: Graphics, widths: readonly number[], color: number): void => {
  const top = -widths.length / 2;
  widths.forEach((width, row) => graphic.rect(-width / 2, top + row, width, 1).fill(color));
};

/** Draws a '#' grid with its centre on x = 0 and y = 0 (rows merged into horizontal runs). */
const paintGlyph = (graphic: Graphics, rows: readonly string[], color: number): void => {
  const left = -rows[0].length / 2;
  const top = -rows.length / 2;
  rows.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const on = x < row.length && row[x] === '#';
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        graphic.rect(left + start, top + y, x - start, 1).fill(color);
        start = -1;
      }
    }
  });
};

const buildAlertContext = (color: number, glyph: readonly string[]): GraphicsContext => {
  const art = new Graphics();
  paintDisc(art, DISC_OUTER, COLOR_WHITE);
  paintDisc(art, DISC_INNER, color);
  paintGlyph(art, glyph, COLOR_INK);
  return art.context;
};

/** Frame: a white border, dark well; the bar sits on y = 0 inside it and grows up. */
const buildBinFrameContext = (): GraphicsContext => {
  const art = new Graphics();
  art.rect(-3, -BIN_BAR_MAX_TEXELS - 1, 6, BIN_BAR_MAX_TEXELS + 2).fill(COLOR_WHITE);
  art.rect(-2, -BIN_BAR_MAX_TEXELS, 4, BIN_BAR_MAX_TEXELS).fill(COLOR_INK);
  return art.context;
};

/** One texel tall, hanging up from y = 0, so scale.y is its height in texels. */
const buildBinBarContext = (): GraphicsContext => {
  const art = new Graphics();
  art.rect(-1, -1, 2, 1).fill(COLOR_WHITE);
  return art.context;
};

type AlertKind = 0 | 1 | 2 | 3;
const ALERT_NONE: AlertKind = 0;
const ALERT_BROKEN: AlertKind = 1;
const ALERT_MAINTENANCE: AlertKind = 2;
const ALERT_NO_ACCESS: AlertKind = 3;

/** The no-access badge does not bob: it is a standing condition, not an alarm. */
const bobFor = (kind: AlertKind, bobStep: number): number => (kind === ALERT_NO_ACCESS ? 0 : bobStep);

interface Badge {
  readonly objectId: number;
  readonly root: Container;
  /** Bin: the scaled bar; null for alerts. */
  readonly bar: Graphics | null;
  /** Alert: which glyph is built (the badge is replaced when it changes); 0 for bins. */
  readonly alert: AlertKind;
  seen: number;
  shown: boolean;
  x: number;
  y: number;
  barTexels: number;
  full: boolean;
}

export class VoxelBadges {
  /** Bumped when a badge's picture changes. Only ever grows. */
  version = 0;
  private readonly layer = new Container();
  private readonly frameContext = buildBinFrameContext();
  private readonly barContext = buildBinBarContext();
  private readonly brokenContext = buildAlertContext(COLOR_BROKEN, GLYPH_BROKEN);
  private readonly maintenanceContext = buildAlertContext(COLOR_MAINTENANCE, GLYPH_MAINTENANCE);
  private readonly noAccessContext = buildAlertContext(COLOR_NO_ACCESS, GLYPH_NO_ACCESS);
  private readonly bins = new Map<number, Badge>();
  private readonly alerts = new Map<number, Badge>();
  private readonly badges: Badge[] = [];
  private sweep = 0;
  private bobStep = 0;
  private visibleCount = 0;
  private readonly frame: MutableViewFrame = createViewFrame();
  /** Scratch for the view-mapped anchor (no allocation per update). */
  private readonly anchor: XY = { x: 0, y: 0 };

  constructor(root: Container, private readonly session: () => ParkSession, private readonly objectTop: (objectId: number) => number | null) {
    root.addChild(this.layer);
  }

  /** True when no badge is showing. */
  get isEmpty(): boolean {
    return this.visibleCount === 0 || !this.layer.visible;
  }

  /**
   * Phase 55: hidden at the far zoom levels, where the badges (pixel art at one texel per texel) would shrink to
   * specks: an overview. They keep updating, so they are where they belong when shown again. One `version` bump on a
   * change.
   */
  setHidden(hidden: boolean): void {
    if (this.layer.visible === !hidden) return;
    this.layer.visible = !hidden;
    this.version += 1;
  }

  /**
   * The map was turned: copies the rotation and the world map size, re-places every shown badge in view space
   * and bumps `version` once (only when the frame differs; a repeated call does nothing). The next `update`
   * finds every badge where it belongs and draws nothing.
   */
  setView(frame: ViewFrame): void {
    const same = sameViewFrame(frame, this.frame);
    this.frame.rotation = frame.rotation;
    this.frame.width = frame.width;
    this.frame.height = frame.height;
    if (same) return;
    for (const badge of this.badges) {
      if (!badge.shown) continue;
      const alert = badge.alert !== ALERT_NONE;
      if (!this.anchorOf(badge, alert ? ALERT_CLEARANCE : BIN_CLEARANCE, bobFor(badge.alert, this.bobStep))) continue;
      badge.x = this.anchor.x;
      badge.y = this.anchor.y;
      badge.root.position.set(badge.x, badge.y);
    }
    this.version += 1;
  }

  /** A new park: every badge goes, and the next update rebuilds from its simulations. */
  reset(): void {
    if (this.badges.length === 0) return;
    for (const badge of this.badges) badge.root.destroy({ children: true });
    this.badges.length = 0;
    this.bins.clear();
    this.alerts.clear();
    this.visibleCount = 0;
    this.version += 1;
  }

  /** Releases the shared shapes (the containers go with the overlay root). */
  destroy(): void {
    this.frameContext.destroy();
    this.barContext.destroy();
    this.brokenContext.destroy();
    this.maintenanceContext.destroy();
    this.noAccessContext.destroy();
  }

  /**
   * Syncs every badge with the park for this frame. Draws nothing and allocates nothing in a steady
   * state; `elapsedMs` only picks the bob step.
   */
  update(elapsedMs: number): void {
    this.bobStep = Math.floor(elapsedMs / ALERT_BOB_STEP_MS) & 1;
    this.sweep += 1;
    const session = this.session();
    session.operations.bins.forEach(this.syncBin);
    session.rides.rides.forEach(this.syncRide);
    session.shops.services.forEach(this.syncService);
    // Badges whose object or state went away this sweep: swap-remove, no iteration allocation.
    for (let index = this.badges.length - 1; index >= 0; index -= 1) {
      const badge = this.badges[index];
      if (badge.seen === this.sweep) continue;
      (badge.alert === ALERT_NONE ? this.bins : this.alerts).delete(badge.objectId);
      this.badges[index] = this.badges[this.badges.length - 1];
      this.badges.pop();
      if (badge.shown) {
        this.visibleCount -= 1;
        this.version += 1;
      }
      badge.root.destroy({ children: true });
    }
  }

  private readonly syncBin = (bin: { objectId: number; fill: number; capacity: number }): void => {
    let badge = this.bins.get(bin.objectId);
    if (!badge) {
      badge = this.createBin(bin.objectId);
      this.bins.set(bin.objectId, badge);
    }
    badge.seen = this.sweep;
    const fill = Math.max(0, Math.min(1, bin.fill / Math.max(1, bin.capacity)));
    const texels = fill > 0 ? Math.max(1, Math.round(fill * BIN_BAR_MAX_TEXELS)) : 0;
    const full = bin.fill >= bin.capacity;
    this.place(badge, texels > 0, BIN_CLEARANCE, 0, texels, full);
  };

  /** Rides: broken > maintenance > no path access (PA-024). */
  private readonly syncRide = (ride: { objectId: number; broken: boolean; maintenanceKind: unknown }): void => {
    const kind = ride.broken
      ? ALERT_BROKEN
      : ride.maintenanceKind
        ? ALERT_MAINTENANCE
        : this.session().management.hasPathAccess(ride.objectId) ? ALERT_NONE : ALERT_NO_ACCESS;
    this.syncAlert(ride.objectId, kind);
  };

  /** Services (Phase 11, PA-024): only the no-access badge; they never break. */
  private readonly syncService = (service: { objectId: number }): void => {
    this.syncAlert(service.objectId, this.session().management.hasPathAccess(service.objectId) ? ALERT_NONE : ALERT_NO_ACCESS);
  };

  private syncAlert(objectId: number, kind: AlertKind): void {
    if (kind === ALERT_NONE) return;
    let badge = this.alerts.get(objectId);
    if (badge && badge.alert !== kind) {
      // A change of kind swaps the glyph: drop the old badge now and build the other one.
      this.alerts.delete(objectId);
      this.badges[this.badges.indexOf(badge)] = this.badges[this.badges.length - 1];
      this.badges.pop();
      if (badge.shown) this.visibleCount -= 1;
      badge.root.destroy({ children: true });
      badge = undefined;
    }
    if (!badge) {
      badge = this.createAlert(objectId, kind);
      this.alerts.set(objectId, badge);
    }
    badge.seen = this.sweep;
    this.place(badge, true, ALERT_CLEARANCE, bobFor(kind, this.bobStep), 0, false);
  }

  /**
   * Moves a badge to above its object (whole texels) and records what changed. The object's ground
   * centre in texel space is (32 (cx − cy), 16 (cx + cy + 1)) for the centre cell (cx, cy), the same
   * point `cellToWorld(centre) + TILE_HEIGHT / 2` gives the classic renderer; the scene's objectTop
   * lifts it. Unknown objects or tops (not built yet) hide the badge until they are known.
   */
  private place(badge: Badge, wanted: boolean, clearance: number, bob: number, barTexels: number, full: boolean): void {
    let show = wanted;
    let x = badge.x;
    let y = badge.y;
    if (show) {
      if (this.anchorOf(badge, clearance, bob)) {
        x = this.anchor.x;
        y = this.anchor.y;
      } else {
        show = false;
      }
    }
    const moved = show && (x !== badge.x || y !== badge.y);
    const restyled = show && (badge.barTexels !== barTexels || badge.full !== full);
    if (show === badge.shown && !moved && !restyled) return;
    if (show !== badge.shown) this.visibleCount += show ? 1 : -1;
    badge.shown = show;
    badge.root.visible = show;
    badge.x = x;
    badge.y = y;
    badge.barTexels = barTexels;
    badge.full = full;
    badge.root.position.set(x, y);
    if (badge.bar) {
      badge.bar.scale.y = Math.max(1, barTexels);
      badge.bar.tint = full ? COLOR_BIN_FULL : COLOR_BIN_OK;
    }
    this.version += 1;
  }

  /**
   * The badge's whole-texel position for `clearance` and `bob` in the current view, into `this.anchor`. False when
   * the object or its top is not known yet. The footprint centre (cell-index space, fractional) is mapped to the
   * view, then projected as before: (32 (u - v), 16 (u + v) + 16 - top).
   */
  private anchorOf(badge: Badge, clearance: number, bob: number): boolean {
    const session = this.session();
    const object = session.world.objects.get(badge.objectId);
    const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
    const top = object ? this.objectTop(badge.objectId) : null;
    if (!object || !definition || top === null) return false;
    const size = footprintSize(definition, object.rotation);
    cellToView(this.frame, object.anchor.x + (size[0] - 1) / 2, object.anchor.y + (size[1] - 1) / 2, this.anchor);
    const centreX = this.anchor.x;
    const centreY = this.anchor.y;
    this.anchor.x = Math.round((centreX - centreY) * TILE_WIDTH / 2);
    this.anchor.y = Math.round((centreX + centreY) * TILE_HEIGHT / 2 + TILE_HEIGHT / 2 - top) - clearance - bob;
    return true;
  }

  private createBin(objectId: number): Badge {
    const root = new Container();
    root.visible = false;
    const bar = new Graphics(this.barContext);
    root.addChild(new Graphics(this.frameContext), bar);
    this.layer.addChild(root);
    const badge: Badge = { objectId, root, bar, alert: ALERT_NONE, seen: 0, shown: false, x: 0, y: 0, barTexels: -1, full: false };
    this.badges.push(badge);
    return badge;
  }

  private createAlert(objectId: number, kind: AlertKind): Badge {
    const root = new Container();
    root.visible = false;
    const context = kind === ALERT_BROKEN
      ? this.brokenContext
      : kind === ALERT_MAINTENANCE ? this.maintenanceContext : this.noAccessContext;
    root.addChild(new Graphics(context));
    this.layer.addChild(root);
    const badge: Badge = { objectId, root, bar: null, alert: kind, seen: 0, shown: false, x: 0, y: 0, barTexels: 0, full: false };
    this.badges.push(badge);
    return badge;
  }
}
