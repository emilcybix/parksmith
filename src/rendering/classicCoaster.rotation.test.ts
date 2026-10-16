import { afterEach, describe, expect, it } from 'vitest';
import { centreLineFor } from '../game/coaster/centreLine';
import type { CoasterPiece } from '../game/coaster/design';
import { hillDipLayout, loopOvalLayout, ovalLayout, withFreeLifts } from '../game/coaster/testLayouts';
import {
  buildClassicTrack, classicFarSide, classicTrackX, classicTrackY, setClassicView,
} from './classicCoaster';
import type { ClassicTrackGeometry } from './classicCoaster';
import {
  cellToView, createViewFrame, IDENTITY_VIEW_FRAME, pointToView, vectorToView, VIEW_ROTATIONS, type ViewRotation, type XY,
} from './viewRotation';

/**
 * Phase 26: the coaster art through the four views. The decisive test is a differential: a layout
 * built in the WORLD and drawn in view q must be the exact picture of the same layout turned in the
 * world (cells through `cellToView`) and drawn in view 0. The tangent, the frame, the banking and
 * the station's far side all come from the same line, so anything the turn forgot shows up here.
 */

const WIDTH = 32;
const HEIGHT = 32;
const STATION = 3;
const START = { x: 4, y: 4 };

afterEach(() => setClassicView(IDENTITY_VIEW_FRAME));

const flatten = (geometry: ClassicTrackGeometry): number[] => {
  const out: number[] = [];
  const add = (values: readonly number[]): void => { out.push(...values, Number.NaN); };
  for (const group of [geometry.spine, geometry.left, geometry.right, geometry.chevrons]) group.forEach(add);
  for (const values of [geometry.ties, geometry.chain, geometry.brake, geometry.brakeFin]) add(values);
  for (const support of geometry.supports) { add(support.legs); add(support.braces); }
  for (const station of geometry.stations) {
    for (const values of [station.platform, station.platformEdge, station.canopy, station.valance, station.post, station.gate, station.light]) add(values);
  }
  return out;
};

const build = (pieces: readonly CoasterPiece[], rotation: ViewRotation): ClassicTrackGeometry => {
  setClassicView(createViewFrame(rotation, WIDTH, HEIGHT));
  return buildClassicTrack(centreLineFor(pieces), 0, pieces.length - 1, { closed: true, stationLength: STATION });
};

const turned = (pieces: readonly CoasterPiece[], rotation: ViewRotation): CoasterPiece[] => {
  const frame = createViewFrame(rotation, WIDTH, HEIGHT);
  const out: XY = { x: 0, y: 0 };
  return pieces.map((piece) => {
    cellToView(frame, piece.cell.x, piece.cell.y, out);
    return { ...piece, cell: { x: out.x, y: out.y } };
  });
};

describe('classic coaster art in four views', () => {
  const layouts: [string, CoasterPiece[]][] = [
    ['oval', ovalLayout(START)],
    ['loop oval', loopOvalLayout(START)],
    ['hill and dip', hillDipLayout(START)],
    ['free lifts', withFreeLifts(ovalLayout(START), [4])],
  ];

  for (const [name, pieces] of layouts) {
    it(`${name}: view q of the layout equals view 0 of the turned layout, every number`, () => {
      for (const view of VIEW_ROTATIONS) {
        const a = flatten(build(pieces, view));
        const b = flatten(build(turned(pieces, view), 0));
        expect(a.length).toBe(b.length);
        expect(a.length).toBeGreaterThan(100);
        for (let index = 0; index < a.length; index += 1) {
          if (Number.isNaN(a[index])) { expect(Number.isNaN(b[index])).toBe(true); continue; }
          expect(Math.abs(a[index] - b[index]), `${name} view ${view} number ${index}`).toBeLessThan(1e-6);
        }
      }
    });
  }

  it('the station furniture is on the far side of the track in every view', () => {
    for (const view of VIEW_ROTATIONS) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const side = classicFarSide(dx, dy);
        setClassicView(createViewFrame(view, WIDTH, HEIGHT));
        const farSide = classicFarSide(dx, dy);
        const out: XY = { x: 0, y: 0 };
        vectorToView(view, -dy * farSide, dx * farSide, out);
        // The far-side normal, as the camera sees it, points to smaller x + y (away from the camera).
        expect(out.x + out.y, `view ${view} dir ${dx},${dy}`).toBeLessThan(0);
        expect(side === 1 || side === -1).toBe(true);
      }
    }
  });

  it('the projection is the isometric projection of the view point', () => {
    const out: XY = { x: 0, y: 0 };
    for (const view of VIEW_ROTATIONS) {
      const frame = createViewFrame(view, WIDTH, HEIGHT);
      setClassicView(frame);
      for (const [x, y, z] of [[3.5, 7.25, 0], [20, 11.5, 2], [0.5, 31.5, 1]]) {
        pointToView(frame, x, y, out);
        expect(classicTrackX(x, y)).toBeCloseTo((out.x - out.y) * 32, 9);
        expect(classicTrackY(x, y, z)).toBeCloseTo((out.x + out.y) * 16 - z * 13, 9);
      }
    }
  });
});
