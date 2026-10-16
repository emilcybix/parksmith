import type { CinematicView } from '../RendererPort';
import { pointFromView, vectorFromView, type ViewFrame, type ViewRotation } from '../viewRotation';

/**
 * Phase 41 step 3: the camera of a smooth view turn, pure. The isometric picture is the 2:1 projection
 * (x − y, (x + y) / 2 − z) in view voxels; an orthographic camera at 30° elevation and √2 texels per voxel reproduces
 * it exactly when z is drawn at √(2/3) (ISO_Z_SCALE). A narrow perspective camera far away comes within a texel of
 * that, so a turn starts and ends on (nearly) the isometric frame, yawing about the ground point at the middle of the
 * screen, and the renderer then snaps to the isometric view of the new rotation.
 */
export const ISO_Z_SCALE = Math.sqrt(2 / 3);
export const ISO_ELEVATION = Math.PI / 6;
export const TURN_FOV = (6 * Math.PI) / 180;
export const VIEW_TURN_MS = 420;
const TEXELS_PER_VOXEL = Math.SQRT2;
const TILE = 32;

/** The world azimuth (radians) of the direction from the screen's middle toward the isometric eye in a view. */
export const viewAzimuth = (rotation: ViewRotation): number => {
  const out = { x: 0, y: 0 };
  vectorFromView(rotation, 1, 1, out);
  return Math.atan2(out.y, out.x);
};

/** The ground point (world voxels, z 0) at the middle of a low-res target whose texel (0, 0) is `cameraTexel`. */
export const groundAtCentre = (
  frame: ViewFrame, cameraTexelX: number, cameraTexelY: number, lowWidth: number, lowHeight: number,
): [number, number] => {
  const texelX = cameraTexelX + lowWidth / 2;
  const texelY = cameraTexelY + lowHeight / 2;
  // Invert the view projection at z = 0: X = u − v, Y = (u + v) / 2.
  const u = texelY + texelX / 2;
  const v = texelY - texelX / 2;
  const world = { x: 0, y: 0 };
  pointFromView(frame, u / TILE, v / TILE, world);
  return [world.x * TILE, world.y * TILE];
};

/** The shorter way from `from` to `to` (radians), eased (smoothstep) at `t` in 0..1. */
export const turnAzimuth = (from: number, to: number, t: number): number => {
  let delta = to - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const c = Math.min(1, Math.max(0, t));
  return from + delta * c * c * (3 - 2 * c);
};

/** The near-isometric camera at `azimuth` round the ground point, framing `lowHeight` texels of picture. */
export const turnView = (target: readonly [number, number], azimuth: number, lowHeight: number, out: CinematicView): CinematicView => {
  const worldHeight = lowHeight / TEXELS_PER_VOXEL;
  const distance = worldHeight / 2 / Math.tan(TURN_FOV / 2);
  const flat = distance * Math.cos(ISO_ELEVATION);
  out.eye[0] = target[0] + flat * Math.cos(azimuth);
  out.eye[1] = target[1] + flat * Math.sin(azimuth);
  out.eye[2] = distance * Math.sin(ISO_ELEVATION);
  out.target[0] = target[0];
  out.target[1] = target[1];
  out.target[2] = 0;
  out.fovY = TURN_FOV;
  out.zScale = ISO_Z_SCALE;
  out.atmosphere = false;
  return out;
};
