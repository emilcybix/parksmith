import { describe, expect, it } from 'vitest';
import { centreLineFor, centreLineTieCount } from '../game/coaster/centreLine';
import type { CoasterPiece } from '../game/coaster/design';
import { hillDipLayout, longestLayout, loopOvalLayout, ovalLayout, randomCircuit, zigzagLayout } from '../game/coaster/testLayouts';
import { GAME_CONFIG } from '../game/config';
import { buildClassicTrack, CLASSIC_CORRIDOR_HALF, CLASSIC_RUNG_Z_PX } from './classicCoaster';
import type { ClassicTrackGeometry } from './classicCoaster';

/**
 * Phase 27 step 2 review of the classic coaster structure on 100 random circuits and the fixtures:
 * supports stand on the ground and rise, both legs where the corridor rule allows, bracing that
 * grows with height and never below walking height, legs out of the walkway corridors; the station
 * furniture once per station piece with one gate and one light; ties by arc length; and where the
 * classic and voxel renderers disagree (documented).
 */

const STATION = GAME_CONFIG.coaster.stationLength;
const CLEARANCE = GAME_CONFIG.coaster.pathClearanceHeight;

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

const closed = (pieces: readonly CoasterPiece[]): ClassicTrackGeometry =>
  buildClassicTrack(centreLineFor(pieces), 0, pieces.length - 1, { closed: true, stationLength: STATION, boostTiles: [] });

/** Cell-space coordinates of a screen point on the ground (z = 0). */
const tileOf = (x: number, y: number): { u: number; v: number } => ({ u: x / 64 + y / 32, v: y / 32 - x / 64 });

describe('classic coaster review: supports', () => {
  it('stands a bent under every raised piece off the station, feet on the ground, legs rising, bracing above walking height and growing with height', () => {
    let bents = 0;
    let singleLegged = 0;
    let dropped = 0;
    const bracingByLevel = new Map<number, number[]>();
    for (const [name, pieces] of CIRCUITS) {
      const geometry = closed(pieces);
      const line = centreLineFor(pieces);
      let raised = 0;
      for (let index = STATION; index < pieces.length; index += 1) if (pieces[index].height > 0) raised += 1;
      // One bent per raised piece unless no leg found a clear spot (dropped) — count those.
      dropped += raised - geometry.supports.length;
      expect(geometry.supports.length, `${name}: at most one bent per raised piece`).toBeLessThanOrEqual(raised);
      for (const support of geometry.supports) {
        bents += 1;
        const legs = support.legs.length / 4;
        expect(legs === 1 || legs === 2, `${name}: a bent has one or two legs`).toBe(true);
        if (legs === 1) singleLegged += 1;
        for (let at = 0; at < support.legs.length; at += 4) {
          const [footX, footY, topX, topY] = support.legs.slice(at, at + 4);
          expect(topX, `${name}: a leg is vertical`).toBe(footX);
          expect(topY, `${name}: a leg rises`).toBeLessThan(footY);
          // The foot stands inside a track tile, out of the walkway corridors of its tile.
          const { u, v } = tileOf(footX, footY);
          const tile = pieces.find((piece) => Math.floor(u) === piece.cell.x && Math.floor(v) === piece.cell.y);
          expect(tile, `${name}: a foot at ${u.toFixed(2)},${v.toFixed(2)} on a track tile`).toBeDefined();
          if (tile && tile.height >= CLEARANCE) {
            const dx = Math.abs(u - (tile.cell.x + 0.5));
            const dy = Math.abs(v - (tile.cell.y + 0.5));
            expect(dx >= CLASSIC_CORRIDOR_HALF - 1e-9 && dy >= CLASSIC_CORRIDOR_HALF - 1e-9, `${name}: foot ${dx.toFixed(3)},${dy.toFixed(3)} from the walk lines`).toBe(true);
          }
        }
        // Rungs and diagonals never below the rung height (a walking guest), and the beam between the leg tops.
        if (legs === 2) {
          const [, footAY, , topAY] = support.legs.slice(0, 4);
          const [, footBY, , topBY] = support.legs.slice(4, 8);
          expect(support.braces.length, `${name}: a beam`).toBeGreaterThanOrEqual(4);
          const beam = support.braces.slice(0, 4);
          expect(beam[1], `${name}: the beam at or under leg A's top`).toBeGreaterThanOrEqual(topAY - 1e-9);
          expect(beam[3], `${name}: the beam at or under leg B's top`).toBeGreaterThanOrEqual(topBY - 1e-9);
          // Members run from leg A (x1, y1) to leg B (x2, y2); heights are over each leg's own foot.
          for (let at = 4; at < support.braces.length; at += 4) {
            const [, y1, , y2] = support.braces.slice(at, at + 4);
            expect(Math.min(footAY - y1, footBY - y2), `${name}: bracing above walking height`).toBeGreaterThanOrEqual(CLASSIC_RUNG_Z_PX - 1e-9);
          }
        } else {
          expect(support.bracingCount, `${name}: a single leg carries no bracing`).toBe(0);
        }
      }
      // Bracing grows with height: record per piece level (matching bents to pieces by order).
      let at = 0;
      for (let index = STATION; index < pieces.length && at < geometry.supports.length; index += 1) {
        if (pieces[index].height === 0) continue;
        const support = geometry.supports[at];
        at += 1;
        if (line.turn[index] !== 0) continue;
        const list = bracingByLevel.get(pieces[index].height) ?? [];
        list.push(support.bracingCount);
        bracingByLevel.set(pieces[index].height, list);
      }
    }
    expect(bents).toBeGreaterThan(1000);
    const mean = (list: number[] | undefined): number => (list && list.length > 0 ? list.reduce((a, b) => a + b, 0) / list.length : 0);
    expect(mean(bracingByLevel.get(2))).toBeGreaterThan(mean(bracingByLevel.get(1)));
    expect(mean(bracingByLevel.get(3))).toBeGreaterThan(mean(bracingByLevel.get(2)));
    expect(mean(bracingByLevel.get(4))).toBeGreaterThan(mean(bracingByLevel.get(3)));
    // Corridor pushes may drop a leg or a whole bent; report the rate.
    expect(singleLegged / bents, `single-legged bents: ${singleLegged} of ${bents}`).toBeLessThan(0.05);
    expect(dropped / (bents + dropped), `dropped bents: ${dropped} of ${bents + dropped}`).toBeLessThan(0.05);
  });
});

