import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParkSession } from '../game/session/ParkSession';

/**
 * GameApp's side of biomes and maps (Phase 24), in the undo test's style: fake renderer, stubbed window, real manager
 * over a memory store, gestures driven through the input handlers. Pinned here: starting a sandbox on a map, the
 * camera sweep's centre, the bulldozer clearing an obstacle for its price (hover text, toast, ledger, one undo entry),
 * the typed refusals (permanent, funds), the refused ghost and path texts, and the map names a save carries.
 */

const log: string[] = [];
const phases: number[] = [];
const weatherViews: Array<{ kind: string; intensity: number; day: number }> = [];
let frameCallback: ((deltaMs: number) => void) | null = null;
type Handlers = {
  hover(cell: { x: number; y: number } | null): void;
  start(cell: { x: number; y: number }): void;
  move(cell: { x: number; y: number }): void;
  end(cell: { x: number; y: number }): void;
  cancel(): void;
};
let inputHandlers: Handlers | null = null;
let hovered: { x: number; y: number } | null = null;

class FakeRenderer {
  get hoveredCell() { return hovered; }
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(callback: (deltaMs: number) => void): void { frameCallback = callback; }
  setSession(): void { log.push('setSession'); }
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(phase: number): void { phases.push(phase); }
  setWeather(view: Readonly<{ kind: string; intensity: number; day: number }>): void { weatherViews.push({ kind: view.kind, intensity: view.intensity, day: view.day }); }
  setInputHandlers(handlers: Handlers): void { inputHandlers = handlers; }
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
const { hashState } = await import('../game/save/hash');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const host = {} as HTMLElement;

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
  return game;
};

/** The parts of GameApp the tests reach into; named so a rename breaks here and not silently. */
interface Internals {
  session: InstanceType<typeof ParkSession>;
  undo: {
    depth: number;
    hasPending: boolean;
    begin(kind: string): void;
    status(): { canUndo: boolean; reason: string | null; depth: number; label: string; armed: boolean; rewindSeconds: number };
    refresh(): boolean;
    newest: { label: string; kind: string } | null;
  };
  saves: { notifyParkRewound?: () => void };
  selectedRideId: number | null;
  coasterDraft: unknown[];
  handleScenarioEvents(events: Array<{ kind: string }>): void;
  swapping: boolean;
}
const internals = (game: unknown) => game as Internals;

const hashOf = (game: unknown): string => {
  const session = internals(game).session;
  session.syncWithWorld();
  return hashState(session.serialize());
};

/** Runs real frames through the ticker; at speed 4 one 1,000 ms frame is 1,000 ms of ... 4 x 250 simulated. */
const runFrames = (count: number, deltaMs = 250): void => {
  for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs);
};

const pressUndo = (options: { repeat?: boolean; shift?: boolean; target?: unknown } = {}): { prevented: boolean } => {
  let prevented = false;
  for (const handler of handlers.get('keydown') ?? []) {
    handler({
      ctrlKey: true, metaKey: false, altKey: false, shiftKey: options.shift ?? false, key: 'z',
      repeat: options.repeat ?? false,
      target: options.target ?? null,
      preventDefault: () => { prevented = true; },
    });
  }
  return { prevented };
};

const toast = (): string | null => useUiStore.getState().toast;

