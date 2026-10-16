import { centreLineFor, layoutCanClose } from '../../../game/coaster/centreLine';
import { isShuttleLayout } from '../../../game/coaster/shuttle';
import { openDraftRing } from '../../draftRing';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { GAME_CONFIG } from '../../../game/config';
import { sameObjectColours, type ObjectColours } from '../../../game/content/colours';
import type { CoasterPiece } from '../../../game/coaster/design';
import type { BuildDefinition } from '../../../game/types';
import { BOX_FLOATS, BoxWriter, withMaterial, withOutlineGroup } from '../contracts/boxes';
import { COLOUR_TAG_LIMIT } from '../contracts/blueprint';
import { coasterCarSlotKey, coasterCouplingSlotKey } from '../contracts/rigid';
import type { GhostState } from '../contracts/frame';
import { GHOST_COVERAGE_VALID, GHOST_TINT_VALID } from '../contracts/gbuffer';
import { coasterHangOffset, createCoasterCarPoses, placeCarsOnTrack, writeCoasterCarTransforms } from './coasterCars';
import type { TransformTable } from './rigid';
import type { SceneModels } from './staticWorld';

/**
 * The coaster builder's draft as the real voxel track (design §10/§12): every piece goes through the
 * same `pieceBoxes` the built coaster uses, so what the player designs is what gets built, drawn
 * through the dithered ghost program instead of the old vector line.
 *
 * - Boxes are in WORLD voxels (origin 0), so no model-local placement is needed.
 * - `pieceBoxes` reads each piece's neighbours as a closed ring, and the smooth centre line (corners,
 *   heights) is built from that ring. A layout that can close (≥ 3 pieces, first and last cardinal
 *   neighbours: the legacy draft's rule) is handed over as it is. An open layout is handed over as
 *   `openLayoutRing`: a scratch piece behind the first (the station's lead-in) and one ahead of the
 *   last, straight on at the same height (the track simply ends level), so neither end bends toward
 *   the far side of the map; only the real pieces' boxes are written. The classic preview builds
 *   the same ring, so both renderers draw the same curve.
 * - Rebuilds only when the content signature changes (length and per piece cell, height, special,
 *   plus the definition and armed flag), and every rebuild hands the GPU a new array view, because
 *   the GPU uploads only when `boxes` changes identity. Nothing allocates while the layout is
 *   unchanged, and storage only grows.
 * - The parked train (Phase 27 step 3) stands at the end of the station through the same dithered
 *   program: its cars and couplings are rigid boxes on transform slots of the shared table, held
 *   under `DRAFT_TRAIN_OBJECT_ID` and posed once per rebuild (never per frame) by the very placement
 *   the built coaster uses, so it is exact on slopes and corners. It carries no riders, and its slots
 *   are released when the draft is cleared or rebuilt. Without a transform table (tests) no train.
 * - Phase 28 colour before placing: the draft carries the record the coaster will get. It is part of the signature
 *   (compared by value), so a changed choice rebuilds the draft once and a repeat costs nothing; the track
 *   gets the per-tag material table through `pieceBoxes`, the parked train's cars through their flat tags.
 * - The tint is not used: a fine layout keeps its own colours (the GPU mixes none for the draft);
 *   blocked cells stay marked by the overlay's red diamonds.
 */

/** The longest layout the builder accepts. */
const MAX_PIECES = 64;
/** Transform-table object id of the draft's train (real objects start at 1). */
export const DRAFT_TRAIN_OBJECT_ID = -1;
/** Straight scratch pieces laid behind an open draft's first piece for its parked train. */
const TRAIN_LEAD_IN_PIECES = 3;

/**
 * The ring an OPEN draft's parked train rides (Phase 27 step 3 review fix): the layout's pieces from
 * index 0 (so the head index is the built coaster's), the trailing scratch piece of
 * `openLayoutRing`, then `TRAIN_LEAD_IN_PIECES` straight pieces leading into piece 0 in the
 * station's direction, farthest first. The track's own ring (`openLayoutRing`, rotated) has a single
 * lead-in whose predecessor is the trailing scratch piece on the far side of the layout, so its
 * centre line runs backwards there and the rear cars of a 5- or 6-car train (which reach back past
 * piece 0) were shoved back or reversed. Here every piece a car can reach has its true straight
 * neighbour; the one seam (trailing piece to the farthest lead-in) lies more than a train length away.
 * Only the train uses this ring; the track is drawn from the usual one.
 */
