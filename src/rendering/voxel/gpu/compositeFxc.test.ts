import { describe, expect, it } from 'vitest';
import { preprocessGlsl } from './glslTestKit';
import { voxelProgramSource } from './programs';
import type { CompositeVariant } from './shaders/composite';
import type { WeatherTier } from './shaders/compositeWeather';

/**
 * Static guard for the composite fragment shader against the HLSL compiler (fxc) behind ANGLE on
 * Windows. A real player's Chrome/Edge (Direct3D 11) refused the first version of this shader on
 * its first draw ("Error compiling dynamic pixel executable", GL_INVALID_OPERATION, HRESULT
 * 0x80004005) while SwiftShader — the only GPU the tests run on — accepted the identical GLSL.
 * fxc cannot be run here, so these tests do not prove the shader compiles on D3D; they keep out,
 * by construction, the constructs that are known to make fxc fail or blow up, on the exact source
 * the browser compiles (generated from TypeScript, comments stripped):
 *
 * fxc inlines every function, unrolls every loop it can and keeps struct values as copies. A struct
 * that holds arrays and is passed by value into functions called from an unrolled loop, indexed by
 * the loop variable, becomes a copy of the whole neighbourhood per call and a dynamically indexed
 * temp array per access — thousands of temp registers and a compile that gives up.
 *
 * The heuristics are deliberately blunt and cheap; each limit has a stated reason. If one trips
 * for a legitimate change, understand the reason first, then move the limit with a comment — the
 * numbers recorded below are what the shader measured when the guard was written.
 */

interface GlslFunction {
  name: string;
  params: string[];
  body: string;
}

/** `struct Name { ... };` declarations. */
const structsOf = (source: string): { name: string; body: string }[] =>
  [...source.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}\s*;/g)].map((match) => ({ name: match[1], body: match[2] }));

/** Top-level functions (declared at column 0, as every generated function is), with brace-matched bodies. */
const functionsOf = (source: string): GlslFunction[] => {
  const functions: GlslFunction[] = [];
  for (const match of source.matchAll(/^(?!(?:const|uniform|struct|out|in|precision)\b)[a-z]\w*\s+(\w+)\s*\(([^)]*)\)\s*\{/gm)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < source.length; close += 1) {
      if (source[close] === '{') depth += 1;
      if (source[close] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    functions.push({
      name: match[1],
      params: match[2].split(',').map((param) => param.trim()).filter((param) => param.length > 0),
      body: source.slice(open + 1, close),
    });
  }
  return functions;
};

/** Parameters whose type is a declared struct, as `function(param)` strings. */
const structParameters = (source: string): string[] => {
  const structNames = new Set(structsOf(source).map((entry) => entry.name));
  return functionsOf(source).flatMap((fn) => fn.params
    .filter((param) => param.split(/\s+/).some((token) => structNames.has(token)))
    .map((param) => `${fn.name}(${param})`));
};

/** Structs with an array member: whole-array copies on every assignment or by-value call. */
const structsWithArrays = (source: string): string[] =>
  structsOf(source).filter((entry) => entry.body.includes('[')).map((entry) => entry.name);

/**
 * Array subscripts whose index is not an integer literal — `name[expression]` — with the function
 * they sit in. Declarations (`float M[16]`) and constructors (`ivec2[4](`) have literal sizes and
 * do not count.
 */
const dynamicSubscripts = (source: string): { array: string; index: string; inFunction: string }[] => {
  const functions = functionsOf(source);
  const found: { array: string; index: string; inFunction: string }[] = [];
  for (const fn of functions) {
    for (const match of fn.body.matchAll(/(\w+)\s*\[([^\]]*)\]/g)) {
      if (!/^\s*\d+\s*$/.test(match[2])) found.push({ array: match[1], index: match[2].trim(), inFunction: fn.name });
    }
  }
  return found;
};

