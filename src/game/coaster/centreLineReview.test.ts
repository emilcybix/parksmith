import { describe, expect, it } from 'vitest';
import {
  CENTRE_LINE_BANK_MAX,
  CENTRE_LINE_LOOP_RADIUS,
  CENTRE_LINE_TIE_SPACING,
  COASTER_LEVEL_TILES,
  centreLineFor,
  centreLineRollAt,
  centreLineRollInPiece,
  centreLineTieAlong,
  centreLineTieCount,
  createCentreLineFrame,
  createCentreLineSample,
  sampleCentreLine,
  sampleCentreLineFrame,
} from './centreLine';
import type { CoasterPiece } from './design';
import { hillDipLayout, longestLayout, loopOvalLayout, ovalLayout, randomCircuit, zigzagLayout } from './testLayouts';

/**
 * Phase 27 step 2 review of the centre line's banking, tie spacing and loop geometry (the rules
 * both renderers build from), on the fixture layouts and 100 random circuits:
 * - roll(arc): exactly zero on straights and rings, capped at CENTRE_LINE_BANK_MAX, eased (zero
 *   and flat at a corner's edges, one hump), signed by the turn and mirror-symmetric;
 * - ties: spaced by arc length over the whole circuit, tile joins included;
 * - loops: the ring is a circle of radius 16 in the vertical plane of travel, and the tangent is
 *   continuous where the ring leaves and rejoins the track, on flat runs and on ramps.
 */

const circuits = (): Array<[string, CoasterPiece[]]> => {
  const list: Array<[string, CoasterPiece[]]> = [
    ['oval', ovalLayout()],
    ['zig-zag', zigzagLayout()],
    ['hill and dip', hillDipLayout()],
    ['loop oval', loopOvalLayout()],
    ['longest', longestLayout()],
  ];
  for (let seed = 1; list.length < 105 && seed < 20000; seed += 1) {
    const target = 4 + 2 * (seed % 20);
    const layout = randomCircuit(seed, target, 4 + (seed % 6));
    const straight = layout !== null && layout[1].cell.x - layout[0].cell.x === layout[2].cell.x - layout[1].cell.x
      && layout[1].cell.y - layout[0].cell.y === layout[2].cell.y - layout[1].cell.y;
    if (layout && straight) list.push([`seed ${seed} (${target} pieces)`, layout]);
  }
  return list;
};

const CIRCUITS = circuits();

const mirrored = (pieces: readonly CoasterPiece[]): CoasterPiece[] =>
  pieces.map((piece) => ({ ...piece, cell: { x: 40 - piece.cell.x, y: piece.cell.y } }));

describe('centre line review: banking', () => {
  it('rolls exactly zero on straights and rings, at most BANK_MAX on corners, eased from +0 at both edges, signed by the turn', () => {
    expect(CIRCUITS.length).toBeGreaterThanOrEqual(100);
    let corners = 0;
    for (const [name, pieces] of CIRCUITS) {
      const line = centreLineFor(pieces);
      for (let index = 0; index < line.pieceCount; index += 1) {
        const length = line.tileLength[index];
        const steps = 64;
        if (line.turn[index] === 0) {
          for (let step = 0; step <= steps; step += 1) {
            expect(Object.is(centreLineRollInPiece(line, index, (length * step) / steps), 0), `${name} piece ${index}: a straight has +0 roll`).toBe(true);
          }
          continue;
        }
        corners += 1;
        expect(Object.is(centreLineRollInPiece(line, index, 0), 0), `${name} piece ${index}: +0 at the entry edge`).toBe(true);
        // sin(π) is 1.2e-16, so the exit edge is −7e-33 rather than the +0 the module comment claims: harmless (tan of it is 0).
        expect(Math.abs(centreLineRollInPiece(line, index, length)), `${name} piece ${index}: zero at the exit edge`).toBeLessThan(1e-30);
        let previous = 0;
        let apex = 0;
        let rising = true;
        for (let step = 1; step <= steps; step += 1) {
          const roll = centreLineRollInPiece(line, index, (length * step) / steps);
          expect(Math.abs(roll), `${name} piece ${index}: capped`).toBeLessThanOrEqual(CENTRE_LINE_BANK_MAX + 1e-12);
          expect(Math.sign(roll), `${name} piece ${index}: outer rail up (sign = −turn)`).toBe(-line.turn[index]);
          // Eased: |roll| rises monotonically to one apex and falls back, in small steps.
          const magnitude = Math.abs(roll);
          const previousMagnitude = Math.abs(previous);
          if (rising && magnitude < previousMagnitude - 1e-12) rising = false;
          if (!rising) expect(magnitude, `${name} piece ${index}: one hump`).toBeLessThanOrEqual(previousMagnitude + 1e-12);
          expect(Math.abs(magnitude - previousMagnitude), `${name} piece ${index}: no jump`).toBeLessThan(0.03);
          apex = Math.max(apex, magnitude);
          previous = roll;
        }
        expect(apex, `${name} piece ${index}: reaches the cap at the apex`).toBeCloseTo(CENTRE_LINE_BANK_MAX, 6);
      }
      // Rings never bank.
      const sample = createCentreLineSample();
      for (let distance = 0; distance < line.totalLength; distance += 0.02) {
        sampleCentreLine(line, distance, sample);
        if (sample.ringAngle > 0) expect(centreLineRollAt(line, distance), `${name}: no roll on a ring`).toBe(0);
      }
    }
    expect(corners).toBeGreaterThan(500);
  });

  it('is mirror-symmetric: a left and a right turn bank by the same amount the other way, and the frame mirrors with it', () => {
    const frame = createCentreLineFrame();
    const mirrorFrame = createCentreLineFrame();
    for (const [name, pieces] of CIRCUITS) {
      const line = centreLineFor(pieces);
      const mirror = centreLineFor(mirrored(pieces));
      expect(mirror.totalLength).toBeCloseTo(line.totalLength, 9);
      for (let index = 0; index < line.pieceCount; index += 1) {
        expect(mirror.turn[index] + line.turn[index], `${name} piece ${index}: the turn flips`).toBe(0);
        for (let step = 0; step <= 16; step += 1) {
          const along = (line.tileLength[index] * step) / 16;
          expect(centreLineRollInPiece(mirror, index, along), `${name} piece ${index} at ${along.toFixed(3)}`)
            .toBeCloseTo(-centreLineRollInPiece(line, index, along), 12);
        }
      }
      for (let distance = 0; distance < line.totalLength; distance += 0.05) {
        sampleCentreLineFrame(line, distance, frame);
        sampleCentreLineFrame(mirror, distance, mirrorFrame);
        // Position mirrors in x, height is the same; the rolled normal mirrors in x too and its lift (z) matches.
        expect(mirrorFrame.x).toBeCloseTo(41 - frame.x, 9);
        expect(mirrorFrame.y).toBeCloseTo(frame.y, 9);
        expect(mirrorFrame.z).toBeCloseTo(frame.z, 9);
        expect(mirrorFrame.normalZ, `${name} at ${distance.toFixed(2)}: the bank lift mirrors`).toBeCloseTo(-frame.normalZ, 9);
        expect(mirrorFrame.upZ).toBeCloseTo(frame.upZ, 9);
      }
    }
  });
});

