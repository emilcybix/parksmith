import {
  Application,
  BufferImageSource,
  Geometry,
  GlProgram,
  RenderContainer,
  RendererType,
  RenderTexture,
  Shader,
  State,
  type RenderSurface,
  type WebGLRenderer,
} from 'pixi.js';
import { UnsupportedRendererError } from '../RendererPort';
import { programTag } from './gpu/glFailure';

/**
 * Starting the voxel renderer's Pixi application, and proving the GPU can run it before anything is
 * shown. Everything that can fail on a player's machine fails here, inside `mount`, as an
 * UnsupportedRendererError — so GameApp can fall back to the classic renderer instead of showing a
 * blank park. That matters because Pixi itself never throws for the usual low-tier failures: it
 * silently falls back to WebGL1, and it only logs a shader that fails to compile or link.
 *
 * Nothing runs at module load: every GPU object is created inside these functions (the module is
 * also imported by Node tests, where creating a GlProgram throws).
 */

/** Renderer strings of software rasterisers, from WEBGL_debug_renderer_info (or RENDERER). */
const SOFTWARE_RASTERISER = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i;

export interface VoxelAppOptions {
  /** R, device px per CSS px. */
  resolution: number;
  /**
   * Run on a software rasteriser instead of refusing it (`&voxelAllowSoftware=1`, headless test
   * browsers). It also skips the performance-caveat probe, which a software GPU fails by definition.
   */
  allowSoftware: boolean;
  /**
   * Runs once just before `app.init`. Texture uploaders and other renderer extensions must be
   * registered before the renderer's systems are constructed, i.e. here.
   */
  beforeInit?: () => void;
  /** `&voxelDebug=1`: trace every GL call that leaves an error behind (see traceGlErrors). */
  debug?: boolean;
}

const capabilityError = (message: string, cause?: unknown, kind: 'webgl2' | 'software' = 'webgl2'): UnsupportedRendererError =>
  new UnsupportedRendererError(message, { capability: true, kind, cause });

const failureError = (message: string, cause?: unknown): UnsupportedRendererError =>
  new UnsupportedRendererError(message, { capability: false, cause });

/**
 * What the browser will hand out: `hardware` (a WebGL2 context it does not consider a "major
 * performance caveat"), `software` (WebGL2 only with the caveat, i.e. a blocklisted GPU or a
 * software fallback) or `none`. Probed on throwaway canvases rather than through Pixi's
 * `failIfMajorPerformanceCaveat` option: Pixi caches its WebGL-support answer for the whole page, so
 * a refused probe there would also push the classic fallback onto Pixi's Canvas renderer. The
 * difference between the last two is what the player is told (GameApp's toast).
 */
const probeWebGl2 = (): 'hardware' | 'software' | 'none' => {
  const probe = (failIfMajorPerformanceCaveat: boolean): boolean => {
    const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat });
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  };
  if (probe(true)) return 'hardware';
  return probe(false) ? 'software' : 'none';
};

/** The GPU's name as the browser reports it (unmasked where the browser allows). */
export const gpuRendererName = (gl: WebGL2RenderingContext): string => {
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
};

/** The largest render target side the GPU supports: texture size and viewport, whichever is smaller. */
export const maxRenderTargetSize = (gl: WebGL2RenderingContext): number => {
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, viewport[0], viewport[1]);
};

/**
 * Creates the voxel renderer's Application (design §4): WebGL only, no MSAA (the look is pixel
 * art), a transparent canvas so the page's own gradient shows, the real device pixel ratio, sized
 * to `host`. Rejects with a capability error unless the result is a WebGL **2** context on a
 * hardware GPU (or `allowSoftware`). The canvas is not attached; the caller does that once the GPU
 * has been validated.
 */
