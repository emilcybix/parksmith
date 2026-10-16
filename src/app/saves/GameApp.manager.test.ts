import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GameApp's save integration, in the lifecycle test's style: fake renderer, stubbed window, and
 * the store builder's MemorySaveStore behind the real manager, writer and bridge. What is pinned
 * here is the wiring only GameApp owns: the session swap, the tour node, autosave from the ticker,
 * Ctrl+S, and that a failed load leaves the live park alone.
 */

const log: string[] = [];
let frameCallback: ((deltaMs: number) => void) | null = null;
const sessions: unknown[] = [];
let failNextSetSession = false;

class FakeRenderer {
  hoveredCell = null;
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(callback: (deltaMs: number) => void): void { frameCallback = callback; }
  setSession(session: unknown): void {
    sessions.push(session);
    log.push('setSession');
    if (failNextSetSession) {
      failNextSetSession = false;
      throw new Error('renderer refused the session');
    }
  }
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(): void {}
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

vi.mock('../rendererFlag', () => ({
  RENDERER_KIND: 'classic', LIGHT_PRESET: 'day', LIGHT_OVERRIDE: null, TIME_OVERRIDE: null, ZOOM_OVERRIDE: null, ALLOW_SOFTWARE_GPU: false, VOXEL_GPU_MIN: false,
}));
vi.mock('../../rendering/WorldRenderer', () => ({ WorldRenderer: FakeRenderer }));

const { GameApp } = await import('../GameApp');
const { saveBridge } = await import('../gameBridge');
const { useUiStore } = await import('../../ui/store');
const { MemorySaveStore } = await import('./memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./SaveManager');
const { AUTOSAVE_INTERVAL_SECONDS, START_AUTOSAVE_DELAY_SECONDS } = await import('./constants');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const startNode = { scenarioId: 'sunny-start' as const };
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
  return { game, store };
};

/** Real frames through the ticker the renderer was given. */
const runFrames = (count: number, deltaMs = 1000): void => {
  for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs);
};

const internals = (game: unknown) => game as {
  session: { mode: string };
  handleScenarioEvents(events: Array<{ kind: string; scenarioId?: string; atSeconds?: number; evidence?: string }>): void;
};

