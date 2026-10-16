import { Application, Container, Graphics, Sprite, Text, Texture, UPDATE_PRIORITY } from 'pixi.js';
import { previewFill } from './previewFill';
import {
  centreLineFor,
  centreLineIndexToDistance,
  layoutCanClose,
} from '../game/coaster/centreLine';
import { COASTER_TYPE_BY_ID } from '../game/coaster/content';
import type { CoasterPiece } from '../game/coaster/design';
import { WEATHER_FLAGS } from '../app/rendererFlag';
import { GAME_CONFIG } from '../game/config';
import { DEFAULT_BIOME_ID } from '../game/biomes/content';
import { PROP_KIND_BY_ID, type PropKindDefinition } from '../game/maps/props';
import { propFootprintSize } from '../game/maps/parse';
import type { PropPlacement } from '../game/maps/types';
import { BUILD_BY_ID } from '../game/content/catalog';
import type { ObjectColours } from '../game/content/colours';
import type { GuestSimulation } from '../game/guests/GuestSimulation';
import type { Guest } from '../game/guests/types';
import type { ParkSession } from '../game/session/ParkSession';
import type { OperationsSimulation } from '../game/operations/OperationsSimulation';
import type { StaffSnapshot } from '../game/operations/types';
import type { RideSimulation } from '../game/rides/RideSimulation';
import { createWeatherView, type WeatherView } from '../game/weather/types';
import type { ScenerySimulation } from '../game/scenery/ScenerySimulation';
import type { ShopSimulation } from '../game/shops/ShopSimulation';
import { footprintSize } from '../game/types';
import type { BuildDefinition, Cell, PlacedObject, Rotation } from '../game/types';
import type { GameWorld } from '../game/World';
import {
  buildClassicTrack, CLASSIC_COASTER_COMMON, classicCoasterPalette, classicOffsetX, classicOffsetY,
  classicTrackX, classicTrackY, setClassicView,
} from './classicCoaster';
import type { ClassicTrackGeometry } from './classicCoaster';
import { openDraftRing } from './draftRing';
import { classicTint } from './classicDayTint';
import { ClassicSeeThrough, type SeeThroughCandidate } from './classicSeeThrough';
import { ClassicWeather, type FieldBounds, type ScreenSize } from './classicWeather';
import { coasterHeadIndex } from './coasterTrain';
import { classicCarLean, classicTrainSpec, createClassicTrain, setClassicLoadedCars } from './classicTrain';
import { createObjectArt, drawEntranceArt } from './classicObjectArt';
import { drawPropArt, propArtIsOriented, shade } from './classicPropArt';
import { entranceFocus } from './entranceFraming';
import { coasterCarFrame, coasterLoadedCars, createCoasterCarFrame } from './coasterCarFrame';
import type { ClassicTrain } from './classicTrain';
import { createDayWeights, dayWeights } from './dayCycle';
import { cellToWorld, diamondPoints, isometricSortKey, TILE_HEIGHT, TILE_WIDTH } from './isometric';
import { stretchSegment } from './parts';
import type {
  HintMarker, PaintHover, RendererPerformance, RendererPort, SeeThroughRequest, WorldInputHandlers,
} from './RendererPort';
import { createRideArt, type RideArt } from './rideArt';
import { resolveSeeThroughFocus, type SeeThroughFocus, type SeeThroughMode } from './seeThrough';
import { presentationFlags, WeatherLook, type WeatherEffects } from './weatherLook';
import { getPresentation, onPresentationChange, reducedMotion } from '../settings/motion';
import { bindWorldInput, type WorldInput, type WorldInputView } from './worldInput';
import {
  cellToView, createViewFrame, pointFromView, pointToView, rectToView, rotationInView, vectorToView,
  type CellRect, type MutableViewFrame, type ViewRotation, type XY,
} from './viewRotation';

export type { WorldInputHandlers } from './RendererPort';

interface AnimatedDisplay {
  container: Container;
  phase: number;
}

/** One placed ride's machinery, plus the motion state its animation is driven from. */
interface RideDisplay {
  objectId: number;
  art: RideArt;
  /**
   * The machinery for the other footprint axis, kept detached after the first quarter turn so later
   * turns swap it in instead of rebuilding it (ride art depends on the rotation's parity alone).
   */
  spareArt: RideArt | null;
  /** Keeps identical rides out of lockstep. */
  phase: number;
  /** Smoothed 0..1 so spin-up and spin-down are gradual instead of instant. */
  motion: number;
  /** Motion-weighted milliseconds: only advances while the ride is actually turning. */
  spin: number;
}

interface RideAlertDisplay {
  container: Container;
  state: 'broken' | 'maintenance';
}

/**
 * One placed object's static display. Kept per object so a construction change touches only what
 * actually changed: rebuilding every ride's machinery because one path tile moved was the single
 * largest cost during active building.
 */
interface ObjectDisplay {
  container: Container;
  /** Plot tint and fence. The fence opens where a path touches, so paths dirty this — only this. */
  base: Graphics | null;
  centerCell: Cell;
  isRide: boolean;
  /**
   * The colour record this object's art was drawn from (Phase 28), compared by identity with the object's:
   * the world replaces a record on every change, so a mismatch is exactly "recolour this object".
   */
  colours: ObjectColours | null;
  /** A non-ride, non-coaster object's art container (the plot base is the group's first child), so a recolour can swap it. */
  art: Container | null;
  /** Which plot edges a path touches. A path edit that does not change this changes no art. */
  pathEdges: string;
  /** Sort key and screen box in camera pixels, cached once for the see-through overlap test. */
  sortKey: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * One prop's display (Phase 24): a single pooled Graphics, created when the prop appears and destroyed when it is cleared.
 * Shaped like an object display for the see-through fader (`container`, sort key and screen box in camera pixels).
 */
interface PropDisplay extends SeeThroughCandidate {
  container: Graphics;
  prop: PropPlacement;
  kind: PropKindDefinition;
  /** Which view axis a 2x1 prop lies along (0 = view x), so a view turn redraws it only when this flips. */
  along: 0 | 1;
}

/** What an equivalence test needs to see of the scene. See `WorldRenderer.sceneProbe`. */
export interface SceneProbe {
  drawnPathVersion: number;
  pathDisplay: Container | null;
  entranceDisplay: Container | null;
  objects: {
    objectId: number;
    container: Container;
    base: Graphics | null;
    isRide: boolean;
    pathEdges: string;
  }[];
  rideDisplayIds: number[];
  animatedDisplayIds: number[];
  rideArtTops: [number, number][];
}

/**
 * Every display here is a `new Graphics()` that owns its own GraphicsContext, and in Pixi v8 a
 * plain `destroy()` (or `{ children: true }`) releases the display but NOT the context's GPU
 * buffers. A park swap (load, and now every undo) rebuilds about a thousand displays, so without
 * `context: true` each swap leaked ~24 MB of heap and ~2,200 GL buffers (measured, 1,000 guests).
 * Safe because no display shares a context: each site constructs its own.
 */
/** The page colour past the map's edge: a touch lighter than the ground, but a touch darker for a pale ground (snow), so the edge of the map still reads. */
const backdropOf = (base: number): number => {
  const luma = (0.299 * ((base >> 16) & 255) + 0.587 * ((base >> 8) & 255) + 0.114 * (base & 255)) / 255;
  return shade(base, luma > 0.8 ? 0.9 : 1.1);
};

const DESTROY_DISPLAY = { children: true, context: true } as const;
const DESTROY_GRAPHICS = { context: true } as const;

const COASTER_ELEVATION_PX = 13;
/** Screen px of a car's pivot above the rail top (classic draws cars 4 px above the track). */
const COASTER_CAR_LIFT_PX = 4;

/**
 * Screen position of a point of the coaster centre line (tiles in cell space, height in levels):
 * the isometric projection of a continuous cell coordinate, lifted 13 px a level. For the centre of
 * cell (x, y) at height h this is exactly where the old piece-to-piece line put it. The track
 * structure is built from the same projection in classicCoaster.ts.
 */
const trackScreenX = classicTrackX;
const trackScreenY = classicTrackY;

const INFLUENCE_BASE_ALPHA = 0.22;
const INFLUENCE_SCORE_ALPHA = 0.34;
const INFLUENCE_EDGE_COLOR = 0xfff4c9;
const CARDINAL_DIRECTIONS: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const FENCE_HEIGHT = 9;
const FENCE_RAIL_COLOR = 0xd8e6e4;
const FENCE_POST_COLOR = 0x3f6f6a;

/**
 * The two diamond corners of the tile edge facing `direction`, given the tile's top corner
 * in local coordinates. Used to fence the outside of a footprint one edge at a time.
 */
const footprintEdge = (
  top: { x: number; y: number },
  direction: Cell,
): [{ x: number; y: number }, { x: number; y: number }] => {
  const right = { x: top.x + TILE_WIDTH / 2, y: top.y + TILE_HEIGHT / 2 };
  const bottom = { x: top.x, y: top.y + TILE_HEIGHT };
  const left = { x: top.x - TILE_WIDTH / 2, y: top.y + TILE_HEIGHT / 2 };
  if (direction.x === 1) return [bottom, right];
  if (direction.x === -1) return [top, left];
  if (direction.y === 1) return [left, bottom];
  return [top, right];
};

const influenceColor = (score: number): number =>
  score >= 50 ? 0xff9f45 : score >= 20 ? 0xffd166 : 0x5fe0b6;

// A tile on the outer rim of the influence gets a bright outline so the exact radius reads
// at a glance instead of fading into the terrain.
const isInfluenceEdge = (cell: Cell, covered: ReadonlySet<string>): boolean =>
  CARDINAL_DIRECTIONS.some((direction) => !covered.has(`${cell.x + direction.x},${cell.y + direction.y}`));

/** The classic camera's zoom range and wheel sensitivity: continuous, exponential in deltaY. */
const CLASSIC_MIN_ZOOM = 0.42;
const CLASSIC_MAX_ZOOM = 1.65;
const CLASSIC_WHEEL_ZOOM_RATE = 0.0012;

/**
 * The classic camera as the shared input binding sees it: a Pixi container positioned in CSS px with
 * a continuous uniform scale. The wheel keeps the world point under the cursor fixed; it does not
 * normalise `deltaMode` (legacy behaviour, unchanged).
 */
export const containerCameraView = (
  camera: Container,
  screen: () => { width: number; height: number },
): WorldInputView => ({
  cssSize: screen,
  cssToWorld: (x, y) => ({ x: (x - camera.x) / camera.scale.x, y: (y - camera.y) / camera.scale.y }),
  panByCss: (dx, dy) => {
    camera.x += dx;
    camera.y += dy;
  },
  zoomAtCss: (x, y, event) => {
    const beforeX = (x - camera.x) / camera.scale.x;
    const beforeY = (y - camera.y) / camera.scale.y;
    const scale = Math.min(
      CLASSIC_MAX_ZOOM,
      Math.max(CLASSIC_MIN_ZOOM, camera.scale.x * Math.exp(-event.deltaY * CLASSIC_WHEEL_ZOOM_RATE)),
    );
    camera.scale.set(scale);
    camera.position.set(x - beforeX * scale, y - beforeY * scale);
  },
});

/** Diamond edges as [neighbour dx, dy, then two end points as fractions of the tile], from the cell's top vertex. */
const HINT_EDGES: readonly (readonly [number, number, number, number, number, number])[] = [
  [1, 0, 0.5, 0.5, 0, 1],
  [-1, 0, 0, 0, -0.5, 0.5],
  [0, 1, -0.5, 0.5, 0, 1],
  [0, -1, 0, 0, 0.5, 0.5],
];

const NO_CELLS: readonly Cell[] = [];

/** Phase 26: the turn animation (an ease of a snapshot of the old picture into the new one). */
const VIEW_TURN_MS = 180;
/** The view-turn veil: the canvas background colour, faded from this alpha to 0 with an ease-out. */
const VIEW_TURN_VEIL_COLOR = 0x9ed789;
const VIEW_TURN_VEIL_ALPHA = 0.55;
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

interface PreviewArgs {
  cells: readonly Cell[];
  definition: BuildDefinition | null;
  valid: boolean;
  bulldoze: boolean;
  rotation: Rotation;
  colours: ObjectColours | null;
}

interface DraftArgs {
  pieces: readonly CoasterPiece[];
  color: number;
  armed: boolean;
  definitionId?: string;
  colours: ObjectColours | null;
}

export class WorldRenderer implements RendererPort {
  readonly kind = 'classic';
  /** Phase 26: the classic renderer draws the map turned in all four views. */
  readonly supportsViewRotation = true;
  readonly app = new Application();
  /**
   * The view this picture is drawn in (rotation plus the world size it pivots about). Mutated in
   * place by `setViewRotation`; the input binding, the coaster projection and every builder below
   * read it, so a turn is one write followed by one synchronous rebuild.
   */
  private readonly view: MutableViewFrame = createViewFrame(0, 0, 0);
  /** Reused scratch for the cell to screen projection (no per-frame allocation). */
  private readonly viewCell: XY = { x: 0, y: 0 };
  private readonly viewPoint: XY = { x: 0, y: 0 };
  private readonly screenPoint: XY = { x: 0, y: 0 };
  private readonly viewRect: CellRect = { x: 0, y: 0, width: 0, depth: 0 };
  private lastElapsedMs = 0;
  private lastPreview: PreviewArgs | null = null;
  private lastDraft: DraftArgs | null = null;
  private hintCells: Cell[] = [];
  /** A snapshot of the previous orientation, fading out over the new one. Null when idle. */
  /**
   * The view-turn veil: ONE pooled full-screen Sprite(Texture.WHITE) tinted to the background, built
   * on the first animated turn and kept (hidden) afterwards. It is a flat colour over the already
   * turned picture, so no frame ever shows two orientations.
   */
  private turnVeil: Sprite | null = null;
  /** Milliseconds into the running veil fade, or null when the veil is hidden. */
  private turnVeilElapsedMs: number | null = null;
  private readonly seeThroughViewFocus: SeeThroughFocus = {
    minX: 0, minY: 0, maxX: 0, maxY: 0, mode: 'cell', peek: false, heightVoxels: 0,
  };
  private readonly camera = new Container();
  private readonly dayMix = createDayWeights();
  private dayTint = 0xffffff;
  /** Until the app sets a time of day the picture stays untinted (the weights start at night). */
  private timeKnown = false;
  /** The latest weather view (copied: the port promises nothing about the caller's object). */
  private readonly weatherView = createWeatherView();
  private readonly weatherLook = new WeatherLook({ ...WEATHER_FLAGS, ...presentationFlags(getPresentation()) });
  private readonly screenSize: ScreenSize = { width: 0, height: 0 };
  private readonly weatherField: FieldBounds = { x: 0, y: 0, width: 1, height: 1 };
  /** Pooled cloud shadows (camera space) and rain streaks (screen space); built once, only written to. */
  private readonly classicWeather = new ClassicWeather(
    () => {
      if (this.mounted) {
        this.screenSize.width = this.app.screen.width;
        this.screenSize.height = this.app.screen.height;
      }
      return this.screenSize;
    },
    () => {
      // The park's footprint in camera pixels (cellToWorld of the four corners).
      const field = this.weatherField;
      field.x = -this.world.height * (TILE_WIDTH / 2);
      field.y = 0;
      field.width = (this.world.width + this.world.height) * (TILE_WIDTH / 2);
      field.height = (this.world.width + this.world.height) * (TILE_HEIGHT / 2);
      return field;
    },
  );
  private readonly terrainLayer = new Container();
  private readonly influenceLayer = new Container();
  private readonly constructionLayer = new Container();
  private readonly trainLayer = new Container();
  private readonly selectionLayer = new Container();
  /** The First Day pointer ring: one Graphics, pulsed by an alpha write in `update`. */
  private readonly hintLayer = new Container();
  /** Live presentation preferences (reduced motion, weather level, flashes), released by destroy. */
  private stopWatchingPresentation: (() => void) | null = onPresentationChange((prefs) => {
    this.weatherLook.setPresentation(prefs);
  });
  /**
   * The coaster layout in progress. It has its own layer because the preview layer is cleared on
   * every pointer move: a half-drawn track vanished the moment the cursor left the plot or moved
   * over a panel, even though the pieces were still there.
   */
  private readonly coasterDraftLayer = new Container();
  /** The one Graphics the layout in progress is drawn into: cleared and redrawn on every change, never replaced. */
  private coasterDraftGraphic: Graphics | null = null;
  private readonly previewLayer = new Container();
  /** See-through: pooled fader, reused request/focus objects, and the last preview footprint. */
  private readonly seeThroughFader = new ClassicSeeThrough(reducedMotion);
  private readonly seeThroughRequest: SeeThroughRequest = { armed: false, peek: false };
  private readonly seeThroughFocus: SeeThroughFocus = {
    minX: 0, minY: 0, maxX: 0, maxY: 0, mode: 'cell', peek: false, heightVoxels: 0,
  };
  private readonly seeThroughApplied: SeeThroughFocus = {
    minX: 0, minY: 0, maxX: 0, maxY: 0, mode: 'cell', peek: false, heightVoxels: 0,
  };
  private seeThroughAppliedValid = false;
  private seeThroughDirty = false;
  private previewCells: readonly Cell[] = [];
  private previewMode: SeeThroughMode = 'place';
  private readonly animatedDisplays = new Map<number, AnimatedDisplay>();
  private readonly rideDisplays = new Map<number, RideDisplay>();
  /** Local top edge of each ride's art, so overlays can clear the machinery. */
  private readonly rideArtTops = new Map<number, number>();
  private readonly objectDisplays = new Map<number, ObjectDisplay>();
  private pathDisplay: Graphics | null = null;
  /** Props by id (Phase 24): created on sync, destroyed on a clear, re-sorted on a view turn. */
  private readonly propDisplays = new Map<number, PropDisplay>();
  private drawnPropRevision = -1;
  /** The ground the cached terrain was drawn from (`MapLayout.groundKey`); a different map or biome redraws it, an undo swap on the same map does not. */
  private terrainGroundKey: string | null = null;
  /** Terrain per view class (see `terrainKey`); only the current one is in the terrain layer. */
  private readonly terrainCache = new Map<number, Graphics>();
  private entranceDisplay: Container | null = null;
  /** The gate record the entrance was drawn from (identity, like an object's). */
  private drawnGateColours: ObjectColours | null = null;
  /** The Paint tool's hover outline: one pooled Graphics in the preview layer, redrawn only when its input changes. */
  private paintHoverGraphic: Graphics | null = null;
  private paintHoverCells: readonly Cell[] | null = null;
  private paintHoverTint: number | null = null;
  private drawnPathVersion = -1;
  private sceneryInfluenceDirty = true;
  private readonly guestDisplays = new Map<number, Container>();
  private readonly workerDisplays = new Map<number, Container>();
  private readonly litterDisplays = new Map<string, Container>();
  private readonly binIndicators = new Map<number, Container>();
  private readonly rideAlerts = new Map<number, RideAlertDisplay>();
  private readonly coasterTrains = new Map<number, ClassicTrain>();
  /** Scratch point of the centre line the trains are placed from (reused every frame). */
  private readonly trainFrame = createCoasterCarFrame();
  private readonly trainLean = { x: 0, y: 0 };
  private handlers: WorldInputHandlers | null = null;
  private input: WorldInput | null = null;
  private showGrid = true;
  private fps = 60;
  private lastFrameAt = performance.now();
  private renderMs = 0;
  private selectedObjectId: number | null = null;
  private showSceneryInfluence = false;
  private sceneryInfluenceVersion = -1;
  private viewInputEnabled = true;

