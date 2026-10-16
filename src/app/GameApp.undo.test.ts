import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GameApp's side of snapshot undo, in the lifecycle test's style: fake renderer, stubbed window,
 * real manager over a memory store. Gestures are driven through the input handlers the renderer
 * was given, exactly as pointer events reach the game. What is pinned is what only GameApp owns:
 * WHEN the snapshot is taken (immediately before the first mutation, outside any batch), what an
 * undo keeps and resets, the keyboard routing, and the clearing rules.
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
const { UNDO_FAILED_MESSAGE, UNDO_SCENARIO_ENDED_MESSAGE } = await import('./undo/constants');

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

describe('capture policy', () => {
  it('snapshots immediately before the first mutation of each gesture kind, outside any batch', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    game.world.buildObject('moonpetal-carousel', { x: 20, y: 10 });
    const calls: Array<{ kind: string; version: number; inBatch: boolean }> = [];
    let batchDepth = 0;
    const realBatch = game.world.batch.bind(game.world);
    vi.spyOn(game.world, 'batch').mockImplementation((run) => {
      batchDepth += 1;
      try { return realBatch(run); } finally { batchDepth -= 1; }
    });
    const realBegin = app.undo.begin.bind(app.undo);
    vi.spyOn(app.undo, 'begin').mockImplementation((kind) => {
      calls.push({ kind, version: game.world.version, inBatch: batchDepth > 0 });
      return realBegin(kind);
    });

    // A path drag: nothing touches the world until pointer-up.
    useUiStore.getState().selectBuild('sunstone-path');
    const versionBeforePath = game.world.version;
    inputHandlers!.start({ x: 15, y: 30 });
    inputHandlers!.move({ x: 15, y: 28 });
    expect(calls, 'a drag in progress captures nothing').toEqual([]);
    inputHandlers!.end({ x: 15, y: 28 });
    // An object placement.
    placeBench(5);
    // A coaster is covered by its own test; a bulldozer drag over the bench.
    useUiStore.getState().selectBulldozer();
    const versionBeforeBulldoze = game.world.version;
    inputHandlers!.start({ x: 5, y: 4 });
    inputHandlers!.end({ x: 5, y: 4 });

    expect(calls.map((call) => call.kind)).toEqual(['paths', 'object', 'demolition']);
    expect(calls[0].version, 'path snapshot is before buildPaths').toBe(versionBeforePath);
    expect(calls[2].version, 'demolition snapshot is before the bulldozer').toBeGreaterThanOrEqual(versionBeforeBulldoze);
    expect(calls.every((call) => !call.inBatch), 'serialize throws inside world.batch, so begin never runs there').toBe(true);
    expect(app.undo.depth).toBe(3);
    game.destroy();
  });

  it('a click that builds nothing leaves no entry and takes no snapshot when refused up front', async () => {
    const game = await makeGame();
    const app = internals(game);
    const begin = vi.spyOn(app.undo, 'begin');
    useUiStore.getState().selectBuild('ribbon-bench');
    inputHandlers!.end({ x: 500, y: 500 });
    useUiStore.getState().selectBulldozer();
    inputHandlers!.start({ x: 3, y: 3 });
    inputHandlers!.end({ x: 3, y: 3 });
    expect(begin, 'no capture for a refused placement or a bulldozer over empty grass').not.toHaveBeenCalled();
    expect(app.undo.depth).toBe(0);
    game.destroy();
  });

  it('a bulldozer drag over several things is one entry, committed at pointer-up', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    for (const x of [4, 5, 6]) placeBench(x);
    expect(app.undo.depth).toBe(3);
    useUiStore.getState().selectBulldozer();
    inputHandlers!.start({ x: 4, y: 4 });
    inputHandlers!.move({ x: 5, y: 4 });
    inputHandlers!.move({ x: 6, y: 4 });
    expect(app.undo.hasPending, 'the drag is still pending').toBe(true);
    expect(app.undo.depth, 'not committed mid-drag').toBe(3);
    inputHandlers!.end({ x: 6, y: 4 });
    expect(app.undo.depth, 'one entry for the whole drag').toBe(4);
    expect(app.undo.newest).toMatchObject({ kind: 'demolition', label: '3 things demolished' });
    game.destroy();
  });

  it('a coaster build snapshots right before placeCoaster; an invalid layout takes no snapshot', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(1_000_000);
    useUiStore.getState().selectBuild('star-chaser');
    // A straight three-piece layout is not a valid coaster: refused before any snapshot.
    for (const x of [4, 5, 6]) inputHandlers!.start({ x, y: 10 });
    expect(app.coasterDraft.length).toBeGreaterThan(0);
    game.coasterBuild();
    expect(app.undo.depth).toBe(0);
    expect(app.undo.hasPending).toBe(false);

    // A closed loop with a flat station, one hill and one drop, as the renderer tests use.
    const ring: Array<{ x: number; y: number }> = [];
    for (let x = 0; x < 6; x += 1) ring.push({ x: 10 + x, y: 10 });
    for (let y = 1; y < 4; y += 1) ring.push({ x: 15, y: 10 + y });
    for (let x = 4; x >= 0; x -= 1) ring.push({ x: 10 + x, y: 13 });
    for (let y = 2; y >= 1; y -= 1) ring.push({ x: 10, y: 10 + y });
    const descentStart = ring.length - 3;
    app.coasterDraft = ring.map((cell, index) => ({
      cell,
      height: index < 3 ? 0 : index < descentStart ? Math.min(2, index - 2) : Math.max(0, ring.length - 1 - index),
    }));
    const versionBefore = game.world.version;
    const realBegin = app.undo.begin.bind(app.undo);
    let versionAtBegin = -1;
    vi.spyOn(app.undo, 'begin').mockImplementation((kind) => {
      versionAtBegin = game.world.version;
      expect(kind).toBe('coaster');
      realBegin(kind);
    });
    game.coasterBuild();
    expect(game.world.coasters.size, 'the layout really built').toBe(1);
    expect(versionAtBegin, 'begin ran before the world was touched').toBe(versionBefore);
    expect(app.undo.newest).toMatchObject({ kind: 'coaster', label: 'Star Chaser built' });
    game.destroy();
  });
});

