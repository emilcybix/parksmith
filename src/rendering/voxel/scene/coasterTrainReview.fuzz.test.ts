import { describe, expect, it } from 'vitest';
import {
  centreLineFor,
  createCentreLineFrame,
  resampleCentreLineFrame,
} from '../../../game/coaster/centreLine';
import type { CoasterPiece } from '../../../game/coaster/design';
import { deriveCoasterStats } from '../../../game/coaster/design';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { hillDipLayout, longestLayout, loopOvalLayout, ovalLayout, randomCircuit, zigzagLayout } from '../../../game/coaster/testLayouts';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { coasterHeadIndex } from '../../coasterTrain';
import {
  coasterCouplingFrame,
  coasterCouplingHalfFrame,
  coasterLoadedCars,
  createCoasterCarFrame,
  createCoasterCouplingFrame,
} from '../../coasterCarFrame';
import type { CoasterCarFrame } from '../../coasterCarFrame';
import { compileBlueprint } from '../blueprint/compile';
import { BOX_FLOATS, BoxWriter } from '../contracts/boxes';
import { buildPalette } from '../palette';
import { coasterContent, COUPLING_HALF_LENGTH } from '../content/coaster';
import { SKIN_MATERIALS } from '../contracts/palette';
import { coasterRailTopZ, createCoasterCarPoses, placeCarsOnTrack } from './coasterCars';
import type { CoasterCarPoses } from './coasterCars';

/**
 * Phase 27 step 3 adversarial review of the train geometry (voxel cars as rigid parts), on the
 * fixture layouts and 100 random closed circuits, sampled at 60 frames per second of the real
 * (gameplay) timing over a whole lap. Each car, its riders and its couplings are the compiled
 * models (not hand-picked corners) placed as oriented boxes; intersections are separating-axis
 * tests with a penetration depth, never corner distances. Found defects are pinned with
 * `it.fails` so the suite stays green and flips when the defect is fixed.
 */

const TILE = 32;
const LEVEL = 13;
const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const TYPES = ['comet-trail', 'star-chaser', 'skyline-serpent'] as const;