  private mounted = false;
  /**
   * Set by `destroy`. An Application cannot be destroyed while `init` is still running (it throws
   * and init completes anyway, leaving a live canvas and ticker), so a destroy that arrives during
   * mount only raises this flag and `mount` tears the Application down once init has resolved.
   */
  private destroyed = false;

  constructor(private session: ParkSession) {
    this.syncViewSize();
  }

  /** The view pivots about the WORLD map size; refreshed whenever the session (so the world) changes. */
  private syncViewSize(): void {
    this.view.width = this.world.width;
    this.view.height = this.world.height;
    setClassicView(this.view);
  }

  /** Top vertex of cell-index (x, y) in camera pixels, in the current view. The result is a reused scratch. */
  private project(x: number, y: number): XY {
    cellToView(this.view, x, y, this.viewCell);
    const out = this.screenPoint;
    out.x = (this.viewCell.x - this.viewCell.y) * (TILE_WIDTH / 2);
    out.y = (this.viewCell.x + this.viewCell.y) * (TILE_HEIGHT / 2);
    return out;
  }

  /** `isometricSortKey` of a point-like cell (guest, worker, litter) in the current view. */
  private cellSortKey(x: number, y: number): number {
    cellToView(this.view, x, y, this.viewCell);
    return (this.viewCell.x + this.viewCell.y) * 100 + this.viewCell.x;
  }

  /** `isometricSortKey` of an object's footprint as the current view sees it. */
  private objectSortKey(object: PlacedObject, definition: BuildDefinition): number {
    const [width, depth] = footprintSize(definition, object.rotation);
    const rect = rectToView(this.view, object.anchor.x, object.anchor.y, width, depth, this.viewRect);
    return isometricSortKey({ x: rect.x, y: rect.y }, [rect.width, rect.depth]);
  }

  private get world(): GameWorld { return this.session.world; }
  private get guests(): GuestSimulation { return this.session.guests; }
  private get rides(): RideSimulation { return this.session.rides; }
  private get shops(): ShopSimulation { return this.session.shops; }
  private get operations(): OperationsSimulation { return this.session.operations; }
  private get scenery(): ScenerySimulation { return this.session.scenery; }

  /** Points the renderer at a new park session and rebuilds every display from scratch. */
  setSession(session: ParkSession): void {
    this.session = session;
    this.syncViewSize();
    this.weatherLook.reset();
    this.seeThroughFader.clear();
    this.seeThroughDirty = true;
    this.setHintMarkers([]);
    this.lastDraft = null;
    this.setPaintHover(null);
    if (!this.mounted) return;
    this.clearScene();
    // A different map or biome has other ground; the same ground (an undo swap, a Meadow to Meadow restart) keeps its cache.
    this.drawTerrain();
    this.applyBackdrop();
    this.selectedObjectId = null;
    this.drawCoasterDraft([], 0);
    this.clearPreview();
    this.syncWorld();
  }

  /** Destroys every display that is placed from the world (not the pooled layers), ready for a rebuild. */
  private clearScene(): void {
    for (const map of [this.guestDisplays, this.workerDisplays, this.litterDisplays, this.binIndicators]) {
      for (const display of map.values()) {
        display.removeFromParent();
        display.destroy(DESTROY_DISPLAY);
      }
      map.clear();
    }
    for (const alert of this.rideAlerts.values()) {
      alert.container.removeFromParent();
      alert.container.destroy(DESTROY_DISPLAY);
    }
    this.rideAlerts.clear();
    for (const train of this.coasterTrains.values()) {
      train.container.removeFromParent();
      train.container.destroy(DESTROY_DISPLAY);
    }
    this.coasterTrains.clear();
    for (const objectId of [...this.objectDisplays.keys()]) this.removeObjectDisplay(objectId);
    for (const propId of [...this.propDisplays.keys()]) this.removePropDisplay(propId);
    this.drawnPropRevision = -1;
    this.pathDisplay?.removeFromParent();
    this.pathDisplay?.destroy(DESTROY_GRAPHICS);
    this.pathDisplay = null;
    this.entranceDisplay?.removeFromParent();
    this.entranceDisplay?.destroy(DESTROY_DISPLAY);
    this.entranceDisplay = null;
    this.drawnGateColours = null;
    this.drawnPathVersion = -1;
    this.sceneryInfluenceVersion = -1;
    this.sceneryInfluenceDirty = true;
  }

  async mount(host: HTMLElement): Promise<void> {
    if (this.destroyed) return;
    try {
      await this.app.init({
        background: '#9ed789',
        antialias: true,
        resizeTo: host,
        resolution: Math.min(window.devicePixelRatio, 2),
        autoDensity: true,
      });
    } catch (error) {
      // Nobody is waiting for this renderer any more; a failed init has nothing left to report.
      if (this.destroyed) return;
      throw error;
    }
    if (this.destroyed) {
      this.app.destroy(true, { children: true });
      return;
    }
    this.mounted = true;
    this.app.canvas.className = 'game-canvas';
    this.app.canvas.setAttribute('aria-label', 'Isometric theme park construction area');
    this.app.canvas.dataset.renderer = this.kind;
    host.appendChild(this.app.canvas);

    // The influence overlay sits above construction so decorated path tiles — the ones that
    // actually matter for appeal — are not hidden behind the opaque path graphics.
    this.camera.addChild(...this.cameraLayers());
    this.constructionLayer.sortableChildren = true;
    this.app.stage.addChild(this.camera, this.classicWeather.rainLayer);
    this.camera.scale.set(0.72);
    this.applyBackdrop();
    this.focusEntrance();
    this.drawTerrain();
    this.syncWorld();
    this.bindInput();
  }

  /** Runs `listener` at the ticker's NORMAL priority, before Pixi renders the stage at LOW. */
  onFrame(listener: (deltaMs: number) => void): void {
    this.app.ticker.add((ticker) => listener(ticker.deltaMS), undefined, UPDATE_PRIORITY.NORMAL);
  }

  setInputHandlers(handlers: WorldInputHandlers): void { this.handlers = handlers; }

