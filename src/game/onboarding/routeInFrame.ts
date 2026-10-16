import { BUILD_BY_ID } from '../content/catalog';
import { entranceFrame } from '../maps/frame';
import type { ParkSession } from '../session/ParkSession';

/**
 * The First Day pacing route (pacing.test.ts's "rich" route) written in the ENTRANCE FRAME, so it builds on any
 * map whose First Day apron is clear (lateral -2..+3, depth 0..11): `l` is lateral (right of the inward
 * direction), `d` the depth from the gate, both of the near-left cell of the footprint. On Meadow Garden
 * (gate (15, 31) facing north) it places exactly what the original route places; a test pins that.
 */
export interface RoutePlacement {
  readonly definitionId: string;
  readonly l: number;
  readonly d: number;
}

export const ROUTE_PATH_DEPTH = 12;

export const ROUTE_PLACEMENTS: readonly RoutePlacement[] = [
  { definitionId: 'moonpetal-carousel', l: 1, d: 3 },
  { definitionId: 'picnic-pocket', l: 1, d: 1 },
  { definitionId: 'fizz-foundry', l: -2, d: 1 },
  { definitionId: 'petal-roundabout', l: 1, d: 7 },
  { definitionId: 'lollipop-lamp', l: -1, d: 5 },
  { definitionId: 'lollipop-lamp', l: -1, d: 8 },
  { definitionId: 'sunburst-flowers', l: -1, d: 9 },
];

/** Builds the rich route into `session` (paths, objects, the carousel at $5, one cleaner). Throws if anything does not fit. */
export const buildFirstDayRoute = (session: ParkSession, options: { carouselPrice?: number } = {}): void => {
  const { world } = session;
  const frame = entranceFrame({ ...world.entrance, facing: world.entranceFacing });
  const cells = [];
  for (let d = 0; d < ROUTE_PATH_DEPTH; d += 1) cells.push(frame.toWorld(0, d));
  world.buildPaths(cells);
  for (const placement of ROUTE_PLACEMENTS) {
    const definition = BUILD_BY_ID.get(placement.definitionId);
    if (!definition) throw new Error(`unknown definition ${placement.definitionId}`);
    const anchor = frame.rectToWorld(placement.l, placement.d, definition.footprint[0], definition.footprint[1]);
    if (!world.buildObject(placement.definitionId, anchor, frame.rotation)) {
      throw new Error(`the route could not place ${placement.definitionId} at lateral ${placement.l}, depth ${placement.d} (${anchor.x},${anchor.y})`);
    }
  }
  session.syncWithWorld();
  const carousel = [...world.objects.values()].find((object) => object.definitionId === 'moonpetal-carousel');
  if (!carousel) throw new Error('the carousel is missing');
  session.rides.setTicketPrice(carousel.id, options.carouselPrice ?? 5);
  session.operations.hireStaff('cleaner');
};