/** Every loop with its trip count (Infinity when the bound is not a literal or a const int). */
const loopsOf = (source: string): { header: string; trips: number }[] => {
  const constants = new Map([...source.matchAll(/\bconst\s+int\s+(\w+)\s*=\s*(\d+)\s*;/g)].map((match) => [match[1], Number(match[2])]));
  const loops: { header: string; trips: number }[] = [];
  for (const match of source.matchAll(/\b(for|while)\s*\(([^)]*)\)/g)) {
    const bounded = /^\s*int\s+(\w+)\s*=\s*(-?\d+)\s*;\s*\1\s*<\s*(\w+)\s*;/.exec(match[2]);
    const limit = bounded ? (/^\d+$/.test(bounded[3]) ? Number(bounded[3]) : constants.get(bounded[3])) : undefined;
    loops.push({ header: match[0], trips: bounded && limit !== undefined ? limit - Number(bounded[2]) : Infinity });
  }
  return loops;
};

/**
 * Characters of main once every call is expanded in place (fxc inlines everything): a function's
 * body plus, for each call site, the expansion of the callee. A proxy for the HLSL fxc has to
 * optimise — it catches a look duplicated at two call sites or a helper that grows per neighbour.
 */
const expandedSize = (source: string, entry: string): number => {
  const functions = new Map(functionsOf(source).map((fn) => [fn.name, fn]));
  const memo = new Map<string, number>();
  const sizeOf = (name: string): number => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const fn = functions.get(name);
    if (!fn) return 0;
    let size = fn.body.replace(/\s+/g, ' ').length;
    for (const other of functions.keys()) {
      if (other === name) continue;
      const calls = (fn.body.match(new RegExp(`\\b${other}\\(`, 'g')) ?? []).length;
      if (calls > 0) size += calls * sizeOf(other);
    }
    memo.set(name, size);
    return size;
  };
  return sizeOf(entry);
};

const fragmentOf = (variant: CompositeVariant, tier?: WeatherTier, kind: 'main' | 'translucent' | 'front' = 'main'): string =>
  preprocessGlsl(kind === 'front'
    ? voxelProgramSource('compositeFront', 'full', tier).fragment
    : voxelProgramSource('composite', variant, tier, kind === 'translucent').fragment);

/** The shape of the first, fxc-refused shader, in miniature: a struct of arrays, by value, in a loop. */
const REFUSED_SHAPE = `
const ivec2 OFFSET[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
struct Input {
  ivec2 texel;
  float depthKey[4];
  vec4 gdata[4];
};
bool far(Input i, int n) {
  return i.depthKey[n] > 0.0;
}
vec3 look(Input i) {
  vec3 color = vec3(0.0);
  for (int n = 0; n < 4; n++) {
    if (!far(i, n)) continue;
    color += vec3(i.gdata[n].rgb) * float(OFFSET[n].x);
  }
  return color;
}
void main() {}
`;

describe('fxc guard: the detectors', () => {
  it('flag the constructs of the refused shader (so a clean result means something)', () => {
    expect(structsWithArrays(REFUSED_SHAPE)).toEqual(['Input']);
    expect(structParameters(REFUSED_SHAPE)).toEqual(['far(Input i)', 'look(Input i)']);
    expect(dynamicSubscripts(REFUSED_SHAPE).map((entry) => `${entry.array}[${entry.index}]@${entry.inFunction}`)).toEqual([
      'depthKey[n]@far',
      'gdata[n]@look',
      'OFFSET[n]@look',
    ]);
    expect(loopsOf(REFUSED_SHAPE)).toEqual([{ header: 'for (int n = 0; n < 4; n++)', trips: 4 }]);
    expect(expandedSize(REFUSED_SHAPE, 'look')).toBeGreaterThan(expandedSize(REFUSED_SHAPE, 'far'));
  });

  it('accept literal subscripts, array declarations and constructors', () => {
    const source = 'float f(vec3 v) {\n  const float M[4] = float[4](1.0, 2.0, 3.0, 4.0);\n  return M[2] + v[0];\n}\n';
    expect(dynamicSubscripts(source)).toEqual([]);
  });
});

/**
 * Every shipped composite: the two variants at their default weather tier, plus the tiers the
 * fallback chain compiles (full without weather, full with rain only, lite without weather).
 */
interface CompositeCase {
  name: string;
  variant: CompositeVariant;
  tier?: WeatherTier;
  /** The translucent see-through build of the main run, or the front-layer run (default: the plain main run). */
  kind?: 'main' | 'translucent' | 'front';
  /** Recorded when the weather pass landed, ~20 % headroom (see the comment at the assertion). */
  limits: { size: number; expanded: number };
}

