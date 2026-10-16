import { createStormFlash, stormFlashAt } from '../game/weather/flash';
import { WEATHER_KINDS, type WeatherKind, type WeatherView } from '../game/weather/types';
import type { DayWeights } from './dayCycle';
import type { PresentationPrefs } from '../settings/motion';
import type { WeatherEffects as WeatherEffectsLevel } from '../settings/schema';

/**
 * The renderer-neutral weather look (Phase 20 step 3): a pure function of the typed weather view,
 * the time-of-day weights and a few presentation flags, shared by the voxel and the classic renderer.
 * Presentation only: it reads the simulation and nothing flows back.
 *
 * Flow per frame: view -> target drivers (kind x intensity) -> slewed drivers (eased on REAL time, so
 * every discontinuity, a slot edge, a load, a sandbox switch, a pin, fades instead of popping) ->
 * effects (plain quantised numbers) that the renderers turn into pixels or a tint. `effects` is ONE
 * reused object; `revision` moves only when a quantised value moved, so a calm or paused frame is
 * detectably unchanged and the renderers write nothing.
 *
 * Time bases. The animation clock (cloud drift, rain fall, shimmer) is real time, frozen while the
 * game is paused or under reduced motion. Sim time (`view.secondsIntoSegment`) only decides
 * WHEN a storm flashes.
 *
 * PHOTOSENSITIVITY CAP (documented in ARCHITECTURE.md too). Lightning is the only flashing effect:
 *  1. `FlashLimiter` counts pulse onsets in REAL time and admits at most `MAX_FLASHES_PER_SECOND` (3)
 *     in any one second window (WCAG 2.3.1 "three flashes or fewer"), whatever the game speed; a
 *     suppressed pulse stays dark until it ends.
 *  2. The level is rate limited (rise <= 12/s, fall <= 6/s), so there is never an instant full step.
 *  3. The renderers cap the lift at a fraction of the lit colour (never full white) and it is global
 *     and soft, not a strobing area.
 *  4. A paused game and reduced motion show no flash at all.
 */

/** Photosensitivity cap: lightning pulses admitted per real second. */
export const MAX_FLASHES_PER_SECOND = 3;
/** Cloud offsets wrap here (the cloud noise period, in voxels). */
export const CLOUD_WRAP_VOXELS = 448;
/** Rain and shimmer phases wrap here (rows). */
export const RAIN_WRAP_ROWS = 4096;

/** Presentation-only pin of the weather picture (the `&weather=` flag); the simulation is untouched. */
export interface WeatherPin {
  kind: WeatherKind;
  /** 0..1 */
  intensity: number;
}

export interface WeatherLookFlags {
  /** Effective reduced motion (src/settings/motion.ts), pushed by the owner through `setPresentation`. */
  reducedMotion: boolean;
  /** Weather effects level (the player's presentation-only switch, independent of the sandbox weather). */
  level: WeatherEffectsLevel;
  /** Lightning flashes on/off (photosensitivity); still capped by the limiter. */
  flashes: boolean;
  /** `&weather=` / `&wintensity=`: overrides the view (also when the sandbox weather is off). */
  pin: WeatherPin | null;
  /** `&wclock=`: the animation clock is frozen at this value (deterministic screenshots). */
  fixedClockSeconds: number | null;
  /** `&wmotion=run`: the animation clock ignores pause (dev). */
  runWhilePaused: boolean;
  /** `&wflash=0..1`: constant flash level, bypassing the limiter (dev). */
  flashPin: number | null;
}

export const DEFAULT_WEATHER_FLAGS: Readonly<WeatherLookFlags> = Object.freeze({
  reducedMotion: false,
  level: 'full' as WeatherEffectsLevel,
  flashes: true,
  pin: null,
  fixedClockSeconds: null,
  runWhilePaused: false,
  flashPin: null,
});

/** Slewed drivers 0..1, all exactly 0 for a clear sky: the continuous state the look is a function of. */
export interface WeatherDrivers {
  cover: number;
  shade: number;
  rain: number;
  wet: number;
  heat: number;
  gloom: number;
  storm: number;
}

export const createWeatherDrivers = (): WeatherDrivers => ({ cover: 0, shade: 0, rain: 0, wet: 0, heat: 0, gloom: 0, storm: 0 });