export const createVoxelApp = async (
  host: HTMLElement,
  options: VoxelAppOptions,
): Promise<Application<WebGLRenderer>> => {
  if (!options.allowSoftware) {
    const support = probeWebGl2();
    if (support !== 'hardware') {
      throw capabilityError('The voxel renderer needs a hardware-accelerated WebGL2 context', undefined, support === 'software' ? 'software' : 'webgl2');
    }
  }
  options.beforeInit?.();
  const app = new Application<WebGLRenderer>();
  try {
    await app.init({
      // Only WebGL: auto-detection would otherwise build a WebGPU or Canvas renderer just to refuse it.
      preference: ['webgl'],
      antialias: false,
      backgroundAlpha: 0,
      resolution: options.resolution,
      autoDensity: true,
      resizeTo: host,
    });
  } catch (cause) {
    throw capabilityError('Pixi could not create a WebGL renderer', cause);
  }
  try {
    const renderer = app.renderer;
    if (renderer.type !== RendererType.WEBGL) {
      throw capabilityError('The voxel renderer needs WebGL2; Pixi picked a different backend');
    }
    // Pixi falls back to WebGL1 without a word when WebGL2 is missing.
    if (renderer.context.webGLVersion !== 2) {
      throw capabilityError(`The voxel renderer needs WebGL2; the browser only offers WebGL ${renderer.context.webGLVersion}`);
    }
    const name = gpuRendererName(renderer.gl as WebGL2RenderingContext);
    if (!options.allowSoftware && SOFTWARE_RASTERISER.test(name)) {
      throw capabilityError(`The voxel renderer needs a hardware GPU; this one is a software rasteriser (${name})`, undefined, 'software');
    }
  } catch (error) {
    app.destroy(true, { children: true });
    throw error;
  }
  // Always on while the pipeline starts up (the warm-up is a handful of calls), so a driver error
  // names its call; `debug` keeps it on for the whole session.
  traceGlErrors(app.renderer.gl as WebGL2RenderingContext, options.debug === true);
  return app;
};

/**
 * Wraps every WebGL method so the error queue is read after each call, remembering the first calls
 * that fail (name, a short argument summary, a stack). Drivers differ on what they reject, and a bare
 * "0x502 while warming up" says nothing about which call it was; the startup errors quote this list.
 * Slow, so `stopGlErrorTrace` removes it once the pipeline has been validated.
 */
/** The `#define SHADER_NAME` Pixi puts in every program, of whatever program is in use right now. */
const currentProgramName = (gl: WebGL2RenderingContext): string => {
  const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  if (!program) return 'none';
  for (const shader of gl.getAttachedShaders(program) ?? []) {
    const match = /#define SHADER_NAME ([\w-]+)/.exec(gl.getShaderSource(shader) ?? '');
    if (match) return match[1];
  }
  return 'unnamed';
};

const traces = new WeakMap<WebGL2RenderingContext, { lines: string[]; restore: () => void }>();

const traceGlErrors = (gl: WebGL2RenderingContext, logToConsole: boolean): void => {
  if (traces.has(gl)) return;
  const lines: string[] = [];
  const target = gl as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  for (const key in gl) {
    const original = target[key];
    if (typeof original !== 'function' || key === 'getError') continue;
    originals.set(key, original);
    target[key] = function traced(...args: unknown[]): unknown {
      const result = (original as (...rest: unknown[]) => unknown).apply(gl, args);
      if (lines.length < 12) {
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
          const summary = args.map((arg) => (typeof arg === 'number' || typeof arg === 'string'
            ? String(arg) : arg === null ? 'null' : (arg as object).constructor?.name ?? typeof arg)).join(', ');
          const program = key.startsWith('draw') ? programTag(currentProgramName(gl)) : '';
          const line = `gl.${key}(${summary})${program} -> 0x${error.toString(16)}`;
          lines.push(line);
          if (logToConsole) console.error(`[voxelDebug] ${line}`, new Error().stack);
        }
      }
      return result;
    };
  }
  traces.set(gl, {
    lines,
    restore: () => { for (const [key, original] of originals) target[key] = original; },
  });
};

/**
 * Forgets the failing calls recorded so far (the tracing itself stays on). A pipeline rebuilt after
 * a failed startup (VoxelRenderer's lite composite) must be judged on its own draws, not on the
 * failure it replaces.
 */
export const resetGlErrorTrace = (gl: WebGL2RenderingContext): void => {
  const trace = traces.get(gl);
  if (trace) trace.lines.length = 0;
  // Drain the queue too (capped: a lost context keeps reporting).
  let drained = 0;
  while (gl.getError() !== gl.NO_ERROR && drained < 16) drained += 1;
};