describe('centre line review: ties', () => {
  /** Arc positions of every tie of the circuit (tiles and rings), in circuit order. */
  const tieArcs = (pieces: readonly CoasterPiece[]): number[] => {
    const line = centreLineFor(pieces);
    const arcs: number[] = [];
    for (let index = 0; index < line.pieceCount; index += 1) {
      const start = line.tileStart[index];
      const length = line.tileLength[index];
      for (let k = 0; k < centreLineTieCount(length); k += 1) arcs.push(start + centreLineTieAlong(k));
      if (line.loop[index] === 1) {
        const ringStart = start + length;
        const ringLength = line.tileStart[index + 1] - ringStart;
        for (let k = 0; k < centreLineTieCount(ringLength); k += 1) arcs.push(ringStart + centreLineTieAlong(k));
      }
    }
    return arcs;
  };

  it('spaces the ties of every straight piece 4 voxels apart, 8 to a tile', () => {
    expect(centreLineTieCount(1)).toBe(8);
    for (let k = 1; k < 8; k += 1) expect(centreLineTieAlong(k) - centreLineTieAlong(k - 1)).toBeCloseTo(CENTRE_LINE_TIE_SPACING, 12);
  });

  // FINDING (step 2 review): ties restart at every piece's entry edge, so where a corner (π/4 tile
  // = 25.13 voxels of arc) hands over to the next piece its last tie (at 25 voxels) and the next
  // piece's first tie (at 26.13) are 1.13 voxels apart instead of 4: a double tie at every corner
  // exit, in both renderers (the voxel tie columns [4k, 4k + 2) merge into one 3-voxel tie there).
  // The brief asks for ties spaced evenly by arc length. This test pins the current behaviour;
  // once ties are phased by circuit arc it will start passing and `it.fails` must be dropped.
  it.fails('spaces ties evenly by arc length over the whole circuit, corner exits included (gap 4 ± 1 voxels)', () => {
    const voxel = 1 / 32;
    for (const [name, pieces] of CIRCUITS) {
      const line = centreLineFor(pieces);
      const arcs = tieArcs(pieces);
      for (let at = 1; at < arcs.length; at += 1) {
        const gap = (arcs[at] - arcs[at - 1]) / voxel;
        expect(gap, `${name}: tie ${at} is ${gap.toFixed(2)} voxels after tie ${at - 1}`).toBeGreaterThanOrEqual(3);
        expect(gap, `${name}: tie ${at} is ${gap.toFixed(2)} voxels after tie ${at - 1}`).toBeLessThanOrEqual(5);
      }
      const wrap = (line.totalLength - arcs[arcs.length - 1] + arcs[0]) / voxel;
      expect(wrap, `${name}: the lap-closing gap`).toBeGreaterThanOrEqual(3);
      expect(wrap, `${name}: the lap-closing gap`).toBeLessThanOrEqual(5);
    }
  });

  it('measures the double tie: every corner exit puts two ties about 1.1 voxels apart (documents the finding above)', () => {
    let cornerExits = 0;
    let doubles = 0;
    for (const [, pieces] of CIRCUITS) {
      const line = centreLineFor(pieces);
      const arcs = tieArcs(pieces);
      for (let index = 0; index < line.pieceCount; index += 1) if (line.turn[index] !== 0) cornerExits += 1;
      for (let at = 1; at < arcs.length; at += 1) if ((arcs[at] - arcs[at - 1]) * 32 < 2) doubles += 1;
    }
    expect(cornerExits).toBeGreaterThan(500);
    // One double tie per corner (a corner's exit; the lap-closing corner's lands in the wrap, not counted here).
    expect(doubles).toBeGreaterThanOrEqual(cornerExits - CIRCUITS.length);
  });
});

