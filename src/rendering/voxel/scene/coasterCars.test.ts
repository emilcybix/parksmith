import { describe, expect, it } from 'vitest';
import {
  centreLineFor,
  centreLineIndexToDistance,
  COASTER_LEVEL_TILES,
  createCentreLineSample,
  sampleCentreLine,
} from '../../../game/coaster/centreLine';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { deriveCoasterStats, validateCoasterLayout } from '../../../game/coaster/design';
import type { CoasterPiece } from '../../../game/coaster/design';
import { hillDipLayout, layoutFromMoves, OVAL_HEIGHTS, OVAL_MOVES, zigzagLayout } from '../../../game/coaster/testLayouts';
import { GAME_CONFIG } from '../../../game/config';
import { ParkSession } from '../../../game/session/ParkSession';
import { seedDevPark } from '../../../game/session/devPark';
import { coasterHeadIndex } from '../../coasterTrain';
import type { CoasterTimingRecord } from '../../coasterTrain';
import { TRANSFORM_FLOATS } from '../contracts/boxes';
import { coasterCarSlotKey, coasterCouplingSlotKey, coasterRiderSlotKey, COLLAPSED_PART_QUATERNION } from '../contracts/rigid';
import { BOX_FLOATS } from '../contracts/boxes';
import { coasterContent } from '../content/coaster';
import { compileBlueprint } from '../blueprint/compile';
import { buildPalette } from '../palette';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import {
  COASTER_CAR_POSE_FLOATS,
  COASTER_CAR_SPACING_UNITS,
  coasterIndexToDistance,
  coasterRailTopZ,
  coasterTrackFor,
  createCoasterCarPoses,
  createCoasterTrack,
  createCoasterTrackPoint,
  placeCarsOnTrack,
  placeCoasterCars,
  sampleCoasterTrack,
  writeCoasterCarTransforms,
} from './coasterCars';
import type { CoasterCarPoses } from './coasterCars';
import { createTransformTable } from './rigid';

/**
 * Coaster cars are rigid transforms on the smooth centre line (game/coaster/centreLine.ts), so this
 * file checks them against that line and against the track geometry the design states, not against
 * the module's own maths:
 * - every car sits on the centre line at the arc length the head index and the coupling distance say,
 *   points along its tangent, and is never rolled; the train is at every piece centre at the head
 *   index of that piece, and never moves backwards, jumps at a cycle start or end, or kinks in a lap;
 * - through a loop the cars run in to the ring base, once around a vertical ring of radius 16 and
 *   out again, pitching a full turn;
 * - the placement API (cache, pose buffer, transform slots) behaves as the scene relies on.
 */

type Vector = readonly [number, number, number];
type Quaternion = readonly [number, number, number, number];

const PARKED = GAME_CONFIG.coaster.stationLength - 1;
const LOAD = GAME_CONFIG.coaster.stationLoadSeconds;
const CHASER = COASTER_TYPE_BY_ID.get('star-chaser');
/** The coupling distance in voxels (0.62 of a 32-voxel tile). */
const SPACING_VOXELS = COASTER_CAR_SPACING_UNITS * 32;

type TestCoaster = CoasterTimingRecord;

const devParkCoaster = (): TestCoaster => {
  const session = new ParkSession(null);
  seedDevPark(session);
  const [record] = session.world.coasters.values();
  if (!record) throw new Error('the dev park lost its coaster');
  return record;
};

const START = { x: 4, y: 4 };

/** The 24-piece oval: a flat station along y = 4 (pieces 0 to 2), a hill, four corners. */
const ovalPieces = (loops: readonly number[]): CoasterPiece[] => layoutFromMoves(
  START,
  OVAL_MOVES,
  OVAL_HEIGHTS,
  Object.fromEntries(loops.map((index) => [index, 'loop' as const])),
);

const timingOf = (pieces: CoasterPiece[]): TestCoaster => {
  if (!CHASER) throw new Error('the star-chaser coaster type went missing');
  expect(validateCoasterLayout(pieces, CHASER), 'the synthetic layout must be buildable').toEqual({ ok: true });
  return { pieces, stats: deriveCoasterStats(pieces, CHASER) };
};

const ovalCoaster = (loops: readonly number[] = []): TestCoaster => timingOf(ovalPieces(loops));

/** gpu/shaders/common.ts vxQuatRotate, in TypeScript. */
const rotate = (q: Quaternion, v: Vector): Vector => {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]);
  const ty = 2 * (q[2] * v[0] - q[0] * v[2]);
  const tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + (q[1] * tz - q[2] * ty),
    v[1] + q[3] * ty + (q[2] * tx - q[0] * tz),
    v[2] + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
};

