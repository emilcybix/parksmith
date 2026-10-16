import { describe, expect, it } from 'vitest';
import {
  cellFromView, cellToView, compassAngle, createViewFrame, fromViewCell, IDENTITY_VIEW_FRAME, isViewRotation,
  pointFromView, pointToView, rectToView, rotationInView, toViewCell, turnView, vectorFromView, vectorToView,
  viewMapSize, VIEW_ROTATIONS, type CellRect, type ViewFrame, type ViewRotation, type XY,
} from './viewRotation';
import { pickCell } from './worldInput';
import { worldToCell } from './isometric';

const SIZES: readonly [number, number][] = [[1, 1], [1, 2], [2, 1], [3, 5], [5, 3], [7, 7], [32, 32], [64, 48], [48, 64]];
const frameOf = (q: ViewRotation, w: number, h: number): ViewFrame => ({ rotation: q, width: w, height: h });

/** Small deterministic PRNG. */
const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

describe('viewRotation', () => {
  it('turnView four times is the identity and validates', () => {
    for (const q of VIEW_ROTATIONS) {
      let r = q;
      for (let i = 0; i < 4; i++) r = turnView(r, 1);
      expect(r).toBe(q);
      expect(turnView(turnView(q, 1), -1)).toBe(q);
    }
    expect(turnView(0, -1)).toBe(3);
    expect(isViewRotation(2)).toBe(true);
    expect(isViewRotation(4)).toBe(false);
    expect(isViewRotation('1')).toBe(false);
  });

  it('four composed turns (with each intermediate view size) are the identity for every cell', () => {
    for (const [w, h] of SIZES) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let cur: XY = { x, y };
          let cw = w;
          let ch = h;
          for (let i = 0; i < 4; i++) {
            cur = cellToView(frameOf(1, cw, ch), cur.x, cur.y, { x: 0, y: 0 });
            [cw, ch] = [ch, cw];
          }
          expect(cur).toEqual({ x, y });
        }
      }
    }
  });

  it('round trips, stays inside the view map, and is a bijection', () => {
    for (const [w, h] of SIZES) {
      for (const q of VIEW_ROTATIONS) {
        const frame = frameOf(q, w, h);
        const size = viewMapSize(frame);
        const seen = new Set<number>();
        const out: XY = { x: 0, y: 0 };
        const back: XY = { x: 0, y: 0 };
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            cellToView(frame, x, y, out);
            expect(out.x).toBeGreaterThanOrEqual(0);
            expect(out.y).toBeGreaterThanOrEqual(0);
            expect(out.x).toBeLessThan(size.width);
            expect(out.y).toBeLessThan(size.height);
            seen.add(out.y * size.width + out.x);
            cellFromView(frame, out.x, out.y, back);
            expect(back).toEqual({ x, y });
          }
        }
        expect(seen.size).toBe(w * h);
        for (let v = 0; v < size.height; v++) {
          for (let u = 0; u < size.width; u++) {
            cellFromView(frame, u, v, out);
            cellToView(frame, out.x, out.y, back);
            expect(back).toEqual({ x: u, y: v });
          }
        }
      }
    }
  });

  it('points round trip and a cell centre maps to the view cell centre', () => {
    const rnd = prng(3);
    for (const [w, h] of SIZES) {
      for (const q of VIEW_ROTATIONS) {
        const frame = frameOf(q, w, h);
        const a: XY = { x: 0, y: 0 };
        const b: XY = { x: 0, y: 0 };
        for (let i = 0; i < 50; i++) {
          const x = rnd() * w;
          const y = rnd() * h;
          pointToView(frame, x, y, a);
          pointFromView(frame, a.x, a.y, b);
          expect(Math.abs(b.x - x)).toBeLessThan(1e-12);
          expect(Math.abs(b.y - y)).toBeLessThan(1e-12);
          const cx = Math.floor(x);
          const cy = Math.floor(y);
          pointToView(frame, cx + 0.5, cy + 0.5, a);
          cellToView(frame, cx, cy, b);
          expect(a.x).toBeCloseTo(b.x + 0.5, 12);
          expect(a.y).toBeCloseTo(b.y + 0.5, 12);
          // a non-boundary point stays in the cell the cell transform names
          pointToView(frame, x, y, a);
          cellFromView(frame, Math.floor(a.x), Math.floor(a.y), b);
          expect(b).toEqual({ x: cx, y: cy });
        }
      }
    }
  });

  it('a vector is the difference of neighbouring cells and inverts', () => {
    const frame0 = (q: ViewRotation) => frameOf(q, 9, 6);
    for (const q of VIEW_ROTATIONS) {
      const frame = frame0(q);
      const o: XY = { x: 0, y: 0 };
      const a: XY = { x: 0, y: 0 };
      const b: XY = { x: 0, y: 0 };
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 3]]) {
        cellToView(frame, 3, 3, a);
        cellToView(frame, 3 + dx, 3 + dy, b);
        vectorToView(q, dx, dy, o);
        expect([o.x + 0, o.y + 0]).toEqual([b.x - a.x, b.y - a.y]);
        vectorFromView(q, o.x, o.y, b);
        expect([b.x + 0, b.y + 0]).toEqual([dx, dy]);
      }
    }
  });

  it('footprint rectangles map to rectangles with matching area', () => {
    const rnd = prng(11);
    for (const [w, h] of SIZES) {
      for (const q of VIEW_ROTATIONS) {
        const frame = frameOf(q, w, h);
        const rect: CellRect = { x: 0, y: 0, width: 0, depth: 0 };
        const out: XY = { x: 0, y: 0 };
        for (let i = 0; i < 30; i++) {
          const rw = 1 + Math.floor(rnd() * Math.min(w, 4));
          const rd = 1 + Math.floor(rnd() * Math.min(h, 4));
          const rx = Math.floor(rnd() * (w - rw + 1));
          const ry = Math.floor(rnd() * (h - rd + 1));
          rectToView(frame, rx, ry, rw, rd, rect);
          expect(rect.width * rect.depth).toBe(rw * rd);
          const seen = new Set<number>();
          for (let y = ry; y < ry + rd; y++) {
            for (let x = rx; x < rx + rw; x++) {
              cellToView(frame, x, y, out);
              expect(out.x).toBeGreaterThanOrEqual(rect.x);
              expect(out.x).toBeLessThan(rect.x + rect.width);
              expect(out.y).toBeGreaterThanOrEqual(rect.y);
              expect(out.y).toBeLessThan(rect.y + rect.depth);
              seen.add(out.y * 1000 + out.x);
            }
          }
          expect(seen.size).toBe(rw * rd);
        }
      }
    }
  });

  it('rotationInView, compassAngle and q = 0 identity', () => {
    expect(rotationInView(0, 0)).toBe(0);
    expect(rotationInView(1, 1)).toBe(2);
    expect(rotationInView(3, 2)).toBe(1);
    for (const r of [0, 1, 2, 3] as const) for (const q of VIEW_ROTATIONS) expect((rotationInView(r, q) & 1)).toBe((r + q) & 1);
    expect(VIEW_ROTATIONS.map(compassAngle)).toEqual([45, 135, 225, 315]);
    const frame = createViewFrame(0, 32, 32);
    const cell = { x: 4, y: 9 };
    expect(toViewCell(frame, cell)).toBe(cell);
    expect(fromViewCell(IDENTITY_VIEW_FRAME, cell)).toBe(cell);
    expect(toViewCell(frameOf(1, 32, 32), cell)).toEqual({ x: 22, y: 4 });
    const p = pickCell(frame, 123.4, 56.7);
    expect(p).toEqual(worldToCell(123.4, 56.7));
    const out: XY = { x: 0, y: 0 };
    expect(Object.is(pointToView(frame, 1.25, 2.5, out).x, 1.25)).toBe(true);
    expect(viewMapSize(frameOf(1, 4, 7))).toEqual({ width: 7, height: 4 });
  });
});
