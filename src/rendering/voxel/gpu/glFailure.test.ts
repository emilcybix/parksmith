import { describe, expect, it } from 'vitest';
import { UnsupportedRendererError } from '../../RendererPort';
import { appendDegradedLabel, COMPOSITE_PROGRAM_NAME, compositeCarriesViewCode, compositeRungsAfter, degradedLabelFor, degradedLabelOf, degradePlanFor, failedOnlyInComposite, failedProgramsOf, parseSeeThroughLook, programTag, seeThroughRungsFor } from './glFailure';

const failure = (message: string): UnsupportedRendererError => new UnsupportedRendererError(message, { capability: false });

/** The line the user reported, verbatim. */
const REPORTED = 'The GPU reported errors while the voxel renderer warmed up: see calls; first failing calls: gl.drawElements(4, 3, 5125, 0) [program voxel-composite-vertex] -> 0x502';

describe('failed program of a startup error', () => {
  it('reads the program of the reported message, without the stage suffix', () => {
    expect(failedProgramsOf(failure(REPORTED))).toEqual([COMPOSITE_PROGRAM_NAME]);
    expect(failedOnlyInComposite(failure(REPORTED))).toBe(true);
  });

  it('reads what boot.ts writes, so writer and reader cannot drift', () => {
    expect(failedProgramsOf(failure(`calls: gl.drawElements(4, 3, 5125, 0)${programTag('voxel-composite-vertex')} -> 0x502`))).toEqual([COMPOSITE_PROGRAM_NAME]);
    expect(failedProgramsOf(failure(`x${programTag('voxel-lightPass-fragment')}`))).toEqual(['voxel-lightPass']);
    // A rebuild in the fallback chain: Pixi suffixes a shader name it has seen before (observed: voxel-lightPass-vertex-2).
    expect(failedProgramsOf(failure(`A voxel shader program failed to link${programTag('voxel-lightPass-vertex-2')}: x`))).toEqual(['voxel-lightPass']);
    expect(failedProgramsOf(failure(`x${programTag('voxel-composite-fragment-13')}`))).toEqual([COMPOSITE_PROGRAM_NAME]);
  });

  it('lists each program once and rejects a failure that touches anything else too', () => {
    const both = failure('a [program voxel-composite-vertex] -> 0x502 | b [program voxel-composite-vertex] -> 0x502 | c [program voxel-upscale-vertex] -> 0x502');
    expect(failedProgramsOf(both)).toEqual(['voxel-composite', 'voxel-upscale']);
    expect(failedOnlyInComposite(both)).toBe(false);
  });

  it('names nothing for link errors, framebuffer errors and non-errors', () => {
    expect(failedOnlyInComposite(failure('A voxel shader program failed to link: no log'))).toBe(false);
    expect(failedOnlyInComposite(failure('A voxel render target is incomplete (framebuffer status 0x8cd6)'))).toBe(false);
    expect(failedOnlyInComposite('[program voxel-composite-vertex]')).toBe(false);
    expect(failedOnlyInComposite(null)).toBe(false);
  });
});

