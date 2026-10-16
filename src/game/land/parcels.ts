import { GAME_CONFIG } from '../config';
import type { Cell } from '../types';

/**
 * Parcel geometry (Phase 21). Pure. A parcel is a `parcelSize` x `parcelSize` square of cells, indexed row-major:
 * `index = py * columns + px`. Map sizes are whole parcels (the validators guarantee it), so no parcel is partial.
 */
export interface ParcelGrid {
  readonly parcelSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly count: number;
}

/** An inclusive cell rectangle (the shape of `MapDefinition.ownedArea`). */
export interface CellRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export const parcelGridOf = (width: number, height: number, parcelSize: number = GAME_CONFIG.land.parcelSize): ParcelGrid => {
  const columns = Math.ceil(width / parcelSize);
  const rows = Math.ceil(height / parcelSize);
  return Object.freeze({ parcelSize, columns, rows, count: columns * rows });
};

/** True when a map size is legal: whole parcels, within the land bounds on each axis. */
export const isLegalMapSize = (width: number, height: number): boolean => {
  const { parcelSize, minimumMapSize, maximumMapSize } = GAME_CONFIG.land;
  const legal = (value: number) => Number.isInteger(value) && value >= minimumMapSize && value <= maximumMapSize && value % parcelSize === 0;
  return legal(width) && legal(height);
};

/** The sentence a refused size reads as. */
export const legalMapSizeText = (): string => {
  const { parcelSize, minimumMapSize, maximumMapSize } = GAME_CONFIG.land;
  return `whole ${parcelSize}-cell parcels from ${minimumMapSize} to ${maximumMapSize} on each side`;
};

export const parcelIndexOfCell = (grid: ParcelGrid, x: number, y: number): number => (
  Math.floor(y / grid.parcelSize) * grid.columns + Math.floor(x / grid.parcelSize)
);

export const parcelColumn = (grid: ParcelGrid, index: number): number => index % grid.columns;
export const parcelRow = (grid: ParcelGrid, index: number): number => Math.floor(index / grid.columns);

/** The parcel's cells as an inclusive rectangle. */
export const parcelRect = (grid: ParcelGrid, index: number): CellRect => {
  const x0 = parcelColumn(grid, index) * grid.parcelSize;
  const y0 = parcelRow(grid, index) * grid.parcelSize;
  return { x0, y0, x1: x0 + grid.parcelSize - 1, y1: y0 + grid.parcelSize - 1 };
};

/** The parcel's centre cell (rounded down): where a "For sale" marker stands. */
export const parcelCentre = (grid: ParcelGrid, index: number): Cell => {
  const rect = parcelRect(grid, index);
  return { x: rect.x0 + (grid.parcelSize >> 1), y: rect.y0 + (grid.parcelSize >> 1) };
};

/** The four edge neighbours inside the grid, in a fixed order (north, east, south, west). */
export const parcelNeighbours = (grid: ParcelGrid, index: number): number[] => {
  const px = parcelColumn(grid, index);
  const py = parcelRow(grid, index);
  const out: number[] = [];
  if (py > 0) out.push(index - grid.columns);
  if (px < grid.columns - 1) out.push(index + 1);
  if (py < grid.rows - 1) out.push(index + grid.columns);
  if (px > 0) out.push(index - 1);
  return out;
};

/** Chebyshev distance between two parcels, in parcels. */
export const parcelDistance = (grid: ParcelGrid, a: number, b: number): number => Math.max(
  Math.abs(parcelColumn(grid, a) - parcelColumn(grid, b)),
  Math.abs(parcelRow(grid, a) - parcelRow(grid, b)),
);

/** The parcels a parcel-aligned rectangle covers, ascending. Null when the rectangle is not parcel-aligned. */
export const parcelsOfRect = (grid: ParcelGrid, rect: CellRect): number[] | null => {
  const size = grid.parcelSize;
  if (rect.x0 % size !== 0 || rect.y0 % size !== 0 || (rect.x1 + 1) % size !== 0 || (rect.y1 + 1) % size !== 0) return null;
  const out: number[] = [];
  for (let py = rect.y0 / size; py <= (rect.y1 + 1) / size - 1; py += 1) {
    for (let px = rect.x0 / size; px <= (rect.x1 + 1) / size - 1; px += 1) out.push(py * grid.columns + px);
  }
  return out;
};

/**
 * The price of one parcel (see GAME_CONFIG.land.price): grows with the parcels already owned, carries a premium near the
 * gate and a discount far from it, scaled by the ruleset's land multiplier, rounded to the nearest `roundTo`. Pure.
 */
export const parcelPrice = (ownedCount: number, distanceFromGate: number, landCostMultiplier: number): number => {
  const price = GAME_CONFIG.land.price;
  const distanceFactor = Math.max(price.farFloor, 1 + price.nearPremium - price.perStep * distanceFromGate);
  const raw = (price.basePrice + price.perOwnedParcel * ownedCount) * distanceFactor * landCostMultiplier;
  return Math.max(price.roundTo, Math.round(raw / price.roundTo) * price.roundTo);
};