/** Driver values at intensity 1 (wet is table * min(1, 2 * intensity)). */
export const WEATHER_DRIVER_TABLE: Readonly<Record<WeatherKind, Readonly<WeatherDrivers>>> = {
  sunny: { cover: 0.22, shade: 0.3, rain: 0, wet: 0, heat: 0, gloom: 0, storm: 0 },
  hot: { cover: 0.06, shade: 0.22, rain: 0, wet: 0, heat: 1, gloom: 0, storm: 0 },
  cloudy: { cover: 0.75, shade: 0.22, rain: 0, wet: 0, heat: 0, gloom: 0.35, storm: 0 },
  rain: { cover: 0.9, shade: 0.26, rain: 0.75, wet: 1, heat: 0, gloom: 0.6, storm: 0 },
  storm: { cover: 1, shade: 0.32, rain: 1, wet: 1, heat: 0, gloom: 1, storm: 1 },
};

const clamp01 = (value: number): number => (value > 0 ? (value < 1 ? value : 1) : 0);

/** Pure target drivers; intensity 0 or `!enabled` gives exactly all zeros. Monotone in intensity per kind. */
export const weatherTargetDrivers = (enabled: boolean, kind: WeatherKind, intensity: number, out: WeatherDrivers): WeatherDrivers => {
  const amount = enabled && Number.isFinite(intensity) ? clamp01(intensity) : 0;
  const row = WEATHER_DRIVER_TABLE[kind] ?? WEATHER_DRIVER_TABLE.sunny;
  out.cover = row.cover * amount;
  out.shade = row.shade * amount;
  out.rain = row.rain * amount;
  out.wet = row.wet * Math.min(1, 2 * amount);
  out.heat = row.heat * amount;
  out.gloom = row.gloom * amount;
  out.storm = row.storm * amount;
  return out;
};

const SLEW_RATE = 0.25;
const WET_UP_RATE = 0.12;
const WET_DOWN_RATE = 0.03;
const MAX_DT_SECONDS = 0.1;

const slewOne = (current: number, target: number, step: number): number => {
  if (current < target) return Math.min(target, current + step);
  if (current > target) return Math.max(target, current - step);
  return current;
};

/** Moves `drivers` toward `target` by at most rate * dt per field; reaches it exactly. True when anything moved. */
export const slewDrivers = (drivers: WeatherDrivers, target: Readonly<WeatherDrivers>, dtSeconds: number): boolean => {
  const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? Math.min(dtSeconds, MAX_DT_SECONDS) : 0;
  const step = SLEW_RATE * dt;
  const wetStep = (target.wet > drivers.wet ? WET_UP_RATE : WET_DOWN_RATE) * dt;
  const previous = drivers.cover + drivers.shade * 2 + drivers.rain * 3 + drivers.wet * 5 + drivers.heat * 7 + drivers.gloom * 11 + drivers.storm * 13;
  if (drivers.cover === target.cover && drivers.shade === target.shade && drivers.rain === target.rain && drivers.wet === target.wet
    && drivers.heat === target.heat && drivers.gloom === target.gloom && drivers.storm === target.storm) return false;
  drivers.cover = slewOne(drivers.cover, target.cover, step);
  drivers.shade = slewOne(drivers.shade, target.shade, step);
  drivers.rain = slewOne(drivers.rain, target.rain, step);
  drivers.wet = slewOne(drivers.wet, target.wet, wetStep);
  drivers.heat = slewOne(drivers.heat, target.heat, step);
  drivers.gloom = slewOne(drivers.gloom, target.gloom, step);
  drivers.storm = slewOne(drivers.storm, target.storm, step);
  const next = drivers.cover + drivers.shade * 2 + drivers.rain * 3 + drivers.wet * 5 + drivers.heat * 7 + drivers.gloom * 11 + drivers.storm * 13;
  return next !== previous;
};

