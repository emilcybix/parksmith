import { Container, Sprite } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSettings, updateSettings } from '../settings';
import { ParkSession } from '../game/session/ParkSession';
import { createWeatherView, WEATHER_KINDS, type WeatherKind, type WeatherView } from '../game/weather/types';
import { classicTint } from './classicDayTint';
import { CLASSIC_CLOUD_POOL, CLASSIC_RAIN_POOL, ClassicWeather } from './classicWeather';
import { createDayWeights, dayWeights, type DayWeights } from './dayCycle';
import { blendLightPreset, createDayLook } from './voxel/dayLook';
import {
  MAX_FLASHES_PER_SECOND,
  WeatherLook,
  createWeatherEffects,
  parseWeatherFlags,
  weatherEffectsFrom,
  weatherTargetDrivers,
  createWeatherDrivers,
  type WeatherEffects,
} from './weatherLook';
import { WorldRenderer } from './WorldRenderer';

/**
 * Adversarial review of the weather presentation (Phase 20 step 3): photosensitivity in both
 * renderers, reduced motion, pooled classic layers, the pause freeze, hostile inputs and the day look
 * modifier slot. Every defect it found has been fixed; the tests stay as regression guards.
 */

const NOON: DayWeights = { day: 1, dusk: 0, night: 0 };
const NIGHT: DayWeights = { day: 0, dusk: 0, night: 1 };
const weightsAt = (hour: number): DayWeights => ({ ...dayWeights(createDayWeights(), hour / 24) });
const stormView = (over: Partial<WeatherView> = {}): WeatherView => (
  { ...createWeatherView(), kind: 'storm', intensity: 1, flashSeed: 12345, ...over }
);
const viewOf = (kind: WeatherKind, intensity: number, over: Partial<WeatherView> = {}): WeatherView => (
  { ...createWeatherView(), kind, intensity, flashSeed: kind === 'storm' ? 12345 : 0, ...over }
);

/** Rising edges through `high` after the level was below `low`: what a person sees as one flash. */
class FlashCounter {
  readonly onsets: number[] = [];
  maxStep = 0;
  private armed = true;
  private previous = 0;
  private first = true;
  constructor(private readonly low: number, private readonly high: number) {}
  push(timeSeconds: number, level: number): void {
    if (!this.first) this.maxStep = Math.max(this.maxStep, Math.abs(level - this.previous));
    this.first = false;
    this.previous = level;
    if (level <= this.low) this.armed = true;
    if (this.armed && level >= this.high) {
      this.armed = false;
      this.onsets.push(timeSeconds);
    }
  }
  /** The most onsets in any closed one second window. */
  get worstWindow(): number {
    let worst = 0;
    for (let i = 0; i < this.onsets.length; i += 1) {
      let j = i;
      while (j + 1 < this.onsets.length && this.onsets[j + 1] - this.onsets[i] <= 1) j += 1;
      worst = Math.max(worst, j - i + 1);
    }
    return worst;
  }
}

interface RunOptions {
  speed: number;
  seconds: number;
  seed?: number;
  intensity?: number;
  weights?: DayWeights;
  /** Frame length in ms as a function of the frame number (jitter, 30 fps, long hitches). */
  frameMs?: (frame: number) => number;
  /** True while the game is paused, as a function of the frame number. */
  paused?: (frame: number) => boolean;
}

/** Drives a WeatherLook like GameApp does: sim time advances by real dt x speed, and not at all while paused. */
const runStorm = (options: RunOptions) => {
  const look = new WeatherLook();
  const counter = new FlashCounter(0.1, 0.4);
  const frameMs = options.frameMs ?? (() => 1000 / 60);
  let sim = 0;
  let real = 0;
  let frame = 0;
  let flashFrames = 0;
  while (real < options.seconds) {
    const dtMs = frameMs(frame);
    const paused = options.paused?.(frame) ?? false;
    const dt = Math.min(dtMs, 100) / 1000;
    real += dt;
    if (!paused) sim += (dtMs / 1000) * options.speed;
    const view = stormView({ flashSeed: options.seed ?? 12345, intensity: options.intensity ?? 1, secondsIntoSegment: sim });
    const effects = look.update(view, options.weights ?? NOON, dtMs, paused);
    counter.push(real, effects.flash);
    if (effects.flash > 0) flashFrames += 1;
    frame += 1;
  }
  return { counter, flashFrames, look };
};

