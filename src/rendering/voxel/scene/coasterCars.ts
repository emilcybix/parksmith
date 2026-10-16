import type { CoasterPiece } from '../../../game/coaster/design';
import {
  centreLineFor,
  centreLineIndexToDistance,
  createCentreLine,
  createCentreLineSample,
  sampleCentreLine,
} from '../../../game/coaster/centreLine';
import type { CentreLine } from '../../../game/coaster/centreLine';
import {
  COASTER_CAR_SPACING_TILES,
  coasterCouplingFrame,
  coasterCouplingHalfFrame,
  createCoasterCarFrame,
  createCoasterCouplingFrame,
  resampleCoasterCarFrame,
} from '../../coasterCarFrame';
import type { CoasterCarFrame } from '../../coasterCarFrame';
import { coasterCarSlotKey, coasterCouplingSlotKey, coasterRiderSlotKey, COLLAPSED_PART_QUATERNION } from '../contracts/rigid';
import { COASTER_LEVEL_VOXELS, VOXELS_PER_TILE } from '../contracts/space';
import { WORLD_POSE_FLOATS } from './rigid';
import type { TransformTable } from './rigid';

/**
 * Coaster car poses in world voxels along the track, from the shared, corrected
 * `coasterHeadIndex` (src/rendering/coasterTrain.ts): the caller turns the ride's status and cycle
 * into a head index, this module turns the index into one rigid transform per car, one per
 * coupling and one per car's riders.
 *
 * The track is the smooth centre line of `game/coaster/centreLine.ts` (Phase 27): corners are quarter
 * circles of 16 voxels inside their tile, heights are a monotone spline through the piece heights, a
 * loop ring is a vertical circle on the exit edge of its piece. Positions are that line scaled to
 * voxels (32 per tile, 13 per level, the rail top 5 above the level's base, art bible: bed
 * [13L + 1, 13L + 5), rail top 13L + 5) and the track content (content/coaster.ts) is built from the
 * very same line, so a car at z = 0 rides on the rendered rails.
 *
 * Timing: the head index (cell-based, gameplay) maps onto arc length with
 * `centreLineIndexToDistance`: linear inside each piece-centre-to-piece-centre segment and
 * monotonic, so the train is at every piece centre at the second it always was and lap time is
 * unchanged. Cars sit `COASTER_CAR_SPACING_UNITS` tiles of arc length behind the head.
 *
 * Orientation (car space, content.ts: +x travel, +y the car's left, z = 0 the rail top): the shared
 * frame of `coasterCarFrame.ts`, an orthonormal basis built from the car's two bogie points (so a car
 * spans a corner or a ring like a real one) and the banked cross-section's up axis (so it leans
 * with the track and rides upside down round the top of a loop); this module only turns that basis
 * into a quaternion. A coupling is two half-bars, each posed from one car's hitch toward the other's.
 *
 * Riders are a separate part per car (one rider per seat of that car). A parked or loading train shows none: its rider slot gets the
 * collapse pose (contracts/rigid.ts `COLLAPSED_PART_QUATERNION`, a degenerate quaternion that makes
 * every quad zero-area) so a status flip changes 8 floats and rebuilds nothing.
 *
 * API: `placeCoasterCars(record, …)` looks the centre line up in a cache keyed by the record's
 * `pieces` array (`centreLineFor` also re-checks the layout, so an edited array is never stale).
 * Callers that manage tracks themselves use `createCoasterTrack` + `placeCarsOnTrack`. Neither
 * allocates once `out.data` is large enough. `writeCoasterCarTransforms` then copies the poses into
 * the slots (contracts/rigid.ts) of the transform table.
 */

/**
 * Floats per car in `CoasterCarPoses.data`: pivot x, y, z, then quaternion x, y, z, w — the world
 * pose layout TransformTable.writeFrom reads, so a car is copied into its slot as it is.
 */
export const COASTER_CAR_POSE_FLOATS = WORLD_POSE_FLOATS;
/** Arc length, in tiles, between neighbouring cars (legacy coupling distance). */
export const COASTER_CAR_SPACING_UNITS = COASTER_CAR_SPACING_TILES;
/** Rail top above a level's base (13L): the 4-voxel bed from 13L + 1 plus the rails on it. */
export const COASTER_RAIL_TOP_OFFSET_VOXELS = 5;
/** Loop ring radius to the running surface, in voxels (legacy COASTER_LOOP_RADIUS, 16 px). */
export const COASTER_LOOP_RADIUS_VOXELS = 16;

/** World z of the rail top at a track height level. */
export const coasterRailTopZ = (height: number): number =>
  height * COASTER_LEVEL_VOXELS + COASTER_RAIL_TOP_OFFSET_VOXELS;

export interface CoasterCarPoses {
  /** Per car: pivot x, y, z (world voxels) and unit quaternion x, y, z, w — 7 floats. */
  data: Float32Array;
  count: number;
  /**
   * Per coupling (between car k and k + 1) two half-bar poses of the same 7 floats: half 0 (on car
   * k's rear hitch) at 2k, half 1 (on car k + 1's front hitch) at 2k + 1; `couplingCount` couplings.
   */
  couplings: Float32Array;
  couplingCount: number;
  /** Each car's frame (tiles), kept so couplings and tests read the basis the quaternion came from. */
  frames: CoasterCarFrame[];
}

