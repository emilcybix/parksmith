import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryDetection, RecoveryMonitor, RecoveryParkInfo } from './saves/recoveryTypes';

/**
 * The Map as GameApp wires it (Phase 23): new run, offer, loadout, stage, result, next level, victory and failure, the
 * profile's run record, the leave-run prompt, Continue, the save round trip at every phase, the undo boundary and the
 * hold between stages. The pure rules are tested in src/game/run; this file pins the app's lifecycle around them.
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
const { gameBridge, saveBridge } = await import('./gameBridge');
const { runBridge } = await import('../ui/runBridge');
const { useUiStore, NO_MENU_PREVIEW } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');
const { RECOVERY_MONITOR_HOLDER_KEY } = await import('./saves/recoveryMonitor');
const { resetSettings } = await import('../settings');
const { PROFILE_STORAGE_KEY, serializeProfile, freshProfile } = await import('../game/profile/schema');
const { forceStageOutcomeForDevelopment, createRun, runHash } = await import('../game/run');
const { GAME_CONFIG } = await import('../game/config');
const { latestRunSlot } = await import('./runSlots');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();
let windowStub: Record<string, unknown>;
const host = {} as HTMLElement;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const fakeMonitor = (): RecoveryMonitor & { started: RecoveryParkInfo[] } => ({
  sessionId: 'tab-run',
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
const knownProfile = (patch: Record<string, unknown> = {}) => memoryStorage({
  [PROFILE_STORAGE_KEY]: serializeProfile({ ...freshProfile(), ui: { mapSeen: true, tourOffered: true }, ...patch } as ReturnType<typeof freshProfile>),
});

type Game = InstanceType<typeof GameApp>;
interface Internals {
  session: {
    mode: string;
    run: import('../game/run').RunState | null;
    scenarioDefinition: { id: string; name: string } | null;
    activeCards: Array<{ id: string }>;
    serialize(): unknown;
  };
}
const internals = (game: Game): Internals => game as unknown as Internals;

const makeGame = async (options: { profile?: ReturnType<typeof memoryStorage>; store?: InstanceType<typeof MemorySaveStore>; startMenu?: boolean } = {}) => {
  const monitor = fakeMonitor();
  windowStub[RECOVERY_MONITOR_HOLDER_KEY] = monitor;
  const store = options.store ?? new MemorySaveStore();
  const profile = options.profile ?? knownProfile();
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, { kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined }),
    startMenu: options.startMenu ?? false,
    profileStorage: profile,
  });
  await game.mount(host);
  await settle();
  return { game, monitor, profile, store };
};

const runFrames = (count: number, deltaMs = 1000): void => { for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs); };
const ui = () => useUiStore.getState();
const run = (game: Game) => internals(game).session.run!;

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
    run: null, runView: null, runLoadoutSelection: [], runRewards: null, leaveRunPrompt: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetSettings();
});

const SEED = 4242;

/** Loads a slot like the Save / Load dialog does: replacing a live unfinished run asks first, and "Leave the run" loads for real. */
const loadSlot = async (game: Game, slotId: string): Promise<void> => {
  const before = internals(game).session;
  const result = await saveBridge.load(slotId as never);
  if (!result.ok) {
    expect(ui().leaveRunPrompt, result.error.message).toEqual({ reason: 'load' });
    runBridge.resolveLeaveRun('leave');
    // The load that follows "Leave the run" is asynchronous: wait for the new session instead of a fixed number of ticks.
    for (let i = 0; i < 400 && internals(game).session === before; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await settle();
  }
};

/** New run -> offer accepted -> a loadout of the first `count` distinct deck cards -> the stage is running. */
const intoStage = (game: Game, count = 0): void => {
  if (run(game).phase === 'offer') runBridge.acceptRunOffer();
  const deck = [...new Set(run(game).deck)];
  runBridge.startRunStage(deck.slice(0, Math.min(count, run(game).levels[run(game).levelIndex].slots)));
};

/** Latches the stage's result through the development hook and lets the next step hand it to the app. */
const finishStage = (game: Game, outcome: 'succeeded' | 'failed'): void => {
  forceStageOutcomeForDevelopment(internals(game).session as never, outcome);
  runFrames(2, 1000);
};

/** Clears every remaining level with the hook, taking each offer and an empty loadout, up to and including the win. */
const winRun = (game: Game): void => {
  for (let guard = 0; guard < 60 && run(game).phase !== 'won' && run(game).phase !== 'lost'; guard += 1) {
    if (run(game).phase === 'stage') finishStage(game, 'succeeded');
    else if (ui().runView === 'stage-result') runBridge.continueAfterStage();
    else intoStage(game, 0);
  }
};

describe('starting a run', () => {
  it('builds the run, a frozen paused first park, the run map, and counts the start', async () => {
    const { game, monitor } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    const session = internals(game).session;
    expect(session.mode).toBe('run');
    expect(session.scenarioDefinition?.id).toBe('the-map-stage');
    expect(session.scenarioDefinition?.name).toMatch(/^Level 1 · Meadow$/);
    expect(run(game)).toMatchObject({ seed: SEED, difficulty: 'standard', phase: 'offer', levelIndex: 0, parkLevelIndex: 0, loadout: [] });
    expect(run(game).levels).toHaveLength(GAME_CONFIG.run.levelCount);
    expect(game.clock.speed, 'the backdrop never runs').toBe(0);
    expect(ui().sessionMode).toBe('run');
    expect(ui().run?.seed).toBe(SEED);
    expect(ui().runView).toBe('map');
    expect(ui().runRewards).toBeNull();
    expect(ui().profile?.runs.started).toBe(1);
    expect(ui().profile?.stats.run.parksStarted, 'a stage is counted when it starts, not the run').toBe(0);
    expect(monitor.started.at(-1)).toMatchObject({ mode: 'run', scenarioId: null });
    expect(ui().toast).toContain(`seed ${SEED}`);
    game.destroy();
  });

  it('is the same run for the same seed and difficulty, whatever the profile', async () => {
    const first = await makeGame();
    runBridge.startRun(SEED, 'standard');
    const a = structuredClone(run(first.game));
    first.game.destroy();
    const second = await makeGame({ profile: knownProfile({ bonusIds: ['nest-egg'] }) });
    runBridge.startRun(SEED, 'standard');
    const b = structuredClone(run(second.game));
    expect({ ...b, grant: null }).toEqual({ ...a, grant: null });
    expect(b.grant.bonusIds, 'the grant is the only thing the profile changes').toEqual(['nest-egg']);
    second.game.destroy();
  });

  it('refuses a bad seed, an unknown difficulty and a locked Tough, and the live park stays', async () => {
    const { game } = await makeGame();
    const session = internals(game).session;
    for (const [seed, difficulty] of [[-1, 'standard'], [1.5, 'standard'], [2 ** 32, 'standard'], [Number.NaN, 'standard'], [5, 'impossible']] as const) {
      runBridge.startRun(seed, difficulty as never);
      expect(internals(game).session, `${seed} ${difficulty}`).toBe(session);
    }
    runBridge.startRun(5, 'tough');
    expect(internals(game).session).toBe(session);
    expect(ui().toast).toContain('Win a Standard run');
    expect(ui().profile?.runs.started).toBe(0);
    game.destroy();
  });

  it('Tough starts once the profile has a Standard victory', async () => {
    const profile = knownProfile({ runs: { started: 1, victories: { relaxed: 0, standard: 1, tough: 0 }, losses: { relaxed: 0, standard: 0, tough: 0 }, bestLevel: { relaxed: 0, standard: 5, tough: 0 }, recentRunKeys: [] } });
    const { game } = await makeGame({ profile });
    runBridge.startRun(5, 'tough');
    expect(run(game).difficulty).toBe('tough');
    game.destroy();
  });

  it('snapshots the profile grant once: a bonus earned later never reaches a run in progress', async () => {
    const { game } = await makeGame({ profile: knownProfile({ bonusIds: ['nest-egg'] }) });
    runBridge.startRun(SEED, 'standard');
    expect(run(game).grant.bonusIds).toEqual(['nest-egg']);
    expect(ui().runBonusIds).toEqual(['nest-egg']);
    gameBridge.setUseBonuses('run', false);
    expect(run(game).grant.bonusIds).toEqual(['nest-egg']);
    game.destroy();
  });
});

describe('the hold between stages', () => {
  it('refuses speed, undo and world input while the run map is the screen', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    game.setSpeed(2);
    expect(game.clock.speed).toBe(0);
    const version = game.world.version;
    gameBridge.requestUndo();
    expect(ui().toast).toBe('Undo works inside a level');
    expect(game.world.version).toBe(version);
    game.setSpeed(0);
    runFrames(10, 1000);
    expect(game.world.tick, 'nothing steps behind the run map').toBe(0);
    game.destroy();
  });

  it('is not "running" for the save layer, and lifts when the stage starts', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    runBridge.acceptRunOffer();
    game.setSpeed(1);
    expect(game.clock.speed, 'the loadout phase is still a hold').toBe(0);
    runBridge.startRunStage([]);
    expect(game.clock.speed).toBe(1);
    game.setSpeed(2);
    expect(game.clock.speed).toBe(2);
    game.destroy();
  });
});

