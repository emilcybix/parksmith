import { Container, UPDATE_PRIORITY, type Application, type WebGLRenderer } from 'pixi.js';
import { lowPassCamera, orbitCamera } from './cameraOrbit';
import { flatRideView, trainRideView } from './rideCamera';
import { VIEW_TURN_MS, groundAtCentre, turnAzimuth, turnView, viewAzimuth } from './viewTurnCamera';
import { ALLOW_SOFTWARE_GPU, CAMERA_3D, LIGHT_OVERRIDE, LIGHT_PRESET, VOXEL_DEBUG, VOXEL_GPU_MIN, VOXEL_TIMING, WEATHER_FLAGS, ZOOM_OVERRIDE } from '../../app/rendererFlag';
import type { CinematicView } from '../RendererPort';
import type { CoasterPiece } from '../../game/coaster/design';
import { BUILD_BY_ID } from '../../game/content/catalog';
import type { ObjectColours } from '../../game/content/colours';
import type { CrowdHeatmapView } from '../../game/crowd/types';
import { createWeatherView, type WeatherView } from '../../game/weather/types';
import type { ParkSession } from '../../game/session/ParkSession';
import type { BuildDefinition, Cell, PlacedObject, Rotation } from '../../game/types';
import { SEE_THROUGH, resolveSeeThroughFocus, SeeThroughFade, slewTo, type SeeThroughFocus, type SeeThroughMode, type SeeThroughRequest } from '../seeThrough';
import { UnsupportedRendererError, type CameraMotion, type HintMarker, type PaintHover, type RendererPerformance, type RendererPort, type ViewInfo, type ViewInsets, type WorldEffect, type WorldInputHandlers } from '../RendererPort';
import { bindWorldInput, pickCell, type WorldInput } from '../worldInput';
import { cellToView, createViewFrame, pointFromView, rectToView, viewMapSize, type CellRect, type MutableViewFrame, type ViewRotation, type XY } from '../viewRotation';
import { createModelCache } from './blueprint/compile';
import { createVoxelApp, maxRenderTargetSize, resetGlErrorTrace, revalidateGpu, runGpuSelfTest, stopGlErrorTrace, validateGpu } from './boot';
import { MAX_RESOLUTION, VoxelCamera, type SnappedCamera } from './camera';
import { NULL_GPU_SINK } from './contracts/frame';
import type { Palette } from './contracts/palette';
import { depthRangeFor, VOXELS_PER_TILE, type DepthRange } from './contracts/space';
import { createViewTransform, setViewTransform, type ViewTransform } from './contracts/view';
import { registerVoxelUploader } from './gpu/dataSource';
import { appendDegradedLabel, compositeCarriesViewCode, compositeRungsAfter, degradedLabelFor, degradePlanFor, parseSeeThroughLook, seeThroughRungsFor, type CompositeRung, type DegradePlan, type SeeThroughLook } from './gpu/glFailure';
import type { CompositeVariant } from './gpu/shaders/composite';
import type { WeatherTier } from './gpu/shaders/compositeWeather';
import { createSeeThroughFrame, createSeeThroughValues, seeThroughValuesFor, type SeeThroughFrame } from './gpu/seeThroughView';
import { createVoxelGpu, type VoxelFrameInput, type VoxelGpu, type VoxelGpuOptions } from './gpu/VoxelGpu';
import { PASS_COMPOSITE, PASS_GBUFFER, PASS_LIGHT, PASS_UPSCALE } from './gpu/timing';
import { createDayWeights, dayWeights, type DayWeights } from '../dayCycle';
import { createWeatherEffects, presentationFlags, WeatherLook, type WeatherEffects } from '../weatherLook';
import { getPresentation, onPresentationChange, reducedMotion } from '../../settings/motion';
import { getSettings } from '../../settings/settingsStore';
import { blendLightPreset, createDayLook, presetBitsFor, type DayLook } from './dayLook';
import type { LightPresetName } from './lightPresets';
import { VoxelBadges } from './overlay/badges';
import { VoxelHints } from './overlay/hints';
import { VoxelEffects } from './overlay/effects';
import { TILE_HEIGHT, TILE_WIDTH } from '../isometric';
import { VoxelOverlays } from './overlay/overlays';
import { gamePalette } from './gamePalette';
import { buildFigureTemplates } from './scene/figureModels';
import { VoxelScene, type GhostVolume } from './scene/VoxelScene';

/** R: the real device pixel ratio (unlike the classic renderer's cap of 2), up to MAX_RESOLUTION. */
/** Texels a path's top face stands above its ground diamond (PATH_TOP_Z in screen texels; see refinePick). */
export const PATH_PICK_LIFT = 3;

/** Cells of margin round the camera's view inside which figures are still packed (voxel leftovers: culling). */
const FIGURE_CULL_MARGIN = 3;

const currentResolution = (): number => Math.min(window.devicePixelRatio || 1, MAX_RESOLUTION);

/**
 * `&voxelComposite=lite`: start with the degraded composite instead of the full one (a way to see
 * and test the fallback on any GPU). Parsed here, when mounting, rather than in app/rendererFlag.ts
 * — it is a diagnostic of this renderer only and the fallback below must be testable without the
 * module-load-time flags.
 */
const requestedCompositeVariant = (): CompositeVariant => {
  try {
    const flag = new URLSearchParams(window.location.search).get('voxelComposite');
    if (flag === 'lite' || flag === 'full') return flag;
  } catch {
    // No window or no readable URL (Node tests): the setting, else the normal picture.
  }
  // The player's Graphics setting (read at mount, like the flag).
  try {
    return getSettings().graphicsDetail === 'lite' ? 'lite' : 'full';
  } catch {
    return 'full';
  }
};

/**
 * `&voxelWeather=off|rain`: start the weather pass at no effects (`off`) or at rain only (`rain`), a
 * diagnostic and test aid like `&voxelComposite=lite`, parsed at mount for the same reason.
 */
const requestedWeatherTier = (variant: CompositeVariant): WeatherTier => {
  let flag: string | null = null;
  try {
    flag = new URLSearchParams(window.location.search).get('voxelWeather');
  } catch {
    // No window or no readable URL (Node tests): the default tier.
  }
  if (flag === 'off') return 'none';
  if (flag === 'rain') return 'rain';
  return variant === 'lite' ? 'rain' : 'full';
};

/**
 * `&voxelSeeThrough=alpha|dither|off`: which see-through look to start with (default `alpha`: the buildings in
 * the way turn translucent; `dither` is the earlier 1-texel screen door; `off` has no cutaway). A diagnostic and
 * comparison aid like `&voxelWeather=off`, parsed at mount for the same reason; the fallback chain only ever
 * goes down from what was asked (alpha -> dither -> off).
 */
const requestedSeeThroughLook = (): SeeThroughLook => {
  try {
    return parseSeeThroughLook(new URLSearchParams(window.location.search).get('voxelSeeThrough'));
  } catch {
    // No window or no readable URL (Node tests): the default look.
    return 'alpha';
  }
};

/**
 * How long a lost WebGL context may stay lost before the renderer gives up (GameApp then mounts the
 * classic one). Browsers restore a context within a moment when they restore it at all; a context
 * the browser decided never to restore would otherwise leave a frozen canvas.
 */
export const CONTEXT_LOST_TIMEOUT_MS = 5_000;

/** What a startup retry switches off, on top of the composite variant. */
type PipelineDegrade = Pick<VoxelGpuOptions, 'skipLights' | 'skipShadows' | 'skipSeeThrough'>;

/** Smoothing of the fps estimate (the classic renderer's EMA weight). */
const FPS_SMOOTHING = 0.08;
/** The height (voxels) the cutaway opens for a paint target that has no placed model to measure (the entrance gate: posts 48 + the arch). */
const PAINT_TARGET_FALLBACK_HEIGHT = 64;

/** Everything the overlay preview is drawn from (rotation only turns the ghost, not the diamonds). */
const previewKeyOf = (
  cells: readonly Cell[], definition: BuildDefinition | null, valid: boolean, bulldoze: boolean, blocked: readonly Cell[] | null,
  rotation: Rotation,
): string => {
  let key = `${definition?.id ?? '-'}|${valid ? 1 : 0}|${bulldoze ? 1 : 0}|${rotation}`;
  for (const cell of cells) key += `|${cell.x},${cell.y}`;
  if (blocked) for (const cell of blocked) key += `!${cell.x},${cell.y}`;
  return key;
};

/** The frame inputs the GPU reads, reused every frame (VoxelFrameInput's fields are read-only to it). */
interface FrameInput extends VoxelFrameInput {
  camera: Readonly<SnappedCamera>;
  elapsedMs: number;
  grid: boolean;
  preset: LightPresetName;
  look: Readonly<DayLook>;
  lookRevision: number;
  lightBits: number;
  depthRange: Readonly<DepthRange>;
  weather: Readonly<WeatherEffects>;
  weatherRevision: number;
  seeThrough: Readonly<SeeThroughFrame>;
  view: Readonly<ViewTransform>;
}

/** The weights are re-blended only when one moved by more than this (a paused park never does). */
const LOOK_EPSILON = 1e-5;
/** The look before the app has said what time it is: noon, which is exactly the day preset. */
const DEFAULT_PHASE = 0.5;

const presetNameOf = (weights: DayWeights): LightPresetName => (
  weights.day >= weights.dusk && weights.day >= weights.night ? 'day' : weights.dusk >= weights.night ? 'dusk' : 'night'
);

