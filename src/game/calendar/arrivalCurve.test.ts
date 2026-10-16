import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { arrivalCurveAt, arrivalCurveMean } from './arrivalCurve';
import { isScheduleOpen } from './calendarMath';

describe('arrival curve', () => {
  it('has a day-long mean of 1 so the daily total stays where it was', () => {
    expect(arrivalCurveMean()).toBeGreaterThan(0.98);
    expect(arrivalCurveMean()).toBeLessThan(1.02);
  });

  it('a quiet morning, a busy afternoon and a thin evening', () => {
    const afternoon = arrivalCurveAt(14);
    expect(arrivalCurveAt(7)).toBeLessThan(afternoon * 0.65);
    expect(arrivalCurveAt(8)).toBeLessThan(afternoon * 0.65);
    expect(arrivalCurveAt(21)).toBeLessThan(afternoon * 0.5);
    expect(arrivalCurveAt(2)).toBeLessThan(arrivalCurveAt(21));
    expect(afternoon).toBe(Math.max(...Array.from({ length: 240 }, (_, index) => arrivalCurveAt(index / 10))));
  });

  it('is positive everywhere (the night has a floor) and wraps at 24 h', () => {
    for (let hour = 0; hour < 24; hour += 0.1) expect(arrivalCurveAt(hour)).toBeGreaterThan(0.4);
    expect(arrivalCurveAt(24)).toBeCloseTo(arrivalCurveAt(0), 12);
    expect(arrivalCurveAt(25.5)).toBeCloseTo(arrivalCurveAt(1.5), 12);
    expect(arrivalCurveAt(-1)).toBeCloseTo(arrivalCurveAt(23), 12);
  });

  it('hits every key exactly and rises monotonically between 5 h and 14 h and falls between 14 h and 24 h', () => {
    for (const [hour, value] of GAME_CONFIG.calendar.arrivalCurve) expect(arrivalCurveAt(hour % 24), `hour ${hour}`).toBeCloseTo(hour === 24 ? arrivalCurveAt(0) : value, 12);
    let previous = arrivalCurveAt(5);
    for (let hour = 5.05; hour <= 14; hour += 0.05) {
      const value = arrivalCurveAt(hour);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
    previous = arrivalCurveAt(14);
    for (let hour = 14.05; hour <= 24; hour += 0.05) {
      const value = arrivalCurveAt(hour);
      expect(value).toBeLessThanOrEqual(previous + 1e-12);
      previous = value;
    }
  });

  it('is continuous (no jumps between neighbouring samples)', () => {
    for (let hour = 0; hour < 24; hour += 0.01) expect(Math.abs(arrivalCurveAt(hour + 0.01) - arrivalCurveAt(hour))).toBeLessThan(0.02);
  });
});

describe('opening hours on the raw clock', () => {
  it('opens at the open hour (inclusive) and closes at the close hour (exclusive)', () => {
    const at = (hour: number): number => hour / 24;
    expect(isScheduleOpen(true, 8, 21, at(7.99))).toBe(false);
    expect(isScheduleOpen(true, 8, 21, at(8))).toBe(true);
    expect(isScheduleOpen(true, 8, 21, at(20.99))).toBe(true);
    expect(isScheduleOpen(true, 8, 21, at(21))).toBe(false);
    expect(isScheduleOpen(true, 8, 21, at(3))).toBe(false);
  });

  it('hours off means always open', () => {
    for (let hour = 0; hour < 24; hour += 1) expect(isScheduleOpen(false, 8, 21, hour / 24)).toBe(true);
  });
});
