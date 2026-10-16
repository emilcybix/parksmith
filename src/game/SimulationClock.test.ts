import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from './config';
import { SimulationClock } from './SimulationClock';

const STEP = GAME_CONFIG.fixedStepMs;

const countingClock = (): { clock: SimulationClock; steps: number[] } => {
  const steps: number[] = [];
  const clock = new SimulationClock((stepMs) => steps.push(stepMs));
  return { clock, steps };
};

describe('simulation clock', () => {
  it('runs one fixed step per accumulated step length and reports the remainder as a fraction', () => {
    const { clock, steps } = countingClock();
    expect(clock.stepFraction).toBe(0);
    expect(clock.update(STEP * 0.4)).toBe(0);
    expect(clock.stepFraction).toBeCloseTo(0.4, 9);
    expect(clock.update(STEP * 2)).toBe(2);
    expect(steps).toEqual([STEP, STEP]);
    expect(clock.stepFraction).toBeCloseTo(0.4, 9);
    expect(clock.simulationTimeMs).toBe(STEP * 2);
    expect(clock.stepsLastFrame).toBe(2);
  });

  it('scales real time by the game speed and caps a single frame at 250 ms of real time', () => {
    const { clock, steps } = countingClock();
    clock.setSpeed(2);
    clock.update(STEP * 0.75);
    expect(steps).toHaveLength(1);
    expect(clock.stepFraction).toBeCloseTo(0.5, 9);
    clock.setSpeed(1);
    clock.update(10_000);
    // 250 ms of real time plus the half step already accumulated.
    expect(steps).toHaveLength(1 + Math.floor((250 + STEP * 0.5) / STEP));
  });

  it('keeps the fraction frozen while paused, so interpolated figures do not snap back', () => {
    const { clock, steps } = countingClock();
    clock.update(STEP * 1.6);
    expect(steps).toHaveLength(1);
    const fraction = clock.stepFraction;
    expect(fraction).toBeCloseTo(0.6, 9);
    clock.setSpeed(0);
    expect(clock.stepFraction).toBe(fraction);
    for (let frame = 0; frame < 30; frame += 1) expect(clock.update(16)).toBe(0);
    expect(steps).toHaveLength(1);
    expect(clock.stepFraction).toBe(fraction);
    expect(clock.stepsLastFrame).toBe(0);
  });

  it('continues the step in progress on resume instead of starting it over', () => {
    const { clock, steps } = countingClock();
    clock.update(STEP * 0.7);
    clock.setSpeed(0);
    clock.update(1_000);
    clock.setSpeed(1);
    expect(clock.update(STEP * 0.3)).toBe(1);
    expect(steps).toHaveLength(1);
    expect(clock.stepFraction).toBeCloseTo(0, 9);
  });

  it('drops the backlog after the catch-up limit, and reads 0 then', () => {
    const { clock, steps } = countingClock();
    clock.setSpeed(4);
    expect(clock.update(250)).toBe(GAME_CONFIG.maxCatchUpSteps);
    expect(steps).toHaveLength(GAME_CONFIG.maxCatchUpSteps);
    expect(clock.stepFraction).toBe(0);
    expect(clock.update(STEP * 0.1)).toBe(0);
    expect(clock.stepFraction).toBeCloseTo(0.4, 9);
  });

  it('never reports a whole step', () => {
    const { clock } = countingClock();
    for (const delta of [0, 1, 99.999, 100, 100.000_001, 199.9, 33.3, 16.7, 250, 7]) {
      clock.update(delta);
      expect(clock.stepFraction).toBeGreaterThanOrEqual(0);
      expect(clock.stepFraction).toBeLessThan(1);
    }
  });

  it('resetAccumulator drops the partial step in progress and nothing else', () => {
    const { clock, steps } = countingClock();
    clock.update(STEP * 1.7);
    expect(clock.stepFraction).toBeCloseTo(0.7, 9);
    clock.resetAccumulator();
    expect(clock.stepFraction).toBe(0);
    expect(clock.simulationTimeMs, 'the timeline already run is kept').toBe(STEP);
    expect(clock.update(STEP * 0.4), 'the next frame starts from zero, not from 0.7').toBe(0);
    expect(steps).toHaveLength(1);
  });
});
