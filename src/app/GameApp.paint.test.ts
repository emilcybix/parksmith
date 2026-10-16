import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 28 step 2, GameApp's side of the Paint tool, presets and colour before placing: the pointer handlers
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
const { runBridge } = await import('../ui/runBridge');
const { useUiStore } = await import('../ui/store');
const { BUILD_BY_ID: BUILD } = await import('../game/content/catalog');
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

const toast = (): string | null => useUiStore.getState().toast;

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

describe('the Paint tool: arming, hover, readout', () => {
  it('C arms the tool and I arms it in pick mode; both are build-capability keys', async () => {
    const { game } = await park();
    press('c', 'KeyC');
    expect(ui().tool).toBe('paint');
    expect(ui().paintPicking).toBe(false);
    press('i', 'KeyI');
    expect(ui().tool).toBe('paint');
    expect(ui().paintPicking).toBe(true);
    press('c', 'KeyC');
    expect(ui().paintPicking, 'C arms the plain tool again').toBe(false);
    game.destroy();
  });

  it('hover over an object outlines its footprint through the overlay seam, tinted with the brush swatch, and fills the readout', async () => {
    const { game, stall } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    paintHovers.length = 0;
    inputHandlers!.hover(cellOf(stall));
    const hover = paintHovers.at(-1)!;
    expect(hover.cells).toEqual(game.world.objectFootprint(stall));
    expect(hover.tint, 'the swatch classic colour').toBe(0x3aa7a3);
    expect(ui().paintReadout).toMatchObject({ title: 'Paint · Picnic Pocket', detail: 'Main to Teal', muted: false });
    log.length = 0;
    inputHandlers!.hover({ x: 3, y: 3 });
    expect(paintHovers.at(-1), 'empty ground: nothing to paint, outline off').toBeNull();
    expect(ui().paintReadout?.muted).toBe(true);
    expect(log, 'the paint hover never calls the build ghost').not.toContain('drawPreview');
    inputHandlers!.hover(null);
    expect(paintHovers.at(-1)).toBeNull();
    game.destroy();
  });

  it('a tree is not paintable: no outline, and the readout says why; Accent on the fountain says there is no such part', async () => {
    const { game, tree } = await park();
    const fountain = game.world.seedScenarioObject('ripple-fountain', { x: 5, y: 20 }, 0)!;
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    inputHandlers!.hover(cellOf(tree));
    expect(paintHovers.at(-1)).toBeNull();
    expect(ui().paintReadout?.detail).toBe('Trees keep their colours');
    ui().setPaintTarget('secondary');
    inputHandlers!.hover(cellOf(fountain));
    expect(ui().paintReadout?.detail).toBe('No Accent part');
    game.destroy();
  });

  it('a preset or default brush has no tint; the gate and a coaster-like footprint are targets too', async () => {
    const { game } = await park();
    ui().selectPaint();
    setBrush({ kind: 'preset', presetId: 'seaside' });
    inputHandlers!.hover(game.world.entrance);
    expect(paintHovers.at(-1)).toEqual({ cells: [game.world.entrance], tint: null });
    expect(ui().paintReadout).toMatchObject({ title: 'Paint · Entrance gate', detail: 'Seaside colours' });
    game.destroy();
  });

  it('changing the brush redraws the hover at once, without a mouse move; Esc puts the tool down and clears it', async () => {
    const { game, stall } = await park();
    ui().selectPaint();
    hovered = cellOf(stall);
    inputHandlers!.hover(hovered);
    const count = paintHovers.length;
    setBrush({ kind: 'swatch', swatch: 4 });
    expect(paintHovers.length, 'the new brush tints the outline now').toBeGreaterThan(count);
    expect(paintHovers.at(-1)?.tint).not.toBe(0x3aa7a3);
    press('Escape', 'Escape');
    expect(ui().tool).toBe('pointer');
    expect(paintHovers.at(-1)).toBeNull();
    expect(ui().paintReadout).toBeNull();
    game.destroy();
  });

  it('eyedropper hover says what a click copies', async () => {
    const { game, stall } = await park();
    ui().selectPaint(true);
    inputHandlers!.hover(cellOf(stall));
    expect(ui().paintReadout).toMatchObject({ title: 'Pick · Picnic Pocket', detail: 'Click to copy its colours' });
    game.destroy();
  });
});

