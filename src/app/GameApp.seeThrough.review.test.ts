import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Adversarial review of the see-through wiring in GameApp: the hold-to-peek key (X) and the armed
 * flag the renderer is told. Same style as GameApp.undo.test.ts: fake renderer, stubbed window.
 * Pinned: no collision with another shortcut, the peek never sticks (blur, hidden page, modal
 * opening while held, text input, key-up with other modifiers), and Escape/tool changes disarm.
 */

const log: string[] = [];
const phases: number[] = [];
const weatherViews: Array<{ kind: string; intensity: number; day: number }> = [];
let hovered: { x: number; y: number } | null = null;
const seeCalls: Array<{ armed: boolean; peek: boolean }> = [];

class FakeRenderer {
  get hoveredCell() { return hovered; }
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(): void {}
  setSession(): void { log.push('setSession'); }
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(phase: number): void { phases.push(phase); }
  setWeather(view: Readonly<{ kind: string; intensity: number; day: number }>): void { weatherViews.push({ kind: view.kind, intensity: view.intensity, day: view.day }); }
  setInputHandlers(): void {}
  setViewInputEnabled(): void {}
  setToolCursor(): void {}
  focusCell(): void {}
  focusEntrance(): void {}
  setGridVisible(): void {}
  setSceneryInfluenceVisible(): void {}
  selectObject(): void { log.push('selectObject'); }
  drawPreview(): void { log.push('drawPreview'); }
  clearPreview(): void {}
  setHintMarkers(): void {}
  setSeeThrough(request: { armed: boolean; peek: boolean }): void { seeCalls.push({ armed: request.armed, peek: request.peek }); }
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

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const host = {} as HTMLElement;

const games: Array<{ destroy(): void }> = [];
const makeGame = async () => {
  const store = new MemorySaveStore();
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, {
      kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined,
    }),
  });
  await game.mount(host);
  await settle();
  games.push(game);
  return game;
};


beforeEach(() => {
  log.length = 0;
  seeCalls.length = 0;
  hovered = null;
  handlers = new Map();
  // A stored tour profile: without one this is a first run and the Parks map opens by itself.
  const storage = new Map<string, string>([
    ['parksmith-profile', JSON.stringify({ version: 1, discoveredCardIds: [], tour: {}, ui: { mapSeen: true, tourOffered: true } })],
  ]);
  const register = (type: string, handler: Handler): void => { handlers.set(type, [...(handlers.get(type) ?? []), handler]); };
  vi.stubGlobal('window', {
    addEventListener: register,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  });
  vi.stubGlobal('document', { addEventListener: register, removeEventListener: () => undefined, visibilityState: 'visible' });
  useUiStore.getState().setToast(null);
  useUiStore.getState().selectPointer();
  useUiStore.getState().closeManagement();
  useUiStore.getState().closeSavesDialog();
});

