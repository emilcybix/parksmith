import { describe, expect, it } from 'vitest';
import {
  CENTRE_LINE_BANK_MAX,
  CENTRE_LINE_LOOP_RADIUS,
  COASTER_LEVEL_TILES,
  centreLineChainedHalf,
  centreLineIndexToDistance,
  centreLineRollAt,
  centreLineSupportDistance,
  centreLineTieAlong,
  centreLineTieCount,
  createCentreLine,
  createCentreLineFrame,
  createCentreLineSample,
  openLayoutRing,
  sampleCentreLine,
  sampleCentreLineFrame,
} from './centreLine';
import type { CoasterPiece } from './design';
import { randomCircuit } from './testLayouts';

/** Adversarial property tests for the centre line: random closed circuits, hostile layouts. */
const circuits = (): Array<[string, CoasterPiece[]]> => {
  const list: Array<[string, CoasterPiece[]]> = [];
  for (let seed = 1; list.length < 70 && seed < 2000; seed += 1) {
    const target = 4 + 2 * (seed % 22);
    const layout = randomCircuit(seed, target, 4 + (seed % 7));
    if (layout) list.push([`seed ${seed} (${target})`, layout]);
  }
  return list;
};

describe('centre line fuzz', () => {
  it('is finite, continuous, closed and length-consistent on random circuits', () => {
    const all = circuits();
    expect(all.length).toBeGreaterThan(60);
    const a = createCentreLineSample();
    const b = createCentreLineSample();
    for (const [name, pieces] of all) {
      const line = createCentreLine(pieces);
      let expected = 0;
      for (let i = 0; i < pieces.length; i += 1) {
        const p = pieces[(i + pieces.length - 1) % pieces.length].cell;
        const n = pieces[(i + 1) % pieces.length].cell;
        const straight = n.x - pieces[i].cell.x === pieces[i].cell.x - p.x && n.y - pieces[i].cell.y === pieces[i].cell.y - p.y;
        expected += straight ? 1 : Math.PI / 4;
        if (line.loop[i]) expected += Math.PI;
      }
      expect(line.totalLength, name + JSON.stringify(pieces)).toBeCloseTo(expected, 9);
      const step = 0.004;
      let worstPlan = 0;
      let worstZ = 0;
      let worstTurn = 0;
      let finite = true;
      for (let distance = 0; distance < line.totalLength - step; distance += step) {
        sampleCentreLine(line, distance, a);
        sampleCentreLine(line, distance + step, b);
        if (!Number.isFinite(a.x + a.y + a.z + a.tangentX + a.tangentY + a.tangentZ + a.pitch)) finite = false;
        worstPlan = Math.max(worstPlan, Math.hypot(b.x - a.x, b.y - a.y) / step);
        worstZ = Math.max(worstZ, (Math.abs(b.z - a.z) * COASTER_LEVEL_TILES) / step);
        const dot = a.tangentX * b.tangentX + a.tangentY * b.tangentY + a.tangentZ * b.tangentZ;
        worstTurn = Math.max(worstTurn, Math.acos(Math.min(1, dot)) / step);
      }
      expect(finite, name).toBe(true);
      expect(worstPlan, `${name} plan jump`).toBeLessThanOrEqual(1.0001);
      expect(worstZ, `${name} z jump`).toBeLessThan(2.5);
      expect(worstTurn, `${name} tangent kink (rad per tile)`).toBeLessThan(9);
      // The seam: tangent and position match across the lap start.
      sampleCentreLine(line, line.totalLength - 1e-9, a);
      sampleCentreLine(line, 1e-9, b);
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1e-6);
      expect(Math.hypot(a.tangentX - b.tangentX, a.tangentY - b.tangentY, a.tangentZ - b.tangentZ)).toBeLessThan(1e-6);
      // Index map: monotonic, hits every piece centre.
      let previous = -Infinity;
      for (let index = 0; index <= pieces.length; index += 0.25) {
        const d = centreLineIndexToDistance(line, index === pieces.length ? pieces.length - 1e-12 : index);
        expect(d, name).toBeGreaterThanOrEqual(previous);
        previous = d;
      }
    }
  });

  it('keeps an orthonormal frame, bounded banking, circular rings and the chain rule on random circuits', () => {
    const frame = createCentreLineFrame();
    const base = createCentreLineSample();
    let rings = 0;
    let corners = 0;
    for (const [name, pieces] of circuits()) {
      const line = createCentreLine(pieces);
      for (let distance = 0; distance < line.totalLength; distance += 0.0097) {
        sampleCentreLineFrame(line, distance, frame);
        const label = `${name} at ${distance}`;
        expect(Math.hypot(frame.normalX, frame.normalY, frame.normalZ), `${label} N unit`).toBeCloseTo(1, 9);
        expect(Math.hypot(frame.upX, frame.upY, frame.upZ), `${label} B unit`).toBeCloseTo(1, 9);
        expect(frame.normalX * frame.tangentX + frame.normalY * frame.tangentY + frame.normalZ * frame.tangentZ, `${label} N ⊥ T`).toBeCloseTo(0, 9);
        expect(frame.upX * frame.normalX + frame.upY * frame.normalY + frame.upZ * frame.normalZ, `${label} B ⊥ N`).toBeCloseTo(0, 9);
        expect(frame.upZ, `${label} B = T × N`).toBeCloseTo(frame.tangentX * frame.normalY - frame.tangentY * frame.normalX, 9);
        expect(Math.abs(frame.roll), `${label} roll cap`).toBeLessThanOrEqual(CENTRE_LINE_BANK_MAX);
        expect(frame.roll, `${label} roll`).toBe(centreLineRollAt(line, distance));
        if (frame.ringAngle > 0 || line.turn[frame.piece] === 0) expect(frame.roll, `${label} no roll off corners`).toBe(0);
        else corners += 1;
      }
      for (let index = 0; index < line.pieceCount; index += 1) {
        expect(line.chained[index], `${name} chain ${index}`).toBe(pieces[(index + 1) % pieces.length].height > pieces[index].height ? 1 : 0);
        expect(centreLineChainedHalf(line, index, 0)).toBe(line.chained[(index + pieces.length - 1) % pieces.length] === 1);
        expect(centreLineChainedHalf(line, index, line.tileLength[index])).toBe(line.chained[index] === 1);
        expect(centreLineTieCount(line.tileLength[index])).toBe(line.turn[index] === 0 ? 8 : 7);
        expect(centreLineTieAlong(centreLineTieCount(line.tileLength[index]) - 1)).toBeLessThan(line.tileLength[index]);
        const support = centreLineSupportDistance(line, index);
        expect(support).toBeGreaterThan(line.tileStart[index]);
        expect(support).toBeLessThan(line.tileStart[index] + line.tileLength[index] / 2 + 1e-12);
        if (line.loop[index] === 0) {
          expect(line.ringEntryPitch[index]).toBe(0);
          continue;
        }
        rings += 1;
        const ringStart = line.tileStart[index] + line.tileLength[index];
        sampleCentreLine(line, ringStart, base);
        const alpha = line.ringEntryPitch[index];
        expect(alpha).toBeCloseTo(base.pitch, 12);
        const radius = CENTRE_LINE_LOOP_RADIUS;
        for (let step = 1; step < 40; step += 1) {
          sampleCentreLineFrame(line, ringStart + (2 * Math.PI * radius * step) / 40, frame);
          const along = (frame.x - base.x) * base.dirX + (frame.y - base.y) * base.dirY;
          const up = (frame.z - base.z) * COASTER_LEVEL_TILES;
          expect(Math.hypot(along + radius * Math.sin(alpha), up - radius * Math.cos(alpha)), `${name} ring ${index} circle`).toBeCloseTo(radius, 9);
          expect(frame.pitch, `${name} ring ${index} pitch`).toBeCloseTo(alpha + (2 * Math.PI * step) / 40, 9);
          expect(frame.normalZ, `${name} ring ${index} axis`).toBeCloseTo(0, 12);
        }
      }
    }
    expect(rings).toBeGreaterThan(20);
    expect(corners).toBeGreaterThan(500);
  }, 20_000);

  it('survives hostile layouts without throwing or NaN, and stays fast', () => {
    const cell = (x: number, y: number, height = 0, special?: 'loop' | 'boost'): CoasterPiece =>
      special ? { cell: { x, y }, height, special } : { cell: { x, y }, height };
    const hostile: Array<[string, CoasterPiece[]]> = [
      ['empty', []],
      ['one', [cell(1, 1)]],
      ['one loop', [cell(1, 1, 0, 'loop')]],
      ['two', [cell(1, 1), cell(2, 1)]],
      ['dupes', [cell(1, 1), cell(1, 1), cell(1, 1)]],
      ['disconnected', [cell(1, 1), cell(10, 10), cell(-5, 3), cell(2, 2, 4)]],
      ['out and back', [cell(1, 1), cell(2, 1), cell(1, 1), cell(2, 1)]],
      ['negative cells', [cell(-3, -3), cell(-2, -3), cell(-2, -2), cell(-3, -2)]],
      ['huge heights', [cell(0, 0, 99), cell(1, 0, -50), cell(2, 0, 1e6), cell(3, 0)]],
      ['loop on hairpin', [cell(0, 0, 0, 'loop'), cell(1, 0, 0, 'loop'), cell(1, 1), cell(0, 1)]],
      ['all loops', Array.from({ length: 8 }, (_unused, i) => cell(i, 0, 0, 'loop'))],
      ['nan height', [cell(0, 0, Number.NaN), cell(1, 0), cell(2, 0)]],
    ];
    const sample = createCentreLineSample();
    const frame = createCentreLineFrame();
    for (const [name, pieces] of hostile) {
      const line = createCentreLine(pieces);
      for (const d of [-5, 0, 0.1, 1.5, line.totalLength, line.totalLength * 2.3, 1e9, Number.NaN, Infinity]) {
        sampleCentreLine(line, d, sample);
        sampleCentreLineFrame(line, d, frame);
        expect(Number.isFinite(centreLineRollAt(line, d)), `${name} roll d=${d}`).toBe(true);
        if (name === 'nan height') continue;
        for (const v of [sample.x, sample.y, sample.z, sample.tangentX, sample.tangentY, sample.tangentZ,
          frame.normalX, frame.normalY, frame.normalZ, frame.upX, frame.upY, frame.upZ, frame.roll]) {
          expect(Number.isFinite(v), `${name} d=${d}`).toBe(true);
        }
      }
      for (let index = 0; index < line.pieceCount; index += 1) {
        expect(Number.isFinite(centreLineSupportDistance(line, index))).toBe(true);
        expect(typeof centreLineChainedHalf(line, index, 0.3)).toBe('boolean');
      }
      expect(() => openLayoutRing(pieces)).not.toThrow();
      if (pieces.length > 0) {
        const ring = createCentreLine(openLayoutRing(pieces));
        sampleCentreLine(ring, 0.7, sample);
        expect(Number.isFinite(sample.x), name).toBe(true);
      }
    }
  });
});
