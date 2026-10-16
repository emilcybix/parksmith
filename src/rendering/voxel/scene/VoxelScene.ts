import type { ParkSession } from '../../../game/session/ParkSession';
import type { CoasterPiece } from '../../../game/coaster/design';
import type { ObjectColours } from '../../../game/content/colours';
import type { BuildDefinition, Cell, Rotation } from '../../../game/types';
import { coasterLoadedCars } from '../../coasterCarFrame';
import { coasterHeadIndex, coasterInterpolatedRemaining } from '../../coasterTrain';
import type { ModelCache } from '../blueprint/compile';
import type { Vec3 } from '../contracts/blueprint';
import { BOX_TEX_WIDTH, BOX_TEXELS, DYNAMIC_BOX_TEX_WIDTH, TRANSFORM_TEX_WIDTH, TRANSFORM_TEXELS } from '../contracts/boxes';
import { PREWARM_BUDGET_MS } from '../contracts/budgets';
import { FIGURE_TEX_WIDTH, FIGURE_TEXELS } from '../contracts/figures';
import { LIGHT_TEX_WIDTH, NULL_GPU_SINK } from '../contracts/frame';
import type { DynamicTexture, GhostState, VoxelGpuSink, VoxelSceneStats } from '../contracts/frame';
import type { Palette } from '../contracts/palette';
import { createViewTransform, setViewTransform } from '../contracts/view';
import type { ViewTransform } from '../contracts/view';
import type { ViewFrame } from '../../viewRotation';
import { restPose } from '../contracts/rigid';
import type { PartDriver, PartPose, RideMotionState } from '../contracts/rigid';
import type { QuarterTurn } from '../contracts/space';
import { advanceRideMotion, createRideMotionState } from '../rideMotion';
import { placeCoasterCars, writeCoasterCarTransforms } from './coasterCars';
import { createFigurePacker } from './figures';
import type { FigurePacker } from './figures';
import { CoasterDraft } from './coasterDraft';
import { GhostPreview } from './ghost';
import { LightTable } from './lights';
import { LitterList } from './litter';
import { createTransformTable, writeRotatedPartTransform } from './rigid';
import type { TransformTable } from './rigid';
import { REGISTRY_CONTENT, reportContentError, SceneModels, StaticWorld } from './staticWorld';
import type { ContentErrorReporter, ObjectPlacement, SceneContent, TrainPlacement } from './staticWorld';

/**
 * The voxel scene (design §4, §5, §9): everything that turns a park into typed arrays, and nothing
 * that touches Pixi. It runs unmounted in Node against a recording VoxelGpuSink, which is how the
 * frame-cost, construction-cost and incremental-equals-from-scratch guards work.
 *
 * Per frame (`update`), in this order:
 *   1. the world diff, once, if anything notified since the last frame (`syncWorld` only flags it,
 *      so the dev park's ~110 synchronous notifications cost one diff);
 *   2. dirty static chunks rebuilt (StaticWorld, sorted front-to-back) and sent with `setChunk`, the
 *      light table re-packed and sent when any chunk was rebuilt;
 *   3. an idle prewarm slice of the model cache (PREWARM_BUDGET_MS, what the frame has left of it);
 *   4. ride motion per animated object (rideMotion.ts), its part drivers posing the rigid parts
 *      (writeRotatedPartTransform: the parts come from ModelCache.model(bp, q), already turned);
 *   5. coaster trains (coasterHeadIndex + placeCoasterCars → car slots);
 *   6. the transform table's dirty rows; the figure packer's dirty rows and ranges; the litter list
 *      when its signature changed; the ghost when the preview (or, for a bulldoze preview, the
 *      world) changed.
 * A steady frame therefore stages only dynamic rows — figures that moved, parts that turned — and
 * allocates nothing of its own once warm: index loops, reused poses and records, and the clock read
 * only while the prewarm has work. (A fractional stepFraction is still boxed where it crosses into
 * the figure packer's API, a few bytes per frame.)
 */

const BYTES_PER_TEXEL = 16;

