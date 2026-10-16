import { describe, expect, it } from 'vitest';
import { classicTint } from './classicDayTint';
import { createDayWeights, dayWeights } from './dayCycle';

const tintAt = (hour: number): number => classicTint(dayWeights(createDayWeights(), hour / 24));
const channels = (tint: number): number[] => [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];

describe('classic day tint', () => {
  it('is exactly white by day, so the classic picture is unchanged', () => {
    expect(tintAt(12)).toBe(0xffffff);
    expect(tintAt(9)).toBe(0xffffff);
    expect(tintAt(16.9)).toBe(0xffffff);
  });

  it('cools at night but never below the colourful floor', () => {
    const [r, g, b] = channels(tintAt(2));
    expect(b).toBeGreaterThan(r);
    for (const value of [r, g, b]) expect(value).toBeGreaterThanOrEqual(Math.floor(0.6 * 255));
  });

  it('warms at dusk', () => {
    const [r, g, b] = channels(tintAt(19));
    expect(r).toBeGreaterThan(b);
    expect(r).toBeGreaterThan(g);
  });

  it('changes only a few dozen times per day (quantised), so the tint write is rare', () => {
    let last = -1;
    let changes = 0;
    for (let minute = 0; minute < 1440; minute += 1) {
      const tint = tintAt(minute / 60);
      if (tint !== last) changes += 1;
      last = tint;
    }
    expect(changes).toBeLessThan(120);
    expect(changes).toBeGreaterThan(5);
  });
});
