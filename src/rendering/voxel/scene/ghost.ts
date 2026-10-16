import { BUILD_BY_ID } from '../../../game/content/catalog';
import { PROP_KIND_BY_ID } from '../../../game/maps/props';
import { sameObjectColours, type ObjectColours } from '../../../game/content/colours';
import type { BuildDefinition, Cell, Rotation } from '../../../game/types';
import type { GameWorld } from '../../../game/World';
import type { GhostState } from '../contracts/frame';
import {
  GHOST_COVERAGE_INVALID,
  GHOST_COVERAGE_VALID,
  GHOST_COVERAGE_VALID_COLOURED,
  GHOST_TINT_BULLDOZE,
  GHOST_TINT_BULLDOZE_REFUSED,
  GHOST_TINT_INVALID,
  GHOST_TINT_MIX,
  GHOST_TINT_MIX_COLOURED,
  GHOST_TINT_VALID,
} from '../contracts/gbuffer';
import { GROUND_TOP_Z, visualQuarterTurn, VOXELS_PER_TILE } from '../contracts/space';
import type { FlatModel } from '../blueprint/compile';
import { BOX_FLOATS, withMaterial } from '../contracts/boxes';
import { COLOUR_TAG_LIMIT } from '../contracts/blueprint';
import type { SceneModels } from './staticWorld';

/**
 * The voxel ghost (design §10): what is about to be built, or about to be bulldozed, drawn as the
 * real model through a world-anchored Bayer screen door (the dither program) instead of the legacy
 * translucent art. The GPU keeps the ghost's boxes in their own small texture and uploads them only
 * when the box list changes identity, so the list is always a cached model-local flat model
 * (ModelCache.flat, keyed by blueprint and quarter turn) placed by the origin uniform: moving the
 * cursor moves a uniform, rotating or switching the tool uploads one model.
 *
 * - A build preview shows the definition's model at the rotated footprint's minimum corner, tinted
 *   and screened by validity (GHOST_TINT_VALID / GHOST_TINT_INVALID, GHOST_COVERAGE_*).
 * - A bulldoze preview shows the model of the object (or, Phase 24, the map prop) under the cursor, in place,
 *   tinted GHOST_TINT_BULLDOZE (a refused prop clear: GHOST_TINT_BULLDOZE_REFUSED); the depth bias lets it win over
 *   the identical geometry it covers. It is re-resolved whenever the world changes, so it disappears with the object
 *   it marks.
 * - Phase 28 colour before placing: a build preview carries the colour record the next object will get, and a
 *   bulldoze preview the record of the object it marks. With no record (or a model with no tagged box) the ghost
 *   is the cached flat model exactly as before. With one it is a recoloured COPY of that flat model, cached by
 *   (flat identity, record value): the same identity, so no upload, while neither changes, a new identity once
 *   when the choice (or the model, turn or marked object) changes. The copy swaps only the material byte of the
 *   boxes a colour slot tags, so box count, order and extents are the flat model's. A VALID build ghost drawn
 *   from such a copy is screened denser and tinted lighter (GHOST_COVERAGE_VALID_COLOURED, GHOST_TINT_MIX_COLOURED)
 *   so the chosen colour reads through the validity tint; an invalid or bulldoze ghost, and a ghost in its shipped
 *   colours, keep the plain coverage and mix.
 * - Paths have no ghost (the overlay diamonds are the preview), and neither do coasters: their
 *   layout draft is an overlay, and a placed coaster is a whole track rather than one model.
 */

const TILE = VOXELS_PER_TILE;

export class GhostPreview {
  /** The state handed to the sink; reused, so a preview change never allocates one. */
  readonly state: GhostState = {
    boxes: new Float32Array(0),
    boxCount: 0,
    originX: 0,
    originY: 0,
    originZ: GROUND_TOP_Z,
    coverage: GHOST_COVERAGE_VALID,
    tint: GHOST_TINT_VALID,
    tintMix: GHOST_TINT_MIX,
    extentX: 0,
    extentY: 0,
    heightVoxels: 0,
  };
  /** The box list `state`'s extents were measured from (the cached flat model: measured once per model). */
  private measuredBoxes: Float32Array | null = null;
  private measuredCount = -1;
  private active = false;
  private readonly cells: Cell[] = [];
  private definition: BuildDefinition | null = null;
  private valid = true;
  private bulldoze = false;
  private rotation: Rotation = 0;
  private colours: ObjectColours | null = null;
  /** Phase 28: the recoloured copy of a flat model, and what it was made from (see `recoloured`). */
  private copySource: FlatModel | null = null;
  private copyColours: ObjectColours | null = null;
  private copyStorage = new Float32Array(0);
  private copyView = new Float32Array(0);
  private readonly slotTable = new Uint8Array(COLOUR_TAG_LIMIT);

