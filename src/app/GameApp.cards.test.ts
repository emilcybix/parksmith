import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryDetection, RecoveryMonitor, RecoveryParkInfo } from './saves/recoveryTypes';

/**
 * Phase 25 (design 3.3-3.6, 11.1 "App"): one-shot cards played through GameApp. The play goes through the run bridge
 * (toast, ledger, the run untouched), is one undo step that rewinds it, is refused on the backdrop, twice and after the
 * result, survives a save and the autosave with its pending cost, and settles into the run: an unplayed card returns,
 * a played one stays used, and a cost still pending comes off the next level's starting cash. Harness as in
 * GameApp.run.test.ts.
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
const { forceStageOutcomeForDevelopment, planRun, runHash } = await import('../game/run');

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

type Ledger = { playedIds(order: readonly string[]): string[]; unpaidTotal(): number; hasPlayed(id: string): boolean };
const plays = (game: Game): Ledger => (internals(game).session as unknown as { plays: Ledger }).plays;
const cash = (game: Game): number => game.world.cash;
const saveVersion = (game: Game): number => (game as unknown as { saveHost: { worldVersion(): number } }).saveHost.worldVersion();
const undoDepth = (game: Game): number => (game as unknown as { undo: { depth: number } }).undo.depth;
const cardState = (id: string) => ui().activeCards.find((card) => card.id === id);

/** The first seed whose deck before level 1 (starter + the first offer) holds `cardId`: robust to a retuned plan. */
const seedWith = (cardId: string): number => {
  for (let seed = 1; seed < 5_000; seed += 1) {
    const plan = planRun({ seed, difficulty: 'standard' });
    if ([...plan.starterDeck, ...plan.levels[0].offer].includes(cardId as never)) return seed;
  }
  throw new Error(`no seed offers ${cardId} before level 1`);
};

/** Starts a run on a seed that has the card, accepts the offer and starts level 1 with that card alone. */
const stageWith = async (cardId: string, options: Parameters<typeof makeGame>[0] = {}) => {
  const made = await makeGame(options);
  runBridge.startRun(seedWith(cardId), 'standard');
  runBridge.acceptRunOffer();
  runBridge.startRunStage([cardId]);
  expect(run(made.game)).toMatchObject({ phase: 'stage', loadout: [cardId] });
  return made;
};

const finishStage = (game: Game, outcome: 'succeeded' | 'failed'): void => {
  forceStageOutcomeForDevelopment(internals(game).session as never, outcome);
  runFrames(2, 1000);
};

const LOAN = 'bridging-loan';

