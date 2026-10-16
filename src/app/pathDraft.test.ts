import { describe, expect, it } from 'vitest';
import { blockedDraftCells, extendPathDraft } from './pathDraft';
import type { Cell } from '../game/types';

const drag = (points: Cell[]): Cell[] => {
  const draft: Cell[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) extendPathDraft(draft, draft[draft.length - 1], points[index]);
  return draft;
};
const keys = (cells: readonly Cell[]): string[] => cells.map((cell) => `${cell.x},${cell.y}`);

describe('extendPathDraft', () => {
  it('grows along the line, both ends included once', () => {
    expect(keys(drag([{ x: 0, y: 0 }, { x: 3, y: 0 }]))).toEqual(['0,0', '1,0', '2,0', '3,0']);
  });

  it('pulling back cuts the draft to the cell the pointer returns to', () => {
    expect(keys(drag([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 0 }]))).toEqual(['0,0', '1,0', '2,0']);
  });

  it('pulling back all the way leaves the one-cell draft', () => {
    expect(keys(drag([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 0 }]))).toEqual(['0,0']);
  });

  it('steers round after a pull-back: only the final route stays', () => {
    const draft = drag([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2 }, { x: 4, y: 2 }]);
    expect(keys(draft)).toEqual(['0,0', '1,0', '1,1', '1,2', '2,2', '3,2', '4,2']);
  });

  it('a fast move across the trail cuts at the first trail cell it meets and grows on', () => {
    // An L: down 3, right 2; then one jump straight back left across the vertical leg at (0,3)… the line from (2,3)
    // to (-2,3) meets (1,3), then (0,3) — both trail cells — and goes on to fresh cells.
    const draft = drag([{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: 2, y: 3 }, { x: -2, y: 3 }]);
    expect(keys(draft)).toEqual(['0,0', '0,1', '0,2', '0,3', '-1,3', '-2,3']);
  });

  it('never holds a cell twice and always ends on the pointer cell', () => {
    const points: Cell[] = [{ x: 5, y: 5 }, { x: 9, y: 7 }, { x: 6, y: 9 }, { x: 5, y: 4 }, { x: 8, y: 6 }, { x: 5, y: 5 }];
    const draft = drag(points);
    expect(new Set(keys(draft)).size).toBe(draft.length);
    expect(draft[draft.length - 1]).toEqual({ x: 5, y: 5 });
  });
});

describe('blockedDraftCells', () => {
  it('lists the cells that cannot take a path, in order', () => {
    const draft = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    expect(keys(blockedDraftCells(draft, (cell) => cell.x % 2 === 0))).toEqual(['1,0', '3,0']);
  });
});