describe('offer, loadout and the stage', () => {
  it('accepting the offer adds every offered card to the deck and opens the loadout', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    const before = run(game).deck.length;
    const offer = run(game).levels[0].offer;
    runBridge.acceptRunOffer();
    expect(run(game).phase).toBe('loadout');
    expect(run(game).deck).toHaveLength(before + offer.length);
    expect(run(game).offersSeen).toEqual([0]);
    expect(ui().runView).toBe('loadout');
    expect(ui().run?.deckSize).toBe(before + offer.length);
    runBridge.acceptRunOffer();
    expect(run(game).deck, 'a second accept does nothing').toHaveLength(before + offer.length);
    game.destroy();
  });

  it('a stage is a NEW park on the level map with the chosen cards, which leave the deck when it starts', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    const backdrop = internals(game).session;
    runBridge.acceptRunOffer();
    const pick = [...new Set(run(game).deck)].slice(0, run(game).levels[0].slots);
    const deckBefore = run(game).deck.length;
    runBridge.startRunStage(pick);
    const session = internals(game).session;
    expect(session).not.toBe(backdrop);
    expect(run(game).phase).toBe('stage');
    expect(session.activeCards.map((card) => card.id)).toEqual(pick);
    expect(run(game).loadout).toEqual(pick);
    expect(run(game).deck).toHaveLength(deckBefore - pick.length);
    expect(run(game).usedPile.map((used) => used.cardId)).toEqual(pick);
    expect(game.clock.speed).toBe(1);
    expect(ui().runView, 'the park is on screen').toBeNull();
    expect(ui().scenario?.objective).toBeDefined();
    expect(ui().profile?.stats.run.parksStarted).toBe(1);
    expect(ui().toast).toContain('Level 1');
    game.destroy();
  });

  it('refuses a loadout that is too big, has a card twice or one the deck lacks, and starts nothing', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    runBridge.acceptRunOffer();
    const backdrop = internals(game).session;
    const deck = [...new Set(run(game).deck)];
    runBridge.startRunStage([...deck, ...deck, 'not-a-card']);
    expect(internals(game).session).toBe(backdrop);
    runBridge.startRunStage([deck[0], deck[0]]);
    expect(internals(game).session).toBe(backdrop);
    runBridge.startRunStage(['not-a-card']);
    expect(internals(game).session).toBe(backdrop);
    expect(run(game).phase).toBe('loadout');
    game.destroy();
  });

  it('a stage cannot start before the offer is accepted, and an offer cannot be taken in a stage', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    const backdrop = internals(game).session;
    runBridge.startRunStage([]);
    expect(internals(game).session).toBe(backdrop);
    intoStage(game);
    const deck = run(game).deck.length;
    runBridge.acceptRunOffer();
    expect(run(game).deck).toHaveLength(deck);
    game.destroy();
  });
});