/** Within `tolerance` voxels on every axis: a car's pivot is the chord midpoint of its bogies, up to the sagitta off the line. */
const expectNear = (actual: Vector, expected: Vector, message: string, tolerance = 0.6): void => {
  for (let axis = 0; axis < 3; axis += 1) {
    expect(Math.abs(actual[axis] - expected[axis]), `${message} (axis ${axis})`).toBeLessThan(tolerance);
  }
};

const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (a: Vector): number => Math.hypot(a[0], a[1], a[2]);

interface CarPose {
  position: Vector;
  rotation: Quaternion;
  /** Car +x, +y (its left) and +z in the world. */
  forward: Vector;
  left: Vector;
  up: Vector;
}

const carPose = (poses: CoasterCarPoses, car: number): CarPose => {
  const at = car * COASTER_CAR_POSE_FLOATS;
  const data = poses.data;
  const rotation: Quaternion = [data[at + 3], data[at + 4], data[at + 5], data[at + 6]];
  return {
    position: [data[at], data[at + 1], data[at + 2]],
    rotation,
    forward: rotate(rotation, [1, 0, 0]),
    left: rotate(rotation, [0, 1, 0]),
    up: rotate(rotation, [0, 0, 1]),
  };
};

const trainAt = (coaster: TestCoaster, headIndex: number, cars: number): CarPose[] => {
  const poses = createCoasterCarPoses(cars);
  placeCoasterCars(coaster, headIndex, cars, poses);
  expect(poses.count).toBe(cars);
  return Array.from({ length: cars }, (_unused, car) => carPose(poses, car));
};

const expectVector = (actual: Vector, expected: Vector, message: string, digits = 3): void => {
  for (let axis = 0; axis < 3; axis += 1) expect(actual[axis], `${message} (axis ${axis})`).toBeCloseTo(expected[axis], digits);
};

/** The centre line at an arc length, in voxels, written out independently of coasterCars.ts. */
const linePoint = (pieces: readonly CoasterPiece[], distance: number): { position: Vector; tangent: Vector; ring: number } => {
  const sample = sampleCentreLine(centreLineFor(pieces), distance, createCentreLineSample());
  return {
    position: [sample.x * 32, sample.y * 32, sample.z * 13 + 5],
    tangent: [sample.tangentX, sample.tangentY, sample.tangentZ],
    ring: sample.ringAngle,
  };
};

/** Head indices through one whole ride cycle, from the start of the station load to past the end. */
const cycleHeads = (coaster: TestCoaster, stepSeconds: number): number[] => {
  const heads: number[] = [];
  for (let seconds = -LOAD; seconds <= coaster.stats.durationSeconds - LOAD + 0.5; seconds += stepSeconds) {
    heads.push(coasterHeadIndex(coaster, coaster.stats.durationSeconds - LOAD - seconds));
  }
  return heads;
};

describe('coaster track centre line', () => {
  it('puts every piece on its tile at the rail top of its level, at the tile centre or on its arc', () => {
    const coaster = devParkCoaster();
    const track = createCoasterTrack(coaster.pieces);
    expect(track.pieceCount).toBe(16);
    const point = createCoasterTrackPoint();
    coaster.pieces.forEach((piece, index) => {
      sampleCoasterTrack(track, track.centreDistance[index], point);
      expect(point.z, `piece ${index} at the rail top of level ${piece.height}`).toBeCloseTo(13 * piece.height + 5, 9);
      expect(point.piece).toBe(index);
      const inside = point.x >= piece.cell.x * 32 && point.x <= (piece.cell.x + 1) * 32
        && point.y >= piece.cell.y * 32 && point.y <= (piece.cell.y + 1) * 32;
      expect(inside, `piece ${index} stays in its tile`).toBe(true);
      if (track.turn[index] === 0) {
        // A straight piece: exactly the cell centre.
        expect([point.x, point.y]).toEqual([piece.cell.x * 32 + 16, piece.cell.y * 32 + 16]);
      }
    });
    expect([coasterRailTopZ(0), coasterRailTopZ(1), coasterRailTopZ(2)], 'art bible: rail top 13L + 5').toEqual([5, 18, 31]);
    const looped = createCoasterTrack(ovalPieces([5]));
    expect(looped.loop[5], 'a loop carries a ring').toBe(1);
    expect(looped.totalLength - createCoasterTrack(ovalPieces([])).totalLength).toBeCloseTo(Math.PI, 10);
  });
});

