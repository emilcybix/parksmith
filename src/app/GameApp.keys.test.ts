import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The keyboard shortcuts as GameApp runs them, through the keybinding registry: the default keys
 * behave exactly as before, a rebound key works and the old one does nothing, an unbound action is
 * dead, and the coaster designer keeps R and F to itself. Same style as the see-through review
 * test: fake renderer, stubbed window.
 */

const log: string[] = [];
const phases: number[] = [];
const weatherViews: Array<{ kind: string; intensity: number; day: number }> = [];
let hovered: { x: number; y: number } | null = null;
const seeCalls: Array<{ armed: boolean; peek: boolean }> = [];
const entranceFocus: Array<string | undefined> = [];

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
  setInputHandlers(): void {}
  setViewInputEnabled(): void {}
  setToolCursor(): void {}
  focusCell(): void {}
  focusEntrance(motion?: string): void { entranceFocus.push(motion); }
  setGridVisible(): void {}
  setSceneryInfluenceVisible(): void {}
  selectObject(): void { log.push('selectObject'); }
  drawPreview(): void { log.push('drawPreview'); }
  clearPreview(): void {}
  setHintMarkers(): void {}
  setSeeThrough(request: { armed: boolean; peek: boolean }): void { seeCalls.push({ armed: request.armed, peek: request.peek }); }
  drawCoasterDraft(): void {}
}

vi.mock('./rendererFlag', () => ({
  RENDERER_KIND: 'classic', LIGHT_PRESET: 'day', LIGHT_OVERRIDE: null, TIME_OVERRIDE: null, ZOOM_OVERRIDE: null, ALLOW_SOFTWARE_GPU: false, VOXEL_GPU_MIN: false,
}));
vi.mock('../rendering/WorldRenderer', () => ({ WorldRenderer: FakeRenderer }));

const { GameApp } = await import('./GameApp');
const { BUILD_CATALOG } = await import('../game/content/catalog');
const { resetSettings, updateSettings } = await import('../settings');
const { useUiStore } = await import('../ui/store');
const { MemorySaveStore } = await import('./saves/memorySaveStore');
const { computeStateSeal, createHashingWriter } = await import('./saves/SaveManager');

type Handler = (event: unknown) => void;
let handlers = new Map<string, Handler[]>();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const host = {} as HTMLElement;

const games: Array<{ destroy(): void }> = [];
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
  games.push(game);
  return game;
};


beforeEach(() => {
  log.length = 0;
  seeCalls.length = 0;
  entranceFocus.length = 0;
  hovered = null;
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
  useUiStore.getState().closeManagement();
  useUiStore.getState().closeSavesDialog();
  useUiStore.getState().closeSettings();
  useUiStore.getState().setGrid(true);
  if (useUiStore.getState().cleanView) useUiStore.getState().toggleCleanView();
});