  /** Whether a preview is set at all (even one that resolves to no ghost). */
  get isActive(): boolean {
    return this.active;
  }

  /** Whether the ghost depends on the world beyond the request itself (bulldoze previews do). */
  get followsWorld(): boolean {
    return this.active && this.bulldoze;
  }

  /**
   * Stores a preview request; true when it differs from the current one. GameApp repeats the same
   * request on every pointermove inside a cell, and those must cost nothing.
   */
  set(
    cells: readonly Cell[],
    definition: BuildDefinition | null,
    valid: boolean,
    bulldoze: boolean,
    rotation: Rotation,
    colours: ObjectColours | null = null,
  ): boolean {
    if (this.active && this.matches(cells, definition, valid, bulldoze, rotation, colours)) return false;
    this.active = true;
    this.cells.length = cells.length;
    for (let index = 0; index < cells.length; index += 1) {
      const cell = this.cells[index] ?? { x: 0, y: 0 };
      cell.x = cells[index].x;
      cell.y = cells[index].y;
      this.cells[index] = cell;
    }
    this.definition = definition;
    this.valid = valid;
    this.bulldoze = bulldoze;
    this.rotation = rotation;
    this.colours = colours;
    return true;
  }

  /** Forgets the request; true when there was one. */
  clear(): boolean {
    if (!this.active) return false;
    this.active = false;
    this.cells.length = 0;
    this.definition = null;
    this.colours = null;
    return true;
  }

  /**
   * The ghost to draw for the current request against `world`, or null for none. Compiles the model
   * on a cache miss (the idle prewarm makes that rare); a content failure falls back to its
   * placeholder inside SceneModels, never throws here.
   */
  resolve(world: GameWorld, models: SceneModels): GhostState | null {
    if (!this.active || this.cells.length === 0) return null;
    return this.bulldoze ? this.resolveBulldoze(world, models) : this.resolveBuild(models);
  }

  private resolveBuild(models: SceneModels): GhostState | null {
    const definition = this.definition;
    if (!definition || definition.kind === 'path' || definition.custom === 'coaster') return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    for (const cell of this.cells) {
      if (cell.x < minX) minX = cell.x;
      if (cell.y < minY) minY = cell.y;
    }
    const flat = models.objectFlat(definition, visualQuarterTurn(this.rotation));
    const boxes = this.recoloured(flat, definition.id, this.colours, models);
    return this.fill(boxes, flat.boxCount, minX * TILE, minY * TILE,
      this.valid ? GHOST_TINT_VALID : GHOST_TINT_INVALID, boxes !== flat.boxes);
  }

  private resolveBulldoze(world: GameWorld, models: SceneModels): GhostState | null {
    const cell = this.cells[0];
    // The bulldozer takes a path before the track above it, and paths have no ghost.
    if (world.paths.has(`${cell.x},${cell.y}`)) return null;
    const object = world.objectAt(cell);
    if (!object) return this.resolveBulldozeProp(world, models);
    if (world.coasters.has(object.id)) return null;
    const definition = BUILD_BY_ID.get(object.definitionId);
    if (!definition) return null;
    const flat = models.objectFlat(definition, visualQuarterTurn(object.rotation));
    // The marked object keeps the colours it has, so the dither lies over identical geometry in identical paint.
    const boxes = this.recoloured(flat, definition.id, object.colours ?? null, models);
    return this.fill(boxes, flat.boxCount, object.anchor.x * TILE, object.anchor.y * TILE, GHOST_TINT_BULLDOZE, false);
  }