describe('coaster cars on the centre line', () => {
  it('parks the train at the end of the station, level and facing along it', () => {
    const coaster = ovalCoaster();
    const cars = trainAt(coaster, coasterHeadIndex(coaster, null), 4);
    const [lead] = cars;
    expectNear(lead.position, [6 * 32 + 16, 4 * 32 + 16, 5], 'lead car at the end of the station');
    expectVector(lead.forward, [1, 0, 0], 'facing along the station (+x), the chord a hair off where the line starts to rise', 1);
    expectVector(lead.left, [0, 1, 0], 'left is +y', 3);
    expectVector(lead.up, [0, 0, 1], 'wheels down', 1);
    for (let car = 1; car < 3; car += 1) {
      expectVector(cars[car].position, [lead.position[0] - car * SPACING_VOXELS, lead.position[1], 5], `car ${car} on the station`);
    }
    // Car 3 has rolled back onto the corner that leads into the station: on the arc, heading round it.
    const corner = linePoint(coaster.pieces, centreLineIndexToDistance(createCoasterTrack(coaster.pieces), PARKED) - 3 * COASTER_CAR_SPACING_UNITS);
    expectNear(cars[3].position, corner.position, 'car 3 on the corner');
  });

  it('keeps every car on the centre line, 0.62 tiles of arc behind the car ahead, through a whole ride', () => {
    for (const coaster of [ovalCoaster(), timingOf(zigzagLayout(START)), timingOf(hillDipLayout(START))]) {
      const track = createCoasterTrack(coaster.pieces);
      for (const head of cycleHeads(coaster, 0.05)) {
        const headDistance = centreLineIndexToDistance(track, head);
        trainAt(coaster, head, 5).forEach((car, index) => {
          const expected = linePoint(coaster.pieces, headDistance - index * COASTER_CAR_SPACING_UNITS);
          expectNear(car.position, expected.position, `car ${index} at head ${head}`);
          // The car points along the tangent of the line under it (a unit vector in voxel space too).
          expect(dot(car.forward, expected.tangent), `car ${index} heading at head ${head}`).toBeGreaterThan(0.995);
        });
      }
    }
  });

  it('is at every piece centre exactly when the cell-based head index says: gameplay timing is unchanged', () => {
    const coaster = ovalCoaster();
    const track = createCoasterTrack(coaster.pieces);
    for (let index = 0; index < coaster.pieces.length; index += 1) {
      const [lead] = trainAt(coaster, index, 1);
      const expected = linePoint(coaster.pieces, track.centreDistance[index]);
      expectNear(lead.position, expected.position, `piece ${index} centre`);
      // Half way between two piece centres the lead car is half way along that segment's arc.
      const half = linePoint(coaster.pieces, (track.centreDistance[index] + track.centreDistance[index + 1]) / 2);
      expectNear(trainAt(coaster, index + 0.5, 1)[0].position, half.position, `half way past piece ${index}`);
    }
  });

  it('never moves backwards, and ends a cycle where it started: no pop at the cycle start or end', () => {
    for (const coaster of [ovalCoaster(), ovalCoaster([5, 14]), timingOf(zigzagLayout(START))]) {
      const track = createCoasterTrack(coaster.pieces);
      const count = coaster.pieces.length;
      // The lead car's unwrapped arc length (laps counted) never decreases through the cycle, and the
      // cycle is exactly one lap of the circuit: the head index goes round once.
      let previous = -Infinity;
      let previousHead = -Infinity;
      let firstDistance = 0;
      let lastDistance = 0;
      for (const [step, rawHead] of cycleHeads(coaster, 0.02).entries()) {
        // coasterHeadIndex returns to the parked index when the cycle ends: one lap further on.
        const head = rawHead === PARKED && previousHead > PARKED + 1 ? PARKED + count : rawHead;
        previousHead = head;
        const distance = centreLineIndexToDistance(track, head) + Math.floor(head / count) * track.totalLength;
        expect(distance, `the lead car moved backwards at head ${head}`).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = distance;
        if (step === 0) firstDistance = distance;
        lastDistance = distance;
      }
      expect(lastDistance - firstDistance, 'one lap of arc length per cycle').toBeCloseTo(track.totalLength, 9);
      const start = trainAt(coaster, coasterHeadIndex(coaster, coaster.stats.durationSeconds), 5);
      const end = trainAt(coaster, coasterHeadIndex(coaster, 0), 5);
      const parked = trainAt(coaster, coasterHeadIndex(coaster, null), 5);
      start.forEach((car, index) => {
        expectVector(car.position, parked[index].position, `car ${index}: cycle start is the parked train`, 6);
        // The stats round the cycle to 0.1 s, so the head stops up to 0.05 s of travel (at most ~4 voxels
        // at cruise speed) short of the parked position when the cycle clock reaches 0: the same
        // as before the centre line, and far below a visible pop.
        expect(length(minus(end[index].position, parked[index].position)), `car ${index}: cycle end is the parked train`).toBeLessThan(4);
        expect(dot(end[index].forward, parked[index].forward), `car ${index}: heading at the cycle end`).toBeGreaterThan(0.95);
      });
      // The unwrapped head index only ever advances.
      let last = -Infinity;
      for (const head of cycleHeads(coaster, 0.05)) {
        // The cycle's end returns to the parked index (a lap on): not a step back.
        if (!(head === PARKED && last > PARKED + 1)) expect(head).toBeGreaterThanOrEqual(last - 1e-12);
        last = head;
      }
    }
  });

  it('yaws each car along the line, banks it no more than the track, and pitches it with the slope under it', () => {
    for (const coaster of [ovalCoaster(), timingOf(zigzagLayout(START))]) {
      for (const head of cycleHeads(coaster, 0.03)) {
        for (const car of trainAt(coaster, head, 5)) {
          expect(Math.hypot(...car.rotation), 'unit quaternion').toBeCloseTo(1, 6);
          expect(Math.abs(car.left[2]), 'banked at most like the track (0.45 rad) plus the chord').toBeLessThan(Math.sin(0.55));
          // Its nose-up angle is at most the steepest ramp of a layout (1 level in ~0.8 tile, eased: 1.5×);
          // banking tips the up axis further by at most the track's bank.
          expect(car.up[2], 'at most a ramp\'s pitch').toBeGreaterThan(Math.cos(Math.atan(1.7 * COASTER_LEVEL_TILES * 2) + 0.55));
        }
      }
    }
  });
});