/** What both renderers read. Plain numbers, one reused instance, quantised so `revision` moves only when the picture can. */
export interface WeatherEffects {
  /** Any effect > 0; renderers skip all weather work when false. */
  active: boolean;
  /** Bumped when any field below (except `modifiers`, which has its own revision) changed after quantising. */
  revision: number;
  /** 0..1 coverage threshold. */
  cloudCover: number;
  /** 0..0.4 max shadow mix, already scaled by time of day (little at night). */
  cloudStrength: number;
  /** Voxels, quarter steps, wrapped to [0, CLOUD_WRAP_VOXELS). */
  cloudOffsetX: number;
  cloudOffsetY: number;
  /** Shadow multiply colour, every channel >= 0.78. */
  cloudTint: [number, number, number];
  /** 0..1 (reduced motion: <= 0.35). */
  rainDensity: number;
  /** Columns per row, 0.25 rain .. 0.5 storm. */
  rainSlant: number;
  /** Integer rows, wrapped (0 under reduced motion). */
  rainPhaseA: number;
  rainPhaseB: number;
  /** Streak colour, scaled by the ambient brightness of the day look; zero without rain. */
  rainTint: [number, number, number];
  /** 0..1 darken/saturate ground top faces. */
  wetness: number;
  /** 0..1 puddle radius/strength. */
  puddle: number;
  /** 0..1 puddle rings (0 under reduced motion). */
  ripple: number;
  /** 0..0.5; 0 under reduced motion and outside a hot day. */
  shimmer: number;
  /** Integer rows, wrapped. */
  shimmerPhase: number;
  /** 0..1 lightning level, capped and rate limited, quantised 1/16. */
  flash: number;
  /** 0..1, time-of-day scaled, for the classic tint. */
  gloom: number;
  /** Grade modifiers for the voxel day look (identity at clear). */
  modifiers: { exposureScale: number; saturationScale: number; ambientScale: number; tintMul: [number, number, number] };
  /** Bumped when `modifiers` changed after quantising. */
  modifiersRevision: number;
}

export const createWeatherEffects = (): WeatherEffects => ({
  active: false,
  revision: 0,
  cloudCover: 0,
  cloudStrength: 0,
  cloudOffsetX: 0,
  cloudOffsetY: 0,
  cloudTint: [1, 1, 1],
  rainDensity: 0,
  rainSlant: 0.25,
  rainPhaseA: 0,
  rainPhaseB: 0,
  rainTint: [0, 0, 0],
  wetness: 0,
  puddle: 0,
  ripple: 0,
  shimmer: 0,
  shimmerPhase: 0,
  flash: 0,
  gloom: 0,
  modifiers: { exposureScale: 1, saturationScale: 1, ambientScale: 1, tintMul: [1, 1, 1] },
  modifiersRevision: 0,
});

// Quantisation: scalar fields to 1/100 (so the documented floors are exact values), flash to 1/16.
const q100 = (value: number): number => Math.round(value * 100) / 100;
const q16 = (value: number): number => Math.round(value * 16) / 16;

const CLOUD_TINT_BASE = [0.82, 0.87, 1.0] as const;
const RAIN_TINT_BASE = [0.85, 0.93, 1.0] as const;

/**
 * The pure mapping from drivers and time of day to every NON-animated effect field (and `active`
 * without flash). Writes into `out` (no allocation); leaves offsets, phases, flash and revisions alone.
 */
