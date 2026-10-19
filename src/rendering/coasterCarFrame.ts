import {
  COASTER_LEVEL_TILES,
  createCentreLineFrame,
  createCentreLineSample,
  resampleCentreLine,
  resampleCentreLineFrame,
} from '../game/coaster/centreLine';
import type { CentreLine } from '../game/coaster/centreLine';
import type { RideStatus } from '../game/rides/types';

/**
 * Where a coaster car sits and how it is turned, renderer-agnostic (Phase 27 step 3): the voxel cars
 * (rigid parts) and the classic cars (pooled graphics) both read the same frame, so a car is in the
 * same spot in both views. Pure, allocation-free, no Pixi and no voxel imports.
 *
 * A car is placed by its BOGIES, not by the tangent at its centre: the two bogie points sit
 * `COASTER_CAR_BOGIE_TILES` of arc ahead of and behind the car's centre on the centre line, the
 * pivot is the midpoint of the chord between them and the car's forward axis is that chord, so a
 * car on a corner or a ring spans the curve like a real one (its pivot is off the line by only the
 * sagitta, under half a voxel). Its up axis is the cross-section frame's B′ at the centre
 * (`resampleCentreLineFrame`: the banking is already in it, and on a ring it points to the ring's
 * centre), made orthogonal to the forward axis. Yaw, pitch and roll all come out of one orthonormal
 * basis, so nothing here is a special case for a ring or tied to a fixed heading (Phase 26).
 *
 * Timing is untouched: car k's centre is `COASTER_CAR_SPACING_TILES · k` of arc behind the head.
 */

/** Arc length, in tiles, between neighbouring cars' centres (gameplay-neutral visual constant). */
export const COASTER_CAR_SPACING_TILES = 0.62;
/** Bogie points: ± this arc (tiles) from the car's centre. 3 voxels. */
export const COASTER_CAR_BOGIE_TILES = 3 / 32;
/** Hitch points on the car axis: ± this (tiles) from the pivot. */
export const COASTER_CAR_HITCH_TILES = 4 / 32;
/** Hitch height (tiles) above the rail top, along the car's up axis: the chassis' mid height. */
export const COASTER_CAR_HITCH_UP_TILES = 2 / 32;

export interface CoasterCarFrame {
  /** Pivot on the rail top: x, y in tiles, z in levels (centre-line units). */
  x: number;
  y: number;
  z: number;
  /** Orthonormal basis in tile units: car +x (travel), +y (left), +z (up, rolled; toward the centre on a ring). */
  forwardX: number;
  forwardY: number;
  forwardZ: number;
  leftX: number;
  leftY: number;
  leftZ: number;
  upX: number;
  upY: number;
  upZ: number;
  /** Banking at the car's centre (centreLineRollAt), radians. */
  roll: number;
  /** Arc length of the car's centre, wrapped. Set it (before the call) to place a car with `resampleCoasterCarFrame`. */
  distance: number;
}

export const createCoasterCarFrame = (): CoasterCarFrame => ({
  x: 0, y: 0, z: 0,
  forwardX: 1, forwardY: 0, forwardZ: 0,
  leftX: 0, leftY: 1, leftZ: 0,
  upX: 0, upY: 0, upZ: 1,
  roll: 0,
  distance: 0,
});

const FRAME = createCentreLineFrame();
const SAMPLE = createCentreLineSample();

/**
 * `coasterCarFrame` for a hot loop: the car centre's arc length comes in through `out.distance`
 * (V8 boxes a double that crosses a call it did not inline). Allocation-free.
 */