describe('coaster cars through a loop', () => {
  /** The ring of the loop on piece `loop`: base M (its exit edge), the running-surface circle. */
  const ringOf = (coaster: TestCoaster, loop: number) => {
    const track = createCoasterTrack(coaster.pieces);
    const start = track.tileStart[loop] + track.tileLength[loop];
    const base = linePoint(coaster.pieces, start).position;
    return { track, start, base, centre: [base[0], base[1], base[2] + 16] as Vector };
  };

  it('runs in to the ring base, once around a vertical ring of radius 16 and out again', () => {
    const coaster = ovalCoaster([5]);
    const { track, start, base, centre } = ringOf(coaster, 5);
    expect(track.loop[5]).toBe(1);
    const ringEnd = track.tileStart[6];
    expect(ringEnd - start).toBeCloseTo(Math.PI, 10);
    let around = 0;
    for (let step = 0; step <= 400; step += 1) {
      const distance = start + ((ringEnd - start) * step) / 400;
      // Put the lead car at this arc length: head index of the matching fraction of the segment.
      const segmentStart = track.centreDistance[5];
      const segmentEnd = track.centreDistance[6];
      const head = 5 + (distance - segmentStart) / (segmentEnd - segmentStart);
      const [car] = trainAt(coaster, head, 1);
      expect(Math.abs(length(minus(car.position, centre)) - 16), `step ${step}: on the ring (the chord midpoint sits a sagitta inside)`).toBeLessThan(0.4);
      expect(car.position[1], `step ${step}: in the vertical plane of travel`).toBeCloseTo(base[1], 3);
      if (step > 0 && step < 400) {
        const inward = minus(centre, car.position);
        expectVector(car.up, [inward[0] / 16, inward[1] / 16, inward[2] / 16], `step ${step}: wheels on the running surface`, 1);
        around += 1;
      }
      expectVector(car.left, [0, 1, 0], `step ${step}: the yaw never changes in a straight loop`, 5);
    }
    expect(around).toBe(399);
    const [before] = trainAt(coaster, 5.01, 1);
    expect(before.position[0], 'running in toward the ring base').toBeLessThan(base[0]);
    expectVector(before.up, [0, 0, 1], 'level on the run-in', 5);
  });

  it('pitches the car nose-up through one full turn, upside down over the top', () => {
    const coaster = ovalCoaster([5]);
    const { track, start } = ringOf(coaster, 5);
    const at = (fraction: number): CarPose => {
      const distance = start + Math.PI * fraction;
      const head = 5 + (distance - track.centreDistance[5]) / (track.centreDistance[6] - track.centreDistance[5]);
      return trainAt(coaster, head, 1)[0];
    };
    let previous = Math.atan2(at(0).forward[2], at(0).forward[0]);
    let turned = 0;
    for (let step = 1; step <= 1_000; step += 1) {
      const car = at(step / 1_000);
      const angle = Math.atan2(car.forward[2], car.forward[0]);
      let delta = angle - previous;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      expect(delta, `the pitch only ever advances (step ${step})`).toBeGreaterThanOrEqual(-1e-6);
      turned += delta;
      previous = angle;
    }
    expect(turned, 'once around the ring').toBeCloseTo(2 * Math.PI, 0);
    expectVector(at(0.5).up, [0, 0, -1], 'upside down at the top', 5);
    expectVector(at(0.5).forward, [-1, 0, 0], 'running backwards over the top', 5);
    expectVector(at(0.25).forward, [0, 0, 1], 'nose straight up a quarter of the way round', 5);
  });

  it('puts the ring base at the rail top of the exit edge, climbing or flat', () => {
    // Piece 3 climbs from level 1 toward 2: the ring stands on the line where it crosses the edge.
    const coaster = ovalCoaster([3]);
    const { base } = ringOf(coaster, 3);
    expect(base[2], 'between the heights of pieces 3 and 4').toBeGreaterThan(18);
    expect(base[2]).toBeLessThan(31);
    const [climbing] = trainAt(coaster, 3.9, 1);
    expect(climbing.left[2], 'a climb never rolls the car').toBeCloseTo(0, 2);
  });

  it('turns out of a loop into the corner without a pop: heading and position stay continuous', () => {
    // Loop on piece 6, followed by a straight, the corner at piece 8.
    const coaster = ovalCoaster([6]);
    let previous = trainAt(coaster, 5.5, 4);
    for (let head = 5.5 + 0.002; head < 9.5; head += 0.002) {
      const cars = trainAt(coaster, head, 4);
      cars.forEach((car, index) => {
        const was = previous[index];
        expect(length(minus(car.position, was.position)), `car ${index} moved too far at head ${head}`).toBeLessThan(1.5);
        expect(Math.min(dot(car.forward, was.forward), dot(car.up, was.up)), `car ${index} turned too far at head ${head}`)
          .toBeGreaterThan(Math.cos((6 * Math.PI) / 180));
      });
      previous = cars;
    }
  });
});

