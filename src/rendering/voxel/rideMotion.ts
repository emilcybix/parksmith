import type { RideStatus } from '../../game/rides/types';
import type { RideMotionState } from './contracts/rigid';

/**
 * The legacy ride motion model (WorldRenderer.syncRideMachinery) as a pure, allocation-free step,
 * so a voxel ride turns exactly like its classic twin and part drivers (contracts/rigid.ts) read
 * the same numbers the classic ride art does:
 * - `motion` eases toward the target the status implies — 1 running, 0.14 idle or waiting (the
 *   machine ticks over while it loads), 0 closed, broken or in maintenance — by
 *   `(target − motion) · min(1, deltaMs / 420)` per frame, so machines spin up and coast down
 *   instead of snapping;
 * - `spin` accumulates motion-weighted wall-clock milliseconds, so a machine that coasted to a
 *   stop picks up from the same angle when it reopens;
 * - `progress` is the fraction of the current cycle while running (the drop tower's climb and
 *   fall), else 0.
 *
 * Like legacy it runs on the frame clock, not the simulation clock: it does not turn faster at 2×
 * or 4×. While the game is paused the scene passes a zero delta, so machinery stands still.
 */

/**
 * Legacy gives every ride display a phase of `objectId · 730` spin-ms and hands drivers
 * `spin + phase`, which keeps identical rides out of lockstep. The phase never changes, so it is
 * folded into the initial spin here and `state.spin` is the very value legacy passes to `animate`.
 */
export const RIDE_SPIN_PHASE_PER_OBJECT_MS = 730;

/** Time constant of the motion ease, in wall-clock milliseconds (legacy). */
export const RIDE_MOTION_EASE_MS = 420;

/** Motion of an open ride between cycles: the machinery ticks over while guests board. */
export const RIDE_IDLE_MOTION = 0.14;

/** The motion a ride eases toward in each status. */
export const rideMotionTarget = (status: RideStatus): number => {
  if (status === 'running') return 1;
  if (status === 'idle' || status === 'waiting') return RIDE_IDLE_MOTION;
  return 0;
};

/** A freshly placed ride: at rest, closed, spin at its lockstep-breaking phase. */
export const createRideMotionState = (objectId: number): RideMotionState => ({
  spin: objectId * RIDE_SPIN_PHASE_PER_OBJECT_MS,
  motion: 0,
  progress: 0,
  elapsedMs: 0,
  status: 'closed',
});

/**
 * Advances one frame in place. The caller passes what legacy reads: the ride runtime's status
 * (`'closed'` when the ride has no runtime), its `cycleRemainingSeconds` (0 without a runtime) and
 * `world.rideProfile(id).duration` (0 without a profile, which keeps progress at 0).
 */
export const advanceRideMotion = (
  state: RideMotionState,
  status: RideStatus,
  deltaMs: number,
  elapsedMs: number,
  cycleRemainingSeconds: number,
  durationSeconds: number,
): void => {
  const target = rideMotionTarget(status);
  state.motion += (target - state.motion) * Math.min(1, deltaMs / RIDE_MOTION_EASE_MS);
  state.spin += deltaMs * state.motion;
  state.progress = status === 'running' && durationSeconds > 0
    ? Math.min(1, Math.max(0, 1 - cycleRemainingSeconds / durationSeconds))
    : 0;
  state.elapsedMs = elapsedMs;
  state.status = status;
};