describe('classic coaster review: station, ties and parity with the voxel renderer', () => {
  it('furnishes each station piece once, with one gate and one light, and lays Σ centreLineTieCount ties', () => {
    for (const [name, pieces] of CIRCUITS) {
      const geometry = closed(pieces);
      const line = centreLineFor(pieces);
      expect(geometry.stations.length, `${name}: a station piece gets its furniture`).toBe(STATION);
      expect(geometry.stations.filter((station) => station.gate.length > 0).length, `${name}: one gate`).toBe(1);
      expect(geometry.stations.filter((station) => station.light.length > 0).length, `${name}: one light`).toBe(1);
      expect(geometry.stations[0].gate.length, `${name}: the gate on the first piece`).toBeGreaterThan(0);
      expect(geometry.stations[STATION - 1].light.length, `${name}: the light on the last station piece`).toBeGreaterThan(0);
      expect(geometry.brake.length, `${name}: the brake pad`).toBe(6);
      let ties = 0;
      for (let index = 0; index < line.pieceCount; index += 1) {
        ties += centreLineTieCount(line.tileLength[index]);
        if (line.loop[index] === 1) ties += centreLineTieCount(line.tileStart[index + 1] - line.tileStart[index] - line.tileLength[index]);
      }
      expect(geometry.ties.length / 4, `${name}: ties`).toBe(ties);
    }
  });

  // FINDING (step 2 review): the voxel station under a loop ring (a loop on the last piece, the
  // first station piece the lap-closing corner) keeps piece 0's platform only — no gate, no canopy,
  // no bulbs there — while the classic renderer draws the full furniture on all three pieces. The
  // two renderers disagree on exactly these layouts; this test documents that they exist.
  it('draws the queue gate on every layout, including the ones where the voxel station drops it', () => {
    let ringOverStations = 0;
    for (const [, pieces] of CIRCUITS) {
      const line = centreLineFor(pieces);
      if (line.turn[0] !== 0 && pieces[pieces.length - 1].special === 'loop') ringOverStations += 1;
      expect(closed(pieces).stations[0].gate.length).toBe(12);
    }
    expect(ringOverStations).toBeGreaterThan(5);
  });
});
