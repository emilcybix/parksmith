import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { RideSimulation } from '../rides/RideSimulation';
import { hashState } from '../save/hash';
import { ShopSimulation } from '../shops/ShopSimulation';
import { neutralConditions } from '../weather/types';
import { GameWorld } from '../World';
import { GuestSimulation } from './GuestSimulation';

/** A small standalone park: a street up from the gate with one ride on each side and one stall on each side. */
const createPark = (setup: 'rides' | 'shops' | 'both' = 'both') => {
  const world = new GameWorld();
  const street = [];
  for (let y = 31; y >= 22; y -= 1) street.push({ x: 15, y });
  world.buildPaths(street);
  if (setup !== 'shops') {
    world.buildObject('comet-cups', { x: 12, y: 26 });
    world.buildObject('petal-roundabout', { x: 16, y: 26 });
  }
  if (setup !== 'rides') {
    world.buildObject('glacier-scoop', { x: 13, y: 29 });
    world.buildObject('picnic-pocket', { x: 16, y: 29 });
  }
  const conditions = neutralConditions();
  const rides = new RideSimulation(world);
  const shops = new ShopSimulation(world);
  const guests = new GuestSimulation(world, rides, shops, 4242);
  rides.setConditions(conditions);
  guests.setConditions(conditions);
  rides.syncWithWorld(guests.guests);
  shops.syncWithWorld(guests.guests);
  const step = (): void => {
    guests.step(100);
    rides.step(100, guests.guests);
    shops.step(100, guests.guests);
  };
  return { world, conditions, rides, shops, guests, step };
};

const objectIdOf = (world: GameWorld, definitionId: string): number => (
  [...world.objects.values()].find((object) => object.definitionId === definitionId)!.id
);

describe('guests under neutral conditions', () => {
  it('behave exactly as before weather existed: a 300 tick standalone park keeps its pinned state hash', () => {
    const park = createPark();
    park.guests.spawnGuests(40);
    for (let tick = 0; tick < 300; tick += 1) park.step();
    // Measured on the code before this change (the weather hooks multiply by exactly 1 and add 0). Re-pinned once for
    // Phase 29: guest life (pauses, benches, the extra guest fields) changes the park itself, weather or not.
    // Re-pinned 2026-10-15, Phase 30 (was b993431f97dbae0a): complaining guests now carry the optional `thoughtObjectId`
    // key (the building they complain about). Only the key moves it: with it stripped the state hashes exactly as
    // before, so the Phase 30 gameplay rules (the need gate on life activities, bench walkers in a crowd) change
    // nothing in this park.
    const state = park.guests.serialize();
    expect(hashState(state)).toBe('2a0387142e983af6');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const stripped = { ...state, guests: state.guests.map(({ thoughtObjectId, ...guest }) => guest) };
    expect(state.guests.some((guest) => guest.thoughtObjectId !== undefined), 'someone complains about a building').toBe(true);
    expect(hashState(stripped), 'without the Phase 30 key').toBe('b993431f97dbae0a');
  });
});

describe('arrival rate', () => {
  const arrivals = (rate: number): number => {
    const park = createPark();
    park.conditions.arrivalRate = rate;
    for (let tick = 0; tick < 600; tick += 1) park.step();
    return park.guests.totalArrivals;
  };

  it('scales how fast the spawn countdown drains: twice the rate, about twice the arrivals; zero never spawns', () => {
    const neutral = arrivals(1);
    expect(neutral).toBeGreaterThan(8);
    expect(arrivals(2)).toBeGreaterThan(neutral * 1.6);
    expect(arrivals(2)).toBeLessThan(neutral * 2.4);
    expect(arrivals(0.5)).toBeLessThan(neutral * 0.7);
    expect(arrivals(0)).toBe(0);
  });
});

describe('heat', () => {
  /** Spawns one guest, lets it pick a ride and start walking, then measures the next stretch. */
  const measure = (configure: (park: ReturnType<typeof createPark>) => void) => {
    const park = createPark('rides');
    configure(park);
    park.guests.spawnGuests(1);
    const guest = [...park.guests.guests.values()][0];
    const startThirst = guest.thirst;
    for (let tick = 0; tick < 12; tick += 1) park.guests.step(100);
    expect(guest.state).toBe('walkingToRide');
    // Per-step distances: arriving at a cell snaps the guest and drops the rest of that step's
    // movement, so a step is either the full movement or shorter; the longest one is the speed.
    let longest = 0;
    for (let index = 0; index < 12; index += 1) {
      const before = { ...guest.position };
      park.guests.step(10);
      longest = Math.max(longest, Math.hypot(guest.position.x - before.x, guest.position.y - before.y));
    }
    const walked = longest;
    return {
      walked,
      thirstGrowth: guest.thirst - startThirst,
    };
  };

  it('lowers walking distance and raises thirst growth by exactly the factors', () => {
    const base = measure(() => undefined);
    const hot = measure((park) => {
      park.conditions.walkSpeedFactor = 0.9;
      park.conditions.thirstFactor = 1.35;
    });
    expect(base.walked).toBeCloseTo(GAME_CONFIG.guests.walkingCellsPerSecond * 0.01, 9);
    expect(hot.walked).toBeCloseTo(GAME_CONFIG.guests.walkingCellsPerSecond * 0.01 * 0.9, 9);
    expect(base.thirstGrowth).toBeGreaterThan(0);
    expect(hot.thirstGrowth / base.thirstGrowth).toBeCloseTo(1.35, 6);
  });
});

