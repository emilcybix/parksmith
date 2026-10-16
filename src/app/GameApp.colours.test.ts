import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 28 step 1, GameApp's side of recolouring a ride from the inspector: the bridge commands, the
 * undo gesture (one entry per ride however many picks, cosmetic: no rewound time), the save token and
 * the UI snapshot. Same scaffold as GameApp.undo.test.ts: fake renderer, stubbed window, real manager.
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
const { gameBridge } = await import('./gameBridge');
const { useUiStore } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');
const { ParkSession } = await import('../game/session/ParkSession');
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

/** One object placement through the input handlers, as a click on the grass. */
const placeBench = (x: number): void => {
  useUiStore.getState().selectBuild('ribbon-bench');
  inputHandlers!.end({ x, y: 4 });
};

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


const COLOUR_SWATCH_COUNT = 21;

/** The selected-ride colour record the inspector reads. */
const shown = () => useUiStore.getState().selectedColours;

const selectRide = (anchor: { x: number; y: number }): void => {
  useUiStore.getState().selectPointer();
  inputHandlers!.start(anchor);
};

const park = async () => {
  const game = await makeGame();
  game.world.addMoney(500_000);
  const ride = game.world.buildObject('moonpetal-carousel', { x: 20, y: 10 })!;
  const swings = game.world.buildObject('harbor-swings', { x: 20, y: 16 })!;
  selectRide(ride.anchor);
  return { game, app: internals(game), ride: ride.id, swings: swings.id, anchor: ride.anchor, swingsAnchor: swings.anchor };
};

describe('inspector colour commands', () => {
  it('a pick recolours the ride, publishes the record and takes ONE undo entry labelled by the ride', async () => {
    const { game, app, ride } = await park();
    expect(shown()).toBeNull();
    const stamp = (game as unknown as { saveVersion(): number }).saveVersion();
    gameBridge.setSelectedObjectColour(0, 19);
    expect(game.world.objectColours(ride)).toEqual([19, null, null]);
    expect(shown()).toEqual([19, null, null]);
    expect(app.undo.depth).toBe(1);
    expect(app.undo.newest).toMatchObject({ kind: 'recolour', label: 'Moonpetal Carousel recoloured' });
    expect((game as unknown as { saveVersion(): number }).saveVersion(), 'the save layer sees a change').not.toBe(stamp);
    expect(useUiStore.getState().undoStatus.canUndo).toBe(true);
    game.destroy();
  });

  it('further picks on the same ride join that entry; picking what is already there costs nothing', async () => {
    const { game, app } = await park();
    gameBridge.setSelectedObjectColour(0, 19);
    gameBridge.setSelectedObjectColour(1, 4);
    gameBridge.setSelectedObjectColour(0, 7);
    gameBridge.setSelectedObjectColour(2, 2);
    expect(shown()).toEqual([7, 4, 2]);
    expect(app.undo.depth, 'four picks, one entry').toBe(1);
    const entry = app.undo.newest;
    gameBridge.setSelectedObjectColour(0, 7);
    expect(app.undo.depth).toBe(1);
    expect(app.undo.newest, 'same entry, not replaced').toBe(entry);
    game.destroy();
  });

  it('a different ride, or any other gesture in between, opens a new entry', async () => {
    const { game, app, anchor, swingsAnchor } = await park();
    gameBridge.setSelectedObjectColour(0, 19);
    selectRide(swingsAnchor);
    gameBridge.setSelectedObjectColour(0, 3);
    expect(app.undo.depth, 'another ride is another entry').toBe(2);
    placeBench(5);
    expect(app.undo.depth).toBe(3);
    selectRide(swingsAnchor);
    gameBridge.setSelectedObjectColour(1, 5);
    expect(app.undo.depth, 'a bench was built since: the recolour starts its own entry').toBe(4);
    selectRide(anchor);
    gameBridge.setSelectedObjectColour(1, 7);
    expect(app.undo.depth).toBe(5);
    game.destroy();
  });

  it('Reset puts every slot back as one entry, and is free when nothing is customised', async () => {
    const { game, app, ride } = await park();
    gameBridge.resetSelectedObjectColours();
    expect(app.undo.depth, 'nothing to reset, nothing recorded').toBe(0);
    gameBridge.setSelectedObjectColour(0, 19);
    gameBridge.setSelectedObjectColour(2, 9);
    placeBench(5);
    selectRide(game.world.objects.get(ride)!.anchor);
    gameBridge.resetSelectedObjectColours();
    expect(game.world.objectColours(ride)).toBeNull();
    expect(shown()).toBeNull();
    expect(app.undo.depth).toBe(3);
    game.destroy();
  });

  it('refuses nonsense without throwing, changing anything or recording anything', async () => {
    const { game, app, ride } = await park();
    const version = game.world.version;
    for (const [slot, swatch] of [[3, 1], [-1, 1], [0.5, 1], [Number.NaN, 1], [0, 21], [0, -1], [0, 1.5], [0, Number.NaN], [0, Infinity], [1e9, 0]] as Array<[number, number]>) {
      expect(() => gameBridge.setSelectedObjectColour(slot, swatch), `${slot},${swatch}`).not.toThrow();
    }
    expect(game.world.objectColours(ride)).toBeNull();
    expect(game.world.version).toBe(version);
    expect(app.undo.depth).toBe(0);
    useUiStore.getState().selectPointer();
    game.closeInspector();
    expect(() => gameBridge.setSelectedObjectColour(0, 1)).not.toThrow();
    expect(() => gameBridge.resetSelectedObjectColours()).not.toThrow();
    expect(app.undo.depth).toBe(0);
    expect(shown()).toBeNull();
    game.destroy();
  });

  it('selecting a recoloured ride shows its record; closing clears it', async () => {
    const { game, anchor, swingsAnchor } = await park();
    gameBridge.setSelectedObjectColour(1, 12);
    selectRide(swingsAnchor);
    expect(shown(), 'the other ride is at defaults').toBeNull();
    selectRide(anchor);
    expect(shown()).toEqual([null, 12, null]);
    game.closeInspector();
    expect(shown()).toBeNull();
    game.destroy();
  });

  it('a recolour is free: no cash, no transaction, no world version, no simulation change', async () => {
    const { game } = await park();
    const before = { cash: game.world.cash, version: game.world.version, pathVersion: game.world.pathVersion, transactions: game.world.transactions.length };
    gameBridge.setSelectedObjectColour(0, 19);
    gameBridge.setSelectedObjectColour(1, 3);
    gameBridge.resetSelectedObjectColours();
    expect({ cash: game.world.cash, version: game.world.version, pathVersion: game.world.pathVersion, transactions: game.world.transactions.length }).toEqual(before);
    game.destroy();
  });
});

