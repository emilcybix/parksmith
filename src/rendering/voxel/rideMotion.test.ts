import { describe, expect, it } from 'vitest';
import type { RideStatus } from '../../game/rides/types';
import type { RideMotionState } from './contracts/rigid';
import {
  advanceRideMotion,
  createRideMotionState,
  RIDE_IDLE_MOTION,
  RIDE_MOTION_EASE_MS,
  RIDE_SPIN_PHASE_PER_OBJECT_MS,
  rideMotionTarget,
} from './rideMotion';

/**
 * A voxel ride must turn exactly like its classic twin: same spin-up, same idle tick-over, same
 * coast to a stop, same drop-tower progress — otherwise switching renderers visibly changes the
 * park. The reference below is WorldRenderer.syncRideMachinery's maths copied line for line
 * (legacy keeps a separate phase of id · 730 and hands `spin + phase` to the ride art), and the
 * voxel state is held to it frame by frame over seeded random status and frame-time sequences.
 */

const STATUSES: readonly RideStatus[] = ['idle', 'waiting', 'running', 'closed', 'broken', 'maintenance'];

interface LegacyRideDisplay {
  phase: number;
  motion: number;
  spin: number;
}

/** WorldRenderer.createObjectDisplay's ride display, reduced to its numbers. */
const legacyDisplay = (objectId: number): LegacyRideDisplay => ({ phase: objectId * 730, motion: 0, spin: 0 });

/** One WorldRenderer.syncRideMachinery step for one display; returns what `art.animate` gets. */
const legacyStep = (
  display: LegacyRideDisplay,
  status: RideStatus,
  deltaMs: number,
  cycleRemainingSeconds: number,
  duration: number,
): { spin: number; motion: number; progress: number } => {
  const target = status === 'running' ? 1 : status === 'idle' || status === 'waiting' ? 0.14 : 0;
  display.motion += (target - display.motion) * Math.min(1, deltaMs / 420);
  display.spin += deltaMs * display.motion;
  const progress = status === 'running' && duration > 0
    ? Math.min(1, Math.max(0, 1 - cycleRemainingSeconds / duration))
    : 0;
  return { spin: display.spin + display.phase, motion: display.motion, progress };
};

/** A deterministic stream of numbers in [0, 1), so failures reproduce. */
const randomStream = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

/** Frame times a real session produces: steady 60 Hz, jittery frames, stalls and tab switches. */
const frameTime = (random: () => number): number => {
  const roll = random();
  if (roll < 0.55) return 1000 / 60;
  if (roll < 0.85) return random() * 50;
  if (roll < 0.93) return 0;
  if (roll < 0.98) return 420 + random() * 600;
  return 5_000;
};

const advance = (
  state: RideMotionState,
  status: RideStatus,
  deltaMs: number,
  elapsedMs = 0,
  remaining = 0,
  duration = 0,
): RideMotionState => {
  advanceRideMotion(state, status, deltaMs, elapsedMs, remaining, duration);
  return state;
};