describe('a stage result moves the run', () => {
  it('a clear: the run advances to the next offer, the ring is empty, the park is frozen, the stage-result screen opens', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    // an undoable edit exists inside the stage
    game.world.addMoney(1);
    finishStage(game, 'succeeded');
    expect(run(game)).toMatchObject({ phase: 'offer', levelIndex: 1, parkLevelIndex: 0 });
    expect(run(game).history).toHaveLength(1);
    expect(run(game).history[0]).toMatchObject({ levelIndex: 0, outcome: 'succeeded' });
    expect(ui().runView).toBe('stage-result');
    expect(ui().run?.levelsCleared).toBe(1);
    expect(game.clock.speed).toBe(0);
    expect(ui().scenarioRewards, 'a stage grants no scenario result').toBeNull();
    expect(ui().rewardDraft, 'and no reward draft').toBeNull();
    expect(ui().profile?.stats.run.wins, 'a stage is not a run: wins count runs').toBe(0);
    expect(ui().profile?.clearedScenarioIds, 'a stage never clears a scenario').toEqual([]);
    gameBridge.requestUndo();
    expect(ui().toast).toBe('Undo works inside a level');
    game.destroy();
  });

  it('Continue to The Map shows the map; the next offer, loadout and stage are level 2 on its own map', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    const first = internals(game).session.scenarioDefinition?.name;
    finishStage(game, 'succeeded');
    runBridge.continueAfterStage();
    expect(ui().runView).toBe('map');
    runBridge.continueAfterStage();
    expect(ui().runView, 'Continue only means something on the result').toBe('map');
    intoStage(game, 1);
    expect(run(game)).toMatchObject({ phase: 'stage', levelIndex: 1, parkLevelIndex: 1 });
    expect(internals(game).session.scenarioDefinition?.name).toMatch(/^Level 2 · /);
    expect(internals(game).session.scenarioDefinition?.name).not.toBe(first);
    expect(run(game).usedPile).toHaveLength(1);
    game.destroy();
  });

  it('a failure ends the run: lost, the end screen, a loss and the best level in the profile, no cards discovered', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    finishStage(game, 'succeeded');
    runBridge.continueAfterStage();
    intoStage(game);
    finishStage(game, 'failed');
    expect(run(game).phase).toBe('lost');
    expect(run(game).history.map((entry) => entry.outcome)).toEqual(['succeeded', 'failed']);
    expect(ui().runView).toBe('end');
    expect(ui().runRewards).toMatchObject({ outcome: 'lost', eligible: true, newBestLevel: true, bestLevel: 1, newlyDiscoveredCardIds: [] });
    expect(ui().profile?.runs.losses.standard).toBe(1);
    expect(ui().profile?.runs.bestLevel.standard).toBe(1);
    expect(ui().profile?.stats.run.losses).toBe(1);
    expect(game.clock.speed).toBe(0);
    game.destroy();
  });

  it('clearing the last level is the victory: won, rewards (discovered cards, Tough), and never raw power', async () => {
    const profile = knownProfile();
    const { game } = await makeGame({ profile });
    runBridge.startRun(SEED, 'standard');
    const before = structuredClone(ui().profile!);
    winRun(game);
    expect(run(game).phase).toBe('won');
    expect(run(game).history).toHaveLength(GAME_CONFIG.run.levelCount);
    expect(ui().runView).toBe('end');
    const rewards = ui().runRewards!;
    expect(rewards).toMatchObject({ outcome: 'won', eligible: true, bestLevel: GAME_CONFIG.run.levelCount, newBestLevel: true });
    expect(rewards.newlyUnlockedDifficulties).toEqual(['tough']);
    const after = ui().profile!;
    expect(after.runs.victories.standard).toBe(1);
    expect(after.stats.run.wins).toBe(1);
    expect(after.collectionCardIds.length).toBeGreaterThanOrEqual(before.collectionCardIds.length);
    expect(after.bonusIds, 'no raw power').toEqual(before.bonusIds);
    expect(after.unlockedBuildingIds).toEqual(before.unlockedBuildingIds);
    expect(JSON.parse(profile.map.get(PROFILE_STORAGE_KEY)!).runs.victories.standard).toBe(1);
    game.destroy();
  });

  it('Try this seed again is a fresh run with the same levels, and a better attempt counts', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    const plan = structuredClone(run(game).levels);
    intoStage(game);
    finishStage(game, 'failed');
    expect(ui().profile?.runs.bestLevel.standard).toBe(0);
    runBridge.runEndAction('same-seed');
    expect(run(game)).toMatchObject({ phase: 'offer', levelIndex: 0, seed: SEED });
    expect(run(game).levels).toEqual(plan);
    expect(ui().runView).toBe('map');
    expect(ui().profile?.runs.started).toBe(2);
    intoStage(game);
    finishStage(game, 'succeeded');
    runBridge.continueAfterStage();
    intoStage(game);
    finishStage(game, 'failed');
    expect(ui().runRewards, 'the second attempt is its own record').toMatchObject({ alreadyRecorded: false, newBestLevel: true, bestLevel: 1 });
    expect(ui().profile?.runs.losses.standard).toBe(2);
    game.destroy();
  });

  it('a run whose plan was edited plays and ends, but earns and records nothing', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    const levels = run(game).levels as Array<{ timeLimitDays: number }>;
    levels[0].timeLimitDays += 1;
    intoStage(game);
    finishStage(game, 'failed');
    expect(ui().runRewards).toMatchObject({ eligible: false });
    expect(ui().profile?.runs.losses.standard).toBe(0);
    game.destroy();
  });

  it('the end of a run is recorded once: a late duplicate event changes nothing', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    finishStage(game, 'failed');
    const losses = ui().profile!.runs.losses.standard;
    (game as unknown as { handleScenarioEvents(events: unknown[]): void }).handleScenarioEvents([{ kind: 'scenarioFailed', scenarioId: 'the-map-stage', atSeconds: 5, evidence: 'late' }]);
    expect(ui().profile?.runs.losses.standard).toBe(losses);
    expect(run(game).history).toHaveLength(1);
    game.destroy();
  });
});