describe('coaster train continuity', () => {
  it.each([['the dev park', null], ['an oval', []], ['a loop oval', [5, 14]]] as const)(
    'closes the lap without a jump on %s',
    (_name, loops) => {
      const coaster = loops === null ? devParkCoaster() : ovalCoaster(loops);
      const count = coaster.pieces.length;
      let previous = trainAt(coaster, PARKED, 5);
      for (let head = PARKED + 0.004; head <= PARKED + count + 1; head += 0.004) {
        const cars = trainAt(coaster, head, 5);
        cars.forEach((car, index) => {
          const was = previous[index];
          // A segment is at most ~1.1 tiles for 0.004 of an index (loop segments 4), so well under 2 voxels.
          expect(length(minus(car.position, was.position)), `car ${index} moved too far at head ${head}`).toBeLessThan(2);
          const turn = Math.min(dot(car.forward, was.forward), dot(car.up, was.up));
          expect(turn, `car ${index} turned too far at head ${head}`).toBeGreaterThan(Math.cos((6 * Math.PI) / 180));
        });
        previous = cars;
      }
      // An unwrapped head a lap later is the same train.
      trainAt(coaster, PARKED + count + 0.37, 5).forEach((car, index) => {
        const same = trainAt(coaster, PARKED + 0.37, 5)[index];
        expectNear(car.position, same.position, `car ${index} a lap later`, 0.01);
        expectVector(car.forward, same.forward, `car ${index} heading a lap later`, 5);
      });
    },
  );
});

