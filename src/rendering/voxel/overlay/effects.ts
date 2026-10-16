import { Container, Graphics, GraphicsContext } from 'pixi.js';
import { BUILD_BY_ID } from '../../../game/content/catalog';
import type { ParkSession } from '../../../game/session/ParkSession';
import { footprintSize } from '../../../game/types';
import { TILE_HEIGHT, TILE_WIDTH } from '../../isometric';
import type { WorldEffect, WorldEffectKind } from '../../RendererPort';
import { cellToView, createViewFrame, type MutableViewFrame, type ViewFrame, type XY } from '../../viewRotation';
import { sameViewFrame } from './overlays';

/**
 * Phase 15: short-lived world feedback in the voxel overlay target — money popups ("+$40" in a 3 x 5 pixel font), and
 * small pixel icons for a finished ride cycle, a sale, a breakdown, a repair, a construction puff and a guest's strong
 * reaction (a heart or a storm cloud). Like the badges: whole-texel shapes in GraphicsContexts built ONCE (one per glyph
 * and icon, white with an ink shadow so a `tint` colours them), a fixed pool of slots, and a frame that only sets
 * `visible`, positions, `context` references, `tint` and `alpha`. No Graphics drawing call ever happens after the
 * constructor, and a steady frame with no effect running changes nothing (`version` still).
 *
 * An effect rises one texel every RISE_STEP_MS and fades out over its last third in eighths of alpha (clean dither
 * patterns); under reduced motion it does not rise and holds full alpha until it vanishes. The pool is fixed
 * (MAX_EFFECTS): when it is full the oldest effect is reused, so a burst can never grow memory or the frame cost.
 * Classic renderer: none (legacy).
 */

export const MAX_EFFECTS = 24;
export const EFFECT_LIFETIME_MS = 1_400;
export const RISE_STEP_MS = 90;
/** Money popups: at most this many glyphs ("-$12,345" is 8). */
const MAX_GLYPHS = 8;
/** Texels between an object's top (or a ground point) and the foot of an effect. */
const CLEARANCE = 6;
/** The lift of an object popup whose scene top is not known yet (a building placed this gesture). */
const NEW_OBJECT_TOP = 40;
/** A guest's head, in texels above the ground (figures are about 14 texels tall). */
const GUEST_HEAD = 18;

const INK = 0x173f3b;
const WHITE = 0xffffff;

/** The colour (tint) of each kind. */
export const EFFECT_TINT: Readonly<Record<WorldEffectKind, number>> = {
  'money-gain': 0x58d9ad,
  'money-spend': 0xff8a7a,
  'ride-cycle': 0xffe66d,
  sale: 0xffd166,
  breakdown: 0xff6277,
  repair: 0xf4b94e,
  build: 0xf3e2b3,
  happy: 0xff8fb1,
  unhappy: 0x9fb3c8,
};

