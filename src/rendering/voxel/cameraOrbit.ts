/**
 * Phase 41 step 0: the spike's camera maths, pure. World voxels, z up. `orbitCamera` circles the map centre; `lowPass`
 * glides a few voxels above the ground along a straight line across the map. `viewProjection` writes a column-major
 * perspective x look-at matrix (WebGL's convention) into `out`.
 */
export interface CameraPose {
  eye: [number, number, number];
  target: [number, number, number];
}

/** Phase 41: what the GPU draws a cinematic frame from (RendererPort's type). */
export type { CinematicView } from '../RendererPort';

/**
 * Phase 41: the horizon's row as a fraction of the picture from the top: where a level line of sight lands for this
 * pose and field of view (0.5 when looking level; above the middle when looking down). May lie outside 0..1.
 */
export const horizonRow = (pose: CameraPose, fovY: number): number => {
  const fx = pose.target[0] - pose.eye[0];
  const fy = pose.target[1] - pose.eye[1];
  const fz = pose.target[2] - pose.eye[2];
  const down = Math.atan2(-fz, Math.hypot(fx, fy) || 1e-6);
  return 0.5 - (0.5 * Math.tan(down)) / Math.tan(fovY / 2);
};

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

/**
 * Near and far planes of a perspective camera over a map `size` voxels across: the near plane just short of the nearest
 * the map can come (two map sizes nearer than the target), never under 2 voxels. A far camera (a view turn frames the
 * isometric picture from thousands of voxels away) with the near plane at 2 had too little depth precision to keep the
 * soil 1 voxel under the grass from showing through it in stripes.
 */
export const perspectiveDepthPlanes = (pose: CameraPose, size: number): { near: number; far: number } => {
  const distance = Math.hypot(pose.eye[0] - pose.target[0], pose.eye[1] - pose.target[1], pose.eye[2] - pose.target[2]);
  return { near: Math.max(2, distance - 2 * size), far: distance + 12 * size };
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

/** The inverse of a column-major 4 × 4 matrix into `out` (identity if it is singular): the cinematic light pass's unprojection. */
export const invertMatrix4 = (m: Float32Array, out: Float32Array): Float32Array => {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0 || !Number.isFinite(det)) {
    out.fill(0);
    out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1;
    return out;
  }
  const inv = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * inv;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * inv;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * inv;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * inv;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * inv;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * inv;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * inv;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * inv;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * inv;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * inv;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * inv;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * inv;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * inv;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * inv;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * inv;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * inv;
  return out;
};
