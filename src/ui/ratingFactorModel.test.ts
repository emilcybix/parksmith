import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import type { RatingFactor, RatingFactorKey } from '../game/management/types';
import { ParkSession } from '../game/session/ParkSession';
import { FACTOR_SORT_NOTE, ratingFactorRow, ratingFactorRows } from './ratingFactorModel';

const factor = (key: string, weight: number, score: number): RatingFactor => ({
  key: key as RatingFactorKey,
  label: key,
  score,
  weight,
  contribution: Math.round(score * weight * 10) / 10,
  detail: '',
});

describe('ratingFactorRows (Phase 11, PA-016)', () => {
  it('words the weight line, with full marks under half a point and a singular point', () => {
    expect(ratingFactorRow(factor('guestHappiness', 0.17, 12)).weightLine).toBe('17% of the rating · 15 pts to gain');
    expect(ratingFactorRow(factor('guestHappiness', 0.17, 100)).weightLine).toBe('17% of the rating · full marks');
    expect(ratingFactorRow(factor('parkSize', 0.06, 96)).weightLine).toBe('6% of the rating · full marks');
    expect(ratingFactorRow(factor('parkSize', 0.06, 85)).weightLine).toBe('6% of the rating · 1 pt to gain');
    const row = ratingFactorRow(factor('cleanliness', 0.09, 50));
    expect(row).toMatchObject({ points: 4.5, weightLabel: '9% of the rating', gainLabel: '5 pts to gain' });
    expect(row.maxPoints).toBeCloseTo(9, 10);
    expect(row.gain).toBeCloseTo(4.5, 10);
  });

  it('never reports a negative gain', () => {
    const over = { ...factor('value', 0.07, 100), contribution: 7.2 };
    expect(ratingFactorRow(over)).toMatchObject({ gain: 0, gainLabel: 'full marks' });
  });

  it('sorts by whole points to gain, then weight, then the canonical order', () => {
    const rows = ratingFactorRows([
      factor('a', 0.06, 50), // gain 3
      factor('b', 0.09, 100), // gain 0
      factor('c', 0.17, 60), // gain 6.8 → 7
      factor('d', 0.08, 10), // gain 7.2 → 7, lighter than c
      factor('e', 0.07, 57), // gain 3.0 → 3, heavier than a
      factor('f', 0.07, 57.5), // gain 3.0 → 3, same weight as e, later index
      factor('g', 0.11, 100), // gain 0, heavier than b
    ]);
    expect(rows.map((row) => row.factor.key)).toEqual(['c', 'd', 'e', 'f', 'a', 'g', 'b']);
  });

  it('keeps near-equal rows still as gains wobble inside the same whole point', () => {
    const first = ratingFactorRows([factor('x', 0.09, 40), factor('y', 0.09, 41)]).map((row) => row.factor.key);
    const second = ratingFactorRows([factor('x', 0.09, 41), factor('y', 0.09, 40)]).map((row) => row.factor.key);
    expect(first).toEqual(['x', 'y']);
    expect(second).toEqual(['x', 'y']);
  });

  it('adds up to the live rating: 100 points at full marks, the contributions to the score', () => {
    const session = new ParkSession();
    for (let tick = 0; tick < 20; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
    const { rating } = session.management.snapshot();
    const rows = ratingFactorRows(rating.factors);
    expect(rows).toHaveLength(rating.factors.length);
    expect(rows.reduce((total, row) => total + row.maxPoints, 0)).toBeCloseTo(100, 9);
    expect(Math.abs(rows.reduce((total, row) => total + row.points, 0) - rating.score)).toBeLessThanOrEqual(0.6);
    for (let index = 1; index < rows.length; index += 1) {
      expect(Math.round(rows[index - 1].gain)).toBeGreaterThanOrEqual(Math.round(rows[index].gain));
    }
  });

  it('has the sort note', () => {
    expect(FACTOR_SORT_NOTE).toBe('Biggest gains first.');
  });
});
