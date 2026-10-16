import {
  Buffer as PixiBuffer,
  BufferImageSource,
  BufferUsage,
  CLEAR,
  Geometry,
  RenderContainer,
  RenderTarget,
  RenderTexture,
  Shader,
  State,
  TextureSource,
  UniformGroup,
  type BindOptions,
  type Container,
  GlProgram,
  type Renderer,
  type RenderSurface,
  type WebGLRenderer,
} from 'pixi.js';
import type { SnappedCamera } from '../camera';
import {
  BOX_FLOATS,
  BOX_TEX_WIDTH,
  BOX_TEXELS,
  buildBoxIndices,
  packBoxWord,
  DYNAMIC_BOX_TEX_WIDTH,
  INDICES_PER_BOX,
  TRANSFORM_TEX_WIDTH,
  TRANSFORM_TEXELS,
} from '../contracts/boxes';
import {
  FIGURE_MODEL_COUNT,
  FIGURE_TEMPLATE_TEX_WIDTH,
  FIGURE_TEMPLATE_TEXELS,
  FIGURE_TEX_WIDTH,
  FIGURE_TEXELS,
  type FigureRange,
} from '../contracts/figures';
import {
  LIGHT_TEX_WIDTH,
  LIGHT_TEXELS,
  type DynamicTexture,
  type GhostState,
  type TexelBounds,
  type VoxelGpuSink,
} from '../contracts/frame';
import { GHOST_DEPTH_BIAS, GHOST_TINT_MIX } from '../contracts/gbuffer';
import { MAT, PALETTE_TEX_ROWS, PALETTE_TEX_WIDTH, PATTERN } from '../contracts/palette';
import type { DepthRange } from '../contracts/space';
import { blendLightPreset, createDayLook, type DayLook } from '../dayLook';
import type { LightPresetName } from '../lightPresets';
import type { WeatherEffects } from '../../weatherLook';
import type { FigureTemplates } from '../scene/figureModels';
import { rendererHasVoxelUploader, VoxelDataSource } from './dataSource';
import {
  boxDrawIndexCount,
  boxesForLights,
  chunkNeedsCut,
  clipSizeFor,
  createVoxelGpuStats,
  figureRangeBoxes,
  GHOST_XRAY_COVERAGE,
  GHOST_XRAY_TINT_MIX,
  GPU_MIN_TARGET_SIZE,
  indexCapacityFor,
  lightDrawIndexCount,
  lightPassActive,
  lightPresetBit,
  planChunkDraws,
  planWarmUp,
  resetVoxelGpuStats,
  rowsForRecords,
  viewOfTarget,
  wrapShaderSeconds,
  type ChunkDrawState,
  type TexelView,
  type VoxelGpuStats,
  type WarmDraw,
} from './drawPlan';
import type { ViewTransform } from '../contracts/view';
import { ViewUniformSync } from './viewUniforms';
import { createVoxelPrograms, VOXEL_PROGRAM_NAMES, type VoxelPrograms } from './programs';
import { createFrontRect, FRONT_CAPACITY, frontRectFor, seeThroughView, SeeThroughUniformSync, type SeeThroughFrame } from './seeThroughView';
import type { CompositeVariant } from './shaders/composite';
import type { WeatherTier } from './shaders/compositeWeather';
import { WeatherUniformSync, type WeatherUniformTarget } from './weatherUniforms';
import { rgbToUnit } from './shaders/glsl';
import { GpuPassTimer, PASS_COMPOSITE, PASS_GBUFFER, PASS_LIGHT, PASS_UPSCALE, type GpuPassTimings } from './timing';
import { perspectiveCompositeShaderSource, perspectiveFigureShaderSource, perspectiveWorldShaderSource } from './shaders/perspective';
import { horizonRow, viewProjection, type CinematicView } from '../cameraOrbit';

/**
 * The voxel renderer's GPU side (design §5–§7): every Pixi resource and every pass of a frame.
 *
 * The scene (VoxelScene) feeds it through the VoxelGpuSink seam — static chunks, dynamic rows, figure
 * ranges, the ghost — and the renderer adds the per-frame camera and look (`setFrame`). All of it is
 * drawn inside one `app.render()` by `layer`, a RenderContainer the renderer puts on the stage:
 *
 *   G-buffer (MRT albedo + gdata, sampled depth24plus; cleared) — visible chunks nearest first,
 *     figures one draw per model, litter; then the dithered draws: figure shadow decals, the ghost's
 *     x-ray (depth test GREATER, before the ghost so the ghost never x-rays itself) and the ghost
 *   → [translucent see-through only: the front layer — the cut chunks through `worldFront` into a small front
 *     G-buffer, the light pass over it (same lights, front camera) into the front light target, then
 *     `compositeFront` into `frontLit` over the hole's rectangle, hiding the texels the main depth has nearer]
 *   → light pass (dusk and night: one additive quad per light into the light target)
 *   → composite (G-buffer + light + overlay [+ the lit front layer] → the finished low-res picture)
 *   → integer upscale into whatever target the stage is rendered to (the screen).
 *
 * Rules the whole file keeps (design §5, critique gpu #4/#12, performance #10/#11):
 * - every box draw goes through `drawBoxes`: a zero count skips the draw (Pixi would draw the WHOLE
 *   index buffer for size 0), start 0, size = boxes · 18, never past the shared index buffer, which
 *   is one Uint32 buffer sized to the largest single draw and grown by powers of two;
 * - one Shader per data source (a Shader per chunk), all of a program's shaders sharing the one
 *   GlProgram and the one `frameUniforms` group with identical resource order — swapping a resource
 *   per draw would allocate, and Pixi generates one sync function per program;
 * - no `discard` in any program an opaque draw uses (programs.ts); the one exception is the see-through
 *   cutaway: while its strength is above 0, the few chunks whose bounds touch the hole are drawn with
 *   the `worldCut` program (a dithered discard of what stands in front of the build site), every other
 *   draw keeps the discard-free one, and with the effect off the cut program is never bound;
 * - targets that a pass overwrites completely are still cleared (tile GPUs then skip the load);
 * - the G-buffer pass maps geometry through a power-of-two viewport (uClipSize) and sub-texel-snapped
 *   positions, so window coordinates are exact and a pan by whole texels moves every texel exactly —
 *   rotating ride parts included;
 * - the overlay target is unbound after the composite samples it, so Pixi can always render into it;
 * - nothing is allocated per frame once warm: draw options, bind options and counters are reused;
 * - long-lived geometry and buffers never get garbage-collected (a culled chunk must not lose its
 *   GPU copy); every data texture keeps its CPU copy, so a restored context re-uploads everything
 *   on first use, and the owner is told (`onContextRestored`) to redraw the overlay target.
 *
 * Nothing runs at module load; `createVoxelGpu` builds everything, after `app.init`, in the browser.
 */

export interface VoxelGpuOptions {
  /**
   * `lite` swaps the composite fragment shader for the degraded one (no neighbour taps, outlines,
   * contours or light pools): the fallback when a GPU's shader compiler refuses `full` (ANGLE/D3D11:
   * "Error compiling dynamic pixel executable"). Same resources and draws either way. Default `full`.
   */
  compositeVariant?: CompositeVariant;
  /**
   * What the composite compiles of the weather pass (shaders/compositeWeather.ts): `full` (default for the
   * full composite), `rain` (default for lite) or `none`. A GPU compiler that refuses the composite is
   * retried with fewer effects before the composite itself is simplified (VoxelRenderer).
   */
  weatherTier?: WeatherTier;
  /**
   * Harness only (`&voxelGpu=min`, design §5): the same CPU work, uploads and draw sequence, but
   * every draw clamped to one box, 64×64 targets and no composite taps, so frame-rate gates measure
   * the main thread even on a software rasteriser.
   */
  gpuMin?: boolean;
  /** Per-pass GPU timing with EXT_disjoint_timer_query_webgl2 when the GPU offers it. */
  timing?: boolean;
  /** Draw the parts of the ghost that existing geometry hides, sparser (default on). */
  ghostXray?: boolean;
  /** Never run the light pass (its program failed on this GPU): no light pools, the rest unchanged. */
  skipLights?: boolean;
  /** Never draw the figure shadow decals (their program failed on this GPU). */
  skipShadows?: boolean;
  /** Never create the see-through cut shaders and ignore the frame's see-through input (its program failed). */
  skipSeeThrough?: boolean;
  /**
   * Phase 26 view rotation (default on): compile the VX_VIEW sources (every geometry program, the light pass and
   * the composite's ground hook read `uView`). False builds today's exact pre-rotation sources (hash-pinned by
   * shaders.test.ts): the `no-view-rotation` rung the voxel renderer retries with when a geometry program
   * fails to compile or draw in a view-turn build. `VoxelGpu.supportsViewTurn` reports what was built.
   */
  viewTurn?: boolean;
  /**
   * The translucent see-through (default off): the occluders of the see-through volume are drawn into a
   * front layer, lit on its own and mixed over the revealed scene at SEE_THROUGH.OCCLUDER_OPACITY. Off, or
   * with the lite composite, the cut is the dithered screen door (the `dither` rung); the front programs
   * and targets are not even created.
   */
  translucentSeeThrough?: boolean;
  /**
   * Called once when the front layer's draw code threw: the GPU then renders the dither rung for good
   * (the exception is contained, the voxel renderer keeps running).
   */
  onTranslucentFailed?: (error: unknown) => void;
  /**
   * Called after a lost WebGL context came back. Data textures and targets restore themselves; the
   * owner must re-render the overlay target and re-send anything it only sends on change.
   */
  onContextRestored?: () => void;
}

/** Everything that changes per frame outside the scene. */
export interface VoxelFrameInput {
  readonly camera: Readonly<SnappedCamera>;
  /** Milliseconds since mount; wrapped for the shaders here. */
  readonly elapsedMs: number;
  readonly grid: boolean;
  /** The preset the look is nearest to (diagnostics); the look itself is `look`. */
  readonly preset: LightPresetName;
  /**
   * The blended look (dayLook.ts). The renderer owns this scratch and bumps `lookRevision` whenever
   * it rewrote it, so a still frame (a paused park, a pinned time) costs the GPU one integer compare.
   */
  readonly look: Readonly<DayLook>;
  readonly lookRevision: number;
  /** `uPresetBit`: the union of the presets that carry weight, so authored lights stay eligible. */
  readonly lightBits: number;
  /** depthRangeFor(map width, map height) — every depth key of the park inside, with room to spare. */
  readonly depthRange: Readonly<DepthRange>;
  /**
   * The weather look (rendering/weatherLook.ts) and its `revision`: the uniforms are written only when the
   * revision moved, so a calm or paused frame costs one compare. Omitted = a clear sky.
   */
  readonly weather?: Readonly<WeatherEffects>;
  readonly weatherRevision?: number;
  /**
   * The see-through cutaway (seeThroughView.ts): the uniforms are written only when its `revision`
   * moved, and the cut program is bound only while `strength` > 0. Omitted = off.
   */
  readonly seeThrough?: Readonly<SeeThroughFrame>;
  /**
   * Phase 26: the view transform (contracts/view.ts). `uView` (and the front layer's copy) is written only when
   * its `revision` moved, so a steady frame writes nothing. Omitted = view 0. Ignored by a `viewTurn: false` build.
   */
  readonly view?: Readonly<ViewTransform>;
}