describe('the Paint tool: click, Shift, drag', () => {
  it('a click paints Main and takes ONE cosmetic undo entry named for the object', async () => {
    const { game, app, stall } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    click(cellOf(stall));
    expect(game.world.objectColours(stall.id)).toEqual([TEAL, null]);
    expect(app.undo.depth).toBe(1);
    expect(app.undo.newest).toMatchObject({ kind: 'recolour', label: 'Painted Picnic Pocket' });
    expect(useUiStore.getState().undoStatus.rewindSeconds).toBe(0);
    game.destroy();
  });

  it('Shift, read at pointer down, paints every part; the Accent target paints the accent only', async () => {
    const { game, bench, stall } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    click(cellOf(bench), true);
    expect(game.world.objectColours(bench.id)).toEqual([TEAL, TEAL]);
    ui().setPaintTarget('secondary');
    click(cellOf(stall));
    expect(game.world.objectColours(stall.id)).toEqual([null, TEAL]);
    game.destroy();
  });

  it('a preset or a copied brush paints every part whatever the target', async () => {
    const { game, stall, bench } = await park();
    ui().selectPaint();
    setBrush({ kind: 'preset', presetId: 'midnight' }, 'primary');
    click(cellOf(stall));
    expect(game.world.objectColours(stall.id)).toEqual([12, 4]);
    setBrush({ kind: 'copied', sourceName: 'Test', roles: { primary: 7, secondary: 6 } }, 'primary');
    click(cellOf(bench));
    expect(game.world.objectColours(bench.id)).toEqual([7, 6]);
    game.destroy();
  });

  it('a drag paints every object it crosses once, as ONE undo entry, and Ctrl+Z puts them all back', async () => {
    const { game, app, stall, bench, lamp, tree } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    // The bench (14,6), the lamp (16,6) and the tree (18,6) lie on one row: drag along it.
    inputHandlers!.start(cellOf(bench), { shift: false });
    inputHandlers!.move({ x: 15, y: 6 });
    inputHandlers!.move(cellOf(lamp));
    inputHandlers!.move({ x: 17, y: 6 });
    inputHandlers!.move(cellOf(tree));
    inputHandlers!.move(cellOf(bench));
    inputHandlers!.end(cellOf(bench));
    expect(game.world.objectColours(bench.id)).toEqual([TEAL, null]);
    expect(game.world.objectColours(lamp.id)).toEqual([TEAL, null]);
    expect(game.world.objectColours(tree.id), 'the tree is skipped').toBeNull();
    expect(game.world.objectColours(stall.id), 'an object off the path is untouched').toBeNull();
    expect(app.undo.depth, 'one entry for the drag').toBe(1);
    expect(app.undo.newest?.label).toBe('Painted 2 things');
    pressUndo();
    expect(game.world.objectColours(bench.id)).toBeNull();
    expect(game.world.objectColours(lamp.id)).toBeNull();
    expect(app.undo.depth).toBe(0);
    game.destroy();
  });

  it('the Shift state of the pointer down governs the whole drag', async () => {
    const { game, bench, lamp } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    inputHandlers!.start(cellOf(bench), { shift: true });
    inputHandlers!.move(cellOf(lamp));
    inputHandlers!.end(cellOf(lamp));
    expect(game.world.objectColours(bench.id)).toEqual([TEAL, TEAL]);
    expect(game.world.objectColours(lamp.id)).toEqual([TEAL, TEAL]);
    game.destroy();
  });

  it('a drag over bare ground, a path or an object that already looks right makes no entry', async () => {
    const { game, app, stall } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    inputHandlers!.start({ x: 2, y: 2 }, { shift: false });
    inputHandlers!.move({ x: 9, y: 4 });
    inputHandlers!.end({ x: 9, y: 4 });
    expect(app.undo.depth).toBe(0);
    click(cellOf(stall));
    expect(app.undo.depth).toBe(1);
    click(cellOf(stall));
    expect(app.undo.depth, 'painting Teal on Teal changes nothing and is not an entry').toBe(1);
    expect(toast()).toBe('Already these colours');
    game.destroy();
  });

  it('the default brush puts the shipped colours back, and a tree click toasts why', async () => {
    const { game, stall, tree } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    click(cellOf(stall));
    setBrush({ kind: 'default' });
    click(cellOf(stall));
    expect(game.world.objectColours(stall.id)).toBeNull();
    click(cellOf(tree));
    expect(toast()).toBe('Trees keep their colours');
    game.destroy();
  });

  it('the entrance gate is painted by its cell, and its undo restores the gate too', async () => {
    const { game, app } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    click(game.world.entrance);
    expect(game.world.gateColours).toEqual([TEAL, null, null]);
    expect(app.undo.newest?.label).toBe('Painted Entrance gate');
    pressUndo();
    expect(game.world.gateColours).toBeNull();
    game.destroy();
  });

  it('a pointer down that never saw its up is settled by the next one (no leaked snapshot)', async () => {
    const { game, app, bench, lamp } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    inputHandlers!.start(cellOf(bench), { shift: false });
    inputHandlers!.start(cellOf(lamp), { shift: false });
    inputHandlers!.end(cellOf(lamp));
    expect(app.undo.depth).toBe(2);
    expect(app.undo.hasPending).toBe(false);
    game.destroy();
  });

  it('Ctrl+Z in the middle of a drag keeps the drag going without losing the entry', async () => {
    const { game, app, bench, lamp } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    inputHandlers!.start(cellOf(bench), { shift: false });
    pressUndo();
    expect(game.world.objectColours(bench.id), 'the partial drag is undone').toBeNull();
    inputHandlers!.move(cellOf(lamp));
    inputHandlers!.end(cellOf(lamp));
    expect(game.world.objectColours(lamp.id)).toEqual([TEAL, null]);
    expect(app.undo.depth).toBe(1);
    game.destroy();
  });

  it('right-click (cancel) keeps what was painted as one entry and puts the tool down', async () => {
    const { game, app, bench, lamp } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    inputHandlers!.start(cellOf(bench), { shift: false });
    inputHandlers!.move(cellOf(lamp));
    inputHandlers!.cancel();
    expect(game.world.objectColours(lamp.id)).toEqual([TEAL, null]);
    expect(app.undo.depth).toBe(1);
    expect(ui().tool).toBe('pointer');
    game.destroy();
  });

  it('painting does not open the inspector and does not change the selection', async () => {
    const { game, stall } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    click(cellOf(stall));
    expect(ui().selectedService).toBeNull();
    expect(ui().selectedRide).toBeNull();
    game.destroy();
  });
});

