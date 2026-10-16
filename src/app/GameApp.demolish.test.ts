import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 11 (PA-015) in GameApp: demolish from the inspector (the button's bridge command and Delete / Backspace), the
 * confirmation's place in the Escape order, the undo entry, and the bulldozer's two-click rule for a coaster. Fake
 * renderer and stubbed window as in GameApp.undo.test.ts; the fake stands in for the classic renderer (the mocked
 * `WorldRenderer`), so this is also the classic path.
 */

type CellLike = { x: number; y: number };
type Handlers = {
  hover(cell: CellLike | null): void;
  start(cell: CellLike): void;
  move(cell: CellLike): void;
  end(cell: CellLike): void;
  cancel(): void;
};
let inputHandlers: Handlers | null = null;
let frameCallback: ((deltaMs: number) => void) | null = null;
const previews: Array<{ cells: CellLike[]; valid: boolean; demolition: boolean }> = [];
const focusCalls: Array<{ kind: 'cell' | 'entrance'; motion: string | undefined }> = [];

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
  setWeather(): void {}
  setInputHandlers(handlers: Handlers): void { inputHandlers = handlers; }
  setViewInputEnabled(): void {}
  setToolCursor(): void {}
  focusCell(_cell: CellLike, motion?: string): void { focusCalls.push({ kind: 'cell', motion }); }
  focusEntrance(motion?: string): void { focusCalls.push({ kind: 'entrance', motion }); }
  setGridVisible(): void {}
  setSceneryInfluenceVisible(): void {}
  selectObject(): void {}
  drawPreview(cells: CellLike[], _definition: unknown, valid: boolean, demolition = false): void {
    previews.push({ cells: cells.map((cell) => ({ x: cell.x, y: cell.y })), valid, demolition });
  }
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
const { BUILD_BY_ID } = await import('../game/content/catalog');
const { COASTER_TYPE_BY_ID } = await import('../game/coaster/content');
const { coasterBaseCost, deriveCoasterStats } = await import('../game/coaster/design');
const { coasterArmedText, coasterHoverText, DEMOLISH_DURING_DRAFT_MESSAGE, demolitionToast } = await import('./placementFeedback');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();

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
  game.world.addMoney(200_000);
  runFrames(8);
  return game;
};

interface Internals {
  undo: { depth: number; hasPending: boolean; newest: { label: string; kind: string } | null };
  armedCoasterId: number | null;
  coasterDraft: unknown[];
}
const internals = (game: unknown) => game as Internals;

const runFrames = (count: number, deltaMs = 250): void => {
  for (let i = 0; i < count; i += 1) frameCallback?.(deltaMs);
};

const keydown = (key: string, extra: Record<string, unknown> = {}): { prevented: boolean } => {
  let prevented = false;
  for (const handler of handlers.get('keydown') ?? []) {
    handler({
      type: 'keydown', key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null,
      preventDefault: () => { prevented = true; }, ...extra,
    });
  }
  return { prevented };
};

const ui = () => useUiStore.getState();

const CAROUSEL = BUILD_BY_ID.get('moonpetal-carousel')!;
const PICNIC = BUILD_BY_ID.get('picnic-pocket')!;
const COMET_DEF = BUILD_BY_ID.get('comet-trail')!;
const COMET = COASTER_TYPE_BY_ID.get('comet-trail')!;

