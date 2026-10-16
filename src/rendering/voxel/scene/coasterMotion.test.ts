import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../../game/config';
import { ParkSession } from '../../../game/session/ParkSession';
import { seedDevPark } from '../../../game/session/devPark';
import { SimulationClock } from '../../../game/SimulationClock';
import type { GameSpeed } from '../../../game/types';
import { coasterHeadIndex, coasterInterpolatedRemaining } from '../../coasterTrain';
import type { CoasterTimingRecord } from '../../coasterTrain';
import { createCoasterCarPoses, placeCoasterCars } from './coasterCars';

/**
 * The train used to be placed from `cycleRemainingSeconds`, which only changes at the 10 Hz
 * simulation step, so it jumped ten times a second while everything else glided. These drive the
 * real SimulationClock with 60 fps frames and a ride that counts its cycle down one step at a time,
 * exactly as RideSimulation does, and watch the lead car.
 */
const devParkCoaster = (): CoasterTimingRecord => {
  const session = new ParkSession(null);
  seedDevPark(session);
  const [record] = session.world.coasters.values();
  if (!record) throw new Error('the dev park lost its coaster');
  return record;
};

const STEP_SECONDS = GAME_CONFIG.fixedStepMs / 1000;
const FRAME_MS = 1000 / 60;
const LOAD = GAME_CONFIG.coaster.stationLoadSeconds;

interface Frame {
  /** Unwrapped fractional piece index of the lead car (a full lap on once the cycle is over). */
  head: number;
  /** Lead car world position. */
  position: [number, number, number];
  /** Where the continuous (never quantised) simulation time puts it, to compare against. */
  ideal: number;
  running: boolean;
}

/** One ride cycle at `speed`, a frame at a time; `interpolate` false is the old 10 Hz behaviour. */
const runCycle = (record: CoasterTimingRecord, speed: GameSpeed, interpolate: boolean): Frame[] => {
  const duration = record.stats.durationSeconds;
  const poses = createCoasterCarPoses(1);
  let remaining = duration;
  let running = true;
  const clock = new SimulationClock(() => {
    if (!running) return;
    remaining = Math.max(0, remaining - STEP_SECONDS);
    if (remaining <= 1e-6) running = false;
  });
  clock.setSpeed(speed);
  const frames: Frame[] = [];
  const frameCount = Math.ceil((duration * 1000) / (FRAME_MS * speed)) + 10;
  for (let frame = 0; frame < frameCount; frame += 1) {
    clock.update(FRAME_MS);
    const shown = running
      ? interpolate ? coasterInterpolatedRemaining(remaining, duration, clock.stepFraction) : remaining
      : null;
    const head = coasterHeadIndex(record, shown);
    placeCoasterCars(record, head, 1, poses);
    frames.push({
      // Parked after the cycle is the same spot as a finished lap: count it as the lap's end.
      head: running ? head : head + record.pieces.length,
      position: [poses.data[0], poses.data[1], poses.data[2]],
      ideal: Math.min(duration, Math.max(0, duration - (clock.simulationTimeMs + clock.stepFraction * GAME_CONFIG.fixedStepMs) / 1000)),
      running,
    });
  }
  return frames;
};

const displacements = (frames: Frame[]): number[] => {
  const moves: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (!frames[index].running || !frames[index - 1].running) continue;
    const a = frames[index - 1].position;
    const b = frames[index].position;
    moves.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return moves;
};