const COMPOSITES: readonly CompositeCase[] = [
  { name: 'full', variant: 'full', limits: { size: 19_800, expanded: 31_200 } },
  { name: 'lite', variant: 'lite', limits: { size: 9_400, expanded: 4_600 } },
  { name: 'full, no weather', variant: 'full', tier: 'none', limits: { size: 16_000, expanded: 21_700 } },
  { name: 'full, rain only', variant: 'full', tier: 'rain', limits: { size: 17_300, expanded: 24_600 } },
  { name: 'lite, no weather', variant: 'lite', tier: 'none', limits: { size: 8_200, expanded: 1_700 } },
  // The translucent see-through (see the record at the assertion): the shipped main run plus the coverage helper and the mix,
  // and the front-layer run, which is the same look with a transparent background and without rain, overlay and light fetch.
  { name: 'full, translucent', variant: 'full', kind: 'translucent', limits: { size: 20_900, expanded: 32_100 } },
  { name: 'full, translucent, no weather', variant: 'full', tier: 'none', kind: 'translucent', limits: { size: 17_000, expanded: 22_500 } },
  { name: 'front run', variant: 'full', kind: 'front', limits: { size: 20_200, expanded: 27_400 } },
  { name: 'front run, no weather', variant: 'full', tier: 'none', kind: 'front', limits: { size: 16_300, expanded: 21_000 } },
];

