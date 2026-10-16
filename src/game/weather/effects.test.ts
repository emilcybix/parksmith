import { describe, expect, it } from 'vitest';
import { arrivalCurveAt } from '../calendar/arrivalCurve';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { arrivalDeltaPercent, arrivalFactorOf, factorAt } from './effects';
import { WEATHER_KINDS, neutralConditions, type WeatherSeverity } from './types';

const effects = GAME_CONFIG.weather.effects;

describe('weather effect formulas', () => {
  it('factorAt blends from neutral (e = 0) to the configured value (e = 1)', () => {
    expect(factorAt(0.65, 0)).toBe(1);
    expect(factorAt(0.65, 1)).toBeCloseTo(0.65, 12);
    expect(factorAt(0.65, 0.5)).toBeCloseTo(0.825, 12);
    expect(factorAt(1.35, 0.5)).toBeCloseTo(1.175, 12);
  });

  it('every kind at e = 0, 0.5 and 1 and every severity gives exactly the configured numbers in the conditions', () => {
    const severities: WeatherSeverity[] = ['low', 'normal', 'high'];
    for (const kind of WEATHER_KINDS) {
      for (const severity of severities) {
        for (const drawn of [0, 0.5, 1]) {
          const session = new ParkSession(null);
          session.setWeatherSeverity(severity);
          session.weather.forceCurrentSlot(kind, drawn);
          const e = Math.min(1, drawn * GAME_CONFIG.weather.severityScale[severity]);
          const c = session.weather.conditions;
          const label = `${kind} ${severity} ${drawn}`;
          expect(c.weatherKind, label).toBe(kind);
          expect(c.weatherIntensity, label).toBeCloseTo(e, 12);
          expect(c.arrivalWeatherFactor, label).toBeCloseTo(1 + (effects.arrivalFactor[kind] - 1) * e, 12);
          expect(c.thirstFactor, label).toBeCloseTo(1 + (effects.thirstFactor[kind] - 1) * e, 12);
          expect(c.walkSpeedFactor, label).toBeCloseTo(1 + (effects.walkSpeedFactor[kind] - 1) * e, 12);
          expect(c.coveredRideBonus, label).toBeCloseTo(effects.rideBias[kind].covered * e, 12);
          expect(c.openAirRideBonus, label).toBeCloseTo(effects.rideBias[kind].openAir * e, 12);
          expect(c.warmFoodBonus, label).toBeCloseTo(effects.serviceBias[kind].warm * e, 12);
          expect(c.coldTreatBonus, label).toBeCloseTo(effects.serviceBias[kind].cold * e, 12);
          expect(c.stormActive, label).toBe(kind === 'storm' && e > 0);
        }
      }
    }
  });

  it('the effects point the way the design says', () => {
    expect(effects.arrivalFactor.rain).toBeLessThan(1);
    expect(effects.arrivalFactor.storm).toBeLessThan(effects.arrivalFactor.rain);
    expect(effects.thirstFactor.hot).toBeGreaterThan(1);
    expect(effects.walkSpeedFactor.hot).toBeLessThan(1);
    expect(effects.rideBias.rain.covered).toBeGreaterThan(effects.rideBias.rain.openAir);
    expect(effects.serviceBias.rain.warm).toBeGreaterThan(effects.serviceBias.rain.cold);
    expect(effects.serviceBias.hot.cold).toBeGreaterThan(effects.serviceBias.hot.warm);
    for (const kind of WEATHER_KINDS) expect(effects.walkSpeedFactor[kind]).toBeGreaterThan(0.8);
  });

  it('arrival delta percent is the rounded change the factor causes', () => {
    expect(arrivalDeltaPercent('rain', 1)).toBe(-35);
    expect(arrivalDeltaPercent('sunny', 1)).toBe(8);
    expect(arrivalDeltaPercent('cloudy', 1)).toBe(0);
    expect(arrivalFactorOf('storm', 0)).toBe(1);
  });
});

describe('ParkConditions', () => {
  it('is one object whose keys never change, for the whole life of the session', () => {
    const session = new ParkSession(null);
    const conditions = session.weather.conditions;
    const keys = Object.keys(conditions).sort();
    expect(keys).toEqual(Object.keys(neutralConditions()).sort());
    for (let tick = 0; tick < 10_000; tick += 1) session.weather.step(tick * 7);
    expect(session.weather.conditions).toBe(conditions);
    expect(Object.keys(conditions).sort()).toEqual(keys);
  });

  it('weather and the curve together leave the long-run arrival rate within 3 % of neutral', () => {
    const session = new ParkSession(null);
    let total = 0;
    let samples = 0;
    // 600 days sampled every half hour of park time: curve times weather factor, gate open.
    for (let tick = 0; tick < 600 * 7_200; tick += 150) {
      session.weather.step(tick);
      total += session.weather.conditions.arrivalRate;
      samples += 1;
    }
    expect(total / samples).toBeGreaterThan(0.97);
    expect(total / samples).toBeLessThan(1.03);
  });

  it('refreshing twice at the same tick changes nothing (conditions are a pure function of saved state)', () => {
    const session = new ParkSession(null);
    session.weather.step(9_999);
    const once = { ...session.weather.conditions };
    session.weather.refresh(9_999);
    session.weather.refresh(9_999);
    expect(session.weather.conditions).toEqual(once);
  });

  it('arrival rate is the curve at the clock hour times the weather factor, zero when the schedule is closed', () => {
    const session = new ParkSession(null);
    session.weather.setEnabled(false);
    session.weather.step(0);
    expect(session.weather.conditions.arrivalRate).toBeCloseTo(arrivalCurveAt(6), 12);
    session.setOpeningHours(true, 8, 21);
    session.weather.step(0);
    expect(session.weather.conditions.scheduleOpen).toBe(false);
    expect(session.weather.conditions.arrivalRate).toBe(0);
  });
});
