import { describe, expect, it } from 'vitest';
import { resolveSeeThroughFocus, SEE_THROUGH, slewTo, SeeThroughFade, type SeeThroughFocus } from './seeThrough';
import { createSeeThroughValues, seeThroughCoverage, seeThroughValuesFor } from './voxel/gpu/seeThroughView';

const blank = (): SeeThroughFocus => ({ minX: 0, minY: 0, maxX: 0, maxY: 0, mode: 'cell', peek: false, heightVoxels: 0 });

describe('see-through QA findings', () => {
  it('an L-shaped path drag opens only the cursor cell, not the empty corner of its bounding box', () => {
    const cells = [];
    for (let x = 10; x <= 30; x += 1) cells.push({ x, y: 10 });
    for (let y = 11; y <= 30; y += 1) cells.push({ x: 30, y });
    const out = blank();
    expect(resolveSeeThroughFocus({ armed: true, peek: false }, { x: 30, y: 30 }, cells, 'cell', 0, out)).toBe(true);
    expect([out.minX, out.minY, out.maxX, out.maxY]).toEqual([30, 30, 30, 30]);
    expect(out.mode).toBe('cell');
    const values = seeThroughValuesFor(out, createSeeThroughValues());
    const cornerKey = (20 + 1) * 32 + (25 + 1) * 32 + 8;
    expect(cornerKey).toBeLessThan(values.cutKey);
  });

  it('an oversized place or bulldoze footprint collapses to the hovered cell', () => {
    const cells = [];
    for (let x = 0; x < SEE_THROUGH.MAX_FOOTPRINT_CELLS + 1; x += 1) cells.push({ x, y: 0 });
    for (const mode of ['place', 'bulldoze'] as const) {
      const out = blank();
      resolveSeeThroughFocus({ armed: true, peek: false }, { x: 3, y: 0 }, cells, mode, 20, out);
      expect([out.minX, out.maxX, out.mode, out.heightVoxels]).toEqual([3, 3, 'cell', 0]);
    }
    const ok = blank();
    resolveSeeThroughFocus({ armed: true, peek: false }, { x: 3, y: 0 }, cells.slice(0, SEE_THROUGH.MAX_FOOTPRINT_CELLS), 'place', 20, ok);
    expect([ok.minX, ok.maxX, ok.mode]).toEqual([0, SEE_THROUGH.MAX_FOOTPRINT_CELLS - 1, 'place']);
  });

  it('a peek keeps a low object on the hovered cell and cuts one a cell in front of it (the cursor target stays selectable by eye)', () => {
    const out = blank();
    resolveSeeThroughFocus({ armed: false, peek: true }, { x: 5, y: 5 }, [], 'cell', 0, out);
    const values = seeThroughValuesFor({ ...out, heightVoxels: SEE_THROUGH.COASTER_HEIGHT_VOXELS }, createSeeThroughValues());
    // A fragment inside the hole's lower half (nearer things project lower on screen).
    const at = (z: number, texelY: number) => seeThroughCoverage(values.ax, texelY, 2 * texelY + 3 * z, values, 1);
    expect(at(10, values.ay - values.ah + 2)).toBe(0); // top of the hole: behind the cut key, stays
    expect(at(10, values.ay + values.ah - 2)).toBe(1); // bottom of the hole: nearer than the site, cut
  });

  it('the fade never leaves a half-open hole after a very long frame (software GL, background tab)', () => {
    const fade = new SeeThroughFade(() => false);
    fade.setTarget(true);
    expect(fade.step(5000)).toBe(1);
    fade.setTarget(false);
    expect(fade.step(5000)).toBe(0);
    expect(slewTo(0, 100, 5000, SEE_THROUGH.POSITION_TAU_MS, false)).toBe(100);
  });
});