/** The surfaces of the pipeline, for validation and for harness readbacks. */
export interface VoxelGpuSurfaces {
  readonly gbuffer: RenderTarget;
  readonly albedo: TextureSource;
  readonly gdata: TextureSource;
  readonly depth: TextureSource;
  readonly light: TextureSource;
  readonly composite: TextureSource;
  readonly overlay: RenderTexture;
  /** The translucent see-through's front layer (null when the pipeline has none): G-buffer and its lit result. */
  readonly front: {
    readonly gbuffer: RenderTarget;
    readonly albedo: TextureSource;
    readonly gdata: TextureSource;
    readonly depth: TextureSource;
    /** The front layer's own light pools (the light pass run over the front G-buffer). */
    readonly light: TextureSource;
    readonly lit: TextureSource;
  } | null;
}

export interface VoxelGpu extends VoxelGpuSink {
  /**
   * Phase 41: the cinematic camera. A view draws the frame through it (the static chunks, the train, the ground skirt,
   * a sky and fog; no figures, overlays or ghosts); null is the isometric view. The renderer sends it every frame it
   * wants it; the programs compile on first use.
   */
  setPerspective(view: Readonly<CinematicView> | null): void;
  /** Phase 41: the map size in tiles (the ground skirt around it). */
  setCameraMap(widthTiles: number, heightTiles: number): void;
  /** Phase 41: whether the cinematic programs compiled and drew (false after a failure: the caller stays isometric). */
  readonly perspectiveOk: boolean;
  /** The sources were built with the view-rotation code (VoxelGpuOptions.viewTurn); false = view 0 only. */
  readonly supportsViewTurn: boolean;
  /** The stage child that runs every pass; add it to `app.stage` once. */
  readonly layer: RenderContainer;
  /** Low-res overlay target (world texels, row 0 at the top), composited with dither. */
  readonly overlayTexture: RenderTexture;
  readonly surfaces: VoxelGpuSurfaces;
  /** The previous frame's counters. */
  readonly stats: Readonly<VoxelGpuStats>;
  /** Smoothed per-pass GPU milliseconds, or null without the timer extension (or `timing` off). */
  readonly timings: GpuPassTimings | null;
  /** Sizes every low-res target (camera.ts lowResSize, guard band included). Cheap when unchanged. */
  resize(lowWidth: number, lowHeight: number): void;
  setFrame(frame: VoxelFrameInput): void;
  /** contracts/palette.ts textureData(): 256 × 4 RGBA8. */
  setPalette(textureData: Uint8Array): void;
  setFigureTemplates(templates: FigureTemplates): void;
  /** Whether the composite samples the overlay target (off when the overlay is empty). */
  setOverlayVisible(visible: boolean): void;
  /** Renders `container` (world texels, already placed at −uCameraTexel) into the overlay target. */
  renderOverlay(container: Container): void;
  /** Forgets every chunk, dynamic count, figure range and the ghost (session swap). Keeps GPU memory. */
  resetScene(): void;
  /**
   * One minimal real draw of every program this pipeline uses, with its real state (planWarmUp),
   * rendered through the layer outside the scene: the synthetic draws read whatever the data
   * textures hold, change no count, range or ghost, and the next frame overwrites every target, so
   * the first real frame looks exactly as it would have. Call it before validating, so draw-time
   * driver failures of ANY program are in the error queue and the call trace.
   */
  warmUp(): void;
  /** Every GlProgram in use (those of skipped features are left out), for boot.ts validateGpu. */
  programs(): readonly GlProgram[];
  /** Every render target, for boot.ts validateGpu. */
  targets(): readonly RenderSurface[];
  destroy(): void;
}

const FLOATS_PER_TEXEL = 4;
const RGBA8_BYTES_PER_TEXEL = 4;
const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];

/** One static chunk: its own data texture and Shader, its live box count and screen bounds. */
class ChunkSlot implements ChunkDrawState {
  /** The same chunk through the see-through cut program, created the first time a hole touches it. */
  cutShader: Shader | null = null;
  /** The same chunk through the front-layer program, created the first time the translucent hole touches it. */
  frontShader: Shader | null = null;
  /** Phase 41 spike: the same chunk through the perspective program (only with `&camera3d`). */
  perspectiveShader: Shader | null = null;
  /** Whether this frame's draw of the chunk goes through the cut program (set by drawChunks for the visible chunks). */
  cutNow = false;
  count = 0;
  bounds: TexelBounds | null = null;
  private readonly boundsStore: TexelBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(readonly source: VoxelDataSource, readonly shader: Shader) {}

  setBounds(bounds: Readonly<TexelBounds> | null): void {
    if (!bounds) {
      this.bounds = null;
      return;
    }
    this.boundsStore.minX = bounds.minX;
    this.boundsStore.minY = bounds.minY;
    this.boundsStore.maxX = bounds.maxX;
    this.boundsStore.maxY = bounds.maxY;
    this.bounds = this.boundsStore;
  }
}

/** The one stage child of the voxel renderer: runs every pass of a frame inside app.render. */
export class VoxelLayer extends RenderContainer {
  private readonly runPasses: (renderer: Renderer) => void;

  constructor(runPasses: (renderer: Renderer) => void) {
    super({ label: 'VoxelLayer' });
    this.runPasses = runPasses;
    this.eventMode = 'none';
  }

  override render(renderer: Renderer): void {
    this.runPasses(renderer);
  }
}

const opaqueState = (): State => {
  const state = new State();
  state.blend = false;
  state.depthTest = true;
  state.depthMask = true;
  state.culling = false;
  return state;
};

const xrayState = (): State => {
  const state = opaqueState();
  // The x-ray reveals what is hidden without hiding anything itself.
  state.depthMask = false;
  return state;
};

const additiveState = (): State => {
  const state = new State();
  state.blendMode = 'add';
  state.depthTest = false;
  state.depthMask = false;
  state.culling = false;
  return state;
};

const fullscreenState = (): State => {
  const state = new State();
  state.blend = false;
  state.depthTest = false;
  state.depthMask = false;
  state.culling = false;
  return state;
};

const colorTarget = (label: string, width = 1, height = 1): TextureSource => new TextureSource({
  width,
  height,
  format: 'rgba8unorm',
  alphaMode: 'no-premultiply-alpha',
  scaleMode: 'nearest',
  autoGarbageCollect: false,
  label,
});

const vec2 = (): Float32Array => new Float32Array(2);
const vec3 = (): Float32Array => new Float32Array(3);
const vec4 = (): Float32Array => new Float32Array(4);
/** The quarter turn the warm-up draws with: (c, s, ox, oy) of q = 1 on a one-tile map. */
const WARM_VIEW = new Float32Array([0, 1, 32, 0]);

const copyRgb = (target: Float32Array, rgb: readonly [number, number, number]): void => {
  target[0] = rgb[0];
  target[1] = rgb[1];
  target[2] = rgb[2];
};

class PixiVoxelGpu implements VoxelGpu {
  readonly layer: VoxelLayer;
  readonly overlayTexture: RenderTexture;
  /** Voxel leftovers: the low-res size the overlay target takes while it is shown, and whether it is. */
  private overlayWidth = 1;
  private overlayHeight = 1;
  private overlayVisible = false;
  readonly surfaces: VoxelGpuSurfaces;
  readonly stats: VoxelGpuStats = createVoxelGpuStats();

  private readonly renderer: WebGLRenderer;
  private readonly gpuMin: boolean;
  private readonly ghostXray: boolean;
  /** The light pass and the shadow decals run (both off after their program failed; lights also off with the lite composite). */
  private readonly lightPassOn: boolean;
  private readonly shadowsOn: boolean;
  /** The see-through cut program is available (off after its program failed). */
  private readonly seeThroughAllowed: boolean;
  /** The translucent front layer exists in this pipeline (see VoxelGpuOptions.translucentSeeThrough). */
  private readonly translucent: boolean;
  /** The draws of a warm-up in progress (warmUp); null in every real frame. */
  private warm: ReadonlySet<WarmDraw> | null = null;
  private readonly onContextRestored: (() => void) | null;
  private readonly onTranslucentFailed: ((error: unknown) => void) | null;
  /** The front layer threw once: the dither rung from then on. */
  private frontFailed = false;
  private readonly programSet: VoxelPrograms;
  private readonly timer: GpuPassTimer | null;

  // Geometry: one shared index buffer for every box and light draw, one for fullscreen triangles.
  private readonly indexBuffer: PixiBuffer;
  private indexCapacity: number;
  private readonly boxGeometry: Geometry;
  private readonly fullscreenGeometry: Geometry;

  // Data textures (CPU copies inside).
  private readonly palette: BufferImageSource;
  private readonly paletteData = new Uint8Array(PALETTE_TEX_WIDTH * PALETTE_TEX_ROWS * RGBA8_BYTES_PER_TEXEL);
  private readonly transforms: VoxelDataSource;
  private readonly figures: VoxelDataSource;
  private readonly templates: VoxelDataSource;
  private readonly litter: VoxelDataSource;
  private readonly lights: VoxelDataSource;
  private readonly ghostBoxes: VoxelDataSource;
  private readonly draftBoxes: VoxelDataSource;
  private readonly chunks: (ChunkSlot | null)[] = [];
  private chunkOrder = new Int32Array(16);

  // Targets.
  private readonly gbuffer: RenderTarget;
  private readonly albedo: TextureSource;
  private readonly gdata: TextureSource;
  private readonly depth: TextureSource;
  private readonly lightTarget: TextureSource;
  private readonly composite: TextureSource;
  /** The front layer's own G-buffer and lit result, created once at a fixed capacity; null without the translucent see-through. */
  private readonly frontTargets: VoxelGpuSurfaces['front'];

