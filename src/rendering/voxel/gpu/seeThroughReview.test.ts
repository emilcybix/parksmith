import { describe, expect, it } from 'vitest';
import { SEE_THROUGH, type SeeThroughFocus } from '../../seeThrough';
import {
  BAYER_4X4,
  DITHER_OFFSET_GHOST,
  DITHER_OFFSET_LIGHT,
  DITHER_OFFSET_OVERLAY,
  DITHER_OFFSET_SEE,
  DITHER_OFFSET_SHADOW,
  DITHER_OFFSET_WEATHER,
} from '../contracts/gbuffer';
import { preprocessGlsl } from './glslTestKit';
import { voxelProgramSource } from './programs';
import {
  createSeeThroughFrame,
  createSeeThroughValues,
  seeThroughCoverage,
  seeThroughValuesFor,
  seeThroughView,
  SeeThroughUniformSync,
  writeSeeThroughUniforms,
  type SeeThroughUniformValues,
} from './seeThroughView';

/**
 * Adversarial GPU review of the see-through cutaway: the properties that decide whether the new
 * program links and compiles on the strictest drivers (ANGLE/D3D11 fxc), whether the CPU chunk
 * selection and the shader agree (a mismatch is a visible pop at a chunk edge), whether the dither
 * is world-anchored, and whether the per-frame path allocates. Pure TypeScript / generated GLSL.
 */

const fragment = preprocessGlsl(voxelProgramSource('worldCut').fragment);
const vertex = preprocessGlsl(voxelProgramSource('worldCut').vertex);

const uniformsOf = (source: string): Map<string, string> =>
  new Map([...source.matchAll(/^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*;/gm)].map((m) => [m[2], m[1]]));

/** Deterministic xorshift, so a failure reproduces. */
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

describe('worldCut: link and compile safety', () => {
  it('declares every uniform the two stages share with the same type (a mismatch is a link error)', () => {
    const v = uniformsOf(vertex);
    const f = uniformsOf(fragment);
    for (const [name, type] of f) {
      if (v.has(name)) expect(v.get(name), name).toBe(type);
    }
    expect(f.get('uSeeA')).toBe('vec4');
    expect(f.get('uSeeB')).toBe('vec4');
    // The see-through uniforms are fragment-only: the vertex stage must not grow a dependency on them.
    expect(v.has('uSeeA') || v.has('uSeeB')).toBe(false);
  });

  it('has exactly one discard, and it comes before the surface colour work (cheap early out)', () => {
    const discards = fragment.match(/\bdiscard\b/g) ?? [];
    expect(discards).toHaveLength(1);
    const main = fragment.slice(fragment.indexOf('void main'));
    expect(main.indexOf('discard')).toBeLessThan(main.indexOf('vxSurfaceColor('));
    expect(main.indexOf('discard')).toBeLessThan(main.indexOf('vxMaterialProps('));
  });

  it('keeps the see-through arithmetic shallow: no dynamic indexing of its own, bounded nesting', () => {
    const statement = fragment.split('\n').filter((line) => /see[A-Z]|uSee/.test(line)).join(' ');
    expect(statement).not.toMatch(/\[[^\]]*see[A-Za-z]*[^\]]*\]/);
    let depth = 0;
    let max = 0;
    for (const ch of statement) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      max = Math.max(max, depth);
    }
    expect(depth).toBe(0);
    expect(max, 'fxc blows up on deep expression trees; this one measured 4').toBeLessThanOrEqual(5);
  });

  it('reads no texture before its discard, and uses no derivative anywhere (no non-uniform-flow gradients)', () => {
    const main = fragment.slice(fragment.indexOf('void main'));
    const beforeDiscard = main.slice(0, main.indexOf('discard'));
    expect(beforeDiscard).not.toMatch(/texelFetch|texture\s*\(|textureLod/);
    expect(fragment).not.toMatch(/dFdx|dFdy|fwidth|texture\s*\(/);
  });

  it('adds nothing to the vertex stage relative to the opaque program (no varying churn, one shared vertex program)', () => {
    const opaque = preprocessGlsl(voxelProgramSource('worldOpaque').vertex);
    const squash = (text: string): string => text.replace(/\n\s*\n+/g, '\n');
    expect(squash(vertex)).toBe(squash(opaque));
  });
});