describe('the paint panel and the inspector share one slot', () => {
  it('arming the paint tool closes an open inspector, and inspecting from the Buildings tab puts the tool down', async () => {
    const { game, stall } = await park();
    ui().selectPointer();
    inputHandlers!.start(cellOf(stall));
    expect(ui().selectedService).not.toBeNull();
    press('c', 'KeyC');
    expect(ui().tool).toBe('paint');
    expect(ui().selectedService, 'the inspector closed').toBeNull();
    game.focusBuilding(stall.id);
    expect(ui().tool, 'the pointer is back').toBe('pointer');
    expect(ui().selectedService?.definitionId).toBe('picnic-pocket');
    game.destroy();
  });
});

describe('the eyedropper', () => {
  it('copies the colours of what is under the cursor into the brush, turns pick mode off and makes no undo entry', async () => {
    const { game, app, stall, bench } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    click(cellOf(stall));
    expect(app.undo.depth).toBe(1);
    ui().selectPaint(true);
    click(cellOf(stall));
    expect(ui().paintBrush).toMatchObject({ kind: 'copied', sourceName: 'Picnic Pocket' });
    expect(ui().paintPicking).toBe(false);
    expect(app.undo.depth, 'picking is not an edit').toBe(1);
    click(cellOf(bench));
    expect(game.world.objectColours(bench.id), 'the copied brush paints the roles: Walls Teal, roof the default swatch or none').toEqual([TEAL, null]);
    game.destroy();
  });

  it('a tree cannot be picked, a click on nothing does nothing', async () => {
    const { game, tree } = await park();
    ui().selectPaint(true);
    click(cellOf(tree));
    expect(ui().paintBrush.kind).toBe('default');
    expect(ui().paintPicking, 'still picking').toBe(true);
    click({ x: 3, y: 3 });
    expect(ui().paintPicking).toBe(true);
    game.destroy();
  });
});

