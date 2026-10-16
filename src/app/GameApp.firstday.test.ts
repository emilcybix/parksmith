import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParkSession } from '../game/session/ParkSession';

/**
 * GameApp's side of the First Day UI: the skip and dismiss commands, the world markers it hands the
 * renderer, the first-run Parks map and the one-time Park Tour offer. Same style as the undo test:
 * fake renderer, stubbed window, real manager over a memory store.
 */

const markerCalls: Array<ReadonlyArray<{ cells: ReadonlyArray<{ x: number; y: number }> }>> = [];
let frameCallback: ((deltaMs: number) => void) | null = null;

class FakeRenderer {
  get hoveredCell() { return null; }
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
  setHintMarkers(markers: typeof markerCalls[number]): void { markerCalls.push(markers.map((marker) => ({ cells: [...marker.cells] }))); }
  drawCoasterDraft(): void {}
}

vi.mock('./rendererFlag', () => ({
  RENDERER_KIND: 'classic', LIGHT_PRESET: 'day', LIGHT_OVERRIDE: null, TIME_OVERRIDE: null, ZOOM_OVERRIDE: null, ALLOW_SOFTWARE_GPU: false, VOXEL_GPU_MIN: false,
}));
vi.mock('../rendering/WorldRenderer', () => ({ WorldRenderer: FakeRenderer }));

const { GameApp } = await import('./GameApp');
const { gameBridge } = await import('./gameBridge');
const { runBridge } = await import('../ui/runBridge');
const { useUiStore } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');

const PROFILE_KEY = 'parksmith-profile';
const STORED_PROFILE = JSON.stringify({ version: 1, discoveredCardIds: [], tour: {} });

let storage = new Map<string, string>();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const makeGame = async () => {
  const store = new MemorySaveStore();
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

interface Internals {
  session: ParkSession;
}
const internals = (game: unknown) => game as Internals;
const runFrames = (count: number, deltaMs = 250): void => {
  for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs);
};
const lastMarkers = () => markerCalls[markerCalls.length - 1];

const stubWindow = (seed: Record<string, string>): void => {
  storage = new Map(Object.entries(seed));
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  });
  vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined, visibilityState: 'visible' });
};

