import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import type { CoasterPiece } from '../../../game/coaster/design';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { COLOUR_SWATCHES, colourSlotsFor, ENTRANCE_COLOUR_ID, sameObjectColours, SWATCH_COUNT } from '../../../game/content/colours';
import type { ObjectColours } from '../../../game/content/colours';
import { GROUND_ALT, GROUND_WATER } from '../../../game/maps/types';
import type { PropKindDefinition } from '../../../game/maps/props';
import { PROP_KIND_BY_ID } from '../../../game/maps/props';
import { propFootprintSize } from '../../../game/maps/parse';
import type { BiomeDefinition } from '../../../game/biomes/types';
import { footprintSize } from '../../../game/types';
import type { BuildDefinition, Cell, PlacedObject, Rotation } from '../../../game/types';
import type { CoasterRecord, GameWorld } from '../../../game/World';
import { coasterHeadIndex } from '../../coasterTrain';
import type { FlatModel, ModelCache } from '../blueprint/compile';
import { placeholderCoaster, placeholderContent, placeholderEntrance, placeholderLitter, placeholderProp } from '../content/placeholder';
import { coasterContentFor, contentFor, entranceBlueprint, litterContent, propContentFor } from '../content/registry';
import { COLOUR_TAG_LIMIT } from '../contracts/blueprint';
import type { Blueprint, CompiledModel, Vec3 } from '../contracts/blueprint';
import { BOX_FLOATS, BoxWriter, packBoxWord, STATIC_SLOT, TRANSFORM_FLOATS, withMaterial, withOutlineGroup } from '../contracts/boxes';
import type { CoasterContent, LitterEmitter, ObjectContent, PropContent } from '../contracts/content';
import type { TexelBounds } from '../contracts/frame';
import { createViewTransform } from '../contracts/view';
import type { ViewTransform } from '../contracts/view';
import { objectOutlineGroup, OUTLINE_GROUP_GROUND, propOutlineGroup } from '../contracts/gbuffer';
import { MAT, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { coasterCarSlotKey, coasterCouplingSlotKey, coasterRiderSlotKey } from '../contracts/rigid';
import type { PartDriver, PartPose } from '../contracts/rigid';
import {
  CHUNK_TILES,
  chunkCountFor,
  chunkIndexOfCell,
  GROUND_TOP_Z,
  PATH_TOP_Z,
  PLOT_TOP_Z,
  SOIL_DEPTH,
  visualQuarterTurn,
  VOXELS_PER_TILE,
} from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';
import {
  COASTER_LOOP_RADIUS_VOXELS,
  coasterRailTopZ,
  createCoasterCarPoses,
  placeCoasterCars,
  writeCoasterCarTransforms,
} from './coasterCars';
import type { CoasterCarPoses } from './coasterCars';
import { groundStyleFor, meadowGroundStyle } from './groundStyle';
import type { GroundStyle } from './groundStyle';
import { LightList } from './lights';
import { writeRotatedPartTransform } from './rigid';
import type { TransformTable } from './rigid';

/**
 * The static world (design §9): the park turned into one box list per 8×8-tile chunk, rebuilt only
 * for the chunks construction touched.
 *
 * Per chunk, in world voxels (contracts/space.ts layering — no two boxes ever overlap, because
 * coplanar overlaps z-fight on real GPUs):
 * - terrain, z ∈ [−16, 0): a 1-voxel grass layer (PATTERN.GRASS: the legacy two-green checker and
 *   the grid line) over 15 voxels of soil (PATTERN.SOIL strata) — the diorama edge;
 * - paths, [0, 1): paving (PATTERN.PAVING) merged into runs along x and down y, with a 1-voxel curb
 *   2 tall on every edge that has no path beyond it (the only thing above z = 1 on a path edge);
 * - plots, [0, 1): a slab tinted by the object's colour (palette.plotTint) under every object but
 *   coasters, and for rides the legacy fence — posts 2×2×10 every 16 voxels, rails at z 5 and 9 —
 *   around the plot, open wherever a path touches it (WorldRenderer.createObjectBase's rule);
 * - models from z = 1: every object's compiled model placed at 32·anchor (its moving parts drawn
 *   through transform slots), the entrance gate, each coaster piece in its own chunk and the
 *   coaster's cars in the chunk of its first piece.
 * Each chunk is sorted front to back (descending max-corner depth key) with the ground (outline
 * group 0) last, so a real GPU's early-Z rejects what the first boxes already hide.
 *
 * Dirty tracking: `sync` diffs the world — the path grid when pathVersion moves, object ids with
 * their definition, rotation and anchor, coaster ids — and marks only the chunks whose boxes can
 * change: an object's home chunk (every piece chunk for a coaster); for a path tile its own chunk,
 * the chunks of the path tiles beside it (their curbs) and the home chunks of the rides beside it
 * (their fences). world.version is never a geometry key: money and park-open changes notify too.
 * Phase 28: an object's colour record is a geometry key of its own chunk(s) only (compared by value; the
 * slots, tags and substitution are under `SceneModels.slotTable`); a recolour changes the material byte of the
 * tagged boxes and nothing else, so no box count, extent, order or transform slot moves.
 * Rebuilds read the current world and are deterministic, so a chunk rebuilt incrementally is
 * identical to one built from scratch (equivalence.test.ts), transform slots aside, which hashes
 * compare through the slot's key.
 */

const TILE = VOXELS_PER_TILE;
/** Grass layer on top of the soil; the rest of SOIL_DEPTH is soil. */
const GRASS_DEPTH = 1;
const CURB_WIDTH = 1;
const CURB_HEIGHT = 2;
const FENCE_POST_SIZE = 2;
const FENCE_POST_HEIGHT = 10;
const FENCE_POST_SPACING = 16;
const FENCE_RAIL_HEIGHT = 1;
/** Rail bottoms (art bible: rails at z 5 and 9). */
const FENCE_RAIL_Z: readonly number[] = [5, 9];
/** Transform-table layout of a slot's pivot (contracts/boxes.ts). */
const PIVOT_FLOATS = TRANSFORM_FLOATS;
/** Voxels above the highest rail a coaster's train can reach: a loop's diameter plus a car. */
const COASTER_TRAIN_HEADROOM = 2 * COASTER_LOOP_RADIUS_VOXELS + 12;
/** Horizontal slack around a track for cars overhanging their centreline and loop rings. */
const COASTER_TRACK_MARGIN = 2 * COASTER_LOOP_RADIUS_VOXELS;
/** Catalog duration of a ride without one (World.rideProfile's default). */
const DEFAULT_RIDE_DURATION_SECONDS = 30;
/**
 * Highest a moving ride part may reach (art bible: rides top out at 150), with a margin. A driver
 * may move a part's pivot anywhere inside its footprint, so a moving part is bounded by the whole
 * footprint column up to here as well as by its own sweep around the pivot at rest.
 */
const MOVING_PART_CEILING_Z = 160;
/** Train length when a coaster type is unknown (legacy's default). */
const DEFAULT_TRAIN_CARS = 4;

/** The entrance gate is not a placed object; it takes the outline group no object id maps to first. */
const ENTRANCE_OUTLINE_GROUP = objectOutlineGroup(0);

const CARDINAL_X: readonly number[] = [1, -1, 0, 0];
const CARDINAL_Y: readonly number[] = [0, 0, 1, -1];

/** The pose a closed ride's parts rest in (contracts/rigid.ts restPose): offset 0, identity rotation. */
const REST_POSE: Readonly<PartPose> = { dx: 0, dy: 0, dz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };

// ---- Content -------------------------------------------------------------------------------------

/**
 * Where the scene's models come from. The registry in the game; tests swap in the placeholders to
 * pin the static world independently of the content being authored.
 */
export interface SceneContent {
  objectContent(definitionId: string): ObjectContent;
  coaster(): CoasterContent;
  litter(): LitterEmitter;
  entrance(palette: Palette): Blueprint;
  /** Phase 24: a map prop's content. */
  prop(kind: PropKindDefinition['id']): PropContent;
}

export const REGISTRY_CONTENT: SceneContent = {
  objectContent: contentFor,
  coaster: coasterContentFor,
  litter: litterContent,
  entrance: entranceBlueprint,
  prop: propContentFor,
};

const PLACEHOLDER_OBJECT = placeholderContent();

/** The stand-in content every failing model falls back to, as a whole content source. */
export const PLACEHOLDER_CONTENT: SceneContent = {
  objectContent: () => PLACEHOLDER_OBJECT,
  coaster: () => placeholderCoaster,
  litter: () => placeholderLitter,
  entrance: placeholderEntrance,
  prop: () => placeholderProp,
};

/** How a content failure is reported: once per failing blueprint, never per frame. */
export type ContentErrorReporter = (message: string, error: unknown) => void;

export const reportContentError: ContentErrorReporter = (message, error) => {
  console.error(message, error);
};

interface ResolvedBlueprint {
  blueprint: Blueprint;
  /** False once the content failed and the placeholder stands in; its drivers then never apply. */
  fromContent: boolean;
}

const PREWARM_OBJECT = 0;
const PREWARM_CAR = 1;
const PREWARM_ENTRANCE = 2;
const PREWARM_RIDERS = 3;
const PREWARM_COUPLING = 4;

/** One blueprint the idle prewarm compiles ahead of need. */
export interface PrewarmTask {
  kind: number;
  definition: BuildDefinition | null;
  carIndex: number;
}

const footprintArea = (definition: BuildDefinition): number => definition.footprint[0] * definition.footprint[1];

/** Buildable catalog objects the prewarm covers, smallest footprint first (catalog order within). */
const PREWARM_CATALOG: readonly BuildDefinition[] = BUILD_CATALOG
  .filter((definition) => definition.kind !== 'path' && !definition.custom)
  .map((definition, index) => ({ definition, index }))
  .sort((left, right) => footprintArea(left.definition) - footprintArea(right.definition) || left.index - right.index)
  .map((entry) => entry.definition);

const COASTER_DEFINITIONS: readonly BuildDefinition[] = BUILD_CATALOG.filter((definition) => definition.custom === 'coaster');

/**
 * Blueprints and compiled models for the scene, with every content failure isolated: a blueprint
 * that throws while it is built or compiled is reported once and replaced by its placeholder for
 * good. The compiler does not memoise failures, so without this a content bug would throw from
 * every frame that needs the model. The fallback is per blueprint (per call for coaster pieces and
 * litter), so a scene rebuilt in any order still reaches the same boxes.
 */
export class SceneModels {
  readonly palette: Palette;
  readonly cache: ModelCache;
  private readonly content: SceneContent;
  private readonly report: ContentErrorReporter;
  private readonly resolved = new Map<string, ResolvedBlueprint>();
  private readonly reported = new Set<string>();
  private readonly grounds = new Map<string, GroundStyle>();
  /** A one-element queue for ModelCache.prewarm, reused so a prewarm step allocates nothing. */
  private readonly single: Blueprint[] = [];
  private prewarmQueue: readonly PrewarmTask[] = [];
  private prewarmNext = 0;
  /** Phase 28: the palette material of every colour swatch (0 = the palette lacks it), built once. */
  private readonly swatchMaterials = new Uint8Array(SWATCH_COUNT);

  constructor(palette: Palette, cache: ModelCache, content: SceneContent = REGISTRY_CONTENT, report: ContentErrorReporter = reportContentError) {
    this.palette = palette;
    this.cache = cache;
    this.content = content;
    this.report = report;
    for (const swatch of COLOUR_SWATCHES) {
      try {
        this.swatchMaterials[swatch.index] = palette.material(swatch.rgb);
      } catch {
        // A palette built without the swatch colours (tests): that swatch repaints nothing, reported once on use.
      }
    }
  }

  /**
   * The unflagged palette material a colour swatch paints, or 0 when `swatch` is not a swatch index or
   * the palette has no material for it (the box then keeps its default colour). Never throws.
   */
  swatchMaterial(swatch: number): number {
    if (!Number.isInteger(swatch) || swatch < 0 || swatch >= SWATCH_COUNT) return 0;
    const material = this.swatchMaterials[swatch];
    if (material === 0) this.reportOnce(`colour swatch ${swatch}`, new Error(`The palette has no material for swatch ${swatch}.`));
    return material;
  }

  /**
   * Phase 28: fills `table` (index = colour slot tag, 0 = keep the box's own material) from a colour record
   * of `definitionId` and returns it, or returns null when the record repaints nothing (no record, every slot
   * on its default, a swatch the palette lacks). The slot's tag is its position in the definition's slot
   * list plus one. Allocates nothing: `table` is the caller's scratch.
   */
  slotTable(definitionId: string, colours: ObjectColours | null | undefined, table: Uint8Array): Uint8Array | null {
    if (!colours) return null;
    const slots = colourSlotsFor(definitionId);
    table.fill(0);
    let any = false;
    for (let index = 0; index < slots.length && index < colours.length; index += 1) {
      const swatch = colours[index];
      if (swatch === null || swatch === undefined) continue;
      const material = this.swatchMaterial(swatch);
      if (material === 0) continue;
      table[slots[index].tag] = material;
      any = true;
    }
    return any ? table : null;
  }

  /** The compiled model of a catalog object at a visual quarter turn; never throws for a content bug. */
  objectModel(definition: BuildDefinition, quarterTurn: QuarterTurn): CompiledModel {
    const entry = this.objectEntry(definition);
    if (entry.fromContent) {
      try {
        return this.cache.model(entry.blueprint, quarterTurn);
      } catch (error) {
        this.fallBack(definition.id, entry, PLACEHOLDER_OBJECT.blueprint(definition, this.palette), error);
      }
    }
    return this.cache.model(entry.blueprint, quarterTurn);
  }

  /** Every part of the model at rest in one model-space list (the ghost preview). */
  objectFlat(definition: BuildDefinition, quarterTurn: QuarterTurn): FlatModel {
    this.objectModel(definition, quarterTurn);
    return this.cache.flat(this.objectEntry(definition).blueprint, quarterTurn);
  }

  /** The part drivers of a definition, or undefined when its placeholder stands in. */
  drivers(definition: BuildDefinition): Readonly<Record<string, PartDriver>> | undefined {
    const entry = this.objectEntry(definition);
    return entry.fromContent ? this.content.objectContent(definition.id).drivers : undefined;
  }

  /**
   * The entrance gate, all parts at rest (it has no drivers). `quarterTurn` 1 is a gate on an east or west edge
   * (Phase 24: guests walk along x there, so the frame of posts stands across y).
   */
  entranceModel(quarterTurn: QuarterTurn = 0): CompiledModel {
    const entry = this.entranceEntry();
    if (entry.fromContent) {
      try {
        return this.cache.model(entry.blueprint, quarterTurn);
      } catch (error) {
        this.fallBack('the entrance', entry, placeholderEntrance(this.palette), error);
      }
    }
    return this.cache.model(entry.blueprint, quarterTurn);
  }

  entranceFlat(quarterTurn: QuarterTurn = 0): FlatModel {
    this.entranceModel(quarterTurn);
    return this.cache.flat(this.entranceEntry().blueprint, quarterTurn);
  }

  /**
   * Phase 24: the box words of a biome's ground. A palette that lacks the biome's colours (one built without
   * `biomeMaterials`) falls back to Meadow's words, reported once.
   */
  groundStyle(biome: BiomeDefinition): GroundStyle {
    const cached = this.grounds.get(biome.id);
    if (cached) return cached;
    let style: GroundStyle;
    try {
      style = groundStyleFor(this.palette, biome);
    } catch (error) {
      this.reportOnce(`the ${biome.id} ground`, error);
      style = meadowGroundStyle();
    }
    this.grounds.set(biome.id, style);
    return style;
  }

  /** The compiled model of a map prop at a visual quarter turn; never throws for a content bug. */
  propModel(kind: PropKindDefinition, quarterTurn: QuarterTurn): CompiledModel {
    const entry = this.propEntry(kind);
    if (entry.fromContent) {
      try {
        return this.cache.model(entry.blueprint, quarterTurn);
      } catch (error) {
        this.fallBack(`prop ${kind.id}`, entry, placeholderProp.blueprint(kind, this.palette), error);
      }
    }
    return this.cache.model(entry.blueprint, quarterTurn);
  }

  /** Every part of the prop at rest in one model-space list. */
  propFlat(kind: PropKindDefinition, quarterTurn: QuarterTurn): FlatModel {
    this.propModel(kind, quarterTurn);
    return this.cache.flat(this.propEntry(kind).blueprint, quarterTurn);
  }

  /** Car `carIndex` of a coaster type, every part at rest in car space. */
  carFlat(definition: BuildDefinition, carIndex: number): FlatModel {
    const entry = this.carEntry(definition, carIndex);
    if (entry.fromContent) {
      try {
        return this.cache.flat(entry.blueprint, 0);
      } catch (error) {
        this.fallBack(`${definition.id} cars`, entry, placeholderCoaster.carBlueprint(definition, carIndex, this.palette), error);
      }
    }
    return this.cache.flat(entry.blueprint, 0);
  }

  /** The riders of car `carIndex`, in car space (a separate rigid part). */
  riderFlat(definition: BuildDefinition, carIndex: number): FlatModel {
    const entry = this.riderEntry(definition, carIndex);
    if (entry.fromContent) {
      try {
        return this.cache.flat(entry.blueprint, 0);
      } catch (error) {
        this.fallBack(`${definition.id} riders`, entry, placeholderCoaster.riderBlueprint(definition, carIndex, this.palette), error);
      }
    }
    return this.cache.flat(entry.blueprint, 0);
  }

  /** Half of the coupling bar between two cars of a coaster type, in its own space (from its pivot, a hitch, along +x). Two per coupling. */
  couplingFlat(definition: BuildDefinition): FlatModel {
    const entry = this.couplingEntry(definition);
    if (entry.fromContent) {
      try {
        return this.cache.flat(entry.blueprint, 0);
      } catch (error) {
        this.fallBack(`${definition.id} couplings`, entry, placeholderCoaster.couplingBlueprint(definition, this.palette), error);
      }
    }
    return this.cache.flat(entry.blueprint, 0);
  }

  /**
   * One coaster piece's track boxes (world voxels) into `out`. A piece the content cannot build is
   * replaced by the placeholder's for that piece alone, so the fallback never depends on the order
   * pieces happen to be built in.
   */
  pieceBoxes(
    pieces: readonly CoasterPiece[],
    index: number,
    definition: BuildDefinition,
    outlineGroup: number,
    out: BoxWriter,
    paint: Uint8Array | null = null,
    supports = true,
  ): void {
    const start = out.count;
    try {
      this.content.coaster().pieceBoxes(pieces, index, definition, this.palette, outlineGroup, out, paint, supports);
    } catch (error) {
      out.count = start;
      this.reportOnce(`coaster track of ${definition.id}`, error);
      placeholderCoaster.pieceBoxes(pieces, index, definition, this.palette, outlineGroup, out, null, supports);
    }
  }

  /** One litter pile's boxes into `out`, with the placeholder standing in for a failing emitter. */
  litterBoxes(cellX: number, cellY: number, units: number, out: BoxWriter, sick = false): void {
    const start = out.count;
    try {
      this.content.litter()(cellX, cellY, units, this.palette, out, sick);
    } catch (error) {
      out.count = start;
      this.reportOnce('litter', error);
      placeholderLitter(cellX, cellY, units, this.palette, out);
    }
  }

  /** Whether the object's own content (not the placeholder) builds it. */
  fromContent(definition: BuildDefinition): boolean {
    return this.objectEntry(definition).fromContent;
  }

  /** Replaces the prewarm queue (smallest blueprints first is the caller's job). */
  setPrewarmQueue(tasks: readonly PrewarmTask[]): void {
    this.prewarmQueue = tasks;
    this.prewarmNext = 0;
  }

  /** Blueprints the prewarm has not reached yet. */
  get prewarmRemaining(): number {
    return this.prewarmQueue.length - this.prewarmNext;
  }

  /**
   * Compiles queued blueprints (both quarter turns) through ModelCache.prewarm until `budgetMs` is
   * spent — at least one per call, so a slow blueprint cannot stall the queue. The clock is read
   * between blueprints only. Returns how many tasks remain; allocation-free once the queue is done.
   */
  prewarm(budgetMs: number): number {
    const queue = this.prewarmQueue;
    if (this.prewarmNext >= queue.length || !(budgetMs > 0)) return queue.length - this.prewarmNext;
    const started = performance.now();
    let compiled = 0;
    while (this.prewarmNext < queue.length) {
      const spent = performance.now() - started;
      if (compiled > 0 && spent >= budgetMs) break;
      const task = queue[this.prewarmNext];
      this.prewarmNext += 1;
      if (this.prewarmTask(task, Math.max(budgetMs - spent, Number.MIN_VALUE))) compiled += 1;
    }
    return queue.length - this.prewarmNext;
  }

  /** The default queue: the gate, what the world holds, then the rest of the catalog and the cars. */
  static prewarmQueueFor(world: GameWorld): PrewarmTask[] {
    const tasks: PrewarmTask[] = [{ kind: PREWARM_ENTRANCE, definition: null, carIndex: 0 }];
    const queued = new Set<string>();
    const inWorld: BuildDefinition[] = [];
    for (const object of world.objects.values()) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition || definition.custom || queued.has(definition.id)) continue;
      queued.add(definition.id);
      inWorld.push(definition);
    }
    inWorld.sort((left, right) => footprintArea(left) - footprintArea(right));
    for (const definition of inWorld) tasks.push({ kind: PREWARM_OBJECT, definition, carIndex: 0 });
    for (const definition of PREWARM_CATALOG) {
      if (!queued.has(definition.id)) tasks.push({ kind: PREWARM_OBJECT, definition, carIndex: 0 });
    }
    for (const definition of COASTER_DEFINITIONS) {
      const cars = COASTER_TYPE_BY_ID.get(definition.id)?.trainCars ?? DEFAULT_TRAIN_CARS;
      for (let carIndex = 0; carIndex < cars; carIndex += 1) {
        tasks.push({ kind: PREWARM_CAR, definition, carIndex });
        tasks.push({ kind: PREWARM_RIDERS, definition, carIndex });
      }
      tasks.push({ kind: PREWARM_COUPLING, definition, carIndex: 0 });
    }
    return tasks;
  }

  /** True when the task had to compile something. */
  private prewarmTask(task: PrewarmTask, budgetMs: number): boolean {
    const definition = task.definition;
    let entry: ResolvedBlueprint;
    let what: string;
    if (task.kind === PREWARM_ENTRANCE || definition === null) {
      entry = this.entranceEntry();
      what = 'the entrance';
    } else if (task.kind === PREWARM_CAR) {
      entry = this.carEntry(definition, task.carIndex);
      what = `${definition.id} cars`;
    } else if (task.kind === PREWARM_RIDERS) {
      entry = this.riderEntry(definition, task.carIndex);
      what = `${definition.id} riders`;
    } else if (task.kind === PREWARM_COUPLING) {
      entry = this.couplingEntry(definition);
      what = `${definition.id} couplings`;
    } else {
      entry = this.objectEntry(definition);
      what = definition.id;
    }
    const blueprint = entry.blueprint;
    if (this.cache.isReady(blueprint.id, 0) && this.cache.isReady(blueprint.id, 1)) return false;
    this.single[0] = blueprint;
    try {
      this.cache.prewarm(this.single, budgetMs);
    } catch (error) {
      const fallback = task.kind === PREWARM_ENTRANCE || definition === null
        ? placeholderEntrance(this.palette)
        : task.kind === PREWARM_CAR
          ? placeholderCoaster.carBlueprint(definition, task.carIndex, this.palette)
          : task.kind === PREWARM_RIDERS
            ? placeholderCoaster.riderBlueprint(definition, task.carIndex, this.palette)
            : task.kind === PREWARM_COUPLING
              ? placeholderCoaster.couplingBlueprint(definition, this.palette)
              : PLACEHOLDER_OBJECT.blueprint(definition, this.palette);
      this.fallBack(what, entry, fallback, error);
      this.single[0] = entry.blueprint;
      this.cache.prewarm(this.single, budgetMs);
    }
    return true;
  }

  private objectEntry(definition: BuildDefinition): ResolvedBlueprint {
    const cached = this.resolved.get(definition.id);
    if (cached) return cached;
    let entry: ResolvedBlueprint;
    try {
      entry = { blueprint: this.content.objectContent(definition.id).blueprint(definition, this.palette), fromContent: true };
    } catch (error) {
      this.reportOnce(definition.id, error);
      entry = { blueprint: PLACEHOLDER_OBJECT.blueprint(definition, this.palette), fromContent: false };
    }
    this.resolved.set(definition.id, entry);
    return entry;
  }

  private propEntry(kind: PropKindDefinition): ResolvedBlueprint {
    const key = `#prop:${kind.id}`;
    const cached = this.resolved.get(key);
    if (cached) return cached;
    let entry: ResolvedBlueprint;
    try {
      entry = { blueprint: this.content.prop(kind.id).blueprint(kind, this.palette), fromContent: true };
    } catch (error) {
      this.reportOnce(`prop ${kind.id}`, error);
      entry = { blueprint: placeholderProp.blueprint(kind, this.palette), fromContent: false };
    }
    this.resolved.set(key, entry);
    return entry;
  }

  private entranceEntry(): ResolvedBlueprint {
    const key = '#entrance';
    const cached = this.resolved.get(key);
    if (cached) return cached;
    let entry: ResolvedBlueprint;
    try {
      entry = { blueprint: this.content.entrance(this.palette), fromContent: true };
    } catch (error) {
      this.reportOnce('the entrance', error);
      entry = { blueprint: placeholderEntrance(this.palette), fromContent: false };
    }
    this.resolved.set(key, entry);
    return entry;
  }

  private carEntry(definition: BuildDefinition, carIndex: number): ResolvedBlueprint {
    const key = `#car:${definition.id}:${carIndex}`;
    const cached = this.resolved.get(key);
    if (cached) return cached;
    let entry: ResolvedBlueprint;
    try {
      entry = { blueprint: this.content.coaster().carBlueprint(definition, carIndex, this.palette), fromContent: true };
    } catch (error) {
      this.reportOnce(`${definition.id} cars`, error);
      entry = { blueprint: placeholderCoaster.carBlueprint(definition, carIndex, this.palette), fromContent: false };
    }
    this.resolved.set(key, entry);
    return entry;
  }

  private riderEntry(definition: BuildDefinition, carIndex: number): ResolvedBlueprint {
    const key = `#riders:${definition.id}:${carIndex}`;
    const cached = this.resolved.get(key);
    if (cached) return cached;
    let entry: ResolvedBlueprint;
    try {
      entry = { blueprint: this.content.coaster().riderBlueprint(definition, carIndex, this.palette), fromContent: true };
    } catch (error) {
      this.reportOnce(`${definition.id} riders`, error);
      entry = { blueprint: placeholderCoaster.riderBlueprint(definition, carIndex, this.palette), fromContent: false };
    }
    this.resolved.set(key, entry);
    return entry;
  }

  private couplingEntry(definition: BuildDefinition): ResolvedBlueprint {
    const key = `#coupling:${definition.id}`;
    const cached = this.resolved.get(key);
    if (cached) return cached;
    let entry: ResolvedBlueprint;
    try {
      entry = { blueprint: this.content.coaster().couplingBlueprint(definition, this.palette), fromContent: true };
    } catch (error) {
      this.reportOnce(`${definition.id} couplings`, error);
      entry = { blueprint: placeholderCoaster.couplingBlueprint(definition, this.palette), fromContent: false };
    }
    this.resolved.set(key, entry);
    return entry;
  }

  private fallBack(what: string, entry: ResolvedBlueprint, fallback: Blueprint, error: unknown): void {
    this.reportOnce(what, error);
    entry.blueprint = fallback;
    entry.fromContent = false;
  }

  private reportOnce(what: string, error: unknown): void {
    if (this.reported.has(what)) return;
    this.reported.add(what);
    this.report(`Voxel content for ${what} failed; drawing its placeholder instead.`, error);
  }
}