describe('a preset on the whole park', () => {
  it('recolours every colourable object and the gate as ONE undo entry; undo brings everything back', async () => {
    const { game, app, stall, carousel, tree } = await park();
    const before = JSON.stringify([...game.world.objects.values()].map((object) => [object.id, object.colours ?? null]));
    gameBridge.applyPresetToPark('seaside');
    expect(game.world.objectColours(stall.id)).toEqual([16, 6]);
    expect(game.world.objectColours(carousel.id)).not.toBeNull();
    expect(game.world.objectColours(tree.id), 'trees stay fixed').toBeNull();
    expect(game.world.gateColours).not.toBeNull();
    expect(app.undo.depth).toBe(1);
    expect(app.undo.newest?.label).toBe('Seaside colours for the park');
    expect(toast()).toMatch(/^Seaside: \d+ things recoloured$/);
    pressUndo();
    expect(JSON.stringify([...game.world.objects.values()].map((object) => [object.id, object.colours ?? null]))).toBe(before);
    expect(game.world.gateColours).toBeNull();
    game.destroy();
  });

  it('Candy is the reset, applying a preset the park already wears is a no-op, and an unknown preset does nothing', async () => {
    const { game, app, stall } = await park();
    gameBridge.applyPresetToPark('midnight');
    expect(app.undo.depth).toBe(1);
    gameBridge.applyPresetToPark('midnight');
    expect(app.undo.depth, 'already wearing it').toBe(1);
    expect(toast()).toBe('The park already wears Midnight');
    gameBridge.applyPresetToPark('candy');
    expect(game.world.objectColours(stall.id)).toBeNull();
    expect(game.world.gateColours).toBeNull();
    expect(app.undo.depth).toBe(2);
    gameBridge.applyPresetToPark('nope' as never);
    expect(app.undo.depth).toBe(2);
    game.destroy();
  });

  it('is free in the Sandbox: no transaction, no version bump', async () => {
    const { game } = await park();
    const before = { cash: game.world.cash, version: game.world.version, transactions: game.world.transactions.length };
    gameBridge.applyPresetToPark('autumn');
    expect({ cash: game.world.cash, version: game.world.version, transactions: game.world.transactions.length }).toEqual(before);
    game.destroy();
  });
});