interface LocalBox { cx: number; cy: number; cz: number; ex: number; ey: number; ez: number; r: number; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

const localBoxes = (boxes: Float32Array, count: number): LocalBox[] => {
  const list: LocalBox[] = [];
  for (let box = 0; box < count; box += 1) {
    const at = box * BOX_FLOATS;
    const ex = boxes[at + 4] / 2;
    const ey = boxes[at + 5] / 2;
    const ez = boxes[at + 6] / 2;
    list.push({
      cx: boxes[at] + ex, cy: boxes[at + 1] + ey, cz: boxes[at + 2] + ez, ex, ey, ez, r: Math.hypot(ex, ey, ez),
      x0: boxes[at], y0: boxes[at + 1], z0: boxes[at + 2],
      x1: boxes[at] + boxes[at + 4], y1: boxes[at + 1] + boxes[at + 5], z1: boxes[at + 2] + boxes[at + 6],
    });
  }
  return list;
};

const partBoxes = (blueprint: Parameters<typeof compileBlueprint>[0]): LocalBox[] => {
  const part = compileBlueprint(blueprint).parts[0];
  return localBoxes(part.boxes, part.boxCount);
};

interface TrainModels { cars: LocalBox[][]; riders: LocalBox[][]; coupling: LocalBox[]; count: number }
const MODELS = new Map<string, TrainModels>();
const modelsOf = (id: string): TrainModels => {
  let models = MODELS.get(id);
  if (!models) {
    const definition = BUILD_BY_ID.get(id)!;
    const count = COASTER_TYPE_BY_ID.get(id)!.trainCars;
    models = {
      count,
      cars: Array.from({ length: count }, (_, car) => partBoxes(coasterContent.carBlueprint(definition, car, palette))),
      riders: Array.from({ length: count }, (_, car) => partBoxes(coasterContent.riderBlueprint(definition, car, palette))),
      coupling: partBoxes(coasterContent.couplingBlueprint(definition, palette)),
    };
    MODELS.set(id, models);
  }
  return models;
};

/** A rigid pose in world voxels: pivot and the basis columns (forward, left, up). */
interface Pose { p: [number, number, number]; a: number[][] }
const poseOf = (frame: CoasterCarFrame): Pose => ({
  p: [frame.x * TILE, frame.y * TILE, coasterRailTopZ(frame.z)],
  a: [[frame.forwardX, frame.forwardY, frame.forwardZ], [frame.leftX, frame.leftY, frame.leftZ], [frame.upX, frame.upY, frame.upZ]],
});
/** Coupling half pose: its frame's pivot is at a hitch, `COASTER_CAR_HITCH_UP_TILES` above the rail (frame z in levels). */
const couplingPoseOf = (frame: CoasterCarFrame): Pose => ({
  p: [frame.x * TILE, frame.y * TILE, frame.z * LEVEL + 5],
  a: [[frame.forwardX, frame.forwardY, frame.forwardZ], [frame.leftX, frame.leftY, frame.leftZ], [frame.upX, frame.upY, frame.upZ]],
});
const toWorld = (pose: Pose, x: number, y: number, z: number): [number, number, number] => [
  pose.p[0] + x * pose.a[0][0] + y * pose.a[1][0] + z * pose.a[2][0],
  pose.p[1] + x * pose.a[0][1] + y * pose.a[1][1] + z * pose.a[2][1],
  pose.p[2] + x * pose.a[0][2] + y * pose.a[1][2] + z * pose.a[2][2],
];
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Penetration depth of two oriented boxes (separating-axis theorem over the 15 axes): ≤ 0 when
 * they are apart or only touch, otherwise the smallest overlap along any axis (voxels).
 */
const penetration = (ca: number[], aa: number[][], ea: number[], cb: number[], ab: number[][], eb: number[]): number => {
  const t = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]];
  let least = Infinity;
  const test = (axis: number[]): boolean => {
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    if (length < 1e-6) return true;
    const n = [axis[0] / length, axis[1] / length, axis[2] / length];
    const ra = ea[0] * Math.abs(dot(aa[0], n)) + ea[1] * Math.abs(dot(aa[1], n)) + ea[2] * Math.abs(dot(aa[2], n));
    const rb = eb[0] * Math.abs(dot(ab[0], n)) + eb[1] * Math.abs(dot(ab[1], n)) + eb[2] * Math.abs(dot(ab[2], n));
    const overlap = ra + rb - Math.abs(dot(t, n));
    if (overlap < least) least = overlap;
    return overlap > 0;
  };
  for (let i = 0; i < 3; i += 1) if (!test(aa[i])) return least;
  for (let i = 0; i < 3; i += 1) if (!test(ab[i])) return least;
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) if (!test(cross(aa[i], ab[j]))) return least;
  return least;
};