describe.each(COMPOSITES)('fxc guard: composite fragment ($name)', ({ variant, tier, kind, limits }) => {
  const source = fragmentOf(variant, tier, kind);

  it('declares no struct holding an array, and takes no struct parameter', () => {
    // WHY: an array inside a struct is copied whole on every by-value call and assignment, and
    // indexing it by a loop variable forces an indexable temp (fxc "temp register limit" / timeouts).
    expect(structsWithArrays(source), 'structs with arrays').toEqual([]);
    // WHY: a struct parameter is a by-value copy per call, and fxc inlines every call.
    expect(structParameters(source), 'functions taking a struct').toEqual([]);
    // The shader needs no struct at all, so none may creep back in unreviewed.
    expect(structsOf(source), 'any struct').toEqual([]);
  });

  it('indexes no array dynamically except the Bayer table', () => {
    // WHY: a subscript that is not a literal on a non-const-folded array makes fxc emit an indexable
    // temp (and, when the index is a loop variable, unroll the loop around it). The Bayer table in
    // common.ts is the one accepted case: a 16-entry float table in a tiny function that the world
    // programs — which the same ANGLE/D3D11 players run fine — already use.
    expect(dynamicSubscripts(source)).toEqual([
      { array: 'M', index: '(p.y & 3) * 4 + (p.x & 3)', inFunction: 'vxBayer4' },
    ]);
  });

  it('has no loops', () => {
    // WHY: fxc unrolls loops; the first version unrolled four iterations of a body that was itself
    // large and copied a struct per call. The four neighbours are four explicit, constant-offset
    // evaluations instead, so there is nothing to unroll and no continue/break inside one.
    const loops = loopsOf(source);
    expect(loops.map((loop) => loop.header), 'loops').toEqual([]);
    expect(Math.max(0, ...loops.map((loop) => loop.trips)), 'longest loop trip').toBe(0);
    expect(source, 'no early exits from a loop').not.toMatch(/\b(?:continue|break)\b/);
  });

  it('calls the look from one place, and stays below the recorded size and inlined-size limits', () => {
    // WHY: fxc inlines every call, so a look called from two branches is compiled twice, and the
    // inlined size of main is the best cheap proxy for the HLSL it must optimise.
    const main = functionsOf(source).find((fn) => fn.name === 'main');
    expect(main, 'main').toBeDefined();
    expect(main?.body.match(/\bvxLook\(/g) ?? [], 'vxLook call sites in main').toHaveLength(1);
    // The weather hooks are inlined too: one rain call and at most one shimmer call per main.
    expect(main?.body.match(/\bvxApplyRain\(/g) ?? [], 'vxApplyRain call sites in main').toHaveLength(kind === 'front' ? 0 : 1);
    expect(main?.body.match(/\bvxShimmerDx\(/g)?.length ?? 0, 'vxShimmerDx call sites in main').toBe(variant === 'full' && kind !== 'front' ? 1 : 0);
    const size = source.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join('\n').length;
    const expanded = expandedSize(source, 'main');
    // Recorded when the guard was written (comments and blank lines removed): full 11.1k chars,
    // 40 functions, main inlined 14.3k; lite 6.3k chars, main inlined 1.2k. The refused version
    // measured 9.4k chars, 33 functions, main inlined 9.7k by this same count (which does not
    // multiply a loop body by its trips) — so the size is not what separates them: the struct of
    // arrays, the by-value calls and the 17 dynamic subscripts are, and are asserted above. The
    // limits sit ~20% above the record: a feature may spend that, a copy-paste doubling may not.
    // Phase 20 (weather pass: rain, cloud noise, puddles, shimmer, flash; compositeWeather.ts) moved
    // the records to: full 16.5k chars / main inlined 26.0k; lite 7.8k / 3.8k; full without weather
    // 13.4k / 18.1k; full with rain only 14.4k / 20.5k; lite without weather 6.8k / 1.4k. The weather
    // chunks are straight-line scalar code (hash, noise, mix) behind a uniform branch: no loop, array,
    // struct or extra fetch, which is what the checks above pin. If the full composite is ever
    // refused on a Direct3D machine, the startup chain (glFailure.ts compositeRungsAfter) rebuilds it
    // without the weather pass first.
    // Phase 26 (view rotation, VX_VIEW; compositeWeather.ts): the full weather tier's ground hook maps the texel's view
    // point back to the world (vxWorldXYOfView: three scalar lines and one uniform, no fetch, loop or array), about +300
    // chars over the view-off build (full 16.8k -> 17.1k); the limits above were not moved. The rain, no-weather and lite
    // builds contain no view code, which viewTransform.test.ts pins.
    // The translucent see-through (VX_TRANSLUCENT) adds the coverage helper and the mix: full 17.4k chars /
    // main inlined 26.7k (full without it: 16.7k / 26.0k); without weather 14.1k / 18.7k. The front run
    // (compositeFront, a program of its own) is the same look without the light fetch, the rain, the
    // overlay and the shimmer: 16.8k / 22.8k, without weather 13.6k / 17.5k. None of them adds a loop, struct,
    // array or second look call; the translucent build is the first thing a refusing GPU drops (glFailure.ts).
    expect(size, 'preprocessed fragment size (chars, comments and blank lines removed)').toBeLessThanOrEqual(limits.size);
    expect(expanded, 'main with every call expanded in place (chars)').toBeLessThanOrEqual(limits.expanded);
  });
});

/**
 * The world-cut program (see-through cutaway) is the one opaque program with a `discard`, and no
 * browser test here can compile it with fxc. Its source is the shipped plain world program plus a
 * handful of straight-line scalar lines, so the guard pins exactly that: no struct, no loop, no
 * derivative, no dynamic subscript beyond what the plain program (which the same D3D11 players run
 * fine) already has, one discard ahead of every texture read, and a bounded size over the plain
 * program. If a change trips one of these, understand the reason before moving a limit.
 */
describe('fxc guard: world-cut fragment (see-through)', () => {
  const plain = preprocessGlsl(voxelProgramSource('worldOpaque').fragment);
  const cut = preprocessGlsl(voxelProgramSource('worldCut').fragment);
  const sizeOf = (source: string): number => source.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join('\n').length;

  it('declares no struct and takes no struct parameter, and has no loops or derivatives', () => {
    expect(structsOf(cut), 'any struct').toEqual([]);
    expect(structParameters(cut)).toEqual([]);
    expect(loopsOf(cut).map((loop) => loop.header), 'loops').toEqual([]);
    expect(cut, 'no early exits from a loop').not.toMatch(/\b(?:continue|break)\b/);
    // A derivative in a branch after a discard is undefined behaviour and a known fxc complaint.
    expect(cut).not.toMatch(/\b(?:dFdx|dFdy|fwidth)\b/);
  });

  it('indexes no array dynamically beyond what the shipped plain world program does', () => {
    const allowed = new Set(dynamicSubscripts(plain).map((entry) => `${entry.array}@${entry.inFunction}`));
    const extra = dynamicSubscripts(cut).filter((entry) => !allowed.has(`${entry.array}@${entry.inFunction}`));
    expect(extra).toEqual([]);
    expect(dynamicSubscripts(cut).some((entry) => entry.inFunction === 'main')).toBe(false);
  });

  it('discards once in the cut block, before any texture read, and the plain program has no discard', () => {
    expect(plain).not.toMatch(/\bdiscard\b/);
    const main = functionsOf(cut).find((fn) => fn.name === 'main')?.body ?? '';
    expect(main.match(/\bdiscard\b/g) ?? []).toHaveLength(1);
    expect(main.indexOf('discard')).toBeGreaterThan(-1);
    expect(main.slice(0, main.indexOf('discard'))).not.toMatch(/\btexture(?:Lod|Fetch)?\s*\(|texelFetch|vxSurfaceColor|vxMaterialProps/);
  });

  it('stays within a small, recorded size over the plain world program', () => {
    // The cut block is about a dozen scalar lines (see shaders/world.ts); 1.5k chars leaves room for tuning, not for a rewrite.
    expect(sizeOf(cut) - sizeOf(plain), 'extra chars over the plain program').toBeLessThanOrEqual(1_500);
    expect(expandedSize(cut, 'main') - expandedSize(plain, 'main'), 'extra inlined chars in main').toBeLessThanOrEqual(2_000);
  });
});

/**
 * The front-layer world program (`worldFront`, see-through) is the world-cut program with the discard turned
 * around: the same straight-line scalar lines, the same single discard ahead of every texture read.
 */
describe('fxc guard: front-layer world fragment (translucent see-through)', () => {
  const plain = preprocessGlsl(voxelProgramSource('worldOpaque').fragment);
  const front = preprocessGlsl(voxelProgramSource('worldFront').fragment);
  const cut = preprocessGlsl(voxelProgramSource('worldCut').fragment);
  const sizeOf = (source: string): number => source.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join('\n').length;

  it('declares no struct, loop, derivative or early exit', () => {
    expect(structsOf(front), 'any struct').toEqual([]);
    expect(structParameters(front)).toEqual([]);
    expect(loopsOf(front).map((loop) => loop.header), 'loops').toEqual([]);
    expect(front).not.toMatch(/\b(?:continue|break|dFdx|dFdy|fwidth)\b/);
  });

  it('indexes no array dynamically beyond what the shipped plain world program does', () => {
    const allowed = new Set(dynamicSubscripts(plain).map((entry) => `${entry.array}@${entry.inFunction}`));
    expect(dynamicSubscripts(front).filter((entry) => !allowed.has(`${entry.array}@${entry.inFunction}`))).toEqual([]);
    expect(dynamicSubscripts(front).some((entry) => entry.inFunction === 'main')).toBe(false);
  });

  it('discards once, ahead of every texture read, and the discard is the exact complement of the cut\'s', () => {
    const main = functionsOf(front).find((fn) => fn.name === 'main')?.body ?? '';
    expect(main.match(/\bdiscard\b/g) ?? []).toHaveLength(1);
    expect(main.slice(0, main.indexOf('discard'))).not.toMatch(/\btexture(?:Lod|Fetch)?\s*\(|texelFetch|vxSurfaceColor|vxMaterialProps/);
    expect(main).toContain('if (!(seeCut > 0.0)) discard;');
    expect(front).not.toMatch(/\bvxBayer4\(ivec2\(gl_FragCoord/);
    // The cut program at uSeeC.z > 0 discards exactly seeCut > 0.0 (threshold 0): the front layer keeps the rest.
    expect(cut).toContain('uSeeC.z > 0.0 ? 0.0 :');
    expect(front, 'a hair of key slack, so rounding never drops a fragment from both layers').toContain('const float VX_SEE_KEY_SLACK = 0.05;');
    expect(cut, 'the cut itself has none').toContain('const float VX_SEE_KEY_SLACK = 0.0;');
  });

  it('stays within a small, recorded size over the plain world program', () => {
    // Recorded: +627 chars over the plain program (the cut block); 1.5k leaves room for tuning, not for a rewrite.
    expect(sizeOf(front) - sizeOf(plain), 'extra chars over the plain program').toBeLessThanOrEqual(1_500);
    expect(expandedSize(front, 'main') - expandedSize(plain, 'main'), 'extra inlined chars in main').toBeLessThanOrEqual(2_000);
  });
});
