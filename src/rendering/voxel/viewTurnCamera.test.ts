import { describe, expect, it } from 'vitest';
import { ISO_Z_SCALE, groundAtCentre, turnAzimuth, turnView, viewAzimuth } from './viewTurnCamera';
import { perspectiveDepthPlanes, viewProjection } from './cameraOrbit';
import { perspectiveCompositeShaderSource } from './gpu/shaders/perspective';
import type { CinematicView } from '../RendererPort';
import { projectX, projectY } from './contracts/space';

/** Phase 41 step 3: the turn camera lands on the isometric picture. */
const project = (m: Float32Array, p: [number, number, number]): [number, number] => {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w];
};

describe('Phase 41 step 3: smooth view turns', () => {
  it('view 0 looks from +x +y, and each view turns the eye a quarter round', () => {
    expect(viewAzimuth(0)).toBeCloseTo(Math.PI / 4, 9);
    const steps = [0, 1, 2, 3].map((q) => viewAzimuth(q as 0 | 1 | 2 | 3));
    for (let q = 1; q < 4; q += 1) {
      let delta = Math.abs(steps[q] - steps[q - 1]);
      if (delta > Math.PI) delta = 2 * Math.PI - delta;
      expect(delta).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it('the turn camera draws within a texel of the isometric projection near the middle', () => {
    const lowWidth = 640;
    const lowHeight = 400;
    const view: CinematicView = { eye: [0, 0, 0], target: [0, 0, 0], fovY: 0 };
    const target: [number, number] = [512, 512];
    turnView(target, viewAzimuth(0), lowHeight, view);
    const m = viewProjection(view, lowWidth / lowHeight, view.fovY, 2, 1e6, new Float32Array(16));
    for (const [dx, dy, dz] of [[40, 0, 0], [0, 40, 0], [0, 0, 40], [-30, 20, 10]]) {
      const ndc = project(m, [target[0] + dx, target[1] + dy, dz * ISO_Z_SCALE]);
      // The shader flips x (the isometric handedness).
      const texelX = -ndc[0] * lowWidth / 2;
      const texelY = -ndc[1] * lowHeight / 2;
      expect(texelX).toBeCloseTo(projectX(dx, dy), -0.4);
      expect(texelY).toBeCloseTo(projectY(dx, dy, dz), -0.4);
    }
  });

  it('the ground at the middle round-trips the isometric projection, and the yaw goes the short way', () => {
    const frame = { rotation: 0 as const, width: 32, height: 32 };
    const [x, y] = groundAtCentre(frame, projectX(300, 200) - 320, projectY(300, 200, 0) - 200, 640, 400);
    expect(x).toBeCloseTo(300, 6);
    expect(y).toBeCloseTo(200, 6);
    expect(turnAzimuth(3, -3, 1)).toBeCloseTo(-3 + 2 * Math.PI, 9);
    expect(turnAzimuth(0, 1, 0)).toBe(0);
    expect(turnAzimuth(0, 1, 0.5)).toBeCloseTo(0.5, 9);
  });

  it('a turn keeps the isometric framing: no skirt over the map edge, no sky, outlines on (owner report 2026-10-19)', () => {
    const view: CinematicView = { eye: [0, 0, 0], target: [0, 0, 0], fovY: 0 };
    turnView([1024, 1024], viewAzimuth(1), 400, view);
    expect(view.skirt).toBe(false);
    expect(view.atmosphere).toBe(false);
    // The composite takes the isometric background and a silhouette outline when there is no atmosphere.
    const fragment = perspectiveCompositeShaderSource().fragment;
    expect(fragment).toContain('uniform float uIsoFrame;');
    expect(fragment).toContain('vxTurnOutline(texel, depth)');
    expect(fragment).toContain('vxBackground()');
  });

  it('a far turn camera keeps the depth precision to hold the soil 1 voxel under the grass', () => {
    const view: CinematicView = { eye: [0, 0, 0], target: [0, 0, 0], fovY: 0 };
    const size = 64 * 32;
    turnView([size / 2, size / 2], viewAzimuth(0), 1600, view);
    const { near, far } = perspectiveDepthPlanes(view, size);
    const distance = Math.hypot(view.eye[0] - size / 2, view.eye[1] - size / 2, view.eye[2]);
    // The whole map stays inside the planes...
    expect(near).toBeLessThanOrEqual(distance - Math.SQRT2 * size);
    expect(far).toBeGreaterThan(distance + Math.SQRT2 * size);
    // ...and one step of a 24-bit depth buffer at the target is far under a voxel (it was about one at near = 2).
    const step = (distance * distance) / (near * 2 ** 24);
    expect(step).toBeLessThan(0.05);
    // A close camera (the ride-along) keeps the 2-voxel near plane.
    expect(perspectiveDepthPlanes({ eye: [10, 10, 10], target: [0, 0, 0] }, size).near).toBe(2);
  });
});
