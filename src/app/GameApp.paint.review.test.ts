import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 28 step 2 ADVERSARIAL REVIEW (persistence, undo, input) of GameApp's side of the Paint tool.
 * `it.fails` marks a confirmed finding: the test asserts the behaviour the spec asks for and fails today;
 * it flips (and must lose `.fails`) when the defect is fixed. Scaffold copied from GameApp.paint.test.ts.
 *
 * Original header: Phase 28 step 2, GameApp's side of the Paint tool, presets and colour before placing: the pointer handlers
 * (click, Shift, drag, eyedropper), the hover (the overlay seam and the readout), one undo entry per gesture,
 * the cosmetic undo (gate included), the whole-park preset, the cost plumbing, and the ghost and placement
 * colours. Same scaffold as GameApp.colours.test.ts: fake renderer, stubbed window, real manager.
 */

const log: string[] = [];
const phases: number[] = [];
const previews: unknown[][] = [];
const paintHovers: Array<{ cells: Array<{ x: number; y: number }>; tint: number | null } | null> = [];
const weatherViews: Array<{ kind: string; intensity: number; day: number }> = [];
type Handlers = {
  hover(cell: { x: number; y: number } | null): void;
  start(cell: { x: number; y: number }, modifiers?: { shift: boolean }): void;
  move(cell: { x: number; y: number }): void;
  end(cell: { x: number; y: number }): void;
  cancel(): void;
};
let inputHandlers: Handlers | null = null;
let hovered: { x: number; y: number } | null = null;