  /** The armed tool is visible where the eye already is: on the cursor over the park. */
  setToolCursor(cursor: string): void {
    if (this.mounted) this.app.canvas.style.cursor = cursor;
  }

  /** The cell under the cursor, so a tool change can redraw its blueprint in place. */
  get hoveredCell(): Cell | null { return this.input?.hoveredCell ?? null; }
  get gestureHeld(): boolean { return this.input?.gestureHeld ?? false; }

  /**
   * The classic look of the day: one multiply tint on the camera container (day is exactly white).
   * The property is written only when the quantised colour changes, so a still sky costs nothing
   * and no display object is ever created or destroyed for it. The page backdrop stays untinted.
   */
  private machineryPaused = false;
  private pausedMs = 0;

  setMachineryPaused(paused: boolean): void {
    this.machineryPaused = paused;
  }

  setTimeOfDay(phase: number): void {
    dayWeights(this.dayMix, phase);
    this.timeKnown = true;
    this.applyTint(this.weatherLook.effects);
  }

  /** Weather presentation only: the view is copied and read by `update`; nothing flows back. */
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

  /** The time-of-day tint, dimmed by gloom and lifted by lightning; written only when the colour changes. */
  private applyTint(effects: Readonly<WeatherEffects>): void {
    if (!this.timeKnown) return;
    const tint = classicTint(this.dayMix, effects.gloom, effects.flash);
    if (tint === this.dayTint) return;
    this.dayTint = tint;
    this.camera.tint = tint;
  }

  setGridVisible(visible: boolean): void {
    this.showGrid = visible;
    this.clearTerrainCache();
    this.drawTerrain();
  }

  setSceneryInfluenceVisible(visible: boolean): void {
    this.showSceneryInfluence = visible;
    this.influenceLayer.visible = visible;
    if (visible) this.drawSceneryInfluence();
  }

  /** Test seam: how many static displays the scene is currently holding. */
  get staticDisplayCount(): number {
    return this.objectDisplays.size + (this.pathDisplay ? 1 : 0) + (this.entranceDisplay ? 1 : 0);
  }

  /** Test seam: how many prop displays the scene holds (Phase 24). */
  get propDisplayCount(): number { return this.propDisplays.size; }

  /** Test seam: whether a coaster layout in progress is still on screen. */
  get coasterDraftVisible(): boolean {
    return this.coasterDraftLayer.children.length > 0;
  }

  /**
   * Test seam: the raw scene bookkeeping, so an equivalence test can prove that the incremental
   * `syncWorld` converges on the same scene a from-scratch rebuild produces. Returns references,
   * not copies, and applies no normalisation — the test owns what "the same" means.
   */
  get sceneProbe(): SceneProbe {
    return {
      drawnPathVersion: this.drawnPathVersion,
      pathDisplay: this.pathDisplay,
      entranceDisplay: this.entranceDisplay,
      objects: [...this.objectDisplays.entries()].map(([objectId, display]) => ({
        objectId,
        container: display.container,
        base: display.base,
        isRide: display.isRide,
        pathEdges: display.pathEdges,
      })),
      rideDisplayIds: [...this.rideDisplays.keys()],
      animatedDisplayIds: [...this.animatedDisplays.keys()],
      rideArtTops: [...this.rideArtTops.entries()],
    };
  }

  /** Puts one cell in the middle of the viewport, keeping the current zoom. */
  focusCell(cell: Cell): void {
    const destination = this.project(cell.x, cell.y);
    this.camera.position.set(
      this.app.screen.width / 2 - destination.x * this.camera.scale.x,
      this.app.screen.height / 2 - destination.y * this.camera.scale.y,
    );
  }

  /** The start screen's sweep: `focusCell` for fractional coordinates, without allocating. */
  setCameraCentre(cellX: number, cellY: number): void {
    const centre = this.project(cellX, cellY);
    this.camera.position.set(
      this.app.screen.width / 2 - centre.x * this.camera.scale.x,
      this.app.screen.height / 2 - centre.y * this.camera.scale.y,
    );
  }

  /**
   * "Center camera on the park entrance". The rule is shared with the voxel camera (`entranceFocus`): when the gate
   * is at the bottom of the picture (Meadow in view 0) the long-standing framing applies, a cell 11 in front of the
   * gate at 18% of the screen height with the gate below it; in every other case the gate is elsewhere in the
   * picture, so the midpoint between the gate and the map centre is centred and both stay on screen whatever edge
   * the gate sits on. Presentation only; it always snaps.
   */
  focusEntrance(): void {
    const scale = this.camera.scale;
    const screen = this.app.screen;
    const focus = entranceFocus(this.view, this.world.entrance);
    if (focus.mode === 'anchor') {
      // The anchor is already a VIEW cell: project it without turning it again.
      const destinationX = (focus.viewX - focus.viewY) * (TILE_WIDTH / 2);
      const destinationY = (focus.viewX + focus.viewY) * (TILE_HEIGHT / 2);
      this.camera.position.set(
        screen.width / 2 - destinationX * scale.x,
        screen.height * 0.18 - destinationY * scale.y,
      );
      return;
    }
    const gate = this.project(this.world.entrance.x, this.world.entrance.y);
    const gateX = gate.x;
    const gateY = gate.y + TILE_HEIGHT / 2;
    // Phase 21: the heart is the middle of the owned land (the map centre on a wholly owned map).
    const heart = this.world.heart;
    const centre = this.project(heart.x, heart.y);
    const midX = (gateX + centre.x) / 2;
    const midY = (gateY + centre.y) / 2;
    this.camera.position.set(screen.width / 2 - midX * scale.x, screen.height / 2 - midY * scale.y);
  }

  /**
   * Brings the scene back in line with the world, touching only what changed. The construction
   * layer sorts by `zIndex`, so displays can be added in any order as objects appear.
   */
  syncWorld(): void {
    if (this.drawnPathVersion !== this.world.pathVersion) {
      this.drawnPathVersion = this.world.pathVersion;
      this.drawPaths();
      this.refreshRideBases();
    }
    if (!this.entranceDisplay) this.drawEntrance();
    else if ((this.world.gateColours ?? null) !== this.drawnGateColours) this.recolourEntrance();
    this.syncProps();
    for (const object of this.world.objects.values()) {
      if (!this.objectDisplays.has(object.id)) {
        this.createObjectDisplay(object);
        this.seeThroughDirty = true;
      }
    }
    for (const objectId of [...this.objectDisplays.keys()]) {
      if (!this.world.objects.has(objectId)) this.removeObjectDisplay(objectId);
    }
    this.syncObjectColours();
    this.sceneryInfluenceDirty = true;
    this.drawSceneryInfluence();
    this.refreshSelection();
  }

  /**
   * Phase 28: redraws the art of every object whose colour record changed since it was drawn, once. A
   * sync with nothing recoloured costs one identity compare per object and touches no display.
   */
  private syncObjectColours(): void {
    for (const [objectId, display] of this.objectDisplays) {
      const object = this.world.objects.get(objectId);
      if (!object) continue;
      const colours = object.colours ?? null;
      if (colours !== display.colours) this.recolourObject(object, display, colours);
    }
  }

  private recolourObject(object: PlacedObject, display: ObjectDisplay, colours: ObjectColours | null): void {
    const definition = BUILD_BY_ID.get(object.definitionId);
    display.colours = colours;
    if (!definition) return;
    setClassicView(this.view);
    this.seeThroughDirty = true;
    const coaster = this.world.coasters.get(object.id);
    if (coaster) {
      // The track is one Graphics: cleared and drawn again in place, as a view turn does. The train is rebuilt
      // once by the next `syncCoasterTrains` (its hull and stripe colours are baked into its Graphics).
      const track = display.container as Graphics;
      track.clear();
      this.drawCoasterTrack(track, coaster.pieces, definition.color, true, 1, definition.id, colours);
      const trackBounds = track.getLocalBounds();
      display.left = trackBounds.minX;
      display.top = trackBounds.minY;
      display.right = trackBounds.maxX;
      display.bottom = trackBounds.maxY;
      const train = this.coasterTrains.get(object.id);
      if (train) {
        train.container.removeFromParent();
        train.container.destroy(DESTROY_DISPLAY);
        this.coasterTrains.delete(object.id);
      }
      return;
    }
    const group = display.container;
    if (definition.kind === 'ride') this.recolourRide(object, definition, display);
    else if (display.art) {
      const index = Math.max(0, group.getChildIndex(display.art));
      group.removeChild(display.art);
      display.art.destroy(DESTROY_DISPLAY);
      display.art = createObjectArt(definition, colours);
      group.addChildAt(display.art, index);
      const animated = this.animatedDisplays.get(object.id);
      if (animated) animated.container = display.art;
    } else return;
    const bounds = group.getLocalBounds();
    display.left = group.x + bounds.minX;
    display.top = group.y + bounds.minY;
    display.right = group.x + bounds.maxX;
    display.bottom = group.y + bounds.maxY;
  }

  /**
   * Swaps one ride's machinery for a fresh drawing in the new colours. The plot, fence, sort key and
   * motion state are kept (they live on the object display and the ride display, not in the art);
   * the old art and the spare art of the other footprint axis are destroyed with their GPU buffers,
   * since the spare was drawn in the old colours.
   */
  private recolourRide(object: PlacedObject, definition: BuildDefinition, display: ObjectDisplay): void {
    const ride = this.rideDisplays.get(object.id);
    if (!ride) return;
    const group = display.container;
    const index = Math.max(0, group.getChildIndex(ride.art.container));
    group.removeChild(ride.art.container);
    ride.art.container.destroy(DESTROY_DISPLAY);
    ride.spareArt?.container.destroy(DESTROY_DISPLAY);
    ride.spareArt = null;
    ride.art = createRideArt(definition, rotationInView(object.rotation, this.view.rotation), display.colours);
    group.addChildAt(ride.art.container, index);
    this.rideArtTops.set(object.id, ride.art.container.getLocalBounds().minY);
  }

  /** The entrance gate drawn again in the park's gate colours (once per change; the group keeps its place and sort key). */
  private recolourEntrance(): void {
    const group = this.entranceDisplay;
    if (!group) return;
    this.drawnGateColours = this.world.gateColours ?? null;
    for (const child of group.removeChildren()) child.destroy(DESTROY_DISPLAY);
    drawEntranceArt(group, this.drawnGateColours);
  }

  private removeObjectDisplay(objectId: number): void {
    const display = this.objectDisplays.get(objectId);
    if (!display) return;
    this.seeThroughFader.forget(display.container);
    this.seeThroughDirty = true;
    display.container.removeFromParent();
    display.container.destroy(DESTROY_DISPLAY);
    this.rideDisplays.get(objectId)?.spareArt?.container.destroy(DESTROY_DISPLAY);
    this.objectDisplays.delete(objectId);
    this.rideDisplays.delete(objectId);
    this.animatedDisplays.delete(objectId);
    this.rideArtTops.delete(objectId);
  }

  /**
   * A ride's fence opens wherever a path touches its plot, so a path edit invalidates the plot
   * art — and nothing else. The machinery above it is expensive and stays exactly as it was.
   */
  private refreshRideBases(): void {
    for (const [objectId, display] of this.objectDisplays) {
      if (!display.isRide || !display.base) continue;
      const object = this.world.objects.get(objectId);
      const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
      if (!object || !definition) continue;
      // Most path edits happen nowhere near most rides. Comparing which plot edges a path
      // touches is a handful of set lookups; rebuilding a fence is a hundred drawing calls.
      const pathEdges = this.plotPathEdges(object);
      if (pathEdges === display.pathEdges) continue;
      display.pathEdges = pathEdges;
      const replacement = this.createObjectBase(definition, object, display.centerCell);
      display.container.removeChild(display.base);
      display.base.destroy(DESTROY_GRAPHICS);
      display.container.addChildAt(replacement, 0);
      display.base = replacement;
    }
  }

  /** Stable description of where paths touch a plot — the only path fact its art depends on. */
  private plotPathEdges(object: PlacedObject): string {
    const cells = this.world.objectFootprint(object);
    const occupied = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    let signature = '';
    for (const cell of cells) {
      for (const direction of CARDINAL_DIRECTIONS) {
        const key = `${cell.x + direction.x},${cell.y + direction.y}`;
        signature += occupied.has(key) ? 'o' : this.world.paths.has(key) ? 'p' : '.';
      }
    }
    return signature;
  }

  selectObject(object: PlacedObject | null): void {
    this.selectedObjectId = object?.id ?? null;
    this.refreshSelection();
  }