/** Stats every update starts from. */
const resetStats = (stats: VoxelSceneStats): void => {
  stats.chunksRebuilt = 0;
  stats.boxesEmitted = 0;
  stats.dynamicRowsStaged = 0;
  stats.bytesStaged = 0;
  stats.blueprintsCompiled = 0;
  stats.chunksReordered = 0;
};

/** Texel width of each dynamic texture (contracts), for the bytes-staged counter. */
const dynamicTextureWidth = (texture: DynamicTexture): number => {
  switch (texture) {
    case 'figures': return FIGURE_TEX_WIDTH;
    case 'transforms': return TRANSFORM_TEX_WIDTH;
    case 'litter': return DYNAMIC_BOX_TEX_WIDTH;
    case 'lights': return LIGHT_TEX_WIDTH;
  }
};

/** Whole texture rows `count` records of `texels` texels fill in a `width`-texel-wide texture. */
const rowsFor = (count: number, texels: number, width: number): number => Math.ceil(Math.max(0, count) * texels / width);

/** One moving part of an animated object, with its driver resolved once per rebuild. */
interface AnimatedPart {
  readonly partId: string;
  readonly slot: number;
  /** The part's pivot in the turned model (rotateModel), model space. */
  readonly pivot: Vec3;
  /** Null: no driver (or a driver that failed); the part stays at rest. */
  driver: PartDriver | null;
}

/** A placed object with moving parts, as the frame loop animates it. */
interface AnimatedObject {
  readonly objectId: number;
  readonly definitionId: string;
  readonly originX: number;
  readonly originY: number;
  readonly quarterTurn: QuarterTurn;
  readonly durationSeconds: number;
  readonly motion: RideMotionState;
  readonly parts: readonly AnimatedPart[];
}

export interface VoxelSceneOptions {
  /** Where the scene's arrays go; NULL_GPU_SINK until the renderer attaches its GPU. */
  sink?: VoxelGpuSink;
  /** The content registry by default; tests pass the placeholders to pin the static world. */
  content?: SceneContent;
  /** How a content failure is reported (once per failing blueprint or driver). */
  reportError?: ContentErrorReporter;
  /** Idle prewarm per frame (ms); 0 turns the prewarm off. Default PREWARM_BUDGET_MS. */
  prewarmBudgetMs?: number;
}

/** What the see-through cutaway needs of the ghost: where it stands and how much room it fills (voxels). */
export interface GhostVolume {
  active: boolean;
  originX: number;
  originY: number;
  extentX: number;
  extentY: number;
  heightVoxels: number;
}

