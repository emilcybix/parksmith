import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 19: the fatal path and the feedback report through a mounted GameApp with a fake renderer (its frame listener is
 * driven by hand). A frame that throws stops the park, attempts the emergency autosave and raises the error screen, and
 * nothing runs afterwards; the report carries the version and, only on request, the park.
 */

let frameListener: ((deltaMs: number) => void) | null = null;

const fakeRenderer = class {
  hoveredCell = null;
  mount(): Promise<void> { return Promise.resolve(); }
  destroy(): void {}
  onFrame(listener: (deltaMs: number) => void): void { frameListener = listener; }
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
};

vi.mock('./rendererFlag', () => ({
  RENDERER_KIND: 'voxel', LIGHT_PRESET: 'day', LIGHT_OVERRIDE: null, TIME_OVERRIDE: null, ZOOM_OVERRIDE: null, ALLOW_SOFTWARE_GPU: false, VOXEL_GPU_MIN: false,
}));
vi.mock('../rendering/voxel/VoxelRenderer', () => ({ VoxelRenderer: fakeRenderer }));
vi.mock('../rendering/WorldRenderer', () => ({ WorldRenderer: fakeRenderer }));

const { GameApp } = await import('./GameApp');
const { useUiStore } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { GAME_VERSION } = await import('../ui/aboutModel');
const { SAVE_SCHEMA_VERSION } = await import('../game/save/version');

type Internals = {
  clock: { update(deltaMs: number): void; speed: number };
  saves: { flushOnHide(): void };
};

const mounted = async () => {
  const game = new GameApp({ startMenu: false, saveStore: new MemorySaveStore() });
  await game.mount({} as HTMLElement);
  return game;
};

beforeEach(() => {
  const noop = (): void => undefined;
  vi.stubGlobal('window', {
    addEventListener: noop, removeEventListener: noop, setTimeout: () => 0, clearTimeout: noop,
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  });
  vi.stubGlobal('document', { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', activeElement: null, createElement: () => ({}) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useUiStore.setState({ fatalError: null });
  frameListener = null;
});

describe('GameApp fatal path (Phase 19)', () => {
  it('a frame that throws stops the park, flushes a save and raises the error screen once; later frames do nothing', async () => {
    const game = await mounted();
    const internals = game as unknown as Internals;
    const flush = vi.spyOn(internals.saves, 'flushOnHide');
    game.setSpeed(1);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const update = vi.spyOn(internals.clock, 'update').mockImplementation(() => { throw new TypeError('boom'); });
    expect(frameListener).not.toBeNull();
    frameListener!(16);
    expect(useUiStore.getState().fatalError).toBe('TypeError: boom');
    expect(internals.clock.speed).toBe(0);
    expect(flush).toHaveBeenCalledTimes(1);
    frameListener!(16);
    frameListener!(16);
    expect(update, 'nothing runs after a fatal error').toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    error.mockRestore();
    game.destroy();
  });
});

describe('GameApp feedback report (Phase 19)', () => {
  it('carries the version, the save format and the message; the park only on request and only when there is one', async () => {
    const game = await mounted();
    const plain = game.buildFeedbackReport('  The queue never moves.  ', false);
    expect(plain).toMatchObject({ kind: 'parksmith-feedback', gameVersion: GAME_VERSION, saveSchema: SAVE_SCHEMA_VERSION, message: 'The queue never moves.', save: null });
    expect(plain.settings).not.toBeNull();
    expect(game.canAttachPark(), 'an untouched starter park is not a park yet').toBe(false);
    (game as unknown as { world: { buildPaths(cells: { x: number; y: number }[]): unknown } }).world.buildPaths([{ x: 15, y: 30 }]);
    expect(game.canAttachPark()).toBe(true);
    const withPark = game.buildFeedbackReport('', true);
    expect(withPark.save?.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(withPark.save?.state.world.cash).toBeGreaterThan(0);
    game.destroy();
  });
});
