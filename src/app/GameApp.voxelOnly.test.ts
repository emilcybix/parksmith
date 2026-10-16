import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 34, the mirror of `GameApp.classic.test.ts`: the voxel game must never download or run the classic renderer.
 * `import('../rendering/WorldRenderer')` is reached only for `?renderer=classic` or a fallback, so a voxel renderer
 * that mounts leaves the classic module unevaluated. The classic module is replaced by a factory that records being
 * evaluated, so ANY import of it, static or dynamic, fails this test. The static graph check is
 * `bundleSplit.static.test.ts`.
 */

const evaluated: string[] = [];

vi.mock('./rendererFlag', () => ({
  RENDERER_KIND: 'voxel', LIGHT_PRESET: 'day', LIGHT_OVERRIDE: null, TIME_OVERRIDE: null, ZOOM_OVERRIDE: null, ALLOW_SOFTWARE_GPU: false, VOXEL_GPU_MIN: false,
}));
vi.mock('../rendering/WorldRenderer', () => {
  evaluated.push('WorldRenderer');
  return { WorldRenderer: class {} };
});
vi.mock('../rendering/voxel/VoxelRenderer', () => ({
  VoxelRenderer: class {
    readonly kind = 'voxel';
    hoveredCell = null;
    mount(): Promise<void> { return Promise.resolve(); }
    destroy(): void {}
    onFatalError(): void {}
    onFrame(): void {}
    setInputHandlers(): void {}
    setViewInputEnabled(): void {}
    setToolCursor(): void {}
    setHintMarkers(): void {}
  },
}));

const { GameApp } = await import('./GameApp');

describe('GameApp in voxel mode', () => {
  it('mounts the voxel renderer and never imports the classic module', async () => {
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    try {
      const game = new GameApp();
      await game.mount({} as HTMLElement);
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect((game as unknown as { renderer: { kind: string } | null }).renderer?.kind).toBe('voxel');
      expect(evaluated, 'the classic module was never loaded').toEqual([]);
      game.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