describe('abandoning', () => {
  it('inside a stage: lost with the park seconds, the cards stay used, a loss is counted', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    runBridge.acceptRunOffer();
    const card = run(game).deck[0];
    runBridge.startRunStage([card]);
    runFrames(6, 1000);
    runBridge.abandonRun();
    expect(run(game).phase).toBe('lost');
    expect(run(game).history.at(-1)).toMatchObject({ outcome: 'abandoned', cardIds: [card] });
    expect(run(game).history.at(-1)!.atSeconds).toBeGreaterThan(0);
    expect(ui().runView).toBe('end');
    expect(ui().profile?.runs.losses.standard).toBe(1);
    expect(game.clock.speed).toBe(0);
    game.destroy();
  });

  it('at the run map: lost at the level reached with an empty entry', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    runBridge.abandonRun();
    expect(run(game).phase).toBe('lost');
    expect(run(game).history.at(-1)).toMatchObject({ outcome: 'abandoned', atSeconds: 0, cardIds: [] });
    expect(ui().runView).toBe('end');
    runBridge.abandonRun();
    expect(run(game).history, 'a finished run cannot be abandoned again').toHaveLength(1);
    game.destroy();
  });

  it('a run from another generator version ends as abandoned with no loss counted', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    // The run state is frozen once it is in a session: swap in a copy made by "another build".
    const holder = internals(game).session as unknown as { runState: import('../game/run').RunState };
    const other = structuredClone(holder.runState);
    (other.levels[0].recipe as { generatorVersion: number }).generatorVersion = 999;
    holder.runState = other;
    runBridge.acceptRunOffer();
    runBridge.startRunStage([]);
    expect(run(game).phase).toBe('lost');
    expect(run(game).history.at(-1)).toMatchObject({ outcome: 'abandoned' });
    expect(ui().toast).toContain('generator');
    expect(ui().profile?.runs.losses.standard).toBe(0);
    expect(ui().runView).toBe('end');
    game.destroy();
  });
});