beforeEach(() => {
  markerCalls.length = 0;
  frameCallback = null;
  useUiStore.setState({ scenarioPickerOpen: false, loadoutScenarioId: null, mapOfferPending: false, runView: null, cleanView: false });
  useUiStore.getState().selectPointer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('First Day commands', () => {
  beforeEach(() => stubWindow({ [PROFILE_KEY]: STORED_PROFILE }));

  it('skip reaches the tracker and the store at once, without waiting for a frame', async () => {
    const game = await makeGame();
    const before = useUiStore.getState().onboarding!;
    expect(before.currentStepId).toBe('lay-path');
    gameBridge.skipOnboardingStep();
    expect(internals(game).session.onboardingSnapshot()!.steps[0].status).toBe('skipped');
    const after = useUiStore.getState().onboarding!;
    expect(after.steps[0].status).toBe('skipped');
    expect(after.currentStepId).toBe('first-ride');
    game.destroy();
  });

  it('dismiss reaches the tracker and the store at once and switches the world marker off', async () => {
    const game = await makeGame();
    expect(lastMarkers()).toEqual([{ cells: [{ x: 15, y: 31 }] }]);
    gameBridge.dismissOnboarding();
    expect(internals(game).session.onboardingSnapshot()!.dismissed).toBe(true);
    expect(useUiStore.getState().onboarding!.dismissed).toBe(true);
    expect(lastMarkers()).toEqual([]);
    game.destroy();
  });

  it('points at the gate on a fresh park and at the path tip once a path is laid', async () => {
    const game = await makeGame();
    expect(lastMarkers()).toEqual([{ cells: [{ x: 15, y: 31 }] }]);
    game.world.buildPaths([{ x: 15, y: 30 }, { x: 15, y: 29 }]);
    runFrames(2);
    expect(lastMarkers()).toEqual([{ cells: [{ x: 15, y: 29 }] }]);
    game.destroy();
  });

  it('hides the marker in clean view and behind a modal, and brings it back', async () => {
    const game = await makeGame();
    useUiStore.getState().toggleCleanView();
    expect(lastMarkers()).toEqual([]);
    useUiStore.getState().toggleCleanView();
    expect(lastMarkers()).toHaveLength(1);
    useUiStore.getState().openScenarioLoadout('sunny-start');
    expect(lastMarkers()).toEqual([]);
    useUiStore.getState().closeScenarioPicker();
    expect(lastMarkers()).toHaveLength(1);
    game.destroy();
  });

  it('calls the renderer only when the markers change', async () => {
    const game = await makeGame();
    runFrames(8);
    const calls = markerCalls.length;
    runFrames(8);
    expect(markerCalls.length).toBe(calls);
    game.destroy();
  });

  it('advances the card when the player builds while paused, without waiting for the clock', async () => {
    const game = await makeGame();
    game.setSpeed(0);
    game.world.buildPaths([30, 29, 28, 27, 26, 25, 24].map((y) => ({ x: 15, y })));
    // Any UI sync follows a real build; hiring is the simplest public one.
    game.hireStaff('cleaner');
    const snapshot = useUiStore.getState().onboarding!;
    expect(snapshot.steps[0].status).toBe('done');
    expect(snapshot.currentStepId).toBe('first-ride');
    game.destroy();
  });

  it('bumps the park epoch for a new park but not for the same park', async () => {
    const game = await makeGame();
    const epoch = useUiStore.getState().parkEpoch;
    game.startScenario(null);
    expect(useUiStore.getState().parkEpoch).toBe(epoch + 1);
    game.destroy();
  });
});

describe('The Map offer', () => {
  beforeEach(() => stubWindow({ [PROFILE_KEY]: STORED_PROFILE }));

  it('is offered once when the sandbox park is stable, and remembered', async () => {
    const game = await makeGame();
    expect(useUiStore.getState().mapOfferPending).toBe(false);
    internals(game).session.onboarding!.restore({
      dismissed: false,
      completed: [{ id: 'fix-problem', tick: 5, evidence: 1 }],
      skipped: [],
      sawLitter: false,
    });
    runFrames(2);
    expect(useUiStore.getState().mapOfferPending).toBe(true);
    expect(JSON.parse(storage.get(PROFILE_KEY)!).ui?.tourOffered === true, 'not spent until answered').toBe(false);
    runBridge.resolveMapOffer(false);
    expect(JSON.parse(storage.get(PROFILE_KEY)!).ui.tourOffered).toBe(true);
    runFrames(4);
    expect(useUiStore.getState().mapOfferPending, 'never offered twice').toBe(false);
    game.destroy();
  });

  it('is never offered when the hints were dismissed', async () => {
    const game = await makeGame();
    gameBridge.dismissOnboarding();
    runFrames(4);
    expect(useUiStore.getState().mapOfferPending).toBe(false);
    game.destroy();
  });
});

describe('first run (Phase 23): the Sandbox First Day park, nothing opens by itself', () => {
  it('a brand-new profile lands in the sandbox with the First Day card and no Parks map, run screen or menu', async () => {
    stubWindow({});
    const game = await makeGame();
    const ui = useUiStore.getState();
    expect(ui.scenarioPickerOpen).toBe(false);
    expect(ui.runView).toBeNull();
    expect(ui.menuKind).toBeNull();
    expect(ui.sessionMode).toBe('sandbox');
    expect(ui.onboarding, 'the First Day tracker runs in the sandbox').not.toBeNull();
    expect(game.clock.speed).toBe(1);
    // The old "map seen" flag is no longer written: nothing was shown.
    expect(JSON.parse(storage.get(PROFILE_KEY)!).ui.mapSeen).toBe(false);
    game.destroy();
    // The next session finds the profile and is just as quiet.
    const next = await makeGame();
    expect(useUiStore.getState().scenarioPickerOpen).toBe(false);
    next.destroy();
  });

  it('stays shut for a stored profile and when storage is unavailable', async () => {
    stubWindow({ [PROFILE_KEY]: STORED_PROFILE });
    const game = await makeGame();
    expect(useUiStore.getState().scenarioPickerOpen).toBe(false);
    game.destroy();
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined, visibilityState: 'visible' });
    const bare = await makeGame();
    expect(useUiStore.getState().scenarioPickerOpen).toBe(false);
    bare.destroy();
  });

  it('"Open The Map" on the one-time offer opens the pause menu on The Map setup; "Not now" only remembers', async () => {
    stubWindow({ [PROFILE_KEY]: STORED_PROFILE.replace('"tourOffered":true', '"tourOffered":false') });
    const game = await makeGame();
    useUiStore.setState({ mapOfferPending: true });
    runBridge.resolveMapOffer(true);
    expect(useUiStore.getState().mapOfferPending).toBe(false);
    expect(useUiStore.getState().menuKind).toBe('pause');
    expect(useUiStore.getState().menuPanel).toBe('the-map');
    expect(JSON.parse(storage.get(PROFILE_KEY)!).ui.tourOffered).toBe(true);
    game.destroy();
  });
});
