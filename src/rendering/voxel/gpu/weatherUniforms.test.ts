import { describe, expect, it } from 'vitest';
import { createWeatherView, type WeatherKind, type WeatherView } from '../../../game/weather/types';
import { WeatherLook, type WeatherEffects } from '../../weatherLook';
import { WEATHER_UNIFORM_FLOATS, WeatherUniformSync, writeWeatherUniforms, type WeatherUniformTarget } from './weatherUniforms';

const target = (): WeatherUniformTarget => ({
  uWxA: new Float32Array(4),
  uWxB: new Float32Array(4),
  uWxC: new Float32Array(4),
  uWxD: new Float32Array(4),
  uWxCloudTint: new Float32Array(3),
  uWxRainTint: new Float32Array(3),
});

const DAY = { day: 1, dusk: 0, night: 0 } as never;
const view = (kind: WeatherKind, intensity: number, seconds = 0): WeatherView => ({ ...createWeatherView(), kind, intensity, secondsIntoSegment: seconds, flashSeed: 11 });

/** Runs `frames` frames of 16 ms and counts the uniform writes the revision gate lets through. */
const writesOver = (look: WeatherLook, sync: WeatherUniformSync, t: WeatherUniformTarget, frames: number, build: (frame: number) => WeatherView, paused: boolean): number => {
  const before = sync.writes;
  for (let frame = 0; frame < frames; frame += 1) {
    const effects = look.update(build(frame), DAY, 16, paused);
    sync.sync(t, effects, effects.revision);
  }
  return sync.writes - before;
};

describe('weather uniforms: dirty tracking', () => {
  it('writes the 22 floats of the design exactly once for a calm sunny paused frame, then nothing', () => {
    expect(WEATHER_UNIFORM_FLOATS).toBe(22);
    const look = new WeatherLook({ reducedMotion: false });
    const sync = new WeatherUniformSync();
    const t = target();
    const first = writesOver(look, sync, t, 1, () => view('sunny', 0), true);
    expect(first, 'the first frame primes the uniforms').toBe(1);
    expect(writesOver(look, sync, t, 300, () => view('sunny', 0), true), 'a still clear sky writes nothing').toBe(0);
    expect(t.uWxA[0], 'inactive').toBe(0);
  });

  it('a paused storm that has settled writes nothing', () => {
    const look = new WeatherLook({ reducedMotion: false });
    const sync = new WeatherUniformSync();
    const t = target();
    writesOver(look, sync, t, 400, () => view('storm', 1), true);
    expect(writesOver(look, sync, t, 300, () => view('storm', 1, 5), true), 'frozen rain, clouds and flash').toBe(0);
    expect(t.uWxA[0], 'but active').toBe(1);
    expect(t.uWxD[0], 'no flash while paused').toBe(0);
  });

  it('a running storm writes only when a quantised value moves, far fewer times than frames', () => {
    const look = new WeatherLook({ reducedMotion: false });
    const sync = new WeatherUniformSync();
    const t = target();
    writesOver(look, sync, t, 400, () => view('rain', 1), false);
    const writes = writesOver(look, sync, t, 600, (frame) => view('rain', 1, frame * 0.016), false);
    expect(writes, 'whole-row rain steps and quarter-voxel clouds').toBeGreaterThan(0);
    expect(writes, 'never every frame at 60 fps for 10 s').toBeLessThan(600);
  });

  it('reduced motion running rain writes nothing once settled (static texture)', () => {
    const look = new WeatherLook({ reducedMotion: true });
    const sync = new WeatherUniformSync();
    const t = target();
    writesOver(look, sync, t, 400, () => view('storm', 1), false);
    expect(writesOver(look, sync, t, 300, (frame) => view('storm', 1, frame * 0.016), false)).toBe(0);
    expect(t.uWxD[0], 'no flash').toBe(0);
    expect(t.uWxD[2], 'no ripples').toBe(0);
    expect(t.uWxB[3], 'no shimmer').toBe(0);
  });

  it('weather turned off goes inactive with one last write, then nothing', () => {
    const look = new WeatherLook({ reducedMotion: false });
    const sync = new WeatherUniformSync();
    const t = target();
    writesOver(look, sync, t, 100, () => view('storm', 1), true);
    const off = (): WeatherView => ({ ...view('storm', 1), enabled: false });
    const writes = writesOver(look, sync, t, 4000, off, true);
    expect(writes, 'the fade-out steps (puddles dry over ~30 s), then still').toBeGreaterThan(0);
    expect(t.uWxA[0]).toBe(0);
    expect(writesOver(look, sync, t, 100, off, true)).toBe(0);
  });

  it('a revision bump writes every field once, and invalidate forces a rewrite (rebuilt pipeline)', () => {
    const look = new WeatherLook({ reducedMotion: false, pin: { kind: 'storm', intensity: 1 }, fixedClockSeconds: 7 });
    const effects = look.update(view('sunny', 0), DAY, 16, true) as WeatherEffects;
    const t = target();
    const sync = new WeatherUniformSync();
    expect(sync.sync(t, effects, effects.revision)).toBe(true);
    expect(sync.sync(t, effects, effects.revision)).toBe(false);
    sync.invalidate();
    expect(sync.sync(t, effects, effects.revision), 'after invalidate').toBe(true);
    const direct = target();
    writeWeatherUniforms(direct, effects);
    expect(Array.from(t.uWxA)).toEqual(Array.from(direct.uWxA));
    expect(t.uWxB[0], 'rain density is in uWxB.x').toBeCloseTo(effects.rainDensity, 6);
    expect(t.uWxRainTint[2], 'rain tint reaches the uniform').toBeCloseTo(effects.rainTint[2], 6);
  });
});