describe('the run map overlay', () => {
  it('open and close: a stage pauses behind the map and closing goes back to the paused park', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    game.setSpeed(2);
    runBridge.openRunMap();
    expect(ui().runView).toBe('map');
    expect(game.clock.speed).toBe(0);
    runBridge.closeRunMap();
    expect(ui().runView).toBeNull();
    expect(ui().menuKind).toBeNull();
    expect(game.clock.speed, 'the player presses play').toBe(0);
    game.destroy();
  });

  it('between stages, closing the map opens the pause menu over the frozen backdrop', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    runBridge.closeRunMap();
    expect(ui().runView).toBeNull();
    expect(ui().menuKind).toBe('pause');
    runBridge.openRunMap();
    expect(ui().runView).toBe('map');
    expect(ui().menuKind, 'the menu gives way to the map').toBeNull();
    game.destroy();
  });

  it('the pause menu of a run opens The Map as the run map; with no run it opens the setup panel', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'sandbox' });
    game.openPauseMenu();
    gameBridge.menuOpenTheMap();
    expect(ui().menuPanel).toBe('the-map');
    game.resumeFromMenu();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    game.openPauseMenu();
    gameBridge.menuOpenTheMap();
    expect(ui().menuKind).toBeNull();
    expect(ui().runView).toBe('map');
    game.destroy();
  });

  it('Escape: the run screen layers close one at a time, a decision is never dismissed, the hub closes into the pause menu', async () => {
    const { game } = await makeGame();
    const press = (key: string): void => {
      const event = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault: () => undefined };
      for (const handler of handlers.get('keydown') ?? []) handler(event);
    };
    runBridge.startRun(SEED, 'standard');
    ui().setRunView('offer');
    press('Escape');
    expect(ui().runView).toBe('map');
    intoStage(game);
    finishStage(game, 'succeeded');
    expect(ui().runView).toBe('stage-result');
    press('Escape');
    expect(ui().runView, 'the stage result is answered with its button').toBe('stage-result');
    runBridge.continueAfterStage();
    press('Escape');
    // The hub between stages closes into the pause menu over the frozen backdrop (Save, Load and Settings live there).
    expect(ui().runView).toBeNull();
    expect(ui().menuKind).toBe('pause');
    game.destroy();
  });
});

describe('leaving an unfinished run', () => {
  it('a new park asks first; Cancel keeps the run, Leave goes on, and Save first opens Save / Load and keeps the question', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    const session = internals(game).session;
    game.startPark({ mode: 'sandbox' });
    expect(ui().leaveRunPrompt).toEqual({ reason: 'new-park' });
    expect(internals(game).session).toBe(session);
    runBridge.resolveLeaveRun('cancel');
    expect(ui().leaveRunPrompt).toBeNull();
    expect(internals(game).session).toBe(session);
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    expect(ui().leaveRunPrompt).toEqual({ reason: 'scenario' });
    runBridge.resolveLeaveRun('save-first');
    expect(ui().savesDialogOpen).toBe(true);
    expect(ui().leaveRunPrompt, 'the prompt waits for the next answer').not.toBeNull();
    useUiStore.getState().closeSavesDialog();
    runBridge.resolveLeaveRun('leave');
    expect(ui().leaveRunPrompt).toBeNull();
    expect(internals(game).session.mode).toBe('scenario');
    game.destroy();
  });

  it('a new run asks first too, and a finished run does not', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    runBridge.startRun(SEED + 1, 'standard');
    expect(ui().leaveRunPrompt).toEqual({ reason: 'new-run' });
    expect(run(game).seed).toBe(SEED);
    runBridge.resolveLeaveRun('leave');
    expect(run(game).seed).toBe(SEED + 1);
    runBridge.abandonRun();
    game.startPark({ mode: 'sandbox' });
    expect(ui().leaveRunPrompt, 'nothing to lose').toBeNull();
    expect(internals(game).session.mode).toBe('sandbox');
    game.destroy();
  });

  it('loading from the Save / Load dialog closes the dialog so the question is on top, and reports no failure', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    expect((await saveBridge.saveToSlot('manual-1', 'Keep')).ok).toBe(true);
    runBridge.startRun(SEED + 1, 'standard');
    runBridge.resolveLeaveRun('leave');
    useUiStore.getState().openSavesDialog();
    const result = await saveBridge.load('manual-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code, 'not "busy": nothing failed').toBe('deferred');
    expect(ui().savesDialogOpen, 'the dialog no longer covers the question').toBe(false);
    expect(ui().leaveRunPrompt).toEqual({ reason: 'load' });
    runBridge.resolveLeaveRun('cancel');
    expect(run(game).seed).toBe(SEED + 1);
    game.destroy();
  });

  it('on the start screen a new run, park or Scenario asks before it replaces the run only the autosave holds', async () => {
    const store = new MemorySaveStore();
    const first = await makeGame({ store });
    runBridge.startRun(SEED, 'standard');
    runBridge.acceptRunOffer();
    runFrames(8, 1000);
    await settle();
    runFrames(8, 1000);
    await settle();
    expect((await store.list()).find((row) => row.id === 'autosave')?.run).toMatchObject({ seed: SEED, levelNumber: 1 });
    first.game.destroy();

    const second = await makeGame({ store, startMenu: true });
    await settle();
    expect(ui().menuKind).toBe('start');
    const backdrop = internals(second.game).session;
    runBridge.startRun(9999, 'standard');
    expect(ui().leaveRunPrompt).toMatchObject({ reason: 'new-run', saved: { seed: SEED, levelNumber: 1, phase: 'loadout' } });
    expect(internals(second.game).session, 'nothing replaced yet').toBe(backdrop);
    runBridge.resolveLeaveRun('cancel');
    expect(ui().leaveRunPrompt).toBeNull();
    expect(ui().menuKind).toBe('start');
    second.game.startPark({ mode: 'sandbox' });
    expect(ui().leaveRunPrompt).toMatchObject({ reason: 'new-park', saved: { seed: SEED } });
    runBridge.resolveLeaveRun('cancel');
    second.game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    expect(ui().leaveRunPrompt).toMatchObject({ reason: 'scenario' });
    runBridge.resolveLeaveRun('cancel');
    expect(internals(second.game).session).toBe(backdrop);
    runBridge.startRun(9999, 'standard');
    runBridge.resolveLeaveRun('leave');
    expect(run(second.game).seed, 'Leave starts the new run').toBe(9999);
    second.game.destroy();

    // Continuing the autosaved run itself asks nothing.
    const third = await makeGame({ store, startMenu: true });
    await settle();
    // The start screen reads the newest save for its backdrop (SaveManager.loadPreview) after boot. That read holds the
    // manager's load lock WITHOUT showing in busy.loading, and a load that starts meanwhile is refused as 'busy': under
    // full-suite load the settle above sometimes ended before the read did, continueRun failed and the starter sandbox
    // stayed. Wait for the backdrop itself (menuPreview 'ready' is published only after the read has finished).
    const saves = (third.game as unknown as { saves: { snapshot(): { slots: Parameters<typeof latestRunSlot>[0]; busy: { loading: unknown } } } }).saves;
    const ready = (): boolean => ui().menuPreview.phase === 'ready' && latestRunSlot(saves.snapshot().slots) !== null && saves.snapshot().busy.loading === null;
    for (let i = 0; i < 500 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const why = (): string => JSON.stringify({
      menuPreview: ui().menuPreview, menuNotice: ui().menuNotice, busy: saves.snapshot().busy,
      slots: saves.snapshot().slots.map((slot) => ({ id: slot.id, run: slot.run, status: slot.status })),
    });
    expect(ready(), `the start screen is settled: ${why()}`).toBe(true);
    await runBridge.continueRun();
    expect(ui().leaveRunPrompt).toBeNull();
    expect(internals(third.game).session.mode, `Continue run loaded the autosaved run: ${why()}`).toBe('run');
    third.game.destroy();
  });

  it('a stale answer with no question does nothing', async () => {
    const { game } = await makeGame();
    runBridge.resolveLeaveRun('leave');
    expect(ui().leaveRunPrompt).toBeNull();
    game.destroy();
  });
});