describe('ride motion', () => {
  it('starts a ride closed and at rest, its spin at the lockstep-breaking phase', () => {
    for (const objectId of [0, 1, 7, 66, 12_345]) {
      expect(createRideMotionState(objectId)).toEqual({
        spin: objectId * 730,
        motion: 0,
        progress: 0,
        elapsedMs: 0,
        status: 'closed',
      });
    }
    expect(RIDE_SPIN_PHASE_PER_OBJECT_MS).toBe(730);
  });

  it('eases toward 1 running, 0.14 idle or waiting and 0 otherwise', () => {
    expect(STATUSES.map(rideMotionTarget)).toEqual([0.14, 0.14, 1, 0, 0, 0]);
    expect(RIDE_IDLE_MOTION).toBe(0.14);
    for (const status of STATUSES) {
      const state = createRideMotionState(3);
      advance(state, 'running', 5_000);
      for (let frame = 0; frame < 600; frame += 1) advance(state, status, 1000 / 60);
      expect(state.motion, `motion after ten seconds ${status}`).toBeCloseTo(rideMotionTarget(status), 9);
      expect(state.status).toBe(status);
    }
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('reproduces the classic renderer frame for frame (seed %i)', (seed) => {
    const random = randomStream(seed * 7_919);
    const objectId = 1 + Math.floor(random() * 200);
    const state = createRideMotionState(objectId);
    const display = legacyDisplay(objectId);
    let status: RideStatus = 'closed';
    let elapsedMs = 0;
    for (let frame = 0; frame < 3_000; frame += 1) {
      // Rides hold a status for a while, as the simulation does, then switch.
      if (random() < 0.02) status = STATUSES[Math.floor(random() * STATUSES.length)];
      const deltaMs = frameTime(random);
      elapsedMs += deltaMs;
      const duration = random() < 0.1 ? 0 : 5 + random() * 40;
      const remaining = (random() * 1.4 - 0.2) * duration;
      const expected = legacyStep(display, status, deltaMs, remaining, duration);
      advanceRideMotion(state, status, deltaMs, elapsedMs, remaining, duration);
      expect(state.motion, `motion at frame ${frame}`).toBe(expected.motion);
      expect(state.progress, `progress at frame ${frame}`).toBe(expected.progress);
      // Legacy adds the phase at the end, the voxel state starts from it: same value, different
      // rounding order, so compare relative to the magnitude.
      expect(Math.abs(state.spin - expected.spin), `spin at frame ${frame}`)
        .toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(expected.spin)));
      expect(state.elapsedMs).toBe(elapsedMs);
      expect(state.status).toBe(status);
    }
  });

  it('coasts to a stop on closure and picks up from the same angle when it reopens', () => {
    const state = createRideMotionState(12);
    for (let frame = 0; frame < 180; frame += 1) advance(state, 'running', 1000 / 60);
    expect(state.motion).toBeGreaterThan(0.99);
    let previousMotion = state.motion;
    let previousStep = Number.POSITIVE_INFINITY;
    for (let frame = 0; frame < 240; frame += 1) {
      const before = state.spin;
      advance(state, 'closed', 1000 / 60);
      const step = state.spin - before;
      expect(state.motion, 'closure never speeds a ride up').toBeLessThan(previousMotion);
      expect(step, 'the spin increments shrink as the ride coasts').toBeLessThan(previousStep);
      expect(step).toBeGreaterThan(0);
      previousMotion = state.motion;
      previousStep = step;
    }
    const stoppedAt = state.spin;
    advance(state, 'running', 1000 / 60);
    expect(state.spin, 'reopening continues from the coasted angle').toBeGreaterThanOrEqual(stoppedAt);
    expect(state.spin - stoppedAt).toBeLessThan(1000 / 60);
  });

  it('never turns a ride that stayed closed', () => {
    const state = createRideMotionState(9);
    for (let frame = 0; frame < 100; frame += 1) advance(state, 'broken', 1000 / 60);
    expect(state.spin).toBe(9 * 730);
    expect(state.motion).toBe(0);
  });

  it('reaches the target in one frame after a stall of at least the ease time', () => {
    for (const status of STATUSES) {
      const state = advance(createRideMotionState(1), 'running', 100);
      advance(state, status, RIDE_MOTION_EASE_MS + 1);
      expect(state.motion, status).toBeCloseTo(rideMotionTarget(status), 12);
    }
  });

  it('reports cycle progress only while running, clamped to the cycle', () => {
    const cases: [RideStatus, number, number, number][] = [
      ['running', 30, 30, 0],
      ['running', 15, 30, 0.5],
      ['running', 0, 30, 1],
      ['running', 45, 30, 0],
      ['running', -3, 30, 1],
      ['running', 10, 0, 0],
      ['idle', 15, 30, 0],
      ['waiting', 15, 30, 0],
      ['broken', 15, 30, 0],
    ];
    for (const [status, remaining, duration, progress] of cases) {
      const state = advance(createRideMotionState(2), status, 16, 16, remaining, duration);
      expect(state.progress, `${status} with ${remaining} of ${duration} s left`).toBe(progress);
    }
  });

  it('keeps identical rides out of lockstep by exactly their phase', () => {
    const first = createRideMotionState(4);
    const second = createRideMotionState(5);
    for (let frame = 0; frame < 500; frame += 1) {
      const status: RideStatus = frame < 300 ? 'running' : 'idle';
      advance(first, status, 1000 / 60);
      advance(second, status, 1000 / 60);
    }
    expect(second.motion).toBe(first.motion);
    expect(second.spin - first.spin).toBeCloseTo(730, 6);
  });
});
