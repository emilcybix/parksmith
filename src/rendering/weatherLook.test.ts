import { describe, expect, it } from 'vitest';
import { WEATHER_KINDS, createWeatherView, type WeatherKind, type WeatherView } from '../game/weather/types';
import { createDayWeights, dayWeights, type DayWeights } from './dayCycle';
import {
  CLOUD_WRAP_VOXELS,
  FlashLimiter,
  MAX_FLASHES_PER_SECOND,
  RAIN_WRAP_ROWS,
  WEATHER_DRIVER_TABLE,
  WeatherLook,
  applyReducedMotion,
  createWeatherDrivers,
  createWeatherEffects,
  parseWeatherFlags,
  slewDrivers,
  weatherEffectsFrom,
  weatherTargetDrivers,
  type WeatherDrivers,
  type WeatherEffects,
} from './weatherLook';

const NOON: DayWeights = { day: 1, dusk: 0, night: 0 };
const NIGHT: DayWeights = { day: 0, dusk: 0, night: 1 };
const todWeights = (fraction: number): DayWeights => ({ ...dayWeights(createDayWeights(), fraction) });
const view = (kind: WeatherKind, intensity: number, extra: Partial<WeatherView> = {}): WeatherView =>
  ({ ...createWeatherView(), kind, intensity, flashSeed: kind === 'storm' ? 12345 : 0, ...extra });
const DRIVER_KEYS = Object.keys(createWeatherDrivers()) as (keyof WeatherDrivers)[];
const targetOf = (kind: WeatherKind, intensity: number, enabled = true) =>
  ({ ...weatherTargetDrivers(enabled, kind, intensity, createWeatherDrivers()) });
const effectsOf = (drivers: WeatherDrivers, weights: DayWeights): WeatherEffects =>
  weatherEffectsFrom(drivers, weights, createWeatherEffects());
const settle = (look: WeatherLook, v: WeatherView, weights: DayWeights, seconds = 30, paused = false) => {
  for (let i = 0; i < seconds * 60; i += 1) look.update(v, weights, 1000 / 60, paused);
};

describe('target drivers', () => {
  it('are exactly zero at intensity 0 or when disabled, and match the table at 1', () => {
    for (const kind of WEATHER_KINDS) {
      expect(targetOf(kind, 0)).toEqual(createWeatherDrivers());
      expect(targetOf(kind, 1, false)).toEqual(createWeatherDrivers());
      expect(targetOf(kind, Number.NaN)).toEqual(createWeatherDrivers());
      expect(targetOf(kind, 1)).toEqual(WEATHER_DRIVER_TABLE[kind]);
      expect(targetOf(kind, 7)).toEqual(WEATHER_DRIVER_TABLE[kind]);
    }
  });

  it('are monotone in intensity for every kind and driver', () => {
    for (const kind of WEATHER_KINDS) {
      let previous = targetOf(kind, 0);
      for (let i = 1; i <= 100; i += 1) {
        const next = targetOf(kind, i / 100);
        for (const key of DRIVER_KEYS) expect(next[key], `${kind}.${key}@${i}`).toBeGreaterThanOrEqual(previous[key]);
        previous = next;
      }
    }
  });
});

describe('slew', () => {
  it('reaches the target exactly in finite time without overshoot, and wet dries slower than it wets', () => {
    const drivers = createWeatherDrivers();
    const storm = targetOf('storm', 1);
    let frames = 0;
    while (slewDrivers(drivers, storm, 1 / 60)) {
      frames += 1;
      for (const key of DRIVER_KEYS) expect(drivers[key]).toBeLessThanOrEqual(storm[key]);
      expect(frames).toBeLessThan(10_000);
    }
    expect(drivers).toEqual(storm);
    const wetFrames = frames;
    const clear = createWeatherDrivers();
    frames = 0;
    while (slewDrivers(drivers, clear, 1 / 60)) frames += 1;
    expect(drivers).toEqual(clear);
    expect(frames).toBeGreaterThan(wetFrames);
    expect(slewDrivers(drivers, clear, 1 / 60)).toBe(false);
  });

  it('clamps a huge dt so a hidden tab never jumps', () => {
    const drivers = createWeatherDrivers();
    slewDrivers(drivers, targetOf('storm', 1), 60);
    expect(drivers.cover).toBeCloseTo(0.025, 12);
  });
});

