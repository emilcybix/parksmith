import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryDetection, RecoveryMonitor, RecoveryParkInfo } from './saves/recoveryTypes';

/**
 * Phase 22 adversarial review (profile, save and rules safety through GameApp). `it.fails` marks a confirmed finding:
 * the test asserts what the spec asks for and fails today; drop `.fails` once it is fixed. Harness copied from
 * GameApp.modes.test.ts.
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
const { useUiStore, NO_MENU_PREVIEW } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');
const { RECOVERY_MONITOR_HOLDER_KEY } = await import('./saves/recoveryMonitor');
const { resetSettings } = await import('../settings');
const { PROFILE_STORAGE_KEY, serializeProfile, freshProfile } = await import('../game/profile/schema');

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
  session: import('../game/session/ParkSession').ParkSession;
  guests: { spawnGuests(count: number): number };
  
  currentNodeId: string | null;
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

const clearedProfile = (ids: string[]) => knownProfile({
  scenarios: Object.fromEntries(ids.map((id) => [id, { clears: 1, attempts: 1, bestClearSeconds: 100, bestProgressPercent: 100, firstClearVia: 'scenario' }])),
});

describe('review: a locked scenario cannot be played or cleared through any start path', () => {
  it('Scenario mode refuses a locked scenario (baseline)', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'sandbox' });
    game.startPark({ mode: 'scenario', scenarioId: 'harvest-festival', cardIds: [] });
    expect(internals(game).session.mode).toBe('sandbox');
    game.destroy();
  });

  it('FIXED: gameBridge.startScenario cannot start a locked scenario (it is Scenario mode, with its unlock)', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'sandbox' });
    gameBridge.startScenario('frost-fair', []);
    expect(internals(game).session.scenarioDefinition?.id ?? null).toBeNull();
    game.destroy();
  });

});

describe('review: a park keeps the bonuses and unlocks it started with', () => {
  it('a saved Scenario park with Nest egg loads with Nest egg into a profile that lacks it, and without it into one that has it', async () => {
    const first = await makeGame({ profile: knownProfile({ bonusIds: ['nest-egg'] }) });
    first.game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    expect(internals(first.game).session.grant.bonusIds).toEqual(['nest-egg']);
    const cash = first.game.world.cash;
    const { saveBridge } = await import('./gameBridge');
    expect((await saveBridge.saveToSlot('manual-1', 'with bonus')).ok).toBe(true);
    first.game.destroy();

    // Same save store, a profile WITHOUT the bonus (another browser profile, a reset): the park keeps its snapshot.
    const second = await makeGame({ profile: knownProfile(), store: first.store });
    second.game.startPark({ mode: 'sandbox' });
    expect((await saveBridge.load('manual-1')).ok).toBe(true);
    expect(internals(second.game).session.grant.bonusIds).toEqual(['nest-egg']);
    expect(second.game.world.cash).toBe(cash);
    second.game.destroy();
  });

  it('turning the switch off mid-park never changes the park in progress (rules, grant, cash)', async () => {
    const { game } = await makeGame({ profile: knownProfile({ bonusIds: ['nest-egg', 'builders-discount'] }) });
    game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
    const rules = JSON.stringify(internals(game).session.rules);
    const grant = JSON.stringify(internals(game).session.grant);
    gameBridge.setUseBonuses('scenario', false);
    runFrames(3, 250);
    expect(JSON.stringify(internals(game).session.rules)).toBe(rules);
    expect(JSON.stringify(internals(game).session.grant)).toBe(grant);
    game.destroy();
  });

  it('an unlock earned in another tab does not reach a park in progress, but reaches the next one', async () => {
    const { game, profile } = await makeGame({ profile: clearedProfile(['sunny-start']) });
    game.startPark({ mode: 'sandbox' });
    const running = internals(game).session;
    const other = { ...freshProfile(), ui: { mapSeen: true, tourOffered: true }, unlockedBuildingIds: ['tiki-tumbler'],
      scenarios: { 'sunny-start': { clears: 1, attempts: 1, bestClearSeconds: 100, bestProgressPercent: 100, firstClearVia: 'scenario' as const },
        'boardwalk-breeze': { clears: 1, attempts: 1, bestClearSeconds: 100, bestProgressPercent: 100, firstClearVia: 'scenario' as const } } };
    const text = serializeProfile(other as ReturnType<typeof freshProfile>);
    profile.map.set(PROFILE_STORAGE_KEY, text);
    for (const handler of handlers.get('storage') ?? []) handler({ key: PROFILE_STORAGE_KEY, newValue: text });
    expect(ui().profile?.unlockedBuildingIds).toContain('tiki-tumbler');
    expect(running.buildLockOf('tiki-tumbler')?.kind).toBe('profile');
    game.startPark({ mode: 'sandbox' });
    expect(internals(game).session.buildLockOf('tiki-tumbler')).toBeNull();
    game.destroy();
  });
});

describe('review: unlock gating in the live app', () => {
  it('a locked gated building is refused by the build tool, leaves cash and world untouched, and is not in a fresh profile\'s HUD as buildable', async () => {
    const { game } = await makeGame();
    game.startPark({ mode: 'sandbox' });
    const session = internals(game).session;
    game.world.addMoney(100_000);
    const before = game.world.objects.size;
    const cash = game.world.cash;
    for (const id of ['tiki-tumbler', 'cactus-cooler', 'cocoa-chalet', 'lantern-maple']) {
      expect(session.buildLockOf(id)?.kind, id).toBe('profile');
      for (let x = 0; x < 30; x += 3) {
        for (let y = 0; y < 30; y += 3) expect(game.world.buildObject(id, { x, y })).toBeNull();
      }
      expect(ui().profileLocks[id], id).toMatch(/^Clear .+ in Scenario mode$/);
    }
    expect(game.world.objects.size).toBe(before);
    expect(game.world.cash).toBe(cash);
    game.destroy();
  });
});
