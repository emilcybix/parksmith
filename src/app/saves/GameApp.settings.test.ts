import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings consumers GameApp owns: the autosave interval reaches the SaveManager live, and
 * the notification intensity filters toasts while refusals and errors always get through. Same
 * harness as GameApp.manager.test.ts (fake renderer, stubbed window, memory store).
 */

class FakeRenderer {
  hoveredCell = null;
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(): void {}
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

vi.mock('../rendererFlag', () => ({
  RENDERER_KIND: 'classic', LIGHT_PRESET: 'day', LIGHT_OVERRIDE: null, TIME_OVERRIDE: null, ZOOM_OVERRIDE: null, ALLOW_SOFTWARE_GPU: false, VOXEL_GPU_MIN: false,
}));
vi.mock('../../rendering/WorldRenderer', () => ({ WorldRenderer: FakeRenderer }));

const { GameApp } = await import('../GameApp');
const { useUiStore } = await import('../../ui/store');
const { MemorySaveStore } = await import('./memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./SaveManager');
const { resetSettings, updateSettings } = await import('../../settings/settingsStore');

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const makeGame = async () => {
  const store = new MemorySaveStore();
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, { kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined }),
  });
  await game.mount({} as HTMLElement);
  await settle();
  return game;
};

type Internals = {
  toast(message: string, cls?: 'alert' | 'important' | 'routine'): void;
  saves: { getAutosaveInterval(): number };
};

beforeEach(() => {
  const storage = new Map<string, string>([
    ['parksmith-profile', JSON.stringify({ version: 1, discoveredCardIds: [], tour: {}, ui: { mapSeen: true, tourOffered: true } })],
  ]);
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
  });
  vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined, visibilityState: 'visible' });
  resetSettings();
  useUiStore.getState().setToast(null);
});

afterEach(() => {
  resetSettings();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('autosave interval wiring', () => {
  it('starts from the stored setting and follows live changes, Off included', async () => {
    updateSettings({ autosaveMinutes: 5 });
    const game = await makeGame();
    const saves = (game as unknown as Internals).saves;
    expect(saves.getAutosaveInterval()).toBe(300);
    updateSettings({ autosaveMinutes: 1 });
    expect(saves.getAutosaveInterval()).toBe(60);
    updateSettings({ autosaveMinutes: 0 });
    expect(saves.getAutosaveInterval()).toBe(0);
    updateSettings({ autosaveMinutes: 10 });
    expect(saves.getAutosaveInterval()).toBe(600);
    game.destroy();
    updateSettings({ autosaveMinutes: 2 });
    expect(saves.getAutosaveInterval(), 'a destroyed game no longer listens').toBe(600);
  });

  it('the default setting reproduces the old 120 second cadence', async () => {
    const game = await makeGame();
    expect((game as unknown as Internals).saves.getAutosaveInterval()).toBe(120);
    game.destroy();
  });
});

describe('notification intensity on toasts', () => {
  const table: Array<[string, 'alert' | 'important' | 'routine', 'all' | 'important' | 'minimal', boolean]> = [
    ['alert', 'alert', 'all', true], ['alert', 'alert', 'important', true], ['alert', 'alert', 'minimal', true],
    ['important', 'important', 'all', true], ['important', 'important', 'important', true], ['important', 'important', 'minimal', false],
    ['routine', 'routine', 'all', true], ['routine', 'routine', 'important', false], ['routine', 'routine', 'minimal', false],
  ];
  for (const [name, cls, level, shown] of table) {
    it(`${name} toast at "${level}" is ${shown ? 'shown' : 'suppressed'}`, async () => {
      const game = await makeGame();
      updateSettings({ notifications: level });
      (game as unknown as Internals).toast('hello', cls);
      expect(useUiStore.getState().toast).toBe(shown ? 'hello' : null);
      game.destroy();
    });
  }

  it('an unclassified toast is an alert and is never suppressed', async () => {
    const game = await makeGame();
    updateSettings({ notifications: 'minimal' });
    (game as unknown as Internals).toast('refused');
    expect(useUiStore.getState().toast).toBe('refused');
    game.destroy();
  });

  it('a suppressed toast leaves the one on screen alone', async () => {
    const game = await makeGame();
    (game as unknown as Internals).toast('an error');
    updateSettings({ notifications: 'minimal' });
    (game as unknown as Internals).toast('routine news', 'routine');
    expect(useUiStore.getState().toast).toBe('an error');
    game.destroy();
  });

  it('a real refusal gets through at minimal while a real success does not', async () => {
    const game = await makeGame();
    game.startScenario(null);
    await settle();
    useUiStore.getState().setToast(null);
    updateSettings({ notifications: 'minimal' });
    game.startScenario('no-such-scenario');
    expect(useUiStore.getState().toast).toBe('That park scenario does not exist');
    useUiStore.getState().setToast(null);
    game.addMoney(); // developer tools are off in tests: the refusal message is an alert
    expect(useUiStore.getState().toast).toMatch(/Developer tools are disabled/);
    game.destroy();
  });
});