describe('undo restores the park', () => {
  it('rewinds a build to the exact pre-gesture state hash and keeps tool, speed and rotation', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    runFrames(8);
    useUiStore.getState().selectBuild('ribbon-bench');
    const hashBefore = hashOf(game);
    const timeBefore = game.clock.simulationTimeMs;
    inputHandlers!.end({ x: 7, y: 4 });
    runFrames(20);
    expect(game.world.objects.size).toBe(1);
    game.setSpeed(2);

    const sessionBefore = app.session;
    pressUndo();
    expect(app.session, 'a fresh session, not an in-place restore').not.toBe(sessionBefore);
    expect(hashOf(game), 'the park is exactly as it was before the gesture').toBe(hashBefore);
    expect(game.clock.simulationTimeMs).toBe(timeBefore);
    expect(game.clock.speed, 'undo does not pause or change speed').toBe(2);
    expect(useUiStore.getState().tool).toBe('build');
    expect(useUiStore.getState().selectedDefinitionId, 'the player still holds the bench').toBe('ribbon-bench');
    expect(toast()).toMatch(/^Undid Ribbon Bench built · rewound \d+ s$/);
    expect(app.undo.depth).toBe(0);
    game.destroy();
  });

  it('keeps the player\'s First Day skip and dismissal across an undo that predates them', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    runFrames(8);
    useUiStore.getState().selectBuild('ribbon-bench');
    inputHandlers!.end({ x: 7, y: 4 });
    runFrames(20);
    app.session.onboarding!.skipStep('first-drink');
    app.session.onboarding!.dismissAll();

    const sessionBefore = app.session;
    pressUndo();
    expect(app.session).not.toBe(sessionBefore);
    const snapshot = app.session.onboardingSnapshot()!;
    expect(snapshot.dismissed, 'the hints stay off').toBe(true);
    expect(snapshot.steps.find((step) => step.id === 'first-drink')!.status).toBe('skipped');
    game.destroy();
  });

  it('rewinds the calendar with the park but keeps the day length and fixed time the player chose', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    runFrames(8);
    const tickAtGesture = game.world.tick;
    const positionAtGesture = app.session.calendar.positionUnits();
    useUiStore.getState().selectBuild('ribbon-bench');
    inputHandlers!.end({ x: 7, y: 4 });
    runFrames(60);
    expect(game.world.tick).toBeGreaterThan(tickAtGesture);
    gameBridge.setDayLength(60);
    gameBridge.setTimeLock('night');
    runFrames(30);
    expect(app.session.calendar.serialize().dayLengthSeconds).toBe(60);

    pressUndo();
    const calendar = app.session.calendar;
    expect(game.world.tick, 'the world is rewound').toBe(tickAtGesture);
    expect(calendar.positionUnits(), 'the clock position is the snapshot\'s').toBe(positionAtGesture);
    expect(calendar.serialize().anchorTick, 'consistent with the rewound tick').toBeLessThanOrEqual(game.world.tick);
    expect([calendar.dayLengthSeconds, calendar.timeLock], 'the player\'s choices survive').toEqual([60, 'night']);
    runFrames(8);
    // 60 s days from here on: 600 ticks per day, continuous from the rewound position.
    const advanced = calendar.positionUnits() - positionAtGesture;
    expect(advanced).toBeGreaterThan(0);
    expect(advanced).toBeCloseTo((game.world.tick - tickAtGesture) * 1_000_000 / 600, -1);
    expect(useUiStore.getState().timeLock).toBe('night');
    game.destroy();
  });

  it('rewinds the drawn weather with the park but keeps the weather and opening hours the player chose', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    runFrames(8);
    const weatherThen = JSON.stringify(app.session.weather.serialize().days);
    useUiStore.getState().selectBuild('ribbon-bench');
    inputHandlers!.end({ x: 7, y: 4 });
    runFrames(60);
    gameBridge.setWeatherSeverity('high');
    gameBridge.setOpeningHours(true, 6, 23);
    gameBridge.setDayLength(60);
    app.session.weather.forceCurrentSlot('storm', 1);
    runFrames(20);
    expect(JSON.stringify(app.session.weather.serialize().days), 'the sky changed since').not.toBe(weatherThen);

    pressUndo();
    expect(JSON.stringify(app.session.weather.serialize().days), 'the forecast the player saw is back').toBe(weatherThen);
    expect(app.session.weather.severity).toBe('high');
    expect(app.session.calendar).toMatchObject({ hoursEnabled: true, openHour: 6, closeHour: 23, dayLengthSeconds: 60 });
    expect(useUiStore.getState().weatherUi).toMatchObject({ weatherSeverity: 'high', hoursEnabled: true, openHour: 6, closeHour: 23 });
    game.destroy();
  });

  it('weather and hours settings are unsaved changes, unchanged ones are not, and a scenario park refuses them', async () => {
    const game = await makeGame();
    const host = (game as unknown as { saveHost: { worldVersion(): number } }).saveHost;
    const token = host.worldVersion();
    gameBridge.setWeatherEnabled(true);
    gameBridge.setWeatherSeverity('normal');
    gameBridge.setOpeningHours(false, 8, 21);
    expect(host.worldVersion(), 'same values change nothing').toBe(token);
    gameBridge.setWeatherSeverity('low');
    const afterSeverity = host.worldVersion();
    expect(afterSeverity).not.toBe(token);
    gameBridge.setWeatherEnabled(false);
    expect(host.worldVersion()).not.toBe(afterSeverity);
    expect(useUiStore.getState().weatherUi).toMatchObject({ weatherEnabled: false, weatherSeverity: 'low', forecastText: [] });
    gameBridge.setOpeningHours(true, 8, 21);
    expect(useUiStore.getState().weatherUi).toMatchObject({ hoursEnabled: true, openHour: 8, closeHour: 21, scheduleOpen: false });
    expect(internals(game).undo.depth, 'no undo snapshot for a setting').toBe(0);
    gameBridge.startScenario('sunny-start', []);
    await settle();
    const scenarioToken = host.worldVersion();
    gameBridge.setWeatherEnabled(false);
    gameBridge.setWeatherSeverity('high');
    gameBridge.setOpeningHours(true, 8, 21);
    expect(host.worldVersion(), 'a scenario park refuses every switch').toBe(scenarioToken);
    expect(useUiStore.getState().weatherUi).toMatchObject({ weatherEnabled: true, weatherEditable: false, weatherSeverity: 'normal', hoursEnabled: false });
    game.destroy();
  });

  it('hands the renderer the weather every frame and publishes the chip data only when it changes', async () => {
    const game = await makeGame();
    weatherViews.length = 0;
    runFrames(4, 40);
    expect(weatherViews).toHaveLength(4);
    expect(weatherViews.every((view) => view.kind === 'sunny' && view.day === 1)).toBe(true);
    const published = useUiStore.getState().weatherUi;
    runFrames(8, 250);
    expect(useUiStore.getState().weatherUi, 'a steady sky keeps the same object in the store').toBe(published);
    internals(game).session.weather.forceCurrentSlot('rain', 0.5);
    runFrames(2, 250);
    expect(useUiStore.getState().weatherUi).toMatchObject({ weatherKind: 'rain', weatherIntensityPercent: 50 });
    expect(weatherViews[weatherViews.length - 1]).toMatchObject({ kind: 'rain', intensity: 0.5 });
    game.destroy();
  });

  it('an undo with no setting change leaves the calendar exactly as the snapshot had it', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    runFrames(8);
    const before = app.session.calendar.serialize();
    useUiStore.getState().selectBuild('ribbon-bench');
    inputHandlers!.end({ x: 7, y: 4 });
    runFrames(40);
    pressUndo();
    expect(app.session.calendar.serialize()).toEqual(before);
    game.destroy();
  });

  it('hands the renderer the effective time of day every frame, smoothed between steps and frozen while paused', async () => {
    const game = await makeGame();
    phases.length = 0;
    runFrames(4, 40);
    expect(phases.length).toBe(4);
    expect(phases.every((phase) => phase >= 0 && phase < 1)).toBe(true);
    expect(phases[3], 'the clock advances inside a step, not only on steps').toBeGreaterThan(phases[0]);
    gameBridge.setSpeed(0);
    phases.length = 0;
    runFrames(5, 100);
    expect(new Set(phases).size, 'paused: a still sky').toBe(1);
    gameBridge.setSpeed(1);
    gameBridge.setTimeLock('night');
    phases.length = 0;
    runFrames(3, 100);
    expect(phases, 'a fixed time pins the look (midnight)').toEqual([0, 0, 0]);
    game.destroy();
  });

  it('a calendar setting is an unsaved change, an unchanged one is not, and the undo ring does not see it as a world edit', async () => {
    const game = await makeGame();
    const host = (game as unknown as { saveHost: { worldVersion(): number } }).saveHost;
    const app = internals(game);
    const token = host.worldVersion();
    gameBridge.setDayLength(720);
    gameBridge.setTimeLock('auto');
    expect(host.worldVersion(), 'same values change nothing').toBe(token);
    gameBridge.setDayLength(1440);
    expect(host.worldVersion(), 'a real change moves the version the save manager compares').not.toBe(token);
    const afterLength = host.worldVersion();
    gameBridge.setTimeLock('dusk');
    expect(host.worldVersion()).not.toBe(afterLength);
    expect(app.undo.depth, 'no undo snapshot for a setting').toBe(0);
    expect(useUiStore.getState()).toMatchObject({ dayLengthSeconds: 1440, timeLock: 'dusk', phaseLabel: 'Dawn', clockText: '06:00', calendarEditable: true });
    game.destroy();
  });

  it('a mis-demolished ride comes back with ticket price, closed intent and revenue', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    for (let index = 0; index < 6; index += 1) game.world.buildPaths([{ x: 15, y: 30 - index }]);
    const ride = game.world.buildObject('moonpetal-carousel', { x: 16, y: 26 })!;
    game.rides.setTicketPrice(ride.id, 8);
    game.rides.setOpen(ride.id, false);
    game.rides.getRide(ride.id)!.lifetimeRevenue = 321;
    runFrames(20);
    const runtime = structuredClone(game.rides.getRide(ride.id)!);
    const hashBefore = hashOf(game);

    useUiStore.getState().selectBulldozer();
    inputHandlers!.start(ride.anchor);
    inputHandlers!.end(ride.anchor);
    expect(game.rides.getRide(ride.id), 'the ride is gone').toBeUndefined();
    expect(app.undo.newest?.label).toBe('Moonpetal Carousel demolished');

    pressUndo();
    expect(game.rides.getRide(ride.id), 'back with every runtime field').toEqual(runtime);
    expect(game.rides.getRide(ride.id)).toMatchObject({ ticketPrice: 8, open: false, lifetimeRevenue: 321 });
    expect(hashOf(game)).toBe(hashBefore);
    expect(useUiStore.getState().tool, 'the bulldozer is still armed').toBe('bulldoze');
    game.destroy();
  });

  it('resets selection, drafts and the clock accumulator, and re-runs the hover', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    const ride = game.world.buildObject('moonpetal-carousel', { x: 16, y: 26 })!;
    placeBench(7);
    useUiStore.getState().selectPointer();
    inputHandlers!.start(ride.anchor);
    expect(app.selectedRideId, 'the ride is selected').toBe(ride.id);
    useUiStore.getState().selectBuild('ribbon-bench');
    hovered = { x: 9, y: 9 };
    frameCallback?.(120);
    log.length = 0;

    pressUndo();
    expect(app.selectedRideId, 'selection belongs to the old world').toBeNull();
    expect(game.clock.stepFraction, 'no catch-up burst after the swap').toBe(0);
    expect(log, 'the inspector closes, the renderer swaps, then the ghost is redrawn for the rewound world')
      .toEqual(['selectObject', 'setSession', 'drawPreview']);
    game.destroy();
  });

  it('keeps older entries after an undo, and the undo after a load starts from an empty ring', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    placeBench(5);
    pressUndo();
    expect(app.undo.depth, 'the older gesture is still there').toBe(1);
    // A new park clears: a different park's snapshots must not be reachable.
    game.startScenario(null);
    expect(app.undo.depth).toBe(0);
    expect(useUiStore.getState().undoStatus).toMatchObject({ canUndo: false, reason: 'empty' });
    game.destroy();
  });

  it('a chain of ten presses walks back through every gesture', async () => {
    const game = await makeGame();
    game.world.addMoney(1_000_000);
    const hashes: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      hashes.push(hashOf(game));
      placeBench(4 + index);
      runFrames(8);
    }
    for (let index = 9; index >= 0; index -= 1) {
      pressUndo();
      expect(hashOf(game), `depth ${index}`).toBe(hashes[index]);
    }
    pressUndo();
    expect(toast()).toBe('Nothing to undo yet');
    game.destroy();
  });

  it('after a load the ring is empty, and a gesture after the load can be undone', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    const saved = await (await import('./gameBridge')).saveBridge.saveToSlot('manual-1', 'Before');
    expect(saved.ok).toBe(true);
    const loaded = await (await import('./gameBridge')).saveBridge.load('manual-1');
    expect(loaded.ok).toBe(true);
    expect(app.undo.depth, 'the ring does not carry over a load').toBe(0);
    const hashBefore = hashOf(game);
    placeBench(5);
    pressUndo();
    expect(hashOf(game)).toBe(hashBefore);
    game.destroy();
  });
});

