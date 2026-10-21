import type { ViewInsets } from '../RendererPort';
import type { Cell } from '../../game/types';
import { cellToWorld, TILE_HEIGHT, TILE_WIDTH } from '../isometric';
import type { WheelDelta, WorldInputView } from '../worldInput';
import { ENTRANCE_ANCHOR_HEIGHT_FRACTION, entranceFocus } from '../entranceFraming';
import { cellToView, type ViewFrame, type XY } from '../viewRotation';
import { voxelFromView, voxelToView, type ViewTransform } from './contracts/view';
import { GUARD_BAND_TEXELS, LOW_RES_TEXEL_BUDGET, MAX_ZOOM_CSS_PER_TEXEL } from './contracts/budgets';

/**
 * The voxel renderer's camera: integer zoom, texel-snapped, sized to a texel budget.
 *
 * The picture is drawn into a low-res target at one texel per voxel step (a texel is a legacy world
 * px) and upscaled by a whole number N of device px per texel, so every texel stays a crisp N×N
 * square. The camera keeps a float origin — the world texel at the canvas's top-left device pixel —
 * and snaps it once per frame: a whole texel for the low-res target plus a sub-texel shift of
 * 0..N−1 device px for the upscale. Panning is then smooth at N > 1, yet nothing ever shimmers,
 * because the low-res picture itself only moves in whole texels.
 *
 * Zoom levels come from the screen: the smallest N is the first whose target fits
 * LOW_RES_TEXEL_BUDGET (and the GPU's texture and viewport limits), so a DPR-2 laptop or a DPR-3
 * phone never runs the composite at full backing-store resolution; the largest is
 * MAX_ZOOM_CSS_PER_TEXEL CSS px per texel.
 *
 * Picking, drag pan and wheel zoom come through the shared input binding (worldInput.ts), for which
 * this class is the view. Key pan arrives the same way, as `panByCss`, at the legacy speed.
 *
 * Phase 55: a zoom LEVEL is a pair (texel scale k, zoom N): the low-res target holds k world texels per texel (k = 1
 * at every level but the far ones), each drawn as N × N device px, so a device px shows k / N world texels. The far
 * levels (k = 2 and 4 at the smallest N) draw the scene at half and quarter scale into a target of the same size
 * (`farLevels`; off until the renderer draws them). The origin snaps to whole low-res texels (multiples of k world
 * texels), and with k = 1 every expression below is bit for bit what it was before levels had a k.
 */

/** Highest devicePixelRatio the voxel renderer honours; beyond it the budget decides anyway. */
export const MAX_RESOLUTION = 3;

/** WheelEvent.deltaMode values. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
/** CSS px per wheel line (Firefox reports lines, three per notch). */
const WHEEL_LINE_PX = 16;
/** Normalised wheel units per zoom level: one mouse notch in Chromium and Safari. */
const WHEEL_UNITS_PER_LEVEL = 100;

export interface ZoomLevels {
  /** Smallest N whose low-res target fits the budget and the GPU limits. */
  min: number;
  max: number;
  /** The default: round(R), clamped — one texel per CSS px where the budget allows. */
  initial: number;
}

/** Phase 55: one zoom level: `texelScale` world texels per low-res texel, each drawn as `zoom` × `zoom` device px. */
export interface ZoomLevel {
  readonly texelScale: number;
  readonly zoom: number;
}

/** Phase 55: the far levels' texel scales, furthest first (powers of two, so every `/ k` is exact). */
export const FAR_TEXEL_SCALES: readonly number[] = [4, 2];

/**
 * Phase 55: the levels in order, furthest first: with `far`, (4, min) and (2, min); then (1, N) for every N from min
 * to max. A level's index is what the wheel steps.
 */
export const zoomLevelList = (levels: Readonly<ZoomLevels>, far: boolean): ZoomLevel[] => {
  const list: ZoomLevel[] = far ? FAR_TEXEL_SCALES.map((texelScale) => ({ texelScale, zoom: levels.min })) : [];
  for (let zoom = levels.min; zoom <= levels.max; zoom += 1) list.push({ texelScale: 1, zoom });
  return list;
};

