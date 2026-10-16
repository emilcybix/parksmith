import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { entranceFrame } from '../maps/frame';
import { MAPS } from '../maps/content';
import { buildFirstDayRoute } from '../onboarding/routeInFrame';
import { PathNetwork } from '../navigation/PathNetwork';
import { ParkSession } from './ParkSession';

/**
 * The entrance is a MAP property (Phase 24): the game half of "an alternative entrance works end to end".
 * Red Rock Canyon (gate (16, 0), facing south) and Seaside Cove (gate (0, 15), facing east) exercise two
 * of the three non-Meadow facings; every shipped map runs the same checks. The rendering half (voxel gate
 * model quarter turn, entrance framing, classic container, menu sweep centre) lives with the renderers.
 */

const step = (session: ParkSession, ticks: number): void => {
  for (let t = 0; t < ticks; t += 1) session.step(GAME_CONFIG.fixedStepMs);
};

const bfs = (paths: ReadonlySet<string>, from: string, to: string): number | null => {
  const seen = new Map<string, number>([[from, 0]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head += 1) {
    const key = queue[head];
    const distance = seen.get(key)!;
    if (key === to) return distance;
    const [x, y] = key.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = `${x + dx},${y + dy}`;
      if (paths.has(next) && !seen.has(next)) {
        seen.set(next, distance + 1);
        queue.push(next);
      }
    }
  }
  return null;
};

describe.each(MAPS.map((map) => [map.id] as const))('the entrance on %s', (id) => {
  const fresh = (): ParkSession => new ParkSession(null, [], { mapId: id });

  it('arrivals appear on the gate cell and the park accepts them through it', () => {
    const session = fresh();
    const gate = session.world.entrance;
    expect(session.world.paths.has(`${gate.x},${gate.y}`)).toBe(true);
    session.guests.spawnGuests(3);
    for (const guest of session.guests.guests.values()) {
      expect(guest.currentCell).toEqual(gate);
      expect(guest.position).toEqual(gate);
    }
  });

  it('a route from the gate to a ride exists and routeDistance equals a breadth-first search', () => {
    const session = fresh();
    buildFirstDayRoute(session);
    session.guests.navigation.sync(session.world.paths, session.world.pathVersion);
    const gateKey = `${session.world.entrance.x},${session.world.entrance.y}`;
    const carousel = [...session.world.objects.values()].find((object) => object.definitionId === 'moonpetal-carousel')!;
    // The nearest path tile beside the ride is a legal destination; compare every path tile.
    for (const key of session.world.paths) {
      const [x, y] = key.split(',').map(Number);
      expect(session.guests.navigation.routeDistance(session.world.entrance, { x, y }), key).toBe(bfs(session.world.paths, gateKey, key));
    }
    const adjacent = session.world.objectFootprint(carousel).flatMap((cell) => [
      { x: cell.x + 1, y: cell.y }, { x: cell.x - 1, y: cell.y }, { x: cell.x, y: cell.y + 1 }, { x: cell.x, y: cell.y - 1 },
    ]).filter((cell) => session.world.paths.has(`${cell.x},${cell.y}`));
    expect(adjacent.length, 'the ride stands beside the lane').toBeGreaterThan(0);
    expect(session.guests.navigation.routeDistance(session.world.entrance, adjacent[0])).not.toBeNull();
  });

  it('guests arrive on their own, play, and leave through the gate when the park closes', () => {
    const session = fresh();
    buildFirstDayRoute(session);
    step(session, 2_000);
    expect(session.guests.totalArrivals, 'organic arrivals reach the park').toBeGreaterThan(2);
    expect(session.guests.guests.size).toBeGreaterThan(0);
    session.world.setParkOpen(false);
    session.syncWithWorld();
    const gate = session.world.entrance;
    let sawLeaver = false;
    for (let tick = 0; tick < 6_000 && session.guests.guests.size > 0; tick += 1) {
      session.step(GAME_CONFIG.fixedStepMs);
      for (const guest of session.guests.guests.values()) {
        if (guest.state === 'leaving' && guest.route.length > 0) {
          sawLeaver = true;
          expect(guest.route[guest.route.length - 1], 'a leaving guest walks to the gate').toEqual(gate);
        }
      }
    }
    expect(sawLeaver).toBe(true);
    expect(session.guests.guests.size, 'every guest went home through the gate').toBe(0);
  });

  it('the First Day hint points at the gate, then at the connected tip of the lane', () => {
    const session = fresh();
    const frame = entranceFrame({ ...session.world.entrance, facing: session.world.entranceFacing });
    expect(session.onboardingFocus()).toEqual([session.world.entrance]);
    const lane = [1, 2, 3, 4, 5].map((depth) => frame.toWorld(0, depth));
    session.world.buildPaths(lane);
    session.syncWithWorld();
    session.refreshManagement();
    const focus = session.onboardingFocus();
    expect(focus.length).toBe(1);
    expect(focus[0]).toEqual(lane[lane.length - 1]);
  });

  it('the connected-area flood, litter and staff all start at the gate', () => {
    const session = fresh();
    buildFirstDayRoute(session);
    session.syncWithWorld();
    const network = new PathNetwork();
    network.sync(session.world.paths, session.world.pathVersion);
    expect(network.connectedCells(session.world.entrance).length).toBe(session.world.paths.size);
    session.operations.hireStaff('cleaner');
    session.syncWithWorld();
    const worker = [...session.operations.staff.values()][0];
    expect(worker.currentCell).toEqual(session.world.entrance);
  });
});