describe('photosensitivity: the flash cap over long storms (shared WeatherLook, so both renderers)', () => {
  const SEEDS = [1, 7, 99, 12345, 0xdeadbeef];

  it('never has more than 3 flashes in any one second at 1x, 2x and 4x, for several seeds, over a long storm', () => {
    for (const seed of SEEDS) {
      for (const speed of [1, 2, 4]) {
        const { counter } = runStorm({ speed, seconds: 600, seed });
        expect(counter.onsets.length, `seed ${seed} speed ${speed} has lightning`).toBeGreaterThan(10);
        expect(counter.worstWindow, `seed ${seed} speed ${speed}`).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
      }
    }
  });

  it('holds at a jittery 30 fps and through long frame hitches (the dt clamp must not weaken the cap)', () => {
    const jitter = (frame: number): number => [16, 33, 8, 50, 100, 250, 12][frame % 7];
    for (const speed of [1, 4]) {
      const { counter } = runStorm({ speed, seconds: 300, frameMs: jitter });
      expect(counter.worstWindow, `speed ${speed}`).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
      const { counter: slow } = runStorm({ speed, seconds: 300, frameMs: () => 1000 / 30 });
      expect(slow.worstWindow, `30 fps speed ${speed}`).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
    }
  });

  it('holds when the player toggles pause every few frames (an unpause is not a fresh allowance)', () => {
    for (const every of [1, 2, 3, 5, 11, 20]) {
      const { counter } = runStorm({ speed: 4, seconds: 400, paused: (frame) => Math.floor(frame / every) % 2 === 1 });
      expect(counter.worstWindow, `toggle every ${every} frames`).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
    }
  });

  it('has no strobing step: the level never moves faster than the documented rise and is never full white', () => {
    const { counter, look } = runStorm({ speed: 4, seconds: 300, frameMs: () => 1000 / 60 });
    // 12 per second rise at 60 fps is 0.2 per frame, plus one quantisation step of 1/16.
    expect(counter.maxStep).toBeLessThanOrEqual(12 / 60 + 1 / 16 + 1e-9);
    expect(look.effects.flash).toBeLessThanOrEqual(1);
  });

  it('flashes in only a small share of the frames (lightning, not a lamp that stays on)', () => {
    const { flashFrames } = runStorm({ speed: 1, seconds: 600 });
    expect(flashFrames / (600 * 60)).toBeLessThan(0.25);
  });

  it('a storm at intensity 1 flashes at night and at dusk too, and always within the cap', () => {
    for (const weights of [NIGHT, weightsAt(19)]) {
      const { counter } = runStorm({ speed: 4, seconds: 300, weights });
      expect(counter.worstWindow).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
    }
  });

  it('switching the kind storm -> rain -> storm every second cannot produce a burst', () => {
    const look = new WeatherLook();
    const counter = new FlashCounter(0.1, 0.4);
    let sim = 0;
    let real = 0;
    for (let frame = 0; frame < 60 * 400; frame += 1) {
      real += 1 / 60;
      sim += 4 / 60;
      const kind: WeatherKind = Math.floor(real) % 2 === 0 ? 'storm' : 'rain';
      const view = viewOf(kind, 1, { flashSeed: 99, secondsIntoSegment: sim });
      counter.push(real, look.update(view, NOON, 1000 / 60, false).flash);
    }
    expect(counter.worstWindow).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
  });

  it('setSession / reset (a held Ctrl+Z swaps the session many times a second) cannot restart flashes beyond the cap', () => {
    // reset() clears the limiter; every swap inside a lightning pulse is a fresh allowance. Measured as
    // big one-frame drops (a normal fall is at most 6/s = 0.1 per frame): each is a visible flicker.
    for (const every of [2, 6, 12, 20, 30, 45]) {
      const look = new WeatherLook();
      let sim = 0;
      let previous = 0;
      let real = 0;
      const dropTimes: number[] = [];
      for (let frame = 0; frame < 60 * 600; frame += 1) {
        real += 1 / 60;
        sim += 1 / 60;
        if (frame % every === 0) look.reset();
        const level = look.update(stormView({ secondsIntoSegment: sim }), NOON, 1000 / 60, false).flash;
        if (previous - level > 0.25) dropTimes.push(real);
        previous = level;
      }
      let worst = 0;
      for (let i = 0; i < dropTimes.length; i += 1) {
        let j = i;
        while (j + 1 < dropTimes.length && dropTimes[j + 1] - dropTimes[i] <= 1) j += 1;
        worst = Math.max(worst, j - i + 1);
      }
      expect(worst, `reset every ${every} frames`).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
    }
  });
});