  // Uniforms. frameUniforms is shared by every program that reads the camera.
  private readonly frameUniforms = new UniformGroup({
    uCameraTexel: { value: vec2(), type: 'vec2<f32>' },
    uLowSize: { value: vec2(), type: 'vec2<f32>' },
    /** The G-buffer pass's power-of-two viewport, which the geometry programs map through (clipSizeFor). */
    uClipSize: { value: vec2(), type: 'vec2<f32>' },
    uDepthRange: { value: vec2(), type: 'vec2<f32>' },
    uTime: { value: 0, type: 'f32' },
    uGrid: { value: 0, type: 'f32' },
    /** Phase 26: (c, s, ox, oy) of the view transform, written when its revision moves (view 0 = (1, 0, 0, 0)). */
    uView: { value: new Float32Array([1, 0, 0, 0]), type: 'vec4<f32>' },
  });
  /** Phase 41: the cinematic camera (read only while a view is set). */
  private readonly perspectiveUniforms = new UniformGroup({
    uViewProj: { value: new Float32Array(16), type: 'mat4x4<f32>' },
    uEye: { value: vec3(), type: 'vec3<f32>' },
  });
  private readonly skyUniforms = new UniformGroup({
    uSkyZenith: { value: vec3(), type: 'vec3<f32>' },
    uSkyHorizon: { value: vec3(), type: 'vec3<f32>' },
    uHorizonY: { value: 0.4, type: 'f32' },
    uNearFar: { value: vec2(), type: 'vec2<f32>' },
    uFog: { value: vec2(), type: 'vec2<f32>' },
  });
  private perspectiveView: CinematicView | null = null;
  private perspectiveProgram: GlProgram | null = null;
  private perspectiveComposite: Shader | null = null;
  private perspectiveFigures: Shader | null = null;
  private perspectiveFailed = false;
  private skirtSource: VoxelDataSource | null = null;
  private skirtShader: Shader | null = null;
  private skirtMap = '';
  private cameraMapWidth = 32;
  private cameraMapHeight = 32;
  private readonly ghostUniforms = new UniformGroup({
    uGhostOrigin: { value: vec3(), type: 'vec3<f32>' },
    uGhostDepthBias: { value: GHOST_DEPTH_BIAS, type: 'f32' },
    uCoverage: { value: 1, type: 'f32' },
    uGhostTint: { value: vec3(), type: 'vec3<f32>' },
    uGhostMix: { value: GHOST_TINT_MIX, type: 'f32' },
  });
  /** The coaster draft's own uniforms: it is drawn in world voxels (origin 0) and never tinted. */
  private readonly draftUniforms = new UniformGroup({
    uGhostOrigin: { value: vec3(), type: 'vec3<f32>' },
    uGhostDepthBias: { value: GHOST_DEPTH_BIAS, type: 'f32' },
    uCoverage: { value: 1, type: 'f32' },
    uGhostTint: { value: vec3(), type: 'vec3<f32>' },
    uGhostMix: { value: 0, type: 'f32' },
  });
  private readonly rangeUniforms = new UniformGroup({
    uEntityBase: { value: 0, type: 'i32' },
    uModelFirstBox: { value: 0, type: 'i32' },
    uModelBoxCount: { value: 1, type: 'i32' },
  });
  private readonly shadowUniforms = new UniformGroup({
    uEntityBase: { value: 0, type: 'i32' },
    uModelFirstBox: { value: 0, type: 'i32' },
    uModelBoxCount: { value: 1, type: 'i32' },
  });
  private readonly lightUniforms = new UniformGroup({
    uPresetBit: { value: 1, type: 'f32' },
  });
  private readonly compositeUniforms = new UniformGroup({
    uTaps: { value: 1, type: 'f32' },
    uLightEnabled: { value: 0, type: 'f32' },
    uOverlayEnabled: { value: 0, type: 'f32' },
    uAmbient: { value: vec3(), type: 'vec3<f32>' },
    uKey: { value: vec3(), type: 'vec3<f32>' },
    uExposure: { value: 1, type: 'f32' },
    uSaturation: { value: 1, type: 'f32' },
    uTint: { value: vec3(), type: 'vec3<f32>' },
    uBackground: { value: vec4(), type: 'vec4<f32>' },
    uEmissiveScale: { value: 0, type: 'f32' },
    uGlassGlow: { value: 0, type: 'f32' },
    uLightStrength: { value: 0, type: 'f32' },
    uOutlineTint: { value: vec3(), type: 'vec3<f32>' },
    uOutlineInkMix: { value: 0, type: 'f32' },
    uContourFactor: { value: 1, type: 'f32' },
    uShadowStrength: { value: 0, type: 'f32' },
    uShadowTint: { value: vec3(), type: 'vec3<f32>' },
    // Weather (compositeWeather.ts): written only when the effects' revision moves.
    uWxA: { value: vec4(), type: 'vec4<f32>' },
    uWxB: { value: vec4(), type: 'vec4<f32>' },
    uWxC: { value: vec4(), type: 'vec4<f32>' },
    uWxD: { value: vec4(), type: 'vec4<f32>' },
    uWxCloudTint: { value: vec3(), type: 'vec3<f32>' },
    uWxRainTint: { value: vec3(), type: 'vec3<f32>' },
  });
  private readonly weatherSync = new WeatherUniformSync();
  /** The see-through hole (`uSeeA`: rectangle centre and half size, `uSeeB`: cut key, floor z, margin, strength). */
  private readonly seeThroughUniforms = new UniformGroup({
    uSeeA: { value: vec4(), type: 'vec4<f32>' },
    uSeeB: { value: vec4(), type: 'vec4<f32>' },
    /** The front layer's rectangle in target texels (x, y, width, height); width 0 = the dither rung this frame. */
    uSeeC: { value: vec4(), type: 'vec4<f32>' },
  });
  /**
   * What the front layer's programs read instead of frameUniforms: the same values with the camera moved
   * by the rectangle's origin and the target size set to the layer's capacity, so the geometry and look
   * code need no change at all (front texel f is world texel f + camera').
   */
  private readonly frontFrameUniforms = new UniformGroup({
    uCameraTexel: { value: vec2(), type: 'vec2<f32>' },
    uLowSize: { value: vec2(), type: 'vec2<f32>' },
    uClipSize: { value: vec2(), type: 'vec2<f32>' },
    uDepthRange: { value: vec2(), type: 'vec2<f32>' },
    uTime: { value: 0, type: 'f32' },
    uGrid: { value: 0, type: 'f32' },
    uView: { value: new Float32Array([1, 0, 0, 0]), type: 'vec4<f32>' },
  });
  /** The latest see-through input (revision, hole, strength) and the front rectangle planned for this frame. */
  private seeInput: Readonly<SeeThroughFrame> | null = null;
  private readonly frontRect = createFrontRect();
  private cutOrder = new Int32Array(16);
  private cutCount = 0;
  private readonly seeThroughSync = new SeeThroughUniformSync();
  /** The strength the uniforms hold: the cut program is bound only above 0. */
  private seeThroughStrength = 0;
  private readonly cutView: TexelView = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private seeViewRevision = Number.NaN;
  private litterCutShader: Shader | null = null;
  private litterFrontShader: Shader | null = null;
  private readonly warmSaved = new Float32Array(12);
  private readonly upscaleUniforms = new UniformGroup({
    /** N (device px per texel), target height in device px, offset x, offset y (≤ 0). */
    uUpscale: { value: vec4(), type: 'vec4<f32>' },
    uFlipY: { value: 1, type: 'f32' },
  });

  // Shaders beyond the per-chunk ones.
  private readonly litterShader: Shader;
  private readonly ghostShader: Shader;
  private readonly draftShader: Shader;
  private readonly figureShader: Shader;
  private readonly shadowShader: Shader;
  private readonly lightShader: Shader;
  /** The same light program over the front G-buffer (front camera), into the front light target. */
  private readonly frontLightShader: Shader | null;
  private readonly compositeShader: Shader;
  private readonly compositeFrontShader: Shader | null;
  private readonly upscaleShader: Shader;

  private readonly opaque = opaqueState();
  private readonly xray = xrayState();
  private readonly additive = additiveState();
  private readonly fullscreen = fullscreenState();

  // Scene state from the sink.
  private figureCount = 0;
  private litterCount = 0;
  private lightCount = 0;
  private readonly rangeModel = new Int32Array(FIGURE_MODEL_COUNT);
  private readonly rangeFirst = new Int32Array(FIGURE_MODEL_COUNT);
  private readonly rangeCount = new Int32Array(FIGURE_MODEL_COUNT);
  private rangeTotal = 0;
  private readonly templateFirst = new Int32Array(FIGURE_MODEL_COUNT);
  private readonly templateCount = new Int32Array(FIGURE_MODEL_COUNT);
  private shadowFirst = 0;
  private shadowCount = 0;
  private ghostCount = 0;
  private ghostSource: Float32Array | null = null;
  private ghostCoverage = 1;
  /** The ghost's tint mix (GhostState.tintMix): GHOST_TINT_MIX, or less for a valid ghost in a chosen colour. */
  private ghostMix = GHOST_TINT_MIX;
  private draftCount = 0;
  private draftSource: Float32Array | null = null;

  // Frame state.
  private look: Readonly<DayLook> = blendLightPreset(createDayLook(), { day: 1, dusk: 0, night: 0 });
  private appliedLook: Readonly<DayLook> | null = null;
  private appliedLookRevision = -1;
  private readonly viewSync = new ViewUniformSync();
  private viewWritesPending = 0;
  readonly supportsViewTurn: boolean;
  private zoom = 1;
  private offsetX = 0;
  private offsetY = 0;
  private readonly maxViewport: number;
  private readonly view: TexelView = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private destroyed = false;

  // Reused per-frame objects.
  private readonly drawCall: Parameters<WebGLRenderer['encoder']['draw']>[0];
  private readonly rootBinding = {} as BindOptions;
  private readonly gbufferBinding: BindOptions;
  private readonly lightBinding: BindOptions;
  private readonly compositeBinding: BindOptions;
  private readonly frontGbufferBinding: BindOptions;
  private readonly frontLightBinding: BindOptions;
  private readonly frontLitBinding: BindOptions;
  private readonly contextListener = { contextChange: (): void => this.handleContextChange() };

