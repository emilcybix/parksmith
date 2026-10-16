import type { CoasterPiece } from '../game/coaster/design';
import type { ParkSession } from '../game/session/ParkSession';
import type { WeatherView } from '../game/weather/types';
import type { CrowdHeatmapView } from '../game/crowd/types';
import type { BuildDefinition, Cell, PlacedObject, Rotation } from '../game/types';
import type { ObjectColours } from '../game/content/colours';
import type { SeeThroughRequest } from './seeThrough';

export type { SeeThroughRequest } from './seeThrough';
export type { ViewRotation } from './viewRotation';
import type { ViewRotation } from './viewRotation';

/** The modifier keys held at pointer down. Only `shift` is read today (Paint: every slot). */
export interface PointerModifiers {
  readonly shift: boolean;
}

/**
 * Phase 28 step 2. What the Paint tool would recolour under the cursor: the target object's footprint cells
 * (a coaster: every piece cell; the entrance gate: its cell) and the brush colour as a classic RGB for the
 * outline fill, or null when the brush has no single colour (default, preset, copied: outline only).
 */
export interface PaintHover {
  readonly cells: readonly Cell[];
  readonly tint: number | null;
}

/**
 * What the world's pointer and camera input tells the game. Both renderers deliver exactly these
 * calls through the shared binding in `worldInput.ts`, so GameApp cannot tell them apart.
 */
/** Phase 36: CSS px of the world view that the HUD covers on each side (the rail, the top bar, Park Pulse, the dock). */
export interface ViewInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WorldInputHandlers {
  /** Every pointermove that is not a pan, even inside the same cell: the in-map cell or null. */
  hover(cell: Cell | null): void;
  /**
   * Left press inside the map, unless Alt or Space turns it into a pan. `modifiers` carries the keys held
   * at pointer down (the Paint tool reads Shift there); optional so older callers and tests need no change.
   */
  start(cell: Cell, modifiers?: PointerModifiers): void;
  /** Pointer move inside the map while ANY button is held (legacy P17: a right-drag moves too). */
  move(cell: Cell): void;
  /** Left release inside the map. */
  end(cell: Cell): void;
  /** Right-click (contextmenu). */
  cancel(): void;
}

export interface RendererPerformance {
  fps: number;
  /** The last frame interval. It is not a render time, and GameApp does not show it. */
  renderMs: number;
  /** Objects, path tiles, guests, workers and litter piles: a total, not a visible count. */
  entities: number;
}

/**
 * One place the First Day hints point at: a single cell or one object footprint (at most nine
 * cells). The renderer draws a soft pulsing ring on the ground there.
 */
export interface HintMarker {
  readonly cells: readonly Cell[];
}

export type RendererKind = 'classic' | 'voxel';

/**
 * Phase 11 (PA-021): how a focus moves the camera. `'instant'` (the default) snaps; `'ease'` glides for player-
 * initiated moves (an estate row, the brand button, the recentre control and key). Optional on the port, so the
 * classic renderer (legacy) ignores it and keeps snapping; the voxel renderer snaps anyway under reduced motion.
 */
export type CameraMotion = 'instant' | 'ease';

/**
 * Phase 41: a cinematic camera view: world voxels (z up), a look-at pose and a vertical field of view in radians.
 * Presentation only (the menu shots, the view-turn transition, ride-along).
 */
export interface CinematicView {
  eye: [number, number, number];
  target: [number, number, number];
  fovY: number;
  /** World z is drawn scaled by this (default 1); a view turn uses ISO_Z_SCALE to match the isometric picture. */
  zScale?: number;
  /** Distance fog and the sky (default on); a view turn, framed like the isometric view, has neither. */
  atmosphere?: boolean;
}

/**
 * Everything GameApp asks of a renderer: the eighteen members it has always used, a frame hook in
 * place of the Pixi ticker it used to reach into, and which renderer it is. Keeping GameApp on this
 * seam is what lets the voxel renderer draw the whole picture — and the classic one take over when
 * the voxel one cannot run — without GameApp knowing anything about Pixi.
 */
export interface RendererPort {
  readonly kind: RendererKind;

  /** Builds the initial scene and attaches the canvas; rejects if the renderer cannot run here. */
  mount(host: HTMLElement): Promise<void>;
  /** Idempotent, and safe before `mount` resolves: a pending mount then resolves without side effects. */
  destroy(): void;
  /**
   * Runs `listener` once per animation frame, before the frame is drawn (`deltaMs` ≤ 100). Only
   * valid after `mount` resolves. GameApp's listener is the only per-frame work that may call
   * `update`; a renderer registers no frame callbacks of its own.
   */
  onFrame(listener: (deltaMs: number) => void): void;
  /**
   * Optional. Registers the one listener told when a mounted renderer can no longer draw (the
   * voxel renderer after a lost WebGL context that never came back or came back broken). The owner
   * is expected to destroy it and mount another; the renderer itself does nothing more.
   */
  onFatalError?(listener: (error: Error) => void): void;

