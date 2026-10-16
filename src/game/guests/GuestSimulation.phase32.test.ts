import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { RideSimulation } from '../rides/RideSimulation';
import { ScenerySimulation } from '../scenery/ScenerySimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { neutralConditions } from '../weather/types';
import { GameWorld } from '../World';
import { GuestSimulation } from './GuestSimulation';
import { THOUGHTS, holdsSouvenir, souvenirBit, souvenirPriceLimit } from './life';
import type { Guest } from './types';

/**
 * Phase 32: the Phase 29 guest-life rules no earlier test pinned. A balloon slipping away (the bit, the mood drop, the
 * pause only for a wandering guest), the keepsake mood lifts and their ceiling, stopping to watch a running ride, hot
 * thirst, the souvenir money reserve and price limit, and the sulk after giving up on a shop queue. Tests only: every
 * number comes from GAME_CONFIG, nothing is retuned. The sick pile's litter penalty is in
 * `operations/OperationsSimulation.phase32.test.ts`.
 */

const LIFE = GAME_CONFIG.guestLife;
const SOUVENIR = LIFE.souvenir;

/** A street up from the gate with a roundabout beside it; `extras` places more objects. */
const createPark = (extras: ReadonlyArray<readonly [string, number, number]> = []) => {
  const world = new GameWorld();
  const street = [];
  for (let y = 31; y >= 20; y -= 1) street.push({ x: 15, y });
  world.buildPaths(street);
  world.addMoney(100_000);
  world.buildObject('petal-roundabout', { x: 16, y: 26 });
  for (const [id, x, y] of extras) {
    if (!world.buildObject(id, { x, y })) throw new Error(`could not place ${id} at ${x},${y}`);
  }
  const conditions = neutralConditions();
  const scenery = new ScenerySimulation(world);
  scenery.syncWithWorld();
  const rides = new RideSimulation(world);
  const shops = new ShopSimulation(world);
  const guests = new GuestSimulation(world, rides, shops, 3232, scenery);
  rides.setConditions(conditions);
  guests.setConditions(conditions);
  rides.syncWithWorld(guests.guests);
  shops.syncWithWorld(guests.guests);
  const step = (ticks = 1): void => {
    for (let tick = 0; tick < ticks; tick += 1) {
      guests.step(100);
      rides.step(100, guests.guests);
      shops.step(100, guests.guests);
    }
  };
  return { world, conditions, rides, shops, guests, step };
};

type Park = ReturnType<typeof createPark>;

const objectIdOf = (world: GameWorld, definitionId: string): number => (
  [...world.objects.values()].find((object) => object.definitionId === definitionId)!.id
);

/** One fresh guest standing on the street at (15, y), wandering, with nothing to do. */
const standingGuest = (park: Park, y = 27): Guest => {
  park.guests.spawnGuests(1);
  const guest = [...park.guests.guests.values()].at(-1)!;
  guest.position = { x: 15, y };
  guest.currentCell = { x: 15, y };
  guest.route = [{ x: 15, y }];
  guest.routeIndex = 1;
  guest.state = 'wandering';
  guest.stateTimerSeconds = 10;
  return guest;
};

/** Runs `body` with the guest simulation's random stream answering `value` to every draw. */
const withRandom = <T>(park: Park, value: number, body: () => T): T => {
  const random = (park.guests as unknown as { random: { next: () => number } }).random;
  const next = random.next;
  random.next = () => value;
  try {
    return body();
  } finally {
    random.next = next;
  }
};

/**
 * `seconds` whole seconds of needs (the 1 s need tick) for guests kept standing after an activity, so no decision,
 * walk or pause moves them: only `updateNeeds` touches their happiness and thirst.
 */
const standStill = (park: Park, guests: readonly Guest[], seconds: number): void => {
  for (const guest of guests) guest.needTimerSeconds = 0;
  for (let second = 0; second < seconds; second += 1) {
    for (const guest of guests) {
      guest.state = 'wandering';
      guest.activity = null;
      guest.routeIndex = guest.route.length;
      guest.stateTimerSeconds = 0;
    }
    park.guests.step(1000);
  }
};

