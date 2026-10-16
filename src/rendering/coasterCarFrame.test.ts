import { describe, expect, it } from 'vitest';
import {
  centreLineIndexToDistance,
  centreLineRollAt,
  COASTER_LEVEL_TILES,
  createCentreLine,
  createCentreLineSample,
  sampleCentreLine,
} from '../game/coaster/centreLine';
import type { CentreLine } from '../game/coaster/centreLine';
import type { CoasterPiece } from '../game/coaster/design';
import { COASTER_TYPES } from '../game/coaster/content';
import { GAME_CONFIG } from '../game/config';
import {
  hillDipLayout,
  longestLayout,
  loopOvalLayout,
  ovalLayout,
  randomCircuit,
  zigzagLayout,
} from '../game/coaster/testLayouts';
import {
  COASTER_CAR_BOGIE_TILES,
  COASTER_CAR_SPACING_TILES,
  coasterCarFrame,
  coasterCouplingFrame,
  coasterCouplingHalfFrame,
  coasterCarSeats,
  coasterFirstSeat,
  coasterLoadedCars,
  COASTER_MAX_SEATS_PER_CAR,
  createCoasterCarFrame,
  createCoasterCouplingFrame,
} from './coasterCarFrame';
import type { CoasterCarFrame } from './coasterCarFrame';
import { COUPLING_HALF_LENGTH } from './voxel/content/coaster';

/**
 * The shared car frame (Phase 27 step 3): bogie chord for the pivot and forward axis, the banked
 * cross-section's up axis, couplings between neighbouring hitches. Checked against the centre line
 * on every fixture layout and on random circuits, never against the module's own maths.
 */
const TILE = 32;

const circuits = (): Array<[string, CoasterPiece[]]> => {
  const list: Array<[string, CoasterPiece[]]> = [
    ['oval', ovalLayout()],
    ['zigzag', zigzagLayout()],
    ['hill-dip', hillDipLayout()],
    ['loop oval', loopOvalLayout()],
    ['longest', longestLayout()],
  ];
  for (let seed = 1; list.length < 65 && seed < 6000; seed += 1) {
    const target = 4 + 2 * (seed % 20);
    const layout = randomCircuit(seed, target, 4 + (seed % 6));
    const straight = layout !== null && layout[1].cell.x - layout[0].cell.x === layout[2].cell.x - layout[1].cell.x
      && layout[1].cell.y - layout[0].cell.y === layout[2].cell.y - layout[1].cell.y;
    if (layout && straight) list.push([`seed ${seed}`, layout]);
  }
  return list;
};

const ALL = circuits();
const lines = new Map<string, CentreLine>(ALL.map(([name, pieces]) => [name, createCentreLine(pieces)]));

/** Walks `steps` head positions around one lap and hands every car's frame (and coupling) to `visit`. */
const walk = (
  line: CentreLine,
  cars: number,
  steps: number,
  visit: (frames: CoasterCarFrame[], head: number) => void,
): void => {
  const frames = Array.from({ length: cars }, createCoasterCarFrame);
  for (let step = 0; step < steps; step += 1) {
    const head = (step / steps) * line.totalLength;
    for (let car = 0; car < cars; car += 1) coasterCarFrame(line, head, car, frames[car]);
    visit(frames, head);
  }
};

