import { describe, expect, it } from 'vitest';
import { ParkSession } from '../game/session/ParkSession';
import { hashState } from '../game/save/hash';
import { createStormFlash, stormFlashAt } from '../game/weather/flash';
import { createWeatherView } from '../game/weather/types';
import { createDayWeights, dayWeights } from './dayCycle';
import { MAX_FLASHES_PER_SECOND, WeatherLook } from './weatherLook';

const stepTicks = (s: ParkSession, n: number): void => { for (let i = 0; i < n; i += 1) s.step(100); };

describe('review: presentation never feeds back into the simulation', () => {
  it('reading the view, stormFlashAt and WeatherLook 1000x leaves the state hash identical', () => {
    const a = new ParkSession(null);
    const b = new ParkSession(null);
    stepTicks(a, 600);
    stepTicks(b, 600);
    const look = new WeatherLook();
    const view = createWeatherView();
    const flash = createStormFlash();
    const weights = dayWeights(createDayWeights(), 0.5);
    for (let i = 0; i < 1000; i += 1) {
      b.weatherViewInto(view, b.world.tick + (i % 10) / 10);
      b.weatherForecast();
      stormFlashAt(view.flashSeed || 77, i * 0.37, flash);
      look.update(view, weights, 16.7, false);
    }
    expect(hashState(b.serialize())).toBe(hashState(a.serialize()));
    stepTicks(a, 3000);
    stepTicks(b, 3000);
    expect(hashState(b.serialize())).toBe(hashState(a.serialize()));
  });
});

describe('review: photosensitivity cap on the effect output (real onsets, 0.05 crossings)', () => {
  // simPerRealSecond: sim seconds that pass per real second (game speed); fps: frames per real second.
  const worstWindow = (fps: number, simPerRealSecond: number, seed: number): { worst: number; maxStep: number } => {
    const look = new WeatherLook();
    const view = { ...createWeatherView(), kind: 'storm' as const, intensity: 1, enabled: true, flashSeed: seed };
    const weights = dayWeights(createDayWeights(), 0.9);
    const onsets: number[] = [];
    let prev = 0;
    let maxStep = 0;
    let sim = 0;
    for (let i = 0; i < fps * 300; i += 1) {
      sim += simPerRealSecond / fps;
      view.secondsIntoSegment = sim;
      const f = look.update(view, weights, 1000 / fps, false).flash;
      maxStep = Math.max(maxStep, Math.abs(f - prev));
      if (prev <= 0.05 && f > 0.05) onsets.push(i / fps);
      prev = f;
    }
    let worst = 0;
    for (let i = 0; i < onsets.length; i += 1) {
      let n = 0;
      for (let j = i; j < onsets.length && onsets[j] - onsets[i] <= 1; j += 1) n += 1;
      worst = Math.max(worst, n);
    }
    return { worst, maxStep };
  };

  it('at most 3 onsets per real second at 1x..16x and 30..144 fps, and the rise is rate limited', () => {
    for (const fps of [30, 60, 144]) {
      for (const speed of [1, 4, 16]) {
        for (const seed of [1, 99, 0xdeadbeef, 123456]) {
          const { worst, maxStep } = worstWindow(fps, speed, seed);
          expect(worst, `fps ${fps} speed ${speed} seed ${seed}`).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
          expect(maxStep, `fps ${fps}`).toBeLessThanOrEqual(12 / fps + 1 / 16 + 1e-9); // output is quantised to 1/16
        }
      }
    }
  });
});
