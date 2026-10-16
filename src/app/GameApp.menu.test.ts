import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryDetection, RecoveryMonitor, RecoveryParkInfo } from './saves/recoveryTypes';

/**
 * The start screen, the camera sweep and the pause menu as GameApp wires them (Phase 18 step 2), in
 * the manager and recovery tests' style: a fake renderer that records what the app asks of it, a
 * stubbed window, the real SaveManager over a MemorySaveStore and a fake recovery monitor. What is
 * pinned: the park behind the start screen is paused, read-only and invisible to saves, undo and
 * recovery; Continue starts exactly the parked state; New park, Load and Quit to menu hand over
 * cleanly; Escape opens and closes the pause menu without disturbing any older Escape behaviour.
 */

let frameCallback: ((deltaMs: number) => void) | null = null;
let inputHandlers: {
  hover(cell: unknown): void; start(cell: unknown): void; move(cell: unknown): void; end(cell: unknown): void; cancel(): void;
} | null = null;
const centres: Array<[number, number]> = [];
let focusEntranceCalls = 0;
const viewEnabled: boolean[] = [];

class FakeRenderer {
  hoveredCell = null;
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(callback: (deltaMs: number) => void): void { frameCallback = callback; }
  setSession(): void {}
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(): void {}
  setInputHandlers(handlers: typeof inputHandlers): void { inputHandlers = handlers; }
  setViewInputEnabled(enabled: boolean): void { viewEnabled.push(enabled); }
  setToolCursor(): void {}
  focusCell(): void {}
  focusEntrance(): void { focusEntranceCalls += 1; }
  setCameraCentre(x: number, y: number): void { centres.push([x, y]); }
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
const { saveBridge, recoveryBridge } = await import('./gameBridge');
const { useUiStore, NO_MENU_PREVIEW } = await import('../ui/store');
const { activeInputContext } = await import('../ui/inputContext');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');
const { START_AUTOSAVE_DELAY_SECONDS } = await import('./saves/constants');
const { RECOVERY_MONITOR_HOLDER_KEY } = await import('./saves/recoveryMonitor');
const { hashState } = await import('../game/save/hash');
const { updateSettings, resetSettings } = await import('../settings');
const { ParkSession } = await import('../game/session/ParkSession');
const { createParkSave } = await import('../game/save/version');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();
let windowStub: Record<string, unknown>;
const host = {} as HTMLElement;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** The preview read imports the load module lazily, which can take longer than a fixed number of ticks. */
const untilPreviewReady = async (): Promise<void> => {
  for (let i = 0; i < 400 && useUiStore.getState().menuPreview.phase !== 'ready'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

interface FakeMonitor extends RecoveryMonitor {
  started: RecoveryParkInfo[];
  forgotten: string[][];
  cleaned: number;
  detection: RecoveryDetection;
}
const fakeMonitor = (sessionId: string): FakeMonitor => ({
  sessionId,
  mode: 'web-locks',
  started: [],
  forgotten: [],
  cleaned: 0,
  detection: { kind: 'clean' },
  start(park) { this.started.push(park); return Promise.resolve(); },
  heartbeat: () => undefined,
  markClean() { this.cleaned += 1; },
  detectInterrupted() { return Promise.resolve(this.detection); },
  forget(ids) { this.forgotten.push([...ids]); },
  dispose: () => undefined,
});

const memoryStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
};
/** A profile that has been seen before, so these tests are not a first run (no menu skip). */
const knownProfile = () => memoryStorage({
  'parksmith-profile': JSON.stringify({ version: 1, discoveredCardIds: [], tour: {}, ui: { mapSeen: true, tourOffered: true } }),
});

type Store = InstanceType<typeof MemorySaveStore>;
type Game = InstanceType<typeof GameApp>;
interface Internals {
  session: InstanceType<typeof ParkSession>;
  saves: { snapshot(): { unsavedChanges: boolean; slots: Array<{ id: string; revision: number; savedAt: number; status: { state: string } }>; autosave: { state: string } }; hasUnsavedEdits(): boolean; refresh(): Promise<void> };
  undo: { status(): { canUndo: boolean } };
}
const internals = (game: Game): Internals => game as unknown as Internals;

const makeGame = async (store: Store, options: { startMenu?: boolean; monitor?: FakeMonitor; profileStorage?: ReturnType<typeof memoryStorage> | null } = {}) => {
  const monitor = options.monitor ?? fakeMonitor('tab-test');
  windowStub[RECOVERY_MONITOR_HOLDER_KEY] = monitor;
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, {
      kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined,
    }),
    startMenu: options.startMenu ?? true,
    profileStorage: options.profileStorage === undefined ? knownProfile() : options.profileStorage,
  });
  await game.mount(host);
  await settle();
  if (useUiStore.getState().menuKind === 'start' && options.profileStorage !== null) await untilPreviewReady();
  return { game, monitor };
};

const runFrames = (count: number, deltaMs = 1000): void => { for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs); };

const press = (key: string, extra: Record<string, unknown> = {}): void => {
  const event = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault: () => undefined, ...extra };
  for (const handler of handlers.get('keydown') ?? []) handler(event);
};

