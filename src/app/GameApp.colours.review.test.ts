import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 28 step 1, adversarial review of the app side: undo restores exactly and is one entry, the
 * whole-park undo of a demolition brings colours back, a failed undo capture cannot make a later pick
 * join an unrelated entry, a manual save and the autosave (crash recovery) keep colours through the
 * real manager, and a v5 save loads at defaults. Scaffold copied from GameApp.colours.test.ts.
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
const { hashState } = await import('../game/save/hash');
const { saveBridge } = await import('./gameBridge');
const { START_AUTOSAVE_DELAY_SECONDS } = await import('./saves/constants');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const host = {} as HTMLElement;

const makeGame = async (store = new MemorySaveStore()) => {
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, {
      kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined,
    }),
  });
  await game.mount(host);
  await settle();
  stores.set(game, store);
  return game;
};
const stores = new Map<unknown, InstanceType<typeof MemorySaveStore>>();

/** The parts of GameApp the tests reach into; named so a rename breaks here and not silently. */
interface Internals {
  session: import('../game/session/ParkSession').ParkSession;
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




const selectRide = (anchor: { x: number; y: number }): void => {
  useUiStore.getState().selectPointer();
  inputHandlers!.start(anchor);
};

/** Every object's colour record, as the world holds it. */
const allColours = (game: { world: { objects: Map<number, { id: number }>; objectColours(id: number): readonly (number | null)[] | null } }) => (
  Object.fromEntries([...game.world.objects.keys()].map((id) => [id, game.world.objectColours(id)]))
);

const park = async (options: { chosen?: boolean } = {}) => {
  const game = await makeGame();
  if (options.chosen) {
    game.startScenario(null);
    await settle();
  }
  game.world.addMoney(500_000);
  const ride = game.world.buildObject('moonpetal-carousel', { x: 20, y: 10 })!;
  const swings = game.world.buildObject('harbor-swings', { x: 20, y: 16 })!;
  selectRide(ride.anchor);
  return { game, app: internals(game), ride: ride.id, swings: swings.id, anchor: ride.anchor, swingsAnchor: swings.anchor };
};

describe('undo of a recolour is one entry and restores exactly', () => {
  it('many picks on one ride after another ride was recoloured: one entry, and its undo puts every record back as it was', async () => {
    const { game, app, ride, swings, anchor, swingsAnchor } = await park();
    selectRide(swingsAnchor);
    gameBridge.setSelectedObjectColour(0, 3);
    gameBridge.setSelectedObjectColour(2, 11);
    selectRide(anchor);
    const before = allColours(game);
    const depth = app.undo.depth;
    const version = game.world.version;
    for (let pick = 0; pick < 30; pick += 1) gameBridge.setSelectedObjectColour(pick % 3, (pick * 5) % 21);
    gameBridge.resetSelectedObjectColours();
    gameBridge.setSelectedObjectColour(1, 20);
    expect(app.undo.depth, 'thirty-two picks and a reset on one ride: one entry').toBe(depth + 1);
    expect(game.world.version, 'never a world version bump').toBe(version);

    pressUndo();
    expect(allColours(game)).toEqual(before);
    expect(game.world.objectColours(swings), 'the other ride keeps its own entry and record').toEqual([3, null, 11]);
    expect(game.world.objectColours(ride)).toBeNull();
    expect(app.undo.depth).toBe(depth);
    pressUndo();
    expect(game.world.objectColours(swings)).toBeNull();
    expect(app.undo.depth).toBe(depth - 1);
    game.destroy();
  });

  it('undo of a demolished recoloured ride brings it back with its colours, on the same id', async () => {
    const { game, app, ride, anchor } = await park();
    gameBridge.setSelectedObjectColour(0, 19);
    gameBridge.setSelectedObjectColour(2, 4);
    useUiStore.getState().selectBulldozer();
    inputHandlers!.start(anchor);
    inputHandlers!.end(anchor);
    expect(game.world.objects.has(ride)).toBe(false);
    expect(app.undo.newest?.kind).toBe('demolition');
    pressUndo();
    expect(game.world.objectColours(ride)).toEqual([19, null, 4]);
    // And the recolour entry below it still takes the colours back.
    pressUndo();
    expect(game.world.objectColours(ride)).toBeNull();
    game.destroy();
  });

  it('a pick after the ride was demolished and rebuilt does not join the old ride\'s entry', async () => {
    const { game, app, anchor } = await park();
    gameBridge.setSelectedObjectColour(0, 19);
    const depth = app.undo.depth;
    useUiStore.getState().selectBulldozer();
    inputHandlers!.start(anchor);
    inputHandlers!.end(anchor);
    useUiStore.getState().selectBuild('moonpetal-carousel');
    inputHandlers!.end(anchor);
    const rebuilt = [...game.world.objects.values()].find((object) => object.definitionId === 'moonpetal-carousel')!;
    expect(game.world.objectColours(rebuilt.id), 'a rebuilt ride starts at defaults').toBeNull();
    selectRide(rebuilt.anchor);
    gameBridge.setSelectedObjectColour(1, 7);
    expect(app.undo.depth).toBe(depth + 3);
    expect(app.undo.newest?.kind).toBe('recolour');
    game.destroy();
  });

  it('a pick whose undo capture failed records nothing, and the next pick on that ride opens its own entry instead of joining another ride\'s', async () => {
    const { game, app, ride, swings, anchor, swingsAnchor } = await park();
    selectRide(swingsAnchor);
    gameBridge.setSelectedObjectColour(0, 3);
    const swingsEntry = app.undo.newest;
    expect(swingsEntry?.kind).toBe('recolour');
    selectRide(anchor);
    const spy = vi.spyOn(game as unknown as { capturePark(): unknown }, 'capturePark').mockImplementationOnce(() => {
      throw new Error('capture failed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    gameBridge.setSelectedObjectColour(0, 19);
    expect(spy).toHaveBeenCalled();
    expect(game.world.objectColours(ride), 'undo never vetoes the edit it guards').toEqual([19, null, null]);
    expect(app.undo.newest, 'no entry for the failed capture').toBe(swingsEntry);

    gameBridge.setSelectedObjectColour(1, 5);
    expect(game.world.objectColours(ride)).toEqual([19, 5, null]);
    const depth = app.undo.depth;

    // One press takes back the carousel's own pick and must not touch the swings.
    pressUndo();
    const afterUndo = { carousel: game.world.objectColours(ride), swings: game.world.objectColours(swings) };
    expect(afterUndo, 'today the carousel pick JOINED the swings entry: one Undo resets both rides').toEqual({
      carousel: [19, null, null],
      swings: [3, null, null],
    });
    expect(depth, 'the second pick on the carousel is its own entry').toBe(2);
    game.destroy();
  });
});

describe('colours through the real save manager', () => {
  it('a manual save and a load into another park keep every record; the loaded park has an empty ring', async () => {
    const { game, app, ride, swings, swingsAnchor } = await park({ chosen: true });
    gameBridge.setSelectedObjectColour(0, 19);
    gameBridge.setSelectedObjectColour(2, 8);
    selectRide(swingsAnchor);
    gameBridge.setSelectedObjectColour(1, 1);
    const before = allColours(game);
    const saved = await saveBridge.saveToSlot('manual-1', 'Painted');
    expect(saved.ok).toBe(true);
    game.startScenario(null);
    await settle();
    expect(game.world.objects.has(ride)).toBe(false);
    const loaded = await saveBridge.load('manual-1');
    expect(loaded.ok).toBe(true);
    expect(allColours(game)).toEqual(before);
    expect(game.world.objectColours(swings)).toEqual([null, 1, null]);
    expect(app.undo.depth, 'a load starts a fresh timeline').toBe(0);
    game.destroy();
  });

  it('a recolour on a PAUSED park is enough to make the autosave (crash recovery) write it', async () => {
    const { game, ride } = await park({ chosen: true });
    game.clock.setSpeed(0);
    runFrames(START_AUTOSAVE_DELAY_SECONDS * 4 + 4, 1000);
    await settle();
    const store = stores.get(game)!;
    const first = (await store.list()).find((row) => row.id === 'autosave');
    expect(first, 'the built park autosaved').toBeDefined();
    const tick = game.world.tick;

    gameBridge.setSelectedObjectColour(0, 17);
    // The park is paused: only the colour makes it dirty.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    (document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    for (const handler of handlers.get('visibilitychange') ?? []) handler({});
    await settle();
    expect(game.world.tick, 'nothing advanced').toBe(tick);
    const second = (await store.list()).find((row) => row.id === 'autosave');
    expect(second?.revision, 'the hidden-tab flush wrote the recoloured park').toBeGreaterThan(first!.revision);

    game.startScenario(null);
    await settle();
    const loaded = await saveBridge.load('autosave');
    expect(loaded.ok).toBe(true);
    expect(game.world.objectColours(ride), 'crash recovery keeps colours').toEqual([17, null, null]);
    game.destroy();
  });

  it('the unsaved-changes flag sees a recolour made after a save', async () => {
    const { game } = await park({ chosen: true });
    gameBridge.setSelectedObjectColour(0, 19);
    expect((await saveBridge.saveToSlot('manual-2', 'A')).ok).toBe(true);
    const saves = (game as unknown as { saves: { hasUnsavedEdits(): boolean; snapshot(): { unsavedChanges: boolean } } }).saves;
    expect(saves.hasUnsavedEdits(), 'saved').toBe(false);
    gameBridge.setSelectedObjectColour(0, 18);
    expect(saves.hasUnsavedEdits(), 'a recolour after the save is an unsaved edit').toBe(true);
    game.destroy();
  });
});

describe('the simulation never sees colours, through the real app', () => {
  /** Owners and world (colours stripped) of the live session: what a guest, the ledger or a rating can observe. */
  const observable = (game: unknown): string => {
    const session = internals(game).session;
    session.syncWithWorld();
    const state = structuredClone(session.serialize());
    for (const object of state.world.objects) delete object.colours;
    return hashState(state);
  };

  const run = async (paint: boolean): Promise<{ trace: string[]; riders: number; painted: number }> => {
    const { game, anchor, swingsAnchor } = await park();
    for (let y = 30; y >= 8; y -= 1) game.world.buildPaths([{ x: 15, y }]);
    for (let x = 16; x <= 19; x += 1) { game.world.buildPaths([{ x, y: 12 }]); game.world.buildPaths([{ x, y: 18 }]); }
    game.spawnGuests();
    game.clock.setSpeed(4);
    const trace: string[] = [];
    let riders = 0;
    let painted = 0;
    for (let frame = 0; frame < 240; frame += 1) {
      if (paint) {
        // Every frame: alternate rides through the inspector, every slot, every swatch, some resets,
        // and now and then a cosmetic Undo.
        selectRide(frame % 2 === 0 ? anchor : swingsAnchor);
        if (frame % 11 === 5) gameBridge.resetSelectedObjectColours();
        else gameBridge.setSelectedObjectColour(frame % 3, (frame * 7) % 21);
        if (frame % 17 === 9 && useUiStore.getState().undoStatus.kind === 'recolour') pressUndo();
        painted += 1;
      }
      runFrames(1, 250);
      for (const ride of game.rides.rides.values()) riders = Math.max(riders, ride.riderGuestIds.length);
      if (frame % 20 === 19) trace.push(`${game.world.tick}:${observable(game)}`);
    }
    game.destroy();
    return { trace, riders, painted };
  };

  it('240 frames at speed 4 with a pick, reset or cosmetic undo every frame match a run with none', async () => {
    const plain = await run(false);
    const painted = await run(true);
    expect(painted.painted).toBe(240);
    expect(plain.riders, 'guests were riding').toBeGreaterThan(0);
    expect(painted.trace).toEqual(plain.trace);
  }, 120_000);
});