beforeEach(() => {
  log.length = 0;
  frameCallback = null;
  inputHandlers = null;
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


const CANYON = 'red-rock-canyon' as const;
const BOULDER = { x: 27, y: 1 };
const WALL = { x: 9, y: 0 };

describe('starting a sandbox on a map', () => {
  it('builds the chosen map, names it in the toast and keeps Meadow for the plain start', async () => {
    const game = await makeGame();
    expect(game.world.map.id).toBe('meadow');
    game.startSandboxMap(CANYON);
    expect(game.world.map.id).toBe(CANYON);
    expect(game.world.entrance).toEqual({ x: 16, y: 0 });
    expect(game.world.entranceFacing).toBe('south');
    expect(game.world.biome.id).toBe('desert-canyon');
    expect(toast()).toBe('Red Rock Canyon started');
    game.startScenario(null);
    expect(game.world.map.id, 'the default start is the Meadow Garden').toBe('meadow');
    expect(toast()).toBe('Sandbox park started');
    game.destroy();
  });

  it('restarts a sandbox on the same map, and refuses an unknown one without swapping', async () => {
    const game = await makeGame();
    game.startSandboxMap('frosted-hollow');
    game.restartScenario();
    expect(game.world.map.id).toBe('frosted-hollow');
    const session = internals(game).session;
    game.startScenario(null, [], 'nowhere' as never);
    expect(internals(game).session, 'nothing was swapped').toBe(session);
    expect(toast()).toBe('That map does not exist');
    game.destroy();
  });

  it('a scenario plays its own map: a chosen map is ignored', async () => {
    const game = await makeGame();
    game.startScenario('sunny-start', [], CANYON);
    expect(game.world.map.id).toBe('meadow');
    game.destroy();
  });

  it('takes the sandbox clock defaults of the biome only on a new park (Autumn Forest: relaxed days, dusk)', async () => {
    const game = await makeGame();
    game.startSandboxMap('maple-ridge');
    expect(internals(game).session.calendar.dayLengthSeconds).toBe(1440);
    expect(internals(game).session.calendar.timeLock).toBe('dusk');
    game.startScenario(null);
    expect(internals(game).session.calendar.dayLengthSeconds).toBe(720);
    expect(internals(game).session.calendar.timeLock).toBe('auto');
    game.destroy();
  });

  it('centres the start screen sweep on the world it shows after every swap', async () => {
    const game = await makeGame();
    game.startSandboxMap(CANYON);
    const sweep = (game as unknown as { sweep: { reset(): void; current(out: { x: number; y: number }): { x: number; y: number } } }).sweep;
    sweep.reset();
    expect(sweep.current({ x: 0, y: 0 })).toEqual({ x: game.world.width / 2, y: game.world.height / 2 });
    game.destroy();
  });
});

describe('weather and climate text per biome', () => {
  it('publishes the biome words and the climate to the weather UI', async () => {
    const game = await makeGame();
    game.startSandboxMap('frosted-hollow');
    game.setSpeed(0);
    runFrames(3);
    const ui = useUiStore.getState().weatherUi;
    expect(ui.biomeId).toBe('winter');
    expect(ui.climate).toBe('cold');
    expect(ui.climateLabel).toBe('Cold');
    game.startScenario(null);
    runFrames(3);
    expect(useUiStore.getState().weatherUi.biomeId).toBe('meadow');
    expect(useUiStore.getState().weatherUi.climate).toBe('mild');
    game.destroy();
  });
});

describe('clearing obstacles with the bulldozer', () => {
  const setup = async () => {
    const game = await makeGame();
    game.startSandboxMap(CANYON);
    game.setSpeed(0);
    return game;
  };

  it('shows the price on hover, clears for it on click, names the toast and the undo entry', async () => {
    const game = await setup();
    const app = internals(game);
    expect(game.world.propAt(BOULDER)?.kind).toBe('red-boulder');
    useUiStore.getState().selectBulldozer();
    const cash = game.world.cash;
    inputHandlers!.hover(BOULDER);
    const state = useUiStore.getState();
    expect(state.previewTitle).toBe('Clear Red boulder · $180');
    expect(state.previewCost).toBe(180);
    expect(state.previewValid).toBe(true);
    expect(state.previewBlock).toBeNull();
    inputHandlers!.start(BOULDER);
    inputHandlers!.end(BOULDER);
    expect(game.world.propAt(BOULDER)).toBeUndefined();
    expect(game.world.cash).toBe(cash - 180);
    expect(toast()).toBe('Cleared Red boulder · -$180');
    const row = game.world.transactions.find((transaction) => transaction.category === 'land-clearing');
    expect(row).toMatchObject({ amount: -180, label: 'Cleared Red boulder' });
    expect(app.undo.depth).toBe(1);
    expect(app.undo.newest?.label).toBe('Red boulder cleared');
    game.destroy();
  });

  it('Ctrl+Z puts the boulder and the cash back (and a second clear works again)', async () => {
    const game = await setup();
    useUiStore.getState().selectBulldozer();
    const cash = game.world.cash;
    const before = hashOf(game);
    inputHandlers!.start(BOULDER);
    inputHandlers!.end(BOULDER);
    expect(game.world.propAt(BOULDER)).toBeUndefined();
    pressUndo();
    await settle();
    expect(game.world.propAt(BOULDER)?.kind, 'the boulder is back').toBe('red-boulder');
    expect(game.world.cash).toBe(cash);
    expect(hashOf(game)).toBe(before);
    inputHandlers!.start(BOULDER);
    inputHandlers!.end(BOULDER);
    expect(game.world.propAt(BOULDER)).toBeUndefined();
    expect(game.world.cash).toBe(cash - 180);
    game.destroy();
  });

  it('a drag over several props is one undo entry named by what it cleared', async () => {
    const game = await setup();
    const app = internals(game);
    useUiStore.getState().selectBulldozer();
    // Two clearable props on row 1 and 2 of the east mesa: the boulder at (27, 1) and the saguaro at (27, 2).
    inputHandlers!.start({ x: 27, y: 1 });
    inputHandlers!.move({ x: 27, y: 2 });
    inputHandlers!.end({ x: 27, y: 2 });
    expect(game.world.propAt({ x: 27, y: 1 })).toBeUndefined();
    expect(game.world.propAt({ x: 27, y: 2 })).toBeUndefined();
    expect(app.undo.depth).toBe(1);
    expect(app.undo.newest?.label).toBe('2 obstacles cleared');
    expect(toast(), 'each stroke of the drag reports what it just cleared').toBe('Cleared Saguaro · -$70');
    expect(game.world.transactions.filter((transaction) => transaction.category === 'land-clearing').map((transaction) => transaction.amount).sort((a, b) => a - b)).toEqual([-180, -70]);
    game.destroy();
  });

  it('refuses a permanent prop with the typed text, no charge and no undo entry', async () => {
    const game = await setup();
    const app = internals(game);
    expect(game.world.propAt(WALL)?.kind).toBe('canyon-wall');
    useUiStore.getState().selectBulldozer();
    const cash = game.world.cash;
    inputHandlers!.hover(WALL);
    expect(useUiStore.getState().previewTitle).toBe('Canyon wall cannot be cleared');
    expect(useUiStore.getState().previewValid).toBe(false);
    inputHandlers!.start(WALL);
    inputHandlers!.end(WALL);
    expect(game.world.propAt(WALL)).toBeDefined();
    expect(game.world.cash).toBe(cash);
    expect(toast()).toBe('Canyon wall cannot be cleared');
    expect(app.undo.depth).toBe(0);
    game.destroy();
  });

  it('refuses for lack of cash with the shortfall, once per drag, and takes no snapshot', async () => {
    const game = await setup();
    const app = internals(game);
    game.world.postTransaction(-(game.world.cash - 100), 'Test spend');
    useUiStore.getState().selectBulldozer();
    inputHandlers!.hover(BOULDER);
    expect(useUiStore.getState().previewValid).toBe(false);
    expect(useUiStore.getState().previewBlock).toBe('Need $180 · you have $100');
    inputHandlers!.start(BOULDER);
    inputHandlers!.end(BOULDER);
    expect(game.world.propAt(BOULDER)).toBeDefined();
    expect(game.world.cash).toBe(100);
    expect(toast()).toBe('Need $180 · you have $100');
    expect(app.undo.depth).toBe(0);
    game.destroy();
  });

  it('an object ghost over a prop says what blocks it and what clearing costs; water and permanent say so', async () => {
    const game = await setup();
    useUiStore.getState().selectBuild('ribbon-bench');
    inputHandlers!.hover(BOULDER);
    expect(useUiStore.getState().previewValid).toBe(false);
    expect(useUiStore.getState().previewBlock).toBe('Blocked by Red boulder · clear it for $180');
    inputHandlers!.hover(WALL);
    expect(useUiStore.getState().previewBlock).toBe('Blocked by Canyon wall (it cannot be cleared)');
    inputHandlers!.end(BOULDER);
    expect(toast()).toBe('Blocked by Red boulder · clear it for $180');
    game.destroy();

    const sea = await makeGame();
    sea.startSandboxMap('seaside-cove');
    const water = (() => {
      for (let y = 0; y < sea.world.height; y += 1) {
        for (let x = 0; x < sea.world.width; x += 1) if (sea.world.obstacleAt({ x, y })?.kind === 'water') return { x, y };
      }
      throw new Error('no water');
    })();
    useUiStore.getState().selectBuild('ribbon-bench');
    inputHandlers!.hover(water);
    expect(useUiStore.getState().previewBlock).toBe('Blocked by water');
    useUiStore.getState().selectBuild('sunstone-path');
    inputHandlers!.hover(water);
    expect(useUiStore.getState().previewBlock).toBe('Blocked by water');
    sea.destroy();
  });

  it('a path over a prop is refused with the same words, and builds nothing', async () => {
    const game = await setup();
    useUiStore.getState().selectBuild('sunstone-path');
    inputHandlers!.hover(BOULDER);
    expect(useUiStore.getState().previewBlock).toBe('Blocked by Red boulder · clear it for $180');
    const paths = game.world.paths.size;
    inputHandlers!.start({ x: 27, y: 0 });
    inputHandlers!.move({ x: 27, y: 2 });
    inputHandlers!.end({ x: 27, y: 2 });
    expect(game.world.paths.size).toBe(paths);
    expect(toast()).toBe('Blocked by Red boulder · clear it for $180');
    game.destroy();
  });

  it('an empty tile and the gate still read as before under the bulldozer', async () => {
    const game = await setup();
    useUiStore.getState().selectBulldozer();
    inputHandlers!.hover({ x: 14, y: 12 });
    expect(useUiStore.getState().previewTitle).toBeNull();
    expect(useUiStore.getState().previewValid).toBe(false);
    game.destroy();
  });
});

describe('what a save says about the map', () => {
  it('captures the map and biome names (and Custom map for a land that is not shipped)', async () => {
    const game = await makeGame();
    game.startSandboxMap(CANYON);
    const captured = (game as unknown as { capturePark(): { mapName?: string; biomeName?: string; state: { map: { id: string } } } }).capturePark();
    expect(captured.mapName).toBe('Red Rock Canyon');
    expect(captured.biomeName).toBe('Desert Canyon');
    expect(captured.state.map.id).toBe(CANYON);
    game.destroy();
  });
});

describe('starting a sandbox on a generated map (Phase 24 step 2)', () => {
  it('builds the generated layout, stores the recipe, names it in the toast and the save metadata', async () => {
    const { recipeOf } = await import('../game/maps/generator');
    const recipe = recipeOf('jungle', 1234, { density: 'high' });
    const game = await makeGame();
    game.startGeneratedMap(recipe);
    expect(game.world.biome.id).toBe('jungle');
    expect(game.world.map.id).toBe('gen-jungle-1234-hw');
    expect(toast()).toBe('Jungle Generated · seed 1234 started');
    const captured = (game as unknown as { capturePark(): { mapName?: string; biomeName?: string; state: { map: { recipe: unknown } } } }).capturePark();
    expect(captured.state.map.recipe).toEqual(recipe);
    expect(captured.mapName).toBe('Generated · seed 1234');
    expect(captured.biomeName).toBe('Jungle');
    game.destroy();
  });

  it('refuses a hostile recipe without swapping the park', async () => {
    const game = await makeGame();
    const session = internals(game).session;
    game.startGeneratedMap({ generatorVersion: 1, biomeId: 'meadow', seed: -5, density: 'normal', water: true });
    expect(internals(game).session).toBe(session);
    expect(toast()).toBe('That generated map is not valid');
    game.startGeneratedMap({ generatorVersion: 99, biomeId: 'meadow', seed: 5, density: 'normal', water: true });
    expect(internals(game).session).toBe(session);
    expect(toast()).toBe('That generated map could not be made');
    game.destroy();
  });

  it('a scenario ignores a recipe', async () => {
    const { recipeOf } = await import('../game/maps/generator');
    const game = await makeGame();
    game.startScenario('sunny-start', [], undefined, recipeOf('winter', 7));
    expect(game.world.map.id).toBe('meadow');
    game.destroy();
  });
});