type Vec = [number, number, number];
/** A car-local voxel point in world voxels (z in voxels, level = 13). */
const world = (frame: CoasterCarFrame, x: number, y: number, z: number): Vec => [
  frame.x * TILE + x * frame.forwardX + y * frame.leftX + z * frame.upX,
  frame.y * TILE + x * frame.forwardY + y * frame.leftY + z * frame.upY,
  frame.z * COASTER_LEVEL_TILES * TILE + x * frame.forwardZ + y * frame.leftZ + z * frame.upZ,
];
const distance = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('car frame', () => {
  it('puts the pivot within half a voxel of the centre line and both bogies on it, for every car', () => {
    const sample = createCentreLineSample();
    let worst = 0;
    for (const [name, pieces] of ALL) {
      const line = lines.get(name)!;
      expect(pieces.length).toBeGreaterThan(0);
      walk(line, 6, 60, (frames) => {
        frames.forEach((frame, car) => {
          sampleCentreLine(line, frame.distance, sample);
          const gap = distance(
            [frame.x * TILE, frame.y * TILE, frame.z * COASTER_LEVEL_TILES * TILE],
            [sample.x * TILE, sample.y * TILE, sample.z * COASTER_LEVEL_TILES * TILE],
          );
          worst = Math.max(worst, gap);
          expect(gap, `${name} car ${car}: pivot off the line`).toBeLessThan(0.6);
        });
      });
    }
    expect(worst).toBeGreaterThan(0);
  });

  it('is an orthonormal right-handed basis', () => {
    for (const [name] of ALL) {
      walk(lines.get(name)!, 6, 50, (frames) => {
        for (const f of frames) {
          const F: Vec = [f.forwardX, f.forwardY, f.forwardZ];
          const L: Vec = [f.leftX, f.leftY, f.leftZ];
          const U: Vec = [f.upX, f.upY, f.upZ];
          const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
          expect(Math.abs(dot(F, F) - 1)).toBeLessThan(1e-9);
          expect(Math.abs(dot(L, L) - 1)).toBeLessThan(1e-9);
          expect(Math.abs(dot(U, U) - 1)).toBeLessThan(1e-9);
          expect(Math.abs(dot(F, L))).toBeLessThan(1e-9);
          expect(Math.abs(dot(F, U))).toBeLessThan(1e-9);
          expect(Math.abs(dot(L, U))).toBeLessThan(1e-9);
          const cross: Vec = [F[1] * L[2] - F[2] * L[1], F[2] * L[0] - F[0] * L[2], F[0] * L[1] - F[1] * L[0]];
          expect(Math.abs(dot(cross, U) - 1), `${name}: det +1`).toBeLessThan(1e-9);
        }
      });
    }
  });

  it('banks with the track: roll equals centreLineRollAt, zero on straights and the station, and left of a left turn is lower', () => {
    let banked = 0;
    for (const [name] of ALL) {
      const line = lines.get(name)!;
      walk(line, 5, 80, (frames) => {
        for (const frame of frames) {
          expect(frame.roll).toBeCloseTo(centreLineRollAt(line, frame.distance), 12);
          if (Math.abs(frame.roll) < 0.05) continue;
          banked += 1;
          // The car's tilt about its forward axis: left.z is the sine of the lean, negative = left side down.
          // A left turn banks with roll < 0 (centreLineRollInPiece): the car leans in, its left (inner) side low.
          expect(Math.sign(frame.leftZ), `${name}: lean direction`).toBe(Math.sign(frame.roll));
          expect(Math.abs(Math.asin(Math.abs(frame.leftZ)) - Math.abs(frame.roll)), `${name}: lean angle`).toBeLessThan(0.15);
        }
      });
    }
    expect(banked, 'the fixtures bank somewhere').toBeGreaterThan(100);
    const oval = lines.get('oval')!;
    // The station run (the head parked at the end of the station, cars behind it) is level and unrolled.
    const parked = centreLineIndexToDistance(oval, GAME_CONFIG.coaster.stationLength - 1);
    const frame = createCoasterCarFrame();
    for (let car = 0; car < 3; car += 1) {
      coasterCarFrame(oval, parked, car, frame);
      expect(frame.roll).toBe(0);
      expect(frame.leftZ).toBeCloseTo(0, 9);
    }
  });

  it('points up at the ring centre inside a loop and rides upside down over the top', () => {
    const line = lines.get('loop oval')!;
    const sample = createCentreLineSample();
    let upsideDown = 0;
    let inRing = 0;
    walk(line, 6, 600, (frames) => {
      for (const frame of frames) {
        sampleCentreLine(line, frame.distance, sample);
        if (sample.ringAngle < 0.3 || sample.ringAngle > 2 * Math.PI - 0.3) continue;
        inRing += 1;
        if (frame.upZ < -0.95) upsideDown += 1;
        // Up is perpendicular to the travel direction and has no sideways (ring axis) component beyond the lean-free case.
        const side = frame.upX * -sample.dirY + frame.upY * sample.dirX;
        expect(Math.abs(side), 'no lean inside a ring').toBeLessThan(0.05);
      }
    });
    expect(inRing).toBeGreaterThan(100);
    expect(upsideDown, 'cars hang upside down near the top').toBeGreaterThan(5);
  });

  it('moves continuously: no pose jump bigger than a fraction of a voxel per 1/60 s at the fastest speed', () => {
    for (const [name] of ALL.slice(0, 20)) {
      const line = lines.get(name)!;
      const a = createCoasterCarFrame();
      const b = createCoasterCarFrame();
      // 0.01 tile of arc is 0.32 voxel: the pivot and the basis must change by that order, never jump.
      const step = 0.01;
      let previous: CoasterCarFrame | null = null;
      for (let d = 0; d < line.totalLength; d += step) {
        coasterCarFrame(line, d, 1, a);
        if (previous) {
          const jump = Math.hypot(a.x - b.x, a.y - b.y, (a.z - b.z) * COASTER_LEVEL_TILES) * TILE;
          expect(jump, `${name} at ${d.toFixed(2)}: pivot jump`).toBeLessThan(0.6);
          const turn = Math.abs(a.forwardX * b.forwardX + a.forwardY * b.forwardY + a.forwardZ * b.forwardZ);
          expect(turn, `${name}: forward jump`).toBeGreaterThan(0.99);
          const lean = a.upX * b.upX + a.upY * b.upY + a.upZ * b.upZ;
          expect(lean, `${name}: up jump`).toBeGreaterThan(0.99);
        }
        previous = b;
        coasterCarFrame(line, d, 1, b);
      }
    }
  });

  it('is deterministic and keeps the arc spacing exact', () => {
    const line = lines.get('oval')!;
    const one = createCoasterCarFrame();
    const two = createCoasterCarFrame();
    for (let car = 0; car < 5; car += 1) {
      coasterCarFrame(line, 3.1, car, one);
      coasterCarFrame(line, 3.1, car, two);
      expect(two).toEqual(one);
      expect(one.distance).toBeCloseTo(3.1 - car * COASTER_CAR_SPACING_TILES, 12);
    }
    expect(COASTER_CAR_BOGIE_TILES).toBe(3 / 32);
  });
});