export class VoxelScene {
  /** Counters of the latest `update` (contracts/frame.ts). */
  readonly stats: VoxelSceneStats = {
    chunksRebuilt: 0,
    boxesEmitted: 0,
    dynamicRowsStaged: 0,
    bytesStaged: 0,
    blueprintsCompiled: 0,
    chunksReordered: 0,
  };
  /**
   * Phase 26: the view transform the static chunks are sorted and bounded for and the GPU maps world voxels
   * through. One object for the scene's life, mutated by `setView` (its revision moves only with a value).
   */
  readonly view: ViewTransform = createViewTransform();
  private session: ParkSession;
  private readonly cache: ModelCache;
  private readonly models: SceneModels;
  private readonly transforms: TransformTable = createTransformTable();
  private staticWorld: StaticWorld;
  private readonly lightTable = new LightTable();
  private readonly litter: LitterList;
  private readonly packer: FigurePacker;
  private readonly ghost = new GhostPreview();
  private readonly draft = new CoasterDraft();
  private draftPieces: readonly CoasterPiece[] = [];
  private draftDefinition: BuildDefinition | null = null;
  private draftArmed = true;
  /** Phase 28: the colours the coaster will get (colour before placing); null = the type's defaults. */
  private draftColours: ObjectColours | null = null;
  private draftDirty = false;
  /** The draft box list the sink last received (it uploads only when this identity changes). */
  private sentDraftBoxes: Float32Array | null = null;
  private readonly report: ContentErrorReporter;
  private readonly prewarmBudgetMs: number;
  private sink: VoxelGpuSink;
  /** Motion state per animated object: it outlives chunk rebuilds, so a ride keeps its angle. */
  private readonly motions = new Map<number, RideMotionState>();
  private animated: AnimatedObject[] = [];
  private trains: TrainPlacement[] = [];
  private readonly pose: PartPose = { dx: 0, dy: 0, dz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  /** Set by `syncWorld` (and on every reset); the next update diffs the world once. */
  private worldChanged = true;
  private ghostDirty = false;
  /** The volume of the ghost last staged (see-through cutaway): reused, read through `ghostVolume`. */
  private readonly ghostBounds: GhostVolume = { active: false, originX: 0, originY: 0, extentX: 0, extentY: 0, heightVoxels: 0 };
  /** Upload whole tables on the next update (a new sink never saw the rows sent before). */
  private resendTransforms = false;
  private resendFigures = false;
  private stagedTransformCount = -1;
  /** The ghost box list the sink last received (it uploads only when this identity changes). */
  private sentGhostBoxes: Float32Array | null = null;
  private prewarmQueued = false;
  /** `definitionId:partId` of drivers that threw: reported once, then left at rest for good. */
  private readonly failedDrivers = new Set<string>();

  constructor(session: ParkSession, palette: Palette, modelCache: ModelCache, options: VoxelSceneOptions = {}) {
    this.session = session;
    this.cache = modelCache;
    this.sink = options.sink ?? NULL_GPU_SINK;
    this.report = options.reportError ?? reportContentError;
    this.prewarmBudgetMs = options.prewarmBudgetMs ?? PREWARM_BUDGET_MS;
    this.models = new SceneModels(palette, modelCache, options.content ?? REGISTRY_CONTENT, this.report);
    this.staticWorld = this.createStaticWorld(session);
    this.litter = new LitterList((cellX, cellY, units, out, sick) => this.models.litterBoxes(cellX, cellY, units, out, sick));
    this.packer = createFigurePacker(palette);
  }

  /** Static chunks (16 for the 32×32 map). */
  get chunkCount(): number {
    return this.staticWorld.chunkCount;
  }

  /**
   * Blueprints the idle prewarm has not reached yet: infinite until the first update queues them,
   * 0 when the prewarm is off.
   */
  get prewarmRemaining(): number {
    if (this.prewarmBudgetMs <= 0) return 0;
    return this.prewarmQueued ? this.models.prewarmRemaining : Number.POSITIVE_INFINITY;
  }

  /**
   * Sends everything to a new sink from the next update on (the renderer attaches its GPU at mount;
   * the old sink's copies are of no use to the new one).
   */
  setSink(sink: VoxelGpuSink): void {
    this.sink = sink;
    this.staticWorld.markAllDirty();
    this.litter.reset();
    this.resendTransforms = true;
    this.resendFigures = true;
    this.stagedTransformCount = -1;
    this.sentGhostBoxes = null;
    this.ghostDirty = true;
    this.sentDraftBoxes = null;
    this.draftDirty = true;
  }

  /**
   * A new park (design §4): forget everything derived from the old world — known objects and path
   * version (all chunks dirty), transform slots, ride motion and trains, figure history, the litter
   * signature, the ghost and the lights. The model cache survives. The sink is expected to have
   * forgotten its scene too (VoxelGpu.resetScene); everything is sent again on the next update.
   */
  setSession(session: ParkSession): void {
    this.session = session;
    const world = session.world;
    if (world.width !== this.staticWorld.width || world.height !== this.staticWorld.height) {
      this.staticWorld = this.createStaticWorld(session);
    } else {
      this.staticWorld.reset();
    }
    this.transforms.reset();
    this.motions.clear();
    this.animated = [];
    this.trains = [];
    this.packer.reset();
    this.litter.reset();
    this.lightTable.count = 0;
    this.ghost.clear();
    this.ghostDirty = true;
    this.sentGhostBoxes = null;
    this.draft.clear();
    this.draftPieces = [];
    this.draftDefinition = null;
    this.draftColours = null;
    this.draftDirty = true;
    this.sentDraftBoxes = null;
    this.resendTransforms = true;
    this.resendFigures = true;
    this.stagedTransformCount = -1;
    this.worldChanged = true;
    this.prewarmQueued = false;
  }

  /**
   * Phase 26: shows the world through `frame` (rotation plus the world map size in tiles). No geometry is
   * rebuilt: the static data stays in world voxels and the vertex stage turns it. What changes is the
   * chunk sort order (early-Z) and the chunk screen bounds, so every chunk that is not waiting for a
   * rebuild is re-sorted, re-bounded and re-sent with `setChunk`, once, here, so no frame mixes two
   * orientations. The figure packer lays the queues out for the view (their records change once, on the next
   * pack); no other dynamic record moves. Chunks that are dirty are built for the new view by the next update. A repeat of the
   * current view costs nothing. Counters land in `stats` (`chunksReordered`, `bytesStaged`) until the
   * next update resets them.
   */
  setView(frame: ViewFrame): void {
    const before = this.view.revision;
    setViewTransform(frame, this.view);
    // Queue slots are a screen layout: the next pack moves the queued guests' records (and only those).
    this.packer.setView(frame.rotation);
    if (this.view.revision === before) return;
    const staticWorld = this.staticWorld;
    const stats = this.stats;
    resetStats(stats);
    const reordered = staticWorld.reorderForView();
    for (let index = 0; index < reordered; index += 1) {
      const chunk = staticWorld.reorderedChunks[index];
      const boxes = staticWorld.chunkBoxes(chunk);
      this.sink.setChunk(chunk, boxes.data, boxes.count, staticWorld.chunkBounds(chunk));
      stats.chunksReordered += 1;
      stats.bytesStaged += rowsFor(boxes.count, BOX_TEXELS, BOX_TEX_WIDTH) * BOX_TEX_WIDTH * BYTES_PER_TEXEL;
    }
  }

  /** The world notified: diff it once on the next update. Cheap enough to call on every change. */
  syncWorld(): void {
    this.worldChanged = true;
    if (this.ghost.followsWorld) this.ghostDirty = true;
  }

  /** The ghost of a build or bulldoze preview (renderer.drawPreview); repeats cost nothing. */
  setPreview(
    cells: readonly Cell[],
    definition: BuildDefinition | null,
    valid: boolean,
    bulldoze = false,
    rotation: Rotation = 0,
    colours: ObjectColours | null = null,
  ): void {
    if (this.ghost.set(cells, definition, valid, bulldoze, rotation, colours)) this.ghostDirty = true;
  }

  clearPreview(): void {
    if (this.ghost.clear()) this.ghostDirty = true;
  }

  /**
   * The coaster builder's layout (renderer.drawCoasterDraft) as the real voxel track. `pieces` is
   * the GameApp's array, mutated in place, so it is read again on every call and compared by
   * content; repeats cost one pass over the pieces and no allocation. Empty clears the draft.
   */
  setCoasterDraft(pieces: readonly CoasterPiece[], definition: BuildDefinition | null, armed: boolean, colours: ObjectColours | null = null): void {
    this.draftPieces = pieces;
    this.draftDefinition = definition;
    this.draftArmed = armed;
    this.draftColours = colours;
    this.draftDirty = true;
  }

  private machineryPaused = false;
  private pausedMs = 0;

  setMachineryPaused(paused: boolean): void {
    this.machineryPaused = paused;
  }

  /**
   * One frame of scene work (see the file comment). `elapsedMs` is the frame clock ride drivers
   * read; `stepFraction` is SimulationClock.stepFraction, for figure interpolation.
   */
  /** Voxel leftovers: figures outside this WORLD-cell rectangle are not packed (the camera's view plus a margin). */
  setFigureCull(x0: number, y0: number, x1: number, y1: number): void {
    this.packer.setCull(x0, y0, x1, y1);
  }

  update(deltaMs: number, elapsedMs: number, stepFraction: number): void {
    const stats = this.stats;
    resetStats(stats);
    // The clock is only read while the prewarm has work: a steady frame makes no API call it does not need.
    const prewarming = this.prewarmBudgetMs > 0 && (!this.prewarmQueued || this.models.prewarmRemaining > 0);
    const started = prewarming ? performance.now() : 0;
    const compiledBefore = this.cache.compiledCount;
    const world = this.session.world;
    if (this.worldChanged) {
      this.worldChanged = false;
      this.staticWorld.sync(world);
    }
    const rebuilt = this.staticWorld.rebuildDirty(world);
    if (rebuilt > 0) this.afterRebuild(rebuilt);
    if (prewarming) this.prewarm(started);
    // Machinery stops with the game: a paused frame advances neither its ease nor its spin, and the
    // drivers' clock stands still too (pausedMs is subtracted), so nothing jumps when play resumes.
    if (this.machineryPaused) this.pausedMs += deltaMs;
    this.animateRides(this.machineryPaused ? 0 : deltaMs, elapsedMs - this.pausedMs);
    this.animateTrains(stepFraction);
    // The draft's parked train poses its slots when the draft rebuilds: before the rows are staged.
    if (this.draftDirty) this.stageDraft();
    this.stageTransforms();
    this.stageFigures(stepFraction);
    this.stageLitter();
    if (this.ghostDirty) this.stageGhost();
    stats.blueprintsCompiled = this.cache.compiledCount - compiledBefore;
  }

  // ---- Test and overlay seams -------------------------------------------------------------------

  /** Digest of a chunk's boxes, bounds and lights, transform slots by key (equivalence tests). */
  chunkHash(index: number): string {
    return this.staticWorld.chunkHash(index);
  }

  chunkBoxCount(index: number): number {
    return this.staticWorld.chunkBoxes(index).count;
  }

  /** Highest z (world voxels) of an object at rest, for overlay badges; null when unknown. */
  objectTop(objectId: number): number | null {
    return this.staticWorld.objectTop(objectId);
  }

  // ---- Frame steps -----------------------------------------------------------------------------

  private createStaticWorld(session: ParkSession): StaticWorld {
    return new StaticWorld({
      width: session.world.width,
      height: session.world.height,
      models: this.models,
      transforms: this.transforms,
      view: this.view,
    });
  }

  /** Sends the rebuilt chunks and the re-packed lights, and refreshes what the frame loop animates. */
  private afterRebuild(rebuilt: number): void {
    const stats = this.stats;
    const staticWorld = this.staticWorld;
    for (let index = 0; index < rebuilt; index += 1) {
      const chunk = staticWorld.rebuiltChunks[index];
      const boxes = staticWorld.chunkBoxes(chunk);
      this.sink.setChunk(chunk, boxes.data, boxes.count, staticWorld.chunkBounds(chunk));
      stats.chunksRebuilt += 1;
      stats.boxesEmitted += boxes.count;
      stats.bytesStaged += rowsFor(boxes.count, BOX_TEXELS, BOX_TEX_WIDTH) * BOX_TEX_WIDTH * BYTES_PER_TEXEL;
    }
    const lights = this.lightTable;
    const count = lights.pack(staticWorld.lights);
    this.stageDynamic('lights', lights.data, count, 0, lights.rows);
    this.refreshAnimated();
  }

  /**
   * Rebuilds the animated-object and train lists from the placements (rebuild frames only, so it
   * may allocate). Motion state is kept by object id; objects that went take theirs with them.
   */
  private refreshAnimated(): void {
    const placements = this.staticWorld.placements;
    const animated: AnimatedObject[] = [];
    for (const placement of placements.values()) {
      if (placement.parts.length > 0) animated.push(this.animatedObject(placement));
    }
    for (const objectId of [...this.motions.keys()]) {
      if (!placements.has(objectId)) this.motions.delete(objectId);
    }
    this.animated = animated;
    this.trains = [...this.staticWorld.trains.values()];
  }

  private animatedObject(placement: ObjectPlacement): AnimatedObject {
    let motion = this.motions.get(placement.objectId);
    if (!motion) {
      motion = createRideMotionState(placement.objectId);
      this.motions.set(placement.objectId, motion);
    }
    const drivers = placement.fromContent ? this.models.drivers(placement.definition) : undefined;
    return {
      objectId: placement.objectId,
      definitionId: placement.definition.id,
      originX: placement.originX,
      originY: placement.originY,
      quarterTurn: placement.quarterTurn,
      durationSeconds: placement.durationSeconds,
      motion,
      parts: placement.parts.map((part): AnimatedPart => ({
        partId: part.partId,
        slot: part.slot,
        pivot: part.pivot,
        driver: this.failedDrivers.has(`${placement.definition.id}:${part.partId}`) ? null : drivers?.[part.partId] ?? null,
      })),
    };
  }

  /** Compiles catalog blueprints ahead of need with whatever the frame has left of the budget. */
  private prewarm(frameStarted: number): void {
    if (!this.prewarmQueued) {
      this.models.setPrewarmQueue(SceneModels.prewarmQueueFor(this.session.world));
      this.prewarmQueued = true;
    }
    if (this.models.prewarmRemaining === 0) return;
    const budget = this.prewarmBudgetMs - (performance.now() - frameStarted);
    if (budget > 0) this.models.prewarm(budget);
  }

  /**
   * Legacy ride motion per animated object, then each part's driver in model space, composed with
   * the placement into its slot. The pose is reset to rest before every driver, so a driver that
   * only sets a rotation never inherits the previous part's offset.
   */
  private animateRides(deltaMs: number, elapsedMs: number): void {
    const rides = this.session.rides;
    const animated = this.animated;
    const pose = this.pose;
    for (let index = 0; index < animated.length; index += 1) {
      const entry = animated[index];
      const runtime = rides.getRide(entry.objectId);
      advanceRideMotion(
        entry.motion,
        runtime === undefined ? 'closed' : runtime.status,
        deltaMs,
        elapsedMs,
        runtime === undefined ? 0 : runtime.cycleRemainingSeconds,
        entry.durationSeconds,
      );
      const parts = entry.parts;
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = parts[partIndex];
        restPose(pose);
        if (part.driver !== null) this.drive(entry, part, pose);
        writeRotatedPartTransform(this.transforms, part.slot, entry.originX, entry.originY, 0, entry.quarterTurn, part.pivot, pose);
      }
    }
  }

