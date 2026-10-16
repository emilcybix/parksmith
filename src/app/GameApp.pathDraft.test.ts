import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 37: the path drag re-routes. Pulling the pointer back along the draft takes the path back with it, the
 * preview draws the cells that cannot take a path apart from the rest, and the hover cost follows the cut. Driven
 * through the input handlers the (fake) renderer was given, as in the undo test.
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

const keysOf = (cells: readonly Cell[]): string[] => cells.map((cell) => `${cell.x},${cell.y}`);
const column = (x: number, fromY: number, toY: number): string[] => {
  const out: string[] = [];
  for (let y = fromY; fromY <= toY ? y <= toY : y >= toY; y += fromY <= toY ? 1 : -1) out.push(`${x},${y}`);
  return out;
};
const pressUndo = (): void => {
  for (const handler of handlers.get('keydown') ?? []) {
    handler({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'z', repeat: false, target: null, preventDefault: () => undefined });
  }
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

describe('Phase 37: path drag re-route', () => {
  it('a drag into a building, pulled back and steered round it, builds exactly the final route', async () => {
    const game = await makeGame();
    game.world.addMoney(100_000);
    expect(game.world.buildObject('ribbon-bench', { x: 15, y: 25 })).toBeTruthy();
    for (const key of [...column(15, 30, 26), ...column(14, 26, 22), ...column(15, 24, 22)]) {
      const [x, y] = key.split(',').map(Number);
      expect(game.world.canPlacePath({ x, y }), `test cell ${key} is free`).toBe(true);
    }
    useUiStore.getState().selectBuild('sunstone-path');
    inputHandlers!.start({ x: 15, y: 30 });
    inputHandlers!.move({ x: 15, y: 23 });
    const into = previews.at(-1)!;
    expect(keysOf(into.blocked ?? []), 'only the bench cell is drawn as blocked').toEqual(['15,25']);
    expect(into.valid, 'the rest keeps the normal colour').toBe(true);
    expect(useUiStore.getState().previewValid, 'the hover card still refuses the draft').toBe(false);
    // Pull back to just before the bench, then go round it.
    inputHandlers!.move({ x: 15, y: 26 });
    expect(keysOf(previews.at(-1)!.cells)).toEqual(column(15, 30, 26));
    expect(previews.at(-1)!.blocked).toEqual([]);
    expect(useUiStore.getState().previewValid, 'the cut draft is buildable again').toBe(true);
    inputHandlers!.move({ x: 14, y: 26 });
    inputHandlers!.move({ x: 14, y: 22 });
    inputHandlers!.end({ x: 14, y: 22 });
    const built = new Set(game.world.paths.keys());
    for (const key of [...column(15, 30, 26), ...column(14, 26, 22)]) expect(built.has(key), `${key} built`).toBe(true);
    for (const key of column(15, 24, 22)) expect(built.has(key), `${key} was pulled back and not built`).toBe(false);
    game.destroy();
  });

  it('a pull-back all the way to the first cell leaves a one-cell draft, and the hover cost follows the cut', async () => {
    const game = await makeGame();
    game.world.addMoney(100_000);
    useUiStore.getState().selectBuild('sunstone-path');
    inputHandlers!.start({ x: 15, y: 30 });
    inputHandlers!.move({ x: 15, y: 27 });
    const long = useUiStore.getState().previewCost;
    inputHandlers!.move({ x: 15, y: 30 });
    expect(keysOf(previews.at(-1)!.cells)).toEqual(['15,30']);
    const short = useUiStore.getState().previewCost;
    expect(short).toBe(game.world.pathCost);
    expect(long).toBe(4 * game.world.pathCost);
    game.destroy();
  });

  it('a draft the park cannot afford is all red', async () => {
    const game = await makeGame();
    game.world.addMoney(-game.world.cash);
    useUiStore.getState().selectBuild('sunstone-path');
    inputHandlers!.start({ x: 15, y: 30 });
    inputHandlers!.move({ x: 15, y: 27 });
    expect(previews.at(-1)!.valid).toBe(false);
    expect(previews.at(-1)!.blocked).toBeNull();
    game.destroy();
  });

  it('a mid-drag Ctrl+Z still empties the draft', async () => {
    const game = await makeGame();
    game.world.addMoney(100_000);
    useUiStore.getState().selectBuild('ribbon-bench');
    inputHandlers!.end({ x: 5, y: 4 });
    useUiStore.getState().selectBuild('sunstone-path');
    const before = game.world.paths.size;
    inputHandlers!.start({ x: 15, y: 30 });
    inputHandlers!.move({ x: 15, y: 27 });
    pressUndo();
    inputHandlers!.move({ x: 15, y: 25 });
    inputHandlers!.end({ x: 15, y: 25 });
    expect(game.world.paths.size).toBe(before);
    game.destroy();
  });
});
