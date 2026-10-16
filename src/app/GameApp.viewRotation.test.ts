import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 26 step 1, GameApp's side of the map view: Q/E and the bridge turn it through the renderer
 * port, a renderer that cannot turn keeps view 0 and says so (the park's own value survives), the
 * view lives in the app block and not in the world or the undo ring, and a load or a new park sets
 * it. Same style as GameApp.keys.test.ts: fake renderer, stubbed window.
 */

let supports = true;
const rotations: Array<{ rotation: number; instant: boolean | undefined }> = [];
let reduced = false;
let gestureHeld = false;

class FakeRenderer {
  readonly hoveredCell = null;
  get supportsViewRotation(): boolean { return supports; }
  get gestureHeld(): boolean { return gestureHeld; }
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(): void {}
  setSession(): void {}
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(): void {}
  setWeather(): void {}
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
  setSeeThrough(): void {}
  drawCoasterDraft(): void {}
  setViewRotation(rotation: number, instant?: boolean): void { rotations.push({ rotation, instant }); }
}

vi.mock('./rendererFlag', () => ({
  RENDERER_KIND: 'classic', LIGHT_PRESET: 'day', LIGHT_OVERRIDE: null, TIME_OVERRIDE: null, ZOOM_OVERRIDE: null, ALLOW_SOFTWARE_GPU: false, VOXEL_GPU_MIN: false,
}));
vi.mock('../rendering/WorldRenderer', () => ({ WorldRenderer: FakeRenderer }));
vi.mock('../settings/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings/motion')>()),
  reducedMotion: () => reduced,
}));