describe('effects mapping', () => {
  it('is the identity at a clear sky for every time of day', () => {
    for (let i = 0; i <= 200; i += 1) {
      const effects = effectsOf(createWeatherDrivers(), todWeights(i / 200));
      expect(effects.active).toBe(false);
      expect(effects.modifiers).toEqual({ exposureScale: 1, saturationScale: 1, ambientScale: 1, tintMul: [1, 1, 1] });
      expect(effects.cloudStrength).toBe(0);
      expect(effects.cloudTint).toEqual([1, 1, 1]);
      expect(effects.rainDensity).toBe(0);
      expect(effects.wetness).toBe(0);
      expect(effects.shimmer).toBe(0);
      expect(effects.gloom).toBe(0);
    }
  });

  it('lifts saturation under gloom so the dimmed park keeps its chroma (never below 1)', () => {
    for (const kind of WEATHER_KINDS) {
      for (let i = 0; i < 100; i += 1) {
        const e = effectsOf(targetOf(kind, 1), todWeights(i / 100));
        expect(e.modifiers.saturationScale).toBeGreaterThanOrEqual(1);
        expect(e.modifiers.saturationScale).toBeLessThanOrEqual(1.12);
      }
    }
  });

  it('keeps the colourful floors for every kind, intensity and time of day', () => {
    for (const kind of WEATHER_KINDS) {
      for (const intensity of [0.2, 0.5, 0.8, 1]) {
        for (let i = 0; i < 200; i += 1) {
          const e = effectsOf(targetOf(kind, intensity), todWeights(i / 200));
          expect(e.modifiers.exposureScale).toBeGreaterThanOrEqual(0.86);
          expect(e.modifiers.saturationScale).toBeGreaterThanOrEqual(0.96);
          for (const c of e.modifiers.tintMul) expect(c).toBeGreaterThanOrEqual(0.92);
          for (const c of e.cloudTint) expect(c).toBeGreaterThanOrEqual(0.78);
          expect(e.cloudStrength).toBeLessThanOrEqual(0.4);
        }
      }
    }
  });

  it('is monotone in intensity at a fixed time of day', () => {
    for (const kind of WEATHER_KINDS) {
      let previous = effectsOf(targetOf(kind, 0), NOON);
      for (let i = 1; i <= 50; i += 1) {
        const next = effectsOf(targetOf(kind, i / 50), NOON);
        for (const key of ['cloudCover', 'cloudStrength', 'rainDensity', 'wetness', 'puddle', 'ripple', 'shimmer', 'gloom'] as const) {
          expect(next[key], `${kind}.${key}`).toBeGreaterThanOrEqual(previous[key]);
        }
        expect(next.modifiers.exposureScale).toBeLessThanOrEqual(kind === 'hot' ? 2 : previous.modifiers.exposureScale);
        previous = next;
      }
    }
  });

  it('is Lipschitz in the time of day weights (jump <= 0.5 x weight change + one quantisation step)', () => {
    const keys = ['cloudStrength', 'rainDensity', 'gloom', 'shimmer'] as const;
    for (const kind of WEATHER_KINDS) {
      const drivers = targetOf(kind, 1);
      let previousWeights = todWeights(0);
      let previous = effectsOf(drivers, previousWeights);
      for (let i = 1; i <= 200; i += 1) {
        const weights = todWeights(i / 200);
        const next = effectsOf(drivers, weights);
        const bound = 0.5 * (Math.abs(weights.day - previousWeights.day) + Math.abs(weights.dusk - previousWeights.dusk)
          + Math.abs(weights.night - previousWeights.night)) + 0.011;
        for (const key of keys) expect(Math.abs(next[key] - previous[key]), `${kind}.${key}@${i}`).toBeLessThanOrEqual(bound);
        for (const key of ['exposureScale', 'saturationScale', 'ambientScale'] as const) {
          expect(Math.abs(next.modifiers[key] - previous.modifiers[key])).toBeLessThanOrEqual(bound);
        }
        for (let c = 0; c < 3; c += 1) expect(Math.abs(next.rainTint[c] - previous.rainTint[c])).toBeLessThanOrEqual(bound);
        previous = next;
        previousWeights = weights;
      }
    }
  });

  it('leaves the night nearly alone: a night storm gloom is at most a quarter of the day one', () => {
    const drivers = targetOf('storm', 1);
    expect(effectsOf(drivers, NIGHT).gloom).toBeLessThanOrEqual(0.25 * effectsOf(drivers, NOON).gloom);
    expect(effectsOf(drivers, NIGHT).cloudStrength).toBeLessThan(effectsOf(drivers, NOON).cloudStrength);
  });

  it('only shimmers on a hot day', () => {
    expect(effectsOf(targetOf('hot', 1), NOON).shimmer).toBe(0.5);
    expect(effectsOf(targetOf('hot', 1), NIGHT).shimmer).toBe(0);
    expect(effectsOf(targetOf('storm', 1), NOON).shimmer).toBe(0);
  });
});

