import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 30: the Parks chooser from the pause menu (the top bar's Parks button, the result overlay) replaces the park
 * being played, so a park with changes no save holds asks first, exactly as Quit to menu does; Save or Quit without
 * saving leaves for the start screen on the chosen panel, Cancel stays. Harness as in GameApp.menu.test.ts, reduced.
 */

let frameCallback: ((deltaMs: number) => void) | null = null;

class FakeRenderer {
  hoveredCell = null;
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
  setCameraCentre(): void {}
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
const { gameBridge } = await import('./gameBridge');
const { useUiStore, NO_MENU_PREVIEW } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');
const { RECOVERY_MONITOR_HOLDER_KEY } = await import('./saves/recoveryMonitor');
const { resetSettings } = await import('../settings');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();
let windowStub: Record<string, unknown>;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const fakeMonitor = () => ({
  sessionId: 'tab-test',
  mode: 'web-locks' as const,
  start: () => Promise.resolve(),
  heartbeat: () => undefined,
  markClean: () => undefined,
  detectInterrupted: () => Promise.resolve({ kind: 'clean' as const }),
  forget: () => undefined,
  dispose: () => undefined,
});

const knownProfile = () => {
  const map = new Map<string, string>([
    ['parksmith-profile', JSON.stringify({ version: 1, discoveredCardIds: [], tour: {}, ui: { mapSeen: true, tourOffered: true } })],
  ]);
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
};

type Game = InstanceType<typeof GameApp>;
interface Internals { saves: { snapshot(): { unsavedChanges: boolean } } }
const internals = (game: Game): Internals => game as unknown as Internals;

const games: Game[] = [];
const makeGame = async (): Promise<Game> => {
  windowStub[RECOVERY_MONITOR_HOLDER_KEY] = fakeMonitor();
  const store = new MemorySaveStore();
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, { kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined }),
    startMenu: false,
    profileStorage: knownProfile(),
  });
  await game.mount({} as HTMLElement);
  await settle();
  games.push(game);
  game.startScenario(null);
  await settle();
  return game;
};

const press = (key: string): void => {
  const event = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault: () => undefined };
  for (const handler of handlers.get('keydown') ?? []) handler(event);
};

const ui = () => useUiStore.getState();

beforeEach(() => {
  frameCallback = null;
  handlers = new Map();
  const register = (type: string, handler: Handler): void => { handlers.set(type, [...(handlers.get(type) ?? []), handler]); };
  windowStub = { addEventListener: register, removeEventListener: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined };
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('document', { addEventListener: register, removeEventListener: () => undefined, visibilityState: 'visible', activeElement: null });
  resetSettings();
  useUiStore.setState({
    menuKind: null, menuPanel: 'main', menuNotice: null, menuPreview: NO_MENU_PREVIEW,
    settingsOpen: false, savesDialogOpen: false, scenarioPickerOpen: false, loadoutScenarioId: null,
    tool: 'build', selectedDefinitionId: 'sunstone-path', managementOpen: false, toast: null,
  });
});

afterEach(() => {
  for (const game of games.splice(0)) game.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetSettings();
});

describe('the Parks chooser from the pause menu', () => {
  it('opens straight onto the panel when nothing is unsaved', async () => {
    const game = await makeGame();
    expect(internals(game).saves.snapshot().unsavedChanges).toBe(false);
    gameBridge.openParksChooser('modes');
    expect(ui().menuKind).toBe('pause');
    expect(ui().menuPanel).toBe('modes');
    void frameCallback;
  });

  it('asks first when the park has unsaved changes; Cancel (Escape) stays in the park and a later Quit asks its own question', async () => {
    const game = await makeGame();
    ui().selectPointer();
    game.world.buildPaths([{ x: 15, y: 21 }, { x: 15, y: 22 }]);
    expect(internals(game).saves.snapshot().unsavedChanges).toBe(true);
    gameBridge.openParksChooser('modes');
    expect(ui().menuKind).toBe('pause');
    expect(ui().menuPanel, 'the same question as Quit to menu').toBe('quit');
    press('Escape');
    expect(ui().menuPanel).toBe('main');
    expect(ui().menuKind).toBe('pause');
    // Resume, then Quit to menu: the chooser target of the cancelled question must not steer it.
    gameBridge.resumeFromMenu();
    expect(ui().menuKind).toBeNull();
    gameBridge.openPauseMenu();
    gameBridge.requestQuitToMenu();
    expect(ui().menuPanel).toBe('quit');
    await gameBridge.confirmQuitToMenu('discard');
    await settle();
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPanel).toBe('main');
  });

  it('Quit without saving leaves for the start screen on the chosen panel', async () => {
    const game = await makeGame();
    ui().selectPointer();
    game.world.buildPaths([{ x: 15, y: 21 }]);
    gameBridge.openParksChooser('scenarios');
    expect(ui().menuPanel).toBe('quit');
    await gameBridge.confirmQuitToMenu('discard');
    await settle();
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPanel).toBe('scenarios');
    expect(game.clock.speed).toBe(0);
  });

  it('Save and quit writes the save first, then leaves for the chosen panel', async () => {
    const game = await makeGame();
    ui().selectPointer();
    game.world.buildPaths([{ x: 15, y: 21 }]);
    gameBridge.openParksChooser('modes');
    expect(ui().menuPanel).toBe('quit');
    await gameBridge.confirmQuitToMenu('save');
    await settle();
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPanel).toBe('modes');
    expect(ui().menuPreview.slotId, 'the save that was just written').toMatch(/^manual-/);
  });

  it('from the start screen the chooser never asks (no park is being played)', async () => {
    const game = await makeGame();
    ui().selectPointer();
    game.world.buildPaths([{ x: 15, y: 21 }]);
    gameBridge.openPauseMenu();
    gameBridge.requestQuitToMenu();
    await gameBridge.confirmQuitToMenu('discard');
    await settle();
    expect(ui().menuKind).toBe('start');
    gameBridge.openParksChooser('collection');
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPanel).toBe('collection');
  });
});