export const createCoasterCarPoses = (capacity = 8): CoasterCarPoses => {
  const cars = Math.max(1, capacity);
  return {
    data: new Float32Array(cars * COASTER_CAR_POSE_FLOATS),
    count: 0,
    couplings: new Float32Array(2 * cars * COASTER_CAR_POSE_FLOATS),
    couplingCount: 0,
    frames: Array.from({ length: cars }, createCoasterCarFrame),
  };
};

/** What car placement reads from a coaster record (`GameWorld.coasters`). */
export interface CoasterTrackSource {
  readonly pieces: readonly CoasterPiece[];
}

/** A layout's centre line, built once so placing a train is arithmetic only. */
export type CoasterTrack = CentreLine;

export const createCoasterTrack = (pieces: readonly CoasterPiece[]): CoasterTrack => createCentreLine(pieces);

/** The cached track of a record's layout (built on first use, rebuilt if the layout changed). */
export const coasterTrackFor = (source: CoasterTrackSource): CoasterTrack => centreLineFor(source.pieces);

/** Where the rail top is at an arc length, in voxels, and how a car sitting there is turned. */
export interface CoasterTrackPoint {
  x: number;
  y: number;
  z: number;
  /** Heading about +z (radians): the plan direction of the line. */
  yaw: number;
  /** Nose-up angle: the slope of the climb under the point, and round a loop ring the turn 0 → 2π. */
  pitch: number;
  /** Nose-up angle around a loop ring, 0 → 2π through the ring; 0 everywhere else. */
  ringAngle: number;
  /** The arc length sampled (tiles), wrapped onto the circuit: [0, totalLength). */
  distance: number;
  /** The piece the point is on. */
  piece: number;
}

export const createCoasterTrackPoint = (): CoasterTrackPoint =>
  ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ringAngle: 0, distance: 0, piece: 0 });

const SAMPLE = createCentreLineSample();

/**
 * Samples the track at an arc length in tiles (wrapped onto the circuit, and stored wrapped in
 * `out.distance`); an empty layout samples the origin. Allocation-free.
 */
export const sampleCoasterTrack = (track: CoasterTrack, distance: number, out: CoasterTrackPoint): CoasterTrackPoint => {
  sampleCentreLine(track, distance, SAMPLE);
  out.x = SAMPLE.x * VOXELS_PER_TILE;
  out.y = SAMPLE.y * VOXELS_PER_TILE;
  out.z = coasterRailTopZ(SAMPLE.z);
  out.yaw = Math.atan2(SAMPLE.dirY, SAMPLE.dirX);
  out.pitch = SAMPLE.pitch;
  out.ringAngle = SAMPLE.ringAngle;
  out.distance = SAMPLE.distance;
  out.piece = SAMPLE.piece;
  return out;
};

/** Arc length (tiles) of a (possibly unwrapped) fractional piece index (`coasterHeadIndex`). */
export const coasterIndexToDistance = (track: CoasterTrack, index: number): number =>
  centreLineIndexToDistance(track, index);

const HEAD_DISTANCE = createCoasterTrackPoint();
const COUPLING = createCoasterCouplingFrame();
const COUPLING_HALF = createCoasterCarFrame();

/**
 * Writes a frame as a world pose (pivot in voxels, then the quaternion of the basis forward, left,
 * up as columns: Shepperd's method, no square root of a negative, no allocation).
 */
const writeFramePose = (frame: CoasterCarFrame, data: Float32Array, at: number): void => {
  const m00 = frame.forwardX;
  const m10 = frame.forwardY;
  const m20 = frame.forwardZ;
  const m01 = frame.leftX;
  const m11 = frame.leftY;
  const m21 = frame.leftZ;
  const m02 = frame.upX;
  const m12 = frame.upY;
  const m22 = frame.upZ;
  let qx: number;
  let qy: number;
  let qz: number;
  let qw: number;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const scale = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / scale;
    qx = (m21 - m12) * scale;
    qy = (m02 - m20) * scale;
    qz = (m10 - m01) * scale;
  } else if (m00 > m11 && m00 > m22) {
    const scale = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / scale;
    qx = 0.25 * scale;
    qy = (m01 + m10) / scale;
    qz = (m02 + m20) / scale;
  } else if (m11 > m22) {
    const scale = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / scale;
    qx = (m01 + m10) / scale;
    qy = 0.25 * scale;
    qz = (m12 + m21) / scale;
  } else {
    const scale = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / scale;
    qx = (m02 + m20) / scale;
    qy = (m12 + m21) / scale;
    qz = 0.25 * scale;
  }
  data[at] = frame.x * VOXELS_PER_TILE;
  data[at + 1] = frame.y * VOXELS_PER_TILE;
  data[at + 2] = coasterRailTopZ(frame.z);
  data[at + 3] = qx;
  data[at + 4] = qy;
  data[at + 5] = qz;
  data[at + 6] = qw;
};

