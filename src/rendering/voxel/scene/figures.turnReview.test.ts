import { describe, expect, it } from 'vitest';
import { createViewFrame, VIEW_ROTATIONS } from '../../viewRotation';
import { queueSlotOffset } from '../contracts/figures';
import { createViewTransform, setViewTransform, vectorToViewVoxel } from '../contracts/view';

/**
 * Phase 26 review (adversarial): figure placements that were authored against the SCREEN of view 0.
 *
 * queueSlotOffset is "the legacy screen layout (7 columns, rows 5 px down) re-expressed inside the ground
 * plane ... a queued guest never sinks into the paving or hides behind the fence in front of the access
 * tile". The offset is stored in WORLD voxels and the vertex stage only rotates it, so in view 2 every row
 * goes UP the screen (away from the camera, into whatever stands behind the access tile) and in views 1 / 3
 * the columns run down the screen. The property the comment promises was a view-0 property. Fixed:
 * queueSlotOffset(index, rotation) inverse-turns the screen layout into the world for the view shown, and the
 * figure packer follows the scene's view.
 */
describe('queue slots under view rotation (review)', () => {
  const transforms = VIEW_ROTATIONS.map((q) => setViewTransform(createViewFrame(q, 32, 32), createViewTransform()));
  const out = { x: 0, y: 0 };

  it('every queue row is lower on screen (nearer the camera: view dvx + dvy >= 0) in every view, as in view 0', () => {
    const bad: string[] = [];
    for (const t of transforms) {
      for (let index = 0; index < 80; index += 1) {
        const { dvx, dvy } = queueSlotOffset(index, t.rotation);
        vectorToViewVoxel(t, dvx, dvy, out);
        if (out.x + out.y < -1e-9 && bad.length < 8) bad.push(`view ${t.rotation} slot ${index}: view offset (${out.x}, ${out.y})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the queue crowd keeps the legacy screen layout in every view (the view offset equals the view-0 offset)', () => {
    const bad: string[] = [];
    for (const t of transforms) {
      for (const index of [0, 6, 7, 20, 79]) {
        const view0 = queueSlotOffset(index, 0);
        const { dvx, dvy } = queueSlotOffset(index, t.rotation);
        vectorToViewVoxel(t, dvx, dvy, out);
        if (out.x !== view0.dvx || out.y !== view0.dvy) bad.push(`view ${t.rotation} slot ${index}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
