import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { RideSimulation } from '../rides/RideSimulation';
import { ScenerySimulation } from '../scenery/ScenerySimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { neutralConditions } from '../weather/types';
import { GameWorld } from '../World';
import { GuestSimulation } from './GuestSimulation';
import {
  ALL_SOUVENIR_BITS,
  THOUGHTS,
  afterPurchase,
  afterRide,
  holdsSouvenir,
  nauseaGain,
  souvenirBit,
  souvenirDesire,
  souvenirPriceLimit,
  targetWarmth,
} from './life';
import type { Guest } from './types';

/**
 * Phase 29: guest life. The pure rules (life.ts) and how the guest simulation lives them: benches, pauses, nausea and
 * being sick, warmth, souvenirs.
 */

const LIFE = GAME_CONFIG.guestLife;

/** A street up from the gate; `extras` places more objects beside it. */
const createPark = (extras: ReadonlyArray<readonly [string, number, number, (0 | 1 | 2 | 3)?]> = []) => {
  const world = new GameWorld();
  const street = [];
  for (let y = 31; y >= 20; y -= 1) street.push({ x: 15, y });
  world.buildPaths(street);
  world.addMoney(100_000);
  world.buildObject('petal-roundabout', { x: 16, y: 26 });
  for (const [id, x, y, rotation] of extras) {
    if (!world.buildObject(id, { x, y }, rotation ?? 0)) throw new Error(`could not place ${id} at ${x},${y}`);
  }
  const conditions = neutralConditions();
  const scenery = new ScenerySimulation(world);
  scenery.syncWithWorld();
  const rides = new RideSimulation(world);
  const shops = new ShopSimulation(world);
  const guests = new GuestSimulation(world, rides, shops, 2929, scenery);
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

const objectIdOf = (world: GameWorld, definitionId: string): number => (
  [...world.objects.values()].find((object) => object.definitionId === definitionId)!.id
);

/** One fresh guest standing on the street at (15, y), wandering, with nothing to do. */
const standingGuest = (park: ReturnType<typeof createPark>, y = 27): Guest => {
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

describe('the pure rules', () => {
  it('a gentle ride never unsettles a stomach; an intense one does, more for a gentle guest and on a full stomach', () => {
    expect(nauseaGain(LIFE.nausea.minimumIntensity, 20, 50)).toBe(0);
    expect(nauseaGain(10, 10, 5)).toBe(0);
    const thrillSeeker = nauseaGain(86, 90, 50);
    const gentle = nauseaGain(86, 20, 50);
    expect(thrillSeeker).toBeGreaterThan(0);
    expect(gentle).toBeGreaterThan(thrillSeeker);
    expect(nauseaGain(86, 20, 10)).toBeCloseTo(gentle * LIFE.nausea.fullStomachFactor);
  });

  it('after a ride: queasy guests stop, delighted ones cheer (a flourish: they stay wandering), others carry on', () => {
    const guest = { state: 'wandering', activity: null, nausea: 0, preferredIntensity: 20, hunger: 50, route: [], routeIndex: 0 } as unknown as Guest;
    afterRide(guest, 20, 90);
    expect([guest.state, guest.activity]).toEqual(['wandering', 'cheer']);
    guest.activity = null;
    afterRide(guest, 20, 50);
    expect(guest.activity).toBeNull();
    guest.nausea = LIFE.nausea.queasy;
    afterRide(guest, 30, 90);
    expect([guest.state, guest.activity, guest.currentThought]).toEqual(['pausing', 'queasy', THOUGHTS.queasy]);
  });

  it('after a purchase: warm items warm, cold ones cool, souvenirs are kept, and the guest eats, drinks or shows off', () => {
    const guest = { state: 'wandering', activity: null, warmth: 50, souvenirs: 0 } as unknown as Guest;
    afterPurchase(guest, 'food', 'warm', undefined);
    expect([guest.warmth, guest.activity, guest.state]).toEqual([50 + LIFE.warmth.itemWarmth, 'eat', 'wandering']);
    afterPurchase(guest, 'drink', 'cold', undefined);
    expect([guest.warmth, guest.activity]).toEqual([50, 'drink']);
    afterPurchase(guest, 'souvenir', undefined, 'balloon');
    expect(holdsSouvenir(guest, 'balloon')).toBe(true);
    expect(guest.activity).toBe('showOff');
    afterPurchase(guest, 'toilet', undefined, undefined);
    expect(guest.souvenirs).toBe(souvenirBit('balloon'));
  });

  it('souvenir bits cover exactly the five keepsakes', () => {
    expect(ALL_SOUVENIR_BITS).toBe(31);
    expect(['umbrella', 'hat', 'balloon', 'plush', 'glowWand'].map((kind) => souvenirBit(kind as never))).toEqual([1, 2, 4, 8, 16]);
  });

  it('rain sells umbrellas, heat sells hats, night sells glow wands, a good mood sells balloons; nobody buys one twice', () => {
    const conditions = neutralConditions();
    const guest = { souvenirs: 0, warmth: 50, happiness: 60 };
    const dry = souvenirDesire(guest, 'umbrella', conditions);
    conditions.weatherKind = 'rain';
    conditions.weatherIntensity = 1;
    expect(souvenirDesire(guest, 'umbrella', conditions)).toBeGreaterThan(dry + 50);
    expect(souvenirDesire({ ...guest, souvenirs: souvenirBit('umbrella') }, 'umbrella', conditions)).toBe(0);
    expect(souvenirDesire({ ...guest, warmth: 85 }, 'hat', conditions)).toBeGreaterThan(souvenirDesire(guest, 'hat', conditions));
    const day = souvenirDesire(guest, 'glowWand', conditions);
    conditions.night = true;
    expect(souvenirDesire(guest, 'glowWand', conditions)).toBeGreaterThan(day);
    expect(souvenirDesire({ ...guest, happiness: 90 }, 'balloon', conditions)).toBeGreaterThan(souvenirDesire(guest, 'balloon', conditions));
    // A guest who barely wants an umbrella will not pay its shelf price; a soaked one will pay more.
    expect(souvenirPriceLimit('umbrella', 2)).toBeLessThan(6);
    expect(souvenirPriceLimit('umbrella', 72)).toBeGreaterThan(6);
  });

  it('a sun hat halves the heat, an umbrella keeps the rain chill off', () => {
    const conditions = neutralConditions();
    conditions.ambientWarmth = 90;
    expect(targetWarmth({ souvenirs: 0 }, conditions)).toBe(90);
    expect(targetWarmth({ souvenirs: souvenirBit('hat') }, conditions)).toBe(70);
    conditions.ambientWarmth = 30;
    conditions.weatherKind = 'rain';
    conditions.weatherIntensity = 0.8;
    expect(targetWarmth({ souvenirs: 0 }, conditions)).toBe(30);
    expect(targetWarmth({ souvenirs: souvenirBit('umbrella') }, conditions)).toBe(LIFE.warmth.umbrellaFloor);
  });
});

describe('benches', () => {
  it('a tired guest walks to a free seat, sits, gets their energy back and gets up rested', () => {
    const park = createPark([['ribbon-bench', 14, 25]]);
    const benchId = objectIdOf(park.world, 'ribbon-bench');
    const guest = standingGuest(park, 28);
    guest.energy = LIFE.bench.seekChanceEnergy - 5;
    park.step();
    expect([guest.state, guest.destinationObjectId, guest.activity]).toEqual(['walkingToBench', benchId, 'seatLeft']);
    let sat = false;
    let rested = false;
    for (let tick = 0; tick < 600 && !rested; tick += 1) {
      park.step();
      if (guest.state === 'resting') sat = true;
      if (sat && guest.state !== 'resting') rested = true;
    }
    expect(sat, 'sat down').toBe(true);
    expect(rested, 'got up again').toBe(true);
    expect(guest.energy).toBeGreaterThan(LIFE.bench.seekEnergy);
    expect(guest.activity === null || guest.state === 'wandering' || guest.state === 'pausing').toBe(true);
  });

  it('two guests share a bench, one per seat, and a third finds no seat', () => {
    const park = createPark([['ribbon-bench', 14, 25]]);
    const tired = [standingGuest(park, 28), standingGuest(park, 28), standingGuest(park, 28)];
    for (const guest of tired) guest.energy = 10;
    park.step();
    const seats = tired.filter((guest) => guest.state === 'walkingToBench').map((guest) => guest.activity).sort();
    expect(seats).toEqual(['seatLeft', 'seatRight']);
    expect(tired.filter((guest) => guest.state !== 'walkingToBench')).toHaveLength(1);
  });

  it('nobody heads for a bench they cannot reach, and a park without benches says so', () => {
    const park = createPark();
    const guest = standingGuest(park, 28);
    guest.energy = 20;
    guest.stateTimerSeconds = 30;
    park.step(12);
    expect(guest.state).not.toBe('walkingToBench');
    expect(park.guests.thoughtInsights(20).some((insight) => insight.text.includes('bench'))
      || guest.currentThought === THOUGHTS.noBench || guest.state !== 'wandering').toBe(true);
  });

  it('a bulldozed bench sends its sitter on their way', () => {
    const park = createPark([['ribbon-bench', 14, 25]]);
    const guest = standingGuest(park, 25);
    guest.energy = 10;
    for (let tick = 0; tick < 100 && guest.state !== 'resting'; tick += 1) park.step();
    expect(guest.state).toBe('resting');
    park.world.bulldoze({ x: 14, y: 25 });
    park.step();
    expect(guest.state).not.toBe('resting');
    expect(guest.activity === null || guest.state === 'pausing').toBe(true);
  });
});

describe('pauses', () => {
  it('a queasy guest who is still sick at the end of the pause is sick on the path, and feels better for it', () => {
    const park = createPark();
    const guest = standingGuest(park);
    guest.nausea = 95;
    guest.state = 'pausing';
    guest.activity = 'queasy';
    guest.stateTimerSeconds = 0;
    const happiness = guest.happiness;
    park.step(Math.ceil(LIFE.pauseSeconds.queasy * 10) + 1);
    expect([guest.state, guest.activity, guest.currentThought]).toEqual(['pausing', 'vomit', THOUGHTS.vomit]);
    expect(guest.nausea).toBeLessThanOrEqual(LIFE.nausea.afterVomit);
    expect(guest.happiness).toBeLessThan(happiness);
    expect(park.guests.drainSickCells()).toEqual([{ x: 15, y: 27 }]);
    expect(park.guests.drainSickCells(), 'drained once').toEqual([]);
    park.step(Math.ceil(LIFE.pauseSeconds.vomit * 10) + 1);
    expect(guest.state).not.toBe('pausing');
    expect(guest.activity === null || (guest.state as string) === 'wandering').toBe(true);
  });

  it('a queasy guest whose stomach settled just carries on', () => {
    const park = createPark();
    const guest = standingGuest(park);
    guest.nausea = LIFE.nausea.queasy;
    guest.state = 'pausing';
    guest.activity = 'queasy';
    guest.stateTimerSeconds = 0;
    park.step(Math.ceil(LIFE.pauseSeconds.queasy * 10) + 1);
    expect(guest.activity).not.toBe('vomit');
    expect(park.guests.drainSickCells()).toEqual([]);
  });

  it('a queasy guest steers clear of intense rides and puts off food', () => {
    const park = createPark([['thunder-drum', 12, 26], ['picnic-pocket', 16, 29]]);
    const drum = objectIdOf(park.world, 'thunder-drum');
    const choices = (nausea: number): number => {
      let picked = 0;
      for (let trial = 0; trial < 30; trial += 1) {
        const guest = standingGuest(park, 27);
        guest.nausea = nausea;
        guest.preferredIntensity = 60;
        guest.money = 200;
        guest.stateTimerSeconds = 30;
        park.guests.step(100);
        if (guest.destinationObjectId === drum) picked += 1;
        park.guests.guests.delete(guest.id);
      }
      return picked;
    };
    expect(choices(90)).toBeLessThan(choices(0));
  });

  it('giving up on a queue is a stomp of frustration first, then a wander', () => {
    const park = createPark();
    const ride = objectIdOf(park.world, 'petal-roundabout');
    const guest = standingGuest(park, 26);
    expect(park.rides.joinQueue(ride, guest)).toBe('joined');
    guest.destinationObjectId = ride;
    guest.stateTimerSeconds = guest.patienceSeconds + 1;
    park.guests.step(100);
    expect([guest.state, guest.activity]).toEqual(['pausing', 'sulk']);
    park.step(Math.ceil(LIFE.pauseSeconds.sulk * 10) + 2);
    expect(guest.state).toBe('wandering');
    expect(guest.activity).toBeNull();
  });

  it('a hot guest fans themself and seeks a cold treat; a cold one shivers and seeks a warm one', () => {
    const park = createPark([['glacier-scoop', 13, 29], ['cocoa-chalet', 16, 29]]);
    const scoop = objectIdOf(park.world, 'glacier-scoop');
    const cocoa = objectIdOf(park.world, 'cocoa-chalet');
    const tally = (warmth: number) => {
      const out = { fan: 0, shiver: 0, scoop: 0, cocoa: 0 };
      for (let trial = 0; trial < 60; trial += 1) {
        const guest = standingGuest(park, 28);
        guest.warmth = warmth;
        guest.hunger = 60;
        guest.money = 200;
        guest.stateTimerSeconds = 30;
        park.guests.step(100);
        if (guest.activity === 'fanSelf') out.fan += 1;
        if (guest.activity === 'shiver') out.shiver += 1;
        if (guest.destinationObjectId === scoop) out.scoop += 1;
        if (guest.destinationObjectId === cocoa) out.cocoa += 1;
        park.guests.guests.delete(guest.id);
      }
      return out;
    };
    const hot = tally(95);
    const cold = tally(5);
    expect(hot.fan).toBeGreaterThan(0);
    expect(hot.shiver).toBe(0);
    expect(cold.shiver).toBeGreaterThan(0);
    expect(cold.fan).toBe(0);
    expect(hot.scoop).toBeGreaterThan(hot.cocoa);
    expect(cold.cocoa).toBeGreaterThan(cold.scoop);
  });

  it('a guest on a lovely spot sometimes stops to admire (or photograph) the scenery, facing it', () => {
    const extras: Array<readonly [string, number, number]> = [];
    for (let y = 21; y <= 29; y += 2) extras.push(['ripple-fountain', 13, y] as const);
    const park = createPark(extras);
    let admired = 0;
    for (let trial = 0; trial < 60; trial += 1) {
      const guest = standingGuest(park, 26);
      guest.stateTimerSeconds = 30;
      park.guests.step(100);
      if (guest.state === 'pausing' && (guest.activity === 'admire' || guest.activity === 'photo')) {
        admired += 1;
        expect(park.world.objects.get(guest.destinationObjectId!)?.definitionId).toBe('ripple-fountain');
      }
      park.guests.guests.delete(guest.id);
    }
    expect(admired).toBeGreaterThan(0);
  });
});

describe('warmth, rain and souvenirs over time', () => {
  it('warmth drifts toward the park and stays put in neutral weather', () => {
    const park = createPark();
    const guest = standingGuest(park);
    park.step(100);
    expect(guest.warmth).toBeCloseTo(LIFE.warmth.neutral, 5);
    park.conditions.ambientWarmth = 95;
    const before = guest.warmth;
    park.guests.step(1000);
    expect(guest.warmth).toBeGreaterThan(before);
  });

  it('rain soaks guests without an umbrella, not those with one', () => {
    const run = (souvenirs: number): number => {
      const park = createPark();
      park.conditions.weatherKind = 'rain';
      park.conditions.weatherIntensity = 1;
      const guest = standingGuest(park);
      guest.souvenirs = souvenirs;
      guest.happiness = 70;
      // Needs and thoughts tick once a second; keep the guest standing so nothing else moves happiness.
      for (let second = 0; second < 20; second += 1) {
        guest.stateTimerSeconds = 0;
        guest.state = 'wandering';
        guest.routeIndex = guest.route.length;
        park.guests.step(1000);
      }
      return guest.happiness;
    };
    expect(run(0)).toBeLessThan(run(souvenirBit('umbrella')));
  });

  it('guests buy umbrellas in the rain from a souvenir stall, which records souvenir sales', () => {
    const park = createPark([['brolly-booth', 16, 29]]);
    park.conditions.weatherKind = 'rain';
    park.conditions.weatherIntensity = 1;
    park.guests.spawnGuests(30);
    for (const guest of park.guests.guests.values()) guest.money = 100;
    park.step(1200);
    const holders = [...park.guests.guests.values()].filter((guest) => holdsSouvenir(guest, 'umbrella')).length;
    const sales = park.world.transactions.filter((transaction) => transaction.category === 'souvenir-revenue');
    expect(holders + sales.length).toBeGreaterThan(0);
    expect(sales.length).toBeGreaterThan(0);
  });
});

describe('the session wires it together', () => {
  it('where a guest is sick, the path gets a sick litter pile the same tick', async () => {
    const { ParkSession } = await import('../session/ParkSession');
    const session = new ParkSession(null);
    const street = [];
    for (let y = 31; y >= 24; y -= 1) street.push({ x: 15, y });
    session.world.buildPaths(street);
    session.world.buildObject('petal-roundabout', { x: 16, y: 26 });
    session.syncWithWorld();
    session.guests.spawnGuests(1);
    const guest = [...session.guests.guests.values()][0];
    guest.position = { x: 15, y: 27 };
    guest.currentCell = { x: 15, y: 27 };
    guest.route = [{ x: 15, y: 27 }];
    guest.routeIndex = 1;
    guest.state = 'pausing';
    guest.activity = 'queasy';
    guest.nausea = 99;
    guest.stateTimerSeconds = LIFE.pauseSeconds.queasy;
    session.step(GAME_CONFIG.fixedStepMs);
    expect(guest.activity).toBe('vomit');
    expect(session.operations.litter.get('15,27')).toMatchObject({ sick: true, units: GAME_CONFIG.operations.litter.sickUnits });
    // A save taken now carries the sick pile and no pending sick cell (the queue never outlives the tick).
    const restored = ParkSession.fromState(JSON.parse(JSON.stringify(session.serialize())));
    expect(restored.operations.litter.get('15,27')?.sick).toBe(true);
  });
});