/** 3 x 5 glyphs ('#' on), the font of the money popups. */
const FONT: Readonly<Record<string, readonly string[]>> = {
  0: ['###', '#.#', '#.#', '#.#', '###'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['###', '..#', '###', '#..', '###'],
  3: ['###', '..#', '.##', '..#', '###'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '###', '..#', '###'],
  6: ['###', '#..', '###', '#.#', '###'],
  7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '###'],
  $: ['.##', '##.', '.#.', '.##', '##.'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '-': ['...', '...', '###', '...', '...'],
  ',': ['...', '...', '...', '.#.', '#..'],
  k: ['#..', '#.#', '##.', '#.#', '#.#'],
};

/** 7 x 7 icons, one per non-money kind. */
const ICONS: Readonly<Record<Exclude<WorldEffectKind, 'money-gain' | 'money-spend'>, readonly string[]>> = {
  'ride-cycle': ['...#...', '..###..', '#######', '.#####.', '..###..', '.##.##.', '##...##'],
  sale: ['.#####.', '##...##', '#..#..#', '#.###.#', '#..#..#', '##...##', '.#####.'],
  breakdown: ['..##...', '..##...', '..##...', '..##...', '.......', '..##...', '..##...'],
  repair: ['##..##.', '##..##.', '######.', '.####..', '..##...', '..##...', '..##...'],
  build: ['#.....#', '..#.#..', '.#...#.', '...#...', '.#...#.', '..#.#..', '#.....#'],
  happy: ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
  unhappy: ['..###..', '.#####.', '#######', '.#####.', '..#.#..', '.#...#.', '#...#..'],
};

/** A glyph or icon centred on x = 0 with its foot on y = 0: an ink shadow one texel down-right, then the white body. */
const buildContext = (rows: readonly string[]): GraphicsContext => {
  const art = new Graphics();
  const width = rows[0].length;
  const left = -Math.floor(width / 2);
  const top = -rows.length;
  for (const [offset, colour] of [[1, INK], [0, WHITE]] as const) {
    rows.forEach((row, y) => {
      for (let x = 0; x < width; x += 1) if (row[x] === '#') art.rect(left + x + offset, top + y + offset, 1, 1);
    });
    art.fill(colour);
  }
  return art.context;
};

/** The text of a money popup: "+$40", "-$1,150", "+$12k" above $99,999. */
export const moneyText = (amount: number): string => {
  const whole = Math.round(Math.abs(amount));
  const body = whole > 99_999 ? `${Math.round(whole / 1_000)}k` : whole.toLocaleString('en-US');
  return `${amount < 0 ? '-' : '+'}$${body}`;
};

interface Slot {
  readonly root: Container;
  readonly glyphs: Graphics[];
  active: boolean;
  bornMs: number;
  /** Texel anchor of the foot of the effect at birth (view space). */
  x: number;
  y: number;
  /** World data to re-anchor on a turn. */
  cellX: number;
  cellY: number;
  objectId: number | null;
  kind: WorldEffectKind;
  /** The last drawn rise and alpha step (a change bumps `version`). */
  rise: number;
  alphaStep: number;
  /** The object's scene top was not known at birth (built this gesture): re-anchor once it is. */
  pendingTop: boolean;
}

export class VoxelEffects {
  /** Bumped whenever what the effects show changes. Only ever grows. */
  version = 0;
  private readonly layer = new Container();
  private readonly glyphContexts = new Map<string, GraphicsContext>();
  private readonly iconContexts = new Map<WorldEffectKind, GraphicsContext>();
  private readonly slots: Slot[] = [];
  private activeCount = 0;
  private nowMs = 0;
  private readonly frame: MutableViewFrame = createViewFrame();
  private readonly anchor: XY = { x: 0, y: 0 };

  constructor(
    root: Container,
    private readonly session: () => ParkSession,
    private readonly objectTop: (objectId: number) => number | null,
    private readonly reducedMotion: () => boolean = () => false,
  ) {
    for (const [char, rows] of Object.entries(FONT)) this.glyphContexts.set(char, buildContext(rows));
    for (const [kind, rows] of Object.entries(ICONS)) this.iconContexts.set(kind as WorldEffectKind, buildContext(rows));
    const blank = this.glyphContexts.get('0') as GraphicsContext;
    for (let index = 0; index < MAX_EFFECTS; index += 1) {
      const slotRoot = new Container();
      slotRoot.visible = false;
      const glyphs: Graphics[] = [];
      for (let glyph = 0; glyph < MAX_GLYPHS; glyph += 1) {
        const graphic = new Graphics(blank);
        graphic.visible = false;
        glyphs.push(graphic);
        slotRoot.addChild(graphic);
      }
      this.layer.addChild(slotRoot);
      this.slots.push({
        root: slotRoot, glyphs, active: false, bornMs: 0, x: 0, y: 0, cellX: 0, cellY: 0, objectId: null,
        kind: 'build', rise: -1, alphaStep: -1, pendingTop: false,
      });
    }
    root.addChild(this.layer);
  }

  get isEmpty(): boolean {
    return this.activeCount === 0;
  }

  /** How many effects are running (for tests and the performance readout). */
  get active(): number {
    return this.activeCount;
  }

  /**
   * Starts an effect. Reads `effect` and keeps nothing of it (GameApp reuses one object). With the pool full the oldest
   * running effect is replaced. An object effect whose object is unknown is dropped.
   */
  show(effect: Readonly<WorldEffect>): void {
    let slot: Slot | null = null;
    for (const candidate of this.slots) {
      if (!candidate.active) { slot = candidate; break; }
      if (slot === null || candidate.bornMs < slot.bornMs) slot = candidate;
    }
    if (slot === null) return;
    slot.kind = effect.kind;
    slot.cellX = effect.x;
    slot.cellY = effect.y;
    slot.objectId = effect.objectId;
    if (!this.anchorOf(slot)) {
      if (slot.active) this.release(slot);
      return;
    }
    if (!slot.active) this.activeCount += 1;
    slot.active = true;
    slot.bornMs = this.nowMs;
    slot.x = this.anchor.x;
    slot.y = this.anchor.y;
    slot.rise = -1;
    slot.alphaStep = -1;
    this.dress(slot, effect);
    slot.root.visible = true;
    this.place(slot);
    this.version += 1;
  }

  /** Advances every running effect to `elapsedMs`. Draws nothing; allocates nothing. */
  update(elapsedMs: number): void {
    this.nowMs = elapsedMs;
    if (this.activeCount === 0) return;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      if (elapsedMs - slot.bornMs >= EFFECT_LIFETIME_MS || elapsedMs < slot.bornMs) {
        this.release(slot);
        this.version += 1;
        continue;
      }
      // A building placed this gesture: the scene knows its top from the next frame; move the popup above it then.
      if (slot.pendingTop && slot.objectId !== null && this.objectTop(slot.objectId) !== null && this.anchorOf(slot)) {
        slot.x = this.anchor.x;
        slot.y = this.anchor.y;
        slot.rise = -1;
      }
      this.place(slot);
    }
  }

  /** The map was turned: every running effect moves to its view position (one version bump). */
  setView(frame: ViewFrame): void {
    const same = sameViewFrame(frame, this.frame);
    this.frame.rotation = frame.rotation;
    this.frame.width = frame.width;
    this.frame.height = frame.height;
    if (same) return;
    const before = this.version;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      if (!this.anchorOf(slot)) { this.release(slot); continue; }
      slot.x = this.anchor.x;
      slot.y = this.anchor.y;
      slot.rise = -1;
      this.place(slot);
    }
    this.version = before + 1;
  }

  /** A new park: everything running goes. */
  reset(): void {
    if (this.activeCount === 0) return;
    for (const slot of this.slots) if (slot.active) this.release(slot);
    this.version += 1;
  }

  destroy(): void {
    for (const context of this.glyphContexts.values()) context.destroy();
    for (const context of this.iconContexts.values()) context.destroy();
  }

  private release(slot: Slot): void {
    slot.active = false;
    slot.root.visible = false;
    this.activeCount -= 1;
  }

  /** Points the slot's glyphs at the effect's text or icon and tints them. */
  private dress(slot: Slot, effect: Readonly<WorldEffect>): void {
    const tint = EFFECT_TINT[effect.kind];
    if (effect.kind === 'money-gain' || effect.kind === 'money-spend') {
      const text = moneyText(effect.kind === 'money-spend' ? -Math.abs(effect.amount) : Math.abs(effect.amount));
      const count = Math.min(text.length, MAX_GLYPHS);
      // Glyphs are 3 texels and a 1-texel gap, centred on the anchor.
      const left = -((count * 4 - 1) >> 1) + 1;
      for (let index = 0; index < MAX_GLYPHS; index += 1) {
        const glyph = slot.glyphs[index];
        const context = index < count ? this.glyphContexts.get(text[index]) : undefined;
        glyph.visible = context !== undefined;
        if (context === undefined) continue;
        glyph.context = context;
        glyph.tint = tint;
        glyph.position.set(left + index * 4, 0);
      }
      return;
    }
    const icon = slot.glyphs[0];
    icon.context = this.iconContexts.get(effect.kind) as GraphicsContext;
    icon.tint = tint;
    icon.visible = true;
    icon.position.set(0, 0);
    for (let index = 1; index < MAX_GLYPHS; index += 1) slot.glyphs[index].visible = false;
  }

  /** Whole-texel rise and an eighths alpha from the effect's age; bumps `version` only when either changed. */
  private place(slot: Slot): void {
    const age = Math.max(0, this.nowMs - slot.bornMs);
    const still = this.reducedMotion();
    const rise = still ? 0 : Math.min(12, Math.floor(age / RISE_STEP_MS));
    const fadeFrom = EFFECT_LIFETIME_MS * (2 / 3);
    const alphaStep = still || age < fadeFrom ? 8 : Math.max(1, 8 - Math.floor(((age - fadeFrom) / (EFFECT_LIFETIME_MS - fadeFrom)) * 8));
    if (rise === slot.rise && alphaStep === slot.alphaStep) return;
    slot.rise = rise;
    slot.alphaStep = alphaStep;
    slot.root.position.set(slot.x, slot.y - rise);
    slot.root.alpha = alphaStep / 8;
    this.version += 1;
  }

  /**
   * The effect's foot in view texels, into `this.anchor`: above the object's top for an object effect (its footprint
   * centre), above a guest's head for a reaction, else on the ground point (x, y) (fractional cells allowed).
   */
  private anchorOf(slot: Slot): boolean {
    let cx = slot.cellX;
    let cy = slot.cellY;
    let lift = 0;
    if (slot.objectId !== null) {
      const object = this.session().world.objects.get(slot.objectId);
      const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
      if (!object || !definition) return false;
      const size = footprintSize(definition, object.rotation);
      cx = object.anchor.x + (size[0] - 1) / 2;
      cy = object.anchor.y + (size[1] - 1) / 2;
      // A construction puff sits on the ground of the footprint (under the money popup). An object built this very
      // gesture has no scene top yet (the scene syncs on the next frame): its popup uses a typical building height
      // instead of being dropped (browser check, 2026-10-14).
      const top = slot.kind === 'build' ? 0 : this.objectTop(slot.objectId);
      slot.pendingTop = top === null;
      lift = top ?? NEW_OBJECT_TOP;
    } else if (slot.kind === 'happy' || slot.kind === 'unhappy') {
      lift = GUEST_HEAD;
    }
    cellToView(this.frame, cx, cy, this.anchor);
    const u = this.anchor.x;
    const v = this.anchor.y;
    this.anchor.x = Math.round((u - v) * TILE_WIDTH / 2);
    this.anchor.y = Math.round((u + v) * TILE_HEIGHT / 2 + TILE_HEIGHT / 2 - lift) - CLEARANCE;
    return true;
  }
}