// ---- Placements ----------------------------------------------------------------------------------

/** A moving part of a placed model: the transform slot it is drawn through and its turned pivot. */
export interface PartPlacement {
  readonly partId: string;
  readonly slot: number;
  /** The part's pivot in the TURNED model (rotateModel), model space. */
  readonly pivot: Vec3;
}

/** What the frame loop needs of a placed object after its chunk was built. */
export interface ObjectPlacement {
  readonly objectId: number;
  readonly definition: BuildDefinition;
  readonly homeChunk: number;
  readonly originX: number;
  readonly originY: number;
  readonly quarterTurn: QuarterTurn;
  /** Highest z of the model at rest (world voxels): overlay badges sit above it. */
  readonly top: number;
  /** Moving parts (model parts 1+ with boxes), in part order. */
  readonly parts: readonly PartPlacement[];
  /** Whether the object's own content built it; only then do its drivers apply. */
  readonly fromContent: boolean;
  /** Seconds per ride cycle (World.rideProfile's catalog duration). */
  readonly durationSeconds: number;
}

/** A coaster's train as the frame loop poses it. */
export interface TrainPlacement {
  readonly objectId: number;
  readonly record: CoasterRecord;
  readonly carCount: number;
  /** Riders the train can seat (the coaster type's capacity), to turn a head count into loaded cars. */
  readonly capacity: number;
  readonly poses: CoasterCarPoses;
  readonly homeChunk: number;
  readonly top: number;
}

