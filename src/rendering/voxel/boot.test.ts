import { describe, expect, it, vi } from 'vitest';
import type { GlProgram, WebGLRenderer } from 'pixi.js';
import { revalidateGpu, validateGpu } from './boot';
import { degradePlanFor } from './gpu/glFailure';

/**
 * boot.ts's validation, against a scripted WebGL context: what the failure message of a program
 * that does not link carries (its name, so VoxelRenderer can pick a fallback, and the driver's
 * log), and the order of a re-validation (warm-up draws first, judgement after).
 */

const program = (name: string): GlProgram => ({ vertex: `#version 300 es\n#define SHADER_NAME ${name}-vertex\nvoid main() {}` }) as unknown as GlProgram;

interface FakeOptions {
  /** Names of programs that fail to link, with the program log. */
  failing?: Record<string, string>;
  shaderLog?: string;
  lost?: boolean;
  log?: string[];
}

const fakeRenderer = (options: FakeOptions = {}): WebGLRenderer => {
  const log = options.log ?? [];
  const linked = new Map<object, string>();
  const gl = {
    LINK_STATUS: 1, FRAMEBUFFER: 2, FRAMEBUFFER_COMPLETE: 3, NO_ERROR: 0,
    getProgramParameter: (handle: object) => !((options.failing ?? {})[linked.get(handle) ?? ''] !== undefined),
    getProgramInfoLog: (handle: object) => (options.failing ?? {})[linked.get(handle) ?? ''] ?? '',
    getAttachedShaders: () => [{}],
    getShaderInfoLog: () => options.shaderLog ?? '',
    bindFramebuffer: () => undefined,
    checkFramebufferStatus: () => 3,
    getError: () => 0,
    isContextLost: () => options.lost ?? false,
  };
  return {
    gl,
    shader: {
      _getProgramData: (source: GlProgram) => {
        const handle = {};
        linked.set(handle, /SHADER_NAME ([\w-]+?)-vertex/.exec(source.vertex ?? '')?.[1] ?? '');
        log.push('link');
        return { program: handle };
      },
    },
    renderTarget: { getRenderTarget: () => ({}), getGpuRenderTarget: () => ({ framebuffer: {} }) },
    resetState: () => undefined,
  } as unknown as WebGLRenderer;
};

const failureOf = (run: () => void): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
};

describe('validateGpu link failures', () => {
  it('names the program that did not link, so the lite composite can rescue a composite that fails at link time', () => {
    const renderer = fakeRenderer({ failing: { 'voxel-composite': 'D3D: Error compiling dynamic pixel executable' } });
    const error = failureOf(() => validateGpu(renderer, [program('voxel-upscale'), program('voxel-composite')], []));
    expect(error.message).toContain('failed to link [program voxel-composite-vertex]');
    expect(error.message).toContain('Error compiling dynamic pixel executable');
    expect(degradePlanFor(error), 'the fallback matches it').toEqual({ viewRotation: false, composite: true, lights: false, shadows: false, seeThrough: false, translucent: false });
  });

  it('includes each shader\'s compile log, truncated, and says so when the driver says nothing', () => {
    const long = 'x'.repeat(2_000);
    const verbose = failureOf(() => validateGpu(fakeRenderer({ failing: { 'voxel-lightPass': 'link' }, shaderLog: long }), [program('voxel-lightPass')], []));
    expect(verbose.message.length, 'about 600 characters of log, not 2,000').toBeLessThan(900);
    expect(verbose.message).toContain('link | xxx');
    expect(degradePlanFor(verbose)).toEqual({ viewRotation: false, composite: false, lights: true, shadows: false, seeThrough: false, translucent: false });
    const silent = failureOf(() => validateGpu(fakeRenderer({ failing: { 'voxel-upscale': '' } }), [program('voxel-upscale')], []));
    expect(silent.message).toContain('no log');
  });
});

describe('revalidateGpu', () => {
  it('draws the warm-up before it judges anything', () => {
    const log: string[] = [];
    const renderer = fakeRenderer({ log });
    revalidateGpu(renderer, { warmUp: () => log.push('warmUp'), programs: () => [program('voxel-upscale')], targets: () => [] });
    expect(log).toEqual(['warmUp', 'link']);
  });

  it('judges nothing while the context is lost again (the lost-context timer owns that case)', () => {
    const warmUp = vi.fn();
    revalidateGpu(fakeRenderer({ lost: true }), { warmUp, programs: () => [], targets: () => [] });
    expect(warmUp).not.toHaveBeenCalled();
  });

  it('throws what validation finds, naming the program', () => {
    const renderer = fakeRenderer({ failing: { 'voxel-upscale': 'broken' } });
    const error = failureOf(() => revalidateGpu(renderer, { warmUp: () => undefined, programs: () => [program('voxel-upscale')], targets: () => [] }));
    expect(error.message).toContain('[program voxel-upscale-vertex]');
  });
});