  constructor(renderer: WebGLRenderer, options: VoxelGpuOptions) {
    if (!rendererHasVoxelUploader(renderer.texture)) {
      throw new Error('The voxel data uploader must be registered before app.init (boot.ts beforeInit → registerVoxelUploader)');
    }
    this.renderer = renderer;
    const viewportLimits = renderer.gl.getParameter(renderer.gl.MAX_VIEWPORT_DIMS) as Int32Array;
    this.maxViewport = Math.min(viewportLimits[0], viewportLimits[1]);
    this.gpuMin = options.gpuMin ?? false;
    this.ghostXray = options.ghostXray ?? true;
    this.lightPassOn = lightPassActive(options.compositeVariant ?? 'full', options.skipLights ?? false);
    this.shadowsOn = !(options.skipShadows ?? false);
    this.seeThroughAllowed = !(options.skipSeeThrough ?? false);
    this.translucent = this.seeThroughAllowed && (options.translucentSeeThrough ?? false) && (options.compositeVariant ?? 'full') === 'full';
    this.supportsViewTurn = options.viewTurn ?? true;
    this.onContextRestored = options.onContextRestored ?? null;
    this.onTranslucentFailed = options.onTranslucentFailed ?? null;
    this.programSet = createVoxelPrograms(options.compositeVariant ?? 'full', options.weatherTier, this.translucent, this.supportsViewTurn);

    this.timer = options.timing ? GpuPassTimer.create(renderer.gl as WebGL2RenderingContext) : null;

    this.indexCapacity = indexCapacityFor(0, 0);
    this.indexBuffer = new PixiBuffer({
      data: buildBoxIndices(this.indexCapacity),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
      label: 'voxel-box-indices',
    });
    this.indexBuffer.autoGarbageCollect = false;
    this.boxGeometry = new Geometry({ indexBuffer: this.indexBuffer });
    this.boxGeometry.autoGarbageCollect = false;
    const fullscreenIndices = new PixiBuffer({
      data: new Uint32Array([0, 1, 2]),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
      label: 'voxel-fullscreen-indices',
    });
    fullscreenIndices.autoGarbageCollect = false;
    this.fullscreenGeometry = new Geometry({ indexBuffer: fullscreenIndices });
    this.fullscreenGeometry.autoGarbageCollect = false;

    this.palette = new BufferImageSource({
      resource: this.paletteData,
      width: PALETTE_TEX_WIDTH,
      height: PALETTE_TEX_ROWS,
      format: 'rgba8unorm',
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'nearest',
      autoGarbageCollect: false,
      label: 'voxel-palette',
    });
    this.transforms = new VoxelDataSource({ width: TRANSFORM_TEX_WIDTH, label: 'voxel-transforms' });
    this.figures = new VoxelDataSource({ width: FIGURE_TEX_WIDTH, label: 'voxel-figures' });
    this.templates = new VoxelDataSource({ width: FIGURE_TEMPLATE_TEX_WIDTH, label: 'voxel-figure-templates' });
    this.litter = new VoxelDataSource({ width: DYNAMIC_BOX_TEX_WIDTH, label: 'voxel-litter' });
    this.lights = new VoxelDataSource({ width: LIGHT_TEX_WIDTH, label: 'voxel-lights' });
    this.ghostBoxes = new VoxelDataSource({ width: DYNAMIC_BOX_TEX_WIDTH, label: 'voxel-ghost' });
    this.draftBoxes = new VoxelDataSource({ width: DYNAMIC_BOX_TEX_WIDTH, label: 'voxel-draft' });

    this.albedo = colorTarget('voxel-albedo');
    this.gdata = colorTarget('voxel-gdata');
    this.depth = new TextureSource({
      width: 1,
      height: 1,
      format: 'depth24plus',
      // A depth texture samples as 0 with linear filtering (incomplete); nearest is required.
      scaleMode: 'nearest',
      autoGarbageCollect: false,
      label: 'voxel-depth',
    });
    this.gbuffer = new RenderTarget({ colorTextures: [this.albedo, this.gdata], depthStencilTexture: this.depth, label: 'voxel-gbuffer' });
    this.lightTarget = colorTarget('voxel-light');
    this.composite = colorTarget('voxel-composite');
    this.frontTargets = this.translucent ? this.createFrontTargets() : null;
    this.overlayTexture = RenderTexture.create({ width: 1, height: 1, format: 'rgba8unorm', scaleMode: 'nearest', label: 'voxel-overlay' });
    this.surfaces = {
      gbuffer: this.gbuffer,
      albedo: this.albedo,
      gdata: this.gdata,
      depth: this.depth,
      light: this.lightTarget,
      composite: this.composite,
      overlay: this.overlayTexture,
      front: this.frontTargets,
    };

    const programs = this.programSet;
    this.litterShader = this.worldShader(this.litter);
    this.ghostShader = new Shader({
      glProgram: programs.worldDither,
      resources: {
        uBoxes: this.ghostBoxes,
        uTransforms: this.transforms,
        uPalette: this.palette,
        frameUniforms: this.frameUniforms,
        ghostUniforms: this.ghostUniforms,
      },
    });
    this.draftShader = new Shader({
      glProgram: programs.worldDither,
      resources: {
        uBoxes: this.draftBoxes,
        uTransforms: this.transforms,
        uPalette: this.palette,
        frameUniforms: this.frameUniforms,
        ghostUniforms: this.draftUniforms,
      },
    });
    this.figureShader = new Shader({
      glProgram: programs.figureOpaque,
      resources: {
        uEntities: this.figures,
        uTemplates: this.templates,
        uPalette: this.palette,
        frameUniforms: this.frameUniforms,
        rangeUniforms: this.rangeUniforms,
      },
    });
    this.shadowShader = new Shader({
      glProgram: programs.figureDither,
      resources: {
        uEntities: this.figures,
        uTemplates: this.templates,
        uPalette: this.palette,
        frameUniforms: this.frameUniforms,
        rangeUniforms: this.shadowUniforms,
      },
    });
    this.lightShader = new Shader({
      glProgram: programs.lightPass,
      resources: {
        uLights: this.lights,
        uDepth: this.depth,
        uGData: this.gdata,
        frameUniforms: this.frameUniforms,
        lightUniforms: this.lightUniforms,
      },
    });
    this.compositeShader = new Shader({
      glProgram: programs.composite,
      resources: {
        uAlbedo: this.albedo,
        uGData: this.gdata,
        uDepth: this.depth,
        uLight: this.lightTarget,
        uOverlay: this.overlayTexture.source,
        // The lit front layer when there is one; any texture otherwise (the program never reads it).
        uFront: this.frontTargets?.lit ?? this.albedo,
        frameUniforms: this.frameUniforms,
        compositeUniforms: this.compositeUniforms,
        seeThroughUniforms: this.seeThroughUniforms,
      },
    });
    this.frontLightShader = this.frontTargets === null ? null : new Shader({
      glProgram: programs.lightPass,
      resources: {
        uLights: this.lights,
        uDepth: this.frontTargets.depth,
        uGData: this.frontTargets.gdata,
        frameUniforms: this.frontFrameUniforms,
        lightUniforms: this.lightUniforms,
      },
    });
    this.compositeFrontShader = this.frontTargets === null || programs.compositeFront === undefined ? null : new Shader({
      glProgram: programs.compositeFront,
      resources: {
        uAlbedo: this.frontTargets.albedo,
        uGData: this.frontTargets.gdata,
        uDepth: this.frontTargets.depth,
        uLight: this.frontTargets.light,
        uOverlay: this.overlayTexture.source,
        // The MAIN depth, which hides the layer where something nearer stands in front of it (never the lit
        // layer it renders into).
        uFront: this.depth,
        frameUniforms: this.frontFrameUniforms,
        compositeUniforms: this.compositeUniforms,
        seeThroughUniforms: this.seeThroughUniforms,
      },
    });
    this.upscaleShader = new Shader({
      glProgram: programs.upscale,
      resources: {
        uComposite: this.composite,
        upscaleUniforms: this.upscaleUniforms,
      },
    });

    this.compositeUniforms.uniforms.uTaps = this.gpuMin ? 0 : 1;
    this.drawCall = { geometry: this.boxGeometry, shader: this.litterShader, state: this.opaque, size: 0, start: 0 };
    this.gbufferBinding = { target: this.gbuffer, clear: CLEAR.ALL, clearColor: TRANSPARENT };
    this.lightBinding = { target: this.lightTarget, clear: CLEAR.COLOR, clearColor: TRANSPARENT };
    this.compositeBinding = { target: this.composite, clear: CLEAR.COLOR, clearColor: TRANSPARENT };
    this.frontGbufferBinding = { target: this.frontTargets?.gbuffer ?? this.gbuffer, clear: CLEAR.ALL, clearColor: TRANSPARENT };
    this.frontLightBinding = { target: this.frontTargets?.light ?? this.lightTarget, clear: CLEAR.COLOR, clearColor: TRANSPARENT };
    this.frontLitBinding = { target: this.frontTargets?.lit ?? this.composite, clear: CLEAR.COLOR, clearColor: TRANSPARENT };
    this.applyLook(this.look, lightPresetBit('day'));
    this.layer = new VoxelLayer((activeRenderer) => this.renderPasses(activeRenderer as WebGLRenderer));
    renderer.runners.contextChange.add(this.contextListener);
  }

  private createFrontTargets(): NonNullable<VoxelGpuSurfaces['front']> {
    const { width, height } = FRONT_CAPACITY;
    const albedo = colorTarget('voxel-front-albedo', width, height);
    const gdata = colorTarget('voxel-front-gdata', width, height);
    const depth = new TextureSource({
      width,
      height,
      format: 'depth24plus',
      scaleMode: 'nearest',
      autoGarbageCollect: false,
      label: 'voxel-front-depth',
    });
    const gbuffer = new RenderTarget({ colorTextures: [albedo, gdata], depthStencilTexture: depth, label: 'voxel-front-gbuffer' });
    return { gbuffer, albedo, gdata, depth, light: colorTarget('voxel-front-light', width, height), lit: colorTarget('voxel-front-lit', width, height) };
  }

  get timings(): GpuPassTimings | null {
    return this.timer;
  }

  // ---- VoxelGpuSink --------------------------------------------------------------------------

  setChunk(index: number, boxes: Float32Array, boxCount: number, bounds: TexelBounds | null): void {
    const chunk = this.chunkAt(index);
    const count = bounds === null ? 0 : Math.max(0, boxCount);
    if (count > 0) {
      chunk.source.writePrefix(boxes, count * BOX_FLOATS);
      this.ensureIndexCapacity(count);
    }
    chunk.count = count;
    chunk.setBounds(count > 0 ? bounds : null);
  }

  setDynamic(texture: DynamicTexture, data: Float32Array, count: number, rowStart: number, rowEnd: number): void {
    const source = this.dynamicSource(texture);
    if (rowEnd > rowStart) source.writeRows(data, rowStart, rowEnd);
    const live = Math.max(0, count);
    source.ensureRows(rowsForRecords(live, this.recordTexels(texture), source.pixelWidth));
    if (texture === 'figures') {
      this.figureCount = live;
      this.ensureFigureIndexCapacity();
    } else if (texture === 'litter') {
      this.litterCount = live;
      this.ensureIndexCapacity(live);
    } else if (texture === 'lights') {
      this.lightCount = live;
      this.ensureIndexCapacity(boxesForLights(live));
    }
  }

  setFigureRanges(ranges: readonly FigureRange[]): void {
    let total = 0;
    for (let index = 0; index < ranges.length && total < FIGURE_MODEL_COUNT; index += 1) {
      const range = ranges[index];
      this.rangeModel[total] = range.model;
      this.rangeFirst[total] = range.firstEntity;
      this.rangeCount[total] = range.entityCount;
      total += 1;
    }
    this.rangeTotal = total;
    this.ensureFigureIndexCapacity();
  }

  setGhost(ghost: GhostState | null): void {
    if (!ghost || ghost.boxCount <= 0) {
      this.ghostCount = 0;
      this.ghostSource = null;
      return;
    }
    if (ghost.boxes !== this.ghostSource || ghost.boxCount !== this.ghostCount) {
      this.ghostBoxes.writePrefix(ghost.boxes, ghost.boxCount * BOX_FLOATS);
      this.ghostSource = ghost.boxes;
      this.ensureIndexCapacity(ghost.boxCount);
    }
    this.ghostCount = ghost.boxCount;
    this.ghostCoverage = ghost.coverage;
    this.ghostMix = ghost.tintMix;
    const origin = this.ghostUniforms.uniforms.uGhostOrigin;
    origin[0] = ghost.originX;
    origin[1] = ghost.originY;
    origin[2] = ghost.originZ;
    rgbToUnit(ghost.tint, this.ghostUniforms.uniforms.uGhostTint);
  }

