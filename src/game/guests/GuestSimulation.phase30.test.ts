import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { BUILD_BY_ID } from '../content/catalog';
import { RideSimulation } from '../rides/RideSimulation';
import { ScenerySimulation } from '../scenery/ScenerySimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { neutralConditions } from '../weather/types';
import { GameWorld } from '../World';
import { GuestSimulation, SOUVENIR_INSIGHT, type GuestCrowdReader } from './GuestSimulation';
import { COMPLAINT_THOUGHTS, PRICEY_SOUVENIR_THOUGHT, SOUVENIR_THOUGHT, THOUGHTS, setThought, souvenirBit, startPause } from './life';
import type { Guest } from './types';

/**
 * Phase 30: guest life readability and complaint links. The complaint link (`thoughtObjectId`) end to end, what Park
 * Pulse makes of the Phase 29 thoughts, the guest inspector reads (`guestNear`, `guestSnapshot`), the need gate on life
 * activities, bench walkers in a crowd, the pricey souvenir line and the sick-cell contract.
 */

const LIFE = GAME_CONFIG.guestLife;

/** A street up from the gate with a roundabout beside it; `extras` places more objects. */
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
  const guests = new GuestSimulation(world, rides, shops, 3030, scenery);
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

const complain = (guest: Guest, text: string, objectId: number | null): void => {
  setThought(guest, text, objectId);
};

