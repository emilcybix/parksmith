import { BUILD_BY_ID } from './content/catalog';
import type { MapLayout } from './maps/types';
import { ParkSession } from './session/ParkSession';
import type { Cell } from './types';

/**
 * The prop-heavy scale park shared by performance.maps.test.ts (the heaviest hand-made maps) and
 * performance.generated.test.ts (the heaviest generated maps): paths laid as a comb over the open cells reachable from the
 * gate, rides on free 3x3 plots beside them, shops, staff. Plots in a forest are cleared first, as a player would.
 */
const key = (cell: Cell): string => `${cell.x},${cell.y}`;

export const buildPropPark = (
  source: { mapId: 'frosted-hollow' | 'maple-ridge' | 'meadow-estate' } | { layout: MapLayout },
): { session: ParkSession; rides: number; paths: number } => {
  const session = new ParkSession(null, [], source);
  const { world } = session;
  world.addMoney(500_000, 'scale test funding');
  // Phase 21: on an estate the whole map is bought first (the largest park a player can own).
  for (let offer = world.land.forSale(); offer.length > 0; offer = world.land.forSale()) {
    for (const parcel of offer) world.buyParcel(parcel);
  }
  // The open cells reachable from the gate over free ground.
  const reachable = new Set<string>([key(world.entrance)]);
  const queue: Cell[] = [{ ...world.entrance }];
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: cell.x + dx, y: cell.y + dy };
      if (!world.isInside(next) || world.isObstructed(next) || reachable.has(key(next))) continue;
      reachable.add(key(next));
      queue.push(next);
    }
  }
  // A comb: every fourth row, every fifth column and the gate's own column of the reachable land, kept only where it joins the gate.
  const candidates = new Set([...reachable].filter((entry) => {
    const [x, y] = entry.split(',').map(Number);
    return y % 4 === 0 || x % 5 === 0 || x === world.entrance.x;
  }));
  candidates.add(key(world.entrance));
  const joined = new Set<string>([key(world.entrance)]);
  const walk: Cell[] = [{ ...world.entrance }];
  for (let head = 0; head < walk.length; head += 1) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: walk[head].x + dx, y: walk[head].y + dy };
      if (!candidates.has(key(next)) || joined.has(key(next))) continue;
      joined.add(key(next));
      walk.push(next);
    }
  }
  world.buildPaths(walk);
  // Rides and shops on plots that touch a path tile. Plots in a forest are cleared first (a player does the same:
  // Maple Ridge's paddocks cannot hold ten 3x3 rides without buying trees), so every map gets the same park.
  const build = (definitionId: string): boolean => {
    const definition = BUILD_BY_ID.get(definitionId)!;
    for (let y = 0; y < world.height - 1; y += 1) {
      for (let x = 0; x < world.width - 1; x += 1) {
        const cells = world.footprintCells(definition, { x, y });
        const fits = cells.every((cell) => (
          world.isInside(cell) && !world.paths.has(key(cell)) && !world.objectAt(cell) && world.groundAt(cell) !== 2
          && (world.propAt(cell) === undefined || world.checkClear(cell).ok)
        ));
        if (!fits) continue;
        const touches = cells.some((cell) => (
          [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => world.paths.has(key({ x: cell.x + dx, y: cell.y + dy })))
        ));
        if (!touches) continue;
        for (const cell of cells) if (world.propAt(cell)) world.bulldoze(cell);
        if (world.buildObject(definitionId, { x, y })) return true;
      }
    }
    return false;
  };
  let rides = 0;
  for (let index = 0; index < 10; index += 1) if (build('petal-roundabout')) rides += 1;
  for (const shop of ['picnic-pocket', 'fizz-foundry', 'comfort-cabin', 'picnic-pocket', 'fizz-foundry']) build(shop);
  for (let i = 0; i < 8; i += 1) {
    session.operations.hireStaff('cleaner');
    session.operations.hireStaff('mechanic');
  }
  session.syncWithWorld();
  return { session, rides, paths: world.paths.size };
};

