import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 40b: building fronts in the app. Beside a path the ghost turns a front-only building toward it, R wins on its
 * cell, a front that faces no path is named in the hover line, and the player's click builds exactly the turn shown.
 */

type Cell = { x: number; y: number };
type Handlers = {
  hover(cell: Cell | null): void;
  start(cell: Cell): void;
  move(cell: Cell): void;
  end(cell: Cell): void;
  cancel(): void;
};
let inputHandlers: Handlers | null = null;
let hovered: Cell | null = null;
interface PreviewCall { cells: Cell[]; valid: boolean; blocked: Cell[] | null }
const previews: PreviewCall[] = [];

class FakeRenderer {
  get hoveredCell() { return hovered; }
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(): void {}
  setSession(): void {}
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(): void {}
  setWeather(): void {}
  setInputHandlers(handlers: Handlers): void { inputHandlers = handlers; }
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
const { FRONT_FACES_NO_PATH } = await import('./GameApp');
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
  inputHandlers = null;
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

describe('Phase 40b: building fronts', () => {
  const spine = (game: { world: { buildPaths(cells: Cell[]): unknown; addMoney(amount: number): void } }): void => {
    useUiStore.setState({ buildRotation: 0 });
    game.world.addMoney(100_000);
    game.world.buildPaths(Array.from({ length: 6 }, (_unused, index) => ({ x: 15, y: 30 - index })));
  };

  it('beside a path the ghost turns the stall to face it, and a click builds exactly that turn', async () => {
    const game = await makeGame();
    spine(game);
    useUiStore.getState().selectBuild('picnic-pocket');
    expect(useUiStore.getState().buildRotation).toBe(0);
    inputHandlers!.hover({ x: 16, y: 27 });
    expect(useUiStore.getState().buildRotation, 'front turned west, onto the path').toBe(3);
    expect(useUiStore.getState().previewBlock).toBeNull();
    inputHandlers!.end({ x: 16, y: 27 });
    const stall = [...game.world.objects.values()].find((object) => object.definitionId === 'picnic-pocket')!;
    expect(stall.rotation).toBe(3);
    game.destroy();
  });

  it('R wins on its cell: the warning names the problem, and the click builds the turn the player chose', async () => {
    const game = await makeGame();
    spine(game);
    useUiStore.getState().selectBuild('picnic-pocket');
    hovered = { x: 16, y: 27 };
    inputHandlers!.hover(hovered);
    expect(useUiStore.getState().buildRotation).toBe(3);
    game.rotateBuild();
    expect(useUiStore.getState().buildRotation, 'R turned it on').toBe(0);
    expect(useUiStore.getState().previewBlock).toBe(FRONT_FACES_NO_PATH);
    expect(useUiStore.getState().previewValid, 'still buildable').toBe(true);
    inputHandlers!.end({ x: 16, y: 27 });
    const stall = [...game.world.objects.values()].find((object) => object.definitionId === 'picnic-pocket')!;
    expect(stall.rotation, 'exactly the turn shown').toBe(0);
    game.destroy();
  });

  it('a ride is not turned (rides keep every side)', async () => {
    const game = await makeGame();
    spine(game);
    useUiStore.getState().selectBuild('comet-cups');
    inputHandlers!.hover({ x: 16, y: 26 });
    expect(useUiStore.getState().buildRotation).toBe(0);
    game.destroy();
  });
});
