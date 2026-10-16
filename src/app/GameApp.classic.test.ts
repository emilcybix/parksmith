import { describe, expect, it, vi } from 'vitest';

/**
 * The classic game must never download or run the voxel renderer: `import('../rendering/voxel/...')`
 * is only reached when RENDERER_KIND is 'voxel'. The voxel module is replaced by a factory that
 * records being evaluated, so ANY import of it, static or dynamic, fails this test.
 */

const evaluated: string[] = [];

vi.mock('./rendererFlag', () => ({
  RENDERER_KIND: 'classic', LIGHT_PRESET: 'day', LIGHT_OVERRIDE: null, TIME_OVERRIDE: null, ZOOM_OVERRIDE: null, ALLOW_SOFTWARE_GPU: false, VOXEL_GPU_MIN: false,
}));
vi.mock('../rendering/voxel/VoxelRenderer', () => {
  evaluated.push('VoxelRenderer');
  return { VoxelRenderer: class {} };
});
vi.mock('../rendering/WorldRenderer', () => ({
  WorldRenderer: class {
    readonly kind = 'classic';
    hoveredCell = null;
    mount(): Promise<void> { return Promise.resolve(); }
    destroy(): void {}
    onFrame(): void {}
    setInputHandlers(): void {}
    setViewInputEnabled(): void {}
    setToolCursor(): void {}
    setHintMarkers(): void {}
  },
}));

const { GameApp } = await import('./GameApp');

describe('GameApp in classic mode', () => {
  it('mounts the classic renderer and never imports the voxel module', async () => {
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    try {
      const game = new GameApp();
      await game.mount({} as HTMLElement);
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(evaluated, 'the voxel module was never loaded').toEqual([]);
      game.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
