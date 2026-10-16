import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 16 (design 4.2): GameApp's side of the placement readout's theme line. The pure preview runs only when the hovered
 * cell, the armed piece, its rotation or the world changes (a pointer move fires on every pixel), and the store gets a
 * view only when it changed. Also: the hand's Research Grant line follows the park's own research cost scale. Same
 * scaffold as GameApp.paint.test.ts: fake renderer, stubbed window, real manager.
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

const ui = () => useUiStore.getState();

interface SessionView {
  rules: { themeAffinity?: number };
  scenery: { previewThemeBonus: (...args: unknown[]) => unknown };
}
const sessionOf = (game: unknown): SessionView => (game as { session: SessionView }).session;

const park = async () => {
  const game = await makeGame();
  game.world.addMoney(500_000);
  const carousel = game.world.buildObject('moonpetal-carousel', { x: 20, y: 10 })!;
  ui().selectPointer();
  return { game, carousel };
};

describe('placement readout: the theme preview', () => {
  it('runs once per hovered cell, piece and world, and publishes the view only when it changes', async () => {
    const { game, carousel } = await park();
    const scenery = sessionOf(game).scenery;
    const spy = vi.spyOn(scenery, 'previewThemeBonus');
    ui().selectBuild('bunting-mast');
    const near = { x: carousel.anchor.x + 4, y: carousel.anchor.y + 1 };
    inputHandlers!.hover(near);
    expect(spy).toHaveBeenCalledTimes(1);
    const view = ui().previewTheme;
    expect(view).toMatchObject({ theme: 'carnival', themeAffinity: sessionOf(game).rules.themeAffinity ?? 0, topName: 'Moonpetal Carousel' });
    expect(view!.topGain).toBeGreaterThan(0);
    // The same cell again (a pointer move inside the tile): no new query, the very same view object.
    inputHandlers!.hover(near);
    inputHandlers!.hover(near);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ui().previewTheme).toBe(view);
    // Another cell asks again; far away nothing of the theme is in reach.
    inputHandlers!.hover({ x: 2, y: 30 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(ui().previewTheme).toMatchObject({ topName: null, reachedDestinations: 0 });
    // A world change (a new building) re-asks for the same cell.
    inputHandlers!.hover(near);
    expect(spy).toHaveBeenCalledTimes(3);
    game.world.buildObject('lollipop-lamp', { x: carousel.anchor.x + 4, y: carousel.anchor.y + 3 });
    inputHandlers!.hover(near);
    expect(spy).toHaveBeenCalledTimes(4);
    game.destroy();
  });

  it('is cleared for a ride, the pointer and an empty hover, without asking the scenery', async () => {
    const { game, carousel } = await park();
    const scenery = sessionOf(game).scenery;
    ui().selectBuild('bunting-mast');
    inputHandlers!.hover({ x: carousel.anchor.x + 4, y: carousel.anchor.y });
    expect(ui().previewTheme).not.toBeNull();
    const spy = vi.spyOn(scenery, 'previewThemeBonus');
    ui().selectBuild('comet-cups');
    inputHandlers!.hover({ x: 2, y: 30 });
    expect(ui().previewTheme).toBeNull();
    ui().selectBuild('bunting-mast');
    inputHandlers!.hover({ x: 2, y: 31 });
    expect(ui().previewTheme).not.toBeNull();
    inputHandlers!.hover(null);
    expect(ui().previewTheme).toBeNull();
    ui().selectPointer();
    inputHandlers!.hover({ x: 2, y: 31 });
    expect(ui().previewTheme).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    game.destroy();
  });
});