describe('what a startup failure lets the game give up', () => {
  const tagged = (...names: string[]): UnsupportedRendererError =>
    failure(names.map((name) => `gl.drawElements(4, 6, 5125, 0)${programTag(`${name}-vertex`)} -> 0x502`).join(' | '));

  it('reads a link-time failure (named by validateGpu) like a draw-time one', () => {
    const link = failure(`A voxel shader program failed to link${programTag('voxel-composite-vertex')}: ERROR: shader | 0:12 error`);
    expect(failedOnlyInComposite(link)).toBe(true);
    expect(degradePlanFor(link)).toEqual({ viewRotation: false, composite: true, lights: false, shadows: false, seeThrough: false, translucent: false });
  });

  it('plans the lite composite, no light pools and no shadows, alone or together', () => {
    expect(degradePlanFor(tagged('voxel-lightPass'))).toEqual({ viewRotation: false, composite: false, lights: true, shadows: false, seeThrough: false, translucent: false });
    expect(degradePlanFor(tagged('voxel-figureDither'))).toEqual({ viewRotation: false, composite: false, lights: false, shadows: true, seeThrough: false, translucent: false });
    expect(degradePlanFor(tagged('voxel-composite', 'voxel-lightPass', 'voxel-figureDither')))
      .toEqual({ viewRotation: false, composite: true, lights: true, shadows: true, seeThrough: false, translucent: false });
  });

  it('plans no see-through cutaway when only its program fails, alone or with the other optional ones', () => {
    expect(degradePlanFor(tagged('voxel-worldCut'))).toEqual({ viewRotation: false, composite: false, lights: false, shadows: false, seeThrough: true, translucent: false });
    expect(degradePlanFor(tagged('voxel-worldCut', 'voxel-lightPass')))
      .toEqual({ viewRotation: false, composite: false, lights: true, shadows: false, seeThrough: true, translucent: false });
    expect(degradePlanFor(tagged('voxel-worldCut', 'voxel-worldOpaque')), 'the opaque world cannot be given up').toBeNull();
  });

  it('labels the lost cutaway no-seethrough, after the other labels', () => {
    expect(degradedLabelOf({ viewRotation: false, composite: false, lights: false, shadows: false, seeThrough: true, translucent: false }, false)).toBe('no-seethrough');
    expect(degradedLabelOf({ viewRotation: false, composite: false, lights: true, shadows: true, seeThrough: true, translucent: false }, false)).toBe('no-lights+no-shadows+no-seethrough');
    const start = { variant: 'full', tier: 'full', translucent: false } as const;
    expect(degradedLabelFor({ viewRotation: false, composite: false, lights: false, shadows: false, seeThrough: true, translucent: false }, start, start)).toBe('no-seethrough');
    expect(degradedLabelFor({ viewRotation: false, composite: true, lights: false, shadows: false, seeThrough: true, translucent: false }, start, { variant: 'lite', tier: 'rain', translucent: false }))
      .toBe('composite-lite+no-seethrough');
  });

  it('plans nothing when any program that cannot be done without is named, or none is', () => {
    for (const other of ['voxel-worldOpaque', 'voxel-worldDither', 'voxel-figureOpaque', 'voxel-upscale']) {
      expect(degradePlanFor(tagged('voxel-lightPass', other)), other).toBeNull();
    }
    expect(degradePlanFor(failure('The GPU reported errors while the voxel renderer warmed up: 0x502'))).toBeNull();
    expect(degradePlanFor('x')).toBeNull();
  });

  it('labels what was applied for window.__voxelDegraded', () => {
    expect(degradedLabelOf({ viewRotation: false, composite: true, lights: false, shadows: false, seeThrough: false, translucent: false }, false)).toBe('composite-lite');
    expect(degradedLabelOf({ viewRotation: false, composite: false, lights: true, shadows: false, seeThrough: false, translucent: false }, false)).toBe('no-lights');
    expect(degradedLabelOf({ viewRotation: false, composite: false, lights: false, shadows: true, seeThrough: false, translucent: false }, false)).toBe('no-shadows');
    expect(degradedLabelOf({ viewRotation: false, composite: false, lights: true, shadows: true, seeThrough: false, translucent: false }, false)).toBe('no-lights+no-shadows');
    expect(degradedLabelOf({ viewRotation: false, composite: true, lights: true, shadows: false, seeThrough: false, translucent: false }, false), 'lite has no lights anyway').toBe('composite-lite');
    expect(degradedLabelOf({ viewRotation: false, composite: false, lights: true, shadows: false, seeThrough: false, translucent: false }, true), 'asked for lite, then lost lights').toBe('no-lights');
  });
});

describe('the composite fallback chain (Phase 20)', () => {
  const plan = { viewRotation: false, composite: true, lights: false, shadows: false, seeThrough: false, translucent: false };

  it('walks full+weather -> full -> lite+rain -> lite, in that order', () => {
    expect(compositeRungsAfter({ variant: 'full', tier: 'full', translucent: false })).toEqual([
      { variant: 'full', tier: 'none', translucent: false },
      { variant: 'lite', tier: 'rain', translucent: false },
      { variant: 'lite', tier: 'none', translucent: false },
    ]);
  });

  it('skips what the start already lacks and never climbs back to full', () => {
    expect(compositeRungsAfter({ variant: 'full', tier: 'none', translucent: false })).toEqual([{ variant: 'lite', tier: 'none', translucent: false }]);
    expect(compositeRungsAfter({ variant: 'lite', tier: 'rain', translucent: false })).toEqual([{ variant: 'lite', tier: 'none', translucent: false }]);
    expect(compositeRungsAfter({ variant: 'lite', tier: 'none', translucent: false })).toEqual([]);
  });

  it('labels every rung for window.__voxelDegraded', () => {
    const start = { variant: 'full', tier: 'full', translucent: false } as const;
    expect(degradedLabelFor(plan, start, { variant: 'full', tier: 'none', translucent: false })).toBe('no-weather');
    expect(degradedLabelFor(plan, start, { variant: 'lite', tier: 'rain', translucent: false })).toBe('composite-lite');
    expect(degradedLabelFor(plan, start, { variant: 'lite', tier: 'none', translucent: false })).toBe('composite-lite+no-weather');
    expect(degradedLabelFor({ viewRotation: false, composite: false, lights: true, shadows: false, seeThrough: false, translucent: false }, start, { variant: 'full', tier: 'full', translucent: false }), 'weather kept for a light failure').toBe('no-lights');
    expect(degradedLabelFor(plan, { variant: 'lite', tier: 'rain', translucent: false }, { variant: 'lite', tier: 'none', translucent: false }), 'asked-for lite is not a degradation').toBe('no-weather');
  });

  it('appends the runtime label once', () => {
    expect(appendDegradedLabel(undefined, 'no-weather')).toBe('no-weather');
    expect(appendDegradedLabel('composite-lite', 'no-weather')).toBe('composite-lite+no-weather');
    expect(appendDegradedLabel('no-weather', 'no-weather')).toBe('no-weather');
  });
});

