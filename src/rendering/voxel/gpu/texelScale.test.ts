import { describe, expect, it } from 'vitest';
import { viewOfTarget, type TexelView } from './drawPlan';
import { preprocessGlsl } from './glslTestKit';
import { VOXEL_PROGRAM_NAMES, voxelProgramSource } from './programs';
import { FRONT_CAPACITY, FRONT_INK_TEXELS, createFrontRect, frontRectFor, type SeeThroughUniformValues } from './seeThroughView';

/**
 * Phase 55 step 2: uTexelScale (world texels per low-res texel) everywhere the GLSL meets the camera. Static checks over
 * the generated sources (compilation itself is verified in the browser), plus the CPU side's culling and front
 * rectangle.
 */
const stages = (): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const name of VOXEL_PROGRAM_NAMES) {
    for (const viewTurn of [false, true]) {
      const { vertex, fragment } = voxelProgramSource(name, 'full', undefined, true, viewTurn);
      out.push([`${name}${viewTurn ? '/turn' : ''} vertex`, vertex], [`${name}${viewTurn ? '/turn' : ''} fragment`, fragment]);
    }
  }
  return out;
};

/** The source with every #define of a variant on (the dither and cut variants declare their own uniforms). */
const variants = (source: string): string[] => {
  const plain = preprocessGlsl(source);
  return [plain, ...['VX_DITHER', 'VX_CUT', 'VX_FRONT'].map((define) => preprocessGlsl(source.replace('#version 300 es', `#version 300 es\n#define ${define}`)))];
};

describe('Phase 55: the texel scale in the voxel GLSL', () => {
  it('every stage that reads the camera declares uTexelScale', () => {
    for (const [key, source] of stages()) {
      for (const text of variants(source)) {
        const body = text.replace(/uniform vec2 uCameraTexel;/g, '');
        if (!/\buCameraTexel\b/.test(body)) continue;
        expect(text, key).toContain('uniform float uTexelScale;');
      }
    }
  });

  it('every stage that uses uTexelScale declares it (a composite variant without the camera too)', () => {
    for (const [key, source] of stages()) {
      for (const text of variants(source)) {
        if (/\buTexelScale\b/.test(text.replace(/uniform float uTexelScale;/g, ''))) expect(text, key).toContain('uniform float uTexelScale;');
      }
    }
  });

  it('outlines continue a face\'s plane by world texels: the low-res step times uTexelScale', () => {
    const text = preprocessGlsl(voxelProgramSource('composite', 'full', 'full', true).fragment);
    expect(text).toContain('vec2 world = step * uTexelScale;');
    expect(text).toContain('raw - dot(vxPlaneGradient(faceN), world) > VX_SILHOUETTE_MIN_RESIDUAL');
  });

  it('every clip mapping and sub-texel snap takes it, and no dither anchors the raw camera texel', () => {
    for (const [key, source] of stages()) {
      const text = preprocessGlsl(source);
      for (const call of text.match(/vxClip\([^;]*\);/g) ?? []) expect(call, key).toContain('uTexelScale');
      for (const call of text.match(/vxSnapSubtexel\([^;]*\)/g) ?? []) {
        if (call.startsWith('vxSnapSubtexel(vec2 texel')) continue;
        expect(call, key).toContain('uTexelScale');
      }
      // A world-texel camera added to a low-res texel would collapse the Bayer pattern at k = 2 and 4.
      expect(text, key).not.toMatch(/ivec2\(uCameraTexel\)/);
    }
  });

  it('every low-res texel turned back into the world steps uTexelScale world texels', () => {
    for (const name of ['composite', 'compositeFront', 'lightPass'] as const) {
      const text = preprocessGlsl(voxelProgramSource(name, 'full', 'full', true).fragment);
      expect(text, name).not.toMatch(/uCameraTexel \+ vec2\(texel\) \+ 0\.5/);
      expect(text, name).toContain('uCameraTexel + (vec2(texel) + 0.5) * uTexelScale');
    }
  });
});

describe('Phase 55: culling and the see-through front rectangle at a texel scale', () => {
  it('the chunk view spans the target times the scale', () => {
    const out: TexelView = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    expect(viewOfTarget(-208, 96, 653, 413, out, 4)).toEqual({ minX: -208, minY: 96, maxX: -208 + 653 * 4, maxY: 96 + 413 * 4 });
    expect(viewOfTarget(-208, 96, 653, 413, out)).toEqual({ minX: -208, minY: 96, maxX: -208 + 653, maxY: 96 + 413 });
  });

  it('the front rectangle is in target texels: the hole shrinks by the scale', () => {
    const values: SeeThroughUniformValues = { ax: 400, ay: 300, aw: 40, ah: 30, cutKey: 0, floorZ: 0, margin: 24 };
    const one = createFrontRect();
    const two = createFrontRect();
    expect(frontRectFor(values, 0, 0, 2_000, 2_000, FRONT_CAPACITY, one)).toBe(true);
    expect(frontRectFor(values, 0, 0, 2_000, 2_000, FRONT_CAPACITY, two, 2)).toBe(true);
    expect(two.x).toBe(Math.floor((400 - 40 - 24) / 2) - FRONT_INK_TEXELS);
    expect(two.width).toBe(Math.ceil((400 + 40 + 24) / 2) - Math.floor((400 - 40 - 24) / 2) + 2 * FRONT_INK_TEXELS);
    expect(two.width).toBeLessThan(one.width);
  });
});