describe('rain and heat steer choices', () => {
  const share = (setup: 'rides' | 'shops', prepare: (park: ReturnType<typeof createPark>) => void, pick: (ids: Record<string, number>) => number): number => {
    const park = createPark(setup);
    prepare(park);
    park.guests.spawnGuests(400);
    for (const guest of park.guests.guests.values()) {
      guest.hunger = setup === 'shops' ? 80 : 10;
      guest.thirst = 10;
      guest.money = 100;
    }
    for (let tick = 0; tick < 12; tick += 1) park.guests.step(100);
    const ids = {
      cups: setup === 'rides' ? objectIdOf(park.world, 'comet-cups') : -1,
      roundabout: setup === 'rides' ? objectIdOf(park.world, 'petal-roundabout') : -1,
      scoop: setup === 'shops' ? objectIdOf(park.world, 'glacier-scoop') : -1,
      picnic: setup === 'shops' ? objectIdOf(park.world, 'picnic-pocket') : -1,
    };
    const target = pick(ids);
    const chosen = [...park.guests.guests.values()].filter((guest) => guest.destinationObjectId !== null);
    expect(chosen.length).toBeGreaterThan(300);
    return chosen.filter((guest) => guest.destinationObjectId === target).length / chosen.length;
  };

  it('rain moves guests from the open-air ride to the covered one', () => {
    const neutral = share('rides', () => undefined, (ids) => ids.roundabout);
    const rain = share('rides', (park) => {
      park.conditions.coveredRideBonus = GAME_CONFIG.weather.effects.rideBias.rain.covered;
      park.conditions.openAirRideBonus = GAME_CONFIG.weather.effects.rideBias.rain.openAir;
    }, (ids) => ids.roundabout);
    expect(rain).toBeGreaterThan(neutral + 0.1);
  });

  it('rain moves hungry guests to the warm food stall, heat to the cold one', () => {
    const neutral = share('shops', () => undefined, (ids) => ids.picnic);
    const rain = share('shops', (park) => {
      park.conditions.warmFoodBonus = GAME_CONFIG.weather.effects.serviceBias.rain.warm;
      park.conditions.coldTreatBonus = GAME_CONFIG.weather.effects.serviceBias.rain.cold;
    }, (ids) => ids.picnic);
    const heat = share('shops', (park) => {
      park.conditions.warmFoodBonus = GAME_CONFIG.weather.effects.serviceBias.hot.warm;
      park.conditions.coldTreatBonus = GAME_CONFIG.weather.effects.serviceBias.hot.cold;
    }, (ids) => ids.picnic);
    expect(rain).toBeGreaterThan(neutral + 0.05);
    expect(heat).toBeLessThan(neutral - 0.05);
  });

  it('the destination tags come from the catalog: covered rides and warm or cold shops', () => {
    const park = createPark();
    park.guests.spawnGuests(1);
    park.guests.step(100);
    const internals = park.guests as unknown as {
      rideDestinations: Array<{ object: { definitionId: string }; covered: boolean }>;
      serviceDestinations: Array<{ object: { definitionId: string }; temperature: string | null }>;
    };
    const covered = Object.fromEntries(internals.rideDestinations.map((entry) => [entry.object.definitionId, entry.covered]));
    expect(covered).toEqual({ 'comet-cups': false, 'petal-roundabout': true });
    const temperature = Object.fromEntries(internals.serviceDestinations.map((entry) => [entry.object.definitionId, entry.temperature]));
    expect(temperature).toEqual({ 'glacier-scoop': 'cold', 'picnic-pocket': 'warm' });
  });
});

describe('shared conditions object', () => {
  it('guests read the live object: changing it mid-run takes effect on the next step with no copy', () => {
    const park = createPark('rides');
    park.guests.spawnGuests(1);
    for (let tick = 0; tick < 12; tick += 1) park.guests.step(100);
    const guest = [...park.guests.guests.values()][0];
    const before = { ...guest.position };
    park.conditions.walkSpeedFactor = 0;
    for (let tick = 0; tick < 10; tick += 1) park.guests.step(100);
    expect(guest.position).toEqual(before);
    park.conditions.walkSpeedFactor = 1;
    for (let tick = 0; tick < 10; tick += 1) park.guests.step(100);
    expect(guest.position).not.toEqual(before);
  });
});