describe('coaster train motion between simulation steps', () => {
  it.each([1, 2, 4] as const)('glides every frame at %ix, matching continuous simulation time', (speed) => {
    const record = devParkCoaster();
    const frames = runCycle(record, speed, true);
    // The shown remaining time is the continuous one, to the float.
    const duration = record.stats.durationSeconds;
    let checked = 0;
    for (const frame of frames) {
      if (!frame.running) continue;
      expect(frame.head, `at ideal ${frame.ideal}`).toBeCloseTo(coasterHeadIndex(record, frame.ideal), 6);
      checked += 1;
    }
    expect(checked, 'frames while running').toBeGreaterThan((duration * 60) / speed - 20);
    // Never backwards, whatever happens at step boundaries.
    for (let index = 1; index < frames.length; index += 1) {
      expect(frames[index].head, `frame ${index}`).toBeGreaterThanOrEqual(frames[index - 1].head - 1e-9);
    }
  });

  it('moves a little every frame once rolling, where the 10 Hz train stood still between steps', () => {
    const record = devParkCoaster();
    const moving = (frames: Frame[]): number[] => {
      const moves = displacements(frames);
      // After the station load and before the last piece: the train is rolling.
      return moves.slice(Math.ceil(((LOAD + 1) * 1000) / FRAME_MS), moves.length - 60);
    };
    const smooth = moving(runCycle(record, 1, true));
    const old = moving(runCycle(record, 1, false));
    expect(Math.min(...smooth), 'no frame stands still').toBeGreaterThan(0);
    expect(old.filter((move) => move === 0).length / old.length, 'the old train stood still on most frames').toBeGreaterThan(0.3);
    // Frame to frame the speed changes only where the physics changes it: neighbouring frames
    // never differ by more than the lift-to-drop speed ratio the profile has, and the shown
    // displacement tracks the true one (no 10 Hz beat: the spread is not a step-sized spike).
    for (let index = 1; index < smooth.length; index += 1) {
      const ratio = smooth[index] / smooth[index - 1];
      expect(ratio, `frame ${index}`).toBeGreaterThan(0.5);
      expect(ratio, `frame ${index}`).toBeLessThan(2);
    }
    expect(Math.max(...old) / Math.max(...smooth), 'the old train jumped several frames of travel at once').toBeGreaterThan(3);
  });

  it('does not jump when the cycle starts or ends', () => {
    const record = devParkCoaster();
    const frames = runCycle(record, 1, true);
    const parked = frames[0].position;
    for (const frame of frames.slice(0, Math.floor((LOAD * 1000) / FRAME_MS) - 2)) {
      expect(frame.position, 'parked through the load').toEqual(parked);
    }
    const last = frames.findIndex((frame) => !frame.running);
    expect(last, 'the cycle ends').toBeGreaterThan(0);
    const before = frames[last - 1].position;
    const after = frames[last].position;
    expect(Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]), 'the wrap to parked is one frame of travel')
      .toBeLessThan(3);
  });

  it('freezes while paused and ignores a fraction outside a step', () => {
    const record = devParkCoaster();
    const duration = record.stats.durationSeconds;
    const clock = new SimulationClock(() => undefined);
    clock.update(40);
    clock.setSpeed(0);
    const held = clock.stepFraction;
    clock.update(500);
    expect(coasterInterpolatedRemaining(10, duration, clock.stepFraction), 'paused: same fraction, same train')
      .toBe(coasterInterpolatedRemaining(10, duration, held));
    expect(coasterInterpolatedRemaining(10, duration, -1), 'negative fraction').toBe(10);
    expect(coasterInterpolatedRemaining(10, duration, 7), 'one step at most').toBeCloseTo(10 - STEP_SECONDS, 9);
    expect(coasterInterpolatedRemaining(0.02, duration, 0.9), 'never below zero').toBe(0);
    expect(coasterInterpolatedRemaining(duration + 1, duration, 0.5), 'never above the cycle').toBe(duration);
  });

  it('clamps at both ends of the cycle: a nearly-finished train at 0 and a fresh one never above the duration', () => {
    const duration = devParkCoaster().stats.durationSeconds;
    expect(STEP_SECONDS * 0.9, 'the case is a real overshoot').toBeGreaterThan(0.01);
    expect(coasterInterpolatedRemaining(0.01, duration, 0.9), 'remaining 0.01, fraction 0.9: 0, not negative').toBe(0);
    expect(coasterInterpolatedRemaining(duration, duration, 0), 'a train at the very start, fraction 0').toBe(duration);
    expect(coasterInterpolatedRemaining(duration, duration, 1), 'fraction 1: a step along, still within the cycle')
      .toBeCloseTo(duration - STEP_SECONDS, 9);
    for (const fraction of [0, 0.25, 1]) {
      const shown = coasterInterpolatedRemaining(duration, duration, fraction);
      expect(shown, `fraction ${fraction}`).toBeLessThanOrEqual(duration);
      expect(shown, `fraction ${fraction}`).toBeGreaterThanOrEqual(0);
    }
  });
});
