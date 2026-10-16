import { describe, expect, it } from 'vitest';
import { SEE_THROUGH, type SeeThroughFocus } from '../../seeThrough';
import { preprocessGlsl } from './glslTestKit';
import { voxelProgramSource } from './programs';
import {
  createFrontRect,
  createSeeThroughFrame,
  createSeeThroughValues,
  FRONT_CAPACITY,
  frontRectFor,
  heldInFrontLayer,
  keptInMainBuffer,
  seeThroughCoverage,
  seeThroughValuesFor,
  SeeThroughUniformSync,
  type SeeThroughUniformValues,
} from './seeThroughView';

/**
 * Adversarial review of the translucent see-through (front layer): geometry of the front rectangle,
 * the two-layer partition, the generated GLSL of the new programs, and the uniform dirty tracking.
 */

const rng = (seed: number): (() => number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
};

const focusOf = (cells: number, height: number, peek = false): SeeThroughFocus => ({
  minX: 10, minY: 10, maxX: 10 + cells - 1, maxY: 10 + cells - 1, mode: 'place', peek, heightVoxels: height,
});

describe('front rectangle', () => {
  it('contains every texel whose coverage is above 0 (random holes, cameras and screen sizes)', () => {
    const next = rng(7);
    const values = createSeeThroughValues();
    const rect = createFrontRect();
    for (let trial = 0; trial < 400; trial += 1) {
      const cells = 1 + Math.floor(next() * 6);
      const focus = focusOf(cells, Math.floor(next() * 120), next() < 0.3);
      focus.minX = Math.floor(next() * 40);
      focus.minY = Math.floor(next() * 40);
      focus.maxX = focus.minX + cells - 1;
      focus.maxY = focus.minY + cells - 1;
      seeThroughValuesFor(focus, values);
      // A slewed, fractional hole as the renderer feeds it.
      values.ax += next() - 0.5;
      values.ay += next() - 0.5;
      values.margin += next() * 3;
      const camX = Math.floor(next() * 900);
      const camY = Math.floor(next() * 500);
      const lowW = 320 + Math.floor(next() * 900);
      const lowH = 200 + Math.floor(next() * 500);
      frontRectFor(values, camX, camY, lowW, lowH, { width: 1e6, height: 1e6 }, rect);
      for (let probe = 0; probe < 200; probe += 1) {
        const tx = Math.floor(next() * lowW);
        const ty = Math.floor(next() * lowH);
        const covered = seeThroughCoverage(tx + camX + 0.5, ty + camY + 0.5, 1e6, values, 1) > 0;
        if (!covered) continue;
        const inside = tx >= rect.x && tx < rect.x + rect.width && ty >= rect.y && ty < rect.y + rect.height;
        expect(inside, `trial ${trial} texel ${tx},${ty}`).toBe(true);
      }
    }
  });

  it('a 6 x 6 cell footprint (the largest the hole opens as a whole) fits the layer for ordinary heights', () => {
    const values = createSeeThroughValues();
    const rect = createFrontRect();
    for (const height of [26, 64, 100, 150]) {
      seeThroughValuesFor(focusOf(SEE_THROUGH.MAX_FOOTPRINT_CELLS, height), values);
      expect(frontRectFor(values, 0, 0, 4096, 4096, FRONT_CAPACITY, rect), `height ${height}`).toBe(true);
    }
  });

  it('documents the silent limit: a rectangle beyond the capacity reports false (the dither rung for that frame)', () => {
    const values = createSeeThroughValues();
    const rect = createFrontRect();
    seeThroughValuesFor(focusOf(12, 40), values);
    expect(frontRectFor(values, 0, 0, 4096, 4096, FRONT_CAPACITY, rect)).toBe(false);
  });

  it('an off-screen hole is an empty rectangle that fits', () => {
    const values = createSeeThroughValues();
    const rect = createFrontRect();
    seeThroughValuesFor(focusOf(2, 30), values);
    expect(frontRectFor(values, 5000, 5000, 640, 360, FRONT_CAPACITY, rect)).toBe(true);
    expect(rect.width).toBe(0);
  });
});

describe('two-layer partition', () => {
  it('every fragment is in the main buffer, the front layer, or both; outside the key slack in exactly one', () => {
    const next = rng(11);
    const values: SeeThroughUniformValues = { ax: 100, ay: 60, aw: 70, ah: 50, cutKey: 300, floorZ: 1.5, margin: 24 };
    for (let i = 0; i < 20000; i += 1) {
      const tx = 0 + next() * 260;
      const ty = 0 + next() * 160;
      const key = 250 + next() * 100;
      const strength = next() < 0.2 ? next() : 1;
      const coverage = seeThroughCoverage(tx, ty, key, values, strength);
      const main = keptInMainBuffer(coverage);
      const front = heldInFrontLayer(tx, ty, key, values, strength);
      expect(main || front).toBe(true);
      if (Math.abs(key - values.cutKey) > SEE_THROUGH.KEY_SLACK) expect(main !== front).toBe(true);
    }
  });
});