/** Phase 41: the cinematic camera's vertical field of view (50°). */
const CINEMATIC_FOV = (50 * Math.PI) / 180;

/**
 * The voxel pixel-art renderer, the game's main renderer (design §3–§5, §10); `?renderer=classic`
 * or a failed start gives the classic one.
 *
 * Three parts, wired here:
 * - VoxelScene (scene/VoxelScene.ts) turns the park into typed arrays — static chunks, ride and
 *   coaster transforms, figures, litter, lights, the ghost — and is pure, so it runs (and is
 *   tested) without a GPU;
 * - VoxelGpu (gpu/VoxelGpu.ts) is the scene's sink and runs every pass inside one stage child: the
 *   G-buffer at one texel per voxel step, lighting and outlines in the composite, then the integer
 *   upscale to the screen;
 * - the overlays (overlay/overlays.ts) are Pixi Graphics in world texels, rendered into the GPU's
 *   low-res overlay target — a detached container placed at −uCameraTexel — and composited under
 *   the world-anchored dither. They are re-rendered only when their version, the camera texel or
 *   the target size changes (and after a lost context), and skipped when empty. Bin and ride badges
 *   (overlay/badges.ts) are synced from the park every frame without drawing; they bump the version
 *   only when one visibly changes.
 *
 * What is settled here and must survive:
 * - The constructor touches neither the DOM nor the GPU (tests construct renderers in Node); the
 *   scene exists from the start with a null sink and is attached to the GPU at mount.
 * - `mount` order: boot the Application (capability checks; the data uploader is registered before
 *   `app.init`) → GPU self-test → GPU pipeline, palette, figure templates, first scene build → one
 *   warm-up render and validation of every program and target → only then attach the canvas and
 *   bind input, so any failure leaves nothing behind and GameApp can fall back to the classic
 *   renderer. Everything fails as an UnsupportedRendererError.
 * - `update` is the only per-frame entry; the renderer registers no ticker callbacks of its own.
 *   Per frame (design §5): held camera keys → the snapped camera and look into the frame uniforms →
 *   the scene (world diff at most once, dirty chunks, prewarm, motion, figures, litter, ghost) →
 *   the overlay target if needed. Pixi then renders the stage at LOW priority.
 * - Every new canvas size, resolution or zoom level goes through `applyViewport` (the renderer's
 *   'resize' — Pixi's ResizePlugin renders right after emitting it — and DPR changes) or through
 *   the per-frame `setFrame`, so the frame drawn next always has consistent targets and uniforms.
 * - `destroy` is idempotent and safe before `mount` resolves; a pending mount then does nothing.
 *   The GPU pipeline goes before the Pixi application (the G-buffer's framebuffer is only freed by
 *   the renderer's own teardown).
 * - `setSession` keeps view state (camera, grid, scenery heatmap visibility, cursor, handlers, view input)
 *   and resets everything derived from the old world, in the scene, the GPU and the overlays. The crowd heatmap
 *   (Phase 14) is world data, not view state: it is forgotten and GameApp pushes the new park's view.
 */
export class VoxelRenderer implements RendererPort {
  readonly kind = 'voxel';
  /**
   * Phase 26: the static data stays in world voxels and the vertex stages turn it (design-step2.md), so a turn
   * rebuilds nothing. False when the pipeline was built without the view code (`no-view-rotation`).
   */
  get supportsViewRotation(): boolean {
    return this.viewTurnOk;
  }
  private session: ParkSession;
  private app: Application<WebGLRenderer> | null = null;
  private gpu: VoxelGpu | null = null;
  private host: HTMLElement | null = null;
  private maxTargetSize = 0;
  private readonly camera = new VoxelCamera({ zoomOverride: ZOOM_OVERRIDE });
  private readonly palette: Palette;
  private readonly scene: VoxelScene;
  /** World-texel overlays, never on the stage: rendered into the GPU's overlay target. */
  private readonly overlayRoot = new Container();
  private readonly overlays: VoxelOverlays;
  /** Bin bars and ride alerts, on top of the overlays in the same root. */
  private readonly badges: VoxelBadges;
  /** The First Day pointer ring, between the selection and the draft layers. */
  private readonly hints: VoxelHints;
  /** Phase 15: money popups and feedback cues, the topmost overlay layer. */
  private readonly effects: VoxelEffects;
  /** The orientation of the picture and the WORLD map size (tiles): what picking, the overlays and the camera turn through. */
  private readonly viewFrame: MutableViewFrame = createViewFrame(0, 0, 0);
  /** Phase 21: the land revision the camera plot was last read at, and its scratch rectangle. */
  private plotLandRevision = -1;
  /** Scratch corners of the figure cull rectangle (world cells). */
  private readonly cullA: XY = { x: 0, y: 0 };
  private readonly cullB: XY = { x: 0, y: 0 };
  private readonly plotRect: CellRect = { x: 0, y: 0, width: 0, depth: 0 };
  /**
   * The transform the camera origin is in: the view last applied in full (scene, overlays AND camera). A turn
   * retargets the camera from it, and the runtime rung restores view 0 from it, so a failure partway through a
   * turn (after the scene took the new view) never recentres the camera from a view that was never shown.
   */
  private readonly shownView: ViewTransform = createViewTransform();
  /** Scratch for the transform a turn goes to. */
  private readonly nextView: ViewTransform = createViewTransform();
  private readonly viewScratch: XY = { x: 0, y: 0 };
  private readonly rectScratch: CellRect = { x: 0, y: 0, width: 0, depth: 0 };
  /** Whether the pipeline carries the view code; set at build, cleared by the `no-view-rotation` rung. */
  private viewTurnOk = true;
  /** What the next build asks of the GPU (false only on the startup retry that gave the view code up). */
  private viewTurnRequested = true;
  private input: WorldInput | null = null;
  private handlers: WorldInputHandlers | null = null;
  private viewInputEnabled = true;
  private toolCursor: string | null = null;
  private showGrid = true;
  /** Set by `syncWorld` and `setSession`; the next frame diffs the world once, however often it notified. */
  private worldDirty = true;
  private readonly frame: FrameInput;
  /** What the overlay target holds; any difference re-renders it. */
  private overlayVersion = -1;
  private overlayCameraX = Number.NaN;
  private overlayCameraY = Number.NaN;
  private overlayWidth = 0;
  private overlayHeight = 0;
  private overlayShown = false;
  /** The preview the overlays last drew; GameApp repeats it on every pointermove inside a cell. */
  private previewKey: string | null = null;
  private stopWatchingResolution: (() => void) | null = null;
  private mounted = false;
  private destroyed = false;
  private fps = 60;
  private lastFrameAt = performance.now();
  private renderMs = 0;
  private fatalListener: ((error: Error) => void) | null = null;
  /** A restored context must be proven again before the next frame draws (see `revalidate`). */
  private revalidatePending = false;
  private contextLostTimer: ReturnType<typeof setTimeout> | null = null;
  private contextLostListener: (() => void) | null = null;
  private contextRestoredListener: (() => void) | null = null;
  /** Presentation only: the clock fraction the app last handed us, and the scratch the look is blended in. */
  private timeOfDay = DEFAULT_PHASE;
  private readonly look = createDayLook();
  private readonly weights = createDayWeights();
  private readonly appliedWeights = createDayWeights();
  /** The weights moved since the look was last blended (syncDayWeights sets it, updateLook consumes it). */
  private weightsMoved = false;
  /** Weather presentation: reads the typed view, never feeds back (rendering/weatherLook.ts). */
  private readonly weatherLook = new WeatherLook({ ...WEATHER_FLAGS, ...presentationFlags(getPresentation()) });
  /** Live presentation preferences (reduced motion, weather level, flashes), released by destroy. */
  private stopWatchingPresentation: (() => void) | null = onPresentationChange((prefs) => {
    this.weatherLook.setPresentation(prefs);
  });
  // See-through cutaway (rendering/seeThrough.ts, gpu/seeThroughView.ts): presentation only, all state preallocated.
  private readonly seeRequest: SeeThroughRequest = { armed: false, peek: false };
  private readonly seeFade = new SeeThroughFade(reducedMotion);
  private readonly seeFocus: SeeThroughFocus = { minX: 0, minY: 0, maxX: 0, maxY: 0, mode: 'cell', peek: false, heightVoxels: 0 };
  /** Where the hole wants to be, and where the slewed hole is (what the GPU holds once it settles). */
  private readonly seeTarget = createSeeThroughValues();
  private readonly seeCurrent = createSeeThroughValues();
  private seePositionValid = false;
  private readonly seeFrame = createSeeThroughFrame();
  private seeEnabled = true;
  private seeFailed = false;
  /** The last preview's footprint (pooled Cell objects) and kind, which is what the cutaway opens around. */
  private readonly previewCells: Cell[] = [];
  private readonly previewPool: Cell[] = [];
  private previewMode: SeeThroughMode = 'cell';
  /**
   * Phase 28: the Paint tool's hover target (pooled cells) and the height of what stands there. While it is set
   * the cutaway treats it like a bulldoze target: what is in front of it fades, the target stays intact.
   */
  private readonly paintCells: Cell[] = [];
  private readonly paintPool: Cell[] = [];
  private paintHeight = 0;
  /** A coaster layout is being designed (drawCoasterDraft armed with a layout or a type). */
  private coasterDesigner = false;
  private readonly weatherView = createWeatherView();
  /** What the composite compiled of the weather pass; `none` (or a runtime failure) feeds a clear sky. */
  private weatherTier: WeatherTier = 'full';
  private weatherFailed = false;
  private readonly clearWeather = createWeatherEffects();
  private appliedModifiers: Readonly<WeatherEffects> | null = null;
  private appliedModifiersRevision = -1;
  private machineryPaused = false;