/** Phase 24: a prop as the chunks were last built with it (props only ever disappear in play, or all change on a restore). */
interface KnownProp {
  kind: string;
  x: number;
  y: number;
  rotation: Rotation;
  /** Its home chunk (the chunk of its front-most footprint cell, the object rule). */
  chunk: number;
  stamp: number;
}

interface KnownObject {
  definitionId: string;
  rotation: Rotation;
  anchorX: number;
  anchorY: number;
  /** Chunks the object's boxes live in: its home chunk, or every chunk a coaster's pieces touch. */
  chunks: number[];
  /** Phase 28: the colour record the object's boxes were last emitted with (undefined = defaults). */
  colours: ObjectColours | undefined;
  stamp: number;
}

/**
 * A chunk's screen bounds (in VIEW texels), owned by the chunk so a rebuild allocates none. `sweeps` keeps
 * the WORLD voxel AABBs of what moves (ride-part sweeps, a coaster's track volume), so a view turn can
 * recompute the bounds without rebuilding the chunk.
 */
const EXTENT_STRIDE = 7;

class ChunkBounds implements TexelBounds {
  minX = 0;
  minY = 0;
  maxX = 0;
  maxY = 0;
  readonly sweeps: number[] = [];
  /** Per box in the current (sorted) order: the WORLD AABB x0, y0, z0, x1, y1, z1 the sort key is taken from, then the box's emission index (the tie-break, so every view sorts as a rebuild does). */
  extents = new Float64Array(EXTENT_STRIDE * 512);
}

