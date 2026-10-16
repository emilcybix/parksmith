import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryDetection, RecoveryMonitor, RecoveryParkInfo } from './saves/recoveryTypes';

/**
 * Game modes and the profile as GameApp wires them (Phase 22): every mode starts through `startPark`, a clear records
 * rewards in the profile, the unlock shows in a NEW park and not in one started before, retry keeps seed, cards and
 * mode, the old v9 saves load with the right mode, and another tab's progress arrives through the storage event.
 */

let frameCallback: ((deltaMs: number) => void) | null = null;

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
  setInputHandlers(): void {}
  setViewInputEnabled(): void {}
  setToolCursor(): void {}
  focusCell(): void {}
  focusEntrance(): void {}
  setCameraCentre(): void {}
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
const { gameBridge } = await import('./gameBridge');
const { runBridge } = await import('../ui/runBridge');
const { useUiStore, NO_MENU_PREVIEW } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');
const { RECOVERY_MONITOR_HOLDER_KEY, parseRecoveryMarker, decideRecovery } = await import('./saves/recoveryMonitor');
const { resetSettings } = await import('../settings');
const { ParkSession } = await import('../game/session/ParkSession');
const { SaveError, SAVE_SCHEMA_VERSION } = await import('../game/save/version');
const { PROFILE_STORAGE_KEY, serializeProfile, freshProfile } = await import('../game/profile/schema');
const { slotMode } = await import('./saves/mapMeta');
const { recoveredSlotName, isRecoveredSlotName } = await import('./saves/recoveryTypes');
const { buildLockRefusal } = await import('./placementFeedback');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();
let windowStub: Record<string, unknown>;
const host = {} as HTMLElement;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const fakeMonitor = (): RecoveryMonitor & { started: RecoveryParkInfo[] } => ({
  sessionId: 'tab-modes',
  mode: 'web-locks',
  started: [],
  start(park: RecoveryParkInfo) { this.started.push(park); return Promise.resolve(); },
  heartbeat: () => undefined,
  markClean: () => undefined,
  detectInterrupted: () => Promise.resolve({ kind: 'clean' } as RecoveryDetection),
  forget: () => undefined,
  dispose: () => undefined,
});

const memoryStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
  };
};
/** A profile that has been seen (no first-run map) and holds `patch`. */
const knownProfile = (patch: Record<string, unknown> = {}) => memoryStorage({
  [PROFILE_STORAGE_KEY]: serializeProfile({ ...freshProfile(), ui: { mapSeen: true, tourOffered: true }, ...patch } as ReturnType<typeof freshProfile>),
});

interface Internals {
  session: InstanceType<typeof ParkSession>;
  guests: { spawnGuests(count: number): number };
}
type Game = InstanceType<typeof GameApp>;
const internals = (game: Game): Internals => game as unknown as Internals;

const makeGame = async (options: { profile?: ReturnType<typeof memoryStorage>; store?: InstanceType<typeof MemorySaveStore> } = {}) => {
  const monitor = fakeMonitor();
  windowStub[RECOVERY_MONITOR_HOLDER_KEY] = monitor;
  const store = options.store ?? new MemorySaveStore();
  const profile = options.profile ?? knownProfile();
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, { kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined }),
    startMenu: false,
    profileStorage: profile,
  });
  await game.mount(host);
  await settle();
  return { game, monitor, profile, store };
};

const runFrames = (count: number, deltaMs = 1000): void => { for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs); };
const ui = () => useUiStore.getState();

/** Plays the open scenario park to its win: fills the park with guests and runs the clock until a result latches. */
const winPark = (game: Game): void => {
  internals(game).guests.spawnGuests(200);
  for (let i = 0; i < 120 && ui().scenario?.status === 'running'; i += 1) runFrames(5, 1000);
};