describe('a balloon slips away', () => {
  /** A guest holding a balloon whose next step runs the 1 s need tick. */
  const balloonGuest = (park: Park, y = 27): Guest => {
    const guest = standingGuest(park, y);
    guest.souvenirs = souvenirBit('balloon') | souvenirBit('plush');
    guest.happiness = 70;
    guest.needTimerSeconds = GAME_CONFIG.guests.needUpdateSeconds;
    return guest;
  };
  /** The need tick's length for a guest primed by `balloonGuest`, stepped once by 100 ms. */
  const tickSeconds = GAME_CONFIG.guests.needUpdateSeconds + 0.1;

  it('a wandering guest loses the bit, the mood drop, and stops mid-route to watch it go', () => {
    const park = createPark();
    const guest = balloonGuest(park);
    guest.route = [{ x: 15, y: 27 }, { x: 15, y: 26 }, { x: 15, y: 25 }, { x: 15, y: 24 }];
    guest.routeIndex = 1;
    const before = guest.happiness;
    withRandom(park, 0, () => park.guests.step(100));
    expect(holdsSouvenir(guest, 'balloon'), 'the balloon is gone').toBe(false);
    expect(holdsSouvenir(guest, 'plush'), 'only the balloon bit is cleared').toBe(true);
    // The keepsake lift runs first in the same need tick (balloon and plush, under the ceiling), then the loss.
    const lift = (SOUVENIR.balloonHappinessPerSecond + SOUVENIR.plushHappinessPerSecond) * tickSeconds;
    expect(guest.happiness).toBeCloseTo(before + lift - SOUVENIR.balloonLossHappiness, 6);
    expect([guest.state, guest.activity, guest.currentThought]).toEqual(['pausing', 'balloonLost', THOUGHTS.balloonLost]);
    expect(guest.routeIndex, 'the walk stops where they stand').toBe(guest.route.length);
    // The pause runs its course, then the guest decides afresh.
    park.step(Math.ceil(LIFE.pauseSeconds.balloonLost * 10) + 1);
    expect(guest.state).not.toBe('pausing');
    expect(guest.activity).toBeNull();
    expect(holdsSouvenir(guest, 'balloon'), 'a lost balloon stays lost').toBe(false);
  });

  it('a guest on their way to a ride or in a queue loses it too, but does not stop', () => {
    const park = createPark();
    const ride = objectIdOf(park.world, 'petal-roundabout');
    const walker = balloonGuest(park, 22);
    walker.state = 'walkingToRide';
    walker.destinationObjectId = ride;
    walker.route = [{ x: 15, y: 22 }, { x: 15, y: 23 }, { x: 15, y: 24 }, { x: 15, y: 25 }, { x: 15, y: 26 }];
    walker.routeIndex = 1;
    const queued = balloonGuest(park, 26);
    expect(park.rides.joinQueue(ride, queued)).toBe('joined');
    queued.destinationObjectId = ride;
    queued.stateTimerSeconds = 0;
    queued.needTimerSeconds = GAME_CONFIG.guests.needUpdateSeconds;
    queued.happiness = 70;
    withRandom(park, 0, () => park.guests.step(100));
    for (const guest of [walker, queued]) {
      expect(holdsSouvenir(guest, 'balloon'), `guest ${guest.id} lost it`).toBe(false);
      expect(guest.currentThought).toBe(THOUGHTS.balloonLost);
      expect(guest.activity).toBeNull();
      expect(guest.happiness).toBeLessThan(70 - SOUVENIR.balloonLossHappiness + 1);
    }
    expect(walker.state, 'still walking to the ride').toBe('walkingToRide');
    expect(walker.destinationObjectId).toBe(ride);
    expect(queued.state, 'still in the queue').toBe('queueing');
  });

  it('nothing slips away indoors, and the chance is the configured rate per second', () => {
    const park = createPark();
    const rider = balloonGuest(park);
    rider.state = 'riding';
    withRandom(park, 0, () => park.guests.step(100));
    expect(holdsSouvenir(rider, 'balloon'), 'a rider keeps it').toBe(true);
    park.guests.guests.delete(rider.id);

    const chance = SOUVENIR.balloonLossPerSecond * tickSeconds;
    const kept = balloonGuest(park);
    withRandom(park, chance + 1e-9, () => park.guests.step(100));
    expect(holdsSouvenir(kept, 'balloon'), 'a draw just above the chance keeps it').toBe(true);
    park.guests.guests.delete(kept.id);
    const lost = balloonGuest(park);
    withRandom(park, chance - 1e-9, () => park.guests.step(100));
    expect(holdsSouvenir(lost, 'balloon'), 'a draw just below loses it').toBe(false);
  });
});

