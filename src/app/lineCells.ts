import type { Cell } from '../game/types';

/** The cells a straight pointer path crosses, both ends included (Bresenham), shared by every drag tool. */
export const lineCells = (from: Cell, to: Cell): Cell[] => {
  const cells: Cell[] = [];
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const sx = from.x < to.x ? 1 : -1;
  const sy = from.y < to.y ? 1 : -1;
  let error = dx - dy;
  while (true) {
    cells.push({ x, y });
    if (x === to.x && y === to.y) break;
    const doubled = error * 2;
    if (doubled > -dy) { error -= dy; x += sx; }
    if (doubled < dx) { error += dx; y += sy; }
  }
  return cells;
};