beforeEach(() => {
  frameCallback = null;
  handlers = new Map();
  const register = (type: string, handler: Handler): void => { handlers.set(type, [...(handlers.get(type) ?? []), handler]); };
  windowStub = {
    addEventListener: register,
    removeEventListener: (type: string, handler: Handler) => handlers.set(type, (handlers.get(type) ?? []).filter((item) => item !== handler)),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('document', { addEventListener: register, removeEventListener: () => undefined, visibilityState: 'visible', activeElement: null });
  resetSettings();
  useUiStore.setState({
    menuKind: null, menuPanel: 'main', menuNotice: null, menuPreview: NO_MENU_PREVIEW,
    settingsOpen: false, savesDialogOpen: false, scenarioPickerOpen: false, loadoutScenarioId: null,
    tool: 'build', selectedDefinitionId: 'sunstone-path', managementOpen: false, toast: null, scenarioRewards: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetSettings();
});

describe('starting a park in each mode', () => {
  it('a Sandbox park has the Sandbox mode, no bonuses even when earned (the switch is off), and every unlock', async () => {
    const { game } = await makeGame({ profile: knownProfile({ bonusIds: ['nest-egg'], unlockedBuildingIds: ['tiki-tumbler'] }) });
    game.startPark({ mode: 'sandbox' });
    const session = internals(game).session;
    expect(session.mode).toBe('sandbox');
    expect(session.grant.bonusIds).toEqual([]);
    expect(session.grant.unlockedBuildingIds).toEqual(['tiki-tumbler']);
    expect(ui().sessionMode).toBe('sandbox');
    // Phase 33: the top bar names the Sandbox map.
    expect(ui().parkTitle).toBe('Meadow Garden');
    expect(ui().activeBonuses).toEqual([]);
    expect(ui().profileLocks['tiki-tumbler']).toBeUndefined();
    expect(ui().profileLocks['cactus-cooler']).toBe('Clear Canyon Caravan in Scenario mode');
    game.destroy();
  });

  it('a Scenario park takes the bonuses the switch allows, and publishes them for the HUD', async () => {
    const { game } = await makeGame({ profile: knownProfile({ bonusIds: ['nest-egg'] }) });
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    expect(internals(game).session.mode).toBe('scenario');
    expect(internals(game).session.grant.bonusIds).toEqual(['nest-egg']);
    expect(ui().sessionMode).toBe('scenario');
    // Phase 33: the top bar names the scenario.
    expect(ui().parkTitle).toBe('Sunny Start');
    expect(ui().activeBonuses.map((bonus) => bonus.id)).toEqual(['nest-egg']);
    // 9,000 scenario cash + the 500 bonus
    expect(game.world.cash).toBe(9_500);
    game.destroy();
  });

  it('turning the Sandbox switch on gives the Sandbox park the bonuses, for parks started afterwards only', async () => {
    const { game } = await makeGame({ profile: knownProfile({ bonusIds: ['nest-egg'] }) });
    game.startPark({ mode: 'sandbox' });
    const before = game.world.cash;
    gameBridge.setUseBonuses('sandbox', true);
    expect(game.world.cash, 'the running park is unchanged').toBe(before);
    game.startPark({ mode: 'sandbox' });
    expect(game.world.cash).toBe(before + 500);
    expect(ui().profile?.useBonuses.sandbox).toBe(true);
    game.destroy();
  });

  it('startScenario(id, cards) starts that scenario in Scenario mode (never a run) and a null id is the Sandbox', async () => {
    const { game } = await makeGame();
    game.startScenario('sunny-start', []);
    expect(internals(game).session.mode).toBe('scenario');
    expect(internals(game).session.scenarioDefinition?.id).toBe('sunny-start');
    game.startScenario(null);
    expect(internals(game).session.mode).toBe('sandbox');
    game.destroy();
  });

  it('a locked scenario is refused in Scenario mode with its condition, and the live park stays', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'sandbox' });
    const session = internals(game).session;
    game.startPark({ mode: 'scenario', scenarioId: 'boardwalk-breeze', cardIds: [] });
    expect(internals(game).session).toBe(session);
    expect(ui().toast).toContain('Clear Sunny Start first');
    game.destroy();
  });

  it('card pool: Scenario takes the profile collection; other ids are dropped', async () => {
    const { game } = await makeGame({ profile: knownProfile({ discoveredCardIds: ['rush-hour'] }) });
    const snapshot = ui().profile!;
    const pick = snapshot.collectionCardIds[0];
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [pick, 'not-a-card'] });
    expect(internals(game).session.activeCards.map((card) => card.id)).toEqual([pick]);
    game.destroy();
  });

  it('the Scenario browser entry starts a scenario through the bridge and leaves the Parks layer', async () => {
    const { game } = await makeGame();
    ui().openScenarioLoadout('sunny-start');
    gameBridge.menuStartScenario('sunny-start', []);
    expect(internals(game).session.mode).toBe('scenario');
    expect(ui().scenarioPickerOpen).toBe(false);
    game.destroy();
  });

  it('records the start in the profile stats', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'sandbox' });
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    expect(ui().profile?.stats.sandbox.parksStarted).toBe(1);
    expect(ui().profile?.stats.scenario.parksStarted).toBe(1);
    game.destroy();
  });
});