  /** Runs one driver; a driver that throws or poses nowhere is reported once and retired. */
  private drive(entry: AnimatedObject, part: AnimatedPart, pose: PartPose): void {
    const driver = part.driver as PartDriver;
    try {
      driver(entry.motion, pose);
    } catch (error) {
      this.retireDriver(entry, part, error);
      restPose(pose);
      return;
    }
    if (!Number.isFinite(pose.dx) || !Number.isFinite(pose.dy) || !Number.isFinite(pose.dz)) {
      this.retireDriver(entry, part, new Error(`the driver posed part '${part.partId}' at a non-finite offset`));
      restPose(pose);
    }
  }

  private retireDriver(entry: AnimatedObject, part: AnimatedPart, error: unknown): void {
    part.driver = null;
    const key = `${entry.definitionId}:${part.partId}`;
    if (this.failedDrivers.has(key)) return;
    this.failedDrivers.add(key);
    this.report(`Voxel ride driver ${key} failed; the part stays at rest.`, error);
  }

  /**
   * Every coaster's train along its track, from the shared (corrected) timing, advanced by the
   * fraction of the current simulation step so it moves every frame, not 10 times a second.
   */
  private animateTrains(stepFraction: number): void {
    const rides = this.session.rides;
    const trains = this.trains;
    for (let index = 0; index < trains.length; index += 1) {
      const train = trains[index];
      const runtime = rides.getRide(train.objectId);
      const headIndex = coasterHeadIndex(
        train.record,
        runtime !== undefined && runtime.status === 'running'
          ? coasterInterpolatedRemaining(runtime.cycleRemainingSeconds, train.record.stats.durationSeconds, stepFraction)
          : null,
      );
      placeCoasterCars(train.record, headIndex, train.carCount, train.poses);
      const loaded = runtime === undefined
        ? 0
        : coasterLoadedCars(runtime.status, runtime.riderGuestIds.length, train.capacity, train.carCount);
      writeCoasterCarTransforms(this.transforms, train.objectId, train.poses, loaded);
    }
  }