describe('coaster car placement API', () => {
  it('caches the track per layout and reuses the pose buffer once it is large enough', () => {
    const coaster = devParkCoaster();
    const track = coasterTrackFor(coaster);
    expect(coasterTrackFor(coaster), 'cached per record').toBe(track);
    expect(coasterTrackFor({ pieces: coaster.pieces }), 'keyed by the layout itself').toBe(track);

    const poses = createCoasterCarPoses(2);
    placeCoasterCars(coaster, 7.3, 5, poses);
    expect(poses.count).toBe(5);
    expect(poses.data.length, 'grown to fit the train').toBeGreaterThanOrEqual(5 * COASTER_CAR_POSE_FLOATS);
    const data = poses.data;
    placeCoasterCars(coaster, 8.1, 5, poses);
    expect(poses.data, 'a warm buffer is reused').toBe(data);
    placeCoasterCars(coaster, 8.1, 3, poses);
    expect(poses.data).toBe(data);
    expect(poses.count).toBe(3);

    const explicit = createCoasterCarPoses(3);
    placeCarsOnTrack(createCoasterTrack(coaster.pieces), 8.1, 3, explicit);
    expect(Array.from(explicit.data.subarray(0, 21)), 'the cache changes nothing').toEqual(Array.from(poses.data.subarray(0, 21)));

    const growing = [...coaster.pieces];
    const before = coasterTrackFor({ pieces: growing });
    growing.push({ cell: { x: 6, y: 8 }, height: 0 });
    expect(coasterTrackFor({ pieces: growing }).pieceCount, 'a layout that changed length is rebuilt').toBe(before.pieceCount + 1);
    growing[3] = { ...growing[3], height: 3 };
    expect(coasterTrackFor({ pieces: growing }).nodeHeight[3], 'a layout edited in place is rebuilt').toBe(3);
  });

  it('samples the same centre line the cars ride on, wrapping any distance onto the circuit', () => {
    const coaster = ovalCoaster([4, 6]);
    const track = coasterTrackFor(coaster);
    const total = track.totalLength;
    const point = createCoasterTrackPoint();
    for (let step = -200; step <= 1_200; step += 1) {
      const distance = (step / 1_000) * total * 1.37;
      expect(sampleCoasterTrack(track, distance, point), 'fills and returns the given point').toBe(point);
      const wrapped = ((distance % total) + total) % total;
      const expected = linePoint(coaster.pieces, wrapped);
      expectVector([point.x, point.y, point.z], expected.position, `distance ${distance}`, 6);
      expect(point.ringAngle, `ring angle at ${distance}`).toBeCloseTo(expected.ring, 9);
      expect(point.distance, 'stored wrapped').toBeGreaterThanOrEqual(0);
      expect(point.distance).toBeLessThan(total);
      expect(point.distance).toBeCloseTo(wrapped, 9);
    }
    for (let index = -3; index <= 45; index += 0.25) {
      expect(coasterIndexToDistance(track, index), `index ${index}`).toBeCloseTo(centreLineIndexToDistance(track, index), 12);
    }
    expect(coasterIndexToDistance(track, Number.POSITIVE_INFINITY), 'a non-finite index is the start').toBe(0);
    sampleCoasterTrack(track, Number.NaN, point);
    expect([point.distance, point.piece], 'a non-finite distance samples the start').toEqual([0, 0]);
    sampleCoasterTrack(createCoasterTrack([]), 12, point);
    expect([point.x, point.y, point.z, point.pitch, point.distance], 'an empty layout samples the origin (at ground level)').toEqual([0, 0, 5, 0, 0]);
    expect(coasterIndexToDistance(createCoasterTrack([]), 3)).toBe(0);
  });

  it('places nothing for an empty train or layout and survives a non-finite head', () => {
    const coaster = devParkCoaster();
    const poses = createCoasterCarPoses(4);
    placeCoasterCars(coaster, 4, 0, poses);
    expect(poses.count).toBe(0);
    placeCoasterCars(coaster, 4, Number.NaN, poses);
    expect(poses.count).toBe(0);
    placeCoasterCars({ pieces: [] }, 4, 4, poses);
    expect(poses.count).toBe(0);
    placeCoasterCars(coaster, Number.NaN, 2, poses);
    expect(poses.count).toBe(2);
    expect(Array.from(poses.data.subarray(0, 14)).every(Number.isFinite), 'no NaN reaches the GPU').toBe(true);
    expectNear(carPose(poses, 0).position, linePoint(coaster.pieces, 0).position, 'a broken head index parks at the start of the line');
  });
});

