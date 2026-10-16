import { describe, expect, it } from 'vitest';
import type { Cell } from '../game/types';
import {
  resolveSeeThroughFocus,
  SEE_THROUGH,
  SeeThroughFade,
  slewTo,
  type SeeThroughFocus,
} from './seeThrough';

const out = (): SeeThroughFocus => ({ minX: 0, minY: 0, maxX: 0, maxY: 0, mode: 'cell', peek: false, heightVoxels: 0 });
const cell = (x: number, y: number): Cell => ({ x, y });

describe('resolveSeeThroughFocus', () => {
  it('is off without a hovered cell or without armed/peek, and leaves out untouched', () => {
    const o = out();
    expect(resolveSeeThroughFocus({ armed: true, peek: false }, null, [], 'cell', 0, o)).toBe(false);
    expect(resolveSeeThroughFocus({ armed: false, peek: false }, cell(3, 3), [], 'cell', 0, o)).toBe(false);
    expect(o).toEqual(out());
  });

  it('uses the hovered cell as a plain cell when there is no preview', () => {
    const o = out();
    expect(resolveSeeThroughFocus({ armed: true, peek: false }, cell(4, 7), [], 'place', 12, o)).toBe(true);
    expect(o).toEqual({ minX: 4, minY: 7, maxX: 4, maxY: 7, mode: 'cell', peek: false, heightVoxels: 0 });
  });

  it('takes the preview footprint bounds, mode and height', () => {
    const o = out();
    const cells = [cell(5, 5), cell(6, 5), cell(5, 7), cell(6, 7)];
    resolveSeeThroughFocus({ armed: true, peek: false }, cell(5, 5), cells, 'place', 18, o);
    expect(o).toEqual({ minX: 5, minY: 5, maxX: 6, maxY: 7, mode: 'place', peek: false, heightVoxels: 18 });
    resolveSeeThroughFocus({ armed: true, peek: false }, cell(5, 5), cells, 'bulldoze', 18, o);
    expect(o.mode).toBe('bulldoze');
  });

  it('peek grows the hovered cell by one cell and works without an armed tool', () => {
    const o = out();
    expect(resolveSeeThroughFocus({ armed: false, peek: true }, cell(10, 10), [cell(1, 1)], 'place', 0, o)).toBe(true);
    expect(o).toEqual({ minX: 9, minY: 9, maxX: 11, maxY: 11, mode: 'cell', peek: true, heightVoxels: 0 });
  });

  it('sanitises a bad height', () => {
    const o = out();
    resolveSeeThroughFocus({ armed: true, peek: false }, cell(1, 1), [cell(1, 1)], 'place', Number.NaN, o);
    expect(o.heightVoxels).toBe(0);
  });
});

describe('SeeThroughFade', () => {
  it('fades in over 140 ms and out over 220 ms, linearly', () => {
    const fade = new SeeThroughFade(() => false);
    fade.setTarget(true);
    expect(fade.step(70)).toBeCloseTo(0.5, 5);
    expect(fade.step(70)).toBe(1);
    expect(fade.settled).toBe(true);
    fade.setTarget(false);
    expect(fade.step(110)).toBeCloseTo(0.5, 5);
    expect(fade.step(500)).toBe(0);
    expect(fade.settled).toBe(true);
  });

  it('does not change once settled', () => {
    const fade = new SeeThroughFade(() => false);
    expect(fade.step(16)).toBe(0);
    expect(fade.settled).toBe(true);
  });

  it('is instant under reduced motion, and reads the flag live', () => {
    let reduced = true;
    const fade = new SeeThroughFade(() => reduced);
    fade.setTarget(true);
    expect(fade.value).toBe(1);
    fade.setTarget(false);
    expect(fade.value).toBe(0);
    reduced = false;
    fade.setTarget(true);
    expect(fade.value).toBe(0);
    reduced = true;
    expect(fade.step(1)).toBe(1);
  });
});

describe('slewTo', () => {
  it('approaches the target, frame-rate independent, and snaps within epsilon', () => {
    const one = slewTo(0, 1, 70, SEE_THROUGH.POSITION_TAU_MS, false);
    expect(one).toBeCloseTo(1 - Math.exp(-1), 6);
    const two = slewTo(slewTo(0, 1, 35, 70, false), 1, 35, 70, false);
    expect(two).toBeCloseTo(one, 6);
    expect(slewTo(1 - SEE_THROUGH.EPSILON / 2, 1, 16, 70, false)).toBe(1);
    let v = 0;
    for (let i = 0; i < 200; i += 1) v = slewTo(v, 5, 16, 70, false);
    expect(v).toBe(5);
  });

  it('is instant when asked and holds on a zero delta', () => {
    expect(slewTo(0, 9, 16, 70, true)).toBe(9);
    expect(slewTo(0, 9, 0, 70, false)).toBe(0);
  });
});