export const weatherEffectsFrom = (drivers: Readonly<WeatherDrivers>, weights: Readonly<DayWeights>, out: WeatherEffects): WeatherEffects => {
  const sun = clamp01(weights.day + 0.45 * weights.dusk + 0.12 * weights.night);
  const lum = weights.day + 0.8 * weights.dusk + 0.45 * weights.night;
  const gloomScale = weights.day + 0.6 * weights.dusk + 0.25 * weights.night;
  const g = drivers.gloom * gloomScale;
  const h = drivers.heat * weights.day;

  out.cloudCover = q100(drivers.cover);
  const strength = drivers.shade * sun;
  out.cloudStrength = q100(strength);
  const t = clamp01(out.cloudStrength / 0.4);
  for (let i = 0; i < 3; i += 1) out.cloudTint[i] = q100(1 + (CLOUD_TINT_BASE[i] - 1) * t);

  out.rainDensity = q100(drivers.rain);
  out.rainSlant = q100(0.25 + 0.25 * drivers.storm);
  const rainScale = 0.4 + 0.42 * lum;
  for (let i = 0; i < 3; i += 1) out.rainTint[i] = out.rainDensity > 0 ? q100(rainScale * RAIN_TINT_BASE[i]) : 0;

  out.wetness = q100(drivers.wet);
  out.puddle = q100(drivers.wet * (0.4 + 0.6 * drivers.rain));
  out.ripple = q100(drivers.rain * drivers.wet);
  out.shimmer = q100(0.5 * h);
  out.gloom = q100(g);

  const m = out.modifiers;
  m.exposureScale = q100(1 - 0.14 * g + 0.03 * h);
  // Gloom dims the lit colour (exposure, ambient), so saturation is LIFTED to keep the chroma: measured at noon,
  // the same pixels keep their HSV saturation and lose value only; the lift stops the candy ground reading as grey.
  m.saturationScale = q100(1 + 0.12 * g);
  m.ambientScale = q100(1 - 0.1 * g);
  m.tintMul[0] = q100(1 - 0.07 * g + 0.02 * h);
  m.tintMul[1] = q100(1 - 0.03 * g);
  m.tintMul[2] = q100(1 - 0.05 * h);

  out.active = out.cloudStrength > 0 || out.rainDensity > 0 || out.wetness > 0 || out.puddle > 0 || out.shimmer > 0 || out.gloom > 0
    || m.exposureScale !== 1 || m.saturationScale !== 1 || m.ambientScale !== 1
    || m.tintMul[0] !== 1 || m.tintMul[1] !== 1 || m.tintMul[2] !== 1;
  return out;
};

/** 'Weather: Reduced' keeps the motion but slows it and drops the harsh parts. */
const CALM_RAIN_DENSITY = 0.5;
const CALM_WIND_FACTOR = 0.5;
const CALM_RAIN_FALL_FACTOR = 0.6;

/**
 * Pure in-place calmer-weather mapping for 'Weather: Reduced': lighter rain, no flash, no shimmer,
 * no puddle rings. Gloom, wetness and cloud shadow stay, so the park keeps its colour.
 */
export const applyCalmWeather = (effects: WeatherEffects): void => {
  effects.rainDensity = effects.rainDensity < REDUCED_RAIN_FLOOR ? 0 : Math.min(effects.rainDensity, CALM_RAIN_DENSITY);
  if (effects.rainDensity === 0) {
    effects.rainTint[0] = 0;
    effects.rainTint[1] = 0;
    effects.rainTint[2] = 0;
  }
  effects.flash = 0;
  effects.shimmer = 0;
  effects.shimmerPhase = 0;
  effects.ripple = 0;
};

/** The flag subset the player's presentation preferences own. */
export const presentationFlags = (prefs: Readonly<PresentationPrefs>): Pick<WeatherLookFlags, 'reducedMotion' | 'level' | 'flashes'> => ({
  reducedMotion: prefs.reducedMotion,
  level: prefs.weatherEffects,
  flashes: prefs.lightningFlashes,
});

const REDUCED_RAIN_DENSITY = 0.35;
const REDUCED_RAIN_FLOOR = 0.05;

/**
 * Pure in-place reduced-motion mapping: clouds stand still at offset 0, rain becomes a static light
 * texture (or off when it is faint), no flash, no shimmer, no puddle rings. Wetness, puddles, gloom
 * and cloud shadow are not motion and stay.
 */
export const applyReducedMotion = (effects: WeatherEffects): void => {
  effects.cloudOffsetX = 0;
  effects.cloudOffsetY = 0;
  effects.rainPhaseA = 0;
  effects.rainPhaseB = 0;
  effects.rainDensity = effects.rainDensity < REDUCED_RAIN_FLOOR ? 0 : Math.min(effects.rainDensity, REDUCED_RAIN_DENSITY);
  if (effects.rainDensity === 0) {
    effects.rainTint[0] = 0;
    effects.rainTint[1] = 0;
    effects.rainTint[2] = 0;
  }
  effects.flash = 0;
  effects.shimmer = 0;
  effects.shimmerPhase = 0;
  effects.ripple = 0;
};

/**
 * Real-time lightning limiter. Feed it the raw flash strength every frame; it returns the strength
 * or 0 when the cap suppresses the current pulse. A pulse is an excursion above `ONSET` that lasts until the strength is exactly 0; at most
 * `MAX_FLASHES_PER_SECOND` onsets are admitted in any one second window.
 */
