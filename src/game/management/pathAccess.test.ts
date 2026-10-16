import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../content/catalog';
import { DETERMINISM_FIXTURES } from '../save/determinismFixtures';
import { runReference } from '../save/determinismHarness';
import type { ParkSession } from '../session/ParkSession';
import type { PlacedObject } from '../types';
import { GameWorld } from '../World';
import { ManagementSimulation } from './ManagementSimulation';

/** Phase 11 (PA-024): `hasPathAccess(id)` is `connectivity().objectIds.has(id)`, a pure read for the badge pass. */

const isRideOrService = (object: PlacedObject): boolean => {
  const definition = BUILD_BY_ID.get(object.definitionId);
  return definition?.kind === 'ride' || Boolean(definition?.stats?.serviceType);
};

/** The guests' own route-based destination list (private; read here only to prove the two tests agree). */
const guestReachableIds = (session: ParkSession): Set<number> => {
  session.guests.capacityView(); // syncs navigation and refreshes destinations, both derived caches
  const internals = session.guests as unknown as {
    rideDestinations: Array<{ object: PlacedObject }>;
    serviceDestinations: Array<{ object: PlacedObject }>;
  };
  return new Set([...internals.rideDestinations, ...internals.serviceDestinations].map((destination) => destination.object.id));
};

describe('ManagementSimulation.hasPathAccess (Phase 11, PA-024)', () => {
  it('turns on when a path from the gate reaches the ride and off when it is removed', () => {
    const world = new GameWorld();
    const ride = world.buildObject('petal-roundabout', { x: 12, y: 27 })!;
    const management = new ManagementSimulation(world);
    expect(management.hasPathAccess(ride.id)).toBe(false);
    world.buildPaths([{ x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }]);
    expect(management.hasPathAccess(ride.id)).toBe(true);
    expect(management.hasPathAccess(ride.id)).toBe(management.connectivity().objectIds.has(ride.id));
    world.bulldoze({ x: 15, y: 29 });
    expect(management.hasPathAccess(ride.id)).toBe(false);
    expect(management.hasPathAccess(9_999), 'unknown id').toBe(false);
  });

  const SAMPLED = [
    'hand-driven park: breakdown, repair, litter, closure, research',
    'player-built coaster with loop and boost, bulldozed later',
    'red rock canyon: First Day route in the gate frame, boulders cleared, a hot afternoon',
    'first day: sandbox progression latching, skip and dismiss',
  ];
  for (const name of SAMPLED) {
    it(`agrees with connectivity() and the guests' route test, and changes nothing: ${name}`, () => {
      const fixture = DETERMINISM_FIXTURES.find((candidate) => candidate.name === name)!;
      expect(fixture, name).toBeDefined();
      const options = { build: fixture.build, total: fixture.total, checkpointTicks: new Set<number>(), checkpoints: false, observeAtEnd: false };
      const plain = runReference({ ...options, act: fixture.act });
      let compared = 0;
      const read = runReference({
        ...options,
        act: (session, tick) => {
          fixture.act(session, tick);
          for (const object of session.world.objects.values()) session.management.hasPathAccess(object.id);
          if (tick % 50 !== 0) return;
          const connected = session.management.connectivity().objectIds;
          const routed = guestReachableIds(session);
          for (const object of session.world.objects.values()) {
            const access = session.management.hasPathAccess(object.id);
            expect(access, `${object.definitionId} #${object.id} at tick ${tick}`).toBe(connected.has(object.id));
            if (isRideOrService(object)) {
              expect(access, `flood vs route for ${object.definitionId} #${object.id} at tick ${tick}`).toBe(routed.has(object.id));
              compared += 1;
            }
          }
        },
      });
      expect(read.finalHash).toBe(plain.finalHash);
      expect(read.eventHashes).toEqual(plain.eventHashes);
      expect(read.fingerprints).toEqual(plain.fingerprints);
      expect(compared).toBeGreaterThan(0);
    }, 60_000);
  }
});