describe('centre line review: loops', () => {
  it('rings every loop as a true circle of radius 16 in the vertical plane of travel, tangent-continuous at entry and exit, flat or on a ramp', () => {
    const sample = createCentreLineSample();
    const before = createCentreLineSample();
    const after = createCentreLineSample();
    let rings = 0;
    let ramped = 0;
    const angleBetween = (a: typeof before, b: typeof after): number => {
      const dot = a.tangentX * b.tangentX + a.tangentY * b.tangentY + a.tangentZ * b.tangentZ;
      const la = Math.hypot(a.tangentX, a.tangentY, a.tangentZ);
      const lb = Math.hypot(b.tangentX, b.tangentY, b.tangentZ);
      return Math.acos(Math.min(1, Math.max(-1, dot / (la * lb))));
    };
    for (const [name, pieces] of CIRCUITS) {
      const line = centreLineFor(pieces);
      for (let index = 0; index < line.pieceCount; index += 1) {
        if (line.loop[index] === 0) continue;
        rings += 1;
        const ringStart = line.tileStart[index] + line.tileLength[index];
        const ringEnd = line.tileStart[index + 1];
        expect(ringEnd - ringStart).toBeCloseTo(2 * Math.PI * CENTRE_LINE_LOOP_RADIUS, 9);
        sampleCentreLine(line, ringStart, sample);
        const base = { x: sample.x, y: sample.y, z: sample.z * COASTER_LEVEL_TILES, dirX: sample.dirX, dirY: sample.dirY };
        const pitch = line.ringEntryPitch[index];
        if (Math.abs(pitch) > 0.05) ramped += 1;
        const radius = CENTRE_LINE_LOOP_RADIUS;
        const centre = {
          x: base.x - base.dirX * radius * Math.sin(pitch),
          y: base.y - base.dirY * radius * Math.sin(pitch),
          z: base.z + radius * Math.cos(pitch),
        };
        for (let step = 1; step < 128; step += 1) {
          sampleCentreLine(line, ringStart + ((ringEnd - ringStart) * step) / 128, sample);
          const z = sample.z * COASTER_LEVEL_TILES;
          const distance = Math.hypot(sample.x - centre.x, sample.y - centre.y, z - centre.z);
          expect(distance, `${name} loop ${index} step ${step}: on the circle`).toBeCloseTo(radius, 9);
          // In the vertical plane of travel: no sideways offset from the base's plan line.
          const across = -(sample.x - base.x) * base.dirY + (sample.y - base.y) * base.dirX;
          expect(across, `${name} loop ${index} step ${step}: in the plane of travel`).toBeCloseTo(0, 9);
          expect(sample.ringAngle).toBeGreaterThan(0);
        }
        // Tangent continuity (the step-1 review's 27° kink): a sample just before the ring and just
        // inside it point the same way, within a quarter degree; the same where the ring rejoins.
        const epsilon = 1e-4;
        sampleCentreLine(line, ringStart - epsilon, before);
        sampleCentreLine(line, ringStart + epsilon, after);
        expect((angleBetween(before, after) * 180) / Math.PI, `${name} loop ${index}: entry kink (deg)`).toBeLessThan(0.25);
        sampleCentreLine(line, ringEnd - epsilon, before);
        sampleCentreLine(line, ringEnd + epsilon, after);
        expect((angleBetween(before, after) * 180) / Math.PI, `${name} loop ${index}: exit kink (deg)`).toBeLessThan(0.25);
        // Position continuity too.
        sampleCentreLine(line, ringEnd - epsilon, before);
        sampleCentreLine(line, ringEnd + epsilon, after);
        expect(Math.hypot(before.x - after.x, before.y - after.y, (before.z - after.z) * COASTER_LEVEL_TILES)).toBeLessThan(1e-3);
      }
    }
    expect(rings, 'rings checked').toBeGreaterThan(60);
    expect(ramped, 'rings on ramps checked').toBeGreaterThan(10);
  });
});
