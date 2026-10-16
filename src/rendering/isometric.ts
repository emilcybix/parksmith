import type { Cell } from '../game/types';

export const TILE_WIDTH = 64;
export const TILE_HEIGHT = 32;

export const cellToWorld = ({ x, y }: Cell): { x: number; y: number } => ({
  x: (x - y) * (TILE_WIDTH / 2),
  y: (x + y) * (TILE_HEIGHT / 2),
});

export const worldToCell = (x: number, y: number): Cell => ({
  x: Math.floor(x / TILE_WIDTH + y / TILE_HEIGHT),
  y: Math.floor(-x / TILE_WIDTH + y / TILE_HEIGHT),
});

export const isometricSortKey = (
  anchor: Cell,
  footprint: readonly [number, number] = [1, 1],
): number => {
  const frontX = anchor.x + footprint[0] - 1;
  const frontY = anchor.y + footprint[1] - 1;
  return (frontX + frontY) * 100 + frontX;
};

export const diamondPoints = (x: number, y: number, inset = 0): number[] => [
  x, y + inset,
  x + TILE_WIDTH / 2 - inset, y + TILE_HEIGHT / 2,
  x, y + TILE_HEIGHT - inset,
  x - TILE_WIDTH / 2 + inset, y + TILE_HEIGHT / 2,
];
