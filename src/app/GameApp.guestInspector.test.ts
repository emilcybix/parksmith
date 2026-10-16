import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 30 in GameApp: the guest inspector (the pointer's click on a guest figure where no ride or stall is, the
 * bridge's selectGuest, Escape, the close, a guest who leaves, a session swap, the paint tool) and focusBuilding as the
 * complaint links use it (closes the management dashboard, eases the camera, opens the inspector, drops a guest
 * selection). Fake renderer and stubbed window as in GameApp.demolish.test.ts.
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
const focusCalls: Array<{ kind: 'cell' | 'entrance'; motion: string | undefined }> = [];
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
  focusCell(_cell: CellLike, motion?: string): void { focusCalls.push({ kind: 'cell', motion }); }
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
const { activeInputContext } = await import('../ui/inputContext');
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

const keydown = (key: string, extra: Record<string, unknown> = {}): void => {
  for (const handler of handlers.get('keydown') ?? []) {
    handler({
      type: 'keydown', key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null,
      preventDefault: () => undefined, ...extra,
    });
  }
};

const ui = () => useUiStore.getState();
const click = (cell: CellLike): void => { inputHandlers!.start(cell); inputHandlers!.end(cell); };

const CAROUSEL = BUILD_BY_ID.get('moonpetal-carousel')!;
const PICNIC = BUILD_BY_ID.get('picnic-pocket')!;

/** One guest at the gate (the dev spawn puts a guest on the entrance cell), paused so nothing moves it. */
const spawnOne = (game: InstanceType<typeof GameApp>): { id: number; cell: CellLike } => {
  game.setSpeed(0);
  game.guests.spawnGuests(1);
  const guest = [...game.guests.guests.values()].at(-1)!;
  return { id: guest.id, cell: { x: guest.position.x, y: guest.position.y } };
};

beforeEach(() => {
  inputHandlers = null;
  frameCallback = null;
  focusCalls.length = 0;
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

describe('selecting a guest', () => {
  it('the pointer click on a cell with no ride or stall picks the nearest guest figure and publishes the snapshot', async () => {
    const game = await makeGame();
    const { id, cell } = spawnOne(game);
    expect(ui().selectedGuest).toBeNull();
    click(cell);
    expect(ui().selectedGuest?.id).toBe(id);
    expect(ui().selectedGuest).toMatchObject({ state: 'entering', doing: 'Just arrived' });
    expect(ui().selectedRide).toBeNull();
    expect(ui().selectedService).toBeNull();
    expect(selectCalls.at(-1), 'no building highlight for a guest').toBeNull();
    expect(activeInputContext(ui())).toBe('inspector');
    // A click on an empty cell far from anyone closes it.
    click({ x: cell.x + 5, y: cell.y + 5 });
    expect(ui().selectedGuest).toBeNull();
    expect(activeInputContext(ui())).not.toBe('inspector');
  });

  it('a click on a bench picks the guest sitting on it, though their position is the path beside it (review fix)', async () => {
    const game = await makeGame();
    const bench = game.world.buildObject('ribbon-bench', { x: 20, y: 14 })!;
    expect(bench).toBeTruthy();
    const { id } = spawnOne(game);
    const sitter = game.guests.guests.get(id)!;
    sitter.state = 'resting';
    sitter.activity = 'seatLeft';
    sitter.destinationObjectId = bench.id;
    sitter.position = { x: 21, y: 14 };
    sitter.currentCell = { x: 21, y: 14 };
    expect(game.guests.guestNear({ x: 20, y: 14 }), 'by distance alone the sitter is out of reach').toBeNull();
    click({ x: 20, y: 14 });
    expect(ui().selectedGuest?.id).toBe(id);
    expect(ui().selectedGuest?.state).toBe('resting');
  });

  it('the bridge selects a guest by id and ignores one who is not in the park', async () => {
    const game = await makeGame();
    const { id } = spawnOne(game);
    gameBridge.selectGuest(id + 1000);
    expect(ui().selectedGuest).toBeNull();
    gameBridge.selectGuest(id);
    expect(ui().selectedGuest?.id).toBe(id);
  });

  it('is exclusive with a ride or stall selection, both ways', async () => {
    const game = await makeGame();
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    const { id } = spawnOne(game);
    gameBridge.selectGuest(id);
    click({ x: 20, y: 10 });
    expect(ui().selectedRide?.objectId).toBe(ride.id);
    expect(ui().selectedGuest).toBeNull();
    gameBridge.selectGuest(id);
    expect(ui().selectedRide).toBeNull();
    expect(ui().selectedGuest?.id).toBe(id);
    expect(selectCalls.at(-1), 'the ride highlight is cleared').toBeNull();
    // A stall too, and an open demolish confirmation goes with the selection.
    const stall = game.world.buildObject(PICNIC.id, { x: 6, y: 6 })!;
    game.focusBuilding(stall.id);
    ui().openDemolishConfirm(stall.id);
    gameBridge.selectGuest(id);
    expect(ui().selectedService).toBeNull();
    expect(ui().demolishConfirmId).toBeNull();
    expect(ui().selectedGuest?.id).toBe(id);
  });
});

describe('closing the guest inspector', () => {
  it('Escape and the close command close it', async () => {
    const game = await makeGame();
    const { id } = spawnOne(game);
    gameBridge.selectGuest(id);
    keydown('Escape');
    expect(ui().selectedGuest).toBeNull();
    gameBridge.selectGuest(id);
    gameBridge.closeInspector();
    expect(ui().selectedGuest).toBeNull();
  });

  it('a guest who leaves closes it on the next UI sync', async () => {
    const game = await makeGame();
    const { id } = spawnOne(game);
    gameBridge.selectGuest(id);
    expect(ui().selectedGuest?.id).toBe(id);
    game.guests.removeAll();
    runFrames(2);
    expect(ui().selectedGuest).toBeNull();
    expect(activeInputContext(ui())).not.toBe('inspector');
    // The id is dropped too: a later guest with the same id is not silently adopted (ids never repeat anyway).
    game.guests.spawnGuests(1);
    runFrames(2);
    expect(ui().selectedGuest).toBeNull();
  });

  it('a session swap (a new park) and the paint tool close it', async () => {
    const game = await makeGame();
    const first = spawnOne(game);
    gameBridge.selectGuest(first.id);
    game.startScenario(null);
    expect(ui().selectedGuest).toBeNull();
    const second = spawnOne(game);
    gameBridge.selectGuest(second.id);
    expect(ui().selectedGuest?.id).toBe(second.id);
    ui().selectPaint();
    runFrames(1);
    expect(ui().selectedGuest, 'the paint panel takes the inspector slot').toBeNull();
    ui().selectPointer();
  });
});

describe('focusBuilding for the complaint links', () => {
  it('closes the management dashboard, eases the camera, opens the building inspector and drops a guest selection', async () => {
    const game = await makeGame();
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    const { id } = spawnOne(game);
    gameBridge.selectGuest(id);
    ui().openManagement('activity');
    expect(ui().managementOpen).toBe(true);
    gameBridge.focusBuilding(ride.id);
    expect(ui().managementOpen, 'the dashboard would hide the inspector').toBe(false);
    expect(ui().selectedRide?.objectId).toBe(ride.id);
    expect(ui().selectedGuest).toBeNull();
    expect(focusCalls.at(-1)).toEqual({ kind: 'cell', motion: 'ease' });
    expect(activeInputContext(ui())).toBe('inspector');
    // From the Pulse (no dashboard open) it is the same, for a stall.
    const stall = game.world.buildObject(PICNIC.id, { x: 6, y: 6 })!;
    gameBridge.focusBuilding(stall.id);
    expect(ui().selectedService?.objectId).toBe(stall.id);
    expect(ui().selectedRide).toBeNull();
    expect(ui().managementOpen).toBe(false);
    // A demolished building: nothing happens, the dashboard stays as it is.
    game.world.demolishObject(stall.id);
    ui().openManagement('activity');
    gameBridge.focusBuilding(stall.id);
    expect(ui().managementOpen).toBe(true);
    expect(ui().selectedService).toBeNull();
  });

  it('the guest snapshot carries the complaint link only while the building stands', async () => {
    const game = await makeGame();
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    const { id } = spawnOne(game);
    const guest = game.guests.guests.get(id)!;
    guest.currentThought = 'This queue is taking forever.';
    guest.thoughtObjectId = ride.id;
    gameBridge.selectGuest(id);
    expect(ui().selectedGuest).toMatchObject({ thought: 'This queue is taking forever.', thoughtObjectId: ride.id, thoughtObjectName: CAROUSEL.name });
    game.world.demolishObject(ride.id);
    runFrames(2);
    expect(ui().selectedGuest).toMatchObject({ thoughtObjectId: null, thoughtObjectName: null });
  });
});