  /** The transform rows that changed this frame (or all of them for a new sink). */
  private stageTransforms(): void {
    const table = this.transforms;
    const count = table.highestSlot;
    let start = table.dirtyRowStart;
    let end = table.dirtyRowEnd;
    if (this.resendTransforms) {
      this.resendTransforms = false;
      start = 0;
      end = Math.max(end, rowsFor(count, TRANSFORM_TEXELS, TRANSFORM_TEX_WIDTH));
    }
    if (end > start || count !== this.stagedTransformCount) {
      this.stageDynamic('transforms', table.data, count, start, end);
      this.stagedTransformCount = count;
    }
    table.clearDirty();
  }

  private stageFigures(stepFraction: number): void {
    const frame = this.packer.pack(this.session, stepFraction);
    let start = frame.rowStart;
    let end = frame.rowEnd;
    if (this.resendFigures) {
      this.resendFigures = false;
      start = 0;
      end = Math.max(end, rowsFor(frame.count, FIGURE_TEXELS, FIGURE_TEX_WIDTH));
    }
    this.stageDynamic('figures', frame.data, frame.count, start, end);
    this.sink.setFigureRanges(frame.ranges);
  }

  private stageLitter(): void {
    if (!this.litter.sync(this.session.operations.litter)) return;
    const boxes = this.litter.boxes;
    this.stageDynamic('litter', boxes.data, boxes.count, 0, this.litter.rows);
    this.stats.boxesEmitted += boxes.count;
  }