const trainRing = (layout: readonly CoasterPiece[]): CoasterPiece[] => {
  const ring = openDraftRing(layout);
  const leadIn = ring.shift() as CoasterPiece;
  const first = layout[0];
  const stepX = first.cell.x - leadIn.cell.x;
  const stepY = first.cell.y - leadIn.cell.y;
  for (let back = TRAIN_LEAD_IN_PIECES; back >= 1; back -= 1) {
    ring.push({ cell: { x: first.cell.x - back * stepX, y: first.cell.y - back * stepY }, height: first.height });
  }
  return ring;
};

/** Coverage while another tool is armed: the layout stays visible but recedes. */
export const DRAFT_COVERAGE_PARKED = 0.3;
export const DRAFT_COVERAGE_ARMED = GHOST_COVERAGE_VALID;

const SPECIAL_CODE: Readonly<Record<string, number>> = {
  loop: 1, boost: 2, launch: 3, 'airtime-hill': 4, corkscrew: 5, 'zero-g-roll': 6, 'cobra-roll': 7,
};
/** The special plus the lift flag (bit 8): a toggled lift must rebuild the draft's chain strips. */
const pieceCode = (piece: CoasterPiece): number => (piece.special ? SPECIAL_CODE[piece.special] ?? 3 : 0) | (piece.freeClimb === true ? 256 : 0)
  | (piece.launchSpeed !== undefined ? 512 : 0);

export class CoasterDraft {
  /** The state handed to the sink; reused, `boxes` changes identity on every rebuild. */
  readonly state: GhostState = {
    boxes: new Float32Array(0),
    boxCount: 0,
    originX: 0,
    originY: 0,
    originZ: 0,
    coverage: DRAFT_COVERAGE_ARMED,
    tint: GHOST_TINT_VALID,
    // The layout draws in its own colours, untinted (the draft program has always run at mix 0).
    tintMix: 0,
    // The cutaway does not use the draft's volume (the coaster designer has its own fixed height).
    extentX: 0,
    extentY: 0,
    heightVoxels: 0,
  };
  private readonly writer = new BoxWriter(1024);
  private signature = new Int32Array(MAX_PIECES * 4);
  private length = 0;
  private definition: BuildDefinition | null = null;
  private armed = true;
  private valid = false;
  private transforms: TransformTable | null = null;
  private colours: ObjectColours | null = null;
  private readonly slotTable = new Uint8Array(COLOUR_TAG_LIMIT);
  /** The slot table of the build in progress (null: default colours). */
  private paint: Uint8Array | null = null;

  /**
   * The draft's ghost, or null when there is nothing to show. The same object comes back until the
   * layout changes.
   */
  resolve(
    pieces: readonly CoasterPiece[],
    definition: BuildDefinition | null,
    armed: boolean,
    models: SceneModels,
    transforms: TransformTable | null = null,
    colours: ObjectColours | null = null,
  ): GhostState | null {
    const count = Math.min(pieces.length, MAX_PIECES);
    if (this.transforms !== transforms) {
      this.transforms?.releaseObject(DRAFT_TRAIN_OBJECT_ID);
      this.transforms = transforms;
      this.valid = false;
    }
    if (count === 0 || definition === null) {
      this.transforms?.releaseObject(DRAFT_TRAIN_OBJECT_ID);
      this.valid = false;
      this.length = 0;
      this.definition = null;
      return null;
    }
    if (this.valid && !this.changed(pieces, count, definition, armed, colours)) return this.state;
    this.store(pieces, count, definition, armed, colours);
    this.build(pieces, count, definition, models);
    return this.state;
  }

  /** Forget the layout (a new session): the next resolve rebuilds. */
  clear(): void {
    this.transforms?.releaseObject(DRAFT_TRAIN_OBJECT_ID);
    this.valid = false;
    this.length = 0;
    this.definition = null;
    this.colours = null;
  }

  private changed(pieces: readonly CoasterPiece[], count: number, definition: BuildDefinition, armed: boolean, colours: ObjectColours | null): boolean {
    if (count !== this.length || definition !== this.definition || armed !== this.armed || !sameObjectColours(colours, this.colours)) return true;
    const signature = this.signature;
    for (let index = 0; index < count; index += 1) {
      const piece = pieces[index];
      const at = index * 4;
      if (
        signature[at] !== piece.cell.x || signature[at + 1] !== piece.cell.y
        || signature[at + 2] !== piece.height || signature[at + 3] !== pieceCode(piece)
      ) return true;
    }
    return false;
  }

  private store(pieces: readonly CoasterPiece[], count: number, definition: BuildDefinition, armed: boolean, colours: ObjectColours | null): void {
    const signature = this.signature;
    for (let index = 0; index < count; index += 1) {
      const piece = pieces[index];
      const at = index * 4;
      signature[at] = piece.cell.x;
      signature[at + 1] = piece.cell.y;
      signature[at + 2] = piece.height;
      signature[at + 3] = pieceCode(piece);
    }
    this.length = count;
    this.definition = definition;
    this.armed = armed;
    this.colours = colours;
    this.valid = true;
  }