describe('keyboard and the dock command', () => {
  it('ignores auto-repeat so holding the key cannot run through the ring', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    placeBench(5);
    const held = pressUndo({ repeat: true });
    expect(held.prevented, 'the browser must still not undo its own way').toBe(true);
    expect(app.undo.depth, 'a repeat does nothing').toBe(2);
    pressUndo();
    expect(app.undo.depth, 'the first press counts').toBe(1);
    pressUndo({ repeat: true });
    pressUndo({ repeat: true });
    expect(app.undo.depth).toBe(1);
    game.destroy();
  });

  it('Ctrl+Shift+Z (redo elsewhere) does nothing and is swallowed, never a second rewind', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    const result = pressUndo({ shift: true });
    expect(result.prevented, 'the browser must not act on it either').toBe(true);
    expect(app.undo.depth, 'nothing was rewound').toBe(1);
    game.destroy();
  });

  it('Ctrl+Z mid path drag leaves a quiet release: no capture, no "cannot be built" toast', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    useUiStore.getState().selectBuild('sunstone-path');
    inputHandlers!.start({ x: 15, y: 30 });
    inputHandlers!.move({ x: 15, y: 28 });
    pressUndo();
    const afterUndo = toast();
    const begin = vi.spyOn(app.undo, 'begin');
    inputHandlers!.end({ x: 15, y: 28 });
    expect(begin, 'an emptied draft captures nothing').not.toHaveBeenCalled();
    expect(toast(), 'the undo toast is not replaced').toBe(afterUndo);
    game.destroy();
  });

  it('leaves Ctrl+Z to the browser in a text field', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    const result = pressUndo({ target: { tagName: 'INPUT', isContentEditable: false } });
    expect(result.prevented).toBe(false);
    expect(app.undo.depth).toBe(1);
    game.destroy();
  });

  it('the dock command and Ctrl+Z are the same route', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    gameBridge.requestUndo();
    expect(app.undo.depth).toBe(0);
    expect(toast()).toMatch(/^Undid Ribbon Bench built/);
    game.destroy();
  });

  it('a half-drawn coaster track steps back a piece before the ring', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    useUiStore.getState().selectBuild('star-chaser');
    inputHandlers!.start({ x: 10, y: 10 });
    inputHandlers!.move({ x: 12, y: 10 });
    expect(app.coasterDraft.length).toBe(3);
    expect(useUiStore.getState().undoStatus.label, 'the label says what Ctrl+Z will do').toBe('Undo track piece');
    pressUndo();
    expect(app.coasterDraft.length).toBe(2);
    expect(app.undo.depth, 'the ring was not touched').toBe(1);
    game.destroy();
  });

  it('Ctrl+Z mid bulldozer drag undoes the partial drag', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    for (const x of [4, 5, 6]) placeBench(x);
    const hashBefore = hashOf(game);
    useUiStore.getState().selectBulldozer();
    inputHandlers!.start({ x: 4, y: 4 });
    inputHandlers!.move({ x: 5, y: 4 });
    pressUndo();
    expect(hashOf(game)).toBe(hashBefore);
    expect(app.undo.hasPending).toBe(false);
    expect(app.undo.depth, 'the three benches are still undoable').toBe(3);
    game.destroy();
  });
});