  constructor(session: ParkSession) {
    this.session = session;
    this.palette = gamePalette();
    this.scene = new VoxelScene(session, this.palette, createModelCache());
    this.viewFrame.width = session.world.width;
    this.viewFrame.height = session.world.height;
    this.syncPlotBounds();
    this.overlays = new VoxelOverlays(this.overlayRoot, () => this.session);
    // Index 4: after the land (Phase 21), the crowd heatmap (Phase 14), the scenery heatmap and the selection, before the draft and the preview.
    this.hints = new VoxelHints(this.overlayRoot, 4);
    this.badges = new VoxelBadges(this.overlayRoot, () => this.session, (objectId) => this.scene.objectTop(objectId));
    this.effects = new VoxelEffects(this.overlayRoot, () => this.session, (objectId) => this.scene.objectTop(objectId), reducedMotion);
    // An explicit `&light=` pins the look to one preset for good; otherwise it follows setTimeOfDay.
    const initial = LIGHT_OVERRIDE === null
      ? dayWeights(this.appliedWeights, DEFAULT_PHASE)
      : Object.assign(this.appliedWeights, {
        day: LIGHT_OVERRIDE === 'day' ? 1 : 0, dusk: LIGHT_OVERRIDE === 'dusk' ? 1 : 0, night: LIGHT_OVERRIDE === 'night' ? 1 : 0,
      });
    blendLightPreset(this.look, initial);
    this.frame = {
      camera: this.camera.snapped(),
      elapsedMs: 0,
      grid: this.showGrid,
      preset: LIGHT_PRESET,
      look: this.look,
      lookRevision: 1,
      lightBits: presetBitsFor(initial),
      depthRange: depthRangeFor(session.world.width, session.world.height),
      weather: this.weatherLook.effects,
      weatherRevision: this.weatherLook.effects.revision,
      seeThrough: this.seeFrame,
      view: this.scene.view,
    };
  }

  /**
   * Presentation only: the weather picture as plain data (RendererPort.setWeather). The nine fields
   * are copied into one owned view; nothing is kept from the caller's object.
   */
  setWeather(view: Readonly<WeatherView>): void {
    const own = this.weatherView;
    own.enabled = view.enabled;
    own.kind = view.kind;
    own.intensity = view.intensity;
    own.previousKind = view.previousKind;
    own.day = view.day;
    own.slot = view.slot;
    own.segmentProgress = view.segmentProgress;
    own.secondsIntoSegment = view.secondsIntoSegment;
    own.flashSeed = view.flashSeed;
  }

  /**
   * Presentation only (RendererPort.setSeeThrough): the two flags are copied; the hole follows the
   * hovered cell and the preview footprint every frame (updateSeeThrough) and fades in and out.
   */
  setSeeThrough(request: Readonly<SeeThroughRequest>): void {
    this.seeRequest.armed = request.armed;
    this.seeRequest.peek = request.peek;
  }

  /**
   * One frame of the cutaway: the focus from the cursor and the preview, the fade, the slewed hole,
   * and a new revision for the GPU only when a value really moved (an idle frame writes nothing).
   * Presentation only: a bug here is contained, logged once and leaves the effect off.
   */
  private updateSeeThrough(deltaMs: number): void {
    if (!this.seeEnabled || this.seeFailed) return;
    try {
      const focus = this.seeFocus;
      const volume = this.scene.ghostVolume;
      const painting = this.paintCells.length > 0 && this.previewCells.length === 0;
      const has = resolveSeeThroughFocus(
        this.seeRequest,
        this.hoveredCell,
        painting ? this.paintCells : this.previewCells,
        painting ? 'bulldoze' : this.previewMode,
        volume.active ? volume.heightVoxels : painting ? this.paintHeight : 0,
        focus,
      );
      if (has) {
        this.shapeFocus(focus, volume.active ? volume : null);
        this.focusToView(focus);
      }
      this.seeFade.setTarget(has);
      const strength = this.seeFade.step(deltaMs);
      const current = this.seeCurrent;
      if (has) {
        const target = seeThroughValuesFor(focus, this.seeTarget);
        if (!this.seePositionValid) {
          Object.assign(current, target);
          this.seePositionValid = true;
        } else {
          const instant = reducedMotion();
          const tau = SEE_THROUGH.POSITION_TAU_MS;
          current.ax = slewTo(current.ax, target.ax, deltaMs, tau, instant);
          current.ay = slewTo(current.ay, target.ay, deltaMs, tau, instant);
          current.aw = slewTo(current.aw, target.aw, deltaMs, tau, instant);
          current.ah = slewTo(current.ah, target.ah, deltaMs, tau, instant);
          current.cutKey = slewTo(current.cutKey, target.cutKey, deltaMs, tau, instant);
          current.margin = slewTo(current.margin, target.margin, deltaMs, tau, instant);
          current.floorZ = target.floorZ;
        }
      } else if (strength === 0) {
        this.seePositionValid = false;
      }
      const frame = this.seeFrame;
      if (strength === frame.strength && current.ax === frame.ax && current.ay === frame.ay && current.aw === frame.aw && current.ah === frame.ah
        && current.cutKey === frame.cutKey && current.margin === frame.margin && current.floorZ === frame.floorZ) return;
      frame.ax = current.ax;
      frame.ay = current.ay;
      frame.aw = current.aw;
      frame.ah = current.ah;
      frame.cutKey = current.cutKey;
      frame.margin = current.margin;
      frame.floorZ = current.floorZ;
      frame.strength = strength;
      frame.revision += 1;
    } catch (error) {
      this.seeFailed = true;
      console.warn('The voxel see-through presentation failed; continuing without it.', error);
      this.disableSeeThrough();
      const target = window as unknown as { __voxelDegraded?: string };
      target.__voxelDegraded = appendDegradedLabel(target.__voxelDegraded, 'no-seethrough');
    }
  }

  /** The volume the cutaway opens around, beyond the plain footprint: the demolished object, a coaster piece, a peek. */
  private shapeFocus(focus: SeeThroughFocus, volume: Readonly<GhostVolume> | null): void {
    if (focus.peek) {
      // No ghost to measure: open the height of a typical ride above the cursor.
      if (volume === null) focus.heightVoxels = SEE_THROUGH.COASTER_HEIGHT_VOXELS;
    } else if (focus.mode === 'bulldoze') {
      // The preview names only the hovered cell; the object under it may fill more.
      if (volume !== null) {
        focus.minX = Math.min(focus.minX, Math.floor(volume.originX / VOXELS_PER_TILE));
        focus.minY = Math.min(focus.minY, Math.floor(volume.originY / VOXELS_PER_TILE));
        focus.maxX = Math.max(focus.maxX, Math.ceil((volume.originX + volume.extentX) / VOXELS_PER_TILE) - 1);
        focus.maxY = Math.max(focus.maxY, Math.ceil((volume.originY + volume.extentY) / VOXELS_PER_TILE) - 1);
      }
    } else if (this.coasterDesigner && this.previewCells.length === 0) {
      // A coaster piece is a column of track up to a few levels high: open a fixed volume at the cursor.
      focus.mode = 'place';
      focus.heightVoxels = SEE_THROUGH.COASTER_HEIGHT_VOXELS;
    }
  }

  /**
   * The focus rectangle (world cells, inclusive) as view cells: the cutaway's maths (depth key, screen rect)
   * runs in the view the picture is drawn in. The footprint of a quarter turn swaps its sides (rectToView).
   */
  private focusToView(focus: SeeThroughFocus): void {
    const frame = this.viewFrame;
    if (frame.rotation === 0) return;
    const rect = rectToView(frame, focus.minX, focus.minY, focus.maxX - focus.minX + 1, focus.maxY - focus.minY + 1, this.rectScratch);
    focus.minX = rect.x;
    focus.minY = rect.y;
    focus.maxX = rect.x + rect.width - 1;
    focus.maxY = rect.y + rect.depth - 1;
  }

  /** Strength 0 for good (a failed presentation, or a pipeline without the cut program). */
  private disableSeeThrough(): void {
    const frame = this.seeFrame;
    frame.strength = 0;
    frame.revision += 1;
  }

  /** Presentation only. `phase` is the clock fraction of the day (0 = midnight, 0.5 = noon). */
  setTimeOfDay(phase: number): void {
    this.timeOfDay = phase;
  }

  setMachineryPaused(paused: boolean): void {
    this.machineryPaused = paused;
    this.scene.setMachineryPaused(paused);
  }

  /** Moves the applied day weights to the clock's, flagging that the look must be blended again. Ignored under `&light=`. */
  private syncDayWeights(): void {
    if (LIGHT_OVERRIDE !== null) return;
    const weights = dayWeights(this.weights, this.timeOfDay);
    const applied = this.appliedWeights;
    if (Math.abs(weights.day - applied.day) <= LOOK_EPSILON
      && Math.abs(weights.dusk - applied.dusk) <= LOOK_EPSILON
      && Math.abs(weights.night - applied.night) <= LOOK_EPSILON) return;
    applied.day = weights.day;
    applied.dusk = weights.dusk;
    applied.night = weights.night;
    this.weightsMoved = true;
  }

