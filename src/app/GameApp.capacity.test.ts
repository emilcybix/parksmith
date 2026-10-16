import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 11 in GameApp: the park reads it publishes beside the snapshots (never inside them, design rule 2).
 * - PA-009: `guestCapacity` (a new object only when a number changed), the transient `atCapacity` flag and its one-off
 *   `important` toast, reset on a session swap.
 * - PA-024: `noPathAccessIds`, sorted, with a stable array identity while nothing changed.
 * Fake renderer and stubbed window as in GameApp.undo.test.ts; frames drive the 4 Hz snapshot.
 */

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
const { capacityToast } = await import('../ui/capacityModel');
const { CAPACITY_FIRE_TICKS, CAPACITY_ON_TICKS } = await import('./capacityNotice');


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
  return game;
};

const runFrames = (count: number, deltaMs = 250): void => {
  for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs);
};

/** Runs 4 Hz frames until the world tick has moved on by at least `ticks`. */
const runTicks = (game: InstanceType<typeof GameApp>, ticks: number): void => {
  const target = game.world.tick + ticks;
  for (let guard = 0; game.world.tick < target && guard < 10_000; guard += 1) frameCallback?.(250);
};

const ui = () => useUiStore.getState();

type CapacityView = ReturnType<InstanceType<typeof GameApp>['guests']['capacityView']>;
const holdFull = (game: InstanceType<typeof GameApp>, base: CapacityView): void => {
  vi.spyOn(game.guests, 'capacityView').mockImplementation(() => ({ ...base, blocked: null, ceiling: 12 }));
  Object.defineProperty(game.guests.guests, 'size', { configurable: true, get: () => 12 });
};

beforeEach(() => {
  frameCallback = null;
  const storage = new Map<string, string>([
    ['parksmith-profile', JSON.stringify({ version: 1, discoveredCardIds: [], tour: {}, ui: { mapSeen: true, tourOffered: true } })],
  ]);
  const register = (): void => undefined;
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
});

afterEach(() => {
  for (const game of games.splice(0)) game.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('guest capacity', () => {
  it('publishes capacityView on the 4 Hz snapshot and on a world change, keeping the object while nothing changed', async () => {
    const game = await makeGame();
    runFrames(4);
    const first = ui().guestCapacity;
    expect(first).toEqual(game.guests.capacityView());
    runFrames(4);
    expect(ui().guestCapacity, 'the same numbers keep the same object').toBe(first);
    // A ride built while paused shows at once (syncUi on the world change, no frame needed).
    game.setSpeed(0);
    game.world.buildObject('moonpetal-carousel', { x: 20, y: 10 });
    expect(ui().guestCapacity).toEqual(game.guests.capacityView());
  });

  it('turns atCapacity on after 10 simulated seconds at the ceiling and toasts once after 60', async () => {
    const game = await makeGame();
    const base = game.guests.capacityView();
    // A park held exactly full: 12 guests (as GameApp counts them) against a ceiling of 12. Guests in an empty test park
    // leave at once, so the count is pinned on the map the app reads.
    holdFull(game, base);
    game.setSpeed(4);
    const toasts: Array<{ text: string | null; cls: string }> = [];
    const stop = useUiStore.subscribe((state, previous) => {
      if (state.toastSeq !== previous.toastSeq) toasts.push({ text: state.toast, cls: state.toastClass });
    });
    try {
      runFrames(1);
      expect(ui().atCapacity).toBe(false);
      runTicks(game, CAPACITY_ON_TICKS + 10);
      expect(ui().atCapacity).toBe(true);
      expect(toasts.filter((toast) => toast.text?.startsWith('Park at capacity'))).toEqual([]);
      runTicks(game, CAPACITY_FIRE_TICKS + 10);
      runTicks(game, CAPACITY_FIRE_TICKS);
      const capacityToasts = toasts.filter((toast) => toast.text?.startsWith('Park at capacity'));
      expect(capacityToasts).toHaveLength(1);
      expect(capacityToasts[0].cls).toBe('important');
      expect(capacityToasts[0].text).toBe(capacityToast(12));
    } finally {
      stop();
    }
  });

  it('pausing freezes the tracker, and a session swap resets it', async () => {
    const game = await makeGame();
    const base = game.guests.capacityView();
    holdFull(game, base);
    game.setSpeed(4);
    runTicks(game, CAPACITY_ON_TICKS - 30);
    game.setSpeed(0);
    runFrames(200);
    expect(ui().atCapacity, 'no simulated time passed').toBe(false);
    game.setSpeed(4);
    runTicks(game, 50);
    expect(ui().atCapacity).toBe(true);

    game.startSandboxMap('meadow');
    expect(ui().atCapacity).toBe(false);
  });
});

describe('no path access', () => {
  it('lists the unconnected rides and stalls, sorted, and keeps the array while nothing changed', async () => {
    const game = await makeGame();
    expect(ui().noPathAccessIds).toEqual([]);
    const stall = game.world.buildObject('picnic-pocket', { x: 6, y: 6 })!;
    const ride = game.world.buildObject('moonpetal-carousel', { x: 20, y: 10 })!;
    game.world.buildObject('ribbon-bench', { x: 3, y: 20 });
    expect(ui().noPathAccessIds).toEqual([stall.id, ride.id].sort((a, b) => a - b));
    const published = ui().noPathAccessIds;
    for (const id of published) expect(game.management.hasPathAccess(id)).toBe(false);
    runFrames(8);
    expect(ui().noPathAccessIds, 'same content, same array').toBe(published);

    game.world.bulldoze({ x: 20, y: 10 });
    expect(ui().noPathAccessIds).toEqual([stall.id]);
  });
});