describe('undo inside a stage never touches the run', () => {
  it('the run hash is the same after every rewind, and the ring is empty at the boundary', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    const before = runHash(run(game));
    game.world.addMoney(10_000);
    for (let i = 0; i < 4; i += 1) {
      const object = game.world.buildObject('ribbon-bench', { x: 10 + i * 2, y: 12 });
      void object;
    }
    const app = game as unknown as { undo: { depth: number } };
    expect(runHash(run(game))).toBe(before);
    gameBridge.requestUndo();
    gameBridge.requestUndo();
    expect(runHash(run(game))).toBe(before);
    finishStage(game, 'succeeded');
    expect(app.undo.depth, 'a result clears the ring').toBe(0);
    game.destroy();
  });
});

describe('saves: the run travels with the park', () => {
  it('a save carries the run summary in its row and loads back at every phase', async () => {
    const { game, store } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    const save = async (name: string) => { expect((await saveBridge.saveToSlot(name as never, name)).ok).toBe(true); };
    await save('manual-1');
    runBridge.acceptRunOffer();
    await save('manual-2');
    intoStage(game, 1);
    runFrames(5, 250);
    const tick = game.world.tick;
    await save('manual-3');
    finishStage(game, 'succeeded');
    await save('manual-4');
    const rows = await store.list();
    expect(rows.find((row) => row.id === 'manual-1')?.run).toMatchObject({ seed: SEED, levelNumber: 1, phase: 'offer', levelsCleared: 0 });
    expect(rows.find((row) => row.id === 'manual-3')?.run).toMatchObject({ phase: 'stage', levelNumber: 1 });
    expect(rows.find((row) => row.id === 'manual-4')?.run).toMatchObject({ phase: 'offer', levelNumber: 2, levelsCleared: 1 });

    await loadSlot(game, 'manual-1');
    expect(run(game).phase).toBe('offer');
    expect(ui().runView, 'at the run map').toBe('map');
    expect(game.clock.speed).toBe(0);

    await loadSlot(game, 'manual-2');
    expect(run(game).phase).toBe('loadout');
    expect(ui().runView).toBe('map');

    await loadSlot(game, 'manual-3');
    expect(run(game).phase).toBe('stage');
    expect(run(game).loadout).toHaveLength(1);
    expect(ui().runView, 'mid-stage: straight back in the park').toBeNull();
    expect(game.clock.speed, 'a loaded park starts paused').toBe(0);
    expect(game.world.tick).toBe(tick);
    expect(internals(game).session.activeCards).toHaveLength(1);
    // and the stage plays on to its result
    game.setSpeed(1);
    finishStage(game, 'succeeded');
    expect(run(game)).toMatchObject({ phase: 'offer', levelIndex: 1 });

    await loadSlot(game, 'manual-4');
    expect(run(game)).toMatchObject({ phase: 'offer', levelIndex: 1, parkLevelIndex: 0 });
    expect(ui().runView).toBe('map');
    expect(ui().run?.levelsCleared).toBe(1);
    game.destroy();
  });

  it('loading another save over a live unfinished run asks first; Cancel keeps the run and its park', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    expect((await saveBridge.saveToSlot('manual-1', 'Keep')).ok).toBe(true);
    const session = internals(game).session;
    const refused = await saveBridge.load('manual-1');
    expect(refused.ok).toBe(false);
    expect(ui().leaveRunPrompt).toEqual({ reason: 'load' });
    runBridge.resolveLeaveRun('cancel');
    expect(internals(game).session).toBe(session);
    await loadSlot(game, 'manual-1');
    expect(internals(game).session, 'Leave loads for real').not.toBe(session);
    expect(run(game).phase).toBe('offer');
    game.destroy();
  });

  it('a finished run loads on its end screen and is not recorded twice', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    finishStage(game, 'failed');
    expect((await saveBridge.saveToSlot('manual-1', 'Over')).ok).toBe(true);
    const losses = ui().profile!.runs.losses.standard;
    game.startPark({ mode: 'sandbox' });
    expect((await saveBridge.load('manual-1')).ok).toBe(true);
    expect(run(game).phase).toBe('lost');
    expect(ui().runView).toBe('end');
    expect(ui().runRewards, 'the lines were shown when it ended').toBeNull();
    expect(ui().profile?.runs.losses.standard).toBe(losses);
    game.destroy();
  });

  it('a stage that ended while the run never heard of it is settled on load', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    // The result latches in the scenario but no step ever delivers it (a hand-made or interrupted file).
    forceStageOutcomeForDevelopment(internals(game).session as never, 'succeeded');
    expect((await saveBridge.saveToSlot('manual-1', 'Interrupted')).ok).toBe(true);
    game.startPark({ mode: 'sandbox' });
    runBridge.resolveLeaveRun('leave');
    game.startPark({ mode: 'sandbox' });
    expect((await saveBridge.load('manual-1')).ok).toBe(true);
    expect(run(game)).toMatchObject({ phase: 'offer', levelIndex: 1 });
    expect(run(game).history[0]).toMatchObject({ outcome: 'succeeded' });
    expect(ui().runView).toBe('stage-result');
    game.destroy();
  });

  it('a last-level result that only the save holds settles the run as won but records no victory', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    const last = GAME_CONFIG.run.levelCount - 1;
    for (let guard = 0; guard < 60 && !(run(game).levelIndex === last && run(game).phase === 'stage'); guard += 1) {
      if (run(game).phase === 'stage') finishStage(game, 'succeeded');
      else if (ui().runView === 'stage-result') runBridge.continueAfterStage();
      else intoStage(game, 0);
    }
    expect(run(game)).toMatchObject({ levelIndex: last, phase: 'stage' });
    // Latched in the scenario, never delivered: the save is the only witness of the win.
    forceStageOutcomeForDevelopment(internals(game).session as never, 'succeeded');
    expect((await saveBridge.saveToSlot('manual-1', 'Claimed win')).ok).toBe(true);
    const victories = ui().profile!.runs.victories.standard;
    game.startPark({ mode: 'sandbox' });
    runBridge.resolveLeaveRun('leave');
    expect((await saveBridge.load('manual-1')).ok).toBe(true);
    expect(run(game).phase).toBe('won');
    expect(ui().runView).toBe('end');
    expect(ui().runRewards?.eligible, 'shown as not eligible').toBe(false);
    expect(ui().profile?.runs.victories.standard, 'a result only the save claims pays nothing').toBe(victories);
    game.destroy();
  });

  it('the autosave holds the run: it appears after a boundary and Continue run loads it', async () => {
    const store = new MemorySaveStore();
    const first = await makeGame({ store });
    runBridge.startRun(SEED, 'standard');
    runBridge.acceptRunOffer();
    runFrames(8, 1000);
    await settle();
    runFrames(8, 1000);
    await settle();
    const autosave = (await store.list()).find((row) => row.id === 'autosave');
    expect(autosave?.mode).toBe('run');
    expect(autosave?.run).toMatchObject({ seed: SEED, phase: 'loadout', levelNumber: 1 });
    first.game.destroy();

    const second = await makeGame({ store, startMenu: true });
    await settle();
    expect(useUiStore.getState().menuKind).toBe('start');
    await runBridge.continueRun();
    expect(internals(second.game).session.mode).toBe('run');
    expect(run(second.game)).toMatchObject({ seed: SEED, phase: 'loadout' });
    expect(ui().runView).toBe('map');
    expect(ui().menuKind).toBeNull();
    second.game.destroy();
  });

  it('the start screen\'s ordinary Continue resumes a run save at its screen too (the previewed park is adopted)', async () => {
    const store = new MemorySaveStore();
    const first = await makeGame({ store });
    runBridge.startRun(SEED, 'standard');
    runBridge.acceptRunOffer();
    intoStage(first.game, 1);
    runFrames(4, 250);
    expect((await saveBridge.saveToSlot('manual-1', 'Mid stage')).ok).toBe(true);
    await settle();
    first.game.destroy();
    const second = await makeGame({ store, startMenu: true });
    await settle();
    expect(ui().menuKind).toBe('start');
    expect(ui().runView, 'the run screens stay shut behind the start screen').toBeNull();
    await gameBridge.menuContinue();
    expect(ui().menuKind).toBeNull();
    expect(run(second.game)).toMatchObject({ phase: 'stage', levelIndex: 0 });
    expect(ui().runView, 'mid-stage: back in the park').toBeNull();
    expect(second.game.clock.speed).toBe(0);
    expect(internals(second.game).session.activeCards).toHaveLength(1);
    second.game.destroy();
  });

  it('Continue run with no run to continue leaves a notice and starts nothing', async () => {
    const { game } = await makeGame({ startMenu: true });
    await settle();
    await runBridge.continueRun();
    expect(ui().menuNotice).toContain('no run');
    expect(internals(game).session.mode).not.toBe('run');
    game.destroy();
  });

  it('latestRunSlot picks the newest unfinished readable run save', () => {
    const base = {
      kind: 'manual', name: 'x', scenarioId: 'the-map-stage', scenarioName: 'x', mode: 'run', playtimeSeconds: 0, savedAt: 1, schemaVersion: 11, contentVersion: 1,
      savedAtTick: 0, guestCount: 0, cash: 0, rating: 0, sizeBytes: 1, revision: 1, writerTabId: 't', status: { state: 'ok' },
    };
    const summary = (phase: string, levelNumber = 1) => ({ seed: 1, difficulty: 'standard', levelNumber, levelCount: 5, biomeId: 'meadow', phase, levelsCleared: 0 });
    const rows = [
      { ...base, id: 'manual-1', savedAt: 10, run: summary('offer') },
      { ...base, id: 'manual-2', savedAt: 30, run: summary('lost') },
      { ...base, id: 'manual-3', savedAt: 20, run: summary('stage', 2) },
      { ...base, id: 'manual-4', savedAt: 40, mode: 'scenario' },
      { ...base, id: 'manual-5', savedAt: 50, run: summary('offer'), status: { state: 'unreadable', code: 'meta-corrupt', message: 'x' } },
      { ...base, id: 'manual-6', savedAt: 60 },
    ];
    expect(latestRunSlot(rows as never)?.id).toBe('manual-3');
    expect(latestRunSlot([])).toBeNull();
    expect(latestRunSlot(rows.slice(1, 2) as never)).toBeNull();
  });
});