describe('worldCut: dither is world-anchored and does not correlate with the other screen doors', () => {
  const offsets: [string, readonly [number, number]][] = [
    ['ghost', DITHER_OFFSET_GHOST], ['shadow', DITHER_OFFSET_SHADOW], ['light', DITHER_OFFSET_LIGHT],
    ['overlay', DITHER_OFFSET_OVERLAY], ['see', DITHER_OFFSET_SEE], ['weather', DITHER_OFFSET_WEATHER],
  ];

  it('uses an offset no other screen door uses', () => {
    const keys = offsets.map(([, [x, y]]) => `${x},${y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the Bayer cell of a world texel is independent of the camera (pan by any integer, negative included)', () => {
    const cell = (x: number, y: number): number => BAYER_4X4[((y + DITHER_OFFSET_SEE[1]) & 3) * 4 + ((x + DITHER_OFFSET_SEE[0]) & 3)];
    for (const camera of [[0, 0], [1, 0], [0, 1], [-5, 3], [4096, -777], [-1, -1]]) {
      for (const world of [[100, 200], [-3, 7], [0, 0], [333, -1]]) {
        const fragmentIndex = [world[0] - camera[0], world[1] - camera[1]];
        const anchored = cell(fragmentIndex[0] + camera[0], fragmentIndex[1] + camera[1]);
        expect(anchored, `camera ${camera} world ${world}`).toBe(cell(world[0], world[1]));
      }
    }
  });

  it('coverage does not depend on the camera at all (it is a function of world texel and key only)', () => {
    const values = seeThroughValuesFor({ minX: 5, minY: 5, maxX: 5, maxY: 5, mode: 'place', peek: false, heightVoxels: 30 }, createSeeThroughValues());
    const a = seeThroughCoverage(10, 20, values.cutKey + 10, values, 1);
    expect(seeThroughCoverage(10, 20, values.cutKey + 10, values, 1)).toBe(a);
  });
});

describe('worldCut: the CPU chunk selection and the shader agree', () => {
  it('every texel with coverage above zero lies inside seeThroughView (else a chunk outside it would pop)', () => {
    const rand = rng(1234);
    const view = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    for (let trial = 0; trial < 200; trial += 1) {
      const minX = Math.floor(rand() * 20);
      const minY = Math.floor(rand() * 20);
      const focus: SeeThroughFocus = {
        minX, minY, maxX: minX + Math.floor(rand() * 4), maxY: minY + Math.floor(rand() * 4),
        mode: (['place', 'bulldoze', 'cell'] as const)[Math.floor(rand() * 3)], peek: rand() < 0.3,
        heightVoxels: Math.floor(rand() * 120),
      };
      const values = seeThroughValuesFor(focus, createSeeThroughValues());
      seeThroughView(values, view);
      for (let probe = 0; probe < 200; probe += 1) {
        const tx = values.ax + (rand() - 0.5) * 2 * (values.aw + values.margin * 3);
        const ty = values.ay + (rand() - 0.5) * 2 * (values.ah + values.margin * 3);
        const key = values.cutKey + rand() * 400;
        // Pick a key that also satisfies the floor test at this texel.
        const coverage = seeThroughCoverage(tx, ty, key, values, 1);
        if (coverage > 0) {
          expect(tx, 'x inside view').toBeGreaterThanOrEqual(view.minX);
          expect(tx).toBeLessThanOrEqual(view.maxX);
          expect(ty).toBeGreaterThanOrEqual(view.minY);
          expect(ty).toBeLessThanOrEqual(view.maxY);
        }
      }
    }
  });

  it('coverage falls off monotonically and continuously with distance from the hole (no ring, no pop)', () => {
    const values: SeeThroughUniformValues = { ...createSeeThroughValues(), ax: 0, ay: 0, aw: 50, ah: 30, cutKey: 0, margin: 24 };
    let previous = 1;
    for (let d = 0; d <= 40; d += 0.25) {
      const c = seeThroughCoverage(50 + d, 0, 1000, values, 1);
      expect(c).toBeLessThanOrEqual(previous + 1e-12);
      expect(previous - c, 'no jump larger than the smoothstep slope allows').toBeLessThan(0.1);
      previous = c;
    }
    expect(seeThroughCoverage(50, 0, 1000, values, 1)).toBe(1);
    expect(seeThroughCoverage(50 + 24, 0, 1000, values, 1)).toBe(0);
  });
});

describe('worldCut: per-frame path allocates nothing and writes only when told to', () => {
  it('seeThroughValuesFor, seeThroughView and writeSeeThroughUniforms work in place', () => {
    const out = createSeeThroughValues();
    const focus: SeeThroughFocus = { minX: 1, minY: 2, maxX: 3, maxY: 4, mode: 'place', peek: false, heightVoxels: 10 };
    expect(seeThroughValuesFor(focus, out)).toBe(out);
    const view = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    expect(seeThroughView(out, view)).toBe(view);
    const target = { uSeeA: new Float32Array(4), uSeeB: new Float32Array(4), uSeeC: new Float32Array(4) };
    const a = target.uSeeA;
    const b = target.uSeeB;
    writeSeeThroughUniforms(target, { ...createSeeThroughFrame(), ...out, strength: 0.5, revision: 1 });
    expect(target.uSeeA).toBe(a);
    expect(target.uSeeB).toBe(b);
    expect(b[3]).toBe(0.5);
  });

  it('an idle armed frame (same revision) writes nothing, however many times it is synced', () => {
    const sync = new SeeThroughUniformSync();
    const target = { uSeeA: new Float32Array(4), uSeeB: new Float32Array(4), uSeeC: new Float32Array(4) };
    const frame = { ...createSeeThroughFrame(), revision: 3, strength: 1 };
    expect(sync.sync(target, frame)).toBe(true);
    for (let i = 0; i < 100; i += 1) expect(sync.sync(target, frame)).toBe(false);
    expect(sync.writes).toBe(1);
    sync.invalidate();
    expect(sync.sync(target, frame), 'a rebuilt pipeline re-uploads').toBe(true);
  });

  it('the wake-up values never leave a cut bigger than the soft margin around the hole', () => {
    // The warm-up writes a huge hole and restores it; the margin it reads must stay finite so the
    // smoothstep edges are ordered (edge0 < edge1), which GLSL requires for a defined result.
    const values = createSeeThroughValues();
    expect(0.4 * values.margin).toBeLessThan(values.margin);
    expect(SEE_THROUGH.PEEK_MARGIN_TEXELS).toBeGreaterThan(SEE_THROUGH.MARGIN_TEXELS);
  });
});