describe('generated GLSL of the new programs', () => {
  const sources = {
    front: preprocessGlsl(voxelProgramSource('compositeFront').fragment),
    main: preprocessGlsl(voxelProgramSource('composite', 'full', undefined, true).fragment),
    plain: preprocessGlsl(voxelProgramSource('composite').fragment),
    lite: preprocessGlsl(voxelProgramSource('composite', 'lite', undefined, true).fragment),
    worldFront: preprocessGlsl(voxelProgramSource('worldFront').fragment),
    worldCut: preprocessGlsl(voxelProgramSource('worldCut').fragment),
    worldOpaque: preprocessGlsl(voxelProgramSource('worldOpaque').fragment),
  };

  it('no loops, struct arrays or dynamic sampler indexing in any new program', () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, name).not.toMatch(/\b(for|while|do)\s*[({]/);
      expect(source, name).not.toMatch(/\bstruct\b/);
    }
  });

  it('only the translucent main reads the lit layer (uFront) behind the uSeeC.z switch; the front run binds the main depth there, the plain build never reads it', () => {
    const reads = (source: string): number => [...source.matchAll(/texelFetch\(\s*uFront\b/g)].length;
    expect(reads(sources.main)).toBe(1);
    expect(reads(sources.front), 'the front run reads the MAIN depth through the same slot, once').toBe(1);
    expect(reads(sources.plain)).toBe(0);
    expect(reads(sources.lite)).toBe(0);
    expect(sources.main).toMatch(/uSeeC\.z\s*>\s*0\.0[\s\S]{0,260}texelFetch\(\s*uFront/);
  });

  it('the front run reads its own light pools, but neither the overlay nor applies rain', () => {
    expect(sources.front).toMatch(/uLightEnabled > 0\.5\) light = texelFetch\(uLight, texel, 0\)/);
    expect(sources.front).not.toMatch(/vxApplyRain\(color/);
    expect(sources.front).not.toMatch(/vxApplyOverlay\(color/);
  });

  it('the cut and the front program compute the cut coverage with the same expression', () => {
    const seeCut = (source: string): string => (/float seeCut = [^;]+;/.exec(source)?.[0] ?? '').replace(/VX_SEE_KEY_SLACK/g, 'S').replace(/\s+/g, ' ');
    expect(seeCut(sources.worldCut)).not.toBe('');
    expect(seeCut(sources.worldFront)).toBe(seeCut(sources.worldCut));
  });

  it('the opaque world program still contains no discard (early-Z)', () => {
    expect(sources.worldOpaque).not.toMatch(/\bdiscard\b/);
  });

  it('the front run hides the layer where the main G-buffer is nearer (a guest or litter in front of the faded building)', () => {
    // Was the KNOWN GAP: the mix had no depth test, so a guest nearer than the building was tinted by it.
    expect(sources.front).toMatch(/float mainDepth = texelFetch\(uFront, texel \+ ivec2\(uSeeC\.xy\), 0\)\.r;/);
    expect(sources.front).toMatch(/vxDepthKeyAt\(mainDepth\) > vxDepthKeyAt\(layerDepth\) \+ VX_SEE_NEARER_SLACK\) color = vec4\(0\.0\)/);
    expect(sources.front).toContain(`const float VX_SEE_NEARER_SLACK = ${SEE_THROUGH.FRONT_NEARER_SLACK.toFixed(2)};`);
    // The main run keeps its single, un-depth-tested mix: the decision is made once, in the layer.
    expect(sources.main).not.toMatch(/mainDepth/);
  });

  it('the front slack clears the layer\'s own survivors but not a guest at the wall', () => {
    expect(SEE_THROUGH.FRONT_NEARER_SLACK).toBeGreaterThan(SEE_THROUGH.KEY_SLACK);
    expect(SEE_THROUGH.FRONT_NEARER_SLACK).toBeLessThan(2);
  });
});

describe('uniform dirty tracking with the front rectangle', () => {
  it('a still frame writes nothing, a moved rectangle writes once, invalidate forces one write', () => {
    const sync = new SeeThroughUniformSync();
    const target = { uSeeA: new Float32Array(4), uSeeB: new Float32Array(4), uSeeC: new Float32Array(4) };
    const frame = createSeeThroughFrame();
    frame.strength = 1;
    frame.revision = 1;
    const rect = { x: 3, y: 4, width: 100, height: 80 };
    expect(sync.sync(target, frame, rect)).toBe(true);
    for (let i = 0; i < 50; i += 1) expect(sync.sync(target, frame, rect)).toBe(false);
    rect.x = 4;
    expect(sync.sync(target, frame, rect)).toBe(true);
    expect(sync.sync(target, frame, rect)).toBe(false);
    expect(sync.sync(target, frame, null)).toBe(true);
    expect(Array.from(target.uSeeC)).toEqual([0, 0, 0, 0]);
    sync.invalidate();
    expect(sync.sync(target, frame, null)).toBe(true);
  });
});