describe('couplings and bodies', () => {
  it('keeps the hitch distance between one coupling half and two: no gap, and no half reaching past the far hitch', () => {
    let min = Infinity;
    let max = 0;
    const coupling = createCoasterCouplingFrame();
    for (const [name] of ALL) {
      walk(lines.get(name)!, 6, 200, (frames) => {
        for (let car = 0; car + 1 < frames.length; car += 1) {
          coasterCouplingFrame(frames[car], frames[car + 1], coupling);
          const voxels = coupling.length * TILE;
          min = Math.min(min, voxels);
          max = Math.max(max, voxels);
        }
      });
    }
    console.log(`hitch distance min ${min.toFixed(3)} max ${max.toFixed(3)} voxels, two halves of ${COUPLING_HALF_LENGTH}`);
    expect(max, 'open gap').toBeLessThanOrEqual(2 * COUPLING_HALF_LENGTH);
    expect(min, 'a half past the far hitch').toBeGreaterThan(COUPLING_HALF_LENGTH);
  });

  it('orients the coupling along the hitches and keeps its pivot at their midpoint', () => {
    const line = lines.get('hill-dip')!;
    const coupling = createCoasterCouplingFrame();
    walk(line, 4, 100, (frames) => {
      coasterCouplingFrame(frames[0], frames[1], coupling);
      const mid: Vec = [
        (frames[0].x + frames[1].x) / 2 * TILE,
        (frames[0].y + frames[1].y) / 2 * TILE,
        (frames[0].z + frames[1].z) / 2 * COASTER_LEVEL_TILES * TILE,
      ];
      // Between the two pivots (the hitches are on their axes), so near their midpoint.
      expect(distance([coupling.x * TILE, coupling.y * TILE, coupling.z * COASTER_LEVEL_TILES * TILE], mid)).toBeLessThan(5);
      expect(Math.hypot(coupling.forwardX, coupling.forwardY, coupling.forwardZ)).toBeCloseTo(1, 9);
    });
  });

  it('hangs each coupling half on its own car\'s hitch, pointing at the other, with an orthonormal basis', () => {
    const line = lines.get('hill-dip')!;
    const coupling = createCoasterCouplingFrame();
    const half = createCoasterCarFrame();
    walk(line, 4, 100, (frames) => {
      coasterCouplingFrame(frames[0], frames[1], coupling);
      const mid: Vec = [coupling.x * TILE, coupling.y * TILE, coupling.z * COASTER_LEVEL_TILES * TILE];
      const pivots: Vec[] = [];
      for (const which of [0, 1]) {
        coasterCouplingHalfFrame(coupling, which, half);
        const pivot: Vec = [half.x * TILE, half.y * TILE, half.z * COASTER_LEVEL_TILES * TILE];
        pivots.push(pivot);
        expect(distance(pivot, mid), 'half the hitch distance from the middle').toBeCloseTo(coupling.length * TILE / 2, 6);
        // +x points from this hitch toward the middle (and on to the other hitch).
        const toMid: Vec = [mid[0] - pivot[0], mid[1] - pivot[1], mid[2] - pivot[2]];
        const along = (toMid[0] * half.forwardX + toMid[1] * half.forwardY + toMid[2] * half.forwardZ) / (distance(pivot, mid) || 1);
        expect(along).toBeCloseTo(1, 6);
        const f: Vec = [half.forwardX, half.forwardY, half.forwardZ];
        const l: Vec = [half.leftX, half.leftY, half.leftZ];
        const u: Vec = [half.upX, half.upY, half.upZ];
        expect(f[0] * l[0] + f[1] * l[1] + f[2] * l[2]).toBeCloseTo(0, 9);
        expect(f[0] * u[0] + f[1] * u[1] + f[2] * u[2]).toBeCloseTo(0, 9);
        // Right-handed: left = up × forward.
        expect(u[1] * f[2] - u[2] * f[1]).toBeCloseTo(l[0], 9);
        expect(u[2] * f[0] - u[0] * f[2]).toBeCloseTo(l[1], 9);
      }
      expect(distance(pivots[0], pivots[1])).toBeCloseTo(coupling.length * TILE, 6);
    });
  });

  it('keeps neighbouring car bodies apart (loops included); raised arms are reported', () => {
    let closestBody = Infinity;
    let closestArms = Infinity;
    let where = '';
    for (const [name] of ALL) {
      walk(lines.get(name)!, 6, 120, (frames, head) => {
        for (let car = 0; car + 1 < frames.length; car += 1) {
          // Body corners (x ±5, y ±4, z 2 and 7) and the riders' raised arms (z 12 over the seats).
          const bodyOf = (frame: CoasterCarFrame): Vec[] => {
            const list: Vec[] = [];
            for (const x of [-5, 5]) for (const y of [-4, 4]) for (const z of [2, 7]) list.push(world(frame, x, y, z));
            return list;
          };
          const armsOf = (frame: CoasterCarFrame): Vec[] => {
            const list: Vec[] = [];
            for (const x of [-3, 3]) for (const y of [-3, 3]) list.push(world(frame, x, y, 12));
            return list;
          };
          for (const p of bodyOf(frames[car])) {
            for (const q of bodyOf(frames[car + 1])) {
              const d = distance(p, q);
              if (d < closestBody) { closestBody = d; where = `${name} car ${car} head ${head.toFixed(3)}`; }
            }
          }
          for (const p of [...bodyOf(frames[car]), ...armsOf(frames[car])]) {
            for (const q of [...bodyOf(frames[car + 1]), ...armsOf(frames[car + 1])]) closestArms = Math.min(closestArms, distance(p, q));
          }
        }
      });
    }
    console.log(`closest body corners ${closestBody.toFixed(3)} voxels (${where}), with raised arms ${closestArms.toFixed(3)}`);
    // The worst case is the underside of two cars over a one-tile crest of 73 degrees between neighbours
    // (a 0 -> 1 -> 0 hill): the corner points nearly touch, the bodies do not interpenetrate.
    expect(closestBody).toBeGreaterThanOrEqual(0.25);
  });
});