describe('reduced motion: the pure mapping end to end', () => {
  const frozen = (e: Readonly<WeatherEffects>) => [e.cloudOffsetX, e.cloudOffsetY, e.rainPhaseA, e.rainPhaseB, e.shimmer, e.shimmerPhase, e.flash, e.ripple];

  it('every storm, hot day and rain frame is static: no motion field ever leaves zero, over every pause/pin combination', () => {
    const combos: Partial<ConstructorParameters<typeof WeatherLook>[0]>[] = [
      {},
      { runWhilePaused: true },
      { fixedClockSeconds: 123.4 },
      { fixedClockSeconds: 9999, runWhilePaused: true },
      { flashPin: 1 },
      { pin: { kind: 'storm', intensity: 1 } },
      { pin: { kind: 'hot', intensity: 1 }, runWhilePaused: true },
      { pin: { kind: 'storm', intensity: 1 }, flashPin: 0.9, fixedClockSeconds: 5 },
    ];
    for (const flags of combos) {
      for (const kind of WEATHER_KINDS) {
        const look = new WeatherLook({ reducedMotion: true, ...flags });
        let sim = 0;
        for (let frame = 0; frame < 600; frame += 1) {
          sim += 0.1;
          const e = look.update(viewOf(kind, 1, { secondsIntoSegment: sim }), weightsAt(frame % 24), 16, frame % 3 === 0);
          expect(frozen(e), `${kind} ${JSON.stringify(flags)} frame ${frame}`).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
          expect(e.rainDensity).toBeLessThanOrEqual(0.35);
        }
      }
    }
  });

  it('keeps explaining the weather without motion: gloom, wetness, cloud shadow and a light rain texture remain', () => {
    const look = new WeatherLook({ reducedMotion: true });
    for (let frame = 0; frame < 600; frame += 1) look.update(viewOf('storm', 1), NOON, 16, false);
    const e = look.effects;
    expect(e.active).toBe(true);
    expect(e.gloom).toBeGreaterThan(0.5);
    expect(e.wetness).toBeGreaterThan(0.5);
    expect(e.cloudStrength).toBeGreaterThan(0);
    expect(e.rainDensity).toBeGreaterThan(0);
    expect(e.rainDensity).toBeLessThanOrEqual(0.35);
  });

  it('a faint rain (intensity 0.05) becomes off, not a flickering few streaks', () => {
    const look = new WeatherLook({ reducedMotion: true });
    for (let frame = 0; frame < 600; frame += 1) look.update(viewOf('rain', 0.05), NOON, 16, false);
    expect(look.effects.rainDensity).toBe(0);
    expect(look.effects.rainTint).toEqual([0, 0, 0]);
  });

  it('a fade between kinds under reduced motion changes the picture smoothly (no pop of a static texture)', () => {
    const look = new WeatherLook({ reducedMotion: true });
    for (let frame = 0; frame < 300; frame += 1) look.update(viewOf('sunny', 1), NOON, 16, false);
    let previous = look.effects.rainDensity;
    let worst = 0;
    for (let frame = 0; frame < 60 * 12; frame += 1) {
      const density = look.update(viewOf('storm', 1), NOON, 16, false).rainDensity;
      worst = Math.max(worst, Math.abs(density - previous));
      previous = density;
    }
    // The 0.05 floor snaps density 0.04 -> 0 and 0.05 -> 0.05 once: one small step, never a jump to full.
    expect(worst).toBeLessThanOrEqual(0.06);
  });
});