interface Hit { depth: number; where: string }
/** Deepest penetration between two posed box sets (bounding-sphere prefilter). */
const deepest = (a: LocalBox[], pa: Pose, b: LocalBox[], pb: Pose, hit: Hit, where: string): void => {
  const centresB = b.map((box) => toWorld(pb, box.cx, box.cy, box.cz));
  for (const boxA of a) {
    const ca = toWorld(pa, boxA.cx, boxA.cy, boxA.cz);
    for (let j = 0; j < b.length; j += 1) {
      const cb = centresB[j];
      if (Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]) >= boxA.r + b[j].r) continue;
      const depth = penetration(ca, pa.a, [boxA.ex, boxA.ey, boxA.ez], cb, pb.a, [b[j].ex, b[j].ey, b[j].ez]);
      if (depth > hit.depth) {
        hit.depth = depth;
        hit.where = `${where}: [${boxA.x0},${boxA.y0},${boxA.z0}]-[${boxA.x1},${boxA.y1},${boxA.z1}] vs [${b[j].x0},${b[j].y0},${b[j].z0}]-[${b[j].x1},${b[j].y1},${b[j].z1}]`;
      }
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Circuits and real timing

interface Circuit { name: string; pieces: CoasterPiece[]; type: string; hasLoop: boolean }
const circuits = (): Circuit[] => {
  const list: Circuit[] = [];
  for (const type of TYPES) {
    list.push({ name: `oval/${type}`, pieces: ovalLayout(), type, hasLoop: false });
    list.push({ name: `zigzag/${type}`, pieces: zigzagLayout(), type, hasLoop: false });
    list.push({ name: `hill-dip/${type}`, pieces: hillDipLayout(), type, hasLoop: false });
    list.push({ name: `longest/${type}`, pieces: longestLayout(), type, hasLoop: false });
  }
  list.push({ name: 'loop oval/star-chaser', pieces: loopOvalLayout(), type: 'star-chaser', hasLoop: true });
  list.push({ name: 'loop oval/skyline-serpent', pieces: loopOvalLayout(), type: 'skyline-serpent', hasLoop: true });
  let made = 0;
  for (let seed = 1; made < 100 && seed < 20000; seed += 1) {
    const pieces = randomCircuit(seed, 6 + 2 * (seed % 14), 4 + (seed % 6));
    if (!pieces) continue;
    const straightStart = pieces[1].cell.x - pieces[0].cell.x === pieces[2].cell.x - pieces[1].cell.x
      && pieces[1].cell.y - pieces[0].cell.y === pieces[2].cell.y - pieces[1].cell.y;
    if (!straightStart) continue;
    const hasLoop = pieces.some((piece) => piece.special === 'loop');
    // Loops only on the looping types; the comet gets loop-free circuits.
    const type = hasLoop ? (made % 2 === 0 ? 'star-chaser' : 'skyline-serpent') : TYPES[made % 3];
    list.push({ name: `seed ${seed}/${type}`, pieces, type, hasLoop });
    made += 1;
  }
  return list;
};
const ALL = circuits();

/** Every 1/60 s of one lap at the gameplay timing: hands each frame's poses to `visit`. */
const lap = (circuit: Circuit, visit: (poses: CoasterCarPoses, frame: number) => void): void => {
  const type = COASTER_TYPE_BY_ID.get(circuit.type)!;
  const stats = deriveCoasterStats(circuit.pieces, type);
  const record = { pieces: circuit.pieces, stats };
  const line = centreLineFor(circuit.pieces);
  const poses = createCoasterCarPoses(type.trainCars);
  const frames = Math.ceil(stats.durationSeconds * 60);
  for (let frame = 0; frame <= frames; frame += 1) {
    const remaining = Math.max(0, stats.durationSeconds - frame / 60);
    placeCarsOnTrack(line, coasterHeadIndex(record, remaining), type.trainCars, poses);
    visit(poses, frame);
  }
};

const COUPLING = createCoasterCouplingFrame();

// ---------------------------------------------------------------------------------------------

describe('Phase 27 step 3 review: train geometry', () => {
  it('has a fixture set of 100 random circuits plus every fixture, loops on both looping types', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(114);
    expect(ALL.filter((circuit) => circuit.hasLoop).length).toBeGreaterThan(10);
  });

  it('writes a unit quaternion that rotates car +x, +y, +z onto the frame basis on every frame of every lap', () => {
    let worst = 0;
    const rotate = (q: number[], v: number[]): number[] => {
      // v' = v + 2w (q × v) + 2 q × (q × v)
      const u = [q[0], q[1], q[2]];
      const t = cross(u, v).map((c) => 2 * c);
      const s = cross(u, t);
      return [v[0] + q[3] * t[0] + s[0], v[1] + q[3] * t[1] + s[1], v[2] + q[3] * t[2] + s[2]];
    };
    for (const circuit of ALL.slice(0, 40)) {
      lap(circuit, (poses) => {
        for (let car = 0; car < poses.count; car += 1) {
          const at = car * 7;
          const q = [poses.data[at + 3], poses.data[at + 4], poses.data[at + 5], poses.data[at + 6]];
          const frame = poses.frames[car];
          worst = Math.max(worst, Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1));
          const f = rotate(q, [1, 0, 0]);
          const u = rotate(q, [0, 0, 1]);
          worst = Math.max(worst, Math.hypot(f[0] - frame.forwardX, f[1] - frame.forwardY, f[2] - frame.forwardZ));
          worst = Math.max(worst, Math.hypot(u[0] - frame.upX, u[1] - frame.upY, u[2] - frame.upZ));
        }
      });
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it('keeps every running wheel on its rail: wheel bottoms over the bogies within a voxel of the rail top, lateral slip under a voxel', () => {
    const rail = createCentreLineFrame();
    let worst = 0;
    let worstSlip = 0;
    let where = '';
    for (const circuit of ALL) {
      const line = centreLineFor(circuit.pieces);
      lap(circuit, (poses, frame) => {
        if (frame % 2 === 1) return;
        for (let car = 0; car < poses.count; car += 1) {
          const f = poses.frames[car];
          const pose = poseOf(f);
          for (const along of [-3, 3]) {
            rail.distance = f.distance + along / TILE;
            resampleCentreLineFrame(line, rail);
            for (const side of [-3, 3]) {
              const wheel = toWorld(pose, along, side, 0);
              const top = [
                rail.x * TILE + side * rail.normalX,
                rail.y * TILE + side * rail.normalY,
                coasterRailTopZ(rail.z) + side * rail.normalZ,
              ];
              const d = [wheel[0] - top[0], wheel[1] - top[1], wheel[2] - top[2]];
              // Height above the rail top, along the rail's own up (lateral slip on a corner is inherent to a rigid car).
              const signed = d[0] * rail.upX + d[1] * rail.upY + d[2] * rail.upZ;
              const gap = Math.abs(signed);
              const slip = Math.abs(d[0] * rail.normalX + d[1] * rail.normalY + d[2] * rail.normalZ);
              worstSlip = Math.max(worstSlip, slip);
              if (gap > worst) { worst = gap; where = `${circuit.name} car ${car} frame ${frame} bogie ${along} side ${side} height ${signed.toFixed(2)} roll ${f.roll.toFixed(3)} rail roll ${rail.roll.toFixed(3)} slip ${slip.toFixed(2)}`; }
            }
          }
        }
      });
    }
    console.log(`wheel height above rail top: worst ${worst.toFixed(3)} voxels (${where}); lateral slip worst ${worstSlip.toFixed(3)}`);
    // Measured 0.84 (low): the car takes the roll at its centre, so on a corner entry/exit where the
    // banking ramps fastest the bogie rails are rolled up to ~0.16 rad less and one side's wheels float
    // (the other side's sink) by up to 3 · sin 0.16. Guard against anything worse.
    expect(worst, where).toBeLessThan(1);
    expect(worstSlip, 'a wheel stays over its 2-voxel rail').toBeLessThan(1);
  });

  /** Deepest car-to-next-car penetration over every lap: bodies only, or bodies with riders. */
  const carToCar = (withRiders: boolean): { plain: Hit; loops: Hit } => {
    const plain: Hit = { depth: 0, where: '' };
    const loops: Hit = { depth: 0, where: '' };
    for (const circuit of ALL) {
      const models = modelsOf(circuit.type);
      lap(circuit, (poses, frame) => {
        for (let car = 0; car + 1 < poses.count; car += 1) {
          const boxesA = withRiders ? [...models.cars[car], ...models.riders[car]] : models.cars[car];
          const boxesB = withRiders ? [...models.cars[car + 1], ...models.riders[car + 1]] : models.cars[car + 1];
          deepest(boxesA, poseOf(poses.frames[car]), boxesB, poseOf(poses.frames[car + 1]), circuit.hasLoop ? loops : plain,
            `${circuit.name} cars ${car}/${car + 1} frame ${frame}`);
        }
      });
    }
    return { plain, loops };
  };

  it('never lets one car body interpenetrate the next car body, 60 fps over a lap (crests, dips, corners, loops)', () => {
    const { plain, loops } = carToCar(false);
    console.log(`car-car bodies: no-loop ${plain.depth.toFixed(3)} (${plain.where}); loops ${loops.depth.toFixed(3)} (${loops.where})`);
    expect(plain.depth, plain.where).toBeLessThan(0.25);
    // Measured 0.43 (low): inside a ring the star chaser's back-row hoop bar (z 10..11, x −4) of car k
    // dips into the side wall of car k + 1. Guard against anything worse.
    expect(loops.depth, loops.where).toBeLessThan(0.6);
  }, 120_000);

  // DEFECT (low): the looping types' raised arms (rider boxes z 10..12) of the back row of car k and
  // the front row of car k + 1 overlap by ~0.9 voxel in a sharp V dip (0.64 rad down then up across a
  // corner) and inside a loop ring, where neighbouring cars' tops converge.
  it.fails('never lets the riders of one car interpenetrate the riders of the next car', () => {
    const { plain, loops } = carToCar(true);
    console.log(`car-car with riders: no-loop ${plain.depth.toFixed(3)} (${plain.where}); loops ${loops.depth.toFixed(3)} (${loops.where})`);
    expect(plain.depth, plain.where).toBeLessThan(0.25);
    expect(loops.depth, loops.where).toBeLessThan(0.25);
  }, 120_000);

  // Fixed (was DEFECT, medium): out of a ring into a banked climbing corner the two cars differ by ~90
  // degrees, and the single 16-voxel bar, tucked past the behind car's front hitch along the chord,
  // came out under that car's floor (car-space z −0.9). A coupling is now two half-bars, each hinged
  // at its own car's hitch (coasterCarFrame.ts `coasterCouplingHalfFrame`): no end passes a hitch.
  it('keeps each coupling half-bar\'s hitch end inside the car it hangs on, and its free end short of the far hitch', () => {
    // The hitch end's corners in the host car's space must lie in the chassis/body envelope
    // x [−5, 5] × y [−4, 4] × z [1, 7]; the free end must stop before the other car's hitch.
    let worst = 0;
    let where = '';
    let shortest = Infinity;
    const half = createCoasterCarFrame();
    for (const circuit of ALL) {
      lap(circuit, (poses, frame) => {
        for (let car = 0; car + 1 < poses.count; car += 1) {
          const ahead = poses.frames[car];
          const behind = poses.frames[car + 1];
          coasterCouplingFrame(ahead, behind, COUPLING);
          shortest = Math.min(shortest, COUPLING.length * TILE - COUPLING_HALF_LENGTH);
          for (const [which, owner] of [[0, ahead], [1, behind]] as const) {
            const bar = couplingPoseOf(coasterCouplingHalfFrame(COUPLING, which, half));
            const host = poseOf(owner);
            for (const y of [-1, 1]) {
              for (const z of [-1, 1]) {
                const w = toWorld(bar, 0, y, z);
                const d = [w[0] - host.p[0], w[1] - host.p[1], w[2] - host.p[2]];
                const local = [dot(d, host.a[0]), dot(d, host.a[1]), dot(d, host.a[2])];
                const out = Math.max(Math.abs(local[0]) - 5, Math.abs(local[1]) - 4, 1 - local[2], local[2] - 7, 0);
                if (out > worst) { worst = out; where = `${circuit.name} coupling ${car} half ${which} frame ${frame} local ${local.map((v) => v.toFixed(2))}`; }
              }
            }
          }
        }
      });
    }
    console.log(`coupling half-bar hitch end outside its host car: worst ${worst.toFixed(3)} voxels (${where}); free end short of the far hitch by at least ${shortest.toFixed(3)}`);
    expect(worst, where).toBeLessThan(0.5);
    expect(shortest, 'a half-bar never reaches past the other car\'s hitch').toBeGreaterThan(0);
  }, 60_000);

  it('keeps the coupling\'s visible gap closed: the two halves together reach both hitches on every frame', () => {
    let worstGap = 0;
    for (const circuit of ALL) {
      lap(circuit, (poses) => {
        for (let car = 0; car + 1 < poses.count; car += 1) {
          coasterCouplingFrame(poses.frames[car], poses.frames[car + 1], COUPLING);
          worstGap = Math.max(worstGap, COUPLING.length * TILE - 2 * COUPLING_HALF_LENGTH);
        }
      });
    }
    expect(worstGap).toBeLessThanOrEqual(0);
  });

  // DEFECT (low): a loop whose next piece is lower and the one after higher (valid: ±1 per piece)
  // tilts the ring forward over the next tile; the star chaser's back-row hoop climbing out on the
  // piece after next passes 1.8 voxels into that ring's spine (seed 207). Cars on the piece right
  // after a loop are not checked against that loop (shared rails at the ring base).
  it.fails('keeps every car, rider and coupling box clear of the other pieces\' track structure (rails, bed, supports)', () => {
    // Static track boxes of every piece, then each posed car box vs the boxes of pieces other than
    // the ones it is riding on (its own rails are touched by the wheels by design).
    const hit: Hit = { depth: 0, where: '' };
    const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (const circuit of ALL) {
      const definition = BUILD_BY_ID.get(circuit.type)!;
      const writer = new BoxWriter(256);
      const owner: number[] = [];
      const trackMaterial: number[] = [];
      for (let piece = 0; piece < circuit.pieces.length; piece += 1) {
        const from = writer.count;
        coasterContent.pieceBoxes(circuit.pieces, piece, definition, palette, 0, writer);
        for (let box = from; box < writer.count; box += 1) {
          owner.push(piece);
          trackMaterial.push(writer.data[box * BOX_FLOATS + 3] & 255);
        }
      }
      const track = localBoxes(writer.data, writer.count);
      const buckets = new Map<string, number[]>();
      track.forEach((box, j) => {
        const key = `${Math.floor(box.cx / TILE)},${Math.floor(box.cy / TILE)}`;
        const list = buckets.get(key);
        if (list) list.push(j); else buckets.set(key, [j]);
      });
      const models = modelsOf(circuit.type);
      const n = circuit.pieces.length;
      const line = centreLineFor(circuit.pieces);
      const sample = createCentreLineFrame();
      lap(circuit, (poses, frame) => {
        if (frame % 3 !== 0) return;
        for (let car = 0; car < poses.count; car += 1) {
          const frameOf = poses.frames[car];
          const pose = poseOf(frameOf);
          // The pieces under the car (its piece and the neighbours a 16-voxel car can span).
          sample.distance = frameOf.distance;
          resampleCentreLineFrame(line, sample);
          const piece = sample.piece;
          const near = new Set([piece, (piece + 1) % n, (piece + n - 1) % n]);
          const boxes = [...models.cars[car], ...models.riders[car]];
          const tx = Math.floor(pose.p[0] / TILE);
          const ty = Math.floor(pose.p[1] / TILE);
          const candidates: number[] = [];
          for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) candidates.push(...(buckets.get(`${tx + dx},${ty + dy}`) ?? []));
          for (const boxA of boxes) {
            const ca = toWorld(pose, boxA.cx, boxA.cy, boxA.cz);
            for (const j of candidates) {
              if (near.has(owner[j])) continue;
              const b = track[j];
              if (Math.hypot(ca[0] - b.cx, ca[1] - b.cy, ca[2] - b.cz) >= boxA.r + b.r) continue;
              const depth = penetration(ca, pose.a, [boxA.ex, boxA.ey, boxA.ez], [b.cx, b.cy, b.cz], identity, [b.ex, b.ey, b.ez]);
              if (depth > hit.depth) { hit.depth = depth; hit.where = `${circuit.name} car ${car} (on piece ${piece}) vs piece ${owner[j]} box [${b.x0},${b.y0},${b.z0}]-[${b.x1},${b.y1},${b.z1}] material ${trackMaterial[j]} with ${boxA === boxes[0] ? 'chassis' : models.cars[car].includes(boxA) ? 'car' : 'rider'} box [${boxA.x0},${boxA.y0},${boxA.z0}]-[${boxA.x1},${boxA.y1},${boxA.z1}] frame ${frame}`; }
            }
          }
        }
      });
    }
    console.log(`car vs other pieces' track: deepest ${hit.depth.toFixed(3)} voxels (${hit.where})`);
    expect(hit.depth, hit.where).toBeLessThan(0.5);
  }, 300_000);

  it('banks with the right sign: on every corner apex the outer side of the car is up', () => {
    let checked = 0;
    for (const circuit of ALL.filter((c) => !c.hasLoop)) {
      const line = centreLineFor(circuit.pieces);
      const sample = createCentreLineFrame();
      lap(circuit, (poses) => {
        const f = poses.frames[0];
        if (Math.abs(f.roll) < 0.2) return;
        // The plan turn direction from the tangent change across the car.
        sample.distance = f.distance - 0.2;
        resampleCentreLineFrame(line, sample);
        const bx = sample.dirX; const by = sample.dirY;
        sample.distance = f.distance + 0.2;
        resampleCentreLineFrame(line, sample);
        const turn = bx * sample.dirY - by * sample.dirX; // > 0: turning left
        if (Math.abs(turn) < 0.1) return;
        checked += 1;
        // Turning left, the outer (right) side is up, so the car's left axis points down.
        expect(Math.sign(f.leftZ), `${circuit.name} roll ${f.roll}`).toBe(-Math.sign(turn));
      });
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('never flips: forward and up turn by less than 45 degrees between 60 fps frames, also round a loop and across the lap seam', () => {
    let worst = 0;
    let where = '';
    for (const circuit of ALL) {
      const previous: number[][] = [];
      lap(circuit, (poses, frame) => {
        for (let car = 0; car < poses.count; car += 1) {
          const f = poses.frames[car];
          const now = [f.forwardX, f.forwardY, f.forwardZ, f.upX, f.upY, f.upZ];
          const before = previous[car];
          if (before) {
            const turnF = Math.acos(Math.min(1, before[0] * now[0] + before[1] * now[1] + before[2] * now[2]));
            const turnU = Math.acos(Math.min(1, before[3] * now[3] + before[4] * now[4] + before[5] * now[5]));
            const turn = Math.max(turnF, turnU) * 180 / Math.PI;
            if (turn > worst) { worst = turn; where = `${circuit.name} car ${car} frame ${frame}`; }
          }
          previous[car] = now;
        }
      });
    }
    console.log(`largest per-frame turn ${worst.toFixed(2)} degrees (${where})`);
    expect(worst, where).toBeLessThan(45);
  });
});

describe('Phase 27 step 3 review: riders', () => {
  it('shows no riders on a parked, loading, waiting, idle, closed, broken or maintenance train, whatever its head count', () => {
    for (const status of ['idle', 'waiting', 'closed', 'broken', 'maintenance', undefined] as const) {
      for (const type of TYPES) {
        const t = COASTER_TYPE_BY_ID.get(type)!;
        expect(coasterLoadedCars(status, t.trainCapacity, t.trainCapacity, t.trainCars)).toBe(0);
      }
    }
  });

  // Fixed (was DEFECT, medium, visual honesty): every loaded car showed four riders whatever the type
  // seats. Each car's rider model now carries its share of the capacity (coasterCarSeats: 3 per comet
  // car, 2 per star chaser car, 2 2 1 1 1 1 on the serpent) and the cars fill front to back.
  it('shows about as many rider figures as there are riders on board (at most one car\'s worth over)', () => {
    for (const type of TYPES) {
      const t = COASTER_TYPE_BY_ID.get(type)!;
      const models = modelsOf(type);
      // Riders drawn per car: one head (skin box) per rider in the compiled model.
      const skins = new Set(SKIN_MATERIALS as readonly number[]);
      const definition = BUILD_BY_ID.get(type)!;
      const figures = models.riders.map((_boxes, car) => {
        const part = compileBlueprint(coasterContent.riderBlueprint(definition, car, palette)).parts[0];
        let heads = 0;
        for (let box = 0; box < part.boxCount; box += 1) if (skins.has(part.boxes[box * BOX_FLOATS + 3] & 255)) heads += 1;
        return heads;
      });
      expect(figures.reduce((sum, value) => sum + value, 0), `${type}: a full train shows its capacity`).toBe(t.trainCapacity);
      const perCar = Math.max(...figures);
      for (let riders = 1; riders <= t.trainCapacity; riders += 1) {
        const loaded = coasterLoadedCars('running', riders, t.trainCapacity, t.trainCars);
        const shown = figures.slice(0, loaded).reduce((sum, value) => sum + value, 0);
        expect(shown, `${type} with ${riders} riders shows ${shown} figures`).toBeGreaterThanOrEqual(riders);
        expect(shown, `${type} with ${riders} riders shows ${shown} figures`).toBeLessThanOrEqual(riders + perCar - 1);
      }
    }
  });
});