/**
 * Poses `carCount` cars behind the head (car 0 leads) and the couplings between them into `out`;
 * `headIndex` is a fractional, possibly unwrapped piece index (coasterHeadIndex). Grows its buffers
 * only when they are too small; otherwise allocation-free.
 */
export const placeCarsOnTrack = (track: CoasterTrack, headIndex: number, carCount: number, out: CoasterCarPoses): void => {
  const cars = track.pieceCount > 0 && carCount > 0 && Number.isFinite(carCount) ? Math.floor(carCount) : 0;
  if (out.data.length < cars * COASTER_CAR_POSE_FLOATS) out.data = new Float32Array(cars * COASTER_CAR_POSE_FLOATS);
  if (out.couplings.length < 2 * cars * COASTER_CAR_POSE_FLOATS) out.couplings = new Float32Array(2 * cars * COASTER_CAR_POSE_FLOATS);
  while (out.frames.length < cars) out.frames.push(createCoasterCarFrame());
  out.count = cars;
  out.couplingCount = cars > 0 ? cars - 1 : 0;
  const data = out.data;
  const frames = out.frames;
  // The head's arc length goes through a field, never a call, so no heap number is boxed per car.
  HEAD_DISTANCE.distance = centreLineIndexToDistance(track, headIndex);
  for (let car = 0; car < cars; car += 1) {
    const frame = frames[car];
    frame.distance = HEAD_DISTANCE.distance - car * COASTER_CAR_SPACING_TILES;
    resampleCoasterCarFrame(track, frame);
    writeFramePose(frame, data, car * COASTER_CAR_POSE_FLOATS);
  }
  for (let car = 0; car + 1 < cars; car += 1) {
    coasterCouplingFrame(frames[car], frames[car + 1], COUPLING);
    writeFramePose(coasterCouplingHalfFrame(COUPLING, 0, COUPLING_HALF), out.couplings, 2 * car * COASTER_CAR_POSE_FLOATS);
    writeFramePose(coasterCouplingHalfFrame(COUPLING, 1, COUPLING_HALF), out.couplings, (2 * car + 1) * COASTER_CAR_POSE_FLOATS);
  }
};

/** Poses a coaster record's train (track cached per layout). See `placeCarsOnTrack`. */
export const placeCoasterCars = (
  record: CoasterTrackSource,
  headIndex: number,
  carCount: number,
  out: CoasterCarPoses,
): void => {
  placeCarsOnTrack(coasterTrackFor(record), headIndex, carCount, out);
};

const COLLAPSED = new Float32Array(COASTER_CAR_POSE_FLOATS);

/**
 * Copies posed cars into the transform table: car k into the slot keyed (objectId,
 * coasterCarSlotKey(k)), its riders into coasterRiderSlotKey(k) and the two halves of the coupling
 * behind it into coasterCouplingSlotKey(k, 0) and (k, 1) — each allocated on first use, then stable until the coaster's slots
 * are released. Riders of cars 0 … `loadedCars − 1` (coasterCarFrame.ts `coasterLoadedCars`) take the car's pose; every other rider slot
 * takes the collapse pose at the car's pivot rounded to whole voxels (so a parked train writes
 * identical floats every frame). True when anything moved (a parked train dirties nothing).
 * Allocation-free once every slot exists.
 */
export const writeCoasterCarTransforms = (
  table: TransformTable,
  objectId: number,
  poses: CoasterCarPoses,
  loadedCars = 0,
  withRiders = true,
): boolean => {
  let changed = false;
  const data = poses.data;
  for (let car = 0; car < poses.count; car += 1) {
    const at = car * COASTER_CAR_POSE_FLOATS;
    if (table.writeFrom(table.slotFor(objectId, coasterCarSlotKey(car)), data, at)) changed = true;
    if (!withRiders) continue;
    const riders = table.slotFor(objectId, coasterRiderSlotKey(car));
    if (car < loadedCars) {
      if (table.writeFrom(riders, data, at)) changed = true;
    } else {
      COLLAPSED[0] = Math.round(data[at]);
      COLLAPSED[1] = Math.round(data[at + 1]);
      COLLAPSED[2] = Math.round(data[at + 2]);
      COLLAPSED[3] = COLLAPSED_PART_QUATERNION[0];
      COLLAPSED[4] = COLLAPSED_PART_QUATERNION[1];
      COLLAPSED[5] = COLLAPSED_PART_QUATERNION[2];
      COLLAPSED[6] = COLLAPSED_PART_QUATERNION[3];
      if (table.writeFrom(riders, COLLAPSED, 0)) changed = true;
    }
  }
  for (let car = 0; car < poses.couplingCount; car += 1) {
    for (let half = 0; half < 2; half += 1) {
      const slot = table.slotFor(objectId, coasterCouplingSlotKey(car, half));
      if (table.writeFrom(slot, poses.couplings, (2 * car + half) * COASTER_CAR_POSE_FLOATS)) changed = true;
    }
  }
  return changed;
};