const { GameApp } = await import('./GameApp');
const { gameBridge, saveBridge } = await import('./gameBridge');
const { resetSettings, updateSettings } = await import('../settings');
const { useUiStore } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');
const { hashState } = await import('../game/save/hash');
const { createParkSave } = await import('../game/save/version');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const host = {} as HTMLElement;
const games: Array<{ destroy(): void }> = [];
let lastStore: InstanceType<typeof MemorySaveStore> | null = null;
const makeGame = async () => {
  const store = new MemorySaveStore();
  lastStore = store;
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
const internals = (game: unknown) => game as {
  capturePark(): { state: unknown; app: { viewRotation?: number } };
  undo: { depth: number };
  viewRotation: number;
};

beforeEach(() => {
  supports = true;
  reduced = false;
  gestureHeld = false;
  rotations.length = 0;
  handlers = new Map();
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
  useUiStore.setState({ viewRotation: 0 });
  useUiStore.getState().setToast(null);
  useUiStore.getState().selectPointer();
  useUiStore.getState().closeManagement();
  useUiStore.getState().closeSavesDialog();
  useUiStore.getState().closeSettings();
});

afterEach(() => {
  for (const game of games.splice(0)) game.destroy();
  resetSettings();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const press = (k: string, extra: Record<string, unknown> = {}): void => {
  for (const handler of handlers.get('keydown') ?? []) {
    handler({
      type: 'keydown', key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null,
      preventDefault: () => undefined, ...extra,
    });
  }
};
const view = (): number => useUiStore.getState().viewRotation;

describe('rotating the view', () => {
  it('E turns clockwise, Q counter-clockwise, wrapping, one step per press and never on key repeat', async () => {
    const game = await makeGame();
    rotations.length = 0;
    press('e');
    expect(view()).toBe(1);
    press('e'); press('e'); press('e');
    expect(view()).toBe(0);
    press('q');
    expect(view()).toBe(3);
    press('q', { repeat: true });
    expect(view(), 'holding the key does not spin the map').toBe(3);
    expect(rotations.map((entry) => entry.rotation)).toEqual([1, 2, 3, 0, 3]);
    expect(rotations.every((entry) => entry.instant === false), 'a key press animates').toBe(true);
    expect(internals(game).viewRotation).toBe(3);
  });

  it('the bridge buttons do the same, and reduced motion asks for an instant snap', async () => {
    await makeGame();
    rotations.length = 0;
    reduced = true;
    gameBridge.rotateView(1);
    expect(view()).toBe(1);
    expect(rotations).toEqual([{ rotation: 1, instant: true }]);
  });

  it('the keys are rebindable and inert behind a modal', async () => {
    await makeGame();
    updateSettings({ keybindings: { rotateViewRight: 'k:j' } });
    press('e');
    expect(view(), 'the old key is dead').toBe(0);
    press('j');
    expect(view()).toBe(1);
    useUiStore.getState().openSettings();
    press('q');
    expect(view(), 'settings own the keyboard').toBe(1);
  });

  it('waits for a held drag: the turn is refused while the pointer gesture is down', async () => {
    const game = await makeGame();
    rotations.length = 0;
    gestureHeld = true;
    press('e');
    gameBridge.rotateView(-1);
    expect(view()).toBe(0);
    expect(internals(game).viewRotation).toBe(0);
    expect(rotations).toEqual([]);
    expect(useUiStore.getState().toast).toBe('Release the mouse button to turn the view');
    gestureHeld = false;
    press('e');
    expect(view()).toBe(1);
  });

  it('a renderer that cannot rotate keeps view 0 and shows the toast', async () => {
    supports = false;
    const game = await makeGame();
    press('e');
    expect(view()).toBe(0);
    expect(internals(game).viewRotation).toBe(0);
    expect(useUiStore.getState().toast).toBe('Map rotation is not available on this graphics device');
    expect(rotations).toEqual([]);
  });

  it('is not part of the world, the determinism hash or the undo ring', async () => {
    const game = await makeGame();
    const before = hashState(internals(game).capturePark().state);
    const depth = internals(game).undo.depth;
    const version = game.world.version;
    press('e'); press('e'); press('q');
    expect(hashState(internals(game).capturePark().state)).toBe(before);
    expect(internals(game).undo.depth).toBe(depth);
    expect(game.world.version).toBe(version);
  });
});

describe('the view in the save', () => {
  it('goes into the app block, comes back with a load, and a park saved at view 0 loads at view 0', async () => {
    const game = await makeGame();
    game.startScenario(null);
    press('e'); press('e');
    expect(internals(game).capturePark().app.viewRotation).toBe(2);
    const saved = await saveBridge.saveToSlot('manual-1', 'Turned');
    expect(saved.ok).toBe(true);
    press('e');
    expect(view()).toBe(3);
    const loaded = await saveBridge.load('manual-1');
    expect(loaded.ok).toBe(true);
    expect(view()).toBe(2);
    expect(rotations[rotations.length - 1]).toEqual({ rotation: 2, instant: true });
    game.startScenario(null);
    expect(view(), 'a new park starts at view 0').toBe(0);
  });

  it('a renderer that cannot rotate keeps the park\'s saved view and writes it back', async () => {
    const game = await makeGame();
    game.startScenario(null);
    press('e');
    await saveBridge.saveToSlot('manual-1', 'Turned');
    supports = false;
    await saveBridge.load('manual-1');
    expect(view(), 'shown at 0').toBe(0);
    expect(internals(game).capturePark().app.viewRotation, 'saved as it was').toBe(1);
  });

  it('a turn alone makes the paused park dirty for the autosave, not for the unsaved-changes warning', async () => {
    const game = await makeGame();
    game.startScenario(null);
    await settle();
    const saves = (game as unknown as { saves: { flushOnHide(): void; hasUnsavedEdits(): boolean } }).saves;
    const autosavedView = async (): Promise<number | undefined> => {
      try {
        const record = await lastStore!.read('autosave');
        const payload = record.payload as { app?: { viewRotation?: number } };
        return payload.app?.viewRotation ?? 0;
      } catch {
        return undefined;
      }
    };
    saves.flushOnHide();
    await settle();
    const baseline = await autosavedView();
    press('e'); press('e');
    expect(view()).toBe(2);
    expect(saves.hasUnsavedEdits(), 'turning the view is no edit').toBe(false);
    saves.flushOnHide();
    await settle();
    expect(baseline, 'nothing changed yet: no autosave was written').toBeUndefined();
    expect(await autosavedView(), 'crash recovery restores the turned view').toBe(2);
  });

  it('an undo rewind does not turn the view back', async () => {
    const game = await makeGame();
    useUiStore.getState().selectBuild('ribbon-bench');
    game.world.addMoney(5000);
    const handlersCapture = game as unknown as { handleEnd(cell: { x: number; y: number }): void };
    handlersCapture.handleEnd({ x: 5, y: 4 });
    expect(internals(game).undo.depth, 'the bench is an undo entry').toBeGreaterThan(0);
    press('e');
    expect(view()).toBe(1);
    press('z', { ctrlKey: true });
    expect(view()).toBe(1);
  });

  it('an envelope without the field loads as view 0 and a bad value is refused', async () => {
    const game = await makeGame();
    const { state, app } = internals(game).capturePark() as { state: Parameters<typeof createParkSave>[0]; app: Parameters<typeof createParkSave>[1] };
    const legacyApp = { clock: app.clock, tourNodeId: app.tourNodeId };
    const { migrateSave } = await import('../game/save/migrate');
    expect(() => migrateSave(createParkSave(state, legacyApp, 1))).not.toThrow();
    expect(() => migrateSave(createParkSave(state, { ...app, viewRotation: 4 as never }, 1))).toThrow();
  });
});
