import type { Cell } from '../types';
import {
  parcelDistance,
  parcelGridOf,
  parcelIndexOfCell,
  parcelNeighbours,
  parcelPrice,
  type ParcelGrid,
} from './parcels';

/** Why a parcel cannot be bought (a refusal changes nothing). */
export type LandPurchaseBlockReason = 'unrestricted' | 'outside' | 'owned' | 'not-adjacent' | 'funds';

/**
 * Which parcels of the map the park owns (Phase 21). An UNRESTRICTED ownership owns every parcel: it is every map whose
 * owned area is null (every 32 x 32 map) and every save written before Phase 21, and it is never saved. A restricted one
 * holds one byte per parcel and is saved as the ascending list of owned parcels.
 *
 * Owned land only grows (land is never sold back) and only by buying a parcel that shares an edge with owned land, so the
 * owned set is always one edge-connected region holding the gate's parcel.
 */
export class LandOwnership {
  readonly grid: ParcelGrid;
  /** The gate's parcel: always owned, the origin of the price's distance factor. */
  readonly gateParcel: number;
  private owned: Uint8Array | null;
  private ownedTotal: number;

  constructor(width: number, height: number, gate: Cell, ownedParcels: readonly number[] | null) {
    this.grid = parcelGridOf(width, height);
    this.gateParcel = parcelIndexOfCell(this.grid, gate.x, gate.y);
    this.owned = null;
    this.ownedTotal = this.grid.count;
    if (ownedParcels !== null) this.assign(ownedParcels);
  }

  /** False when the whole map is owned (nothing to buy, nothing drawn, nothing saved). */
  get restricted(): boolean {
    return this.owned !== null;
  }

  get ownedCount(): number {
    return this.ownedTotal;
  }

  get parcelCount(): number {
    return this.grid.count;
  }

  /** Replaces the owned set (null = everything). The caller validated the list (see `checkOwnedParcels`). */
  assign(ownedParcels: readonly number[] | null): void {
    if (ownedParcels === null) {
      this.owned = null;
      this.ownedTotal = this.grid.count;
      return;
    }
    const owned = new Uint8Array(this.grid.count);
    for (const index of ownedParcels) owned[index] = 1;
    this.owned = owned;
    this.ownedTotal = ownedParcels.length;
  }

  isParcelOwned(index: number): boolean {
    if (index < 0 || index >= this.grid.count || !Number.isInteger(index)) return false;
    return this.owned === null || this.owned[index] === 1;
  }

  /** Ownership of a cell inside the map (the caller checks the map bounds). */
  isCellOwned(x: number, y: number): boolean {
    return this.owned === null || this.owned[parcelIndexOfCell(this.grid, x, y)] === 1;
  }

  parcelOfCell(cell: Cell): number {
    return parcelIndexOfCell(this.grid, cell.x, cell.y);
  }

  /** The owned parcels, ascending (every parcel when unrestricted). */
  ownedParcels(): number[] {
    const out: number[] = [];
    for (let index = 0; index < this.grid.count; index += 1) if (this.isParcelOwned(index)) out.push(index);
    return out;
  }

  /** True when the parcel is unowned and shares an edge with owned land. */
  isForSale(index: number): boolean {
    if (this.owned === null || !this.isParcelInGrid(index) || this.owned[index] === 1) return false;
    return parcelNeighbours(this.grid, index).some((neighbour) => this.owned?.[neighbour] === 1);
  }

  /** The parcels for sale now, ascending. */
  forSale(): number[] {
    const out: number[] = [];
    for (let index = 0; index < this.grid.count; index += 1) if (this.isForSale(index)) out.push(index);
    return out;
  }

  /** The price of a parcel at the current owned count (whether or not it is for sale). */
  priceOf(index: number, landCostMultiplier: number): number {
    return parcelPrice(this.ownedTotal, parcelDistance(this.grid, index, this.gateParcel), landCostMultiplier);
  }

  /** Why a parcel cannot be bought now, ignoring cash (the world adds 'funds'); null = it can. */
  blockReason(index: number): Exclude<LandPurchaseBlockReason, 'funds'> | null {
    if (this.owned === null) return 'unrestricted';
    if (!this.isParcelInGrid(index)) return 'outside';
    if (this.owned[index] === 1) return 'owned';
    return this.isForSale(index) ? null : 'not-adjacent';
  }

  /** Marks a parcel owned. The caller checked `blockReason` and charged the price. */
  take(index: number): void {
    if (this.owned === null || this.owned[index] === 1) return;
    this.owned[index] = 1;
    this.ownedTotal += 1;
  }

  /** The inclusive cell bounds of the owned land (the whole map when unrestricted). */
  ownedBounds(): { x0: number; y0: number; x1: number; y1: number } {
    const size = this.grid.parcelSize;
    if (this.owned === null) return { x0: 0, y0: 0, x1: this.grid.columns * size - 1, y1: this.grid.rows * size - 1 };
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = -1;
    let maxY = -1;
    for (let index = 0; index < this.grid.count; index += 1) {
      if (this.owned[index] !== 1) continue;
      const px = index % this.grid.columns;
      const py = Math.floor(index / this.grid.columns);
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    return { x0: minX * size, y0: minY * size, x1: (maxX + 1) * size - 1, y1: (maxY + 1) * size - 1 };
  }

  private isParcelInGrid(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.grid.count;
  }
}

/**
 * Validates a saved or authored owned-parcel list against a parcel grid: a non-empty, strictly ascending list of parcel
 * indices that holds the gate's parcel and is edge-connected (the only shape buying can produce). Returns the problem, or
 * null when the list is good. Pure.
 */
export const checkOwnedParcels = (grid: ParcelGrid, gateParcel: number, list: unknown): string | null => {
  if (!Array.isArray(list)) return 'is not an array';
  if (list.length === 0) return 'is empty';
  if (list.length > grid.count) return `has ${list.length} entries but the map has ${grid.count} parcels`;
  let previous = -1;
  for (let i = 0; i < list.length; i += 1) {
    const value: unknown = list[i];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= grid.count) {
      return `[${i}] is not a parcel index in 0..${grid.count - 1}`;
    }
    if (value <= previous) return `[${i}] is not strictly ascending`;
    previous = value;
  }
  const owned = new Set(list as number[]);
  if (!owned.has(gateParcel)) return `does not hold the gate's parcel ${gateParcel}`;
  const seen = new Set<number>([gateParcel]);
  const queue = [gateParcel];
  while (queue.length > 0) {
    const next = queue.pop() as number;
    for (const neighbour of parcelNeighbours(grid, next)) {
      if (owned.has(neighbour) && !seen.has(neighbour)) {
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }
  }
  if (seen.size !== owned.size) return 'is not one connected area around the gate';
  return null;
};
