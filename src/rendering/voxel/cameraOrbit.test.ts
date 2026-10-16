import { describe, expect, it } from 'vitest';
import { lowPassCamera, orbitCamera, viewProjection, type CameraPose } from './cameraOrbit';
import { perspectiveWorldShaderSource } from './gpu/shaders/perspective';
import { worldShaderSource } from './gpu/shaders/world';

/** Phase 41 step 0: the spike camera's maths (pure) and its shader's shape. */
const project = (m: Float32Array, p: [number, number, number]): [number, number, number] => {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w];
};

describe('Phase 41 spike: camera maths', () => {
  const pose = (): CameraPose => ({ eye: [0, 0, 0], target: [0, 0, 0] });

  it('the target lands in the middle of the picture, and up is up', () => {
    const camera = orbitCamera(1024, 1024, 3, pose());
    const matrix = viewProjection(camera, 16 / 10, Math.PI / 3.6, 4, 8192, new Float32Array(16));
    const centre = project(matrix, camera.target);
    expect(centre[0]).toBeCloseTo(0, 5);
    expect(centre[1]).toBeCloseTo(0, 5);
    expect(centre[2]).toBeGreaterThan(-1);
    expect(centre[2]).toBeLessThan(1);
    const above = project(matrix, [camera.target[0], camera.target[1], 200]);
    expect(above[1], 'a point above the target is higher on screen').toBeGreaterThan(centre[1]);
  });

  it('the orbit keeps its distance and height and goes round the map centre', () => {
    const a = orbitCamera(1024, 2048, 0, pose());
    const b = orbitCamera(1024, 2048, 10, pose());
    const radius = (camera: CameraPose) => Math.hypot(camera.eye[0] - 512, camera.eye[1] - 1024);
    expect(radius(a)).toBeCloseTo(radius(b), 6);
    expect(a.eye[2]).toBe(b.eye[2]);
    expect(a.eye[0]).not.toBe(b.eye[0]);
  });

  it('the low pass stays low over the map', () => {
    for (const seconds of [0, 5, 12.5, 24]) {
      const camera = lowPassCamera(1024, 1024, seconds, pose());
      expect(camera.eye[2]).toBe(30);
      expect(camera.eye[0]).toBeGreaterThanOrEqual(0);
      expect(camera.eye[0]).toBeLessThanOrEqual(1024);
    }
  });

  it('the spike program reuses the isometric opaque fragment shader as it is', () => {
    const source = perspectiveWorldShaderSource();
    expect(source.vertex).toContain('uniform mat4 uViewProj;');
    expect(source.vertex).toContain('gl_Position.y = -gl_Position.y;');
    expect(source.fragment).toBe(worldShaderSource('opaque', false).fragment);
  });
});