describe('keepsakes lift the mood, up to a ceiling', () => {
  it('a balloon, a plush and a glow wand at night each lift happiness at their own rate', () => {
    const park = createPark();
    const kinds = {
      none: 0,
      balloon: souvenirBit('balloon'),
      plush: souvenirBit('plush'),
      glow: souvenirBit('glowWand'),
      all: souvenirBit('balloon') | souvenirBit('plush') | souvenirBit('glowWand'),
    };
    const run = (night: boolean): Record<keyof typeof kinds, number> => {
      park.conditions.night = night;
      const guests = Object.entries(kinds).map(([kind, bits]) => {
        const guest = standingGuest(park);
        guest.souvenirs = bits;
        guest.happiness = 60;
        return [kind, guest] as const;
      });
      // Draws of 0.999: no balloon slips away while we measure.
      withRandom(park, 0.999, () => standStill(park, guests.map(([, guest]) => guest), 10));
      for (const [, guest] of guests) park.guests.guests.delete(guest.id);
      return Object.fromEntries(guests.map(([kind, guest]) => [kind, guest.happiness - 60])) as Record<keyof typeof kinds, number>;
    };
    const day = run(false);
    expect(day.balloon - day.none).toBeCloseTo(SOUVENIR.balloonHappinessPerSecond * 10, 6);
    expect(day.plush - day.none).toBeCloseTo(SOUVENIR.plushHappinessPerSecond * 10, 6);
    expect(day.glow - day.none, 'a glow wand does nothing by day').toBeCloseTo(0, 6);
    const night = run(true);
    expect(night.glow - night.none).toBeCloseTo(SOUVENIR.glowHappinessPerSecond * 10, 6);
    expect(night.all - night.none).toBeCloseTo(
      (SOUVENIR.balloonHappinessPerSecond + SOUVENIR.plushHappinessPerSecond + SOUVENIR.glowHappinessPerSecond) * 10, 6);
  });

  it('the lift stops at the ceiling and never pulls a happier guest down', () => {
    const park = createPark();
    park.conditions.night = true;
    const all = souvenirBit('balloon') | souvenirBit('plush') | souvenirBit('glowWand');
    const near = standingGuest(park);
    near.souvenirs = all;
    near.happiness = SOUVENIR.maximumHappiness - 0.05;
    const above = standingGuest(park);
    above.souvenirs = all;
    above.happiness = SOUVENIR.maximumHappiness + 3;
    withRandom(park, 0.999, () => standStill(park, [near, above], 10));
    expect(near.happiness).toBe(SOUVENIR.maximumHappiness);
    expect(above.happiness).toBe(SOUVENIR.maximumHappiness + 3);
  });
});