  /** The footprint and height of the ghost the sink holds (inactive when none): presentation input of the cutaway. */
  get ghostVolume(): Readonly<GhostVolume> {
    return this.ghostBounds;
  }

  private stageGhost(): void {
    this.ghostDirty = false;
    const ghost: GhostState | null = this.ghost.resolve(this.session.world, this.models);
    const volume = this.ghostBounds;
    volume.active = ghost !== null;
    volume.originX = ghost?.originX ?? 0;
    volume.originY = ghost?.originY ?? 0;
    volume.extentX = ghost?.extentX ?? 0;
    volume.extentY = ghost?.extentY ?? 0;
    volume.heightVoxels = ghost?.heightVoxels ?? 0;
    this.sink.setGhost(ghost);
    if (ghost !== null && ghost.boxes !== this.sentGhostBoxes) {
      this.stats.bytesStaged += rowsFor(ghost.boxCount, BOX_TEXELS, DYNAMIC_BOX_TEX_WIDTH) * DYNAMIC_BOX_TEX_WIDTH * BYTES_PER_TEXEL;
    }
    this.sentGhostBoxes = ghost === null ? null : ghost.boxes;
  }

  private stageDraft(): void {
    this.draftDirty = false;
    const draft = this.draft.resolve(this.draftPieces, this.draftDefinition, this.draftArmed, this.models, this.transforms, this.draftColours);
    this.sink.setDraft(draft);
    if (draft !== null && draft.boxes !== this.sentDraftBoxes) {
      this.stats.bytesStaged += rowsFor(draft.boxCount, BOX_TEXELS, DYNAMIC_BOX_TEX_WIDTH) * DYNAMIC_BOX_TEX_WIDTH * BYTES_PER_TEXEL;
    }
    this.sentDraftBoxes = draft === null ? null : draft.boxes;
  }

  private stageDynamic(texture: DynamicTexture, data: Float32Array, count: number, rowStart: number, rowEnd: number): void {
    this.sink.setDynamic(texture, data, count, rowStart, rowEnd);
    if (rowEnd > rowStart) {
      this.stats.dynamicRowsStaged += rowEnd - rowStart;
      this.stats.bytesStaged += (rowEnd - rowStart) * dynamicTextureWidth(texture) * BYTES_PER_TEXEL;
    }
  }
}