describe('reduced motion mapping', () => {
  it('freezes motion, thins rain, drops flash/shimmer/ripples and keeps the still looks', () => {
    const e = effectsOf(targetOf('storm', 1), NOON);
    Object.assign(e, { cloudOffsetX: 5, cloudOffsetY: 3, rainPhaseA: 40, rainPhaseB: 33, shimmerPhase: 9, flash: 0.5, shimmer: 0.3 });
    const { wetness, puddle, gloom, cloudStrength } = e;
    applyReducedMotion(e);
    expect([e.cloudOffsetX, e.cloudOffsetY, e.rainPhaseA, e.rainPhaseB, e.shimmerPhase, e.flash, e.shimmer, e.ripple]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(e.rainDensity).toBe(0.35);
    expect([e.wetness, e.puddle, e.gloom, e.cloudStrength]).toEqual([wetness, puddle, gloom, cloudStrength]);
    const faint = effectsOf(targetOf('rain', 0.05), NOON);
    applyReducedMotion(faint);
    expect(faint.rainDensity).toBe(0);
    expect(faint.rainTint).toEqual([0, 0, 0]);
  });

  it('holds through WeatherLook: static pictures, no flash, still fades in', () => {
    const look = new WeatherLook({ reducedMotion: true });
    const stormView = view('storm', 1, { secondsIntoSegment: 3 });
    for (let i = 0; i < 2000; i += 1) {
      const e = look.update({ ...stormView, secondsIntoSegment: i / 10 }, NOON, 16, false);
      expect(e.flash).toBe(0);
      expect(e.rainPhaseA + e.rainPhaseB + e.cloudOffsetX + e.cloudOffsetY + e.shimmerPhase + e.ripple).toBe(0);
      expect(e.rainDensity).toBeLessThanOrEqual(0.35);
    }
    expect(look.effects.wetness).toBe(1);
  });
});

describe('FlashLimiter', () => {
  it('admits at most three onsets in any one second window, whatever the pulse rate', () => {
    const limiter = new FlashLimiter();
    const admittedOnsets: number[] = [];
    let wasLit = false;
    // A pulse every 0.1 s lasting 0.05 s at 60 fps for a minute.
    for (let frame = 0; frame < 3600; frame += 1) {
      const now = frame / 60;
      const raw = (frame % 6) < 3 ? 1 : 0;
      const lit = limiter.admit(now, raw) > 0;
      if (lit && !wasLit) admittedOnsets.push(now);
      wasLit = lit;
    }
    expect(admittedOnsets.length).toBeGreaterThan(100);
    for (let i = 0; i + MAX_FLASHES_PER_SECOND < admittedOnsets.length; i += 1) {
      expect(admittedOnsets[i + MAX_FLASHES_PER_SECOND] - admittedOnsets[i]).toBeGreaterThan(1);
    }
  });

  it('suppresses the rest of a suppressed pulse, passes a quiet pulse, and resets when time runs backwards', () => {
    const limiter = new FlashLimiter();
    for (const t of [0, 0.2, 0.4]) {
      expect(limiter.admit(t, 1)).toBe(1);
      expect(limiter.admit(t + 0.05, 0)).toBe(0);
    }
    expect(limiter.admit(0.6, 1)).toBe(0);
    expect(limiter.admit(0.65, 0.9)).toBe(0);
    expect(limiter.admit(0.7, 0)).toBe(0);
    expect(limiter.admit(1.5, 1)).toBe(1);
    expect(limiter.admit(0.1, 1), 'backwards time resets').toBe(1);
    limiter.reset();
    expect(limiter.admit(0.1, 0.04)).toBe(0.04);
  });
});

describe('WeatherLook flashes', () => {
  const run = (speed: number, hours = 2, paused = false) => {
    const look = new WeatherLook();
    const onsets: number[] = [];
    const levels: number[] = [];
    let sim = 0;
    let real = 0;
    let wasLit = false;
    const dtMs = 1000 / 60;
    settle(look, view('storm', 1), NOON, 8);
    while (real < hours * 3600) {
      sim += (dtMs / 1000) * speed;
      real += dtMs / 1000;
      const e = look.update(view('storm', 1, { secondsIntoSegment: sim }), NOON, dtMs, paused);
      levels.push(e.flash);
      if (e.flash > 0 && !wasLit) onsets.push(real);
      wasLit = e.flash > 0;
    }
    return { onsets, levels };
  };

  it('never shows more than 3 onsets in a one second window at 1x, 2x and 4x (and 20x as a stress)', () => {
    for (const speed of [1, 2, 4, 20]) {
      const { onsets } = run(speed, 1);
      expect(onsets.length, `speed ${speed}`).toBeGreaterThan(5);
      for (let i = 0; i + 3 < onsets.length; i += 1) expect(onsets[i + 3] - onsets[i], `speed ${speed}`).toBeGreaterThan(1);
    }
  });

  it('shapes the level: quantised, capped at 1, bounded rate of change', () => {
    const { levels } = run(4, 0.5);
    let previous = 0;
    for (const level of levels) {
      expect(level).toBeLessThanOrEqual(1);
      expect(level * 16).toBeCloseTo(Math.round(level * 16), 9);
      expect(level - previous).toBeLessThanOrEqual(12 / 60 + 1 / 16 + 1e-9);
      expect(previous - level).toBeLessThanOrEqual(6 / 60 + 1 / 16 + 1e-9);
      previous = level;
    }
  });

  it('shows no flash while paused', () => {
    const { levels } = run(1, 0.5, true);
    expect(Math.max(...levels)).toBe(0);
  });

  it('needs a storm: rain with a storm seed stays dark', () => {
    const look = new WeatherLook();
    for (let s = 0; s < 600; s += 0.5) {
      expect(look.update(view('rain', 1, { flashSeed: 12345, secondsIntoSegment: s }), NOON, 500, false).flash).toBe(0);
    }
  });

  it('&wflash holds a constant level, bypassing the limiter', () => {
    const look = new WeatherLook({ flashPin: 1 });
    expect(look.update(view('sunny', 0), NOON, 16, true).flash).toBe(1);
    expect(look.effects.active).toBe(true);
  });
});

describe('WeatherLook state', () => {
  it('a clear sky is inactive, identity and never bumps the revision', () => {
    const look = new WeatherLook();
    look.update(view('sunny', 0), NOON, 16, false);
    const { revision, modifiersRevision } = look.effects;
    for (let i = 0; i < 100; i += 1) look.update(view('sunny', 0), NOON, 16, i % 2 === 0);
    expect(look.effects.active).toBe(false);
    expect(look.effects.revision).toBe(revision);
    expect(look.effects.modifiersRevision).toBe(modifiersRevision);
  });

  it('weather off or intensity 0 reads as no effects whatever the kind', () => {
    const look = new WeatherLook();
    look.update(view('storm', 1, { enabled: false }), NOON, 16, false);
    expect(look.effects.active).toBe(false);
    look.update(view('storm', 0), NOON, 16, false);
    expect(look.effects.active).toBe(false);
  });

  it('snaps on the first frame, then eases (no popping) and returns to clear exactly', () => {
    const look = new WeatherLook();
    look.update(view('rain', 1), NOON, 16, false);
    expect(look.effects.rainDensity).toBe(0.75);
    look.update(view('sunny', 0), NOON, 16, false);
    expect(look.effects.rainDensity).toBeGreaterThan(0.7);
    settle(look, view('sunny', 0), NOON, 60);
    expect(look.effects.active).toBe(false);
    expect(look.effects.wetness).toBe(0);
    look.reset();
    look.update(view('rain', 1), NOON, 16, false);
    expect(look.effects.rainDensity).toBe(0.75);
  });

  it('intensity scales the picture (low vs high severity)', () => {
    const low = new WeatherLook();
    const high = new WeatherLook();
    low.update(view('rain', 0.6), NOON, 16, false);
    high.update(view('rain', 1), NOON, 16, false);
    expect(low.effects.rainDensity).toBeLessThan(high.effects.rainDensity);
    expect(low.effects.puddle).toBeLessThan(high.effects.puddle);
  });

  it('paused: nothing animates and the revision holds over 100 frames, but a switch still fades', () => {
    const look = new WeatherLook();
    settle(look, view('storm', 1, { secondsIntoSegment: 1 }), NOON, 5);
    look.update(view('storm', 1), NOON, 16, true);
    const frozen = { ...look.effects };
    const revision = look.effects.revision;
    for (let i = 0; i < 100; i += 1) look.update(view('storm', 1, { secondsIntoSegment: 1 }), NOON, 16, true);
    expect(look.effects.revision).toBe(revision);
    expect(look.effects.rainPhaseA).toBe(frozen.rainPhaseA);
    expect(look.effects.cloudOffsetX).toBe(frozen.cloudOffsetX);
    for (let i = 0; i < 100; i += 1) look.update(view('sunny', 0), NOON, 16, true);
    expect(look.effects.rainDensity).toBeLessThan(frozen.rainDensity);
  });

  it('running: clouds and rain move, wrapped, in whole rows and quarter voxels', () => {
    const look = new WeatherLook();
    settle(look, view('storm', 1), NOON, 20);
    const a = look.effects.rainPhaseA;
    const x = look.effects.cloudOffsetX;
    settle(look, view('storm', 1), NOON, 1);
    expect(look.effects.rainPhaseA).not.toBe(a);
    expect(look.effects.cloudOffsetX).not.toBe(x);
    for (let i = 0; i < 20; i += 1) settle(look, view('storm', 1), NOON, 30);
    const e = look.effects;
    expect(Number.isInteger(e.rainPhaseA) && e.rainPhaseA >= 0 && e.rainPhaseA < RAIN_WRAP_ROWS).toBe(true);
    expect(e.cloudOffsetX * 4).toBe(Math.floor(e.cloudOffsetX * 4));
    expect(e.cloudOffsetX).toBeLessThan(CLOUD_WRAP_VOXELS);
    expect(e.cloudOffsetY).toBeLessThan(CLOUD_WRAP_VOXELS);
  });

  it('hot shimmer animates its phase and stops when paused', () => {
    const look = new WeatherLook();
    settle(look, view('hot', 1), NOON, 3);
    const p = look.effects.shimmerPhase;
    settle(look, view('hot', 1), NOON, 1);
    expect(look.effects.shimmerPhase).not.toBe(p);
    const q = look.effects.shimmerPhase;
    settle(look, view('hot', 1), NOON, 1, true);
    expect(look.effects.shimmerPhase).toBe(q);
  });

  it('reuses one effects object and its arrays (no allocation per update)', () => {
    const look = new WeatherLook();
    const e = look.effects;
    const arrays = [e.cloudTint, e.rainTint, e.modifiers, e.modifiers.tintMul];
    for (let i = 0; i < 1000; i += 1) {
      const result = look.update(view('storm', 1, { secondsIntoSegment: i }), todWeights(i / 1000), 16, false);
      expect(result).toBe(e);
    }
    expect([e.cloudTint, e.rainTint, e.modifiers, e.modifiers.tintMul]).toEqual(arrays);
    expect(e.cloudTint).toBe(arrays[0]);
    expect(e.modifiers.tintMul).toBe(arrays[3]);
  });

  it('modifiersRevision moves only with the grade', () => {
    const look = new WeatherLook();
    look.update(view('storm', 1), NOON, 16, false);
    const r = look.effects.modifiersRevision;
    expect(r).toBeGreaterThan(0);
    settle(look, view('storm', 1), NOON, 2);
    expect(look.effects.modifiersRevision).toBe(r);
    settle(look, view('sunny', 0), NOON, 5);
    expect(look.effects.modifiersRevision).toBeGreaterThan(r);
  });
});

describe('pins', () => {
  it('a pin overrides the view, also when the weather is off, and a pinned storm flashes', () => {
    const look = new WeatherLook({ pin: { kind: 'storm', intensity: 0.8 }, runWhilePaused: true });
    const e = look.update(view('sunny', 0, { enabled: false }), NOON, 16, true);
    expect(e.rainDensity).toBe(0.8);
    let flashed = false;
    for (let i = 0; i < 60 * 600 && !flashed; i += 1) flashed = look.update(view('sunny', 0), NOON, 16, true).flash > 0;
    expect(flashed).toBe(true);
  });

  it('a paused pin without wmotion stays still', () => {
    const look = new WeatherLook({ pin: { kind: 'rain', intensity: 1 } });
    settle(look, view('sunny', 0), NOON, 3, true);
    expect(look.effects.rainPhaseA).toBe(0);
    expect(look.effects.rainDensity).toBe(0.75);
  });

  it('wclock gives deterministic, identical output across instances and never advances', () => {
    const make = () => new WeatherLook({ pin: { kind: 'storm', intensity: 0.8 }, fixedClockSeconds: 7 });
    const a = make();
    const b = make();
    settle(a, view('sunny', 0), NOON, 10);
    settle(b, view('sunny', 0), NOON, 25);
    expect({ ...a.effects, revision: 0, modifiersRevision: 0 }).toEqual({ ...b.effects, revision: 0, modifiersRevision: 0 });
    const x = a.effects.cloudOffsetX;
    settle(a, view('sunny', 0), NOON, 5);
    expect(a.effects.cloudOffsetX).toBe(x);
    expect(x).toBeGreaterThan(0);
  });
});

describe('parseWeatherFlags', () => {
  it('parses the table', () => {
    expect(parseWeatherFlags('')).toEqual({});
    expect(parseWeatherFlags('?weather=hot')).toEqual({ pin: { kind: 'hot', intensity: 0.8 } });
    expect(parseWeatherFlags('?weather=rain&wintensity=2')).toEqual({ pin: { kind: 'rain', intensity: 1 } });
    expect(parseWeatherFlags('?weather=rain&wintensity=-1')).toEqual({ pin: { kind: 'rain', intensity: 0 } });
    expect(parseWeatherFlags('?weather=rain&wintensity=.25')).toEqual({ pin: { kind: 'rain', intensity: 0.25 } });
    for (const junk of ['', 'abc', '1e2', ' ', 'NaN', 'Infinity']) {
      expect(parseWeatherFlags(`?weather=cloudy&wintensity=${junk}`), junk).toEqual({ pin: { kind: 'cloudy', intensity: 0.8 } });
    }
    expect(parseWeatherFlags('?weather=Storm')).toEqual({});
    expect(parseWeatherFlags('?wclock=3.5')).toEqual({ fixedClockSeconds: 3.5 });
    expect(parseWeatherFlags('?wclock=-3')).toEqual({});
    expect(parseWeatherFlags('?wclock=')).toEqual({});
    expect(parseWeatherFlags('?wmotion=run')).toEqual({ runWhilePaused: true });
    expect(parseWeatherFlags('?wmotion=walk')).toEqual({});
    expect(parseWeatherFlags('?wflash=3')).toEqual({ flashPin: 1 });
    expect(parseWeatherFlags('?wflash=0')).toEqual({ flashPin: 0 });
    expect(parseWeatherFlags('?wflash=x')).toEqual({});
  });
});

describe('setPresentation (live presentation preferences)', () => {
  it('reduced motion freezes the animation clock and the flash on the next update', () => {
    const look = new WeatherLook({});
    const view = { ...createWeatherView(), kind: 'storm' as const, intensity: 1, flashSeed: 7 };
    for (let i = 0; i < 300; i += 1) look.update(view, { day: 1, dusk: 0, night: 0 }, 16, false);
    look.setPresentation({ reducedMotion: true, weatherEffects: 'full', lightningFlashes: true });
    for (let i = 0; i < 300; i += 1) look.update(view, { day: 1, dusk: 0, night: 0 }, 16, false);
    const a = look.effects.cloudOffsetX;
    for (let i = 0; i < 100; i += 1) look.update(view, { day: 1, dusk: 0, night: 0 }, 16, false);
    expect(look.effects.cloudOffsetX).toBe(a);
    expect(look.effects.flash).toBe(0);
  });
});

describe('weather effects level and flashes (player presentation switch)', () => {
  const prefs = (weatherEffects: 'full' | 'reduced' | 'off', lightningFlashes = true, reducedMotion = false) =>
    ({ reducedMotion, weatherEffects, lightningFlashes });
  const stormRun = (look: WeatherLook, seconds = 600) => {
    let maxFlash = 0;
    let maxRain = 0;
    let sim = 0;
    for (let i = 0; i < seconds * 60; i += 1) {
      sim += 1 / 60;
      const e = look.update(view('storm', 1, { secondsIntoSegment: sim }), NOON, 1000 / 60, false);
      maxFlash = Math.max(maxFlash, e.flash);
      maxRain = Math.max(maxRain, e.rainDensity);
    }
    return { maxFlash, maxRain, effects: look.effects };
  };

  it('full is the unchanged default: a storm flashes and rains', () => {
    const { maxFlash, maxRain } = stormRun(new WeatherLook());
    expect(maxFlash).toBeGreaterThan(0);
    expect(maxRain).toBeGreaterThan(0.5);
  });

  it('off gives zero effects even with a pin and even in a storm; it ignores the &weather= pin', () => {
    const look = new WeatherLook({ pin: { kind: 'storm', intensity: 1 }, flashPin: 1 });
    look.setPresentation(prefs('off'));
    const { effects, maxFlash } = stormRun(look, 20);
    expect(maxFlash).toBe(0);
    expect(effects.active).toBe(false);
    expect(effects.rainDensity).toBe(0);
    expect(effects.cloudStrength).toBe(0);
  });

  it('reduced caps the rain, drops flash, shimmer and ripple, but keeps gloom and wetness', () => {
    const calm = new WeatherLook();
    calm.setPresentation(prefs('reduced'));
    const full = new WeatherLook();
    const a = stormRun(calm, 60);
    const b = stormRun(full, 60);
    expect(a.maxFlash).toBe(0);
    expect(a.maxRain).toBeLessThanOrEqual(0.5);
    expect(a.effects.ripple).toBe(0);
    expect(a.effects.shimmer).toBe(0);
    expect(a.effects.gloom).toBe(b.effects.gloom);
    expect(a.effects.wetness).toBe(b.effects.wetness);
  });

  it('flashes off removes lightning only, in a full storm', () => {
    const look = new WeatherLook();
    look.setPresentation(prefs('full', false));
    const { maxFlash, maxRain } = stormRun(look, 120);
    expect(maxFlash).toBe(0);
    expect(maxRain).toBeGreaterThan(0.5);
  });

  it('a level change slews instead of popping', () => {
    const look = new WeatherLook();
    settle(look, view('storm', 1), NOON, 20);
    const before = look.effects.cloudStrength;
    look.setPresentation(prefs('off'));
    for (let i = 0; i < 30; i += 1) look.update(view('storm', 1), NOON, 16, false);
    expect(look.effects.cloudStrength).toBeGreaterThan(0);
    expect(look.effects.cloudStrength).toBeLessThan(before);
  });
});
