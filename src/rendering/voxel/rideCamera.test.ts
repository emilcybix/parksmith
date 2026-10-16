import { describe, expect, it } from 'vitest';
import type { CinematicView } from '../RendererPort';
import { RIDER_EYE_VOXELS, flatRideView, trainRideView } from './rideCamera';

const view = (): CinematicView => ({ eye: [0, 0, 0], target: [0, 0, 0], fovY: 0 });

describe('Phase 41 step 4: ride-along cameras', () => {
  it('sits at the eyes of a rider above the lead car and looks along its heading', () => {
    // A car at (100, 200, 30) heading +y: a quarter turn about +z.
    const s = Math.SQRT1_2;
    const camera = trainRideView([100, 200, 30, 0, 0, s, s], 1.2, view());
    expect(camera.eye[2]).toBeCloseTo(30 + RIDER_EYE_VOXELS, 6);
    expect(camera.target[1] - camera.eye[1]).toBeGreaterThan(50);
    expect(Math.abs(camera.target[0] - camera.eye[0])).toBeLessThan(1e-6);
    expect(camera.target[2]).toBeLessThan(camera.eye[2]);
  });

  it('circles a flat ride at a constant radius', () => {
    const a = flatRideView(500, 500, 96, 0, 1, view());
    const b = flatRideView(500, 500, 96, 4, 1, view());
    expect(Math.hypot(a.eye[0] - 500, a.eye[1] - 500)).toBeCloseTo(96, 6);
    expect(Math.hypot(b.eye[0] - 500, b.eye[1] - 500)).toBeCloseTo(96, 6);
    expect(a.eye[0]).not.toBe(b.eye[0]);
  });
});