beforeEach(() => {
  log.length = 0;
  sessions.length = 0;
  failNextSetSession = false;
  frameCallback = null;
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
  useUiStore.getState().closeSavesDialog();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GameApp save and load', () => {
  it('save then load into a different park restores world, tick, cash and clock, paused', async () => {
    const { game } = await makeGame();
    game.startScenario(startNode.scenarioId);
    game.world.addMoney(777);
    runFrames(4, 250);
    const cash = game.world.cash;
    const tick = game.world.tick;
    const time = game.clock.simulationTimeMs;
    expect(tick, 'the park actually advanced').toBeGreaterThan(0);
    const saved = await saveBridge.saveToSlot('manual-1', 'Opener');
    expect(saved.ok).toBe(true);

    game.startScenario(null);
    expect(game.world.tick, 'a different, fresh park').toBe(0);
    const sessionBefore = internals(game).session;
    const setSessionCalls = sessions.length;

    const loaded = await saveBridge.load('manual-1');
    expect(loaded.ok).toBe(true);
    expect(internals(game).session, 'a new session object').not.toBe(sessionBefore);
    expect(sessions.at(-1), 'the renderer was given the loaded session').toBe(internals(game).session);
    expect(sessions.length).toBe(setSessionCalls + 1);
    expect(game.world.cash).toBe(cash);
    expect(game.world.tick).toBe(tick);
    expect(game.clock.simulationTimeMs).toBe(time);
    expect(game.clock.speed, 'a loaded park starts paused').toBe(0);
    expect(useUiStore.getState().speed).toBe(0);
    const ui = useUiStore.getState();
    expect(ui.scenario?.scenarioId, 'UI snapshot refreshed before first paint').toBe(startNode.scenarioId);
    expect(ui.management, 'management section is populated').not.toBeNull();
    expect(ui.savesDialogOpen).toBe(false);
    game.destroy();
  });

  it('clearing a scenario loaded from a save still records the clear in the profile', async () => {
    const { game } = await makeGame();
    game.startScenario(startNode.scenarioId);
    await saveBridge.saveToSlot('manual-1', 'Opener');
    game.startScenario(null);
    await saveBridge.load('manual-1');
    internals(game).handleScenarioEvents([{ kind: 'scenarioSucceeded', scenarioId: 'sunny-start', atSeconds: 120, evidence: 'test' }]);
    expect(useUiStore.getState().profile?.clearedScenarioIds).toContain('sunny-start');
    game.destroy();
  });

  it('a corrupt record fails the load, flags the slot, and leaves the live session identical', async () => {
    const { game, store } = await makeGame();
    game.startScenario(startNode.scenarioId);
    await saveBridge.saveToSlot('manual-1', 'Opener');
    store.seedRaw('manual-1', undefined, { schemaVersion: 1, garbage: true });
    game.startScenario(null);
    game.world.addMoney(5);
    const session = internals(game).session;
    const cash = game.world.cash;
    const calls = sessions.length;
    const result = await saveBridge.load('manual-1');
    expect(result.ok).toBe(false);
    expect(internals(game).session, 'same session object').toBe(session);
    expect(game.world.cash).toBe(cash);
    expect(sessions.length, 'the renderer was not touched').toBe(calls);
    expect(game.clock.speed, 'speed untouched').toBe(1);
    const row = (await store.list()).find((slot) => slot.id === 'manual-1');
    expect(row?.status.state).toBe('unreadable');
    expect(await store.read('manual-1'), 'the raw record is still there').toBeDefined();
    game.destroy();
  });

  it('starting a scenario after a load works and the loaded park does not leak into it', async () => {
    const { game } = await makeGame();
    game.startScenario(startNode.scenarioId);
    game.world.addMoney(1000);
    await saveBridge.saveToSlot('manual-1', 'Opener');
    await saveBridge.load('manual-1');
    game.startScenario(null);
    expect(internals(game).session.mode).toBe('sandbox');
    expect(game.clock.speed).toBe(1);
    expect(game.world.tick).toBe(0);
    expect(useUiStore.getState().scenario).toBeNull();
    game.destroy();
  });

  it('Ctrl+S quick-saves in the world, always preventing the browser dialog, and never saves from a text field', async () => {
    const { game, store } = await makeGame();
    game.startScenario(null);
    const press = (target: unknown) => {
      const preventDefault = vi.fn();
      for (const handler of handlers.get('keydown') ?? []) handler({ key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target, preventDefault });
      return preventDefault;
    };
    expect(press({ tagName: 'INPUT' }), 'no Save Page dialog over a rename field either').toHaveBeenCalled();
    await settle();
    expect(await store.list(), 'a text field does not quick-save').toEqual([]);
    const prevented = press(null);
    expect(prevented, 'the Save Page dialog never opens over the game').toHaveBeenCalled();
    await settle();
    const rows = await store.list();
    expect(rows.map((row) => row.id)).toEqual(['manual-1']);
    expect(useUiStore.getState().toast ?? '', 'the save strip reports the result, not a duplicate toast').not.toContain('Saved to');
    game.destroy();
  });

  it('Ctrl+S behind a modal prevents the browser dialog, saves nothing and says why', async () => {
    const { game, store } = await makeGame();
    game.startScenario(null);
    useUiStore.getState().setToast(null);
    useUiStore.getState().openScenarioLoadout('sunny-start');
    const preventDefault = vi.fn();
    for (const handler of handlers.get('keydown') ?? []) handler({ key: 's', ctrlKey: true, altKey: false, shiftKey: false, target: null, preventDefault });
    await settle();
    expect(preventDefault).toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
    expect(useUiStore.getState().toast).toContain('autosaved');
    game.destroy();
  });

  it('a load whose install throws puts the previous session and renderer session back', async () => {
    const { game } = await makeGame();
    game.startScenario(startNode.scenarioId);
    await saveBridge.saveToSlot('manual-1', 'Opener');
    game.startScenario(null);
    const session = internals(game).session;
    const shown = sessions.length;
    failNextSetSession = true;
    const result = await saveBridge.load('manual-1');
    expect(result.ok, 'the install failure is a failed load').toBe(false);
    expect(internals(game).session, 'the live session object is back').toBe(session);
    expect(sessions.at(-1), 'the renderer shows the live session again').toBe(session);
    expect(sessions.length).toBe(shown + 2);
    expect(() => game.world.addMoney(1), 'the world is still editable and its listener attached').not.toThrow();
    game.destroy();
  });

  it('a tour node id in a save (the retired Park Tour) is ignored on load, and the next save writes null', async () => {
    const { game, store } = await makeGame();
    game.startScenario(startNode.scenarioId);
    await saveBridge.saveToSlot('manual-1', 'Opener');
    const meta = (await store.list())[0];
    const record = await store.read('manual-1');
    const payload = structuredClone(record.payload) as { app: { tourNodeId: string | null } };
    payload.app.tourNodeId = 'opener';
    await store.write('manual-1', payload, meta, {});
    game.startScenario(null);
    const result = await saveBridge.load('manual-1');
    expect(result.ok).toBe(true);
    await saveBridge.saveToSlot('manual-2', 'Again');
    const written = (await store.read('manual-2')).payload as { app: { tourNodeId: string | null } };
    expect(written.app.tourNodeId, 'the retired tour node is never written again').toBeNull();
    game.destroy();
  });

  it('a load resets the clock accumulator so the first frame does not replay banked time', async () => {
    const { game } = await makeGame();
    game.startScenario(null);
    await saveBridge.saveToSlot('manual-1', 'One');
    const reset = vi.spyOn(game.clock, 'resetAccumulator');
    await saveBridge.load('manual-1');
    expect(reset).toHaveBeenCalledTimes(1);
    game.destroy();
  });

  it('Escape closes the Save/Load dialog layer', async () => {
    const { game } = await makeGame();
    useUiStore.getState().openSavesDialog();
    for (const handler of handlers.get('keydown') ?? []) handler({ key: 'Escape', ctrlKey: false, altKey: false, target: null, preventDefault: () => undefined });
    expect(useUiStore.getState().savesDialogOpen).toBe(false);
    game.destroy();
  });
});