/** Loads a slot like the Save / Load dialog does: replacing a live unfinished run asks first, and "Leave the run" loads for real. */
const loadSlot = async (game: Game, slotId: string): Promise<void> => {
  const before = internals(game).session;
  const result = await saveBridge.load(slotId as never);
  if (!result.ok) {
    expect(ui().leaveRunPrompt, result.error.message).toEqual({ reason: 'load' });
    runBridge.resolveLeaveRun('leave');
    for (let i = 0; i < 400 && internals(game).session === before; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await settle();
  }
};

/** Runs the park at speed 1 until the loan's repayment fell due (its tick), still inside the stage. */
const runUntilRepaid = (game: Game): void => {
  game.setSpeed(1);
  for (let guard = 0; guard < 5_000 && plays(game).unpaidTotal() > 0 && run(game).phase === 'stage'; guard += 1) runFrames(1, 1000);
  expect(run(game).phase, 'the stage is still running').toBe('stage');
};

describe('playing a one-shot', () => {
  it('through the bridge: the effect, a toast, the ledger and the HUD state, the run itself untouched', async () => {
    const { game } = await stageWith(LOAN);
    const before = runHash(run(game));
    const cashBefore = cash(game);
    expect(cardState(LOAN)).toMatchObject({ playState: 'ready', playable: true });
    runBridge.playCard(LOAN);
    expect(cash(game), 'the loan pays out at once').toBe(cashBefore + 2_000);
    expect(ui().toast).toMatch(/^Played Bridging Loan · /);
    expect(plays(game).playedIds(run(game).loadout)).toEqual([LOAN]);
    expect(plays(game).unpaidTotal()).toBe(2_400);
    expect(cardState(LOAN)).toMatchObject({ playState: 'played', playable: false });
    expect(cardState(LOAN)?.pending?.amount).toBe(-2_400);
    expect(runHash(run(game)), 'a play never changes the run').toBe(before);
    game.destroy();
  });

  it('is one undo step: the entry is named after the card and rewinds the play (the card is ready again)', async () => {
    const { game } = await stageWith(LOAN);
    const before = runHash(run(game));
    const cashBefore = cash(game);
    expect(undoDepth(game)).toBe(0);
    runBridge.playCard(LOAN);
    expect(undoDepth(game), 'a play moves no world version, yet it leaves an entry').toBe(1);
    expect(ui().undoStatus.target).toBe('Bridging Loan played');
    gameBridge.requestUndo();
    expect(plays(game).hasPlayed(LOAN)).toBe(false);
    expect(cash(game)).toBe(cashBefore);
    expect(cardState(LOAN)).toMatchObject({ playState: 'ready', playable: true });
    expect(runHash(run(game))).toBe(before);
    // and it can be played again after the rewind
    runBridge.playCard(LOAN);
    expect(plays(game).hasPlayed(LOAN)).toBe(true);
    game.destroy();
  });

  it('marks the park unsaved (the save layer\'s version moves)', async () => {
    const { game } = await stageWith(LOAN);
    const version = saveVersion(game);
    runBridge.playCard(LOAN);
    expect(saveVersion(game)).not.toBe(version);
    game.destroy();
  });

  it('works while paused', async () => {
    const { game } = await stageWith(LOAN);
    game.setSpeed(0);
    runBridge.playCard(LOAN);
    expect(plays(game).hasPlayed(LOAN)).toBe(true);
    game.destroy();
  });
});

describe('refusals', () => {
  it('twice: the second play says so and changes nothing', async () => {
    const { game } = await stageWith(LOAN);
    runBridge.playCard(LOAN);
    const cashAfter = cash(game);
    const depth = undoDepth(game);
    runBridge.playCard(LOAN);
    expect(ui().toast).toBe('Bridging Loan was already played this level');
    expect(cash(game)).toBe(cashAfter);
    expect(undoDepth(game), 'a refused play leaves no undo entry').toBe(depth);
    game.destroy();
  });

  it('a one-shot that cannot be played now toasts the session\'s reason', async () => {
    const { game } = await stageWith('fireworks-night');
    expect(game.guests.guests.size).toBe(0);
    expect(cardState('fireworks-night')).toMatchObject({ playState: 'ready', playable: false, hint: 'No guests yet' });
    runBridge.playCard('fireworks-night');
    expect(ui().toast).toBe('No guests yet');
    expect(plays(game).hasPlayed('fireworks-night')).toBe(false);
    expect(undoDepth(game)).toBe(0);
    game.destroy();
  });

  it('a card outside the loadout, an unknown id and a stage card are refused', async () => {
    const { game } = await stageWith(LOAN);
    runBridge.playCard('coach-party');
    expect(ui().toast).toBe("That card is not in this level's loadout");
    runBridge.playCard('no-such-card');
    expect(ui().toast).toBe('That card does not exist');
    expect(plays(game).playedIds(run(game).loadout)).toEqual([]);
    game.destroy();
  });

  it('on the backdrop between stages and after the result: refused, nothing changes', async () => {
    const { game } = await stageWith(LOAN);
    finishStage(game, 'succeeded');
    expect(run(game).phase).toBe('offer');
    const ledger = plays(game).playedIds([LOAN]);
    runBridge.playCard(LOAN);
    expect(ui().toast).toBe('One-shot cards are played during a level');
    expect(plays(game).playedIds([LOAN])).toEqual(ledger);
    game.destroy();
  });

  it('after the stage result latched but before it reached the run: the session says the level is over', async () => {
    const { game } = await stageWith(LOAN);
    forceStageOutcomeForDevelopment(internals(game).session as never, 'succeeded');
    runBridge.playCard(LOAN);
    expect(plays(game).hasPlayed(LOAN)).toBe(false);
    expect(ui().toast).toBe('The level is over');
    game.destroy();
  });
});

describe('settlement: plays and debt reach the run', () => {
  it('a cleared stage with an unplayed one-shot returns it to the deck', async () => {
    const { game } = await stageWith(LOAN);
    finishStage(game, 'succeeded');
    const entry = run(game).history[0];
    expect(entry).toMatchObject({ outcome: 'succeeded', cardIds: [LOAN], playedCardIds: [], unpaidDebt: 0 });
    expect(run(game).deck).toContain(LOAN);
    expect(run(game).usedPile.map((used) => used.cardId)).not.toContain(LOAN);
    game.destroy();
  });

  it('a played one-shot stays used, and its cost still pending comes off the next level\'s starting cash', async () => {
    const { game } = await stageWith(LOAN);
    runBridge.playCard(LOAN);
    runFrames(3, 1000);
    finishStage(game, 'succeeded');
    const entry = run(game).history[0];
    expect(entry).toMatchObject({ playedCardIds: [LOAN], unpaidDebt: 2_400 });
    expect(run(game).usedPile).toContainEqual({ cardId: LOAN, levelIndex: 0 });
    expect(run(game).deck).not.toContain(LOAN);
    expect(ui().run?.levels[0].result?.unpaidDebt).toBe(2_400);
    // Level 2 starts with its planned cash minus the debt.
    const planned = run(game).levels[1].startingCash;
    runBridge.continueAfterStage();
    runBridge.acceptRunOffer();
    runBridge.startRunStage([]);
    expect(run(game)).toMatchObject({ phase: 'stage', levelIndex: 1 });
    expect(cash(game)).toBe(Math.max(0, planned - 2_400));
    game.destroy();
  });

  it('a cost that fell due inside the stage is paid there and leaves no debt', async () => {
    const { game } = await stageWith(LOAN);
    runBridge.playCard(LOAN);
    runUntilRepaid(game);
    expect(plays(game).unpaidTotal(), 'repaid after 240 s of park time').toBe(0);
    expect(game.world.tick).toBeGreaterThanOrEqual(2_400);
    finishStage(game, 'succeeded');
    expect(run(game).history[0]).toMatchObject({ playedCardIds: [LOAN], unpaidDebt: 0 });
    game.destroy();
  });

  it('abandon inside a stage records the plays and the debt; abandon between stages records none', async () => {
    const { game } = await stageWith(LOAN);
    runBridge.playCard(LOAN);
    runBridge.abandonRun();
    expect(run(game).phase).toBe('lost');
    expect(run(game).history.at(-1)).toMatchObject({ outcome: 'abandoned', playedCardIds: [LOAN], unpaidDebt: 2_400 });
    game.destroy();

    const second = await stageWith(LOAN);
    runBridge.playCard(LOAN);
    finishStage(second.game, 'succeeded');
    runBridge.abandonRun();
    expect(run(second.game).history.at(-1)).toMatchObject({ outcome: 'abandoned', playedCardIds: [], unpaidDebt: 0 });
    second.game.destroy();
  });

  it('a failed stage records its plays too', async () => {
    const { game } = await stageWith(LOAN);
    runBridge.playCard(LOAN);
    finishStage(game, 'failed');
    expect(run(game).phase).toBe('lost');
    expect(run(game).history[0]).toMatchObject({ outcome: 'failed', playedCardIds: [LOAN], unpaidDebt: 2_400 });
    game.destroy();
  });
});

describe('saves', () => {
  it('a save mid-stage after a play reloads the ledger and its pending cost, and the cost still falls due', async () => {
    const { game } = await stageWith(LOAN);
    runBridge.playCard(LOAN);
    runFrames(5, 1000);
    const tick = game.world.tick;
    const pending = cardState(LOAN)?.pending;
    expect((await saveBridge.saveToSlot('manual-1', 'Played')).ok).toBe(true);
    const hash = runHash(run(game));
    await loadSlot(game, 'manual-1');
    expect(game.world.tick).toBe(tick);
    expect(runHash(run(game))).toBe(hash);
    expect(plays(game).playedIds(run(game).loadout)).toEqual([LOAN]);
    expect(cardState(LOAN)?.pending).toEqual(pending);
    runBridge.playCard(LOAN);
    expect(ui().toast, 'still played once only').toBe('Bridging Loan was already played this level');
    runUntilRepaid(game);
    expect(plays(game).unpaidTotal()).toBe(0);
    game.destroy();
  });

  it('crash recovery: the autosave holds the play and its pending cost', async () => {
    const store = new MemorySaveStore();
    const first = await stageWith(LOAN, { store });
    runBridge.playCard(LOAN);
    await (first.game as unknown as { saves: { autosaveNow(): Promise<unknown> } }).saves.autosaveNow();
    const hash = runHash(run(first.game));
    first.game.destroy();

    const second = await makeGame({ store, startMenu: true });
    await settle();
    await runBridge.continueRun();
    expect(run(second.game)).toMatchObject({ phase: 'stage', loadout: [LOAN] });
    expect(runHash(run(second.game))).toBe(hash);
    expect(plays(second.game).unpaidTotal()).toBe(2_400);
    expect(ui().activeCards.find((card) => card.id === LOAN)?.playState).toBe('played');
    second.game.destroy();
  });

  it('a stage result only the save holds is settled on load with the save\'s plays and debt', async () => {
    const { game } = await stageWith(LOAN);
    runBridge.playCard(LOAN);
    forceStageOutcomeForDevelopment(internals(game).session as never, 'succeeded');
    expect((await saveBridge.saveToSlot('manual-1', 'Interrupted')).ok).toBe(true);
    game.startPark({ mode: 'sandbox' });
    runBridge.resolveLeaveRun('leave');
    expect((await saveBridge.load('manual-1')).ok).toBe(true);
    expect(run(game)).toMatchObject({ phase: 'offer', levelIndex: 1 });
    expect(run(game).history[0]).toMatchObject({ outcome: 'succeeded', playedCardIds: [LOAN], unpaidDebt: 2_400 });
    game.destroy();
  });
});
