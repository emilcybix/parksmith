import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 42: the windows in the app: their keys open and close them, Esc closes the newest before the pause menu, the
 * UI tick publishes workers and buildings only while a window wants them, and the bulk actions touch only the rows
 * they are given.
 */

type Cell = { x: number; y: number };
let hovered: Cell | null = null;
let frameCallback: ((deltaMs: number) => void) | null = null;
const frame = (deltaMs: number): void => frameCallback?.(deltaMs);
interface PreviewCall { cells: Cell[]; valid: boolean; blocked: Cell[] | null }
const previews: PreviewCall[] = [];

class FakeRenderer {
  get hoveredCell() { return hovered; }
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(callback: (deltaMs: number) => void): void { frameCallback = callback; }
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
  drawPreview(cells: readonly Cell[], _definition: unknown, valid: boolean, _bulldoze?: boolean, _rotation?: number, _colours?: unknown, blocked?: readonly Cell[] | null): void {
    previews.push({ cells: cells.map((cell) => ({ ...cell })), valid, blocked: blocked ? blocked.map((cell) => ({ ...cell })) : null });
  }
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

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const makeGame = async () => {
  const store = new MemorySaveStore();
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, {
      kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined,
    }),
  });
  await game.mount({} as HTMLElement);
  await settle();
  return game;
};

beforeEach(() => {
  previews.length = 0;
  hovered = null;
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
  useUiStore.getState().setToast(null);
  useUiStore.getState().selectPointer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const press = (key: string): void => {
  for (const handler of handlers.get('keydown') ?? []) {
    handler({
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      repeat: false, target: null, preventDefault: () => undefined,
    });
  }
};

describe('Phase 42: windows', () => {
  it('K opens the Staff window and O the Buildings window; Esc closes the newest first, then opens the menu', async () => {
    const game = await makeGame();
    useUiStore.setState({ openWindows: [] });
    press('k');
    press('o');
    expect(useUiStore.getState().openWindows).toEqual(['staff', 'buildings']);
    press('Escape');
    expect(useUiStore.getState().openWindows).toEqual(['staff']);
    press('Escape');
    expect(useUiStore.getState().openWindows).toEqual([]);
    expect(useUiStore.getState().menuKind).toBeNull();
    press('Escape');
    expect(useUiStore.getState().menuKind, 'nothing left to close: the pause menu').toBe('pause');
    game.destroy();
  });

  it('bulk close closes only the rows it is given; a price step reaches a stall by id', async () => {
    const game = await makeGame();
    const internals = game as unknown as { rides: { getRide(id: number): { open?: boolean; status: string } | undefined }; shops: { getService(id: number): { open: boolean; itemPrice: number } | undefined } };
    game.world.addMoney(100_000);
    game.world.buildPaths(Array.from({ length: 6 }, (_unused, index) => ({ x: 15, y: 30 - index })));
    const a = game.world.buildObject('picnic-pocket', { x: 16, y: 27 }, 3)!;
    const b = game.world.buildObject('fizz-foundry', { x: 13, y: 27 }, 1)!;
    (game as unknown as { session: { syncWithWorld(): void } }).session.syncWithWorld();
    game.setObjectsOpen([a.id], false);
    expect(internals.shops.getService(a.id)!.open).toBe(false);
    expect(internals.shops.getService(b.id)!.open).toBe(true);
    const price = internals.shops.getService(b.id)!.itemPrice;
    game.adjustObjectPrice(b.id, 0.5);
    expect(internals.shops.getService(b.id)!.itemPrice).toBeCloseTo(price + 0.5, 5);
    game.destroy();
  });

  it('the UI tick publishes the workers only while the Staff window is open', async () => {
    const game = await makeGame();
    useUiStore.setState({ openWindows: [], workers: [] });
    game.world.addMoney(100_000);
    game.hireStaff('cleaner');
    frame(300);
    expect(useUiStore.getState().workers).toEqual([]);
    useUiStore.getState().toggleWindow('staff');
    frame(300);
    expect(useUiStore.getState().workers.length).toBeGreaterThan(0);
    useUiStore.getState().closeWindow('staff');
    game.destroy();
  });
});
