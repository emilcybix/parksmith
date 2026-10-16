import { describe, expect, it } from 'vitest';
import { LIGHT_PRESETS } from '../lightPresets';
import { preprocessGlsl } from './glslTestKit';
import { voxelProgramSource } from './programs';
import { weatherChunks, type WeatherTier } from './shaders/compositeWeather';
import { CLOUD_WRAP_VOXELS, RAIN_WRAP_ROWS } from '../../weatherLook';

/**
 * Adversarial guards for the Phase 20 weather pass (reviewer additions; production code untouched).
 * They pin what the pass must never do on the ANGLE/D3D11 path and what the user decided.
 */

/** USER DECISION: the day/dusk/night values stay exactly as authored (the user likes the night look). */
const AUTHORED_PRESETS = `{"day":{"ambient":[0.5,0.53,0.62],"key":[0.5,0.47,0.38],"exposure":1,"saturation":1,"tint":[1,1,1],"background":null,"emissiveScale":0.35,"glassGlow":0,"lightPass":false,"lightStrength":0,"outlineTint":[0.42,0.45,0.55],"outlineInkMix":0.3,"contourFactor":0.8,"shadowStrength":1,"shadowTint":[0.5,0.56,0.84]},"dusk":{"ambient":[0.4,0.4,0.62],"key":[0.7,0.5,0.3],"exposure":1,"saturation":1.12,"tint":[1.02,0.97,0.95],"background":null,"emissiveScale":0.9,"glassGlow":0.9,"lightPass":true,"lightStrength":0.9,"outlineTint":[0.4,0.4,0.55],"outlineInkMix":0.35,"contourFactor":0.78,"shadowStrength":1,"shadowTint":[0.6,0.62,0.86]},"night":{"ambient":[0.27,0.32,0.52],"key":[0.12,0.15,0.26],"exposure":1,"saturation":1.1,"tint":[0.95,0.99,1.08],"background":1056798,"emissiveScale":1,"glassGlow":1,"lightPass":true,"lightStrength":1.3,"outlineTint":[0.35,0.38,0.55],"outlineInkMix":0.4,"contourFactor":0.75,"shadowStrength":1,"shadowTint":[0.6,0.64,0.9]}}`;

describe('lightPresets are unchanged by Phase 20', () => {
  it('day, dusk and night hold the authored values', () => {
    expect(JSON.stringify(LIGHT_PRESETS)).toBe(AUTHORED_PRESETS);
  });
});

const TIERS: readonly WeatherTier[] = ['full', 'rain', 'none'];

describe.each(TIERS)('weather chunks, tier %s: constructs fxc or the derivative rules dislike', (tier) => {
  const source = preprocessGlsl(weatherChunks(tier));

  it('read no texture and use no screen-space derivative (it runs inside non-uniform branches)', () => {
    expect(source).not.toMatch(/\b(?:texture|textureLod|texelFetch|textureGrad|dFdx|dFdy|fwidth)\s*\(/);
  });

  it('has no loop, array, struct, early loop exit, modulo or float-to-int of a negative modulus', () => {
    expect(source).not.toMatch(/\b(?:for|while|do|struct|continue|break|discard)\b/);
    expect(source).not.toMatch(/\[[^\]]*\]/);
    expect(source).not.toMatch(/%/);
  });

  it('keeps the fragment-stage defaults: no precision qualifier overrides, no extension or version directives', () => {
    expect(source).not.toMatch(/\b(?:lowp|mediump)\b|#extension|#version/);
  });

  it('has every shift on an unsigned operand (signed shifts of negatives differ between compilers)', () => {
    for (const match of source.matchAll(/(\w+)\s*(?:>>|<<)=?\s*\d+/g)) expect(match[1], 'shifted variable').toBe('h');
  });
});

describe('weather hooks', () => {
  it.each(TIERS)('defines each hook exactly once, with the signature the mains call (%s)', (tier) => {
    const source = preprocessGlsl(weatherChunks(tier));
    expect(source.match(/^vec4 vxApplyRain\(/gm) ?? []).toHaveLength(1);
    expect(source.match(/^vec3 vxWeatherSurface\(/gm) ?? []).toHaveLength(1);
    expect(source.match(/^int vxShimmerDx\(/gm) ?? []).toHaveLength(1);
  });

  it('the rain slant is a constant: an eased slant would re-hash every streak column on each step', () => {
    const source = preprocessGlsl(weatherChunks('rain'));
    const layer = /vec4 vxRainLayer[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    expect(layer).toMatch(/int col = w\.x - int\(floor\(float\(w\.y\) \* 0\.25\)\) \+ shift;/);
    expect(layer).not.toMatch(/uWxB\.y/);
  });

  it('a clear sky costs a uniform compare: every effect hook is gated on the enabled flag before any work', () => {
    const source = preprocessGlsl(weatherChunks('full'));
    const rain = /vec4 vxApplyRain[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    expect(rain).toMatch(/if \(uWxA\.x > 0\.5 && uWxB\.x > 0\.0\)/);
    const shimmer = /int vxShimmerDx[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    expect(shimmer.split('\n')[1]).toMatch(/uWxA\.x < 0\.5/);
    const full = preprocessGlsl(voxelProgramSource('composite', 'full', 'full').fragment);
    expect(full).toMatch(/if \(uWxA\.x > 0\.5 && !background && !exempt\) lit = vxWeatherSurface/);
  });

  it('the none tier compiles no effect: no hash, no noise, no uWx reads in the hooks', () => {
    const source = preprocessGlsl(weatherChunks('none'));
    expect(source).not.toMatch(/uWx|vxWxHash|vxCloudNoise/);
  });

  it('the lite composite never gets the neighbour-reading shimmer or the ground pass at its default tier', () => {
    const lite = preprocessGlsl(voxelProgramSource('composite', 'lite').fragment);
    expect(lite).not.toMatch(/vxCloudNoise|vxWetGround/);
    expect(lite).toMatch(/vxApplyRain/);
  });
});

describe('periodicity: the shader patterns repeat exactly over the CPU wrap, so a wrap never pops', () => {
  const source = preprocessGlsl(weatherChunks('full'));

  it('cloud octaves: 8 cells of 56 voxels and 16 cells of 28 voxels both span the cloud wrap', () => {
    expect(8 * 56).toBe(CLOUD_WRAP_VOXELS);
    expect(16 * 28).toBe(CLOUD_WRAP_VOXELS);
    expect(source).toMatch(/vxCloudNoise\(q, 56\.0, 7, 1\)/);
    expect(source).toMatch(/vxCloudNoise\(q \+ 117\.0, 28\.0, 15, 2\)/);
  });

  it('rain: 32-row cycle and a 64-cycle ripple clock divide the row wrap; shimmer advances a whole wave per 32 rows', () => {
    expect(RAIN_WRAP_ROWS % 32).toBe(0);
    expect(RAIN_WRAP_ROWS % 64).toBe(0);
    expect(source).toMatch(/\/ 32\.0 \+/);
    expect(source).toMatch(/uWxC\.z \* 0\.015625/);
    const perRow = Number(/uWxD\.y \* ([0-9.]+)/.exec(source)?.[1]);
    const wraps = (RAIN_WRAP_ROWS * perRow) / (2 * Math.PI);
    expect(Math.abs(wraps - Math.round(wraps)), 'whole sine periods per wrap').toBeLessThan(1e-3);
  });
});