export class FlashLimiter {
  private static readonly ONSET = 0.05;
  private readonly onsets = new Float64Array(MAX_FLASHES_PER_SECOND);
  private count = 0;
  private head = 0;
  private active = false;
  private suppressed = false;
  private last = -Infinity;

  admit(nowSeconds: number, strength: number): number {
    if (nowSeconds < this.last) this.reset();
    this.last = nowSeconds;
    if (!(strength > 0)) {
      // The pulse is over (the sim returns exactly 0 between pulses).
      this.active = false;
      this.suppressed = false;
      return 0;
    }
    // A faint start below ONSET is not yet a pulse; once one is running it lasts until strength is 0.
    if (!this.active && strength <= FlashLimiter.ONSET) return strength;
    if (!this.active) {
      this.active = true;
      const oldest = this.count < MAX_FLASHES_PER_SECOND ? -Infinity : this.onsets[this.head];
      // Strictly more than a second after the oldest of the last three onsets: a closed one second
      // window can then never hold a fourth.
      if (nowSeconds - oldest > 1) {
        this.onsets[this.head] = nowSeconds;
        this.head = (this.head + 1) % MAX_FLASHES_PER_SECOND;
        if (this.count < MAX_FLASHES_PER_SECOND) this.count += 1;
        this.suppressed = false;
      } else {
        this.suppressed = true;
      }
    }
    return this.suppressed ? 0 : strength;
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
    this.active = false;
    this.suppressed = false;
    this.last = -Infinity;
  }
}

const FLASH_RISE_PER_SECOND = 12;
const FLASH_FALL_PER_SECOND = 6;
const PIN_FLASH_SEED = 0x9e3779b1;
const WIND_DIR_X = 0.87;
const WIND_DIR_Y = 0.5;
const SHIMMER_ROWS_PER_SECOND = 8;
const SIGNATURE_LENGTH = 24;

const wrap = (value: number, period: number): number => {
  const r = value % period;
  return r < 0 ? r + period : r;
};

/**
 * One per renderer. `update` is allocation-free and returns the reused `effects` object.
 */
export class WeatherLook {
  readonly effects: Readonly<WeatherEffects>;
  private readonly out = createWeatherEffects();
  private readonly flags: WeatherLookFlags;
  private readonly drivers = createWeatherDrivers();
  private readonly target = createWeatherDrivers();
  private readonly limiter = new FlashLimiter();
  private readonly flashScratch = createStormFlash();
  private readonly signature = new Float64Array(SIGNATURE_LENGTH);
  private readonly lastSignature = new Float64Array(SIGNATURE_LENGTH);
  private readonly modifierSignature = new Float64Array(6);
  private readonly lastModifierSignature = new Float64Array(6);
  private snap = true;
  private haveSignature = false;
  private realSeconds = 0;
  private animSeconds = 0;
  private cloudX = 0;
  private cloudY = 0;
  private phaseA = 0;
  private phaseB = 0;
  private phaseShimmer = 0;
  private flashLevel = 0;

  /** Live change of the player's presentation preferences; takes effect on the next update. */
  setPresentation(prefs: Readonly<PresentationPrefs>): void {
    this.flags.reducedMotion = prefs.reducedMotion;
    this.flags.level = prefs.weatherEffects;
    this.flags.flashes = prefs.lightningFlashes;
  }

  constructor(flags: Partial<WeatherLookFlags> = {}) {
    this.flags = { ...DEFAULT_WEATHER_FLAGS, ...flags };
    this.effects = this.out;
  }

  update(view: Readonly<WeatherView>, weights: Readonly<DayWeights>, dtMs: number, paused: boolean): Readonly<WeatherEffects> {
    const flags = this.flags;
    const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs / 1000, MAX_DT_SECONDS) : 0;
    this.realSeconds += dt;