afterEach(() => {
  for (const game of games.splice(0)) game.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const key = (type: 'keydown' | 'keyup', k: string, extra: Record<string, unknown> = {}): { prevented: boolean } => {
  let prevented = false;
  for (const handler of handlers.get(type) ?? []) {
    handler({
      type, key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null,
      preventDefault: () => { prevented = true; }, ...extra,
    });
  }
  return { prevented };
};
const last = () => seeCalls[seeCalls.length - 1] ?? { armed: false, peek: false };
const fire = (type: string): void => { for (const handler of handlers.get(type) ?? []) handler({ type }); };

describe('see-through wiring (adversarial)', () => {
  it('armed follows the tool, and Escape disarms it', async () => {
    await makeGame();
    expect(last().armed).toBe(false);
    useUiStore.getState().selectBuild('ribbon-bench');
    expect(last().armed).toBe(true);
    key('keydown', 'Escape');
    expect(useUiStore.getState().tool).toBe('pointer');
    expect(last()).toEqual({ armed: false, peek: false });
    useUiStore.getState().selectBulldozer();
    expect(last().armed).toBe(true);
    useUiStore.getState().selectPointer();
    expect(last().armed).toBe(false);
  });

  it('X peeks while held with the pointer tool and releases on keyup', async () => {
    await makeGame();
    key('keydown', 'x');
    expect(last()).toEqual({ armed: false, peek: true });
    key('keyup', 'x');
    expect(last().peek).toBe(false);
  });

  it('X does not run any other shortcut and does not preventDefault', async () => {
    await makeGame();
    useUiStore.getState().selectPointer();
    const before = JSON.stringify([useUiStore.getState().tool, useUiStore.getState().showGrid, useUiStore.getState().cleanView]);
    expect(key('keydown', 'x').prevented).toBe(false);
    key('keyup', 'x');
    expect(JSON.stringify([useUiStore.getState().tool, useUiStore.getState().showGrid, useUiStore.getState().cleanView])).toBe(before);
  });

  it('a held key repeat, Ctrl+X and Alt+X never press', async () => {
    await makeGame();
    key('keydown', 'x', { repeat: true });
    key('keydown', 'x', { ctrlKey: true });
    key('keydown', 'x', { metaKey: true });
    key('keydown', 'x', { altKey: true });
    expect(last().peek).toBe(false);
  });

  it('never presses from a text field', async () => {
    await makeGame();
    key('keydown', 'x', { target: { tagName: 'INPUT', isContentEditable: false } });
    key('keydown', 'x', { target: { tagName: 'TEXTAREA', isContentEditable: false } });
    key('keydown', 'x', { target: { tagName: 'DIV', isContentEditable: true } });
    expect(last().peek).toBe(false);
  });

  it('never presses behind a modal, and a modal opening while held releases it', async () => {
    await makeGame();
    useUiStore.getState().openSavesDialog();
    key('keydown', 'x');
    expect(last().peek).toBe(false);
    useUiStore.getState().closeSavesDialog();
    key('keydown', 'x');
    expect(last().peek).toBe(true);
    useUiStore.getState().openSavesDialog();
    expect(last().peek, 'opening a modal while held releases').toBe(false);
    useUiStore.getState().closeSavesDialog();
    expect(last().peek, 'closing the modal does not resurrect a peek the player may have released').toBe(false);
    key('keyup', 'x');
    expect(last().peek).toBe(false);
  });

  it('the management panel (build capability off) releases a held peek', async () => {
    await makeGame();
    key('keydown', 'x');
    expect(last().peek).toBe(true);
    useUiStore.getState().openManagement('finances');
    expect(last()).toEqual({ armed: false, peek: false });
  });

  it('blur and a hidden page release a held peek', async () => {
    await makeGame();
    key('keydown', 'x');
    fire('blur');
    expect(last().peek).toBe(false);
    key('keydown', 'x');
    expect(last().peek).toBe(true);
    (document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    fire('visibilitychange');
    (document as unknown as { visibilityState: string }).visibilityState = 'visible';
    expect(last().peek).toBe(false);
  });

  it('any keyup of X releases, even with modifiers or from a text field', async () => {
    await makeGame();
    key('keydown', 'x');
    key('keyup', 'X', { ctrlKey: true, target: { tagName: 'INPUT', isContentEditable: false } });
    expect(last().peek).toBe(false);
  });

  it('peek survives a tool change while held (same layer family) and does not re-send identical state', async () => {
    await makeGame();
    key('keydown', 'x');
    const count = seeCalls.length;
    useUiStore.getState().selectBuild('ribbon-bench');
    expect(last()).toEqual({ armed: true, peek: true });
    useUiStore.getState().setGrid(true);
    useUiStore.getState().setGrid(false);
    expect(seeCalls.length, 'unrelated store changes send nothing').toBe(count + 1);
  });

  it('the coaster designer context is armed and can peek', async () => {
    await makeGame();
    useUiStore.getState().selectBuild('comet-trail');
    expect(last().armed).toBe(true);
    key('keydown', 'x');
    expect(last().peek).toBe(true);
    key('keydown', 'Escape');
    key('keyup', 'x');
    expect(last()).toEqual({ armed: false, peek: false });
  });
});