  /**
   * Phase 24: the bulldozer over a map prop marks the prop itself, like a placed object: its model in place, so the
   * see-through cutaway learns the prop's height and keeps it (without a ghost the cut key fell to the prop's own
   * front corner and cut the obstacle the player is about to pay for out of the picture). A clear that will happen is
   * tinted GHOST_TINT_BULLDOZE; a refused one (a permanent prop, or a clear the park cannot afford: `valid` false)
   * GHOST_TINT_BULLDOZE_REFUSED, matching the overlay diamond.
   */
  private resolveBulldozeProp(world: GameWorld, models: SceneModels): GhostState | null {
    const prop = world.propAt(this.cells[0]);
    if (!prop) return null;
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    if (!kind) return null;
    const flat = models.propFlat(kind, visualQuarterTurn(prop.rotation));
    return this.fill(flat.boxes, flat.boxCount, prop.x * TILE, prop.y * TILE,
      this.valid ? GHOST_TINT_BULLDOZE : GHOST_TINT_BULLDOZE_REFUSED, false);
  }

  /**
   * The box list to draw for `flat` in `colours`: `flat.boxes` itself when there is nothing to repaint (no
   * record, an all-default table, a model without tagged boxes), otherwise a recoloured copy. The copy lives in
   * one reused buffer and is handed out as a view that is NEW only when (flat, record value) changes, because
   * the GPU uploads a ghost exactly when this identity changes; a repeat costs one comparison.
   */
  private recoloured(flat: FlatModel, definitionId: string, colours: ObjectColours | null, models: SceneModels): Float32Array {
    if (colours === null || flat.tags === null) return flat.boxes;
    if (this.copySource === flat && sameObjectColours(this.copyColours, colours)) return this.copyView;
    const table = models.slotTable(definitionId, colours, this.slotTable);
    if (table === null) return flat.boxes;
    const length = flat.boxCount * BOX_FLOATS;
    if (this.copyStorage.length < length) this.copyStorage = new Float32Array(length);
    const storage = this.copyStorage;
    storage.set(flat.boxes.subarray(0, length));
    const tags = flat.tags;
    for (let box = 0; box < flat.boxCount; box += 1) {
      const material = table[tags[box]];
      if (material === 0) continue;
      const at = box * BOX_FLOATS + 3;
      storage[at] = withMaterial(storage[at], material);
    }
    this.copySource = flat;
    this.copyColours = colours;
    this.copyView = storage.subarray(0, length);
    return this.copyView;
  }

  /** `showsChoice`: the boxes are a recoloured copy for a build ghost (a valid one then lets the colour through). */
  private fill(boxes: Float32Array, boxCount: number, originX: number, originY: number, tint: number, showsChoice: boolean): GhostState | null {
    if (boxCount <= 0) return null;
    const state = this.state;
    state.boxes = boxes;
    state.boxCount = boxCount;
    if (boxes !== this.measuredBoxes || boxCount !== this.measuredCount) this.measure(state, boxes, boxCount);
    state.originX = originX;
    state.originY = originY;
    state.originZ = GROUND_TOP_Z;
    const colourThrough = showsChoice && this.valid;
    state.coverage = this.valid ? (colourThrough ? GHOST_COVERAGE_VALID_COLOURED : GHOST_COVERAGE_VALID) : GHOST_COVERAGE_INVALID;
    state.tint = tint;
    state.tintMix = colourThrough ? GHOST_TINT_MIX_COLOURED : GHOST_TINT_MIX;
    return state;
  }

  /**
   * The model's far x / y corner and top, in voxels from its origin: what the see-through cutaway
   * needs to know about the volume the ghost fills. Cached model lists are measured once.
   */
  private measure(state: GhostState, boxes: Float32Array, boxCount: number): void {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let index = 0; index < boxCount; index += 1) {
      const at = index * BOX_FLOATS;
      x = Math.max(x, boxes[at] + boxes[at + 4]);
      y = Math.max(y, boxes[at + 1] + boxes[at + 5]);
      z = Math.max(z, boxes[at + 2] + boxes[at + 6]);
    }
    state.extentX = x;
    state.extentY = y;
    state.heightVoxels = z;
    this.measuredBoxes = boxes;
    this.measuredCount = boxCount;
  }

  private matches(
    cells: readonly Cell[],
    definition: BuildDefinition | null,
    valid: boolean,
    bulldoze: boolean,
    rotation: Rotation,
    colours: ObjectColours | null,
  ): boolean {
    if (definition !== this.definition || valid !== this.valid || bulldoze !== this.bulldoze || rotation !== this.rotation) return false;
    if (!sameObjectColours(colours, this.colours)) return false;
    if (cells.length !== this.cells.length) return false;
    for (let index = 0; index < cells.length; index += 1) {
      if (cells[index].x !== this.cells[index].x || cells[index].y !== this.cells[index].y) return false;
    }
    return true;
  }
}
