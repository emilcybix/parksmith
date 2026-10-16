import { describe, expect, it } from 'vitest';
import { BIOMES } from '../biomes/content';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { MAPS } from '../maps/content';
import { applyClimate, climateKindOf, NEUTRAL_CLIMATE } from './climate';
import { applyWeatherEffects } from './effects';
import { WEATHER_KINDS, neutralConditions } from './types';

describe('applyClimate (the cold effect and the heat effect)', () => {
  const climate = GAME_CONFIG.weather.climate;

  it('is declared small in GAME_CONFIG and the four formulas hold at -1, -0.4, 0, 0.5 and 1', () => {
    expect(climate).toEqual({
      heat: { coldTreatBonus: 5, warmFoodPenalty: 3 },
      cold: { warmFoodBonus: 8, coldTreatPenalty: 6 },
      pulse: { coldAt: -0.7, coolAt: -0.3, warmAt: 0.3, hotAt: 0.7 },
    });
    const at = (temperature: number) => {
      const out = neutralConditions();
      applyClimate(out, temperature);
      return { warm: out.warmFoodBonus, cold: out.coldTreatBonus };
    };
    expect(at(-1)).toEqual({ warm: 8, cold: -6 });
    expect(at(-0.4)).toEqual({ warm: 8 * 0.4, cold: -6 * 0.4 });
    expect(at(0)).toEqual({ warm: 0, cold: 0 });
    expect(at(0.5)).toEqual({ warm: -3 * 0.5, cold: 5 * 0.5 });
    expect(at(1)).toEqual({ warm: -3, cold: 5 });
  });

  it('temperature 0 leaves the object identical, field by field (not even + 0)', () => {
    for (const kind of WEATHER_KINDS) {
      const touched = neutralConditions();
      applyWeatherEffects(touched, kind, 0.7);
      const untouched = { ...touched };
      applyClimate(touched, 0);
      for (const key of Object.keys(untouched) as Array<keyof typeof untouched>) expect(Object.is(touched[key], untouched[key]), `${kind} ${key}`).toBe(true);
    }
    // -0 stays -0 and 0 stays 0: a weather kind with a negative bias times a zero intensity.
    const signed = neutralConditions();
    signed.warmFoodBonus = -0;
    applyClimate(signed, 0);
    expect(Object.is(signed.warmFoodBonus, -0)).toBe(true);
  });

  it('adds to the weather effects (after them), it does not replace them', () => {
    const out = neutralConditions();
    applyWeatherEffects(out, 'rain', 1);
    expect(out.warmFoodBonus).toBe(7);
    applyClimate(out, -1);
    expect(out.warmFoodBonus).toBe(15);
    expect(out.coldTreatBonus).toBe(-11);
  });

  it('words the climate by the pulse thresholds', () => {
    expect(climateKindOf(-1)).toBe('cold');
    expect(climateKindOf(-0.7)).toBe('cold');
    expect(climateKindOf(-0.4)).toBe('cool');
    expect(climateKindOf(-0.3)).toBe('cool');
    expect(climateKindOf(-0.29)).toBe('mild');
    expect(climateKindOf(0)).toBe('mild');
    expect(climateKindOf(0.2)).toBe('mild');
    expect(climateKindOf(0.3)).toBe('warm');
    expect(climateKindOf(0.5)).toBe('warm');
    expect(climateKindOf(0.7)).toBe('hot');
    expect(climateKindOf(1)).toBe('hot');
    expect(NEUTRAL_CLIMATE.temperature).toBe(0);
  });
});

describe('climate in a park', () => {
  const sessionOn = (mapId: (typeof MAPS)[number]['id']): ParkSession => new ParkSession(null, [], { mapId });

  it('Winter: warm food +8 and cold treats -6 even on a sunny first day; Desert: cold treats +5 and warm food -3', () => {
    const winter = sessionOn('frosted-hollow');
    winter.weather.step(0);
    expect(winter.weather.conditions.weatherKind).toBe('sunny');
    // Day 1 is a fixed sunny day at intensity 0.7: the sunny table adds cold +2 * 0.7.
    expect(winter.weather.conditions.warmFoodBonus).toBeCloseTo(8, 10);
    expect(winter.weather.conditions.coldTreatBonus).toBeCloseTo(2 * 0.7 - 6, 10);
    const desert = sessionOn('red-rock-canyon');
    desert.weather.step(0);
    expect(desert.weather.conditions.warmFoodBonus).toBeCloseTo(-3, 10);
    expect(desert.weather.conditions.coldTreatBonus).toBeCloseTo(2 * 0.7 + 5, 10);
    const meadow = new ParkSession(null);
    meadow.weather.step(0);
    expect(meadow.weather.conditions.warmFoodBonus).toBe(0);
    expect(meadow.weather.conditions.coldTreatBonus).toBeCloseTo(2 * 0.7, 12);
  });

  it('climate belongs to the place: it still applies with the weather switched off', () => {
    const winter = sessionOn('frosted-hollow');
    winter.setWeatherEnabled(false);
    winter.weather.step(0);
    expect(winter.weather.conditions.weatherIntensity).toBe(0);
    expect(winter.weather.conditions.warmFoodBonus).toBe(8);
    expect(winter.weather.conditions.coldTreatBonus).toBe(-6);
    const meadow = new ParkSession(null);
    meadow.setWeatherEnabled(false);
    meadow.weather.step(0);
    expect(meadow.weather.conditions.warmFoodBonus).toBe(0);
    expect(meadow.weather.conditions.coldTreatBonus).toBe(0);
  });

  it('every biome\'s temperature agrees with its climate word and the maps use it', () => {
    for (const map of MAPS) {
      const biome = BIOMES.find((candidate) => candidate.id === map.biome)!;
      const session = sessionOn(map.id);
      session.weather.step(0);
      const expectedWarm = biome.temperature === 0 ? 0 : biome.temperature > 0 ? -3 * biome.temperature : 8 * -biome.temperature;
      expect(session.weather.conditions.warmFoodBonus, map.id).toBeCloseTo(expectedWarm, 10);
    }
  });
});