describe('undoing a recolour is cosmetic', () => {
  it('takes the colours back and nothing else: no session swap, no rewound time, no returned cash, guests stay', async () => {
    const { game, app, ride } = await park();
    gameBridge.setSelectedObjectColour(0, 19);
    gameBridge.setSelectedObjectColour(1, 4);
    game.spawnGuests();
    game.clock.setSpeed(4);
    runFrames(40);
    game.world.addMoney(1234);
    const after = { time: game.clock.simulationTimeMs, cash: game.world.cash, guests: game.guests.guests.size, tick: game.world.tick, session: app.session };
    expect(after.time).toBeGreaterThan(5_000);
    log.length = 0;
    const status = useUiStore.getState().undoStatus;
    expect(status.rewindSeconds, 'the control does not promise a rewind').toBe(0);
    expect(status.needsConfirmation).toBe(false);
    expect(status.label).toBe('Undo');
    expect(status.tooltip).toContain('Nothing else changes');

    pressUndo();
    expect(game.world.objectColours(ride)).toBeNull();
    expect(shown()).toBeNull();
    expect({ time: game.clock.simulationTimeMs, cash: game.world.cash, guests: game.guests.guests.size, tick: game.world.tick, session: app.session }).toEqual(after);
    expect(log, 'no swap, nothing rebuilt but the ride').not.toContain('setSession');
    expect(app.undo.depth).toBe(0);
    expect(toast()).toBe('Undid Moonpetal Carousel recoloured');
    expect(app.selectedRideId, 'the inspector stays open on the same ride').toBe(ride);
    game.destroy();
  });

  it('needs no confirmation however long ago the colour was picked', async () => {
    const { game, ride } = await park();
    gameBridge.setSelectedObjectColour(0, 19);
    game.clock.setSpeed(4);
    runFrames(400, 1000);
    expect(game.clock.simulationTimeMs).toBeGreaterThan(300_000);
    pressUndo();
    expect(game.world.objectColours(ride), 'one press, no second press').toBeNull();
    game.destroy();
  });

  it('an undo of a recolour sits in the ring order: the bench built after it goes first, then the colours', async () => {
    const { game, app, ride, anchor } = await park();
    gameBridge.setSelectedObjectColour(0, 19);
    placeBench(5);
    selectRide(anchor);
    gameBridge.setSelectedObjectColour(2, 8);
    expect(app.undo.depth).toBe(3);
    pressUndo();
    expect(game.world.objectColours(ride), 'the second recolour is undone, the first stays').toEqual([19, null, null]);
    pressUndo();
    expect([...game.world.objects.values()].some((object) => object.definitionId === 'ribbon-bench'), 'the bench is gone').toBe(false);
    expect(game.world.objectColours(ride), 'whole-park rewind: the colour picked before the bench is still there').toEqual([19, null, null]);
    pressUndo();
    expect(game.world.objectColours(ride)).toBeNull();
    game.destroy();
  });

  it('a whole-park undo of an older gesture takes the colours back with it', async () => {
    const { game, ride, anchor } = await park();
    placeBench(5);
    selectRide(anchor);
    gameBridge.setSelectedObjectColour(0, 19);
    expect(game.world.objectColours(ride)).toEqual([19, null, null]);
    pressUndo(); // the recolour
    pressUndo(); // the bench: a whole-park snapshot taken before the recolour existed
    expect(game.world.objectColours(ride)).toBeNull();
    game.destroy();
  });

  it('the recolour entry is gone after its undo, and a new pick starts a new entry', async () => {
    const { game, app, ride } = await park();
    gameBridge.setSelectedObjectColour(0, 19);
    pressUndo();
    expect(app.undo.depth).toBe(0);
    gameBridge.setSelectedObjectColour(0, 20);
    expect(app.undo.depth).toBe(1);
    expect(game.world.objectColours(ride)).toEqual([20, null, null]);
    game.destroy();
  });

  it('the save token and the autosave stamp move on an edit and on its undo', async () => {
    const { game } = await park();
    const token = (): number => (game as unknown as { saveVersion(): number }).saveVersion();
    const first = token();
    gameBridge.setSelectedObjectColour(0, 19);
    const second = token();
    pressUndo();
    const third = token();
    expect(new Set([first, second, third]).size, 'three different states of the park, three different tokens').toBe(3);
    game.destroy();
  });
});

