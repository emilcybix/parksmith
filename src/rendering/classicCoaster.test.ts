import { describe, expect, it } from 'vitest';
import {
  CENTRE_LINE_CORNER_RADIUS,
  CENTRE_LINE_HALF_GAUGE,
  centreLineFor,
  createCentreLineFrame,
  openLayoutRing,
  sampleCentreLineFrame,
} from '../game/coaster/centreLine';
import type { CoasterPiece } from '../game/coaster/design';
import { hillDipLayout, layoutFromMoves, loopOvalLayout, ovalLayout, withFreeLifts } from '../game/coaster/testLayouts';
import { openDraftRing } from './draftRing';
import {
  buildClassicTrack,
  CLASSIC_CORRIDOR_HALF,
  classicCoasterPalette,
  classicFarSide,
  classicOffsetX,
  classicOffsetY,
  classicTrackX,
  classicTrackY,
} from './classicCoaster';
import type { ClassicTrackGeometry } from './classicCoaster';

/**
 * The classic coaster structure is pure screen geometry built from the centre line's frame: two
 * rails either side of the line, ties across it, supports under it, a chain on the climbs, a brake
 * before the station and the station furniture on the far side. These tests read the geometry
 * without Pixi; coasterClassic.test.ts checks the renderer strokes exactly this once.
 */

const START = { x: 4, y: 4 };
const STATION = 3;

const closed = (pieces: readonly CoasterPiece[], boostTiles: number[] = []): ClassicTrackGeometry =>
  buildClassicTrack(centreLineFor(pieces), 0, pieces.length - 1, { closed: true, stationLength: STATION, boostTiles });

/** Cell-space coordinates of a screen point on the ground (z = 0). */
const tileOf = (x: number, y: number): { u: number; v: number } => ({ u: x / 64 + y / 32, v: y / 32 - x / 64 });

/** Whether a ground point is on the flat layout's centre line (the step-1 check, now for the spine). */
const onCentreLine = (pieces: readonly CoasterPiece[], x: number, y: number): { on: boolean; arc: boolean } => {
  const line = centreLineFor(pieces);
  const { u, v } = tileOf(x, y);
  for (const dx of [1e-9, -1e-9]) {
    for (const dy of [1e-9, -1e-9]) {
      const cellX = Math.floor(u + dx);
      const cellY = Math.floor(v + dy);
      const index = pieces.findIndex((piece) => piece.cell.x === cellX && piece.cell.y === cellY);
      if (index < 0) continue;
      if (line.turn[index] === 0) {
        const across = line.inX[index] !== 0 ? v - (cellY + 0.5) : u - (cellX + 0.5);
        if (Math.abs(across) < 1e-6) return { on: true, arc: false };
        continue;
      }
      const cornerX = cellX + 0.5 - 0.5 * line.inX[index] + CENTRE_LINE_CORNER_RADIUS * line.outX[index];
      const cornerY = cellY + 0.5 - 0.5 * line.inY[index] + CENTRE_LINE_CORNER_RADIUS * line.outY[index];
      if (Math.abs(Math.hypot(u - cornerX, v - cornerY) - CENTRE_LINE_CORNER_RADIUS) < 1e-6) return { on: true, arc: true };
    }
  }
  return { on: false, arc: false };
};

/** Mean y of a polygon [x0, y0, …]. */
const centroidY = (polygon: readonly number[]): number => {
  let sum = 0;
  for (let at = 1; at < polygon.length; at += 2) sum += polygon[at];
  return sum / (polygon.length / 2);
};

/** Rotates a layout a quarter turn (x, y) → (−y, x) and shifts it back onto the map. */
const rotated = (pieces: readonly CoasterPiece[]): CoasterPiece[] =>
  pieces.map((piece) => ({ ...piece, cell: { x: 20 - piece.cell.y, y: piece.cell.x } }));
