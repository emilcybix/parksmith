import { describe, expect, it } from 'vitest';
import { ClassicSeeThrough, type FadeTarget, type SeeThroughCandidate } from './classicSeeThrough';
import { isometricSortKey } from './isometric';
import { SEE_THROUGH, type SeeThroughFocus } from './seeThrough';

const focusAt = (x: number, y: number, extra: Partial<SeeThroughFocus> = {}): SeeThroughFocus => ({
  minX: x, minY: y, maxX: x, maxY: y, mode: 'cell', peek: false, heightVoxels: 0, ...extra,
});

/** A candidate whose screen box is wide open, so only the sort key decides. */
const candidate = (key: number, over = true): { c: SeeThroughCandidate; t: FadeTarget } => {
  const t = { alpha: 1 };
  const box = over ? { left: -1e5, top: -1e5, right: 1e5, bottom: 1e5 } : { left: 9e5, top: 9e5, right: 9e6, bottom: 9e6 };
  return { c: { container: t, sortKey: key, ...box }, t };
};

const run = (fader: ClassicSeeThrough, ms: number): void => {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) fader.step(16);
};

describe('ClassicSeeThrough', () => {
  const front = isometricSortKey({ x: 12, y: 12 });
  const behind = isometricSortKey({ x: 2, y: 2 });

  it('fades only objects in front of the focus that overlap it, to the classic alpha', () => {
    const fader = new ClassicSeeThrough(() => false);
    const inFront = candidate(front);
    const atBack = candidate(behind);
    const apart = candidate(front, false);
    fader.setFocus(focusAt(5, 5), [inFront.c, atBack.c, apart.c]);
    expect(fader.activeCount).toBe(1);
    run(fader, 400);
    expect(inFront.t.alpha).toBeCloseTo(SEE_THROUGH.CLASSIC_ALPHA, 5);
    expect(atBack.t.alpha).toBe(1);
    expect(apart.t.alpha).toBe(1);
  });

  it('never fades the object that owns the focus footprint (bulldoze)', () => {
    const fader = new ClassicSeeThrough(() => false);
    const own = candidate(isometricSortKey({ x: 5, y: 5 }, [2, 2]));
    fader.setFocus(focusAt(5, 5, { maxX: 6, maxY: 6, mode: 'bulldoze' }), [own.c]);
    expect(fader.activeCount).toBe(0);
  });

  it('fades smoothly, not in one frame, and restores alpha to exactly 1 when the focus ends', () => {
    const fader = new ClassicSeeThrough(() => false);
    const item = candidate(front);
    fader.setFocus(focusAt(5, 5), [item.c]);
    fader.step(16);
    expect(item.t.alpha).toBeLessThan(1);
    expect(item.t.alpha).toBeGreaterThan(SEE_THROUGH.CLASSIC_ALPHA);
    run(fader, 400);
    fader.setFocus(null, []);
    run(fader, 400);
    expect(item.t.alpha).toBe(1);
    expect(fader.activeCount).toBe(0);
  });

  it('writes nothing once settled', () => {
    const fader = new ClassicSeeThrough(() => false);
    let writes = 0;
    const target = { _a: 1, get alpha() { return this._a; }, set alpha(v: number) { writes += 1; this._a = v; } };
    fader.setFocus(focusAt(5, 5), [{ container: target, sortKey: front, left: -9, top: -9, right: 9, bottom: 9 }]);
    run(fader, 400);
    const settled = writes;
    run(fader, 400);
    expect(writes).toBe(settled);
  });

  it('is instant under reduced motion', () => {
    const fader = new ClassicSeeThrough(() => true);
    const item = candidate(front);
    fader.setFocus(focusAt(5, 5), [item.c]);
    fader.step(1);
    expect(item.t.alpha).toBeCloseTo(SEE_THROUGH.CLASSIC_ALPHA, 5);
    fader.setFocus(null, []);
    fader.step(1);
    expect(item.t.alpha).toBe(1);
    expect(fader.activeCount).toBe(0);
  });

  it('lets an object that leaves the focus fade back while others stay', () => {
    const fader = new ClassicSeeThrough(() => false);
    const a = candidate(front);
    const b = candidate(front + 100, true);
    fader.setFocus(focusAt(5, 5), [a.c, b.c]);
    run(fader, 400);
    fader.setFocus(focusAt(5, 5), [b.c]);
    run(fader, 400);
    expect(a.t.alpha).toBe(1);
    expect(b.t.alpha).toBeCloseTo(SEE_THROUGH.CLASSIC_ALPHA, 5);
    expect(fader.activeCount).toBe(1);
  });

  it('reuses pooled entries and leaks none when displays are forgotten or cleared', () => {
    const fader = new ClassicSeeThrough(() => false);
    const pool = (fader as unknown as { pool: unknown[] }).pool;
    const items = Array.from({ length: 20 }, () => candidate(front));
    fader.setFocus(focusAt(5, 5), items.map((item) => item.c));
    expect(fader.activeCount).toBe(20);
    fader.forget(items[3].t);
    expect(fader.activeCount).toBe(19);
    expect(items[3].t.alpha).toBe(1);
    fader.clear();
    expect(fader.activeCount).toBe(0);
    expect(items.every((item) => item.t.alpha === 1)).toBe(true);
    expect(pool).toHaveLength(20);
    fader.setFocus(focusAt(5, 5), items.map((item) => item.c));
    expect(pool).toHaveLength(0);
    expect((fader as unknown as { byTarget: Map<unknown, unknown> }).byTarget.size).toBe(20);
  });

  it('peek reaches one cell further back than the same footprint without peek', () => {
    const fader = new ClassicSeeThrough(() => false);
    const footprint = { minX: 4, minY: 4, maxX: 6, maxY: 6 };
    const frontKey = isometricSortKey({ x: 4, y: 4 }, [3, 3]);
    const justBehind = candidate(frontKey - 50);
    fader.setFocus(focusAt(4, 4, footprint), [justBehind.c]);
    expect(fader.activeCount).toBe(0);
    fader.setFocus(focusAt(4, 4, { ...footprint, peek: true }), [justBehind.c]);
    expect(fader.activeCount).toBe(1);
  });

  it('keyFloor keeps an object at or below the floor opaque', () => {
    const fader = new ClassicSeeThrough(() => false);
    const own = candidate(front);
    fader.setFocus(focusAt(5, 5), [own.c], front);
    expect(fader.activeCount).toBe(0);
    fader.setFocus(focusAt(5, 5), [own.c], front - 1);
    expect(fader.activeCount).toBe(1);
  });
});