/**
 * Turns the call tracing back on (it is removed once the startup is validated) and forgets earlier
 * failures: a re-validation after a restored context must name the call that fails, like startup does.
 */
export const startGlErrorTrace = (gl: WebGL2RenderingContext): void => {
  traceGlErrors(gl, false);
  resetGlErrorTrace(gl);
};

/** Removes the call tracing (unless the session asked for it with `&voxelDebug=1`). */
export const stopGlErrorTrace = (gl: WebGL2RenderingContext, keep: boolean): void => {
  if (keep) return;
  traces.get(gl)?.restore();
  traces.delete(gl);
};

/** Throws if the GL error queue is not empty, naming every pending error (capped: a lost context repeats). */
const assertNoGlErrors = (gl: WebGL2RenderingContext, during: string): void => {
  const errors: string[] = [];
  for (let error = gl.getError(); error !== gl.NO_ERROR && errors.length < 16; error = gl.getError()) {
    errors.push(`0x${error.toString(16)}`);
  }
  // The call trace reads (and so empties) the error queue after every call, so a failure may live
  // only in its list.
  const calls = traces.get(gl)?.lines ?? [];
  if (errors.length > 0 || calls.length > 0) {
    throw failureError(`The GPU reported errors while ${during}: ${errors.length > 0 ? errors.join(', ') : 'see calls'}${calls.length > 0 ? `; first failing calls: ${calls.join(' | ')}` : ''}`);
  }
};

/** A program's name: the `#define SHADER_NAME` Pixi writes into its vertex source (GlProgram keeps no name). */
const programNameOf = (program: GlProgram): string =>
  /#define SHADER_NAME ([\w-]+)/.exec(program.vertex ?? '')?.[1] ?? 'unnamed';

/** Longest compiler/linker log a failure message carries (a D3D log can run to pages). */
const MAX_LINK_LOG = 600;

/**
 * Everything the driver said about a program that did not link: the program log and each shader's
 * compile log (Direct3D reports the real cause there), truncated. Written next to the program tag so
 * the failure is attributed (and the lite/no-lights fallbacks can match it) like a draw-time failure.
 */
const linkLogOf = (gl: WebGL2RenderingContext, program: WebGLProgram): string => {
  const parts = [gl.getProgramInfoLog(program) ?? ''];
  for (const shader of gl.getAttachedShaders(program) ?? []) parts.push(gl.getShaderInfoLog(shader) ?? '');
  const log = parts.map((part) => part.trim()).filter((part) => part.length > 0).join(' | ');
  if (log.length === 0) return 'no log';
  return log.length > MAX_LINK_LOG ? `${log.slice(0, MAX_LINK_LOG)}…` : log;
};

/**
 * Proves that GPU resources built (and drawn once, as a warm-up) actually work, because Pixi only
 * logs failures: every program is linked now (`_getProgramData` compiles and links on demand) and
 * must report LINK_STATUS; every render target's framebuffer must be complete; and the GL error
 * queue must be empty. Throws a non-capability UnsupportedRendererError otherwise. Call it outside
 * a render pass; it leaves Pixi's GL state caches reset.
 */
export const validateGpu = (
  renderer: WebGLRenderer,
  programs: readonly GlProgram[],
  targets: readonly RenderSurface[],
): void => {
  const gl = renderer.gl as WebGL2RenderingContext;
  for (const program of programs) {
    const linked = renderer.shader._getProgramData(program).program;
    if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) {
      throw failureError(`A voxel shader program failed to link${programTag(programNameOf(program))}: ${linkLogOf(gl, linked)}`);
    }
  }
  try {
    for (const surface of targets) {
      const target = renderer.renderTarget.getRenderTarget(surface);
      gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.renderTarget.getGpuRenderTarget(target).framebuffer);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw failureError(`A voxel render target is incomplete (framebuffer status 0x${status.toString(16)})`);
      }
    }
  } finally {
    // The framebuffer was bound behind Pixi's back; make it forget what it thinks is bound.
    renderer.resetState();
  }
  assertNoGlErrors(gl, 'the voxel renderer warmed up');
};