  setDraft(draft: GhostState | null): void {
    if (!draft || draft.boxCount <= 0) {
      this.draftCount = 0;
      this.draftSource = null;
      return;
    }
    if (draft.boxes !== this.draftSource || draft.boxCount !== this.draftCount) {
      this.draftBoxes.writePrefix(draft.boxes, draft.boxCount * BOX_FLOATS);
      this.draftSource = draft.boxes;
      this.ensureIndexCapacity(draft.boxCount);
    }
    this.draftCount = draft.boxCount;
    const uniforms = this.draftUniforms.uniforms;
    uniforms.uCoverage = draft.coverage;
    uniforms.uGhostMix = draft.tintMix;
    uniforms.uGhostOrigin[0] = draft.originX;
    uniforms.uGhostOrigin[1] = draft.originY;
    uniforms.uGhostOrigin[2] = draft.originZ;
    rgbToUnit(draft.tint, uniforms.uGhostTint);
  }

  // ---- Frame inputs ----------------------------------------------------------------------------

  resize(lowWidth: number, lowHeight: number): void {
    const width = this.gpuMin ? GPU_MIN_TARGET_SIZE : Math.max(1, Math.ceil(lowWidth));
    const height = this.gpuMin ? GPU_MIN_TARGET_SIZE : Math.max(1, Math.ceil(lowHeight));
    if (this.albedo.pixelWidth !== width || this.albedo.pixelHeight !== height) {
      this.gbuffer.resize(width, height);
      this.lightTarget.resize(width, height);
      this.composite.resize(width, height);
    }
    // Voxel leftovers: the overlay target is full size only while something is drawn in it (1 x 1 otherwise).
    this.overlayWidth = width;
    this.overlayHeight = height;
    if (this.overlayVisible) this.fitOverlay();
    const uniforms = this.frameUniforms.uniforms;
    uniforms.uLowSize[0] = width;
    uniforms.uLowSize[1] = height;
    uniforms.uClipSize[0] = clipSizeFor(width, this.maxViewport);
    uniforms.uClipSize[1] = clipSizeFor(height, this.maxViewport);
  }

  setFrame(frame: VoxelFrameInput): void {
    const camera = frame.camera;
    this.resize(camera.lowWidth, camera.lowHeight);
    const uniforms = this.frameUniforms.uniforms;
    uniforms.uCameraTexel[0] = camera.cameraTexelX;
    uniforms.uCameraTexel[1] = camera.cameraTexelY;
    uniforms.uDepthRange[0] = frame.depthRange.min;
    uniforms.uDepthRange[1] = frame.depthRange.max;
    uniforms.uTime = wrapShaderSeconds(frame.elapsedMs);
    uniforms.uGrid = frame.grid ? 1 : 0;
    this.zoom = Math.max(1, camera.zoom);
    this.offsetX = camera.offsetX;
    this.offsetY = camera.offsetY;
    // The camera's own view, not the target: under gpuMin the target shrinks to 64×64 while the draw
    // sequence must stay what the real frame would draw.
    viewOfTarget(camera.cameraTexelX, camera.cameraTexelY, camera.lowWidth, camera.lowHeight, this.view);
    if (frame.lookRevision !== this.appliedLookRevision || frame.look !== this.appliedLook) {
      this.applyLook(frame.look, frame.lightBits);
      this.appliedLookRevision = frame.lookRevision;
    }
    // Phase 26: uView only when the transform's revision moved (the front layer's copy follows in syncFrontFrame).
    if (this.supportsViewTurn && this.viewSync.sync(this.frameUniforms.uniforms.uView, frame.view)) this.viewWritesPending += 1;
    if (frame.weather !== undefined) this.weatherSync.sync(this.compositeUniforms.uniforms as unknown as WeatherUniformTarget, frame.weather, frame.weatherRevision ?? 0);
    if (frame.seeThrough !== undefined && this.seeThroughAllowed) this.applySeeThrough(frame.seeThrough);
  }

  /**
   * Takes a new see-through hole when its revision moved (a still frame costs one compare): the
   * uniforms, the strength that decides whether the cut program is bound at all, and the rectangle
   * chunk bounds are tested against.
   */
  private applySeeThrough(input: Readonly<SeeThroughFrame>): void {
    this.seeInput = input;
    if (input.revision === this.seeViewRevision) return;
    this.seeViewRevision = input.revision;
    this.seeThroughStrength = input.strength;
    seeThroughView(input, this.cutView);
  }

  /**
   * Decides the rung and the front rectangle of this frame once the cut chunks are known, and writes the
   * see-through uniforms when the revision or the rectangle moved (a still frame writes nothing).
   * Returns whether the front layer is drawn: the translucent pipeline, a hole that touches a chunk, a
   * rectangle that is on screen and fits the layer. Otherwise uSeeC.z is 0 and the cut is the dither rung.
   */
  private planSeeThrough(): boolean {
    const input = this.seeInput;
    if (input === null || !this.seeThroughAllowed) return false;
    let active = false;
    if (this.translucent && !this.frontFailed && this.seeThroughStrength > 0 && this.cutCount > 0) {
      const frame = this.frameUniforms.uniforms;
      active = frontRectFor(input, frame.uCameraTexel[0], frame.uCameraTexel[1], frame.uLowSize[0], frame.uLowSize[1], FRONT_CAPACITY, this.frontRect)
        && this.frontRect.width > 0;
    }
    if (this.seeThroughSync.sync(this.seeThroughUniforms.uniforms, input, active ? this.frontRect : null)) this.stats.seeThroughWrites += 1;
    return active;
  }

  setPalette(textureData: Uint8Array): void {
    if (textureData.length !== this.paletteData.length) {
      throw new Error(`The palette must be ${PALETTE_TEX_WIDTH}×${PALETTE_TEX_ROWS} RGBA8 (${this.paletteData.length} bytes), got ${textureData.length}`);
    }
    this.paletteData.set(textureData);
    this.palette.update();
  }

  setFigureTemplates(templates: FigureTemplates): void {
    this.templates.writePrefix(templates.data, templates.boxCount * FIGURE_TEMPLATE_TEXELS * FLOATS_PER_TEXEL);
    this.templateFirst.fill(0);
    this.templateCount.fill(0);
    for (const range of templates.models) {
      this.templateFirst[range.model] = range.firstBox;
      this.templateCount[range.model] = range.boxCount;
    }
    this.shadowFirst = templates.shadow.firstBox;
    this.shadowCount = templates.shadow.boxCount;
    this.ensureFigureIndexCapacity();
  }

  setOverlayVisible(visible: boolean): void {
    this.compositeUniforms.uniforms.uOverlayEnabled = visible ? 1 : 0;
    this.overlayVisible = visible;
    if (visible) this.fitOverlay();
    else if (this.overlayTexture.width !== 1 || this.overlayTexture.height !== 1) this.overlayTexture.resize(1, 1);
  }

  /** Sizes the overlay target to the low-res target (a no-op when it already is). */
  private fitOverlay(): void {
    if (this.overlayTexture.width !== this.overlayWidth || this.overlayTexture.height !== this.overlayHeight) {
      this.overlayTexture.resize(this.overlayWidth, this.overlayHeight);
    }
  }

  renderOverlay(container: Container): void {
    this.fitOverlay();
    // A fresh options object on purpose: Pixi writes the container's transform into it and would
    // skip updating that transform on a reused one (the overlay moves with every camera texel).
    this.renderer.render({ container, target: this.overlayTexture, clear: true, clearColor: TRANSPARENT });
  }

  resetScene(): void {
    for (const chunk of this.chunks) {
      if (!chunk) continue;
      chunk.count = 0;
      chunk.setBounds(null);
    }
    this.figureCount = 0;
    this.litterCount = 0;
    this.lightCount = 0;
    this.rangeTotal = 0;
    this.setGhost(null);
    this.setDraft(null);
  }

  warmUp(): void {
    this.warm = new Set(planWarmUp({ lights: this.lightPassOn, shadows: this.shadowsOn, seeThrough: this.seeThroughAllowed, translucent: this.translucent }));
    // Phase 26: the warm-up draws with a quarter turn in uView, so a draw-time failure of the view code shows up at
    // startup (where the no-view-rotation rung can still retry), not on the first Q press. Restored right after.
    const mainView = this.frameUniforms.uniforms.uView;
    const savedView = Float32Array.from(mainView);
    if (this.supportsViewTurn) {
      mainView.set(WARM_VIEW);
    }
    // A detached container of its own: rendering `layer` itself would turn it into a render group
    // of its own inside the stage.
    const pass = new RenderContainer({ render: (activeRenderer) => this.renderPasses(activeRenderer as WebGLRenderer) });
    try {
      this.renderer.render({ container: pass });
    } finally {
      this.warm = null;
      pass.destroy();
      if (this.supportsViewTurn) {
        mainView.set(savedView);
        this.frontFrameUniforms.uniforms.uView.set(savedView);
      }
    }
  }

  programs(): readonly GlProgram[] {
    return VOXEL_PROGRAM_NAMES
      .filter((name) => (name !== 'lightPass' || this.lightPassOn) && (name !== 'figureDither' || this.shadowsOn) && (name !== 'worldCut' || this.seeThroughAllowed)
        && ((name !== 'worldFront' && name !== 'compositeFront') || this.translucent))
      .map((name) => this.programSet[name] as GlProgram);
  }

  targets(): readonly RenderSurface[] {
    return this.frontTargets === null
      ? [this.gbuffer, this.lightTarget, this.composite, this.overlayTexture]
      : [this.gbuffer, this.lightTarget, this.composite, this.overlayTexture, this.frontTargets.gbuffer, this.frontTargets.light, this.frontTargets.lit];
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderer.runners.contextChange.remove(this.contextListener);
    this.layer.destroy();
    for (const chunk of this.chunks) {
      if (!chunk) continue;
      chunk.shader.destroy();
      chunk.cutShader?.destroy();
      chunk.frontShader?.destroy();
      chunk.source.destroy();
    }
    this.chunks.length = 0;
    this.litterCutShader?.destroy();
    this.litterFrontShader?.destroy();
    this.compositeFrontShader?.destroy();
    for (const shader of [this.litterShader, this.ghostShader, this.draftShader, this.figureShader, this.shadowShader, this.lightShader, this.compositeShader, this.upscaleShader]) {
      shader.destroy();
    }
    for (const source of [this.palette, this.transforms, this.figures, this.templates, this.litter, this.lights, this.ghostBoxes, this.draftBoxes]) {
      source.destroy();
    }
    this.boxGeometry.destroy(true);
    this.fullscreenGeometry.destroy(true);
    this.gbuffer.destroy();
    this.albedo.destroy();
    this.gdata.destroy();
    this.lightTarget.destroy();
    this.composite.destroy();
    if (this.frontTargets !== null) {
      this.frontTargets.gbuffer.destroy();
      this.frontTargets.albedo.destroy();
      this.frontTargets.gdata.destroy();
      this.frontTargets.depth.destroy();
      this.frontTargets.light.destroy();
      this.frontTargets.lit.destroy();
    }
    this.overlayTexture.destroy(true);
    this.timer?.destroy();
    for (const name of VOXEL_PROGRAM_NAMES) this.programSet[name]?.destroy();
  }