afterEach(() => {
  for (const game of games.splice(0)) game.destroy();
  resetSettings();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const key = (type: 'keydown' | 'keyup', k: string, extra: Record<string, unknown> = {}): void => {
  for (const handler of handlers.get(type) ?? []) {
    handler({
      type, key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null,
      preventDefault: () => undefined, ...extra,
    });
  }
};
const tap = (k: string, extra: Record<string, unknown> = {}): void => key('keydown', k, extra);
const ui = () => useUiStore.getState();

const PLAIN = BUILD_CATALOG.find((definition) => definition.kind !== 'path' && !definition.custom)!;
const COASTER = BUILD_CATALOG.find((definition) => definition.custom === 'coaster')!;

describe('default bindings behave as before', () => {
  it('g toggles the grid and h the clean view', async () => {
    await makeGame();
    tap('g');
    expect(ui().showGrid).toBe(false);
    tap('G', { shiftKey: true });
    expect(ui().showGrid).toBe(true);
    tap('h');
    expect(ui().cleanView).toBe(true);
  });

  it('0, 1, 2 and 4 set the speed, by physical key', async () => {
    await makeGame();
    tap('4');
    expect(ui().speed).toBe(4);
    tap('0');
    expect(ui().speed).toBe(0);
    tap('2', { code: 'Digit2' });
    expect(ui().speed).toBe(2);
    tap('&', { code: 'Digit1' });
    expect(ui().speed).toBe(1);
    tap('3');
    expect(ui().speed).toBe(1);
  });

  it('b arms the bulldozer, p the path tool, r rotates the selected building', async () => {
    await makeGame();
    tap('b');
    expect(ui().tool).toBe('bulldoze');
    tap('p');
    expect(ui().selectedDefinitionId).toBe('sunstone-path');
    ui().selectBuild(PLAIN.id);
    const before = ui().buildRotation;
    tap('r');
    expect(ui().buildRotation).toBe((before + 1) % 4);
  });

  it('x peeks while held and releases on key up', async () => {
    await makeGame();
    ui().selectBuild(PLAIN.id);
    tap('x');
    expect(seeCalls[seeCalls.length - 1].peek).toBe(true);
    key('keyup', 'x');
    expect(seeCalls[seeCalls.length - 1].peek).toBe(false);
  });

  it('ignores every key with Ctrl, Cmd or Alt held', async () => {
    await makeGame();
    tap('g', { ctrlKey: true });
    tap('1', { altKey: true });
    expect(ui().showGrid).toBe(true);
    expect(ui().speed).toBe(1);
  });
});

describe('rebinding', () => {
  it('a rebound grid key works at once and the old key does nothing', async () => {
    await makeGame();
    updateSettings({ keybindings: { toggleGrid: 'k:j' } });
    tap('g');
    expect(ui().showGrid).toBe(true);
    tap('j');
    expect(ui().showGrid).toBe(false);
  });

  it('an unbound action is dead', async () => {
    await makeGame();
    updateSettings({ keybindings: { toggleCleanView: null } });
    tap('h');
    expect(ui().cleanView).toBe(false);
  });

  it('a rebound peek key peeks and X no longer does', async () => {
    await makeGame();
    ui().selectBuild(PLAIN.id);
    updateSettings({ keybindings: { peek: 'k:v' } });
    tap('x');
    expect(seeCalls.some((call) => call.peek)).toBe(false);
    tap('v');
    expect(seeCalls[seeCalls.length - 1].peek).toBe(true);
    key('keyup', 'v');
    expect(seeCalls[seeCalls.length - 1].peek).toBe(false);
  });

  it('a rebound speed key follows the physical key, a Shift binding needs Shift', async () => {
    await makeGame();
    updateSettings({ keybindings: { speed4: 'shift+k:f' } });
    tap('4');
    expect(ui().speed).toBe(1);
    tap('f');
    expect(ui().speed).toBe(1);
    tap('F', { shiftKey: true });
    expect(ui().speed).toBe(4);
  });

  it('does not run game shortcuts behind a dialog, rebound or not', async () => {
    await makeGame();
    updateSettings({ keybindings: { toggleGrid: 'k:j' } });
    ui().openSettings();
    tap('j');
    expect(ui().showGrid).toBe(true);
  });
});

describe('the coaster designer keeps R and F', () => {
  it('r raises, f lowers, and the tool keys do nothing there', async () => {
    const game = await makeGame();
    const adjust = vi.spyOn(game, 'coasterAdjustHeight');
    ui().selectBuild(COASTER.id);
    tap('r');
    tap('f');
    expect(adjust.mock.calls).toEqual([[1], [-1]]);
    tap('b');
    expect(ui().tool).toBe('build');
    expect(ui().selectedDefinitionId).toBe(COASTER.id);
  });

  it('a rebound designer key works and R then does nothing', async () => {
    const game = await makeGame();
    const adjust = vi.spyOn(game, 'coasterAdjustHeight');
    ui().selectBuild(COASTER.id);
    updateSettings({ keybindings: { coasterRaise: 'k:u' } });
    tap('r');
    tap('u');
    expect(adjust.mock.calls).toEqual([[1]]);
  });
});

describe('recentre view (Phase 11, PA-021)', () => {
  it('v eases the camera back to the park entrance, once per press', async () => {
    await makeGame();
    tap('v');
    expect(entranceFocus).toEqual(['ease']);
    tap('v', { repeat: true });
    expect(entranceFocus).toEqual(['ease']);
    // A build tool armed: the view scope is still live.
    ui().selectBuild(PLAIN.id);
    tap('V', { shiftKey: true });
    expect(entranceFocus).toEqual(['ease', 'ease']);
  });

  it('does not recentre behind a modal or the pause menu', async () => {
    const game = await makeGame();
    ui().openSettings();
    tap('v');
    expect(entranceFocus).toEqual([]);
    ui().closeSettings();
    game.openPauseMenu();
    tap('v');
    expect(entranceFocus).toEqual([]);
    // The menu layer lives in the shared store: put it away for the next test.
    game.resumeFromMenu();
    expect(ui().menuKind).toBeNull();
  });

  it('follows a rebinding, and a player binding on V wins over the new default', async () => {
    await makeGame();
    updateSettings({ keybindings: { recentreView: 'k:j' } });
    tap('v');
    expect(entranceFocus).toEqual([]);
    tap('j');
    expect(entranceFocus).toEqual(['ease']);
    updateSettings({ keybindings: { bulldozer: 'k:v' } });
    tap('v');
    expect(ui().tool).toBe('bulldoze');
    expect(entranceFocus).toEqual(['ease']);
  });
});

describe('Phase 35: the mute and crowd heatmap keys', () => {
  it('m mutes (Master to 0) with a toast naming the state, and m again brings the level back', async () => {
    await makeGame();
    const { getSettings } = await import('../settings');
    updateSettings({ masterVolume: 40 });
    tap('m');
    expect(getSettings().masterVolume).toBe(0);
    expect(ui().toast).toBe('Sound muted · M to unmute');
    tap('m', { repeat: true });
    expect(getSettings().masterVolume).toBe(0);
    tap('m');
    expect(getSettings().masterVolume).toBe(40);
    expect(ui().toast).toBe('Sound on · Master 40 %');
  });

  it('a rebound mute key works and names itself; M then does nothing', async () => {
    await makeGame();
    const { getSettings } = await import('../settings');
    updateSettings({ keybindings: { toggleMute: 'k:u' } });
    tap('m');
    expect(getSettings().masterVolume).toBe(70);
    tap('u');
    expect(getSettings().masterVolume).toBe(0);
    expect(ui().toast).toBe('Sound muted · U to unmute');
  });

  it('t toggles the crowd heatmap where the renderer draws it, turning the scenery heatmap off', async () => {
    const drawn: Array<unknown> = [];
    const proto = FakeRenderer.prototype as unknown as { setCrowdHeatmap?: (view: unknown) => void };
    proto.setCrowdHeatmap = (view) => { drawn.push(view); };
    try {
      await makeGame();
      ui().setSceneryInfluenceVisible(true);
      tap('t');
      expect(ui().showCrowdHeatmap).toBe(true);
      expect(ui().showSceneryInfluence).toBe(false);
      expect(drawn[drawn.length - 1]).not.toBeNull();
      tap('t', { repeat: true });
      expect(ui().showCrowdHeatmap).toBe(true);
      tap('t');
      expect(ui().showCrowdHeatmap).toBe(false);
      expect(drawn[drawn.length - 1]).toBeNull();
    } finally {
      delete proto.setCrowdHeatmap;
      ui().setCrowdHeatmapVisible(false);
    }
  });

  it('with the classic renderer t stays off and says why, like the button', async () => {
    await makeGame();
    tap('t');
    expect(ui().showCrowdHeatmap).toBe(false);
    expect(ui().toast).toBe('The crowd heatmap is drawn by the voxel renderer.');
  });
});