describe('the complaint link (thoughtObjectId)', () => {
  it('setThought keeps the id only for a complaint line and clears it for anything else', () => {
    const guest = { currentThought: '', thoughtObjectId: null } as Pick<Guest, 'currentThought' | 'thoughtObjectId'>;
    for (const text of COMPLAINT_THOUGHTS) {
      setThought(guest, text, 7);
      expect(guest.thoughtObjectId, text).toBe(7);
    }
    setThought(guest, 'That was fun.', 7);
    expect(guest.thoughtObjectId).toBeNull();
    setThought(guest, 'This queue is taking forever.', 9);
    setThought(guest, THOUGHTS.hot);
    expect(guest.thoughtObjectId).toBeNull();
  });

  it('startPause keeps a complaint id for the sulk and clears it for any other pause', () => {
    const park = createPark();
    const guest = standingGuest(park);
    startPause(guest, 'sulk', 'This queue is taking forever.', null, 5);
    expect([guest.currentThought, guest.thoughtObjectId]).toEqual(['This queue is taking forever.', 5]);
    startPause(guest, 'queasy', THOUGHTS.queasy);
    expect(guest.thoughtObjectId).toBeNull();
  });

  it('a guest who gives up on a ride queue complains about that ride, through the sulk and the wander after it', () => {
    const park = createPark();
    const ride = objectIdOf(park.world, 'petal-roundabout');
    const guest = standingGuest(park, 26);
    expect(park.rides.joinQueue(ride, guest)).toBe('joined');
    expect(guest.thoughtObjectId, 'queueing is no complaint').toBeNull();
    guest.destinationObjectId = ride;
    guest.stateTimerSeconds = guest.patienceSeconds + 1;
    park.guests.step(100);
    expect([guest.state, guest.activity, guest.thoughtObjectId]).toEqual(['pausing', 'sulk', ride]);
    park.step(Math.ceil(LIFE.pauseSeconds.sulk * 10) + 2);
    expect([guest.state, guest.currentThought, guest.thoughtObjectId]).toEqual(['wandering', 'This queue is taking forever.', ride]);
    expect(park.guests.guestSnapshot(guest.id)).toMatchObject({ thoughtObjectId: ride, thoughtObjectName: 'Petal Roundabout' });
  });

  it('a balloon lost during the sulk keeps the queue complaint and its link (review fix)', () => {
    const park = createPark();
    const ride = objectIdOf(park.world, 'petal-roundabout');
    const guest = standingGuest(park, 26);
    guest.souvenirs = souvenirBit('balloon');
    startPause(guest, 'sulk', 'This queue is taking forever.', null, ride);
    guest.needTimerSeconds = GAME_CONFIG.guests.needUpdateSeconds;
    const random = (park.guests as unknown as { random: { next: () => number } }).random;
    const next = random.next.bind(random);
    random.next = () => 0;
    park.guests.step(100);
    random.next = next;
    expect(guest.souvenirs & souvenirBit('balloon'), 'the balloon is gone').toBe(0);
    expect([guest.currentThought, guest.thoughtObjectId]).toEqual(['This queue is taking forever.', ride]);
    park.step(Math.ceil(LIFE.pauseSeconds.sulk * 10) + 2);
    expect([guest.state, guest.currentThought, guest.thoughtObjectId]).toEqual(['wandering', 'This queue is taking forever.', ride]);
  });

  it('a guest who cannot pay at the ride entrance or at boarding complains about that ride', () => {
    const park = createPark();
    const ride = objectIdOf(park.world, 'petal-roundabout');
    park.rides.setTicketPrice(ride, 10);
    const walker = standingGuest(park, 26);
    walker.money = 1;
    walker.state = 'walkingToRide';
    walker.destinationObjectId = ride;
    walker.route = [{ x: 15, y: 27 }, { x: 15, y: 26 }];
    walker.routeIndex = 2;
    park.guests.step(100);
    expect([walker.currentThought, walker.thoughtObjectId]).toEqual(["I'm not paying that much.", ride]);

    const boarder = standingGuest(park, 26);
    boarder.money = 20;
    expect(park.rides.joinQueue(ride, boarder)).toBe('joined');
    boarder.money = 1;
    for (let tick = 0; tick < 200 && boarder.state === 'queueing'; tick += 1) park.rides.step(100, park.guests.guests);
    expect([boarder.state, boarder.currentThought, boarder.thoughtObjectId]).toEqual(['wandering', "I'm not paying that much.", ride]);
  });

  it('a guest turned away at a stall for the price complains about that stall', () => {
    const park = createPark([['brolly-booth', 16, 29]]);
    const booth = objectIdOf(park.world, 'brolly-booth');
    park.shops.setPrice(booth, 12);
    const guest = standingGuest(park, 29);
    guest.money = 100;
    guest.servicePriceLimit = 8;
    expect(park.shops.joinQueue(booth, guest), 'the price limit is checked at the door').toBe('unaffordable');
    guest.servicePriceLimit = null;
    expect(park.shops.joinQueue(booth, guest)).toBe('joined');
    guest.servicePriceLimit = 8;
    for (let tick = 0; tick < 50 && guest.state === 'queueingForShop'; tick += 1) park.shops.step(100, park.guests.guests);
    expect([guest.state, guest.currentThought, guest.thoughtObjectId]).toEqual(['wandering', "I'm not paying that much.", booth]);
  });

  it('the chooseDestination-level price complaint (every option too dear) carries no building', () => {
    const park = createPark();
    const ride = objectIdOf(park.world, 'petal-roundabout');
    park.rides.setTicketPrice(ride, 25);
    const guest = standingGuest(park, 27);
    guest.money = 100;
    guest.stateTimerSeconds = 30;
    for (let trial = 0; trial < 40 && guest.currentThought !== "I'm not paying that much."; trial += 1) {
      guest.state = 'wandering';
      guest.route = [guest.currentCell];
      guest.routeIndex = 1;
      guest.stateTimerSeconds = 30;
      park.guests.step(100);
    }
    expect(guest.currentThought).toBe("I'm not paying that much.");
    expect(guest.thoughtObjectId).toBeNull();
  });
});