  setSession(session: ParkSession): void;
  /** Reconciles the scene with the world; a cheap no-op when nothing geometric changed. */
  syncWorld(): void;
  /**
   * The single per-frame entry point. `stepFraction` is how far the simulation is between fixed
   * steps (SimulationClock.stepFraction), for renderers that interpolate.
   */
  update(deltaMs: number, elapsedMs: number, stepFraction?: number): void;
  getPerformance(): RendererPerformance;
  /**
   * Presentation only: the time of day as a clock fraction (0 = midnight, 0.5 = noon, in [0, 1)).
   * GameApp calls it once per frame, before `update`. The renderer turns it into a look and keeps it;
   * nothing it does can reach the simulation, and calling it never rebuilds scene geometry.
   */
  setTimeOfDay(phase: number): void;
  /**
   * True while the game is paused: ride machinery stops turning (and keeps its angle) instead of
   * running on the wall clock. Optional so a renderer that has no machinery need not implement it.
   */
  setMachineryPaused?(paused: boolean): void;
  /**
   * Presentation only: the weather picture (kind, intensity, slot progress, storm flash seed), as
   * plain data. GameApp calls it once per frame next to `setTimeOfDay` with ONE reused object, so a
   * renderer must read it and not keep the reference past the call (feed it to a WeatherLook,
   * rendering/weatherLook.ts). Optional, and nothing it does can reach the simulation.
   */
  setWeather?(view: Readonly<WeatherView>): void;

  /**
   * Presentation only: whether the see-through cutaway should show the build site (a tool is armed
   * in a context that may build) and whether the hold-to-peek key is down. GameApp calls it ONLY
   * when `armed` or `peek` changes, with ONE reused object, so a renderer must read it and not keep
   * the reference. The cursor cell is the renderer's own `hoveredCell` and the footprint is its
   * last `drawPreview`; fading in and out is the renderer's per-frame job. Optional, and nothing it
   * does can reach the simulation or change picking.
   */
  setSeeThrough?(request: Readonly<SeeThroughRequest>): void;

  /**
   * Phase 26. True when the renderer can draw the map turned. Absent or false: GameApp keeps the
   * picture at view 0, leaves the park's saved value alone and tells the player.
   */
  readonly supportsViewRotation?: boolean;
  /**
   * Presentation only: shows the map turned by `rotation` quarter turns (clockwise on screen per
   * step) about its centre. Nothing reaches the simulation. Idempotent for the current value. The
   * new orientation is complete before the next frame is drawn (no frame mixes two orientations);
   * picking switches at the same moment, and the renderer calls the input's `rehover()` last, so
   * GameApp redraws the ghost under a pointer that did not move. `instant` skips any transition
   * (load, new park, a renderer attached mid-park); otherwise the renderer animates unless reduced
   * motion is on. Optional: only called when `supportsViewRotation` is true.
   */
  setViewRotation?(rotation: ViewRotation, instant?: boolean): void;
  /**
   * True while a pointer tool gesture is held on the canvas (see WorldInput.gestureHeld). GameApp
   * refuses a view turn meanwhile: the drag's cells were picked in the old orientation, and the
   * next move would join them to a cell picked in the new one along a straight world line.
   */
  readonly gestureHeld?: boolean;

  setInputHandlers(handlers: WorldInputHandlers): void;
  /** The in-map cell under the pointer, so a tool change can redraw its blueprint in place. */
  readonly hoveredCell: Cell | null;
  /** Camera keys follow the input context; disabling also releases every held key. */
  setViewInputEnabled(enabled: boolean): void;
  setToolCursor(cursor: string): void;
  /**
   * Centres a world cell. `motion` (Phase 11) defaults to `'instant'`; a renderer may ignore it. Phase 36: with `insets`
   * the cell goes to the middle of the area they leave uncovered (a building beside its inspector, not under it); a
   * renderer may ignore them (the classic one centres).
   */
  focusCell(cell: Cell, motion?: CameraMotion, insets?: Readonly<ViewInsets>): void;
  /**
   * Phase 36: the HUD's cover of the world view on each side, in CSS px. The voxel camera keeps a plot cell inside the
   * uncovered area while the player pans. Optional: the classic renderer has no clamp.
   */
  setViewInsets?(insets: Readonly<ViewInsets>): void;
  /** Frames the park entrance. `motion` (Phase 11) defaults to `'instant'`; a renderer may ignore it. */
  focusEntrance(motion?: CameraMotion): void;
  /**
   * Presentation only: puts a (possibly fractional) cell coordinate in the middle of the viewport,
   * keeping the zoom. Takes numbers, not a Cell, so GameApp's start-screen camera sweep can call it
   * every frame without allocating. Optional: a renderer without it simply shows a still park.
   */
  setCameraCentre?(cellX: number, cellY: number): void;
  /** The camera's current whole zoom level (the start-screen sweep steps it). Optional, with `setCameraZoom`. */
  readonly cameraZoom?: number;
  /** Presentation only: sets the whole zoom level, clamped into the renderer's levels, keeping the viewport's centre. */
  setCameraZoom?(zoom: number): void;
  /**
   * Phase 41: draws the next frames through a cinematic camera (null: back to the isometric view). Optional (voxel
   * only); `cinematicSupported` says whether this GPU drew it. Presentation only.
   */
  setCinematic?(view: Readonly<CinematicView> | null): void;
  /** Phase 41 step 3: true while a smooth view turn is on screen (a second turn waits for it). */
  readonly viewTurning?: boolean;
  readonly cinematicSupported?: boolean;

