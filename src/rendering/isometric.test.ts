import { describe, expect, it } from 'vitest';
import { isometricSortKey } from './isometric';

describe('isometric depth ordering', () => {
  it('renders cells closer to the lower map edge after cells behind them', () => {
    expect(isometricSortKey({ x: 15, y: 31 })).toBeGreaterThan(
      isometricSortKey({ x: 15, y: 29 }),
    );
  });

  it('sorts a building by the front edge of its complete footprint', () => {
    expect(isometricSortKey({ x: 12, y: 27 }, [3, 3])).toBe(
      isometricSortKey({ x: 14, y: 29 }),
    );
  });
});
