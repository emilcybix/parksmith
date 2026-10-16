import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import { PathNetwork } from '../navigation/PathNetwork';
import { ParkSession } from './ParkSession';
import { DEV_PARK_CASH, seedDevPark } from './devPark';

describe('developer park', () => {
  it('places every plot it declares, with cash and crew ready', () => {
    const session = new ParkSession(null);
    const report = seedDevPark(session);

    expect(report.skipped).toEqual([]);
    expect(report.rides).toBe(12);
    expect(report.services).toBe(9);
    expect(report.decorations).toBeGreaterThan(30);
    expect(report.coasters).toBe(1);
    expect(report.paths).toBeGreaterThan(90);
    expect(session.world.cash).toBe(DEV_PARK_CASH);
    expect(session.operations.snapshot().staff.cleaners.total).toBe(4);
    expect(session.operations.snapshot().staff.mechanics.total).toBe(2);
    // Enough of a spread to exercise rides, services, facilities, bins, and scenery together.
    const groups = new Set(session.buildingsSnapshot().map((row) => row.group));
    expect([...groups].sort()).toEqual(['bin', 'drink', 'food', 'other', 'ride', 'scenery', 'toilet']);
  });

  it('connects every ride and service to the entrance so guests can actually reach them', () => {
    const session = new ParkSession(null);
    seedDevPark(session);
    const navigation = new PathNetwork();
    navigation.sync(session.world.paths, session.world.pathVersion);

    for (const object of session.world.objects.values()) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition) continue;
      if (definition.kind !== 'ride' && !definition.stats?.serviceType) continue;
      const footprint = new Set(session.world.objectFootprint(object).map((cell) => `${cell.x},${cell.y}`));
      const access = session.world.objectFootprint(object).flatMap((cell) => [
        { x: cell.x + 1, y: cell.y },
        { x: cell.x - 1, y: cell.y },
        { x: cell.x, y: cell.y + 1 },
        { x: cell.x, y: cell.y - 1 },
      ]).filter((cell) => !footprint.has(`${cell.x},${cell.y}`)
        && session.world.paths.has(`${cell.x},${cell.y}`));
      const reachable = access.some((cell) => navigation.findRoute(session.world.entrance, cell) !== null);
      expect(reachable, `${definition.name} at ${object.anchor.x},${object.anchor.y} has no reachable entrance`)
        .toBe(true);
    }
  });

  it('runs a full crowd through the park without stalling the simulation', () => {
    const session = new ParkSession(null);
    seedDevPark(session);
    session.guests.spawnGuests(GAME_CONFIG.guests.maximum);
    expect(session.guests.guests.size).toBe(GAME_CONFIG.guests.maximum);

    for (let step = 0; step < 200; step += 1) session.step(GAME_CONFIG.fixedStepMs);

    const management = session.management.snapshot();
    expect(management.guestCount).toBeGreaterThan(GAME_CONFIG.guests.maximum * 0.9);
    // Guests are actually using the park rather than milling at the gate.
    const rides = session.buildingsSnapshot().filter((row) => row.group === 'ride');
    expect(rides.some((row) => (row.served ?? 0) > 0)).toBe(true);
    expect(rides.reduce((total, row) => total + (row.revenue ?? 0), 0)).toBeGreaterThan(0);
    // The larger crew cap is available at this crowd size.
    expect(session.operations.staffCapacity()).toBeGreaterThan(
      GAME_CONFIG.operations.staff.baseCapacityPerRole,
    );
  });
});
