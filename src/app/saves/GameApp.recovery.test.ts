import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryDetection, RecoveryMonitor, RecoveryParkInfo } from './recoveryTypes';

/**
 * GameApp's interrupted-session wiring, in the manager test's style (fake renderer, stubbed window,
 * MemorySaveStore behind the real manager and controller). The monitor is a fake planted where
 * `getOrCreateRecoveryMonitor` looks, so what is pinned is only what GameApp owns: the autosave is
 * held from construction, detection runs once after the slot list exists, Resume goes through the
 * normal load flow, and a park start and a page hide reach the monitor.
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
const { recoveryBridge } = await import('../gameBridge');
const { useUiStore } = await import('../../ui/store');
const { MemorySaveStore } = await import('./memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./SaveManager');
const { START_AUTOSAVE_DELAY_SECONDS } = await import('./constants');
const { RECOVERY_MONITOR_HOLDER_KEY } = await import('./recoveryMonitor');
const { isRecoveredSlotName } = await import('./recoveryTypes');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();
let windowStub: Record<string, unknown>;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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

const plant = (monitor: FakeMonitor): void => { windowStub[RECOVERY_MONITOR_HOLDER_KEY] = monitor; };

const makeGame = async (store: InstanceType<typeof MemorySaveStore>) => {
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, {
      kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined,
    }),
  });
  await game.mount({} as HTMLElement);
  await settle();
  return game;
};

const runFrames = (count: number): void => { for (let i = 0; i < count; i += 1) frameCallback?.(1000); };

/** A first run that leaves an autosave behind, written by `tabId`. */
const interruptedRun = async (store: InstanceType<typeof MemorySaveStore>, tabId: string) => {
  const monitor = fakeMonitor(tabId);
  plant(monitor);
  const game = await makeGame(store);
  game.startScenario(null);
  await settle(); // the park-start rescan holds the autosave until it has looked at the other tabs
  game.world.addMoney(1234);
  runFrames(START_AUTOSAVE_DELAY_SECONDS + 1);
  await settle();
  const cashAtAutosave = game.world.cash;
  game.destroy();
  return { monitor, cashAtAutosave };
};

beforeEach(() => {
  frameCallback = null;
  handlers = new Map();
  const register = (type: string, handler: Handler): void => { handlers.set(type, [...(handlers.get(type) ?? []), handler]); };
  windowStub = {
    addEventListener: register,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('document', { addEventListener: register, removeEventListener: () => undefined, visibilityState: 'visible' });
  useUiStore.getState().setToast(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GameApp interrupted-session recovery', () => {
  it('tells the monitor about a started park and marks the tab clean on pagehide, which is not a crash', async () => {
    const monitor = fakeMonitor('tab-a');
    plant(monitor);
    const game = await makeGame(new MemorySaveStore());
    expect(monitor.started, 'merely opening the game registers nothing').toEqual([]);
    game.startScenario(null);
    expect(monitor.started).toEqual([{ parkName: 'Sandbox park', scenarioId: null, mode: 'sandbox' }]);
    for (const handler of handlers.get('pagehide') ?? []) handler({});
    expect(monitor.cleaned, 'pagehide removes the marker through the monitor').toBeGreaterThanOrEqual(1);
    game.destroy();
  });

  it('holds the autosave while an offer is open, so a new park cannot overwrite it', async () => {
    const store = new MemorySaveStore();
    const { cashAtAutosave } = await interruptedRun(store, 'tab-crashed');
    const before = (await store.list()).find((row) => row.id === 'autosave')!;
    const monitor = fakeMonitor('tab-new');
    const autosave = before;
    monitor.detection = {
      kind: 'offer',
      offer: {
        interruptedSessionIds: ['tab-crashed'], sessionId: 'tab-crashed', parkName: 'Sandbox park', scenarioId: null,
        startedAt: 1, lastSeenAt: 2, evidence: 'lock-free',
        autosave: {
          name: autosave.name, scenarioName: autosave.scenarioName, savedAt: autosave.savedAt, playtimeSeconds: autosave.playtimeSeconds,
          guestCount: autosave.guestCount, cash: autosave.cash, rating: autosave.rating, revision: autosave.revision,
        },
      },
    };
    plant(monitor);
    const game = await makeGame(store);
    expect(useUiStore.getState().recovery.phase).toBe('offered');
    game.startScenario(null);
    runFrames(START_AUTOSAVE_DELAY_SECONDS * 3);
    await settle();
    const after = (await store.list()).find((row) => row.id === 'autosave')!;
    expect(after.revision, 'no autosave was written while the offer was pending').toBe(before.revision);

    const result = await recoveryBridge.resume();
    expect(result.ok, 'Resume loads the autosave through the normal load flow').toBe(true);
    await settle();
    expect(game.world.cash, 'the loaded park is the interrupted one').toBe(cashAtAutosave);
    expect(game.clock.speed, 'a loaded park starts paused').toBe(0);
    expect(useUiStore.getState().recovery.phase).toBe('idle');
    expect(monitor.forgotten, 'the interrupted marker is forgotten once resolved').toEqual([['tab-crashed']]);
    expect(monitor.started.length, 'the resumed park registers with the monitor').toBeGreaterThanOrEqual(2);
    game.destroy();
  });

  it('Not now keeps the old autosave in a manual slot and lets the new park autosave afterwards', async () => {
    const store = new MemorySaveStore();
    await interruptedRun(store, 'tab-crashed');
    const old = (await store.list()).find((row) => row.id === 'autosave')!;
    const monitor = fakeMonitor('tab-new');
    monitor.detection = {
      kind: 'offer',
      offer: {
        interruptedSessionIds: ['tab-crashed'], sessionId: 'tab-crashed', parkName: 'Sandbox park', scenarioId: null,
        startedAt: 1, lastSeenAt: 2, evidence: 'lock-free',
        autosave: {
          name: old.name, scenarioName: old.scenarioName, savedAt: old.savedAt, playtimeSeconds: old.playtimeSeconds,
          guestCount: old.guestCount, cash: old.cash, rating: old.rating, revision: old.revision,
        },
      },
    };
    plant(monitor);
    const game = await makeGame(store);
    game.startScenario(null);
    const dismissed = await recoveryBridge.dismiss();
    expect(dismissed.ok).toBe(true);
    const rows = await store.list();
    const kept = rows.find((row) => isRecoveredSlotName(row.name));
    expect(kept?.savedAt, 'the old autosave survived under its new slot').toBe(old.savedAt);
    expect(rows.some((row) => row.id === 'autosave'), 'the autosave slot is free again').toBe(false);
    runFrames(START_AUTOSAVE_DELAY_SECONDS + 1);
    await settle();
    expect((await store.list()).some((row) => row.id === 'autosave'), 'the new park autosaves once the offer is resolved').toBe(true);
    game.destroy();
  });
});