describe('weather off, intensity extremes and hostile views', () => {
  const finite = (e: Readonly<WeatherEffects>): boolean => [
    e.cloudCover, e.cloudStrength, e.cloudOffsetX, e.cloudOffsetY, ...e.cloudTint, e.rainDensity, e.rainSlant, e.rainPhaseA, e.rainPhaseB,
    ...e.rainTint, e.wetness, e.puddle, e.ripple, e.shimmer, e.shimmerPhase, e.flash, e.gloom,
    e.modifiers.exposureScale, e.modifiers.saturationScale, e.modifiers.ambientScale, ...e.modifiers.tintMul,
  ].every(Number.isFinite);

  it('weather off in the middle of a storm ends the lightning within the fade, and nothing is left afterwards', () => {
    const look = new WeatherLook();
    let sim = 0;
    for (let frame = 0; frame < 60 * 20; frame += 1) {
      sim += 4 / 60;
      look.update(viewOf('storm', 1, { secondsIntoSegment: sim }), NOON, 1000 / 60, false);
    }
    let lastFlashAt = -1;
    for (let frame = 0; frame < 60 * 60; frame += 1) {
      sim += 4 / 60;
      const e = look.update(viewOf('storm', 1, { enabled: false, secondsIntoSegment: sim }), NOON, 1000 / 60, false);
      if (e.flash > 0) lastFlashAt = frame / 60;
    }
    // drivers.storm eases from 1 to 0.5 at 0.25/s before the gate closes: allow that, not more.
    expect(lastFlashAt).toBeLessThanOrEqual(2.6);
    expect(look.effects.active).toBe(false);
    expect(look.effects.revision).toBeGreaterThan(0);
  });

  it('low intensity storms (below 0.5) never flash; the lightning arrives with the severe half of the range', () => {
    const low = runStorm({ speed: 4, seconds: 300, intensity: 0.45 });
    expect(low.flashFrames).toBe(0);
    const high = runStorm({ speed: 4, seconds: 300, intensity: 0.9 });
    expect(high.flashFrames).toBeGreaterThan(0);
  });

  it('flash strength scales with intensity (a milder storm is not a weaker-looking full flash)', () => {
    const peak = (intensity: number): number => {
      const look = new WeatherLook();
      let sim = 0;
      let top = 0;
      for (let frame = 0; frame < 60 * 300; frame += 1) {
        sim += 1 / 60;
        top = Math.max(top, look.update(stormView({ intensity, secondsIntoSegment: sim }), NOON, 1000 / 60, false).flash);
      }
      return top;
    };
    expect(peak(1)).toBeGreaterThanOrEqual(peak(0.6));
    expect(peak(0.6)).toBeGreaterThan(0);
  });

  it('survives NaN, Infinity, negative and huge values and unknown kinds with finite effects', () => {
    const hostile: Partial<WeatherView>[] = [
      { intensity: Number.NaN },
      { intensity: Number.POSITIVE_INFINITY },
      { intensity: Number.NEGATIVE_INFINITY },
      { intensity: -5 },
      { intensity: 1e308 },
      { kind: 'tornado' as WeatherKind },
      { kind: undefined as unknown as WeatherKind },
      { secondsIntoSegment: Number.NaN },
      { secondsIntoSegment: -10 },
      { secondsIntoSegment: Number.POSITIVE_INFINITY },
      { flashSeed: Number.NaN },
      { flashSeed: -1 },
      { flashSeed: 2 ** 40 },
    ];
    for (const extra of hostile) {
      const look = new WeatherLook();
      for (let frame = 0; frame < 300; frame += 1) {
        const e = look.update({ ...stormView(), ...extra }, weightsAt(frame % 24), 16, false);
        expect(finite(e), JSON.stringify(extra, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))).toBe(true);
        expect(e.flash).toBeGreaterThanOrEqual(0);
        expect(e.flash).toBeLessThanOrEqual(1);
      }
    }
  });

  it('survives hostile dt (NaN, negative, zero, Infinity, 1e9) and keeps every phase wrapped', () => {
    const look = new WeatherLook();
    for (const dt of [Number.NaN, -16, 0, Number.POSITIVE_INFINITY, 1e9, 16]) {
      const e = look.update(stormView(), NOON, dt, false);
      expect(finite(e), `dt ${dt}`).toBe(true);
      expect(e.rainPhaseA).toBeGreaterThanOrEqual(0);
      expect(e.cloudOffsetX).toBeGreaterThanOrEqual(0);
    }
  });

  it('intensity 0 or weather off is exactly the clear picture for every kind and hour', () => {
    for (const kind of WEATHER_KINDS) {
      for (let hour = 0; hour < 24; hour += 3) {
        const a = weatherEffectsFrom(weatherTargetDrivers(true, kind, 0, createWeatherDrivers()), weightsAt(hour), createWeatherEffects());
        const b = weatherEffectsFrom(weatherTargetDrivers(false, kind, 1, createWeatherDrivers()), weightsAt(hour), createWeatherEffects());
        for (const e of [a, b]) {
          expect(e.active, `${kind}@${hour}`).toBe(false);
          expect(e.modifiers).toEqual({ exposureScale: 1, saturationScale: 1, ambientScale: 1, tintMul: [1, 1, 1] });
        }
      }
    }
  });
});

