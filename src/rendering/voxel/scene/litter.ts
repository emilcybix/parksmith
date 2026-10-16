import type { LitterPileRuntime } from '../../../game/operations/types';
import { BOX_TEXELS, BoxWriter, DYNAMIC_BOX_TEX_WIDTH } from '../contracts/boxes';

/**
 * The litter list: every litter pile on the paths as a few small boxes (cups and wrappers from the
 * content's LitterEmitter), in the dynamic litter texture (the static BOX layout, 256 texels wide).
 *
 * Litter is not static geometry: at a thousand guests piles appear and get swept up every few
 * seconds, and putting them in the static chunks would rebuild a chunk each time. It is not
 * per-frame either: a pile only changes when a guest drops something or a cleaner sweeps. So the
 * list is rebuilt, whole, only when its signature — a hash of every pile's cell and units, computed
 * allocation-free each frame — changes, and a steady frame uploads nothing.
 */

/** Boxes per litter texture row (256 texels, two per box). */
export const LITTER_BOXES_PER_ROW = DYNAMIC_BOX_TEX_WIDTH / BOX_TEXELS;

/** Texture rows `count` litter boxes occupy. */
export const litterRowsFor = (count: number): number => Math.ceil(Math.max(0, count) / LITTER_BOXES_PER_ROW);

/** Emits one pile's boxes; the scene passes the content's emitter wrapped so it never throws. */
export type LitterPileEmitter = (cellX: number, cellY: number, units: number, out: BoxWriter, sick: boolean) => void;

const FNV_OFFSET = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

/** A well-mixed 32-bit value of one pile, for the order-independent half of the signature. */
const mixPile = (x: number, y: number, units: number): number => {
  let hash = Math.imul(x ^ 0x9e37_79b9, 0x85eb_ca6b) ^ Math.imul(y + 0x7f4a_7c15, 0xc2b2_ae35);
  hash ^= Math.imul(units ^ 0x2545_f491, 0x27d4_eb2f);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2c1b_3c6d);
  return (hash ^ (hash >>> 12)) >>> 0;
};

export class LitterList {
  /** The boxes of every pile, in world voxels, slot 0. */
  readonly boxes = new BoxWriter(128);
  private readonly emit: LitterPileEmitter;
  private hashOrdered = 0;
  private hashSum = 0;
  private pileCount = 0;
  private builtOrdered = Number.NaN;
  private builtSum = Number.NaN;
  private builtCount = -1;

  constructor(emit: LitterPileEmitter) {
    this.emit = emit;
  }

  /** Texture rows the current boxes occupy. */
  get rows(): number {
    return litterRowsFor(this.boxes.count);
  }

  /** Forget what was built (a new session, a lost sink): the next `sync` rebuilds. */
  reset(): void {
    this.builtOrdered = Number.NaN;
    this.builtSum = Number.NaN;
    this.builtCount = -1;
    this.boxes.clear();
  }

  /**
   * Recomputes the signature of `piles` (allocation-free) and rebuilds the boxes when it changed.
   * True when the boxes were rebuilt and must be uploaded.
   */
  sync(piles: ReadonlyMap<string, LitterPileRuntime>): boolean {
    this.hashOrdered = FNV_OFFSET;
    this.hashSum = 0;
    this.pileCount = 0;
    piles.forEach(this.accumulate);
    if (this.hashOrdered === this.builtOrdered && this.hashSum === this.builtSum && this.pileCount === this.builtCount) {
      return false;
    }
    this.builtOrdered = this.hashOrdered;
    this.builtSum = this.hashSum;
    this.builtCount = this.pileCount;
    this.boxes.clear();
    piles.forEach(this.emitPile);
    return true;
  }

  /**
   * Two hashes, one over the piles in iteration order and one a sum that ignores order, plus the
   * count: a stale list would need all three to collide at once.
   */
  private readonly accumulate = (pile: LitterPileRuntime): void => {
    // Phase 29: a pile turning sick changes its look, so the flag is part of its signature.
    const mixed = mixPile(pile.cell.x, pile.cell.y, pile.sick ? pile.units ^ 0x4000_0000 : pile.units);
    this.hashOrdered = Math.imul(this.hashOrdered ^ mixed, FNV_PRIME) >>> 0;
    this.hashSum = (this.hashSum + mixed) >>> 0;
    this.pileCount += 1;
  };

  private readonly emitPile = (pile: LitterPileRuntime): void => {
    if (pile.units <= 0) return;
    this.emit(pile.cell.x, pile.cell.y, pile.units, this.boxes, pile.sick === true);
  };
}