describe('confirmation for a long rewind', () => {
  it('arms on the first press past a minute, rewinds on the second', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    game.setSpeed(4);
    runFrames(90, 1_000);
    expect(game.clock.simulationTimeMs).toBeGreaterThan(60_000);
    const hashAfter = hashOf(game);

    pressUndo();
    expect(toast()).toMatch(/This rewinds \d+ min \d+ s of the whole park\. Press Undo again to confirm\./);
    expect(hashOf(game), 'the first press changed nothing').toBe(hashAfter);
    expect(useUiStore.getState().undoStatus).toMatchObject({ armed: true });
    expect(useUiStore.getState().undoStatus.label).toMatch(/^Confirm rewind /);
    pressUndo();
    expect(app.undo.depth, 'an immediate second press (a double-click) does not confirm').toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000);
    pressUndo();
    vi.restoreAllMocks();
    expect(app.undo.depth).toBe(0);
    expect(toast()).toMatch(/^Undid Ribbon Bench built · rewound \d+ min/);
    game.destroy();
  });
});

describe('scenario results and clearing', () => {
  it('a scenario result clears the ring and keeps it shut, with the reason in the status', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    app.handleScenarioEvents([{ kind: 'scenarioFailed' }]);
    expect(app.undo.depth).toBe(0);
    expect(useUiStore.getState().undoStatus).toMatchObject({ canUndo: false, reason: 'scenario-ended', message: UNDO_SCENARIO_ENDED_MESSAGE });
    placeBench(5);
    expect(app.undo.depth, 'a gesture after the latch captures nothing').toBe(0);
    pressUndo();
    expect(toast()).toBe(UNDO_SCENARIO_ENDED_MESSAGE);
    // Restarting is a new park and reopens the ring.
    game.restartScenario();
    placeBench(5);
    expect(app.undo.depth).toBe(1);
    game.destroy();
  });

  it('startScenario and restart clear the ring', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    game.restartScenario();
    expect(app.undo.depth).toBe(0);
    game.destroy();
  });
});

