import { describe, expect, it } from 'vitest';
import { createViewFrame, VIEW_ROTATIONS, type XY } from '../../viewRotation';
import { queueSlotOffset } from './figures';
import { projectX, projectY } from './space';
import { createViewTransform, setViewTransform, vectorToViewVoxel } from './view';

/**
 * Phase 26 review. `queueSlotOffset` is the legacy SCREEN layout of a queue (7 columns 7 texels apart, rows 5
 * texels further down the screen and nearer the camera) re-expressed as a WORLD ground offset for view 0 only. The
 * figure packer adds it to the guest's world position (scene/figures.ts `write`), and the turned views map that world
 * offset through uView like everything else, so the layout turns with the map: in views 1 and 3 a row of queued
 * guests lies along the depth axis (one guest in front, a tower of heads behind it), and in view 2 the rows climb the
 * screen away from the camera. Seen in the headless matrix (phase26/vrev/shots/queue-q*.png). The queue is
 * presentation only, so it should keep its screen layout in every view (as the classic renderer's does).
 * Fixed: queueSlotOffset takes the view and returns the world offset whose view offset is the legacy layout.
 */
describe('queue slot layout in turned views (review)', () => {
  const t = createViewTransform();
  const v: XY = { x: 0, y: 0 };
  const screenOf = (index: number): { sx: number; sy: number } => {
    const o = queueSlotOffset(index, t.rotation);
    vectorToViewVoxel(t, o.dvx, o.dvy, v);
    return { sx: projectX(v.x, v.y), sy: projectY(v.x, v.y, 0) };
  };

  it.each(VIEW_ROTATIONS)('view %i: the first row spreads 7 texels apart across the screen and later rows sit lower', (q) => {
    setViewTransform(createViewFrame(q, 32, 32), t);
    const row0 = [0, 1, 2, 3, 4, 5, 6].map(screenOf);
    expect(row0.map((p) => p.sx), 'columns side by side on screen').toEqual([-21, -14, -7, 0, 7, 14, 21]);
    expect(row0.map((p) => p.sy), 'one row on one screen line').toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(screenOf(7).sy, 'the second row is lower on screen (nearer the camera)').toBe(5);
  });
});