const ui = () => useUiStore.getState();
const context = () => activeInputContext(useUiStore.getState());

/** Plays a park (no menu), changes it, saves it to `slot`, and tears the game down. Returns what was saved. */
const seedSave = async (store: Store, slot: 'autosave' | 'manual-1' | 'manual-2', cashBonus: number) => {
  const { game } = await makeGame(store, { startMenu: false });
  game.startScenario(null);
  await settle(); // the park-start rescan holds the autosave until it has looked at the other tabs
  game.world.addMoney(cashBonus);
  runFrames(6, 250);
  const result = slot === 'autosave' ? await autosaveNow(game) : await saveBridge.saveToSlot(slot, `Park ${slot}`);
  expect(result.ok, `seed save ${slot}`).toBe(true);
  const saved = { cash: game.world.cash, tick: game.world.tick, hash: hashState(internals(game).session.serialize()) };
  game.destroy();
  return saved;
};
const autosaveNow = async (game: Game) => {
  runFrames(START_AUTOSAVE_DELAY_SECONDS + 1);
  await settle();
  void game;
  return { ok: true as const };
};

beforeEach(() => {
  frameCallback = null;
  inputHandlers = null;
  centres.length = 0;
  focusEntranceCalls = 0;
  viewEnabled.length = 0;
  handlers = new Map();
  const register = (type: string, handler: Handler): void => { handlers.set(type, [...(handlers.get(type) ?? []), handler]); };
  windowStub = {
    addEventListener: register,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('document', { addEventListener: register, removeEventListener: () => undefined, visibilityState: 'visible', activeElement: null });
  resetSettings();
  useUiStore.setState({
    menuKind: null, menuPanel: 'main', menuNotice: null, menuPreview: NO_MENU_PREVIEW,
    settingsOpen: false, savesDialogOpen: false, scenarioPickerOpen: false, loadoutScenarioId: null,
    tool: 'build', selectedDefinitionId: 'sunstone-path', managementOpen: false, toast: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetSettings();
});

describe('boot to the start screen', () => {
  it('shows the menu over a paused park with no save: the empty starter map, New park leading', async () => {
    const { game, monitor } = await makeGame(new MemorySaveStore());
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPreview).toEqual({ phase: 'ready', slotId: null, revision: null });
    expect(game.clock.speed, 'the clock does not run behind the menu').toBe(0);
    expect(ui().speed).toBe(0);
    expect(context()).toBe('menu');
    expect(centres.length, 'the starter map drifts too').toBeGreaterThan(0);
    expect(monitor.started, 'no recovery marker or lock while only the menu is up').toEqual([]);
    game.destroy();
  });

  it('puts the latest save behind the menu, paused and exactly as saved, and the sweep moves the camera', async () => {
    const store = new MemorySaveStore();
    const saved = await seedSave(store, 'manual-1', 4321);
    const { game, monitor } = await makeGame(store);
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPreview).toMatchObject({ phase: 'ready', slotId: 'manual-1' });
    expect(ui().saves.slots.some((slot) => slot.id === 'manual-1'), 'the slot list the card is built from is in the store before the card shows').toBe(true);
    expect(game.world.cash).toBe(saved.cash);
    expect(game.world.tick).toBe(saved.tick);
    expect(game.clock.speed).toBe(0);
    const record = await store.read('manual-1');
    expect(hashState(internals(game).session.serialize()), 'the previewed state is the saved state').toBe((record.payload as { stateHash: string }).stateHash);
    expect(hashState(internals(game).session.serialize())).toBe(saved.hash);

    const before = centres.length;
    runFrames(120, 16);
    expect(centres.length, 'the sweep writes the camera each frame').toBeGreaterThan(before + 100);
    const spread = new Set(centres.slice(before).map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`));
    expect(spread.size, 'and the camera actually moves').toBeGreaterThan(50);
    expect(monitor.started).toEqual([]);
    game.destroy();
  });

  it('runs no simulation, autosave, undo capture or recovery lock while only the menu is up', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'autosave', 100);
    const revisionBefore = (await store.list()).find((row) => row.id === 'autosave')!.revision;
    const { game, monitor } = await makeGame(store);
    const tick = game.world.tick;
    const cash = game.world.cash;
    runFrames(START_AUTOSAVE_DELAY_SECONDS * 6, 1000);
    await settle();
    expect(game.world.tick, 'no simulation ticks').toBe(tick);
    expect(game.world.cash).toBe(cash);
    expect((await store.list()).find((row) => row.id === 'autosave')!.revision, 'no autosave was written').toBe(revisionBefore);
    expect(internals(game).saves.snapshot().unsavedChanges, 'the preview is nobody\'s unsaved work').toBe(false);
    expect(internals(game).undo.status().canUndo).toBe(false);
    expect(monitor.started).toEqual([]);
    expect(monitor.cleaned, 'nothing to clean: no marker was ever written').toBe(0);
    game.destroy();
  });

  it('refuses every world input behind the menu: clicks, drags, right click, tool keys, speed keys, undo', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 50);
    const { game } = await makeGame(store);
    ui().selectBuild('sunstone-path');
    const version = game.world.version;
    const paths = game.world.paths.size;
    inputHandlers!.hover({ x: 3, y: 3 });
    inputHandlers!.start({ x: 3, y: 3 });
    inputHandlers!.move({ x: 4, y: 3 });
    inputHandlers!.end({ x: 5, y: 3 });
    inputHandlers!.cancel();
    expect(game.world.version).toBe(version);
    expect(game.world.paths.size).toBe(paths);
    expect(ui().hoveredCell).toBeNull();
    expect(ui().tool, 'right click did not disarm the tool').toBe('build');
    press('b');
    press('p');
    press('g');
    press('h');
    press('2');
    press('z', { ctrlKey: true });
    press('s', { ctrlKey: true });
    expect(ui().tool).toBe('build');
    expect(ui().cleanView).toBe(false);
    expect(game.clock.speed).toBe(0);
    expect(viewEnabled.at(-1), 'camera keys are off while the menu owns the keyboard').toBe(false);
    game.destroy();
  });

  it('skips the sweep when the voxel renderer failed (window.__voxelFailure), and only then', async () => {
    windowStub.__voxelFailure = 'WebGL2 missing';
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 50);
    const { game } = await makeGame(store);
    expect(ui().menuPreview.phase).toBe('ready');
    runFrames(60, 16);
    expect(centres, 'no camera work at all on a fallback renderer').toEqual([]);
    game.destroy();
  });
});

describe('reduced motion', () => {
  it('stands the camera still: one framing, no drift', async () => {
    updateSettings({ reducedMotion: 'on' });
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 50);
    const { game } = await makeGame(store);
    runFrames(200, 16);
    expect(centres.length, 'the framing is written once and never again').toBe(1);
    expect(centres[0]).toEqual([16, 16]);
    game.destroy();
  });

  it('stops mid-sweep the moment the setting turns on, and resumes when it turns off', async () => {
    updateSettings({ reducedMotion: 'off' });
    const { game } = await makeGame(new MemorySaveStore());
    runFrames(60, 16);
    const moving = centres.length;
    expect(moving).toBeGreaterThan(30);
    updateSettings({ reducedMotion: 'on' });
    runFrames(60, 16);
    expect(centres.length, 'nothing written while reduced').toBe(moving);
    updateSettings({ reducedMotion: 'off' });
    runFrames(60, 16);
    expect(centres.length).toBeGreaterThan(moving + 30);
    game.destroy();
  });
});

describe('Continue', () => {
  it('adopts the previewed session (same object, same hash) and then starts clock, undo, autosave and recovery', async () => {
    const store = new MemorySaveStore();
    const saved = await seedSave(store, 'manual-1', 777);
    const { game, monitor } = await makeGame(store);
    const session = internals(game).session;
    const hashBefore = hashState(session.serialize());
    expect(hashBefore).toBe(saved.hash);

    await game.menuContinue();
    expect(ui().menuKind).toBeNull();
    expect(internals(game).session, 'the same session: nothing was loaded twice').toBe(session);
    expect(hashState(internals(game).session.serialize()), 'exactly the parked state').toBe(hashBefore);
    expect(game.clock.speed, 'a continued park starts paused, like a loaded one').toBe(0);
    expect(monitor.started, 'the recovery lock starts now').toEqual([{ parkName: 'Sandbox park', scenarioId: null, mode: 'sandbox' }]);
    expect(internals(game).saves.snapshot().unsavedChanges).toBe(false);
    expect(context()).toBe('world');
    expect(ui().toast).toMatch(/Loaded/);

    // The clock really starts once the player plays: ticks advance and the first autosave follows.
    game.setSpeed(1);
    const tick = game.world.tick;
    runFrames(START_AUTOSAVE_DELAY_SECONDS + 2, 1000);
    await settle();
    expect(game.world.tick).toBeGreaterThan(tick);
    expect((await store.list()).some((row) => row.id === 'autosave'), 'the autosave schedule is armed').toBe(true);

    // And so is undo: a build is a rewindable gesture again, and the ring was empty until now.
    expect(internals(game).undo.status().canUndo).toBe(false);
    ui().selectBuild('sunstone-path');
    inputHandlers!.start({ x: 15, y: 21 });
    inputHandlers!.end({ x: 15, y: 21 });
    expect(internals(game).undo.status().canUndo, 'a gesture after Continue is captured').toBe(true);
    game.destroy();
  });

  it('starts the same state a normal Load of the same slot gives', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 999);
    const first = await makeGame(store);
    await first.game.menuContinue();
    const continued = hashState(internals(first.game).session.serialize());
    first.game.destroy();

    const second = await makeGame(store, { startMenu: false });
    const loaded = await saveBridge.load('manual-1');
    expect(loaded.ok).toBe(true);
    expect(hashState(internals(second.game).session.serialize())).toBe(continued);
    second.game.destroy();
  });

  it('re-reads through the normal load path when the slot changed after the preview (another tab saved)', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 100);
    const { game } = await makeGame(store);
    const previewed = internals(game).session;
    // Another tab writes a newer park into the same slot (built by hand: the UI store is shared by every GameApp in a test).
    const rival = new ParkSession(null);
    rival.world.addMoney(5555);
    rival.syncWithWorld();
    const newerCash = rival.world.cash;
    const row = (await store.list()).find((entry) => entry.id === 'manual-1')!;
    await store.write('manual-1', createParkSave(rival.serialize(), { clock: { speed: 0, simulationTimeMs: 0 }, tourNodeId: null }, Date.now() + 5000), { ...row, savedAt: Date.now() + 5000 });
    await internals(game).saves.refresh();
    await game.menuContinue();
    await settle();
    expect(ui().menuKind).toBeNull();
    expect(internals(game).session, 'a different session than the stale preview').not.toBe(previewed);
    expect(game.world.cash).toBe(newerCash);
    game.destroy();
  });

  it('is refused while a recovery offer is open', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'autosave', 100);
    const monitor = fakeMonitor('tab-new');
    const row = (await store.list()).find((entry) => entry.id === 'autosave')!;
    monitor.detection = {
      kind: 'offer',
      offer: {
        interruptedSessionIds: ['tab-crashed'], sessionId: row.writerTabId, parkName: 'Sandbox park', scenarioId: null,
        startedAt: 1, lastSeenAt: 2, evidence: 'lock-free',
        autosave: { name: row.name, scenarioName: row.scenarioName, savedAt: row.savedAt, playtimeSeconds: row.playtimeSeconds, guestCount: row.guestCount, cash: row.cash, rating: row.rating, revision: row.revision },
      },
    };
    const { game } = await makeGame(store, { monitor });
    expect(ui().recovery.phase).toBe('offered');
    expect(context(), 'the recovery prompt is above the start screen').toBe('recovery');
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPreview, 'the card shows over the starter map until the offer is answered').toEqual({ phase: 'ready', slotId: null, revision: null });
    await game.menuContinue();
    game.menuNewPark();
    expect(ui().menuKind, 'neither Continue nor New park acted').toBe('start');
    press('Escape');
    expect(ui().recovery.phase, 'Escape does not decide about the save').toBe('offered');
    expect(ui().menuKind).toBe('start');
    game.destroy();
  });
});

describe('recovery precedence', () => {
  const offerFor = (row: { name: string; scenarioName: string; savedAt: number; playtimeSeconds: number; guestCount: number; cash: number; rating: number; revision: number; writerTabId: string }) => ({
    kind: 'offer' as const,
    offer: {
      interruptedSessionIds: ['tab-crashed'], sessionId: row.writerTabId, parkName: 'Sandbox park', scenarioId: null,
      startedAt: 1, lastSeenAt: 2, evidence: 'lock-free' as const,
      autosave: { name: row.name, scenarioName: row.scenarioName, savedAt: row.savedAt, playtimeSeconds: row.playtimeSeconds, guestCount: row.guestCount, cash: row.cash, rating: row.rating, revision: row.revision },
    },
  });

  it('Not now frees the menu, which then previews the newest remaining save', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'autosave', 100);
    const row = (await store.list()).find((entry) => entry.id === 'autosave')!;
    const monitor = fakeMonitor('tab-new');
    monitor.detection = offerFor(row);
    const { game } = await makeGame(store, { monitor });
    expect(ui().recovery.phase).toBe('offered');
    const result = await recoveryBridge.dismiss();
    expect(result.ok).toBe(true);
    await settle();
    expect(ui().recovery.phase).toBe('idle');
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPreview.phase).toBe('ready');
    expect(ui().menuPreview.slotId, 'the recovered copy, now a manual slot, is what the menu shows').toMatch(/^manual-/);
    expect(context()).toBe('menu');
    game.destroy();
  });

  it('Resume loads the autosave through the normal flow and closes the menu', async () => {
    const store = new MemorySaveStore();
    const saved = await seedSave(store, 'autosave', 321);
    const row = (await store.list()).find((entry) => entry.id === 'autosave')!;
    const monitor = fakeMonitor('tab-new');
    monitor.detection = offerFor(row);
    const { game } = await makeGame(store, { monitor });
    const result = await recoveryBridge.resume();
    expect(result.ok).toBe(true);
    await settle();
    expect(ui().menuKind).toBeNull();
    expect(game.world.cash).toBe(saved.cash);
    expect(game.clock.speed).toBe(0);
    expect(monitor.started.length).toBeGreaterThanOrEqual(1);
    expect(context()).toBe('world');
    game.destroy();
  });
});

describe('an unreadable latest save', () => {
  const corrupt = async (store: Store, id: 'autosave' | 'manual-1', savedAt: number) => {
    await store.write(id, { definitely: 'not a save' }, {
      id, kind: id === 'autosave' ? 'auto' : 'manual', name: id === 'autosave' ? 'Autosave' : 'Broken park', scenarioId: null, scenarioName: 'Sandbox park',
      playtimeSeconds: 1, savedAt, schemaVersion: 4, contentVersion: 2, savedAtTick: 1, guestCount: 1, cash: 1, rating: 1, sizeBytes: 10,
      revision: 1, writerTabId: 'x', status: { state: 'ok' },
    });
  };

  it('falls back to the plain menu with a message, never an empty screen or a crash', async () => {
    const store = new MemorySaveStore();
    await corrupt(store, 'autosave', Date.now());
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((error: unknown) => { errors.push(error); });
    const { game } = await makeGame(store);
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPreview).toEqual({ phase: 'ready', slotId: null, revision: null });
    expect(ui().menuNotice).toMatch(/Your latest save “Autosave” could not be read/);
    expect(game.world.cash, 'the empty starter map is on screen').toBeGreaterThan(0);
    expect(game.clock.speed).toBe(0);
    expect((await store.list()).find((row) => row.id === 'autosave')!.status.state, 'the record is kept, flagged unreadable').toBe('unreadable');
    expect(errors).toEqual([]);
    runFrames(30, 16);
    game.destroy();
  });

  it('shows the next newest readable save instead and says so', async () => {
    const store = new MemorySaveStore();
    const saved = await seedSave(store, 'manual-1', 600);
    await corrupt(store, 'autosave', Date.now() + 60_000);
    const { game } = await makeGame(store);
    expect(ui().menuPreview).toMatchObject({ phase: 'ready', slotId: 'manual-1' });
    expect(ui().menuNotice).toMatch(/could not be read, so the menu shows/);
    expect(game.world.cash).toBe(saved.cash);
    game.destroy();
  });

  it('falls back to the previous autosave generation, and Continue plays it (Phase 31)', async () => {
    const store = new MemorySaveStore();
    const saved = await seedSave(store, 'autosave', 700);
    await store.move('autosave', 'autosave-previous');
    await corrupt(store, 'autosave', Date.now() + 60_000);
    const { game } = await makeGame(store);
    expect(ui().menuPreview, 'the previous generation is the newest readable autosave').toMatchObject({ phase: 'ready', slotId: 'autosave-previous' });
    expect(ui().menuNotice).toMatch(/could not be read, so the menu shows/);
    expect(game.world.cash).toBe(saved.cash);
    const record = await store.read('autosave-previous');
    await game.menuContinue();
    await settle();
    expect(ui().menuKind, 'continued').toBeNull();
    expect(hashState(internals(game).session.serialize()), 'exactly the saved park').toBe((record.payload as { stateHash: string }).stateHash);
    game.destroy();
  });
});

describe('New park from the start screen', () => {
  it('starts a fresh sandbox, hands the camera back and starts clock, autosave and recovery', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 888);
    const { game, monitor } = await makeGame(store);
    const previewed = internals(game).session;
    runFrames(10, 16);
    const swept = centres.length;
    game.menuNewPark();
    expect(ui().menuKind).toBeNull();
    expect(internals(game).session).not.toBe(previewed);
    expect(game.clock.speed).toBe(1);
    expect(game.clock.simulationTimeMs, 'a new park does not inherit the park time of the preview').toBe(0);
    expect(game.world.tick).toBe(0);
    expect(focusEntranceCalls, 'the camera goes back to the entrance').toBe(1);
    runFrames(10, 16);
    expect(centres.length, 'the sweep stopped').toBe(swept);
    expect(monitor.started).toEqual([{ parkName: 'Sandbox park', scenarioId: null, mode: 'sandbox' }]);
    expect(context()).toBe('world');
    game.destroy();
  });
});

describe('New park from the start screen on a chosen map (Phase 24)', () => {
  it('starts the map the picker chose, framed from the gate of that map, and leaves the menu', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 888);
    const { game, monitor } = await makeGame(store);
    game.menuNewPark('red-rock-canyon');
    expect(ui().menuKind).toBeNull();
    expect(game.world.map.id).toBe('red-rock-canyon');
    expect(game.world.entrance).toEqual({ x: 16, y: 0 });
    expect(game.clock.speed).toBe(1);
    expect(focusEntranceCalls, 'the camera goes to the new gate').toBe(1);
    // The sweep behind the menu was centred on the map it showed; a new park is not swept at all.
    expect(monitor.started).toEqual([{ parkName: 'Sandbox park', scenarioId: null, mode: 'sandbox' }]);
    game.destroy();
  });

  it('without a choice it is the Meadow Garden, exactly as before the picker', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 888);
    const { game } = await makeGame(store);
    game.menuNewPark();
    expect(game.world.map.id).toBe('meadow');
    expect(game.world.entrance).toEqual({ x: 15, y: 31 });
    game.destroy();
  });
});

describe('pause menu', () => {
  const playing = async () => {
    const result = await makeGame(new MemorySaveStore(), { startMenu: false });
    result.game.startScenario(null);
    ui().selectPointer();
    return result;
  };

  it('opens on Escape in the world, pauses the clock, and Resume restores the previous speed', async () => {
    const { game } = await playing();
    game.setSpeed(2);
    expect(context()).toBe('world');
    press('Escape');
    expect(ui().menuKind).toBe('pause');
    expect(context()).toBe('menu');
    expect(game.clock.speed).toBe(0);
    const tick = game.world.tick;
    runFrames(20, 100);
    expect(game.world.tick, 'nothing advances while the menu is open').toBe(tick);
    game.resumeFromMenu();
    expect(ui().menuKind).toBeNull();
    expect(game.clock.speed).toBe(2);
    expect(ui().speed).toBe(2);
    game.destroy();
  });

  it('Escape in the Parks chooser\'s Scenario browser and Sandbox picker goes where Back goes: the chooser, then the list', async () => {
    const { game } = await playing();
    press('Escape');
    expect(ui().menuKind).toBe('pause');
    for (const panel of ['scenarios', 'new-park'] as const) {
      ui().setMenuPanel('modes');
      ui().setMenuPanel(panel);
      press('Escape');
      expect(ui().menuPanel, panel).toBe('modes');
      press('Escape');
      expect(ui().menuPanel, panel).toBe('main');
      expect(ui().menuKind).toBe('pause');
    }
    game.destroy();
  });

  it('closes on Escape (the same key) and restores a paused game as paused', async () => {
    const { game } = await playing();
    game.setSpeed(0);
    press('Escape');
    expect(ui().menuKind).toBe('pause');
    press('Escape');
    expect(ui().menuKind).toBeNull();
    expect(game.clock.speed).toBe(0);
    game.setSpeed(4);
    press('Escape');
    press('Escape', { repeat: true });
    expect(ui().menuKind, 'a held key does not close what it just opened').toBe('pause');
    press('Escape');
    expect(game.clock.speed).toBe(4);
    game.destroy();
  });

  it('leaves every older Escape behaviour alone: armed tool first, then inspectors, panels and dialogs, then the menu', async () => {
    const { game } = await playing();
    // armed tool
    ui().selectBuild('sunstone-path');
    press('Escape');
    expect(ui().tool).toBe('pointer');
    expect(ui().menuKind, 'the first Escape only disarmed the tool').toBeNull();
    // management panel
    ui().openManagement('finances');
    press('Escape');
    expect(ui().managementOpen).toBe(false);
    expect(ui().menuKind).toBeNull();
    // the Scenario browser's loadout
    ui().openScenarioLoadout('garden-gate');
    press('Escape');
    expect(ui().loadoutScenarioId).toBeNull();
    expect(ui().scenarioPickerOpen).toBe(false);
    expect(ui().menuKind).toBeNull();
    // clock popover
    ui().setClockPopoverOpen(true);
    press('Escape');
    expect(ui().clockPopoverOpen).toBe(false);
    expect(ui().menuKind).toBeNull();
    // Save / Load and Settings (opened from the world)
    ui().openSettings();
    ui().openSavesDialog();
    press('Escape');
    expect(ui().savesDialogOpen).toBe(false);
    expect(ui().settingsOpen).toBe(true);
    press('Escape');
    expect(ui().settingsOpen).toBe(false);
    expect(ui().menuKind).toBeNull();
    // and now nothing is left to close
    press('Escape');
    expect(ui().menuKind).toBe('pause');
    game.destroy();
  });

  it('does not open beneath a modal layer (the Menu button reached by keyboard): loadout, run screen, Settings, Save / Load, result', async () => {
    const store = new MemorySaveStore();
    const { game } = await makeGame(store, { startMenu: false });
    game.startScenario(null);
    ui().selectPointer();
    game.clock.setSpeed(2);
    for (const open of [
      () => useUiStore.setState({ scenarioPickerOpen: true, loadoutScenarioId: 'garden-gate' as never }),
      () => useUiStore.setState({ runView: 'map' }),
      () => useUiStore.setState({ settingsOpen: true }),
      () => useUiStore.setState({ savesDialogOpen: true }),
    ]) {
      useUiStore.setState({ scenarioPickerOpen: false, loadoutScenarioId: null, runView: null, settingsOpen: false, savesDialogOpen: false });
      open();
      game.openPauseMenu();
      expect(ui().menuKind).toBeNull();
      expect(game.clock.speed, 'the clock keeps its speed').toBe(2);
    }
    useUiStore.setState({ scenarioPickerOpen: false, loadoutScenarioId: null, runView: null, settingsOpen: false, savesDialogOpen: false });
    game.openPauseMenu();
    expect(ui().menuKind).toBe('pause');
    game.destroy();
  });

  it('puts Settings, Save / Load and the Scenario loadout above the menu, closing one layer per Escape, resuming last', async () => {
    const { game } = await playing();
    game.setSpeed(2);
    press('Escape');
    ui().openSettings();
    expect(context()).toBe('settings');
    ui().openSavesDialog();
    expect(context()).toBe('saveLoad');
    press('Escape');
    expect(context()).toBe('settings');
    expect(ui().menuKind).toBe('pause');
    press('Escape');
    expect(context()).toBe('menu');
    ui().openScenarioLoadout('garden-gate');
    expect(context()).toBe('loadout');
    press('Escape');
    expect(ui().menuKind).toBe('pause');
    expect(game.clock.speed, 'still paused while sub-layers come and go').toBe(0);
    press('Escape');
    expect(ui().menuKind).toBeNull();
    expect(game.clock.speed).toBe(2);
    game.destroy();
  });

  it('keeps world input inert while open', async () => {
    const { game } = await playing();
    press('Escape');
    const version = game.world.version;
    ui().selectBuild('sunstone-path');
    inputHandlers!.start({ x: 2, y: 2 });
    inputHandlers!.end({ x: 2, y: 2 });
    press('1');
    press('b');
    expect(game.world.version).toBe(version);
    expect(game.clock.speed).toBe(0);
    game.destroy();
  });

  it('a Load from the pause menu closes it and the loaded park starts paused (the old speed is not restored)', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 250);
    const { game } = await makeGame(store, { startMenu: false });
    game.startScenario(null);
    ui().selectPointer();
    game.setSpeed(4);
    press('Escape');
    const loaded = await saveBridge.load('manual-1');
    expect(loaded.ok).toBe(true);
    expect(ui().menuKind).toBeNull();
    expect(game.clock.speed).toBe(0);
    game.destroy();
  });

  it('Save in the pause menu writes a quick save', async () => {
    const store = new MemorySaveStore();
    const { game } = await makeGame(store, { startMenu: false });
    game.startScenario(null);
    ui().selectPointer();
    press('Escape');
    game.menuQuickSave();
    await settle();
    expect((await store.list()).some((row) => row.kind === 'manual')).toBe(true);
    expect(ui().menuKind, 'the menu stays open after saving').toBe('pause');
    game.destroy();
  });
});

describe('Quit to menu', () => {
  it('goes straight back when nothing is unsaved, over the latest park', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 400);
    const { game, monitor } = await makeGame(store, { startMenu: false });
    await saveBridge.load('manual-1');
    ui().selectPointer();
    press('Escape');
    expect(internals(game).saves.snapshot().unsavedChanges).toBe(false);
    game.requestQuitToMenu();
    await settle();
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPanel).toBe('main');
    expect(ui().menuPreview).toMatchObject({ phase: 'ready', slotId: 'manual-1' });
    expect(game.clock.speed).toBe(0);
    expect(monitor.cleaned, 'the tab no longer runs a park: marker and lock are released').toBeGreaterThanOrEqual(1);
    game.destroy();
  });

  it('asks first when the park has unsaved changes, and Cancel stays in the park', async () => {
    const store = new MemorySaveStore();
    const { game } = await makeGame(store, { startMenu: false });
    game.startScenario(null);
    ui().selectPointer();
    game.world.buildPaths([{ x: 15, y: 21 }, { x: 15, y: 22 }]);
    expect(internals(game).saves.snapshot().unsavedChanges).toBe(true);
    press('Escape');
    game.requestQuitToMenu();
    expect(ui().menuKind).toBe('pause');
    expect(ui().menuPanel).toBe('quit');
    press('Escape');
    expect(ui().menuPanel, 'Escape steps back from the question').toBe('main');
    expect(ui().menuKind).toBe('pause');
    game.destroy();
  });

  it('Save and quit writes the save first, then shows the new latest park', async () => {
    const store = new MemorySaveStore();
    const { game } = await makeGame(store, { startMenu: false });
    game.startScenario(null);
    ui().selectPointer();
    game.world.addMoney(2468);
    game.world.buildPaths([{ x: 15, y: 21 }]);
    const cash = game.world.cash;
    press('Escape');
    game.requestQuitToMenu();
    await game.confirmQuitToMenu('save');
    await settle();
    expect(ui().menuKind).toBe('start');
    const slot = ui().menuPreview.slotId;
    expect(slot, 'the save that was just written').toMatch(/^manual-/);
    expect(game.world.cash).toBe(cash);
    expect(game.clock.speed).toBe(0);
    game.destroy();
  });

  it('Quit without saving leaves the unsaved changes behind and shows the previous save', async () => {
    const store = new MemorySaveStore();
    const saved = await seedSave(store, 'manual-1', 300);
    const { game } = await makeGame(store, { startMenu: false });
    game.startScenario(null);
    ui().selectPointer();
    game.world.addMoney(99_999);
    press('Escape');
    game.requestQuitToMenu();
    expect(ui().menuPanel).toBe('quit');
    await game.confirmQuitToMenu('discard');
    await settle();
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPreview).toMatchObject({ slotId: 'manual-1' });
    expect(game.world.cash, 'the extra cash was not kept').toBe(saved.cash);
    game.destroy();
  });

  it('Cancel (or Escape) while Save and quit is still writing keeps the player in the park', async () => {
    const store = new MemorySaveStore();
    const { game } = await makeGame(store, { startMenu: false });
    game.startScenario(null);
    ui().selectPointer();
    game.world.buildPaths([{ x: 15, y: 21 }]);
    press('Escape');
    game.requestQuitToMenu();
    const saves = internals(game).saves as unknown as { quickSave(): Promise<unknown> };
    const real = saves.quickSave.bind(saves);
    let release: () => void = () => undefined;
    saves.quickSave = () => new Promise((resolve) => { release = () => resolve(real()); });
    const pending = game.confirmQuitToMenu('save');
    press('Escape');
    expect(ui().menuPanel).toBe('main');
    release();
    await pending;
    await settle();
    expect(ui().menuKind, 'the answer was Cancel: the park is not left').toBe('pause');
    expect(game.clock.speed).toBe(0);
    game.destroy();
  });

  it('a failing Save and quit keeps the park, says why and does not hang; Quit without saving still works', async () => {
    const store = new MemorySaveStore();
    const { game } = await makeGame(store, { startMenu: false });
    game.startScenario(null);
    ui().selectPointer();
    game.world.buildPaths([{ x: 15, y: 21 }]);
    const cash = game.world.cash;
    press('Escape');
    game.requestQuitToMenu();
    const saves = internals(game).saves as unknown as { quickSave(): Promise<unknown> };
    saves.quickSave = () => Promise.resolve({ ok: false, error: { code: 'quota', message: 'Storage is full.' } });
    await game.confirmQuitToMenu('save');
    expect(ui().menuKind).toBe('pause');
    expect(ui().menuNotice).toContain('Storage is full.');
    expect(ui().menuNotice).toContain('The park was not left.');
    expect(game.world.cash).toBe(cash);
    await game.confirmQuitToMenu('discard');
    await settle();
    expect(ui().menuKind).toBe('start');
    game.destroy();
  });

  it('two quick presses of Save and quit leave exactly once', async () => {
    const store = new MemorySaveStore();
    const { game, monitor } = await makeGame(store, { startMenu: false });
    game.startScenario(null);
    ui().selectPointer();
    game.world.buildPaths([{ x: 15, y: 21 }]);
    press('Escape');
    game.requestQuitToMenu();
    await Promise.all([game.confirmQuitToMenu('save'), game.confirmQuitToMenu('save')]);
    await settle();
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPreview.phase).toBe('ready');
    expect(ui().menuPreview.slotId, 'the save just written is previewed, not the starter map').toMatch(/^manual-/);
    const session = internals(game).session;
    await game.menuContinue();
    expect(internals(game).session, 'one session, the previewed one').toBe(session);
    expect(monitor.started.length).toBeGreaterThanOrEqual(2);
    game.destroy();
  });

  it('after quitting, Continue reuses the previewed park and registers the recovery lock again', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 300);
    const { game, monitor } = await makeGame(store, { startMenu: false });
    game.startScenario(null);
    ui().selectPointer();
    press('Escape');
    game.requestQuitToMenu();
    await game.confirmQuitToMenu('discard');
    await settle();
    const startsBefore = monitor.started.length;
    const session = internals(game).session;
    await game.menuContinue();
    expect(internals(game).session).toBe(session);
    expect(monitor.started.length).toBe(startsBefore + 1);
    expect(ui().menuKind).toBeNull();
    game.destroy();
  });
});

describe('boot decision in GameApp', () => {
  it('a first run (no profile, no saves) opens on the start screen too; New park gives the Sandbox First Day park', async () => {
    const { game } = await makeGame(new MemorySaveStore(), { profileStorage: memoryStorage() });
    expect(ui().menuKind).toBe('start');
    expect(game.clock.speed).toBe(0);
    game.menuNewPark();
    expect(ui().menuKind).toBeNull();
    expect(game.clock.speed).toBe(1);
    expect(ui().scenarioPickerOpen, 'the Parks map is gone').toBe(false);
    expect(ui().runView).toBeNull();
    expect(ui().sessionMode).toBe('sandbox');
    expect(ui().onboarding, 'the First Day tracker runs').not.toBeNull();
    expect(['world', 'build']).toContain(context());
    game.destroy();
  });

  it('shows the menu for a first run that already has a save', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 10);
    const { game } = await makeGame(store, { profileStorage: memoryStorage() });
    expect(ui().menuKind).toBe('start');
    expect(ui().scenarioPickerOpen).toBe(false);
    game.destroy();
  });

  it('&menu=0 (startMenu: false) opens straight into the park, as before the menu existed', async () => {
    const store = new MemorySaveStore();
    await seedSave(store, 'manual-1', 10);
    const { game } = await makeGame(store, { startMenu: false });
    expect(ui().menuKind).toBeNull();
    expect(game.clock.speed).toBe(1);
    expect(centres, 'no sweep').toEqual([]);
    game.destroy();
  });
});

describe('the sweep and the session swap', () => {
  it('a preview is a real ParkSession built from the save, and a second mount sees the same bytes', async () => {
    const store = new MemorySaveStore();
    const saved = await seedSave(store, 'manual-1', 12);
    const a = await makeGame(store);
    const hashA = hashState(internals(a.game).session.serialize());
    a.game.destroy();
    const b = await makeGame(store);
    expect(hashState(internals(b.game).session.serialize())).toBe(hashA);
    expect(hashA).toBe(saved.hash);
    expect(internals(b.game).session).toBeInstanceOf(ParkSession);
    b.game.destroy();
  });
});
