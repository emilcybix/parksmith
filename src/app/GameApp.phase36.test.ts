import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 36 (browser verification of Phases 30-35) in GameApp, with the fake renderer and stubbed window of
 * GameApp.phase30.review.test.ts:
 * - a complaint link / Buildings row focus hands the renderer the HUD's cover WITH the inspector it opens, so the camera
 *   puts the building beside the inspector (at 1100x690 the inspector hid the whole carousel);
 * - the renderer gets the HUD's cover for its pan clamp when it is attached;
 * - a click on a guest's head (the ground cell behind the figure) opens the guest inspector.
 */

type CellLike = { x: number; y: number };
type Handlers = {
  hover(cell: CellLike | null): void;
  start(cell: CellLike): void;
  move(cell: CellLike): void;
  end(cell: CellLike): void;
  cancel(): void;
};
let inputHandlers: Handlers | null = null;
let frameCallback: ((deltaMs: number) => void) | null = null;
const focusCalls: Array<{ kind: 'cell' | 'entrance'; motion: string | undefined; insets?: { left: number; top: number; right: number; bottom: number } }> = [];
const insetCalls: Array<{ left: number; top: number; right: number; bottom: number }> = [];
const selectCalls: Array<number | null> = [];

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
  setWeather(): void {}
  setInputHandlers(handlers: Handlers): void { inputHandlers = handlers; }
  setViewInputEnabled(): void {}
  setToolCursor(): void {}
  focusCell(_cell: CellLike, motion?: string, insets?: { left: number; top: number; right: number; bottom: number }): void { focusCalls.push({ kind: 'cell', motion, insets }); }
  setViewInsets(insets: { left: number; top: number; right: number; bottom: number }): void { insetCalls.push(insets); }
  focusEntrance(motion?: string): void { focusCalls.push({ kind: 'entrance', motion }); }
  setGridVisible(): void {}
  setSceneryInfluenceVisible(): void {}
  selectObject(object: { id: number } | null): void { selectCalls.push(object === null ? null : object.id); }
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
const { useUiStore } = await import('../ui/store');
const { hudInsets } = await import('../ui/layoutModel');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');
const { BUILD_BY_ID } = await import('../game/content/catalog');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const games: Array<{ destroy(): void }> = [];
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
  games.push(game);
  game.world.addMoney(200_000);
  runFrames(8);
  return game;
};

const runFrames = (count: number, deltaMs = 250): void => {
  for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs);
};

const ui = () => useUiStore.getState();
const click = (cell: CellLike): void => { inputHandlers!.start(cell); inputHandlers!.end(cell); };

const CAROUSEL = BUILD_BY_ID.get('moonpetal-carousel')!;

beforeEach(() => {
  inputHandlers = null;
  frameCallback = null;
  focusCalls.length = 0;
  insetCalls.length = 0;
  selectCalls.length = 0;
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
  ui().setToast(null);
  ui().selectPointer();
  ui().closeDemolishConfirm();
  ui().closeManagement();
});

afterEach(() => {
  for (const game of games.splice(0)) game.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


type Game = InstanceType<typeof GameApp>;

describe('Phase 36: the camera and the pointer know where the HUD and the figures are', () => {
  it('hands the renderer the HUD insets for its clamp when it is attached', async () => {
    await makeGame();
    expect(insetCalls.length).toBeGreaterThan(0);
    expect(insetCalls.at(-1)).toEqual(hudInsets(1, false));
  });

  it('focusBuilding of a ride eases to it framed beside the inspector it opens; a scenery piece only beside Park Pulse', async () => {
    const game = await makeGame();
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    const tree = game.world.buildObject('confetti-tree', { x: 5, y: 5 })!;
    gameBridge.focusBuilding(ride.id);
    expect(focusCalls.at(-1)).toEqual({ kind: 'cell', motion: 'ease', insets: hudInsets(1, true) });
    expect(ui().selectedRide?.objectId).toBe(ride.id);
    gameBridge.focusBuilding(tree.id);
    expect(focusCalls.at(-1)).toEqual({ kind: 'cell', motion: 'ease', insets: hudInsets(1, false) });
  });

  it('a click on the ground just behind a standing guest (where the head is drawn) opens their inspector', async () => {
    const game: Game = await makeGame();
    game.setSpeed(0);
    game.guests.spawnGuests(1);
    const guest = [...game.guests.guests.values()].at(-1)!;
    guest.position = { x: 12, y: 12 };
    guest.currentCell = { x: 12, y: 12 };
    guest.state = 'pausing';
    click({ x: 11, y: 11 });
    expect(ui().selectedGuest?.id).toBe(guest.id);
  });
});
