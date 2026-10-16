import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import { createDayWeights, dayWeights } from './dayCycle';

const at = (hour: number) => ({ ...dayWeights(createDayWeights(), hour / 24) });
const MINUTES = 1440;

describe('look keys (data)', () => {
  const keys = GAME_CONFIG.calendar.lookKeys;

  it('are sorted by hour, sum to 1 and start and end on pure night so the day wraps seamlessly', () => {
    for (let index = 1; index < keys.length; index += 1) expect(keys[index][0]).toBeGreaterThan(keys[index - 1][0]);
    for (const [, day, dusk, night] of keys) expect(day + dusk + night).toBeCloseTo(1, 12);
    expect(keys[0].slice(1)).toEqual([0, 0, 1]);
    expect(keys[keys.length - 1].slice(1)).toEqual([0, 0, 1]);
  });

  it('agree with the phase labels: day is the day plateau, night the night plateau', () => {
    const { dawnStart, dayStart, duskStart, nightStart } = GAME_CONFIG.calendar.phaseHours;
    expect(at(12)).toEqual({ day: 1, dusk: 0, night: 0 });
    expect(at(dayStart)).toEqual({ day: 1, dusk: 0, night: 0 });
    expect(at(duskStart)).toEqual({ day: 1, dusk: 0, night: 0 });
    expect(at(nightStart)).toEqual({ day: 0, dusk: 0, night: 1 });
    expect(at(0)).toEqual({ day: 0, dusk: 0, night: 1 });
    expect(at(dawnStart)).toEqual({ day: 0, dusk: 0, night: 1 });
  });
});

describe('dayWeights', () => {
  it('sums to 1 and stays inside 0..1 at every minute of the day', () => {
    const w = createDayWeights();
    for (let minute = 0; minute < MINUTES; minute += 1) {
      dayWeights(w, minute / MINUTES);
      expect(w.day + w.dusk + w.night, `minute ${minute}`).toBeCloseTo(1, 12);
      for (const value of [w.day, w.dusk, w.night]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('hits the key weights exactly at the key hours (no rounding on the keys)', () => {
    for (const [hour, day, dusk, night] of GAME_CONFIG.calendar.lookKeys) {
      const w = at(hour);
      expect(w.day).toBeCloseTo(day, 12);
      expect(w.dusk).toBeCloseTo(dusk, 12);
      expect(w.night).toBeCloseTo(night, 12);
    }
  });

  it('is continuous: no weight jumps by more than 2 % between neighbouring minutes, across midnight too', () => {
    const a = createDayWeights();
    const b = createDayWeights();
    for (let minute = 0; minute < MINUTES; minute += 1) {
      dayWeights(a, minute / MINUTES);
      dayWeights(b, ((minute + 1) % MINUTES) / MINUTES);
      expect(Math.abs(a.day - b.day), `day at ${minute}`).toBeLessThan(0.02);
      expect(Math.abs(a.dusk - b.dusk), `dusk at ${minute}`).toBeLessThan(0.02);
      expect(Math.abs(a.night - b.night), `night at ${minute}`).toBeLessThan(0.02);
    }
  });

  it('eases with a zero slope at every key (no kink where a ramp meets a plateau)', () => {
    for (const [hour] of GAME_CONFIG.calendar.lookKeys) {
      const before = at(hour - 0.001);
      const exact = at(hour);
      const after = at(hour + 0.001);
      for (const name of ['day', 'dusk', 'night'] as const) {
        expect(Math.abs(before[name] - exact[name]), `${name} before ${hour}`).toBeLessThan(2e-5);
        expect(Math.abs(after[name] - exact[name]), `${name} after ${hour}`).toBeLessThan(2e-5);
      }
    }
  });

  it('wraps any phase into one day and tolerates junk', () => {
    expect(dayWeights(createDayWeights(), 1.5)).toEqual(dayWeights(createDayWeights(), 0.5));
    expect(dayWeights(createDayWeights(), -0.25)).toEqual(dayWeights(createDayWeights(), 0.75));
    expect(dayWeights(createDayWeights(), Number.NaN)).toEqual(dayWeights(createDayWeights(), 0));
  });

  it('writes into and returns the object it is given (nothing allocated per frame)', () => {
    const w = createDayWeights();
    expect(dayWeights(w, 0.3)).toBe(w);
  });

  it('the dawn at 07:00 is a mix of dusk and night only, never an extra look', () => {
    const w = at(7);
    expect(w.day).toBe(0);
    expect(w.dusk).toBeCloseTo(0.6, 12);
    expect(w.night).toBeCloseTo(0.4, 12);
  });
});
