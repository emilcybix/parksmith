import type { Cell } from '../game/types';

/**
 * The see-through ("cutaway") model both renderers share, pure: no Pixi, no DOM, no allocation per
 * call. When a tool is armed (or the player holds the peek key) the renderer cuts away whatever
 * stands between the camera and the cursor, so a build site behind a tall building stays visible.
 *
 * Presentation only: it reads the hovered cell and the preview footprint and never feeds the
 * simulation; picking stays by map cell (worldInput) and is not affected.
 */

/** What GameApp tells a renderer. One reused object on the app side; a renderer must not keep it. */
export interface SeeThroughRequest {
  /** A placement, path, bulldoze or coaster-designer tool is armed in a context that may build. */
  armed: boolean;
  /** The hold-to-peek key is down: see through everything near the cursor. */
  peek: boolean;
}

/** place: a footprint to build; bulldoze: the demolished object must stay intact; cell: one cell. */
export type SeeThroughMode = 'place' | 'bulldoze' | 'cell';

export interface SeeThroughFocus {
  /** Inclusive cell bounds of the focus footprint. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  mode: SeeThroughMode;
  peek: boolean;
  /** Height of the focus volume in voxels (0 for a plain cell). */
  heightVoxels: number;
}

/**
 * Opacity of an occluding building at full strength, one number for both renderers (the voxel
 * renderer's translucent front layer and the classic renderer's faded display objects). Target
 * 30 to 35 per cent: the building stays readable as a faded building and the build site shows
 * through it clearly.
 */
const OCCLUDER_OPACITY = 0.3;

export const SEE_THROUGH = {
  FADE_IN_MS: 140,
  FADE_OUT_MS: 220,
  /** Time constant of the rect and key slew, so the hole follows the cursor without jumping. */
  POSITION_TAU_MS: 70,
  MARGIN_TEXELS: 24,
  PEEK_MARGIN_TEXELS: 48,
  /** Paving and plots top out at 1 voxel: texels below 1.5 are ground and are never cut. */
  FLOOR_Z: 1.5,
  /** One cell of depth: peek opens things beside and one cell behind the cursor too. */
  PEEK_DEPTH_SLACK: 64,
  COASTER_HEIGHT_VOXELS: 26,
  /**
   * The voxel renderer's front layer keeps a fragment when its depth key is within this of the cut
   * key (the main pass discards from the cut key exactly), so rasteriser rounding between the two
   * passes can duplicate a fragment (harmless: it lies over itself) but never drop it.
   */
  KEY_SLACK: 0.05,
  /**
   * Depth keys. The front layer's lit run hides a texel of the layer where the main G-buffer holds
   * something nearer than this much in front of it (a guest, litter or the coaster draft standing in
   * front of the faded building). The layer's own fragments are the same depth as the main buffer's
   * survivors of the same building, so this only has to clear rounding and a hair of surface thickness.
   */
  FRONT_NEARER_SLACK: 0.75,
  /** Slewed values snap to their target inside this distance, so an idle frame writes nothing. */
  EPSILON: 1 / 512,
  /** Opacity of the occluders the see-through volume fades (both renderers; see OCCLUDER_OPACITY above). */
  OCCLUDER_OPACITY,
  /** Classic renderer: alpha of a faded object at full strength (the shared occluder opacity). */
  CLASSIC_ALPHA: OCCLUDER_OPACITY,
  /**
   * The hole is one rectangle, so a footprint wider than this (cells, either axis) is not opened as
   * a whole: a long path or bulldoze drag would eat away every building beside it. It then opens
   * around the hovered cell only (the end of the drag). Rides and large plots are well inside it.
   */
  MAX_FOOTPRINT_CELLS: 6,
} as const;

/**
 * Fills `out` and returns true when something should be cut; false when there is no hovered cell
 * or the request is neither armed nor peeking (`out` is then left untouched). The footprint is the
 * preview cells' bounds (or the hovered cell when there is no preview). Peek ignores the preview
 * footprint and opens the hovered cell grown by one cell on each side, in plain cell mode.
 */