describe('colour before placing', () => {
  it('the ghost request carries the brush record, the placed object has it, and undo removes the whole building', async () => {
    const { game, app } = await park();
    setBrush({ kind: 'swatch', swatch: TEAL });
    ui().selectBuild('picnic-pocket');
    previews.length = 0;
    inputHandlers!.hover({ x: 6, y: 24 });
    expect(previews.at(-1)?.[5], 'drawPreview(..., colours)').toEqual([TEAL, null]);
    const count = game.world.objects.size;
    inputHandlers!.end({ x: 6, y: 24 });
    const placed = [...game.world.objects.values()].at(-1)!;
    expect(game.world.objects.size).toBe(count + 1);
    expect(placed.definitionId).toBe('picnic-pocket');
    expect(game.world.objectColours(placed.id)).toEqual([TEAL, null]);
    expect(app.undo.depth).toBe(1);
    expect(app.undo.newest?.label).toBe('Picnic Pocket built');
    pressUndo();
    expect(game.world.objects.size).toBe(count);
    game.destroy();
  });

  it('a preset gives the new building its roles, the default brush and a non-colourable card give none', async () => {
    const { game } = await park();
    setBrush({ kind: 'preset', presetId: 'midnight' });
    ui().selectBuild('ribbon-bench');
    inputHandlers!.end({ x: 6, y: 26 });
    const bench = [...game.world.objects.values()].at(-1)!;
    expect(game.world.objectColours(bench.id)).toEqual([12, 4]);
    ui().selectBuild('confetti-tree');
    previews.length = 0;
    inputHandlers!.hover({ x: 8, y: 26 });
    expect(previews.at(-1)?.[5], 'trees take no colour').toBeNull();
    inputHandlers!.end({ x: 8, y: 26 });
    const tree = [...game.world.objects.values()].at(-1)!;
    expect(game.world.objectColours(tree.id)).toBeNull();
    setBrush({ kind: 'default' });
    ui().selectBuild('ribbon-bench');
    inputHandlers!.end({ x: 10, y: 26 });
    expect(game.world.objectColours([...game.world.objects.values()].at(-1)!.id)).toBeNull();
    game.destroy();
  });

  it('a brush change redraws the ghost under a still cursor (a new request, not a stale one)', async () => {
    const { game } = await park();
    ui().selectBuild('picnic-pocket');
    hovered = { x: 6, y: 24 };
    inputHandlers!.hover(hovered);
    previews.length = 0;
    setBrush({ kind: 'swatch', swatch: 4 });
    expect(previews.at(-1)?.[5]).toEqual([4, null]);
    game.destroy();
  });

  it('a coaster is built with the brush colours (Train, Seats, Rails, Supports by role) and the draft is drawn in them', async () => {
    const { game, app } = await park();
    game.world.setBuildAccessPolicy(null);
    setBrush({ kind: 'preset', presetId: 'seaside' });
    ui().selectBuild('comet-trail');
    const pieces: Array<{ cell: Cell; height: number }> = [];
    let x = 2;
    let y = 24;
    for (const move of 'EEENENEESSSWWWWWWN') {
      pieces.push({ cell: { x, y }, height: pieces.length < 3 ? 0 : 1 });
      if (move === 'E') x += 1; else if (move === 'W') x -= 1; else if (move === 'S') y += 1; else y -= 1;
    }
    (app as unknown as { coasterDraft: unknown[] }).coasterDraft = pieces.map((piece, index) => ({ ...piece, height: [0, 0, 0, 1, 2, 2, 2, 1, 1, 2, 2, 2, 1, 1, 0, 0, 0, 0][index] }));
    const drafts: unknown[][] = [];
    (game as unknown as { renderer: { drawCoasterDraft: (...args: unknown[]) => void } }).renderer.drawCoasterDraft = (...args: unknown[]) => { drafts.push(args); };
    setBrush({ kind: 'swatch', swatch: 4 });
    (game as unknown as { refreshCoasterPreview(): void }).refreshCoasterPreview();
    expect(drafts.at(-1)?.[4], 'drawCoasterDraft(..., colours)').toEqual([4, null, null, null]);
    setBrush({ kind: 'preset', presetId: 'seaside' });
    const before = [...game.world.objects.keys()];
    game.coasterBuild();
    const built = [...game.world.objects.values()].find((object) => !before.includes(object.id));
    expect(built?.definitionId, game.world.coasters.size === 0 ? toast() ?? '' : '').toBe('comet-trail');
    expect(game.world.objectColours(built!.id)).toEqual([16, 6, 14, 20]);
    expect(app.undo.newest?.label).toBe('Comet Trail built');
    pressUndo();
    expect(game.world.objects.has(built!.id)).toBe(false);
    game.destroy();
  });

  it('placing is free even where a recolour is priced', async () => {
    const { game } = await park();
    setBrush({ kind: 'swatch', swatch: TEAL });
    ui().selectBuild('ribbon-bench');
    const cash = game.world.cash;
    inputHandlers!.end({ x: 6, y: 26 });
    expect(game.world.cash, 'only the bench price, no recolour fee').toBe(cash - game.world.objectCost(BUILD.get('ribbon-bench')!));
    game.destroy();
  });
});