describe('the swap path', () => {
  it('tells the save manager after a successful restore and not after a failed one', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    const rewound = vi.fn();
    app.saves.notifyParkRewound = rewound;
    placeBench(4);
    placeBench(5);
    pressUndo();
    expect(rewound).toHaveBeenCalledTimes(1);

    // fromState throws: nothing of the live park may be touched.
    const hashBefore = hashOf(game);
    const session = app.session;
    log.length = 0;
    vi.spyOn(ParkSession, 'fromState').mockImplementation(() => { throw new Error('corrupt entry'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pressUndo();
    expect(toast()).toBe(UNDO_FAILED_MESSAGE);
    expect(app.session, 'the live session object is untouched').toBe(session);
    expect(hashOf(game)).toBe(hashBefore);
    expect(log, 'the renderer was never given another session').toEqual([]);
    expect(rewound, 'no dirty flag for a restore that did not happen').toHaveBeenCalledTimes(1);
    expect(app.undo.depth, 'the failing entry was dropped').toBe(0);
    game.destroy();
  });

  it('puts the previous session back when the renderer refuses the swap', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    const session = app.session;
    const hashBefore = hashOf(game);
    const time = game.clock.simulationTimeMs;
    let refuse = true;
    vi.spyOn(FakeRenderer.prototype, 'setSession').mockImplementation(() => {
      if (refuse) { refuse = false; throw new Error('renderer refused the session'); }
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pressUndo();
    expect(toast()).toBe(UNDO_FAILED_MESSAGE);
    expect(app.session, 'rolled back to the live session').toBe(session);
    expect(hashOf(game)).toBe(hashBefore);
    expect(game.clock.simulationTimeMs, 'the clock was rolled back too').toBe(time);
    expect(app.swapping).toBe(false);
    game.destroy();
  });

  it('refuses an undo that arrives while a swap is in flight', async () => {
    const game = await makeGame();
    const app = internals(game);
    game.world.addMoney(100_000);
    placeBench(4);
    placeBench(5);
    let reentrant: string | null = null;
    vi.spyOn(FakeRenderer.prototype, 'setSession').mockImplementation(() => {
      gameBridge.requestUndo();
      reentrant = toast();
    });
    pressUndo();
    expect(reentrant, 'the nested press was refused, not run').toBe('Undo is unavailable while a park is loading');
    expect(app.undo.depth, 'only the outer undo ran').toBe(1);
    game.destroy();
  });
});