describe('a win, its rewards and the unlock in the next park', () => {
  it('Sunny Start clears: Nest egg is earned, Boardwalk Breeze and friends open, the result carries it', async () => {
    const { game, profile } = await makeGame();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    winPark(game);
    expect(ui().scenario?.status).toBe('succeeded');
    const rewards = ui().scenarioRewards!;
    expect(rewards).toMatchObject({ scenarioId: 'sunny-start', outcome: 'succeeded', firstClear: true, eligible: true });
    expect(rewards.newlyEarnedBonusIds).toEqual(['nest-egg']);
    expect(rewards.newlyAvailableScenarioIds).toContain('boardwalk-breeze');
    expect(ui().profile?.clearedScenarioIds).toEqual(['sunny-start']);
    expect(ui().profile?.stats.scenario.wins).toBe(1);
    expect(ui().rewardDraft?.length, 'a Scenario win drafts from the profile collection').toBeGreaterThan(0);
    // persisted
    expect(JSON.parse(profile.map.get(PROFILE_STORAGE_KEY)!).scenarios['sunny-start'].clears).toBe(1);
    game.destroy();
  });

  it('drafting a card in Scenario mode discovers it for the profile', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    winPark(game);
    const choice = ui().rewardDraft![0];
    gameBridge.chooseRewardCard(choice);
    expect(ui().rewardDraft).toBeNull();
    expect(ui().profile?.discoveredCardIds).toContain(choice);
    game.destroy();
  });

  it('a Boardwalk Breeze win unlocks Tiki Tumbler: buildable in a NEW sandbox, still locked in the park started before', async () => {
    const { game } = await makeGame({ profile: knownProfile({ scenarios: { 'sunny-start': { clears: 1, attempts: 1, bestClearSeconds: 100, bestProgressPercent: 100, firstClearVia: 'scenario' } } }) });
    game.startPark({ mode: 'sandbox' });
    const oldSandbox = internals(game).session;
    expect(oldSandbox.buildLockOf('tiki-tumbler')).toMatchObject({ kind: 'profile' });
    game.startPark({ mode: 'scenario', scenarioId: 'boardwalk-breeze', cardIds: [] });
    winPark(game);
    expect(ui().scenario?.status).toBe('succeeded');
    expect(ui().scenarioRewards?.newlyUnlockedBuildingIds).toEqual(['tiki-tumbler']);
    game.startPark({ mode: 'sandbox' });
    const fresh = internals(game).session;
    expect(fresh.buildLockOf('tiki-tumbler')).toBeNull();
    expect(ui().profileLocks['tiki-tumbler']).toBeUndefined();
    expect(oldSandbox.buildLockOf('tiki-tumbler'), 'a park keeps the snapshot it started with').toMatchObject({ kind: 'profile' });
    game.world.addMoney(50_000);
    // and the ghost refusal text names the unlock source in a park that does not have it
    expect(buildLockRefusal(oldSandbox.buildLockOf('tiki-tumbler')!)).toContain('Boardwalk Breeze');
    game.destroy();
  });

  it('a second clear grants nothing new', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    winPark(game);
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    winPark(game);
    expect(ui().scenarioRewards).toMatchObject({ firstClear: false, newlyEarnedBonusIds: [], newlyUnlockedBuildingIds: [] });
    expect(ui().profile?.records['sunny-start']?.clears).toBe(2);
    game.destroy();
  });

  it('a failed park grants nothing and records the best progress', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    gameBridge.setSpeed(2);
    for (let i = 0; i < 6000 && ui().scenario?.status === 'running'; i += 1) runFrames(1, 250);
    expect(ui().scenario?.status).toBe('failed');
    expect(ui().scenarioRewards).toMatchObject({ outcome: 'failed', newlyEarnedBonusIds: [], newlyUnlockedBuildingIds: [] });
    expect(ui().profile?.clearedScenarioIds).toEqual([]);
    expect(ui().profile?.stats.scenario.losses).toBe(1);
    game.destroy();
  });

  it('a park whose rules were edited shows its result but grants nothing', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    (internals(game).session.rules as { startingCash: number }).startingCash += 1;
    winPark(game);
    expect(ui().scenario?.status).toBe('succeeded');
    expect(ui().scenarioRewards).toMatchObject({ eligible: false, newlyEarnedBonusIds: [] });
    expect(ui().profile?.clearedScenarioIds).toEqual([]);
    game.destroy();
  });
});

