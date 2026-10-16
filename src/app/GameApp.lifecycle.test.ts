import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GameApp picks its renderer at mount and falls back to the classic one when the voxel renderer
 * cannot start. Mount is asynchronous twice over (a dynamic import, then Pixi's init), and the app
 * can be destroyed at any point in between (HMR, an early unmount) — so every interleaving is pinned
 * here with fake renderers whose mount() promises the test settles by hand: no renderer is built for
 * a destroyed app, no toast or hook survives a destroy, and a failure always names its cause.
 */

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}
const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const log: string[] = [];
const pending: { kind: string; mount: Deferred }[] = [];
let voxelConstructorThrows = false;
/** The listener the voxel fake got through onFatalError, so a test can raise a mid-game failure. */
let fatalListener: ((error: Error) => void) | null = null;

const fakeRenderer = (kind: 'voxel' | 'classic') => class {
  readonly kind = kind;
  hoveredCell = null;
  constructor() {
    if (kind === 'voxel' && voxelConstructorThrows) throw new Error('module exploded');
    log.push(`${kind}:new`);
  }
  mount(): Promise<void> {
    log.push(`${kind}:mount`);
    const mount = deferred();
    pending.push({ kind, mount });
    return mount.promise;
  }
  destroy(): void { log.push(`${kind}:destroy`); }
  // Only the voxel renderer reports fatal errors; the classic one has no such hook.
  readonly onFatalError = kind === 'voxel' ? (listener: (error: Error) => void): void => { fatalListener = listener; } : undefined;
  onFrame(): void { log.push(`${kind}:onFrame`); }
  setSession(): void { log.push(`${kind}:setSession`); }
  syncWorld(): void {}
  update(): void {}
  getPerformance() { return { fps: 60, renderMs: 16, entities: 0 }; }
  setTimeOfDay(): void {}
  setInputHandlers(): void { log.push(`${kind}:setInputHandlers`); }
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
vi.mock('../rendering/voxel/VoxelRenderer', () => ({ VoxelRenderer: fakeRenderer('voxel') }));
vi.mock('../rendering/WorldRenderer', () => ({ WorldRenderer: fakeRenderer('classic') }));

const { GameApp } = await import('./GameApp');
const { GAME_CONFIG } = await import('../game/config');
const { UnsupportedRendererError } = await import('../rendering/RendererPort');
const { useUiStore } = await import('../ui/store');

/** Lets every queued microtask and the dynamic import settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const host = {} as HTMLElement;
let errors: unknown[] = [];

beforeEach(() => {
  log.length = 0;
  pending.length = 0;
  voxelConstructorThrows = false;
  fatalListener = null;
  errors = [];
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  vi.spyOn(console, 'error').mockImplementation((error: unknown) => { errors.push(error); });
  useUiStore.getState().setToast(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const next = (kind: string): Deferred => {
  const entry = pending.shift();
  if (!entry || entry.kind !== kind) throw new Error(`expected a pending ${kind} mount, got ${entry?.kind}`);
  return entry.mount;
};

describe('GameApp renderer lifecycle', () => {
  it('voxel mounts: no classic renderer, one frame hook, handlers on voxel', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    next('voxel').resolve();
    await mounted;
    expect(log).toEqual(['voxel:new', 'voxel:mount', 'voxel:setInputHandlers', 'voxel:onFrame']);
    expect(useUiStore.getState().toast).toBeNull();
    game.destroy();
    expect(log.at(-1)).toBe('voxel:destroy');
  });

  it('capability failure: destroy voxel, mount classic, capability toast, error logged', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    const cause = new UnsupportedRendererError('no webgl2', { capability: true });
    next('voxel').reject(cause);
    await settle();
    next('classic').resolve();
    await mounted;
    expect(log).toEqual(['voxel:new', 'voxel:mount', 'voxel:destroy', 'classic:new', 'classic:mount', 'classic:setInputHandlers', 'classic:onFrame']);
    expect(useUiStore.getState().toast).toBe('Voxel renderer needs WebGL2 — using the classic renderer');
    expect(errors).toEqual([cause]);
    game.destroy();
    expect(log.at(-1)).toBe('classic:destroy');
    expect(log.filter((entry) => entry === 'voxel:destroy')).toHaveLength(1);
  });

  it('non-capability failure: failure toast', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    next('voxel').reject(new UnsupportedRendererError('link failed', { capability: false }));
    await settle();
    next('classic').resolve();
    await mounted;
    expect(useUiStore.getState().toast).toBe('Voxel renderer failed to start — using the classic renderer');
  });

  it('a plain Error (bug, module failure) also falls back with the failure toast', async () => {
    voxelConstructorThrows = true;
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    next('classic').resolve();
    await mounted;
    expect(log).toEqual(['classic:new', 'classic:mount', 'classic:setInputHandlers', 'classic:onFrame']);
    expect(useUiStore.getState().toast).toBe('Voxel renderer failed to start — using the classic renderer');
  });

  it('destroy during the dynamic import: nothing is ever constructed', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    game.destroy();
    await mounted;
    await settle();
    expect(log).toEqual([]);
    expect(pending).toHaveLength(0);
  });

  it('destroy during the voxel mount (mount then resolves): no handlers, no frame hook, no classic', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    game.destroy();
    next('voxel').resolve();
    await mounted;
    await settle();
    expect(log).toEqual(['voxel:new', 'voxel:mount', 'voxel:destroy']);
  });

  it('destroy during the voxel mount (mount then rejects): no classic, no toast', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    game.destroy();
    next('voxel').reject(new UnsupportedRendererError('late', { capability: true }));
    await mounted;
    await settle();
    expect(log.filter((entry) => entry.startsWith('classic'))).toEqual([]);
    expect(useUiStore.getState().toast).toBeNull();
  });

  it('destroy during the fallback classic mount: classic destroyed, no toast, no hooks', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    next('voxel').reject(new UnsupportedRendererError('no webgl2', { capability: true }));
    await settle();
    game.destroy();
    next('classic').resolve();
    await mounted;
    await settle();
    expect(log).toEqual(['voxel:new', 'voxel:mount', 'voxel:destroy', 'classic:new', 'classic:mount', 'classic:destroy']);
    expect(useUiStore.getState().toast).toBeNull();
  });

  it('classic fallback mount failure propagates to App (fatal screen), and destroy stays safe', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    next('voxel').reject(new UnsupportedRendererError('no webgl2', { capability: true }));
    await settle();
    next('classic').reject(new Error('classic broke'));
    await expect(mounted).rejects.toThrow('classic broke');
    expect(() => game.destroy()).not.toThrow();
  });

  it('a software-GPU refusal says so', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    next('voxel').reject(new UnsupportedRendererError('software', { capability: true, kind: 'software' }));
    await settle();
    next('classic').resolve();
    await mounted;
    expect(useUiStore.getState().toast).toBe('Voxel renderer needs a hardware GPU — using the classic renderer');
  });

  it('tells the player when the voxel renderer started in a degraded look', async () => {
    const window = globalThis as unknown as { window: { __voxelDegraded?: string } };
    window.window.__voxelDegraded = 'composite-lite';
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    next('voxel').resolve();
    await mounted;
    expect(useUiStore.getState().toast).toBe('Running the simplified voxel look on this GPU');
    game.destroy();
  });

  it('a fatal voxel error mid-game swaps in the classic renderer with its handlers and frame hook, and a toast', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    next('voxel').resolve();
    await mounted;
    expect(fatalListener, 'the voxel renderer is watched').not.toBeNull();
    log.length = 0;
    fatalListener?.(new Error('context lost for good'));
    await settle();
    next('classic').resolve();
    await settle();
    expect(log).toEqual(['voxel:destroy', 'classic:new', 'classic:mount', 'classic:setInputHandlers', 'classic:onFrame']);
    expect(useUiStore.getState().toast).toBe('The GPU stopped responding — switched to the classic renderer');
    expect((globalThis as unknown as { window: { __voxelFailure?: string } }).window.__voxelFailure).toContain('context lost for good');
    expect(errors, 'the cause is logged').toHaveLength(1);
    game.destroy();
    expect(log.at(-1), 'the classic one is the one destroyed now').toBe('classic:destroy');
  });

  it('a fatal error after destroy does nothing', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    next('voxel').resolve();
    await mounted;
    game.destroy();
    log.length = 0;
    fatalListener?.(new Error('late'));
    await settle();
    expect(log).toEqual([]);
    expect(useUiStore.getState().toast).toBeNull();
  });

  it('starting or restarting a scenario drops the old park\'s partial simulation step', async () => {
    const game = new GameApp();
    const mounted = game.mount(host);
    await settle();
    next('voxel').resolve();
    await mounted;
    game.clock.update(GAME_CONFIG.fixedStepMs * 0.6);
    expect(game.clock.stepFraction).toBeGreaterThan(0.5);
    game.startScenario(null);
    expect(game.clock.stepFraction, 'startScenario').toBe(0);
    game.clock.update(GAME_CONFIG.fixedStepMs * 0.6);
    game.restartScenario();
    expect(game.clock.stepFraction, 'restartScenario').toBe(0);
    game.destroy();
  });
});
