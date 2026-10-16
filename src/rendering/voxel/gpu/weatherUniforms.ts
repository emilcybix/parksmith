import type { WeatherEffects } from '../../weatherLook';

/**
 * The weather uniforms of the composite (compositeWeather.ts documents the layout), written only
 * when WeatherEffects.revision moved. `revision` only moves when a quantised value can change the
 * picture, so a calm sunny frame, a paused storm and a disabled sky write nothing: the GPU pays one
 * integer compare. Pure (plain arrays), so it is tested in Node without a GPU.
 */
export interface WeatherUniformTarget {
  uWxA: Float32Array;
  uWxB: Float32Array;
  uWxC: Float32Array;
  uWxD: Float32Array;
  uWxCloudTint: Float32Array;
  uWxRainTint: Float32Array;
}

/** Floats written by one `write`: the 22 of the design (4 x vec4 + 2 x vec3). */
export const WEATHER_UNIFORM_FLOATS = 22;

/** Writes every weather uniform from the effects (no allocation). */
export const writeWeatherUniforms = (target: WeatherUniformTarget, effects: Readonly<WeatherEffects>): void => {
  const a = target.uWxA;
  a[0] = effects.active ? 1 : 0;
  a[1] = effects.cloudCover;
  a[2] = effects.cloudStrength;
  a[3] = effects.wetness;
  const b = target.uWxB;
  b[0] = effects.rainDensity;
  b[1] = effects.rainSlant;
  b[2] = effects.puddle;
  b[3] = effects.shimmer;
  const c = target.uWxC;
  c[0] = effects.cloudOffsetX;
  c[1] = effects.cloudOffsetY;
  c[2] = effects.rainPhaseA;
  c[3] = effects.rainPhaseB;
  const d = target.uWxD;
  d[0] = effects.flash;
  d[1] = effects.shimmerPhase;
  d[2] = effects.ripple;
  d[3] = 0;
  for (let i = 0; i < 3; i += 1) {
    target.uWxCloudTint[i] = effects.cloudTint[i];
    target.uWxRainTint[i] = effects.rainTint[i];
  }
};

/** Remembers which revision the uniforms hold. */
export class WeatherUniformSync {
  private applied = Number.NaN;
  /** How many times `sync` wrote (diagnostics, tests). */
  writes = 0;

  /** Writes when `revision` differs from the applied one; returns whether it did. */
  sync(target: WeatherUniformTarget, effects: Readonly<WeatherEffects>, revision: number): boolean {
    if (revision === this.applied) return false;
    this.applied = revision;
    this.writes += 1;
    writeWeatherUniforms(target, effects);
    return true;
  }

  /** The next `sync` writes (a rebuilt pipeline). */
  invalidate(): void {
    this.applied = Number.NaN;
  }
}