describe('Park Pulse insights (thoughtInsights)', () => {
  it('two resting guests, two bench seekers and two recovered guests produce no raw line', () => {
    const park = createPark();
    for (const text of [THOUGHTS.sitDown, 'Looking for somewhere to sit.', THOUGHTS.recovered]) {
      for (let index = 0; index < 2; index += 1) setThought(standingGuest(park), text);
    }
    expect(park.guests.thoughtInsights(10)).toEqual([]);
  });

  it('souvenir holders, the glow wand at night and a dry guest under an umbrella read as one souvenir line', () => {
    const park = createPark();
    setThought(standingGuest(park), SOUVENIR_THOUGHT.balloon);
    setThought(standingGuest(park), SOUVENIR_THOUGHT.plush);
    setThought(standingGuest(park), THOUGHTS.glowing);
    setThought(standingGuest(park), THOUGHTS.dryUnderUmbrella);
    expect(park.guests.thoughtInsights()).toEqual([{ text: SOUVENIR_INSIGHT, count: 4, objectId: null, objectName: null }]);
  });

  it('queue complainers group per building they name (review fix); the unsplit view links the most named, ties to the lower id', () => {
    const park = createPark([['thunder-drum', 12, 24]]);
    const roundabout = objectIdOf(park.world, 'petal-roundabout');
    const drum = objectIdOf(park.world, 'thunder-drum');
    expect(roundabout).toBeLessThan(drum);
    complain(standingGuest(park), 'This queue is taking forever.', drum);
    complain(standingGuest(park), 'This queue is taking forever.', drum);
    complain(standingGuest(park), 'This queue is taking forever.', roundabout);
    complain(standingGuest(park), 'This queue is taking forever.', null);
    // Per building: the drum's two complainers make a linked line; one guest per other group is below the two-guest bar.
    expect(park.guests.thoughtInsights()).toEqual([
      { text: 'guests are frustrated by a long queue.', count: 2, objectId: drum, objectName: 'Thunder Drum' },
    ]);
    expect(park.guests.thoughtInsights(5, false)).toEqual([
      { text: 'guests are frustrated by a long queue.', count: 4, objectId: drum, objectName: 'Thunder Drum' },
    ]);
    complain(standingGuest(park), 'This queue is taking forever.', roundabout);
    expect(park.guests.thoughtInsights()).toEqual([
      { text: 'guests are frustrated by a long queue.', count: 2, objectId: roundabout, objectName: 'Petal Roundabout' },
      { text: 'guests are frustrated by a long queue.', count: 2, objectId: drum, objectName: 'Thunder Drum' },
    ]);
    expect(park.guests.thoughtInsights(5, false)[0]).toMatchObject({ count: 5, objectId: roundabout, objectName: 'Petal Roundabout' });
  });

  it('a price complaint at a ride and one at a stall are two lines, each linking its own building (review fix)', () => {
    const park = createPark([['brolly-booth', 16, 29]]);
    const ride = objectIdOf(park.world, 'petal-roundabout');
    const booth = objectIdOf(park.world, 'brolly-booth');
    for (let index = 0; index < 3; index += 1) complain(standingGuest(park), "I'm not paying that much.", ride);
    for (let index = 0; index < 2; index += 1) complain(standingGuest(park), "I'm not paying that much.", booth);
    const lines = park.guests.thoughtInsights();
    expect(lines.map((line) => [line.count, line.objectId])).toEqual([[3, ride], [2, booth]]);
    expect(lines[0].text).toBe(lines[1].text);
  });

  it('a demolished building gives null, and an id on a thought that is not a complaint is ignored', () => {
    const park = createPark([['thunder-drum', 12, 24]]);
    const drum = objectIdOf(park.world, 'thunder-drum');
    const complainers = [standingGuest(park), standingGuest(park)];
    for (const guest of complainers) complain(guest, 'That ride is closed.', drum);
    expect(park.guests.thoughtInsights()[0]).toMatchObject({ objectId: drum, objectName: 'Thunder Drum' });
    park.world.bulldoze({ x: 12, y: 24 });
    expect(park.world.objects.has(drum)).toBe(false);
    expect(park.guests.thoughtInsights()[0]).toMatchObject({ text: 'That ride is closed.', count: 2, objectId: null, objectName: null });
    expect(park.guests.guestSnapshot(complainers[0].id)).toMatchObject({ thoughtObjectId: null, thoughtObjectName: null });

    const roundabout = objectIdOf(park.world, 'petal-roundabout');
    for (const guest of complainers) {
      guest.currentThought = 'That was fun.';
      guest.thoughtObjectId = roundabout;
    }
    expect(park.guests.thoughtInsights()).toEqual([{ text: 'That was fun.', count: 2, objectId: null, objectName: null }]);
    expect(park.guests.guestSnapshot(complainers[0].id)).toMatchObject({ thoughtObjectId: null });
  });

  it('shows five lines by default', () => {
    const park = createPark();
    for (let group = 0; group < 6; group += 1) {
      for (let index = 0; index < 2; index += 1) setThought(standingGuest(park), `Raw thought ${group}.`);
    }
    expect(park.guests.thoughtInsights()).toHaveLength(5);
    expect(park.guests.thoughtInsights(10)).toHaveLength(6);
  });
});