const emptyAccumulator = (bounds: ChunkBounds): void => {
  bounds.minX = Number.POSITIVE_INFINITY;
  bounds.minY = Number.POSITIVE_INFINITY;
  bounds.maxX = Number.NEGATIVE_INFINITY;
  bounds.maxY = Number.NEGATIVE_INFINITY;
};

/** Records a moving volume (world voxels): its screen bounds are taken per view in `orderChunk`. */
const addSweep = (bounds: ChunkBounds, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
  bounds.sweeps.push(x0, y0, z0, x1, y1, z1);
};

/**
 * Grows `bounds` by the screen projection of a world-voxel AABB seen through the view transform. For the
 * identity view this is the plain projection (u = x, v = y). The corners (x0, y0) and (x1, y1) hold the
 * extremes of u and v because each is monotone in x and y (c and s are -1, 0 or 1 and one of them is 0).
 */
const includeBox = (
  bounds: ChunkBounds,
  view: Readonly<ViewTransform>,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): void => {
  const { c, s, ox, oy } = view;
  const ua = c * x0 - s * y0 + ox;
  const ub = c * x1 - s * y1 + ox;
  const va = s * x0 + c * y0 + oy;
  const vb = s * x1 + c * y1 + oy;
  const u0 = ua < ub ? ua : ub;
  const u1 = ua < ub ? ub : ua;
  const v0 = va < vb ? va : vb;
  const v1 = va < vb ? vb : va;
  const minX = u0 - v1;
  const maxX = u1 - v0;
  const minY = (u0 + v0) / 2 - z1;
  const maxY = (u1 + v1) / 2 - z0;
  if (minX < bounds.minX) bounds.minX = minX;
  if (maxX > bounds.maxX) bounds.maxX = maxX;
  if (minY < bounds.minY) bounds.minY = minY;
  if (maxY > bounds.maxY) bounds.maxY = maxY;
};

// Sort keys: rank · 2^20 + box index, so a numeric typed-array sort orders boxes with no comparator.
const SORT_INDEX_SCALE = 2 ** 20;
const SORT_DEPTH_LIMIT = 8191;
const SORT_GROUND_RANK = 16_384;

// ---- Hashing (equivalence tests) -----------------------------------------------------------------

const HASH_FLOAT = new Float32Array(1);
const HASH_BITS = new Uint32Array(HASH_FLOAT.buffer);

class ChunkHasher {
  private first = 0x811c_9dc5;
  private second = 0x2545_f491;

  add(value: number): void {
    HASH_FLOAT[0] = value;
    const bits = HASH_BITS[0];
    this.first = Math.imul(this.first ^ bits, 0x0100_0193) >>> 0;
    this.second = Math.imul((this.second + bits) ^ (this.second >>> 13), 0x5bd1_e995) >>> 0;
  }

  get digest(): string {
    return `${this.first.toString(16).padStart(8, '0')}${this.second.toString(16).padStart(8, '0')}`;
  }
}

// ---- The static world ----------------------------------------------------------------------------

export interface StaticWorldOptions {
  width: number;
  height: number;
  models: SceneModels;
  transforms: TransformTable;
  /** The scene's view transform, read on every sort and bounds pass (never copied; the scene mutates it). */
  view?: Readonly<ViewTransform>;
}

export class StaticWorld {
  readonly width: number;
  readonly height: number;
  readonly chunkCount: number;
  readonly chunksAcross: number;
  /** 1 where the chunk must be rebuilt before it is drawn again. */
  readonly dirty: Uint8Array;
  /** Per chunk: the lights its models declare (world voxels). */
  readonly lights: readonly LightList[];
  /** Indices of the chunks the last `rebuildDirty` rebuilt, in index order. */
  readonly rebuiltChunks: Int32Array;
  /** Indices of the chunks the last `reorderForView` re-sorted, in index order. */
  readonly reorderedChunks: Int32Array;
  private readonly models: SceneModels;
  private readonly transforms: TransformTable;
  private readonly view: Readonly<ViewTransform>;
  private readonly writers: BoxWriter[];
  private readonly boundsStore: ChunkBounds[];
  private readonly boundsOf: (ChunkBounds | null)[];
  private readonly placementMap = new Map<number, ObjectPlacement>();
  private readonly trainMap = new Map<number, TrainPlacement>();
  private readonly known = new Map<number, KnownObject>();
  private readonly pendingRemovals: number[] = [];
  private paths: Uint8Array;
  private nextPaths: Uint8Array;
  private knownPathVersion = -1;
  /** Phase 24: the props the chunks were built with, and the world's prop revision they were diffed at (-1 = never). */
  private readonly knownProps = new Map<number, KnownProp>();
  private knownPropRevision = -1;
  /** The ground words of the biome being emitted (set per chunk rebuild from the world's map). */
  private style: GroundStyle = meadowGroundStyle();
  /** Phase 28: the gate record the entrance chunk was last emitted with (undefined = not yet seen: everything is dirty anyway). */
  private knownGateColours: ObjectColours | null | undefined = undefined;
  private stamp = 0;
  private readonly probe: Cell = { x: 0, y: 0 };
  private readonly scratch = new BoxWriter(1024);
  /** Phase 28: colour slot tag → swatch material for the object being emitted (see SceneModels.slotTable). */
  private readonly slotMaterials = new Uint8Array(COLOUR_TAG_LIMIT);
  private sortKeys = new Float64Array(1024);
  private extentScratch = new Float64Array(EXTENT_STRIDE * 1024);
  private inverse = new Int32Array(1024);
  private previousRow = new Map<string, number>();
  private currentRow = new Map<string, number>();
  /** Fence flags of the plot being fenced: side (N, S, W, E) × cell along the side. */
  private readonly sideFenced = new Uint8Array(4 * 8);
  private readonly cutStarts: number[] = [];
  private readonly cutEnds: number[] = [];

  constructor(options: StaticWorldOptions) {
    this.width = options.width;
    this.height = options.height;
    this.models = options.models;
    this.transforms = options.transforms;
    this.view = options.view ?? createViewTransform();
    this.chunkCount = chunkCountFor(this.width, this.height);
    this.chunksAcross = Math.ceil(this.width / CHUNK_TILES);
    this.dirty = new Uint8Array(this.chunkCount).fill(1);
    this.rebuiltChunks = new Int32Array(this.chunkCount);
    this.reorderedChunks = new Int32Array(this.chunkCount);
    this.writers = Array.from({ length: this.chunkCount }, () => new BoxWriter(512));
    this.lights = Array.from({ length: this.chunkCount }, () => new LightList());
    this.boundsStore = Array.from({ length: this.chunkCount }, () => new ChunkBounds());
    this.boundsOf = Array.from({ length: this.chunkCount }, () => null);
    this.paths = new Uint8Array(this.width * this.height);
    this.nextPaths = new Uint8Array(this.width * this.height);
  }

  /** Objects placed by the last rebuild of their chunk. */
  get placements(): ReadonlyMap<number, ObjectPlacement> {
    return this.placementMap;
  }

  get trains(): ReadonlyMap<number, TrainPlacement> {
    return this.trainMap;
  }

  /** A chunk's boxes (BOX layout; only `count` boxes are live). */
  chunkBoxes(index: number): BoxWriter {
    return this.writers[index];
  }

  /** A chunk's screen bounds in world texels, or null when it has no boxes. */
  chunkBounds(index: number): TexelBounds | null {
    return this.boundsOf[index];
  }

  get dirtyCount(): number {
    let count = 0;
    for (let index = 0; index < this.chunkCount; index += 1) count += this.dirty[index];
    return count;
  }

  /** Highest z (world voxels) of an object's model or train at rest, null for unknown objects. */
  objectTop(objectId: number): number | null {
    return this.placementMap.get(objectId)?.top ?? this.trainMap.get(objectId)?.top ?? null;
  }

  markAllDirty(): void {
    this.dirty.fill(1);
  }

  /**
   * Forgets everything derived from a world (a session swap): known objects and paths, placements,
   * trains; every chunk becomes dirty. Transform slots are the caller's to reset.
   */
  reset(): void {
    this.known.clear();
    this.knownGateColours = undefined;
    this.pendingRemovals.length = 0;
    this.placementMap.clear();
    this.trainMap.clear();
    this.paths.fill(0);
    this.knownPathVersion = -1;
    this.knownProps.clear();
    this.knownPropRevision = -1;
    this.markAllDirty();
  }

  /** Diffs the world against what was last seen and marks the chunks whose boxes can change. */
  sync(world: GameWorld): void {
    if (world.pathVersion !== this.knownPathVersion) this.syncPaths(world);
    if (world.propRevision !== this.knownPropRevision) this.syncProps(world);
    // The gate's colours are a park-level record: only the entrance chunk rebuilds, once, when the value changes.
    if (world.gateColours !== this.knownGateColours) {
      if (this.knownGateColours !== undefined && !sameObjectColours(this.knownGateColours, world.gateColours)) {
        this.dirty[chunkIndexOfCell(world.entrance.x, world.entrance.y, this.width)] = 1;
      }
      this.knownGateColours = world.gateColours;
    }
    this.stamp += 1;
    const stamp = this.stamp;
    for (const object of world.objects.values()) {
      const known = this.known.get(object.id);
      if (known && known.definitionId === object.definitionId && known.rotation === object.rotation
        && known.anchorX === object.anchor.x && known.anchorY === object.anchor.y) {
        known.stamp = stamp;
        // A recolour is a data change: only the object's own chunk(s) rebuild, once, and nothing is forgotten
        // (transform slots stay). Compared by value, so a restore that re-creates equal records rebuilds nothing.
        if (known.colours !== object.colours) {
          if (!sameObjectColours(known.colours, object.colours)) for (const chunk of known.chunks) this.dirty[chunk] = 1;
          known.colours = object.colours;
        }
        continue;
      }
      if (known) this.forget(object.id, known);
      this.learn(object, world, stamp);
    }
    for (const [objectId, known] of this.known) {
      if (known.stamp !== stamp) this.forget(objectId, known);
    }
  }