/** Mirrors a layout in x. */
const mirrored = (pieces: readonly CoasterPiece[]): CoasterPiece[] =>
  pieces.map((piece) => ({ ...piece, cell: { x: 24 - piece.cell.x, y: piece.cell.y } }));

describe('classic coaster rails and ties', () => {
  it('runs the spine along the centre line, round corners included, and the rails either side of it', () => {
    const flat = ovalLayout(START).map((piece) => ({ ...piece, height: 0 }));
    const geometry = closed(flat);
    expect(geometry.spine).toHaveLength(1);
    const spine = geometry.spine[0];
    expect(spine.length / 2).toBe(1 + 20 * 4 + 4 * 8);
    let arcs = 0;
    for (let at = 0; at < spine.length; at += 2) {
      const check = onCentreLine(flat, spine[at], spine[at + 1]);
      expect(check.on, `spine vertex ${at / 2} on the centre line`).toBe(true);
      if (check.arc) arcs += 1;
    }
    expect(arcs, 'corners are arcs').toBeGreaterThan(28);
    // The rails are the spine offset symmetrically: their midpoint is the spine, their gauge constant on flats.
    const [left] = geometry.left;
    const [right] = geometry.right;
    expect(left.length).toBe(spine.length);
    expect(right.length).toBe(spine.length);
    for (let at = 0; at < spine.length; at += 2) {
      expect((left[at] + right[at]) / 2).toBeCloseTo(spine[at], 9);
      expect((left[at + 1] + right[at + 1]) / 2).toBeCloseTo(spine[at + 1], 9);
      expect(left[at] === right[at] && left[at + 1] === right[at + 1], 'two distinct rails').toBe(false);
    }
  });

  it('matches the frame: each rail is the sample offset by ± the half gauge along the rolled normal', () => {
    const pieces = hillDipLayout(START);
    const line = centreLineFor(pieces);
    const geometry = closed(pieces);
    const frame = createCentreLineFrame();
    const [spine] = geometry.spine;
    const [left] = geometry.left;
    // Vertex k of a straight piece is at tileStart + k/4 of its length; check every vertex by re-sampling.
    let vertex = 0;
    for (let index = 0; index < pieces.length; index += 1) {
      const steps = line.turn[index] === 0 ? 4 : 8;
      for (let step = index === 0 ? 0 : 1; step <= steps; step += 1) {
        sampleCentreLineFrame(line, line.tileStart[index] + (line.tileLength[index] * step) / steps, frame);
        const x = classicTrackX(frame.x, frame.y);
        const y = classicTrackY(frame.x, frame.y, frame.z);
        expect(spine[vertex * 2]).toBeCloseTo(x, 9);
        expect(spine[vertex * 2 + 1]).toBeCloseTo(y, 9);
        const g = CENTRE_LINE_HALF_GAUGE;
        expect(left[vertex * 2]).toBeCloseTo(x + classicOffsetX(frame.normalX * g, frame.normalY * g), 9);
        expect(left[vertex * 2 + 1]).toBeCloseTo(y + classicOffsetY(frame.normalX * g, frame.normalY * g, frame.normalZ * g), 9);
        vertex += 1;
      }
    }
    expect(vertex * 2).toBe(spine.length);
  });

  it('banks corners: the outer rail rises at the apex, straights stay level across', () => {
    const flat = ovalLayout(START).map((piece) => ({ ...piece, height: 0 }));
    const line = centreLineFor(flat);
    const geometry = closed(flat);
    const [left] = geometry.left;
    const [right] = geometry.right;
    let vertex = 0;
    let bankedApexes = 0;
    for (let index = 0; index < flat.length; index += 1) {
      const straight = line.turn[index] === 0;
      const steps = straight ? 4 : 8;
      for (let step = index === 0 ? 0 : 1; step <= steps; step += 1) {
        // The unrolled normal's screen rise: what the rail-y difference would be without banking.
        const along = (line.tileLength[index] * step) / steps;
        const angle = straight ? 0 : along / CENTRE_LINE_CORNER_RADIUS;
        const dirX = line.inX[index] * Math.cos(angle) + line.outX[index] * Math.sin(angle);
        const dirY = line.inY[index] * Math.cos(angle) + line.outY[index] * Math.sin(angle);
        const plan = 2 * classicOffsetY(-dirY * CENTRE_LINE_HALF_GAUGE, dirX * CENTRE_LINE_HALF_GAUGE, 0);
        const actual = left[vertex * 2 + 1] - right[vertex * 2 + 1];
        if (straight || step === 0 || step === steps) {
          expect(actual, `vertex ${vertex} unbanked`).toBeCloseTo(plan, 9);
        } else if (step === steps / 2) {
          // Roll > 0 lifts the −N side: a left turn (turn +1) rolls negative, so its left rail (+N) drops (y grows).
          const lift = actual - plan;
          expect(Math.abs(lift)).toBeGreaterThan(0.8);
          expect(Math.sign(lift)).toBe(line.turn[index] > 0 ? 1 : -1);
          bankedApexes += 1;
        }
        vertex += 1;
      }
    }
    expect(bankedApexes).toBe(4);
  });

  it('lays ties by arc length: 8 a straight, 7 a corner, 25 round a ring, centred on the line', () => {
    const flat = ovalLayout(START).map((piece) => ({ ...piece, height: 0 }));
    const geometry = closed(flat);
    expect(geometry.ties.length / 4).toBe(20 * 8 + 4 * 7);
    for (let at = 0; at < geometry.ties.length; at += 4) {
      const midX = (geometry.ties[at] + geometry.ties[at + 2]) / 2;
      const midY = (geometry.ties[at + 1] + geometry.ties[at + 3]) / 2;
      expect(onCentreLine(flat, midX, midY).on, `tie ${at / 4} centred on the line`).toBe(true);
      // A tie seen edge-on through its banking (the apex of a corner facing the camera) is the shortest, about 2 px.
      expect(Math.hypot(geometry.ties[at] - geometry.ties[at + 2], geometry.ties[at + 1] - geometry.ties[at + 3])).toBeGreaterThan(1.5);
    }
    const withLoops = closed(loopOvalLayout(START));
    expect(withLoops.ties.length / 4).toBe(20 * 8 + 4 * 7 + 2 * 25);
  });

  it('draws a loop ring as a closed circle of 32 segments with its rails offset by the constant ring axis', () => {
    const geometry = closed(loopOvalLayout(START));
    expect(geometry.spine).toHaveLength(3);
    expect(geometry.left).toHaveLength(3);
    for (const ring of [1, 2]) {
      const spine = geometry.spine[ring];
      const left = geometry.left[ring];
      expect(spine.length / 2).toBe(33);
      expect(spine[0]).toBeCloseTo(spine[64], 6);
      expect(spine[1]).toBeCloseTo(spine[65], 6);
      const offsetX = left[0] - spine[0];
      const offsetY = left[1] - spine[1];
      expect(Math.hypot(offsetX, offsetY)).toBeGreaterThan(1);
      for (let at = 0; at < spine.length; at += 2) {
        expect(left[at] - spine[at]).toBeCloseTo(offsetX, 9);
        expect(left[at + 1] - spine[at + 1]).toBeCloseTo(offsetY, 9);
      }
      // A flat ring's screen extent: 2 · R · |(16 · forward, −32 · up)| = sqrt(16² + 32²) = 35.8 px for R = ½.
      let top = Infinity;
      let bottom = -Infinity;
      for (let at = 1; at < spine.length; at += 2) {
        top = Math.min(top, spine[at]);
        bottom = Math.max(bottom, spine[at]);
      }
      expect(bottom - top).toBeGreaterThan(34);
      expect(bottom - top).toBeLessThan(36);
    }
  });
});

