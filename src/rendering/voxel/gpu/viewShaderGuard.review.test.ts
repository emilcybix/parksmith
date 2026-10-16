import { describe, expect, it } from 'vitest';
import { preprocessGlsl } from './glslTestKit';
import { voxelProgramSource, VOXEL_PROGRAM_NAMES } from './programs';
import { weatherChunks } from './shaders/compositeWeather';

/**
 * Phase 26 review (GPU/shader reviewer): weatherShaderGuard.test.ts runs its fxc / derivative rules on
 * `weatherChunks(tier)` with the default `viewTurn = false`, so the chunk that actually ships in the default
 * build (`weatherChunks('full', true)`: VX_VIEW_INVERSE + the view ground hook) was never checked by it. This
 * runs the same rules on the shipped chunk, and pins that a source built twice is identical (no runtime
 * variant creeps in: the program set compiled at startup is the only one). Reviewer-added; production untouched.
 */
describe('weather chunk as shipped (full tier, view code on): the weather guard rules', () => {
  const source = preprocessGlsl(weatherChunks('full', true));

  it('contains the view inverse map exactly once and the hook reads it once', () => {
    expect(source.match(/^vec2 vxWorldXYOfView\(/gm) ?? []).toHaveLength(1);
    expect(source.match(/vxWorldXYOfView\(viewPoint\.xy, uView\)/g) ?? []).toHaveLength(1);
  });

  it('reads no texture and uses no screen-space derivative', () => {
    expect(source).not.toMatch(/\b(?:texture|textureLod|texelFetch|textureGrad|dFdx|dFdy|fwidth)\s*\(/);
  });

  it('has no loop, array, struct, early loop exit, discard or modulo', () => {
    expect(source).not.toMatch(/\b(?:for|while|do|struct|continue|break|discard)\b/);
    expect(source).not.toMatch(/\[[^\]]*\]/);
    expect(source).not.toMatch(/%/);
  });

  it('keeps every shift on the unsigned hash and no precision override', () => {
    for (const match of source.matchAll(/(\w+)\s*(?:>>|<<)=?\s*\d+/g)) expect(match[1], 'shifted variable').toBe('h');
    expect(source).not.toMatch(/\b(?:lowp|mediump)\b|#extension|#version/);
  });
});

describe('program sources are a pure function of the build options (no runtime variant)', () => {
  it('builds byte-identical sources twice for every program, view on and off', () => {
    for (const viewTurn of [true, false]) {
      for (const name of VOXEL_PROGRAM_NAMES) {
        const a = voxelProgramSource(name, 'full', 'full', true, viewTurn);
        const b = voxelProgramSource(name, 'full', 'full', true, viewTurn);
        expect(a.vertex === b.vertex && a.fragment === b.fragment, `${name} viewTurn ${viewTurn}`).toBe(true);
      }
    }
  });

  it('declares uView as a uniform (never a constant or a define), so a turn is a uniform write and not a recompile', () => {
    for (const name of VOXEL_PROGRAM_NAMES) {
      const { vertex, fragment } = voxelProgramSource(name, 'full', 'full', true, true);
      for (const stage of [vertex, fragment]) {
        expect(stage, name).not.toMatch(/#define\s+VX_VIEW_Q|const\s+vec4\s+uView/);
      }
    }
  });
});
