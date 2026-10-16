import { describe, expect, it } from 'vitest';
import { GuestSimulation } from './GuestSimulation';
import { RideSimulation } from '../rides/RideSimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { GAME_CONFIG } from '../config';
import { GameWorld } from '../World';
import type { Guest } from './types';
import type { SceneryInfluenceReader } from '../scenery/types';

const createReachablePark = (): { world: GameWorld; simulation: GuestSimulation; rides: RideSimulation; rideId: number } => {
  const world = new GameWorld();
  world.buildPaths([
    { x: 15, y: 30 },
    { x: 15, y: 29 },
    { x: 15, y: 28 },
    { x: 15, y: 27 },
  ]);
  const ride = world.buildObject('petal-roundabout', { x: 12, y: 27 });
  if (!ride) throw new Error('Test ride should be placeable');
  const rides = new RideSimulation(world);
  const shops = new ShopSimulation(world);
  return { world, simulation: new GuestSimulation(world, rides, shops, 42), rides, rideId: ride.id };
};

describe('GuestSimulation', () => {
  it('spawns at the entrance, follows paths, and discovers a reachable ride', () => {
    const { simulation, rideId } = createReachablePark();
    simulation.spawnGuests(1);
    for (let tick = 0; tick < 35; tick += 1) simulation.step(100);
    const guest = [...simulation.guests.values()][0];
    expect(guest).toBeDefined();
    expect(guest.recentRideIds).toContain(rideId);
    expect(guest.currentCell.y).toBeLessThan(31);
  });

  it('generates organic arrivals only for an open park with a reachable ride', () => {
    const { simulation } = createReachablePark();
    for (let tick = 0; tick < 20; tick += 1) simulation.step(100);
    expect(simulation.guests.size).toBeGreaterThan(0);
  });

  it('uses park rating and reachable attraction capacity to set organic demand', () => {
    const { world, simulation, rides } = createReachablePark();
    simulation.setParkRating(0);
    const lowRatingPotential = simulation.organicGuestPotential();
    simulation.setParkRating(100);
    const highRatingPotential = simulation.organicGuestPotential();

    expect(lowRatingPotential).toBeGreaterThan(0);
    expect(highRatingPotential).toBeGreaterThan(lowRatingPotential);

    const secondRide = world.buildObject('comet-cups', { x: 16, y: 27 });
    if (!secondRide) throw new Error('Second test ride should be placeable');
    rides.syncWithWorld();

    expect(simulation.organicGuestPotential()).toBeGreaterThan(highRatingPotential);
  });

  it('attracts organic guests faster at a high rating while a low rating still attracts some guests', () => {
    const lowRatingPark = createReachablePark().simulation;
    const highRatingPark = createReachablePark().simulation;
    lowRatingPark.setParkRating(0);
    highRatingPark.setParkRating(100);

    for (let tick = 0; tick < 400; tick += 1) {
      lowRatingPark.step(100);
      highRatingPark.step(100);
    }

    expect(lowRatingPark.guests.size).toBeGreaterThan(0);
    expect(highRatingPark.guests.size).toBeGreaterThan(lowRatingPark.guests.size);
    expect(lowRatingPark.guests.size).toBeLessThanOrEqual(lowRatingPark.organicGuestPotential());
    expect(highRatingPark.guests.size).toBeLessThanOrEqual(highRatingPark.organicGuestPotential());
  });

  it('keeps organic arrivals closed while the park is closed without blocking developer spawns', () => {
    const { world, simulation } = createReachablePark();
    world.setParkOpen(false);
    simulation.setParkRating(100);

    expect(simulation.organicGuestPotential()).toBe(0);
    for (let tick = 0; tick < 100; tick += 1) simulation.step(100);
    expect(simulation.guests.size).toBe(0);

    expect(simulation.spawnGuests(2)).toBe(2);
    expect(simulation.guests.size).toBe(2);
  });

  it('does not attract guests to a ride on a disconnected path island', () => {
    const world = new GameWorld();
    world.buildPaths([{ x: 5, y: 2 }, { x: 5, y: 3 }]);
    expect(world.buildObject('petal-roundabout', { x: 2, y: 2 })).not.toBeNull();
    const simulation = new GuestSimulation(world, new RideSimulation(world), new ShopSimulation(world), 42);
    simulation.setParkRating(100);
    expect(simulation.organicGuestPotential()).toBe(0);
    for (let tick = 0; tick < 30; tick += 1) simulation.step(100);
    expect(simulation.guests.size).toBe(0);
  });

  it('does not generate organic arrivals while every reachable ride is closed', () => {
    const { simulation, rides, rideId } = createReachablePark();
    rides.setOpen(rideId, false);
    simulation.setParkRating(100);
    expect(simulation.organicGuestPotential()).toBe(0);
    for (let tick = 0; tick < 30; tick += 1) simulation.step(100);
    expect(simulation.guests.size).toBe(0);
  });

  it('excludes broken rides from destinations and organic guest potential', () => {
    const { simulation, rides, rideId } = createReachablePark();
    simulation.setParkRating(100);
    expect(simulation.organicGuestPotential()).toBeGreaterThan(0);

    expect(rides.forceBreakdown(rideId, simulation.guests)).toBe(true);

    expect(rides.isAvailable(rideId)).toBe(false);
    expect(simulation.organicGuestPotential()).toBe(0);
    for (let tick = 0; tick < 30; tick += 1) simulation.step(100);
    expect(simulation.guests.size).toBe(0);
  });

  it('rejects a reachable ride when its price is far above perceived value', () => {
    const { simulation, rides, rideId } = createReachablePark();
    rides.setTicketPrice(rideId, 25);
    simulation.spawnGuests(1);
    for (let tick = 0; tick < 100; tick += 1) {
      rides.step(100, simulation.guests);
      simulation.step(100);
    }
    const runtime = rides.getRide(rideId)!;
    expect(runtime.queueGuestIds).toHaveLength(0);
    expect(runtime.ridersToday).toBe(0);
  });

  it('routes guests out when the park closes', () => {
    const { world, simulation } = createReachablePark();
    simulation.spawnGuests(1);
    simulation.step(100);
    world.setParkOpen(false);
    for (let tick = 0; tick < 60; tick += 1) simulation.step(100);
    expect(simulation.guests.size).toBe(0);
  });

  it('prioritizes an urgent drink need and completes the walk, queue, purchase, and relief loop', () => {
    const world = new GameWorld();
    world.buildPaths([
      { x: 15, y: 30 },
      { x: 15, y: 29 },
      { x: 15, y: 28 },
      { x: 15, y: 27 },
      { x: 15, y: 26 },
    ]);
    const ride = world.buildObject('petal-roundabout', { x: 12, y: 27 });
    const drink = world.buildObject('fizz-foundry', { x: 16, y: 27 });
    if (!ride || !drink) throw new Error('Ride and drink stall should be placeable');
    const rides = new RideSimulation(world);
    const shops = new ShopSimulation(world);
    const simulation = new GuestSimulation(world, rides, shops, 9);
    simulation.spawnGuests(1);
    const guest = [...simulation.guests.values()][0];
    guest.thirst = 88;
    guest.hunger = 0;
    guest.toiletNeed = 0;
    guest.energy = 100;
    guest.maximumVisitSeconds = 1_000;
    const cashBefore = world.cash;
    const moneyBefore = guest.money;

    for (let tick = 0; tick < 8; tick += 1) {
      simulation.step(100);
      rides.step(100, simulation.guests);
      shops.step(100, simulation.guests);
    }
    expect(guest.state).toBe('walkingToShop');
    expect(guest.destinationObjectId).toBe(drink.id);

    for (let tick = 0; tick < 100 && shops.getService(drink.id)?.customersServed === 0; tick += 1) {
      simulation.step(100);
      rides.step(100, simulation.guests);
      shops.step(100, simulation.guests);
    }

    expect(shops.getService(drink.id)?.customersServed).toBe(1);
    expect(guest.currentThought).toBe('That was refreshing!');
    simulation.step(100);
    expect(guest.currentThought).toBe('That was refreshing!');
    expect(guest.recentServiceIds).toContain(drink.id);
    expect(guest.thirst).toBeLessThan(30);
    expect(guest.money).toBe(moneyBefore - 4.5);
    expect(world.cash).toBe(cashBefore + 4.5);
    expect(guest.lastPurchaseSatisfaction).not.toBeNull();
  });

  it('uses scenery appeal to break an otherwise equivalent service choice', () => {
    const createChoice = (decorateSecond: boolean): { selected: number | null; firstId: number; secondId: number } => {
      const world = new GameWorld();
      world.buildPaths([
        { x: 15, y: 30 },
        { x: 15, y: 29 },
        { x: 15, y: 28 },
        { x: 15, y: 27 },
      ]);
      const first = world.buildObject('fizz-foundry', { x: 13, y: 27 });
      const second = world.buildObject('fizz-foundry', { x: 16, y: 27 });
      if (!first || !second) throw new Error('Drink stalls should be placeable');
      const scenery: SceneryInfluenceReader = {
        scoreAt: () => 0,
        scoreForObject: (objectId) => decorateSecond && objectId === second.id ? 100 : 0,
      };
      const rides = new RideSimulation(world);
      const shops = new ShopSimulation(world);
      const simulation = new GuestSimulation(world, rides, shops, 7, scenery);
      simulation.spawnGuests(1);
      const guest = [...simulation.guests.values()][0];
      guest.hunger = 0;
      guest.thirst = 88;
      guest.toiletNeed = 0;
      guest.energy = 100;
      guest.maximumVisitSeconds = 1_000;
      simulation.step(800);
      return { selected: guest.destinationObjectId, firstId: first.id, secondId: second.id };
    };

    const plain = createChoice(false);
    const decorated = createChoice(true);
    expect(plain.selected).toBe(plain.firstId);
    expect(decorated.selected).toBe(decorated.secondId);
  });

  it('lifts guest mood on decorated ground, caps the gain, and reports a scenery thought', () => {
    const createPark = (sceneryScore: number): { simulation: GuestSimulation; guest: Guest } => {
      const world = new GameWorld();
      world.buildPaths([
        { x: 15, y: 30 },
        { x: 15, y: 29 },
        { x: 15, y: 28 },
        { x: 15, y: 27 },
      ]);
      const scenery: SceneryInfluenceReader = { scoreAt: () => sceneryScore, scoreForObject: () => 0 };
      const rides = new RideSimulation(world);
      const shops = new ShopSimulation(world);
      const simulation = new GuestSimulation(world, rides, shops, 7, scenery);
      simulation.spawnGuests(1);
      const guest = [...simulation.guests.values()][0];
      guest.happiness = 70;
      guest.hunger = 0;
      guest.thirst = 0;
      guest.toiletNeed = 0;
      guest.energy = 100;
      guest.maximumVisitSeconds = 10_000;
      return { simulation, guest };
    };

    const plain = createPark(GAME_CONFIG.scenery.ambientHappinessThreshold);
    const decorated = createPark(GAME_CONFIG.scenery.maximumScore);
    for (let tick = 0; tick < 100; tick += 1) {
      plain.simulation.step(100);
      decorated.simulation.step(100);
    }

    const gain = decorated.guest.happiness - 70;
    expect(plain.guest.happiness).toBe(70);
    expect(gain).toBeGreaterThanOrEqual(GAME_CONFIG.scenery.ambientHappinessPerSecond * 10);
    expect(gain).toBeLessThanOrEqual(GAME_CONFIG.scenery.ambientHappinessPerSecond * 11);
    expect(decorated.guest.currentThought).toBe('What a lovely spot.');

    for (let tick = 0; tick < 3_000; tick += 1) decorated.simulation.step(100);
    expect(decorated.guest.happiness).toBe(GAME_CONFIG.scenery.maximumAmbientHappiness);
  });

  it('spawns guests in gentle, family, and thrill taste clusters', () => {
    const { simulation } = createReachablePark();
    simulation.spawnGuests(300);
    const preferences = [...simulation.guests.values()].map((guest) => guest.preferredIntensity);
    const gentle = preferences.filter((value) => value <= 36).length;
    const family = preferences.filter((value) => value >= 35 && value <= 65).length;
    const thrill = preferences.filter((value) => value >= 62).length;
    expect(gentle).toBeGreaterThan(preferences.length * 0.2);
    expect(family).toBeGreaterThan(preferences.length * 0.25);
    expect(thrill).toBeGreaterThan(preferences.length * 0.12);
    expect(Math.min(...preferences)).toBeGreaterThanOrEqual(12);
    expect(Math.max(...preferences)).toBeLessThanOrEqual(95);
  });

  it('releases a queued guest before service starts when its only access path is bulldozed', () => {
    const world = new GameWorld();
    world.buildPaths([
      { x: 15, y: 30 },
      { x: 16, y: 30 },
      { x: 16, y: 29 },
    ]);
    const drink = world.buildObject('fizz-foundry', { x: 16, y: 27 });
    if (!drink) throw new Error('Drink stall should be placeable');
    const rides = new RideSimulation(world);
    const shops = new ShopSimulation(world);
    const simulation = new GuestSimulation(world, rides, shops, 14);
    simulation.step(0);
    simulation.spawnGuests(1);
    const guest = [...simulation.guests.values()][0];
    guest.position = { x: 16, y: 29 };
    guest.currentCell = { x: 16, y: 29 };
    guest.route = [{ x: 16, y: 29 }];
    guest.routeIndex = 1;
    guest.routeVersion = world.pathVersion;
    guest.thirst = 80;
    guest.maximumVisitSeconds = 1_000;
    expect(shops.joinQueue(drink.id, guest)).toBe('joined');

    expect(world.bulldoze({ x: 16, y: 29 }).removed).toBe(true);
    simulation.step(100);
    shops.step(100, simulation.guests);

    expect(shops.getService(drink.id)?.activeGuestId).toBeNull();
    expect(shops.getService(drink.id)?.customersServed).toBe(0);
    expect(shops.getService(drink.id)?.queueGuestIds).not.toContain(guest.id);
    expect(guest.state).not.toBe('shopping');
  });

  it('reports repeated unmet service needs as an aggregated Park Pulse insight', () => {
    const world = new GameWorld();
    world.buildPaths([
      { x: 15, y: 30 },
      { x: 15, y: 29 },
      { x: 15, y: 28 },
      { x: 5, y: 3 },
    ]);
    expect(world.buildObject('petal-roundabout', { x: 12, y: 28 })).not.toBeNull();
    expect(world.buildObject('fizz-foundry', { x: 3, y: 3 })).not.toBeNull();
    const rides = new RideSimulation(world);
    const shops = new ShopSimulation(world);
    const simulation = new GuestSimulation(world, rides, shops, 12);
    simulation.spawnGuests(2);
    for (const guest of simulation.guests.values()) {
      guest.thirst = 80;
      guest.hunger = 0;
      guest.toiletNeed = 0;
      guest.maximumVisitSeconds = 1_000;
    }

    for (let tick = 0; tick < 8; tick += 1) simulation.step(100);

    expect([...simulation.guests.values()].map((guest) => guest.currentThought)).toEqual([
      "I can't find anything to drink.",
      "I can't find anything to drink.",
    ]);
    expect(simulation.thoughtInsights()).toContainEqual({
      count: 2,
      text: 'guests cannot find a drink stall.',
      objectId: null,
      objectName: null,
    });
  });
});
