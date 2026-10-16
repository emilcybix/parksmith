import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hillDipLayout, tallLayout, withFreeLifts } from '../game/coaster/testLayouts';
import { liftRuns } from '../game/coaster/lift';
import type { CoasterPiece } from '../game/coaster/design';
import type { ParkSession } from '../game/session/ParkSession';

/**
 * The coaster designer's lift hills (chain or free climb) through GameApp, in the undo test's
 * style: fake renderer, stubbed window, gestures through the input handlers the renderer was given.
 */

type Cell = { x: number; y: number };
type Handlers = {
  hover(cell: Cell | null): void;
  start(cell: Cell): void;
  move(cell: Cell): void;
  end(cell: Cell): void;
  cancel(): void;
};
let inputHandlers: Handlers | null = null;
let hovered: Cell | null = null;
const drawn: unknown[][] = [];

class FakeRenderer {
  get hoveredCell() { return hovered; }
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(): void {}
  setSession(): void {}
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(): void {}
  setWeather(): void {}
  setInputHandlers(handlers: Handlers): void { inputHandlers = handlers; }
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
  drawCoasterDraft(...args: unknown[]): void { drawn.push(args); }
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
const { hashState } = await import('../game/save/hash');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();
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
  coasterDraft: CoasterPiece[];
}
const internals = (game: unknown) => game as Internals;
const hashOf = (game: unknown): string => {
  const session = internals(game).session;
  session.syncWithWorld();
  return hashState(session.serialize());
};

const press = (key: string, ctrl = false): void => {
  for (const handler of handlers.get('keydown') ?? []) {
    handler({
      ctrlKey: ctrl, metaKey: false, altKey: false, shiftKey: false, key, code: `Key${key.toUpperCase()}`,
      repeat: false, target: null, preventDefault: () => undefined,
    });
  }
};

const draft = () => useUiStore.getState().coasterDraft!;
const chainedFlags = (game: unknown): boolean[] => liftRuns(internals(game).coasterDraft).map((run) => run.chained);

