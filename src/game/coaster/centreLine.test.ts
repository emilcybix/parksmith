import { describe, expect, it } from 'vitest';
import { COASTER_LEVEL_VOXELS, VOXELS_PER_TILE } from '../../rendering/voxel/contracts/space';
import {
  CENTRE_LINE_BANK_MAX,
  CENTRE_LINE_CORNER_RADIUS,
  CENTRE_LINE_HALF_GAUGE,
  CENTRE_LINE_LOOP_RADIUS,
  CENTRE_LINE_SUPPORT_ALONG,
  CENTRE_LINE_SUPPORT_HALF_SPAN,
  CENTRE_LINE_TIE_OFFSET,
  CENTRE_LINE_TIE_SPACING,
  COASTER_LEVEL_TILES,
  centreLineBankLift,
  centreLineChainedHalf,
  centreLineChainedSegments,
  centreLineFor,
  centreLineHeightAt,
  centreLineIndexToDistance,
  centreLineRollAt,
  centreLineRollInPiece,
  centreLineSegmentLength,
  centreLineSupportDistance,
  centreLineTieAlong,
  centreLineTieCount,
  createCentreLine,
  createCentreLineFrame,
  createCentreLineSample,
  createGroundHeight,
  createTileProjection,
  projectOntoTile,
  resampleCentreLineFrame,
  sampleCentreLine,
  sampleCentreLineFrame,
} from './centreLine';
import type { CentreLine, CentreLineFrame, CentreLineSample } from './centreLine';
import type { CoasterPiece } from './design';
import {
  HILL_DIP_HEIGHTS,
  HILL_DIP_MOVES,
  OVAL_HEIGHTS,
  OVAL_MOVES,
  ZIGZAG_HEIGHTS,
  ZIGZAG_MOVES,
  hillDipLayout,
  layoutFromMoves,
  longestLayout,
  loopOvalLayout,
  ovalLayout,
  randomCircuit,
  zigzagLayout,
} from './testLayouts';

const START = { x: 4, y: 4 };

/** A serpentine: a turn on every piece for a long stretch, left then right then left. */
const SERPENT_MOVES = `${'E'.repeat(4)}${'SE'.repeat(6)}${'S'.repeat(2)}${'W'.repeat(10)}${'N'.repeat(8)}`;
const SERPENT_HEIGHTS: readonly number[] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 1, 1, 0];
const serpentLayout = (): CoasterPiece[] => layoutFromMoves(START, SERPENT_MOVES, SERPENT_HEIGHTS);

/** A hairpin: two turns back to back (a U) at each end of a long straight oval. */
const UTURN_MOVES = `${'E'.repeat(6)}S${'W'.repeat(5)}S${'E'.repeat(5)}S${'W'.repeat(6)}${'N'.repeat(3)}`;

/** A tiny deterministic generator, so the random layouts are the same on every run. */
const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

/** The oval's cells with random heights 0 to 3 that change by at most one level per piece. */
const randomHeightOval = (seed: number): CoasterPiece[] => {
  const next = random(seed);
  const heights: number[] = [];
  let height = 0;
  for (let index = 0; index < OVAL_MOVES.length; index += 1) {
    const roll = next();
    if (index >= 3) height = Math.min(3, Math.max(0, height + (roll < 0.35 ? -1 : roll > 0.65 ? 1 : 0)));
    heights.push(index === OVAL_MOVES.length - 1 ? Math.min(height, 1) : height);
  }
  return layoutFromMoves(START, OVAL_MOVES, heights);
};

/** The oval with a loop on its climb (piece 3, height 1 between 0 and 2) and one on its drop (piece 10). */
const loopOnClimbLayout = (): CoasterPiece[] => layoutFromMoves(START, OVAL_MOVES, OVAL_HEIGHTS, { 3: 'loop' });
const loopOnDropLayout = (): CoasterPiece[] => layoutFromMoves(START, OVAL_MOVES, OVAL_HEIGHTS, { 10: 'loop' });

const LAYOUTS: ReadonlyArray<readonly [string, () => CoasterPiece[]]> = [
  ['oval', () => ovalLayout(START)],
  ['zig-zag', () => zigzagLayout(START)],
  ['hill and dip', () => hillDipLayout(START)],
  ['serpentine', serpentLayout],
  ['hairpins', () => layoutFromMoves(START, UTURN_MOVES, new Array<number>(UTURN_MOVES.length).fill(0))],
  ['loops and boost', () => loopOvalLayout(START)],
  ...[1, 2, 3, 4, 5, 6].map((seed): readonly [string, () => CoasterPiece[]] => [`random heights ${seed}`, () => randomHeightOval(seed)]),
  ['loop on a climb', loopOnClimbLayout],
  ['loop on a drop', loopOnDropLayout],
];

/** The layouts above plus the longest coaster and the first random circuits: 30 in all, the step-1 pin set. */
const PINNED_LAYOUTS = ((): ReadonlyArray<readonly [string, () => CoasterPiece[]]> => {
  const list: Array<readonly [string, () => CoasterPiece[]]> = [...LAYOUTS.slice(0, 6), ['longest', () => longestLayout()], ...LAYOUTS.slice(6, 12)];
  for (let seed = 1; list.length < 30 && seed < 500; seed += 1) {
    const layout = randomCircuit(seed, 4 + 2 * (seed % 22), 4 + (seed % 7));
    if (layout) list.push([`circuit ${seed}`, () => layout]);
  }
  return list;
})();

const norm3 = (x: number, y: number, z: number): number => Math.hypot(x, y, z);

const snapshot = (sample: CentreLineSample): CentreLineSample => ({ ...sample });

/** Every join of a layout: tile edges, and the start and end of each ring. */
const joinsOf = (line: CentreLine): number[] => {
  const joins: number[] = [];
  for (let index = 0; index <= line.pieceCount; index += 1) {
    joins.push(line.tileStart[index]);
    if (index < line.pieceCount && line.loop[index] === 1) joins.push(line.tileStart[index] + line.tileLength[index]);
  }
  return joins;
};

/** A ring's base M and its plan forward, from the loop piece's exit edge. */
const ringBase = (line: CentreLine, index: number): CentreLineSample =>
  sampleCentreLine(line, line.tileStart[index] + line.tileLength[index], createCentreLineSample());

describe('centre line constants', () => {
  it('agrees with the voxel space: a level is 13 of 32 voxels, a corner 16 voxels', () => {
    expect(COASTER_LEVEL_TILES).toBe(COASTER_LEVEL_VOXELS / VOXELS_PER_TILE);
    expect(CENTRE_LINE_CORNER_RADIUS * VOXELS_PER_TILE).toBe(16);
    expect(CENTRE_LINE_LOOP_RADIUS * VOXELS_PER_TILE).toBe(16);
  });
});

