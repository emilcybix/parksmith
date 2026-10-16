import { COASTER_TYPE_BY_ID } from '../coaster/content';
import { coasterBaseCost, deriveCoasterStats, validateCoasterLayout, type CoasterPiece } from '../coaster/design';
import type { Cell, Rotation } from '../types';
import type { ParkSession } from './ParkSession';

/**
 * The developer park: a fully built, path-connected park to test at scale with, started from
 * the Parks menu. It is a sandbox session with its content stamped straight into the world —
 * nothing is charged and no transactions are recorded, so the finance report stays readable.
 *
 * The layout is a street grid: one avenue north from the gate, four cross streets, and one
 * more along the top. Rides fill the blocks between streets, services take the two-row
 * pockets by the gate and in the north, and decorations fill whatever free path-side cells
 * are left. Declared ride and service plots are expected to fit exactly; decorations are
 * best-effort, so adding a ride never breaks the park.
 */

export const DEV_PARK_CASH = 250_000;

/** The middle of the built park (the street grid and the coaster plot), in cells. */
export const DEV_PARK_CENTRE: Readonly<Cell> = { x: 15, y: 18 };

interface DevPlot {
  definitionId: string;
  anchor: Cell;
  rotation?: Rotation;
}

const AVENUE_X = 15;
const NORTH_STREET_Y = 6;
const CROSS_STREET_Y = [26, 21, 16, 11] as const;
const STREET_FROM_X = 7;
const STREET_TO_X = 23;

const devParkPaths = (): Cell[] => {
  const cells: Cell[] = [];
  for (let y = 30; y >= NORTH_STREET_Y; y -= 1) cells.push({ x: AVENUE_X, y });
  for (const y of [...CROSS_STREET_Y, NORTH_STREET_Y]) {
    for (let x = STREET_FROM_X; x <= STREET_TO_X; x += 1) cells.push({ x, y });
  }
  // A spur down the west edge, so the coaster plot in the north-west is reachable too.
  for (let y = NORTH_STREET_Y; y <= 10; y += 1) cells.push({ x: 6, y });
  cells.push({ x: 6, y: NORTH_STREET_Y - 0 });
  return cells;
};

/** Three ride blocks, four plots each: two west of the avenue, two east of it. */
const RIDE_PLOTS: readonly DevPlot[] = [
  { definitionId: 'moonpetal-carousel', anchor: { x: 7, y: 22 } },
  { definitionId: 'petal-roundabout', anchor: { x: 11, y: 22 } },
  { definitionId: 'bumble-coach', anchor: { x: 16, y: 22 } },
  { definitionId: 'comet-cups', anchor: { x: 20, y: 22 } },

  { definitionId: 'harbor-swings', anchor: { x: 7, y: 17 } },
  { definitionId: 'splash-rings', anchor: { x: 11, y: 17 } },
  { definitionId: 'aurora-wheel', anchor: { x: 16, y: 17 } },
  // Rotated: the same 4x2 coach standing upright in a 2-wide slot.
  { definitionId: 'bumble-coach', anchor: { x: 21, y: 17 }, rotation: 1 },

  { definitionId: 'gale-spinner', anchor: { x: 7, y: 12 } },
  { definitionId: 'thunder-drum', anchor: { x: 11, y: 12 } },
  { definitionId: 'cloud-hopper', anchor: { x: 16, y: 12 } },
  { definitionId: 'comet-cups', anchor: { x: 20, y: 12 } },
];

/** Two-row pockets: the gate yard south of the first street, and the north block. */
const SERVICE_PLOTS: readonly DevPlot[] = [
  { definitionId: 'picnic-pocket', anchor: { x: 12, y: 27 } },
  { definitionId: 'fizz-foundry', anchor: { x: 16, y: 27 } },
  { definitionId: 'comfort-cabin', anchor: { x: 13, y: 29 } },
  { definitionId: 'glacier-scoop', anchor: { x: 16, y: 29 } },
  { definitionId: 'lemon-light', anchor: { x: 16, y: 7 } },
  { definitionId: 'waffle-windmill', anchor: { x: 19, y: 7 } },
  { definitionId: 'snack-sprint', anchor: { x: 16, y: 9 } },
  { definitionId: 'comfort-pavilion', anchor: { x: 19, y: 9 } },
  { definitionId: 'comfort-cabin', anchor: { x: 22, y: 7 } },
];