  setGridVisible(visible: boolean): void;
  setSceneryInfluenceVisible(visible: boolean): void;
  /**
   * Phase 14: the crowd flow heatmap, a ground layer below the scenery heatmap's slot. A view draws it (redrawn only
   * when its `revision` moves or the view turns); null hides it. Optional: the classic renderer omits it (no-op).
   */
  setCrowdHeatmap?(view: Readonly<CrowdHeatmapView> | null): void;
  /**
   * Phase 15: a short world feedback effect (a money popup, a ride, sale, breakdown, repair or construction cue, a guest's
   * reaction). GameApp calls it with ONE reused object: read it, keep nothing. Optional: the classic renderer omits it.
   */
  showEffect?(effect: Readonly<WorldEffect>): void;
  /**
   * Phase 15: what the camera shows, for zoom-aware ambience: zoom as a fraction from the farthest (0) to the closest (1)
   * level and the visible ground rectangle in WORLD cells (clipped to the map), written into `out` (no allocation).
   * Optional: a renderer without it gets a fixed mid-zoom ambience.
   */
  readViewInfo?(out: ViewInfo): void;
  selectObject(object: PlacedObject | null): void;
  drawPreview(
    cells: readonly Cell[],
    definition: BuildDefinition | null,
    valid: boolean,
    bulldoze?: boolean,
    rotation?: Rotation,
    /** Phase 28: the colours the NEXT object will get (colour before placing); null/absent = defaults. */
    colours?: ObjectColours | null,
    /**
     * Phase 37: cells of `cells` drawn with the refused fill whatever `valid` says (the path draft's blocked cells,
     * so the player sees what to steer round). Null/absent/empty = every cell takes `valid`'s fill.
     */
    blocked?: readonly Cell[] | null,
  ): void;
  clearPreview(): void;
  /**
   * Phase 28 step 2. The Paint tool's hover: an outline plus a light fill of the target's cells drawn
   * through the overlay layer (no ghost, no shader). Called on every hover cell change with the resolved
   * target; equal input costs nothing; null clears it (and any see-through focus it caused). Optional.
   */
  setPaintHover?(hover: Readonly<PaintHover> | null): void;
  /**
   * The First Day pointers. `[]` switches them off. Idempotent, and the renderer keeps no reference
   * to the array, so the caller may reuse it; called only when the markers change.
   */
  setHintMarkers(markers: readonly HintMarker[]): void;
  /**
   * The coaster layout in progress. `definitionId` is the coaster type it is drawn as; the voxel
   * renderer builds the real track from it, the legacy one ignores it.
   */
  drawCoasterDraft(
    pieces: readonly CoasterPiece[],
    color: number,
    armed?: boolean,
    definitionId?: string,
    /** Phase 28: the colours the coaster will get when it is finished; null/absent = defaults. */
    colours?: ObjectColours | null,
  ): void;
}

/**
 * Why a renderer refused to mount. `capability` separates "this machine cannot run it" (no WebGL2,
 * a software rasteriser) from "it broke" (a shader that failed to link, an incomplete framebuffer,
 * a module that failed to load), because the player is told different things about each.
 */
export class UnsupportedRendererError extends Error {
  readonly capability: boolean;
  /**
   * For a capability failure, what is missing: `webgl2` (no WebGL2 at all; the default) or
   * `software` (WebGL2 only on a software rasteriser or a blocklisted GPU). It picks the toast.
   */
  readonly kind: 'webgl2' | 'software';

  constructor(message: string, options: { capability: boolean; kind?: 'webgl2' | 'software'; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'UnsupportedRendererError';
    this.capability = options.capability;
    this.kind = options.kind ?? 'webgl2';
  }
}

/** Phase 15: the kinds of world feedback effect (see RendererPort.showEffect). */
export type WorldEffectKind =
  | 'money-gain' | 'money-spend' | 'ride-cycle' | 'sale' | 'breakdown' | 'repair' | 'build' | 'happy' | 'unhappy';

/**
 * One world feedback effect. With `objectId` it sits above that object (its footprint centre and top); otherwise on the
 * ground point (`x`, `y`), a fractional WORLD cell (a guest's position for a reaction). `amount` is the money of a popup.
 */
export interface WorldEffect {
  kind: WorldEffectKind;
  x: number;
  y: number;
  objectId: number | null;
  amount: number;
}

/** Phase 15: the camera's view for ambience (see RendererPort.readViewInfo). */
export interface ViewInfo {
  zoom: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