  /**
   * Blends the look when the time of day moved or the weather's grade modifiers did (their own
   * revision): no allocation, no uniform work for a still frame, and a calm sky never re-blends.
   */
  private updateLook(): void {
    this.syncDayWeights();
    const effects = this.frame.weather;
    const modifiersMoved = effects !== this.appliedModifiers || effects.modifiersRevision !== this.appliedModifiersRevision;
    if (!this.weightsMoved && !modifiersMoved) return;
    this.weightsMoved = false;
    this.appliedModifiers = effects;
    this.appliedModifiersRevision = effects.modifiersRevision;
    const weights = this.appliedWeights;
    blendLightPreset(this.look, weights, effects.modifiers);
    const frame = this.frame;
    frame.lookRevision += 1;
    frame.lightBits = presetBitsFor(weights);
    frame.preset = presetNameOf(weights);
  }

  /**
   * The weather look for this frame, on the day weights the look uses. Uniforms only: a failure
   * here (a bug in the presentation, never the GPU, whose programs were validated at mount) is
   * contained, logged once, and leaves a clear sky; the voxel renderer carries on.
   */
  private updateWeather(deltaMs: number): void {
    const frame = this.frame;
    if (this.weatherTier === 'none' || this.weatherFailed) return;
    this.syncDayWeights();
    try {
      const effects = this.weatherLook.update(this.weatherView, this.appliedWeights, deltaMs, this.machineryPaused);
      frame.weather = effects;
      frame.weatherRevision = effects.revision;
    } catch (error) {
      this.weatherFailed = true;
      console.warn('The voxel weather presentation failed; continuing without it.', error);
      this.useClearWeather();
      const target = window as unknown as { __voxelDegraded?: string };
      target.__voxelDegraded = appendDegradedLabel(target.__voxelDegraded, 'no-weather');
    }
  }

  /** A frozen clear sky: identity modifiers, no effects, revisions one past the last live ones so everything re-applies once. */
  private useClearWeather(): void {
    const clear = this.clearWeather;
    const live = this.weatherLook.effects;
    clear.revision = live.revision + 1;
    clear.modifiersRevision = live.modifiersRevision + 1;
    this.frame.weather = clear;
    this.frame.weatherRevision = clear.revision;
  }

  async mount(host: HTMLElement): Promise<void> {
    if (this.destroyed) return;
    let app: Application<WebGLRenderer>;
    try {
      app = await createVoxelApp(host, {
        resolution: currentResolution(),
        allowSoftware: ALLOW_SOFTWARE_GPU,
        beforeInit: registerVoxelUploader,
        debug: VOXEL_DEBUG,
      });
    } catch (error) {
      if (this.destroyed) return;
      throw error;
    }
    if (this.destroyed) {
      app.destroy(true, { children: true });
      return;
    }
    try {
      await runGpuSelfTest(app.renderer);
    } catch (error) {
      app.destroy(true, { children: true });
      if (this.destroyed) return;
      throw error;
    }
    if (this.destroyed) {
      app.destroy(true, { children: true });
      return;
    }
    this.app = app;
    this.host = host;
    try {
      this.buildPipelineOrDegrade(app);
    } catch (error) {
      this.discardPipeline();
      this.app = null;
      this.host = null;
      app.destroy(true, { children: true });
      throw error instanceof UnsupportedRendererError
        ? error
        : new UnsupportedRendererError('The voxel renderer could not build its GPU pipeline', { capability: false, cause: error });
    }

    const canvas = app.canvas;
    canvas.className = 'game-canvas';
    canvas.setAttribute('aria-label', 'Isometric theme park construction area');
    canvas.dataset.renderer = this.kind;
    // Inline, not in styles.css: the classic canvas must keep its smooth browser scaling.
    canvas.style.imageRendering = 'pixelated';
    if (this.toolCursor !== null) canvas.style.cursor = this.toolCursor;
    app.renderer.on('resize', this.applyViewport);
    this.watchResolution();
    this.watchContextLoss(canvas);

    host.appendChild(canvas);
    this.input = bindWorldInput(
      canvas, this.camera, (cell) => this.session.world.isInside(cell), () => this.handlers,
      undefined, undefined, undefined, () => this.viewFrame, this.refinePick,
    );
    this.input.setViewInputEnabled(this.viewInputEnabled);
    this.mounted = true;
  }

  /** Runs `listener` at the ticker's NORMAL priority, before Pixi renders the stage at LOW. */
  onFrame(listener: (deltaMs: number) => void): void {
    if (!this.app) throw new Error('VoxelRenderer.onFrame needs a mounted renderer');
    this.app.ticker.add((ticker) => listener(ticker.deltaMS), undefined, UPDATE_PRIORITY.NORMAL);
  }

  onFatalError(listener: (error: Error) => void): void {
    this.fatalListener = listener;
  }

  /** Idempotent. Before mount resolves it only marks the renderer; mount then cleans up. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mounted = false;
    this.stopWatchingPresentation?.();
    this.stopWatchingPresentation = null;
    this.input?.destroy();
    this.input = null;
    this.stopWatchingResolution?.();
    this.stopWatchingResolution = null;
    this.stopWatchingContextLoss();
    this.fatalListener = null;
    this.overlayRoot.destroy({ children: true });
    this.badges.destroy();
    this.effects.destroy();
    const app = this.app;
    this.app = null;
    this.host = null;
    if (!app) return;
    app.renderer.off('resize', this.applyViewport);
    this.scene.setSink(NULL_GPU_SINK);
    this.gpu?.destroy();
    this.gpu = null;
    app.destroy(true, { children: true });
  }

  setSession(session: ParkSession): void {
    this.session = session;
    this.frame.depthRange = depthRangeFor(session.world.width, session.world.height);
    this.scene.setSession(session);
    this.worldDirty = true;
    this.weatherLook.reset();
    // A park of another size turns about another centre: the transform follows the new world's size.
    this.viewFrame.width = session.world.width;
    this.viewFrame.height = session.world.height;
    this.scene.setView(this.viewFrame);
    setViewTransform(this.viewFrame, this.shownView);
    this.syncPlotBounds();
    if (this.mounted) {
      this.gpu?.resetScene();
      this.overlays.reset();
      this.badges.reset();
      this.hints.reset();
      this.effects.reset();
      this.previewKey = null;
      this.previewCells.length = 0;
      this.paintCells.length = 0;
      this.paintHeight = 0;
      this.coasterDesigner = false;
    }
    this.setOverlayViews();
    this.seePositionValid = false;
  }

  /** Hands the overlays, the hints and the badges the current orientation (each redraws its retained state once). */
  private setOverlayViews(): void {
    this.overlays.setView(this.viewFrame);
    this.hints.setView(this.viewFrame);
    this.badges.setView(this.viewFrame);
    this.effects.setView(this.viewFrame);
  }

  /**
   * Phase 11 (PA-021): the camera clamp's plot rectangle in view cells (W and H swap under rotation). Phase 21: on an
   * estate it is the owned land, with the margin capped at one parcel, so the centre of the screen stays within a parcel
   * of the park: the land for sale next door is in view and the owned land never leaves the screen (browser check,
   * 2026-10-14: the uncapped margin let a 1280 x 800 view show only dimmed land). Re-read when the owned land changes.
   */
  private syncPlotBounds(): void {
    const world = this.session.world;
    this.plotLandRevision = world.landRevision;
    if (!world.land.restricted) {
      const size = viewMapSize(this.viewFrame);
      this.camera.setPlotBounds(size.width, size.height);
      return;
    }
    const owned = world.land.ownedBounds();
    const rect = rectToView(this.viewFrame, owned.x0, owned.y0, owned.x1 - owned.x0 + 1, owned.y1 - owned.y0 + 1, this.plotRect);
    this.camera.setPlotBounds(rect.width, rect.depth, rect.x, rect.y, world.land.grid.parcelSize);
  }

  /** True while a pointer tool gesture is held on the canvas; GameApp refuses a view turn meanwhile. */
  get gestureHeld(): boolean {
    return this.input?.gestureHeld ?? false;
  }

  /**
   * Phase 26: shows the map turned by `rotation` quarter turns, synchronously, so the next frame is entirely
   * the new orientation (no frame mixes two; the voxel renderer always snaps, whatever `instant` says, and
   * reduced motion is trivially satisfied). Nothing is rebuilt: the scene re-sorts and re-sends its chunks
   * (VoxelScene.setView), the camera keeps the ground point at the middle of the screen, the overlays redraw
   * for the view, the cutaway snaps, and `rehover` runs last so GameApp redraws the ghost under a pointer
   * that did not move. Any failure inside puts everything back to view 0 and gives the rotation up for this
   * session (`no-view-rotation`); the voxel renderer stays.
   */
  setViewRotation(rotation: ViewRotation, instant = true): void {
    if (!this.viewTurnOk) return;
    if (rotation === this.viewFrame.rotation) return;
    // Phase 41 step 3: unless asked to snap (reduced motion, Lite graphics, a load), the camera yaws through the
    // cinematic projection about the ground point at the middle of the screen, while the CPU side is already in the
    // new view; the isometric picture takes over when it lands.
    const camera = this.frame.camera;
    if (!instant && this.mounted && this.gpu?.perspectiveOk === true && camera !== undefined && camera.lowHeight > 0) {
      this.viewTurn = {
        target: groundAtCentre(this.viewFrame, camera.cameraTexelX, camera.cameraTexelY, camera.lowWidth, camera.lowHeight),
        from: viewAzimuth(this.viewFrame.rotation),
        to: viewAzimuth(rotation),
        startMs: this.lastElapsedMs,
        lowHeight: camera.lowHeight,
      };
    }
    try {
      this.applyView(rotation);
    } catch (error) {
      this.abandonViewTurn(error);
    }
    this.input?.rehover();
  }

