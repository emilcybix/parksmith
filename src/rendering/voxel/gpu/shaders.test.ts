import { describe, expect, it } from 'vitest';
import { COMPOSITE_FETCH_BUDGET } from '../contracts/budgets';
import { FIGURE_KEYFRAMES, ROLE_COUNT } from '../contracts/figures';
import { VOXEL_PROGRAM_NAMES, voxelProgramSource, type VoxelProgramName } from './programs';
import { compositeFetchCount, COMPOSITE_FETCHES, COMPOSITE_FETCHES_LITE, COMPOSITE_LOOK_BRANCH_FETCHES } from './shaders/composite';
import { FIGURE_FRAMES, figureKeyframesGlsl } from './shaders/figure';
import { preprocessGlsl as preprocess } from './glslTestKit';
import { LIGHT_PRESETS } from '../lightPresets';
import { createDayWeights, dayWeights } from '../../dayCycle';
import { blendLightPreset, createDayLook } from '../dayLook';
import { glslFloat, glslInt, glslIvec2, glslRgb, glslVec2, rgbToUnit } from './shaders/glsl';

/**
 * The GLSL is generated from TypeScript, so the rules that keep it fast and linkable on real GPUs
 * can be checked in Node on the exact source the browser compiles: no `discard` in any program an
 * opaque draw uses (it switches off early-Z / hidden-surface removal on Mali, Adreno and Apple),
 * uniforms that agree between stages, every sampler highp, the keyframe table baked exactly, and
 * the composite's texel fetches within budget. Compilation itself is verified in the browser.
 */