describe('centre line: lengths and shape', () => {
  it('is a straight tile long on a straight and a quarter circle of radius 1/2 on a turn', () => {
    const line = createCentreLine(ovalLayout(START));
    const pieces = ovalLayout(START);
    expect(line.pieceCount).toBe(24);
    let turns = 0;
    for (let index = 0; index < 24; index += 1) {
      const turning = line.turn[index] !== 0;
      if (turning) turns += 1;
      expect(line.tileLength[index]).toBeCloseTo(turning ? (Math.PI / 2) * 0.5 : 1, 12);
      expect(line.tileStart[index + 1] - line.tileStart[index]).toBeCloseTo(line.tileLength[index], 12);
      expect(pieces[index].cell.x).toBe(line.cellX[index]);
    }
    expect(turns).toBe(4);
    expect(line.totalLength).toBeCloseTo(20 + 4 * (Math.PI / 4), 10);
  });

  it('adds a ring circumference for each loop, and ignores a loop special on a turn', () => {
    const plain = createCentreLine(ovalLayout(START));
    const looped = createCentreLine(loopOvalLayout(START));
    expect(looped.loop[5]).toBe(1);
    expect(looped.loop[14]).toBe(1);
    expect(looped.totalLength - plain.totalLength).toBeCloseTo(2 * 2 * Math.PI * 0.5, 10);
    const onTurn = ovalLayout(START).map((piece, index) => (index === 8 ? { ...piece, special: 'loop' as const } : piece));
    expect(createCentreLine(onTurn).loop[8]).toBe(0);
    expect(createCentreLine(onTurn).totalLength).toBeCloseTo(plain.totalLength, 12);
  });

  it('keeps every plain sample inside its own tile, enters and leaves at edge midpoints, and keeps straights straight', () => {
    for (const [name, make] of LAYOUTS) {
      const pieces = make();
      const line = createCentreLine(pieces);
      const sample = createCentreLineSample();
      for (let index = 0; index < line.pieceCount; index += 1) {
        const length = line.tileLength[index];
        const start = line.tileStart[index];
        const cellX = line.cellX[index];
        const cellY = line.cellY[index];
        sampleCentreLine(line, start, sample);
        expect(sample.x, `${name} piece ${index} entry x`).toBeCloseTo(cellX + 0.5 - 0.5 * line.inX[index], 10);
        expect(sample.y, `${name} piece ${index} entry y`).toBeCloseTo(cellY + 0.5 - 0.5 * line.inY[index], 10);
        sampleCentreLine(line, start + length, sample);
        if (line.loop[index] === 0) {
          expect(sample.x, `${name} piece ${index} exit x`).toBeCloseTo(cellX + 0.5 + 0.5 * line.outX[index], 10);
          expect(sample.y, `${name} piece ${index} exit y`).toBeCloseTo(cellY + 0.5 + 0.5 * line.outY[index], 10);
        }
        for (let step = 0; step <= 40; step += 1) {
          sampleCentreLine(line, start + (length * step) / 40, sample);
          expect(sample.x).toBeGreaterThanOrEqual(cellX - 1e-9);
          expect(sample.x).toBeLessThanOrEqual(cellX + 1 + 1e-9);
          expect(sample.y).toBeGreaterThanOrEqual(cellY - 1e-9);
          expect(sample.y).toBeLessThanOrEqual(cellY + 1 + 1e-9);
          if (line.turn[index] === 0) {
            // Straight: the other coordinate never leaves the centre, the direction never changes.
            const across = line.inX[index] !== 0 ? sample.y - (cellY + 0.5) : sample.x - (cellX + 0.5);
            expect(Math.abs(across)).toBeLessThan(1e-12);
            expect(sample.dirX).toBe(line.inX[index]);
            expect(sample.dirY).toBe(line.inY[index]);
          }
        }
      }
    }
  });

  it('turns on a quarter circle of radius 1/2 around the tile corner, a quarter turn in all', () => {
    const line = createCentreLine(ovalLayout(START));
    const sample = createCentreLineSample();
    for (let index = 0; index < line.pieceCount; index += 1) {
      if (line.turn[index] === 0) continue;
      const cornerX = line.cellX[index] + 0.5 - 0.5 * line.inX[index] + 0.5 * line.outX[index];
      const cornerY = line.cellY[index] + 0.5 - 0.5 * line.inY[index] + 0.5 * line.outY[index];
      for (let step = 0; step <= 30; step += 1) {
        sampleCentreLine(line, line.tileStart[index] + (line.tileLength[index] * step) / 30, sample);
        expect(Math.hypot(sample.x - cornerX, sample.y - cornerY)).toBeCloseTo(0.5, 10);
        // The heading is perpendicular to the radius: it is a true circle.
        expect((sample.x - cornerX) * sample.dirX + (sample.y - cornerY) * sample.dirY).toBeCloseTo(0, 10);
      }
      sampleCentreLine(line, line.tileStart[index], sample);
      expect([sample.dirX, sample.dirY]).toEqual([line.inX[index], line.inY[index]]);
      sampleCentreLine(line, line.tileStart[index] + line.tileLength[index], sample);
      expect(sample.dirX).toBeCloseTo(line.outX[index], 12);
      expect(sample.dirY).toBeCloseTo(line.outY[index], 12);
    }
  });

  it('never lets the arcs of neighbouring zig-zag corners meet: each stays in its own tile', () => {
    const line = createCentreLine(zigzagLayout(START));
    const sample = createCentreLineSample();
    const owner = new Map<string, number>();
    for (let index = 0; index < line.pieceCount; index += 1) owner.set(`${line.cellX[index]},${line.cellY[index]}`, index);
    for (let step = 0; step < 4000; step += 1) {
      sampleCentreLine(line, (line.totalLength * step) / 4000, sample);
      const key = `${Math.min(Math.floor(sample.x), Math.floor(sample.x + 1e-9))},${Math.floor(sample.y + 1e-9)}`;
      const tile = owner.get(`${Math.floor(sample.x + 1e-9)},${Math.floor(sample.y + 1e-9)}`);
      expect(tile, key).toBeDefined();
    }
  });
});

describe('centre line: continuity', () => {
  it('is arc-length parameterised: unit plan speed on every tile, unit 3D speed on a ring', () => {
    const delta = 1e-4;
    for (const [name, make] of LAYOUTS) {
      const line = createCentreLine(make());
      const a = createCentreLineSample();
      const b = createCentreLineSample();
      for (let distance = 0; distance < line.totalLength; distance += 0.0137) {
        sampleCentreLine(line, distance, a);
        sampleCentreLine(line, distance + delta, b);
        if (a.ringAngle === 0 && b.ringAngle === 0 && a.piece === b.piece) {
          expect(Math.hypot(b.x - a.x, b.y - a.y) / delta, `${name} at ${distance}`).toBeCloseTo(1, 4);
        } else if (a.ringAngle > 0 && b.ringAngle > 0) {
          const speed = norm3(b.x - a.x, b.y - a.y, (b.z - a.z) * COASTER_LEVEL_TILES) / delta;
          expect(speed, `${name} ring at ${distance}`).toBeCloseTo(1, 4);
        }
      }
    }
  });

  it('has no jump in position or direction anywhere along any layout, joins and rings included', () => {
    const step = 0.002;
    for (const [name, make] of LAYOUTS) {
      const line = createCentreLine(make());
      const a = createCentreLineSample();
      const b = createCentreLineSample();
      let worst = 0;
      for (let distance = 0; distance < line.totalLength; distance += step) {
        sampleCentreLine(line, distance, a);
        sampleCentreLine(line, distance + step, b);
        const move = norm3(b.x - a.x, b.y - a.y, (b.z - a.z) * COASTER_LEVEL_TILES);
        // Plan speed is 1 on track (less on a ring); the climb adds at most a slope's worth.
        expect(Math.hypot(b.x - a.x, b.y - a.y), `${name} plan position at ${distance}`).toBeLessThanOrEqual(step * 1.00001);
        expect(move, `${name} position at ${distance}`).toBeLessThanOrEqual(step * 1.5);
        const dot = a.tangentX * b.tangentX + a.tangentY * b.tangentY + a.tangentZ * b.tangentZ;
        const turned = Math.acos(Math.min(1, Math.max(-1, dot)));
        worst = Math.max(worst, turned);
        // Curvature: 2 radians per tile on a corner (radius 1/2) and up to about 4 more of pitch change
        // where a one-level climb eases out, so a climbing corner turns at most about 4.5 rad/tile.
        expect(turned, `${name} direction at ${distance}`).toBeLessThanOrEqual(step * 5 + 1e-9);
      }
      expect(worst).toBeGreaterThan(0);
    }
  }, 20_000);

  it('matches position and tangent exactly across every join (tile edges, ring ends, the lap)', () => {
    const epsilon = 1e-9;
    for (const [name, make] of LAYOUTS) {
      const line = createCentreLine(make());
      const before = createCentreLineSample();
      const after = createCentreLineSample();
      const joins: number[] = [];
      for (let index = 0; index <= line.pieceCount; index += 1) {
        joins.push(line.tileStart[index]);
        if (index < line.pieceCount && line.loop[index] === 1) {
          joins.push(line.tileStart[index] + line.tileLength[index], line.tileStart[index + 1]);
        }
      }
      for (const join of joins) {
        sampleCentreLine(line, join - epsilon + (join === 0 ? line.totalLength : 0), before);
        sampleCentreLine(line, join + epsilon, after);
        expect(Math.abs(before.x - after.x), `${name} x at ${join}`).toBeLessThan(1e-7);
        expect(Math.abs(before.y - after.y), `${name} y at ${join}`).toBeLessThan(1e-7);
        expect(Math.abs(before.z - after.z), `${name} z at ${join}`).toBeLessThan(1e-7);
        expect(Math.abs(before.tangentX - after.tangentX), `${name} tx at ${join}`).toBeLessThan(1e-7);
        expect(Math.abs(before.tangentY - after.tangentY), `${name} ty at ${join}`).toBeLessThan(1e-7);
        expect(Math.abs(before.tangentZ - after.tangentZ), `${name} tz at ${join}`).toBeLessThan(1e-7);
      }
    }
  });

  it('closes: a lap ends where it began, with the same heading', () => {
    for (const [name, make] of LAYOUTS) {
      const line = createCentreLine(make());
      const start = snapshot(sampleCentreLine(line, 0, createCentreLineSample()));
      const end = sampleCentreLine(line, line.totalLength, createCentreLineSample());
      expect(end.x, name).toBeCloseTo(start.x, 10);
      expect(end.y, name).toBeCloseTo(start.y, 10);
      expect(end.z, name).toBeCloseTo(start.z, 10);
      expect(end.distance).toBeCloseTo(0, 10);
      const further = sampleCentreLine(line, line.totalLength * 3 + 0.3, createCentreLineSample());
      const near = sampleCentreLine(line, 0.3, createCentreLineSample());
      expect(further.x).toBeCloseTo(near.x, 8);
      expect(sampleCentreLine(line, -0.2, createCentreLineSample()).x)
        .toBeCloseTo(sampleCentreLine(line, line.totalLength - 0.2, createCentreLineSample()).x, 10);
    }
  });

  it('walks the whole layout as a connected chain of tiles, ring pieces aside', () => {
    // Joining exit to entry of consecutive pieces also proves the cells themselves chain up.
    const line = createCentreLine(zigzagLayout(START));
    const exit = createCentreLineSample();
    const entry = createCentreLineSample();
    for (let index = 0; index < line.pieceCount; index += 1) {
      const next = (index + 1) % line.pieceCount;
      sampleCentreLine(line, line.tileStart[index] + line.tileLength[index], exit);
      sampleCentreLine(line, line.tileStart[next === 0 ? line.pieceCount : next], entry);
      expect(Math.hypot(exit.x - entry.x, exit.y - entry.y)).toBeLessThan(1e-9);
    }
  });
});