describe('coaster cars in the transform table', () => {
  it('copies every car into its own slot, keyed by coasterCarSlotKey, and dirties nothing while parked', () => {
    const coaster = devParkCoaster();
    const table = createTransformTable();
    const rideSlot = table.slotFor(3, 1);
    const poses = createCoasterCarPoses(5);
    placeCoasterCars(coaster, coasterHeadIndex(coaster, null), 5, poses);
    expect(writeCoasterCarTransforms(table, 7, poses), 'the first write places the train').toBe(true);
    const slots = Array.from({ length: 5 }, (_unused, car) => table.slotFor(7, coasterCarSlotKey(car)));
    // Per car, in order: the car, then its riders; the couplings follow once all cars have slots.
    expect(slots, 'dense slots after the ride part already in the table').toEqual([2, 4, 6, 8, 10]);
    expect(table.slotFor(3, 1)).toBe(rideSlot);
    slots.forEach((slot, car) => {
      const at = (slot - 1) * TRANSFORM_FLOATS;
      const record = Array.from(table.data.subarray(at, at + TRANSFORM_FLOATS));
      const pose = Array.from(poses.data.subarray(car * COASTER_CAR_POSE_FLOATS, (car + 1) * COASTER_CAR_POSE_FLOATS));
      expect(record, `car ${car}: pivot, spare 0, quaternion`).toEqual([pose[0], pose[1], pose[2], 0, pose[3], pose[4], pose[5], pose[6]]);
    });

    table.clearDirty();
    placeCoasterCars(coaster, coasterHeadIndex(coaster, null), 5, poses);
    expect(writeCoasterCarTransforms(table, 7, poses), 'a parked train changes nothing').toBe(false);
    expect(table.dirtyRowStart, 'and uploads nothing').toBe(table.dirtyRowEnd);

    placeCoasterCars(coaster, PARKED + 2.5, 5, poses);
    expect(writeCoasterCarTransforms(table, 7, poses), 'a moving train is rewritten').toBe(true);
    expect([table.dirtyRowStart, table.dirtyRowEnd]).toEqual([0, 1]);
    expect(table.highestSlot, 'no new slots for a known train: 5 cars, 5 rider parts, 4 couplings of two halves, the ride part').toBe(19);

    table.releaseObject(7);
    expect(table.highestSlot, 'bulldozing the coaster frees its cars').toBe(1);
  });
});

describe('coaster car pitch on slopes', () => {
  it('has no kink: the pitch moves smoothly along the whole lap and is flat on the station', () => {
    for (const coaster of [devParkCoaster(), ovalCoaster(), timingOf(hillDipLayout(START))]) {
      const track = coasterTrackFor(coaster);
      const point = createCoasterTrackPoint();
      let previous = 0;
      for (let at = 0; at <= track.totalLength; at += 0.002) {
        sampleCoasterTrack(track, at, point);
        if (at > 0) expect(Math.abs(point.pitch - previous), `pitch jump at ${at}`).toBeLessThan(0.02);
        previous = point.pitch;
      }
      // The station is level (pieces 0 to 2 at ground): flat there.
      sampleCoasterTrack(track, track.centreDistance[1], point);
      expect(point.pitch).toBe(0);
    }
  });

  it('climbs nose-up, descends nose-down and is flat at crests and dips', () => {
    const coaster = ovalCoaster();
    const track = coasterTrackFor(coaster);
    const point = createCoasterTrackPoint();
    coaster.pieces.forEach((piece, index) => {
      const before = coaster.pieces[(index + coaster.pieces.length - 1) % coaster.pieces.length].height;
      const next = coaster.pieces[(index + 1) % coaster.pieces.length].height;
      sampleCoasterTrack(track, track.centreDistance[index], point);
      if (piece.height >= Math.max(before, next) || piece.height <= Math.min(before, next)) {
        expect(point.pitch, `crest, dip or flat at piece ${index}`).toBe(0);
      } else {
        expect(Math.sign(point.pitch), `slope at piece ${index}`).toBe(Math.sign(next - before));
      }
      expect(point.z).toBeCloseTo(13 * piece.height + 5, 9);
    });
  });
});

/** The vertex shader's vxQuatRotate and vxProject (gpu/shaders/common.ts) with every operation rounded to float32. */
const f = Math.fround;
const gpuProjectX = (pivot: Vector, q: Quaternion, local: Vector): number => {
  const tx = f(2 * f(f(q[1] * local[2]) - f(q[2] * local[1])));
  const ty = f(2 * f(f(q[2] * local[0]) - f(q[0] * local[2])));
  const tz = f(2 * f(f(q[0] * local[1]) - f(q[1] * local[0])));
  const rx = f(f(local[0] + f(q[3] * tx)) + f(f(q[1] * tz) - f(q[2] * ty)));
  const ry = f(f(local[1] + f(q[3] * ty)) + f(f(q[2] * tx) - f(q[0] * tz)));
  return f(f(pivot[0] + rx) - f(pivot[1] + ry));
};