  private applyView(rotation: ViewRotation): void {
    const frame = this.viewFrame;
    frame.rotation = rotation;
    frame.width = this.session.world.width;
    frame.height = this.session.world.height;
    const next = setViewTransform(frame, this.nextView);
    this.scene.setView(frame);
    this.setOverlayViews();
    this.seePositionValid = false;
    if (this.mounted) this.camera.retargetForTurn(this.shownView, next);
    this.syncPlotBounds();
    setViewTransform(frame, this.shownView);
  }

  /**
   * The pipeline came up without the view code (`no-view-rotation`) while a turn asked for before or during the
   * mount had already turned the CPU side: everything (scene sort and bounds, frame.view, overlays, picking)
   * goes back to view 0, which is what that GPU draws. The camera is framed by the caller.
   */
  private resetViewForNoRotation(): void {
    if (this.viewFrame.rotation === 0) return;
    const frame = this.viewFrame;
    frame.rotation = 0;
    frame.width = this.session.world.width;
    frame.height = this.session.world.height;
    this.scene.setView(frame);
    this.setOverlayViews();
    this.seePositionValid = false;
    this.syncPlotBounds();
    setViewTransform(frame, this.shownView);
  }

  /** The runtime rung: back to view 0 through the same code path, rotation off for good, one warning and the label. */
  private abandonViewTurn(error: unknown): void {
    this.viewTurnOk = false;
    console.warn('The voxel view rotation failed; continuing at view 0 without it.', error);
    try {
      this.applyView(0);
    } catch (restoreError) {
      console.warn('The voxel view could not be restored to view 0.', restoreError);
    }
    const target = window as unknown as { __voxelDegraded?: string };
    target.__voxelDegraded = appendDegradedLabel(target.__voxelDegraded, 'no-view-rotation');
  }

  /**
   * Voxel leftovers (picking): a path's top face is drawn PATH_PICK_LIFT texels above the ground diamond, so a point on
   * the upper rim of a path's top would pick the cell behind it. When the point, lowered by the lift, lands on a path,
   * that path is what the player sees there and it wins (a path in front covers the ground behind it).
   */
  private readonly refinePick = (ground: Cell, worldX: number, worldY: number): Cell => {
    const raised = pickCell(this.viewFrame, worldX, worldY + PATH_PICK_LIFT);
    return raised.x !== ground.x || raised.y !== ground.y ? (this.session.world.paths.has(`${raised.x},${raised.y}`) ? raised : ground) : ground;
  };

  /** Phase 15: starts a world feedback effect (see RendererPort.showEffect). */
  showEffect(effect: Readonly<WorldEffect>): void {
    this.effects.show(effect);
  }

