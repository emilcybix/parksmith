import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { RideSimulation } from '../rides/RideSimulation';
import { DETERMINISM_FIXTURES } from '../save/determinismFixtures';
import { runReference } from '../save/determinismHarness';
import { ShopSimulation } from '../shops/ShopSimulation';
import { GameWorld } from '../World';
import { GuestSimulation } from './GuestSimulation';

/** Phase 11 (PA-009): `capacityView()` is the ceiling `updateArrivals` enforces, with its parts, as a pure read. */

const NEUTRAL_RULES = {
  arrivalIntervalMultiplier: 1,
  guestBudgetMultiplier: 1,
  servicePriceToleranceMultiplier: 1,
  needDecayMultiplier: 1,
};

const park = (definitionId = 'moonpetal-carousel') => {
  const world = new GameWorld();
  world.buildPaths([{ x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }]);
  const ride = world.buildObject(definitionId, { x: 12, y: 27 });
  if (!ride) throw new Error('the test ride should be placeable');
  const rides = new RideSimulation(world);
  const simulation = new GuestSimulation(world, rides, new ShopSimulation(world), 42);
  return { world, rides, simulation, rideId: ride.id };
};

describe('GuestSimulation.capacityView (Phase 11, PA-009)', () => {
  it('gives 36 for one carousel at rating 50, as the audit measured, with the parts the formula used', () => {
    const { simulation, world, rideId } = park();
    simulation.setParkRating(50);
    const view = simulation.capacityView();
    expect(view).toEqual({
      ceiling: 36,
      rideSeats: world.rideProfile(rideId)!.capacity,
      rating: 50,
      crowdMultiplier: 1,
      hardMaximum: GAME_CONFIG.guests.maximum,
      blocked: null,
    });
    expect(view.rideSeats).toBe(14);
  });

  it('agrees with organicGuestPotential across a sweep of ratings, rides and multipliers', () => {
    const { simulation, world, rides } = park();
    const extra = [{ id: 'comet-cups', x: 16, y: 27 }, { id: 'petal-roundabout', x: 16, y: 30 }];
    for (let step = 0; step <= extra.length; step += 1) {
      if (step > 0) {
        world.buildObject(extra[step - 1].id, { x: extra[step - 1].x, y: extra[step - 1].y });
        rides.syncWithWorld();
      }
      for (const multiplier of [0.5, 1, 1.3, 4]) {
        simulation.applyRules({ ...NEUTRAL_RULES, crowdCapacityMultiplier: multiplier });
        for (let rating = 0; rating <= 100; rating += 7) {
          simulation.setParkRating(rating);
          const view = simulation.capacityView();
          expect(view.ceiling).toBe(simulation.organicGuestPotential());
          expect(view.ceiling).toBe(Math.min(
            GAME_CONFIG.guests.maximum,
            Math.floor((8 + view.rideSeats * 2.2) * (0.45 + rating / 100) * multiplier),
          ));
        }
      }
    }
  });

  it('reports the card multiplier it applied', () => {
    const { simulation } = park();
    simulation.applyRules({ ...NEUTRAL_RULES, crowdCapacityMultiplier: 1.5 });
    simulation.setParkRating(50);
    const scaled = simulation.capacityView();
    expect(scaled.crowdMultiplier).toBe(1.5);
    expect(scaled.ceiling).toBe(Math.floor((8 + 14 * 2.2) * 0.95 * 1.5));
  });

  it('caps at the hard maximum with enough ride seats', () => {
    const world = new GameWorld(10_000_000);
    const path = [];
    for (let y = 2; y <= 30; y += 1) path.push({ x: 15, y });
    world.buildPaths(path);
    for (let y = 2; y <= 28; y += 3) {
      world.buildObject('moonpetal-carousel', { x: 12, y });
      world.buildObject('moonpetal-carousel', { x: 16, y });
    }
    const simulation = new GuestSimulation(world, new RideSimulation(world), new ShopSimulation(world), 42);
    simulation.applyRules({ ...NEUTRAL_RULES, crowdCapacityMultiplier: 4 });
    simulation.setParkRating(100);
    const view = simulation.capacityView();
    expect(view.blocked).toBeNull();
    expect((8 + view.rideSeats * 2.2) * 1.45 * 4).toBeGreaterThan(GAME_CONFIG.guests.maximum);
    expect(view.ceiling).toBe(GAME_CONFIG.guests.maximum);
    expect(view.hardMaximum).toBe(GAME_CONFIG.guests.maximum);
  });

  it('names each reason the ceiling is 0, in order', () => {
    const closed = park();
    closed.world.setParkOpen(false);
    closed.world.setGateSchedule({ scheduleOpen: false });
    expect(closed.simulation.capacityView()).toMatchObject({ ceiling: 0, blocked: 'park-closed' });

    const afterHours = park();
    afterHours.world.setGateSchedule({ scheduleOpen: false });
    expect(afterHours.simulation.capacityView()).toMatchObject({ ceiling: 0, blocked: 'after-hours' });

    const fewPaths = new GameWorld();
    fewPaths.buildPaths([{ x: 15, y: 30 }]);
    const fewPathsSimulation = new GuestSimulation(fewPaths, new RideSimulation(fewPaths), new ShopSimulation(fewPaths), 42);
    expect(fewPaths.paths.size).toBeLessThan(3);
    expect(fewPathsSimulation.capacityView()).toMatchObject({ ceiling: 0, blocked: 'too-few-paths', rideSeats: 0 });

    const noRide = park();
    noRide.rides.setOpen(noRide.rideId, false);
    expect(noRide.simulation.capacityView()).toMatchObject({ ceiling: 0, blocked: 'no-open-ride', rideSeats: 0 });

    const island = new GameWorld();
    island.buildPaths([{ x: 5, y: 2 }, { x: 5, y: 3 }, { x: 5, y: 4 }]);
    island.buildObject('petal-roundabout', { x: 2, y: 2 });
    const islandSimulation = new GuestSimulation(island, new RideSimulation(island), new ShopSimulation(island), 42);
    expect(islandSimulation.capacityView()).toMatchObject({ ceiling: 0, blocked: 'no-open-ride' });
  });

  it('counts a ride built while paused at once', () => {
    const { simulation, world, rides } = park();
    simulation.setParkRating(50);
    const before = simulation.capacityView().rideSeats;
    world.buildObject('comet-cups', { x: 16, y: 27 });
    rides.syncWithWorld();
    expect(simulation.capacityView().rideSeats).toBeGreaterThan(before);
  });

  const SAMPLED = [
    'scenario with Pulse Cards and a rules-locked id',
    'hand-driven park: breakdown, repair, litter, closure, research',
    'weather: a stormy afternoon with a storm-closed ride, a player-closed ride and opening hours',
    'player-built coaster with loop and boost, bulldozed later',
  ];
  for (const name of SAMPLED) {
    it(`leaves a determinism run identical when read between every tick: ${name}`, () => {
      const fixture = DETERMINISM_FIXTURES.find((candidate) => candidate.name === name)!;
      expect(fixture, name).toBeDefined();
      const options = { build: fixture.build, total: fixture.total, checkpointTicks: new Set<number>(), checkpoints: false, observeAtEnd: false };
      const plain = runReference({ ...options, act: fixture.act });
      const blocks = new Set<string | null>();
      const read = runReference({
        ...options,
        act: (session, tick) => {
          fixture.act(session, tick);
          const view = session.guests.capacityView();
          blocks.add(view.blocked);
          expect(view.ceiling).toBe(session.guests.organicGuestPotential());
        },
      });
      expect(read.finalHash).toBe(plain.finalHash);
      expect(read.eventHashes).toEqual(plain.eventHashes);
      expect(read.fingerprints).toEqual(plain.fingerprints);
      expect(blocks.size).toBeGreaterThan(0);
    }, 60_000);
  }
});