  private build(pieces: readonly CoasterPiece[], count: number, definition: BuildDefinition, models: SceneModels): void {
    const writer = this.writer;
    writer.clear();
    const layout = pieces.length === count ? pieces : pieces.slice(0, count);
    this.transforms?.releaseObject(DRAFT_TRAIN_OBJECT_ID);
    const paint = models.slotTable(definition.id, this.colours, this.slotTable);
    this.paint = paint;
    let ringPieces: readonly CoasterPiece[];
    // Phase 44: a shuttle draft is drawn on its own open line, exactly as it will be built.
    if (layoutCanClose(layout) || (isShuttleLayout(layout) && count >= 2)) {
      ringPieces = layout;
      // Group 0 is the ground's: a draft never claims an object's outline.
      for (let index = 0; index < count; index += 1) models.pieceBoxes(layout, index, definition, 0, writer, paint);
    } else {
      // The layout's own pieces are ring[1] … ring[count]; ring[0] and ring[count + 1] are scratch.
      // Rotate the (cyclic, so identical) ring to start at the first real piece: the station furniture
      // belongs to piece indices 0 … stationLength − 1, and a leading scratch piece would shift it
      // one piece along (the third station piece of a draft lost its platform and canopy).
      const ring = openDraftRing(layout);
      ring.push(ring.shift() as CoasterPiece);
      ringPieces = ring;
      for (let index = 0; index < count; index += 1) models.pieceBoxes(ring, index, definition, 0, writer, paint);
    }
    if (this.transforms !== null && count >= GAME_CONFIG.coaster.stationLength) {
      this.emitTrain(ringPieces === layout ? layout : trainRing(layout), definition, models, writer);
    }
    const state = this.state;
    // A fresh view of the same storage: identity is what tells the GPU to upload.
    state.boxes = writer.data.subarray(0, writer.count * BOX_FLOATS);
    state.boxCount = writer.count;
    state.coverage = this.armed ? DRAFT_COVERAGE_ARMED : DRAFT_COVERAGE_PARKED;
  }

  /** The parked train at the end of the station (closed draft: its own ring; open draft: `trainRing`): cars and coupling halves, no riders. */
  private emitTrain(ring: readonly CoasterPiece[], definition: BuildDefinition, models: SceneModels, writer: BoxWriter): void {
    const table = this.transforms;
    if (table === null) return;
    const cars = COASTER_TYPE_BY_ID.get(definition.id)?.trainCars ?? 0;
    if (cars === 0) return;
    const poses = createCoasterCarPoses(cars);
    placeCarsOnTrack(centreLineFor(ring), GAME_CONFIG.coaster.stationLength - 1, cars, poses, coasterHangOffset(definition.id));
    writeCoasterCarTransforms(table, DRAFT_TRAIN_OBJECT_ID, poses, 0, false);
    for (let car = 0; car < cars; car += 1) {
      const flat = models.carFlat(definition, car);
      this.pushOnSlot(writer, flat.boxes, flat.boxCount, table.slotFor(DRAFT_TRAIN_OBJECT_ID, coasterCarSlotKey(car)), flat.tags);
    }
    if (cars > 1) {
      const coupling = models.couplingFlat(definition);
      for (let car = 0; car + 1 < cars; car += 1) {
        for (let half = 0; half < 2; half += 1) {
          this.pushOnSlot(writer, coupling.boxes, coupling.boxCount, table.slotFor(DRAFT_TRAIN_OBJECT_ID, coasterCouplingSlotKey(car, half)));
        }
      }
    }
  }

  /** Appends a part's boxes (already pivot-relative) bound to a transform slot; `tags` repaint them through the draft's slot table. */
  private pushOnSlot(writer: BoxWriter, boxes: Float32Array, count: number, slot: number, tags: Uint8Array | null = null): void {
    const from = writer.count;
    writer.pushTranslated(boxes, count, 0, 0, 0);
    const data = writer.data;
    const paint = this.paint;
    for (let box = from; box < writer.count; box += 1) {
      const at = box * BOX_FLOATS;
      if (paint !== null && tags !== null) {
        const material = paint[tags[box - from]];
        if (material !== 0) data[at + 3] = withMaterial(data[at + 3], material);
      }
      // Group 0 is the ground's: a draft never claims an object's outline.
      data[at + 3] = withOutlineGroup(data[at + 3], 0);
      data[at + 7] = slot;
    }
  }
}