export const resampleCoasterCarFrame = (line: CentreLine, out: CoasterCarFrame): CoasterCarFrame => {
  if (line.pieceCount === 0) {
    out.x = 0; out.y = 0; out.z = 0;
    out.forwardX = 1; out.forwardY = 0; out.forwardZ = 0;
    out.leftX = 0; out.leftY = 1; out.leftZ = 0;
    out.upX = 0; out.upY = 0; out.upZ = 1;
    out.roll = 0;
    out.distance = 0;
    return out;
  }
  const centre = out.distance;
  // The cross-section frame at the car's centre: up (with the banking) and the roll.
  FRAME.distance = centre;
  resampleCentreLineFrame(line, FRAME);
  let upX = FRAME.upX;
  let upY = FRAME.upY;
  let upZ = FRAME.upZ;
  out.roll = FRAME.roll;
  out.distance = FRAME.distance;
  // The bogie chord (tile units on every axis; the line's z is in levels).
  SAMPLE.distance = centre + COASTER_CAR_BOGIE_TILES;
  resampleCentreLine(line, SAMPLE);
  const frontX = SAMPLE.x;
  const frontY = SAMPLE.y;
  const frontZ = SAMPLE.z * COASTER_LEVEL_TILES;
  SAMPLE.distance = centre - COASTER_CAR_BOGIE_TILES;
  resampleCentreLine(line, SAMPLE);
  const rearX = SAMPLE.x;
  const rearY = SAMPLE.y;
  const rearZ = SAMPLE.z * COASTER_LEVEL_TILES;
  out.x = (frontX + rearX) / 2;
  out.y = (frontY + rearY) / 2;
  out.z = (frontZ + rearZ) / 2 / COASTER_LEVEL_TILES;
  let forwardX = frontX - rearX;
  let forwardY = frontY - rearY;
  let forwardZ = frontZ - rearZ;
  let norm = Math.sqrt(forwardX * forwardX + forwardY * forwardY + forwardZ * forwardZ);
  if (norm < 1e-9) {
    // Degenerate chord (cannot happen on a real line): fall back to the tangent at the centre.
    forwardX = FRAME.tangentX;
    forwardY = FRAME.tangentY;
    forwardZ = FRAME.tangentZ;
    norm = 1;
  }
  forwardX /= norm;
  forwardY /= norm;
  forwardZ /= norm;
  // Gram–Schmidt the frame's up against the chord.
  const along = upX * forwardX + upY * forwardY + upZ * forwardZ;
  upX -= along * forwardX;
  upY -= along * forwardY;
  upZ -= along * forwardZ;
  norm = Math.sqrt(upX * upX + upY * upY + upZ * upZ);
  upX /= norm;
  upY /= norm;
  upZ /= norm;
  out.forwardX = forwardX;
  out.forwardY = forwardY;
  out.forwardZ = forwardZ;
  out.upX = upX;
  out.upY = upY;
  out.upZ = upZ;
  // left = up × forward (car +x forward, +y left, +z up is right-handed).
  out.leftX = upY * forwardZ - upZ * forwardY;
  out.leftY = upZ * forwardX - upX * forwardZ;
  out.leftZ = upX * forwardY - upY * forwardX;
  return out;
};

/** Car `carIndex` behind a head at arc length `headDistance` (tiles, unwrapped ok). Allocation-free. */
export const coasterCarFrame = (
  line: CentreLine,
  headDistance: number,
  carIndex: number,
  out: CoasterCarFrame,
): CoasterCarFrame => {
  out.distance = headDistance - carIndex * COASTER_CAR_SPACING_TILES;
  return resampleCoasterCarFrame(line, out);
};

/** The coupling between two neighbouring cars; `length` is the hitch distance in tiles. */
export interface CoasterCouplingFrame extends CoasterCarFrame {
  length: number;
}

export const createCoasterCouplingFrame = (): CoasterCouplingFrame => ({ ...createCoasterCarFrame(), length: 0 });

/**
 * The coupling between `ahead` (car k) and `behind` (car k + 1): its pivot is the midpoint of the
 * two hitches (ahead's rear hitch, behind's front hitch), its forward runs from behind's hitch to
 * ahead's, and its up is the mean of both cars' up axes made orthogonal to that. Also returns the
 * hitch distance (tiles) in `out.length`. Allocation-free.
 */
export const coasterCouplingFrame = (
  ahead: CoasterCarFrame,
  behind: CoasterCarFrame,
  out: CoasterCouplingFrame,
): CoasterCouplingFrame => {
  const h = COASTER_CAR_HITCH_TILES;
  const v = COASTER_CAR_HITCH_UP_TILES;
  // Hitches in tile units (z converted from levels).
  const aheadX = ahead.x - ahead.forwardX * h + ahead.upX * v;
  const aheadY = ahead.y - ahead.forwardY * h + ahead.upY * v;
  const aheadZ = ahead.z * COASTER_LEVEL_TILES - ahead.forwardZ * h + ahead.upZ * v;
  const behindX = behind.x + behind.forwardX * h + behind.upX * v;
  const behindY = behind.y + behind.forwardY * h + behind.upY * v;
  const behindZ = behind.z * COASTER_LEVEL_TILES + behind.forwardZ * h + behind.upZ * v;
  out.x = (aheadX + behindX) / 2;
  out.y = (aheadY + behindY) / 2;
  out.z = (aheadZ + behindZ) / 2 / COASTER_LEVEL_TILES;
  let forwardX = aheadX - behindX;
  let forwardY = aheadY - behindY;
  let forwardZ = aheadZ - behindZ;
  let norm = Math.sqrt(forwardX * forwardX + forwardY * forwardY + forwardZ * forwardZ);
  out.length = norm;
  if (norm < 1e-9) {
    forwardX = ahead.forwardX;
    forwardY = ahead.forwardY;
    forwardZ = ahead.forwardZ;
  } else {
    forwardX /= norm;
    forwardY /= norm;
    forwardZ /= norm;
  }
  let upX = ahead.upX + behind.upX;
  let upY = ahead.upY + behind.upY;
  let upZ = ahead.upZ + behind.upZ;
  const along = upX * forwardX + upY * forwardY + upZ * forwardZ;
  upX -= along * forwardX;
  upY -= along * forwardY;
  upZ -= along * forwardZ;
  norm = Math.sqrt(upX * upX + upY * upY + upZ * upZ);
  if (norm < 1e-9) {
    upX = ahead.upX;
    upY = ahead.upY;
    upZ = ahead.upZ;
  } else {
    upX /= norm;
    upY /= norm;
    upZ /= norm;
  }
  out.forwardX = forwardX;
  out.forwardY = forwardY;
  out.forwardZ = forwardZ;
  out.upX = upX;
  out.upY = upY;
  out.upZ = upZ;
  out.leftX = upY * forwardZ - upZ * forwardY;
  out.leftY = upZ * forwardX - upX * forwardZ;
  out.leftZ = upX * forwardY - upY * forwardX;
  out.roll = (ahead.roll + behind.roll) / 2;
  out.distance = (ahead.distance + behind.distance) / 2;
  return out;
};