/** What a re-validation needs of the GPU pipeline (VoxelGpu satisfies it). */
export interface RevalidatableGpu {
  warmUp(): void;
  programs(): readonly GlProgram[];
  targets(): readonly RenderSurface[];
}

/**
 * Proves the pipeline again after a lost WebGL context came back: Pixi rebuilt the context, and a
 * driver that has just been reset may fail exactly the draws it failed (or passed) before. Draws
 * every program once, validates, and throws a non-capability UnsupportedRendererError if anything is
 * wrong, with the call trace on so the failing program is named. A context that is lost again is
 * not judged here (nothing can be drawn; the lost-context timeout owns that case).
 */
export const revalidateGpu = (renderer: WebGLRenderer, gpu: RevalidatableGpu): void => {
  const gl = renderer.gl as WebGL2RenderingContext;
  if (gl.isContextLost()) return;
  startGlErrorTrace(gl);
  try {
    gpu.warmUp();
    validateGpu(renderer, gpu.programs(), gpu.targets());
  } finally {
    stopGlErrorTrace(gl, false);
  }
};

/**
 * How long a readback may wait for the GPU before the GPU is considered broken. A slow first frame
 * on a busy machine (shader compilation in another process, a throttled laptop) can take seconds,
 * so this is generous; the budget is split over two fences (below).
 */
const READBACK_TIMEOUT_MS = 15_000;
/** Poll interval for the readback fence; its status only changes between tasks anyway. */
const FENCE_POLL_MS = 4;

/** Resolves true when the fence signalled, false when `timeoutMs` passed first; rejects if the GPU is gone. */
const waitForFence = (gl: WebGL2RenderingContext, sync: WebGLSync, timeoutMs: number): Promise<boolean> => new Promise((resolve, reject) => {
  const started = performance.now();
  const poll = (): void => {
    const status = gl.clientWaitSync(sync, 0, 0);
    if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
      resolve(true);
    } else if (status === gl.WAIT_FAILED || gl.isContextLost()) {
      reject(failureError('The GPU lost the voxel self-test readback'));
    } else if (performance.now() - started > timeoutMs) {
      resolve(false);
    } else {
      setTimeout(poll, FENCE_POLL_MS);
    }
  };
  poll();
});

/**
 * Waits for the GPU to finish what was queued, with one fresh fence if the first never signals: a
 * fence created while the driver was still busy compiling can be starved, a second one cannot.
 * The two attempts share READBACK_TIMEOUT_MS.
 */
const waitForGpu = async (gl: WebGL2RenderingContext): Promise<void> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) throw failureError('The GPU could not fence the voxel self-test readback');
    gl.flush();
    try {
      if (await waitForFence(gl, sync, READBACK_TIMEOUT_MS / 2)) return;
    } finally {
      gl.deleteSync(sync);
    }
  }
  throw failureError(`The GPU did not finish the voxel self-test within ${READBACK_TIMEOUT_MS} ms`);
};

/**
 * Reads a small render target back without stalling the GPU. A plain readPixels waits for all
 * queued work (and Chrome logs "GPU stall due to ReadPixels" for it), so the pixels are copied into
 * a pixel-pack buffer instead, fenced, and fetched once the fence has signalled between tasks.
 */
const readBackWithoutStall = async (renderer: WebGLRenderer, target: RenderTexture): Promise<Uint8Array> => {
  const gl = renderer.gl as WebGL2RenderingContext;
  const { width, height } = target.source;
  const pixels = new Uint8Array(width * height * 4);
  const buffer = gl.createBuffer();
  try {
    try {
      const glTarget = renderer.renderTarget.getGpuRenderTarget(renderer.renderTarget.getRenderTarget(target));
      gl.bindFramebuffer(gl.FRAMEBUFFER, glTarget.resolveTargetFramebuffer);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, pixels.byteLength, gl.STREAM_READ);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    } finally {
      // Pixi never binds a pack buffer, and its readbacks would fail with one left bound.
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      renderer.resetState();
    }
    await waitForGpu(gl);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return pixels;
  } finally {
    gl.deleteBuffer(buffer);
  }
};

