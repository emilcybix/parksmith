import { GAME_CONFIG } from '../config';
import type { ParkConditions } from './types';

/**
 * Climate (Phase 24): the constant, place-bound part of the park conditions. A biome's temperature (-1 cold ..
 * +1 hot, 0 = Meadow) shifts the service utility of warm food and cold treats, a little and always. The tables
 * are GAME_CONFIG.weather.climate. Pure: no allocation, no clock.
 */

/** What the weather owner is built with: the biome's column weights and its temperature. */
export interface ClimateInput {
  readonly mix: readonly number[];
  readonly temperature: number;
}

/** Meadow: every weight 1 and no climate term. */
export const NEUTRAL_CLIMATE: ClimateInput = Object.freeze({ mix: Object.freeze([1, 1, 1, 1, 1]), temperature: 0 });

export type ClimateBand = 'cold' | 'cool' | 'mild' | 'warm' | 'hot';

/** How a temperature is worded in the UI (the Park Pulse and the clock popover), by the configured thresholds. */
export const climateKindOf = (temperature: number): ClimateBand => {
  const pulse = GAME_CONFIG.weather.climate.pulse;
  if (temperature <= pulse.coldAt) return 'cold';
  if (temperature <= pulse.coolAt) return 'cool';
  if (temperature >= pulse.hotAt) return 'hot';
  if (temperature >= pulse.warmAt) return 'warm';
  return 'mild';
};

/**
 * Adds the climate to `out` in place, AFTER the weather effects (it also applies when the weather switch is
 * off: climate belongs to the place). Temperature 0 returns before touching anything, not even `+ 0`.
 */
export const applyClimate = (out: ParkConditions, temperature: number): void => {
  if (temperature === 0) return;
  out.ambientWarmth += GAME_CONFIG.guestLife.warmth.climateShift * temperature;
  const climate = GAME_CONFIG.weather.climate;
  if (temperature > 0) {
    out.coldTreatBonus += climate.heat.coldTreatBonus * temperature;
    out.warmFoodBonus -= climate.heat.warmFoodPenalty * temperature;
  } else {
    const cold = -temperature;
    out.warmFoodBonus += climate.cold.warmFoodBonus * cold;
    out.coldTreatBonus -= climate.cold.coldTreatPenalty * cold;
  }
};