  drawPreview(
    cells: readonly Cell[],
    definition: BuildDefinition | null,
    valid: boolean,
    bulldoze = false,
    rotation: Rotation = 0,
    colours: ObjectColours | null = null,
  ): void {
    this.clearPreview();
    if (cells.length === 0) return;
    this.lastPreview = { cells, definition, valid, bulldoze, rotation, colours };
    this.previewCells = cells;
    this.previewMode = bulldoze ? 'bulldoze' : definition?.kind === 'path' ? 'cell' : 'place';
    if (definition?.kind === 'scenery' && definition.stats?.sceneryAppeal) {
      this.drawSceneryPreview(cells, definition);
    }
    const graphic = new Graphics();
    const fill = previewFill(valid, bulldoze);
    for (const cell of cells) {
      const point = this.project(cell.x, cell.y);
      graphic.poly(diamondPoints(point.x, point.y, 3)).fill({ color: fill, alpha: 0.5 }).stroke({ color: 0xffffff, alpha: 0.88, width: 2 });
    }
    this.previewLayer.addChild(graphic);
    if (definition && definition.kind !== 'path') this.drawPreviewArt(cells, definition, rotation, valid, bulldoze ? null : colours);
  }

  /**
   * The blueprint shows the building itself, at rest and ghosted, so what the player lines up
   * is exactly what gets built — footprint and machinery together.
   */
  private drawPreviewArt(
    cells: readonly Cell[],
    definition: BuildDefinition,
    rotation: Rotation,
    valid: boolean,
    colours: ObjectColours | null,
  ): void {
    const [width, depth] = footprintSize(definition, rotation);
    const anchorX = Math.min(...cells.map((cell) => cell.x));
    const anchorY = Math.min(...cells.map((cell) => cell.y));
    const center = this.project(anchorX + (width - 1) / 2, anchorY + (depth - 1) / 2);
    const group = new Container({ x: center.x, y: center.y + TILE_HEIGHT / 2 });
    if (definition.kind === 'ride') {
      // The build rotation keeps its WORLD meaning: the art is drawn as that rotation seen in this view.
      const art = createRideArt(definition, rotationInView(rotation, this.view.rotation), colours);
      art.animate({ spin: 0, motion: 0, progress: 0, elapsedMs: 0, status: 'closed' });
      group.addChild(art.container);
    } else {
      group.addChild(createObjectArt(definition, colours));
    }
    group.alpha = valid ? 0.6 : 0.35;
    this.previewLayer.addChild(group);
  }

  clearPreview(): void {
    this.lastPreview = null;
    // The paint hover shares this layer but not its lifetime: it is cleared by `setPaintHover` alone.
    this.previewCells = this.paintHoverCells ?? NO_CELLS;
    for (const child of [...this.previewLayer.children]) {
      if (child === this.paintHoverGraphic) continue;
      this.previewLayer.removeChild(child);
      child.destroy(DESTROY_DISPLAY);
    }
  }

  /**
   * Phase 28 step 2: the Paint tool's hover. An outline and (with a tint) a light fill of the target's cells in
   * one pooled Graphics, redrawn only when the cells or the tint change; the see-through treats the target
   * like a bulldoze target (it stays intact, what is in front of it fades). Equal input is free; null clears.
   */
  setPaintHover(hover: Readonly<PaintHover> | null): void {
    if (hover === null || hover.cells.length === 0) {
      if (this.paintHoverCells === null) return;
      this.paintHoverCells = null;
      this.paintHoverTint = null;
      this.paintHoverGraphic?.clear();
      this.paintHoverGraphic?.removeFromParent();
      this.previewCells = this.lastPreview?.cells ?? NO_CELLS;
      this.seeThroughDirty = true;
      return;
    }
    const previous = this.paintHoverCells;
    if (previous !== null && this.paintHoverTint === hover.tint && previous.length === hover.cells.length
      && previous.every((cell, index) => cell.x === hover.cells[index].x && cell.y === hover.cells[index].y)) return;
    this.paintHoverCells = hover.cells.map((cell) => ({ x: cell.x, y: cell.y }));
    this.paintHoverTint = hover.tint;
    const graphic = this.paintHoverGraphic ?? (this.paintHoverGraphic = new Graphics());
    graphic.clear();
    for (const cell of this.paintHoverCells) {
      const point = this.project(cell.x, cell.y);
      const shape = graphic.poly(diamondPoints(point.x, point.y, 2));
      if (hover.tint !== null) shape.fill({ color: hover.tint, alpha: 0.25 });
      shape.stroke({ color: 0xffffff, alpha: 0.95, width: 2.5 });
    }
    if (graphic.parent !== this.previewLayer) this.previewLayer.addChildAt(graphic, 0);
    this.previewCells = this.paintHoverCells;
    this.previewMode = 'bulldoze';
    this.seeThroughDirty = true;
  }

  /**
   * Back to front. The selection ring, hint ring and previews come after the construction layer,
   * so a building in front never hides them (see-through item 5; pinned by a test).
   */
  cameraLayers(): Container[] {
    return [
      this.terrainLayer,
      this.constructionLayer,
      this.trainLayer,
      this.classicWeather.cloudLayer,
      this.influenceLayer,
      this.selectionLayer,
      this.hintLayer,
      this.coasterDraftLayer,
      this.previewLayer,
    ];
  }

  /** GameApp's see-through request (armed tool, held peek key). Copied: the caller reuses its object. */
  setSeeThrough(request: Readonly<SeeThroughRequest>): void {
    this.seeThroughRequest.armed = request.armed;
    this.seeThroughRequest.peek = request.peek;
  }

  /**
   * Resolves the focus every frame (no allocation) but searches for overlapping objects only when
   * it changed. A presentation fault disables the effect instead of breaking the frame.
   */
  private updateSeeThrough(deltaMs: number): void {
    const focus = this.seeThroughFocus;
    const valid = resolveSeeThroughFocus(
      this.seeThroughRequest, this.hoveredCell, this.previewCells, this.previewMode, 0, focus,
    );
    const applied = this.seeThroughApplied;
    const changed = this.seeThroughDirty
      || valid !== this.seeThroughAppliedValid
      || (valid && (focus.minX !== applied.minX || focus.minY !== applied.minY || focus.maxX !== applied.maxX
        || focus.maxY !== applied.maxY || focus.mode !== applied.mode || focus.peek !== applied.peek));
    if (changed) {
      this.seeThroughDirty = false;
      this.seeThroughAppliedValid = valid;
      if (valid) {
        applied.minX = focus.minX;
        applied.minY = focus.minY;
        applied.maxX = focus.maxX;
        applied.maxY = focus.maxY;
        applied.mode = focus.mode;
        applied.peek = focus.peek;
      }
      this.seeThroughFader.setFocus(
        valid ? this.focusInView(focus) : null, this.seeThroughCandidates(), this.demolitionKey(focus, valid),
      );
    }
    this.seeThroughFader.step(deltaMs);
  }

  /** The focus rectangle (world cells) as the current view sees it: the fader works in view space only. */
  private focusInView(focus: Readonly<SeeThroughFocus>): Readonly<SeeThroughFocus> {
    if (this.view.rotation === 0) return focus;
    const out = this.seeThroughViewFocus;
    cellToView(this.view, focus.minX, focus.minY, this.viewCell);
    const ax = this.viewCell.x;
    const ay = this.viewCell.y;
    cellToView(this.view, focus.maxX, focus.maxY, this.viewCell);
    out.minX = Math.min(ax, this.viewCell.x);
    out.maxX = Math.max(ax, this.viewCell.x);
    out.minY = Math.min(ay, this.viewCell.y);
    out.maxY = Math.max(ay, this.viewCell.y);
    out.mode = focus.mode;
    out.peek = focus.peek;
    out.heightVoxels = focus.heightVoxels;
    return out;
  }

  /** Everything that may fade in front of the focus: the objects, then the props (only when the map has any). Runs when the focus changes, never per frame. */
  private *seeThroughCandidates(): Generator<SeeThroughCandidate> {
    yield* this.objectDisplays.values();
    if (this.propDisplays.size > 0) yield* this.propDisplays.values();
  }

  /** Bulldoze: the sort key of the object (or prop) under the cursor, which must stay opaque. */
  private demolitionKey(focus: Readonly<SeeThroughFocus>, valid: boolean): number {
    if (!valid || focus.mode !== 'bulldoze') return Number.NEGATIVE_INFINITY;
    const prop = this.world.propAt({ x: focus.minX, y: focus.minY });
    const propDisplay = prop === undefined ? undefined : this.propDisplays.get(prop.id);
    if (propDisplay) return propDisplay.sortKey;
    const object = this.world.objectAt({ x: focus.minX, y: focus.minY });
    const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
    if (!object || !definition) return Number.NEGATIVE_INFINITY;
    return this.objectSortKey(object, definition);
  }

  update(deltaMs: number, elapsedMs: number): void {
    this.lastElapsedMs = elapsedMs;
    this.input?.keyPan(deltaMs);
    if (this.turnVeilElapsedMs !== null) this.stepTurnVeil(deltaMs);
    try {
      this.updateSeeThrough(deltaMs);
    } catch (error) {
      console.warn('classic see-through disabled', error);
      this.seeThroughFader.clear();
      this.seeThroughRequest.armed = false;
      this.seeThroughRequest.peek = false;
    }
    this.syncGuests(elapsedMs);
    this.syncOperations(elapsedMs);
    for (const item of this.animatedDisplays.values()) {
      item.container.scale.set(1 + Math.sin(elapsedMs * 0.0015 + item.phase) * 0.015);
    }
    if (this.machineryPaused) this.pausedMs += deltaMs;
    this.syncRideMachinery(this.machineryPaused ? 0 : deltaMs, elapsedMs - this.pausedMs);
    this.syncCoasterTrains();
    // One property write, no allocation; static under reduced motion.
    if (this.hintLayer.visible && this.hintLayer.children.length > 0) {
      this.hintLayer.alpha = reducedMotion() ? 0.9 : 0.7 + 0.3 * Math.sin(elapsedMs / 260);
    }
    const effects = this.weatherLook.update(this.weatherView, this.dayMix, deltaMs, this.machineryPaused);
    this.classicWeather.apply(effects);
    this.applyTint(effects);
    const now = performance.now();
    const instantaneous = 1000 / Math.max(1, now - this.lastFrameAt);
    this.fps += (instantaneous - this.fps) * 0.08;
    this.lastFrameAt = now;
    this.renderMs = deltaMs;
  }

  /**
   * `entities` is a total, not a visible count: nothing is culled yet. It was labelled VISIBLE,
   * which made every frame-rate investigation start from a false premise (PA-017). Phase 11B
   * turns it into a real visible count if culling is needed.
   */
  getPerformance(): RendererPerformance {
    return {
      fps: this.fps,
      renderMs: this.renderMs,
      entities: this.world.objects.size
        + this.world.paths.size
        + this.guests.guests.size
        + this.workerDisplays.size
        + this.litterDisplays.size,
    };
  }

  /** Idempotent. Before mount resolves it only marks the renderer; mount then cleans up. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopWatchingPresentation?.();
    this.stopWatchingPresentation = null;
    // Built by a field initialiser, so it is released even when the renderer never mounted.
    this.classicWeather.destroy();
    this.seeThroughFader.clear();
    this.turnVeilElapsedMs = null;
    this.turnVeil?.removeFromParent();
    this.turnVeil?.destroy();
    this.turnVeil = null;
    setClassicView(createViewFrame());
    // The pooled draft Graphics may be parked outside the layer tree; release its context either way.
    this.coasterDraftGraphic?.removeFromParent();
    this.coasterDraftGraphic?.destroy(DESTROY_GRAPHICS);
    this.coasterDraftGraphic = null;
    this.paintHoverGraphic?.removeFromParent();
    this.paintHoverGraphic?.destroy(DESTROY_GRAPHICS);
    this.paintHoverGraphic = null;
    this.paintHoverCells = null;
    // Spare ride machinery and cached terrain of other views are parked outside the layer tree; the
    // app destroys the live ones.
    for (const ride of this.rideDisplays.values()) {
      ride.spareArt?.container.destroy(DESTROY_DISPLAY);
      ride.spareArt = null;
    }
    for (const terrain of this.terrainCache.values()) if (!terrain.parent) terrain.destroy(DESTROY_GRAPHICS);
    this.terrainCache.clear();
    if (!this.mounted) return;
    this.mounted = false;
    this.input?.destroy();
    this.input = null;
    this.app.destroy(true, { children: true });
  }

  /**
   * The terrain only depends on the view through two facts: whether the map's sides swap (an odd
   * turn of a non-square map) and which checker colour a view cell gets. Each such class is drawn
   * once and kept, so a view turn swaps a cached Graphics in instead of re-tessellating the map.
   */
  private terrainKey(): number {
    cellToView(this.view, 0, 0, this.viewCell);
    return (this.view.rotation & 1) * 2 + ((this.viewCell.x + this.viewCell.y) & 1);
  }

  /** Drops every cached terrain Graphics (the grid toggle changes them all). */
  private clearTerrainCache(): void {
    this.terrainLayer.removeChildren();
    for (const terrain of this.terrainCache.values()) terrain.destroy(DESTROY_GRAPHICS);
    this.terrainCache.clear();
  }