describe('the translucent see-through rung (alpha -> dither -> off)', () => {
  const tagged = (...names: string[]): UnsupportedRendererError =>
    failure(names.map((name) => `gl.drawElements(4, 6, 5125, 0)${programTag(`${name}-vertex`)} -> 0x502`).join(' | '));
  const translucentStart = { variant: 'full', tier: 'full', translucent: true } as const;
  const none = { viewRotation: false, composite: false, lights: false, shadows: false, seeThrough: false, translucent: false };

  it('plans the dither rung when only a front-layer program fails, alone or with other optional programs', () => {
    expect(degradePlanFor(tagged('voxel-worldFront'))).toEqual({ ...none, translucent: true });
    expect(degradePlanFor(tagged('voxel-compositeFront'))).toEqual({ ...none, translucent: true });
    expect(degradePlanFor(tagged('voxel-compositeFront', 'voxel-worldFront', 'voxel-lightPass'))).toEqual({ ...none, lights: true, translucent: true });
    expect(degradePlanFor(tagged('voxel-worldFront', 'voxel-worldCut'))).toEqual({ ...none, seeThrough: true, translucent: true });
    expect(degradePlanFor(tagged('voxel-worldFront', 'voxel-worldOpaque')), 'the opaque world cannot be given up').toBeNull();
  });

  it('labels the dither rung no-translucent-seethrough, once, and nothing when the cutaway is gone altogether', () => {
    expect(degradedLabelOf({ ...none, translucent: true }, false)).toBe('no-translucent-seethrough');
    expect(degradedLabelOf({ ...none, seeThrough: true, translucent: true }, false), 'no cutaway at all: no-seethrough only').toBe('no-seethrough');
    expect(degradedLabelFor({ ...none, translucent: true }, translucentStart, { ...translucentStart, translucent: false })).toBe('no-translucent-seethrough');
    expect(degradedLabelFor({ ...none, translucent: true }, translucentStart, translucentStart), 'still translucent: no label').toBe('');
    expect(degradedLabelFor({ ...none, seeThrough: true, translucent: true }, translucentStart, { ...translucentStart, translucent: false })).toBe('no-seethrough');
  });

  it('tries the composite without the translucent mix first, on the same weather tier, then the old chain', () => {
    expect(compositeRungsAfter(translucentStart)).toEqual([
      { variant: 'full', tier: 'full', translucent: false },
      { variant: 'full', tier: 'none', translucent: false },
      { variant: 'lite', tier: 'rain', translucent: false },
      { variant: 'lite', tier: 'none', translucent: false },
    ]);
    expect(compositeRungsAfter({ variant: 'full', tier: 'none', translucent: true })).toEqual([
      { variant: 'full', tier: 'none', translucent: false },
      { variant: 'lite', tier: 'none', translucent: false },
    ]);
  });

  it('labels reaching the lite composite from a translucent start with both losses, but not a lite start', () => {
    const plan = { ...none, composite: true };
    expect(degradedLabelFor(plan, translucentStart, { variant: 'full', tier: 'full', translucent: false })).toBe('no-translucent-seethrough');
    expect(degradedLabelFor(plan, translucentStart, { variant: 'lite', tier: 'rain', translucent: false })).toBe('composite-lite+no-translucent-seethrough');
    expect(degradedLabelFor(plan, { variant: 'lite', tier: 'rain', translucent: false }, { variant: 'lite', tier: 'none', translucent: false }), 'a lite start never had the rung').toBe('no-weather');
  });

  it('steps an unnamed failure down one rung at a time: translucent, then dither, then off', () => {
    const unnamed = failure('A voxel shader program failed to link: no log');
    expect(seeThroughRungsFor(unnamed, 'alpha')).toEqual([{ translucent: false, skipSeeThrough: false }, { translucent: false, skipSeeThrough: true }]);
    expect(seeThroughRungsFor(unnamed, 'dither')).toEqual([{ translucent: false, skipSeeThrough: true }]);
    expect(seeThroughRungsFor(unnamed, 'off')).toEqual([]);
    expect(seeThroughRungsFor(tagged('voxel-worldFront'), 'alpha'), 'a named failure is planned by degradePlanFor').toEqual([]);
    expect(seeThroughRungsFor('x', 'alpha')).toHaveLength(2);
  });

  it('reads the flag: alpha is the default, dither and off are themselves, junk is the default', () => {
    expect(parseSeeThroughLook(null)).toBe('alpha');
    expect(parseSeeThroughLook('alpha')).toBe('alpha');
    expect(parseSeeThroughLook('dither')).toBe('dither');
    expect(parseSeeThroughLook('off')).toBe('off');
    expect(parseSeeThroughLook('ALPHA')).toBe('alpha');
    expect(parseSeeThroughLook('banana')).toBe('alpha');
  });
});