describe('coasterLoadedCars', () => {
  it('shows riders only while running, front cars first, and never counts anyone', () => {
    expect(coasterLoadedCars('idle', 8, 8, 6)).toBe(0);
    expect(coasterLoadedCars('waiting', 8, 8, 6)).toBe(0);
    expect(coasterLoadedCars('broken', 8, 8, 6)).toBe(0);
    expect(coasterLoadedCars(undefined, 8, 8, 6)).toBe(0);
    expect(coasterLoadedCars('running', 0, 8, 6)).toBe(0);
    expect(coasterLoadedCars('running', 8, 8, 6)).toBe(6);
    expect(coasterLoadedCars('running', 1, 8, 6)).toBe(1);
    // Serpent seats 2 2 1 1 1 1: four riders fill cars 0 and 1.
    expect(coasterLoadedCars('running', 4, 8, 6)).toBe(2);
    expect(coasterLoadedCars('running', 5, 8, 6)).toBe(3);
    expect(coasterLoadedCars('running', 99, 8, 6)).toBe(6);
  });

  it('spreads each type\'s capacity over its cars as seats, front cars first, and shows about the real head count', () => {
    expect([0, 1, 2, 3, 4, 5].map((car) => coasterCarSeats(car, 8, 6))).toEqual([2, 2, 1, 1, 1, 1]);
    expect([0, 1, 2, 3].map((car) => coasterCarSeats(car, 12, 4))).toEqual([3, 3, 3, 3]);
    expect([0, 1, 2, 3, 4].map((car) => coasterCarSeats(car, 10, 5))).toEqual([2, 2, 2, 2, 2]);
    expect(coasterCarSeats(6, 8, 6), 'no such car').toBe(0);
    for (const type of COASTER_TYPES) {
      const seats = Array.from({ length: type.trainCars }, (_, car) => coasterCarSeats(car, type.trainCapacity, type.trainCars));
      expect(seats.reduce((sum, value) => sum + value, 0), `${type.definitionId}: the seats are the capacity`).toBe(type.trainCapacity);
      expect(Math.max(...seats), `${type.definitionId}: a car seats at most two rows of two`).toBeLessThanOrEqual(COASTER_MAX_SEATS_PER_CAR);
      for (let car = 0; car < type.trainCars; car += 1) {
        expect(coasterFirstSeat(car, type.trainCapacity, type.trainCars)).toBe(seats.slice(0, car).reduce((sum, value) => sum + value, 0));
      }
      for (let riders = 0; riders <= type.trainCapacity; riders += 1) {
        const loaded = coasterLoadedCars('running', riders, type.trainCapacity, type.trainCars);
        const shown = seats.slice(0, loaded).reduce((sum, value) => sum + value, 0);
        expect(shown, `${type.definitionId} with ${riders} riders`).toBeGreaterThanOrEqual(riders);
        expect(shown, `${type.definitionId} with ${riders} riders`).toBeLessThanOrEqual(riders + Math.max(...seats) - 1 + (riders === 0 ? 1 : 0));
      }
    }
  });
});