  private drawTerrain(): void {
    const groundKey = this.world.map.groundKey;
    if (groundKey !== this.terrainGroundKey) {
      this.clearTerrainCache();
      this.terrainGroundKey = groundKey;
    }
    const key = this.terrainKey();
    const cached = this.terrainCache.get(key);
    if (cached) {
      if (cached.parent !== this.terrainLayer) {
        this.terrainLayer.removeChildren();
        this.terrainLayer.addChild(cached);
      }
      return;
    }
    this.terrainLayer.removeChildren();
    const terrain = new Graphics();
    this.terrainCache.set(key, terrain);
    // Each ground kind has an even and an odd diamond (the checker); Meadow's base is exactly the lawn it always was.
    const ground = this.world.biome.ground;
    const kinds = [ground.base, ground.alt, ground.water];
    const cells = this.world.map.ground;
    for (let y = 0; y < this.world.height; y += 1) {
      for (let x = 0; x < this.world.width; x += 1) {
        const point = this.project(x, y);
        const colours = kinds[cells[y * this.world.width + x]] ?? ground.base;
        const color = (x + y) % 2 === 0 ? colours.rgb : colours.secondary;
        terrain.poly(diamondPoints(point.x, point.y)).fill(color);
        if (this.showGrid) terrain.stroke({ color: ground.classic.grid, alpha: 0.28, width: 1 });
      }
    }
    this.terrainLayer.addChild(terrain);
  }

  /** The page colour behind the map (what shows past its edge): Meadow's own, a light tone of the ground elsewhere. */
  private applyBackdrop(): void {
    const background = this.mounted ? this.app.renderer?.background : undefined;
    if (!background) return;
    const biome = this.world.biome;
    background.color = biome.id === DEFAULT_BIOME_ID ? 0x9ed789 : backdropOf(biome.ground.base.rgb);
  }

  private drawSceneryInfluence(): void {
    // A hidden heatmap is not worth building. Construction only marks it dirty; the toggle pays
    // for it. Before this, every placed bench re-tessellated the whole influence overlay.
    if (!this.showSceneryInfluence) {
      this.influenceLayer.visible = false;
      return;
    }
    const snapshot = this.scenery.snapshot();
    if (snapshot.version === this.sceneryInfluenceVersion
      && !this.sceneryInfluenceDirty
      && this.influenceLayer.children.length > 0) {
      this.influenceLayer.visible = true;
      return;
    }
    this.sceneryInfluenceDirty = false;
    this.sceneryInfluenceVersion = snapshot.version;
    this.influenceLayer.removeChildren().forEach((child) => child.destroy(DESTROY_GRAPHICS));
    const graphic = new Graphics();
    const covered = new Set(snapshot.cells.map((entry) => `${entry.cell.x},${entry.cell.y}`));
    for (const entry of snapshot.cells) {
      const point = this.project(entry.cell.x, entry.cell.y);
      graphic.poly(diamondPoints(point.x, point.y, 1)).fill({
        color: influenceColor(entry.score),
        alpha: INFLUENCE_BASE_ALPHA + entry.score / 100 * INFLUENCE_SCORE_ALPHA,
      });
    }
    for (const entry of snapshot.cells) {
      if (!isInfluenceEdge(entry.cell, covered)) continue;
      const point = this.project(entry.cell.x, entry.cell.y);
      graphic.poly(diamondPoints(point.x, point.y, 1))
        .stroke({ color: INFLUENCE_EDGE_COLOR, alpha: 0.9, width: 2 });
    }
    this.influenceLayer.addChild(graphic);
    this.influenceLayer.visible = this.showSceneryInfluence;
  }