/** name → type of every uniform an (already preprocessed) stage declares; throws on a duplicate. */
const uniformsOf = (stage: string): Map<string, string> => {
  const uniforms = new Map<string, string>();
  for (const match of stage.matchAll(/^\s*uniform\s+(?:(highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*;/gm)) {
    const [, precision, type, name] = match;
    expect(uniforms.has(name), `uniform ${name} declared twice in one stage`).toBe(false);
    uniforms.set(name, `${precision ?? ''} ${type}`.trim());
  }
  return uniforms;
};

const samplersOf = (stage: string): string[] =>
  [...stage.matchAll(/^\s*uniform\s+highp\s+sampler2D\s+(\w+)\s*;/gm)].map((match) => match[1]);

const stagesOf = (name: VoxelProgramName): { vertex: string; fragment: string } => {
  const source = voxelProgramSource(name);
  return { vertex: preprocess(source.vertex), fragment: preprocess(source.fragment) };
};

/** The programs that may discard: the dithered ghost and decals, and the see-through cut and front layer of the world. */
const isDither = (name: VoxelProgramName): boolean => name.endsWith('Dither') || name === 'worldCut' || name === 'worldFront';

describe('voxel GLSL programs', () => {
  it('start both stages with #version 300 es (Pixi detects ES 3.00 from the fragment only)', () => {
    for (const name of VOXEL_PROGRAM_NAMES) {
      const { vertex, fragment } = voxelProgramSource(name);
      expect(vertex.startsWith('#version 300 es\n'), `${name} vertex`).toBe(true);
      expect(fragment.startsWith('#version 300 es\n'), `${name} fragment`).toBe(true);
    }
  });

  it('keep discard out of every program an opaque draw uses, and in every dither variant', () => {
    for (const name of VOXEL_PROGRAM_NAMES) {
      const { vertex, fragment } = stagesOf(name);
      expect(/\bdiscard\b/.test(vertex), `${name} vertex`).toBe(false);
      expect(/\bdiscard\b/.test(fragment), `${name} fragment`).toBe(isDither(name));
    }
  });

  it('declare each uniform once per stage, with the same type in both stages, samplers highp', () => {
    for (const name of VOXEL_PROGRAM_NAMES) {
      const { vertex, fragment } = stagesOf(name);
      const vertexUniforms = uniformsOf(vertex);
      const fragmentUniforms = uniformsOf(fragment);
      for (const [uniform, type] of vertexUniforms) {
        if (fragmentUniforms.has(uniform)) expect(fragmentUniforms.get(uniform), `${name}: ${uniform} in both stages`).toBe(type);
      }
      for (const [uniform, type] of [...vertexUniforms, ...fragmentUniforms]) {
        if (type.endsWith('sampler2D')) expect(type, `${name}: ${uniform}`).toBe('highp sampler2D');
      }
    }
  });

  it('keep the resource layout VoxelGpu binds (samplers in order; Pixi generates one sync per program)', () => {
    const samplers = (name: VoxelProgramName): string[] => {
      const { vertex, fragment } = stagesOf(name);
      const all = [...samplersOf(vertex), ...samplersOf(fragment)];
      return all.filter((sampler, index) => all.indexOf(sampler) === index);
    };
    expect(samplers('worldOpaque')).toEqual(['uBoxes', 'uTransforms', 'uPalette']);
    expect(samplers('worldDither')).toEqual(['uBoxes', 'uTransforms', 'uPalette']);
    expect(samplers('worldCut')).toEqual(['uBoxes', 'uTransforms', 'uPalette']);
    expect(samplers('worldFront')).toEqual(['uBoxes', 'uTransforms', 'uPalette']);
    expect(samplers('figureOpaque')).toEqual(['uEntities', 'uTemplates', 'uPalette']);
    expect(samplers('figureDither')).toEqual(['uEntities', 'uTemplates', 'uPalette']);
    expect(samplers('lightPass')).toEqual(['uLights', 'uDepth', 'uGData']);
    expect(samplers('composite')).toEqual(['uAlbedo', 'uGData', 'uDepth', 'uLight', 'uOverlay', 'uFront']);
    expect(samplers('compositeFront')).toEqual(['uAlbedo', 'uGData', 'uDepth', 'uLight', 'uOverlay', 'uFront']);
    expect(samplers('upscale')).toEqual(['uComposite']);
  });

  it('map geometry through the power-of-two clip size, snapped to the sub-texel grid', () => {
    for (const name of ['worldOpaque', 'worldDither', 'worldCut', 'worldFront', 'figureOpaque', 'figureDither'] as const) {
      const { vertex } = stagesOf(name);
      const clip = /vxClip\(([^;]*)\);/.exec(vertex);
      expect(clip?.[1], name).toContain('uClipSize');
      expect(clip?.[1], name).not.toContain('uLowSize');
    }
    // The world program projects the VIEW point (Phase 26); viewTransform.test.ts pins the pre-rotation text.
    // Phase 55: both the snap and the clip mapping take the texel scale.
    expect(stagesOf('worldOpaque').vertex).toContain('vxClip(vxSnapSubtexel(vxProject(view), uTexelScale), uCameraTexel, uClipSize, uTexelScale,');
  });

  it('call the look exactly once and stay within the composite fetch budget, counted from the call sites', () => {
    const source = voxelProgramSource('composite', 'full', undefined, true);
    const fragment = preprocess(source.fragment);
    const count = (pattern: RegExp): number => (fragment.match(pattern) ?? []).length;
    expect(count(/\bvec3 vxLook\(/g), 'one vxLook definition').toBe(1);
    expect(count(/\bvxLook\(/g), 'one definition and exactly one call').toBe(2);
    expect(count(/\bvec3 vxLook\(\s*ivec2 texel,/g), 'the look takes plain scalars and vectors').toBe(1);

    // Every texel fetch of the shader, found in the source: the helpers' own fetches are reached
    // through their call sites (a helper called four times is four fetches), the rest are direct.
    const defined = (name: string): number => count(new RegExp(`\\b(?:float|vec4|bool) ${name}\\(`, 'g'));
    const calls = (name: string): number => count(new RegExp(`\\b${name}\\(`, 'g')) - defined(name);
    expect(defined('vxNeighbourDepth'), 'one neighbour depth helper').toBe(1);
    expect(count(/texelFetch\(uDepth, vxTapClamp/g), 'the depth fetch lives in vxTapDepth only').toBe(1);
    expect(count(/\bvxTapDepth\(/g) - 1, 'vxTapDepth is reached from the neighbour depth and shadow tap helpers alone').toBe(2);

    // The look's two branches are an if / else: the silhouette branch fetches the nearest neighbour's albedo, the
    // other branch the contact shadow's two taps. A texel pays the larger of the two, not their sum.
    const silhouetteFetches = calls('vxTapAlbedo');
    const shadowFetches = calls('vxShadowTap');
    expect(silhouetteFetches, 'the silhouette branch').toBe(COMPOSITE_LOOK_BRANCH_FETCHES.silhouette);
    expect(shadowFetches, 'the contact shadow taps').toBe(COMPOSITE_LOOK_BRANCH_FETCHES.shadow);
    const look = fragment.slice(fragment.indexOf('vec3 vxLook('));
    const branchStart = look.indexOf('if (outline.x > 0.5 && !exempt) {');
    const elseAt = look.indexOf('} else {', branchStart);
    expect(branchStart, 'the look branches on the silhouette').toBeGreaterThan(-1);
    const silhouetteBranch = look.slice(branchStart, elseAt);
    const otherBranch = look.slice(elseAt, look.indexOf('return color;'));
    expect(silhouetteBranch, 'the albedo fetch sits in the silhouette branch').toContain('vxTapAlbedo(');
    expect(silhouetteBranch).not.toContain('vxContactShadow(');
    expect(otherBranch, 'the shadow taps sit in the other branch (through vxContactShadow)').toContain('vxContactShadow(');
    expect(otherBranch).not.toContain('vxTapAlbedo(');
    expect(count(/\bvxContactShadow\(/g) - defined('vxContactShadow'), 'one contact shadow call').toBe(1);

    const sites = {
      ownDepth: count(/texelFetch\(uDepth, texel, 0\)/g),
      neighbourDepth: calls('vxNeighbourDepth'),
      neighbourGData: calls('vxNeighbourGData'),
      ownAlbedo: count(/texelFetch\(uAlbedo, texel, 0\)/g),
      ownGData: count(/texelFetch\(uGData, texel, 0\)/g),
      light: count(/texelFetch\(uLight, texel, 0\)/g),
      overlay: count(/texelFetch\(uOverlay, texel, 0\)/g),
      lookBranch: Math.max(silhouetteFetches, shadowFetches),
      frontLayer: count(/texelFetch\(uFront, frontTexel, 0\)/g),
    };
    expect(sites, 'call sites agree with COMPOSITE_FETCHES').toEqual(COMPOSITE_FETCHES);
    expect(compositeFetchCount()).toBe(Object.values(sites).reduce((sum, fetches) => sum + fetches, 0));
    expect(compositeFetchCount(), 'worst-case texel fetches').toBeLessThanOrEqual(COMPOSITE_FETCH_BUDGET);
    expect(compositeFetchCount('full', false), 'without the translucent layer').toBe(COMPOSITE_FETCH_BUDGET - 1);
  });

  it('read the front layer in one place only: the translucent main run, inside the hole rectangle, behind a range compare', () => {
    const translucent = preprocess(voxelProgramSource('composite', 'full', undefined, true).fragment);
    const plain = preprocess(voxelProgramSource('composite', 'full').fragment);
    const frontRun = preprocess(voxelProgramSource('compositeFront').fragment);
    const lite = preprocess(voxelProgramSource('composite', 'lite', undefined, true).fragment);
    const fetches = (source: string): number => (source.match(/texelFetch\(uFront/g) ?? []).length;
    expect(fetches(translucent), 'one fetch in the translucent main').toBe(1);
    expect(fetches(plain), 'none in the plain composite').toBe(0);
    // The front run binds the MAIN depth as uFront: one fetch, the nearer-in-front test (not the lit layer it renders into).
    expect(fetches(frontRun), 'one fetch in the front run: the main depth').toBe(1);
    expect(frontRun).toContain('texelFetch(uFront, texel + ivec2(uSeeC.xy), 0).r');
    expect(frontRun, 'the layer is switched off where the main buffer is nearer by the slack').toMatch(
      /vxDepthKeyAt\(mainDepth\) > vxDepthKeyAt\(layerDepth\) \+ VX_SEE_NEARER_SLACK\) color = vec4\(0\.0\)/);
    expect(fetches(lite), 'none in lite, whatever it is asked').toBe(0);
    const fetchAt = translucent.indexOf('texelFetch(uFront');
    const guard = translucent.slice(translucent.lastIndexOf('if (', fetchAt), fetchAt);
    expect(guard, 'the fetch is range-checked, so it needs no clamp').toMatch(/uSeeC\.z > 0\.0 && frontTexel\.x >= 0 && frontTexel\.y >= 0 && float\(frontTexel\.x\) < uSeeC\.z && float\(frontTexel\.y\) < uSeeC\.w/);
    expect(translucent.indexOf('vxApplyRain(color'), 'the mix runs before the rain and the overlay').toBeGreaterThan(fetchAt);
    // The mix is the premultiplied over of the lit layer, weighted by coverage and the shared opacity.
    expect(translucent).toMatch(/float weight = frontLit\.a \* \(1\.0 - vxSeeCoverage\(texel\) \* \(1\.0 - VX_SEE_OPACITY\)\);/);
    expect(translucent).toMatch(/const float VX_SEE_OPACITY = 0\.3;/);
  });

  it('keep the front run a full look of its own: transparent background, its own light pools, no rain, overlay or shimmer', () => {
    const front = preprocess(voxelProgramSource('compositeFront').fragment);
    const main = front.slice(front.indexOf('void main'));
    expect(main).toContain('vec4 color = vec4(0.0);');
    expect(main).not.toMatch(/vxBackground\(|vxApplyRain\(|vxApplyOverlay\(|vxShimmerDx\(|texelFetch\(uOverlay/);
    expect(main, 'the layer is lit by the light pass run over the front G-buffer, behind the same switch').toContain(
      'if (uLightEnabled > 0.5) light = texelFetch(uLight, texel, 0).rgb;');
    expect((front.match(/\bvxLook\(/g) ?? []).length, 'one definition, one call').toBe(2);
    expect(main, 'the ring rule: a background texel is inked only where the cut itself has coverage').toContain('nextToOccluder && vxSeeCoverage(texel) > 0.0');
    // Worst case fetches: the main's table without the overlay and the front fetch, plus the main depth.
    expect(compositeFetchCount() - COMPOSITE_FETCHES.overlay - COMPOSITE_FETCHES.frontLayer + 1).toBeLessThanOrEqual(COMPOSITE_FETCH_BUDGET);
  });

  it('keep the lite composite to the texel itself: no neighbour taps, no light target', () => {
    const fragment = preprocess(voxelProgramSource('composite', 'lite').fragment);
    const count = (pattern: RegExp): number => (fragment.match(pattern) ?? []).length;
    expect(count(/\bvec3 vxLook\(vec4 albedo, vec4 gdata\)/g), 'the lite look').toBe(1);
    expect(count(/\bvxLook\(/g), 'one definition, one call').toBe(2);
    const sites = {
      ownDepth: count(/texelFetch\(uDepth, texel, 0\)/g),
      ownAlbedo: count(/texelFetch\(uAlbedo, texel, 0\)/g),
      ownGData: count(/texelFetch\(uGData, texel, 0\)/g),
      overlay: count(/texelFetch\(uOverlay, texel, 0\)/g),
    };
    expect(sites, 'call sites agree with COMPOSITE_FETCHES_LITE').toEqual(COMPOSITE_FETCHES_LITE);
    expect(compositeFetchCount('lite')).toBe(4);
    // The shared tap helpers (3 fetches, never called here) sit in the prelude; the lite main and
    // look reach none of them, and the compiler drops them.
    expect(count(/texelFetch\(/g), 'no other fetch anywhere').toBe(4 + 3);
    const reachable = fragment.slice(fragment.indexOf('vec3 vxGrade('));
    expect(reachable, 'no neighbour read, no tap helper, no neighbour step').not.toMatch(/vxTap|vxNeighbour|VX_STEP_/);
    expect(fragment, 'the light target is never read').not.toMatch(/texelFetch\(uLight/);
  });

  it('keep the same samplers, in the same order, in both composite variants (one resource layout)', () => {
    const samplers = (variant: 'full' | 'lite'): string[] => samplersOf(preprocess(voxelProgramSource('composite', variant).fragment));
    expect(samplers('lite')).toEqual(samplers('full'));
    expect(samplers('lite')).toEqual(['uAlbedo', 'uGData', 'uDepth', 'uLight', 'uOverlay', 'uFront']);
    expect(voxelProgramSource('composite', 'lite').vertex).toBe(voxelProgramSource('composite', 'full').vertex);
  });
});

describe('figure keyframes in GLSL', () => {
  it('bakes FIGURE_KEYFRAMES exactly, role-major, as ivec2(forward, up)', () => {
    const glsl = figureKeyframesGlsl();
    const list = /VX_FIGURE_KEYFRAMES\[(\d+)\] = ivec2\[\d+\]\((.*)\);/.exec(glsl);
    expect(list, 'the const array').not.toBeNull();
    const entries = [...(list?.[2] ?? '').matchAll(/ivec2\((-?\d+), (-?\d+)\)/g)].map((match) => [Number(match[1]), Number(match[2])]);
    expect(Number(list?.[1])).toBe(ROLE_COUNT * FIGURE_FRAMES);
    expect(entries).toEqual(FIGURE_KEYFRAMES.flatMap((row) => row.map(([forward, up]) => [forward, up])));
    expect(glsl).toContain(`const int VX_FIGURE_FRAMES = ${FIGURE_FRAMES};`);
  });

  it('refuses a malformed table instead of baking a garbled walk', () => {
    expect(() => figureKeyframesGlsl(FIGURE_KEYFRAMES.slice(1))).toThrow(/roles/);
    expect(() => figureKeyframesGlsl(FIGURE_KEYFRAMES.map((row) => row.slice(1)))).toThrow(/keyframes/);
    expect(() => figureKeyframesGlsl(FIGURE_KEYFRAMES.map((row) => row.map(([forward]) => [forward + 0.5, 0] as const)))).toThrow(/GLSL int/);
  });
});

describe('GLSL literals', () => {
  it('writes floats with a decimal point and ints without, refusing what GLSL cannot hold', () => {
    expect(glslFloat(1)).toBe('1.0');
    expect(glslFloat(-4)).toBe('-4.0');
    expect(glslFloat(0.25)).toBe('0.25');
    expect(() => glslFloat(Number.NaN)).toThrow();
    expect(glslInt(-3)).toBe('-3');
    expect(() => glslInt(1.5)).toThrow();
    expect(glslVec2([0, 2])).toBe('vec2(0.0, 2.0)');
    expect(glslIvec2([2, -1])).toBe('ivec2(2, -1)');
  });

  it('turns 0xRRGGBB into sRGB components in 0..1', () => {
    expect(glslRgb(0xff0080)).toBe(`vec3(1.0, 0.0, ${128 / 255})`);
    const out = new Float32Array(4);
    rgbToUnit(0x173f3b, out, 1);
    expect(Array.from(out)).toEqual([0, Math.fround(0x17 / 255), Math.fround(0x3f / 255), Math.fround(0x3b / 255)]);
  });
});

describe('the look: contact shadow and presets', () => {
  const look = preprocess(voxelProgramSource('composite', 'full').fragment);

  it('shades top faces only, from rises of 3+ voxels within 8, in thirds on the world-anchored shadow dither', () => {
    expect(look).toContain('const float VX_SHADOW_MIN_RISE = 3.0;');
    expect(look).toContain('const float VX_SHADOW_REACH = 8.0;');
    expect(look).toMatch(/faceC == VX_FACE_TOP && uTaps > 0\.5/);
    expect(look).toMatch(/floor\(amount \* 3\.0 \+ vxBayer4\(vxWorldTexel\(texel\) \+ VX_DITHER_OFFSET_SHADOW\)\) \/ 3\.0/);
    expect(look).toMatch(/mix\(vec3\(1\.0\), uShadowTint, uShadowStrength \* shade\)/);
    // The three level weights make one full shadow; the 1-texel tap reuses the up neighbour's depth.
    const weights = [...look.matchAll(/const float VX_SHADOW_WEIGHT_\d = ([\d.]+);/g)].map((match) => Number(match[1]));
    expect(weights).toHaveLength(3);
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 6);
    expect(look).toContain('vxShadowHit(p, texel + VX_STEP_UP, depthUp)');
  });

  it('keeps the park colourful: day top faces show the catalogue colour within 3 %, no preset desaturates', () => {
    const day = LIGHT_PRESETS.day;
    for (let channel = 0; channel < 3; channel += 1) {
      const topFace = (day.ambient[channel] + day.key[channel]) * day.exposure * day.tint[channel];
      expect(Math.abs(topFace - 1), `day top face, channel ${channel}`).toBeLessThanOrEqual(0.03);
    }
    expect(day.saturation).toBeGreaterThanOrEqual(1);
    for (const [name, preset] of Object.entries(LIGHT_PRESETS)) {
      expect(preset.saturation, `${name} saturation`).toBeGreaterThanOrEqual(1);
      expect(preset.shadowStrength, `${name} contact shadow is on`).toBeGreaterThan(0);
      expect(preset.shadowTint[2], `${name} shadows are cool`).toBeGreaterThan(preset.shadowTint[0]);
    }
    expect(LIGHT_PRESETS.day.background, 'day shows the page gradient').toBeNull();
    expect(LIGHT_PRESETS.night.background, 'night is a dark teal').toBe(0x10201e);
  });

  it('keeps the park colourful through the whole day cycle, not only at the three presets', () => {
    const w = createDayWeights();
    for (let minute = 0; minute < 1440; minute += 1) {
      const blended = blendLightPreset(createDayLook(), dayWeights(w, minute / 1440));
      expect(blended.saturation, `saturation at minute ${minute}`).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(blended.shadowStrength).toBeGreaterThan(0);
      expect(blended.shadowTint[2]).toBeGreaterThan(blended.shadowTint[0]);
    }
    // Day plateau: top faces show the catalogue colour (same bound as above), through the blend.
    const noon = blendLightPreset(createDayLook(), dayWeights(w, 0.5));
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs((noon.ambient[channel] + noon.key[channel]) * noon.exposure * noon.tint[channel] - 1)).toBeLessThanOrEqual(0.03);
    }
  });

  it('fades the background in premultiplied (alpha 0 = page gradient, 1 = opaque teal, between = a partial backdrop), no 0.5 threshold', () => {
    for (const variant of ['full', 'lite'] as const) {
      const source = preprocess(voxelProgramSource('composite', variant).fragment);
      // The lightning lift (uWxD.x, 0 on a clear sky) scales the opaque backdrop; alpha is untouched.
      expect(source, variant).toMatch(/vec4 vxBackground\(\) \{\s*return vec4\(uBackground\.rgb \* uBackground\.a \* \(1\.0 \+ 0\.45 \* uWxD\.x\), uBackground\.a\);\s*\}/);
      expect(source, variant).not.toMatch(/uBackground\.a > 0\.5/);
    }
  });
});
