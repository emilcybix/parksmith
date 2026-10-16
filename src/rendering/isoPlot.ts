import type { Graphics } from 'pixi.js';
import type { Rotation } from '../game/types';
import { cellToWorld, TILE_HEIGHT, TILE_WIDTH } from './isometric';

/**
 * Geometry for art that has to line up with the plot it stands on.
 *
 * A building's footprint is a rectangle in GRID cells, which on screen is a slanted
 * parallelogram — never a screen-axis-aligned box. Anything long (an oval track, a water
 * channel, a plot surface) must therefore be measured in cells and converted here; built
 * from screen-space radii instead, it lies diagonally across the tiles the player selected
 * and spills onto the neighbours.
 */

/** Screen offset of a point measured in grid cells from the footprint centre. */
export const cellPoint = (cellX: number, cellY: number): { x: number; y: number } =>
  cellToWorld({ x: cellX, y: cellY });

/** Screen offset back to grid cells; only valid for points drawn at ground level. */
export const cellOffsetOf = (point: { x: number; y: number }): { x: number; y: number } => ({
  x: point.x / TILE_WIDTH + point.y / TILE_HEIGHT,
  y: point.y / TILE_HEIGHT - point.x / TILE_WIDTH,
});

/** Orders a pair of cell-space measurements to the plot's own axes; quarter turns swap them. */
export const alongFootprint = (
  rotation: Rotation,
  long: number,
  short: number,
): [number, number] => rotation % 2 === 0 ? [long, short] : [short, long];

/** Flat point list of a cell-space ellipse, ready for `poly(points, true)`. */
export const loopOutline = (longAxis: number, shortAxis: number, steps = 48): number[] => {
  const points: number[] = [];
  for (let index = 0; index < steps; index += 1) {
    const angle = index * Math.PI * 2 / steps;
    const point = cellPoint(Math.cos(angle) * longAxis, Math.sin(angle) * shortAxis);
    points.push(point.x, point.y);
  }
  return points;
};

/** The plot surface: the footprint's isometric parallelogram, from cell half-extents. */
export const groundPlate = (
  graphic: Graphics,
  halfWidth: number,
  halfDepth: number,
  color: number,
  alpha = 1,
): void => {
  const corners = [
    cellPoint(-halfWidth, -halfDepth),
    cellPoint(halfWidth, -halfDepth),
    cellPoint(halfWidth, halfDepth),
    cellPoint(-halfWidth, halfDepth),
  ];
  graphic.poly(corners.flatMap((corner) => [corner.x, corner.y]), true).fill({ color, alpha });
};