describe('the inspector works for stalls and coasters through the generalised bridge', () => {
  it('a stall inspector pick recolours the stall, publishes selectedColours, and joins one undo entry', async () => {
    const { game, app, stall } = await park();
    ui().selectPointer();
    inputHandlers!.start(cellOf(stall));
    expect(ui().selectedService?.definitionId).toBe('picnic-pocket');
    gameBridge.setSelectedObjectColour(1, 7);
    gameBridge.setSelectedObjectColour(0, 19);
    expect(game.world.objectColours(stall.id)).toEqual([19, 7]);
    expect(ui().selectedColours).toEqual([19, 7]);
    expect(app.undo.depth).toBe(1);
    gameBridge.resetSelectedObjectColours();
    expect(game.world.objectColours(stall.id)).toBeNull();
    game.destroy();
  });
});

describe('what a recolour costs (data and plumbing only)', () => {
  const priced = async (config: { scenario: number; map: number }, run: () => Promise<void>): Promise<void> => {
    const { GAME_CONFIG: shipped } = await import('../game/config');
    const table = shipped.colours.recolourCostPerObject as { scenario: number; map: number };
    const saved = { ...table };
    Object.assign(table, config);
    try { await run(); } finally { Object.assign(table, saved); }
  };

  it('is free by default in every mode: nothing is posted', async () => {
    const { game, stall, bench } = await park();
    ui().selectPaint();
    setBrush({ kind: 'swatch', swatch: TEAL });
    click(cellOf(stall));
    click(cellOf(bench), true);
    expect(game.world.transactions.filter((entry) => entry.label === 'Repainting')).toHaveLength(0);
    game.destroy();
  });

  it('the Sandbox stays free even when the config prices a Scenario', async () => {
    await priced({ scenario: 20, map: 30 }, async () => {
      const { game, stall } = await park();
      ui().selectPaint();
      setBrush({ kind: 'swatch', swatch: TEAL });
      const cash = game.world.cash;
      click(cellOf(stall));
      expect(game.world.cash).toBe(cash);
      game.destroy();
    });
  });

  it('in a Scenario a gesture is charged ONCE, for the objects it changed, and its undo refunds it', async () => {
    await priced({ scenario: 20, map: 30 }, async () => {
      const game = await makeGame();
      game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
      await settle();
      game.world.addMoney(500_000);
      const bench = game.world.buildObject('ribbon-bench', { x: 14, y: 6 })!;
      const lamp = game.world.buildObject('lollipop-lamp', { x: 16, y: 6 })!;
      ui().selectPaint();
      setBrush({ kind: 'swatch', swatch: TEAL });
      const cash = game.world.cash;
      const transactions = game.world.transactions.length;
      inputHandlers!.start(cellOf(bench), { shift: false });
      inputHandlers!.move(cellOf(lamp));
      expect(game.world.cash, 'nothing is charged mid-drag').toBe(cash);
      inputHandlers!.end(cellOf(lamp));
      expect(game.world.cash, 'two objects, 20 each').toBe(cash - 40);
      expect(game.world.transactions.length - transactions, 'one transaction for the gesture').toBe(1);
      expect(game.world.transactions[0]).toMatchObject({ amount: -40, label: 'Repainting', category: 'construction' });
      expect(toast()).toBe('Painted 2 things · -$40');
      pressUndo();
      expect(game.world.objectColours(bench.id)).toBeNull();
      expect(game.world.cash, 'the undo posts the same amount back').toBe(cash);
      expect(game.world.transactions[0]).toMatchObject({ amount: 40, category: 'refund' });
      game.destroy();
    });
  });

  it('the park rule recolourCostMultiplier scales it, and The Map has its own price', async () => {
    await priced({ scenario: 20, map: 30 }, async () => {
      const game = await makeGame();
      game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
      await settle();
      game.world.addMoney(500_000);
      const bench = game.world.buildObject('ribbon-bench', { x: 14, y: 6 })!;
      (game as unknown as { session: { rules: { recolourCostMultiplier: number } } }).session.rules.recolourCostMultiplier = 2;
      ui().selectPaint();
      setBrush({ kind: 'swatch', swatch: TEAL });
      let cash = game.world.cash;
      click(cellOf(bench));
      expect(game.world.cash).toBe(cash - 40);
      // A stage of The Map (mode 'run') has its own price.
      runBridge.startRun(3, 'standard');
      runBridge.acceptRunOffer();
      runBridge.startRunStage([]);
      await settle();
      expect((game as unknown as { session: { mode: string } }).session.mode).toBe('run');
      game.world.addMoney(500_000);
      let mapBench: ReturnType<typeof game.world.buildObject> = null;
      for (let y = 0; y < game.world.height && mapBench === null; y += 1) {
        for (let x = 0; x < game.world.width && mapBench === null; x += 1) mapBench = game.world.buildObject('ribbon-bench', { x, y });
      }
      expect(mapBench).not.toBeNull();
      (game as unknown as { session: { rules: { recolourCostMultiplier: number } } }).session.rules.recolourCostMultiplier = 2;
      ui().selectPaint();
      setBrush({ kind: 'swatch', swatch: TEAL });
      cash = game.world.cash;
      click(cellOf(mapBench!));
      expect(game.world.cash, 'The Map: 30 x 2').toBe(cash - 60);
      game.destroy();
    });
  });

  it('a gesture that would overdraw stops at the object it cannot pay for; what it painted stays', async () => {
    await priced({ scenario: 50, map: 50 }, async () => {
      const game = await makeGame();
      game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
      await settle();
      const bench = game.world.buildObject('ribbon-bench', { x: 14, y: 6 })!;
      const lamp = game.world.buildObject('lollipop-lamp', { x: 16, y: 6 })!;
      const world = game.world as unknown as { cash: number };
      world.cash = 70;
      ui().selectPaint();
      setBrush({ kind: 'swatch', swatch: TEAL });
      inputHandlers!.start(cellOf(bench), { shift: false });
      inputHandlers!.move(cellOf(lamp));
      inputHandlers!.end(cellOf(lamp));
      expect(game.world.objectColours(bench.id)).toEqual([TEAL, null]);
      expect(game.world.objectColours(lamp.id), 'the second object would take the total to 100').toBeNull();
      expect(game.world.cash).toBe(20);
      expect(toast()).toMatch(/Not enough cash to repaint more/);
      game.destroy();
    });
  });

  it('an inspector pick series is charged once (by the pick that opens it) and a preset on the park once for all it changes', async () => {
    await priced({ scenario: 10, map: 10 }, async () => {
      const game = await makeGame();
      game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
      await settle();
      game.world.addMoney(500_000);
      const stall = game.world.buildObject('picnic-pocket', { x: 10, y: 10 })!;
      ui().selectPointer();
      inputHandlers!.start(cellOf(stall));
      let cash = game.world.cash;
      gameBridge.setSelectedObjectColour(0, 19);
      gameBridge.setSelectedObjectColour(1, 7);
      gameBridge.setSelectedObjectColour(0, 3);
      expect(game.world.cash, 'three picks, one series, one fee').toBe(cash - 10);
      pressUndo();
      expect(game.world.cash, 'refunded').toBe(cash);
      cash = game.world.cash;
      gameBridge.applyPresetToPark('seaside');
      const changed = [...game.world.objects.values()].filter((object) => object.colours).length + (game.world.gateColours ? 1 : 0);
      expect(game.world.cash).toBe(cash - 10 * changed);
      game.destroy();
    });
  });

  it('a preset the player cannot afford is refused as a whole, and a priced pick the player cannot afford changes nothing', async () => {
    await priced({ scenario: 50, map: 50 }, async () => {
      const game = await makeGame();
      game.startPark({ mode: 'scenario', scenarioId: 'sunny-start', cardIds: [] });
      await settle();
      const stall = game.world.buildObject('picnic-pocket', { x: 10, y: 10 })!;
      (game.world as unknown as { cash: number }).cash = 40;
      gameBridge.applyPresetToPark('seaside');
      expect(game.world.objectColours(stall.id)).toBeNull();
      expect(toast()).toMatch(/Not enough cash to recolour the park/);
      ui().selectPointer();
      inputHandlers!.start(cellOf(stall));
      gameBridge.setSelectedObjectColour(0, 19);
      expect(game.world.objectColours(stall.id)).toBeNull();
      game.destroy();
    });
  });
});