    // 'Off' is the player's own switch: it beats the `&weather=` test pin and never reaches the simulation.
    const off = flags.level === 'off';
    const pin = off ? null : flags.pin;
    const enabled = off ? false : pin !== null ? true : view.enabled;
    const kind = pin !== null ? pin.kind : view.kind;
    const intensity = pin !== null ? pin.intensity : view.intensity;
    weatherTargetDrivers(enabled, kind, intensity, this.target);
    const drivers = this.drivers;
    if (this.snap) {
      drivers.cover = this.target.cover;
      drivers.shade = this.target.shade;
      drivers.rain = this.target.rain;
      drivers.wet = this.target.wet;
      drivers.heat = this.target.heat;
      drivers.gloom = this.target.gloom;
      drivers.storm = this.target.storm;
      this.snap = false;
    } else {
      slewDrivers(drivers, this.target, dt);
    }

    const animating = !paused || flags.runWhilePaused;
    const motion = animating && !flags.reducedMotion;
    const fixed = flags.fixedClockSeconds;
    if (fixed !== null) this.animSeconds = fixed;
    else if (motion) this.animSeconds += dt;

    const calm = flags.level === 'reduced';
    const windSpeed = (0.35 + 0.85 * drivers.storm) * (calm ? CALM_WIND_FACTOR : 1);
    const rainSpeed = (28 + 24 * drivers.storm) * (calm ? CALM_RAIN_FALL_FACTOR : 1);
    if (fixed !== null) {
      this.cloudX = drivers.cover > 0 ? fixed * windSpeed * WIND_DIR_X : 0;
      this.cloudY = drivers.cover > 0 ? fixed * windSpeed * WIND_DIR_Y : 0;
      this.phaseA = drivers.rain > 0 ? fixed * rainSpeed : 0;
      this.phaseB = drivers.rain > 0 ? fixed * rainSpeed * 0.8 : 0;
      this.phaseShimmer = drivers.heat > 0 ? fixed * SHIMMER_ROWS_PER_SECOND : 0;
    } else if (motion) {
      if (drivers.cover > 0) {
        this.cloudX = wrap(this.cloudX + windSpeed * WIND_DIR_X * dt, CLOUD_WRAP_VOXELS);
        this.cloudY = wrap(this.cloudY + windSpeed * WIND_DIR_Y * dt, CLOUD_WRAP_VOXELS);
      }
      if (drivers.rain > 0) {
        this.phaseA = wrap(this.phaseA + rainSpeed * dt, RAIN_WRAP_ROWS);
        this.phaseB = wrap(this.phaseB + rainSpeed * 0.8 * dt, RAIN_WRAP_ROWS);
      }
      if (drivers.heat > 0) this.phaseShimmer = wrap(this.phaseShimmer + SHIMMER_ROWS_PER_SECOND * dt, RAIN_WRAP_ROWS);
    }

    const out = this.out;
    weatherEffectsFrom(drivers, weights, out);
    out.cloudOffsetX = Math.floor(wrap(this.cloudX, CLOUD_WRAP_VOXELS) * 4) / 4;
    out.cloudOffsetY = Math.floor(wrap(this.cloudY, CLOUD_WRAP_VOXELS) * 4) / 4;
    out.rainPhaseA = Math.floor(wrap(this.phaseA, RAIN_WRAP_ROWS));
    out.rainPhaseB = Math.floor(wrap(this.phaseB, RAIN_WRAP_ROWS));
    out.shimmerPhase = Math.floor(wrap(this.phaseShimmer, RAIN_WRAP_ROWS));

    this.updateFlash(view, kind, intensity, pin !== null, animating, dt);
    out.flash = q16(this.flashLevel);

