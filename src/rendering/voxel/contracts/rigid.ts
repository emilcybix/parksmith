import type { RideStatus } from '../../../game/rides/types';

/**
 * Moving ride parts and coaster cars are rigid: a compiled part's boxes never change, only one
 * transform per part does (contracts/boxes.ts, transform layout).
 *
 * Composition, for an object placed at world voxel origin O (= 32 · anchor) with visual quarter
 * turn q (space.ts). A driver always poses its part in UNROTATED model space and never needs to
 * know the rotation; which formula applies depends on where the part's boxes come from:
 * - Parts of a model already turned by rotateModel / ModelCache.model(bp, q) — the normal case —
 *   carry a turned pivot and turned pivot-relative boxes, so (scene/rigid.ts
 *   writeRotatedPartTransform):
 *     world pivot       = O + rotatedPivot + R_q · pose.offset
 *     world orientation = q_q ⊗ pose.rotation ⊗ q_q⁻¹
 * - Parts in the unrotated model frame (scene/rigid.ts writePartTransform):
 *     world pivot       = O + R_q · (pivot + pose.offset)       (R_q rotates inside the footprint)
 *     world orientation = q_q ⊗ pose.rotation
 * Both land every voxel in the same place (tested). Rest pose (closed ride, ghost preview) is
 * offset 0 and the identity rotation. Every allocated slot must be written (a rest pose is enough)
 * before a box that references it is drawn: an all-zero record is not a valid quaternion.
 */

export interface RideMotionState {
  /** Motion-weighted milliseconds: only advances while the machine turns. */
  spin: number;
  /** Smoothed 0..1 so spin-up and spin-down are gradual. */
  motion: number;
  /** 0..1 through the current ride cycle while running, else 0. */
  progress: number;
  elapsedMs: number;
  status: RideStatus;
}

/** A part pose in model space. The driver writes into it; nothing is allocated per frame. */
export interface PartPose {
  dx: number;
  dy: number;
  dz: number;
  /** Unit quaternion. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export type PartDriver = (motion: Readonly<RideMotionState>, out: PartPose) => void;

export const restPose = (out: PartPose): void => {
  out.dx = 0;
  out.dy = 0;
  out.dz = 0;
  out.qx = 0;
  out.qy = 0;
  out.qz = 0;
  out.qw = 1;
};

/** Transform slot keys: blueprint parts by part index, coaster cars by 1000 + car index. */
export const coasterCarSlotKey = (carIndex: number): number => 1000 + carIndex;
/** A car's riders (a separate rigid part, posed with the car or collapsed): 1100 + car index. */
export const coasterRiderSlotKey = (carIndex: number): number => 1100 + carIndex;
/**
 * One half of the coupling behind car `carIndex` (between it and the next car): half 0 hangs on car
 * `carIndex`'s rear hitch, half 1 on the next car's front hitch; 1200 + 2 · car index + half (a train
 * of up to 50 cars stays below 1300).
 */
export const coasterCouplingSlotKey = (carIndex: number, half = 0): number => 1200 + 2 * carIndex + half;

/**
 * The one documented exception to "every slot holds a valid unit quaternion": the pose of a rigid
 * part that is switched off without a rebuild (coaster riders on a parked train). With w = 0 and
 * |q|² = ½ the shader's vxQuatRotate maps every local point v to ((vx + vy) / 2, (vx + vy) / 2, 0),
 * which lies on the world line along (1, 1, 0); vxProject sends that line to ONE vertical screen
 * line (x = wx − wy = 0 for every point), so every quad has zero area and no fragment, outline or
 * shadow is drawn. Pair it with a pivot on whole voxels (integer corners keep that exact in
 * float32): `scene/coasterCars.ts` rounds the car's pivot.
 */
export const COLLAPSED_PART_QUATERNION: readonly [number, number, number, number] = [0.5, 0.5, 0, 0];
