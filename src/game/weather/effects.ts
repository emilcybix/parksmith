import { GAME_CONFIG } from '../config';
import type { ParkConditions, WeatherKind } from './types';

/**
 * Weather effect formulas (pure). Every factor is `1 + (value - 1) * e` and every bias `value * e`,
 * `e` being the effective intensity 0..1, so a drizzle nudges and a downpour bites. The tables
 * live in GAME_CONFIG.weather.effects.
 */

export const factorAt = (valueAtFullIntensity: number, intensity: number): number => (
  1 + (valueAtFullIntensity - 1) * intensity
);

export const arrivalFactorOf = (kind: WeatherKind, intensity: number): number => (
  factorAt(GAME_CONFIG.weather.effects.arrivalFactor[kind], intensity)
);

/** Percent change in arrivals the weather causes right now (negative = fewer), rounded. */
export const arrivalDeltaPercent = (kind: WeatherKind, intensity: number): number => (
  Math.round((arrivalFactorOf(kind, intensity) - 1) * 100)
);

/** Overwrites the weather-driven fields of `out` in place (no allocation). */
export const applyWeatherEffects = (out: ParkConditions, kind: WeatherKind, intensity: number): void => {
  const effects = GAME_CONFIG.weather.effects;
  const ride = effects.rideBias[kind];
  const service = effects.serviceBias[kind];
  out.weatherKind = kind;
  out.weatherIntensity = intensity;
  out.arrivalWeatherFactor = arrivalFactorOf(kind, intensity);
  out.stormActive = kind === 'storm' && intensity > 0 && effects.stormClosesOpenAir;
  out.thirstFactor = factorAt(effects.thirstFactor[kind], intensity);
  out.walkSpeedFactor = factorAt(effects.walkSpeedFactor[kind], intensity);
  out.coveredRideBonus = ride.covered * intensity;
  out.openAirRideBonus = ride.openAir * intensity;
  out.warmFoodBonus = service.warm * intensity;
  out.coldTreatBonus = service.cold * intensity;
  out.ambientWarmth = GAME_CONFIG.guestLife.warmth.neutral + GAME_CONFIG.guestLife.warmth.weatherShift[kind] * intensity;
};