/** A 20-piece loop from (10,10) to (17,13), height 2 along the top (the World.demolish.test.ts layout). */
const placeLoop = (game: InstanceType<typeof GameApp>): number => {
  const pieces: Array<{ cell: CellLike; height: number }> = [];
  for (let x = 10; x <= 17; x += 1) pieces.push({ cell: { x, y: 10 }, height: 0 });
  for (let y = 11; y <= 13; y += 1) pieces.push({ cell: { x: 17, y }, height: 0 });
  for (let x = 16; x >= 10; x -= 1) pieces.push({ cell: { x, y: 13 }, height: 0 });
  for (let y = 12; y >= 11; y -= 1) pieces.push({ cell: { x: 10, y }, height: 0 });
  const heights = [0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
  const laid = pieces.map((piece, index) => ({ ...piece, height: heights[index] }));
  const placed = game.world.placeCoaster('comet-trail', laid, deriveCoasterStats(laid, COMET), coasterBaseCost(laid, COMET));
  if ('error' in placed) throw new Error(`the test coaster should place: ${JSON.stringify(placed)}`);
  return placed.id;
};

beforeEach(() => {
  inputHandlers = null;
  frameCallback = null;
  previews.length = 0;
  focusCalls.length = 0;
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
  ui().setToast(null);
  ui().selectPointer();
  ui().closeDemolishConfirm();
});

afterEach(() => {
  for (const game of games.splice(0)) game.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('demolish from the inspector', () => {
  it('publishes the refund with the selection and demolishes as one named undo entry that restores the ride', async () => {
    const game = await makeGame();
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    game.focusBuilding(ride.id);
    expect(focusCalls.at(-1), 'an estate row click eases the camera').toEqual({ kind: 'cell', motion: 'ease' });
    const refund = game.world.demolitionRefund(ride.id)!;
    expect(refund).toBeGreaterThan(0);
    expect(ui().selectedDemolitionRefund).toBe(refund);
    const depth = internals(game).undo.depth;
    const cashBefore = game.world.cash;

    ui().openDemolishConfirm(ride.id);
    gameBridge.demolishSelected();
    expect(game.world.objects.has(ride.id)).toBe(false);
    expect(game.world.cash).toBe(cashBefore + refund);
    expect(internals(game).undo.depth).toBe(depth + 1);
    expect(internals(game).undo.newest).toMatchObject({ kind: 'demolition', label: `${CAROUSEL.name} demolished` });
    expect(ui().toast).toBe(demolitionToast([CAROUSEL.name], refund));
    expect(ui().toastClass).toBe('routine');
    expect(ui().selectedRide).toBeNull();
    expect(ui().selectedDemolitionRefund).toBeNull();
    expect(ui().demolishConfirmId).toBeNull();

    gameBridge.requestUndo();
    expect([...game.world.objects.values()].some((object) => object.definitionId === CAROUSEL.id), 'undo brings the ride back').toBe(true);
  });

  it('demolishes a stall the same way', async () => {
    const game = await makeGame();
    const stall = game.world.buildObject(PICNIC.id, { x: 6, y: 6 })!;
    game.focusBuilding(stall.id);
    expect(ui().selectedService).not.toBeNull();
    expect(ui().selectedDemolitionRefund).toBe(game.world.demolitionRefund(stall.id));
    gameBridge.demolishSelected();
    expect(game.world.objects.has(stall.id)).toBe(false);
    expect(internals(game).undo.newest?.label).toBe(`${PICNIC.name} demolished`);
  });

  it('does nothing with nothing inspected, and refuses while a coaster layout is open', async () => {
    const game = await makeGame();
    gameBridge.demolishSelected();
    expect(internals(game).undo.newest).toBeNull();
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    game.focusBuilding(ride.id);
    internals(game).coasterDraft.push({ cell: { x: 2, y: 2 }, height: 0 });
    gameBridge.demolishSelected();
    expect(game.world.objects.has(ride.id)).toBe(true);
    expect(ui().toast).toBe(DEMOLISH_DURING_DRAFT_MESSAGE);
    expect(ui().toastClass).toBe('alert');
    internals(game).coasterDraft.length = 0;
  });
});

describe('Delete and Backspace', () => {
  it('open the confirmation in the inspector layer only, and never demolish', async () => {
    const game = await makeGame();
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    // No inspector: nothing happens, and the key is left alone.
    expect(keydown('Delete').prevented).toBe(false);
    expect(ui().demolishConfirmId).toBeNull();

    game.focusBuilding(ride.id);
    expect(keydown('Delete').prevented).toBe(true);
    expect(ui().demolishConfirmId).toBe(ride.id);
    // A second press (focus is on Keep it) cannot demolish.
    keydown('Delete');
    expect(game.world.objects.has(ride.id)).toBe(true);
    ui().closeDemolishConfirm();
    keydown('Backspace');
    expect(ui().demolishConfirmId).toBe(ride.id);
  });

  it('is ignored with Ctrl, Alt or Meta held, on key repeat, and in a text field', async () => {
    const game = await makeGame();
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    game.focusBuilding(ride.id);
    keydown('Delete', { ctrlKey: true });
    keydown('Delete', { altKey: true });
    keydown('Backspace', { metaKey: true });
    keydown('Delete', { repeat: true });
    const field = { tagName: 'INPUT', type: 'text', isContentEditable: false, getAttribute: () => 'text' };
    expect(keydown('Backspace', { target: field }).prevented, 'the field keeps its Backspace').toBe(false);
    expect(ui().demolishConfirmId).toBeNull();
  });

  it('Escape closes the confirmation first, then the inspector', async () => {
    const game = await makeGame();
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    game.focusBuilding(ride.id);
    keydown('Delete');
    keydown('Escape');
    expect(ui().demolishConfirmId).toBeNull();
    expect(ui().selectedRide, 'the inspector stays open').not.toBeNull();
    keydown('Escape');
    expect(ui().selectedRide).toBeNull();
  });

  it('a selection change, an inspector close and a session swap clear the confirmation', async () => {
    const game = await makeGame();
    const ride = game.world.buildObject(CAROUSEL.id, { x: 20, y: 10 })!;
    const stall = game.world.buildObject(PICNIC.id, { x: 6, y: 6 })!;
    game.focusBuilding(ride.id);
    keydown('Delete');
    game.focusBuilding(stall.id);
    expect(ui().demolishConfirmId).toBeNull();
    keydown('Delete');
    expect(ui().demolishConfirmId).toBe(stall.id);
    game.closeInspector();
    expect(ui().demolishConfirmId).toBeNull();
    game.focusBuilding(ride.id);
    keydown('Delete');
    game.startSandboxMap('meadow');
    expect(ui().demolishConfirmId).toBeNull();
  });
});

describe('the bulldozer on a coaster (two-click)', () => {
  it('the first press arms it and changes nothing; the second press demolishes it as one entry', async () => {
    const game = await makeGame();
    const id = placeLoop(game);
    const version = game.world.version;
    const depth = internals(game).undo.depth;
    const refund = game.world.demolitionRefund(id)!;
    const armed = coasterArmedText(COMET_DEF.name, refund);
    ui().selectBulldozer();

    inputHandlers!.start({ x: 12, y: 13 });
    inputHandlers!.end({ x: 12, y: 13 });
    expect(game.world.objects.has(id)).toBe(true);
    expect(game.world.version).toBe(version);
    expect(internals(game).undo.hasPending).toBe(false);
    expect(internals(game).undo.depth).toBe(depth);
    expect(ui().toast).toBe(armed);
    expect(ui().toastClass).toBe('alert');
    expect(ui().previewTitle).toBe(armed);
    expect(ui().previewBlock).toBe(armed);
    expect(previews.at(-1)!.cells).toHaveLength(game.world.objectFootprint(game.world.objects.get(id)!).length);
    expect(previews.at(-1)).toMatchObject({ valid: true, demolition: true });
    // Hovering the armed coaster keeps the whole footprint and the armed readout.
    inputHandlers!.hover({ x: 17, y: 11 });
    expect(ui().previewTitle).toBe(armed);
    expect(previews.at(-1)!.cells.length).toBeGreaterThan(1);

    inputHandlers!.start({ x: 17, y: 11 });
    inputHandlers!.end({ x: 17, y: 11 });
    expect(game.world.objects.has(id)).toBe(false);
    expect(internals(game).undo.depth).toBe(depth + 1);
    expect(internals(game).undo.newest).toMatchObject({ kind: 'demolition', label: `${COMET_DEF.name} demolished` });
    expect(internals(game).armedCoasterId).toBeNull();
  });

  it('hovering an unarmed coaster says it takes two clicks', async () => {
    const game = await makeGame();
    placeLoop(game);
    ui().selectBulldozer();
    inputHandlers!.hover({ x: 12, y: 13 });
    expect(ui().previewTitle).toBe(coasterHoverText(COMET_DEF.name));
    expect(ui().previewBlock).toBeNull();
    expect(previews.at(-1)!.cells).toEqual([{ x: 12, y: 13 }]);
  });

  it('a drag never demolishes a coaster, even an armed one, but still clears what else it crosses', async () => {
    const game = await makeGame();
    const id = placeLoop(game);
    game.world.buildPaths([{ x: 9, y: 12 }, { x: 18, y: 12 }]);
    ui().selectBulldozer();
    // Drag from left of the loop, across both of its sides, to the right of it.
    inputHandlers!.start({ x: 9, y: 12 });
    inputHandlers!.move({ x: 18, y: 12 });
    inputHandlers!.end({ x: 18, y: 12 });
    expect(game.world.objects.has(id)).toBe(true);
    expect(game.world.paths.has('9,12')).toBe(false);
    expect(game.world.paths.has('18,12')).toBe(false);

    // Armed first, then dragged across: still standing.
    inputHandlers!.start({ x: 10, y: 11 });
    inputHandlers!.end({ x: 10, y: 11 });
    expect(internals(game).armedCoasterId).toBe(id);
    inputHandlers!.start({ x: 5, y: 13 });
    expect(internals(game).armedCoasterId, 'a press elsewhere disarms').toBeNull();
    inputHandlers!.move({ x: 20, y: 13 });
    inputHandlers!.end({ x: 20, y: 13 });
    expect(game.world.objects.has(id)).toBe(true);
  });

  it('a press elsewhere, Escape, a right-click cancel, a tool change and a session swap disarm it', async () => {
    const game = await makeGame();
    const id = placeLoop(game);
    const arm = (): void => {
      ui().selectBulldozer();
      inputHandlers!.start({ x: 12, y: 13 });
      inputHandlers!.end({ x: 12, y: 13 });
      expect(internals(game).armedCoasterId).toBe(id);
    };
    const pressCoaster = (): void => {
      inputHandlers!.start({ x: 12, y: 13 });
      inputHandlers!.end({ x: 12, y: 13 });
    };

    arm();
    inputHandlers!.start({ x: 3, y: 30 });
    inputHandlers!.end({ x: 3, y: 30 });
    pressCoaster();
    expect(game.world.objects.has(id), 'the press after a press elsewhere arms again').toBe(true);

    keydown('Escape');
    expect(ui().tool).toBe('pointer');
    expect(internals(game).armedCoasterId).toBeNull();

    arm();
    inputHandlers!.cancel();
    expect(internals(game).armedCoasterId).toBeNull();

    arm();
    ui().selectBuild('sunstone-path');
    expect(internals(game).armedCoasterId).toBeNull();

    arm();
    game.startSandboxMap('meadow');
    expect(internals(game).armedCoasterId).toBeNull();
  });

  it('words the two readouts', () => {
    expect(coasterArmedText('Comet Coaster', 340)).toBe('Click again to demolish Comet Coaster (the whole coaster) · refund $340');
    expect(coasterArmedText('Comet Coaster', 1_340)).toBe('Click again to demolish Comet Coaster (the whole coaster) · refund $1,340');
    expect(coasterHoverText('Comet Coaster')).toBe('Comet Coaster · click twice to demolish the whole coaster');
  });
});
