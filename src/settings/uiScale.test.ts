import { describe, expect, it } from 'vitest';
import { effectiveUiScale, isUiScaleCapped, UI_LAYOUT_MIN_HEIGHT, UI_LAYOUT_MIN_WIDTH } from './uiScale';

describe('effectiveUiScale', () => {
  it('never changes 85 and 100, whatever the window', () => {
    for (const [w, h] of [[1280, 720], [320, 200], [3840, 2160], [0, 0]]) {
      expect(effectiveUiScale(85, w, h)).toBe(0.85);
      expect(effectiveUiScale(100, w, h)).toBe(1);
    }
  });

  it('caps scaling up to what fits at 1280x720 and 1366x768', () => {
    expect(effectiveUiScale(115, 1280, 720)).toBeCloseTo(720 / UI_LAYOUT_MIN_HEIGHT, 9);
    expect(effectiveUiScale(130, 1280, 720)).toBeCloseTo(720 / UI_LAYOUT_MIN_HEIGHT, 9);
    expect(effectiveUiScale(115, 1366, 768)).toBeCloseTo(768 / UI_LAYOUT_MIN_HEIGHT, 9);
    expect(isUiScaleCapped(130, 1280, 720)).toBe(true);
  });

  it('allows the full scale on a big window', () => {
    expect(effectiveUiScale(130, 1920, 1080)).toBe(1.3);
    expect(isUiScaleCapped(130, 1920, 1080)).toBe(false);
    expect(isUiScaleCapped(85, 1280, 720)).toBe(false);
  });

  it('never goes below 100 when scaling up, even in a tiny or degenerate window', () => {
    expect(effectiveUiScale(130, 800, 500)).toBe(1);
    expect(effectiveUiScale(115, 0, 0)).toBe(1);
    expect(effectiveUiScale(115, Number.NaN, 720)).toBe(1);
    expect(effectiveUiScale(130, UI_LAYOUT_MIN_WIDTH * 1.2, UI_LAYOUT_MIN_HEIGHT * 5)).toBeCloseTo(1.2, 9);
  });
});