  private drawSceneryPreview(cells: readonly Cell[], definition: BuildDefinition): void {
    const radius = Math.max(0, Math.floor(definition.stats?.sceneryRadius ?? 0));
    const appeal = Math.max(0, definition.stats?.sceneryAppeal ?? 0);
    if (appeal <= 0) return;
    const influence = new Graphics();
    const minimumX = Math.max(0, Math.min(...cells.map((cell) => cell.x)) - radius);
    const maximumX = Math.min(this.world.width - 1, Math.max(...cells.map((cell) => cell.x)) + radius);
    const minimumY = Math.max(0, Math.min(...cells.map((cell) => cell.y)) - radius);
    const maximumY = Math.min(this.world.height - 1, Math.max(...cells.map((cell) => cell.y)) + radius);
    const distanceTo = (cell: Cell): number =>
      Math.min(...cells.map((source) => Math.abs(source.x - cell.x) + Math.abs(source.y - cell.y)));
    const covered = new Set<string>();
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        if (distanceTo({ x, y }) <= radius) covered.add(`${x},${y}`);
      }
    }
    for (const key of covered) {
      const [x, y] = key.split(',').map(Number);
      const contribution = appeal * (radius + 1 - distanceTo({ x, y })) / (radius + 1);
      const point = this.project(x, y);
      influence.poly(diamondPoints(point.x, point.y, 1)).fill({
        color: influenceColor(contribution),
        alpha: INFLUENCE_BASE_ALPHA + contribution / 100 * INFLUENCE_SCORE_ALPHA,
      });
    }
    for (const key of covered) {
      const [x, y] = key.split(',').map(Number);
      if (!isInfluenceEdge({ x, y }, covered)) continue;
      const point = this.project(x, y);
      influence.poly(diamondPoints(point.x, point.y, 1))
        .stroke({ color: INFLUENCE_EDGE_COLOR, alpha: 0.95, width: 2.5 });
    }
    this.previewLayer.addChild(influence);
  }

  /** World-space center of a track piece, lifted by its height level. */
  private coasterPoint(piece: CoasterPiece): { x: number; y: number } {
    const point = this.project(piece.cell.x, piece.cell.y);
    return { x: point.x, y: point.y + TILE_HEIGHT / 2 - piece.height * COASTER_ELEVATION_PX };
  }

  /** Strokes polylines ([x0, y0, x1, y1, …] each) with one style. */
  private static strokeRuns(graphic: Graphics, runs: readonly number[][], style: { color: number; width: number; alpha: number }): void {
    let any = false;
    for (const run of runs) {
      for (let at = 0; at + 1 < run.length; at += 2) {
        if (at === 0) graphic.moveTo(run[0], run[1]);
        else graphic.lineTo(run[at], run[at + 1]);
        any = true;
      }
    }
    if (any) graphic.stroke({ color: style.color, width: style.width, alpha: style.alpha, join: 'round', cap: 'round' });
  }

  /** Strokes [x1, y1, x2, y2] lines with one style. */
  private static strokeLines(graphic: Graphics, lines: readonly number[], style: { color: number; width: number; alpha: number }): void {
    if (lines.length < 4) return;
    for (let at = 0; at + 3 < lines.length; at += 4) {
      graphic.moveTo(lines[at], lines[at + 1]).lineTo(lines[at + 2], lines[at + 3]);
    }
    graphic.stroke({ color: style.color, width: style.width, alpha: style.alpha, cap: 'round' });
  }

  /**
   * Draws a coaster's structure once (classicCoaster.ts has the geometry): supports behind, then the
   * station platform, the spine, ties, both rails, the chain and brake, and the station canopy in
   * front. Everything is one Graphics, built at construction and never touched per frame.
   */
  private drawCoasterTrack(
    graphic: Graphics,
    pieces: readonly CoasterPiece[],
    color: number,
    closed: boolean,
    alpha = 1,
    definitionId?: string,
    colours: ObjectColours | null = null,
  ): void {
    if (pieces.length === 0) return;
    setClassicView(this.view);
    // An open draft is drawn as the ring it would be built on (see openDraftRing), its scratch
    // lead-in and run-out skipped, so the ghost and the finished coaster show the same curve.
    const ring = closed ? pieces : openDraftRing(pieces);
    const line = centreLineFor(ring);
    const offset = closed ? 0 : 1;
    const stationLength = GAME_CONFIG.coaster.stationLength;
    const palette = classicCoasterPalette(definitionId, color, colours);
    for (const [index, piece] of pieces.entries()) {
      const ground = this.project(piece.cell.x, piece.cell.y);
      const isStation = index < stationLength;
      graphic.poly(diamondPoints(ground.x, ground.y, 3)).fill({
        color: isStation ? palette.ground : color,
        alpha: (isStation ? 0.4 : 0.18) * alpha,
      });
    }
    if (pieces.length < 2 && !closed) return;
    const boostTiles: number[] = [];
    for (const [index, piece] of pieces.entries()) {
      if (piece.special === 'boost') boostTiles.push(index + offset);
    }
    const geometry = buildClassicTrack(line, offset, offset + pieces.length - 1, { closed, stationLength, boostTiles });
    this.strokeCoasterGeometry(graphic, geometry, palette, alpha);
  }

  private strokeCoasterGeometry(
    graphic: Graphics,
    geometry: ClassicTrackGeometry,
    palette: ReturnType<typeof classicCoasterPalette>,
    alpha: number,
  ): void {
    const common = CLASSIC_COASTER_COMMON;
    for (const support of geometry.supports) {
      WorldRenderer.strokeLines(graphic, support.braces, { color: palette.support, width: 1.5, alpha: alpha * 0.9 });
      WorldRenderer.strokeLines(graphic, support.legs, { color: palette.support, width: 2.5, alpha });
      for (let at = 0; at + 3 < support.legs.length; at += 4) {
        graphic.ellipse(support.legs[at], support.legs[at + 1], 3, 1.6).fill({ color: common.footing, alpha });
      }
    }
    for (const station of geometry.stations) {
      graphic.poly(station.platform).fill({ color: common.platform, alpha: alpha * 0.95 });
      WorldRenderer.strokeLines(graphic, station.platformEdge, { color: palette.edge, width: 2, alpha });
    }
    WorldRenderer.strokeRuns(graphic, geometry.spine, { color: palette.spine, width: 2, alpha });
    WorldRenderer.strokeLines(graphic, geometry.ties, { color: palette.tie, width: 1.6, alpha });
    WorldRenderer.strokeRuns(graphic, geometry.left, { color: palette.rail, width: 2, alpha });
    WorldRenderer.strokeRuns(graphic, geometry.right, { color: palette.rail, width: 2, alpha });
    WorldRenderer.strokeLines(graphic, geometry.chain, { color: common.chain, width: 2, alpha });
    WorldRenderer.strokeRuns(graphic, [geometry.brake], { color: common.brake, width: 3, alpha });
    WorldRenderer.strokeLines(graphic, geometry.brakeFin, { color: common.brake, width: 2, alpha });
    WorldRenderer.strokeRuns(graphic, geometry.chevrons, { color: common.chevron, width: 2.5, alpha });
    for (const station of geometry.stations) {
      WorldRenderer.strokeLines(graphic, station.post, { color: common.post, width: 2, alpha });
      WorldRenderer.strokeLines(graphic, station.gate, { color: palette.rail, width: 2, alpha });
      if (station.light.length >= 6) {
        WorldRenderer.strokeLines(graphic, station.light, { color: common.post, width: 2, alpha });
        graphic.circle(station.light[4], station.light[5], 2.2).fill({ color: common.bulb, alpha });
      }
      graphic.poly(station.canopy).fill({ color: palette.canopy, alpha: alpha * 0.95 });
      WorldRenderer.strokeLines(graphic, station.valance, { color: palette.rail, width: 2, alpha });
    }
  }

  /**
   * Redraws the layout in progress into one pooled Graphics (cleared, never replaced). It survives
   * every hover, and dims to show it is parked while another tool is armed — the pieces are still
   * yours to come back to.
   */
  drawCoasterDraft(
    pieces: readonly CoasterPiece[],
    color: number,
    armed = true,
    definitionId?: string,
    colours: ObjectColours | null = null,
  ): void {
    this.coasterDraftLayer.alpha = armed ? 1 : 0.45;
    this.lastDraft = pieces.length === 0 ? null : { pieces: [...pieces], color, armed, definitionId, colours };
    let graphic = this.coasterDraftGraphic;
    if (pieces.length === 0) {
      if (graphic) {
        graphic.clear();
        graphic.removeFromParent();
      }
      return;
    }
    if (!graphic) {
      graphic = new Graphics();
      this.coasterDraftGraphic = graphic;
    } else {
      graphic.clear();
    }
    // Blocked cells (occupied ground, or a path under low track) glow red under the track.
    for (const piece of pieces) {
      if (this.world.canPlaceCoasterPiece(piece)) continue;
      const point = this.project(piece.cell.x, piece.cell.y);
      graphic.poly(diamondPoints(point.x, point.y, 2)).fill({ color: 0xff6f86, alpha: 0.5 });
    }
    const last = pieces[pieces.length - 1];
    const closable = layoutCanClose(pieces);
    this.drawCoasterTrack(graphic, pieces, color, closable, 0.85, definitionId, colours);
    if (!closable && pieces.length >= 2) {
      // A dotted guide back to the station reminds the player the loop must close.
      const from = this.coasterPoint(last);
      const to = this.coasterPoint(pieces[0]);
      graphic.moveTo(from.x, from.y).lineTo(to.x, to.y)
        .stroke({ color: 0xffffff, width: 1.5, alpha: 0.5 });
    }
    if (!graphic.parent) this.coasterDraftLayer.addChild(graphic);
  }

  private syncCoasterTrains(): void {
    // Per frame: scalars and one reused car frame only. The train rides the same centre line the
    // track is drawn from (centreLine.ts), on the car frame the voxel cars use (coasterCarFrame.ts: the
    // bogie chord and the banked up axis), so a car is on the same spot in both views; the display
    // objects are built once and moved by transform.
    const frame = this.trainFrame;
    setClassicView(this.view);
    let liveCount = 0;
    for (const [objectId, record] of this.world.coasters) {
      liveCount += 1;
      const runtime = this.rides.getRide(objectId);
      let train = this.coasterTrains.get(objectId);
      if (!train) {
        const object = this.world.objects.get(objectId);
        const type = COASTER_TYPE_BY_ID.get(object?.definitionId ?? '');
        const cars = type?.trainCars ?? 4;
        train = createClassicTrain(cars, classicTrainSpec(object?.definitionId, object?.colours ?? null), type?.trainCapacity ?? cars * 2);
        this.trainLayer.addChild(train.container);
        this.coasterTrains.set(objectId, train);
      }
      // Timing is shared with the voxel renderer (coasterHeadIndex, cell-based); the centre line maps
      // the piece index onto arc length, so the lap time is the gameplay one.
      const headIndex = coasterHeadIndex(record, runtime?.status === 'running'
        ? runtime.cycleRemainingSeconds
        : null);
      const line = centreLineFor(record.pieces);
      const headDistance = centreLineIndexToDistance(line, headIndex);
      // Riders fill the same cars as in the voxel view (coasterLoadedCars), never on a parked or
      // loading train.
      const carCount = train.cars.length;
      setClassicLoadedCars(train, runtime === undefined
        ? 0
        : coasterLoadedCars(runtime.status, runtime.riderGuestIds.length, train.capacity, carCount));
      const lean = this.trainLean;
      let hasTail = false;
      let tailX = 0;
      let tailY = 0;
      for (let index = 0; index < carCount; index += 1) {
        const car = train.cars[index];
        coasterCarFrame(line, headDistance, index, frame);
        const x = trackScreenX(frame.x, frame.y);
        const y = trackScreenY(frame.x, frame.y, frame.z) - COASTER_CAR_LIFT_PX;
        const dx = classicOffsetX(frame.forwardX, frame.forwardY);
        const dy = classicOffsetY(frame.forwardX, frame.forwardY, frame.forwardZ);
        const length = Math.hypot(dx, dy) || 1;
        const halfLength = car.halfLength;
        car.root.position.set(x, y);
        car.root.rotation = Math.atan2(dy, dx);
        // Banking: the seats and riders lean into the turn, like the voxel cars.
        classicCarLean(frame, car.root.rotation, lean);
        car.upper.position.set(lean.x, lean.y);
        if (hasTail) {
          stretchSegment(train.couplings[index - 1], tailX, tailY, x + (dx / length) * halfLength, y + (dy / length) * halfLength);
        }
        hasTail = true;
        tailX = x - (dx / length) * halfLength;
        tailY = y - (dy / length) * halfLength;
      }
    }
    if (liveCount === this.coasterTrains.size) return;
    for (const [objectId, train] of this.coasterTrains) {
      if (this.world.coasters.has(objectId)) continue;
      train.container.removeFromParent();
      train.container.destroy(DESTROY_DISPLAY);
      this.coasterTrains.delete(objectId);
    }
  }

  /**
   * Drives every ride's moving parts. Motion eases toward the target the ride's status implies,
   * and the spin accumulator advances with it, so a machine coasts to a stop on closure and
   * picks up from the same angle when it reopens.
   */
  private syncRideMachinery(deltaMs: number, elapsedMs: number): void {
    for (const display of this.rideDisplays.values()) {
      const runtime = this.rides.getRide(display.objectId);
      const status = runtime?.status ?? 'closed';
      const target = status === 'running' ? 1 : status === 'idle' || status === 'waiting' ? 0.14 : 0;
      display.motion += (target - display.motion) * Math.min(1, deltaMs / 420);
      display.spin += deltaMs * display.motion;
      const duration = this.world.rideProfile(display.objectId)?.duration ?? 0;
      const progress = status === 'running' && duration > 0
        ? Math.min(1, Math.max(0, 1 - (runtime?.cycleRemainingSeconds ?? 0) / duration))
        : 0;
      display.art.animate({
        spin: display.spin + display.phase,
        motion: display.motion,
        progress,
        elapsedMs,
        status,
      });
    }
  }

  /** One graphic for the whole walkway network, rebuilt only when the path version moves. */
  private drawPaths(): void {
    // One Graphics for every path tile, redrawn in place (a path edit or a view turn).
    const paths = this.pathDisplay ?? new Graphics();
    paths.clear();
    paths.zIndex = -1;
    const ground = this.world.biome.ground;
    for (const key of this.world.paths) {
      const [x, y] = key.split(',').map(Number);
      const point = this.project(x, y);
      paths.poly(diamondPoints(point.x, point.y, 2)).fill(ground.paving.rgb).stroke({ color: ground.curb.rgb, width: 1.5 });
      paths.circle(point.x, point.y + TILE_HEIGHT / 2, 2).fill({ color: ground.classic.pathDot, alpha: 0.65 });
    }
    if (this.pathDisplay !== paths) {
      this.pathDisplay = paths;
      this.constructionLayer.addChild(paths);
    }
  }

  private drawEntrance(): void {
    const point = this.project(this.world.entrance.x, this.world.entrance.y);
    const group = new Container({ x: point.x, y: point.y + TILE_HEIGHT / 2 });
    group.zIndex = this.cellSortKey(this.world.entrance.x, this.world.entrance.y);
    this.drawnGateColours = this.world.gateColours ?? null;
    drawEntranceArt(group, this.drawnGateColours);
    this.entranceDisplay = group;
    this.constructionLayer.addChild(group);
  }

  /** Which view axis a prop's long side lies along, given the current view (0 = view x). Square footprints are 0. */
  private propAlong(prop: PropPlacement, kind: PropKindDefinition): 0 | 1 {
    const [width, depth] = propFootprintSize(kind, prop.rotation);
    if (width === depth) return 0;
    const worldAxis = width > depth ? 0 : 1;
    return (worldAxis ^ (this.view.rotation & 1)) as 0 | 1;
  }

  /** Sort key of a prop's footprint as the current view sees it (the same rule as an object's). */
  private propSortKey(prop: PropPlacement, kind: PropKindDefinition): number {
    const [width, depth] = propFootprintSize(kind, prop.rotation);
    const rect = rectToView(this.view, prop.x, prop.y, width, depth, this.viewRect);
    return isometricSortKey({ x: rect.x, y: rect.y }, [rect.width, rect.depth]);
  }

  /** Puts a prop's Graphics where the current view wants it and caches its sort key and screen box. */
  private placePropDisplay(display: PropDisplay): void {
    const { prop, kind } = display;
    const [width, depth] = propFootprintSize(kind, prop.rotation);
    const centre = this.project(prop.x + (width - 1) / 2, prop.y + (depth - 1) / 2);
    const graphic = display.container;
    graphic.position.set(centre.x, centre.y + TILE_HEIGHT / 2);
    graphic.zIndex = this.propSortKey(prop, kind);
    const bounds = graphic.getLocalBounds();
    display.sortKey = graphic.zIndex;
    display.left = graphic.x + bounds.minX;
    display.top = graphic.y + bounds.minY;
    display.right = graphic.x + bounds.maxX;
    display.bottom = graphic.y + bounds.maxY;
  }

  /** Brings the prop displays in line with the world, only when the prop set moved (a clear, a restore). */
  private syncProps(): void {
    const revision = this.world.propRevision;
    if (revision === this.drawnPropRevision) return;
    this.drawnPropRevision = revision;
    for (const prop of this.world.props.values()) {
      if (this.propDisplays.has(prop.id)) continue;
      const kind = PROP_KIND_BY_ID.get(prop.kind);
      if (!kind) continue;
      const along = this.propAlong(prop, kind);
      const graphic = drawPropArt(new Graphics(), kind, along);
      const display: PropDisplay = {
        container: graphic, prop, kind, along, sortKey: 0, left: 0, top: 0, right: 0, bottom: 0,
      };
      this.placePropDisplay(display);
      this.constructionLayer.addChild(graphic);
      this.propDisplays.set(prop.id, display);
      this.seeThroughDirty = true;
    }
    for (const propId of [...this.propDisplays.keys()]) {
      if (!this.world.props.has(propId)) this.removePropDisplay(propId);
    }
  }

  private removePropDisplay(propId: number): void {
    const display = this.propDisplays.get(propId);
    if (!display) return;
    this.propDisplays.delete(propId);
    this.seeThroughFader.forget(display.container);
    this.seeThroughDirty = true;
    display.container.removeFromParent();
    display.container.destroy(DESTROY_GRAPHICS);
  }

  /** Builds one placed object's static display once. Only removal destroys it again. */
  private createObjectDisplay(object: PlacedObject): void {
    const definition = BUILD_BY_ID.get(object.definitionId);
    if (!definition) return;
    setClassicView(this.view);
    const coaster = this.world.coasters.get(object.id);
    if (coaster) {
      const track = new Graphics();
      const colours = object.colours ?? null;
      this.drawCoasterTrack(track, coaster.pieces, definition.color, true, 1, definition.id, colours);
      track.zIndex = coaster.pieces.reduce((best, piece) => Math.max(best, this.cellSortKey(piece.cell.x, piece.cell.y)), 0);
      this.constructionLayer.addChild(track);
      const trackBounds = track.getLocalBounds();
      this.objectDisplays.set(object.id, {
        container: track,
        base: null,
        centerCell: { ...object.anchor },
        isRide: false,
        colours,
        art: null,
        pathEdges: '',
        sortKey: track.zIndex,
        left: trackBounds.minX,
        top: trackBounds.minY,
        right: trackBounds.maxX,
        bottom: trackBounds.maxY,
      });
      return;
    }
    const centerCell = this.objectCenterCell(object, definition);
    const center = this.project(centerCell.x, centerCell.y);
    const group = new Container({ x: center.x, y: center.y + TILE_HEIGHT / 2 });
    group.zIndex = this.objectSortKey(object, definition);
    const base = this.createObjectBase(definition, object, centerCell);
    group.addChild(base);
    const colours = object.colours ?? null;
    let objectArt: Container | null = null;
    if (definition.kind === 'ride') {
      const art = createRideArt(definition, rotationInView(object.rotation, this.view.rotation), colours);
      group.addChild(art.container);
      this.rideArtTops.set(object.id, art.container.getLocalBounds().minY);
      this.rideDisplays.set(object.id, {
        objectId: object.id,
        art,
        spareArt: null,
        phase: object.id * 730,
        motion: 0,
        spin: 0,
      });
    } else {
      const art = createObjectArt(definition, colours);
      objectArt = art;
      group.addChild(art);
      if (definition.kind === 'scenery') {
        this.animatedDisplays.set(object.id, { container: art, phase: object.id * 0.91 });
      }
    }
    this.constructionLayer.addChild(group);
    const bounds = group.getLocalBounds();
    this.objectDisplays.set(object.id, {
      container: group,
      base,
      centerCell,
      isRide: definition.kind === 'ride',
      colours,
      art: objectArt,
      pathEdges: definition.kind === 'ride' ? this.plotPathEdges(object) : '',
      sortKey: group.zIndex,
      left: group.x + bounds.minX,
      top: group.y + bounds.minY,
      right: group.x + bounds.maxX,
      bottom: group.y + bounds.maxY,
    });
  }

  /** A view turn: moves, re-sorts and redraws the view-dependent parts of one kept object display. */
  private reorientObjectDisplay(
    object: PlacedObject,
    definition: BuildDefinition,
    display: ObjectDisplay,
    previous: ViewRotation,
  ): void {
    const coaster = this.world.coasters.get(object.id);
    if (coaster) {
      const track = display.container as Graphics;
      track.clear();
      this.drawCoasterTrack(track, coaster.pieces, definition.color, true, 1, definition.id, display.colours);
      track.zIndex = coaster.pieces.reduce((best, piece) => Math.max(best, this.cellSortKey(piece.cell.x, piece.cell.y)), 0);
      const trackBounds = track.getLocalBounds();
      display.sortKey = track.zIndex;
      display.left = trackBounds.minX;
      display.top = trackBounds.minY;
      display.right = trackBounds.maxX;
      display.bottom = trackBounds.maxY;
      return;
    }
    const group = display.container;
    const center = this.project(display.centerCell.x, display.centerCell.y);
    group.position.set(center.x, center.y + TILE_HEIGHT / 2);
    group.zIndex = this.objectSortKey(object, definition);
    if (display.base) this.drawObjectBase(display.base, definition, object, display.centerCell);
    const ride = this.rideDisplays.get(object.id);
    const facing = rotationInView(object.rotation, this.view.rotation);
    if (ride && (facing & 1) !== (rotationInView(object.rotation, previous) & 1)) {
      const index = group.getChildIndex(ride.art.container);
      group.removeChild(ride.art.container);
      const outgoing = ride.art;
      ride.art = ride.spareArt ?? createRideArt(definition, facing, display.colours);
      ride.spareArt = outgoing;
      group.addChildAt(ride.art.container, index);
      this.rideArtTops.set(object.id, ride.art.container.getLocalBounds().minY);
    }
    const bounds = group.getLocalBounds();
    display.sortKey = group.zIndex;
    display.left = group.x + bounds.minX;
    display.top = group.y + bounds.minY;
    display.right = group.x + bounds.maxX;
    display.bottom = group.y + bounds.maxY;
  }

  /** Fractional cell at the middle of a placed object's rotated footprint. */
  private objectCenterCell(object: PlacedObject, definition: BuildDefinition): Cell {
    const [width, depth] = footprintSize(definition, object.rotation);
    return {
      x: object.anchor.x + (width - 1) / 2,
      y: object.anchor.y + (depth - 1) / 2,
    };
  }

  /**
   * The plot a placed object stands on: tinted footprint tiles, plus — for rides — a perimeter
   * fence that opens wherever a path touches the plot, so the guest entrance reads on the map.
   */
  private createObjectBase(
    definition: BuildDefinition,
    object: PlacedObject,
    centerCell: Cell,
  ): Graphics {
    return this.drawObjectBase(new Graphics(), definition, object, centerCell);
  }

  /** Draws the plot (and a ride's fence) into `base`, which is cleared first (a view turn reuses it). */
  private drawObjectBase(
    base: Graphics,
    definition: BuildDefinition,
    object: PlacedObject,
    centerCell: Cell,
  ): Graphics {
    base.clear();
    const cells = this.world.objectFootprint(object);
    const occupied = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    // Everything below is laid out in VIEW cells: the plot, then which view edge each world
    // neighbour is on (a world direction turns with the map).
    cellToView(this.view, centerCell.x, centerCell.y, this.viewCell);
    const centreU = this.viewCell.x;
    const centreV = this.viewCell.y;
    const local = (cell: Cell): { x: number; y: number } => {
      cellToView(this.view, cell.x, cell.y, this.viewCell);
      const relative = cellToWorld({ x: this.viewCell.x - centreU, y: this.viewCell.y - centreV });
      return { x: relative.x, y: relative.y - TILE_HEIGHT / 2 };
    };
    for (const cell of cells) {
      const point = local(cell);
      base.poly(diamondPoints(point.x, point.y, 2))
        .fill({ color: definition.color, alpha: 0.23 })
        .stroke({ color: definition.color, alpha: 0.55, width: 1.2 });
    }
    if (definition.kind !== 'ride') return base;
    for (const cell of cells) {
      const point = local(cell);
      for (const direction of CARDINAL_DIRECTIONS) {
        const neighborKey = `${cell.x + direction.x},${cell.y + direction.y}`;
        if (occupied.has(neighborKey)) continue;
        // A path on the far side of this edge is where guests walk in: leave the fence open.
        if (this.world.paths.has(neighborKey)) continue;
        const [from, to] = footprintEdge(point, vectorToView(this.view.rotation, direction.x, direction.y, this.viewPoint));
        base.moveTo(from.x, from.y - FENCE_HEIGHT).lineTo(to.x, to.y - FENCE_HEIGHT)
          .stroke({ color: FENCE_RAIL_COLOR, alpha: 0.85, width: 2 });
        base.moveTo(from.x, from.y - FENCE_HEIGHT * 0.45).lineTo(to.x, to.y - FENCE_HEIGHT * 0.45)
          .stroke({ color: FENCE_RAIL_COLOR, alpha: 0.5, width: 1.2 });
        for (const post of [from, to]) {
          base.moveTo(post.x, post.y).lineTo(post.x, post.y - FENCE_HEIGHT)
            .stroke({ color: FENCE_POST_COLOR, alpha: 0.9, width: 2 });
        }
      }
    }
    return base;
  }

  private syncGuests(elapsedMs: number): void {
    for (const guest of this.guests.guests.values()) {
      let display = this.guestDisplays.get(guest.id);
      if (!display) {
        display = this.createGuestArt(guest);
        this.guestDisplays.set(guest.id, display);
        this.constructionLayer.addChild(display);
      }
      display.visible = guest.state !== 'riding'
        && guest.state !== 'shopping'
        && guest.state !== 'usingFacility';
      if (!display.visible) continue;
      const point = this.project(guest.position.x, guest.position.y);
      let queueIndex = -1;
      if (guest.destinationObjectId !== null) {
        if (guest.state === 'queueing') {
          queueIndex = this.rides.queueIndex(guest.destinationObjectId, guest.id);
        } else if (guest.state === 'queueingForShop') {
          queueIndex = this.shops.queueIndex(guest.destinationObjectId, guest.id);
        }
      }
      const queueOffsetX = queueIndex >= 0 ? (queueIndex % 7 - 3) * 7 : 0;
      const queueOffsetY = queueIndex >= 0 ? Math.floor(queueIndex / 7) * 5 : 0;
      const queued = guest.state === 'queueing' || guest.state === 'queueingForShop';
      const bob = queued ? 0 : Math.abs(Math.sin(elapsedMs * 0.012 + guest.id)) * 1.1;
      display.position.set(point.x + queueOffsetX, point.y + TILE_HEIGHT / 2 + queueOffsetY - bob);
      display.zIndex = this.cellSortKey(guest.position.x, guest.position.y) + 50 + Math.max(0, queueIndex);
      display.alpha = guest.state === 'leaving' ? 0.82 : 1;
    }
    for (const [id, display] of this.guestDisplays) {
      if (this.guests.guests.has(id)) continue;
      display.removeFromParent();
      display.destroy(DESTROY_DISPLAY);
      this.guestDisplays.delete(id);
    }
  }

  private createGuestArt(guest: Guest): Container {
    const group = new Container();
    const art = new Graphics();
    art.ellipse(0, 1, 5.5, 2.5).fill({ color: 0x285a4f, alpha: 0.22 });
    art.moveTo(-2.5, -6).lineTo(-3, -1).stroke({ color: 0x254f4a, width: 2.2 });
    art.moveTo(2.5, -6).lineTo(3, -1).stroke({ color: 0x254f4a, width: 2.2 });
    art.roundRect(-5, -14, 10, 10, 4).fill(guest.color).stroke({ color: 0xffffff, alpha: 0.65, width: 1 });
    art.circle(0, -18, 4.5).fill(guest.accent).stroke({ color: 0x315c54, width: 1 });
    art.arc(0, -19, 4.8, Math.PI, Math.PI * 2).fill(guest.color);
    group.addChild(art);
    return group;
  }

  private syncOperations(elapsedMs: number): void {
    const snapshot = this.operations.snapshot();
    const workerIds = new Set<number>();
    for (const worker of snapshot.workers) {
      workerIds.add(worker.id);
      let display = this.workerDisplays.get(worker.id);
      if (!display) {
        display = this.createWorkerArt(worker);
        this.workerDisplays.set(worker.id, display);
        this.constructionLayer.addChild(display);
      }
      const point = this.project(worker.position.x, worker.position.y);
      const walking = worker.state === 'walking';
      const bob = walking ? Math.abs(Math.sin(elapsedMs * 0.014 + worker.id)) * 1.6 : 0;
      display.position.set(point.x, point.y + TILE_HEIGHT / 2 - bob);
      display.zIndex = this.cellSortKey(worker.position.x, worker.position.y) + 80;
      display.alpha = worker.state === 'waiting' ? 0.72 : 1;
    }
    this.removeMissingDisplays(this.workerDisplays, workerIds);

    const litterKeys = new Set<string>();
    for (const pile of snapshot.litter) {
      const key = `${pile.cell.x},${pile.cell.y}`;
      litterKeys.add(key);
      let display = this.litterDisplays.get(key);
      if (!display) {
        display = this.createLitterArt();
        this.litterDisplays.set(key, display);
        this.constructionLayer.addChild(display);
      }
      const point = this.project(pile.cell.x, pile.cell.y);
      const size = 0.8 + Math.min(0.8, pile.units * 0.09);
      display.position.set(point.x, point.y + TILE_HEIGHT / 2 - 1);
      display.scale.set(size);
      display.zIndex = this.cellSortKey(pile.cell.x, pile.cell.y) + 10;
    }
    this.removeMissingDisplays(this.litterDisplays, litterKeys);

    const binIds = new Set<number>();
    for (const bin of snapshot.bins) {
      binIds.add(bin.objectId);
      let display = this.binIndicators.get(bin.objectId);
      if (!display) {
        display = this.createBinIndicator();
        this.binIndicators.set(bin.objectId, display);
        this.constructionLayer.addChild(display);
      }
      const object = this.world.objects.get(bin.objectId);
      const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
      if (!object || !definition) continue;
      const centre = this.objectCenterCell(object, definition);
      const point = this.project(centre.x, centre.y);
      display.position.set(point.x + 14, point.y + TILE_HEIGHT / 2 - 39);
      display.zIndex = this.objectSortKey(object, definition) + 95;
      const fill = Math.max(0, Math.min(1, bin.fill / Math.max(1, bin.capacity)));
      const bar = display.children[1];
      if (bar instanceof Graphics) {
        bar.scale.y = fill * 20;
        bar.tint = bin.full ? 0xff6277 : 0x58d9ad;
      }
      display.visible = fill > 0;
    }
    this.removeMissingDisplays(this.binIndicators, binIds);

    const alertIds = new Set<number>();
    for (const ride of this.rides.rides.values()) {
      const state = ride.broken ? 'broken' : ride.maintenanceKind ? 'maintenance' : null;
      if (!state) continue;
      alertIds.add(ride.objectId);
      let alert = this.rideAlerts.get(ride.objectId);
      if (!alert || alert.state !== state) {
        if (alert) {
          alert.container.removeFromParent();
          alert.container.destroy(DESTROY_DISPLAY);
        }
        alert = { container: this.createRideAlert(state), state };
        this.rideAlerts.set(ride.objectId, alert);
        this.constructionLayer.addChild(alert.container);
      }
      const object = this.world.objects.get(ride.objectId);
      const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
      if (!object || !definition) continue;
      const centre = this.objectCenterCell(object, definition);
      const point = this.project(centre.x, centre.y);
      // Badges clear the machinery: tall rides push their alert further up than short ones.
      const clearance = (this.rideArtTops.get(ride.objectId) ?? -72) - 14;
      alert.container.position.set(point.x, point.y + TILE_HEIGHT / 2 + clearance);
      alert.container.zIndex = this.objectSortKey(object, definition) + 110;
      alert.container.scale.set(1 + Math.sin(elapsedMs * 0.006) * 0.06);
    }
    for (const [id, alert] of this.rideAlerts) {
      if (alertIds.has(id)) continue;
      alert.container.removeFromParent();
      alert.container.destroy(DESTROY_DISPLAY);
      this.rideAlerts.delete(id);
    }
  }

  private createWorkerArt(worker: StaffSnapshot): Container {
    const group = new Container();
    const graphic = new Graphics();
    const uniform = worker.role === 'cleaner' ? 0x52cfa4 : 0xf4b94e;
    graphic.ellipse(0, 1, 6, 2.5).fill({ color: 0x285a4f, alpha: 0.22 });
    graphic.moveTo(-3, -7).lineTo(-3.5, -1).stroke({ color: 0x254f4a, width: 2.2 });
    graphic.moveTo(3, -7).lineTo(3.5, -1).stroke({ color: 0x254f4a, width: 2.2 });
    graphic.roundRect(-6, -17, 12, 12, 3).fill(uniform).stroke({ color: 0xffffff, width: 1.2 });
    graphic.circle(0, -22, 5).fill(0xffd3a6).stroke({ color: 0x315c54, width: 1 });
    graphic.moveTo(-5, -24).lineTo(5, -24).stroke({ color: uniform, width: 4 });
    if (worker.role === 'cleaner') {
      graphic.moveTo(7, -15).lineTo(11, -1).stroke({ color: 0x79543a, width: 2 });
      graphic.moveTo(7, -2).lineTo(15, 1).stroke({ color: 0xf4b94e, width: 3 });
    } else {
      graphic.circle(10, -9, 4).stroke({ color: 0x315c54, width: 2 });
      graphic.moveTo(7, -6).lineTo(3, -1).stroke({ color: 0x315c54, width: 2 });
    }
    group.addChild(graphic);
    return group;
  }

  private createLitterArt(): Container {
    const group = new Container();
    const graphic = new Graphics();
    graphic.ellipse(0, 1, 11, 4).fill({ color: 0x285a4f, alpha: 0.16 });
    graphic.poly([-9, -2, -4, -8, 1, -4, -1, 1]).fill(0xffd166).stroke({ color: 0xa66a45, width: 1 });
    graphic.roundRect(1, -7, 7, 6, 1).fill(0xff6f91).stroke({ color: 0xffffff, alpha: 0.7, width: 1 });
    group.addChild(graphic);
    return group;
  }

  private createBinIndicator(): Container {
    const group = new Container();
    const outline = new Graphics();
    outline.roundRect(-4, -12, 8, 24, 4).fill({ color: 0x173f3b, alpha: 0.82 }).stroke({ color: 0xffffff, width: 1 });
    // One unit-tall bar, scaled to the fill level instead of redrawn every frame.
    const bar = new Graphics();
    bar.roundRect(-2, -1, 4, 1, 0.5).fill(0xffffff);
    bar.position.y = 10;
    group.addChild(outline, bar);
    return group;
  }

  private createRideAlert(state: 'broken' | 'maintenance'): Container {
    const group = new Container();
    const graphic = new Graphics();
    const color = state === 'broken' ? 0xff6277 : 0xf4b94e;
    graphic.circle(0, 0, 13).fill(color).stroke({ color: 0xffffff, width: 2.5 });
    group.addChild(graphic);
    const label = new Text({
      text: state === 'broken' ? '!' : '⚒',
      style: { fontFamily: 'Arial', fontWeight: '900', fontSize: state === 'broken' ? 17 : 12, fill: 0x173f3b },
    });
    label.anchor.set(0.5);
    label.position.y = state === 'broken' ? -1 : 0;
    group.addChild(label);
    return group;
  }

  private removeMissingDisplays<K>(displays: Map<K, Container>, active: ReadonlySet<K>): void {
    for (const [key, display] of displays) {
      if (active.has(key)) continue;
      display.removeFromParent();
      display.destroy(DESTROY_DISPLAY);
      displays.delete(key);
    }
  }

  setHintMarkers(markers: readonly HintMarker[]): void {
    const hadContent = this.hintLayer.children.length > 0;
    if (!hadContent && markers.length === 0) return;
    this.hintCells = [];
    for (const marker of markers) this.hintCells.push(...marker.cells);
    this.drawHints();
  }

  /** Draws the stored hint cells (world cells) in the current view. */
  private drawHints(): void {
    this.hintLayer.removeChildren().forEach((child) => child.destroy(DESTROY_DISPLAY));
    if (this.hintCells.length === 0) return;
    // The ring is laid out in view cells, so its outline follows the turned map.
    const cells: Cell[] = this.hintCells.map((cell) => {
      cellToView(this.view, cell.x, cell.y, this.viewCell);
      return { x: this.viewCell.x, y: this.viewCell.y };
    });
    const ring = new Graphics();
    const covered = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    for (const cell of cells) {
      const point = cellToWorld(cell);
      ring.poly(diamondPoints(point.x, point.y, 2)).fill({ color: 0xffd166, alpha: 0.28 });
    }
    // One outline around the whole footprint (edges shared with a neighbour cell are skipped): a
    // white halo so it reads on sand paths as well as grass, then the candy orange on top.
    for (const [color, width, alpha] of [[0xffffff, 6, 0.75], [0xff9f1c, 3, 1]] as const) {
      let any = false;
      for (const cell of cells) {
        const point = cellToWorld(cell);
        HINT_EDGES.forEach(([dx, dy, x0, y0, x1, y1]) => {
          if (covered.has(`${cell.x + dx},${cell.y + dy}`)) return;
          ring.moveTo(point.x + x0 * TILE_WIDTH, point.y + y0 * TILE_HEIGHT)
            .lineTo(point.x + x1 * TILE_WIDTH, point.y + y1 * TILE_HEIGHT);
          any = true;
        });
      }
      if (any) ring.stroke({ color, alpha, width });
    }
    this.hintLayer.addChild(ring);
  }

  private refreshSelection(): void {
    this.selectionLayer.removeChildren().forEach((child) => child.destroy(DESTROY_DISPLAY));
    if (this.selectedObjectId === null) return;
    const object = this.world.objects.get(this.selectedObjectId);
    const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
    if (!object || !definition) {
      this.selectedObjectId = null;
      return;
    }
    const outline = new Graphics();
    for (const cell of this.world.objectFootprint(object)) {
      const point = this.project(cell.x, cell.y);
      outline.poly(diamondPoints(point.x, point.y, 2))
        .fill({ color: 0xffe66d, alpha: 0.1 })
        .stroke({ color: 0xfff5a8, alpha: 0.95, width: 3 });
    }
    this.selectionLayer.addChild(outline);
  }

  /**
   * Phase 26. Turns the whole picture to `rotation` (quarter turns, clockwise per step) about the
   * map centre, keeping the world point at the middle of the screen where it was. Static displays
   * are rebuilt synchronously, so the next frame is entirely the new orientation; the ride
   * machinery keeps its motion state. Unless `instant` (or reduced motion), a pooled veil in the
   * background colour fades from 0.55 to 0 over the new picture in 180 ms (never the old picture:
   * no frame mixes orientations). Presentation only.
   */
  setViewRotation(rotation: ViewRotation, instant = false): void {
    if (rotation === this.view.rotation) return;
    const previous = this.view.rotation;
    this.syncViewSize();
    const animate = !instant && this.mounted && !reducedMotion();
    const scale = this.camera.scale;
    // The world point under the middle of the screen, in point space, before the turn.
    let centreU = 0;
    let centreV = 0;
    if (this.mounted) {
      const localX = (this.app.screen.width / 2 - this.camera.x) / scale.x;
      const localY = (this.app.screen.height / 2 - this.camera.y) / scale.y;
      pointFromView(this.view, localX / TILE_WIDTH + localY / TILE_HEIGHT, localY / TILE_HEIGHT - localX / TILE_WIDTH, this.viewPoint);
      centreU = this.viewPoint.x;
      centreV = this.viewPoint.y;
    }
    this.view.rotation = rotation;
    setClassicView(this.view);
    this.classicWeather.setViewMapper(rotation, rotation === 0 ? null : (x, y, out) => {
      pointToView(this.view, x / TILE_WIDTH + y / TILE_HEIGHT, y / TILE_HEIGHT - x / TILE_WIDTH, out);
      const u = out.x;
      const v = out.y;
      out.x = (u - v) * (TILE_WIDTH / 2);
      out.y = (u + v) * (TILE_HEIGHT / 2);
    });
    this.rebuildForView(previous);
    if (this.mounted) {
      pointToView(this.view, centreU, centreV, this.viewPoint);
      const u = this.viewPoint.x;
      const v = this.viewPoint.y;
      this.camera.position.set(
        this.app.screen.width / 2 - (u - v) * (TILE_WIDTH / 2) * scale.x,
        this.app.screen.height / 2 - (u + v) * (TILE_HEIGHT / 2) * scale.y,
      );
    }
    if (animate) this.beginTurnVeil();
    else this.hideTurnVeil();
    this.input?.rehover();
  }

  /**
   * Re-places everything that is drawn in view space for the new orientation, reusing every display
   * object: object containers are moved and re-sorted (their zIndex), and only the view-dependent
   * drawing is redone — plots and fences, coaster track, the path layer, a ride's machinery only
   * when its footprint axis flips (ride art depends on the rotation's parity alone), terrain from
   * a per-class cache. Per-ride motion state lives on the kept displays.
   */
  private rebuildForView(previous: ViewRotation): void {
    this.seeThroughFader.clear();
    this.seeThroughAppliedValid = false;
    this.seeThroughDirty = true;
    setClassicView(this.view);
    for (const [objectId, display] of this.objectDisplays) {
      const object = this.world.objects.get(objectId);
      const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
      if (!object || !definition) continue;
      this.reorientObjectDisplay(object, definition, display, previous);
    }
    for (const display of this.propDisplays.values()) {
      // Only a 2x1 prop's art depends on the view axis; everything else just moves and re-sorts.
      const along = this.propAlong(display.prop, display.kind);
      if (along !== display.along && propArtIsOriented(display.kind)) {
        display.along = along;
        drawPropArt(display.container, display.kind, along);
      }
      this.placePropDisplay(display);
    }
    if (this.entranceDisplay) {
      const point = this.project(this.world.entrance.x, this.world.entrance.y);
      this.entranceDisplay.position.set(point.x, point.y + TILE_HEIGHT / 2);
      this.entranceDisplay.zIndex = this.cellSortKey(this.world.entrance.x, this.world.entrance.y);
    }
    this.drawnPathVersion = -1;
    this.sceneryInfluenceVersion = -1;
    this.sceneryInfluenceDirty = true;
    // Mount draws the terrain; before it, there is none to redraw.
    if (this.mounted) this.drawTerrain();
    this.syncWorld();
    this.drawHints();
    if (this.lastDraft) {
      const { pieces, color, armed, definitionId, colours } = this.lastDraft;
      this.drawCoasterDraft(pieces, color, armed, definitionId, colours);
    }
    if (this.lastPreview) {
      const { cells, definition, valid, bulldoze, rotation, colours } = this.lastPreview;
      this.drawPreview(cells, definition, valid, bulldoze, rotation, colours);
    }
    if (this.paintHoverCells !== null) {
      // The hover outline is drawn in view space: draw it again for the new orientation.
      const cells = this.paintHoverCells;
      const tint = this.paintHoverTint;
      this.paintHoverCells = null;
      this.setPaintHover({ cells, tint });
    }
    // Moving displays are placed from the world every frame; place them now so no frame shows
    // them in the old orientation.
    if (this.mounted) {
      this.syncGuests(this.lastElapsedMs);
      this.syncOperations(this.lastElapsedMs);
      this.syncRideMachinery(0, this.lastElapsedMs - this.pausedMs);
      this.syncCoasterTrains();
    }
  }

  /** Shows the veil at full strength over the (already turned) picture; `update` fades it out. */
  private beginTurnVeil(): void {
    let veil = this.turnVeil;
    if (!veil) {
      veil = new Sprite(Texture.WHITE);
      veil.tint = VIEW_TURN_VEIL_COLOR;
      veil.eventMode = 'none';
      this.turnVeil = veil;
    }
    // On top of the camera and every overlay layer; re-added only if something re-parented it.
    if (veil.parent !== this.app.stage) this.app.stage.addChild(veil);
    else this.app.stage.setChildIndex(veil, this.app.stage.children.length - 1);
    const { width, height } = this.app.screen;
    veil.position.set(0, 0);
    veil.width = width;
    veil.height = height;
    veil.alpha = VIEW_TURN_VEIL_ALPHA;
    veil.visible = true;
    this.turnVeilElapsedMs = 0;
  }

  private stepTurnVeil(deltaMs: number): void {
    const veil = this.turnVeil;
    if (!veil || this.turnVeilElapsedMs === null) return;
    this.turnVeilElapsedMs += deltaMs;
    if (this.turnVeilElapsedMs >= VIEW_TURN_MS || reducedMotion()) {
      this.hideTurnVeil();
      return;
    }
    veil.alpha = VIEW_TURN_VEIL_ALPHA * (1 - easeOutCubic(this.turnVeilElapsedMs / VIEW_TURN_MS));
  }

  /** Hides the veil; once hidden, nothing writes to it until the next animated turn. */
  private hideTurnVeil(): void {
    if (this.turnVeilElapsedMs === null) return;
    this.turnVeilElapsedMs = null;
    if (this.turnVeil) this.turnVeil.visible = false;
  }

  /** Test seam: the veil's current alpha (0 when hidden or never built). */
  get turnVeilAlpha(): number {
    return this.turnVeil?.visible ? this.turnVeil.alpha : 0;
  }

  /** Test seam: the view rotation the picture is currently drawn in. */
  get viewRotation(): ViewRotation { return this.view.rotation; }

  private bindInput(): void {
    this.input = bindWorldInput(
      this.app.canvas,
      containerCameraView(this.camera, () => this.app.screen),
      (cell) => this.world.isInside(cell),
      () => this.handlers,
      undefined,
      undefined,
      undefined,
      () => this.view,
    );
    this.input.setViewInputEnabled(this.viewInputEnabled);
  }

  /**
   * Camera keys obey the same input-context rule as every other shortcut: while a full-screen
   * overlay owns the layer, held keys are released and new ones ignored, so the park cannot drift
   * away behind a modal the player is reading.
   */
  setViewInputEnabled(enabled: boolean): void {
    this.viewInputEnabled = enabled;
    this.input?.setViewInputEnabled(enabled);
  }
}