describe('retry, quit to menu and the chooser', () => {
  it('Quick restart keeps scenario, seed, cards and MODE', async () => {
    const { game } = await makeGame();
    const pick = ui().profile!.collectionCardIds[0];
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [pick] });
    const first = internals(game).session;
    runFrames(10, 1000);
    gameBridge.restartScenario();
    const again = internals(game).session;
    expect(again).not.toBe(first);
    expect(again.mode).toBe('scenario');
    expect(again.scenarioDefinition?.id).toBe('sunny-start');
    expect(again.scenarioDefinition?.seed).toBe(first.scenarioDefinition?.seed);
    expect(again.activeCards.map((card) => card.id)).toEqual([pick]);
    expect(game.world.tick).toBe(0);
    game.destroy();
  });

  it('restarting a Sandbox keeps its mode and map; a stage of The Map has no restart (a failed level ends the run)', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'sandbox', mapId: 'red-rock-canyon' });
    gameBridge.restartScenario();
    expect(internals(game).session.mode).toBe('sandbox');
    expect(internals(game).session.map.id).toBe('red-rock-canyon');
    runBridge.startRun(7, 'standard');
    const run = internals(game).session;
    expect(run.mode).toBe('run');
    gameBridge.restartScenario();
    expect(internals(game).session, 'the run park is untouched').toBe(run);
    expect(ui().toast).toContain('cannot be restarted');
    game.destroy();
  });

  it('the result overlay opens the chooser on a panel: the result closes, the pause menu opens on it', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    winPark(game);
    gameBridge.chooseRewardCard(ui().rewardDraft![0]);
    gameBridge.openParksChooser('scenarios');
    expect(ui().menuKind).toBe('pause');
    expect(ui().menuPanel).toBe('scenarios');
    expect(ui().scenarioResultDismissed).toBe(true);
    game.destroy();
  });

  it('the chooser waits for the reward card: with a draft open it does nothing', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    winPark(game);
    expect(ui().rewardDraft).not.toBeNull();
    gameBridge.openParksChooser('collection');
    expect(ui().menuKind).toBeNull();
    game.destroy();
  });

  it('from the pause menu the chooser just switches panels; The Map opens its setup panel', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'sandbox' });
    game.openPauseMenu();
    gameBridge.openParksChooser('modes');
    expect(ui().menuPanel).toBe('modes');
    gameBridge.menuOpenTheMap();
    expect(ui().menuPanel).toBe('the-map');
    expect(ui().menuKind).toBe('pause');
    game.destroy();
  });

  it('quit to menu from a scenario park leaves the profile as it was and the next Sandbox is a Sandbox', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    game.openPauseMenu();
    gameBridge.requestQuitToMenu();
    await settle();
    expect(ui().menuKind).toBe('start');
    game.startPark({ mode: 'sandbox' });
    expect(internals(game).session.mode).toBe('sandbox');
    game.destroy();
  });
});

