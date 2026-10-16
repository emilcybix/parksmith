import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import { GuestSimulation } from '../guests/GuestSimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { neutralConditions } from '../weather/types';
import { GameWorld } from '../World';
import { RideSimulation } from './RideSimulation';

/**
 * Storm closure is derived from the weather conditions and the catalog's openAir flag. These tests
 * pin the reopen rule: the storm never touches the player's own open switch.
 */
const createPark = () => {
  const world = new GameWorld();
  world.buildPaths([{ x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 }, { x: 15, y: 25 }]);
  const openAir = world.buildObject('comet-cups', { x: 12, y: 27 });
  const covered = world.buildObject('petal-roundabout', { x: 16, y: 27 });
  if (!openAir || !covered) throw new Error('rides should be placeable');
  const conditions = neutralConditions();
  const rides = new RideSimulation(world);
  rides.setConditions(conditions);
  const shops = new ShopSimulation(world);
  const guests = new GuestSimulation(world, rides, shops, 7);
  guests.setConditions(conditions);
  rides.syncWithWorld(guests.guests);
  const step = (seconds = 0.1): void => rides.step(seconds * 1_000, guests.guests);
  return { world, openAir, covered, conditions, rides, guests, step };
};

describe('storm closure of open-air rides', () => {
  it('closes an open-air ride, releases its queue with the storm thought and leaves a covered ride running', () => {
    const park = createPark();
    park.guests.spawnGuests(2);
    const [first, second] = [...park.guests.guests.values()];
    park.rides.joinQueue(park.openAir.id, first);
    park.rides.joinQueue(park.covered.id, second);
    const happiness = first.happiness;
    park.conditions.stormActive = true;
    park.step();
    const open = park.rides.getRide(park.openAir.id)!;
    expect(open.status).toBe('closed');
    expect(open.open, 'the player intent is untouched').toBe(true);
    expect(park.rides.isAvailable(park.openAir.id)).toBe(false);
    expect(first.state).toBe('wandering');
    expect(first.currentThought).toBe('The ride closed for the storm.');
    expect(first.happiness).toBe(happiness - 2);
    expect(park.rides.getRide(park.openAir.id)!.queueGuestIds).toEqual([]);
    expect(park.rides.snapshot(park.openAir.id)).toMatchObject({ status: 'closed', open: true, closureReason: 'storm' });
    expect(park.rides.isAvailable(park.covered.id)).toBe(true);
    expect(park.rides.getRide(park.covered.id)!.queueGuestIds).toEqual([second.id]);
    expect(park.rides.snapshot(park.covered.id)!.closureReason).toBeNull();
    expect(park.rides.stormClosedCount()).toBe(1);
    expect(park.rides.joinQueue(park.openAir.id, first)).toBe('closed');
  });

  it('lets a running cycle finish, then closes', () => {
    const park = createPark();
    park.guests.spawnGuests(1);
    const guest = [...park.guests.guests.values()][0];
    park.rides.joinQueue(park.openAir.id, guest);
    park.step(GAME_CONFIG.rides.maximumDispatchWaitSeconds);
    const ride = park.rides.getRide(park.openAir.id)!;
    expect(ride.status).toBe('running');
    park.conditions.stormActive = true;
    park.step(1);
    expect(ride.status, 'still running').toBe('running');
    expect(guest.state).toBe('riding');
    park.step(60);
    expect(ride.status).toBe('closed');
    expect(guest.state).toBe('wandering');
  });

  it('reopens by itself when the storm ends', () => {
    const park = createPark();
    park.conditions.stormActive = true;
    park.step();
    expect(park.rides.getRide(park.openAir.id)!.status).toBe('closed');
    park.conditions.stormActive = false;
    park.step();
    expect(park.rides.getRide(park.openAir.id)!.status).toBe('idle');
    expect(park.rides.isAvailable(park.openAir.id)).toBe(true);
    expect(park.rides.snapshot(park.openAir.id)!.closureReason).toBeNull();
  });

  it('a ride the player closed stays closed after the storm, and says it was the player', () => {
    const park = createPark();
    park.rides.setOpen(park.openAir.id, false);
    park.conditions.stormActive = true;
    park.step();
    expect(park.rides.snapshot(park.openAir.id)).toMatchObject({ status: 'closed', closureReason: 'player' });
    park.conditions.stormActive = false;
    park.step();
    expect(park.rides.getRide(park.openAir.id)!.status).toBe('closed');
    expect(park.rides.isAvailable(park.openAir.id)).toBe(false);
    expect(park.rides.snapshot(park.openAir.id)!.closureReason).toBe('player');
  });

  it('a ride the player opens during the storm stays closed for the storm and opens when it ends', () => {
    const park = createPark();
    park.rides.setOpen(park.openAir.id, false);
    park.conditions.stormActive = true;
    park.step();
    park.rides.setOpen(park.openAir.id, true);
    expect(park.rides.getRide(park.openAir.id)!.status, 'setOpen does not reopen into a storm').toBe('closed');
    park.step();
    expect(park.rides.snapshot(park.openAir.id)).toMatchObject({ status: 'closed', closureReason: 'storm' });
    park.conditions.stormActive = false;
    park.step();
    expect(park.rides.getRide(park.openAir.id)!.status).toBe('idle');
  });

  it('a ride the player closes during the storm stays closed after it', () => {
    const park = createPark();
    park.conditions.stormActive = true;
    park.step();
    park.rides.setOpen(park.openAir.id, false);
    park.step();
    park.conditions.stormActive = false;
    park.step();
    expect(park.rides.getRide(park.openAir.id)!.status).toBe('closed');
    expect(park.rides.snapshot(park.openAir.id)!.closureReason).toBe('player');
  });

  it('broken and maintenance statuses are neither hidden nor repaired by a storm', () => {
    const park = createPark();
    park.rides.forceBreakdown(park.openAir.id, park.guests.guests);
    expect(park.rides.getRide(park.openAir.id)!.status).toBe('broken');
    park.conditions.stormActive = true;
    park.step();
    expect(park.rides.getRide(park.openAir.id)!.status).toBe('broken');
    park.rides.beginMaintenance(park.openAir.id, 'repair', park.guests.guests);
    park.step();
    expect(park.rides.getRide(park.openAir.id)!.status).toBe('maintenance');
    park.rides.completeMaintenance(park.openAir.id, 'repair', 0);
    expect(park.rides.getRide(park.openAir.id)!.status, 'repaired mid-storm: closed for the storm').toBe('closed');
    park.conditions.stormActive = false;
    park.step();
    expect(park.rides.getRide(park.openAir.id)!.status).toBe('idle');
  });

  it('a ride built during a storm is closed on its first step', () => {
    const park = createPark();
    park.conditions.stormActive = true;
    const late = park.world.buildObject('comet-cups', { x: 12, y: 22 })!;
    park.rides.syncWithWorld(park.guests.guests);
    expect(park.rides.isAvailable(late.id)).toBe(false);
    park.step();
    expect(park.rides.getRide(late.id)!.status).toBe('closed');
  });

  it('the catalog decides which rides are covered: the canopy rides, the rotor drum and the Temple Trek dark ride, nothing else', () => {
    const covered = BUILD_CATALOG.filter((definition) => definition.kind === 'ride' && definition.openAir === false).map((definition) => definition.id);
    expect(covered.sort()).toEqual(['moonpetal-carousel', 'petal-roundabout', 'temple-trek', 'thunder-drum']);
    const park = createPark();
    park.conditions.stormActive = true;
    expect(park.rides.isStormClosed(park.covered.id)).toBe(false);
    expect(park.rides.isStormClosed(park.openAir.id)).toBe(true);
    expect(park.rides.isStormClosed(99_999)).toBe(false);
  });
});