describe('stopping to watch a running ride', () => {
  const decide = (park: Park, y: number, draw: number): Guest => {
    const guest = standingGuest(park, y);
    guest.energy = 100;
    withRandom(park, draw, () => park.guests.step(100));
    return guest;
  };
  const chebyshevToRide = (park: Park, y: number): number => {
    const ride = park.world.objects.get(objectIdOf(park.world, 'petal-roundabout'))!;
    return Math.min(...park.world.objectFootprint(ride).map((cell) => Math.max(Math.abs(cell.x - 15), Math.abs(cell.y - y))));
  };

  it('a guest near a running ride sometimes stops to watch it, facing it, then carries on', () => {
    const park = createPark();
    const ride = objectIdOf(park.world, 'petal-roundabout');
    park.rides.getRide(ride)!.status = 'running';
    const guest = decide(park, 27, 0);
    expect([guest.state, guest.activity, guest.destinationObjectId, guest.currentThought])
      .toEqual(['pausing', 'watchRide', ride, THOUGHTS.watchRide]);
    park.guests.step(Math.ceil(LIFE.pauseSeconds.watchRide * 1000) + 100);
    expect(guest.activity).not.toBe('watchRide');
    expect(guest.state).not.toBe('pausing');
  });

  it('only a running ride, only within the watch distance, and only at the configured chance', () => {
    const park = createPark();
    const ride = objectIdOf(park.world, 'petal-roundabout');
    const runtime = park.rides.getRide(ride)!;
    runtime.status = 'idle';
    expect(decide(park, 27, 0).activity, 'an idle ride is not watched').not.toBe('watchRide');
    runtime.status = 'running';
    const edge = 26 - LIFE.admire.watchRideDistance;
    expect(chebyshevToRide(park, edge)).toBe(LIFE.admire.watchRideDistance);
    expect(decide(park, edge, 0).activity, 'at the watch distance').toBe('watchRide');
    expect(chebyshevToRide(park, edge - 1)).toBe(LIFE.admire.watchRideDistance + 1);
    expect(decide(park, edge - 1, 0).activity, 'one cell further').not.toBe('watchRide');
    expect(decide(park, 27, LIFE.admire.watchRideChance).activity, 'a draw at the chance').not.toBe('watchRide');
    expect(decide(park, 27, LIFE.admire.watchRideChance - 1e-9).activity, 'just below it').toBe('watchRide');
  });
});

describe('hot thirst', () => {
  it('a hot guest grows thirsty hotThirstFactor times as fast, from the hot threshold on', () => {
    const park = createPark();
    park.conditions.ambientWarmth = LIFE.warmth.hot;
    const make = (warmth: number): Guest => {
      const guest = standingGuest(park);
      guest.warmth = warmth;
      guest.thirst = 10;
      return guest;
    };
    const hot = make(LIFE.warmth.hot);
    const comfortable = make(LIFE.warmth.hot - 0.01);
    standStill(park, [hot, comfortable], 1);
    expect(hot.warmth, 'still hot after the drift').toBeGreaterThanOrEqual(LIFE.warmth.hot);
    expect(comfortable.warmth).toBeLessThan(LIFE.warmth.hot);
    expect(comfortable.thirst - 10).toBeCloseTo(GAME_CONFIG.guests.thirstPerSecond, 9);
    expect((hot.thirst - 10) / (comfortable.thirst - 10)).toBeCloseTo(LIFE.warmth.hotThirstFactor, 9);
  });
});