  /**
   * Rebuilds every dirty chunk from the current world, after releasing the transform slots of
   * removed objects (so new objects can take them over in the same pass). Returns how many chunks
   * were rebuilt; their indices are in `rebuiltChunks`.
   */
  rebuildDirty(world: GameWorld): number {
    // Index loops: this runs every frame, and a steady frame must not allocate an iterator.
    const removals = this.pendingRemovals;
    for (let index = 0; index < removals.length; index += 1) {
      const objectId = removals[index];
      this.transforms.releaseObject(objectId);
      this.placementMap.delete(objectId);
      this.trainMap.delete(objectId);
    }
    removals.length = 0;
    let rebuilt = 0;
    for (let index = 0; index < this.chunkCount; index += 1) {
      if (this.dirty[index] === 0) continue;
      this.dirty[index] = 0;
      this.rebuildChunk(index, world);
      this.rebuiltChunks[rebuilt] = index;
      rebuilt += 1;
    }
    return rebuilt;
  }

  /**
   * A digest of everything a chunk rebuild produces — boxes, bounds, lights — with each transform
   * slot replaced by the (object, part) key it was handed out for, because slot numbers depend on
   * the order objects came and went. For equivalence tests; allocates.
   */
  chunkHash(index: number): string {
    const hasher = new ChunkHasher();
    const writer = this.writers[index];
    const data = writer.data;
    hasher.add(writer.count);
    for (let box = 0; box < writer.count; box += 1) {
      const at = box * BOX_FLOATS;
      for (let field = 0; field < 7; field += 1) hasher.add(data[at + field]);
      const slot = data[at + 7];
      if (slot === STATIC_SLOT) {
        hasher.add(0);
        continue;
      }
      const key = this.transforms.keyOfSlot(slot);
      hasher.add(-1);
      hasher.add(key === null ? Number.NaN : key.objectId);
      hasher.add(key === null ? Number.NaN : key.partKey);
    }
    const bounds = this.boundsOf[index];
    if (bounds === null) hasher.add(Number.NaN);
    else {
      hasher.add(bounds.minX);
      hasher.add(bounds.minY);
      hasher.add(bounds.maxX);
      hasher.add(bounds.maxY);
    }
    const lights = this.lights[index];
    hasher.add(lights.count);
    for (let value = 0; value < lights.count * 8; value += 1) hasher.add(lights.data[value]);
    return hasher.digest;
  }

  // ---- Diff --------------------------------------------------------------------------------------

  private isPathIn(grid: Uint8Array, x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height && grid[y * this.width + x] === 1;
  }

  private isPath(x: number, y: number): boolean {
    return this.isPathIn(this.paths, x, y);
  }

  private markCell(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.dirty[chunkIndexOfCell(x, y, this.width)] = 1;
  }