describe('URL flags with garbage', () => {
  const GARBAGE = [
    '', '?', '?&&&', '?weather', '?weather=', '?weather=&wintensity=', '?weather=%', '?weather=%E0%A4%A', '?weather=storm%00',
    '?weather=__proto__', '?weather=constructor', '?weather=toString', '?weather=hasOwnProperty', '?weather=STORM', '?weather=storm ',
    '?weather=storm&weather=rain', '?weather=rain&wintensity=0x10', '?weather=rain&wintensity=1_0', '?weather=rain&wintensity=--1',
    '?weather=rain&wintensity=1e1', '?weather=rain&wintensity=%20', '?weather=rain&wintensity=' + '9'.repeat(400),
    '?weather=rain&wintensity=0.' + '9'.repeat(400), '?wclock=1e3', '?wclock=' + '9'.repeat(400), '?wclock=-0', '?wclock=0x1',
    '?wflash=NaN', '?wflash=Infinity', '?wflash=-Infinity', '?wflash=2', '?wmotion=RUN', '?wmotion=', '?wintensity=1',
    '?' + 'weather=storm&'.repeat(5000),
  ];

  it('never throws, and only ever yields valid values', () => {
    for (const search of GARBAGE) {
      expect(() => parseWeatherFlags(search), search.slice(0, 40)).not.toThrow();
      const flags = parseWeatherFlags(search);
      if (flags.pin) {
        expect((WEATHER_KINDS as readonly string[]).includes(flags.pin.kind)).toBe(true);
        expect(flags.pin.intensity).toBeGreaterThanOrEqual(0);
        expect(flags.pin.intensity).toBeLessThanOrEqual(1);
      }
      if (typeof flags.fixedClockSeconds === 'number') expect(Number.isFinite(flags.fixedClockSeconds) && flags.fixedClockSeconds >= 0).toBe(true);
      if (typeof flags.flashPin === 'number') expect(flags.flashPin >= 0 && flags.flashPin <= 1).toBe(true);
    }
  });

  it('a pin taken from garbage still drives finite, bounded effects (also an absurd wclock)', () => {
    for (const search of GARBAGE) {
      const look = new WeatherLook(parseWeatherFlags(search));
      for (let frame = 0; frame < 30; frame += 1) {
        const e = look.update(createWeatherView(), weightsAt(frame), 16, frame % 2 === 0);
        for (const value of [e.cloudOffsetX, e.cloudOffsetY, e.rainPhaseA, e.rainPhaseB, e.shimmerPhase, e.flash]) expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('the pin never touches the view it was given (presentation only: nothing flows back)', () => {
    const view = Object.freeze({ ...createWeatherView(), kind: 'sunny' as const, intensity: 0.5 });
    const look = new WeatherLook({ pin: { kind: 'storm', intensity: 1 } });
    expect(() => look.update(view, NOON, 16, false)).not.toThrow();
    expect(view.kind).toBe('sunny');
  });
});

describe('day look modifier slot: applied exactly once', () => {
  it('blending twice into the same look gives the same look as blending once (no compounding)', () => {
    const modifiers = { exposureScale: 0.86, saturationScale: 0.96, ambientScale: 0.9, tintMul: [0.93, 0.97, 0.95] as const };
    for (const weights of [NOON, NIGHT, weightsAt(19), weightsAt(6.5), weightsAt(12)]) {
      const once = blendLightPreset(createDayLook(), weights, modifiers);
      const twice = createDayLook();
      blendLightPreset(twice, weights, modifiers);
      blendLightPreset(twice, weights, modifiers);
      expect(twice).toEqual(once);
    }
  });

  it('a modified blend never corrupts the preset constants: the next unmodified blend is pristine', () => {
    const pristine = (weights: DayWeights) => blendLightPreset(createDayLook(), weights);
    const before = [NOON, NIGHT, weightsAt(19)].map(pristine);
    const look = createDayLook();
    for (const weights of [NOON, NIGHT, weightsAt(19)]) {
      blendLightPreset(look, weights, { exposureScale: 0.5, saturationScale: 0.5, ambientScale: 0.5, tintMul: [0.5, 0.5, 0.5] });
    }
    expect([NOON, NIGHT, weightsAt(19)].map(pristine)).toEqual(before);
  });

  it('exposure is exactly the unmodified exposure times the scale, and identity modifiers change nothing', () => {
    for (const weights of [NOON, NIGHT, weightsAt(19)]) {
      const base = blendLightPreset(createDayLook(), weights);
      const scaled = blendLightPreset(createDayLook(), weights, { exposureScale: 0.9 });
      expect(scaled.exposure).toBeCloseTo(base.exposure * 0.9, 12);
      const identity = blendLightPreset(createDayLook(), weights, { exposureScale: 1, saturationScale: 1, ambientScale: 1, tintMul: [1, 1, 1] });
      expect(identity).toEqual(base);
    }
  });

  it('the weather look hands the look its grade only, and the classic tint takes gloom only (never both slots)', () => {
    const look = new WeatherLook({ pin: { kind: 'storm', intensity: 1 } });
    for (let frame = 0; frame < 600; frame += 1) look.update(createWeatherView(), NOON, 16, false);
    const e = look.effects;
    // The voxel path: modifiers scale the look. The classic path: gloom darkens the tint.
    expect(e.modifiers.exposureScale).toBeLessThan(1);
    expect(e.gloom).toBeGreaterThan(0);
    // Classic tint at noon with that gloom is the gloom tint of the day weights once, not twice.
    const once = classicTint(NOON, e.gloom, 0);
    const twice = classicTint(NOON, e.gloom * 2, 0);
    expect(once).not.toBe(0xffffff);
    expect(once).toBeGreaterThanOrEqual(twice);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Classic renderer
 * ---------------------------------------------------------------------------------------------- */

const nodes = (root: Container): number => root.children.reduce((sum, child) => sum + nodes(child as Container), 1);
const channels = (tint: number): number[] => [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];

describe('classic pooled layers', () => {
  it('10,000 frames of changing weather, sizes and intensities: same display objects, same child identity, all positions finite', () => {
    const screen = { width: 1280, height: 720 };
    const field = { x: -1000, y: 0, width: 2000, height: 1000 };
    const pool = new ClassicWeather(() => screen, () => field);
    const cloudChildren = [...pool.cloudLayer.children];
    const rainChildren = [...pool.rainLayer.children];
    const count = pool.displayCount;
    const nodesBefore = nodes(pool.cloudLayer) + nodes(pool.rainLayer);
    const look = new WeatherLook();
    let seed = 1;
    const random = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    let kind: WeatherKind = 'sunny';
    let intensity = 0.5;
    for (let frame = 0; frame < 10_000; frame += 1) {
      if (frame % 97 === 0) { kind = WEATHER_KINDS[Math.floor(random() * WEATHER_KINDS.length)]; intensity = random(); }
      if (frame % 211 === 0) { screen.width = 200 + Math.floor(random() * 3000); screen.height = 100 + Math.floor(random() * 2000); }
      if (frame % 313 === 0) { field.width = 100 + random() * 4000; field.height = 50 + random() * 2000; field.x = -random() * 2000; }
      pool.apply(look.update(viewOf(kind, intensity, { secondsIntoSegment: frame / 10 }), weightsAt((frame / 50) % 24), 16, false));
    }
    expect(pool.displayCount).toBe(count);
    expect(nodes(pool.cloudLayer) + nodes(pool.rainLayer)).toBe(nodesBefore);
    expect(pool.cloudLayer.children.every((child, i) => child === cloudChildren[i])).toBe(true);
    expect(pool.rainLayer.children.every((child, i) => child === rainChildren[i])).toBe(true);
    expect(pool.cloudLayer.children.length).toBe(CLASSIC_CLOUD_POOL);
    expect(pool.rainLayer.children.length).toBe(CLASSIC_RAIN_POOL);
    for (const child of [...pool.cloudLayer.children, ...pool.rainLayer.children] as Sprite[]) {
      for (const value of [child.x, child.y, child.width, child.height, child.rotation, child.alpha]) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('creates no display objects over 3,000 storm frames', () => {
    const pool = new ClassicWeather(() => ({ width: 1280, height: 720 }), () => ({ x: -1000, y: 0, width: 2000, height: 1000 }));
    const look = new WeatherLook({ pin: { kind: 'storm', intensity: 1 } });
    const before = nodes(pool.rainLayer);
    for (let frame = 0; frame < 3_000; frame += 1) pool.apply(look.update(createWeatherView(), weightsAt(frame % 24), 16, false));
    expect(nodes(pool.rainLayer)).toBe(before);
  });

  it('a degenerate screen or field (0, negative, NaN) never throws or produces non-finite positions', () => {
    for (const bad of [0, -5, Number.NaN]) {
      const pool = new ClassicWeather(() => ({ width: bad, height: bad }), () => ({ x: 0, y: 0, width: bad, height: bad }));
      const look = new WeatherLook({ pin: { kind: 'storm', intensity: 1 } });
      expect(() => { for (let frame = 0; frame < 30; frame += 1) pool.apply(look.update(createWeatherView(), NOON, 16, false)); }, `size ${bad}`).not.toThrow();
    }
  });

  it('apply and destroy in any order: apply after destroy is a no-op, destroy twice is safe, layers leave their parents', () => {
    const pool = new ClassicWeather(() => ({ width: 800, height: 600 }), () => ({ x: 0, y: 0, width: 800, height: 600 }));
    const host = new Container();
    host.addChild(pool.cloudLayer, pool.rainLayer);
    const look = new WeatherLook({ pin: { kind: 'storm', intensity: 1 } });
    pool.apply(look.update(createWeatherView(), NOON, 16, false));
    pool.destroy();
    expect(host.children.length).toBe(0);
    expect(() => pool.apply(look.update(createWeatherView(), NOON, 16, false))).not.toThrow();
    expect(() => pool.destroy()).not.toThrow();
  });
});

describe('classic renderer: weather wiring under review', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetSettings(); });

  const make = () => {
    const renderer = new WorldRenderer(new ParkSession(null));
    renderer.syncWorld();
    const internals = renderer as unknown as { camera: Container; classicWeather: ClassicWeather; mounted: boolean };
    // A screen for the rain (the Application is not initialised in Node): the getter is replaced on the instance.
    Object.defineProperty(renderer.app, 'screen', { value: { width: 1280, height: 720 }, configurable: true });
    return { renderer, ...internals };
  };
  const positions = (pool: ClassicWeather): string => [...pool.cloudLayer.children, ...pool.rainLayer.children]
    .map((child) => `${child.x.toFixed(3)},${child.y.toFixed(3)},${child.visible}`).join('|');

  it('flash cap in the classic tint: at most 3 visible flashes in any second, at 1x and 4x, with no step larger than the rate limit allows', () => {
    for (const speed of [1, 4]) {
      const { renderer, camera } = make();
      renderer.setTimeOfDay(0);
      renderer.setWeather(stormView({ secondsIntoSegment: 0 }));
      let sim = 0;
      const samples: number[] = [];
      for (let frame = 0; frame < 60 * 300; frame += 1) {
        sim += speed / 60;
        renderer.setWeather(stormView({ secondsIntoSegment: sim }));
        renderer.update(1000 / 60, frame * (1000 / 60));
        samples.push(channels(camera.tint)[0]);
      }
      const settled = Math.min(...samples);
      const peak = Math.max(...samples);
      expect(peak, `speed ${speed}: the tint does lift on a flash`).toBeGreaterThan(settled + 10);
      expect(peak, 'a flash never goes full white at night').toBeLessThan(255);
      const counter = new FlashCounter(0, 0);
      const span = peak - settled;
      const detector = new FlashCounter(settled + 0.1 * span, settled + 0.4 * span);
      samples.forEach((value, frame) => detector.push(frame / 60, value));
      void counter;
      expect(detector.onsets.length, `speed ${speed}`).toBeGreaterThan(5);
      expect(detector.worstWindow, `speed ${speed}`).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
      // The amplitude of one frame's tint change stays below half the flash span: no instant full step.
      expect(detector.maxStep).toBeLessThanOrEqual(span * 0.6);
    }
  });

  it('paused: rain, clouds and tint are frozen to the last bit while sim time and pulses keep arriving', () => {
    const { renderer, camera, classicWeather } = make();
    renderer.setTimeOfDay(0);
    for (let frame = 0; frame < 60 * 6; frame += 1) {
      renderer.setWeather(stormView({ secondsIntoSegment: frame / 10 }));
      renderer.update(16, frame * 16);
    }
    renderer.setMachineryPaused(true);
    for (let frame = 0; frame < 120; frame += 1) {
      renderer.setWeather(stormView({ secondsIntoSegment: 40 + frame / 10 }));
      renderer.update(16, frame * 16);
    }
    const still = positions(classicWeather);
    const tint = camera.tint;
    for (let frame = 0; frame < 60 * 60; frame += 1) {
      renderer.setWeather(stormView({ secondsIntoSegment: 100 + frame / 3 }));
      renderer.update(16, frame * 16);
      expect(camera.tint).toBe(tint);
    }
    expect(positions(classicWeather)).toBe(still);
  });

  it('low and high intensity: more intensity means more streaks and more cloud, never fewer', () => {
    const countVisible = (intensity: number): { rain: number; clouds: number } => {
      const { renderer, classicWeather } = make();
      (renderer as unknown as { mounted: boolean }).mounted = true; // the rain reads the screen only when mounted
      renderer.setTimeOfDay(0.5);
      renderer.setWeather(viewOf('storm', intensity));
      for (let frame = 0; frame < 60 * 12; frame += 1) renderer.update(16, frame * 16);
      return {
        rain: classicWeather.rainLayer.children.filter((child) => child.visible).length,
        clouds: classicWeather.cloudLayer.children.filter((child) => child.visible).length,
      };
    };
    expect(countVisible(0).rain, 'intensity 0 draws no rain').toBe(0);
    let previous = { rain: 0, clouds: 0 };
    for (const intensity of [0.05, 0.25, 0.5, 0.75, 1]) {
      const now = countVisible(intensity);
      expect(now.rain, `rain at ${intensity}`).toBeGreaterThanOrEqual(previous.rain);
      expect(now.clouds, `clouds at ${intensity}`).toBeGreaterThanOrEqual(previous.clouds);
      previous = now;
    }
    expect(previous.rain).toBe(CLASSIC_RAIN_POOL);
  });

  it('hostile views never break the tint or the pool', () => {
    const { renderer, camera, classicWeather } = make();
    renderer.setTimeOfDay(0.3);
    for (const extra of [{ intensity: Number.NaN }, { intensity: 9 }, { kind: 'tornado' as WeatherKind }, { flashSeed: Number.NaN }]) {
      renderer.setWeather({ ...stormView(), ...extra });
      for (let frame = 0; frame < 120; frame += 1) renderer.update(16, frame * 16);
      expect(Number.isInteger(camera.tint) && camera.tint >= 0 && camera.tint <= 0xffffff).toBe(true);
      for (const child of [...classicWeather.cloudLayer.children, ...classicWeather.rainLayer.children]) {
        expect(Number.isFinite(child.x) && Number.isFinite(child.y)).toBe(true);
      }
    }
  });

  it('survives 10 session swaps during a storm with the same pooled display objects (renderer swap pattern)', () => {
    const { renderer, camera, classicWeather } = make();
    renderer.setTimeOfDay(0.5);
    renderer.setWeather(stormView());
    (renderer as unknown as { mounted: boolean }).mounted = true;
    for (let frame = 0; frame < 120; frame += 1) renderer.update(16, frame * 16);
    const pool = [...classicWeather.cloudLayer.children, ...classicWeather.rainLayer.children];
    const display = classicWeather.displayCount;
    for (let swap = 0; swap < 10; swap += 1) {
      renderer.setSession(new ParkSession(null));
      for (let frame = 0; frame < 30; frame += 1) renderer.update(16, frame * 16);
    }
    expect([...classicWeather.cloudLayer.children, ...classicWeather.rainLayer.children].every((child, i) => child === pool[i])).toBe(true);
    expect(classicWeather.displayCount).toBe(display);
    expect(Number.isFinite(camera.tint)).toBe(true);
    // The swap re-snaps the weather: the picture is the storm again on the next frame, not a fade from clear.
    renderer.update(16, 5_000);
    expect(classicWeather.cloudLayer.visible).toBe(true);
    (renderer as unknown as { mounted: boolean }).mounted = false;
  });

  it('after destroy, update and setWeather are harmless', () => {
    const { renderer } = make();
    (renderer as unknown as { mounted: boolean }).mounted = true;
    Object.defineProperty(renderer.app, 'destroy', { value: () => undefined, configurable: true });
    renderer.setWeather(stormView());
    renderer.update(16, 16);
    renderer.destroy();
    expect(() => { renderer.setWeather(stormView()); renderer.update(16, 32); renderer.destroy(); }).not.toThrow();
  });

  it('reduced motion on at construction: static clouds and rain, no tint pulses (storm, 5 minutes, 4x)', () => {
    updateSettings({ reducedMotion: 'on' });
    const { renderer, camera, classicWeather } = make();
    renderer.setTimeOfDay(0);
    renderer.setWeather(stormView());
    for (let frame = 0; frame < 60 * 8; frame += 1) renderer.update(16, frame * 16);
    const still = positions(classicWeather);
    const tint = camera.tint;
    let sim = 0;
    for (let frame = 0; frame < 60 * 300; frame += 1) {
      sim += 4 / 60;
      renderer.setWeather(stormView({ secondsIntoSegment: sim }));
      renderer.update(16, frame * 16);
      expect(camera.tint).toBe(tint);
    }
    expect(positions(classicWeather)).toBe(still);
  });

  // CONFIRMED DEFECT (medium): both renderers read prefers-reduced-motion once, in a field initialiser
  // (WorldRenderer.ts weatherLook/hintReducedMotion, VoxelRenderer.ts weatherLook). A player who turns
  // the OS setting on during a session keeps clouds drifting, rain falling and lightning flashing until
  // the page is reloaded. The media query fires a `change` event; nobody listens to it.
  it('a LIVE change of the reduced motion setting stops the motion without a reload', () => {
    const { renderer, camera, classicWeather } = make();
    renderer.setTimeOfDay(0);
    renderer.setWeather(stormView());
    for (let frame = 0; frame < 60 * 8; frame += 1) renderer.update(16, frame * 16);
    updateSettings({ reducedMotion: 'on' });
    for (let frame = 0; frame < 60 * 3; frame += 1) renderer.update(16, frame * 16);
    const still = positions(classicWeather);
    const tint = camera.tint;
    let sim = 0;
    for (let frame = 0; frame < 60 * 60; frame += 1) {
      sim += 4 / 60;
      renderer.setWeather(stormView({ secondsIntoSegment: sim }));
      renderer.update(16, frame * 16);
      expect(camera.tint).toBe(tint);
    }
    expect(positions(classicWeather)).toBe(still);
  });

  // CONFIRMED DEFECT (low): ClassicWeather is built by a field initialiser (a canvas Texture in a
  // browser) but WorldRenderer.destroy returns before `classicWeather.destroy()` when the renderer was
  // never mounted, and mount's "destroyed during init" branch destroys only the Application. A renderer
  // swap that destroys a not-yet-mounted classic renderer leaks the cloud texture.
  it('destroying a renderer that never mounted still releases the weather pool', () => {
    const { renderer, classicWeather } = make();
    renderer.destroy();
    const destroyedLayer = (classicWeather.cloudLayer as unknown as { destroyed?: boolean }).destroyed === true;
    expect(destroyedLayer).toBe(true);
  });
});
