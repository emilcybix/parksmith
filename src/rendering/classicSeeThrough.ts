import { SEE_THROUGH, type SeeThroughFocus } from './seeThrough';
import { TILE_HEIGHT, TILE_WIDTH, cellToWorld, isometricSortKey } from './isometric';

/**
 * The classic renderer's see-through: display objects that sort in front of the focus (the build
 * ghost, the bulldoze target or the peeked cell) and whose screen box overlaps it fade to
 * CLASSIC_ALPHA, so a building in front no longer hides the build site.
 *
 * Deliberately simple and allocation-free in the frame loop. The overlap search runs only when the
 * focus changes (one cell of cursor travel), never per frame; entries are pooled; per frame only
 * the short list of faded objects is touched, and `alpha` is written only when it moved. Pure: it
 * needs only `{ alpha }` targets, so it is unit-tested without Pixi.
 */

export interface FadeTarget { alpha: number }

/** What the renderer caches per object display: the display and its screen box in camera pixels. */
export interface SeeThroughCandidate {
  container: FadeTarget;
  /** The display's `zIndex` (isometricSortKey of its front cell). */
  sortKey: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Entry {
  target: FadeTarget | null;
  /** 0..1: how far this object has faded in toward the current focus. */
  level: number;
  wanted: boolean;
  /** The alpha last written, so an unchanged value is never written again. */
  written: number;
}

/** Local rise above the footprint that a placed ghost's art occupies, in camera pixels. */
export const GHOST_RISE_PX = 96;

export class ClassicSeeThrough {
  private readonly pool: Entry[] = [];
  private readonly active: Entry[] = [];
  private readonly byTarget = new Map<FadeTarget, Entry>();
  /** Master strength: follows whether there is a focus at all (cursor on the map, tool armed). */
  private master = 0;
  private masterTarget = 0;
  private focusKey = 0;
  private focusLeft = 0;
  private focusTop = 0;
  private focusRight = 0;
  private focusBottom = 0;

  constructor(private readonly reducedMotion: () => boolean) {}

  /** Number of objects currently faded or fading. Zero when nothing is, so the frame step is free. */
  get activeCount(): number {
    return this.active.length;
  }

  /**
   * Points the effect at a new focus (or none, with `null`) and collects the objects to fade.
   * Call when the focus changes, not per frame. Objects no longer overlapping fade back.
   * `keyFloor` raises the sort key an object must exceed: bulldozing one cell of a ride passes the
   * ride's own key, so the building being demolished is never faded.
   */
  setFocus(
    focus: Readonly<SeeThroughFocus> | null,
    candidates: Iterable<SeeThroughCandidate>,
    keyFloor = Number.NEGATIVE_INFINITY,
  ): void {
    for (const entry of this.active) entry.wanted = false;
    if (focus === null) {
      this.masterTarget = 0;
      if (this.reducedMotion()) this.master = 0;
      return;
    }
    this.masterTarget = 1;
    if (this.reducedMotion()) this.master = 1;
    const margin = focus.peek ? SEE_THROUGH.PEEK_MARGIN_TEXELS : SEE_THROUGH.MARGIN_TEXELS;
    const width = focus.maxX - focus.minX + 1;
    const depth = focus.maxY - focus.minY + 1;
    // One cell of depth is 100 sort keys; peek also opens one cell further back.
    this.focusKey = isometricSortKey({ x: focus.minX, y: focus.minY }, [width, depth]) - (focus.peek ? 100 : 0);
    if (keyFloor > this.focusKey) this.focusKey = keyFloor;
    this.focusLeft = cellToWorld({ x: focus.minX, y: focus.maxY }).x - TILE_WIDTH / 2 - margin;
    this.focusRight = cellToWorld({ x: focus.maxX, y: focus.minY }).x + TILE_WIDTH / 2 + margin;
    this.focusTop = cellToWorld({ x: focus.minX, y: focus.minY }).y - margin
      - (focus.mode === 'place' ? GHOST_RISE_PX : 0);
    this.focusBottom = cellToWorld({ x: focus.maxX, y: focus.maxY }).y + TILE_HEIGHT + margin;
    for (const item of candidates) {
      if (item.sortKey <= this.focusKey) continue;
      if (item.right < this.focusLeft || item.left > this.focusRight) continue;
      if (item.bottom < this.focusTop || item.top > this.focusBottom) continue;
      this.want(item.container);
    }
  }

  private want(target: FadeTarget): void {
    const existing = this.byTarget.get(target);
    if (existing) {
      existing.wanted = true;
      return;
    }
    const entry = this.pool.pop() ?? { target: null, level: 0, wanted: false, written: 1 };
    entry.target = target;
    entry.level = this.reducedMotion() ? 1 : 0;
    entry.wanted = true;
    entry.written = target.alpha;
    this.byTarget.set(target, entry);
    this.active.push(entry);
  }

  /** Advances the fade by one real frame. Writes `alpha` only on objects whose value moved. */
  step(deltaMs: number): void {
    if (this.active.length === 0) {
      this.master = this.masterTarget === 0 ? 0 : this.master;
      return;
    }
    const instant = this.reducedMotion();
    if (instant) this.master = this.masterTarget;
    else if (this.master < this.masterTarget) {
      this.master = Math.min(1, this.master + deltaMs / SEE_THROUGH.FADE_IN_MS);
    } else if (this.master > this.masterTarget) {
      this.master = Math.max(0, this.master - deltaMs / SEE_THROUGH.FADE_OUT_MS);
    }
    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const entry = this.active[i];
      const goal = entry.wanted ? 1 : 0;
      if (instant) entry.level = goal;
      else if (entry.level < goal) entry.level = Math.min(1, entry.level + deltaMs / SEE_THROUGH.FADE_IN_MS);
      else if (entry.level > goal) entry.level = Math.max(0, entry.level - deltaMs / SEE_THROUGH.FADE_OUT_MS);
      const strength = entry.level * this.master;
      if (strength <= 0 && (!entry.wanted || this.master === 0)) {
        this.release(i);
        continue;
      }
      const alpha = 1 - strength * (1 - SEE_THROUGH.CLASSIC_ALPHA);
      if (entry.target && alpha !== entry.written) {
        entry.target.alpha = alpha;
        entry.written = alpha;
      }
    }
  }

  /** The display is going away: forget it without touching it. */
  forget(target: FadeTarget): void {
    const entry = this.byTarget.get(target);
    if (!entry) return;
    this.release(this.active.indexOf(entry), false);
  }

  /** Restores every faded object to exactly alpha 1 and empties the list (session swap, destroy). */
  clear(): void {
    while (this.active.length > 0) this.release(this.active.length - 1);
    this.master = 0;
    this.masterTarget = 0;
  }

  private release(index: number, restore = true): void {
    if (index < 0) return;
    const entry = this.active[index];
    const last = this.active.pop();
    if (last && last !== entry) this.active[index] = last;
    if (entry.target) {
      if (restore) entry.target.alpha = 1;
      this.byTarget.delete(entry.target);
    }
    entry.target = null;
    entry.level = 0;
    entry.wanted = false;
    this.pool.push(entry);
  }
}