describe('profile wiring', () => {
  it('another tab\'s progress arrives through the storage event and is published', async () => {
    const { game } = await makeGame();
    const other = { ...freshProfile(), bonusIds: ['nest-egg'], unlockedBuildingIds: ['cocoa-chalet'], scenarios: { 'sunny-start': { clears: 1, attempts: 1, bestClearSeconds: 90, bestProgressPercent: 100, firstClearVia: 'scenario' } } };
    for (const handler of handlers.get('storage') ?? []) handler({ key: PROFILE_STORAGE_KEY, newValue: serializeProfile(other as ReturnType<typeof freshProfile>) });
    expect(ui().profile?.bonusIds).toEqual(['nest-egg']);
    expect(ui().profile?.unlockedBuildingIds).toEqual(['cocoa-chalet']);
    expect(ui().profile?.clearedScenarioIds).toEqual(['sunny-start']);
    for (const handler of handlers.get('storage') ?? []) handler({ key: 'something-else', newValue: 'garbage' });
    for (const handler of handlers.get('storage') ?? []) handler({ key: PROFILE_STORAGE_KEY, newValue: '{not json' });
    expect(ui().profile?.bonusIds, 'garbage from another tab changes nothing').toEqual(['nest-egg']);
    game.destroy();
  });

  it('the storage listener is removed on destroy', async () => {
    const { game } = await makeGame();
    expect((handlers.get('storage') ?? []).length).toBe(1);
    game.destroy();
    expect((handlers.get('storage') ?? []).length).toBe(0);
  });

  it('a steady park publishes the profile snapshot zero times: the same object over 120 frames', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    const published = ui().profile;
    let writes = 0;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (state.profile !== previous.profile || state.activeBonuses !== previous.activeBonuses || state.profileLocks !== previous.profileLocks || state.sessionMode !== previous.sessionMode) writes += 1;
    });
    runFrames(120, 16);
    unsubscribe();
    expect(writes).toBe(0);
    expect(ui().profile).toBe(published);
    game.destroy();
  });

  it('blocked storage never blocks a start: the profile lives in memory', async () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const monitor = fakeMonitor();
    windowStub[RECOVERY_MONITOR_HOLDER_KEY] = monitor;
    const store = new MemorySaveStore();
    const game = new GameApp({
      saveStore: store,
      saveWriter: createHashingWriter(store, { kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined }),
      startMenu: false,
      profileStorage: blocked,
    });
    await game.mount(host);
    await settle();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    expect(internals(game).session.mode).toBe('scenario');
    expect(ui().profile?.persistence).toBe('unavailable');
    game.destroy();
  });

  it('dismissing the conversion notice clears it', async () => {
    const legacy = memoryStorage({
      [PROFILE_STORAGE_KEY]: JSON.stringify({ version: 1, discoveredCardIds: [], tour: { ownedCardIds: [], unlockedNodeIds: ['opener', 'branch-profit'], completedNodeIds: ['opener'] }, ui: { mapSeen: true, tourOffered: true } }),
    });
    const { game } = await makeGame({ profile: legacy });
    expect(ui().profile?.notice?.kind).toBe('tour-converted');
    expect(ui().profile?.bonusIds).toContain('nest-egg');
    gameBridge.dismissProfileNotice();
    expect(ui().profile?.notice).toBeNull();
    game.destroy();
  });
});

