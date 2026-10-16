import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Container } from 'pixi.js';
import type { CrowdHeatmapView } from '../../game/crowd/types';
import { countGraphicsDrawCalls } from '../drawCallCounter';
import { pickCell } from '../worldInput';
import { createViewFrame as createFrame } from '../viewRotation';
import type { RendererPort } from '../RendererPort';
import { createWeatherView } from '../../game/weather/types';
import { resetSettings, updateSettings } from '../../settings';
import { WeatherLook, type WeatherEffects } from '../weatherLook';
import { BUILD_BY_ID } from '../../game/content/catalog';
import type { DynamicTexture, GhostState, TexelBounds } from './contracts/frame';

/**
 * VoxelRenderer's lifecycle and frame wiring, in Node, with `boot.ts` and the GPU replaced by fakes
 * whose promises the test settles by hand. Every mount/destroy interleaving GameApp can produce is
 * pinned (the Wave A guards, carried over to the full pipeline): destroy before, during and after
 * each await of mount; failures in the self-test and in the GPU pipeline; the order in which the
 * pipeline is built, warmed up and validated before anything is attached; and the per-frame duties
 * — frame uniforms before the scene, the overlay target only when it changed, a new viewport on
 * resize, a full re-send after a session swap.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const log: string[] = [];
let appGate: Deferred<unknown>;
let selfTestGate: Deferred<void>;
let appOptions: { resolution: number; allowSoftware: boolean; beforeInit?: () => void } | null = null;
let validateFailure: unknown = null;
/** What the post-restore revalidateGpu throws (null = passes). */
let revalidateFailure: unknown = null;
/** Outcomes of successive validateGpu calls (null = passes); empty: `validateFailure` decides every call. */
let validateScript: unknown[] = [];
/** `window.location.search` of the stubbed window. */
let locationSearch = '';
const gpus: FakeGpu[] = [];
let createGpuFailure: unknown = null;
let validated: { programs: readonly unknown[]; targets: readonly unknown[] } | null = null;

interface FrameRecord {
  zoom: number;
  lowWidth: number;
  cameraTexelX: number;
  cameraTexelY: number;
  elapsedMs: number;
  grid: boolean;
  preset: string;
  lookRevision: number;
  lightBits: number;
  lightStrength: number;
  lightPass: boolean;
  backgroundAlpha: number;
  depthRange: { min: number; max: number };
  weather: WeatherEffects;
  weatherRevision: number;
  seeThrough: { revision: number; strength: number; ax: number; ay: number; aw: number; ah: number; cutKey: number; floorZ: number; margin: number };
  view: { revision: number; rotation: number; c: number; s: number; ox: number; oy: number };
}

/** The GPU as the renderer sees it: a VoxelGpuSink plus the frame, overlay and lifetime calls. */
class FakeGpu {
  readonly layer = { label: 'VoxelLayer' };
  readonly frames: FrameRecord[] = [];
  readonly chunks: { index: number; count: number; bounds: TexelBounds | null }[] = [];
  readonly dynamics: { texture: DynamicTexture; count: number; rowStart: number; rowEnd: number }[] = [];
  readonly ghosts: (GhostState | null)[] = [];
  readonly drafts: (GhostState | null)[] = [];
  readonly overlays: { x: number; y: number }[] = [];
  readonly overlayVisible: boolean[] = [];
  resets = 0;
  destroyed = false;
  readonly supportsViewTurn: boolean;

  constructor(readonly options: { viewTurn?: boolean; gpuMin?: boolean; compositeVariant?: string; weatherTier?: string; skipLights?: boolean; skipShadows?: boolean; skipSeeThrough?: boolean; translucentSeeThrough?: boolean; onTranslucentFailed?: (error: unknown) => void; onContextRestored?: () => void }) {
    this.supportsViewTurn = options.viewTurn ?? true;
  }

  warmUp(): void {
    log.push('gpu.warmUp');
  }

  setChunk(index: number, _boxes: Float32Array, count: number, bounds: TexelBounds | null): void {
    log.push('gpu.setChunk');
    this.chunks.push({ index, count, bounds });
  }

  setDynamic(texture: DynamicTexture, _data: Float32Array, count: number, rowStart: number, rowEnd: number): void {
    log.push('gpu.setDynamic');
    this.dynamics.push({ texture, count, rowStart, rowEnd });
  }

  setFigureRanges(): void {
    log.push('gpu.setFigureRanges');
  }

  setGhost(ghost: GhostState | null): void {
    this.ghosts.push(ghost === null ? null : { ...ghost });
  }

  setDraft(draft: GhostState | null): void {
    this.drafts.push(draft === null ? null : { ...draft });
  }

  resize(): void {
    log.push('gpu.resize');
  }

  setFrame(frame: {
    camera: FrameRecord & { lowWidth: number }; elapsedMs: number; grid: boolean; preset: string; depthRange: { min: number; max: number };
    lookRevision: number; lightBits: number; look: { lightStrength: number; lightPass: boolean; backgroundAlpha: number };
    weather: WeatherEffects; weatherRevision: number; seeThrough: FrameRecord['seeThrough']; view?: FrameRecord['view'];
  }): void {
    log.push('gpu.setFrame');
    this.frames.push({
      zoom: frame.camera.zoom,
      lowWidth: frame.camera.lowWidth,
      cameraTexelX: frame.camera.cameraTexelX,
      cameraTexelY: frame.camera.cameraTexelY,
      elapsedMs: frame.elapsedMs,
      grid: frame.grid,
      preset: frame.preset,
      lookRevision: frame.lookRevision,
      lightBits: frame.lightBits,
      lightStrength: frame.look.lightStrength,
      lightPass: frame.look.lightPass,
      backgroundAlpha: frame.look.backgroundAlpha,
      depthRange: { ...frame.depthRange },
      weather: structuredClone(frame.weather),
      weatherRevision: frame.weatherRevision,
      seeThrough: { ...frame.seeThrough },
      view: { ...(frame.view ?? { revision: 0, rotation: 0, c: 1, s: 0, ox: 0, oy: 0 }) },
    });
  }

  setPalette(data: Uint8Array): void {
    log.push(`gpu.setPalette ${data.length}`);
  }

  setFigureTemplates(): void {
    log.push('gpu.setFigureTemplates');
  }

  setOverlayVisible(visible: boolean): void {
    this.overlayVisible.push(visible);
  }

  renderOverlay(container: Container): void {
    log.push('gpu.renderOverlay');
    this.overlays.push({ x: container.position.x, y: container.position.y });
  }

  resetScene(): void {
    log.push('gpu.resetScene');
    this.resets += 1;
  }

  programs(): readonly unknown[] {
    return ['program-a', 'program-b'];
  }

  targets(): readonly unknown[] {
    return ['gbuffer', 'overlay'];
  }

  destroy(): void {
    log.push('gpu.destroy');
    this.destroyed = true;
  }
}

let gpu: FakeGpu | null = null;

const fakeApp = () => {
  const listeners = new Map<string, unknown[]>();
  const rendererListeners = new Map<string, ((...values: unknown[]) => void)[]>();
  const canvas = {
    className: '',
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    width: 1280,
    height: 800,
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    addEventListener(type: string, listener: unknown) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: unknown) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener));
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
    setPointerCapture: () => undefined,
  };
  const tickerCallbacks: unknown[] = [];
  const stageChildren: unknown[] = [];
  return {
    canvas,
    listeners,
    rendererListeners,
    tickerCallbacks,
    stageChildren,
    renderer: {
      resolution: 1,
      gl: {},
      on: (event: string, listener: (...values: unknown[]) => void) => {
        log.push(`renderer.on ${event}`);
        rendererListeners.set(event, [...(rendererListeners.get(event) ?? []), listener]);
      },
      off: (event: string, listener: (...values: unknown[]) => void) => {
        log.push(`renderer.off ${event}`);
        rendererListeners.set(event, (rendererListeners.get(event) ?? []).filter((entry) => entry !== listener));
      },
      resize: () => undefined,
    },
    stage: {
      addChild: (child: unknown) => {
        log.push('stage.addChild');
        stageChildren.push(child);
      },
    },
    ticker: {
      add: (callback: unknown) => {
        log.push('ticker.add');
        tickerCallbacks.push(callback);
      },
    },
    render: () => log.push('app.render'),
    destroy: () => log.push('app.destroy'),
    /** What Pixi's ResizePlugin does: the renderer resizes, emits 'resize', then the app renders. */
    resizeTo(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
      for (const listener of rendererListeners.get('resize') ?? []) listener(width, height, 1);
    },
  };
};

vi.mock('./boot', () => ({
  createVoxelApp: (_host: unknown, options: typeof appOptions) => {
    log.push('createVoxelApp');
    appOptions = options;
    return appGate.promise;
  },
  runGpuSelfTest: () => {
    log.push('runGpuSelfTest');
    return selfTestGate.promise;
  },
  maxRenderTargetSize: () => 8192,
  stopGlErrorTrace: () => undefined,
  resetGlErrorTrace: () => {
    log.push('resetGlErrorTrace');
  },
  revalidateGpu: (_renderer: unknown, target: { warmUp(): void }) => {
    log.push('revalidateGpu');
    target.warmUp();
    if (revalidateFailure !== null) throw revalidateFailure;
  },
  validateGpu: (_renderer: unknown, programs: readonly unknown[], targets: readonly unknown[]) => {
    log.push('validateGpu');
    validated = { programs, targets };
    const outcome = validateScript.length > 0 ? validateScript.shift() : validateFailure;
    if (outcome !== null && outcome !== undefined) throw outcome;
  },
}));

vi.mock('./gpu/VoxelGpu', () => ({
  createVoxelGpu: (_renderer: unknown, options: ConstructorParameters<typeof FakeGpu>[0]) => {
    log.push('createVoxelGpu');
    if (createGpuFailure !== null) throw createGpuFailure;
    gpu = new FakeGpu(options);
    gpus.push(gpu);
    return gpu;
  },
}));

const { VoxelRenderer } = await import('./VoxelRenderer');
const { ParkSession } = await import('../../game/session/ParkSession');
const { UnsupportedRendererError } = await import('../RendererPort');
const { registerVoxelUploader } = await import('./gpu/dataSource');
const { depthRangeFor } = await import('./contracts/space');
const { createSeeThroughValues, seeThroughValuesFor } = await import('./gpu/seeThroughView');

const keyListeners = new Map<string, unknown[]>();
const host = {
  appended: [] as unknown[],
  clientWidth: 1280,
  clientHeight: 800,
  appendChild(child: unknown) {
    this.appended.push(child);
    log.push('host.appendChild');
  },
};

