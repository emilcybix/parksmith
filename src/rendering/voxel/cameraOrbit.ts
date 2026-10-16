/**
 * Phase 41 step 0: the spike's camera maths, pure. World voxels, z up. `orbitCamera` circles the map centre; `lowPass`
 * glides a few voxels above the ground along a straight line across the map. `viewProjection` writes a column-major
 * perspective x look-at matrix (WebGL's convention) into `out`.
 */
export interface CameraPose {
  eye: [number, number, number];
  target: [number, number, number];
}

export const orbitCamera = (mapWidthVoxels: number, mapHeightVoxels: number, seconds: number, out: CameraPose): CameraPose => {
  const cx = mapWidthVoxels / 2;
  const cy = mapHeightVoxels / 2;
  const radius = 0.85 * Math.max(mapWidthVoxels, mapHeightVoxels);
  const angle = seconds * 0.12;
  out.eye[0] = cx + radius * Math.cos(angle);
  out.eye[1] = cy + radius * Math.sin(angle);
  out.eye[2] = radius * 0.45;
  out.target[0] = cx;
  out.target[1] = cy;
  out.target[2] = 0;
  return out;
};

export const lowPassCamera = (mapWidthVoxels: number, mapHeightVoxels: number, seconds: number, out: CameraPose): CameraPose => {
  const t = (seconds * 0.04) % 1;
  out.eye[0] = mapWidthVoxels * (0.1 + 0.8 * t);
  out.eye[1] = mapHeightVoxels * (0.9 - 0.8 * t);
  out.eye[2] = 30;
  out.target[0] = out.eye[0] + 0.7 * mapWidthVoxels;
  out.target[1] = out.eye[1] - 0.7 * mapHeightVoxels;
  out.target[2] = 0;
  return out;
};

const normalise = (x: number, y: number, z: number): [number, number, number] => {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
};

export const viewProjection = (pose: CameraPose, aspect: number, fovYRadians: number, near: number, far: number, out: Float32Array): Float32Array => {
  const [ex, ey, ez] = pose.eye;
  const f = normalise(pose.target[0] - ex, pose.target[1] - ey, pose.target[2] - ez);
  // Right = forward x up (z up), then the true up = right x forward.
  const r = normalise(f[1] * 1 - f[2] * 0, f[2] * 0 - f[0] * 1, 0);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  // The view matrix (rows r, u, -f) and its translation.
  const view = [
    r[0], u[0], -f[0], 0,
    r[1], u[1], -f[1], 0,
    r[2], u[2], -f[2], 0,
    -(r[0] * ex + r[1] * ey + r[2] * ez), -(u[0] * ex + u[1] * ey + u[2] * ez), f[0] * ex + f[1] * ey + f[2] * ez, 1,
  ];
  const t = 1 / Math.tan(fovYRadians / 2);
  const projection = [
    t / aspect, 0, 0, 0,
    0, t, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += projection[k * 4 + row] * view[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
};
