import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrowdHeatmapView } from '../game/crowd/types';

/**
 * Phase 14 in GameApp: the crowd heatmap toggle (exclusive with the scenery heatmap, idempotent, a toast on the classic
 * renderer), the 4 Hz `crowd` UI (Park Pulse tracker, rows only while the Neighborhoods tab is open, the hover line), the
 * heatmap push (only while shown, only on a new revision, always after a session swap), `focusNeighborhood` and the undo
 * hand-over of a rule-off park's field. Fake renderer and stubbed window as in GameApp.capacity.test.ts; frames drive the
 * 4 Hz publish. `withCrowdLayer` decides whether the fake renderer has `setCrowdHeatmap` (voxel) or not (classic).
 */

type Cell = { x: number; y: number };
type Handlers = { hover(cell: Cell | null): void; start(cell: Cell): void; move(cell: Cell): void; end(cell: Cell): void; cancel(): void };

let frameCallback: ((deltaMs: number) => void) | null = null;
let inputHandlers: Handlers | null = null;
let hovered: Cell | null = null;
let withCrowdLayer = true;
const pushes: Array<Readonly<CrowdHeatmapView> | null> = [];
const sceneryCalls: boolean[] = [];
const focusCalls: Array<{ cell: Cell; motion: string | undefined }> = [];

class FakeRenderer {
  setCrowdHeatmap?: (view: Readonly<CrowdHeatmapView> | null) => void;
  constructor() {
    if (withCrowdLayer) this.setCrowdHeatmap = (view) => { pushes.push(view); };
  }
  get hoveredCell() { return hovered; }
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(callback: (deltaMs: number) => void): void { frameCallback = callback; }
  setSession(): void {}
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(): void {}
  setWeather(): void {}
  setInputHandlers(handlers: Handlers): void { inputHandlers = handlers; }
  setViewInputEnabled(): void {}
  setToolCursor(): void {}
  focusCell(cell: Cell, motion?: string): void { focusCalls.push({ cell: { ...cell }, motion }); }
  focusEntrance(): void {}
  setGridVisible(): void {}
  setSceneryInfluenceVisible(visible: boolean): void { sceneryCalls.push(visible); }
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
const { useUiStore } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');
const { CROWD_CLASSIC_TOAST } = await import('../ui/neighborhoodModel');
const { CrowdSimulation } = await import('../game/crowd/CrowdSimulation');
const { GAME_CONFIG } = await import('../game/config');
const { seedDevPark } = await import('../game/session/devPark');
type Session = import('../game/session/ParkSession').ParkSession;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const games: Array<{ destroy(): void }> = [];
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
  games.push(game);
  return game;
};

const sessionOf = (game: unknown): Session => (game as { session: Session }).session;
const ui = () => useUiStore.getState();
const runFrames = (count: number, deltaMs = 250): void => {
  for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs);
};
const lastPush = () => pushes[pushes.length - 1];

/** The dev park in the live session, with a structural bottleneck tile flooded well above severe (it stays severe ~1 min). */
const crowdedDevPark = async () => {
  const game = await makeGame();
  const session = sessionOf(game);
  seedDevPark(session);
  session.syncWithWorld();
  const shape = session.crowd.shape();
  const { width } = session.world;
  let index = -1;
  for (const cell of shape.cells) {
    if (shape.articulation[cell] === 1 && shape.laneWidth[cell] === 1 && session.crowdHoverAt({ x: cell % width, y: Math.floor(cell / width) })?.neighborhoodName) {
      index = cell;
      break;
    }
  }
  expect(index, 'the dev park has a one-lane articulation tile inside a neighborhood').toBeGreaterThanOrEqual(0);
  const severe = GAME_CONFIG.crowd.bands.severe;
  const pressure = Math.round((3 * severe * GAME_CONFIG.crowd.entryUnits * GAME_CONFIG.crowd.decayDivisor) / 600);
  session.crowd.restore({ version: 1, pressure: [[index, pressure]] });
  session.world.advanceTick();
  const cell = { x: index % width, y: Math.floor(index / width) };
  expect(session.crowdHoverAt(cell)?.bottleneck).toBe(true);
  return { game, session, cell };
};

beforeEach(() => {
  frameCallback = null;
  inputHandlers = null;
  hovered = null;
  withCrowdLayer = true;
  pushes.length = 0;
  sceneryCalls.length = 0;
  focusCalls.length = 0;
  const storage = new Map<string, string>([
    ['parksmith-profile', JSON.stringify({ version: 1, discoveredCardIds: [], tour: {}, ui: { mapSeen: true, tourOffered: true } })],
  ]);
  const register = (): void => undefined;
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
  useUiStore.setState({ showCrowdHeatmap: false, showSceneryInfluence: false, crowdHeatmapSupported: true, crowd: null, managementOpen: false });
  ui().setToast(null);
  ui().selectPointer();
});