describe('GameApp autosave', () => {
  it('never autosaves the untouched default sandbox the app opens on', async () => {
    const { game, store } = await makeGame();
    runFrames(START_AUTOSAVE_DELAY_SECONDS * 4);
    await settle();
    expect(await store.list(), 'opening the game must not overwrite yesterday\'s autosave').toEqual([]);
    game.destroy();
  });

  it('autosaves a started park from the ticker once dirty time passes the start delay', async () => {
    const { game, store } = await makeGame();
    game.startScenario(null);
    await settle(); // the park-start rescan holds the autosave until it has looked at the other tabs
    runFrames(START_AUTOSAVE_DELAY_SECONDS + 1);
    await settle();
    const rows = await store.list();
    expect(rows.map((row) => row.id)).toEqual(['autosave']);
    expect(rows[0].savedAtTick).toBeGreaterThan(0);
    // The stored park is loadable: serialize happened at a synced step boundary.
    const result = await saveBridge.load('autosave');
    expect(result.ok, 'an autosave taken mid-run loads').toBe(true);
    game.destroy();
  });

  it('a scenario result saves at the next frame, and a hidden tab flushes a dirty park', async () => {
    const { game, store } = await makeGame();
    game.startScenario(startNode.scenarioId);
    internals(game).handleScenarioEvents([{ kind: 'scenarioFailed' }]);
    expect((await store.list()), 'nothing is captured inside the step').toEqual([]);
    runFrames(1);
    await settle();
    expect((await store.list()).map((row) => row.id)).toEqual(['autosave']);
    // Hidden flush needs dirtiness and the gap; run the clock forward past the gap with the real time stubbed.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    game.world.addMoney(1);
    (document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    for (const handler of handlers.get('visibilitychange') ?? []) handler({});
    await settle();
    const row = (await store.list()).find((slot) => slot.id === 'autosave');
    expect(row?.revision, 'the hide wrote a second revision').toBe(2);
    game.destroy();
  });

  it('two hide events inside the minimum gap save once', async () => {
    const { game, store } = await makeGame();
    game.startScenario(null);
    await settle();
    runFrames(START_AUTOSAVE_DELAY_SECONDS + 1);
    await settle();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
    (document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    game.world.addMoney(1);
    for (const handler of handlers.get('visibilitychange') ?? []) handler({});
    await settle();
    game.world.addMoney(1);
    for (const handler of handlers.get('visibilitychange') ?? []) handler({});
    await settle();
    expect((await store.list()).find((slot) => slot.id === 'autosave')?.revision, 'first autosave plus one flush, not two').toBe(2);
    game.destroy();
  });

  it('autosave failure never stops the session: quota shows the banner state and the ticker keeps running', async () => {
    const store = new MemorySaveStore();
    const original = store.write.bind(store);
    store.write = async () => { const { StoreError } = await import('./types'); throw new StoreError('quota', 'full'); };
    const { game } = await makeGame(store);
    game.startScenario(null);
    await settle(); // the park-start rescan holds the autosave until it has looked at the other tabs
    runFrames(START_AUTOSAVE_DELAY_SECONDS + 1);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 200)); // the snapshot publish is throttled
    expect(useUiStore.getState().saves.persistence.state).toBe('unavailable');
    const tick = game.world.tick;
    runFrames(AUTOSAVE_INTERVAL_SECONDS);
    expect(game.world.tick, 'the simulation kept running').toBeGreaterThan(tick);
    store.write = original;
    await saveBridge.retryPersistence();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(useUiStore.getState().saves.persistence.state).toBe('ready');
    game.destroy();
  });

  it('destroy unregisters the commands and listeners', async () => {
    const { game } = await makeGame();
    game.destroy();
    const result = await saveBridge.saveToSlot('manual-1');
    expect(result.ok ? null : result.error.code, 'commands are gone after destroy').toBe('not-ready');
  });
});