  // ---- Passes ----------------------------------------------------------------------------------

  private renderPasses(renderer: WebGLRenderer): void {
    if (this.destroyed) return;
    const stats = this.stats;
    resetVoxelGpuStats(stats);
    stats.viewWrites = this.viewWritesPending;
    this.viewWritesPending = 0;
    stats.lowTexels = this.albedo.pixelWidth * this.albedo.pixelHeight;
    this.flushUploads();
    const timer = this.timer;
    timer?.beginFrame();
    const renderTargets = renderer.renderTarget;
    renderTargets.getBindState(this.rootBinding);
    const gl = renderer.gl;

    timer?.begin(PASS_GBUFFER);
    renderTargets.bind(this.gbufferBinding);
    // Geometry maps through the power-of-two clip size (exact window coordinates); Pixi caches the
    // viewport it set, so it is restored before anything else binds.
    const frame = this.frameUniforms.uniforms;
    gl.viewport(0, 0, frame.uClipSize[0], frame.uClipSize[1]);
    // Phase 41: the cinematic camera draws the static chunks (the train included), the guests and staff and the ground
    // skirt; litter, shadows, the draft and the ghost are drawn in the isometric projection, so they are left out.
    const perspective = this.perspectiveView !== null && this.ensurePerspective();
    const frontActive = perspective ? this.drawChunksPerspective() : this.drawChunks();
    if (!perspective) {
      this.drawFigures();
      this.drawBoxes(this.litterShader, this.litterCount, this.opaque);
      this.drawShadows();
    }
    // The coaster draft: the real track, screen-doored, depth-tested so buildings hide its supports.
    if (this.draftCount > 0 && !perspective) {
      this.drawBoxes(this.draftShader, this.draftCount, this.opaque);
    }
    if (this.ghostCount > 0 && !perspective) {
      if (this.ghostXray) this.drawGhostPass(this.ghostCount, true);
      this.drawGhostPass(this.ghostCount, false);
    }
    const warm = this.warm;
    if (warm) this.drawWarmGeometry(warm);
    gl.viewport(0, 0, frame.uLowSize[0], frame.uLowSize[1]);
    timer?.end();

    // The translucent see-through's front layer: the occluders the cut removed from the G-buffer, drawn into
    // their own small G-buffer and lit by a second run of the composite (nothing here when the hole is closed).
    // A warm-up with no hole open opens a covering one for these draws and the composite after them.
    const warmHole = !frontActive && this.frontTargets !== null && warm !== null && (warm.has('front') || warm.has('frontComposite'));
    if (warmHole) this.beginWarmFront();
    try {
      // Decided once, ahead of the front layer: its own light pass and the composite's light switch follow it.
      const lightDraws = this.planLights(warm);
      if (frontActive || warmHole) this.drawFrontLayerContained(renderTargets, gl, warmHole, lightDraws);
      this.drawLightAndComposite(renderTargets, lightDraws);
    } finally {
      if (warmHole) this.endWarmFront();
    }
    // The overlay target is rendered into by Pixi between frames, with a batch shader that samples
    // all 16 units. Pixi unbinds a target's own texture first — but only where its bind cache says
    // it is, and renderer.resetState() (boot's validateGpu) empties that cache without unbinding.
    // Unbinding it here, while the cache is right, rules out that feedback loop (a dropped overlay
    // draw and GL_INVALID_OPERATION).
    renderer.texture.unbind(this.overlayTexture);

    // Back to the target the stage is rendered into (the screen), without clearing it again.
    const root = renderTargets.bind(this.rootBinding);
    const upscale = this.upscaleUniforms.uniforms;
    upscale.uUpscale[0] = this.zoom;
    // gl_FragCoord counts from the bottom of the drawing buffer; a render texture's row 0 is its top.
    upscale.uUpscale[1] = root.isRoot ? gl.drawingBufferHeight : root.pixelHeight;
    upscale.uUpscale[2] = this.offsetX;
    upscale.uUpscale[3] = this.offsetY;
    upscale.uFlipY = root.isRoot ? 1 : 0;
    timer?.begin(PASS_UPSCALE);
    this.drawFullscreen(this.upscaleShader);
    timer?.end();

    stats.uploadedBytes += this.collectUploadedBytes();
  }

  /** The light pass (dusk and night) and the composite into the low-res picture. */
  /**
   * How many lights this frame draws (0 = no light pass, composites with the pools off) and sets the composite's
   * light switch. A warm-up draws one light even with none in the scene, and composites with light on.
   */
  private planLights(warm: ReadonlySet<WarmDraw> | null): number {
    const lightsOn = this.lightPassOn && this.look.lightPass && this.lightCount > 0;
    const warmLight = !lightsOn && this.lightPassOn && warm !== null && warm.has('light');
    this.compositeUniforms.uniforms.uLightEnabled = lightsOn || warmLight ? 1 : 0;
    return lightsOn ? this.lightCount : warmLight ? 1 : 0;
  }

  private drawLightAndComposite(renderTargets: WebGLRenderer['renderTarget'], lightDraws: number): void {
    const timer = this.timer;
    // Phase 41: the cinematic frame has its own composite (no light pools: their pass reads isometric positions).
    if (this.perspectiveView !== null && this.perspectiveComposite !== null) {
      timer?.begin(PASS_COMPOSITE);
      renderTargets.bind(this.compositeBinding);
      this.drawFullscreen(this.perspectiveComposite);
      timer?.end();
      return;
    }
    if (lightDraws > 0) {
      timer?.begin(PASS_LIGHT);
      renderTargets.bind(this.lightBinding);
      this.drawLights(lightDraws, this.lightShader);
      timer?.end();
    }

    timer?.begin(PASS_COMPOSITE);
    renderTargets.bind(this.compositeBinding);
    this.drawFullscreen(this.compositeShader);
    timer?.end();
  }