describe('the souvenir reserve and price limit', () => {
  interface Internals {
    serviceDestinations: ReadonlyArray<{ object: { id: number } }>;
    souvenirChoice(guest: Guest, destination: unknown, price: number): { servicePriceLimit: number | null } | null;
  }

  const balloonStall = () => {
    const park = createPark([['balloon-bouquet', 16, 29]]);
    const stall = objectIdOf(park.world, 'balloon-bouquet');
    park.guests.step(100);
    const internals = park.guests as unknown as Internals;
    const destination = internals.serviceDestinations.find((candidate) => candidate.object.id === stall)!;
    expect(destination, 'the stall is a destination').toBeDefined();
    const guest = standingGuest(park, 29);
    // Happiness 60: no mood bonus, so the desire is the balloon's base desire.
    guest.happiness = 60;
    const choose = (money: number, price: number) => {
      guest.money = money;
      return internals.souvenirChoice(guest, destination, price);
    };
    return { park, stall, guest, choose };
  };

  it('a guest keeps the reserve back: price plus reserve, not a cent less', () => {
    const { choose } = balloonStall();
    const price = 3;
    expect(choose(price + SOUVENIR.reserve, price)).not.toBeNull();
    expect(choose(price + SOUVENIR.reserve - 0.01, price)).toBeNull();
  });

  it('a guest pays at most the price limit for their desire, and carries the limit to the counter', () => {
    const { choose, guest } = balloonStall();
    const limit = souvenirPriceLimit('balloon', SOUVENIR.baseDesire.balloon);
    expect(limit).toBeCloseTo(SOUVENIR.fairPrice.balloon * (SOUVENIR.minimumPriceShare + SOUVENIR.baseDesire.balloon / SOUVENIR.desirePerShare), 9);
    expect(choose(100, limit)?.servicePriceLimit).toBeCloseTo(limit, 9);
    expect(choose(100, limit + 0.01)).toBeNull();
    guest.souvenirs = souvenirBit('balloon');
    expect(choose(100, 1), 'nobody buys a keepsake they hold').toBeNull();
  });

  it('in play: a guest short of the reserve never heads for the stall, one with money to spare does', () => {
    const park = createPark([['balloon-bouquet', 16, 29]]);
    const stall = objectIdOf(park.world, 'balloon-bouquet');
    park.rides.setOpen(objectIdOf(park.world, 'petal-roundabout'), false);
    const price = park.shops.getService(stall)!.itemPrice;
    const heads = (money: number): number => {
      let picked = 0;
      for (let trial = 0; trial < 40; trial += 1) {
        const guest = standingGuest(park, 27);
        guest.happiness = 90;
        guest.energy = 100;
        guest.money = money;
        park.guests.step(100);
        if (guest.state === 'walkingToShop' && guest.destinationObjectId === stall) picked += 1;
        park.guests.guests.delete(guest.id);
      }
      return picked;
    };
    expect(heads(price + SOUVENIR.reserve - 0.01)).toBe(0);
    expect(heads(50)).toBeGreaterThan(0);
  });
});

describe('the shop-queue sulk', () => {
  it('giving up on a stall queue costs happiness, stomps for the sulk, then wanders, still naming the stall', () => {
    const park = createPark([['brolly-booth', 16, 29]]);
    const booth = objectIdOf(park.world, 'brolly-booth');
    park.guests.step(100);
    const guest = standingGuest(park, 29);
    guest.money = 100;
    expect(park.shops.joinQueue(booth, guest)).toBe('joined');
    expect([guest.state, guest.destinationObjectId]).toEqual(['queueingForShop', booth]);
    // Within their patience and with no wait, they stay in the queue.
    guest.needTimerSeconds = 0;
    park.guests.step(100);
    expect(guest.state).toBe('queueingForShop');

    guest.stateTimerSeconds = guest.patienceSeconds + 1;
    guest.needTimerSeconds = 0;
    const before = guest.happiness;
    park.guests.step(100);
    expect(guest.happiness).toBeCloseTo(before - 5, 9);
    expect([guest.state, guest.activity, guest.currentThought, guest.thoughtObjectId])
      .toEqual(['pausing', 'sulk', 'This queue is taking forever.', booth]);
    expect(park.shops.getService(booth)!.queueGuestIds, 'out of the queue').not.toContain(guest.id);
    park.guests.step(Math.ceil(LIFE.pauseSeconds.sulk * 1000) + 100);
    expect([guest.state, guest.activity, guest.currentThought, guest.thoughtObjectId])
      .toEqual(['wandering', null, 'This queue is taking forever.', booth]);
  });
});
