import { afterEach, describe, expect, it, vi } from 'vitest';

let frameCallback: ((deltaMs: number) => void) | null = null;
class FakeRenderer {
  get hoveredCell() { return null; }
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(callback: (deltaMs: number) => void): void { frameCallback = callback; }
  setSession(): void {}
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(): void {}
  setInputHandlers(): void {}
  setViewInputEnabled(): void {}
  setToolCursor(): void {}
  focusCell(): void {}
  focusEntrance(): void {}
  setGridVisible(): void {}
  setSceneryInfluenceVisible(): void {}
  selectObject(): void {}
  drawPreview(): void {}
  clearPreview(): void {}
  setHintMarkers(): void {}
  drawCoasterDraft(): void {}
}
vi.mock('./rendererFlag', () => ({
  RENDERER_KIND: 'classic', LIGHT_PRESET: 'day', LIGHT_OVERRIDE: null, TIME_OVERRIDE: null, ZOOM_OVERRIDE: null, ALLOW_SOFTWARE_GPU: false, VOXEL_GPU_MIN: false,
}));
vi.mock('../rendering/WorldRenderer', () => ({ WorldRenderer: FakeRenderer }));

const { GameApp } = await import('./GameApp');
const { useUiStore } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');

const storage = new Map<string, string>([['parksmith-profile', JSON.stringify({ version: 1, discoveredCardIds: [], tour: {} })]]);
afterEach(() => { vi.unstubAllGlobals(); });

describe('Park Tour offer visibility (review)', () => {
  it('is not spent while the card cannot be seen (clean view hides Park Pulse)', async () => {
    vi.stubGlobal('window', {
      addEventListener: () => undefined, removeEventListener: () => undefined,
      setTimeout: () => 0, clearTimeout: () => undefined,
      localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } },
    });
    vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined, visibilityState: 'visible' });
    const store = new MemorySaveStore();
    const game = new GameApp({
      saveStore: store,
      saveWriter: createHashingWriter(store, { kind: 'idle', seal: async (s) => computeStateSeal(s), dispose: () => undefined }),
    });
    await game.mount({} as HTMLElement);
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
    useUiStore.setState({ cleanView: true });
    (game as unknown as { session: { onboarding: { restore(s: unknown): void } } }).session.onboarding.restore({
      dismissed: false, completed: [{ id: 'fix-problem', tick: 5, evidence: 1 }], skipped: [], sawLitter: false,
    });
    for (let i = 0; i < 4; i += 1) frameCallback?.(250);
    // Persisted only when the player answers the offer.
    expect(JSON.parse(storage.get('parksmith-profile')!).ui?.tourOffered === true).toBe(false);
    game.destroy();
  });
});