describe('mode in saves, slots and the recovery offer', () => {
  const saveAndLoad = async (mode: 'sandbox' | 'scenario' | 'run') => {
    const { game, store } = await makeGame();
    if (mode === 'sandbox') game.startPark({ mode: 'sandbox' });
    else if (mode === 'scenario') game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    else runBridge.startRun(11, 'standard');
    runFrames(5, 250);
    const { saveBridge } = await import('./gameBridge');
    const result = await saveBridge.saveToSlot('manual-1', 'Mode test');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const meta = (await store.list()).find((row) => row.id === 'manual-1')!;
    return { game, store, meta };
  };

  it.each(['sandbox', 'scenario', 'run'] as const)('a %s park round trips through a slot with its mode in the meta', async (mode) => {
    const { game, meta } = await saveAndLoad(mode);
    expect(meta.mode).toBe(mode);
    expect(slotMode(meta)).toBe(mode);
    // The Map saves carry where the run stands, for the Continue card and the slot rows.
    if (mode === 'run') expect(meta.run).toMatchObject({ seed: 11, difficulty: 'standard', levelNumber: 1, levelCount: 5, phase: 'offer', levelsCleared: 0 });
    else expect(meta.run).toBeUndefined();
    const { saveBridge } = await import('./gameBridge');
    game.startPark({ mode: 'sandbox' });
    // Leaving a run that only the autosave holds asks first.
    if (mode === 'run') runBridge.resolveLeaveRun('leave');
    expect(internals(game).session.mode).toBe('sandbox');
    const loaded = await saveBridge.load('manual-1');
    expect(loaded.ok).toBe(true);
    expect(internals(game).session.mode).toBe(mode);
    expect(ui().sessionMode).toBe(mode);
    game.destroy();
  });

  it('menuLoadSlot resumes a saved park through the Load path, and a missing slot leaves a menu notice', async () => {
    const { game } = await saveAndLoad('scenario');
    game.startPark({ mode: 'sandbox' });
    expect(internals(game).session.mode).toBe('sandbox');
    await gameBridge.menuLoadSlot('manual-1');
    expect(internals(game).session.mode).toBe('scenario');
    expect(ui().menuNotice).toBeNull();
    await gameBridge.menuLoadSlot('manual-9');
    expect(ui().menuNotice, 'a slot that is not there says why').not.toBeNull();
    expect(internals(game).session.mode, 'and the live park stays').toBe('scenario');
    game.destroy();
  });

  it('a loaded park tells the recovery monitor its mode', async () => {
    const { game, monitor } = await makeGame();
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    expect(monitor.started.at(-1)).toMatchObject({ scenarioId: 'sunny-start', mode: 'scenario' });
    game.destroy();
  });

  it('slotMode falls back to the schema 9 rule and ignores hostile values', () => {
    expect(slotMode({ scenarioId: null })).toBe('sandbox');
    expect(slotMode({ scenarioId: 'penny-lane' })).toBe('scenario');
    expect(slotMode({ scenarioId: null, mode: 'run' })).toBe('run');
    expect(slotMode({ scenarioId: 'penny-lane', mode: 'hax' as never })).toBe('scenario');
  });

  it('the recovery marker keeps the mode, ignores a bad one, and the offer takes the autosave\'s mode first', () => {
    const marker = {
      version: 1, sessionId: 's', startedAt: 1, heartbeatAt: 2, hidden: false, mode: 'web-locks', parkName: 'Penny Lane', scenarioId: 'penny-lane', gameMode: 'run',
    };
    expect(parseRecoveryMarker(JSON.stringify(marker))?.gameMode).toBe('run');
    expect(parseRecoveryMarker(JSON.stringify({ ...marker, gameMode: 'nope' }))).not.toBeNull();
    expect(parseRecoveryMarker(JSON.stringify({ ...marker, gameMode: 'nope' }))?.gameMode).toBeUndefined();
    const autosave = {
      id: 'autosave', kind: 'auto', name: 'Autosave', scenarioId: 'penny-lane', scenarioName: 'Penny Lane', mode: 'scenario', playtimeSeconds: 1, savedAt: 1,
      schemaVersion: SAVE_SCHEMA_VERSION, contentVersion: 2, savedAtTick: 1, guestCount: 0, cash: 0, rating: 0, sizeBytes: 1, revision: 3, writerTabId: 's', status: { state: 'ok' },
    };
    const detection = decideRecovery([{ marker: marker as never, evidence: 'lock-free' }], autosave as never);
    expect(detection.kind === 'offer' && detection.offer.mode).toBe('scenario');
    const legacy = decideRecovery([{ marker: { ...marker, gameMode: undefined } as never, evidence: 'lock-free' }], { ...autosave, mode: undefined } as never);
    expect(legacy.kind === 'offer' && legacy.offer.mode).toBeUndefined();
  });

  it('the kept autosave names its mode', () => {
    expect(recoveredSlotName('scenario')).toBe('Recovered autosave (Scenario)');
    expect(recoveredSlotName('run')).toBe('Recovered autosave (The Map)');
    expect(recoveredSlotName()).toBe('Recovered autosave');
    expect(isRecoveredSlotName('Recovered autosave (Sandbox)')).toBe(true);
    expect(isRecoveredSlotName('My recovered park')).toBe(false);
  });

  it('a hand-edited mode in a save is refused on load, never trusted', () => {
    const session = new ParkSession(null);
    const state = JSON.parse(JSON.stringify(session.serialize()));
    state.mode = 'scenario';
    expect(() => ParkSession.fromState(state)).toThrow(SaveError);
  });
});