/** Phase 55: the index of the level nearest `devicePerWorld` (device px per world texel); a tie goes nearer. */
export const nearestLevel = (list: readonly ZoomLevel[], devicePerWorld: number): number => {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  list.forEach((level, index) => {
    const distance = Math.abs(Math.log(level.zoom / level.texelScale) - Math.log(devicePerWorld));
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
};

/** The camera as one frame draws it. All values are whole numbers. */
export interface SnappedCamera {
  /** World texel at the canvas's top-left device pixel. */
  texelX: number;
  texelY: number;
  /** Device-px shift of the upscaled picture, in [−(zoom − 1), 0]. */
  offsetX: number;
  offsetY: number;
  /** Device px per low-res texel. */
  zoom: number;
  /** Phase 55: world texels per low-res texel (1, or 2 and 4 at the far levels). */
  texelScale: number;
  /** Low-res target size in texels, guard band included. */
  lowWidth: number;
  lowHeight: number;
  /** World texel at low-res texel (0, 0) — the shaders' uCameraTexel (guard band included). */
  cameraTexelX: number;
  cameraTexelY: number;
}

const turnScratch: XY = { x: 0, y: 0 };

/** Phase 11 (PA-021): how long a player-initiated focus glides (`easeTo`). */
export const CAMERA_EASE_MS = 250;
/** The most one frame may advance a glide, so a hitch slows the glide instead of skipping it. */
export const CAMERA_EASE_MAX_STEP_MS = 50;

/** Ease-out cubic on [0, 1]: fast start, gentle landing, monotone. */
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/**
 * Phase 11 (PA-021): how far (in cells) the ground point under the viewport centre may leave the plot
 * rectangle: `max(2, min(half viewport texels) / TILE_WIDTH − 1)` (design.md). It grows when zoomed out, so the
 * entrance framing is never moved. It is capped at `min(halfX / TILE_WIDTH, halfY / TILE_HEIGHT) − 0.75`: with the
 * centre off a plot CORNER by m cells on both axes, the nearest cell centre is (2m + 1) half-tiles away along one
 * screen axis, so the floor of 2 alone would push the last cell off a small window at the largest zoom (1100 × 690
 * at 4 CSS px per texel). Below the cap the design's formula holds unchanged.
 */
export const plotMarginCells = (halfTexelsX: number, halfTexelsY: number): number =>
  Math.min(
    Math.max(2, Math.min(halfTexelsX, halfTexelsY) / TILE_WIDTH - 1),
    Math.max(0, Math.min(halfTexelsX / TILE_WIDTH, halfTexelsY / TILE_HEIGHT) - 0.75),
  );

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/** An inset rectangle narrower or shorter than this share of the viewport is ignored on that axis (the whole axis counts). */
export const MIN_SAFE_SHARE = 0.25;

/**
 * Low-res target texels along one axis: every visible texel (one more than the view spans, for the
 * sub-texel shift) plus a guard band on each side so no composite tap reads outside the target.
 */
export const lowResSize = (devicePixels: number, zoom: number): number =>
  Math.ceil(devicePixels / zoom) + 1 + 2 * GUARD_BAND_TEXELS;

/** The zoom levels a canvas of `deviceWidth` × `deviceHeight` device px allows at resolution R. */
export const zoomLevelsFor = (
  deviceWidth: number,
  deviceHeight: number,
  resolution: number,
  maxTextureSize: number,
): ZoomLevels => {
  const fits = (zoom: number): boolean => {
    const width = lowResSize(deviceWidth, zoom);
    const height = lowResSize(deviceHeight, zoom);
    return width * height <= LOW_RES_TEXEL_BUDGET && width <= maxTextureSize && height <= maxTextureSize;
  };
  // Past the canvas's own size every target is the same few texels, so the search always ends.
  const limit = Math.max(1, deviceWidth, deviceHeight) + 1;
  let min = 1;
  while (min < limit && !fits(min)) min += 1;
  const max = Math.max(min + 1, Math.floor(MAX_ZOOM_CSS_PER_TEXEL * resolution));
  return { min, max, initial: clamp(Math.round(resolution), min, max) };
};

/**
 * 0 − x rather than −x, so an unshifted axis reads +0 and not −0. `texel` is the snapped origin in world texels (a
 * multiple of `scale`); the shift is in device px within one low-res texel.
 */
const snapOffset = (origin: number, texel: number, zoom: number, scale: number): number =>
  0 - Math.min(zoom - 1, Math.floor((origin - texel) / scale * zoom));

export interface VoxelCameraOptions {
  /** `&zoom=N`: the starting zoom instead of the per-screen default, clamped into the levels. */
  zoomOverride?: number | null;
  /** Phase 55: offer the far levels (half and quarter scale). Off until the renderer draws them. */
  farLevels?: boolean;
}

export class VoxelCamera implements WorldInputView {
  /** World texel (unsnapped) at the canvas's top-left device pixel. */
  originX = 0;
  originY = 0;
  private levels: ZoomLevels = { min: 1, max: 2, initial: 1 };
  /** Phase 55: the levels (`zoomLevelList`) and the one in use. */
  private list: ZoomLevel[] = zoomLevelList(this.levels, false);
  private level = 0;
  private deviceWidth = 0;
  private deviceHeight = 0;
  private resolution = 1;
  private hasViewport = false;
  private wheelAccumulator = 0;
  private readonly zoomOverride: number | null;
  private readonly farLevels: boolean;
  /** The turn chain (retargetForTurn): the origin per view while only turns moved the camera. */
  private readonly turnMemory = new Float64Array(8);
  private turnChainMask = 0;
  private turnChainX = 0;
  private turnChainY = 0;
  private turnChainLevel: ZoomLevel | null = null;
  private turnChainWidth = 0;
  private turnChainHeight = 0;
  private turnChainRotation = 0;
  private turnChainOx = 0;
  private turnChainOy = 0;
  /** The plot in view-cell space (W and H swap under rotation); 0 = no plot yet, no clamp. */
  private plotWidth = 0;
  private plotHeight = 0;
  private plotX0 = 0;
  private plotY0 = 0;
  /** Phase 21: an estate caps the margin (a parcel), so the owned land never leaves the screen. */
  private plotMarginCap = Number.POSITIVE_INFINITY;
  /** Phase 36: the HUD's cover in CSS px, or none (the whole viewport is the safe area, as before). */
  private insets: ViewInsets | null = null;
  /** The safe area in device px, written by `safeArea` (no allocation per clamp). */
  private readonly safe = { x0: 0, x1: 0, y0: 0, y1: 0 };
  /** The running glide (easeTo), or none. */
  private easing = false;
  private easeElapsed = 0;
  private easeDuration = CAMERA_EASE_MS;
  private easeFromX = 0;
  private easeFromY = 0;
  private easeToX = 0;
  private easeToY = 0;

  constructor(options: VoxelCameraOptions = {}) {
    this.zoomOverride = options.zoomOverride ?? null;
    this.farLevels = options.farLevels ?? false;
  }

  /** Device px per low-res texel (N). */
  get zoom(): number {
    return this.list[this.level].zoom;
  }

  /** Phase 55: world texels per low-res texel (k). */
  get texelScale(): number {
    return this.list[this.level].texelScale;
  }

  /** The range of N the screen allows (the k = 1 levels). */
  get zoomLevels(): Readonly<ZoomLevels> {
    return this.levels;
  }

  /** Phase 55: every level, furthest first. */
  get levelList(): readonly ZoomLevel[] {
    return this.list;
  }

  /** Phase 55: the index of the level in use in `levelList`. */
  get levelIndex(): number {
    return this.level;
  }

  /** The index of the k = 1 level of zoom N (clamped into the range). */
  private indexOfZoom(zoom: number): number {
    const target = clamp(Math.round(zoom), this.levels.min, this.levels.max);
    return this.list.findIndex((level) => level.texelScale === 1 && level.zoom === target);
  }

  /**
   * The one place a new canvas size, resolution or GPU limit enters the camera (the renderer's
   * 'resize' and devicePixelRatio changes both land here). The first call picks the starting zoom;
   * later calls keep the zoom (clamped to the new levels) and the world point at the viewport's
   * centre. When only R changes — a move to another monitor, browser zoom — N scales with it, so the
   * park keeps its size in CSS px.
   */
  setViewport(deviceWidth: number, deviceHeight: number, resolution: number, maxTextureSize: number): void {
    this.completeEase();
    const first = !this.hasViewport;
    const previous = { width: this.deviceWidth, height: this.deviceHeight, zoom: this.zoom, scale: this.texelScale, resolution: this.resolution };
    const centre = this.worldAtDevice(previous.width / 2, previous.height / 2);
    this.levels = zoomLevelsFor(deviceWidth, deviceHeight, resolution, maxTextureSize);
    this.list = zoomLevelList(this.levels, this.farLevels);
    this.deviceWidth = deviceWidth;
    this.deviceHeight = deviceHeight;
    this.resolution = resolution;
    this.hasViewport = true;
    if (first) {
      this.level = this.indexOfZoom(this.zoomOverride ?? this.levels.initial);
      this.constrain();
      return;
    }
    // The same scale where it still exists (an N = 2 level at k = 1 stays; when only R changes, N scales with it).
    if (previous.scale === 1) {
      const scaled = resolution === previous.resolution ? previous.zoom : Math.round(previous.zoom * resolution / previous.resolution);
      this.level = this.indexOfZoom(scaled);
    } else {
      this.level = nearestLevel(this.list, previous.zoom / previous.scale * resolution / previous.resolution);
    }
    // An axis whose size and zoom did not change keeps its origin exactly: re-deriving it from the
    // centre would round, and one rounding step across a texel edge moves the picture a pixel.
    const zoomChanged = this.zoom !== previous.zoom || this.texelScale !== previous.scale;
    if (zoomChanged || deviceWidth !== previous.width) this.originX = centre.x - deviceWidth / 2 * this.texelScale / this.zoom;
    if (zoomChanged || deviceHeight !== previous.height) this.originY = centre.y - deviceHeight / 2 * this.texelScale / this.zoom;
    this.constrain();
  }

  /**
   * Phase 11 (PA-021): the plot's size in VIEW cells (the renderer feeds it on a session and on every view change;
   * W and H swap under rotation). The clamp keeps the ground point under the viewport centre inside the plot
   * rectangle expanded by `plotMarginCells`, so at least one plot cell is always on screen. 0 × 0 turns it off.
   * Setting the bounds moves nothing by itself. Phase 21: on an estate the plot is the owned land plus a parcel
   * (`viewX0`, `viewY0` its view-cell origin; 0, 0 = the whole map, as before).
   */
  setPlotBounds(viewWidthCells: number, viewHeightCells: number, viewX0 = 0, viewY0 = 0, maximumMarginCells = Number.POSITIVE_INFINITY): void {
    this.plotWidth = viewWidthCells;
    this.plotHeight = viewHeightCells;
    this.plotX0 = viewX0;
    this.plotY0 = viewY0;
    this.plotMarginCap = maximumMarginCells;
  }

  /**
   * Phase 36: the HUD's cover on each side, in CSS px (null = none). The clamp then keeps the ground point under the
   * middle of the UNCOVERED rectangle inside the plot (plus a margin from that rectangle's size), so panning can no
   * longer park the whole plot behind the build dock or Park Pulse (the Phase 11 item at 1100x690). Setting it moves
   * nothing by itself; the next pan, zoom, focus or resize clamps with it.
   */
  setSafeInsets(insets: Readonly<ViewInsets> | null): void {
    this.insets = insets === null ? null : { left: insets.left, top: insets.top, right: insets.right, bottom: insets.bottom };
  }

  /**
   * The uncovered rectangle in device px. Each axis falls back to the whole viewport when the insets leave less than
   * MIN_SAFE_SHARE of it (a tiny window), and with no insets it is the whole viewport, so the clamp is unchanged.
   */
  private safeArea(insets: Readonly<ViewInsets> | null = this.insets): { x0: number; x1: number; y0: number; y1: number } {
    const out = this.safe;
    out.x0 = 0; out.x1 = this.deviceWidth; out.y0 = 0; out.y1 = this.deviceHeight;
    if (insets === null) return out;
    const r = this.resolution;
    const x0 = insets.left * r;
    const x1 = this.deviceWidth - insets.right * r;
    if (x1 - x0 >= this.deviceWidth * MIN_SAFE_SHARE) { out.x0 = x0; out.x1 = x1; }
    const y0 = insets.top * r;
    const y1 = this.deviceHeight - insets.bottom * r;
    if (y1 - y0 >= this.deviceHeight * MIN_SAFE_SHARE) { out.y0 = y0; out.y1 = y1; }
    return out;
  }

  /**
   * Phase 36: the viewport fractions of the middle of the area `insets` leave uncovered (default: the clamp's own
   * insets; 0.5, 0.5 without any), where a focus puts a cell.
   */
  safeCentreFractions(insets: Readonly<ViewInsets> | null = this.insets): { x: number; y: number } {
    const safe = this.safeArea(insets);
    return {
      x: this.deviceWidth > 0 ? (safe.x0 + safe.x1) / 2 / this.deviceWidth : 0.5,
      y: this.deviceHeight > 0 ? (safe.y0 + safe.y1) / 2 / this.deviceHeight : 0.5,
    };
  }

  /** True while a focus glide runs (the renderer keeps drawing). */
  get easeActive(): boolean {
    return this.easing;
  }

  /**
   * Glides the origin to (`originX`, `originY`) — clamped first — over `durationMs` (ease-out cubic), advanced by
   * `stepEase`. A glide already running completes at once first. Pan, drag and wheel input cancel it where it is;
   * a turn, resize or another focus completes it. Reduced motion is the caller's choice (it snaps instead).
   */
  easeTo(originX: number, originY: number, durationMs = CAMERA_EASE_MS): void {
    this.completeEase();
    const fromX = this.originX;
    const fromY = this.originY;
    this.originX = originX;
    this.originY = originY;
    this.constrain();
    const toX = this.originX;
    const toY = this.originY;
    this.originX = fromX;
    this.originY = fromY;
    if ((toX === fromX && toY === fromY) || !(durationMs > 0)) {
      this.originX = toX;
      this.originY = toY;
      return;
    }
    this.easing = true;
    this.easeElapsed = 0;
    this.easeDuration = durationMs;
    this.easeFromX = fromX;
    this.easeFromY = fromY;
    this.easeToX = toX;
    this.easeToY = toY;
  }

  /** Advances a glide by `deltaMs`; true while it is still running after this step. Lands exactly on the target. */
  stepEase(deltaMs: number): boolean {
    if (!this.easing) return false;
    // One slow frame (a dashboard re-render right after the click) must not swallow most of the glide.
    this.easeElapsed += Math.min(Math.max(0, deltaMs), CAMERA_EASE_MAX_STEP_MS);
    if (this.easeElapsed >= this.easeDuration) {
      this.completeEase();
      return false;
    }
    const k = easeOutCubic(this.easeElapsed / this.easeDuration);
    this.originX = this.easeFromX + (this.easeToX - this.easeFromX) * k;
    this.originY = this.easeFromY + (this.easeToY - this.easeFromY) * k;
    return true;
  }

  /** Jumps a running glide to its target (a turn, resize, sweep frame or new focus). */
  completeEase(): void {
    if (!this.easing) return;
    this.easing = false;
    this.originX = this.easeToX;
    this.originY = this.easeToY;
  }

  /** Stops a running glide where it is (pan, drag or wheel input). */
  cancelEase(): void {
    this.easing = false;
  }

  /** The camera as this frame draws it. */
  snapped(): SnappedCamera {
    const zoom = this.zoom;
    const scale = this.texelScale;
    const texelX = Math.floor(this.originX / scale) * scale;
    const texelY = Math.floor(this.originY / scale) * scale;
    return {
      texelX,
      texelY,
      offsetX: snapOffset(this.originX, texelX, zoom, scale),
      offsetY: snapOffset(this.originY, texelY, zoom, scale),
      zoom,
      texelScale: scale,
      lowWidth: lowResSize(this.deviceWidth, zoom),
      lowHeight: lowResSize(this.deviceHeight, zoom),
      cameraTexelX: texelX - GUARD_BAND_TEXELS * scale,
      cameraTexelY: texelY - GUARD_BAND_TEXELS * scale,
    };
  }

  cssSize(): { width: number; height: number } {
    return { width: this.deviceWidth / this.resolution, height: this.deviceHeight / this.resolution };
  }

  /**
   * Canvas CSS px → world px through the snapped transform, the exact inverse of the upscale:
   * device px p shows low-res texel floor((p − offset) / N), which is world texel k times that plus texel.
   */
  cssToWorld(x: number, y: number): { x: number; y: number } {
    const snap = this.snapped();
    return {
      x: (x * this.resolution - snap.offsetX) / snap.zoom * snap.texelScale + snap.texelX,
      y: (y * this.resolution - snap.offsetY) / snap.zoom * snap.texelScale + snap.texelY,
    };
  }

  /** The world follows the pointer: a CSS-px drag moves the origin by −Δ·R·k/N world texels. */
  panByCss(dx: number, dy: number): void {
    this.cancelEase();
    this.originX -= dx * this.resolution / this.zoom * this.texelScale;
    this.originY -= dy * this.resolution / this.zoom * this.texelScale;
    this.constrain();
  }

  /**
   * One whole zoom level per 100 normalised wheel units (lines count 16 px, pages a viewport height),
   * accumulated so trackpads and fine wheels step as surely as a mouse notch. Reversing direction
   * drops what was accumulated; so does hitting a limit, so the first notch back always responds.
   * The world point under the cursor stays put.
   */
  zoomAtCss(x: number, y: number, event: WheelDelta): void {
    const unit = event.deltaMode === DOM_DELTA_LINE
      ? WHEEL_LINE_PX
      : event.deltaMode === DOM_DELTA_PAGE ? this.cssSize().height : 1;
    const delta = event.deltaY * unit;
    if (delta === 0 || !Number.isFinite(delta)) return;
    this.cancelEase();
    if (Math.sign(delta) !== Math.sign(this.wheelAccumulator)) this.wheelAccumulator = 0;
    this.wheelAccumulator += delta;
    const levels = Math.trunc(this.wheelAccumulator / WHEEL_UNITS_PER_LEVEL);
    if (levels === 0) return;
    this.wheelAccumulator -= levels * WHEEL_UNITS_PER_LEVEL;
    // Wheel down (positive deltaY) zooms out, like the classic camera: one level further per step.
    const next = clamp(this.level - levels, 0, this.list.length - 1);
    if (next === this.level || next !== this.level - levels) this.wheelAccumulator = 0;
    this.setLevelAtCss(next, x, y);
  }

  /** Sets the k = 1 zoom N (clamped into the levels) keeping the world point at CSS px (x, y) in place. */
  setZoomAtCss(zoom: number, x: number, y: number): void {
    this.setLevelAtCss(this.indexOfZoom(zoom), x, y);
  }

  /** Phase 55: sets the level (an index into `levelList`, clamped) keeping the world point at CSS px (x, y) in place. */
  setLevelAtCss(index: number, x: number, y: number): void {
    const next = clamp(Math.round(index), 0, this.list.length - 1);
    if (next === this.level) return;
    this.cancelEase();
    const deviceX = x * this.resolution;
    const deviceY = y * this.resolution;
    const anchor = this.worldAtDevice(deviceX, deviceY);
    this.level = next;
    this.placeWorldAtDevice(anchor.x, anchor.y, deviceX, deviceY);
    this.constrain();
  }

  /** Puts world px (x, y) at a fraction of the viewport (0.5, 0.5 is the centre), clamped to the plot. */
  focusWorld(x: number, y: number, fractionX = 0.5, fractionY = 0.5): void {
    this.completeEase();
    this.placeWorldAtDevice(x, y, this.deviceWidth * fractionX, this.deviceHeight * fractionY);
    this.constrain();
  }

  /** Centres a cell's top vertex, not its middle — the same point the classic camera centres. */
  focusCell(cell: Cell): void {
    const point = cellToWorld(cell);
    this.focusWorld(point.x, point.y);
  }

  /**
   * `focusCell` for a fractional cell coordinate, without allocating (the start screen's sweep calls it per frame).
   * Phase 36: `fractionX` / `fractionY` put it elsewhere than the middle (a focus into the uncovered area).
   */
  focusCellXY(cellX: number, cellY: number, fractionX = 0.5, fractionY = 0.5): void {
    this.focusWorld((cellX - cellY) * (TILE_WIDTH / 2), (cellX + cellY) * (TILE_HEIGHT / 2), fractionX, fractionY);
  }

  /**
   * "Center camera on the park entrance" (Phase 24: any gate; the rule is `entranceFocus`, shared with the classic
   * renderer). When the gate is on the view's south edge (Meadow in view 0) the long-standing framing applies: the
   * anchor view cell 11 cells in front of the gate goes to (0.5w, 0.18h). In every other case the gate is at
   * another edge of the picture, so, like the classic renderer, the midpoint between the gate's cell middle and the
   * map centre is centred: both are on screen whatever edge the gate sits on. `entrance` is a WORLD cell and the
   * frame carries the world map size. Phase 21: `heart` (a WORLD cell, default the map centre) is the middle of the
   * owned land on an estate.
   */
  focusEntranceInView(
    frame: ViewFrame,
    entranceX: number,
    entranceY: number,
    heart: { readonly x: number; readonly y: number } = { x: (frame.width - 1) / 2, y: (frame.height - 1) / 2 },
  ): void {
    const focus = entranceFocus(frame, { x: entranceX, y: entranceY });
    if (focus.mode === 'anchor') {
      const point = cellToWorld({ x: focus.viewX, y: focus.viewY });
      this.focusWorld(point.x, point.y, 0.5, ENTRANCE_ANCHOR_HEIGHT_FRACTION);
      return;
    }
    const gate = cellToView(frame, entranceX, entranceY, { x: 0, y: 0 });
    const centre = cellToView(frame, heart.x, heart.y, { x: 0, y: 0 });
    const gateX = (gate.x - gate.y) * (TILE_WIDTH / 2);
    const gateY = (gate.x + gate.y) * (TILE_HEIGHT / 2) + TILE_HEIGHT / 2;
    const centreX = (centre.x - centre.y) * (TILE_WIDTH / 2);
    const centreY = (centre.x + centre.y) * (TILE_HEIGHT / 2);
    this.focusWorld((gateX + centreX) / 2, (gateY + centreY) / 2);
  }

  /**
   * A turn keeps the GROUND point under the middle of the screen where it is on the map: texel (sx, sy) of
   * the ground plane is voxel (sy + sx / 2, sy - sx / 2) of the old view, which is turned through the world
   * and into the new view. Zoom and the viewport are untouched.
   *
   * Round trips are exact: the half-viewport in texels (w / 2N) is not dyadic at every zoom (N = 3, 5, odd
   * windows), so recomputing the origin from the centre would drift by an ulp per turn, and an origin on a
   * 1/N boundary (every integer-px pan lands on one) would then flip a `floor` in `snapped()` and move the
   * picture (and the world-anchored Bayer phase) by a pixel or a texel. So while nothing else moves the
   * camera, a chain of turns remembers the origin it left and found in every view, and a turn back to a view
   * of the chain restores that origin bit for bit (Q x 4 and any turn sequence give the identical frame).
   * Any pan, zoom, focus, resize or another map size breaks the chain. Fixed-size storage: no allocation.
   */
  retargetForTurn(from: Readonly<ViewTransform>, to: Readonly<ViewTransform>): void {
    // Phase 11: a glide lands first; the turn itself is never clamped (it keeps a ground point that was inside).
    this.completeEase();
    const memory = this.turnMemory;
    const chained = this.turnChainMask !== 0
      && this.originX === this.turnChainX && this.originY === this.turnChainY
      && this.list[this.level] === this.turnChainLevel
      && this.deviceWidth === this.turnChainWidth && this.deviceHeight === this.turnChainHeight
      && from.rotation === this.turnChainRotation && from.ox === this.turnChainOx && from.oy === this.turnChainOy;
    if (!chained) this.turnChainMask = 0;
    this.turnChainMask |= 1 << from.rotation;
    memory[from.rotation * 2] = this.originX;
    memory[from.rotation * 2 + 1] = this.originY;
    if ((this.turnChainMask & (1 << to.rotation)) !== 0) {
      this.originX = memory[to.rotation * 2];
      this.originY = memory[to.rotation * 2 + 1];
    } else {
      const centreX = this.originX + this.deviceWidth / 2 * this.texelScale / this.zoom;
      const centreY = this.originY + this.deviceHeight / 2 * this.texelScale / this.zoom;
      const u = centreY + centreX / 2;
      const v = centreY - centreX / 2;
      voxelFromView(from, u, v, turnScratch);
      voxelToView(to, turnScratch.x, turnScratch.y, turnScratch);
      const nextX = turnScratch.x - turnScratch.y;
      const nextY = (turnScratch.x + turnScratch.y) / 2;
      this.originX = nextX - this.deviceWidth / 2 * this.texelScale / this.zoom;
      this.originY = nextY - this.deviceHeight / 2 * this.texelScale / this.zoom;
      this.turnChainMask |= 1 << to.rotation;
      memory[to.rotation * 2] = this.originX;
      memory[to.rotation * 2 + 1] = this.originY;
    }
    this.turnChainX = this.originX;
    this.turnChainY = this.originY;
    this.turnChainLevel = this.list[this.level];
    this.turnChainWidth = this.deviceWidth;
    this.turnChainHeight = this.deviceHeight;
    this.turnChainRotation = to.rotation;
    this.turnChainOx = to.ox;
    this.turnChainOy = to.oy;
  }

  /**
   * Phase 11 (PA-021): keeps the ground point under the viewport centre inside the plot rectangle (view cells,
   * expanded by `plotMarginCells`). The ground point of texel (X, Y) is cell (X/32 + Y/16) / 2, (Y/16 − X/32) / 2;
   * each axis is clamped and mapped back. It returns WITHOUT touching the origin when the point is already inside,
   * so a camera that never leaves the plot is bit-identical with and without the clamp (no float drift).
   */
  private constrain(): void {
    if (this.plotWidth <= 0 || this.plotHeight <= 0 || !this.hasViewport) return;
    // Phase 36: the middle of the safe area (the whole viewport without insets: then these are exactly the old
    // halfX / halfY, so a camera that never had insets clamps bit-identically).
    const safe = this.safeArea();
    const perDevice = this.texelScale;
    const offsetX = (safe.x0 + safe.x1) / 2 * perDevice / this.zoom;
    const offsetY = (safe.y0 + safe.y1) / 2 * perDevice / this.zoom;
    const halfX = (safe.x1 - safe.x0) / 2 * perDevice / this.zoom;
    const halfY = (safe.y1 - safe.y0) / 2 * perDevice / this.zoom;
    const centreX = this.originX + offsetX;
    const centreY = this.originY + offsetY;
    const groundX = (centreX / (TILE_WIDTH / 2) + centreY / (TILE_HEIGHT / 2)) / 2;
    const groundY = (centreY / (TILE_HEIGHT / 2) - centreX / (TILE_WIDTH / 2)) / 2;
    const margin = Math.min(plotMarginCells(halfX, halfY), this.plotMarginCap);
    const clampedX = clamp(groundX, this.plotX0 - margin, this.plotX0 + this.plotWidth + margin);
    const clampedY = clamp(groundY, this.plotY0 - margin, this.plotY0 + this.plotHeight + margin);
    if (clampedX === groundX && clampedY === groundY) return;
    this.originX = (clampedX - clampedY) * (TILE_WIDTH / 2) - offsetX;
    this.originY = (clampedX + clampedY) * (TILE_HEIGHT / 2) - offsetY;
  }

  private worldAtDevice(deviceX: number, deviceY: number): { x: number; y: number } {
    return { x: this.originX + deviceX * this.texelScale / this.zoom, y: this.originY + deviceY * this.texelScale / this.zoom };
  }

  private placeWorldAtDevice(worldX: number, worldY: number, deviceX: number, deviceY: number): void {
    this.originX = worldX - deviceX * this.texelScale / this.zoom;
    this.originY = worldY - deviceY * this.texelScale / this.zoom;
  }
}
