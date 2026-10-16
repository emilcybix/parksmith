import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { BUILD_BY_ID } from '../content/catalog';
import { ParkSession } from '../session/ParkSession';
import type { Cell } from '../types';

/**
 * Pathfinding around props (Phase 24). Guests and staff walk only on the path network, so "around the
 * obstacle" is automatic: no path can exist on a prop or on water, and a route exists only through built cells.
 * These tests pin that on Brookside Meadow (a pond, oak groves, a log) and on Red Rock Canyon.
 */

const key = (cell: Cell): string => `${cell.x},${cell.y}`;

/** A shortest 4-connected walk over cells that are not obstructed, from `from` to `to` (inclusive), or null. */
const walkAround = (session: ParkSession, from: Cell, to: Cell): Cell[] | null => {
  const { world } = session;
  const previous = new Map<string, Cell | null>([[key(from), null]]);
  const queue: Cell[] = [from];
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head];
    if (cell.x === to.x && cell.y === to.y) {
      const walk: Cell[] = [];
      for (let at: Cell | null = cell; at; at = previous.get(key(at)) ?? null) walk.unshift(at);
      return walk;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: cell.x + dx, y: cell.y + dy };
      if (!world.isInside(next) || previous.has(key(next)) || world.isObstructed(next)) continue;
      previous.set(key(next), cell);
      queue.push(next);
    }
  }
  return null;
};

describe('paths and guests around props', () => {
  const session = (): ParkSession => new ParkSession(null, [], { mapId: 'brookside-meadow' });

  it('a drag straight through a cluster builds only the free cells and leaves the far side unconnected', () => {
    const park = session();
    const { world } = park;
    // The lane north from the gate, then a drag along y = 19 across the groves at x = 16 (shrub) and x = 17 (oak).
    world.buildPaths(Array.from({ length: 11 }, (_, index) => ({ x: 15, y: 30 - index })));
    expect(world.propAt({ x: 16, y: 19 })?.kind).toBe('shrub');
    expect(world.propAt({ x: 17, y: 19 })?.kind).toBe('oak-tree');
    const drag = Array.from({ length: 11 }, (_, index) => ({ x: 12 + index, y: 19 }));
    const result = world.buildPaths(drag);
    expect(result.built).toBe(9);
    expect(result.added.map(key)).not.toContain('16,19');
    expect(result.added.map(key)).not.toContain('17,19');
    park.syncWithWorld();
    park.guests.navigation.sync(world.paths, world.pathVersion);
    const near = { x: 15, y: 19 };
    const far = { x: 18, y: 19 };
    expect(world.paths.has(key(near)) && world.paths.has(key(far))).toBe(true);
    expect(park.guests.navigation.routeDistance(near, far), 'the tiles beyond the cluster are not joined').toBeNull();
  });

  it('a path built AROUND the cluster connects them, no route cell stands on a prop, and a ride beyond is reached', () => {
    const park = session();
    const { world } = park;
    const gate = world.entrance;
    const beyond = { x: 22, y: 19 };
    const walk = walkAround(park, gate, beyond);
    expect(walk, 'a way around exists').not.toBeNull();
    world.buildPaths(walk!);
    park.syncWithWorld();
    park.guests.navigation.sync(world.paths, world.pathVersion);
    const route = park.guests.navigation.findRoute(gate, beyond);
    expect(route).not.toBeNull();
    for (const cell of route!) expect(world.isObstructed(cell), `${key(cell)} is open ground`).toBe(false);
    // A ride on free ground beside the far end of the path (the first legal 3x3 plot that touches one of its last tiles).
    const tail = new Set(walk!.slice(-4).map(key));
    let placed = false;
    for (let y = 0; y < 30 && !placed; y += 1) {
      for (let x = 0; x < 30 && !placed; x += 1) {
        if (!world.checkObjectBuild('petal-roundabout', { x, y }).ok) continue;
        const touches = world.footprintCells(BUILD_BY_ID.get('petal-roundabout')!, { x, y }).some((cell) => (
          [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tail.has(key({ x: cell.x + dx, y: cell.y + dy })))
        ));
        if (touches) placed = world.buildObject('petal-roundabout', { x, y }) !== null;
      }
    }
    expect(placed, 'a 3x3 plot beside the path').toBe(true);
    park.syncWithWorld();
    const ride = [...park.rides.rides.values()][0];
    park.rides.setTicketPrice(ride.objectId, 1);
    for (let tick = 0; tick < 4_000; tick += 1) park.step(GAME_CONFIG.fixedStepMs);
    const after = park.rides.snapshot(ride.objectId)!;
    expect(after.ridersToday + after.queueLength, 'guests walked around the grove to the ride').toBeGreaterThan(0);
  });

  it('removing the last path tile of a detour cuts the far side off again (the network follows the paths, not the props)', () => {
    const park = session();
    const { world } = park;
    const walk = walkAround(park, world.entrance, { x: 22, y: 19 })!;
    world.buildPaths(walk);
    park.syncWithWorld();
    park.guests.navigation.sync(world.paths, world.pathVersion);
    expect(park.guests.navigation.routeDistance(world.entrance, { x: 22, y: 19 })).toBe(walk.length - 1);
    world.bulldoze(walk[Math.floor(walk.length / 2)]);
    park.guests.navigation.sync(world.paths, world.pathVersion);
    expect(park.guests.navigation.routeDistance(world.entrance, { x: 22, y: 19 })).toBeNull();
  });

  it('clearing an obstacle opens the shorter way: with the groves bought the walk is a straight Manhattan line', () => {
    const park = session();
    const { world } = park;
    const target = { x: 22, y: 19 };
    const manhattan = Math.abs(target.x - world.entrance.x) + Math.abs(target.y - world.entrance.y);
    const around = walkAround(park, world.entrance, target)!;
    for (const prop of [...world.props.values()]) {
      if (prop.kind !== 'great-oak') world.bulldoze(prop);
    }
    const cleared = walkAround(park, world.entrance, target)!;
    expect(cleared.length - 1).toBe(manhattan);
    expect(around.length).toBeGreaterThanOrEqual(cleared.length);
  });

  it('a corridor map: Red Rock Canyon\'s walls force the route, and staff walk the same paths', () => {
    const park = new ParkSession(null, [], { mapId: 'red-rock-canyon' });
    const { world } = park;
    const mesaSide = { x: 4, y: 4 };
    const walk = walkAround(park, world.entrance, mesaSide);
    expect(walk, 'the long way round to the western mesa exists without clearing anything').not.toBeNull();
    // The shortest walk is far longer than the straight line: the permanent walls bend it.
    expect(walk!.length - 1).toBeGreaterThan(Math.abs(mesaSide.x - world.entrance.x) + Math.abs(mesaSide.y - world.entrance.y));
    for (const cell of walk!) expect(world.propAt(cell)).toBeUndefined();
  });
});