  /**
   * Phase 15: the zoom fraction and the visible ground in world cells (see RendererPort.readViewInfo). Called a few times
   * a second, not per frame: the four corner reads allocate a little.
   */
  readViewInfo(out: ViewInfo): void {
    const levels = this.camera.zoomLevels;
    out.zoom = levels.max > levels.min ? (this.camera.zoom - levels.min) / (levels.max - levels.min) : 0.5;
    const size = this.camera.cssSize();
    let u0 = Number.POSITIVE_INFINITY;
    let v0 = Number.POSITIVE_INFINITY;
    let u1 = Number.NEGATIVE_INFINITY;
    let v1 = Number.NEGATIVE_INFINITY;
    for (const [cx, cy] of [[0, 0], [size.width, 0], [0, size.height], [size.width, size.height]]) {
      const texel = this.camera.cssToWorld(cx, cy);
      const u = (texel.x / (TILE_WIDTH / 2) + texel.y / (TILE_HEIGHT / 2)) / 2;
      const v = (texel.y / (TILE_HEIGHT / 2) - texel.x / (TILE_WIDTH / 2)) / 2;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const a = pointFromView(this.viewFrame, u0, v0, { x: 0, y: 0 });
    const b = pointFromView(this.viewFrame, u1, v1, { x: 0, y: 0 });
    const world = this.session.world;
    out.x0 = Math.max(0, Math.floor(Math.min(a.x, b.x)));
    out.y0 = Math.max(0, Math.floor(Math.min(a.y, b.y)));
    out.x1 = Math.min(world.width - 1, Math.ceil(Math.max(a.x, b.x)));
    out.y1 = Math.min(world.height - 1, Math.ceil(Math.max(a.y, b.y)));
    // The middle of the screen and the middle of its left and right edges, on the ground plane.
    const ground = (cssX: number, cssY: number): { x: number; y: number } => {
      const texel = this.camera.cssToWorld(cssX, cssY);
      const u = (texel.x / (TILE_WIDTH / 2) + texel.y / (TILE_HEIGHT / 2)) / 2;
      const v = (texel.y / (TILE_HEIGHT / 2) - texel.x / (TILE_WIDTH / 2)) / 2;
      return pointFromView(this.viewFrame, u, v, { x: 0, y: 0 });
    };
    const centre = ground(size.width / 2, size.height / 2);
    const left = ground(0, size.height / 2);
    const right = ground(size.width, size.height / 2);
    const across = Math.hypot(right.x - left.x, right.y - left.y);
    out.cx = centre.x;
    out.cy = centre.y;
    out.halfWidth = Math.max(1, across / 2);
    out.rightX = across > 0 ? (right.x - left.x) / across : 1;
    out.rightY = across > 0 ? (right.y - left.y) / across : 0;
  }

  syncWorld(): void {
    this.worldDirty = true;
    this.overlays.syncWorld();
    // Phase 21: a parcel bought (or a restore) moves the camera's plot with the owned land.
    if (this.session.world.landRevision !== this.plotLandRevision) this.syncPlotBounds();
  }

  setHintMarkers(markers: readonly HintMarker[]): void {
    this.hints.set(markers);
  }

  update(deltaMs: number, elapsedMs: number, stepFraction = 0): void {
    const started = performance.now();
    this.lastElapsedMs = elapsedMs;
    if (this.revalidatePending) this.revalidate();
    this.input?.keyPan(deltaMs);
    // Phase 11: a focus glide advances here (key pan above cancels it where it is).
    this.camera.stepEase(deltaMs);
    if (this.worldDirty) {
      this.worldDirty = false;
      this.scene.syncWorld();
    }
    const snap = this.camera.snapped();
    this.frame.elapsedMs = elapsedMs;
    this.updateWeather(deltaMs);
    this.updateSeeThrough(deltaMs);
    this.pushFrame(snap);
    this.cullFigures(snap);
    this.scene.update(deltaMs, elapsedMs, stepFraction);
    this.refreshOverlay(snap, false);
    const now = performance.now();
    const instantaneous = 1000 / Math.max(1, now - this.lastFrameAt);
    this.fps += (instantaneous - this.fps) * FPS_SMOOTHING;
    this.lastFrameAt = now;
    this.renderMs = now - started;
  }

  /** The classic renderer's numbers, counted from the simulation rather than from displays. */
  getPerformance(): RendererPerformance {
    const { world, guests, operations } = this.session;
    return {
      fps: this.fps,
      renderMs: this.renderMs,
      entities: world.objects.size + world.paths.size + guests.guests.size + operations.staff.size + operations.litter.size,
      ...(VOXEL_TIMING ? { gpu: this.gpuPerformance() } : {}),
    };
  }

  /** Phase 55: what `&voxelTiming=1` shows (the GPU passes, the zoom and the low-res target). */
  private gpuPerformance(): NonNullable<RendererPerformance['gpu']> {
    const snap = this.camera.snapped();
    const timings = this.gpu?.timings ?? null;
    const ms = timings?.milliseconds;
    return {
      passes: ms === undefined ? null : { gbuffer: ms[PASS_GBUFFER], light: ms[PASS_LIGHT], composite: ms[PASS_COMPOSITE], upscale: ms[PASS_UPSCALE] },
      zoom: snap.zoom,
      lowWidth: snap.lowWidth,
      lowHeight: snap.lowHeight,
    };
  }

  setInputHandlers(handlers: WorldInputHandlers): void {
    this.handlers = handlers;
  }

  get hoveredCell(): Cell | null {
    return this.input?.hoveredCell ?? null;
  }

  setViewInputEnabled(enabled: boolean): void {
    this.viewInputEnabled = enabled;
    this.input?.setViewInputEnabled(enabled);
  }

  setToolCursor(cursor: string): void {
    this.toolCursor = cursor;
    if (this.mounted && this.app) this.app.canvas.style.cursor = cursor;
  }

  /** Phase 11: `'ease'` glides there (CAMERA_EASE_MS); `'instant'`, reduced motion or an unmounted renderer snap. */
  focusCell(cell: Cell, motion: CameraMotion = 'instant', insets?: Readonly<ViewInsets>): void {
    const fromX = this.camera.originX;
    const fromY = this.camera.originY;
    if (insets === undefined) {
      this.setCameraCentre(cell.x, cell.y);
    } else {
      // Phase 36: into the middle of what the HUD leaves uncovered (a building beside its inspector, not under it).
      const at = this.camera.safeCentreFractions(insets);
      const view = cellToView(this.viewFrame, cell.x, cell.y, this.viewScratch);
      this.camera.focusCellXY(view.x, view.y, at.x, at.y);
    }
    this.easeFrom(motion, fromX, fromY);
  }

  /** Phase 36: the HUD's cover, for the camera clamp (see RendererPort.setViewInsets). Moves nothing by itself. */
  setViewInsets(insets: Readonly<ViewInsets>): void {
    this.camera.setSafeInsets(insets);
  }

  focusEntrance(motion: CameraMotion = 'instant'): void {
    const fromX = this.camera.originX;
    const fromY = this.camera.originY;
    const entrance = this.session.world.entrance;
    this.camera.focusEntranceInView(this.viewFrame, entrance.x, entrance.y, this.session.world.heart);
    this.easeFrom(motion, fromX, fromY);
  }

  /**
   * The focus has just put the camera on its (clamped) target; for `'ease'` it goes back to the origin the player
   * last saw (mid-way through a glide that the focus completed, if one ran) and glides from there instead.
   */
  private easeFrom(motion: CameraMotion, fromX: number, fromY: number): void {
    if (motion !== 'ease' || !this.mounted || reducedMotion()) return;
    const camera = this.camera;
    const toX = camera.originX;
    const toY = camera.originY;
    camera.originX = fromX;
    camera.originY = fromY;
    camera.easeTo(toX, toY);
  }

  /** A (possibly fractional) WORLD cell coordinate in the middle of the viewport, through the view. Completes a glide. */
  setCameraCentre(cellX: number, cellY: number): void {
    const view = cellToView(this.viewFrame, cellX, cellY, this.viewScratch);
    this.camera.focusCellXY(view.x, view.y);
  }

  get cameraZoom(): number {
    return this.camera.zoom;
  }

  /** A whole zoom level (clamped), keeping the middle of the viewport where it is. */
  setCameraZoom(zoom: number): void {
    const size = this.camera.cssSize();
    this.camera.setZoomAtCss(zoom, size.width / 2, size.height / 2);
  }

  /** Whether the tile grid is on; the world pass reads it as its grid uniform. */
  get gridVisible(): boolean {
    return this.showGrid;
  }

  setGridVisible(visible: boolean): void {
    this.showGrid = visible;
  }

  setSceneryInfluenceVisible(visible: boolean): void {
    this.overlays.setInfluenceVisible(visible);
  }

  /**
   * Phase 14: the crowd flow heatmap (overlay/overlays.ts `setCrowdHeatmap`). Redrawn only on a new revision or a view
   * turn, so GameApp may repeat the same view freely; null hides it. Forgotten on setSession: push the new park's view.
   */
  setCrowdHeatmap(view: Readonly<CrowdHeatmapView> | null): void {
    this.overlays.setCrowdHeatmap(view);
  }

  selectObject(object: PlacedObject | null): void {
    this.overlays.selectObject(object);
  }

  /**
   * Footprint diamonds in the overlay, and the dithered voxel ghost of the model (or the object to
   * bulldoze). GameApp sends the same preview again on every pointermove inside a cell; a repeat
   * redraws nothing, so it costs no overlay-target render either.
   */
  drawPreview(
    cells: readonly Cell[],
    definition: BuildDefinition | null,
    valid: boolean,
    bulldoze = false,
    rotation: Rotation = 0,
    colours: ObjectColours | null = null,
    blocked: readonly Cell[] | null = null,
  ): void {
    const key = previewKeyOf(cells, definition, valid, bulldoze, blocked, rotation);
    if (key !== this.previewKey) {
      this.previewKey = key;
      this.overlays.drawPreview(cells, definition, valid, bulldoze, blocked, rotation);
    }
    // Phase 28: the colours the next object will get tint the ghost's boxes (a new box list only when they change).
    this.scene.setPreview(cells, definition, valid, bulldoze, rotation, colours);
    this.recordPreview(cells, definition, bulldoze);
  }

  /**
   * Phase 28: the Paint tool's hover (RendererPort.setPaintHover): an outline and a light fill of the target's
   * cells through the overlay layer, retained and redrawn only when the cells or the tint change. Null clears it.
   * The cutaway opens around the target like a bulldoze target, so a stall behind a ride can be picked.
   */
  setPaintHover(hover: Readonly<PaintHover> | null): void {
    if (hover === null || hover.cells.length === 0) {
      this.overlays.clearPaintHover();
      this.paintCells.length = 0;
      this.paintHeight = 0;
      return;
    }
    this.overlays.setPaintHover(hover.cells, hover.tint);
    const own = this.paintCells;
    own.length = hover.cells.length;
    for (let index = 0; index < hover.cells.length; index += 1) {
      const cell = this.paintPool[index] ?? (this.paintPool[index] = { x: 0, y: 0 });
      cell.x = hover.cells[index].x;
      cell.y = hover.cells[index].y;
      own[index] = cell;
    }
    const object = this.session.world.objectAt(hover.cells[0]);
    this.paintHeight = (object ? this.scene.objectTop(object.id) : null) ?? PAINT_TARGET_FALLBACK_HEIGHT;
  }

  /** Keeps the footprint the cutaway opens around (pooled cells, no allocation once warm). */
  private recordPreview(cells: readonly Cell[], definition: BuildDefinition | null, bulldoze: boolean): void {
    const own = this.previewCells;
    const pool = this.previewPool;
    own.length = cells.length;
    for (let index = 0; index < cells.length; index += 1) {
      const cell = pool[index] ?? (pool[index] = { x: 0, y: 0 });
      cell.x = cells[index].x;
      cell.y = cells[index].y;
      own[index] = cell;
    }
    this.previewMode = bulldoze ? 'bulldoze' : definition?.kind === 'path' ? 'cell' : 'place';
  }

  clearPreview(): void {
    this.previewCells.length = 0;
    this.previewKey = null;
    this.overlays.clearPreview();
    this.scene.clearPreview();
  }

  /** The layout as the real voxel track (scene ghost) plus the blocked-cell and guide overlay. */
  drawCoasterDraft(pieces: readonly CoasterPiece[], _color: number, armed = true, definitionId?: string, colours: ObjectColours | null = null): void {
    const definition = definitionId === undefined ? null : BUILD_BY_ID.get(definitionId) ?? null;
    this.coasterDesigner = armed && (pieces.length > 0 || definitionId !== undefined);
    this.scene.setCoasterDraft(pieces, definition, armed, colours);
    this.overlays.drawCoasterDraft(pieces, armed);
  }

  /** Highest z (world voxels) of a placed object at rest, where overlay badges go; null if unknown. */
  objectTop(objectId: number): number | null {
    return this.scene.objectTop(objectId);
  }

  /**
   * Builds the pipeline with the full composite and the whole weather pass; if validation fails and
   * the failure names only programs the game can do without (gpu/glFailure.ts degradePlanFor), walks
   * the fallback chain on the same application, each rung one rebuild plus a validation:
   * - the composite (a Windows ANGLE/Direct3D 11 compiler that cannot build the pixel shader:
   *   "Error compiling dynamic pixel executable", at link or at the first composite draw) →
   *   full composite WITHOUT the weather pass (`no-weather`) → lite composite with rain only
   *   (`composite-lite`) → lite composite without weather (`composite-lite+no-weather`);
   * - the light pass alone → no light pools, 'no-lights'; the figure shadow decals → 'no-shadows';
   *   the world-cut program → no cutaway, 'no-seethrough'; a front-layer program (or a failure naming no
   *   program, tried one rung at a time) → the dither cutaway, 'no-translucent-seethrough', then none.
   * Phase 26 comes first: a failure naming a program that carries the view code is retried once without it
   * (`no-view-rotation`, everything else kept). If that retry fails as well, the chain above is planned from
   * ITS failure and walked with the view code on (rotation kept: the failure was not the view code's), then,
   * on a GPU where both break, once more without it (`...+no-view-rotation`).
   * The cause is logged. If every rung fails, the ORIGINAL error is thrown, since that is the one
   * that explains the machine. Any other failure is thrown at once — nothing optional would change it.
   * `&voxelComposite=lite` and `&voxelWeather=off|rain` start further down the chain.
   */
  private buildPipelineOrDegrade(app: Application<WebGLRenderer>): void {
    const variant = requestedCompositeVariant();
    const seeMode = requestedSeeThroughLook();
    // The translucent rung needs the full composite (lite has no outlines to light a layer with: it shows the dither rung).
    const requested: CompositeRung = { variant, tier: requestedWeatherTier(variant), translucent: seeMode === 'alpha' && variant === 'full' };
    const error = this.tryBuild(app, requested, null, true, seeMode);
    if (error === null) return;
    console.warn('A voxel shader failed on this GPU; retrying without it.', error);
    // Phase 26: a failure naming a program that carries the view code (any geometry program, the light pass, and
    // the composites of a full/full build) is first retried with today's exact sources (`viewTurn: false`, the
    // `no-view-rotation` rung), which keeps everything else.
    const viewPlan = degradePlanFor(error, { viewTurn: true, compositeView: compositeCarriesViewCode(requested) });
    let chainError: unknown = error;
    if (viewPlan?.viewRotation === true) {
      const retryError = this.tryBuild(app, requested, viewPlan, false, seeMode);
      if (retryError === null) {
        this.setDegradedLabel(degradedLabelFor(viewPlan, requested, requested));
        return;
      }
      // The failure survived without the view code, so it is not (only) the view code's: the chain below is
      // planned from that failure and keeps the rotation where it can.
      chainError = retryError;
    }
    const attempts = this.degradeAttempts(chainError, requested, seeMode);
    if (attempts === null || attempts.length === 0) throw error;
    for (const { rung, plan } of attempts) {
      if (this.tryBuild(app, rung, plan, true, seeMode) === null) {
        this.setDegradedLabel(degradedLabelFor(plan, requested, rung));
        return;
      }
    }
    // A GPU where the view code AND something optional both fail: the same chain without the view code.
    if (viewPlan?.viewRotation === true) {
      for (const { rung, plan } of attempts) {
        if (this.tryBuild(app, rung, plan, false, seeMode) === null) {
          const label = degradedLabelFor(plan, requested, rung);
          this.setDegradedLabel(appendDegradedLabel(label === '' ? undefined : label, 'no-view-rotation'));
          return;
        }
      }
    }
    throw error;
  }

  /** One build of the pipeline (the first, or a rung of the chain after discarding the last); returns its failure or null. */
  private tryBuild(app: Application<WebGLRenderer>, rung: CompositeRung, plan: DegradePlan | null, viewTurn: boolean, seeMode: SeeThroughLook): unknown {
    if (plan !== null) {
      this.discardPipeline();
      resetGlErrorTrace(app.renderer.gl as WebGL2RenderingContext);
    }
    this.viewTurnRequested = viewTurn;
    try {
      this.buildPipeline(app, rung, plan === null ? {} : { skipLights: plan.lights, skipShadows: plan.shadows, skipSeeThrough: plan.seeThrough }, seeMode);
      return null;
    } catch (failure) {
      if (plan !== null) console.warn('The reduced voxel pipeline failed as well.', failure);
      return failure;
    }
  }

  private setDegradedLabel(label: string): void {
    (window as unknown as { __voxelDegraded?: string }).__voxelDegraded = label;
  }

  /**
   * The retries of the old chain after a failure (the first build's, or the failure that survived the
   * `viewTurn: false` retry), in order, each with the plan whose label it earns (null: nothing optional would
   * change the failure, so the voxel renderer is given up for the classic one):
   * - a failure naming only optional programs: the composite goes down its own chain (translucent off first,
   *   then weather, then lite), a front-layer program alone drops the translucent rung, anything else keeps the
   *   rung and skips what failed;
   * - a failure naming no program (a link error, which cannot be tied to one draw) steps the see-through down
   *   one rung at a time, translucent -> dither -> off, because its programs are the newest.
   * The lite composite without weather is the last rung of the first kind: if even it fails, nothing is left.
   */
  private degradeAttempts(error: unknown, requested: CompositeRung, seeMode: SeeThroughLook): { rung: CompositeRung; plan: DegradePlan }[] | null {
    const plan = degradePlanFor(error);
    if (plan !== null) {
      const rungs = plan.composite
        ? compositeRungsAfter(requested)
        : plan.translucent && requested.translucent ? [{ ...requested, translucent: false }] : [requested];
      return rungs.map((rung) => ({ rung, plan }));
    }
    const steps = seeThroughRungsFor(error, seeMode);
    if (steps.length === 0) return null;
    return steps.map((step) => ({
      rung: { ...requested, translucent: requested.translucent && step.translucent },
      plan: { viewRotation: false, composite: false, lights: false, shadows: false, seeThrough: step.skipSeeThrough, translucent: !step.translucent },
    }));
  }

  /** Tears the GPU half down (scene detached first), leaving the Pixi application intact. */
  private discardPipeline(): void {
    this.scene.setSink(NULL_GPU_SINK);
    this.gpu?.destroy();
    this.gpu = null;
  }

  /**
   * The GPU half of mount: pipeline, palette, templates, the first scene build and one warm-up
   * render plus one real draw of every program (`gpu.warmUp`), then validation — Pixi only logs a program that fails to link or a target that is
   * incomplete, so both are checked here, where a failure can still fall back.
   */
  private buildPipeline(app: Application<WebGLRenderer>, rung: CompositeRung, degrade: PipelineDegrade, seeMode: SeeThroughLook): void {
    const renderer = app.renderer;
    const compositeVariant = rung.variant;
    this.weatherTier = rung.tier;
    this.seeEnabled = !(degrade.skipSeeThrough ?? false) && !this.seeFailed && seeMode !== 'off';
    if (!this.seeEnabled) this.disableSeeThrough();
    if (rung.tier === 'none') this.useClearWeather();
    else if (!this.weatherFailed) {
      this.frame.weather = this.weatherLook.effects;
      this.frame.weatherRevision = this.weatherLook.effects.revision;
    }
    this.maxTargetSize = maxRenderTargetSize(renderer.gl as WebGL2RenderingContext);
    const gpu = createVoxelGpu(renderer, {
      ...degrade,
      gpuMin: VOXEL_GPU_MIN,
      timing: VOXEL_TIMING,
      viewTurn: this.viewTurnRequested,
      compositeVariant,
      weatherTier: rung.tier,
      translucentSeeThrough: rung.translucent && this.seeEnabled,
      onTranslucentFailed: this.handleTranslucentFailed,
      onContextRestored: this.handleContextRestored,
    });
    this.gpu = gpu;
    this.viewTurnOk = gpu.supportsViewTurn;
    if (!this.viewTurnOk) this.resetViewForNoRotation();
    gpu.setPalette(this.palette.textureData());
    gpu.setFigureTemplates(buildFigureTemplates(this.palette));
    app.stage.addChild(gpu.layer);
    this.scene.setSink(gpu);

    this.applyViewport();
    this.focusEntrance();
    this.worldDirty = false;
    this.scene.syncWorld();
    const snap = this.camera.snapped();
    this.pushFrame(snap);
    this.scene.update(0, this.frame.elapsedMs, 0);
    this.refreshOverlay(snap, true);
    app.render();
    // Most programs had nothing to draw above (no guests, ghost, draft or lights at mount), and a
    // driver can fail a program only at its first draw: draw every one now, before judging.
    gpu.warmUp();
    validateGpu(renderer, gpu.programs(), gpu.targets());
    stopGlErrorTrace(renderer.gl as WebGL2RenderingContext, VOXEL_DEBUG);
  }

  /**
   * Voxel leftovers (figure culling): the guests and staff the camera cannot see are not packed, drawn or uploaded.
   * The low-res target's texel rectangle is mapped to view cells, then to world cells, with a margin of
   * FIGURE_CULL_MARGIN cells (a figure stands about half a tile tall and walks between frames). No allocation.
   */
  private cullFigures(snap: SnappedCamera): void {
    const u0 = (snap.texelX / (TILE_WIDTH / 2) + snap.texelY / (TILE_HEIGHT / 2)) / 2;
    const v0 = (snap.texelY / (TILE_HEIGHT / 2) - (snap.texelX + snap.lowWidth) / (TILE_WIDTH / 2)) / 2;
    const u1 = ((snap.texelX + snap.lowWidth) / (TILE_WIDTH / 2) + (snap.texelY + snap.lowHeight) / (TILE_HEIGHT / 2)) / 2;
    const v1 = ((snap.texelY + snap.lowHeight) / (TILE_HEIGHT / 2) - snap.texelX / (TILE_WIDTH / 2)) / 2;
    pointFromView(this.viewFrame, u0, v0, this.cullA);
    pointFromView(this.viewFrame, u1, v1, this.cullB);
    const margin = FIGURE_CULL_MARGIN;
    this.scene.setFigureCull(
      Math.min(this.cullA.x, this.cullB.x) - margin,
      Math.min(this.cullA.y, this.cullB.y) - margin,
      Math.max(this.cullA.x, this.cullB.x) + margin,
      Math.max(this.cullA.y, this.cullB.y) + margin,
    );
  }

  /**
   * Phase 41: the cinematic camera's view this frame, or null for the isometric one. The developer flag `&camera3d`
   * (orbit or a low pass) wins; otherwise a menu shot, a view turn or a ride-along asks for it.
   */
  setCinematic(view: Readonly<CinematicView> | null): void {
    if (view === null) {
      this.requestedCinematic = null;
      return;
    }
    const held = this.requestedCinematic ?? (this.requestedCinematic = { eye: [0, 0, 0], target: [0, 0, 0], fovY: CINEMATIC_FOV });
    for (let axis = 0; axis < 3; axis += 1) {
      held.eye[axis] = view.eye[axis];
      held.target[axis] = view.target[axis];
    }
    held.fovY = view.fovY;
  }

  get cinematicSupported(): boolean {
    return this.gpu?.perspectiveOk ?? false;
  }

  private requestedCinematic: CinematicView | null = null;
  private rideAlongId: number | null = null;
  private rideAlongFov = (70 * Math.PI) / 180;
  private readonly rideScratch: CinematicView = { eye: [0, 0, 0], target: [0, 0, 0], fovY: 1 };
  private readonly carPose = new Float32Array(7);

  setRideAlong(objectId: number | null, fovY?: number): void {
    this.rideAlongId = objectId;
    if (fovY !== undefined) this.rideAlongFov = fovY;
  }

  /** The ride-along camera this frame: the coaster's lead car, else a circle round a flat ride; null when it is gone. */
  private rideAlongView(): CinematicView | null {
    const id = this.rideAlongId as number;
    if (this.scene.leadCarPose(id, this.carPose)) return trainRideView(this.carPose, this.rideAlongFov, this.rideScratch);
    const world = this.session.world;
    const object = world.objects.get(id);
    if (object === undefined) return null;
    const cells = world.objectFootprint(object);
    const centreX = (cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length + 0.5) * VOXELS_PER_TILE;
    const centreY = (cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length + 0.5) * VOXELS_PER_TILE;
    const radius = (Math.max(...cells.map((cell) => cell.x)) - Math.min(...cells.map((cell) => cell.x)) + 3) * VOXELS_PER_TILE;
    return flatRideView(centreX, centreY, radius, this.lastElapsedMs / 1000, this.rideAlongFov, this.rideScratch);
  }

  /** Phase 41 step 3: whether a smooth view turn is still on screen (GameApp refuses another turn meanwhile). */
  get viewTurning(): boolean {
    return this.viewTurn !== null;
  }

  private viewTurn: { target: [number, number]; from: number; to: number; startMs: number; lowHeight: number } | null = null;
  private lastElapsedMs = 0;
  private readonly turnScratch: CinematicView = { eye: [0, 0, 0], target: [0, 0, 0], fovY: 1 };

  private cinematicView(): CinematicView | null {
    const turn = this.viewTurn;
    if (turn !== null) {
      const t = (this.lastElapsedMs - turn.startMs) / VIEW_TURN_MS;
      if (t >= 1) {
        this.viewTurn = null;
      } else {
        return turnView(turn.target, turnAzimuth(turn.from, turn.to, t), turn.lowHeight, this.turnScratch);
      }
    }
    if (this.rideAlongId !== null) {
      const ride = this.rideAlongView();
      if (ride !== null) return ride;
    }
    if (CAMERA_3D === null || CAMERA_3D === undefined) return this.requestedCinematic;
    const width = this.session.world.width * VOXELS_PER_TILE;
    const height = this.session.world.height * VOXELS_PER_TILE;
    const seconds = this.frame.elapsedMs / 1000;
    if (CAMERA_3D === 'low') lowPassCamera(width, height, seconds, this.cinematic);
    else orbitCamera(width, height, seconds, this.cinematic);
    this.cinematic.fovY = CINEMATIC_FOV;
    return this.cinematic;
  }

  private readonly cinematic: CinematicView = { eye: [0, 0, 0], target: [0, 0, 0], fovY: CINEMATIC_FOV };

  /** The snapped camera and the look into the GPU's frame uniforms (also resizes its targets). */
  private pushFrame(snap: SnappedCamera): void {
    const gpu = this.gpu;
    if (!gpu) return;
    const frame = this.frame;
    frame.camera = snap;
    frame.grid = this.showGrid;
    this.updateLook();
    // Optional calls: test doubles of the GPU predate the cinematic camera.
    gpu.setCameraMap?.(this.session.world.width, this.session.world.height);
    gpu.setPerspective?.(this.cinematicView());
    gpu.setFrame(frame);
  }

  /**
   * Renders the overlays into the low-res overlay target when what they show, the camera texel or
   * the target size changed (or `force`), placing their root at −uCameraTexel so world texel t lands
   * on target texel t − uCameraTexel; an empty overlay is skipped and its composite fetch turned off.
   */
  private refreshOverlay(snap: SnappedCamera, force: boolean): void {
    const gpu = this.gpu;
    if (!gpu) return;
    const overlays = this.overlays;
    const badges = this.badges;
    badges.update(this.frame.elapsedMs);
    this.hints.update(this.frame.elapsedMs);
    this.effects.update(this.frame.elapsedMs);
    const empty = overlays.isEmpty && badges.isEmpty && this.hints.isEmpty && this.effects.isEmpty;
    // The versions only ever grow, so their sum changes exactly when any of them does.
    const version = overlays.version + badges.version + this.hints.version + this.effects.version;
    const changed = force
      || version !== this.overlayVersion
      || snap.cameraTexelX !== this.overlayCameraX
      || snap.cameraTexelY !== this.overlayCameraY
      || snap.lowWidth !== this.overlayWidth
      || snap.lowHeight !== this.overlayHeight;
    if (!changed && this.overlayShown === !empty) return;
    this.overlayVersion = version;
    this.overlayCameraX = snap.cameraTexelX;
    this.overlayCameraY = snap.cameraTexelY;
    this.overlayWidth = snap.lowWidth;
    this.overlayHeight = snap.lowHeight;
    this.overlayShown = !empty;
    gpu.setOverlayVisible(!empty);
    if (empty) return;
    this.overlayRoot.position.set(-snap.cameraTexelX, -snap.cameraTexelY);
    gpu.renderOverlay(this.overlayRoot);
  }

  /**
   * The single place a new canvas size, resolution or zoom limit is applied: the renderer's
   * 'resize' (window resize, via Pixi's ResizePlugin, which renders straight after) and DPR changes
   * both land here, so the frame drawn next is already consistent: targets sized, every
   * size-dependent uniform written, the overlay target re-rendered.
   */
  private readonly applyViewport = (): void => {
    const app = this.app;
    if (!app) return;
    this.camera.setViewport(app.canvas.width, app.canvas.height, app.renderer.resolution, this.maxTargetSize);
    const snap = this.camera.snapped();
    this.pushFrame(snap);
    this.refreshOverlay(snap, true);
    // The world moved under a still pointer: re-pick it so the ghost follows the cell now under it (QA 2026-10-14).
    this.input?.rehover();
  };

  /**
   * A lost WebGL context came back: data textures re-upload themselves from their CPU copies on
   * first use, but the overlay target's pixels are gone, so the next frame re-renders it. The
   * driver that came back may not build what it built before, so the pipeline is proven again at
   * the start of the next frame (`revalidate`), not here: this runs inside Pixi's own restore.
   */
  /**
   * The front layer's CPU side threw while drawing (VoxelGpu contains it and keeps rendering the dither
   * rung): one warning and the label, so support can see that the translucent look is off on this machine.
   */
  private readonly handleTranslucentFailed = (error: unknown): void => {
    console.warn('The voxel translucent see-through failed; continuing with the dithered cutaway.', error);
    const target = window as unknown as { __voxelDegraded?: string };
    target.__voxelDegraded = appendDegradedLabel(target.__voxelDegraded, 'no-translucent-seethrough');
  };

  private readonly handleContextRestored = (): void => {
    this.overlayVersion = -1;
    this.revalidatePending = true;
    this.clearContextLostTimer();
  };

  /** Warm-up draws and validation again after a restore; a failure hands the game to the classic renderer. */
  private revalidate(): void {
    this.revalidatePending = false;
    const app = this.app;
    const gpu = this.gpu;
    if (!app || !gpu) return;
    try {
      revalidateGpu(app.renderer, gpu);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Tells the owner this renderer cannot go on (once): it destroys us and mounts another. */
  private fail(error: Error): void {
    const listener = this.fatalListener;
    this.fatalListener = null;
    this.clearContextLostTimer();
    listener?.(error);
  }

  private clearContextLostTimer(): void {
    if (this.contextLostTimer === null) return;
    clearTimeout(this.contextLostTimer);
    this.contextLostTimer = null;
  }

  /**
   * Starts a clock when the browser reports the context lost and stops it when it is restored. A
   * context that is never restored (a GPU process that keeps crashing, a driver reset the browser
   * gives up on) would leave a frozen canvas; after CONTEXT_LOST_TIMEOUT_MS the owner is told.
   */
  private watchContextLoss(canvas: HTMLCanvasElement): void {
    this.contextLostListener = () => {
      this.clearContextLostTimer();
      this.contextLostTimer = setTimeout(() => {
        this.contextLostTimer = null;
        this.fail(new Error(`The WebGL context was lost and did not come back within ${CONTEXT_LOST_TIMEOUT_MS / 1000} s`));
      }, CONTEXT_LOST_TIMEOUT_MS);
    };
    this.contextRestoredListener = () => this.clearContextLostTimer();
    canvas.addEventListener('webglcontextlost', this.contextLostListener);
    canvas.addEventListener('webglcontextrestored', this.contextRestoredListener);
  }

  private stopWatchingContextLoss(): void {
    this.clearContextLostTimer();
    const canvas = this.app?.canvas;
    if (canvas && this.contextLostListener) canvas.removeEventListener('webglcontextlost', this.contextLostListener);
    if (canvas && this.contextRestoredListener) canvas.removeEventListener('webglcontextrestored', this.contextRestoredListener);
    this.contextLostListener = null;
    this.contextRestoredListener = null;
  }

  /**
   * Pixi fixes the resolution at init and its ResizePlugin only hears window resizes, so a move to
   * another monitor or a browser zoom would leave the canvas resampled by a non-integer factor.
   * A `(resolution: Xdppx)` query fires once when the ratio leaves X; it is re-armed at the new one.
   */
  private watchResolution(): void {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = (): void => {
      query.removeEventListener('change', onChange);
      this.stopWatchingResolution = null;
      const app = this.app;
      const host = this.host;
      if (!app || !host) return;
      app.renderer.resize(host.clientWidth, host.clientHeight, currentResolution());
      this.watchResolution();
    };
    query.addEventListener('change', onChange);
    this.stopWatchingResolution = () => query.removeEventListener('change', onChange);
  }
}