describe('coaster riders, couplings and the collapse pose', () => {
  const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

  it('collapses every rider box of every car onto one screen column, exactly, at any whole-voxel pivot', () => {
    for (const id of ['comet-trail', 'star-chaser', 'skyline-serpent']) {
      const definition = BUILD_BY_ID.get(id)!;
      const cars = COASTER_TYPE_BY_ID.get(id)!.trainCars;
      for (let car = 0; car < cars; car += 1) {
        const part = compileBlueprint(coasterContent.riderBlueprint(definition, car, palette)).parts[0];
        for (const pivot of [[0, 0, 5], [166, 297, 83], [415, 23, 32], [1023, 1023, 100]] as Vector[]) {
          const columns = new Set<number>();
          for (let box = 0; box < part.boxCount; box += 1) {
            const at = box * BOX_FLOATS;
            for (const dx of [0, part.boxes[at + 4]]) {
              for (const dy of [0, part.boxes[at + 5]]) {
                for (const dz of [0, part.boxes[at + 6]]) {
                  const local: Vector = [part.boxes[at] + dx, part.boxes[at + 1] + dy, part.boxes[at + 2] + dz];
                  columns.add(gpuProjectX(pivot, COLLAPSED_PART_QUATERNION, local));
                }
              }
            }
          }
          expect([...columns], `${id} car ${car} at ${pivot}: one screen x for every corner`).toEqual([pivot[0] - pivot[1]]);
        }
      }
    }
  });

  it('writes each car, its riders and its coupling into their own slots; riders take the car pose only when loaded', () => {
    const coaster = devParkCoaster();
    const table = createTransformTable();
    const poses = createCoasterCarPoses(5);
    placeCoasterCars(coaster, PARKED + 3.3, 5, poses);
    expect(poses.couplingCount, 'one coupling between each pair').toBe(4);
    writeCoasterCarTransforms(table, 7, poses, 2);
    const record = (key: number): number[] => {
      const at = (table.slotFor(7, key) - 1) * TRANSFORM_FLOATS;
      return Array.from(table.data.subarray(at, at + TRANSFORM_FLOATS));
    };
    for (let car = 0; car < 5; car += 1) {
      const car7 = Array.from(poses.data.subarray(car * 7, car * 7 + 7));
      expect(record(coasterCarSlotKey(car))).toEqual([car7[0], car7[1], car7[2], 0, car7[3], car7[4], car7[5], car7[6]]);
      if (car < 2) expect(record(coasterRiderSlotKey(car)), `car ${car} is loaded: riders ride with it`).toEqual(record(coasterCarSlotKey(car)));
      else {
        const riders = record(coasterRiderSlotKey(car));
        expect(riders.slice(4), `car ${car} is empty: collapsed`).toEqual([...COLLAPSED_PART_QUATERNION]);
        expect(riders.slice(0, 3), 'at whole voxels').toEqual(car7.slice(0, 3).map(Math.round));
      }
    }
    for (let car = 0; car < 4; car += 1) {
      const a = Array.from(poses.data.subarray(car * 7, car * 7 + 3));
      const b = Array.from(poses.data.subarray((car + 1) * 7, (car + 1) * 7 + 3));
      const apart = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      // Each half hangs on its own car's hitch: half 0 near car k, half 1 near car k + 1, both between them.
      for (const [half, own, other] of [[0, a, b], [1, b, a]] as const) {
        const rec = record(coasterCouplingSlotKey(car, half));
        const to = (p: readonly number[]): number => Math.hypot(rec[0] - p[0], rec[1] - p[1], rec[2] - p[2]);
        expect(to(own), `coupling ${car} half ${half} at its own car's hitch`).toBeLessThan(6);
        expect(to(other)).toBeLessThan(apart);
      }
    }
    table.clearDirty();
    placeCoasterCars(coaster, PARKED + 3.3, 5, poses);
    expect(writeCoasterCarTransforms(table, 7, poses, 2), 'an unchanged train and load dirty nothing').toBe(false);
    expect(writeCoasterCarTransforms(table, 7, poses, 0), 'a train that empties changes its rider slots').toBe(true);
    table.clearDirty();
    expect(writeCoasterCarTransforms(table, 7, poses, 0), 'and then stays clean').toBe(false);
  });

  it('allocates nothing per frame: 100 000 placements and writes leave the heap flat', async () => {
    // The test runner does not expose gc(): switch it on for this process, as node's own flag does.
    // @ts-expect-error node builtins are not in the browser tsconfig's types
    const v8 = await import('node:v8');
    // @ts-expect-error node builtins are not in the browser tsconfig's types
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose-gc');
    const collect = vm.runInNewContext('gc') as () => void;
    const heap = (): number => {
      collect();
      return (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;
    };
    const coaster = devParkCoaster();
    const table = createTransformTable();
    const poses = createCoasterCarPoses(6);
    const track = coasterTrackFor(coaster);
    const run = (frames: number): void => {
      for (let step = 0; step < frames; step += 1) {
        placeCarsOnTrack(track, 4 + step * 0.001, 6, poses);
        writeCoasterCarTransforms(table, 7, poses, 3);
      }
    };
    run(20_000);
    const before = heap();
    run(100_000);
    const grown = heap() - before;
    // A boxed double per car per frame would be 10+ MB here.
    expect(grown, 'heap growth over 100 000 frames').toBeLessThan(500_000);
  });
});
