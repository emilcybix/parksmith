import { GAME_CONFIG } from '../../../game/config';
import type { Guest } from '../../../game/guests/types';
import type { StaffRuntime } from '../../../game/operations/types';
import type { RideRuntime } from '../../../game/rides/types';
import type { ParkSession } from '../../../game/session/ParkSession';
import type { ServiceRuntime } from '../../../game/shops/types';
import type { Cell } from '../../../game/types';
import { VIEW_ROTATIONS, type ViewRotation } from '../../viewRotation';
import {
  FIGURE_CAPACITY,
  FIGURE_FLAG_DESATURATE,
  FIGURE_FLOATS,
  FIGURE_FRAME_ARMS_UP,
  FIGURE_FRAME_CAMERA,
  FIGURE_FRAME_EAT,
  FIGURE_FRAME_FAN_A,
  FIGURE_FRAME_FAN_B,
  FIGURE_FRAME_HOLD,
  FIGURE_FRAME_HUNCH,
  FIGURE_FRAME_JUMP,
  FIGURE_FRAME_MS,
  FIGURE_FRAME_POINT,
  FIGURE_FRAME_SHIVER_A,
  FIGURE_FRAME_SHIVER_B,
  FIGURE_FRAME_SIT,
  FIGURE_FRAME_STANDING,
  FIGURE_FRAME_STOMP_A,
  FIGURE_FRAME_STOMP_B,
  FIGURE_FRAME_VOMIT,
  FIGURE_FRAME_WAVE_A,
  FIGURE_FRAME_WAVE_B,
  FIGURE_MODEL_CLEANER,
  FIGURE_MODEL_GUEST,
  FIGURE_MODEL_GUEST_BALLOON,
  FIGURE_MODEL_GUEST_GLOW,
  FIGURE_MODEL_GUEST_HAT,
  FIGURE_MODEL_GUEST_PLUSH,
  FIGURE_MODEL_GUEST_UMBRELLA,
  FIGURE_MODEL_COUNT,
  FIGURE_MODEL_MECHANIC,
  FIGURE_TEX_WIDTH,
  FIGURE_TEXELS,
  GUEST_FIGURE_MODELS,
  packPaletteWord,
  queueSlotOffset,
} from '../contracts/figures';
import { holdsSouvenir, isRaining } from '../../../game/guests/life';
import type { GuestActivity } from '../../../game/guests/types';
import type { FigureHeading, FigureModel, FigureRange } from '../contracts/figures';
import { MAT, SKIN_MATERIALS } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { PATH_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';

/**
 * Per-frame entity packing for guests and staff (contracts/figures.ts): interpolated positions,
 * queue slots, headings, walk keyframes, palette words — into one reused Float32Array.
 *
 * The simulation moves figures only on its 10 Hz fixed step, so drawing the raw positions makes a
 * thousand guests stutter in 6-voxel hops. Each entity keeps its position at the previous and the
 * latest step, copied as numbers (a guest's `position` object is replaced at every waypoint), and
 * is drawn at prev + (cur − prev) · stepFraction: one step behind the simulation, never ahead of
 * it. A new step is detected from `world.tick`; the history snaps (prev = cur) whenever
 * interpolating would draw something that never happened — several steps in one frame, an entity
 * that is new or was hidden (it would glide out of the ride it just left), or a move of more than
 * two cells (a reroute after the path under it was bulldozed).
 *
 * Walk keyframes are clocked by simulation time, (tick + stepFraction) · fixedStepMs, not by
 * wall-clock time: at 1× the two are the same, but a paused park then stays perfectly still
 * (nobody marches on the spot, and two paused frames are identical texel for texel), and at 2× or
 * 4× the legs keep pace with the ground they cover.
 *
 * Entities are grouped by model — guests, then cleaners, then mechanics — so the GPU draws one
 * range per model. Everything a frame touches is preallocated: histories come from a free list,
 * the queue slot offsets from a table, and records are compared before they are written, so a
 * still frame (a paused park) marks no rows dirty and uploads nothing.
 */

export interface FigureFrame {
  /** FIGURE_FLOATS per entity; the same array every pack. */
  data: Float32Array;
  count: number;
  /**
   * One range per model, indexed by FigureModel (Phase 29 added the guests carrying something after the staff); the
   * entities themselves are packed guests first (GUEST_FIGURE_MODELS order), then cleaners, then mechanics. The same
   * array every pack.
   */
  ranges: readonly FigureRange[];
  /**
   * Dirty texel rows of `data` (FIGURE_TEX_WIDTH wide) since the previous pack; equal when clean.
   * Records are only rewritten when they change, so the texture stays in step with `data` only if
   * these rows are uploaded after every pack.
   */
  rowStart: number;
  rowEnd: number;
}

export interface FigurePacker {
  /** Forget all history (session swap). A different session object passed to `pack` does this too. */
  reset(): void;
  /**
   * Phase 26: the view the map is shown in. Queue slots are a screen layout, so the queued guests' world
   * offsets follow the view; the next pack rewrites (and marks dirty) only their records.
   */
  setView(rotation: ViewRotation): void;
  /**
   * `stepFraction` is SimulationClock.stepFraction (0..1 into the next fixed step). A new step is
   * detected from world.tick; allocation-free once warm. The returned frame object is reused: read
   * it before the next pack.
   */
  pack(session: ParkSession, stepFraction: number): FigureFrame;
  /** Voxel leftovers: write only entities inside this WORLD-cell rectangle (see the class). */
  setCull(x0: number, y0: number, x1: number, y1: number): void;
  /** Write every entity again. */
  clearCull(): void;
  /**
   * Guests and staff the packer currently remembers. After a pack it equals the session's
   * population: histories of guests who left are recycled, never kept (stats and tests).
   */
  readonly remembered: number;
}

const ENTITIES_PER_ROW = FIGURE_TEX_WIDTH / FIGURE_TEXELS;
const HALF_TILE_VOXELS = VOXELS_PER_TILE / 2;
const WALK_CYCLE_FRAMES = 4;

/** A step that moves an entity further than this (in cells) is a teleport, never interpolated. */
const SNAP_DISTANCE_CELLS = 2;
/** Moves and offsets shorter than this (in cells) are float noise, not a direction. */
const DIRECTION_EPSILON = 1e-6;

/** Cell offset of each heading's facing direction: 0 = +x, 1 = +y, 2 = −x, 3 = −y. */
const HEADING_DX: readonly number[] = [1, 0, -1, 0];
const HEADING_DY: readonly number[] = [0, 1, 0, -1];

const HAIR_MATERIALS: readonly number[] = [MAT.HAIR_DARK, MAT.HAIR_BROWN, MAT.HAIR_BLOND];
/** One guest in this many wears a hat in their accent colour instead of showing their hair. */
const HAT_EVERY = 4;

/**
 * Phase 29: a two-frame pose per activity, [A, B, milliseconds per frame] (A === B for a still pose). Animated poses are
 * clocked by simulation time like the walk, offset per guest so a crowd never moves in lockstep.
 */
const ACTIVITY_POSES: Readonly<Record<GuestActivity, readonly [number, number, number]>> = {
  seatLeft: [FIGURE_FRAME_SIT, FIGURE_FRAME_SIT, 1000],
  seatRight: [FIGURE_FRAME_SIT, FIGURE_FRAME_SIT, 1000],
  admire: [FIGURE_FRAME_POINT, FIGURE_FRAME_STANDING, 700],
  watchRide: [FIGURE_FRAME_STANDING, FIGURE_FRAME_ARMS_UP, 450],
  photo: [FIGURE_FRAME_CAMERA, FIGURE_FRAME_CAMERA, 1000],
  cheer: [FIGURE_FRAME_JUMP, FIGURE_FRAME_ARMS_UP, 180],
  queasy: [FIGURE_FRAME_HUNCH, FIGURE_FRAME_HUNCH, 1000],
  vomit: [FIGURE_FRAME_VOMIT, FIGURE_FRAME_HUNCH, 260],
  fanSelf: [FIGURE_FRAME_FAN_A, FIGURE_FRAME_FAN_B, 140],
  shiver: [FIGURE_FRAME_SHIVER_A, FIGURE_FRAME_SHIVER_B, 90],
  sulk: [FIGURE_FRAME_STOMP_A, FIGURE_FRAME_STOMP_B, 240],
  eat: [FIGURE_FRAME_EAT, FIGURE_FRAME_STANDING, 320],
  drink: [FIGURE_FRAME_EAT, FIGURE_FRAME_EAT, 1000],
  balloonLost: [FIGURE_FRAME_ARMS_UP, FIGURE_FRAME_ARMS_UP, 1000],
  showOff: [FIGURE_FRAME_HOLD, FIGURE_FRAME_ARMS_UP, 260],
};

/** New arrivals wave as they come through the gate. */
const ENTERING_POSE: readonly [number, number, number] = [FIGURE_FRAME_WAVE_A, FIGURE_FRAME_WAVE_B, 200];

/**
 * Phase 29 bench seats, in voxels from the bench tile's corner, per visual quarter turn (the bench model's front is world
 * +y at turn 0 and world +x at turn 1, amenities.ts): the two seats sit 5 voxels either side of the middle along the
 * bench, a voxel in front of the middle so the back stays behind the sitter, facing the front.
 */
const SEAT_ALONG = 5;
const SEAT_FORWARD = 1;

const QUEUE_KIND_NONE = 0;
const QUEUE_KIND_RIDE = 1;
const QUEUE_KIND_SHOP = 2;

/**
 * queueSlotOffset for every slot a queue can hold and every view (slot-major per view: view q starts at
 * q * QUEUE_SLOT_COUNT), so a frame never allocates the offset objects. Ground-plane offsets (space.ts): in
 * every view each queue row lower on screen is also nearer the camera, so a queued guest never sinks into
 * the paving or slips behind the fence in front of its tile.
 */
const QUEUE_SLOT_COUNT = Math.max(GAME_CONFIG.rides.maximumQueueLength, GAME_CONFIG.services.maximumQueueLength);

const queueSlotTable = (axis: 'dvx' | 'dvy'): Float64Array => {
  const table = new Float64Array(QUEUE_SLOT_COUNT * VIEW_ROTATIONS.length);
  for (const rotation of VIEW_ROTATIONS) {
    for (let index = 0; index < QUEUE_SLOT_COUNT; index += 1) {
      table[rotation * QUEUE_SLOT_COUNT + index] = queueSlotOffset(index, rotation)[axis];
    }
  }
  return table;
};

const QUEUE_SLOT_DVX = queueSlotTable('dvx');
const QUEUE_SLOT_DVY = queueSlotTable('dvy');

/**
 * The quarter-turn heading closest to a direction in the ground plane; the larger component wins
 * and ties go to x. Paths are a grid, so real moves are axis-aligned anyway.
 */
export const headingOf = (dx: number, dy: number): FigureHeading => {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 2;
  return dy >= 0 ? 1 : 3;
};

/**
 * A well-mixed 32-bit hash of an entity id, so hair, skin and hats vary independently of the
 * guest colour tables (which are indexed by id % 6 and id % 4).
 */
const mixId = (id: number): number => {
  let hash = Math.imul(id ^ 0x9e37_79b9, 0x85eb_ca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2_ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

/** Hair material of a figure: a hat in the guest's accent colour for one in HAT_EVERY guests. */
const hairOf = (palette: Palette, id: number, accent: number | null): number => {
  const hash = mixId(id);
  if (accent !== null && hash % HAT_EVERY === 0) return palette.material(accent);
  return HAIR_MATERIALS[(hash >>> 8) % HAIR_MATERIALS.length];
};

const skinOf = (id: number): number => SKIN_MATERIALS[(mixId(id) >>> 16) % SKIN_MATERIALS.length];

/** What the packer remembers about one guest or staff member between frames. */
interface FigureHistory {
  /** Position (cells) at the previous and at the latest simulation step, copied as numbers. */
  previousX: number;
  previousY: number;
  currentX: number;
  currentY: number;
  /** Whether it was drawn at the latest step; a hidden entity snaps when it reappears. */
  visible: boolean;
  heading: FigureHeading;
  /** packPaletteWord of the entity, resolved once (−1 until then). */
  paletteWord: number;
  /** The pack that last saw the entity in the session; older records are recycled. */
  seenPack: number;
  /** The slot the latest queue pass found the guest in: valid when queuePack is this pack. */
  queuePack: number;
  queueKind: number;
  queueObjectId: number;
  queueIndex: number;
  /** Cached heading toward an object the entity stands beside; valid for this object and cell. */
  facingObjectId: number;
  facingCellX: number;
  facingCellY: number;
  facingHeading: number;
  /** Phase 29: the palette word was resolved for the sun-hat model (its hair slot carries the accent colour). */
  hatted: boolean;
}

const newHistory = (): FigureHistory => ({
  previousX: 0,
  previousY: 0,
  currentX: 0,
  currentY: 0,
  visible: false,
  heading: 0,
  paletteWord: -1,
  seenPack: 0,
  queuePack: 0,
  queueKind: QUEUE_KIND_NONE,
  queueObjectId: -1,
  queueIndex: -1,
  facingObjectId: -1,
  facingCellX: 0,
  facingCellY: 0,
  facingHeading: -1,
  hatted: false,
});

/**
 * Heading of a figure with no route to go by: facing the camera (+y, screen lower-left), which also
 * shows a staff member's tool hand. It is the same for everyone on purpose: the figures that have no
 * route are the ones standing on the same spot (new arrivals at the entrance, idle staff), and
 * identical figures on one spot coincide into one, where mixed headings would interpenetrate.
 */
const DEFAULT_HEADING: FigureHeading = 1;

/** Heading of a figure seen for the first time: the last leg of its route if it has one. */
const initialHeading = (route: readonly Cell[]): FigureHeading => {
  const last = route.length - 1;
  if (last >= 1) {
    const dx = route[last].x - route[last - 1].x;
    const dy = route[last].y - route[last - 1].y;
    if (Math.abs(dx) + Math.abs(dy) > DIRECTION_EPSILON) return headingOf(dx, dy);
  }
  return DEFAULT_HEADING;
};

class PooledFigurePacker implements FigurePacker {
  private readonly palette: Palette;
  /** The view the queue slots are laid out for (setView). */
  private view: ViewRotation = 0;
  private readonly data = new Float32Array(FIGURE_CAPACITY * FIGURE_FLOATS);
  /** Indexed by FigureModel (ranges[m].model === m); the entities are packed guests first, then cleaners, then mechanics. */
  private readonly ranges: FigureRange[] = Array.from({ length: FIGURE_MODEL_COUNT }, (_unused, model) => (
    { model: model as FigureModel, firstEntity: 0, entityCount: 0 }
  ));
  private readonly frame: FigureFrame;
  private readonly guestHistory = new Map<number, FigureHistory>();
  private readonly staffHistory = new Map<number, FigureHistory>();
  private readonly spare: FigureHistory[] = [];
  /** Reused cell for world.objectAt lookups. */
  private readonly probe: Cell = { x: 0, y: 0 };
  /** Phase 32: the seat `seatOf` found (cells, as `track` takes them) and the heading that faces the bench front. */
  private readonly seatCell: Cell = { x: 0, y: 0 };
  private seatHeading: FigureHeading = 0;
  private session: ParkSession | null = null;
  private lastTick = Number.NaN;
  private packs = 0;
  // Per-pack state, set at the start of `pack` and read by the per-entity helpers.
  private stepped = false;
  private jumped = false;
  private fraction = 0;
  private walkFrame = 0;
  private count = 0;
  private dirtyFirst = 0;
  private dirtyLast = -1;
  private sweeping: Map<number, FigureHistory> | null = null;
  /** Phase 29: the guest model the current guest pass packs, and the per-pack weather it is chosen by. */
  private guestModel: FigureModel = FIGURE_MODEL_GUEST;
  private raining = false;
  private night = false;
  /** Simulation milliseconds of this pack (poses are clocked by it, like the walk). */
  private simMs = 0;
  private cullX0 = Number.NEGATIVE_INFINITY;
  private cullY0 = Number.NEGATIVE_INFINITY;
  private cullX1 = Number.POSITIVE_INFINITY;
  private cullY1 = Number.POSITIVE_INFINITY;

  constructor(palette: Palette) {
    this.palette = palette;
    this.frame = { data: this.data, count: 0, ranges: this.ranges, rowStart: 0, rowEnd: 0 };
  }

  get remembered(): number {
    return this.guestHistory.size + this.staffHistory.size;
  }

  setView(rotation: ViewRotation): void {
    this.view = rotation;
  }

  /**
   * Voxel leftovers (culling of figures): only entities whose position lies inside this WORLD-cell rectangle are
   * written (the renderer passes the camera's view plus a margin); null writes everyone (the default, and every test
   * that builds a packer). Off-screen entities keep their history, so one that walks back into view interpolates on.
   */
  setCull(x0: number, y0: number, x1: number, y1: number): void {
    this.cullX0 = x0;
    this.cullY0 = y0;
    this.cullX1 = x1;
    this.cullY1 = y1;
  }

  clearCull(): void {
    this.cullX0 = Number.NEGATIVE_INFINITY;
    this.cullY0 = Number.NEGATIVE_INFINITY;
    this.cullX1 = Number.POSITIVE_INFINITY;
    this.cullY1 = Number.POSITIVE_INFINITY;
  }

  private outside(history: FigureHistory): boolean {
    return history.currentX < this.cullX0 || history.currentX > this.cullX1 || history.currentY < this.cullY0 || history.currentY > this.cullY1;
  }

  reset(): void {
    this.recycleAll(this.guestHistory);
    this.recycleAll(this.staffHistory);
    this.session = null;
    this.lastTick = Number.NaN;
  }

  pack(session: ParkSession, stepFraction: number): FigureFrame {
    if (session !== this.session) {
      this.reset();
      this.session = session;
    }
    this.packs += 1;
    const tick = session.world.tick;
    this.stepped = tick !== this.lastTick;
    // NaN (the first pack) compares unequal, so a fresh packer snaps everything.
    this.jumped = this.stepped && tick !== this.lastTick + 1;
    this.lastTick = tick;
    this.fraction = stepFraction > 0 ? Math.min(stepFraction, 1) : 0;
    this.simMs = (tick + this.fraction) * GAME_CONFIG.fixedStepMs;
    this.walkFrame = Math.floor(this.simMs / FIGURE_FRAME_MS);
    const conditions = session.weather.conditions;
    this.raining = isRaining(conditions);
    this.night = conditions.night;
    this.count = 0;
    this.dirtyFirst = FIGURE_CAPACITY;
    this.dirtyLast = -1;

    // Map.forEach with callbacks bound once: unlike for…of it allocates no iterators.
    session.rides.rides.forEach(this.indexRideQueue);
    session.shops.services.forEach(this.indexShopQueue);
    // One pass per guest model (Phase 29): each guest is tracked and written in exactly one of them, its own.
    for (let index = 0; index < GUEST_FIGURE_MODELS.length; index += 1) {
      this.guestModel = GUEST_FIGURE_MODELS[index];
      const range = this.ranges[this.guestModel];
      range.firstEntity = this.count;
      session.guests.guests.forEach(this.packGuest);
      range.entityCount = this.count - range.firstEntity;
    }
    const cleaners = this.ranges[FIGURE_MODEL_CLEANER];
    cleaners.firstEntity = this.count;
    session.operations.staff.forEach(this.packCleaner);
    cleaners.entityCount = this.count - cleaners.firstEntity;
    const mechanics = this.ranges[FIGURE_MODEL_MECHANIC];
    mechanics.firstEntity = this.count;
    session.operations.staff.forEach(this.packMechanic);
    mechanics.entityCount = this.count - mechanics.firstEntity;

    this.sweep(this.guestHistory, session.guests.guests.size);
    this.sweep(this.staffHistory, session.operations.staff.size);

    const frame = this.frame;
    frame.count = this.count;
    if (this.dirtyLast < this.dirtyFirst) {
      frame.rowStart = 0;
      frame.rowEnd = 0;
    } else {
      frame.rowStart = Math.floor(this.dirtyFirst / ENTITIES_PER_ROW);
      frame.rowEnd = Math.floor(this.dirtyLast / ENTITIES_PER_ROW) + 1;
    }
    return frame;
  }

  /**
   * One pass over every ride and shop queue records each queued guest's slot in its history, so
   * the guest pass reads it in O(1) instead of searching its queue (legacy's indexOf per guest).
   */
  private readonly indexRideQueue = (ride: RideRuntime): void => {
    this.indexQueue(QUEUE_KIND_RIDE, ride.objectId, ride.queueGuestIds);
  };

  private readonly indexShopQueue = (service: ServiceRuntime): void => {
    this.indexQueue(QUEUE_KIND_SHOP, service.objectId, service.queueGuestIds);
  };

  private indexQueue(kind: number, objectId: number, guestIds: readonly number[]): void {
    for (let index = 0; index < guestIds.length; index += 1) {
      const history = this.guestHistory.get(guestIds[index]);
      // A guest first seen this pack has no history yet; queueIndexOf falls back to a search.
      if (history === undefined) continue;
      history.queuePack = this.packs;
      history.queueKind = kind;
      history.queueObjectId = objectId;
      history.queueIndex = index;
    }
  }

  /** Legacy semantics: the guest's slot in the queue of the attraction it is queueing for, or −1. */
  private queueIndexOf(guest: Guest, history: FigureHistory, kind: number, objectId: number): number {
    if (history.queuePack === this.packs && history.queueKind === kind && history.queueObjectId === objectId) {
      return history.queueIndex;
    }
    const session = this.session as ParkSession;
    const queue = kind === QUEUE_KIND_RIDE
      ? session.rides.rides.get(objectId)?.queueGuestIds
      : session.shops.services.get(objectId)?.queueGuestIds;
    return queue === undefined ? -1 : queue.indexOf(guest.id);
  }

  /**
   * Phase 29: the model a guest is drawn with this pack: what they carry, the most visible first (an umbrella only opens
   * in the rain and a glow wand only shows at night).
   */
  private modelOf(guest: Guest): FigureModel {
    if (guest.souvenirs === 0) return FIGURE_MODEL_GUEST;
    if (this.raining && holdsSouvenir(guest, 'umbrella')) return FIGURE_MODEL_GUEST_UMBRELLA;
    if (holdsSouvenir(guest, 'balloon')) return FIGURE_MODEL_GUEST_BALLOON;
    if (this.night && holdsSouvenir(guest, 'glowWand')) return FIGURE_MODEL_GUEST_GLOW;
    if (holdsSouvenir(guest, 'hat')) return FIGURE_MODEL_GUEST_HAT;
    if (holdsSouvenir(guest, 'plush')) return FIGURE_MODEL_GUEST_PLUSH;
    return FIGURE_MODEL_GUEST;
  }

  private readonly packGuest = (guest: Guest): void => {
    const model = this.modelOf(guest);
    if (model !== this.guestModel) return;
    const state = guest.state;
    const visible = state !== 'riding' && state !== 'shopping' && state !== 'usingFacility';
    // Phase 32: a seated guest is tracked AT the seat, so sitting down and standing up interpolate like any step
    // (the path cell beside the bench is under 2 cells from the seat) instead of jumping half a tile.
    const seated = state === 'resting' && guest.destinationObjectId !== null && this.seatOf(guest.destinationObjectId, guest.activity);
    const history = this.track(this.guestHistory, guest.id, seated ? this.seatCell : guest.position, visible, guest.route);
    if (!visible || this.outside(history)) return;
    // A sun hat keeps the guest's accent colour on its crown, whoever would otherwise show hair.
    const hatted = model === FIGURE_MODEL_GUEST_HAT;
    if (history.paletteWord < 0 || history.hatted !== hatted) {
      history.hatted = hatted;
      history.paletteWord = packPaletteWord(
        this.palette.material(guest.color),
        hatted ? this.palette.material(guest.accent) : hairOf(this.palette, guest.id, guest.accent),
        skinOf(guest.id),
      );
    }

    let queueIndex = -1;
    let facing = -1;
    const queueKind = state === 'queueing' ? QUEUE_KIND_RIDE : state === 'queueingForShop' ? QUEUE_KIND_SHOP : QUEUE_KIND_NONE;
    const objectId = guest.destinationObjectId;
    if (queueKind !== QUEUE_KIND_NONE && objectId !== null) {
      queueIndex = this.queueIndexOf(guest, history, queueKind, objectId);
      // Queued guests face the attraction they are waiting for, like a real queue.
      facing = this.facingToward(history, objectId, guest.currentCell);
    }
    // Phase 29: an admirer faces what they admire, a ride watcher the ride.
    if (state === 'pausing' && objectId !== null) facing = this.facingObject(history, objectId, guest.currentCell);
    if (seated) facing = this.seatHeading;
    if (facing >= 0) history.heading = facing as FigureHeading;
    else this.steer(history, guest.route, guest.routeIndex, guest.position);

    const walking = queueKind === QUEUE_KIND_NONE && guest.routeIndex < guest.route.length;
    // A pause, a seat, or a wandering guest's flourish while they stand taking in the ride or the snack.
    const posing = state === 'pausing' || seated || (state === 'wandering' && !walking);
    const pose = posing && guest.activity !== null ? ACTIVITY_POSES[guest.activity]
      : state === 'entering' ? ENTERING_POSE : null;
    this.write(
      history,
      queueIndex,
      pose !== null ? this.poseFrame(pose, guest.id)
        : walking ? (this.walkFrame + guest.id) % WALK_CYCLE_FRAMES : FIGURE_FRAME_STANDING,
      model,
      state === 'leaving' ? FIGURE_FLAG_DESATURATE : 0,
    );
  };

  /** The frame of a two-frame pose now, phase-shifted per guest. */
  private poseFrame(pose: readonly [number, number, number], id: number): number {
    if (pose[0] === pose[1]) return pose[0];
    return (Math.floor(this.simMs / pose[2]) + id) % 2 === 0 ? pose[0] : pose[1];
  }

  /**
   * Phase 29: where a resting guest sits on the bench (the simulation keeps them on the path beside it) and the heading
   * that faces the bench's front, into `seatCell` and `seatHeading`. False when the bench is gone (the guest is then
   * drawn where the simulation has them). Phase 32: it no longer writes the history; the seat goes through `track`, so
   * the first seated frame and the first frame after standing up interpolate (it used to overwrite both the previous
   * and the current position, so a guest jumped half a tile onto the seat).
   */
  private seatOf(benchId: number, activity: GuestActivity | null): boolean {
    const bench = (this.session as ParkSession).world.objects.get(benchId);
    if (bench === undefined) return false;
    const side = activity === 'seatRight' ? 1 : -1;
    const turned = bench.rotation % 2 === 1;
    const alongX = turned ? HALF_TILE_VOXELS + SEAT_FORWARD : HALF_TILE_VOXELS + side * SEAT_ALONG;
    const alongY = turned ? HALF_TILE_VOXELS - side * SEAT_ALONG : HALF_TILE_VOXELS + SEAT_FORWARD;
    // Cells such that write()'s `cell · VOXELS_PER_TILE + HALF_TILE_VOXELS` lands on the seat.
    const x = bench.anchor.x + (alongX - HALF_TILE_VOXELS) / VOXELS_PER_TILE;
    const y = bench.anchor.y + (alongY - HALF_TILE_VOXELS) / VOXELS_PER_TILE;
    this.seatCell.x = x;
    this.seatCell.y = y;
    this.seatHeading = turned ? 0 : 1;
    return true;
  }

  /** Phase 29: heading toward the middle of an object's footprint (scenery or a ride), cached per object and cell. */
  private facingObject(history: FigureHistory, objectId: number, cell: Cell): number {
    if (history.facingObjectId === objectId && history.facingCellX === cell.x && history.facingCellY === cell.y) {
      return history.facingHeading;
    }
    history.facingObjectId = objectId;
    history.facingCellX = cell.x;
    history.facingCellY = cell.y;
    history.facingHeading = -1;
    const world = (this.session as ParkSession).world;
    const object = world.objects.get(objectId);
    if (object === undefined) return -1;
    const footprint = world.objectFootprint(object);
    let sumX = 0;
    let sumY = 0;
    for (const occupied of footprint) {
      sumX += occupied.x;
      sumY += occupied.y;
    }
    const dx = sumX / Math.max(1, footprint.length) - cell.x;
    const dy = sumY / Math.max(1, footprint.length) - cell.y;
    if (Math.abs(dx) + Math.abs(dy) > DIRECTION_EPSILON) history.facingHeading = headingOf(dx, dy);
    return history.facingHeading;
  }

  /** Staff are packed in two passes, cleaners then mechanics, each in hire order. */
  private readonly packCleaner = (worker: StaffRuntime): void => {
    if (worker.role === 'cleaner') this.packWorker(worker, FIGURE_MODEL_CLEANER);
  };

  private readonly packMechanic = (worker: StaffRuntime): void => {
    if (worker.role === 'mechanic') this.packWorker(worker, FIGURE_MODEL_MECHANIC);
  };

  private packWorker(worker: StaffRuntime, model: FigureModel): void {
    const history = this.track(this.staffHistory, worker.id, worker.position, true, worker.route);
    if (this.outside(history)) return;
    if (history.paletteWord < 0) {
      const uniform = model === FIGURE_MODEL_CLEANER ? MAT.CLEANER_UNIFORM : MAT.MECHANIC_UNIFORM;
      history.paletteWord = packPaletteWord(uniform, hairOf(this.palette, worker.id, null), skinOf(worker.id));
    }
    const walking = worker.state === 'walking' && worker.routeIndex < worker.route.length;
    const target = worker.task?.targetObjectId ?? null;
    let facing = -1;
    // At work (or waiting to start), a mechanic faces the ride and a cleaner the bin.
    if (!walking && target !== null) facing = this.facingToward(history, target, worker.currentCell);
    if (facing >= 0) history.heading = facing as FigureHeading;
    else this.steer(history, worker.route, worker.routeIndex, worker.position);
    this.write(
      history,
      -1,
      walking ? (this.walkFrame + worker.id) % WALK_CYCLE_FRAMES : FIGURE_FRAME_STANDING,
      model,
      worker.state === 'waiting' ? FIGURE_FLAG_DESATURATE : 0,
    );
  }

  /** Finds or creates the entity's history and rolls it to this pack (see the file comment). */
  private track(
    histories: Map<number, FigureHistory>,
    id: number,
    position: Cell,
    visible: boolean,
    route: readonly Cell[],
  ): FigureHistory {
    const x = position.x;
    const y = position.y;
    let history = histories.get(id);
    if (history === undefined) {
      history = this.spare.pop() ?? newHistory();
      history.previousX = x;
      history.previousY = y;
      history.currentX = x;
      history.currentY = y;
      history.heading = initialHeading(route);
      history.paletteWord = -1;
      history.queuePack = 0;
      history.facingObjectId = -1;
      histories.set(id, history);
    } else if (this.stepped) {
      const dx = x - history.currentX;
      const dy = y - history.currentY;
      const snap = this.jumped || !history.visible || dx * dx + dy * dy > SNAP_DISTANCE_CELLS * SNAP_DISTANCE_CELLS;
      history.previousX = snap ? x : history.currentX;
      history.previousY = snap ? y : history.currentY;
      history.currentX = x;
      history.currentY = y;
    } else if (x !== history.currentX || y !== history.currentY || (visible && !history.visible)) {
      // Moved or reappeared between steps (a sync outside the fixed step): nothing to interpolate from.
      history.previousX = x;
      history.previousY = y;
      history.currentX = x;
      history.currentY = y;
    }
    history.visible = visible;
    history.seenPack = this.packs;
    return history;
  }

  /**
   * Heading of a moving figure: the direction of its latest step, so it turns exactly when its
   * interpolated position turns the corner rather than one step early; before the first step, the
   * direction to its next waypoint; standing, whatever it last faced.
   */
  private steer(history: FigureHistory, route: readonly Cell[], routeIndex: number, position: Cell): void {
    const stepX = history.currentX - history.previousX;
    const stepY = history.currentY - history.previousY;
    if (Math.abs(stepX) + Math.abs(stepY) > DIRECTION_EPSILON) {
      history.heading = headingOf(stepX, stepY);
      return;
    }
    if (routeIndex >= route.length) return;
    const target = route[routeIndex];
    const towardX = target.x - position.x;
    const towardY = target.y - position.y;
    if (Math.abs(towardX) + Math.abs(towardY) > DIRECTION_EPSILON) history.heading = headingOf(towardX, towardY);
  }

  /**
   * Heading toward a neighbouring cell of `objectId` from `cell` (an access tile always touches its
   * attraction on one side), or −1 when none does. Cached per (object, cell), so the world lookups
   * run once when a figure arrives, not every frame.
   */
  private facingToward(history: FigureHistory, objectId: number, cell: Cell): number {
    if (history.facingObjectId === objectId && history.facingCellX === cell.x && history.facingCellY === cell.y) {
      return history.facingHeading;
    }
    history.facingObjectId = objectId;
    history.facingCellX = cell.x;
    history.facingCellY = cell.y;
    history.facingHeading = -1;
    const world = (this.session as ParkSession).world;
    const probe = this.probe;
    for (let heading = 0; heading < HEADING_DX.length; heading += 1) {
      probe.x = cell.x + HEADING_DX[heading];
      probe.y = cell.y + HEADING_DY[heading];
      if (world.objectAt(probe)?.id === objectId) {
        history.facingHeading = heading;
        break;
      }
    }
    return history.facingHeading;
  }

  /**
   * Writes the next entity record, touching the data (and its dirty rows) only where it changed.
   * Takes the queue slot rather than its offset: a fractional offset passed as an argument is boxed
   * into a fresh heap number on every call, about 5 KB of garbage a frame with a park's queues.
   */
  private write(history: FigureHistory, queueIndex: number, frame: number, model: FigureModel, flags: number): void {
    if (this.count >= FIGURE_CAPACITY) return;
    const entity = this.count;
    this.count += 1;
    let offsetX = 0;
    let offsetY = 0;
    if (queueIndex >= QUEUE_SLOT_COUNT) {
      const offset = queueSlotOffset(queueIndex, this.view);
      offsetX = offset.dvx;
      offsetY = offset.dvy;
    } else if (queueIndex >= 0) {
      offsetX = QUEUE_SLOT_DVX[this.view * QUEUE_SLOT_COUNT + queueIndex];
      offsetY = QUEUE_SLOT_DVY[this.view * QUEUE_SLOT_COUNT + queueIndex];
    }
    const fraction = this.fraction;
    const x = (history.previousX + (history.currentX - history.previousX) * fraction) * VOXELS_PER_TILE + HALF_TILE_VOXELS + offsetX;
    const y = (history.previousY + (history.currentY - history.previousY) * fraction) * VOXELS_PER_TILE + HALF_TILE_VOXELS + offsetY;
    const data = this.data;
    const at = entity * FIGURE_FLOATS;
    if (
      data[at] === Math.fround(x) && data[at + 1] === Math.fround(y) && data[at + 2] === PATH_TOP_Z
      && data[at + 3] === history.heading && data[at + 4] === frame && data[at + 5] === model
      && data[at + 6] === history.paletteWord && data[at + 7] === flags
    ) {
      return;
    }
    data[at] = x;
    data[at + 1] = y;
    data[at + 2] = PATH_TOP_Z;
    data[at + 3] = history.heading;
    data[at + 4] = frame;
    data[at + 5] = model;
    data[at + 6] = history.paletteWord;
    data[at + 7] = flags;
    if (entity < this.dirtyFirst) this.dirtyFirst = entity;
    if (entity > this.dirtyLast) this.dirtyLast = entity;
  }

  /** Recycles the histories of entities that left the session (only when some did). */
  private sweep(histories: Map<number, FigureHistory>, liveCount: number): void {
    if (histories.size <= liveCount) return;
    this.sweeping = histories;
    histories.forEach(this.recycleIfStale);
    this.sweeping = null;
  }

  private readonly recycleIfStale = (history: FigureHistory, id: number): void => {
    if (history.seenPack === this.packs) return;
    this.sweeping?.delete(id);
    this.spare.push(history);
  };

  private recycleAll(histories: Map<number, FigureHistory>): void {
    for (const history of histories.values()) this.spare.push(history);
    histories.clear();
  }
}

export const createFigurePacker = (palette: Palette): FigurePacker => new PooledFigurePacker(palette);