beforeEach(() => {
  log.length = 0;
  keyListeners.clear();
  host.appended = [];
  appGate = deferred();
  selfTestGate = deferred();
  appOptions = null;
  validateFailure = null;
  revalidateFailure = null;
  validateScript = [];
  locationSearch = '';
  gpus.length = 0;
  createGpuFailure = null;
  validated = null;
  gpu = null;
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    location: { get search() { return locationSearch; } },
    addEventListener: (type: string, listener: unknown) => keyListeners.set(type, [...(keyListeners.get(type) ?? []), listener]),
    removeEventListener: (type: string, listener: unknown) =>
      keyListeners.set(type, (keyListeners.get(type) ?? []).filter((entry) => entry !== listener)),
    // The reduced-motion subscription is not part of the boot order these tests pin.
    matchMedia: (query: string) => (query.includes('reduced-motion')
      ? { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }
      : {
        addEventListener: () => log.push('matchMedia.add'),
        removeEventListener: () => log.push('matchMedia.remove'),
      }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSettings();
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

type Renderer = InstanceType<typeof VoxelRenderer>;

/** Mounts a renderer on a fresh fake app, settling both gates. */
const mounted = async (session = new ParkSession(null)): Promise<{ renderer: Renderer; app: ReturnType<typeof fakeApp>; gpu: FakeGpu }> => {
  const renderer = new VoxelRenderer(session);
  const app = fakeApp();
  const mounting = renderer.mount(host as unknown as HTMLElement);
  appGate.resolve(app);
  await flush();
  selfTestGate.resolve();
  await mounting;
  return { renderer, app, gpu: gpu as FakeGpu };
};

/** Per-frame GPU traffic, left out of the lifecycle milestones. */
const FRAME_TRAFFIC = new Set(['gpu.setChunk', 'gpu.setDynamic', 'gpu.setFigureRanges', 'gpu.setFrame', 'gpu.resize', 'gpu.renderOverlay']);

/** The lifecycle milestones of the log. */
const milestones = (): string[] => log.filter((entry) => !FRAME_TRAFFIC.has(entry));

describe('VoxelRenderer: unmounted', () => {
  it('constructs and runs every port call unmounted in Node', () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    renderer.syncWorld();
    renderer.setSession(new ParkSession(null));
    renderer.drawPreview([{ x: 3, y: 3 }], null, true, true);
    renderer.drawPreview([{ x: 3, y: 3 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 1);
    renderer.drawCoasterDraft([], 0);
    renderer.clearPreview();
    renderer.selectObject(null);
    renderer.setSceneryInfluenceVisible(true);
    renderer.setGridVisible(false);
    renderer.setToolCursor('pointer');
    renderer.setViewInputEnabled(false);
    renderer.focusCell({ x: 1, y: 1 });
    renderer.focusEntrance();
    renderer.update(16, 16, 0.5);
    renderer.update(16, 32);
    expect(renderer.getPerformance().entities, 'the entrance path counts').toBeGreaterThan(0);
    expect(renderer.hoveredCell, 'no pointer yet').toBeNull();
    expect(renderer.objectTop(12_345), 'no such object').toBeNull();
    expect(() => renderer.onFrame(() => undefined), 'no ticker before mount').toThrow();
    renderer.destroy();
    renderer.destroy();
    expect(log, 'nothing booted').toEqual([]);
  });
});

describe('VoxelRenderer: mount', () => {
  it('boots, builds and validates the pipeline, then attaches once, with no ticker callback of its own', async () => {
    const { renderer, app, gpu: fake } = await mounted();
    expect(milestones(), 'mount order').toEqual([
      'createVoxelApp',
      'runGpuSelfTest',
      'createVoxelGpu',
      'gpu.setPalette 4096',
      'gpu.setFigureTemplates',
      'stage.addChild',
      'app.render',
      'gpu.warmUp',
      'validateGpu',
      'renderer.on resize',
      'matchMedia.add',
      'host.appendChild',
    ]);
    expect(appOptions?.beforeInit, 'the data uploader is registered before app.init').toBe(registerVoxelUploader);
    expect(app.stageChildren, 'the stage holds only the GPU layer').toEqual([fake.layer]);
    expect(validated, 'every program and target is validated').toEqual({ programs: fake.programs(), targets: fake.targets() });
    const warmUp = log.indexOf('app.render');
    expect(log.indexOf('gpu.warmUp'), 'every program is drawn once before anything is judged').toBeLessThan(log.indexOf('validateGpu'));
    expect(log.indexOf('gpu.warmUp'), 'after the real scene render').toBeGreaterThan(warmUp);
    const chunksBefore = log.slice(0, warmUp).filter((entry) => entry === 'gpu.setChunk').length;
    expect(chunksBefore, 'the whole world is sent before the warm-up render').toBe(16);
    expect(log.slice(0, warmUp), 'frame uniforms before the warm-up render').toContain('gpu.setFrame');
    expect(app.canvas.dataset.renderer, 'data-renderer').toBe('voxel');
    expect(app.canvas.className, 'class').toBe('game-canvas');
    expect(app.canvas.style.imageRendering, 'crisp upscale').toBe('pixelated');
    expect(app.canvas.style.cursor, 'no cursor yet').toBeUndefined();
    expect(app.canvas.attributes['aria-label'], 'aria label').toBe('Isometric theme park construction area');
    expect([...app.listeners.values()].flat(), 'pointer, wheel and menu listeners, and the two context events').toHaveLength(9);
    expect([...keyListeners.values()].flat(), 'key listeners').toHaveLength(2);
    expect(app.tickerCallbacks, 'no ticker callback of its own').toHaveLength(0);
    renderer.onFrame(() => undefined);
    expect(app.tickerCallbacks, 'onFrame registers exactly one').toHaveLength(1);

    renderer.destroy();
    expect([...app.listeners.values()].flat(), 'pointer listeners gone').toHaveLength(0);
    expect([...keyListeners.values()].flat(), 'key listeners gone').toHaveLength(0);
    expect(app.rendererListeners.get('resize'), 'resize listener gone').toHaveLength(0);
    expect(log.slice(-4), 'the GPU goes before the app').toEqual(['matchMedia.remove', 'renderer.off resize', 'gpu.destroy', 'app.destroy']);
    renderer.destroy();
    expect(log.filter((entry) => entry === 'app.destroy'), 'destroyed once').toHaveLength(1);
  });

  it('applies a cursor set before mount', async () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    renderer.setToolCursor('not-allowed');
    const app = fakeApp();
    const mounting = renderer.mount(host as unknown as HTMLElement);
    appGate.resolve(app);
    await flush();
    selfTestGate.resolve();
    await mounting;
    expect(app.canvas.style.cursor, 'the stored cursor').toBe('not-allowed');
  });

  it('builds the park it was switched to before mount', async () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    const other = new ParkSession(null);
    other.world.seedScenarioObject('confetti-tree', { x: 3, y: 3 });
    renderer.setSession(other);
    const app = fakeApp();
    const mounting = renderer.mount(host as unknown as HTMLElement);
    appGate.resolve(app);
    await flush();
    selfTestGate.resolve();
    await mounting;
    const tree = [...other.world.objects.values()][0];
    expect(renderer.objectTop(tree.id), 'the new park\'s tree is in the scene').toBeGreaterThan(0);
  });

  it('never boots when destroyed before mount', async () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    renderer.destroy();
    await renderer.mount(host as unknown as HTMLElement);
    expect(log, 'nothing').toEqual([]);
  });

  it('destroys a late app once and attaches nothing when destroyed during app creation', async () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    const app = fakeApp();
    const mounting = renderer.mount(host as unknown as HTMLElement);
    renderer.destroy();
    appGate.resolve(app);
    await mounting;
    expect(log, 'boot, then teardown').toEqual(['createVoxelApp', 'app.destroy']);
    expect(host.appended, 'nothing attached').toHaveLength(0);
  });

  it('resolves silently when destroyed during an app creation that then fails', async () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    const mounting = renderer.mount(host as unknown as HTMLElement);
    renderer.destroy();
    appGate.reject(new Error('init failed'));
    await expect(mounting, 'no rejection for a renderer nobody wants').resolves.toBeUndefined();
  });

  it('destroys the app once and builds no pipeline when destroyed during the self-test', async () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    const app = fakeApp();
    const mounting = renderer.mount(host as unknown as HTMLElement);
    appGate.resolve(app);
    await flush();
    renderer.destroy();
    selfTestGate.resolve();
    await mounting;
    expect(log, 'no GPU pipeline').toEqual(['createVoxelApp', 'runGpuSelfTest', 'app.destroy']);
    expect(host.appended, 'nothing attached').toHaveLength(0);
    expect([...keyListeners.values()].flat(), 'no key listeners').toHaveLength(0);
  });

  it('resolves silently when destroyed during a self-test that then fails', async () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    const app = fakeApp();
    const mounting = renderer.mount(host as unknown as HTMLElement);
    appGate.resolve(app);
    await flush();
    renderer.destroy();
    selfTestGate.reject(new Error('link failed'));
    await expect(mounting, 'silent').resolves.toBeUndefined();
    expect(log.filter((entry) => entry === 'app.destroy'), 'destroyed once').toHaveLength(1);
  });

  it('rejects on a failed self-test and leaves a later destroy (GameApp\'s fallback) with nothing to do', async () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    const app = fakeApp();
    const mounting = renderer.mount(host as unknown as HTMLElement);
    appGate.resolve(app);
    await flush();
    const failure = new Error('link failed');
    selfTestGate.reject(failure);
    await expect(mounting, 'the self-test error').rejects.toBe(failure);
    renderer.destroy();
    expect(log, 'app destroyed, nothing else').toEqual(['createVoxelApp', 'runGpuSelfTest', 'app.destroy']);
    expect(host.appended, 'nothing attached').toHaveLength(0);
  });

  it('rejects with the validation error and tears the pipeline down before the app', async () => {
    const failure = new UnsupportedRendererError('A voxel shader program failed to link', { capability: false });
    validateFailure = failure;
    const renderer = new VoxelRenderer(new ParkSession(null));
    const app = fakeApp();
    const mounting = renderer.mount(host as unknown as HTMLElement);
    appGate.resolve(app);
    await flush();
    selfTestGate.resolve();
    await expect(mounting, 'the validation error as it is').rejects.toBe(failure);
    expect(log.slice(-3), 'GPU, then app').toEqual(['validateGpu', 'gpu.destroy', 'app.destroy']);
    expect(host.appended, 'nothing attached').toHaveLength(0);
    expect([...keyListeners.values()].flat(), 'no input bound').toHaveLength(0);
    renderer.destroy();
    expect(log.filter((entry) => entry === 'app.destroy'), 'a later destroy does nothing more').toHaveLength(1);
  });

  it('wraps any other pipeline failure as a non-capability UnsupportedRendererError', async () => {
    const cause = new Error('out of texture units');
    createGpuFailure = cause;
    const renderer = new VoxelRenderer(new ParkSession(null));
    const mounting = renderer.mount(host as unknown as HTMLElement);
    appGate.resolve(fakeApp());
    await flush();
    selfTestGate.resolve();
    const error = await mounting.then(() => null, (reason: unknown) => reason);
    expect(error, 'an UnsupportedRendererError').toBeInstanceOf(UnsupportedRendererError);
    expect((error as InstanceType<typeof UnsupportedRendererError>).capability, 'it broke; the machine is capable').toBe(false);
    expect((error as Error).cause, 'with the cause').toBe(cause);
    expect(log.at(-1), 'the app is destroyed').toBe('app.destroy');
  });
});

describe('VoxelRenderer: composite fallback', () => {
  // The weather / lite chain is asserted on the dither see-through (no translucent rung in front of it); the
  // translucent rung's own place in the chain is pinned in 'VoxelRenderer: translucent see-through' below.
  beforeEach(() => {
    locationSearch = '?voxelSeeThrough=dither';
  });

  /** What boot.ts's validateGpu throws when the composite's first draw is rejected. */
  const compositeFailure = (): InstanceType<typeof UnsupportedRendererError> => new UnsupportedRendererError(
    'The GPU reported errors while the voxel renderer warmed up: see calls; first failing calls: gl.drawElements(4, 3, 5125, 0) [program voxel-composite-vertex] -> 0x502',
    { capability: false },
  );

  const mountOn = async (): Promise<{ renderer: Renderer; app: ReturnType<typeof fakeApp>; result: Promise<void> }> => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    const app = fakeApp();
    const result = renderer.mount(host as unknown as HTMLElement);
    appGate.resolve(app);
    await flush();
    selfTestGate.resolve();
    return { renderer, app, result };
  };

  const degraded = (): unknown => (globalThis as unknown as { window: { __voxelDegraded?: string } }).window.__voxelDegraded;

  it('builds the full composite once when nothing fails, and reports no degradation', async () => {
    const { app } = await mounted();
    expect(gpus, 'one pipeline').toHaveLength(1);
    expect(gpus[0].options.compositeVariant, 'the full picture').toBe('full');
    expect(degraded(), 'nothing degraded').toBeUndefined();
    expect(log.filter((entry) => entry === 'validateGpu'), 'validated once').toHaveLength(1);
    expect(log, 'no trace reset without a retry').not.toContain('resetGlErrorTrace');
    expect(app.stageChildren, 'one layer').toHaveLength(1);
  });

  const rungsOf = (): string[] => gpus.map((entry) => `${entry.options.compositeVariant}+${entry.options.weatherTier}`);
  const viewTurnsOf = (): unknown[] => gpus.map((entry) => entry.options.viewTurn);

  it('retries a full/full composite failure without the view code first, keeping weather and the full look (Phase 26)', async () => {
    validateScript = [compositeFailure(), null];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { renderer, result } = await mountOn();
      await expect(result).resolves.toBeUndefined();
      expect(rungsOf(), 'the same composite and weather').toEqual(['full+full', 'full+full']);
      expect(viewTurnsOf(), 'without the view code').toEqual([true, false]);
      expect(degraded()).toBe('no-view-rotation');
      expect(renderer.supportsViewRotation).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('drops the weather pass when the composite fails without the view code as well, keeping the full look and the rotation', async () => {
    const original = compositeFailure();
    validateScript = [original, compositeFailure(), null];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { renderer, app, result } = await mountOn();
      await expect(result, 'mount succeeds on the full composite without weather').resolves.toBeUndefined();
      expect(rungsOf(), 'full+weather, the view retry, then full without weather').toEqual(['full+full', 'full+full', 'full+none']);
      expect(viewTurnsOf(), 'the failure was not the view code\'s: the rotation is kept').toEqual([true, false, true]);
      expect(renderer.supportsViewRotation).toBe(true);
      expect(gpus[0].destroyed, 'the failed pipeline is torn down').toBe(true);
      expect(gpus[1].destroyed, 'so is the failed retry').toBe(true);
      expect(gpus[2].destroyed, 'the third one is alive').toBe(false);
      const order = milestones();
      const retry = order.indexOf('gpu.destroy');
      expect(order.slice(retry - 1, retry + 3), 'validate, tear down, reset the trace, rebuild').toEqual(['validateGpu', 'gpu.destroy', 'resetGlErrorTrace', 'createVoxelGpu']);
      expect(app.stageChildren, 'the stage got every layer').toHaveLength(3);
      expect(host.appended, 'attached once').toHaveLength(1);
      expect(degraded(), 'readable by a person and by tests').toBe('no-weather');
      expect(warn, 'the cause is logged').toHaveBeenCalledWith(expect.stringContaining('retrying without it'), original);
      renderer.setWeather({ ...createWeatherView(), enabled: true, kind: 'storm', intensity: 1 });
      renderer.update(16, 16);
      expect(gpus[2].frames.at(-1)?.weather.active, 'a clear sky is fed to a pipeline without the pass').toBe(false);
      renderer.destroy();
      expect(log.filter((entry) => entry === 'gpu.destroy'), 'each pipeline destroyed once').toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('walks the whole chain: full+weather, full, lite+rain, lite, in that order', async () => {
    const original = compositeFailure();
    validateScript = [original, compositeFailure(), compositeFailure(), null];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result } = await mountOn();
      await expect(result).resolves.toBeUndefined();
      expect(rungsOf()).toEqual(['full+full', 'full+full', 'full+none', 'lite+rain']);
      expect(degraded()).toBe('composite-lite');
      expect(gpus.slice(0, 3).every((entry) => entry.destroyed)).toBe(true);
    } finally {
      warn.mockRestore();
    }
    log.length = 0;
    gpus.length = 0;
    appGate = deferred();
    selfTestGate = deferred();
    validateScript = [compositeFailure(), compositeFailure(), compositeFailure(), compositeFailure(), null];
    const again = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result } = await mountOn();
      await expect(result).resolves.toBeUndefined();
      expect(rungsOf()).toEqual(['full+full', 'full+full', 'full+none', 'lite+rain', 'lite+none']);
      expect(degraded()).toBe('composite-lite+no-weather');
    } finally {
      again.mockRestore();
    }
  });

  it('throws the ORIGINAL error when every rung fails, leaving nothing behind', async () => {
    const original = compositeFailure();
    // Every rung fails: the view retry, the three composite rungs with the view code, then the same three without it.
    validateScript = [original, ...Array.from({ length: 7 }, compositeFailure)];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result } = await mountOn();
      await expect(result, 'the first failure, not a retry\'s').rejects.toBe(original);
      expect(gpus, 'one build, the view retry, three rungs with and three without the view code').toHaveLength(8);
      expect(gpus.every((entry) => entry.destroyed), 'every pipeline torn down').toBe(true);
      expect(log.slice(-2), 'GPU, then app').toEqual(['gpu.destroy', 'app.destroy']);
      expect(host.appended, 'nothing attached').toHaveLength(0);
      expect(degraded(), 'not degraded: it did not start').toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not retry a failure that does not name the composite alone', async () => {
    for (const message of [
      'x: gl.drawElements(4, 3, 5125, 0) [program voxel-upscale-vertex] -> 0x502',
      'x: gl.drawElements(4, 3, 5125, 0) [program voxel-composite-vertex] -> 0x502 | gl.drawElements(4, 3, 5125, 0) [program voxel-upscale-vertex] -> 0x502',
      'x: gl.drawElements(4, 3, 5125, 0) [program voxel-lightPass-vertex] -> 0x502 | gl.drawElements(4, 3, 5125, 0) [program voxel-figureOpaque-vertex] -> 0x502',
    ]) {
      log.length = 0;
      gpus.length = 0;
      appGate = deferred();
      selfTestGate = deferred();
      const failure = new UnsupportedRendererError(message, { capability: false });
      validateScript = [failure, failure];
      const { result } = await mountOn();
      await expect(result, message).rejects.toBe(failure);
      // A program carrying the view code gets exactly one retry, without it, and nothing else (the light pass's own
      // rung cannot rescue figureOpaque); a required program the view code does not touch (upscale) gets none.
      const viewRetry = message.includes('figureOpaque');
      expect(gpus, `no retry for: ${message}`).toHaveLength(viewRetry ? 2 : 1);
      if (viewRetry) expect(gpus[1].options.viewTurn).toBe(false);
      else expect(log, 'no trace reset').not.toContain('resetGlErrorTrace');
    }
  });

  it('retries a failure that names no program once without the cutaway (dither start) and then throws the original error', async () => {
    for (const message of ['A voxel shader program failed to link: no log', 'The GPU reported errors while the voxel renderer warmed up: 0x502']) {
      log.length = 0;
      gpus.length = 0;
      appGate = deferred();
      selfTestGate = deferred();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const failure = new UnsupportedRendererError(message, { capability: false });
        validateScript = [failure, new UnsupportedRendererError('again', { capability: false })];
        const { result } = await mountOn();
        await expect(result, message).rejects.toBe(failure);
        expect(gpus.map((entry) => entry.options.skipSeeThrough), `one rescue attempt for: ${message}`).toEqual([undefined, true]);
      } finally {
        warn.mockRestore();
      }
    }
  });

  it('starts with the lite composite on &voxelComposite=lite, and never retries it', async () => {
    locationSearch = '?dev=1&renderer=voxel&voxelComposite=lite';
    await mounted();
    expect(gpus.map((entry) => entry.options.compositeVariant), 'lite from the start').toEqual(['lite']);
    expect(degraded(), 'asked for, not a degradation').toBeUndefined();

    log.length = 0;
    gpus.length = 0;
    appGate = deferred();
    selfTestGate = deferred();
    const failure = compositeFailure();
    validateScript = [failure, compositeFailure()];
    const { result } = await mountOn();
    await expect(result, 'a failing lite composite is final').rejects.toBe(failure);
    expect(rungsOf(), 'only the weather pass is dropped, never back up to full').toEqual(['lite+rain', 'lite+none']);
  });

  it('reads any other value of the flag as the normal composite', async () => {
    locationSearch = '?voxelComposite=full';
    await mounted();
    expect(gpus.map((entry) => entry.options.compositeVariant)).toEqual(['full']);
  });
});