    if (flags.level === 'reduced' && !flags.reducedMotion) applyCalmWeather(out);
    if (flags.reducedMotion) applyReducedMotion(out);
    if (out.flash > 0) out.active = true;
    this.publishRevisions();
    return out;
  }

  private updateFlash(view: Readonly<WeatherView>, kind: WeatherKind, intensity: number, pinned: boolean, animating: boolean, dt: number): void {
    const flags = this.flags;
    if (flags.flashPin !== null && flags.level !== 'off') {
      this.flashLevel = clamp01(flags.flashPin);
      return;
    }
    let raw = 0;
    if (kind === 'storm' && this.drivers.storm > 0.5 && animating && !flags.reducedMotion
      && flags.level === 'full' && flags.flashes) {
      const seed = pinned ? PIN_FLASH_SEED : view.flashSeed;
      const seconds = pinned ? this.animSeconds : view.secondsIntoSegment;
      raw = stormFlashAt(seed, seconds, this.flashScratch).strength * (0.55 + 0.45 * clamp01(intensity));
    }
    const admitted = this.limiter.admit(this.realSeconds, raw);
    const level = this.flashLevel;
    this.flashLevel = admitted > level
      ? Math.min(admitted, level + FLASH_RISE_PER_SECOND * dt)
      : Math.max(admitted, level - FLASH_FALL_PER_SECOND * dt);
    if (this.flashLevel > 1) this.flashLevel = 1;
  }

  private publishRevisions(): void {
    const out = this.out;
    const s = this.signature;
    s[0] = out.active ? 1 : 0;
    s[1] = out.cloudCover;
    s[2] = out.cloudStrength;
    s[3] = out.cloudOffsetX;
    s[4] = out.cloudOffsetY;
    s[5] = out.cloudTint[0];
    s[6] = out.cloudTint[1];
    s[7] = out.cloudTint[2];
    s[8] = out.rainDensity;
    s[9] = out.rainSlant;
    s[10] = out.rainPhaseA;
    s[11] = out.rainPhaseB;
    s[12] = out.rainTint[0];
    s[13] = out.rainTint[1];
    s[14] = out.rainTint[2];
    s[15] = out.wetness;
    s[16] = out.puddle;
    s[17] = out.ripple;
    s[18] = out.shimmer;
    s[19] = out.shimmerPhase;
    s[20] = out.flash;
    s[21] = out.gloom;
    let changed = !this.haveSignature;
    for (let i = 0; i < SIGNATURE_LENGTH; i += 1) {
      if (s[i] !== this.lastSignature[i]) {
        changed = true;
        this.lastSignature[i] = s[i];
      }
    }
    if (changed) out.revision += 1;

    const m = out.modifiers;
    const ms = this.modifierSignature;
    ms[0] = m.exposureScale;
    ms[1] = m.saturationScale;
    ms[2] = m.ambientScale;
    ms[3] = m.tintMul[0];
    ms[4] = m.tintMul[1];
    ms[5] = m.tintMul[2];
    let modifiersChanged = !this.haveSignature;
    for (let i = 0; i < 6; i += 1) {
      if (ms[i] !== this.lastModifierSignature[i]) {
        modifiersChanged = true;
        this.lastModifierSignature[i] = ms[i];
      }
    }
    if (modifiersChanged) out.modifiersRevision += 1;
    this.haveSignature = true;
  }

  /** The next `update` snaps the drivers to their targets (setSession, context restore). */
  reset(): void {
    this.snap = true;
    this.flashLevel = 0;
    this.limiter.reset();
  }
}

const DEFAULT_PIN_INTENSITY = 0.8;
const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

const parseNumber = (value: string | null): number | null => {
  if (value === null || !NUMBER_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Pure parser for the weather testing flags (they pin the PRESENTATION only):
 * `&weather=sunny|hot|cloudy|rain|storm` with `&wintensity=0..1` (default 0.8, clamped, junk gives
 * the default), `&wclock=<seconds>` (>= 0), `&wmotion=run`, `&wflash=0..1` (clamped). Invalid values
 * are ignored, so the result only holds the keys that were valid.
 */
export const parseWeatherFlags = (search: string): Partial<WeatherLookFlags> => {
  const parameters = new URLSearchParams(search);
  const flags: Partial<WeatherLookFlags> = {};
  const kind = parameters.get('weather');
  if (kind !== null && (WEATHER_KINDS as readonly string[]).includes(kind)) {
    const intensity = parseNumber(parameters.get('wintensity'));
    flags.pin = { kind: kind as WeatherKind, intensity: intensity === null ? DEFAULT_PIN_INTENSITY : clamp01(intensity) };
  }
  const clock = parseNumber(parameters.get('wclock'));
  if (clock !== null && clock >= 0) flags.fixedClockSeconds = clock;
  if (parameters.get('wmotion') === 'run') flags.runWhilePaused = true;
  const flash = parseNumber(parameters.get('wflash'));
  if (flash !== null) flags.flashPin = clamp01(flash);
  return flags;
};
