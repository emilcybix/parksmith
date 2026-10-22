import { Container, Graphics } from 'pixi.js';
import type { Cell } from '../../../game/types';
import type { HintMarker } from '../../RendererPort';
import { cellToWorld } from '../../isometric';
import { createViewFrame, type MutableViewFrame, type ViewFrame } from '../../viewRotation';
import { sameViewFrame, strokeOutline, texelDiamond, viewCells } from './overlays';
import { reducedMotion as effectiveReducedMotion } from '../../../settings/motion';

/**
 * The First Day pointer in the voxel overlay target: a soft, pulsing candy-yellow ring on the ground
 * footprint it points at (the end of the path, the gate, a ride's base, a litter tile).
 *
 * It follows badges.ts: whole-texel geometry, fill alphas in eighths (the composite dithers by
 * alpha), opaque outlines, and no per-frame allocation. `set` (rare: only when the hint's place
 * changes) builds two Graphics, a bright phase A and a dim phase B, and `update` just toggles which
 * one is visible every `HINT_STEP_MS`, bumping `version` only when the phase changes, which is two
 * overlay renders per second. With reduced motion only phase A ever shows and the version never
 * moves after `set`.
 *
 * View rotation (Phase 26): `set` takes WORLD cells and keeps them; they are mapped to VIEW cells when
 * painted, and `setView` repaints the ring for the new view (keeping the pulse phase) and bumps `version` once.
 */

export const HINT_STEP_MS = 450;

const COLOR_SUN = 0xffd166;
/** The outline colour: candy orange reads on sand paths as well as on grass. */
const COLOR_RING = 0xff9f1c;
const COLOR_WHITE = 0xffffff;
/** Eighths, so the 4x4 Bayer dither gives clean 3/8 and 1/8 patterns. */
const BRIGHT_FILL_ALPHA = 3 / 8;
const DIM_FILL_ALPHA = 1 / 8;

export class VoxelHints {
  /** Bumped when the picture changes. Only ever grows. */
  version = 0;
  private readonly layer = new Container();
  private bright: Graphics | null = null;
  private dim: Graphics | null = null;
  private phase = 0;
  private readonly frame: MutableViewFrame = createViewFrame();
  /** The ring's cells in WORLD space, for a repaint on a turn. */
  private worldCells: Cell[] = [];

  /**
   * The layer is inserted at `index` of `root` so it sits between the selection and the draft;
   * `reducedMotion` is read every tick (a test passes a getter, the app uses the settings module).
   */
  constructor(root: Container, index: number, private readonly reducedMotion: () => boolean = effectiveReducedMotion) {
    root.addChildAt(this.layer, Math.min(index, root.children.length));
  }

  /** True when nothing is shown, so the overlay target can be skipped. */
  get isEmpty(): boolean {
    return this.bright === null;
  }

  /** Replaces the marker. Keeps no reference to `markers`. An empty list switches the ring off. */
  set(markers: readonly HintMarker[]): void {
    const cells: Cell[] = [];
    for (const marker of markers) cells.push(...marker.cells);
    const hadContent = this.bright !== null;
    this.clear();
    if (cells.length === 0) {
      if (hadContent) this.version += 1;
      return;
    }
    this.worldCells = cells;
    this.build(0);
    this.version += 1;
  }

  /**
   * The map was turned: repaints the ring in view space, keeping the pulse phase. One `version` bump when the
   * frame differs (even with no ring, which costs nothing); a repeated call does nothing.
   */
  setView(frame: ViewFrame): void {
    const same = sameViewFrame(frame, this.frame);
    this.frame.rotation = frame.rotation;
    this.frame.width = frame.width;
    this.frame.height = frame.height;
    if (same) return;
    if (this.bright !== null) {
      const phase = this.phase;
      this.clear();
      this.build(phase);
    }
    this.version += 1;
  }

  /** Phase 55: the texel scale changed (`VoxelOverlays.setTexelScale` sets the stroke width): repaints the ring. */
  restroke(): void {
    if (this.bright === null) return;
    const phase = this.phase;
    this.clear();
    this.build(phase);
    this.version += 1;
  }

  private build(phase: number): void {
    const cells = viewCells(this.frame, this.worldCells);
    this.bright = this.paint(cells, BRIGHT_FILL_ALPHA, 2, true);
    this.dim = this.paint(cells, DIM_FILL_ALPHA, 1, false);
    this.phase = phase;
    this.bright.visible = phase === 0;
    this.dim.visible = phase !== 0;
    this.layer.addChild(this.bright, this.dim);
  }

  /** The pulse: phase A and B alternate. No allocation, and a version bump only on a phase change. */
  update(elapsedMs: number): void {
    if (this.bright === null || this.dim === null) return;
    if (this.reducedMotion()) {
      // Standing still: show the bright ring, however the pulse was interrupted.
      if (this.phase !== 0) {
        this.phase = 0;
        this.bright.visible = true;
        this.dim.visible = false;
        this.version += 1;
      }
      return;
    }
    const phase = Math.floor(elapsedMs / HINT_STEP_MS) % 2;
    if (phase === this.phase) return;
    this.phase = phase;
    this.bright.visible = phase === 0;
    this.dim.visible = phase === 1;
    this.version += 1;
  }

  /** A new park: the marker goes. */
  reset(): void {
    if (this.bright === null) return;
    this.clear();
    this.worldCells = [];
    this.version += 1;
  }

  private clear(): void {
    this.layer.removeChildren().forEach((child) => child.destroy({ children: true }));
    this.bright = null;
    this.dim = null;
  }

  private paint(cells: readonly Cell[], fillAlpha: number, outlineWidth: number, rim: boolean): Graphics {
    const graphic = new Graphics();
    for (const cell of cells) {
      const point = cellToWorld(cell);
      graphic.poly(texelDiamond(point.x, point.y)).fill({ color: COLOR_SUN, alpha: fillAlpha });
    }
    strokeOutline(graphic, cells, COLOR_RING, outlineWidth);
    if (rim) strokeOutline(graphic, cells, COLOR_WHITE, 1);
    return graphic;
  }
}
