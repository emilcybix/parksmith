import { describe, expect, it } from 'vitest';
import {
  cellToView, createViewFrame, pointFromView, pointToView, turnView, VIEW_ROTATIONS, vectorToView,
  type ViewFrame, type ViewRotation, type XY,
} from '../../viewRotation';
import {
  createViewTransform, headingInView, patternCellShift, setViewTransform, vectorToViewVoxel, voxelFromView, voxelToView,
} from './view';

const frames = (width: number, height: number): ViewFrame[] => VIEW_ROTATIONS.map((q) => createViewFrame(q, width, height));
const out: XY = { x: 0, y: 0 };
const ref: XY = { x: 0, y: 0 };

describe('contracts/view: the voxel view transform', () => {
  for (const [w, h] of [[32, 32], [24, 40], [7, 5]]) {
    it(`equals pointToView x 32 for every rotation and random points (${w}x${h})`, () => {
      for (const frame of frames(w, h)) {
        const t = setViewTransform(frame, createViewTransform());
        for (let index = 0; index < 200; index += 1) {
          const x = Math.floor(Math.random() * w * 32);
          const y = Math.floor(Math.random() * h * 32);
          voxelToView(t, x, y, out);
          pointToView(frame, x / 32, y / 32, ref);
          expect(out.x).toBe(ref.x * 32);
          expect(out.y).toBe(ref.y * 32);
          voxelFromView(t, out.x, out.y, out);
          expect(out).toEqual({ x, y });
          pointFromView(frame, ref.x, ref.y, ref);
          expect(ref.x * 32).toBe(x);
          expect(ref.y * 32).toBe(y);
        }
      }
    });
  }

  it('vectors take the linear part only and match vectorToView', () => {
    for (const frame of frames(32, 32)) {
      const t = setViewTransform(frame, createViewTransform());
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [3, -7]]) {
        vectorToViewVoxel(t, dx, dy, out);
        vectorToView(frame.rotation, dx, dy, ref);
        expect(out).toEqual({ x: ref.x + 0, y: ref.y + 0 });
      }
    }
  });

  it('cell corners: the min corner of cell (x, y) maps to the view min or max corner per the rect rule', () => {
    for (const frame of frames(32, 20)) {
      const t = setViewTransform(frame, createViewTransform());
      const cell = cellToView(frame, 5, 3, { x: 0, y: 0 });
      // The cell's four voxel corners cover exactly the view cell's voxel square.
      const us: number[] = [];
      const vs: number[] = [];
      for (const [cx, cy] of [[5, 3], [6, 3], [5, 4], [6, 4]]) {
        voxelToView(t, cx * 32, cy * 32, out);
        us.push(out.x);
        vs.push(out.y);
      }
      expect(Math.min(...us)).toBe(cell.x * 32);
      expect(Math.max(...us)).toBe(cell.x * 32 + 32);
      expect(Math.min(...vs)).toBe(cell.y * 32);
      expect(Math.max(...vs)).toBe(cell.y * 32 + 32);
    }
  });

  it('is the identity for view 0 and bit-identical (no negative zero)', () => {
    const t = setViewTransform(createViewFrame(0, 32, 32), createViewTransform());
    expect(Object.is(voxelToView(t, 0, 0, out).x, 0)).toBe(true);
    expect(Object.is(out.y, 0)).toBe(true);
    expect(voxelToView(t, 123, 456, out)).toEqual({ x: 123, y: 456 });
    expect(Object.is(patternCellShift(t, out).y, 0)).toBe(true);
    expect(out.x).toBe(0.5);
  });

  it('four turns give the identity', () => {
    let rotation: ViewRotation = 0;
    const t = createViewTransform();
    for (let step = 0; step < 4; step += 1) {
      rotation = turnView(rotation, 1);
      setViewTransform(createViewFrame(rotation, 32, 32), t);
    }
    expect(t.rotation).toBe(0);
    expect(voxelToView(t, 77, 91, out)).toEqual({ x: 77, y: 91 });
  });

  it('bumps the revision only when a value moved', () => {
    const t = createViewTransform();
    const frame = createViewFrame(1, 32, 32);
    setViewTransform(frame, t);
    const revision = t.revision;
    setViewTransform(frame, t);
    expect(t.revision).toBe(revision);
    setViewTransform(createViewFrame(2, 32, 32), t);
    expect(t.revision).toBe(revision + 1);
  });

  it('headingInView matches the matrix on the four unit vectors', () => {
    const headings: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (const frame of frames(32, 32)) {
      const t = setViewTransform(frame, createViewTransform());
      for (let heading = 0; heading < 4; heading += 1) {
        vectorToViewVoxel(t, headings[heading][0], headings[heading][1], out);
        const [ex, ey] = headings[headingInView(heading, frame.rotation)];
        expect(out).toEqual({ x: ex, y: ey });
      }
    }
  });

  it('patternCellShift is half a voxel along view +x in world axes', () => {
    for (const frame of frames(32, 32)) {
      const t = setViewTransform(frame, createViewTransform());
      patternCellShift(t, out);
      // View +x is (c, s) in world axes... the inverse of the linear part applied to (1, 0).
      voxelFromView(t, t.ox + 1, t.oy, ref);
      expect(out.x).toBe(ref.x / 2);
      expect(out.y).toBe(ref.y / 2);
    }
  });
});