afterEach(() => {
  for (const game of games.splice(0)) game.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('crowd heatmap toggle (voxel renderer)', () => {
  it('turning it on turns the scenery heatmap off, and back; both commands are idempotent', async () => {
    const game = await makeGame();
    expect(ui().crowdHeatmapSupported).toBe(true);
    gameBridge.setSceneryInfluenceVisible(true);
    expect(ui().showSceneryInfluence).toBe(true);

    pushes.length = 0;
    gameBridge.setCrowdHeatmapVisible(true);
    expect(ui().showCrowdHeatmap).toBe(true);
    expect(ui().showSceneryInfluence, 'exclusive').toBe(false);
    expect(sceneryCalls[sceneryCalls.length - 1]).toBe(false);
    const shown = lastPush();
    expect(shown).toBe(sessionOf(game).crowdHeatmap(null));

    // The UI sets the store itself and calls the bridge as well: a second call changes nothing.
    gameBridge.setCrowdHeatmapVisible(true);
    expect(ui().showCrowdHeatmap).toBe(true);
    expect(pushes.every((view) => view === shown), 'the same view, never a null in between').toBe(true);

    gameBridge.setSceneryInfluenceVisible(true);
    expect(ui().showCrowdHeatmap, 'exclusive the other way').toBe(false);
    expect(ui().showSceneryInfluence).toBe(true);
    expect(lastPush()).toBeNull();
    gameBridge.setCrowdHeatmapVisible(false);
    expect(ui().showSceneryInfluence, 'turning crowd off leaves scenery alone').toBe(true);
    expect(ui().toast).toBeNull();
  });

  it('pushes only while shown and only when the revision moved; a swap pushes the new park at once', async () => {
    const game = await makeGame();
    const session = sessionOf(game);
    seedDevPark(session);
    session.syncWithWorld();
    game.setSpeed(0);
    runFrames(8);
    expect(pushes.filter((view) => view !== null), 'hidden: nothing drawn').toEqual([]);

    gameBridge.setCrowdHeatmapVisible(true);
    const first = lastPush();
    expect(first?.cells.length).toBe(session.crowd.shape().cells.length);
    const count = pushes.length;
    runFrames(8);
    expect(pushes.length, 'paused, nothing moved: no push').toBe(count);

    // A band change (one tile flooded) shows on the next publish with a new revision.
    session.crowd.restore({ version: 1, pressure: [[session.crowd.shape().cells[0], 5_000_000]] });
    session.world.advanceTick();
    runFrames(1);
    expect(pushes.length).toBe(count + 1);
    expect(lastPush()!.revision).toBeGreaterThan(first!.revision);

    // A new park: the renderer forgot the layer with the old session, so the new view is pushed during the swap.
    game.startScenario(null);
    const next = sessionOf(game);
    expect(next).not.toBe(session);
    expect(lastPush()).toBe(next.crowdHeatmap(null));
    expect(ui().showCrowdHeatmap, 'the toggle is the player\'s, kept across parks').toBe(true);
  });
});

describe('crowd UI on the 4 Hz cadence', () => {
  it('publishes the Pulse line after the hold, rows only while the Neighborhoods tab is open, and resets on a swap', async () => {
    const { game } = await crowdedDevPark();
    game.setSpeed(1);
    runFrames(1);
    expect(ui().crowd).not.toBeNull();
    expect(ui().crowd!.rows, 'tab closed: no rows').toBeNull();
    expect(ui().crowd!.pulseLine, 'not before the 10 s hold').toBeNull();

    runFrames(48); // 12 s of play at speed 1
    expect(ui().crowd!.pulseLine).toMatch(/ has a bottleneck$/);
    expect(ui().crowd!.overviewLine).toBe(`${ui().crowd!.pulseLine} · see Neighborhoods`);

    useUiStore.setState({ managementOpen: true, managementTab: 'neighborhoods' });
    runFrames(1);
    const rows = ui().crowd!.rows!;
    expect(rows.length).toBe(sessionOf(game).crowdView().neighborhoods.length);
    expect(rows.some((row) => row.bottleneck !== null)).toBe(true);
    expect(rows.some((row) => /\d+ stalls?/.test(row.subtitle)), 'stalls are counted').toBe(true);
    const published = ui().crowd;
    game.setSpeed(0);
    runFrames(4);
    expect(ui().crowd, 'paused and unchanged: the store keeps its object').toBe(published);

    game.startScenario(null);
    expect(ui().crowd!.pulseLine, 'a new park starts with no neighborhood lines').toBeNull();
  });

  it('the hover line needs the pointer tool, the heatmap and a path tile', async () => {
    const { game, cell } = await crowdedDevPark();
    game.setSpeed(0);
    runFrames(1);
    hovered = cell;
    inputHandlers!.hover(cell);
    expect(ui().crowd!.hover, 'heatmap off').toBeNull();
    gameBridge.setCrowdHeatmapVisible(true);
    expect(ui().crowd!.hover).toMatch(/^Bottleneck path · \d+ guests a minute · .+$/);
    inputHandlers!.hover({ x: 0, y: 0 });
    expect(ui().crowd!.hover, 'off the path network').toBeNull();
    inputHandlers!.hover(cell);
    expect(ui().crowd!.hover).not.toBeNull();
    useUiStore.getState().selectBulldozer();
    runFrames(1);
    expect(ui().crowd!.hover, 'another tool').toBeNull();
  });
});

describe('focusNeighborhood', () => {
  it('eases to the worst busy tile and lights the heatmap for a bottleneck; else the focus tile, heatmap untouched', async () => {
    const { game, session, cell } = await crowdedDevPark();
    gameBridge.setSceneryInfluenceVisible(true);
    const view = session.crowdView();
    const jammed = view.neighborhoods.find((n) => n.worst?.cell.x === cell.x && n.worst.cell.y === cell.y)!;
    expect(jammed).toBeDefined();
    gameBridge.focusNeighborhood(jammed.key);
    expect(focusCalls[focusCalls.length - 1]).toEqual({ cell, motion: 'ease' });
    expect(ui().showCrowdHeatmap).toBe(true);
    expect(ui().showSceneryInfluence).toBe(false);

    gameBridge.setCrowdHeatmapVisible(false);
    const calm = view.neighborhoods.find((n) => (n.worst === null || n.worst.band < 2)
      && !view.bottlenecks.some((tile) => tile.neighborhoodKey === n.key))!;
    expect(calm).toBeDefined();
    gameBridge.focusNeighborhood(calm.key);
    expect(focusCalls[focusCalls.length - 1]).toEqual({ cell: calm.focus, motion: 'ease' });
    expect(ui().showCrowdHeatmap).toBe(false);

    const before = focusCalls.length;
    gameBridge.focusNeighborhood(9_999);
    expect(focusCalls.length, 'an unknown key does nothing').toBe(before);
    void game;
  });
});

describe('undo', () => {
  it('hands the live crowd field to the rewound park (adoptDisplay) and pushes its heatmap', async () => {
    const game = await makeGame();
    game.world.addMoney(100_000);
    gameBridge.setCrowdHeatmapVisible(true);
    const live = sessionOf(game);
    useUiStore.getState().selectBuild('ribbon-bench');
    inputHandlers!.end({ x: 5, y: 4 });
    const adopt = vi.spyOn(CrowdSimulation.prototype, 'adoptDisplay');
    pushes.length = 0;
    game.requestUndo();
    const rewound = sessionOf(game);
    expect(rewound).not.toBe(live);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt.mock.contexts[0]).toBe(rewound.crowd);
    expect(adopt.mock.calls[0][0]).toBe(live.crowd);
    expect(lastPush()).toBe(rewound.crowdHeatmap(null));
  });
});

describe('classic renderer', () => {
  it('reports the heatmap unsupported, toasts on a press and never turns it on or pushes a view', async () => {
    withCrowdLayer = false;
    useUiStore.setState({ showCrowdHeatmap: true });
    const game = await makeGame();
    expect(ui().crowdHeatmapSupported).toBe(false);
    expect(ui().showCrowdHeatmap, 'a classic mount turns a stale toggle off').toBe(false);
    gameBridge.setCrowdHeatmapVisible(true);
    expect(ui().showCrowdHeatmap).toBe(false);
    expect(ui().toast).toBe(CROWD_CLASSIC_TOAST);
    const session = sessionOf(game);
    seedDevPark(session);
    gameBridge.focusNeighborhood(session.crowdView().neighborhoods[0].key);
    expect(ui().showCrowdHeatmap).toBe(false);
    runFrames(4);
    expect(ui().crowd, 'the Pulse lines and rows still work').not.toBeNull();
    expect(pushes).toEqual([]);
  });
});
