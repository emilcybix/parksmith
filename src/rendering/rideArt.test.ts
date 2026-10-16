import type { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../game/content/catalog';
import { footprintSize, type Rotation } from '../game/types';
import { alongFootprint, cellOffsetOf, loopOutline } from './isoPlot';
import { BESPOKE_RIDE_ART_IDS, createRideArt, VEHICLE_LAYER } from './rideArt';

/**
 * Phase 16 rides the classic renderer (legacy, frozen since 2026-10-13) draws through its generic spinner rather
 * than bespoke machinery: the voxel renderer is the one that gives them their own art.
 */
const PHASE16_GENERIC_RIDE_IDS: readonly string[] = ['puddle-jumpers', 'rocket-pendulum', 'temple-trek'];

/** Custom coasters draw their own track, so they are not part of the machinery catalog. */
const RIDES = BUILD_CATALOG.filter((definition) => definition.kind === 'ride' && !definition.custom);

const ROTATIONS: Rotation[] = [0, 1, 2, 3];

const positions = (container: Container): string[] => {
  const found = [`${container.position.x},${container.position.y},${container.rotation}`];
  for (const child of container.children) found.push(...positions(child as Container));
  return found;
};

describe('ride art', () => {
  it('gives every catalog ride bespoke machinery, except the Phase 16 rides on the generic spinner', () => {
    expect(RIDES.length).toBeGreaterThan(0);
    for (const definition of RIDES) {
      if (PHASE16_GENERIC_RIDE_IDS.includes(definition.id)) continue;
      expect(BESPOKE_RIDE_ART_IDS).toContain(definition.id);
    }
  });

  it('draws the Phase 16 rides through the generic spinner without throwing, in every rotation and while running', () => {
    for (const id of PHASE16_GENERIC_RIDE_IDS) {
      const definition = BUILD_BY_ID.get(id);
      expect(definition, `${id} is a catalog ride`).toBeDefined();
      expect(BESPOKE_RIDE_ART_IDS, `${id} has no bespoke classic builder`).not.toContain(id);
      for (const rotation of ROTATIONS) {
        const art = createRideArt(definition!, rotation);
        expect(art.container.children.length, `${id} r${rotation} draws`).toBeGreaterThan(0);
        for (const step of [0, 1, 2]) {
          expect(() => art.animate({ spin: step * 900, motion: step / 2, progress: 0, elapsedMs: step * 300, status: 'running' }), `${id} animates`).not.toThrow();
        }
        art.container.destroy({ children: true });
      }
    }
  });

  it('keeps a cell-space loop inside the plot it was measured against', () => {
    // The footprint is a rectangle in grid cells, so on screen it is a slanted parallelogram.
    // A loop built from screen-space radii instead spills onto the neighbouring tiles — the
    // blueprint/footprint mismatch this geometry exists to prevent.
    for (const definitionId of ['bumble-coach', 'splash-rings', 'comet-cups']) {
      const [width, depth] = BUILD_BY_ID.get(definitionId)!.footprint;
      for (const rotation of ROTATIONS) {
        const [plotWidth, plotDepth] = footprintSize(BUILD_BY_ID.get(definitionId)!, rotation);
        const [longAxis, shortAxis] = alongFootprint(rotation, width / 2 - 0.7, depth / 2 - 0.6);
        const points = loopOutline(longAxis, shortAxis);
        for (let index = 0; index < points.length; index += 2) {
          const cell = cellOffsetOf({ x: points[index], y: points[index + 1] });
          expect(Math.abs(cell.x)).toBeLessThanOrEqual(plotWidth / 2);
          expect(Math.abs(cell.y)).toBeLessThanOrEqual(plotDepth / 2);
        }
      }
    }
  });

  it('runs the coach train around its own plot in every rotation', () => {
    // Bumble Coach is the ride whose vehicles stay at ground level, so its car positions can
    // be converted straight back to cells and checked against the footprint.
    const definition = BUILD_BY_ID.get('bumble-coach')!;
    for (const rotation of ROTATIONS) {
      const [width, depth] = footprintSize(definition, rotation);
      const art = createRideArt(definition, rotation);
      const seen = new Set<string>();
      const vehicles = art.container.children.find((child) => child.label === VEHICLE_LAYER) as Container;
      expect(vehicles?.children.length, 'the coach has a labelled vehicle layer').toBe(3);
      for (let step = 0; step <= 48; step += 1) {
        art.animate({ spin: step * 400, motion: 1, progress: 0, elapsedMs: step * 200, status: 'running' });
        for (const car of vehicles.children) {
          const point = (car as Container).getGlobalPosition();
          if (point.x === 0 && point.y === 0) continue;
          seen.add(`${Math.round(point.x)},${Math.round(point.y)}`);
          const cell = cellOffsetOf(point);
          // A fifth of a cell of slack for the car body itself.
          expect(Math.abs(cell.x), `${definition.id} r${rotation} along the plot`)
            .toBeLessThanOrEqual(width / 2 - 0.2);
          expect(Math.abs(cell.y), `${definition.id} r${rotation} across the plot`)
            .toBeLessThanOrEqual(depth / 2 - 0.2);
        }
      }
      expect(seen.size, 'the train actually travels').toBeGreaterThan(20);
    }
  });

  it('keeps every moving part at a finite position through a full cycle', () => {
    for (const definition of RIDES) {
      for (const rotation of ROTATIONS) {
        const art = createRideArt(definition, rotation);
        for (let step = 0; step <= 40; step += 1) {
          const progress = step / 40;
          art.animate({
            spin: step * 220,
            motion: progress,
            progress,
            elapsedMs: step * 160,
            status: 'running',
          });
          for (const value of positions(art.container)) {
            expect(value.split(',').every((part) => Number.isFinite(Number(part)))).toBe(true);
          }
        }
      }
    }
  });

  it('holds every part still while the ride is closed', () => {
    for (const definition of RIDES) {
      const art = createRideArt(definition);
      const state = { spin: 0, motion: 0, progress: 0, elapsedMs: 0, status: 'closed' as const };
      art.animate(state);
      const before = positions(art.container);
      art.animate({ ...state, elapsedMs: 5_000 });
      expect(positions(art.container)).toEqual(before);
    }
  });
});