/** Cycled through the free path-side cells; bins come first and often. */
const DECORATION_PALETTE = [
  'tidy-totem',
  'ribbon-bench',
  'confetti-tree',
  'tidy-totem',
  'lollipop-lamp',
  'sunburst-flowers',
  'tidy-totem',
  'ribbon-bench',
  'sunburst-flowers',
  'lollipop-lamp',
] as const;

const DECORATION_LIMIT = 44;

const CARDINALS: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

/**
 * A closed rectangular circuit in the north-west: three flat station pieces, a ramp to a
 * summit, and a drop back to ground level — the shape the coaster validator asks for.
 */
const devParkCoaster = (): CoasterPiece[] => {
  const left = 7;
  const right = 13;
  const top = 7;
  const bottom = 9;
  const ring: Cell[] = [];
  for (let x = left; x <= right; x += 1) ring.push({ x, y: bottom });
  for (let y = bottom - 1; y >= top; y -= 1) ring.push({ x: right, y });
  for (let x = right - 1; x >= left; x -= 1) ring.push({ x, y: top });
  for (let y = top + 1; y < bottom; y += 1) ring.push({ x: left, y });
  const summit = 2;
  const stationLength = 3;
  const climbEnds = stationLength + summit;
  const descentStarts = ring.length - summit;
  return ring.map((cell, index) => {
    let height = 0;
    if (index >= stationLength && index < climbEnds) height = index - stationLength + 1;
    else if (index >= climbEnds && index < descentStarts) height = summit;
    else if (index >= descentStarts) height = ring.length - index - 1;
    return { cell, height };
  });
};

export interface DevParkReport {
  paths: number;
  rides: number;
  services: number;
  decorations: number;
  coasters: number;
  /** Declared ride or service plots that did not fit — always empty in a healthy layout. */
  skipped: string[];
}

export const seedDevPark = (session: ParkSession): DevParkReport => {
  const { world } = session;
  // The street grid is written in Meadow cells (the gate at (15, 31)); on another map it would stand on props.
  if (world.map.id !== 'meadow') throw new Error(`The developer park is laid out for the Meadow map, not '${world.map.id}'`);
  const paths = world.seedScenarioPaths(devParkPaths());
  const skipped: string[] = [];

  const place = (plots: readonly DevPlot[]): number => {
    let placed = 0;
    for (const plot of plots) {
      if (world.seedScenarioObject(plot.definitionId, plot.anchor, plot.rotation ?? 0)) placed += 1;
      else skipped.push(`${plot.definitionId}@${plot.anchor.x},${plot.anchor.y}`);
    }
    return placed;
  };
  const rides = place(RIDE_PLOTS);
  const services = place(SERVICE_PLOTS);

  let coasters = 0;
  const type = COASTER_TYPE_BY_ID.get('star-chaser');
  const layout = devParkCoaster();
  if (!type || !validateCoasterLayout(layout, type).ok) {
    skipped.push('star-chaser:invalid-layout');
  } else {
    const result = world.placeCoaster(
      type.definitionId,
      layout,
      deriveCoasterStats(layout, type),
      coasterBaseCost(layout, type),
    );
    if ('error' in result) skipped.push(`star-chaser:${result.error}`);
    else coasters += 1;
  }

  // Decorations fill the leftovers in a fixed scan order, so the park is reproducible.
  let decorations = 0;
  for (let y = 30; y >= NORTH_STREET_Y && decorations < DECORATION_LIMIT; y -= 1) {
    for (let x = STREET_FROM_X - 1; x <= STREET_TO_X + 1 && decorations < DECORATION_LIMIT; x += 1) {
      const cell = { x, y };
      const besidePath = CARDINALS.some((direction) =>
        world.paths.has(`${cell.x + direction.x},${cell.y + direction.y}`));
      if (!besidePath) continue;
      const definitionId = DECORATION_PALETTE[decorations % DECORATION_PALETTE.length];
      if (world.seedScenarioObject(definitionId, cell)) decorations += 1;
    }
  }

  session.rides.syncWithWorld();
  session.shops.syncWithWorld();
  session.operations.syncWithWorld();
  // Hiring now requires the wage bill to be covered (PA-028), so the working budget goes in
  // before the crew is taken on, and is settled again afterwards so the park always starts from
  // the same figure no matter how the first shift was charged.
  world.cash = DEV_PARK_CASH;
  for (let index = 0; index < 4; index += 1) session.operations.hireStaff('cleaner');
  for (let index = 0; index < 2; index += 1) session.operations.hireStaff('mechanic');
  world.cash = DEV_PARK_CASH;
  // A finished park: the First Day hints have nothing to teach here.
  session.onboarding?.dismissAll();

  return { paths, rides, services, decorations, coasters, skipped };
};