describe('centre line: heights', () => {
  it('passes through each piece height at its tile centre, flat where heights are equal', () => {
    for (const [name, make] of LAYOUTS) {
      const pieces = make();
      const line = createCentreLine(pieces);
      const sample = createCentreLineSample();
      for (let index = 0; index < pieces.length; index += 1) {
        sampleCentreLine(line, line.centreDistance[index], sample);
        expect(sample.z, `${name} piece ${index}`).toBeCloseTo(pieces[index].height, 10);
        const next = pieces[(index + 1) % pieces.length].height;
        if (next === pieces[index].height) {
          for (let step = 0; step <= 8; step += 1) {
            sampleCentreLine(line, line.centreDistance[index] + (centreLineSegmentLength(line, index) * step) / 8, sample);
            if (sample.ringAngle === 0) expect(sample.z, `${name} flat segment ${index}`).toBeCloseTo(next, 10);
          }
        }
      }
    }
  });

  it('never overshoots: between two pieces the line stays between their heights, so crests and dips round off', () => {
    for (const [name, make] of LAYOUTS) {
      const pieces = make();
      const line = createCentreLine(pieces);
      const height = createGroundHeight();
      for (let index = 0; index < pieces.length; index += 1) {
        const low = Math.min(pieces[index].height, pieces[(index + 1) % pieces.length].height);
        const high = Math.max(pieces[index].height, pieces[(index + 1) % pieces.length].height);
        const from = line.nodeGround[index];
        const to = line.nodeGround[index + 1];
        for (let step = 0; step <= 20; step += 1) {
          centreLineHeightAt(line, from + ((to - from) * step) / 20, height);
          expect(height.z, `${name} segment ${index}`).toBeGreaterThanOrEqual(low - 1e-9);
          expect(height.z, `${name} segment ${index}`).toBeLessThanOrEqual(high + 1e-9);
        }
      }
    }
  });

  it('has zero slope exactly at crests, dips and the flat station, and a steady slope on a long climb', () => {
    const pieces = hillDipLayout(START);
    const line = createCentreLine(pieces);
    const height = createGroundHeight();
    for (let index = 0; index < pieces.length; index += 1) {
      const previous = pieces[(index - 1 + pieces.length) % pieces.length].height;
      const next = pieces[(index + 1) % pieces.length].height;
      const here = pieces[index].height;
      centreLineHeightAt(line, line.nodeGround[index], height);
      const extreme = (here >= previous && here >= next) || (here <= previous && here <= next);
      if (extreme) expect(height.slope, `piece ${index}`).toBe(0);
      else expect(Math.sign(height.slope), `piece ${index}`).toBe(Math.sign(next - previous));
    }
    // 0,1,2,3 in a row: the middle pieces climb at the same slope as a straight ramp, one level per tile.
    const ramp = layoutFromMoves(START, OVAL_MOVES, [0, 0, 0, 1, 2, 3, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const rampLine = createCentreLine(ramp);
    centreLineHeightAt(rampLine, rampLine.nodeGround[4], height);
    expect(height.slope).toBeCloseTo(1, 6);
  });

  it('keeps the slope continuous (the height has no kink) across tile edges for every height 0 to 3 transition', () => {
    for (const [name, make] of LAYOUTS) {
      const line = createCentreLine(make());
      const a = createGroundHeight();
      const b = createGroundHeight();
      for (let index = 0; index <= line.pieceCount; index += 1) {
        const edge = line.groundStart[index];
        centreLineHeightAt(line, edge - 1e-9, a);
        centreLineHeightAt(line, edge + 1e-9, b);
        expect(Math.abs(a.z - b.z), name).toBeLessThan(1e-7);
        expect(Math.abs(a.slope - b.slope), name).toBeLessThan(1e-6);
      }
    }
  });

  it('is deterministic: the same layout gives the same samples', () => {
    const a = createCentreLine(zigzagLayout(START));
    const b = createCentreLine(zigzagLayout(START));
    const left = createCentreLineSample();
    const right = createCentreLineSample();
    for (let distance = 0; distance < a.totalLength; distance += 0.31) {
      expect(sampleCentreLine(a, distance, left)).toEqual(sampleCentreLine(b, distance, right));
    }
  });
});

describe('centre line: loops', () => {
  it('runs once round a vertical ring of radius 1/2 in the plane of travel, back to the base', () => {
    const line = createCentreLine(loopOvalLayout(START));
    const sample = createCentreLineSample();
    const base = createCentreLineSample();
    sampleCentreLine(line, line.tileStart[5] + line.tileLength[5], base);
    const baseZ = base.z;
    let top = -Infinity;
    for (let step = 0; step < 64; step += 1) {
      sampleCentreLine(line, line.tileStart[5] + line.tileLength[5] + (Math.PI * step) / 64, sample);
      expect(sample.ringAngle).toBeCloseTo((2 * Math.PI * step) / 64, 8);
      // On the circle of radius 1/2 centred a radius above the base, in the vertical plane.
      const along = (sample.x - base.x) * base.dirX + (sample.y - base.y) * base.dirY;
      const across = (sample.x - base.x) * -base.dirY + (sample.y - base.y) * base.dirX;
      const up = (sample.z - baseZ) * COASTER_LEVEL_TILES - 0.5;
      expect(Math.abs(across)).toBeLessThan(1e-9);
      expect(Math.hypot(along, up)).toBeCloseTo(0.5, 8);
      top = Math.max(top, sample.z);
    }
    expect(top - baseZ).toBeCloseTo(1 / COASTER_LEVEL_TILES, 6);
    sampleCentreLine(line, line.tileStart[6], sample);
    expect(Math.hypot(sample.x - base.x, sample.y - base.y)).toBeLessThan(1e-9);
    expect(sample.z).toBeCloseTo(baseZ, 9);
  });

  it('pitches the nose a full turn, upside down over the top, with no snap at either end', () => {
    const line = createCentreLine(loopOvalLayout(START));
    const sample = createCentreLineSample();
    const ringStart = line.tileStart[14] + line.tileLength[14];
    sampleCentreLine(line, ringStart + Math.PI / 2, sample);
    expect(sample.pitch).toBeCloseTo(Math.PI, 1);
    expect(sample.tangentX * sample.dirX + sample.tangentY * sample.dirY).toBeLessThan(-0.9);
    const before = createCentreLineSample();
    sampleCentreLine(line, ringStart - 1e-9, before);
    sampleCentreLine(line, ringStart + 1e-9, sample);
    expect(Math.abs(before.pitch - sample.pitch)).toBeLessThan(1e-6);
    const end = ringStart + Math.PI;
    sampleCentreLine(line, end - 1e-9, before);
    sampleCentreLine(line, end + 1e-9, sample);
    expect(Math.abs(before.pitch - 2 * Math.PI - sample.pitch)).toBeLessThan(1e-6);
  });
});

describe('centre line: timing map', () => {
  it('maps a fractional piece index to arc length linearly inside a segment and monotonically overall', () => {
    for (const [name, make] of LAYOUTS) {
      const line = createCentreLine(make());
      const count = line.pieceCount;
      let previous = -Infinity;
      for (let step = 0; step < count * 20; step += 1) {
        const distance = centreLineIndexToDistance(line, step / 20);
        expect(distance, name).toBeGreaterThanOrEqual(previous);
        previous = distance;
      }
      for (let index = 0; index < count; index += 1) {
        expect(centreLineIndexToDistance(line, index)).toBeCloseTo(line.centreDistance[index], 10);
        const half = centreLineIndexToDistance(line, index + 0.5);
        expect(half).toBeCloseTo(line.centreDistance[index] + centreLineSegmentLength(line, index) / 2, 10);
      }
      // A lap of the index is exactly one lap of arc length; an unwrapped index wraps.
      expect(centreLineIndexToDistance(line, count - 1e-9)).toBeCloseTo(line.centreDistance[0] + line.totalLength, 6);
      expect(centreLineIndexToDistance(line, count)).toBeCloseTo(line.centreDistance[0], 10);
      expect(centreLineIndexToDistance(line, count + 2.3)).toBeCloseTo(centreLineIndexToDistance(line, 2.3), 10);
    }
  });

  it('puts the centre of each tile at its own piece index', () => {
    const line = createCentreLine(ovalLayout(START));
    const sample = createCentreLineSample();
    for (let index = 0; index < line.pieceCount; index += 1) {
      sampleCentreLine(line, centreLineIndexToDistance(line, index), sample);
      expect(sample.piece).toBe(index);
      const local = (line.turn[index] === 0 ? 0.5 : (Math.PI / 4) / 2);
      expect(sample.distance - line.tileStart[index]).toBeCloseTo(local, 10);
    }
  });

  it('survives a non-finite index and an empty layout', () => {
    const line = createCentreLine(ovalLayout(START));
    expect(centreLineIndexToDistance(line, Number.NaN)).toBe(0);
    expect(centreLineIndexToDistance(createCentreLine([]), 3)).toBe(0);
    const sample = sampleCentreLine(createCentreLine([]), 4, createCentreLineSample());
    expect([sample.x, sample.y, sample.z]).toEqual([0, 0, 0]);
    expect(Number.isFinite(sampleCentreLine(line, Number.NaN, createCentreLineSample()).x)).toBe(true);
  });
});

describe('centre line: tile projection', () => {
  it('agrees with the sampler: a point on the line projects onto its own arc length with no offset', () => {
    const line = createCentreLine(zigzagLayout(START));
    const sample = createCentreLineSample();
    const projection = createTileProjection();
    for (let index = 0; index < line.pieceCount; index += 1) {
      for (let step = 1; step < 12; step += 1) {
        const g = (line.tileLength[index] * step) / 12;
        sampleCentreLine(line, line.tileStart[index] + g, sample);
        projectOntoTile(line, index, sample.x - line.cellX[index], sample.y - line.cellY[index], projection);
        expect(projection.along, `piece ${index}`).toBeCloseTo(g, 9);
        expect(projection.offset, `piece ${index}`).toBeCloseTo(0, 9);
      }
    }
  });

  it('signs the offset: positive on the outside of a turn', () => {
    const line = createCentreLine(ovalLayout(START));
    const projection = createTileProjection();
    for (let index = 0; index < line.pieceCount; index += 1) {
      if (line.turn[index] === 0) continue;
      // The tile corner the turn goes round is the inside of the arc, the opposite corner the outside.
      const cornerX = 0.5 - 0.5 * line.inX[index] + 0.5 * line.outX[index];
      const cornerY = 0.5 - 0.5 * line.inY[index] + 0.5 * line.outY[index];
      projectOntoTile(line, index, cornerX, cornerY, projection);
      expect(projection.offset).toBeLessThan(0);
      projectOntoTile(line, index, 1 - cornerX, 1 - cornerY, projection);
      expect(projection.offset).toBeGreaterThan(0);
    }
  });
});

describe('centre line: cache and malformed layouts', () => {
  it('returns the same line for the same layout and a new one when an array is edited in place', () => {
    const pieces = ovalLayout(START);
    const first = centreLineFor(pieces);
    expect(centreLineFor(pieces)).toBe(first);
    expect(centreLineFor(ovalLayout(START))).not.toBe(first);
    pieces[6] = { ...pieces[6], height: 3 };
    const edited = centreLineFor(pieces);
    expect(edited).not.toBe(first);
    expect(edited.nodeHeight[6]).toBe(3);
    pieces.push({ cell: { x: 0, y: 0 }, height: 0 });
    expect(centreLineFor(pieces).pieceCount).toBe(25);
  });

  it('never produces NaN for empty, single-piece, gapped, U-turning or duplicated layouts', () => {
    const malformed: CoasterPiece[][] = [
      [],
      [{ cell: { x: 3, y: 3 }, height: 0 }],
      [{ cell: { x: 3, y: 3 }, height: 1 }, { cell: { x: 3, y: 3 }, height: 2 }],
      [{ cell: { x: 0, y: 0 }, height: 0 }, { cell: { x: 5, y: 0 }, height: 1 }, { cell: { x: 5, y: 7 }, height: 3 }],
      [{ cell: { x: 0, y: 0 }, height: 0 }, { cell: { x: 1, y: 0 }, height: 1 }, { cell: { x: 0, y: 0 }, height: 2 },
        { cell: { x: 1, y: 0 }, height: 0, special: 'loop' }],
    ];
    for (const pieces of malformed) {
      const line: CentreLine = createCentreLine(pieces);
      const sample = createCentreLineSample();
      for (let step = 0; step <= 50; step += 1) {
        sampleCentreLine(line, (line.totalLength * step) / 50, sample);
        for (const value of [sample.x, sample.y, sample.z, sample.pitch, sample.tangentX, sample.tangentY, sample.tangentZ]) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });

  it('exports the layout helpers the other tests share', () => {
    expect(OVAL_HEIGHTS).toHaveLength(OVAL_MOVES.length);
    expect(ZIGZAG_HEIGHTS).toHaveLength(ZIGZAG_MOVES.length);
    expect(HILL_DIP_HEIGHTS).toHaveLength(HILL_DIP_MOVES.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 27 step 2: the line's position is pinned to step 1, and the frame, banking, round loops and
// the chain are built on top of it.

/** FNV-1a over the samples rounded to 1e-7, so a last-ulp difference between Math implementations cannot move a hash. */
const fnv = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};
const rounded = (value: number): string => (Math.round(value * 1e7) / 1e7).toFixed(7);

/**
 * 1,000 samples per pinned layout (x, y, z, tangent, pitch at k / 1000 of the lap), hashed, as
 * captured from the step-1 sampler before any of step 2 existed: `off` covers every sample off a
 * ring, `ring` the samples on rings. `ringAsStep1` says whether the ring hash is the step-1 one: it
 * is wherever a ring sits on a flat run (the shared `loops and boost` fixture, circuits 4 and 10);
 * on a ramp the ring is rotated by the step-2 design and its new hash is pinned instead.
 */
const STEP1_SAMPLE_HASHES: ReadonlyArray<readonly [string, string, string, number, boolean]> = [
  ['oval', '9ca48483', '811c9dc5', 0, true],
  ['zig-zag', '57c1c1bb', '811c9dc5', 0, true],
  ['hill and dip', 'd21dc502', '811c9dc5', 0, true],
  ['serpentine', '259b731a', '811c9dc5', 0, true],
  ['hairpins', 'c42802a7', '811c9dc5', 0, true],
  ['loops and boost', '5a83442a', 'b2672eb0', 214, true],
  ['longest', 'ee015c8d', '811c9dc5', 0, true],
  ['random heights 1', '8ee47f82', '811c9dc5', 0, true],
  ['random heights 2', 'd8fe6bdd', '811c9dc5', 0, true],
  ['random heights 3', '93eccc5f', '811c9dc5', 0, true],
  ['random heights 4', 'bbea0a4a', '811c9dc5', 0, true],
  ['random heights 5', 'cc2aeb31', '811c9dc5', 0, true],
  ['random heights 6', 'd243cd38', '811c9dc5', 0, true],
  ['circuit 1', 'fadfe29a', '811c9dc5', 0, true],
  ['circuit 2', '1dc5d0a5', '811c9dc5', 0, true],
  ['circuit 3', '5ac12447', '811c9dc5', 0, true],
  ['circuit 4', '5676658c', '4f4ae880', 235, true],
  ['circuit 5', 'c1a50e80', 'ff656354', 425, false],
  ['circuit 6', 'cc745557', '811c9dc5', 0, true],
  ['circuit 8', '9833ccbe', '5a8a9f80', 265, false],
  ['circuit 9', '641f9afb', '5ca4feff', 330, false],
  ['circuit 10', 'bc5d1239', '89096672', 364, true],
  ['circuit 11', '900deaad', 'fcd5da7e', 291, false],
  ['circuit 12', '348fb41c', '4aa17d42', 277, false],
  ['circuit 13', '77dcbf6e', '1648f547', 325, false],
  ['circuit 22', '9061272e', '811c9dc5', 0, true],
  ['circuit 23', '015f92ac', '811c9dc5', 0, true],
  ['circuit 24', 'a5fafb71', '1121cfd5', 305, false],
  ['circuit 25', '5a8a815e', '811c9dc5', 0, true],
  ['circuit 26', '2ac8c3ad', '28e8d3c3', 369, false],
];

describe('centre line: step-1 positions are pinned', () => {
  it('samples 1,000 points per shared fixture exactly as step 1 did, off rings and on flat rings; ramped rings are pinned to the step-2 circle', () => {
    expect(PINNED_LAYOUTS.map(([name]) => name)).toEqual(STEP1_SAMPLE_HASHES.map(([name]) => name));
    const sample = createCentreLineSample();
    let rotated = 0;
    for (const [name, make] of PINNED_LAYOUTS) {
      const pinned = STEP1_SAMPLE_HASHES.find(([pinnedName]) => pinnedName === name)!;
      const line = createCentreLine(make());
      let off = '';
      let ring = '';
      let ringCount = 0;
      for (let k = 0; k < 1000; k += 1) {
        sampleCentreLine(line, (line.totalLength * k) / 1000, sample);
        const row = `${k}:${rounded(sample.x)},${rounded(sample.y)},${rounded(sample.z)},${rounded(sample.tangentX)},${rounded(sample.tangentY)},${rounded(sample.tangentZ)},${rounded(sample.pitch)};`;
        if (sample.ringAngle === 0) off += row;
        else { ring += row; ringCount += 1; }
      }
      expect(fnv(off), `${name}: samples off rings`).toBe(pinned[1]);
      expect(ringCount, `${name}: samples on rings`).toBe(pinned[3]);
      expect(fnv(ring), `${name}: samples on rings`).toBe(pinned[2]);
      if (!pinned[4]) rotated += 1;
    }
    expect(rotated, 'ramped rings exercised').toBeGreaterThanOrEqual(8);
  });

  it('keeps the timing map and the lengths of step 1 (the index map is untouched)', () => {
    for (const [name, make] of PINNED_LAYOUTS) {
      const line = createCentreLine(make());
      for (let index = 0; index < line.pieceCount; index += 1) {
        expect(centreLineIndexToDistance(line, index), name).toBeCloseTo(line.tileStart[index] + line.tileLength[index] / 2, 12);
        expect(centreLineSegmentLength(line, index), name)
          .toBeCloseTo((line.tileLength[index] + line.tileLength[(index + 1) % line.pieceCount]) / 2 + (line.loop[index] ? 2 * Math.PI * CENTRE_LINE_LOOP_RADIUS : 0), 12);
      }
    }
  });
});

describe('centre line: banking roll', () => {
  it('is exactly zero on every straight piece (so on the straight station), on every ring, and bounded by the cap', () => {
    let straightStations = 0;
    for (const [name, make] of LAYOUTS) {
      const line = createCentreLine(make());
      for (let index = 0; index < line.pieceCount; index += 1) {
        // Station pieces 1 and 2 are straight by validation; piece 0 may be the lap's closing corner (the oval's is).
        if (index === 1 || index === 2) {
          expect(line.turn[index], `${name} station piece ${index}`).toBe(0);
          straightStations += 1;
        }
        for (let step = 0; step <= 16; step += 1) {
          const along = (line.tileLength[index] * step) / 16;
          const roll = centreLineRollInPiece(line, index, along);
          if (line.turn[index] === 0) expect(roll, `${name} piece ${index}`).toBe(0);
          expect(Math.abs(roll), `${name} piece ${index}`).toBeLessThanOrEqual(CENTRE_LINE_BANK_MAX);
        }
        if (line.loop[index] === 1) {
          const ringStart = line.tileStart[index] + line.tileLength[index];
          for (let step = 1; step < 32; step += 1) {
            expect(centreLineRollAt(line, ringStart + (Math.PI * step) / 32), `${name} ring ${index}`).toBe(0);
          }
        }
      }
    }
    expect(straightStations).toBe(LAYOUTS.length * 2);
  });

  it('is a raised cosine over a corner: zero at both edges with zero slope, the cap at the apex, continuous with the straights', () => {
    const line = createCentreLine(ovalLayout(START));
    for (let index = 0; index < line.pieceCount; index += 1) {
      if (line.turn[index] === 0) continue;
      const length = line.tileLength[index];
      expect(centreLineRollInPiece(line, index, 0)).toBe(0);
      expect(Math.abs(centreLineRollInPiece(line, index, length))).toBeLessThan(1e-12);
      expect(Math.abs(centreLineRollInPiece(line, index, length / 2))).toBeCloseTo(CENTRE_LINE_BANK_MAX, 12);
      expect(Math.abs(centreLineRollInPiece(line, index, 1e-4)), 'zero slope at the entry').toBeLessThan(1e-6);
      expect(Math.abs(centreLineRollInPiece(line, index, length - 1e-4)), 'zero slope at the exit').toBeLessThan(1e-6);
      let previous = 0;
      for (let step = 1; step <= 32; step += 1) {
        const roll = Math.abs(centreLineRollInPiece(line, index, (length * step) / 32));
        if (step <= 16) expect(roll).toBeGreaterThanOrEqual(previous);
        else expect(roll).toBeLessThanOrEqual(previous);
        previous = roll;
      }
      // Across the edges: the roll at the end of the straight before and the start of the corner agree (both 0).
      expect(centreLineRollAt(line, line.tileStart[index] - 1e-9)).toBe(0);
      expect(Math.abs(centreLineRollAt(line, line.tileStart[index] + 1e-9))).toBeLessThan(1e-12);
    }
  });

  it('agrees between the arc-length and the piece-local form, wrapping any distance', () => {
    for (const [name, make] of LAYOUTS) {
      const line = createCentreLine(make());
      const sample = createCentreLineSample();
      for (let distance = 0; distance < line.totalLength; distance += 0.0173) {
        sampleCentreLine(line, distance, sample);
        const expected = sample.ringAngle > 0 ? 0 : centreLineRollInPiece(line, sample.piece, sample.along);
        expect(centreLineRollAt(line, distance), `${name} at ${distance}`).toBe(expected);
        expect(centreLineRollAt(line, distance + line.totalLength * 2), `${name} wrapped at ${distance}`).toBeCloseTo(expected, 9);
        expect(centreLineRollAt(line, distance - line.totalLength), `${name} negative at ${distance}`).toBeCloseTo(expected, 9);
      }
    }
    expect(centreLineRollAt(createCentreLine([]), 3)).toBe(0);
    expect(centreLineRollAt(createCentreLine(ovalLayout(START)), Number.NaN)).toBe(0);
  });

  it('lifts the outer rail on both turn signs and both axes, and mirrors to the opposite roll on a mirrored layout', () => {
    const layouts: Array<[string, CoasterPiece[]]> = [
      ['oval', ovalLayout(START)],
      ['mirrored oval', ovalLayout(START).map((piece) => ({ ...piece, cell: { x: -piece.cell.x, y: piece.cell.y } }))],
      ['zig-zag', zigzagLayout(START)],
      ['transposed zig-zag', zigzagLayout(START).map((piece) => ({ ...piece, cell: { x: piece.cell.y, y: piece.cell.x } }))],
    ];
    const frame = createCentreLineFrame();
    const checked = { left: 0, right: 0, alongX: 0, alongY: 0 };
    for (const [name, pieces] of layouts) {
      const line = createCentreLine(pieces);
      for (let index = 0; index < line.pieceCount; index += 1) {
        if (line.turn[index] === 0) continue;
        const cornerX = line.cellX[index] + 0.5 - 0.5 * line.inX[index] + 0.5 * line.outX[index];
        const cornerY = line.cellY[index] + 0.5 - 0.5 * line.inY[index] + 0.5 * line.outY[index];
        sampleCentreLineFrame(line, line.tileStart[index] + line.tileLength[index] / 2, frame);
        expect(Math.abs(frame.roll)).toBeCloseTo(CENTRE_LINE_BANK_MAX, 12);
        const gauge = CENTRE_LINE_HALF_GAUGE;
        const leftDistance = Math.hypot(frame.x + gauge * frame.normalX - cornerX, frame.y + gauge * frame.normalY - cornerY);
        const rightDistance = Math.hypot(frame.x - gauge * frame.normalX - cornerX, frame.y - gauge * frame.normalY - cornerY);
        const leftLift = gauge * frame.normalZ;
        const rightLift = -gauge * frame.normalZ;
        const outerLift = leftDistance > rightDistance ? leftLift : rightLift;
        const innerLift = leftDistance > rightDistance ? rightLift : leftLift;
        expect(outerLift, `${name} piece ${index}: the outer rail is up`).toBeGreaterThan(innerLift + 0.02);
        // The rail point rises gauge · sin(roll) (times cos(pitch) on a slope); the voxel columns use tan(roll) at a fixed across offset.
        expect(outerLift, `${name} piece ${index}: by the roll`).toBeCloseTo(Math.abs(gauge * Math.sin(frame.roll) * Math.cos(frame.pitch)), 12);
        expect(Math.abs(centreLineBankLift(gauge, frame.roll)), `${name} piece ${index}: the column formula`).toBeCloseTo(gauge * Math.tan(CENTRE_LINE_BANK_MAX), 12);
        // Position is untouched by the roll: the frame samples where the plain sampler does.
        const plain = sampleCentreLine(line, frame.distance, createCentreLineSample());
        expect([frame.x, frame.y, frame.z]).toEqual([plain.x, plain.y, plain.z]);
        if (line.turn[index] > 0) checked.left += 1; else checked.right += 1;
        if (line.inX[index] !== 0) checked.alongX += 1; else checked.alongY += 1;
      }
    }
    expect(checked.left).toBeGreaterThan(4);
    expect(checked.right).toBeGreaterThan(4);
    expect(checked.alongX).toBeGreaterThan(4);
    expect(checked.alongY).toBeGreaterThan(4);
    // Mirror symmetry: the same corner mirrored in x rolls the other way at every point.
    const line = createCentreLine(layouts[0][1]);
    const mirrored = createCentreLine(layouts[1][1]);
    for (let index = 0; index < line.pieceCount; index += 1) {
      for (let step = 0; step <= 8; step += 1) {
        const along = (line.tileLength[index] * step) / 8;
        expect(centreLineRollInPiece(mirrored, index, along)).toBeCloseTo(-centreLineRollInPiece(line, index, along), 12);
      }
    }
  });

  it('turns an across offset into a rail lift of across · tan(roll)', () => {
    expect(centreLineBankLift(CENTRE_LINE_HALF_GAUGE, 0)).toBe(0);
    expect(centreLineBankLift(3 / 32, 0.45)).toBeCloseTo((3 / 32) * Math.tan(0.45), 15);
    expect(centreLineBankLift(-3 / 32, 0.45)).toBeCloseTo(-centreLineBankLift(3 / 32, 0.45), 15);
    // At the apex the rails at ±3 voxels land 1.45 voxels up and down: 1 to 2 voxels once rounded.
    expect(Math.abs(centreLineBankLift(3 / 32, CENTRE_LINE_BANK_MAX) * 32)).toBeCloseTo(1.449, 2);
  });
});

describe('centre line: cross-section frame', () => {
  const expectFrameSane = (frame: CentreLineFrame, label: string): void => {
    expect(norm3(frame.normalX, frame.normalY, frame.normalZ), `${label} N unit`).toBeCloseTo(1, 9);
    expect(norm3(frame.upX, frame.upY, frame.upZ), `${label} B unit`).toBeCloseTo(1, 9);
    expect(norm3(frame.tangentX, frame.tangentY, frame.tangentZ), `${label} T unit`).toBeCloseTo(1, 9);
    expect(frame.normalX * frame.tangentX + frame.normalY * frame.tangentY + frame.normalZ * frame.tangentZ, `${label} N ⊥ T`).toBeCloseTo(0, 9);
    expect(frame.upX * frame.tangentX + frame.upY * frame.tangentY + frame.upZ * frame.tangentZ, `${label} B ⊥ T`).toBeCloseTo(0, 9);
    expect(frame.upX * frame.normalX + frame.upY * frame.normalY + frame.upZ * frame.normalZ, `${label} B ⊥ N`).toBeCloseTo(0, 9);
    // B = T × N (right-handed: on flat track, forward × left = up).
    expect(frame.upX, `${label} B = T × N`).toBeCloseTo(frame.tangentY * frame.normalZ - frame.tangentZ * frame.normalY, 9);
    expect(frame.upY, `${label} B = T × N`).toBeCloseTo(frame.tangentZ * frame.normalX - frame.tangentX * frame.normalZ, 9);
    expect(frame.upZ, `${label} B = T × N`).toBeCloseTo(frame.tangentX * frame.normalY - frame.tangentY * frame.normalX, 9);
  };

  it('is orthonormal and right-handed everywhere, up on flat track, left of travel on straights', () => {
    const frame = createCentreLineFrame();
    for (const [name, make] of [...LAYOUTS, ['longest', () => longestLayout()] as const]) {
      const line = createCentreLine(make());
      for (let distance = 0; distance < line.totalLength; distance += 0.0137) {
        sampleCentreLineFrame(line, distance, frame);
        expectFrameSane(frame, `${name} at ${distance}`);
        if (frame.ringAngle === 0 && line.turn[frame.piece] === 0) {
          expect(frame.roll).toBe(0);
          expect(frame.normalX).toBeCloseTo(-frame.dirY, 12);
          expect(frame.normalY).toBeCloseTo(frame.dirX, 12);
          expect(frame.normalZ).toBeCloseTo(0, 12);
          expect(frame.upZ).toBeCloseTo(Math.cos(frame.pitch), 12);
          if (frame.pitch === 0) {
            expect(frame.upX).toBeCloseTo(0, 12);
            expect(frame.upY).toBeCloseTo(0, 12);
            expect(frame.upZ).toBe(1);
          }
        }
      }
    }
  }, 20_000);

  it('is a superset of the sample: the same position, tangent, piece and distance as sampleCentreLine', () => {
    const frame = createCentreLineFrame();
    const sample = createCentreLineSample();
    const line = createCentreLine(loopOnClimbLayout());
    for (let distance = -3; distance < line.totalLength * 2; distance += 0.3141) {
      sampleCentreLineFrame(line, distance, frame);
      sampleCentreLine(line, distance, sample);
      for (const key of Object.keys(sample) as Array<keyof CentreLineSample>) expect(frame[key], key).toBe(sample[key]);
      frame.distance = distance;
      resampleCentreLineFrame(line, frame);
      expect(frame.x).toBe(sample.x);
      expect(frame.upZ).toBeCloseTo(Math.cos(frame.pitch) * Math.cos(frame.roll), 12);
    }
    const empty = sampleCentreLineFrame(createCentreLine([]), 2, createCentreLineFrame());
    expect([empty.normalX, empty.normalY, empty.normalZ, empty.upX, empty.upY, empty.upZ, empty.roll].map((value) => value + 0)).toEqual([0, 1, 0, 0, 0, 1, 0]);
  });

  it('is continuous across every join and ring end, and turns no faster than the curvature allows', () => {
    const step = 1 / 64;
    // A corner turns 2 rad per tile, a ring 2 rad per tile, a climb eases out at up to about 3 more,
    // and the roll changes at up to BANK_MAX · π / tileLength = 1.8 rad per tile: 0.11 per 1/64 step.
    const perStep = 0.12;
    const a = createCentreLineFrame();
    const b = createCentreLineFrame();
    const fixtures = [...LAYOUTS, ['longest', () => longestLayout()] as const, ...PINNED_LAYOUTS.filter(([name]) => name.startsWith('circuit'))];
    for (const [name, make] of fixtures) {
      const line = createCentreLine(make());
      for (const join of joinsOf(line)) {
        sampleCentreLineFrame(line, join - 1e-9 + (join === 0 ? line.totalLength : 0), a);
        sampleCentreLineFrame(line, join + 1e-9, b);
        expect(norm3(b.x - a.x, b.y - a.y, (b.z - a.z) * COASTER_LEVEL_TILES), `${name} position at join ${join}`).toBeLessThan(1e-6);
        expect(norm3(b.tangentX - a.tangentX, b.tangentY - a.tangentY, b.tangentZ - a.tangentZ), `${name} T at join ${join}`).toBeLessThan(1e-6);
        expect(norm3(b.normalX - a.normalX, b.normalY - a.normalY, b.normalZ - a.normalZ), `${name} N at join ${join}`).toBeLessThan(1e-6);
        expect(norm3(b.upX - a.upX, b.upY - a.upY, b.upZ - a.upZ), `${name} B at join ${join}`).toBeLessThan(1e-6);
        expect(Math.abs(b.roll - a.roll), `${name} roll at join ${join}`).toBeLessThan(1e-6);
      }
      for (let distance = 0; distance < line.totalLength; distance += step) {
        sampleCentreLineFrame(line, distance, a);
        sampleCentreLineFrame(line, distance + step, b);
        expectFrameSane(a, `${name} at ${distance}`);
        expect(norm3(b.tangentX - a.tangentX, b.tangentY - a.tangentY, b.tangentZ - a.tangentZ), `${name} T step at ${distance}`).toBeLessThan(perStep);
        expect(norm3(b.normalX - a.normalX, b.normalY - a.normalY, b.normalZ - a.normalZ), `${name} N step at ${distance}`).toBeLessThan(perStep);
        expect(norm3(b.upX - a.upX, b.upY - a.upY, b.upZ - a.upZ), `${name} B step at ${distance}`).toBeLessThan(perStep);
      }
    }
  }, 20_000);

  it('keeps the normal as the ring axis all the way round a loop, with the up pointing at the ring centre', () => {
    const frame = createCentreLineFrame();
    for (const make of [loopOvalLayout.bind(null, START), loopOnClimbLayout, loopOnDropLayout]) {
      const line = createCentreLine(make());
      for (let index = 0; index < line.pieceCount; index += 1) {
        if (line.loop[index] === 0) continue;
        const base = ringBase(line, index);
        const alpha = line.ringEntryPitch[index];
        const centreAlong = -CENTRE_LINE_LOOP_RADIUS * Math.sin(alpha);
        const centreUp = CENTRE_LINE_LOOP_RADIUS * Math.cos(alpha);
        for (let step = 0; step < 48; step += 1) {
          sampleCentreLineFrame(line, line.tileStart[index] + line.tileLength[index] + (Math.PI * step) / 48, frame);
          expect(frame.normalX).toBeCloseTo(-base.dirY, 12);
          expect(frame.normalY).toBeCloseTo(base.dirX, 12);
          expect(frame.normalZ).toBeCloseTo(0, 12);
          expect(frame.roll).toBe(0);
          // From the sample toward the centre, in tiles, along the ring plane's forward and up.
          const toCentreAlong = centreAlong - ((frame.x - base.x) * base.dirX + (frame.y - base.y) * base.dirY);
          const toCentreUp = centreUp - (frame.z - base.z) * COASTER_LEVEL_TILES;
          const upAlong = frame.upX * base.dirX + frame.upY * base.dirY;
          expect(upAlong * CENTRE_LINE_LOOP_RADIUS).toBeCloseTo(toCentreAlong, 9);
          expect(frame.upZ * CENTRE_LINE_LOOP_RADIUS).toBeCloseTo(toCentreUp, 9);
        }
      }
    }
  });
});

describe('centre line: round loops', () => {
  it('is a true circle of radius 1/2 about M + R·U′, entering and leaving along the ramp, pitch α + θ, arc 2πR', () => {
    const sample = createCentreLineSample();
    let ramped = 0;
    for (const [name, make] of [...LAYOUTS, ...PINNED_LAYOUTS.filter(([title]) => title.startsWith('circuit'))]) {
      const line = createCentreLine(make());
      for (let index = 0; index < line.pieceCount; index += 1) {
        if (line.loop[index] === 0) continue;
        const base = ringBase(line, index);
        const alpha = line.ringEntryPitch[index];
        expect(alpha, `${name} loop ${index}: the entry pitch is the ramp's`).toBeCloseTo(base.pitch, 12);
        expect(alpha).toBeCloseTo(Math.atan(base.slope * COASTER_LEVEL_TILES), 12);
        if (Math.abs(alpha) > 0.05) ramped += 1;
        const radius = CENTRE_LINE_LOOP_RADIUS;
        const centreAlong = -radius * Math.sin(alpha);
        const centreUp = radius * Math.cos(alpha);
        const ringStart = line.tileStart[index] + line.tileLength[index];
        expect(line.tileStart[index + 1] - ringStart, `${name} loop ${index}: arc length`).toBeCloseTo(2 * Math.PI * radius, 12);
        for (let step = 0; step < 96; step += 1) {
          const theta = (2 * Math.PI * step) / 96;
          sampleCentreLine(line, ringStart + theta * radius, sample);
          const along = (sample.x - base.x) * base.dirX + (sample.y - base.y) * base.dirY;
          const across = (sample.x - base.x) * -base.dirY + (sample.y - base.y) * base.dirX;
          const up = (sample.z - base.z) * COASTER_LEVEL_TILES;
          expect(Math.abs(across), `${name} loop ${index}: in the vertical plane`).toBeLessThan(1e-9);
          expect(Math.hypot(along - centreAlong, up - centreUp), `${name} loop ${index}: on the circle at θ ${theta}`).toBeCloseTo(radius, 9);
          expect(sample.ringAngle).toBeCloseTo(theta, 9);
          expect(sample.pitch, `${name} loop ${index}: pitch α + θ`).toBeCloseTo(alpha + theta, 9);
          expect(sample.slope).toBe(base.slope);
          // The exact rotated-circle formula of the design.
          expect(along).toBeCloseTo(radius * Math.sin(theta) * Math.cos(alpha) - radius * (1 - Math.cos(theta)) * Math.sin(alpha), 9);
          expect(up).toBeCloseTo(radius * Math.sin(theta) * Math.sin(alpha) + radius * (1 - Math.cos(theta)) * Math.cos(alpha), 9);
        }
        // Entry and exit: the ramp's own tangent at M, on both sides, and the next piece's start.
        const before = sampleCentreLine(line, ringStart - 1e-9, createCentreLineSample());
        const entry = sampleCentreLine(line, ringStart + 1e-9, createCentreLineSample());
        const exit = sampleCentreLine(line, line.tileStart[index + 1] - 1e-9, createCentreLineSample());
        const after = sampleCentreLine(line, line.tileStart[index + 1] + 1e-9, createCentreLineSample());
        for (const [a, b, label] of [[before, entry, 'entry'], [exit, after, 'exit'], [entry, exit, 'entry vs exit']] as const) {
          expect(norm3(a.tangentX - b.tangentX, a.tangentY - b.tangentY, a.tangentZ - b.tangentZ), `${name} loop ${index} ${label} tangent`).toBeLessThan(1e-6);
          expect(norm3(a.x - b.x, a.y - b.y, (a.z - b.z) * COASTER_LEVEL_TILES), `${name} loop ${index} ${label} position`).toBeLessThan(1e-6);
        }
      }
    }
    expect(ramped, 'ramped loops exercised').toBeGreaterThanOrEqual(4);
  });

  it('rotates a ramped ring nose-up on a climb and nose-down on a drop, and leaves a flat ring exactly where step 1 had it', () => {
    const climb = createCentreLine(loopOnClimbLayout());
    const drop = createCentreLine(loopOnDropLayout());
    const flat = createCentreLine(loopOvalLayout(START));
    expect(climb.ringEntryPitch[3]).toBeGreaterThan(0.3);
    expect(drop.ringEntryPitch[10]).toBeLessThan(-0.3);
    expect(climb.ringEntryPitch[3]).toBeCloseTo(-drop.ringEntryPitch[10], 9);
    for (let index = 0; index < flat.pieceCount; index += 1) {
      expect(flat.ringEntryPitch[index]).toBe(0);
      expect(climb.ringEntryPitch[index] !== 0).toBe(index === 3);
    }
    // A rotated ring dips R (1 − cos α) under M where it runs along the ramp's tangent: at its exit
    // on a climb (the first quarter never goes below M), at its entry on a drop (the last quarter never does).
    const sample = createCentreLineSample();
    const lowest = (line: CentreLine, index: number, fromStep: number, toStep: number): number => {
      const base = ringBase(line, index);
      let low = Infinity;
      for (let step = fromStep; step <= toStep; step += 1) {
        sampleCentreLine(line, line.tileStart[index] + line.tileLength[index] + (Math.PI * step) / 256, sample);
        low = Math.min(low, (sample.z - base.z) * COASTER_LEVEL_TILES);
      }
      return low;
    };
    const dip = (line: CentreLine, index: number): number => CENTRE_LINE_LOOP_RADIUS * (Math.cos(line.ringEntryPitch[index]) - 1);
    expect(lowest(climb, 3, 0, 256)).toBeCloseTo(dip(climb, 3), 3);
    expect(lowest(climb, 3, 0, 64)).toBeGreaterThanOrEqual(0);
    expect(lowest(drop, 10, 0, 256)).toBeCloseTo(dip(drop, 10), 3);
    expect(lowest(drop, 10, 192, 256)).toBeGreaterThanOrEqual(0);
    expect(dip(drop, 10)).toBeLessThan(-1 / 32);
    // The flat ring: the step-1 formula (the pinned hashes above prove it bit for bit).
    const base = ringBase(flat, 5);
    for (let step = 0; step < 64; step += 1) {
      const angle = (2 * Math.PI * step) / 64;
      sampleCentreLine(flat, flat.tileStart[5] + flat.tileLength[5] + angle * CENTRE_LINE_LOOP_RADIUS, sample);
      expect(sample.x).toBeCloseTo(base.x + base.dirX * (Math.sin(angle) * CENTRE_LINE_LOOP_RADIUS), 12);
      expect(sample.z).toBeCloseTo(base.z + ((1 - Math.cos(angle)) * CENTRE_LINE_LOOP_RADIUS) / COASTER_LEVEL_TILES, 12);
      expect(sample.pitch).toBeCloseTo(angle, 12);
    }
  });
});

describe('centre line: lift chain', () => {
  it('chains exactly the climbing segments, and nothing else, on every layout', () => {
    for (const [name, make] of [...LAYOUTS, ...PINNED_LAYOUTS]) {
      const pieces = make();
      const line = createCentreLine(pieces);
      const expected = pieces.map((piece, index) => (pieces[(index + 1) % pieces.length].height > piece.height ? 1 : 0));
      expect(Array.from(line.chained), name).toEqual(expected);
      expect(Array.from(centreLineChainedSegments(pieces)), name).toEqual(expected);
    }
    expect(centreLineChainedSegments([]).length).toBe(0);
    expect(Array.from(centreLineChainedSegments([{ cell: { x: 1, y: 1 }, height: 2 }]))).toEqual([0]);
  });

  it('splits a tile into an entry half (chained with the segment before) and an exit half (chained with its own segment)', () => {
    const pieces = ovalLayout(START);
    const line = createCentreLine(pieces);
    // Heights 0 0 0 1 2 2 ...: segments 2 and 3 climb, so piece 2's exit half, piece 3 and piece 4's entry half are chained.
    expect(Array.from(line.chained.slice(0, 6))).toEqual([0, 0, 1, 1, 0, 0]);
    expect(centreLineChainedHalf(line, 2, 0.25)).toBe(false);
    expect(centreLineChainedHalf(line, 2, 0.5)).toBe(true);
    expect(centreLineChainedHalf(line, 2, 0.99)).toBe(true);
    expect(centreLineChainedHalf(line, 3, 0.1)).toBe(true);
    expect(centreLineChainedHalf(line, 3, 0.9)).toBe(true);
    expect(centreLineChainedHalf(line, 4, 0.1)).toBe(true);
    expect(centreLineChainedHalf(line, 4, 0.5)).toBe(false);
    expect(centreLineChainedHalf(line, 0, 0.1), 'the lap wraps: the last segment is flat').toBe(false);
    for (let index = 0; index < line.pieceCount; index += 1) {
      for (let step = 0; step <= 8; step += 1) {
        const along = (line.tileLength[index] * step) / 8;
        const segment = along >= line.tileLength[index] / 2 ? index : (index + line.pieceCount - 1) % line.pieceCount;
        expect(centreLineChainedHalf(line, index, along)).toBe(line.chained[segment] === 1);
      }
    }
    expect(centreLineChainedHalf(createCentreLine([]), 0, 0.5)).toBe(false);
  });
});

describe('centre line: tie and support sampling', () => {
  it('spaces ties every 4 voxels of arc from 1 voxel past the start: 8 on a straight, 7 on a corner, 25 round a ring', () => {
    expect(CENTRE_LINE_TIE_SPACING * 32).toBe(4);
    expect(CENTRE_LINE_TIE_OFFSET * 32).toBe(1);
    expect(centreLineTieCount(1)).toBe(8);
    expect(centreLineTieCount(Math.PI / 4)).toBe(7);
    expect(centreLineTieCount(2 * Math.PI * CENTRE_LINE_LOOP_RADIUS)).toBe(25);
    expect(centreLineTieCount(0)).toBe(0);
    expect(centreLineTieCount(CENTRE_LINE_TIE_OFFSET)).toBe(0);
    expect(centreLineTieCount(CENTRE_LINE_TIE_OFFSET + 1e-9)).toBe(1);
    for (const length of [1, Math.PI / 4, 2 * Math.PI * CENTRE_LINE_LOOP_RADIUS]) {
      const count = centreLineTieCount(length);
      for (let k = 0; k < count; k += 1) {
        const along = centreLineTieAlong(k);
        expect(along).toBeLessThan(length);
        expect(along * 32).toBeCloseTo(4 * k + 1, 12);
      }
      expect(centreLineTieAlong(count)).toBeGreaterThanOrEqual(length);
    }
    // Every tie of every piece is a point of the line whose column is [4k, 4k + 2) voxels along the piece.
    const line = createCentreLine(zigzagLayout(START));
    const sample = createCentreLineSample();
    const projection = createTileProjection();
    for (let index = 0; index < line.pieceCount; index += 1) {
      for (let k = 0; k < centreLineTieCount(line.tileLength[index]); k += 1) {
        sampleCentreLine(line, line.tileStart[index] + centreLineTieAlong(k), sample);
        expect(sample.piece).toBe(index);
        projectOntoTile(line, index, sample.x - line.cellX[index], sample.y - line.cellY[index], projection);
        expect(Math.floor(projection.along * 32 + 1e-9) % 4).toBe(1);
      }
    }
  });

  it('puts the support bent 7 voxels past the entry edge, with legs 8 voxels either side along the rolled normal', () => {
    expect(CENTRE_LINE_SUPPORT_ALONG * 32).toBe(7);
    expect(CENTRE_LINE_SUPPORT_HALF_SPAN * 32).toBe(8);
    const frame = createCentreLineFrame();
    for (const [name, make] of LAYOUTS) {
      const line = createCentreLine(make());
      for (let index = 0; index < line.pieceCount; index += 1) {
        const distance = centreLineSupportDistance(line, index);
        expect(distance - line.tileStart[index], `${name} piece ${index}`).toBeCloseTo(CENTRE_LINE_SUPPORT_ALONG, 12);
        sampleCentreLineFrame(line, distance, frame);
        expect(frame.piece).toBe(index);
        expect(frame.ringAngle).toBe(0);
        // Both legs stand inside the piece's own tile.
        for (const sign of [1, -1]) {
          const legX = frame.x + sign * CENTRE_LINE_SUPPORT_HALF_SPAN * frame.normalX;
          const legY = frame.y + sign * CENTRE_LINE_SUPPORT_HALF_SPAN * frame.normalY;
          expect(legX, `${name} piece ${index} leg x`).toBeGreaterThanOrEqual(line.cellX[index] - 1e-9);
          expect(legX).toBeLessThanOrEqual(line.cellX[index] + 1 + 1e-9);
          expect(legY, `${name} piece ${index} leg y`).toBeGreaterThanOrEqual(line.cellY[index] - 1e-9);
          expect(legY).toBeLessThanOrEqual(line.cellY[index] + 1 + 1e-9);
        }
        if (line.turn[index] !== 0) {
          // On a corner the frame has already turned: the legs sit beside the arc, not beside the in-arm.
          const turned = Math.abs(frame.dirX * line.inX[index] + frame.dirY * line.inY[index]);
          expect(turned).toBeLessThan(0.98);
          expect(Math.abs(frame.roll)).toBeGreaterThan(0.1);
        }
      }
    }
    expect(centreLineSupportDistance(createCentreLine([{ cell: { x: 1, y: 1 }, height: 0 }]), 0)).toBeCloseTo(CENTRE_LINE_SUPPORT_ALONG, 12);
  });
});