describe('VoxelRenderer: startup degradations', () => {
  const tagged = (...names: string[]): InstanceType<typeof UnsupportedRendererError> => new UnsupportedRendererError(
    `The GPU reported errors while the voxel renderer warmed up: see calls; first failing calls: ${names.map((name) => `gl.drawElements(4, 6, 5125, 0) [program ${name}-vertex] -> 0x502`).join(' | ')}`,
    { capability: false },
  );
  const mountWith = async (failure: unknown, ...between: unknown[]): Promise<{ result: Promise<void> }> => {
    validateScript = [failure, ...between, null];
    const renderer = new VoxelRenderer(new ParkSession(null));
    const result = renderer.mount(host as unknown as HTMLElement);
    appGate.resolve(fakeApp());
    await flush();
    selfTestGate.resolve();
    return { result };
  };
  const degraded = (): unknown => (globalThis as unknown as { window: { __voxelDegraded?: string } }).window.__voxelDegraded;

  it('draws the warm-up before validating, in the first build and in a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result } = await mountWith(tagged('voxel-composite'));
      await result;
      const calls = log.filter((entry) => entry === 'gpu.warmUp' || entry === 'validateGpu');
      expect(calls, 'warm-up, validate, per pipeline').toEqual(['gpu.warmUp', 'validateGpu', 'gpu.warmUp', 'validateGpu']);
    } finally {
      warn.mockRestore();
    }
  });

  it('continues without light pools when only the light pass fails, instead of dropping to classic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // The view-rotation retry comes first; viewTurn false fails the same way, so the failure is not the view
      // code's: the light rung is built WITH the view code and the rotation is kept.
      const { result } = await mountWith(tagged('voxel-lightPass'), tagged('voxel-lightPass'));
      await expect(result).resolves.toBeUndefined();
      expect(gpus.map((entry) => [entry.options.compositeVariant, entry.options.skipLights, entry.options.skipShadows, entry.options.viewTurn]))
        .toEqual([['full', undefined, undefined, true], ['full', false, false, false], ['full', true, false, true]]);
      expect(degraded()).toBe('no-lights');
      expect(host.appended, 'attached').toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('continues without figure shadows when only their program fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result } = await mountWith(tagged('voxel-figureDither'), tagged('voxel-figureDither'));
      await expect(result).resolves.toBeUndefined();
      expect(gpus[2].options.skipShadows).toBe(true);
      expect(gpus[2].options.skipLights).toBe(false);
      expect(gpus[2].options.viewTurn, 'the failure survived without the view code: the rotation is kept').toBe(true);
      expect(degraded()).toBe('no-shadows');
    } finally {
      warn.mockRestore();
    }
  });

  it('drops both the light pass and the rotation on a GPU where both fail (the light chain without the view code last)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result } = await mountWith(tagged('voxel-lightPass'), tagged('voxel-lightPass'), tagged('voxel-worldOpaque'));
      await expect(result).resolves.toBeUndefined();
      expect(gpus.map((entry) => [entry.options.skipLights, entry.options.viewTurn]))
        .toEqual([[undefined, true], [false, false], [true, true], [true, false]]);
      expect(degraded()).toBe('no-lights+no-view-rotation');
    } finally {
      warn.mockRestore();
    }
  });

  it('retries a composite that failed at LINK time (tagged by validateGpu) with the lite one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      locationSearch = '?voxelSeeThrough=dither';
      const link = new UnsupportedRendererError('A voxel shader program failed to link [program voxel-composite-vertex]: D3D', { capability: false });
      const { result } = await mountWith(link, link);
      await expect(result).resolves.toBeUndefined();
      // The full/full composite carries the view code: one retry without it first.
      expect(gpus.map((entry) => `${entry.options.compositeVariant}+${entry.options.weatherTier}`)).toEqual(['full+full', 'full+full', 'full+none']);
      expect(degraded()).toBe('no-weather');
    } finally {
      warn.mockRestore();
    }
  });

  it('throws the original error when the reduced pipeline fails too', async () => {
    const original = tagged('voxel-lightPass');
    validateScript = [original, tagged('voxel-worldOpaque'), tagged('voxel-worldOpaque')];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const renderer = new VoxelRenderer(new ParkSession(null));
      const result = renderer.mount(host as unknown as HTMLElement);
      appGate.resolve(fakeApp());
      await flush();
      selfTestGate.resolve();
      await expect(result).rejects.toBe(original);
      expect(degraded()).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('VoxelRenderer: lost and restored contexts', () => {
  const fire = (app: ReturnType<typeof fakeApp>, type: string): void => {
    for (const listener of app.listeners.get(type) ?? []) (listener as () => void)();
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const mountedFatal = async (): Promise<{ renderer: Renderer; app: ReturnType<typeof fakeApp>; gpu: FakeGpu; fatal: Error[] }> => {
    const result = await mounted();
    const fatal: Error[] = [];
    result.renderer.onFatalError((error) => fatal.push(error));
    return { ...result, fatal };
  };

  it('proves the pipeline again at the next frame after a restore, and carries on when it passes', async () => {
    const { renderer, gpu: fake, fatal } = await mountedFatal();
    log.length = 0;
    fake.options.onContextRestored?.();
    expect(log, 'not inside Pixi\'s own restore').not.toContain('revalidateGpu');
    renderer.update(16, 16);
    expect(log.filter((entry) => entry === 'gpu.warmUp' || entry === 'revalidateGpu'), 'warm-up inside the revalidation').toEqual(['revalidateGpu', 'gpu.warmUp']);
    renderer.update(16, 32);
    expect(log.filter((entry) => entry === 'revalidateGpu'), 'once per restore').toHaveLength(1);
    expect(fatal).toEqual([]);
  });

  it('tells the owner (once) when the restored context cannot run the pipeline', async () => {
    const { renderer, gpu: fake, fatal } = await mountedFatal();
    const failure = new UnsupportedRendererError('The GPU reported errors [program voxel-figureOpaque-vertex]', { capability: false });
    revalidateFailure = failure;
    fake.options.onContextRestored?.();
    renderer.update(16, 16);
    expect(fatal, 'the validation error').toEqual([failure]);
    fake.options.onContextRestored?.();
    renderer.update(16, 32);
    expect(fatal, 'only once').toHaveLength(1);
  });

  it('gives up after 5 s without a restore, and not when the restore comes in time', async () => {
    const { app, fatal } = await mountedFatal();
    fire(app, 'webglcontextlost');
    vi.advanceTimersByTime(4_900);
    expect(fatal).toEqual([]);
    fire(app, 'webglcontextrestored');
    vi.advanceTimersByTime(10_000);
    expect(fatal, 'restored in time: no fallback').toEqual([]);

    fire(app, 'webglcontextlost');
    vi.advanceTimersByTime(5_000);
    expect(fatal).toHaveLength(1);
    expect(fatal[0].message).toContain('did not come back within 5 s');
  });

  it('stops the clock when destroyed, and never calls back afterwards', async () => {
    const { renderer, app, fatal } = await mountedFatal();
    fire(app, 'webglcontextlost');
    renderer.destroy();
    vi.advanceTimersByTime(20_000);
    expect(fatal).toEqual([]);
    expect(app.listeners.get('webglcontextlost'), 'listener removed').toHaveLength(0);
  });
});

describe('VoxelRenderer: frames', () => {
  it('writes the frame uniforms before the scene sends anything, every frame', async () => {
    const { renderer, gpu: fake } = await mounted();
    log.length = 0;
    renderer.update(16, 1_000, 0.25);
    const frameAt = log.indexOf('gpu.setFrame');
    const firstScene = log.findIndex((entry) => entry === 'gpu.setDynamic' || entry === 'gpu.setFigureRanges');
    expect(frameAt, 'setFrame first').toBeGreaterThanOrEqual(0);
    expect(frameAt < firstScene, 'before the scene').toBe(true);
    const last = fake.frames.at(-1)!;
    expect([last.elapsedMs, last.grid, last.preset], 'clock, grid, preset').toEqual([1_000, true, 'day']);
    expect(last.depthRange, 'the park\'s depth range').toEqual(depthRangeFor(32, 32));
    renderer.setGridVisible(false);
    renderer.update(16, 1_016, 0.5);
    expect(fake.frames.at(-1)!.grid, 'the grid uniform follows the toggle').toBe(false);
    expect(renderer.getPerformance().renderMs, 'renderMs is the update time').toBeGreaterThanOrEqual(0);
  });

  it('follows the time of day through uniforms only: no chunk, dynamic or scene work differs from a still day', async () => {
    const still = await mounted();
    for (let frame = 0; frame < 120; frame += 1) still.renderer.update(16, 16 * frame);
    const baseline = { chunks: still.gpu.chunks.length, dynamics: still.gpu.dynamics.length };
    still.renderer.destroy();

    const { renderer, gpu: fake } = await mounted();
    for (let frame = 0; frame < 120; frame += 1) {
      renderer.setTimeOfDay(frame / 120);
      renderer.update(16, 16 * frame);
    }
    expect({ chunks: fake.chunks.length, dynamics: fake.dynamics.length }, 'a whole day moves no geometry').toEqual(baseline);
    const strengths = fake.frames.map((frame) => frame.lightStrength);
    expect(Math.max(...strengths), 'the night look was reached').toBeGreaterThan(1.2);
    expect(Math.min(...strengths), 'and the day look').toBe(0);
    expect(fake.frames.some((frame) => frame.lightPass), 'lamps on at some point').toBe(true);
    expect(fake.frames.some((frame) => !frame.lightPass), 'and off at some point').toBe(true);
  });

  it('lets the start screen sweep the camera through the port without staging anything: no chunk, no dynamic row, an integer zoom', async () => {
    const still = await mounted();
    for (let frame = 0; frame < 240; frame += 1) still.renderer.update(16, 16 * frame);
    const baseline = { chunks: still.gpu.chunks.length, dynamics: still.gpu.dynamics.length };
    still.renderer.destroy();

    const { renderer, gpu: fake } = await mounted();
    for (let frame = 0; frame < 240; frame += 1) {
      renderer.setCameraCentre?.(16 + 5 * Math.sin(frame / 40), 16 + 2 * Math.sin(frame / 63));
      renderer.update(16, 16 * frame);
    }
    expect({ chunks: fake.chunks.length, dynamics: fake.dynamics.length }, 'a long pan moves no geometry').toEqual(baseline);
    const cameras = fake.frames.slice(-240);
    expect(new Set(cameras.map((camera) => camera.cameraTexelX)).size, 'the picture really moves').toBeGreaterThan(10);
    expect(new Set(cameras.map((camera) => camera.zoom)).size, 'at one fixed zoom').toBe(1);
    expect(Number.isInteger(cameras[0].zoom)).toBe(true);
    expect(renderer.setCameraCentre, 'the port method exists on the voxel renderer').toBeTypeOf('function');
  });

  const stormView = (intensity = 1): ReturnType<typeof createWeatherView> => ({ ...createWeatherView(), kind: 'storm', intensity, flashSeed: 7, secondsIntoSegment: 40 });

  it('follows the weather through uniforms only: no chunk, dynamic or scene work differs from a clear frame', async () => {
    const clear = await mounted();
    for (let frame = 0; frame < 240; frame += 1) clear.renderer.update(16, 16 * frame);
    const baseline = { chunks: clear.gpu.chunks.length, dynamics: clear.gpu.dynamics.length, log: log.filter((entry) => entry.startsWith('gpu.set') && entry !== 'gpu.setFrame').length };
    clear.renderer.destroy();
    log.length = 0;

    const { renderer, gpu: fake } = await mounted();
    log.length = 0;
    // Every effect active: storm at night (flashes), then a hot noon is covered by the weather tests; here the storm sweeps in and out.
    for (let frame = 0; frame < 240; frame += 1) {
      renderer.setTimeOfDay(frame < 120 ? 0.5 : 0.0);
      renderer.setWeather({ ...stormView(frame < 200 ? 1 : 0), secondsIntoSegment: frame * 0.1 });
      renderer.update(100, 100 * frame);
    }
    expect({ chunks: fake.chunks.length, dynamics: fake.dynamics.length }, 'a storm moves no geometry').toEqual({ chunks: baseline.chunks, dynamics: baseline.dynamics });
    expect(log.filter((entry) => entry.startsWith('gpu.set') && entry !== 'gpu.setFrame').length, 'no scene sink call beyond a clear frame\'s').toBeLessThanOrEqual(baseline.log);
    expect(fake.frames.some((frame) => frame.weather.active && frame.weather.rainDensity > 0.5), 'rain reached the frame').toBe(true);
    expect(fake.frames.some((frame) => frame.weather.cloudStrength > 0), 'clouds reached the frame').toBe(true);
    expect(fake.frames.some((frame) => frame.weather.flash > 0), 'lightning reached the frame').toBe(true);
    expect(Math.min(...fake.frames.map((frame) => frame.weather.modifiers.exposureScale)), 'the grade dims, within the floor').toBeGreaterThanOrEqual(0.86);
  });

  it('writes nothing for a calm paused sky: the weather revision and the look stay put', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.setWeather({ ...createWeatherView(), kind: 'sunny', intensity: 0 });
    renderer.update(16, 16);
    const first = fake.frames.at(-1)!;
    expect(first.weather.active, 'a clear sky is inactive').toBe(false);
    for (let frame = 0; frame < 60; frame += 1) {
      renderer.setWeather({ ...createWeatherView(), kind: 'sunny', intensity: 0 });
      renderer.update(16, 32 + frame);
    }
    const last = fake.frames.at(-1)!;
    expect([last.weatherRevision, last.lookRevision], 'revisions unchanged over 60 frames').toEqual([first.weatherRevision, first.lookRevision]);
  });

  it('holds a paused storm still (no new revision) and re-blends the look only when the grade modifiers move', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.setMachineryPaused(true);
    renderer.setWeather(stormView());
    for (let frame = 0; frame < 200; frame += 1) renderer.update(16, 16 * frame);
    const settled = fake.frames.at(-1)!;
    expect(settled.weather.active, 'the storm settled in while paused (drivers ease on real time)').toBe(true);
    for (let frame = 0; frame < 60; frame += 1) {
      renderer.setWeather(stormView());
      renderer.update(16, 4_000 + 16 * frame);
    }
    const later = fake.frames.at(-1)!;
    expect([later.weatherRevision, later.lookRevision, later.weather.flash], 'frozen: nothing to write').toEqual([settled.weatherRevision, settled.lookRevision, 0]);
    expect(settled.lookRevision, 'the storm dimmed the look at least once').toBeGreaterThan(fake.frames[0].lookRevision);
  });

  it('falls back to no weather, keeping the voxel renderer, when the weather pass throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { renderer, gpu: fake } = await mounted();
    renderer.setWeather(stormView());
    for (let frame = 0; frame < 60; frame += 1) renderer.update(16, 16 * frame);
    expect(fake.frames.at(-1)!.weather.active).toBe(true);
    const update = vi.spyOn(WeatherLook.prototype, 'update').mockImplementation(() => {
      throw new Error('weather exploded');
    });
    try {
      renderer.update(16, 2_000);
      renderer.update(16, 2_016);
      const failed = fake.frames.at(-1)!;
      expect(failed.weather.active, 'a clear sky is fed from now on').toBe(false);
      expect(failed.weather.modifiers.exposureScale, 'identity grade').toBe(1);
      expect((globalThis as unknown as { window: { __voxelDegraded?: string } }).window.__voxelDegraded, 'reported once').toBe('no-weather');
      expect(warn, 'logged once').toHaveBeenCalledTimes(1);
      expect(update, 'the failed pass is not retried every frame').toHaveBeenCalledTimes(1);
      const frames = fake.frames.length;
      renderer.update(16, 2_032);
      expect(fake.frames.length, 'the renderer keeps drawing').toBe(frames + 1);
    } finally {
      update.mockRestore();
      warn.mockRestore();
    }
  });

  it('boots the lite composite with rain only, and the weather pass off on &voxelWeather=off', async () => {
    locationSearch = '?voxelComposite=lite';
    await mounted();
    expect(gpus.map((entry) => `${entry.options.compositeVariant}+${entry.options.weatherTier}`)).toEqual(['lite+rain']);
    gpus.length = 0;
    appGate = deferred();
    selfTestGate = deferred();
    locationSearch = '?voxelWeather=off';
    const { renderer, gpu: fake } = await mounted();
    expect(gpus.map((entry) => `${entry.options.compositeVariant}+${entry.options.weatherTier}`)).toEqual(['full+none']);
    renderer.setWeather(stormView());
    renderer.update(16, 16);
    expect(fake.frames.at(-1)!.weather.active, 'no effects without the pass').toBe(false);
  });

  it('writes a new look only when the time moved: a paused park or a pinned time costs a compare', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.setTimeOfDay(0.85);
    renderer.update(16, 16);
    const revision = fake.frames.at(-1)!.lookRevision;
    for (let frame = 0; frame < 30; frame += 1) {
      renderer.setTimeOfDay(0.85);
      renderer.update(16, 32 + frame);
    }
    expect(fake.frames.at(-1)!.lookRevision, 'same time, same look').toBe(revision);
    renderer.setTimeOfDay(0.86);
    renderer.update(16, 100);
    expect(fake.frames.at(-1)!.lookRevision, 'a moved clock re-blends').toBeGreaterThan(revision);
  });

  it('starts at the day preset and hands the GPU the lights bits of the presets that carry weight', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.update(16, 16);
    const first = fake.frames.at(-1)!;
    expect([first.preset, first.lightStrength, first.lightPass, first.backgroundAlpha]).toEqual(['day', 0, false, 0]);
    renderer.setTimeOfDay(0.1);
    renderer.update(16, 32);
    const night = fake.frames.at(-1)!;
    expect([night.preset, night.lightBits, night.backgroundAlpha]).toEqual(['night', 4, 1]);
    renderer.setTimeOfDay(19 / 24);
    renderer.update(16, 48);
    expect(fake.frames.at(-1)!.lightBits).toBe(2);
  });

  it('renders the overlay target only when the overlays, the camera texel or the size change', async () => {
    const { renderer, gpu: fake } = await mounted();
    expect(fake.overlayVisible.at(-1), 'an empty overlay is skipped').toBe(false);
    const rendered = (): number => fake.overlays.length;
    const before = rendered();
    renderer.update(16, 16);
    expect(rendered(), 'nothing to draw').toBe(before);
    renderer.drawPreview([{ x: 10, y: 10 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 0);
    renderer.update(16, 32);
    expect(rendered(), 'the preview is drawn once').toBe(before + 1);
    expect(fake.overlayVisible.at(-1), 'and composited').toBe(true);
    const frame = fake.frames.at(-1)!;
    expect(fake.overlays.at(-1), 'at −uCameraTexel').toEqual({ x: -frame.cameraTexelX, y: -frame.cameraTexelY });
    renderer.update(16, 48);
    expect(rendered(), 'a steady frame does not re-render it').toBe(before + 1);
    renderer.drawPreview([{ x: 10, y: 10 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 0);
    renderer.update(16, 56);
    expect(rendered(), 'nor does the same preview again (every pointermove sends one)').toBe(before + 1);
    renderer.focusCell({ x: 3, y: 4 });
    renderer.update(16, 64);
    expect(rendered(), 'a camera move does').toBe(before + 2);
    fake.options.onContextRestored?.();
    renderer.update(16, 80);
    expect(rendered(), 'so does a restored context').toBe(before + 3);
    renderer.clearPreview();
    renderer.update(16, 96);
    expect(fake.overlayVisible.at(-1), 'empty again: fetch off').toBe(false);
    expect(fake.ghosts.at(-1), 'the ghost is cleared with the preview').toBeNull();
  });

  it('shows a bin badge and renders the overlay target only when a badge changes', async () => {
    const session = new ParkSession(null);
    const bin = session.world.seedScenarioObject('tidy-totem', { x: 10, y: 10 })!;
    session.operations.syncWithWorld();
    const { renderer, gpu: fake } = await mounted(session);
    renderer.update(16, 16);
    expect(fake.overlayVisible.at(-1), 'an empty bin has no badge').toBe(false);
    session.operations.bins.get(bin.id)!.fill = 5;
    const before = fake.overlays.length;
    renderer.update(16, 32);
    expect(fake.overlayVisible.at(-1), 'a filled bin does').toBe(true);
    expect(fake.overlays.length).toBe(before + 1);
    renderer.update(16, 48);
    renderer.update(16, 64);
    expect(fake.overlays.length, 'a steady badge costs no overlay render').toBe(before + 1);
    renderer.setSession(new ParkSession(null));
    renderer.update(16, 80);
    expect(fake.overlayVisible.at(-1), 'the old park\'s badges are gone').toBe(false);
  });

  it('sends the ghost of a build preview', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.drawPreview([{ x: 10, y: 10 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 0);
    renderer.update(16, 16);
    const ghost = fake.ghosts.at(-1);
    expect(ghost?.boxCount, 'a ghost with boxes').toBeGreaterThan(0);
    expect([ghost?.originX, ghost?.originY], 'at the cell').toEqual([320, 320]);
  });

  it('sends the coaster draft as the real track and clears it with the layout', async () => {
    const { renderer, gpu: fake } = await mounted();
    const pieces = [0, 1, 2].map((x) => ({ cell: { x: 4 + x, y: 4 }, height: 0 }));
    renderer.drawCoasterDraft(pieces, 0xe4572e, true, 'star-chaser');
    renderer.update(16, 16);
    expect(fake.drafts.at(-1)?.boxCount, 'the track boxes').toBeGreaterThan(0);
    renderer.drawCoasterDraft([], 0);
    renderer.update(16, 32);
    expect(fake.drafts.at(-1), 'cleared').toBeNull();
  });

  it('applies a new viewport when the renderer resizes, before Pixi renders', async () => {
    const { renderer, app, gpu: fake } = await mounted();
    renderer.drawPreview([{ x: 10, y: 10 }], null, true, true);
    renderer.update(16, 16);
    const frames = fake.frames.length;
    const overlays = fake.overlays.length;
    app.resizeTo(640, 400);
    expect(fake.frames.length, 'new frame uniforms right away').toBe(frames + 1);
    expect(fake.frames.at(-1)!.lowWidth, 'the smaller target').toBeLessThan(fake.frames[frames - 1].lowWidth);
    expect(fake.overlays.length, 'and the overlay target redrawn').toBe(overlays + 1);
  });

  it('forgets the old park on setSession: GPU scene reset, every chunk sent again', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.update(16, 16);
    const chunks = fake.chunks.length;
    renderer.setSession(new ParkSession(null));
    expect(fake.resets, 'the GPU forgets its scene').toBe(1);
    renderer.update(16, 32);
    expect(fake.chunks.length - chunks, 'every chunk again').toBe(16);
  });

  it('resets the overlays and the badges (and forgets the preview) on setSession', async () => {
    const { VoxelOverlays } = await import('./overlay/overlays');
    const { VoxelBadges } = await import('./overlay/badges');
    const overlaysReset = vi.spyOn(VoxelOverlays.prototype, 'reset');
    const badgesReset = vi.spyOn(VoxelBadges.prototype, 'reset');
    try {
      const { renderer, gpu: fake } = await mounted();
      renderer.drawPreview([{ x: 10, y: 10 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 0);
      renderer.update(16, 16);
      const redraws = fake.overlays.length;
      renderer.setSession(new ParkSession(null));
      expect(overlaysReset, 'overlays').toHaveBeenCalledTimes(1);
      expect(badgesReset, 'badges').toHaveBeenCalledTimes(1);
      // The same preview again is not "unchanged" for the new park: it must reach the scene and overlays.
      fake.ghosts.length = 0;
      renderer.drawPreview([{ x: 10, y: 10 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 0);
      renderer.update(16, 32);
      expect(fake.ghosts.at(-1)?.boxCount, 'the ghost is rebuilt for the new park').toBeGreaterThan(0);
      expect(fake.overlays.length, 'and the overlay target drawn again').toBeGreaterThan(redraws);
    } finally {
      overlaysReset.mockRestore();
      badgesReset.mockRestore();
    }
  });

  it('reports the classic renderer\'s entity count', async () => {
    const session = new ParkSession(null);
    const { renderer } = await mounted(session);
    session.world.seedScenarioObject('confetti-tree', { x: 3, y: 3 });
    const { world, guests, operations } = session;
    expect(renderer.getPerformance().entities, 'objects + paths + guests + staff + litter').toBe(
      world.objects.size + world.paths.size + guests.guests.size + operations.staff.size + operations.litter.size,
    );
  });
});

describe('VoxelRenderer: weather review (photosensitivity and reduced motion)', () => {
  const storm = (seconds: number) => ({ ...createWeatherView(), kind: 'storm' as const, intensity: 1, flashSeed: 7, secondsIntoSegment: seconds });

  /** One-second-window worst case of rises through 0.4 (after a dip under 0.1) in the levels the GPU received. */
  const worstWindow = (levels: number[], fps: number): { flashes: number; worst: number; maxStep: number } => {
    const onsets: number[] = [];
    let armed = true;
    let maxStep = 0;
    levels.forEach((level, frame) => {
      if (frame > 0) maxStep = Math.max(maxStep, Math.abs(level - levels[frame - 1]));
      if (level <= 0.1) armed = true;
      if (armed && level >= 0.4) {
        armed = false;
        onsets.push(frame / fps);
      }
    });
    let worst = 0;
    for (let i = 0; i < onsets.length; i += 1) {
      let j = i;
      while (j + 1 < onsets.length && onsets[j + 1] - onsets[i] <= 1) j += 1;
      worst = Math.max(worst, j - i + 1);
    }
    return { flashes: onsets.length, worst, maxStep };
  };

  it('the lightning level the GPU receives has at most 3 flashes in any second at 1x and 4x, never exceeds 1, and has no instant step', async () => {
    for (const speed of [1, 4]) {
      const { renderer, gpu: fake } = await mounted();
      renderer.setTimeOfDay(0);
      let sim = 0;
      for (let frame = 0; frame < 60 * 150; frame += 1) {
        sim += speed / 60;
        renderer.setWeather(storm(sim));
        renderer.update(1000 / 60, frame * (1000 / 60));
      }
      const levels = fake.frames.map((frame) => frame.weather.flash);
      const result = worstWindow(levels, 60);
      expect(result.flashes, `speed ${speed} has lightning`).toBeGreaterThan(3);
      expect(result.worst, `speed ${speed}`).toBeLessThanOrEqual(3);
      expect(Math.max(...levels)).toBeLessThanOrEqual(1);
      expect(result.maxStep, 'rise is rate limited (12/s at 60 fps plus a quantisation step)').toBeLessThanOrEqual(12 / 60 + 1 / 16 + 1e-9);
      renderer.destroy();
      appGate = deferred();
      selfTestGate = deferred();
    }
  });

  it('reduced motion on at construction: the GPU never sees drifting clouds, falling rain, flashes or shimmer', async () => {
    updateSettings({ reducedMotion: 'on' });
    const { renderer, gpu: fake } = await mounted();
    renderer.setTimeOfDay(0.5);
    let sim = 0;
    for (let frame = 0; frame < 60 * 60; frame += 1) {
      sim += 4 / 60;
      renderer.setWeather(storm(sim));
      renderer.update(1000 / 60, frame * (1000 / 60));
    }
    const motion = fake.frames.map((frame) => [frame.weather.cloudOffsetX, frame.weather.cloudOffsetY, frame.weather.rainPhaseA, frame.weather.rainPhaseB, frame.weather.flash, frame.weather.shimmer, frame.weather.ripple]);
    expect(motion.every((row) => row.every((value) => value === 0))).toBe(true);
    expect(fake.frames.at(-1)!.weather.rainDensity, 'a light static texture').toBeLessThanOrEqual(0.35);
    expect(fake.frames.at(-1)!.weather.active).toBe(true);
  });

  it('a paused storm freezes every moving field even while sim time and pulses keep arriving', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.setTimeOfDay(0);
    renderer.setMachineryPaused(true);
    for (let frame = 0; frame < 60 * 8; frame += 1) {
      renderer.setWeather(storm(frame / 10));
      renderer.update(16, frame * 16);
    }
    const settled = fake.frames.length;
    for (let frame = 0; frame < 60 * 60; frame += 1) {
      renderer.setWeather(storm(100 + frame / 3));
      renderer.update(16, frame * 16);
    }
    const later = fake.frames.slice(settled).map((frame) => JSON.stringify(frame.weather));
    expect(new Set(later).size, 'identical effects on every paused frame').toBe(1);
    expect(fake.frames.at(-1)!.weather.flash).toBe(0);
  });
});

describe('VoxelRenderer: see-through cutaway', () => {
  /** Pins the cell the pointer hovers (the renderer reads `hoveredCell` every frame). */
  const hover = (renderer: Renderer, cell: { x: number; y: number } | null): void => {
    Object.defineProperty(renderer, 'hoveredCell', { configurable: true, get: () => cell });
  };
  const run = (renderer: Renderer, frames: number, deltaMs = 16): void => {
    for (let index = 0; index < frames; index += 1) renderer.update(deltaMs, index * deltaMs);
  };
  const revisions = (fake: FakeGpu, from: number): number[] => fake.frames.slice(from).map((frame) => frame.seeThrough.revision);
  const degraded = (): unknown => (globalThis as unknown as { window: { __voxelDegraded?: string } }).window.__voxelDegraded;

  it('is off and costs nothing until a tool is armed: the revision never moves', async () => {
    const { renderer, gpu: fake } = await mounted();
    hover(renderer, { x: 10, y: 10 });
    run(renderer, 60);
    expect(new Set(revisions(fake, 0)).size, 'one revision for 60 frames').toBe(1);
    expect(fake.frames.at(-1)!.seeThrough.strength).toBe(0);
  });

  it('fades in over 140 ms, then writes nothing more while the cursor stays', async () => {
    const { renderer, gpu: fake } = await mounted();
    hover(renderer, { x: 10, y: 10 });
    renderer.setSeeThrough({ armed: true, peek: false });
    run(renderer, 4, 16);
    const mid = fake.frames.at(-1)!.seeThrough.strength;
    expect(mid, 'rising, not popped').toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    run(renderer, 20, 16);
    const settledAt = fake.frames.length;
    expect(fake.frames.at(-1)!.seeThrough.strength, 'fully on').toBe(1);
    run(renderer, 60, 16);
    expect(new Set(revisions(fake, settledAt - 1)).size, 'an idle armed frame writes nothing: one revision').toBe(1);
  });

  it('opens the hole around the footprint it is given, in world texels, with the place cut key', async () => {
    const { renderer, gpu: fake } = await mounted();
    hover(renderer, { x: 10, y: 10 });
    renderer.drawPreview([{ x: 10, y: 10 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 0);
    renderer.setSeeThrough({ armed: true, peek: false });
    run(renderer, 120);
    const height = fake.ghosts.at(-1)!.heightVoxels;
    expect(height, 'the ghost model has a height').toBeGreaterThan(0);
    const frame = fake.frames.at(-1)!.seeThrough;
    // Cell (10, 10): X0 = Y0 = 320, X1 = Y1 = 352.
    expect([frame.ax, frame.aw], 'centred on the diamond, 32 texels either side').toEqual([0, 32]);
    expect(frame.ay + frame.ah, 'the rectangle ends at the near corner of the diamond').toBe(352);
    expect(frame.ay - frame.ah, 'and reaches the model\'s top').toBe(320 - height);
    expect(frame.cutKey, 'place: half the height past the near corner').toBe(704 + height / 2);
    expect([frame.floorZ, frame.margin]).toEqual([1.5, 24]);
  });

  it('slews the hole to a new cell instead of jumping, and lands exactly', async () => {
    const { renderer, gpu: fake } = await mounted();
    hover(renderer, { x: 10, y: 10 });
    renderer.setSeeThrough({ armed: true, peek: false });
    run(renderer, 30);
    const before = fake.frames.at(-1)!.seeThrough.ay;
    hover(renderer, { x: 11, y: 10 });
    renderer.update(16, 1_000);
    const first = fake.frames.at(-1)!.seeThrough;
    expect(first.ay, 'moved toward the new cell').toBeGreaterThan(before);
    expect(first.ay, 'but not all the way in one frame').toBeLessThan(before + 16);
    run(renderer, 60);
    expect(fake.frames.at(-1)!.seeThrough.ay, 'then exactly on it').toBe(before + 16);
    const settled = fake.frames.length;
    run(renderer, 30);
    expect(new Set(revisions(fake, settled - 1)).size, 'and then still').toBe(1);
  });

  it('fades out over 220 ms when the pointer leaves, where it was, and ends exactly at 0', async () => {
    const { renderer, gpu: fake } = await mounted();
    hover(renderer, { x: 10, y: 10 });
    renderer.setSeeThrough({ armed: true, peek: false });
    run(renderer, 30);
    const where = fake.frames.at(-1)!.seeThrough.ax;
    hover(renderer, null);
    run(renderer, 4, 16);
    const mid = fake.frames.at(-1)!.seeThrough;
    expect(mid.strength, 'fading, not gone').toBeGreaterThan(0);
    expect(mid.strength).toBeLessThan(1);
    expect(mid.ax, 'it stays where it was while it fades').toBe(where);
    run(renderer, 30, 16);
    expect(fake.frames.at(-1)!.seeThrough.strength).toBe(0);
    const settled = fake.frames.length;
    run(renderer, 30);
    expect(new Set(revisions(fake, settled - 1)).size).toBe(1);
  });

  it('reduced motion: on and off at once, the hole jumps to its cell without a fade', async () => {
    updateSettings({ reducedMotion: 'on' });
    const { renderer, gpu: fake } = await mounted();
    hover(renderer, { x: 10, y: 10 });
    renderer.setSeeThrough({ armed: true, peek: false });
    renderer.update(16, 16);
    expect(fake.frames.at(-1)!.seeThrough.strength, 'full strength on the first frame').toBe(1);
    const there = fake.frames.at(-1)!.seeThrough.ay;
    hover(renderer, { x: 11, y: 10 });
    renderer.update(16, 32);
    expect(fake.frames.at(-1)!.seeThrough.ay, 'the new cell at once').toBe(there + 16);
    hover(renderer, null);
    renderer.update(16, 48);
    expect(fake.frames.at(-1)!.seeThrough.strength, 'and gone at once').toBe(0);
  });

  it('peek opens a wider hole around the cursor, one cell further back, with a wider margin', async () => {
    const { renderer, gpu: fake } = await mounted();
    hover(renderer, { x: 10, y: 10 });
    renderer.setSeeThrough({ armed: false, peek: true });
    run(renderer, 30);
    const frame = fake.frames.at(-1)!.seeThrough;
    expect(frame.strength, 'peek works without an armed tool').toBe(1);
    // Cells 9..11: X1 = Y1 = 384; cell mode key 2 past the near corner, less one cell of depth.
    expect(frame.cutKey).toBe(768 + 2 - 64);
    expect(frame.margin).toBe(48);
    expect(frame.aw, 'three cells wide').toBe(96);
    renderer.setSeeThrough({ armed: false, peek: false });
    run(renderer, 30);
    expect(fake.frames.at(-1)!.seeThrough.strength, 'releases').toBe(0);
  });

  it('opens the whole object a bulldoze preview marks, not just the hovered cell, and keeps its own texels', async () => {
    const session = new ParkSession(null);
    const object = session.world.buildObject('petal-roundabout', { x: 12, y: 12 });
    expect(object, 'a multi-cell ride is placed').not.toBeNull();
    const { renderer, gpu: fake } = await mounted(session);
    const cell = { x: object!.anchor.x, y: object!.anchor.y };
    hover(renderer, cell);
    renderer.drawPreview([cell], null, true, true);
    renderer.setSeeThrough({ armed: true, peek: false });
    run(renderer, 120);
    const ghost = fake.ghosts.at(-1);
    expect(ghost?.boxCount, 'the demolished object is the ghost').toBeGreaterThan(0);
    const frame = fake.frames.at(-1)!.seeThrough;
    const farX = Math.ceil((ghost!.originX + ghost!.extentX) / 32);
    const farY = Math.ceil((ghost!.originY + ghost!.extentY) / 32);
    expect(frame.cutKey, 'the object\'s own fragments (key <= near corner + height) are never cut')
      .toBe((farX + farY) * 32 + ghost!.heightVoxels);
  });

  it('a paint hover opens the hole like a bulldoze target (the whole object, intact), costs nothing to repeat and narrows again with the hover (Phase 28 step 2)', async () => {
    const place = (): InstanceType<typeof ParkSession> => {
      const session = new ParkSession(null);
      expect(session.world.buildObject('petal-roundabout', { x: 12, y: 12 })).not.toBeNull();
      return session;
    };
    const cells = place().world.objectFootprint(place().world.objectAt({ x: 12, y: 12 })!).map((cell) => ({ x: cell.x, y: cell.y }));
    expect(cells.length, 'a multi-cell ride').toBeGreaterThan(3);
    const reference = await mounted(place());
    hover(reference.renderer, cells[0]);
    reference.renderer.drawPreview([cells[0]], null, true, true);
    reference.renderer.setSeeThrough({ armed: true, peek: false });
    run(reference.renderer, 120);
    const bulldoze = { ...reference.gpu.frames.at(-1)!.seeThrough };
    reference.renderer.destroy();
    log.length = 0;

    const { renderer, gpu: fake } = await mounted(place());
    hover(renderer, cells[0]);
    renderer.setSeeThrough({ armed: true, peek: false });
    renderer.setPaintHover({ cells, tint: 0x3aa7a3 });
    run(renderer, 120);
    const frame = fake.frames.at(-1)!.seeThrough;
    expect({ ...frame, revision: 0 }, 'the same hole a bulldoze preview of that ride opens').toEqual({ ...bulldoze, revision: 0 });
    expect(frame.strength).toBe(1);
    // Repeating the same hover changes nothing; no ghost is ever staged for a paint hover.
    const settled = fake.frames.length;
    renderer.setPaintHover({ cells: cells.map((cell) => ({ ...cell })), tint: 0x3aa7a3 });
    run(renderer, 30);
    expect(new Set(revisions(fake, settled - 1)).size).toBe(1);
    expect(fake.ghosts.filter((ghost) => ghost !== null && ghost !== undefined).length, 'no ghost for a hover').toBe(0);
    renderer.setPaintHover(null);
    run(renderer, 30);
    expect(fake.frames.at(-1)!.seeThrough.strength, 'without the hover the cursor cell still opens a plain hole').toBe(1);
    expect(fake.frames.at(-1)!.seeThrough.aw, 'a one-cell hole again').toBeLessThan(frame.aw);
    hover(renderer, null);
    run(renderer, 30);
    expect(fake.frames.at(-1)!.seeThrough.strength).toBe(0);
  });

  it('a path preview cuts in cell mode (no height), a coaster designer cursor in a fixed volume', async () => {
    const { renderer, gpu: fake } = await mounted();
    hover(renderer, { x: 10, y: 10 });
    renderer.drawPreview([{ x: 10, y: 10 }], BUILD_BY_ID.get('sunstone-path')!, true);
    renderer.setSeeThrough({ armed: true, peek: false });
    run(renderer, 30);
    expect(fake.frames.at(-1)!.seeThrough.cutKey, 'path: two voxels past the near corner').toBe(704 + 2);
    renderer.clearPreview();
    renderer.drawCoasterDraft([], 0, true, 'star-chaser');
    run(renderer, 120);
    const frame = fake.frames.at(-1)!.seeThrough;
    expect(frame.cutKey, 'coaster: half of the fixed 26 voxels').toBe(704 + 13);
    expect(frame.ah, 'tall enough to open a column of track').toBeGreaterThan(16);
  });

  it('moves no geometry: with the effect active a frame sends the scene exactly what an idle one does', async () => {
    const idle = await mounted();
    run(idle.renderer, 120);
    const baseline = { chunks: idle.gpu.chunks.length, dynamics: idle.gpu.dynamics.length };
    idle.renderer.destroy();
    log.length = 0;

    const { renderer, gpu: fake } = await mounted();
    hover(renderer, { x: 10, y: 10 });
    renderer.drawPreview([{ x: 10, y: 10 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 0);
    renderer.setSeeThrough({ armed: true, peek: true });
    for (let index = 0; index < 120; index += 1) {
      if (index === 60) hover(renderer, { x: 14, y: 9 });
      renderer.update(16, index * 16);
    }
    expect(fake.frames.some((frame) => frame.seeThrough.strength > 0), 'the effect ran').toBe(true);
    expect({ chunks: fake.chunks.length, dynamics: fake.dynamics.length }, 'no chunk rebuilt, no extra dynamic rows').toEqual(baseline);
  });

  it('gives up only the cutaway when its program fails (also without the view code): the pipeline is rebuilt without it, label no-seethrough', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const cutFailure = (): InstanceType<typeof UnsupportedRendererError> => new UnsupportedRendererError(
        'The GPU reported errors while the voxel renderer warmed up: see calls; first failing calls: gl.drawElements(4, 6, 5125, 0) [program voxel-worldCut-vertex] -> 0x502',
        { capability: false },
      );
      // The world-cut program carries the view code: the first retry is without it, and fails the same way.
      validateScript = [cutFailure(), cutFailure(), null];
      const renderer = new VoxelRenderer(new ParkSession(null));
      const result = renderer.mount(host as unknown as HTMLElement);
      appGate.resolve(fakeApp());
      await flush();
      selfTestGate.resolve();
      await expect(result).resolves.toBeUndefined();
      expect(gpus.map((entry) => entry.options.skipSeeThrough), 'the chain\'s retry skips it').toEqual([undefined, false, true]);
      expect(gpus.map((entry) => entry.options.viewTurn), 'and keeps the rotation').toEqual([true, false, true]);
      expect(degraded()).toBe('no-seethrough');
      hover(renderer, { x: 10, y: 10 });
      renderer.setSeeThrough({ armed: true, peek: false });
      run(renderer, 30);
      expect(gpus[2].frames.at(-1)!.seeThrough.strength, 'never asks the GPU for a hole').toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('rescues a failure that names no program (a link error) on the dither look by rebuilding once without the cutaway', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      locationSearch = '?voxelSeeThrough=dither';
      const unnamed = () => new UnsupportedRendererError('The GPU reported errors while the voxel renderer warmed up: link failed 0x502', { capability: false });
      validateScript = [unnamed(), null];
      const renderer = new VoxelRenderer(new ParkSession(null));
      const result = renderer.mount(host as unknown as HTMLElement);
      appGate.resolve(fakeApp());
      await flush();
      selfTestGate.resolve();
      await expect(result).resolves.toBeUndefined();
      expect(gpus.map((entry) => entry.options.skipSeeThrough), 'the retry skips it').toEqual([undefined, true]);
      expect(degraded()).toBe('no-seethrough');
    } finally {
      warn.mockRestore();
    }
  });

  it('contains a bug in the presentation: strength 0, one warning, label appended, the renderer carries on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { renderer, gpu: fake } = await mounted();
      Object.defineProperty(renderer, 'hoveredCell', { configurable: true, get: () => { throw new Error('boom'); } });
      renderer.setSeeThrough({ armed: true, peek: false });
      run(renderer, 10);
      run(renderer, 10);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(degraded()).toBe('no-seethrough');
      expect(fake.frames.at(-1)!.seeThrough.strength).toBe(0);
      expect(fake.frames.length, 'frames kept coming').toBeGreaterThanOrEqual(20);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('VoxelRenderer: translucent see-through', () => {
  const named = (...names: string[]): InstanceType<typeof UnsupportedRendererError> => new UnsupportedRendererError(
    `The GPU reported errors while the voxel renderer warmed up: see calls; first failing calls: ${names.map((name) => `gl.drawElements(4, 6, 5125, 0) [program ${name}-vertex] -> 0x502`).join(' | ')}`,
    { capability: false },
  );
  const unnamed = (): InstanceType<typeof UnsupportedRendererError> => new UnsupportedRendererError('A voxel shader program failed to link: no log', { capability: false });
  const mountScript = async (script: unknown[]): Promise<{ result: Promise<void> }> => {
    validateScript = script;
    const renderer = new VoxelRenderer(new ParkSession(null));
    const result = renderer.mount(host as unknown as HTMLElement);
    appGate.resolve(fakeApp());
    await flush();
    selfTestGate.resolve();
    return { result };
  };
  const degraded = (): unknown => (globalThis as unknown as { window: { __voxelDegraded?: string } }).window.__voxelDegraded;
  const rungs = (): string[] => gpus.map((entry) => `${entry.options.compositeVariant}+${entry.options.weatherTier}+${entry.options.translucentSeeThrough ? 'T' : '-'}${entry.options.skipSeeThrough ? '+skip' : ''}`);
  const quiet = (): ReturnType<typeof vi.spyOn> => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  it('starts on the translucent rung by default, with nothing degraded', async () => {
    await mounted();
    expect(rungs()).toEqual(['full+full+T']);
    expect(degraded()).toBeUndefined();
  });

  it('&voxelSeeThrough=dither starts on the old dither cut, &voxelSeeThrough=off without any cut, and a garbage value is the default', async () => {
    for (const [search, translucent] of [['?voxelSeeThrough=dither', false], ['?voxelSeeThrough=off', false], ['?voxelSeeThrough=bogus', true], ['?voxelSeeThrough=alpha', true]] as const) {
      log.length = 0;
      gpus.length = 0;
      appGate = deferred();
      selfTestGate = deferred();
      locationSearch = search;
      await mounted();
      expect(gpus[0].options.translucentSeeThrough, search).toBe(translucent);
      expect(degraded(), `${search}: asked for, not a degradation`).toBeUndefined();
    }
  });

  it('never builds the front layer on the lite composite, and asking for lite by flag is not a degradation', async () => {
    locationSearch = '?voxelComposite=lite';
    await mounted();
    expect(rungs()).toEqual(['lite+rain+-']);
    expect(degraded()).toBeUndefined();
  });

  it('drops only the translucent rung when a front-layer program fails: dither cutaway, label, same composite and weather', async () => {
    for (const program of ['voxel-worldFront', 'voxel-compositeFront']) {
      log.length = 0;
      gpus.length = 0;
      appGate = deferred();
      selfTestGate = deferred();
      const warn = quiet();
      try {
        // Both front programs carry the view code (worldFront the geometry's, compositeFront the full tier's ground
        // hook): the view retry comes first and fails the same way here.
        await expect((await mountScript([named(program), named(program), null])).result, program).resolves.toBeUndefined();
        expect(rungs(), program).toEqual(['full+full+T', 'full+full+T', 'full+full+-']);
        expect(gpus.map((entry) => entry.options.viewTurn), program).toEqual([true, false, true]);
        expect(degraded(), program).toBe('no-translucent-seethrough');
      } finally {
        warn.mockRestore();
      }
    }
  });

  it('retries a composite that failed in a translucent build on the same tier without the translucent mix first, then walks the old chain', async () => {
    const warn = quiet();
    try {
      await expect((await mountScript([named('voxel-composite'), named('voxel-composite'), null])).result).resolves.toBeUndefined();
      expect(rungs()).toEqual(['full+full+T', 'full+full+T', 'full+full+-']);
      expect(degraded(), 'the weather pass is kept').toBe('no-translucent-seethrough');
    } finally {
      warn.mockRestore();
    }
    log.length = 0;
    gpus.length = 0;
    appGate = deferred();
    selfTestGate = deferred();
    const again = quiet();
    try {
      await expect((await mountScript([named('voxel-composite'), named('voxel-composite'), named('voxel-composite'), named('voxel-composite'), null])).result).resolves.toBeUndefined();
      expect(rungs()).toEqual(['full+full+T', 'full+full+T', 'full+full+-', 'full+none+-', 'lite+rain+-']);
      expect(degraded()).toBe('composite-lite+no-translucent-seethrough');
    } finally {
      again.mockRestore();
    }
  });

  it('keeps the translucent cutaway and the weather when only the view code of the composites fails (no-view-rotation, Phase 26)', async () => {
    for (const program of ['voxel-composite', 'voxel-compositeFront']) {
      log.length = 0;
      gpus.length = 0;
      appGate = deferred();
      selfTestGate = deferred();
      const warn = quiet();
      try {
        await expect((await mountScript([named(program), null])).result, program).resolves.toBeUndefined();
        expect(rungs(), program).toEqual(['full+full+T', 'full+full+T']);
        expect(gpus.map((entry) => entry.options.viewTurn), program).toEqual([true, false]);
        expect(degraded(), program).toBe('no-view-rotation');
      } finally {
        warn.mockRestore();
      }
    }
  });

  it('steps a failure that names no program down one see-through rung at a time: translucent, dither, off', async () => {
    const warn = quiet();
    try {
      await expect((await mountScript([unnamed(), null])).result).resolves.toBeUndefined();
      expect(rungs()).toEqual(['full+full+T', 'full+full+-']);
      expect(degraded()).toBe('no-translucent-seethrough');
    } finally {
      warn.mockRestore();
    }
    log.length = 0;
    gpus.length = 0;
    appGate = deferred();
    selfTestGate = deferred();
    const again = quiet();
    try {
      await expect((await mountScript([unnamed(), unnamed(), null])).result).resolves.toBeUndefined();
      expect(rungs()).toEqual(['full+full+T', 'full+full+-', 'full+full+-+skip']);
      expect(degraded()).toBe('no-seethrough');
    } finally {
      again.mockRestore();
    }
  });

  it('throws the original error, never a retry\'s, when every see-through rung fails too', async () => {
    const original = unnamed();
    const warn = quiet();
    try {
      await expect((await mountScript([original, unnamed(), unnamed()])).result).rejects.toBe(original);
      expect(rungs()).toEqual(['full+full+T', 'full+full+-', 'full+full+-+skip']);
      expect(gpus.every((entry) => entry.destroyed)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the voxel renderer when the front layer throws at runtime: one warning, the label once', async () => {
    const warn = quiet();
    try {
      const { gpu: fake } = await mounted();
      fake.options.onTranslucentFailed?.(new Error('front draw'));
      fake.options.onTranslucentFailed?.(new Error('again'));
      expect(degraded()).toBe('no-translucent-seethrough');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('VoxelRenderer: view rotation (Phase 26)', () => {
  const hover = (renderer: Renderer, cell: { x: number; y: number } | null): void => {
    Object.defineProperty(renderer, 'hoveredCell', { configurable: true, get: () => cell });
  };
  const run = (renderer: Renderer, frames: number, deltaMs = 16): void => {
    for (let index = 0; index < frames; index += 1) renderer.update(deltaMs, index * deltaMs);
  };
  const degraded = (): unknown => (globalThis as unknown as { window: { __voxelDegraded?: string } }).window.__voxelDegraded;
  const tagged = (name: string): InstanceType<typeof UnsupportedRendererError> => new UnsupportedRendererError(
    `The GPU reported errors while the voxel renderer warmed up: see calls; first failing calls: gl.drawElements(4, 6, 5125, 0) [program ${name}-vertex] -> 0x502`,
    { capability: false },
  );

  it('supports the view rotation and says so on the port', async () => {
    const { renderer } = await mounted();
    expect(renderer.supportsViewRotation).toBe(true);
    expect(renderer.gestureHeld).toBe(false);
  });

  it('turns in one call: one new view revision, every non-empty chunk re-sent once, nothing more on the steady frames after', async () => {
    const { renderer, gpu: fake } = await mounted();
    run(renderer, 5);
    const before = { chunks: fake.chunks.length, dynamics: fake.dynamics.length, revision: fake.frames.at(-1)!.view.revision };
    renderer.setViewRotation(1);
    // Everything of the turn is applied before the next frame: the chunks were re-sent already.
    const resent = fake.chunks.slice(before.chunks);
    expect(resent.length, 'the chunks with boxes were re-sorted and re-sent').toBeGreaterThan(0);
    expect(new Set(resent.map((chunk) => chunk.index)).size, 'each once').toBe(resent.length);
    expect(resent.every((chunk) => chunk.count > 0 && chunk.bounds !== null)).toBe(true);
    run(renderer, 1);
    const turned = fake.frames.at(-1)!.view;
    expect(turned.rotation).toBe(1);
    expect(turned.revision).toBe(before.revision + 1);
    expect(turned).toMatchObject({ c: 0, s: 1, ox: 32 * 32, oy: 0 });
    const settled = { chunks: fake.chunks.length, dynamics: fake.dynamics.length };
    run(renderer, 60);
    expect(new Set(fake.frames.slice(-60).map((frame) => frame.view.revision)).size, 'the revision stays put').toBe(1);
    expect(fake.chunks.length, 'no chunk sent on steady frames').toBe(settled.chunks);
    expect(fake.dynamics.length - settled.dynamics, 'no dynamic row beyond what a still frame stages').toBeLessThanOrEqual(120);
  });

  it('is idempotent for the current rotation and turns back to the identical view 0 data', async () => {
    const { renderer, gpu: fake } = await mounted();
    run(renderer, 2);
    const revision = fake.frames.at(-1)!.view.revision;
    const chunks = fake.chunks.length;
    renderer.setViewRotation(0);
    expect(fake.chunks.length, 'same view: nothing re-sent').toBe(chunks);
    renderer.setViewRotation(2);
    renderer.setViewRotation(0);
    run(renderer, 1);
    expect(fake.frames.at(-1)!.view.rotation).toBe(0);
    expect(fake.frames.at(-1)!.view.revision).toBe(revision + 2);
  });

  it('keeps the ground point at the middle of the screen through a turn, and four turns restore the camera', async () => {
    const { renderer, gpu: fake } = await mounted();
    run(renderer, 2);
    const first = fake.frames.at(-1)!;
    const start = [first.cameraTexelX, first.cameraTexelY];
    for (let turn = 1; turn <= 4; turn += 1) {
      renderer.setViewRotation((turn & 3) as 0 | 1 | 2 | 3);
      run(renderer, 1);
    }
    const last = fake.frames.at(-1)!;
    expect([last.cameraTexelX, last.cameraTexelY], 'four quarter turns come back').toEqual(start);
  });

  it('opens the see-through hole over the build site in each view (the focus is converted to view cells)', async () => {
    for (const rotation of [0, 1, 2, 3] as const) {
      log.length = 0;
      gpus.length = 0;
      appGate = deferred();
      selfTestGate = deferred();
      const { renderer, gpu: fake } = await mounted();
      renderer.setViewRotation(rotation);
      hover(renderer, { x: 10, y: 4 });
      renderer.drawPreview([{ x: 10, y: 4 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 0);
      renderer.setSeeThrough({ armed: true, peek: false });
      run(renderer, 120);
      const height = fake.ghosts.at(-1)!.heightVoxels;
      const frame = fake.frames.at(-1)!.seeThrough;
      // The view cell of world cell (10, 4) on a 32 x 32 map; the hole is exactly what the view-0 maths gives for it.
      const [u, v] = [[10, 4], [31 - 4, 10], [31 - 10, 31 - 4], [4, 31 - 10]][rotation];
      const expected = seeThroughValuesFor({ minX: u, minY: v, maxX: u, maxY: v, mode: 'place', peek: false, heightVoxels: height }, createSeeThroughValues());
      expect(frame, `view ${rotation}`).toMatchObject({ ax: expected.ax, ay: expected.ay, aw: expected.aw, ah: expected.ah, cutKey: expected.cutKey });
      renderer.destroy();
    }
  });

  it('snaps the see-through hole on a turn instead of sliding it across the screen', async () => {
    const { renderer, gpu: fake } = await mounted();
    hover(renderer, { x: 10, y: 4 });
    renderer.setSeeThrough({ armed: true, peek: false });
    run(renderer, 60);
    renderer.setViewRotation(1);
    run(renderer, 1);
    const frame = fake.frames.at(-1)!.seeThrough;
    // The very first frame after the turn already holds the final hole: it never slews from the old place.
    run(renderer, 1);
    expect(fake.frames.at(-1)!.seeThrough.ax).toBe(frame.ax);
    expect(fake.frames.at(-1)!.seeThrough.ay).toBe(frame.ay);
  });

  it('falls back to view 0 and no-view-rotation when a geometry program fails in the view build, keeping the voxel renderer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      validateScript = [tagged('voxel-worldOpaque'), null];
      const renderer = new VoxelRenderer(new ParkSession(null));
      const result = renderer.mount(host as unknown as HTMLElement);
      appGate.resolve(fakeApp());
      await flush();
      selfTestGate.resolve();
      await expect(result).resolves.toBeUndefined();
      expect(gpus.map((entry) => entry.options.viewTurn)).toEqual([true, false]);
      expect(degraded()).toBe('no-view-rotation');
      expect(renderer.supportsViewRotation).toBe(false);
      expect(host.appended, 'attached: the voxel renderer stays').toHaveLength(1);
      renderer.setViewRotation(1);
      run(renderer, 2);
      expect(gpus[1].frames.at(-1)!.view.rotation, 'never turns').toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('goes to the classic renderer (throws the ORIGINAL error) when the retry without the view code fails too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const original = tagged('voxel-worldDither');
      validateScript = [original, tagged('voxel-worldDither')];
      const renderer = new VoxelRenderer(new ParkSession(null));
      const result = renderer.mount(host as unknown as HTMLElement);
      appGate.resolve(fakeApp());
      await flush();
      selfTestGate.resolve();
      await expect(result).rejects.toBe(original);
    } finally {
      warn.mockRestore();
    }
  });

  it('contains a failure inside a turn: back to view 0, rotation off, the label, one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { renderer, gpu: fake } = await mounted();
      run(renderer, 2);
      let throws = true;
      const scene = (renderer as unknown as { scene: { setView(frame: unknown): void } }).scene;
      const original = scene.setView.bind(scene);
      scene.setView = (frame: { rotation: number }): void => {
        if (throws && frame.rotation === 1) {
          throws = false;
          throw new Error('boom');
        }
        original(frame);
      };
      renderer.setViewRotation(1);
      run(renderer, 2);
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('view rotation')), 'one warning').toHaveLength(1);
      expect(degraded()).toBe('no-view-rotation');
      expect(renderer.supportsViewRotation).toBe(false);
      expect(fake.frames.at(-1)!.view.rotation, 'the picture is at view 0').toBe(0);
      renderer.setViewRotation(2);
      run(renderer, 2);
      expect(fake.frames.at(-1)!.view.rotation, 'and stays there').toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('turns the camera focus points through the view: a world cell lands on the same screen place before and after four turns', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.focusCell({ x: 5, y: 9 });
    run(renderer, 1);
    const a = [fake.frames.at(-1)!.cameraTexelX, fake.frames.at(-1)!.cameraTexelY];
    renderer.setViewRotation(1);
    renderer.focusCell({ x: 5, y: 9 });
    run(renderer, 1);
    const b = [fake.frames.at(-1)!.cameraTexelX, fake.frames.at(-1)!.cameraTexelY];
    expect(b, 'a different view puts the same cell at another texel').not.toEqual(a);
    renderer.setViewRotation(0);
    renderer.focusCell({ x: 5, y: 9 });
    run(renderer, 1);
    expect([fake.frames.at(-1)!.cameraTexelX, fake.frames.at(-1)!.cameraTexelY]).toEqual(a);
  });
});

describe('VoxelRenderer: crowd heatmap (Phase 14)', () => {
  const run = (renderer: Renderer, frames: number, from = 0, deltaMs = 16): void => {
    for (let index = 0; index < frames; index += 1) renderer.update(deltaMs, (from + index) * deltaMs);
  };
  const view = (revision: number): CrowdHeatmapView => ({
    revision,
    cells: [{ x: 8, y: 10 }, { x: 9, y: 10 }, { x: 10, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 10 }],
    bands: [0, 1, 2, 3, 3],
  });
  const overlayRootOf = (renderer: Renderer): Container => (renderer as unknown as { overlayRoot: Container }).overlayRoot;
  const hintsLayerOf = (renderer: Renderer): Container => (renderer as unknown as { hints: { layer: Container } }).hints.layer;

  it('implements the optional port method and runs unmounted in Node', () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    const port: RendererPort = renderer;
    expect(typeof port.setCrowdHeatmap).toBe('function');
    renderer.setCrowdHeatmap(view(1));
    renderer.setCrowdHeatmap(null);
    renderer.update(16, 16);
    renderer.destroy();
    expect(log, 'nothing booted').toEqual([]);
  });

  it('puts the crowd layer above the land layer (Phase 21) and the hints at index 4, after both heatmaps and the selection', () => {
    const renderer = new VoxelRenderer(new ParkSession(null));
    const root = overlayRootOf(renderer);
    expect(root.children.indexOf(hintsLayerOf(renderer))).toBe(4);
    renderer.setCrowdHeatmap(view(1));
    expect((root.children[0] as Container).children.length, 'a wholly owned park draws no land layer').toBe(0);
    expect((root.children[1] as Container).children.length, 'the crowd drawing is in layer 1').toBe(1);
    renderer.destroy();
  });

  it('renders the overlay target once per new revision; the same revision on every frame costs zero Graphics calls and no render', async () => {
    const { renderer, gpu: fake } = await mounted();
    run(renderer, 2);
    expect(fake.overlayVisible.at(-1)).toBe(false);
    const before = fake.overlays.length;
    renderer.setCrowdHeatmap(view(1));
    run(renderer, 1, 2);
    expect([fake.overlays.length, fake.overlayVisible.at(-1)], 'drawn once and composited').toEqual([before + 1, true]);
    const calls = countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 60; frame += 1) {
        renderer.setCrowdHeatmap(view(1));
        renderer.update(16, (3 + frame) * 16);
      }
    });
    expect([calls, fake.overlays.length], 'steady: no Graphics call, no overlay render').toEqual([0, before + 1]);
    renderer.setCrowdHeatmap(view(2));
    run(renderer, 1, 70);
    expect(fake.overlays.length, 'a new revision: one render').toBe(before + 2);
    renderer.setCrowdHeatmap(null);
    run(renderer, 1, 71);
    expect(fake.overlayVisible.at(-1), 'hidden: empty, fetch off').toBe(false);
    const hidden = fake.overlays.length;
    expect(countGraphicsDrawCalls(() => {
      renderer.setCrowdHeatmap(null);
      run(renderer, 30, 72);
    }), 'hidden: nothing drawn').toBe(0);
    expect(fake.overlays.length).toBe(hidden);
  });

  it('Phase 15: with feedback effects running (and the heatmap on), a frame makes no Graphics call; once they end the overlay is steady', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.setCrowdHeatmap(view(1));
    run(renderer, 1, 2);
    const effect = { kind: 'money-spend' as const, x: 12, y: 20, objectId: null, amount: -1_150 };
    const calls = countGraphicsDrawCalls(() => {
      renderer.showEffect(effect);
      renderer.showEffect({ ...effect, kind: 'happy', x: 14.5, y: 25.25 });
      renderer.showEffect({ ...effect, kind: 'money-gain', amount: 40 });
      for (let frame = 0; frame < 120; frame += 1) renderer.update(16, (3 + frame) * 16);
    });
    expect(calls, 'effects animate transform and alpha only').toBe(0);
    const settled = fake.overlays.length;
    run(renderer, 30, 200);
    expect(fake.overlays.length, 'ended: no more overlay renders').toBe(settled);
  });

  it('voxel leftovers: figures the camera cannot see are not packed (a guest on screen still is)', async () => {
    const session = new ParkSession(null, [], { mapId: 'meadow-estate' });
    session.world.addMoney(1_000_000);
    for (let offer = session.world.land.forSale(); offer.length > 0; offer = session.world.land.forSale()) {
      for (const parcel of offer) session.world.buyParcel(parcel);
    }
    session.guests.spawnGuests(200);
    // Spread them over the whole estate: corners far from the camera.
    let index = 0;
    for (const guest of session.guests.guests.values()) {
      guest.position = { x: (index * 7) % 64, y: (index * 13) % 64 };
      guest.currentCell = { x: Math.floor(guest.position.x), y: Math.floor(guest.position.y) };
      index += 1;
    }
    const { renderer, gpu: fake } = await mounted(session);
    renderer.focusCell({ x: 2, y: 2 });
    run(renderer, 2, 5);
    const figures = fake.dynamics.filter((entry) => entry.texture === 'figures');
    const shown = figures.at(-1)?.count ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(200);
  });

  it('voxel leftovers: a point on the raised rim of a path top picks the path, not the cell behind it', async () => {
    const session = new ParkSession(null);
    const { renderer } = await mounted(session);
    const refine = (renderer as unknown as { refinePick(ground: { x: number; y: number }, x: number, y: number): { x: number; y: number } }).refinePick;
    // The ground diamond of (10, 10) has its top vertex at texel (0, 320); one texel above it is the cell behind.
    const behind = pickCell(createFrame(0, 32, 32), 0, 319);
    expect(behind).not.toEqual({ x: 10, y: 10 });
    expect(refine(behind, 0, 319), 'no path: the ground pick').toEqual(behind);
    session.world.seedScenarioPaths([{ x: 10, y: 10 }]);
    expect(refine(behind, 0, 319), 'the path top covers that texel').toEqual({ x: 10, y: 10 });
    expect(refine({ x: 10, y: 10 }, 0, 330), 'inside the diamond: unchanged').toEqual({ x: 10, y: 10 });
  });

  it('redraws once on a view turn and is steady after it', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.setCrowdHeatmap(view(1));
    run(renderer, 2);
    const version = (renderer as unknown as { overlays: { version: number } }).overlays.version;
    renderer.setViewRotation(1);
    expect((renderer as unknown as { overlays: { version: number } }).overlays.version, 'one bump').toBe(version + 1);
    run(renderer, 1, 2);
    const rendered = fake.overlays.length;
    expect(countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 30; frame += 1) {
        renderer.setCrowdHeatmap(view(1));
        renderer.update(16, (3 + frame) * 16);
      }
    })).toBe(0);
    expect(fake.overlays.length, 'no overlay render on steady frames').toBe(rendered);
  });

  it('forgets the old park\'s heatmap on setSession, and the same revision for the new park is drawn afresh', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.setCrowdHeatmap(view(4));
    run(renderer, 1);
    renderer.setSession(new ParkSession(null));
    run(renderer, 1, 1);
    expect(fake.overlayVisible.at(-1), 'the old park\'s flow is gone').toBe(false);
    expect(countGraphicsDrawCalls(() => renderer.setCrowdHeatmap(view(4)))).toBeGreaterThan(0);
    run(renderer, 1, 2);
    expect(fake.overlayVisible.at(-1)).toBe(true);
  });
});

/**
 * Phase 26 review (GPU/perf reviewer, adversarial): the failure paths of the view rotation. Reviewer-added;
 * production code untouched.
 */
describe('VoxelRenderer: view rotation failure paths (review)', () => {
  const run = (renderer: Renderer, frames: number, deltaMs = 16): void => {
    for (let index = 0; index < frames; index += 1) renderer.update(deltaMs, index * deltaMs);
  };
  const cameraOf = (fake: FakeGpu): number[] => [fake.frames.at(-1)!.cameraTexelX, fake.frames.at(-1)!.cameraTexelY];
  const tagged = (name: string): InstanceType<typeof UnsupportedRendererError> => new UnsupportedRendererError(
    `The GPU reported errors while the voxel renderer warmed up: see calls; first failing calls: gl.drawElements(4, 6, 5125, 0) [program ${name}-vertex] -> 0x502`,
    { capability: false },
  );

  it('a failure AFTER the scene took the new view (overlays) restores the camera of the view actually shown, not of the failed one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { renderer, gpu: fake } = await mounted();
      run(renderer, 2);
      const start = cameraOf(fake);
      renderer.setViewRotation(1);
      run(renderer, 1);
      expect(cameraOf(fake), 'view 1 moved the camera').not.toEqual(start);
      // The scene has already switched to view 2 when the overlays throw; the camera was never retargeted to it.
      const overlays = (renderer as unknown as { overlays: { setView(frame: { rotation: number }): void } }).overlays;
      const original = overlays.setView.bind(overlays);
      overlays.setView = (frame: { rotation: number }): void => {
        if (frame.rotation === 2) throw new Error('boom in overlays');
        original(frame);
      };
      renderer.setViewRotation(2);
      run(renderer, 1);
      expect(fake.frames.at(-1)!.view.rotation, 'back at view 0').toBe(0);
      // View 1 -> view 0 is an exact turn (dyadic camera at zoom 1): the ground point under the centre is the one before.
      expect(cameraOf(fake), 'camera recentred from the view that was on screen (1), not from the failed one (2)').toEqual(start);
    } finally {
      warn.mockRestore();
    }
  });

  it('a turn requested before mount is undone when the pipeline then degrades to no-view-rotation (picking, overlays and chunk bounds stay in view 0)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // GameApp sets `this.renderer` before awaiting mount, and supportsViewRotation reads true until the build says otherwise:
      // a save load or a Q press during the mount await reaches setViewRotation on an unmounted renderer.
      validateScript = [tagged('voxel-worldOpaque'), null];
      const renderer = new VoxelRenderer(new ParkSession(null));
      expect(renderer.supportsViewRotation, 'reads true before the build').toBe(true);
      renderer.setViewRotation(2);
      const result = renderer.mount(host as unknown as HTMLElement);
      appGate.resolve(fakeApp());
      await flush();
      selfTestGate.resolve();
      await expect(result).resolves.toBeUndefined();
      expect(renderer.supportsViewRotation).toBe(false);
      run(renderer, 2);
      const last = gpus.at(-1)!;
      // The viewTurn:false GPU draws the identity whatever frame.view says; everything CPU-side must agree with it.
      expect(last.frames.at(-1)!.view.rotation, 'the scene view (chunk sort, chunk bounds, frame.view) is view 0').toBe(0);
      const viewFrame = (renderer as unknown as { viewFrame: { rotation: number } }).viewFrame;
      expect(viewFrame.rotation, 'picking (bindWorldInput viewFrame getter) is in view 0').toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('VoxelRenderer: steady frames in every view with see-through, ghost and weather active (review)', () => {
  const run = (renderer: Renderer, frames: number, from = 0, deltaMs = 16): void => {
    for (let index = 0; index < frames; index += 1) renderer.update(deltaMs, (from + index) * deltaMs);
  };

  it('sends no chunk, no ghost and keeps the view revision, the look and the see-through revision put on steady frames in views 0..3', async () => {
    const { renderer, gpu: fake } = await mounted();
    Object.defineProperty(renderer, 'hoveredCell', { configurable: true, get: () => ({ x: 10, y: 4 }) });
    renderer.drawPreview([{ x: 10, y: 4 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 0);
    renderer.setSeeThrough({ armed: true, peek: false });
    renderer.setWeather?.(createWeatherView());
    let clockFrame = 0;
    for (const rotation of [1, 2, 3, 0] as const) {
      renderer.setViewRotation(rotation);
      // The see-through hole eases in over its own frames after a turn snaps it; let it settle.
      run(renderer, 240, clockFrame);
      clockFrame += 240;
      const mark = { chunks: fake.chunks.length, ghosts: fake.ghosts.length, frames: fake.frames.length };
      run(renderer, 60, clockFrame);
      clockFrame += 60;
      const steady = fake.frames.slice(mark.frames);
      expect(fake.chunks.length - mark.chunks, `view ${rotation}: chunks sent on steady frames`).toBe(0);
      expect(fake.ghosts.length - mark.ghosts, `view ${rotation}: ghost re-sent on steady frames`).toBe(0);
      expect(new Set(steady.map((frame) => frame.view.revision)).size, `view ${rotation}: view revision`).toBe(1);
      expect(steady.every((frame) => frame.view.rotation === rotation), `view ${rotation}: frames carry the view`).toBe(true);
      expect(new Set(steady.map((frame) => frame.seeThrough.revision)).size, `view ${rotation}: see-through revision settles`).toBe(1);
      expect(new Set(steady.map((frame) => frame.lookRevision)).size, `view ${rotation}: look revision`).toBe(1);
    }
  });
});

describe('VoxelRenderer: camera clamp and eased focus (Phase 11, PA-021)', () => {
  const cameraOf = (fake: FakeGpu): number[] => [fake.frames.at(-1)!.cameraTexelX, fake.frames.at(-1)!.cameraTexelY];
  const snapTo = async (cell: { x: number; y: number }): Promise<number[]> => {
    const { renderer, gpu: fake } = await mounted();
    renderer.focusCell(cell);
    renderer.update(16, 16);
    const result = cameraOf(fake);
    renderer.destroy();
    log.length = 0;
    gpus.length = 0;
    appGate = deferred();
    selfTestGate = deferred();
    return result;
  };

  it('focusCell defaults to a snap, and \'ease\' glides there over 250 ms through the frame loop', async () => {
    const target = await snapTo({ x: 25, y: 6 });
    const { renderer, gpu: fake } = await mounted();
    renderer.update(16, 0);
    const start = cameraOf(fake);
    renderer.focusCell({ x: 25, y: 6 }, 'ease');
    renderer.update(16, 16);
    const early = cameraOf(fake);
    expect(early, 'moving').not.toEqual(start);
    expect(early, 'not there yet').not.toEqual(target);
    for (let frame = 2; frame <= 16; frame += 1) renderer.update(16, frame * 16);
    expect(cameraOf(fake), 'landed after 256 ms').toEqual(target);
  });

  it('snaps under reduced motion even when asked to ease', async () => {
    const target = await snapTo({ x: 25, y: 6 });
    updateSettings({ reducedMotion: 'on' });
    const { renderer, gpu: fake } = await mounted();
    renderer.update(16, 0);
    renderer.focusCell({ x: 25, y: 6 }, 'ease');
    renderer.update(16, 16);
    expect(cameraOf(fake), 'no intermediate frame').toEqual(target);
  });

  it('eases to the entrance and completes the glide on a view turn', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.focusCell({ x: 3, y: 3 });
    renderer.update(16, 0);
    renderer.focusEntrance('ease');
    renderer.update(16, 16);
    renderer.setViewRotation(1);
    renderer.setViewRotation(0);
    renderer.update(16, 32);
    const afterTurns = cameraOf(fake);
    renderer.focusEntrance();
    renderer.update(16, 48);
    expect(afterTurns, 'the turn landed the glide on the entrance framing first').toEqual(cameraOf(fake));
  });

  it('a drag pan cancels a glide where it is', async () => {
    const { renderer, gpu: fake } = await mounted();
    renderer.update(16, 0);
    renderer.focusCell({ x: 25, y: 6 }, 'ease');
    renderer.update(16, 16);
    const camera = (renderer as unknown as { camera: { panByCss(dx: number, dy: number): void; easeActive: boolean } }).camera;
    camera.panByCss(0, 0);
    expect(camera.easeActive).toBe(false);
    renderer.update(16, 32);
    const held = cameraOf(fake);
    renderer.update(100, 132);
    expect(cameraOf(fake)).toEqual(held);
  });

  it('feeds the camera the plot in view cells: a far pan stays near the map in every view', async () => {
    const { renderer, gpu: fake } = await mounted();
    const camera = (renderer as unknown as { camera: { panByCss(dx: number, dy: number): void } }).camera;
    for (const rotation of [0, 1, 2, 3] as const) {
      renderer.setViewRotation(rotation);
      camera.panByCss(-50_000, -50_000);
      renderer.update(16, 16);
      const [x, y] = cameraOf(fake);
      // The 32 x 32 plot spans texels x in [-1024, 1024], y in [0, 1024]; the margin keeps the window touching it.
      expect(Math.abs(x), `view ${rotation}`).toBeLessThan(2_000);
      expect(Math.abs(y), `view ${rotation}`).toBeLessThan(2_000);
    }
  });
});