describe('the frozen v9 saves (written before game modes existed)', () => {
  const fixtures = import.meta.glob<Record<string, unknown>>('../game/save/fixtures/park-v9-*.json', { import: 'default', eager: true });
  const expected: Array<[string, 'sandbox' | 'scenario']> = [
    ['park-v9-sandbox-meadow.json', 'sandbox'],
    ['park-v9-sandbox-generated.json', 'sandbox'],
    ['park-v9-scenario.json', 'scenario'],
    ['park-v9-tour.json', 'scenario'],
  ];

  it('the four fixtures are all there', () => {
    expect(Object.keys(fixtures).map((key) => key.split('/').pop()).sort()).toEqual(expected.map(([name]) => name).sort());
  });

  it.each(expected)('%s loads as %s, empty grant, and its row reads the legacy mode', async (name, mode) => {
    const payload = structuredClone(fixtures[`../game/save/fixtures/${name}`]) as { scenarioId: string | null; savedAtEpochMs: number; schemaVersion: number; contentVersion: number; savedAtTick: number; app: { clock: { simulationTimeMs: number }; tourNodeId: string | null } };
    const store = new MemorySaveStore();
    await store.write('manual-1', payload, {
      id: 'manual-1', kind: 'manual', name, scenarioId: payload.scenarioId as never, scenarioName: payload.scenarioId ?? 'Sandbox park',
      playtimeSeconds: payload.app.clock.simulationTimeMs / 1000, savedAt: payload.savedAtEpochMs, schemaVersion: 9, contentVersion: payload.contentVersion,
      savedAtTick: payload.savedAtTick, guestCount: 0, cash: 0, rating: 0, sizeBytes: 1, revision: 0, writerTabId: 'old', status: { state: 'ok' },
    });
    const { game } = await makeGame({ store });
    await settle();
    const row = (await store.list()).find((meta) => meta.id === 'manual-1')!;
    expect(row.mode, 'an old row has no mode field').toBeUndefined();
    expect(slotMode(row)).toBe(mode);
    const { saveBridge } = await import('./gameBridge');
    const result = await saveBridge.load('manual-1');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const session = internals(game).session;
    expect(session.mode).toBe(mode);
    expect(session.grant).toEqual({ unlockedBuildingIds: [], bonusIds: [] });
    expect(ui().sessionMode).toBe(mode);
    game.destroy();
  });
});