  private syncPaths(world: GameWorld): void {
    this.knownPathVersion = world.pathVersion;
    const next = this.nextPaths;
    next.fill(0);
    for (const key of world.paths) {
      const comma = key.indexOf(',');
      const x = Number(key.slice(0, comma));
      const y = Number(key.slice(comma + 1));
      if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.width && y < this.height) {
        next[y * this.width + x] = 1;
      }
    }
    const previous = this.paths;
    for (let cell = 0; cell < next.length; cell += 1) {
      if (next[cell] !== previous[cell]) this.markPathChange(cell % this.width, Math.floor(cell / this.width), world, next);
    }
    this.paths = next;
    this.nextPaths = previous;
  }

  /**
   * Phase 24: diffs the live props against the known ones when the world's prop revision moved (a clear, a restore):
   * only the home chunks of removed, added or changed props are dirtied, so clearing one tree rebuilds one chunk.
   */
  private syncProps(world: GameWorld): void {
    this.knownPropRevision = world.propRevision;
    this.stamp += 1;
    const stamp = this.stamp;
    for (const prop of world.props.values()) {
      const kind = PROP_KIND_BY_ID.get(prop.kind);
      if (!kind) continue;
      const chunk = this.homeChunkOfProp(prop, kind);
      const known = this.knownProps.get(prop.id);
      if (known && known.kind === prop.kind && known.x === prop.x && known.y === prop.y && known.rotation === prop.rotation) {
        known.stamp = stamp;
        continue;
      }
      if (known) this.dirty[known.chunk] = 1;
      this.dirty[chunk] = 1;
      this.knownProps.set(prop.id, { kind: prop.kind, x: prop.x, y: prop.y, rotation: prop.rotation, chunk, stamp });
    }
    for (const [propId, known] of this.knownProps) {
      if (known.stamp === stamp) continue;
      this.dirty[known.chunk] = 1;
      this.knownProps.delete(propId);
    }
  }

  /** The chunk a prop's boxes live in: the chunk of its front-most footprint cell, like an object's. */
  private homeChunkOfProp(prop: { x: number; y: number; rotation: Rotation }, kind: PropKindDefinition): number {
    const [tilesWide, tilesDeep] = propFootprintSize(kind, prop.rotation);
    const x = Math.min(this.width - 1, Math.max(0, prop.x + tilesWide - 1));
    const y = Math.min(this.height - 1, Math.max(0, prop.y + tilesDeep - 1));
    return chunkIndexOfCell(x, y, this.width);
  }

  /** A path tile appeared or went: its chunk, its path neighbours' curbs, its ride neighbours' fences. */
  private markPathChange(x: number, y: number, world: GameWorld, grid: Uint8Array): void {
    this.markCell(x, y);
    for (let direction = 0; direction < 4; direction += 1) {
      const neighbourX = x + CARDINAL_X[direction];
      const neighbourY = y + CARDINAL_Y[direction];
      if (this.isPathIn(grid, neighbourX, neighbourY)) this.markCell(neighbourX, neighbourY);
      this.probe.x = neighbourX;
      this.probe.y = neighbourY;
      const object = world.objectAt(this.probe);
      if (!object || world.coasters.has(object.id)) continue;
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (definition?.kind === 'ride') this.dirty[this.homeChunkOf(object, definition)] = 1;
    }
  }

  private learn(object: PlacedObject, world: GameWorld, stamp: number): void {
    const chunks: number[] = [];
    const coaster = world.coasters.get(object.id);
    if (coaster) {
      for (const piece of coaster.pieces) {
        const chunk = chunkIndexOfCell(piece.cell.x, piece.cell.y, this.width);
        if (!chunks.includes(chunk)) chunks.push(chunk);
      }
    } else {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (definition) chunks.push(this.homeChunkOf(object, definition));
    }
    for (const chunk of chunks) this.dirty[chunk] = 1;
    this.known.set(object.id, {
      definitionId: object.definitionId,
      rotation: object.rotation,
      anchorX: object.anchor.x,
      anchorY: object.anchor.y,
      chunks,
      colours: object.colours,
      stamp,
    });
  }

  private forget(objectId: number, known: KnownObject): void {
    for (const chunk of known.chunks) this.dirty[chunk] = 1;
    this.known.delete(objectId);
    this.pendingRemovals.push(objectId);
  }

  /**
   * The chunk an object's boxes live in: the chunk of its front-most footprint cell, so the object
   * is drawn with the nearest chunk it stands on — before the ground it hides.
   */
  private homeChunkOf(object: PlacedObject, definition: BuildDefinition): number {
    const [tilesWide, tilesDeep] = footprintSize(definition, object.rotation);
    const x = Math.min(this.width - 1, Math.max(0, object.anchor.x + tilesWide - 1));
    const y = Math.min(this.height - 1, Math.max(0, object.anchor.y + tilesDeep - 1));
    return chunkIndexOfCell(x, y, this.width);
  }

  // ---- Rebuild -----------------------------------------------------------------------------------

  private rebuildChunk(index: number, world: GameWorld): void {
    const writer = this.writers[index];
    writer.clear();
    this.lights[index].clear();
    const bounds = this.boundsStore[index];
    emptyAccumulator(bounds);
    bounds.sweeps.length = 0;
    for (const [objectId, placement] of this.placementMap) {
      if (placement.homeChunk === index) this.placementMap.delete(objectId);
    }
    for (const [objectId, train] of this.trainMap) {
      if (train.homeChunk === index) this.trainMap.delete(objectId);
    }

    const tileX0 = (index % this.chunksAcross) * CHUNK_TILES;
    const tileY0 = Math.floor(index / this.chunksAcross) * CHUNK_TILES;
    const tileX1 = Math.min(this.width, tileX0 + CHUNK_TILES);
    const tileY1 = Math.min(this.height, tileY0 + CHUNK_TILES);

    this.style = this.models.groundStyle(world.map.biome);
    this.emitTerrain(writer, tileX0, tileY0, tileX1, tileY1, world.map.ground);
    const entrance = world.entrance;
    const entranceHere = entrance.x >= tileX0 && entrance.x < tileX1 && entrance.y >= tileY0 && entrance.y < tileY1;
    // A gate on an east or west edge is walked through along x: its frame of posts is turned a quarter.
    const gateTurn: QuarterTurn = world.entranceFacing === 'east' || world.entranceFacing === 'west' ? 1 : 0;
    const entranceFlat = entranceHere ? this.models.entranceFlat(gateTurn) : null;
    this.emitPaths(writer, tileX0, tileY0, tileX1, tileY1, entrance, entranceFlat);
    if (entranceFlat) this.emitEntrance(writer, index, entrance, entranceFlat, world.gateColours, gateTurn);

    for (const object of world.objects.values()) {
      if (world.coasters.has(object.id)) continue;
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition || this.homeChunkOf(object, definition) !== index) continue;
      this.emitObject(writer, index, object, definition, bounds);
    }
    for (const record of world.coasters.values()) this.emitCoaster(writer, index, record, world, bounds);
    for (const prop of world.props.values()) {
      const kind = PROP_KIND_BY_ID.get(prop.kind);
      if (kind && this.homeChunkOfProp(prop, kind) === index) this.emitProp(writer, prop, kind);
    }

    this.finishChunk(index, writer, bounds);
  }

  /**
   * The ground: a one-voxel top layer over the soil strata (the diorama edge). Phase 24: the top layer is greedy
   * rectangles per ground word (row runs along x, merged down y exactly like paths), so a chunk of one ground is the
   * single box it always was and Meadow's chunks keep today's two boxes in today's order; a mixed chunk (sand and
   * grass, a pond) is a few disjoint rectangles that cover it exactly once. The soil stays one box under it.
   */
  private emitTerrain(writer: BoxWriter, tileX0: number, tileY0: number, tileX1: number, tileY1: number, ground: Uint8Array): void {
    const style = this.style;
    this.previousRow.clear();
    this.currentRow.clear();
    for (let y = tileY0; y < tileY1; y += 1) {
      let x = tileX0;
      while (x < tileX1) {
        const word = this.groundWord(style, ground[y * this.width + x]);
        let end = x + 1;
        while (end < tileX1 && this.groundWord(style, ground[y * this.width + end]) === word) end += 1;
        this.pushPathBox(writer, x * TILE, y * TILE, GROUND_TOP_Z - GRASS_DEPTH, (end - x) * TILE, TILE, GRASS_DEPTH, word);
        x = end;
      }
      const finished = this.previousRow;
      this.previousRow = this.currentRow;
      this.currentRow = finished;
      this.currentRow.clear();
    }
    this.previousRow.clear();
    writer.push(
      tileX0 * TILE,
      tileY0 * TILE,
      GROUND_TOP_Z - SOIL_DEPTH,
      (tileX1 - tileX0) * TILE,
      (tileY1 - tileY0) * TILE,
      SOIL_DEPTH - GRASS_DEPTH,
      style.soil,
    );
  }

  private groundWord(style: GroundStyle, kind: number): number {
    return kind === GROUND_WATER ? style.water : kind === GROUND_ALT ? style.alt : style.base;
  }

  /**
   * Paving and curbs. Tiles merge into runs along x while they share the curbs above and below
   * them; every box then merges down y into the identical box of the row above when they touch.
   * The entrance tile never joins a run: its curbs are cut wherever the gate stands on them.
   */
  private emitPaths(
    writer: BoxWriter,
    tileX0: number,
    tileY0: number,
    tileX1: number,
    tileY1: number,
    entrance: Cell,
    entranceFlat: FlatModel | null,
  ): void {
    this.previousRow.clear();
    this.currentRow.clear();
    for (let y = tileY0; y < tileY1; y += 1) {
      let x = tileX0;
      while (x < tileX1) {
        if (!this.isPath(x, y)) {
          x += 1;
          continue;
        }
        const north = this.isPath(x, y - 1);
        const south = this.isPath(x, y + 1);
        const isEntrance = x === entrance.x && y === entrance.y;
        let end = x;
        if (!isEntrance) {
          while (end + 1 < tileX1 && this.isPath(end + 1, y) && !(end + 1 === entrance.x && y === entrance.y)
            && this.isPath(end + 1, y - 1) === north && this.isPath(end + 1, y + 1) === south) {
            end += 1;
          }
        }
        this.emitPathRun(writer, x, end, y, north, south, isEntrance ? entranceFlat : null, entrance);
        x = end + 1;
      }
      const finished = this.previousRow;
      this.previousRow = this.currentRow;
      this.currentRow = finished;
      this.currentRow.clear();
    }
  }

  private emitPathRun(
    writer: BoxWriter,
    startX: number,
    endX: number,
    y: number,
    north: boolean,
    south: boolean,
    obstacles: FlatModel | null,
    entrance: Cell,
  ): void {
    const west = this.isPath(startX - 1, y);
    const east = this.isPath(endX + 1, y);
    const x0 = startX * TILE;
    const x1 = (endX + 1) * TILE;
    const y0 = y * TILE;
    const y1 = y0 + TILE;
    const innerX0 = x0 + (west ? 0 : CURB_WIDTH);
    const innerX1 = x1 - (east ? 0 : CURB_WIDTH);
    const innerY0 = y0 + (north ? 0 : CURB_WIDTH);
    const innerY1 = y1 - (south ? 0 : CURB_WIDTH);
    this.pushPathBox(writer, innerX0, innerY0, GROUND_TOP_Z, innerX1 - innerX0, innerY1 - innerY0, PATH_TOP_Z - GROUND_TOP_Z, this.style.paving);
    const curbZ = GROUND_TOP_Z;
    if (!west) this.pushCurb(writer, x0, y0, curbZ, CURB_WIDTH, TILE, 'y', obstacles, entrance);
    if (!east) this.pushCurb(writer, x1 - CURB_WIDTH, y0, curbZ, CURB_WIDTH, TILE, 'y', obstacles, entrance);
    if (!north) this.pushCurb(writer, innerX0, y0, curbZ, innerX1 - innerX0, CURB_WIDTH, 'x', obstacles, entrance);
    if (!south) this.pushCurb(writer, innerX0, y1 - CURB_WIDTH, curbZ, innerX1 - innerX0, CURB_WIDTH, 'x', obstacles, entrance);
  }

  /**
   * A curb along `axis`, cut wherever a model standing on the tile (only ever the entrance gate)
   * would share voxels with it: the gate's posts stand at the tile's edges, and two boxes sharing
   * voxels z-fight.
   */
  private pushCurb(
    writer: BoxWriter,
    x: number,
    y: number,
    z: number,
    sizeX: number,
    sizeY: number,
    axis: 'x' | 'y',
    obstacles: FlatModel | null,
    entrance: Cell,
  ): void {
    if (sizeX <= 0 || sizeY <= 0) return;
    if (obstacles === null) {
      this.pushPathBox(writer, x, y, z, sizeX, sizeY, CURB_HEIGHT, this.style.curb);
      return;
    }
    const originX = entrance.x * TILE;
    const originY = entrance.y * TILE;
    const starts = this.cutStarts;
    const ends = this.cutEnds;
    starts.length = 0;
    ends.length = 0;
    const boxes = obstacles.boxes;
    for (let box = 0; box < obstacles.boxCount; box += 1) {
      const at = box * BOX_FLOATS;
      const bx0 = originX + boxes[at];
      const by0 = originY + boxes[at + 1];
      const bz0 = boxes[at + 2];
      const bx1 = bx0 + boxes[at + 4];
      const by1 = by0 + boxes[at + 5];
      const bz1 = bz0 + boxes[at + 6];
      if (bx0 >= x + sizeX || bx1 <= x || by0 >= y + sizeY || by1 <= y || bz0 >= z + CURB_HEIGHT || bz1 <= z) continue;
      starts.push(axis === 'x' ? Math.max(x, bx0) : Math.max(y, by0));
      ends.push(axis === 'x' ? Math.min(x + sizeX, bx1) : Math.min(y + sizeY, by1));
    }
    let cursor = axis === 'x' ? x : y;
    const limit = axis === 'x' ? x + sizeX : y + sizeY;
    while (cursor < limit) {
      // The nearest cut at or after the cursor, in one pass; cuts are few.
      let nextStart = limit;
      let nextEnd = limit;
      for (let cut = 0; cut < starts.length; cut += 1) {
        if (ends[cut] <= cursor) continue;
        const start = Math.max(starts[cut], cursor);
        if (start < nextStart || (start === nextStart && ends[cut] > nextEnd)) {
          nextStart = start;
          nextEnd = ends[cut];
        }
      }
      if (nextStart > cursor) {
        if (axis === 'x') this.pushPathBox(writer, cursor, y, z, nextStart - cursor, sizeY, CURB_HEIGHT, this.style.curb);
        else this.pushPathBox(writer, x, cursor, z, sizeX, nextStart - cursor, CURB_HEIGHT, this.style.curb);
      }
      cursor = Math.max(cursor, nextEnd);
      if (nextStart === limit) break;
    }
  }

  /** Pushes a path box, or extends the identical box of the row above that ends where this starts. */
  private pushPathBox(writer: BoxWriter, x: number, y: number, z: number, sizeX: number, sizeY: number, sizeZ: number, word: number): void {
    if (sizeX <= 0 || sizeY <= 0) return;
    const key = `${x}:${sizeX}:${z}:${sizeZ}:${word}`;
    const above = this.previousRow.get(key);
    if (above !== undefined) {
      const at = above * BOX_FLOATS;
      if (writer.data[at + 1] + writer.data[at + 5] === y) {
        writer.data[at + 5] += sizeY;
        this.currentRow.set(key, above);
        return;
      }
    }
    this.currentRow.set(key, writer.count);
    writer.push(x, y, z, sizeX, sizeY, sizeZ, word);
  }

  private emitEntrance(writer: BoxWriter, index: number, entrance: Cell, flat: FlatModel, colours: ObjectColours | null, quarterTurn: QuarterTurn): void {
    const originX = entrance.x * TILE;
    const originY = entrance.y * TILE;
    const slotMaterials = this.models.slotTable(ENTRANCE_COLOUR_ID, colours, this.slotMaterials);
    this.pushBoxes(writer, flat.boxes, flat.boxCount, originX, originY, 0, ENTRANCE_OUTLINE_GROUP, STATIC_SLOT, slotMaterials, flat.tags);
    const model = this.models.entranceModel(quarterTurn);
    for (const light of model.lights) this.lights[index].pushPlaced(light, originX, originY, 0);
  }

  /** Phase 24: a map prop's boxes at 32 * its anchor, no plot slab and no fence, in a spread outline group of its own. */
  private emitProp(writer: BoxWriter, prop: { id: number; x: number; y: number; rotation: Rotation }, kind: PropKindDefinition): void {
    const model = this.models.propModel(kind, visualQuarterTurn(prop.rotation));
    const body = model.parts[0];
    this.pushBoxes(writer, body.boxes, body.boxCount, prop.x * TILE, prop.y * TILE, 0, propOutlineGroup(prop.id), STATIC_SLOT);
  }

  private emitObject(writer: BoxWriter, index: number, object: PlacedObject, definition: BuildDefinition, bounds: ChunkBounds): void {
    const [tilesWide, tilesDeep] = footprintSize(definition, object.rotation);
    const originX = object.anchor.x * TILE;
    const originY = object.anchor.y * TILE;
    const group = objectOutlineGroup(object.id);
    writer.push(
      originX,
      originY,
      GROUND_TOP_Z,
      tilesWide * TILE,
      tilesDeep * TILE,
      PLOT_TOP_Z - GROUND_TOP_Z,
      packBoxWord(this.models.palette.plotTint(definition.color), OUTLINE_GROUP_GROUND, PATTERN.GRASS, 0),
    );
    if (definition.kind === 'ride') this.emitFence(writer, object.anchor.x, object.anchor.y, tilesWide, tilesDeep, group);

    const quarterTurn = visualQuarterTurn(object.rotation);
    const model = this.models.objectModel(definition, quarterTurn);
    const body = model.parts[0];
    const slotMaterials = this.models.slotTable(definition.id, object.colours, this.slotMaterials);
    this.pushBoxes(writer, body.boxes, body.boxCount, originX, originY, 0, group, STATIC_SLOT, slotMaterials);
    const parts: PartPlacement[] = [];
    for (let partIndex = 1; partIndex < model.parts.length; partIndex += 1) {
      const part = model.parts[partIndex];
      if (part.boxCount === 0) continue;
      const slot = this.transforms.slotFor(object.id, partIndex);
      // A slot must hold a valid pose before any box that references it is drawn.
      writeRotatedPartTransform(this.transforms, slot, originX, originY, 0, quarterTurn, part.pivot, REST_POSE);
      this.pushBoxes(writer, part.boxes, part.boxCount, 0, 0, 0, group, slot, slotMaterials);
      // Moving parts may point anywhere around their pivot, and drivers move pivots too: bound the
      // sweep at rest and the whole footprint column.
      const reach = 2 * part.sweepRadius;
      const pivotX = originX + part.pivot[0];
      const pivotY = originY + part.pivot[1];
      const pivotZ = part.pivot[2];
      addSweep(bounds, pivotX - reach, pivotY - reach, pivotZ - reach, pivotX + reach, pivotY + reach, pivotZ + reach);
      addSweep(bounds, originX, originY, GROUND_TOP_Z, originX + tilesWide * TILE, originY + tilesDeep * TILE, MOVING_PART_CEILING_Z);
      parts.push({ partId: part.id, slot, pivot: part.pivot });
    }
    for (const light of model.lights) this.lights[index].pushPlaced(light, originX, originY, 0);
    this.placementMap.set(object.id, {
      objectId: object.id,
      definition,
      homeChunk: index,
      originX,
      originY,
      quarterTurn,
      top: model.top,
      parts,
      fromContent: this.models.fromContent(definition),
      // World.rideProfile's duration: the catalog's (default 30 s) for rides, none for anything else.
      durationSeconds: definition.kind === 'ride' ? definition.stats?.duration ?? DEFAULT_RIDE_DURATION_SECONDS : 0,
    });
  }

  /**
   * The legacy ride fence, in voxels: along every plot side, posts 2×2×10 every 16 voxels (and at
   * the ends) inside the plot's outer 2-voxel band, rails at z 5 and 9 on the outer voxel between
   * them — except along a cell edge a path touches, which stays open like the classic fence.
   * Corner posts belong to the sides running along x; a side along y only draws one where the side
   * along x is open, so the two never share voxels.
   */
  private emitFence(writer: BoxWriter, tileX: number, tileY: number, tilesWide: number, tilesDeep: number, group: number): void {
    const fenced = this.sideFenced;
    fenced.fill(0);
    for (let cell = 0; cell < tilesWide; cell += 1) {
      fenced[cell] = this.isPath(tileX + cell, tileY - 1) ? 0 : 1;
      fenced[8 + cell] = this.isPath(tileX + cell, tileY + tilesDeep) ? 0 : 1;
    }
    for (let cell = 0; cell < tilesDeep; cell += 1) {
      fenced[16 + cell] = this.isPath(tileX - 1, tileY + cell) ? 0 : 1;
      fenced[24 + cell] = this.isPath(tileX + tilesWide, tileY + cell) ? 0 : 1;
    }
    const postWord = packBoxWord(MAT.FENCE_POST, group, PATTERN.PLAIN, 0);
    const railWord = packBoxWord(MAT.FENCE_RAIL, group, PATTERN.PLAIN, 0);
    const x0 = tileX * TILE;
    const y0 = tileY * TILE;
    const x1 = x0 + tilesWide * TILE;
    const y1 = y0 + tilesDeep * TILE;
    const northEnd = fenced[tilesWide - 1] === 1;
    const southEnd = fenced[8 + tilesWide - 1] === 1;
    // North and south run along x and own their corners.
    this.emitFenceSide(writer, 'x', x0, y0, y0, tilesWide, 0, true, true, postWord, railWord);
    this.emitFenceSide(writer, 'x', x0, y1 - FENCE_POST_SIZE, y1 - 1, tilesWide, 8, true, true, postWord, railWord);
    // West and east run along y and draw a corner post only where the x side is open.
    this.emitFenceSide(writer, 'y', y0, x0, x0, tilesDeep, 16, fenced[0] === 0, fenced[8] === 0, postWord, railWord);
    this.emitFenceSide(writer, 'y', y0, x1 - FENCE_POST_SIZE, x1 - 1, tilesDeep, 24, !northEnd, !southEnd, postWord, railWord);
  }

  /**
   * One plot side of `cells` cell edges from `along0`, its posts in the band from `across0` and
   * its rails on the voxel `railAcross`. Candidate posts sit at 32k and 32k + 16 for every cell k
   * and at the far end (length − 2): a boundary post stands if either cell beside it is fenced, a
   * mid post if its cell is, a corner post only if this side owns it.
   */
  private emitFenceSide(
    writer: BoxWriter,
    axis: 'x' | 'y',
    along0: number,
    across0: number,
    railAcross: number,
    cells: number,
    flagOffset: number,
    ownsStart: boolean,
    ownsEnd: boolean,
    postWord: number,
    railWord: number,
  ): void {
    const fenced = this.sideFenced;
    const length = cells * TILE;
    const candidates = 2 * cells;
    for (let candidate = 0; candidate <= candidates; candidate += 1) {
      const cell = Math.min(cells - 1, candidate >> 1);
      const offset = candidate === candidates ? length - FENCE_POST_SIZE : candidate * FENCE_POST_SPACING;
      let stands: boolean;
      if (candidate === 0) stands = fenced[flagOffset] === 1 && ownsStart;
      else if (candidate === candidates) stands = fenced[flagOffset + cells - 1] === 1 && ownsEnd;
      else if ((candidate & 1) === 0) stands = fenced[flagOffset + cell] === 1 || fenced[flagOffset + cell - 1] === 1;
      else stands = fenced[flagOffset + cell] === 1;
      if (stands) {
        this.pushAlong(writer, axis, along0 + offset, across0, PLOT_TOP_Z, FENCE_POST_SIZE, FENCE_POST_SIZE, FENCE_POST_HEIGHT, postWord);
      }
      if (candidate === candidates || fenced[flagOffset + cell] === 0) continue;
      const railStart = offset + FENCE_POST_SIZE;
      const railEnd = candidate + 1 === candidates ? length - FENCE_POST_SIZE : (candidate + 1) * FENCE_POST_SPACING;
      if (railEnd <= railStart) continue;
      for (const railZ of FENCE_RAIL_Z) {
        this.pushAlong(writer, axis, along0 + railStart, railAcross, railZ, railEnd - railStart, 1, FENCE_RAIL_HEIGHT, railWord);
      }
    }
  }

  private pushAlong(
    writer: BoxWriter,
    axis: 'x' | 'y',
    along: number,
    across: number,
    z: number,
    alongSize: number,
    acrossSize: number,
    height: number,
    word: number,
  ): void {
    if (axis === 'x') writer.push(along, across, z, alongSize, acrossSize, height, word);
    else writer.push(across, along, z, acrossSize, alongSize, height, word);
  }

  /**
   * A coaster gets no plot slab (unlike emitObject): its cells keep the grass, or the paving of a
   * path under level-2+ track, and the pieces themselves reach down to GROUND_TOP_Z where they stand
   * (footings, level-0 bed, the station platform: content/coaster.ts), so nothing floats.
   */
  private emitCoaster(writer: BoxWriter, index: number, record: CoasterRecord, world: GameWorld, bounds: ChunkBounds): void {
    const object = world.objects.get(record.objectId);
    const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
    if (!definition) return;
    const pieces = record.pieces;
    const group = objectOutlineGroup(record.objectId);
    // Phase 28: the coaster's colour record as a per-tag material table, shared by its track and its train.
    const slotMaterials = this.models.slotTable(definition.id, object?.colours, this.slotMaterials);
    for (let piece = 0; piece < pieces.length; piece += 1) {
      const cell = pieces[piece].cell;
      if (chunkIndexOfCell(cell.x, cell.y, this.width) !== index) continue;
      // Phase 38: a piece over other track or a low object gets no bent of its own.
      const supports = !world.hasSomethingUnder(cell, pieces[piece].height);
      this.models.pieceBoxes(pieces, piece, definition, group, writer, slotMaterials, supports);
    }
    if (pieces.length === 0 || chunkIndexOfCell(pieces[0].cell.x, pieces[0].cell.y, this.width) !== index) return;

    // The train lives with the station: one set of car boxes, posed every frame through the slots.
    const carCount = COASTER_TYPE_BY_ID.get(definition.id)?.trainCars ?? DEFAULT_TRAIN_CARS;
    for (let car = 0; car < carCount; car += 1) {
      const flat = this.models.carFlat(definition, car);
      const slot = this.transforms.slotFor(record.objectId, coasterCarSlotKey(car));
      this.pushBoxes(writer, flat.boxes, flat.boxCount, 0, 0, 0, group, slot, slotMaterials, flat.tags);
      // The riders ride in their own part: posed with the car while the ride runs, collapsed otherwise.
      const riders = this.models.riderFlat(definition, car);
      const riderSlot = this.transforms.slotFor(record.objectId, coasterRiderSlotKey(car));
      this.pushBoxes(writer, riders.boxes, riders.boxCount, 0, 0, 0, group, riderSlot);
    }
    if (carCount > 1) {
      const coupling = this.models.couplingFlat(definition);
      // Two half-bars per coupling, one hinged at each car's hitch.
      for (let car = 0; car + 1 < carCount; car += 1) {
        for (let half = 0; half < 2; half += 1) {
          const slot = this.transforms.slotFor(record.objectId, coasterCouplingSlotKey(car, half));
          this.pushBoxes(writer, coupling.boxes, coupling.boxCount, 0, 0, 0, group, slot);
        }
      }
    }
    const poses = createCoasterCarPoses(carCount);
    placeCoasterCars(record, coasterHeadIndex(record, null), carCount, poses);
    writeCoasterCarTransforms(this.transforms, record.objectId, poses, 0);

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let highest = 0;
    let loops = false;
    for (const piece of pieces) {
      minX = Math.min(minX, piece.cell.x);
      minY = Math.min(minY, piece.cell.y);
      maxX = Math.max(maxX, piece.cell.x);
      maxY = Math.max(maxY, piece.cell.y);
      highest = Math.max(highest, piece.height);
      if (piece.special === 'loop') loops = true;
    }
    const top = coasterRailTopZ(highest) + (loops ? 2 * COASTER_LOOP_RADIUS_VOXELS : 0) + 8;
    addSweep(
      bounds,
      minX * TILE - COASTER_TRACK_MARGIN,
      minY * TILE - COASTER_TRACK_MARGIN,
      GROUND_TOP_Z,
      (maxX + 1) * TILE + COASTER_TRACK_MARGIN,
      (maxY + 1) * TILE + COASTER_TRACK_MARGIN,
      coasterRailTopZ(highest) + COASTER_TRAIN_HEADROOM,
    );
    this.trainMap.set(record.objectId, {
      objectId: record.objectId,
      record,
      carCount,
      capacity: COASTER_TYPE_BY_ID.get(definition.id)?.trainCapacity ?? 0,
      poses,
      homeChunk: index,
      top,
    });
  }

  /**
   * Appends boxes translated by (dx, dy, dz), with the outline group and slot every placed box takes.
   * `slotMaterials` (Phase 28) swaps the material byte of boxes tagged with a colour slot (field 7 of
   * the compiled box, or `tags[box]` for a flat list, whose field 7 is the transform slot) for the table's
   * material: 1:1 per box, so no extent, order or count changes.
   */
  private pushBoxes(
    writer: BoxWriter,
    boxes: Float32Array,
    count: number,
    dx: number,
    dy: number,
    dz: number,
    group: number,
    slot: number,
    slotMaterials: Uint8Array | null = null,
    tags: Uint8Array | null = null,
  ): void {
    writer.ensureCapacity(writer.count + count);
    const data = writer.data;
    let to = writer.count * BOX_FLOATS;
    for (let from = 0; from < count * BOX_FLOATS; from += BOX_FLOATS, to += BOX_FLOATS) {
      data[to] = boxes[from] + dx;
      data[to + 1] = boxes[from + 1] + dy;
      data[to + 2] = boxes[from + 2] + dz;
      let word = boxes[from + 3];
      if (slotMaterials !== null) {
        const tag = tags !== null ? tags[from / BOX_FLOATS] : boxes[from + 7];
        if (tag !== 0 && slotMaterials[tag] !== 0) word = withMaterial(word, slotMaterials[tag]);
      }
      data[to + 3] = withOutlineGroup(word, group);
      data[to + 4] = boxes[from + 4];
      data[to + 5] = boxes[from + 5];
      data[to + 6] = boxes[from + 6];
      data[to + 7] = slot;
    }
    writer.count += count;
  }

  /**
   * Finishes a rebuilt chunk: captures every box's WORLD extent (a moving box at the pose its slot holds
   * now, the rest pose just written, so a later turn re-sorts exactly what a rebuild would) and orders it.
   */
  private finishChunk(index: number, writer: BoxWriter, bounds: ChunkBounds): void {
    const count = writer.count;
    if (bounds.extents.length < count * EXTENT_STRIDE) bounds.extents = new Float64Array(Math.max(count * EXTENT_STRIDE, bounds.extents.length * 2));
    const extents = bounds.extents;
    const data = writer.data;
    const pivots = this.transforms.data;
    for (let box = 0; box < count; box += 1) {
      const at = box * BOX_FLOATS;
      const slot = data[at + 7];
      let x0 = data[at];
      let y0 = data[at + 1];
      let z0 = data[at + 2];
      let x1 = x0 + data[at + 4];
      let y1 = y0 + data[at + 5];
      let z1 = z0 + data[at + 6];
      if (slot !== STATIC_SLOT) {
        const pivot = (slot - 1) * PIVOT_FLOATS;
        x0 += pivots[pivot];
        y0 += pivots[pivot + 1];
        z0 += pivots[pivot + 2];
        x1 += pivots[pivot];
        y1 += pivots[pivot + 1];
        z1 += pivots[pivot + 2];
      }
      const to = box * EXTENT_STRIDE;
      extents[to] = x0;
      extents[to + 1] = y0;
      extents[to + 2] = z0;
      extents[to + 3] = x1;
      extents[to + 4] = y1;
      extents[to + 5] = z1;
      extents[to + 6] = box;
    }
    this.orderChunk(index, writer, bounds);
  }

  /**
   * Sorts the chunk front to back by the VIEW depth key of each box's max corner (view u + v + z; the ground,
   * group 0, after everything else) and finishes its screen bounds in view texels. The key only orders draws
   * for early-Z; the GPU takes the exact per-fragment key from the vertex stage. A moving box is bounded by
   * its sweep (`bounds.sweeps`) instead of its box. The same code runs after a rebuild and after a view turn
   * (a pure permutation of the boxes and their extents, so nothing is recompiled and no slot changes).
   */
  private orderChunk(index: number, writer: BoxWriter, bounds: ChunkBounds): void {
    const count = writer.count;
    if (this.sortKeys.length < count) {
      this.sortKeys = new Float64Array(Math.max(count, this.sortKeys.length * 2));
      this.inverse = new Int32Array(this.sortKeys.length);
    }
    const keys = this.sortKeys;
    const data = writer.data;
    const extents = bounds.extents;
    const view = this.view;
    const { c, s, ox, oy } = view;
    emptyAccumulator(bounds);
    const sweeps = bounds.sweeps;
    for (let at = 0; at < sweeps.length; at += 6) {
      includeBox(bounds, view, sweeps[at], sweeps[at + 1], sweeps[at + 2], sweeps[at + 3], sweeps[at + 4], sweeps[at + 5]);
    }
    for (let box = 0; box < count; box += 1) {
      const at = box * BOX_FLOATS;
      const from = box * EXTENT_STRIDE;
      const x0 = extents[from];
      const y0 = extents[from + 1];
      const z0 = extents[from + 2];
      const x1 = extents[from + 3];
      const y1 = extents[from + 4];
      const z1 = extents[from + 5];
      if (data[at + 7] === STATIC_SLOT) includeBox(bounds, view, x0, y0, z0, x1, y1, z1);
      const ua = c * x0 - s * y0 + ox;
      const ub = c * x1 - s * y1 + ox;
      const va = s * x0 + c * y0 + oy;
      const vb = s * x1 + c * y1 + oy;
      const depth = Math.max(-SORT_DEPTH_LIMIT, Math.min(SORT_DEPTH_LIMIT, Math.round((ua > ub ? ua : ub) + (va > vb ? va : vb) + z1)));
      const ground = ((data[at + 3] >>> 8) & 255) === OUTLINE_GROUP_GROUND;
      keys[box] = ((ground ? SORT_GROUND_RANK : 0) + SORT_DEPTH_LIMIT - depth) * SORT_INDEX_SCALE + extents[from + 6];
      this.inverse[extents[from + 6]] = box;
    }
    keys.subarray(0, count).sort();
    const scratch = this.scratch;
    scratch.clear();
    scratch.ensureCapacity(count);
    const sorted = scratch.data;
    if (this.extentScratch.length < count * EXTENT_STRIDE) this.extentScratch = new Float64Array(Math.max(count * EXTENT_STRIDE, this.extentScratch.length * 2));
    const sortedExtents = this.extentScratch;
    for (let rank = 0; rank < count; rank += 1) {
      const box = this.inverse[keys[rank] % SORT_INDEX_SCALE];
      const from = box * BOX_FLOATS;
      const to = rank * BOX_FLOATS;
      for (let field = 0; field < BOX_FLOATS; field += 1) sorted[to + field] = data[from + field];
      for (let field = 0; field < EXTENT_STRIDE; field += 1) sortedExtents[rank * EXTENT_STRIDE + field] = extents[box * EXTENT_STRIDE + field];
    }
    data.set(sorted.subarray(0, count * BOX_FLOATS));
    extents.set(sortedExtents.subarray(0, count * EXTENT_STRIDE));
    this.boundsOf[index] = count > 0 && bounds.minX <= bounds.maxX ? bounds : null;
  }

  /**
   * The view changed (the scene wrote `view` and bumped its revision): re-sorts and re-bounds every chunk
   * that is not waiting for a rebuild (a dirty chunk is built for the current view anyway). Returns the
   * chunk indices in `reorderedChunks`' first `n` entries, n being the return value. Allocates nothing once warm.
   */
  reorderForView(): number {
    let reordered = 0;
    for (let index = 0; index < this.chunkCount; index += 1) {
      if (this.dirty[index] !== 0) continue;
      const writer = this.writers[index];
      if (writer.count === 0) continue;
      this.orderChunk(index, writer, this.boundsStore[index]);
      this.reorderedChunks[reordered] = index;
      reordered += 1;
    }
    return reordered;
  }
}
