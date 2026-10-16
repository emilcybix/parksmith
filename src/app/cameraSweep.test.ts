import { describe, expect, it } from 'vitest';
import { createCameraSweep, SWEEP_DEFAULTS, sweepDayPhase, sweepZoomStep, ZOOM_STEPS, type SweepPoint } from './cameraSweep';

const make = () => createCameraSweep({ centreX: 16, centreY: 16 });
const point = (): SweepPoint => ({ x: 0, y: 0 });
/** The screen position of a cell, which is what the viewer sees move. */
const screen = (p: SweepPoint): { sx: number; sy: number } => ({ sx: (p.x - p.y) * 32, sy: (p.x + p.y) * 16 });

describe('camera sweep path', () => {
  it('starts at the map centre and does not jump when it begins moving', () => {
    const sweep = make();
    const out = point();
    sweep.current(out);
    expect(out).toEqual({ x: 16, y: 16 });
    sweep.advance(16, out);
    expect(Math.hypot(out.x - 16, out.y - 16), 'the first frame moves almost nothing').toBeLessThan(0.001);
  });

  it('drifts slowly: never faster than a few screen texels per second', () => {
    const sweep = make();
    const out = point();
    let previous = screen(sweep.current(out));
    let maxSpeed = 0;
    for (let frame = 0; frame < 60 * 400; frame += 1) {
      const now = screen(sweep.advance(1000 / 60, out));
      maxSpeed = Math.max(maxSpeed, Math.hypot(now.sx - previous.sx, now.sy - previous.sy) * 60);
      previous = now;
    }
    expect(maxSpeed).toBeGreaterThan(5);
    expect(maxSpeed, 'texels per second on screen').toBeLessThan(40);
  });

  it('stays within a bounded window around the centre, so the park never drifts out of view', () => {
    const sweep = make();
    const out = point();
    for (let frame = 0; frame < 60 * 600; frame += 1) {
      sweep.advance(1000 / 60, out);
      expect(Math.abs(out.x - 16)).toBeLessThanOrEqual((SWEEP_DEFAULTS.sideCells + SWEEP_DEFAULTS.depthCells) / 2 + 1e-9);
      expect(Math.abs(out.y - 16)).toBeLessThanOrEqual((SWEEP_DEFAULTS.sideCells + SWEEP_DEFAULTS.depthCells) / 2 + 1e-9);
    }
  });

  it('is a pure function of elapsed time: the same total gives the same point however frames are cut', () => {
    const a = make();
    const b = make();
    const outA = point();
    const outB = point();
    for (let i = 0; i < 600; i += 1) a.advance(50, outA);
    for (let i = 0; i < 1800; i += 1) b.advance(50 / 3, outB);
    expect(outA.x).toBeCloseTo(outB.x, 6);
    expect(outA.y).toBeCloseTo(outB.y, 6);
  });

  it('caps a long frame at 100 ms and ignores a bad delta, so a background tab cannot make it jump', () => {
    const sweep = make();
    const out = point();
    sweep.advance(60_000, out);
    expect(sweep.elapsedSeconds).toBeCloseTo(0.1);
    sweep.advance(Number.NaN, out);
    sweep.advance(-5, out);
    expect(sweep.elapsedSeconds).toBeCloseTo(0.1);
  });

  it('resets to the centre, and `current` never advances (the still frame under reduced motion)', () => {
    const sweep = make();
    const out = point();
    for (let i = 0; i < 1000; i += 1) sweep.advance(50, out);
    expect(out.x).not.toBe(16);
    sweep.reset();
    expect(sweep.current(out)).toEqual({ x: 16, y: 16 });
    const before = sweep.elapsedSeconds;
    sweep.current(out);
    expect(sweep.elapsedSeconds).toBe(before);
  });

  it('reuses the caller\'s object', () => {
    const out = point();
    expect(make().advance(10, out)).toBe(out);
  });
});

describe('the sweep centre follows the park (Phase 24)', () => {
  it('moves the drift to a new centre without a jump of the clock', () => {
    const sweep = createCameraSweep({ centreX: 16, centreY: 16 });
    const out = { x: 0, y: 0 };
    sweep.current(out);
    expect(out).toEqual({ x: 16, y: 16 });
    sweep.setCentre(20, 12);
    sweep.current(out);
    expect(out).toEqual({ x: 20, y: 12 });
    sweep.advance(5000, out);
    expect(Math.abs(out.x - 20)).toBeLessThanOrEqual(8);
    expect(sweep.elapsedSeconds).toBeGreaterThan(0);
  });
});

describe('zoom steps and time of day', () => {
  it('holds each zoom step, then cycles through them', () => {
    expect(sweepZoomStep(0)).toBe(ZOOM_STEPS[0]);
    expect(sweepZoomStep(SWEEP_DEFAULTS.zoomHoldSeconds - 0.01)).toBe(ZOOM_STEPS[0]);
    expect(sweepZoomStep(SWEEP_DEFAULTS.zoomHoldSeconds)).toBe(ZOOM_STEPS[1]);
    expect(sweepZoomStep(SWEEP_DEFAULTS.zoomHoldSeconds * ZOOM_STEPS.length)).toBe(ZOOM_STEPS[0]);
    expect(Math.min(...ZOOM_STEPS)).toBe(0);
  });

  it('starts at the given time, eases in without a jump and wraps after one period', () => {
    expect(sweepDayPhase(0, 0.5)).toBe(0.5);
    let previous = sweepDayPhase(0, 0.5);
    for (let t = 0.05; t < 10; t += 0.05) {
      const phase = sweepDayPhase(t, 0.5);
      const step = phase - previous;
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(0.05 / SWEEP_DEFAULTS.dayPeriodSeconds + 1e-12);
      previous = phase;
    }
    const later = sweepDayPhase(SWEEP_DEFAULTS.easeInSeconds + 10, 0.5);
    expect(sweepDayPhase(SWEEP_DEFAULTS.easeInSeconds + 10 + SWEEP_DEFAULTS.dayPeriodSeconds, 0.5)).toBeCloseTo(later, 9);
    for (let t = 0; t < 400; t += 7) {
      const phase = sweepDayPhase(t, 0.9);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });
});