describe('the guest inspector reads', () => {
  it('guestNear finds the nearest drawn guest to a cell within the radius, ties to the lower id', () => {
    const park = createPark();
    const near = standingGuest(park, 27);
    const nearer = standingGuest(park, 27);
    near.position = { x: 15, y: 27.6 };
    nearer.position = { x: 15, y: 27.3 };
    expect(park.guests.guestNear({ x: 15, y: 27 })).toBe(nearer.id);
    expect(park.guests.guestNear({ x: 15, y: 28 })).toBe(near.id);
    expect(park.guests.guestNear({ x: 15, y: 22 }), 'nobody within reach').toBeNull();
    nearer.position = { x: 15, y: 27.6 };
    expect(park.guests.guestNear({ x: 15, y: 27 }), 'a tie goes to the lower id').toBe(near.id);
    near.state = 'riding';
    expect(park.guests.guestNear({ x: 15, y: 27 }), 'a rider is not drawn').toBe(nearer.id);
    nearer.state = 'shopping';
    expect(park.guests.guestNear({ x: 15, y: 27 })).toBeNull();
    const before = JSON.stringify(park.guests.serialize());
    park.guests.guestNear({ x: 15, y: 27 }, 50);
    expect(JSON.stringify(park.guests.serialize()), 'a pure read').toBe(before);
  });

  it('guestSnapshot reports what the guest does, thinks, likes and holds, and null once they are gone', () => {
    const park = createPark([['ribbon-bench', 14, 25]]);
    const ride = objectIdOf(park.world, 'petal-roundabout');
    const guest = standingGuest(park, 27);
    guest.preferredIntensity = 80;
    guest.souvenirs = souvenirBit('umbrella') | souvenirBit('glowWand');
    guest.energy = LIFE.bench.seekEnergy - 1;
    guest.nausea = LIFE.nausea.queasy;
    guest.warmth = LIFE.warmth.hot;
    complain(guest, 'That queue is completely full.', ride);
    const snapshot = park.guests.guestSnapshot(guest.id)!;
    expect(snapshot).toMatchObject({
      id: guest.id,
      state: 'wandering',
      doing: 'Wandering',
      thought: 'That queue is completely full.',
      thoughtObjectId: ride,
      thoughtObjectName: 'Petal Roundabout',
      destinationObjectId: null,
      destinationName: null,
      likes: 'thrill',
      souvenirs: ['Umbrella', 'Glow wand'],
      tired: true,
      queasy: true,
      hot: true,
      cold: false,
      soaked: false,
      position: { x: 15, y: 27 },
    });
    expect(snapshot.happiness).toBe(guest.happiness);
    expect(snapshot.money).toBe(guest.money);
    expect(park.guests.guestSnapshot(standingGuest(park).id)!.likes).toMatch(/gentle|family|thrill/);

    guest.state = 'queueing';
    guest.destinationObjectId = ride;
    expect(park.guests.guestSnapshot(guest.id)).toMatchObject({ doing: 'Queueing for Petal Roundabout', destinationName: 'Petal Roundabout' });
    guest.state = 'resting';
    guest.destinationObjectId = objectIdOf(park.world, 'ribbon-bench');
    guest.activity = 'seatLeft';
    expect(park.guests.guestSnapshot(guest.id)!.doing).toBe('Resting on a bench');
    guest.state = 'pausing';
    guest.activity = 'queasy';
    expect(park.guests.guestSnapshot(guest.id)!.doing).toBe('Feeling queasy');

    park.conditions.weatherKind = 'rain';
    park.conditions.weatherIntensity = 1;
    expect(park.guests.guestSnapshot(guest.id)!.soaked, 'an umbrella keeps them dry').toBe(false);
    guest.souvenirs = 0;
    expect(park.guests.guestSnapshot(guest.id)!.soaked).toBe(true);

    park.guests.guests.delete(guest.id);
    expect(park.guests.guestSnapshot(guest.id)).toBeNull();
  });

  it('the band a guest likes follows the build-card bands (gentle below 25, family below 60)', () => {
    const park = createPark();
    const likes = (preferredIntensity: number) => {
      const guest = standingGuest(park);
      guest.preferredIntensity = preferredIntensity;
      return park.guests.guestSnapshot(guest.id)!.likes;
    };
    expect([likes(24), likes(25), likes(59), likes(60)]).toEqual(['gentle', 'family', 'family', 'thrill']);
  });
});