beforeEach(() => {
  inputHandlers = null;
  hovered = null;
  drawn.length = 0;
  handlers = new Map();
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

/** A designer with the hill-dip layout (four lifts) loaded as the draft. */
const openDesigner = async (layout: CoasterPiece[], typeId = 'star-chaser') => {
  const game = await makeGame();
  game.world.addMoney(1_000_000);
  useUiStore.getState().selectBuild(typeId);
  internals(game).coasterDraft = layout;
  // Any hover refreshes the preview from the draft.
  inputHandlers!.hover({ x: 40, y: 20 });
  return game;
};

describe('lift toggles in the designer', () => {
  it('hands the renderer the draft with its flags, so the chain strips follow the data', async () => {
    const game = await openDesigner(hillDipLayout());
    const run = liftRuns(internals(game).coasterDraft)[1];
    gameBridge.coasterSetLift(run.start, false);
    const pieces = drawn[drawn.length - 1][0] as CoasterPiece[];
    expect(pieces.filter((piece) => piece.freeClimb === true)).toHaveLength(run.length);
    expect(pieces[run.start].freeClimb).toBe(true);
    gameBridge.coasterSetLift(run.start, true);
    expect((drawn[drawn.length - 1][0] as CoasterPiece[]).some((piece) => piece.freeClimb === true)).toBe(false);
    game.destroy();
  });

  it('publishes one row per lift, all chained by default', async () => {
    const game = await openDesigner(hillDipLayout());
    const runs = draft().liftRuns;
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.every((run) => run.chained)).toBe(true);
    expect(draft().chainSavings).toBe(0);
    game.destroy();
  });

  it('L flips the lift under the cursor, then the last lift when nothing is hovered', async () => {
    const game = await openDesigner(hillDipLayout());
    const pieces = internals(game).coasterDraft;
    const runs = liftRuns(pieces);
    hovered = pieces[runs[1].start + 1].cell;
    press('l');
    expect(chainedFlags(game)).toEqual(runs.map((_, index) => index !== 1));
    expect(draft().liftRuns[1].chained).toBe(false);
    expect(draft().chainSavings).toBeGreaterThan(0);
    hovered = null;
    press('l');
    // Nothing hovered: the lift holding the last piece, else the last lift.
    expect(chainedFlags(game).filter((chained) => !chained)).toHaveLength(2);
    expect(chainedFlags(game)[runs.length - 1]).toBe(false);
    game.destroy();
  });

  it('a press on a lift piece flips that lift and starts no drag', async () => {
    const game = await openDesigner(hillDipLayout());
    const pieces = internals(game).coasterDraft;
    const runs = liftRuns(pieces);
    const before = pieces.length;
    inputHandlers!.start(pieces[runs[0].start + 1].cell);
    expect(chainedFlags(game)[0]).toBe(false);
    expect(useUiStore.getState().toast).toBeNull();
    inputHandlers!.move({ x: 40, y: 20 });
    expect(internals(game).coasterDraft).toHaveLength(before);
    game.destroy();
  });

  it('a press on the last piece keeps the old behaviour', async () => {
    const game = await openDesigner(hillDipLayout());
    const pieces = internals(game).coasterDraft;
    inputHandlers!.start(pieces[pieces.length - 1].cell);
    expect(chainedFlags(game).every(Boolean)).toBe(true);
    inputHandlers!.start({ x: 50, y: 50 });
    expect(useUiStore.getState().toast).toMatch(/has to continue/);
    game.destroy();
  });

  it('refuses a toggle with no climb in the layout', async () => {
    const game = await openDesigner(hillDipLayout().map((piece) => ({ ...piece, height: 0 })));
    press('l');
    expect(useUiStore.getState().toast).toBe('No climb here to chain.');
    game.destroy();
  });

  it('Ctrl+Z reverts a toggle first, then takes a piece back', async () => {
    const game = await openDesigner(hillDipLayout());
    const length = internals(game).coasterDraft.length;
    gameBridge.coasterSetLift(liftRuns(internals(game).coasterDraft)[0].start, false);
    expect(chainedFlags(game)[0]).toBe(false);
    expect(useUiStore.getState().undoStatus.label).toBe('Undo lift change');
    press('z', true);
    expect(chainedFlags(game)[0]).toBe(true);
    expect(internals(game).coasterDraft).toHaveLength(length);
    expect(useUiStore.getState().undoStatus.label).toBe('Undo track piece');
    press('z', true);
    expect(internals(game).coasterDraft).toHaveLength(length - 1);
    game.destroy();
  });

  it('a free climb that would stall blocks the build; chaining it again lifts the block', async () => {
    const game = await openDesigner(tallLayout(), 'skyline-serpent');
    expect(draft().buildable).toBe(true);
    withFreeLifts(internals(game).coasterDraft);
    gameBridge.coasterSetLift(liftRuns(internals(game).coasterDraft)[0].start, true);
    gameBridge.coasterSetLift(liftRuns(internals(game).coasterDraft)[0].start, false);
    expect(draft().liftRuns[0].chained).toBe(false);
    expect(draft().buildable).toBe(false);
    expect(draft().validationMessage).toMatch(/free climb/i);
    const before = game.world.coasters.size;
    game.coasterBuild();
    expect(game.world.coasters.size).toBe(before);
    gameBridge.coasterSetLift(liftRuns(internals(game).coasterDraft)[0].start, true);
    expect(draft().buildable).toBe(true);
    game.destroy();
  });

  it('building a free coaster keeps its flags, publishes its lift view, and undo takes it back to the exact hash', async () => {
    const game = await openDesigner(hillDipLayout());
    const hashBefore = hashOf(game);
    gameBridge.coasterSetLift(liftRuns(internals(game).coasterDraft)[1].start, false);
    expect(draft().buildable).toBe(true);
    game.coasterBuild();
    expect(game.world.coasters.size).toBe(1);
    const record = [...game.world.coasters.values()][0];
    expect(record.pieces.filter((piece) => piece.freeClimb === true).length).toBeGreaterThan(0);
    game.focusBuilding(record.objectId);
    const view = useUiStore.getState().selectedCoasterLift;
    expect(view?.freeRuns).toBe(1);
    expect(view?.chainedPieces).toBeGreaterThan(0);
    expect(view?.chainBuildCost).toBeGreaterThan(0);
    const hashBuilt = hashOf(game);
    expect(hashBuilt).not.toBe(hashBefore);
    gameBridge.requestUndo();
    expect(game.world.coasters.size).toBe(0);
    expect(hashOf(game)).toBe(hashBefore);
    game.destroy();
  });
});

describe('Phase 38: the designer lets the track cross itself at clearance', () => {
  const lay = (game: unknown, cells: Array<[number, number]>, heightTargets: Record<number, number>): void => {
    void game;
    cells.forEach(([x, y], index) => {
      if (heightTargets[index] !== undefined) {
        for (let step = 0; step < 4; step += 1) gameBridge.coasterAdjustHeight(-1);
        for (let step = 0; step < heightTargets[index]; step += 1) gameBridge.coasterAdjustHeight(1);
      }
      if (index === 0) inputHandlers!.start({ x, y });
      else inputHandlers!.move({ x, y });
    });
    const [lastX, lastY] = cells[cells.length - 1];
    inputHandlers!.end({ x: lastX, y: lastY });
  };
  // East along y = 5, round, and back north through (6, 5).
  const route: Array<[number, number]> = [
    [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5], [8, 5], [8, 6], [8, 7], [7, 7], [6, 7], [6, 6], [6, 5], [6, 4],
  ];

  it('re-entering a cell two levels below the earlier piece adds the crossing', async () => {
    const game = await openDesigner([], 'comet-trail');
    lay(game, route, { 0: 0, 3: 2, 7: 0 });
    const pieces = internals(game).coasterDraft;
    const atCrossing = pieces.filter((piece) => piece.cell.x === 6 && piece.cell.y === 5).map((piece) => piece.height);
    expect(atCrossing).toEqual([2, 0]);
    expect(pieces[pieces.length - 1].cell).toEqual({ x: 6, y: 4 });
    game.destroy();
  });

  it('the hover line names the next level and the track already in the cell', async () => {
    const game = await openDesigner([], 'comet-trail');
    lay(game, route.slice(0, 12), { 0: 0, 3: 2, 7: 0 });
    inputHandlers!.hover({ x: 6, y: 5 });
    expect(useUiStore.getState().previewBlock).toBe('Next piece at level 0 · track here at level 2');
    game.destroy();
  });

  it('re-entering it one level below is refused, with the clearance message', async () => {
    const game = await openDesigner([], 'comet-trail');
    lay(game, route, { 0: 0, 3: 1, 7: 0 });
    const pieces = internals(game).coasterDraft;
    expect(pieces.filter((piece) => piece.cell.x === 6 && piece.cell.y === 5)).toHaveLength(1);
    expect(pieces[pieces.length - 1].cell, 'the draft stops before the refused cell').toEqual({ x: 6, y: 6 });
    expect(useUiStore.getState().toast).toContain('levels needed');
    game.destroy();
  });
});

describe('Phase 44: the shuttle designer', () => {
  it('a shuttle draft carries the launch speed on its first piece, steps it, and builds out and back', async () => {
    const game = await makeGame();
    game.world.addMoney(1_000_000);
    game.world.setBuildAccessPolicy(null);
    useUiStore.getState().selectBuild('thunder-launch');
    inputHandlers!.hover({ x: 4, y: 4 });
    expect(draft().launchSpeed).toBe(10);
    expect(draft().allowedSpecials, 'the station is the launch').not.toContain('launch');
    // Lay the station and a run-up at ground level, then a spike to level 5, eastward from (4, 4).
    const cells = Array.from({ length: 9 }, (_unused, index) => ({ x: 4 + index, y: 4 }));
    inputHandlers!.start(cells[0]);
    inputHandlers!.move(cells[3]);
    for (let level = 0; level < 5; level += 1) gameBridge.coasterAdjustHeight(1);
    inputHandlers!.move(cells[8]);
    inputHandlers!.end(cells[8]);
    const pieces = internals(game).coasterDraft;
    expect(pieces.map((piece) => piece.height)).toEqual([0, 0, 0, 0, 1, 2, 3, 4, 5]);
    expect(pieces[0].launchSpeed).toBe(10);
    expect(draft().buildable, 'launch 10 flies off a 5-high spike').toBe(false);
    for (let step = 0; step < 8; step += 1) gameBridge.coasterAdjustLaunch(-1);
    expect(draft().launchSpeed).toBe(6);
    expect(pieces[0].launchSpeed).toBe(6);
    expect(draft().validationMessage).toBe('Ready to build!');
    // The lift key does nothing on a shuttle (nothing is chained).
    gameBridge.coasterToggleLift();
    expect(pieces.some((piece) => piece.freeClimb === true)).toBe(false);
    gameBridge.coasterBuild();
    const record = [...game.world.coasters.values()][0];
    expect(record.pieces[0].launchSpeed).toBe(6);
    game.destroy();
  });
});