describe('end of run actions', () => {
  it('New run leaves for the start screen on The Map setup; Main menu leaves for the start screen, with the run in the autosave', async () => {
    const store = new MemorySaveStore();
    const { game } = await makeGame({ store });
    runBridge.startRun(SEED, 'standard');
    await settle();
    runBridge.abandonRun();
    runBridge.runEndAction('new-run');
    await settle();
    // No "save before you leave?": the end of the run was written to the autosave on the way out.
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPanel).toBe('the-map');
    expect(ui().runView).toBeNull();
    const autosave = (await store.list()).find((row) => row.id === 'autosave');
    expect(autosave?.run).toMatchObject({ seed: SEED, phase: 'lost' });
    game.destroy();
    const other = await makeGame();
    runBridge.startRun(SEED, 'standard');
    runBridge.abandonRun();
    runBridge.runEndAction('main-menu');
    await settle();
    expect(ui().menuKind).toBe('start');
    expect(ui().menuPanel).toBe('main');
    other.game.destroy();
  });

  it('the run map\'s Main menu between stages writes the autosave and leaves; inside a stage it asks like the pause menu does', async () => {
    const store = new MemorySaveStore();
    const { game } = await makeGame({ store });
    runBridge.startRun(SEED, 'standard');
    await settle();
    runBridge.acceptRunOffer();
    runBridge.runEndAction('main-menu');
    await settle();
    expect(ui().menuKind).toBe('start');
    const autosave = (await store.list()).find((row) => row.id === 'autosave');
    expect(autosave?.run, 'the loadout phase was written on the way out').toMatchObject({ seed: SEED, phase: 'loadout' });
    await runBridge.continueRun();
    expect(run(game).phase).toBe('loadout');
    intoStage(game, 0);
    game.world.addMoney(5);
    runBridge.openRunMap();
    runBridge.runEndAction('main-menu');
    expect(ui().menuKind, 'inside a stage the pause menu quit flow runs').toBe('pause');
    expect(['quit', 'main']).toContain(ui().menuPanel);
    game.destroy();
  });

  it('same-seed and new-run mean nothing while the run goes on', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    const session = internals(game).session;
    runBridge.runEndAction('same-seed');
    runBridge.runEndAction('new-run');
    expect(internals(game).session).toBe(session);
    expect(ui().menuKind).toBeNull();
    game.destroy();
  });
});

describe('the recovery marker and the profile are not disturbed', () => {
  it('a run park tells the recovery monitor its mode and stage name, and the profile reads the same after a reload', async () => {
    const { game, monitor, profile } = await makeGame();
    runBridge.startRun(SEED, 'standard');
    intoStage(game);
    expect(monitor.started.at(-1)).toMatchObject({ mode: 'run', scenarioId: null });
    expect(monitor.started.at(-1)?.parkName).toMatch(/^Level 1 · /);
    game.destroy();
    const stored = JSON.parse(profile.map.get(PROFILE_STORAGE_KEY)!);
    expect(stored.runs.started).toBe(1);
    expect(stored.version).toBe(2);
  });

  it('createRun here and in the app agree (the app adds nothing to the plan)', async () => {
    const { game } = await makeGame();
    runBridge.startRun(SEED, 'relaxed');
    const direct = createRun({ seed: SEED, difficulty: 'relaxed', grant: { unlockedBuildingIds: run(game).grant.unlockedBuildingIds, bonusIds: [] } });
    expect(runHash(run(game))).toBe(runHash(direct));
    game.destroy();
  });
});