describe('the need gate and bench walkers', () => {
  // The ceilings sit at the leave thresholds (see config): a guest there is sent home before any decision point, so
  // the gate is a safety net. The tests pin the ceilings to those thresholds and the behaviour at and below them.
  it('the ceilings are the leave thresholds', () => {
    expect(LIFE.lifeNeedCeiling).toEqual({ hunger: 96, thirst: 94, toiletNeed: 97 });
  });

  it('a tired guest with a need at the ceiling never heads for a near bench; one just below it sits', () => {
    const park = createPark([['ribbon-bench', 14, 25]]);
    const urgent = standingGuest(park, 28);
    urgent.energy = 10;
    urgent.toiletNeed = LIFE.lifeNeedCeiling.toiletNeed;
    const tired = standingGuest(park, 28);
    tired.energy = 10;
    tired.toiletNeed = LIFE.lifeNeedCeiling.toiletNeed - 1;
    park.guests.step(100);
    expect(urgent.state, 'the need comes first').not.toBe('walkingToBench');
    expect(tired.state).toBe('walkingToBench');
  });

  it('a hot guest with a need at the ceiling does not stop to fan themself either', () => {
    const park = createPark();
    let fanned = 0;
    for (let trial = 0; trial < 60; trial += 1) {
      const guest = standingGuest(park, 28);
      guest.warmth = 95;
      guest.hunger = LIFE.lifeNeedCeiling.hunger;
      guest.stateTimerSeconds = 30;
      park.guests.step(100);
      if (guest.activity === 'fanSelf') fanned += 1;
      park.guests.guests.delete(guest.id);
    }
    expect(fanned).toBe(0);
  });

  it('a guest walking to a bench through a severe crowd takes the crowding penalty', () => {
    const run = (severe: boolean): number => {
      const park = createPark([['ribbon-bench', 14, 25]]);
      const reader: GuestCrowdReader = { noteEntry: () => undefined, speedFactorAt: () => 1, isSevereAt: () => severe, strength: 1 };
      park.guests.setCrowd(reader);
      const guest = standingGuest(park, 28);
      guest.state = 'walkingToBench';
      guest.activity = 'seatLeft';
      guest.destinationObjectId = objectIdOf(park.world, 'ribbon-bench');
      guest.route = [{ x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 }, { x: 15, y: 25 }];
      guest.routeIndex = 1;
      guest.happiness = 70;
      guest.needTimerSeconds = GAME_CONFIG.guests.needUpdateSeconds;
      park.guests.step(100);
      return guest.happiness;
    };
    expect(GAME_CONFIG.crowd.severeHappinessPerSecond).toBeGreaterThan(0);
    expect(run(true)).toBeLessThan(run(false));
  });
});