describe('the frozen v10 saves (written before The Map runs existed, Phase 23)', () => {
  const fixtures = import.meta.glob<Record<string, unknown>>('../game/save/fixtures/park-v10-*.json', { import: 'default', eager: true });
  // The interim The Map (mode run on a Park Tour scenario) continues as a Scenario park; the rest keep their mode.
  const expected: Array<[string, 'sandbox' | 'scenario']> = [
    ['park-v10-sandbox-meadow.json', 'sandbox'],
    ['park-v10-sandbox-generated.json', 'sandbox'],
    ['park-v10-scenario.json', 'scenario'],
    ['park-v10-scenario-biome.json', 'scenario'],
    ['park-v10-run-tour.json', 'scenario'],
  ];

  it('the five fixtures are all there', () => {
    expect(Object.keys(fixtures).map((key) => key.split('/').pop()).sort()).toEqual(expected.map(([name]) => name).sort());
  });

  it.each(expected)('%s loads through the app as %s, keeps its park, and is saved again as schema 11 without a run', async (name, mode) => {
    const payload = structuredClone(fixtures[`../game/save/fixtures/${name}`]) as {
      scenarioId: string | null; savedAtEpochMs: number; contentVersion: number; savedAtTick: number;
      app: { clock: { simulationTimeMs: number }; tourNodeId: string | null };
      state: { world: { tick: number; cash: number } };
    };
    const store = new MemorySaveStore();
    await store.write('manual-1', payload, {
      id: 'manual-1', kind: 'manual', name, scenarioId: payload.scenarioId as never, scenarioName: payload.scenarioId ?? 'Sandbox park',
      mode: name === 'park-v10-run-tour.json' ? 'run' : mode, playtimeSeconds: payload.app.clock.simulationTimeMs / 1000, savedAt: payload.savedAtEpochMs, schemaVersion: 10,
      contentVersion: payload.contentVersion, savedAtTick: payload.savedAtTick, guestCount: 0, cash: 0, rating: 0, sizeBytes: 1, revision: 0, writerTabId: 'old', status: { state: 'ok' },
    });
    const { game } = await makeGame({ store });
    await settle();
    const { saveBridge } = await import('./gameBridge');
    const result = await saveBridge.load('manual-1');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const session = internals(game).session;
    expect(session.mode).toBe(mode);
    expect(session.run, 'no run state appears out of nowhere').toBeNull();
    expect(ui().sessionMode).toBe(mode);
    expect(ui().run).toBeNull();
    expect(ui().runView).toBeNull();
    expect(game.world.tick).toBe(payload.state.world.tick);
    expect(game.world.cash).toBe(payload.state.world.cash);
    expect(game.clock.speed, 'a loaded park starts paused').toBe(0);
    const again = await saveBridge.saveToSlot('manual-2', 'Again');
    expect(again.ok).toBe(true);
    const written = (await store.read('manual-2')).payload as { schemaVersion: number; state: { run?: unknown; mode: string }; app: { tourNodeId: string | null } };
    expect(written.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(Object.hasOwn(written.state, 'run')).toBe(false);
    expect(written.state.mode).toBe(mode);
    expect(written.app.tourNodeId, 'the retired tour node is never written again').toBeNull();
    game.destroy();
  });
});