describe('colours reach the saved park', () => {
  it('serialize carries the record and a fresh session built from it restores it', async () => {
    const { game, app, ride } = await park();
    gameBridge.setSelectedObjectColour(0, 19);
    gameBridge.setSelectedObjectColour(2, 8);
    app.session.syncWithWorld();
    const state = app.session.serialize();
    expect(state.world.objects.find((object) => object.id === ride)?.colours).toEqual([19, null, 8]);
    const restored = ParkSession.fromState(JSON.parse(JSON.stringify(state)));
    expect(restored.world.objectColours(ride)).toEqual([19, null, 8]);
    expect(hashOf(game)).toBe(hashState(state));
    game.destroy();
  });

  it('an uncoloured park serializes exactly as before colours existed (no colours key anywhere)', async () => {
    const { game, app } = await park();
    app.session.syncWithWorld();
    expect(JSON.stringify(app.session.serialize()).includes('colours')).toBe(false);
    game.destroy();
  });

  it('the palette the picker offers is the swatch list the world validates against', async () => {
    const { game, ride } = await park();
    for (let swatch = 0; swatch < COLOUR_SWATCH_COUNT; swatch += 1) {
      gameBridge.setSelectedObjectColour(0, swatch);
      // Orchid (9) is the carousel's Main default: picking it is picking the default, stored as no record.
      expect(game.world.objectColours(ride)?.[0] ?? null).toBe(swatch === 9 ? null : swatch);
    }
    gameBridge.setSelectedObjectColour(0, COLOUR_SWATCH_COUNT);
    expect(game.world.objectColours(ride)?.[0], 'one past the end is refused').toBe(COLOUR_SWATCH_COUNT - 1);
    game.destroy();
  });
});