describe('souvenir and rain thoughts', () => {
  const buy = (price: number, queueWaitSeconds = 0): { guest: Guest; booth: number } => {
    const park = createPark([['brolly-booth', 16, 29]]);
    const booth = objectIdOf(park.world, 'brolly-booth');
    park.shops.setPrice(booth, price);
    const guest = standingGuest(park, 29);
    guest.money = 100;
    expect(park.shops.joinQueue(booth, guest)).toBe('joined');
    guest.stateTimerSeconds = queueWaitSeconds;
    for (let tick = 0; tick < 200 && guest.state !== 'wandering'; tick += 1) park.shops.step(100, park.guests.guests);
    expect(guest.state).toBe('wandering');
    return { guest, booth };
  };

  it('a keepsake at a fair price gets the keepsake line; a pricey one keeps the complaint, naming the stall', () => {
    const fair = buy(BUILD_BY_ID.get('brolly-booth')!.stats!.itemPrice!);
    expect([fair.guest.currentThought, fair.guest.thoughtObjectId, fair.guest.activity]).toEqual([SOUVENIR_THOUGHT.umbrella, null, 'showOff']);
    expect(fair.guest.souvenirs & souvenirBit('umbrella')).not.toBe(0);
    const pricey = buy(20);
    expect([pricey.guest.currentThought, pricey.guest.thoughtObjectId]).toEqual([PRICEY_SOUVENIR_THOUGHT, pricey.booth]);
    expect(pricey.guest.lastPurchaseSatisfaction!).toBeLessThan(60);
    expect(pricey.guest.souvenirs & souvenirBit('umbrella'), 'pricey or not, they keep it').not.toBe(0);
  });

  it('a slow queue at the default price disappoints but is no price complaint (review fix)', () => {
    const slow = buy(BUILD_BY_ID.get('brolly-booth')!.stats!.itemPrice!, 40);
    expect(slow.guest.lastPurchaseSatisfaction!).toBeLessThan(60);
    expect([slow.guest.currentThought, slow.guest.thoughtObjectId]).toEqual([SOUVENIR_THOUGHT.umbrella, null]);
  });

  it('a guest under their own umbrella in the rain says so, and a soaked one still complains', () => {
    const thoughtAfterRain = (souvenirs: number, thought?: string): string => {
      const park = createPark();
      park.conditions.weatherKind = 'rain';
      park.conditions.weatherIntensity = 1;
      const guest = standingGuest(park);
      guest.souvenirs = souvenirs;
      if (thought !== undefined) setThought(guest, thought, 4);
      // Inside the post-activity window the guest stands still, so the needs tick writes the thought and nothing
      // overwrites it in the same step.
      guest.stateTimerSeconds = 0;
      guest.needTimerSeconds = GAME_CONFIG.guests.needUpdateSeconds;
      guest.routeIndex = guest.route.length;
      park.guests.step(100);
      return guest.currentThought;
    };
    expect(thoughtAfterRain(souvenirBit('umbrella'))).toBe(THOUGHTS.dryUnderUmbrella);
    expect(thoughtAfterRain(0)).toBe(THOUGHTS.soaked);
    // Review fix: the umbrella line never replaces a live complaint (it would lift the value factor).
    expect(thoughtAfterRain(souvenirBit('umbrella'), 'That queue is completely full.')).toBe('That queue is completely full.');
  });
});

describe('the sick-cell contract', () => {
  it('a simulation stepped on its own keeps the cells until drained; a restore drops them', () => {
    const park = createPark();
    const sick = (y: number): void => {
      const guest = standingGuest(park, y);
      guest.nausea = 99;
      guest.state = 'pausing';
      guest.activity = 'queasy';
      guest.stateTimerSeconds = LIFE.pauseSeconds.queasy;
    };
    sick(27);
    park.guests.step(100);
    sick(23);
    park.guests.step(100);
    park.guests.step(100);
    expect(park.guests.drainSickCells(), 'both ticks\' cells wait for the drain').toEqual([{ x: 15, y: 27 }, { x: 15, y: 23 }]);
    expect(park.guests.drainSickCells()).toEqual([]);
    sick(25);
    park.guests.step(100);
    const state = JSON.parse(JSON.stringify(park.guests.serialize()));
    expect(JSON.stringify(state)).not.toContain('sickCells');
    park.guests.restore(state);
    expect(park.guests.drainSickCells(), 'a restore starts with no pending cell').toEqual([]);
  });
});