  /**
   * The static chunks, nearest first; the ones the see-through hole touches go through the cut program.
   * Returns whether the front layer is to be drawn this frame (planSeeThrough): the cut chunks are listed
   * first because the rung (and uSeeC, which the cut program reads) depends on whether there are any.
   */
  private drawChunks(): boolean {
    const chunks = this.chunks;
    if (this.chunkOrder.length < chunks.length) {
      this.chunkOrder = new Int32Array(chunks.length * 2);
      this.cutOrder = new Int32Array(chunks.length * 2);
    }
    const visible = planChunkDraws(chunks, this.view, this.chunkOrder);
    let live = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk && chunk.count > 0 && chunk.bounds) live += 1;
    }
    this.stats.chunksCulled += live - visible;
    const cutOn = this.seeThroughAllowed && this.seeThroughStrength > 0;
    let cuts = 0;
    if (cutOn) {
      for (let index = 0; index < visible; index += 1) {
        const chunk = chunks[this.chunkOrder[index]] as ChunkSlot;
        chunk.cutNow = chunk.bounds !== null && chunkNeedsCut(chunk.bounds, this.cutView);
        if (chunk.cutNow) {
          this.cutOrder[cuts] = this.chunkOrder[index];
          cuts += 1;
        }
      }
    }
    this.cutCount = cuts;
    const frontActive = this.planSeeThrough();
    for (let index = 0; index < visible; index += 1) {
      const chunk = chunks[this.chunkOrder[index]] as ChunkSlot;
      if (cutOn && chunk.cutNow) {
        this.drawBoxes(chunk.cutShader ?? (chunk.cutShader = this.worldCutShader(chunk.source)), chunk.count, this.opaque);
        this.stats.chunksCut += 1;
      } else {
        this.drawBoxes(chunk.shader, chunk.count, this.opaque);
      }
      this.stats.chunksDrawn += 1;
    }
    return frontActive;
  }

  /** Phase 41: the map size in tiles (the ground skirt is laid around it). */
  setCameraMap(widthTiles: number, heightTiles: number): void {
    this.cameraMapWidth = widthTiles;
    this.cameraMapHeight = heightTiles;
  }

  setPerspective(view: Readonly<CinematicView> | null): void {
    if (view === null || this.perspectiveFailed) {
      this.perspectiveView = null;
      return;
    }
    const held = this.perspectiveView ?? (this.perspectiveView = { eye: [0, 0, 0], target: [0, 0, 0], fovY: 1 });
    for (let axis = 0; axis < 3; axis += 1) {
      held.eye[axis] = view.eye[axis];
      held.target[axis] = view.target[axis];
    }
    held.fovY = view.fovY;
  }

  get perspectiveOk(): boolean {
    return !this.perspectiveFailed;
  }

  /** Builds the cinematic programs and the ground skirt on first use; false (for good) if they cannot be built. */
  private ensurePerspective(): boolean {
    if (this.perspectiveFailed) return false;
    try {
      if (this.perspectiveProgram === null) {
        const world = perspectiveWorldShaderSource();
        this.perspectiveProgram = new GlProgram({ name: 'voxel-worldPerspective', vertex: world.vertex, fragment: world.fragment, preferredVertexPrecision: 'highp', preferredFragmentPrecision: 'highp' });
        const composite = perspectiveCompositeShaderSource();
        this.perspectiveComposite = new Shader({
          glProgram: new GlProgram({ name: 'voxel-compositePerspective', vertex: composite.vertex, fragment: composite.fragment, preferredVertexPrecision: 'highp', preferredFragmentPrecision: 'highp' }),
          resources: {
            uAlbedo: this.albedo,
            uGData: this.gdata,
            uDepth: this.depth,
            uLight: this.lightTarget,
            uOverlay: this.overlayTexture.source,
            uFront: this.albedo,
            frameUniforms: this.frameUniforms,
            compositeUniforms: this.compositeUniforms,
            seeThroughUniforms: this.seeThroughUniforms,
            skyUniforms: this.skyUniforms,
          },
        });
        const figures = perspectiveFigureShaderSource();
        this.perspectiveFigures = new Shader({
          glProgram: new GlProgram({ name: 'voxel-figurePerspective', vertex: figures.vertex, fragment: figures.fragment, preferredVertexPrecision: 'highp', preferredFragmentPrecision: 'highp' }),
          resources: {
            uEntities: this.figures,
            uTemplates: this.templates,
            uPalette: this.palette,
            frameUniforms: this.frameUniforms,
            rangeUniforms: this.rangeUniforms,
            perspectiveUniforms: this.perspectiveUniforms,
          },
        });
        this.skirtSource = new VoxelDataSource({ width: BOX_TEX_WIDTH, label: 'voxel-skirt' });
        this.skirtShader = this.perspectiveShaderFor(this.skirtSource);
      }
      return true;
    } catch (error) {
      console.error(error);
      this.perspectiveFailed = true;
      this.perspectiveView = null;
      return false;
    }
  }

  private perspectiveShaderFor(source: VoxelDataSource): Shader {
    return new Shader({
      glProgram: this.perspectiveProgram as GlProgram,
      resources: {
        uBoxes: source,
        uTransforms: this.transforms,
        uPalette: this.palette,
        frameUniforms: this.frameUniforms,
        perspectiveUniforms: this.perspectiveUniforms,
      },
    });
  }

  /** One grass box well past the map on every side, a voxel under its ground, so a low camera never sees the void. */
  private syncSkirt(): void {
    const key = `${this.cameraMapWidth}x${this.cameraMapHeight}`;
    if (key === this.skirtMap || this.skirtSource === null) return;
    this.skirtMap = key;
    const width = this.cameraMapWidth * VOXELS_PER_TILE_SPIKE;
    const height = this.cameraMapHeight * VOXELS_PER_TILE_SPIKE;
    const reach = 5 * Math.max(width, height);
    const box = new Float32Array(BOX_FLOATS);
    box[0] = -reach;
    box[1] = -reach;
    box[2] = -3;
    box[3] = packBoxWord(MAT.GRASS, 0, PATTERN.PLAIN, 0);
    box[4] = width + 2 * reach;
    box[5] = height + 2 * reach;
    box[6] = 2;
    box[7] = 0;
    this.skirtSource.writePrefix(box, BOX_FLOATS);
    this.ensureIndexCapacity(1);
  }

  /**
   * Phase 41: the ground skirt and every live chunk through the perspective program into the G-buffer, over the low
   * target's own viewport, and the sky and fog uniforms for the cinematic composite. Never opens the front layer.
   */
  private drawChunksPerspective(): boolean {
    const view = this.perspectiveView as CinematicView;
    const frame = this.frameUniforms.uniforms;
    const size = Math.max(this.cameraMapWidth, this.cameraMapHeight) * VOXELS_PER_TILE_SPIKE;
    const near = 2;
    const far = 12 * size;
    const uniforms = this.perspectiveUniforms.uniforms;
    viewProjection(view, frame.uLowSize[0] / Math.max(1, frame.uLowSize[1]), view.fovY, near, far, uniforms.uViewProj);
    uniforms.uEye[0] = view.eye[0];
    uniforms.uEye[1] = view.eye[1];
    uniforms.uEye[2] = view.eye[2];
    this.perspectiveUniforms.update();
    const sky = this.skyUniforms.uniforms;
    sky.uHorizonY = horizonRow(view, view.fovY);
    sky.uNearFar[0] = near;
    sky.uNearFar[1] = far;
    sky.uFog[0] = 1.4 * size;
    sky.uFog[1] = 3.2 * size;
    const night = this.look.backgroundAlpha;
    const background = this.look.backgroundRgb;
    for (let channel = 0; channel < 3; channel += 1) {
      sky.uSkyZenith[channel] = SKY_ZENITH_DAY[channel] * (1 - night) + background[channel] * 0.7 * night;
      sky.uSkyHorizon[channel] = SKY_HORIZON_DAY[channel] * (1 - night) + background[channel] * night;
    }
    this.skyUniforms.update();
    const gl = this.renderer.gl;
    gl.viewport(0, 0, frame.uLowSize[0], frame.uLowSize[1]);
    this.syncSkirt();
    if (this.skirtShader !== null) this.drawBoxes(this.skirtShader, 1, this.opaque);
    for (const chunk of this.chunks) {
      if (!chunk || chunk.count === 0) continue;
      const shader = chunk.perspectiveShader ?? (chunk.perspectiveShader = this.perspectiveShaderFor(chunk.source));
      this.drawBoxes(shader, chunk.count, this.opaque);
      this.stats.chunksDrawn += 1;
    }
    if (this.perspectiveFigures !== null) this.drawFigures(this.perspectiveFigures);
    return false;
  }

  /**
   * The front layer (design: gpu/seeThroughView.ts): the cut chunks again through the front program into the
   * front G-buffer, whose camera is moved to the rectangle's origin, then the composite's front run over the
   * rectangle alone (a scissor) into the lit layer the main composite mixes. `warm` draws one box instead of the
   * chunks and a 1 x 1 rectangle.
   */
  private drawFrontLayer(renderTargets: WebGLRenderer['renderTarget'], gl: WebGL2RenderingContext, warm: boolean, lightDraws: number): void {
    const front = this.frontTargets;
    const shader = this.compositeFrontShader;
    if (front === null || shader === null) return;
    const rect = this.frontRect;
    const frame = this.frameUniforms.uniforms;
    this.syncFrontFrame(rect.x, rect.y);
    renderTargets.bind(this.frontGbufferBinding);
    gl.viewport(0, 0, frame.uClipSize[0], frame.uClipSize[1]);
    if (warm) {
      this.drawBoxes(this.litterFrontShader ?? (this.litterFrontShader = this.worldFrontShader(this.litter)), 1, this.opaque);
    } else {
      for (let index = 0; index < this.cutCount; index += 1) {
        const chunk = this.chunks[this.cutOrder[index]] as ChunkSlot;
        this.drawBoxes(chunk.frontShader ?? (chunk.frontShader = this.worldFrontShader(chunk.source)), chunk.count, this.opaque);
        this.stats.frontDraws += 1;
      }
    }
    // Pixi caches the viewport of the target it binds next (same size as this one): put the real one back.
    gl.viewport(0, 0, FRONT_CAPACITY.width, FRONT_CAPACITY.height);
    gl.enable(gl.SCISSOR_TEST);
    try {
      gl.scissor(0, 0, rect.width, rect.height);
      // The layer's own light pools (dusk and night): the light pass over the front G-buffer, so the faded
      // building gets the pools its unfaded part keeps in the main buffer (no seam at the rim).
      if (lightDraws > 0 && this.frontLightShader !== null) {
        renderTargets.bind(this.frontLightBinding);
        this.drawLights(lightDraws, this.frontLightShader);
      }
      renderTargets.bind(this.frontLitBinding);
      this.drawFullscreen(shader);
    } finally {
      gl.disable(gl.SCISSOR_TEST);
    }
    this.stats.frontTexels = rect.width * rect.height;
  }

  /**
   * drawFrontLayer, with a JavaScript exception contained: the front layer is given up for good (the
   * dither rung from the next frame; this frame's composite stops reading it), the GL state it touched is
   * put back and the owner is told once. A warm-up exception is not contained (boot's validation reports it).
   */
  private drawFrontLayerContained(renderTargets: WebGLRenderer['renderTarget'], gl: WebGL2RenderingContext, warm: boolean, lightDraws: number): void {
    if (warm) {
      this.drawFrontLayer(renderTargets, gl, true, lightDraws);
      return;
    }
    try {
      this.drawFrontLayer(renderTargets, gl, false, lightDraws);
    } catch (error) {
      this.frontFailed = true;
      gl.disable(gl.SCISSOR_TEST);
      const frame = this.frameUniforms.uniforms;
      gl.viewport(0, 0, frame.uLowSize[0], frame.uLowSize[1]);
      this.seeThroughUniforms.uniforms.uSeeC.fill(0);
      this.seeThroughSync.invalidate();
      this.onTranslucentFailed?.(error);
    }
  }

  /** The front programs' frame uniforms: the main ones with the camera shifted by the rectangle's origin and the layer's size. */
  private syncFrontFrame(originX: number, originY: number): void {
    const main = this.frameUniforms.uniforms;
    const front = this.frontFrameUniforms.uniforms;
    front.uCameraTexel[0] = main.uCameraTexel[0] + originX;
    front.uCameraTexel[1] = main.uCameraTexel[1] + originY;
    front.uLowSize[0] = FRONT_CAPACITY.width;
    front.uLowSize[1] = FRONT_CAPACITY.height;
    front.uClipSize[0] = main.uClipSize[0];
    front.uClipSize[1] = main.uClipSize[1];
    front.uDepthRange[0] = main.uDepthRange[0];
    front.uDepthRange[1] = main.uDepthRange[1];
    front.uTime = main.uTime;
    front.uGrid = main.uGrid;
    front.uView.set(main.uView);
  }

  /**
   * A warm-up of the front layer needs a hole that covers a box and a 1 x 1 rectangle at the origin; the
   * hole's uniforms are put back by `endWarmFront` (a frame that never changes them must not inherit them).
   */
  private beginWarmFront(): void {
    const uniforms = this.seeThroughUniforms.uniforms;
    const saved = this.warmSaved;
    saved.set(uniforms.uSeeA, 0);
    saved.set(uniforms.uSeeB, 4);
    saved.set(uniforms.uSeeC, 8);
    uniforms.uSeeA.set([0, 0, 1e5, 1e5]);
    uniforms.uSeeB.set([-1e6, 0, 24, 1]);
    uniforms.uSeeC.set([0, 0, 1, 1]);
    this.frontRect.x = 0;
    this.frontRect.y = 0;
    this.frontRect.width = 1;
    this.frontRect.height = 1;
  }

  private endWarmFront(): void {
    const uniforms = this.seeThroughUniforms.uniforms;
    const saved = this.warmSaved;
    uniforms.uSeeA.set(saved.subarray(0, 4));
    uniforms.uSeeB.set(saved.subarray(4, 8));
    uniforms.uSeeC.set(saved.subarray(8, 12));
  }

  private drawFigures(shader: Shader = this.figureShader): void {
    const uniforms = this.rangeUniforms.uniforms;
    for (let index = 0; index < this.rangeTotal; index += 1) {
      const model = this.rangeModel[index];
      const boxesPerEntity = this.templateCount[model];
      const boxes = figureRangeBoxes(this.rangeFirst[index], this.rangeCount[index], this.figureCount, boxesPerEntity);
      if (boxes === 0) continue;
      uniforms.uEntityBase = this.rangeFirst[index];
      uniforms.uModelFirstBox = this.templateFirst[model];
      uniforms.uModelBoxCount = boxesPerEntity;
      this.drawBoxes(shader, boxes, this.opaque);
    }
  }

  /** One dithered draw of every entity's flat shadow decal (design §7). */
  private drawShadows(): void {
    if (!this.shadowsOn) return;
    const boxes = figureRangeBoxes(0, this.figureCount, this.figureCount, this.shadowCount);
    if (boxes === 0) return;
    const uniforms = this.shadowUniforms.uniforms;
    uniforms.uEntityBase = 0;
    uniforms.uModelFirstBox = this.shadowFirst;
    uniforms.uModelBoxCount = this.shadowCount;
    this.drawBoxes(this.shadowShader, boxes, this.opaque);
  }

  private drawLights(lights: number, shader: Shader): void {
    const size = lightDrawIndexCount(lights, this.gpuMin);
    if (size === 0) return;
    this.ensureIndexCapacity(boxesForLights(lights));
    this.issue(this.boxGeometry, shader, this.additive, size);
    this.stats.lights += this.gpuMin ? 1 : lights;
  }

  /**
   * One draw of the ghost: its x-ray pass (the parts existing geometry hides: sparser, flat tint,
   * depth test inverted, no depth write; the depth func goes back to LESS at once) or the dithered
   * ghost itself. Shared by the frame and the warm-up so the warm-up draws the real states.
   */
  private drawGhostPass(boxes: number, xray: boolean): void {
    const ghost = this.ghostUniforms.uniforms;
    if (xray) {
      const gl = this.renderer.gl;
      ghost.uCoverage = GHOST_XRAY_COVERAGE;
      ghost.uGhostMix = GHOST_XRAY_TINT_MIX;
      gl.depthFunc(gl.GREATER);
      this.drawBoxes(this.ghostShader, boxes, this.xray);
      gl.depthFunc(gl.LESS);
    } else {
      ghost.uCoverage = this.ghostCoverage;
      ghost.uGhostMix = this.ghostMix;
      this.drawBoxes(this.ghostShader, boxes, this.opaque);
    }
  }

  /**
   * The G-buffer draws of a warm-up: a single box through each geometry program, whatever the
   * scene holds (the world program is drawn through the litter's shader: same program, no chunk
   * needed). The uniforms they touch (figure ranges, ghost coverage) are rewritten by the real draws
   * before every use, so nothing leaks into the first real frame; counts and lists are not touched.
   */
  private drawWarmGeometry(warm: ReadonlySet<WarmDraw>): void {
    if (warm.has('world')) this.drawBoxes(this.litterShader, 1, this.opaque);
    if (warm.has('cut')) this.drawWarmCut();
    if (warm.has('figure')) {
      const uniforms = this.rangeUniforms.uniforms;
      uniforms.uEntityBase = 0;
      uniforms.uModelFirstBox = 0;
      uniforms.uModelBoxCount = 1;
      this.drawBoxes(this.figureShader, 1, this.opaque);
    }
    if (warm.has('shadow')) {
      const uniforms = this.shadowUniforms.uniforms;
      uniforms.uEntityBase = 0;
      uniforms.uModelFirstBox = 0;
      uniforms.uModelBoxCount = 1;
      this.drawBoxes(this.shadowShader, 1, this.opaque);
    }
    if (warm.has('draft')) this.drawBoxes(this.draftShader, 1, this.opaque);
    if (warm.has('ghostXray')) this.drawGhostPass(1, true);
    if (warm.has('ghost')) this.drawGhostPass(1, false);
  }

  /**
   * One box through the cut program with a hole that covers it at full strength, so the driver
   * compiles and runs the real program; the hole's uniforms are put back right after (a frame that
   * never changes them must not inherit the warm-up's).
   */
  private drawWarmCut(): void {
    const uniforms = this.seeThroughUniforms.uniforms;
    const saved = this.warmSaved;
    saved.set(uniforms.uSeeA, 0);
    saved.set(uniforms.uSeeB, 4);
    saved.set(uniforms.uSeeC, 8);
    uniforms.uSeeA.set([0, 0, 1e5, 1e5]);
    uniforms.uSeeB.set([-1e6, 0, 24, 1]);
    // The warm-up of the cut program exercises the translucent rung when there is one (a front layer to hold the fragments).
    uniforms.uSeeC.set([0, 0, this.translucent ? 1 : 0, 1]);
    try {
      this.drawBoxes(this.litterCutShader ?? (this.litterCutShader = this.worldCutShader(this.litter)), 1, this.opaque);
    } finally {
      uniforms.uSeeA.set(saved.subarray(0, 4));
      uniforms.uSeeB.set(saved.subarray(4, 8));
      uniforms.uSeeC.set(saved.subarray(8, 12));
    }
  }

  /**
   * The one way any box list is drawn. Zero boxes → no draw at all (size 0 would make Pixi draw the
   * whole index buffer, stale records included); otherwise start 0 and size = boxes · 18, which the
   * shared index buffer always covers (it grows first in the rare frame that needs it).
   */
  private drawBoxes(shader: Shader, boxes: number, state: State): void {
    const size = boxDrawIndexCount(boxes, this.gpuMin);
    if (size === 0) return;
    this.ensureIndexCapacity(size / INDICES_PER_BOX);
    this.issue(this.boxGeometry, shader, state, size);
    this.stats.boxes += size / INDICES_PER_BOX;
  }

  private drawFullscreen(shader: Shader): void {
    this.issue(this.fullscreenGeometry, shader, this.fullscreen, 3);
  }

  private issue(geometry: Geometry, shader: Shader, state: State, size: number): void {
    const call = this.drawCall;
    call.geometry = geometry;
    call.shader = shader;
    call.state = state;
    call.size = size;
    call.start = 0;
    this.renderer.encoder.draw(call);
    this.stats.draws += 1;
  }

  // ---- Resources -------------------------------------------------------------------------------

  private worldShader(boxes: VoxelDataSource): Shader {
    // Resource order is part of the program's generated sync function: keep it identical.
    return new Shader({
      glProgram: this.programSet.worldOpaque,
      resources: {
        uBoxes: boxes,
        uTransforms: this.transforms,
        uPalette: this.palette,
        frameUniforms: this.frameUniforms,
      },
    });
  }

  /** The cut variant of a box list's world shader: the same resources plus the see-through hole (programs.ts worldCut). */
  private worldCutShader(boxes: VoxelDataSource): Shader {
    return new Shader({
      glProgram: this.programSet.worldCut,
      resources: {
        uBoxes: boxes,
        uTransforms: this.transforms,
        uPalette: this.palette,
        frameUniforms: this.frameUniforms,
        seeThroughUniforms: this.seeThroughUniforms,
      },
    });
  }

  /** The front-layer variant of a box list's world shader: the cut's resources, with the front frame uniforms (programs.ts worldFront). */
  private worldFrontShader(boxes: VoxelDataSource): Shader {
    return new Shader({
      glProgram: this.programSet.worldFront as GlProgram,
      resources: {
        uBoxes: boxes,
        uTransforms: this.transforms,
        uPalette: this.palette,
        frameUniforms: this.frontFrameUniforms,
        seeThroughUniforms: this.seeThroughUniforms,
      },
    });
  }

  private chunkAt(index: number): ChunkSlot {
    if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid voxel chunk index ${index}`);
    while (this.chunks.length <= index) this.chunks.push(null);
    let chunk = this.chunks[index];
    if (!chunk) {
      const source = new VoxelDataSource({ width: BOX_TEX_WIDTH, label: `voxel-chunk-${index}` });
      chunk = new ChunkSlot(source, this.worldShader(source));
      this.chunks[index] = chunk;
    }
    return chunk;
  }

  private dynamicSource(texture: DynamicTexture): VoxelDataSource {
    switch (texture) {
      case 'figures': return this.figures;
      case 'transforms': return this.transforms;
      case 'litter': return this.litter;
      case 'lights': return this.lights;
    }
  }

  private recordTexels(texture: DynamicTexture): number {
    switch (texture) {
      case 'figures': return FIGURE_TEXELS;
      case 'transforms': return TRANSFORM_TEXELS;
      case 'litter': return BOX_TEXELS;
      case 'lights': return LIGHT_TEXELS;
    }
  }

  private ensureIndexCapacity(boxes: number): void {
    if (boxes <= this.indexCapacity) return;
    this.indexCapacity = indexCapacityFor(this.indexCapacity, boxes);
    // A new, longer array: Pixi re-specifies the GL buffer (bufferData) on its next bind.
    this.indexBuffer.data = buildBoxIndices(this.indexCapacity);
  }

  private ensureFigureIndexCapacity(): void {
    let largest = figureRangeBoxes(0, this.figureCount, this.figureCount, this.shadowCount);
    for (let index = 0; index < this.rangeTotal; index += 1) {
      const boxes = figureRangeBoxes(this.rangeFirst[index], this.rangeCount[index], this.figureCount, this.templateCount[this.rangeModel[index]]);
      if (boxes > largest) largest = boxes;
    }
    this.ensureIndexCapacity(largest);
  }

  /** One upload per data texture that changed since the last frame (its dirty rows only). */
  private flushUploads(): void {
    const chunks = this.chunks;
    for (let index = 0; index < chunks.length; index += 1) chunks[index]?.source.flush();
    this.transforms.flush();
    this.figures.flush();
    this.templates.flush();
    this.litter.flush();
    this.lights.flush();
    this.ghostBoxes.flush();
    this.draftBoxes.flush();
  }

  private collectUploadedBytes(): number {
    let bytes = 0;
    const chunks = this.chunks;
    for (let index = 0; index < chunks.length; index += 1) bytes += chunks[index]?.source.takeUploadedBytes() ?? 0;
    bytes += this.transforms.takeUploadedBytes();
    bytes += this.figures.takeUploadedBytes();
    bytes += this.templates.takeUploadedBytes();
    bytes += this.litter.takeUploadedBytes();
    bytes += this.lights.takeUploadedBytes();
    bytes += this.ghostBoxes.takeUploadedBytes();
    bytes += this.draftBoxes.takeUploadedBytes();
    return bytes;
  }

  /** Writes a blended look into the composite and light uniforms: numbers only, no shader work. */
  private applyLook(look: Readonly<DayLook>, lightBits: number): void {
    this.look = look;
    this.appliedLook = look;
    const uniforms = this.compositeUniforms.uniforms;
    copyRgb(uniforms.uAmbient, look.ambient);
    copyRgb(uniforms.uKey, look.key);
    uniforms.uExposure = look.exposure;
    uniforms.uSaturation = look.saturation;
    copyRgb(uniforms.uTint, look.tint);
    copyRgb(uniforms.uBackground, look.backgroundRgb);
    uniforms.uBackground[3] = look.backgroundAlpha;
    uniforms.uEmissiveScale = look.emissiveScale;
    uniforms.uGlassGlow = look.glassGlow;
    uniforms.uLightStrength = look.lightStrength;
    copyRgb(uniforms.uOutlineTint, look.outlineTint);
    uniforms.uOutlineInkMix = look.outlineInkMix;
    uniforms.uContourFactor = look.contourFactor;
    uniforms.uShadowStrength = look.shadowStrength;
    copyRgb(uniforms.uShadowTint, look.shadowTint);
    this.lightUniforms.uniforms.uPresetBit = lightBits;
  }

  private handleContextChange(): void {
    // Pixi has dropped every GL object; programs, buffers, targets and data textures come back on
    // their next bind (data textures in full from their CPU copies). Timer queries do not.
    this.timer?.reset(this.renderer.gl as WebGL2RenderingContext);
    this.onContextRestored?.();
  }
}

/** Voxels per tile (contracts/space VOXELS_PER_TILE), local to the cinematic camera so the import list stays as it was. */
const VOXELS_PER_TILE_SPIKE = 32;
/** Phase 41: the day sky (0..1 sRGB) the cinematic composite grades like the park; night mixes toward the backdrop. */
const SKY_ZENITH_DAY: readonly number[] = [0.42, 0.66, 0.93];
const SKY_HORIZON_DAY: readonly number[] = [0.8, 0.89, 0.97];

/**
 * Builds the voxel GPU pipeline on a WebGL2 renderer whose app was created with the voxel data
 * uploader registered (boot.ts `beforeInit: registerVoxelUploader`). Browser only.
 */
export const createVoxelGpu = (renderer: WebGLRenderer, options: VoxelGpuOptions = {}): VoxelGpu =>
  new PixiVoxelGpu(renderer, options);
