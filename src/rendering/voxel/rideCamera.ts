import type { CinematicView } from '../RendererPort';

/**
 * Phase 41 step 4: the ride-along cameras, pure. World voxels, z up.
 * - `trainRideView`: in the lead car, at a rider's eyes, looking down the track. The car pose is the train's own
 *   interpolated pivot (x, y, z) and unit quaternion (x, y, z, w), the 7 floats coasterCars.ts writes per car; car
 *   space is +x forward, +z up from the rail. A loop's upside-down stretch keeps the world's up (no roll yet).
 * - `flatRideView`: a slow, close circle round a flat ride's middle at about head height of its riders.
 */
export const RIDER_EYE_VOXELS = 10;
const LOOK_AHEAD = 64;

const rotate = (qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number): [number, number, number] => {
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
};

export const trainRideView = (pose: ArrayLike<number>, fovY: number, out: CinematicView): CinematicView => {
  const [qx, qy, qz, qw] = [pose[3], pose[4], pose[5], pose[6]];
  const forward = rotate(qx, qy, qz, qw, 1, 0, 0);
  const up = rotate(qx, qy, qz, qw, 0, 0, 1);
  for (let axis = 0; axis < 3; axis += 1) {
    out.eye[axis] = pose[axis] + up[axis] * RIDER_EYE_VOXELS + forward[axis] * 2;
    out.target[axis] = out.eye[axis] + forward[axis] * LOOK_AHEAD - up[axis] * 8;
  }
  out.fovY = fovY;
  out.zScale = 1;
  out.atmosphere = true;
  return out;
};

export const flatRideView = (centreX: number, centreY: number, radius: number, seconds: number, fovY: number, out: CinematicView): CinematicView => {
  const angle = seconds * 0.35;
  out.eye[0] = centreX + radius * Math.cos(angle);
  out.eye[1] = centreY + radius * Math.sin(angle);
  out.eye[2] = 34;
  out.target[0] = centreX;
  out.target[1] = centreY;
  out.target[2] = 20;
  out.fovY = fovY;
  out.zScale = 1;
  out.atmosphere = true;
  return out;
};