class FakeRenderer {
  get hoveredCell() { return hovered; }
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(): void {}
  setSession(): void { log.push('setSession'); }
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(phase: number): void { phases.push(phase); }
  setWeather(view: Readonly<{ kind: string; intensity: number; day: number }>): void { weatherViews.push({ kind: view.kind, intensity: view.intensity, day: view.day }); }
  setInputHandlers(handlers: Handlers): void { inputHandlers = handlers; }
  setViewInputEnabled(): void {}
  setToolCursor(): void {}
  focusCell(): void {}
  focusEntrance(): void {}
  setGridVisible(): void {}
  setSceneryInfluenceVisible(): void {}
  selectObject(): void { log.push('selectObject'); }
  drawPreview(...args: unknown[]): void { log.push('drawPreview'); previews.push(args); }
  clearPreview(): void { log.push('clearPreview'); }
  setPaintHover(hover: { cells: Array<{ x: number; y: number }>; tint: number | null } | null): void { paintHovers.push(hover); }
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

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const host = {} as HTMLElement;

const makeGame = async () => {
  const store = new MemorySaveStore();
  const game = new GameApp({
    saveStore: store,
    saveWriter: createHashingWriter(store, {
      kind: 'idle', seal: async (state) => computeStateSeal(state), dispose: () => undefined,
    }),
  });
  await game.mount(host);
  await settle();
  return game;
};

/** The parts of GameApp the tests reach into; named so a rename breaks here and not silently. */
interface Internals {
  session: unknown;
  undo: {
    depth: number;
    hasPending: boolean;
    begin(kind: string): void;
    status(): { canUndo: boolean; reason: string | null; depth: number; label: string; armed: boolean; rewindSeconds: number };
    refresh(): boolean;
    newest: { label: string; kind: string } | null;
  };
  saves: { notifyParkRewound?: () => void };
  selectedRideId: number | null;
  coasterDraft: unknown[];
  handleScenarioEvents(events: Array<{ kind: string }>): void;
  swapping: boolean;
}
const internals = (game: unknown) => game as Internals;

const pressUndo = (options: { repeat?: boolean; shift?: boolean; target?: unknown } = {}): { prevented: boolean } => {
  let prevented = false;
  for (const handler of handlers.get('keydown') ?? []) {
    handler({
      ctrlKey: true, metaKey: false, altKey: false, shiftKey: options.shift ?? false, key: 'z',
      repeat: options.repeat ?? false,
      target: options.target ?? null,
      preventDefault: () => { prevented = true; },
    });
  }
  return { prevented };
};


beforeEach(() => {
  log.length = 0;
  previews.length = 0;
  paintHovers.length = 0;
  inputHandlers = null;
  hovered = null;
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
  useUiStore.getState().selectPointer();
  useUiStore.setState({ paintBrush: { kind: 'default' }, paintTarget: 'primary', paintPicking: false, paintPanelOpen: false, paintReadout: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});



// --- helpers ------------------------------------------------------------------------------------------------------------------

const TEAL = 19;
/** startScenario enters a Park Tour node (mode 'map'); a stand-alone scenario has none (mode 'scenario'). */
const asStandaloneScenario = (game: unknown): void => { (game as { currentNodeId: string | null }).currentNodeId = null; };
type Cell = { x: number; y: number };

const press = (key: string, code: string): void => {
  for (const handler of handlers.get('keydown') ?? []) {
    handler({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault: () => undefined });
  }
};

const ui = () => useUiStore.getState();

/** Dev-park-free fixture: two rides, a stall, a bench, a lamp, a tree and the entrance gate, plenty of cash. */
const park = async () => {
  const game = await makeGame();
  game.world.addMoney(500_000);
  const carousel = game.world.buildObject('moonpetal-carousel', { x: 20, y: 10 })!;
  const swings = game.world.buildObject('harbor-swings', { x: 20, y: 16 })!;
  const stall = game.world.buildObject('picnic-pocket', { x: 10, y: 10 })!;
  const bench = game.world.buildObject('ribbon-bench', { x: 14, y: 6 })!;
  const lamp = game.world.buildObject('lollipop-lamp', { x: 16, y: 6 })!;
  const tree = game.world.buildObject('confetti-tree', { x: 18, y: 6 })!;
  ui().selectPointer();
  return { game, app: internals(game), carousel, swings, stall, bench, lamp, tree };
};

const cellOf = (object: { anchor: Cell }): Cell => ({ ...object.anchor });

const setBrush = (brush: Parameters<ReturnType<typeof ui>['setPaintBrush']>[0], target: 'primary' | 'secondary' | 'all' = 'primary'): void => {
  ui().setPaintBrush(brush);
  ui().setPaintTarget(target);
};

const click = (cell: Cell, shift = false): void => {
  inputHandlers!.start(cell, { shift });
  inputHandlers!.end(cell);
};

const { COASTER_TYPE_BY_ID } = await import('../game/coaster/content');
const { coasterBaseCost, deriveCoasterStats, validateCoasterLayout } = await import('../game/coaster/design');
const { COLOUR_SLOTS } = await import('../game/content/colours');
const { saveBridge } = await import('./gameBridge');

const priced = async (config: { scenario: number; map: number }, run: () => Promise<void>): Promise<void> => {
  const { GAME_CONFIG: shipped } = await import('../game/config');
  const table = shipped.colours.recolourCostPerObject as { scenario: number; map: number };
  const saved = { ...table };
  Object.assign(table, config);
  try { await run(); } finally { Object.assign(table, saved); }
};

/** A stand-alone priced scenario with a bench and a lamp on one row (the same cells as the builder tests). */
const pricedPark = async () => {
  const game = await makeGame();
  game.startScenario('sunny-start');
  await settle();
  asStandaloneScenario(game);
  game.world.addMoney(500_000);
  const bench = game.world.buildObject('ribbon-bench', { x: 14, y: 6 })!;
  const lamp = game.world.buildObject('lollipop-lamp', { x: 16, y: 6 })!;
  ui().selectPointer();
  return { game, app: internals(game), bench, lamp };
};

/** A Comet Trail on the map (the colour test park's layout, moved to an empty strip). */
const placeComet = (game: { world: { placeCoaster: (...args: never[]) => { ok: boolean; object?: { id: number } } | unknown } }) => {
  const type = COASTER_TYPE_BY_ID.get('comet-trail')!;
  const moves = 'EEENENEESSSWWWWWWN';
  const heights = [0, 0, 0, 1, 2, 2, 2, 1, 1, 2, 2, 2, 1, 1, 0, 0, 0, 0];
  const pieces = [];
  let x = 2; let y = 4;
  for (let index = 0; index < moves.length; index += 1) {
    pieces.push({ cell: { x, y }, height: heights[index] });
    const move = moves[index];
    if (move === 'E') x += 1; else if (move === 'W') x -= 1; else if (move === 'S') y += 1; else y -= 1;
  }
  expect(validateCoasterLayout(pieces, type).ok).toBe(true);
  const world = game.world as unknown as { placeCoaster: (id: string, p: unknown, s: unknown, c: number) => unknown; objects: Map<number, { id: number; definitionId: string }> };
  const before = new Set(world.objects.keys());
  world.placeCoaster(type.definitionId, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
  const placed = [...world.objects.values()].find((object) => !before.has(object.id) && object.definitionId === 'comet-trail');
  expect(placed, 'the coaster was placed').toBeDefined();
  return { id: placed!.id, cells: pieces.map((piece) => piece.cell) };
};

const everyRecord = (game: { world: { objects: Map<number, { id: number; colours?: readonly (number | null)[] }>; gateColours: readonly (number | null)[] | null } }): string => JSON.stringify({
  objects: [...game.world.objects.values()].map((object) => [object.id, object.colours ?? null]),
  gate: game.world.gateColours,
});

describe('review: Ctrl+Z in the middle of a PRICED paint drag', () => {
  it('undoing the partial drag and releasing charges nothing (fixed: the undone part leaves the charge of the gesture)', async () => {
    await priced({ scenario: 20, map: 20 }, async () => {
      const { game, bench } = await pricedPark();
      ui().selectPaint();
      setBrush({ kind: 'swatch', swatch: TEAL });
      const cash = game.world.cash;
      const ledger = game.world.transactions.length;
      inputHandlers!.start(cellOf(bench), { shift: false });
      pressUndo();
      expect(game.world.objectColours(bench.id), 'the partial drag is undone').toBeNull();
      inputHandlers!.end(cellOf(bench));
      // Nothing is painted any more and nothing can be undone: the player must not have paid.
      expect(game.world.cash).toBe(cash);
      expect(game.world.transactions.length, 'no charge and no refund pair either').toBe(ledger);
      game.destroy();
    });
  });

  it('after Ctrl+Z mid-drag the gesture charges only what is still painted', async () => {
    await priced({ scenario: 20, map: 20 }, async () => {
      const { game, bench, lamp } = await pricedPark();
      ui().selectPaint();
      setBrush({ kind: 'swatch', swatch: TEAL });
      const cash = game.world.cash;
      inputHandlers!.start(cellOf(bench), { shift: false });
      pressUndo();
      inputHandlers!.move(cellOf(lamp));
      inputHandlers!.end(cellOf(lamp));
      expect(game.world.objectColours(bench.id)).toBeNull();
      expect(game.world.objectColours(lamp.id)).toEqual([TEAL, null]);
      expect(game.world.cash, 'one object painted, one fee').toBe(cash - 20);
      game.destroy();
    });
  });

  it('control: the same sequence unpriced leaves cash and the ledger alone', async () => {
    const { game, bench, lamp } = await pricedPark();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    const cash = game.world.cash;
    const ledger = game.world.transactions.length;
    inputHandlers!.start(cellOf(bench), { shift: false });
    pressUndo();
    inputHandlers!.move(cellOf(lamp));
    inputHandlers!.end(cellOf(lamp));
    expect(game.world.cash).toBe(cash);
    expect(game.world.transactions.length).toBe(ledger);
    game.destroy();
  });
});

describe('review: the pause menu opened in the middle of a paint drag (the Menu button is keyboard reachable)', () => {
  it('the open drag is settled as its own entry, so the next paint is a separate undo entry', async () => {
    const { game, app, bench, lamp } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    inputHandlers!.start(cellOf(bench), { shift: false });
    expect(app.undo.hasPending).toBe(true);
    gameBridge.openPauseMenu();
    expect(ui().menuKind).toBe('pause');
    // openPauseMenu commits the pending snapshot through finishDemolitionGesture, then drops the gesture.
    expect(app.undo.hasPending, 'no snapshot may leak past the menu').toBe(false);
    gameBridge.resumeFromMenu();
    click(cellOf(lamp));
    expect(app.undo.depth, 'two gestures, two entries').toBe(2);
    pressUndo();
    expect(game.world.objectColours(lamp.id)).toBeNull();
    expect(game.world.objectColours(bench.id), 'one Undo takes back one gesture').toEqual([TEAL, null]);
    game.destroy();
  });

  it('the entry of a drag interrupted by the pause menu is named for the paint (fixed: the paint drag settles before the bulldozer settle)', async () => {
    const { game, app, bench } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    inputHandlers!.start(cellOf(bench), { shift: false });
    gameBridge.openPauseMenu();
    expect(app.undo.newest).toMatchObject({ kind: 'recolour', label: 'Painted Ribbon Bench' });
    game.destroy();
  });

  it('a priced drag interrupted by the pause menu is still charged for what it painted', async () => {
    await priced({ scenario: 20, map: 20 }, async () => {
      const { game, bench } = await pricedPark();
      ui().selectPaint();
      setBrush({ kind: 'swatch', swatch: TEAL });
      const cash = game.world.cash;
      inputHandlers!.start(cellOf(bench), { shift: false });
      gameBridge.openPauseMenu();
      gameBridge.resumeFromMenu();
      expect(game.world.objectColours(bench.id)).toEqual([TEAL, null]);
      expect(game.world.cash, 'the bench was painted, so it was charged').toBe(cash - 20);
      game.destroy();
    });
  });

  it('pointer input behind the pause menu paints nothing and opens no snapshot', async () => {
    const { game, app, stall, bench } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    gameBridge.openPauseMenu();
    inputHandlers!.start(cellOf(stall), { shift: true });
    inputHandlers!.move(cellOf(bench));
    inputHandlers!.end(cellOf(bench));
    expect(game.world.objectColours(stall.id)).toBeNull();
    expect(game.world.objectColours(bench.id)).toBeNull();
    expect(app.undo.hasPending).toBe(false);
    expect(app.undo.depth).toBe(0);
    gameBridge.applyPresetToPark('midnight');
    expect(game.world.objectColours(stall.id), 'the whole-park preset is inert behind the menu too').toBeNull();
    game.destroy();
  });
});

describe('review: the paint keys are build-capability keys', () => {
  const blocked: Array<[string, Record<string, unknown>]> = [
    ['Save / Load', { savesDialogOpen: true }],
    ['Settings', { settingsOpen: true }],
    ['the pause menu', { menuKind: 'pause' }],
    ['the management dashboard', { managementOpen: true }],
  ];
  for (const [name, patch] of blocked) {
    it(`C and I do nothing behind ${name}`, async () => {
      const { game } = await park();
      useUiStore.setState(patch as never);
      press('c', 'KeyC');
      expect(ui().tool, 'C').toBe('pointer');
      press('i', 'KeyI');
      expect(ui().tool, 'I').toBe('pointer');
      useUiStore.setState({ savesDialogOpen: false, settingsOpen: false, menuKind: null, managementOpen: false } as never);
      game.destroy();
    });
  }

  it('C and I do nothing in the coaster designer (the build-not-designer scope)', async () => {
    const { game } = await park();
    ui().selectBuild('comet-trail');
    press('c', 'KeyC');
    expect(ui().tool).toBe('build');
    press('i', 'KeyI');
    expect(ui().tool).toBe('build');
    game.destroy();
  });

  it('Esc puts the paint tool down mid-drag and keeps the drag as one entry; it does not open the pause menu', async () => {
    const { game, app, bench, lamp } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    inputHandlers!.start(cellOf(bench), { shift: false });
    inputHandlers!.move(cellOf(lamp));
    press('Escape', 'Escape');
    expect(ui().tool).toBe('pointer');
    expect(ui().menuKind).toBeNull();
    expect(app.undo.hasPending).toBe(false);
    expect(app.undo.depth).toBe(1);
    // A late pointer-up from the drag must not paint again or open another entry.
    inputHandlers!.end(cellOf(lamp));
    expect(app.undo.depth).toBe(1);
    pressUndo();
    expect(game.world.objectColours(bench.id)).toBeNull();
    expect(game.world.objectColours(lamp.id)).toBeNull();
    game.destroy();
  });
});

describe('review: undo coalescing never merges across gestures or tools', () => {
  const pickOnStall = (stall: { anchor: Cell }) => {
    ui().selectPointer();
    inputHandlers!.start(cellOf(stall));
    inputHandlers!.end(cellOf(stall));
  };

  it('inspector picks, then a paint click on the same stall, then more picks: three entries, each undone alone', async () => {
    const { game, app, stall } = await park();
    pickOnStall(stall);
    expect(ui().selectedService).not.toBeNull();
    gameBridge.setSelectedObjectColour(0, 3);
    gameBridge.setSelectedObjectColour(1, 7);
    expect(app.undo.depth).toBe(1);
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    click(cellOf(stall));
    expect(app.undo.depth).toBe(2);
    pickOnStall(stall);
    gameBridge.setSelectedObjectColour(1, 9);
    expect(app.undo.depth, 'the pick after a paint gesture opens its own entry').toBe(3);
    expect(game.world.objectColours(stall.id)).toEqual([TEAL, 9]);
    pressUndo();
    expect(game.world.objectColours(stall.id)).toEqual([TEAL, 7]);
    pressUndo();
    expect(game.world.objectColours(stall.id)).toEqual([3, 7]);
    pressUndo();
    expect(game.world.objectColours(stall.id)).toBeNull();
    game.destroy();
  });

  it('inspector picks, a whole-park preset, then a pick on the same stall: three entries', async () => {
    const { game, app, stall } = await park();
    pickOnStall(stall);
    gameBridge.setSelectedObjectColour(0, 3);
    gameBridge.applyPresetToPark('berry');
    gameBridge.setSelectedObjectColour(0, 0);
    expect(app.undo.depth).toBe(3);
    pressUndo();
    expect(game.world.objectColours(stall.id)).toEqual([7, 6]);
    game.destroy();
  });

  it('two paint clicks on the same object are two entries (a paint gesture is never joined)', async () => {
    const { game, app, stall } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    click(cellOf(stall));
    setBrush({ kind: 'swatch', swatch: 3 });
    click(cellOf(stall));
    expect(app.undo.depth).toBe(2);
    pressUndo();
    expect(game.world.objectColours(stall.id)).toEqual([TEAL, null]);
    game.destroy();
  });

  it('a paint click right after placing a coloured building is its own entry; undo of it keeps the building', async () => {
    const { game, app } = await park();
    setBrush({ kind: 'swatch', swatch: TEAL });
    ui().selectBuild('picnic-pocket');
    inputHandlers!.end({ x: 6, y: 24 });
    const placed = [...game.world.objects.values()].at(-1)!;
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: 3 });
    click(cellOf(placed));
    expect(app.undo.depth).toBe(2);
    pressUndo();
    expect(game.world.objects.has(placed.id), 'a cosmetic undo never removes the building').toBe(true);
    expect(game.world.objectColours(placed.id), 'it goes back to the colour it was placed with').toEqual([TEAL, null]);
    game.destroy();
  });
});

describe('review: one undo entry restores EXACTLY (pre-existing custom records, a coaster and the gate)', () => {
  it('a drag over a coaster, two objects and the gate, then a whole-park preset: two entries, each undo restores byte for byte', async () => {
    const { game, app, stall, bench, lamp } = await park();
    const comet = placeComet(game as never);
    // Pre-existing custom colours on some of the targets.
    game.world.setObjectColours(bench.id, [3, 9]);
    game.world.setObjectColours(comet.id, [null, 5, 11, 13]);
    game.world.setGateColours([null, 4, 20]);
    game.world.setObjectColours(stall.id, [18, null]);
    const before = everyRecord(game as never);
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    // Shift: every part. A drag: comet first cell, then the row with the bench and the lamp, then the gate.
    inputHandlers!.start(comet.cells[0], { shift: true });
    inputHandlers!.move(cellOf(bench));
    inputHandlers!.move(cellOf(lamp));
    inputHandlers!.move(game.world.entrance);
    inputHandlers!.end(game.world.entrance);
    expect(game.world.objectColours(comet.id)).toEqual([TEAL, TEAL, TEAL, TEAL]);
    expect(game.world.gateColours).toEqual([TEAL, TEAL, TEAL]);
    expect(app.undo.depth, 'one gesture').toBe(1);
    const afterDrag = everyRecord(game as never);
    gameBridge.applyPresetToPark('autumn');
    expect(app.undo.depth).toBe(2);
    expect(game.world.objectColours(comet.id)).toEqual(COLOUR_SLOTS['comet-trail'].map((slot) => ({ primary: 0, secondary: 3, trim: 2, rail: 1, support: 13 } as Record<string, number>)[slot.id]));
    pressUndo();
    expect(everyRecord(game as never), 'undo of the preset').toBe(afterDrag);
    pressUndo();
    expect(everyRecord(game as never), 'undo of the drag').toBe(before);
    expect(app.undo.depth).toBe(0);
    game.destroy();
  });
});

describe('review: brushes that must never paint', () => {
  it.fails('FINDING: a preset brush whose id no longer exists changes nothing (today it resets the object to its defaults)', async () => {
    const { game, app, stall } = await park();
    game.world.setObjectColours(stall.id, [TEAL, 3]);
    ui().selectPaint();
    setBrush({ kind: 'preset', presetId: 'retired-preset' as never });
    click(cellOf(stall));
    expect(game.world.objectColours(stall.id)).toEqual([TEAL, 3]);
    expect(app.undo.depth).toBe(0);
    game.destroy();
  });

  it('the eyedropper never turns a path, bare ground or a tree into a brush', async () => {
    const { game, tree } = await park();
    game.world.buildPaths([{ x: 5, y: 20 }]);
    setBrush({ kind: 'swatch', swatch: TEAL });
    ui().selectPaint(true);
    for (const cell of [{ x: 5, y: 20 }, { x: 3, y: 30 }, cellOf(tree)]) {
      inputHandlers!.start(cell, { shift: false });
      inputHandlers!.end(cell);
      expect(ui().paintBrush, JSON.stringify(cell)).toEqual({ kind: 'swatch', swatch: TEAL });
    }
    game.destroy();
  });

  it('a copied coaster brush on a stall paints only the roles the stall has; on a tree nothing', async () => {
    const { game, stall, tree } = await park();
    const comet = placeComet(game as never);
    game.world.setObjectColours(comet.id, [7, 6, 9, 8]);
    ui().selectPaint(true);
    inputHandlers!.start(comet.cells[3], { shift: false });
    inputHandlers!.end(comet.cells[3]);
    expect(ui().paintBrush.kind).toBe('copied');
    expect(ui().paintPicking).toBe(false);
    click(cellOf(stall));
    expect(game.world.objectColours(stall.id)).toEqual([7, 6]);
    click(cellOf(tree));
    expect(game.world.objectColours(tree.id)).toBeNull();
    game.destroy();
  });
});

describe('review: colour before placing never touches the definition', () => {
  it('placing with a swatch, a preset and a copied brush leaves the catalog entry and the slot table as they were', async () => {
    const { BUILD_BY_ID: catalog } = await import('../game/content/catalog');
    const { game } = await park();
    const definitionBefore = JSON.stringify(catalog.get('picnic-pocket'));
    const slotsBefore = JSON.stringify(COLOUR_SLOTS['picnic-pocket']);
    const brushes = [
      { kind: 'swatch', swatch: TEAL },
      { kind: 'preset', presetId: 'meadow' },
      { kind: 'copied', sourceName: 'X', roles: { primary: 0, secondary: 1 } },
    ] as const;
    const cells = [{ x: 6, y: 24 }, { x: 10, y: 24 }, { x: 6, y: 28 }];
    brushes.forEach((brush, index) => {
      setBrush(brush as never);
      ui().selectBuild('picnic-pocket');
      inputHandlers!.end(cells[index]);
    });
    const placed = [...game.world.objects.values()].filter((object) => object.definitionId === 'picnic-pocket').slice(-3);
    expect(placed.map((object) => object.colours ?? null)).toEqual([[TEAL, null], [18, 8], [0, 1]]);
    expect(JSON.stringify(catalog.get('picnic-pocket'))).toBe(definitionBefore);
    expect(JSON.stringify(COLOUR_SLOTS['picnic-pocket'])).toBe(slotsBefore);
    // Each placed record is its own frozen array (no aliasing between placements or with the brush).
    expect(new Set(placed.map((object) => object.colours)).size).toBe(3);
    expect(placed.every((object) => Object.isFrozen(object.colours))).toBe(true);
    game.destroy();
  });
});

describe('review: colours through a real save, every step-2 kind and the gate', () => {
  it('a painted coaster, stall, bench, lamp and gate survive a manual save, a new park and a load', async () => {
    const { game, app, stall, bench, lamp } = await park();
    (game as unknown as { parkChosen: boolean }).parkChosen = true;
    const comet = placeComet(game as never);
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    inputHandlers!.start(comet.cells[0], { shift: true });
    inputHandlers!.end(comet.cells[0]);
    click(game.world.entrance);
    gameBridge.applyPresetToPark('seaside');
    setBrush({ kind: 'swatch', swatch: 3 });
    click(cellOf(bench), true);
    click(cellOf(lamp));
    const before = everyRecord(game as never);
    expect(game.world.gateColours).not.toBeNull();
    const saved = await saveBridge.saveToSlot('manual-1', 'Painted');
    expect(saved.ok).toBe(true);
    game.startScenario(null);
    await settle();
    expect(game.world.objects.has(stall.id)).toBe(false);
    const loaded = await saveBridge.load('manual-1');
    expect(loaded.ok).toBe(true);
    expect(everyRecord(game as never)).toBe(before);
    expect(app.undo.depth).toBe(0);
    game.destroy();
  });
});