describe('classic coaster supports', () => {
  const corridorClear = (pieces: readonly CoasterPiece[], geometry: ClassicTrackGeometry): void => {
    for (const support of geometry.supports) {
      expect(support.legs.length).toBeGreaterThanOrEqual(4);
      for (let at = 0; at < support.legs.length; at += 4) {
        const { u, v } = tileOf(support.legs[at], support.legs[at + 1]);
        const piece = pieces.find((candidate) => u >= candidate.cell.x && u <= candidate.cell.x + 1 && v >= candidate.cell.y && v <= candidate.cell.y + 1);
        expect(piece, `leg at (${u.toFixed(3)}, ${v.toFixed(3)}) stands on a track tile`).toBeDefined();
        if (!piece) continue;
        expect(Math.abs(u - (piece.cell.x + 0.5))).toBeGreaterThanOrEqual(CLASSIC_CORRIDOR_HALF - 1e-9);
        expect(Math.abs(v - (piece.cell.y + 0.5))).toBeGreaterThanOrEqual(CLASSIC_CORRIDOR_HALF - 1e-9);
        // The leg stands on the ground and rises: its top is above its foot on screen.
        expect(support.legs[at + 2]).toBe(support.legs[at]);
        expect(support.legs[at + 3]).toBeLessThan(support.legs[at + 1] - 4);
      }
    }
  };

  it('stands one bent under every raised piece, none on the station, legs out of the walkway corridors', () => {
    const pieces = hillDipLayout(START);
    const geometry = closed(pieces);
    const raised = pieces.filter((piece, index) => index >= STATION && piece.height > 0).length;
    expect(geometry.supports.length).toBeGreaterThanOrEqual(raised);
    corridorClear(pieces, geometry);
    // Station pieces are flat, and a flat straight next to the station never gets a bent either.
    const stationCells = pieces.slice(0, STATION).map((piece) => piece.cell);
    for (const support of geometry.supports) {
      const { u, v } = tileOf(support.legs[0], support.legs[1]);
      expect(stationCells.some((cell) => u >= cell.x && u <= cell.x + 1 && v >= cell.y && v <= cell.y + 1)).toBe(false);
    }
  });

  it('keeps its legs beside the arc on corners (the zig-zag), out of the corridors', () => {
    const zigzag = layoutFromMoves(START, `${'E'.repeat(4)}${'SE'.repeat(5)}${'S'.repeat(2)}${'W'.repeat(9)}${'N'.repeat(7)}`,
      [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const geometry = closed(zigzag);
    expect(geometry.supports.length).toBeGreaterThanOrEqual(8);
    corridorClear(zigzag, geometry);
  });

  it('braces taller bents more: level 1 a beam only, level 2 a rung, level 3 a diagonal, level 4 two bays', () => {
    // Long flat runs at each level, so the bent in the middle of a run sees that level's bed height.
    const heights = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const layout = layoutFromMoves(START, `${'E'.repeat(24)}${'S'.repeat(1)}${'W'.repeat(24)}${'N'.repeat(1)}`, heights);
    const line = centreLineFor(layout);
    const geometry = closed(layout);
    const bentOf = (index: number): { bracingCount: number; braces: number[] } | undefined => {
      // Supports are emitted in piece order; find the one whose first leg stands on this piece's tile.
      return geometry.supports.find((support) => {
        const { u, v } = tileOf(support.legs[0], support.legs[1]);
        return Math.floor(u) === line.cellX[index] && Math.floor(v) === line.cellY[index];
      });
    };
    expect(bentOf(5)?.bracingCount).toBe(0);
    expect(bentOf(9)?.bracingCount).toBe(1);
    expect(bentOf(13)?.bracingCount).toBe(2);
    expect(bentOf(17)?.bracingCount).toBe(4);
    // Every bent with two legs has a beam between them, and bracing never reaches above the beam.
    for (const support of geometry.supports) {
      if (support.legs.length < 8) continue;
      expect(support.braces.length).toBeGreaterThanOrEqual(4);
      const beamY = Math.min(support.braces[1], support.braces[3]);
      for (let at = 4; at < support.braces.length; at += 4) {
        expect(support.braces[at + 1]).toBeGreaterThanOrEqual(beamY - 1e-9);
        expect(support.braces[at + 3]).toBeGreaterThanOrEqual(beamY - 1e-9);
      }
    }
  });

  it('adds no support under a loop ring: the loop piece keeps its own bent only', () => {
    expect(closed(loopOvalLayout(START)).supports.length).toBe(closed(ovalLayout(START)).supports.length);
  });
});

describe('classic coaster chain, brake and station', () => {
  it('dashes the chain on climbing halves only, continuous by arc length', () => {
    const flat = ovalLayout(START).map((piece) => ({ ...piece, height: 0 }));
    expect(closed(flat).chain).toHaveLength(0);
    // The oval climbs 0 → 1 → 2 over segments 2 and 3: two tiles of chain, a dash every 8 voxels.
    const geometry = closed(ovalLayout(START));
    const dashes = geometry.chain.length / 4;
    expect(dashes).toBeGreaterThanOrEqual(7);
    expect(dashes).toBeLessThanOrEqual(9);
    for (let at = 0; at < geometry.chain.length; at += 4) {
      const length = Math.hypot(geometry.chain[at] - geometry.chain[at + 2], geometry.chain[at + 1] - geometry.chain[at + 3]);
      expect(length).toBeGreaterThan(1);
      expect(length).toBeLessThan(5);
    }
  });

  it('puts the brake pad and fin on the last piece of a closed layout and nowhere on an open draft', () => {
    const geometry = closed(ovalLayout(START));
    expect(geometry.brake).toHaveLength(6);
    expect(geometry.brakeFin).toHaveLength(4);
    expect(geometry.brakeFin[0]).toBe(geometry.brakeFin[2]);
    const open = ovalLayout(START).slice(0, 10);
    const ring = openLayoutRing(open);
    const draft = buildClassicTrack(centreLineFor(ring), 1, open.length, { closed: false, stationLength: STATION });
    expect(draft.brake).toHaveLength(0);
    expect(draft.brakeFin).toHaveLength(0);
    // Nine straights and the oval's first corner (piece 8).
    expect(draft.spine[0].length / 2).toBe(1 + 9 * 4 + 8);
  });

  it('furnishes the station on the far side: platform, canopy and post per piece, a gate at the entry, a light at the exit', () => {
    const pieces = ovalLayout(START);
    const geometry = closed(pieces);
    expect(geometry.stations).toHaveLength(STATION);
    geometry.stations.forEach((station, index) => {
      const centre = pieces[index].cell;
      const trackY = classicTrackY(centre.x + 0.5, centre.y + 0.5, 0);
      expect(centroidY(station.platform), 'the platform is behind the track').toBeLessThan(trackY - 2);
      expect(centroidY(station.canopy), 'the canopy is behind and above the track').toBeLessThan(trackY - 22);
      expect(station.post[1]).toBeGreaterThan(station.post[3]);
      expect(station.gate.length).toBe(index === 0 ? 12 : 0);
      expect(station.light.length).toBe(index === STATION - 1 ? 6 : 0);
    });
  });

  it('keeps the platform clear of a station end that turns toward the far side', () => {
    const edgeLength = (pieces: CoasterPiece[]): number => {
      const station = closed(pieces).stations[2];
      return Math.hypot(station.platformEdge[0] - station.platformEdge[2], station.platformEdge[1] - station.platformEdge[3]);
    };
    // Along +x the far side is −y: a last station piece that turns north keeps only the part clear of its arc.
    const toFar = layoutFromMoves(START, 'EENNWWSS', [0, 0, 0, 0, 0, 0, 0, 0]);
    const toNear = layoutFromMoves(START, 'EESSWWNN', [0, 0, 0, 0, 0, 0, 0, 0]);
    expect(classicFarSide(1, 0)).toBe(-1);
    expect(edgeLength(toFar)).toBeLessThan(edgeLength(toNear) * 0.5);
    expect(closed(toFar).stations).toHaveLength(STATION);
  });

  it('draws boost chevrons on boost tiles only', () => {
    const geometry = closed(loopOvalLayout(START), [18]);
    expect(geometry.chevrons).toHaveLength(2);
    expect(closed(loopOvalLayout(START)).chevrons).toHaveLength(0);
  });
});

describe('classic coaster orientation and types', () => {
  it('builds the same structure whichever way the layout faces (rotated and mirrored ovals)', () => {
    const base = closed(ovalLayout(START));
    for (const variant of [rotated(ovalLayout(START)), mirrored(ovalLayout(START)), rotated(rotated(ovalLayout(START)))]) {
      const geometry = closed(variant);
      expect(geometry.ties.length).toBe(base.ties.length);
      expect(geometry.chain.length).toBe(base.chain.length);
      expect(geometry.supports.map((support) => support.legs.length)).toEqual(base.supports.map((support) => support.legs.length));
      expect(geometry.supports.map((support) => support.bracingCount)).toEqual(base.supports.map((support) => support.bracingCount));
      expect(geometry.stations).toHaveLength(base.stations.length);
      // The platform stays behind the track in every orientation.
      geometry.stations.forEach((station, index) => {
        const centre = variant[index].cell;
        const trackY = classicTrackY(centre.x + 0.5, centre.y + 0.5, 0);
        expect(centroidY(station.platform)).toBeLessThan(trackY - 2);
      });
    }
  });

  it('colours the three coaster types distinctly, rails bright, and falls back by draft colour', () => {
    const comet = classicCoasterPalette('comet-trail', 0xe4572e);
    const chaser = classicCoasterPalette('star-chaser', 0x7048c9);
    const serpent = classicCoasterPalette('skyline-serpent', 0x1b7f79);
    for (const key of ['rail', 'tie', 'support', 'spine'] as const) {
      expect(new Set([comet[key], chaser[key], serpent[key]]).size, `${key} differs by type`).toBe(3);
    }
    for (const palette of [comet, chaser, serpent]) {
      const brightest = Math.max(palette.rail >> 16, (palette.rail >> 8) & 0xff, palette.rail & 0xff);
      expect(brightest, 'rails stay candy-bright').toBeGreaterThanOrEqual(0xe0);
    }
    expect(classicCoasterPalette(undefined, 0x7048c9)).toEqual(chaser);
    expect(classicCoasterPalette('unknown', 0x123456).tie).toBe(0x123456);
  });

  it('survives empty and single-piece layouts', () => {
    const empty = buildClassicTrack(centreLineFor([]), 0, -1, { closed: true, stationLength: STATION });
    expect(empty.spine).toHaveLength(0);
    const single = openLayoutRing([{ cell: { x: 4, y: 4 }, height: 0 }]);
    const draft = buildClassicTrack(centreLineFor(single), 1, 1, { closed: false, stationLength: STATION });
    expect(draft.spine[0].length / 2).toBe(5);
    expect(draft.stations).toHaveLength(1);
  });
});

describe('classic coaster chain follows the lift flag (Phase 27 step 4)', () => {
  it('draws chain on a chained climb and none when the lift is free, on a closed layout and an open draft', () => {
    const chained = hillDipLayout(START);
    const free = withFreeLifts(hillDipLayout(START));
    expect(closed(chained).chain.length).toBeGreaterThan(0);
    expect(closed(free).chain).toHaveLength(0);
    const open = (pieces: CoasterPiece[]): ClassicTrackGeometry => {
      const ring = openDraftRing(pieces.slice(0, 14));
      return buildClassicTrack(centreLineFor(ring), 1, pieces.slice(0, 14).length, { closed: false, stationLength: STATION, boostTiles: [] });
    };
    expect(open(chained).chain.length).toBeGreaterThan(0);
    expect(open(free).chain, 'openDraftRing keeps the free flag').toHaveLength(0);
  });
});