export function resolveSeeThroughFocus(
  request: Readonly<SeeThroughRequest>,
  hovered: Cell | null,
  previewCells: readonly Cell[],
  previewMode: SeeThroughMode,
  heightVoxels: number,
  out: SeeThroughFocus,
): boolean {
  if (hovered === null || (!request.armed && !request.peek)) return false;
  const height = Number.isFinite(heightVoxels) && heightVoxels > 0 ? heightVoxels : 0;
  if (request.peek) {
    out.minX = hovered.x - 1;
    out.minY = hovered.y - 1;
    out.maxX = hovered.x + 1;
    out.maxY = hovered.y + 1;
    out.mode = 'cell';
    out.peek = true;
    out.heightVoxels = height;
    return true;
  }
  let minX = hovered.x;
  let minY = hovered.y;
  let maxX = hovered.x;
  let maxY = hovered.y;
  // A path drag (mode 'cell') is a line of cells, not a footprint: only the cursor's cell opens.
  if (previewCells.length > 0 && previewMode !== 'cell') {
    minX = maxX = previewCells[0].x;
    minY = maxY = previewCells[0].y;
    for (let i = 1; i < previewCells.length; i += 1) {
      const cell = previewCells[i];
      if (cell.x < minX) minX = cell.x;
      if (cell.x > maxX) maxX = cell.x;
      if (cell.y < minY) minY = cell.y;
      if (cell.y > maxY) maxY = cell.y;
    }
  }
  let mode: SeeThroughMode = previewCells.length > 0 ? previewMode : 'cell';
  if (maxX - minX + 1 > SEE_THROUGH.MAX_FOOTPRINT_CELLS || maxY - minY + 1 > SEE_THROUGH.MAX_FOOTPRINT_CELLS) {
    minX = maxX = hovered.x;
    minY = maxY = hovered.y;
    mode = 'cell';
  }
  out.minX = minX;
  out.minY = minY;
  out.maxX = maxX;
  out.maxY = maxY;
  out.mode = mode;
  out.peek = false;
  out.heightVoxels = mode === 'cell' ? 0 : height;
  return true;
}

/**
 * Moves `current` toward `target` with time constant `tauMs` (frame-rate independent), snapping
 * exactly onto the target inside EPSILON. `instant` (reduced motion) jumps straight there.
 */
export function slewTo(
  current: number,
  target: number,
  deltaMs: number,
  tauMs: number,
  instant: boolean,
): number {
  if (instant || tauMs <= 0) return target;
  if (Math.abs(target - current) <= SEE_THROUGH.EPSILON) return target;
  if (!(deltaMs > 0)) return current;
  const next = current + (target - current) * (1 - Math.exp(-deltaMs / tauMs));
  return Math.abs(target - next) <= SEE_THROUGH.EPSILON ? target : next;
}

/**
 * The strength envelope in [0, 1]: linear 0 to 1 in FADE_IN_MS, 1 to 0 in FADE_OUT_MS. Runs on the
 * real frame delta (also while paused and at 4x). Under reduced motion it follows the target at
 * once. `value` is exactly 0 or 1 when `settled`, so an idle frame changes nothing.
 */
export class SeeThroughFade {
  private target = 0;
  private current = 0;

  constructor(private readonly reducedMotion: () => boolean) {}

  get value(): number {
    return this.current;
  }

  get settled(): boolean {
    return this.current === this.target;
  }

  setTarget(on: boolean): void {
    this.target = on ? 1 : 0;
    if (this.reducedMotion()) this.current = this.target;
  }

  step(deltaMs: number): number {
    if (this.current === this.target) return this.current;
    if (this.reducedMotion()) {
      this.current = this.target;
      return this.current;
    }
    if (!(deltaMs > 0)) return this.current;
    if (this.target > this.current) {
      this.current = Math.min(1, this.current + deltaMs / SEE_THROUGH.FADE_IN_MS);
    } else {
      this.current = Math.max(0, this.current - deltaMs / SEE_THROUGH.FADE_OUT_MS);
    }
    return this.current;
  }
}