/**
 * One half of a coupling (Phase 27 step 3 review fix): a coupling is drawn as TWO rigid half-bars,
 * each hinged at one car's hitch and pointing along the hitch-to-hitch chord toward the other hitch.
 * A single fixed-length bar had to tuck its surplus past a hitch along the chord, and where the two
 * cars differ by about 90 degrees (out of a loop ring into a banked climb) that tucked end left the
 * car below its floor. Two halves of `COASTER_COUPLING_HALF_TILES` each never pass the far hitch (the
 * hitch distance stays above one half: measured 9.45 to 16.5 voxels against a half of 9; Phase 48 lengthened the half
 * from 8, because a loop piece's sideways step runs the cars up to 10% further apart than their arc) and close the
 * gap as long as the hitch distance is under two halves; where they overlap in the middle they lie on
 * the same line. `half` 0 is the ahead car's half (pivot on its rear hitch, +x toward the behind
 * car), 1 the behind car's (pivot on its front hitch, +x toward the ahead car). Allocation-free.
 */
export const COASTER_COUPLING_HALF_TILES = 9 / 32;

export const coasterCouplingHalfFrame = (
  coupling: CoasterCouplingFrame,
  half: number,
  out: CoasterCarFrame,
): CoasterCarFrame => {
  const reach = coupling.length / 2;
  const sign = half === 0 ? 1 : -1;
  out.x = coupling.x + sign * coupling.forwardX * reach;
  out.y = coupling.y + sign * coupling.forwardY * reach;
  out.z = coupling.z + (sign * coupling.forwardZ * reach) / COASTER_LEVEL_TILES;
  // The ahead half points backwards (toward the behind car): forward and left flip, up stays.
  out.forwardX = -sign * coupling.forwardX;
  out.forwardY = -sign * coupling.forwardY;
  out.forwardZ = -sign * coupling.forwardZ;
  out.leftX = -sign * coupling.leftX;
  out.leftY = -sign * coupling.leftY;
  out.leftZ = -sign * coupling.leftZ;
  out.upX = coupling.upX;
  out.upY = coupling.upY;
  out.upZ = coupling.upZ;
  out.roll = coupling.roll;
  out.distance = coupling.distance;
  return out;
};

/** Most riders a car model seats (two rows of two); the renderers clamp to it. */
export const COASTER_MAX_SEATS_PER_CAR = 4;

/**
 * Seats of car `car` in a train of `cars` cars that holds `capacity` riders: the capacity spread over
 * the cars, the front cars taking the remainder (comet 3 3 3 3, star chaser 2 2 2 2 2, serpent
 * 2 2 1 1 1 1). Shown riders follow the real head count with this, not a fixed four per car.
 */
export const coasterCarSeats = (car: number, capacity: number, cars: number): number => {
  if (!(cars >= 1) || !(capacity > 0) || car < 0 || car >= cars) return 0;
  const base = Math.floor(capacity / cars);
  const extra = Math.floor(capacity) - base * Math.floor(cars);
  return Math.min(COASTER_MAX_SEATS_PER_CAR, base + (car < extra ? 1 : 0));
};

/** Index of car `car`'s first seat (seats are numbered front to back). */
export const coasterFirstSeat = (car: number, capacity: number, cars: number): number => {
  if (!(cars >= 1) || !(capacity > 0)) return 0;
  const base = Math.floor(capacity / cars);
  const extra = Math.floor(capacity) - base * Math.floor(cars);
  return car * base + Math.min(car, extra);
};

/**
 * How many cars, front first, show riders: 0 unless the ride is running with someone on board;
 * otherwise the cars whose first seat (`coasterFirstSeat`) is taken when the riders fill the seats
 * front to back. Each shown car shows its own seat count (`coasterCarSeats`), so a full train shows
 * exactly its capacity and a partial one at most one car's seats minus one over the head count (2 on
 * the comet, 1 on the others). It only reads a head count: it never counts anyone as a guest.
 * Allocation-free.
 */
export const coasterLoadedCars = (
  status: RideStatus | undefined,
  riders: number,
  capacity: number,
  cars: number,
): number => {
  if (status !== 'running' || !(riders > 0) || !(cars > 0) || !(capacity > 0)) return 0;
  const whole = Math.floor(cars);
  const seated = Math.min(Math.ceil(riders), Math.floor(capacity));
  let loaded = 0;
  while (loaded < whole && coasterFirstSeat(loaded, capacity, whole) < seated) loaded += 1;
  return loaded;
};