const SELF_TEST_SIZE = 4;
/**
 * The probe texel (RGBA32F, like every voxel data texture): a non-integer value above 1 that an
 * 8-bit or integer-truncating path would mangle, a fraction, and the alpha.
 */
const SELF_TEST_TEXEL = [2.5, 0.375, 1.25, 1] as const;
/** The flat integer varying the vertex shader sends (the figure and world programs pass indices this way). */
const SELF_TEST_TAG = 9;
/**
 * What every pixel of the target must read back: the fragment shader writes x / 4, y, tag / 16 and w,
 * so each channel checks a different part of the path (float fetch above 1, float fetch below 1, the
 * flat int varying, the plain alpha). In 8-bit units, ±1.
 */
const SELF_TEST_COLOR = [159, 96, 143, 255] as const;

const SELF_TEST_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uProbe;
flat out vec4 vTexel;
flat out int vTag;
void main() {
  // No attributes at all, like every voxel draw: a full-screen triangle from gl_VertexID alone,
  // the colour from a float data texture read in the vertex shader and an integer sent flat.
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vTexel = texelFetch(uProbe, ivec2(1, 0), 0);
  vTag = ${SELF_TEST_TAG};
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const SELF_TEST_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
flat in vec4 vTexel;
flat in int vTag;
out vec4 outColor;
void main() {
  outColor = vec4(vTexel.x * 0.25, vTexel.y, float(vTag) / 16.0, vTexel.w);
}`;

/**
 * Draws one attribute-less ES 3.00 triangle (gl_VertexID, an RGBA32F texelFetch in the vertex
 * shader, flat float and int varyings) into a 4×4 target, validates program, target and error queue, and reads the target back.
 * A driver that mis-handles the features every voxel draw depends on is caught here, at mount,
 * before any of the real pipeline exists. Resolves after one GPU round trip (a few ms).
 */
export const runGpuSelfTest = async (renderer: WebGLRenderer): Promise<void> => {
  const gl = renderer.gl as WebGL2RenderingContext;
  const program = new GlProgram({
    name: 'voxel-self-test',
    vertex: SELF_TEST_VERTEX,
    fragment: SELF_TEST_FRAGMENT,
    preferredFragmentPrecision: 'highp',
  });
  // Texel 0 is never read: a driver that ignores texelFetch's coordinate returns 100, not the probe.
  const probe = new BufferImageSource({
    resource: new Float32Array([100, 100, 100, 100, ...SELF_TEST_TEXEL]),
    width: 2,
    height: 1,
    format: 'rgba32float',
    alphaMode: 'no-premultiply-alpha',
    scaleMode: 'nearest',
  });
  const target = RenderTexture.create({ width: SELF_TEST_SIZE, height: SELF_TEST_SIZE, format: 'rgba8unorm', scaleMode: 'nearest' });
  const geometry = new Geometry({ indexBuffer: new Uint16Array([0, 1, 2]) });
  const shader = new Shader({ glProgram: program, resources: { uProbe: probe } });
  const state = new State();
  state.blend = false;
  const layer = new RenderContainer({ render: () => renderer.encoder.draw({ geometry, shader, state }) });
  try {
    try {
      renderer.render({ container: layer, target, clear: true, clearColor: [0, 0, 0, 0] });
    } catch (cause) {
      throw failureError('The voxel GPU self-test could not render', cause);
    }
    validateGpu(renderer, [program], [target]);
    const pixels = await readBackWithoutStall(renderer, target);
    assertNoGlErrors(gl, 'the voxel self-test was read back');
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const matches = SELF_TEST_COLOR.every((channel, index) => Math.abs(pixels[offset + index] - channel) <= 1);
      if (!matches) {
        const found = Array.from(pixels.subarray(offset, offset + 4)).join(', ');
        throw failureError(`The voxel GPU self-test read back rgba(${found}) instead of rgba(${SELF_TEST_COLOR.join(', ')})`);
      }
    }
  } finally {
    layer.destroy();
    shader.destroy();
    geometry.destroy();
    target.destroy(true);
    probe.destroy();
  }
};