describe('the no-view-rotation rung (Phase 26)', () => {
  const tagged = (...names: string[]): UnsupportedRendererError =>
    failure(names.map((name) => `gl.drawElements(4, 6, 5125, 0)${programTag(`${name}-vertex`)} -> 0x502`).join(' | '));
  const VIEW_ONLY = { viewRotation: true, composite: false, lights: false, shadows: false, seeThrough: false, translucent: false };

  it('retries once without the view code when a program carrying it fails in a view-turn build', () => {
    for (const name of ['voxel-worldOpaque', 'voxel-worldDither', 'voxel-figureOpaque', 'voxel-figureDither', 'voxel-lightPass', 'voxel-worldCut', 'voxel-worldFront']) {
      expect(degradePlanFor(tagged(name), { viewTurn: true }), name).toEqual(VIEW_ONLY);
    }
    // Everything else waits for the retry: no other part is given up in the same step.
    expect(degradePlanFor(tagged('voxel-worldOpaque', 'voxel-composite', 'voxel-worldCut'), { viewTurn: true })).toEqual(VIEW_ONLY);
    // A required program the view code does not touch cannot be rescued by the retry.
    expect(degradePlanFor(tagged('voxel-worldOpaque', 'voxel-upscale'), { viewTurn: true })).toBeNull();
  });

  it('routes the composites to the view retry only when they carry the view code (full composite, full weather)', () => {
    for (const name of ['voxel-composite', 'voxel-compositeFront']) {
      expect(degradePlanFor(tagged(name), { viewTurn: true, compositeView: true }), name).toEqual(VIEW_ONLY);
      expect(degradePlanFor(tagged(name), { viewTurn: false, compositeView: true })?.viewRotation, name).toBe(false);
    }
    expect(compositeCarriesViewCode({ variant: 'full', tier: 'full', translucent: true })).toBe(true);
    expect(compositeCarriesViewCode({ variant: 'full', tier: 'none', translucent: false })).toBe(false);
    expect(compositeCarriesViewCode({ variant: 'full', tier: 'rain', translucent: false })).toBe(false);
    expect(compositeCarriesViewCode({ variant: 'lite', tier: 'full', translucent: false })).toBe(false);
  });

  it('plans exactly as before without the view code, and for programs the view code does not touch', () => {
    expect(degradePlanFor(tagged('voxel-worldOpaque'), { viewTurn: false })).toBeNull();
    expect(degradePlanFor(tagged('voxel-worldOpaque'))).toBeNull();
    expect(degradePlanFor(tagged('voxel-lightPass'), { viewTurn: false })).toEqual({ viewRotation: false, composite: false, lights: true, shadows: false, seeThrough: false, translucent: false });
    // A composite without the view code (no-weather and lite rungs) keeps its own ladder.
    expect(degradePlanFor(tagged('voxel-composite'), { viewTurn: true })).toEqual({ viewRotation: false, composite: true, lights: false, shadows: false, seeThrough: false, translucent: false });
    expect(degradePlanFor(tagged('voxel-worldCut'), { viewTurn: false })).toEqual({ viewRotation: false, composite: false, lights: false, shadows: false, seeThrough: true, translucent: false });
    expect(degradePlanFor(tagged('voxel-upscale'), { viewTurn: true })).toBeNull();
    expect(degradePlanFor(failure('A voxel shader program failed to link: no log'), { viewTurn: true })).toBeNull();
  });

  it('labels the lost rotation for window.__voxelDegraded, first, and joins with the other labels', () => {
    expect(degradedLabelOf(VIEW_ONLY, false)).toBe('no-view-rotation');
    const start = { variant: 'full', tier: 'full', translucent: false } as const;
    expect(degradedLabelFor(VIEW_ONLY, start, start)).toBe('no-view-rotation');
    expect(appendDegradedLabel(degradedLabelOf(VIEW_ONLY, false), 'no-lights')).toBe('no-view-rotation+no-lights');
    expect(appendDegradedLabel('no-view-rotation', 'no-view-rotation')).toBe('no-view-rotation');
  });
});
