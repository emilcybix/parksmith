import { describe, expect, it } from 'vitest';
import type { Guest } from '../guests/types';
import { GameWorld } from '../World';
import type { SceneryInfluenceReader } from '../scenery/types';
import { ShopSimulation } from './ShopSimulation';

const createGuest = (id: number, overrides: Partial<Guest> = {}): Guest => ({
  id,
  position: { x: 15, y: 31 },
  currentCell: { x: 15, y: 31 },
  route: [{ x: 15, y: 31 }],
  routeIndex: 1,
  routeVersion: 0,
  state: 'wandering',
  destinationObjectId: null,
  money: 50,
  happiness: 70,
  hunger: 20,
  thirst: 20,
  toiletNeed: 20,
  energy: 80,
  preferredIntensity: 30,
  currentThought: '',
  thoughtObjectId: null,
  patienceSeconds: 60,
  lastQueueWaitSeconds: 0,
  lastRideSatisfaction: null,
  lastPurchaseSatisfaction: null,
  servicePriceLimit: null,
  recentRideIds: [],
  recentServiceIds: [],
  ageSeconds: 0,
  maximumVisitSeconds: 120,
  stateTimerSeconds: 0,
  needTimerSeconds: 0,
  color: 0xffffff,
  accent: 0xffffff,
  nausea: 0,
  warmth: 50,
  souvenirs: 0,
  activity: null,
  ...overrides,
});

const guestMap = (...guests: Guest[]): Map<number, Guest> =>
  new Map(guests.map((guest) => [guest.id, guest]));

const createService = (definitionId: string, scenery?: SceneryInfluenceReader) => {
  const world = new GameWorld();
  const object = world.buildObject(definitionId, { x: 8, y: 8 });
  if (!object) throw new Error(`${definitionId} should be placeable`);
  const shops = new ShopSimulation(world, scenery);
  return { world, object, shops };
};

describe('ShopSimulation', () => {
  it('syncs service types, prices, and durations from the build catalog', () => {
    const world = new GameWorld();
    const food = world.buildObject('picnic-pocket', { x: 3, y: 3 });
    const drink = world.buildObject('fizz-foundry', { x: 8, y: 3 });
    const toilet = world.buildObject('comfort-cabin', { x: 13, y: 3 });
    if (!food || !drink || !toilet) throw new Error('Services should be placeable');

    const shops = new ShopSimulation(world);
    expect(shops.getService(food.id)).toMatchObject({ kind: 'food', itemPrice: 7, serviceTimeSeconds: 3.2 });
    expect(shops.getService(drink.id)).toMatchObject({ kind: 'drink', itemPrice: 4.5, serviceTimeSeconds: 2.4 });
    expect(shops.getService(toilet.id)).toMatchObject({ kind: 'toilet', itemPrice: 1, serviceTimeSeconds: 4.5 });
    expect(shops.services.size).toBe(3);
  });

  it('serves food, charges both ledgers once, relieves hunger, and records satisfaction', () => {
    const { world, object, shops } = createService('picnic-pocket');
    const guest = createGuest(1, { hunger: 90, money: 20 });
    const guests = guestMap(guest);
    const cashBefore = world.cash;

    expect(shops.joinQueue(object.id, guest)).toBe('joined');
    shops.step(3_200, guests);

    const service = shops.getService(object.id)!;
    expect(guest.money).toBe(13);
    expect(world.cash).toBe(cashBefore + 7);
    expect(guest.hunger).toBe(28);
    expect(guest.state).toBe('wandering');
    expect(guest.lastPurchaseSatisfaction).toBeGreaterThan(50);
    expect(service.customersServed).toBe(1);
    expect(service.lifetimeRevenue).toBe(7);
    expect(shops.snapshot(object.id)?.satisfaction).toBe(guest.lastPurchaseSatisfaction);

    shops.step(10_000, guests);
    expect(guest.money).toBe(13);
    expect(world.cash).toBe(cashBefore + 7);
  });

  it('adds nearby scenery to service satisfaction and exposes its exact bonuses', () => {
    const baseline = createService('picnic-pocket');
    const influence: SceneryInfluenceReader = { scoreAt: () => 0, scoreForObject: () => 80 };
    const decorated = createService('picnic-pocket', influence);
    const baselineGuest = createGuest(1, { hunger: 70 });
    const decoratedGuest = createGuest(1, { hunger: 70 });

    baseline.shops.joinQueue(baseline.object.id, baselineGuest);
    decorated.shops.joinQueue(decorated.object.id, decoratedGuest);
    baseline.shops.step(3_200, guestMap(baselineGuest));
    decorated.shops.step(3_200, guestMap(decoratedGuest));

    expect(decoratedGuest.lastPurchaseSatisfaction! - baselineGuest.lastPurchaseSatisfaction!).toBeCloseTo(4);
    expect(decorated.shops.snapshot(decorated.object.id)).toMatchObject({
      sceneryScore: 80,
      sceneryChoiceBonus: 4.8,
      scenerySatisfactionBonus: 4,
    });
  });

  it('emits a successful takeaway completion once with its path cell', () => {
    const { object, shops } = createService('picnic-pocket');
    const guest = createGuest(7, {
      currentCell: { x: 9, y: 10 },
      position: { x: 9, y: 10 },
      hunger: 90,
    });
    const guests = guestMap(guest);

    expect(shops.joinQueue(object.id, guest)).toBe('joined');
    shops.step(3_200, guests);

    expect(shops.drainCompletionEvents()).toEqual([{
      id: 1,
      serviceObjectId: object.id,
      guestId: guest.id,
      kind: 'food',
      cell: { x: 9, y: 10 },
    }]);
    expect(shops.drainCompletionEvents()).toEqual([]);
  });

  it('relieves thirst exactly on a fixed-step service boundary', () => {
    const { object, shops } = createService('fizz-foundry');
    const guest = createGuest(1, { thirst: 85 });
    const guests = guestMap(guest);
    expect(shops.joinQueue(object.id, guest)).toBe('joined');

    for (let tick = 0; tick < 24; tick += 1) shops.step(100, guests);

    expect(guest.thirst).toBe(17);
    expect(guest.money).toBe(45.5);
    expect(shops.getService(object.id)?.customersServed).toBe(1);
  });

  it('charges for the toilet facility and fully relieves toilet need', () => {
    const { world, object, shops } = createService('comfort-cabin');
    const guest = createGuest(1, { toiletNeed: 88, money: 12 });
    const guests = guestMap(guest);
    const cashBefore = world.cash;

    expect(shops.joinQueue(object.id, guest)).toBe('joined');
    shops.step(4_500, guests);

    expect(guest.toiletNeed).toBe(0);
    expect(guest.money).toBe(11);
    expect(world.cash).toBe(cashBefore + 1);
    expect(shops.getService(object.id)?.customersServed).toBe(1);
    expect(shops.drainCompletionEvents()).toEqual([]);
  });

  it('serves a deterministic FIFO queue and provides guest-specific wait estimates', () => {
    const { object, shops } = createService('picnic-pocket');
    const first = createGuest(1, { hunger: 80 });
    const second = createGuest(2, { hunger: 70 });
    const guests = guestMap(first, second);
    shops.joinQueue(object.id, first);
    shops.joinQueue(object.id, second);

    expect(shops.estimatedWaitSeconds(object.id)).toBeCloseTo(6.4);
    shops.step(2_000, guests);
    expect(shops.getService(object.id)?.activeGuestId).toBe(first.id);
    expect(shops.queueIndex(object.id, second.id)).toBe(0);
    expect(shops.estimatedWaitSeconds(object.id)).toBeCloseTo(4.4);
    expect(shops.estimatedWaitSeconds(object.id, second.id)).toBeCloseTo(1.2);

    shops.step(1_200, guests);
    expect(shops.getService(object.id)?.activeGuestId).toBe(second.id);
    expect(first.state).toBe('wandering');
    shops.step(3_200, guests);
    expect(second.state).toBe('wandering');
    expect(shops.getService(object.id)?.customersServed).toBe(2);
    expect(shops.getService(object.id)?.status).toBe('idle');
  });

  it('rechecks affordability after a queued price change', () => {
    const { world, object, shops } = createService('fizz-foundry');
    const guest = createGuest(1, { money: 5 });
    const guests = guestMap(guest);
    const cashBefore = world.cash;
    expect(shops.joinQueue(object.id, guest)).toBe('joined');

    shops.setPrice(object.id, 10);
    shops.step(0, guests);

    expect(guest.state).toBe('wandering');
    expect(guest.money).toBe(5);
    expect(world.cash).toBe(cashBefore);
    expect(shops.getService(object.id)?.customersServed).toBe(0);
    expect(shops.drainCompletionEvents()).toEqual([]);
  });

  it('honors the price limit accepted by a guest before a queued price increase', () => {
    const { world, object, shops } = createService('fizz-foundry');
    const guest = createGuest(1, { money: 50, servicePriceLimit: 5 });
    const guests = guestMap(guest);
    const cashBefore = world.cash;
    expect(shops.joinQueue(object.id, guest)).toBe('joined');

    shops.setPrice(object.id, 10);
    shops.step(0, guests);

    expect(guest.state).toBe('wandering');
    expect(guest.currentThought).toBe("I'm not paying that much.");
    expect(guest.money).toBe(50);
    expect(world.cash).toBe(cashBefore);
    expect(shops.getService(object.id)?.customersServed).toBe(0);
  });

  it('clamps prices and releases queued and active guests when closed', () => {
    const { object, shops } = createService('fizz-foundry');
    const active = createGuest(1);
    const queued = createGuest(2);
    const guests = guestMap(active, queued);

    shops.setPrice(object.id, 100);
    expect(shops.getService(object.id)?.itemPrice).toBe(20);
    shops.setPrice(object.id, -4);
    expect(shops.getService(object.id)?.itemPrice).toBe(0);
    shops.joinQueue(object.id, active);
    shops.joinQueue(object.id, queued);
    shops.step(0, guests);
    expect(active.state).toBe('shopping');
    shops.setOpen(object.id, false);
    shops.step(0, guests);

    expect(active.state).toBe('wandering');
    expect(queued.state).toBe('wandering');
    expect(shops.getService(object.id)?.queueGuestIds).toHaveLength(0);
    expect(shops.getService(object.id)?.activeGuestId).toBeNull();
    expect(shops.getService(object.id)?.status).toBe('closed');
  });

  it('prevents one guest from joining multiple service queues', () => {
    const world = new GameWorld();
    const food = world.buildObject('picnic-pocket', { x: 3, y: 3 });
    const drink = world.buildObject('fizz-foundry', { x: 8, y: 3 });
    if (!food || !drink) throw new Error('Services should be placeable');
    const shops = new ShopSimulation(world);
    const guest = createGuest(1);

    expect(shops.joinQueue(food.id, guest)).toBe('joined');
    expect(shops.joinQueue(food.id, guest)).toBe('joined');
    expect(shops.joinQueue(drink.id, guest)).toBe('busy');
    expect(shops.getService(food.id)?.queueGuestIds).toEqual([guest.id]);
    expect(shops.getService(drink.id)?.queueGuestIds).toHaveLength(0);
  });

  it('releases an active customer when its building is removed', () => {
    const { world, object, shops } = createService('comfort-cabin');
    const guest = createGuest(1, { toiletNeed: 90 });
    const guests = guestMap(guest);
    shops.joinQueue(object.id, guest);
    shops.step(0, guests);
    expect(guest.state).toBe('usingFacility');

    world.bulldoze(object.anchor);
    shops.syncWithWorld(guests);
    expect(shops.getService(object.id)).toBeUndefined();
    expect(guest.state).toBe('wandering');
    expect(guest.destinationObjectId).toBeNull();
  });
});

describe('souvenir stalls (Phase 29)', () => {
  it('sell a keepsake: the guest holds it and shows it off, the sale is souvenir revenue, and no wrapper is dropped', () => {
    const { world, object, shops } = createService('balloon-bouquet');
    const guest = createGuest(1, { money: 20 });
    const guests = guestMap(guest);
    expect(shops.getService(object.id)).toMatchObject({ kind: 'souvenir', itemPrice: 3 });
    expect(shops.joinQueue(object.id, guest)).toBe('joined');
    guest.destinationObjectId = object.id;
    shops.step(100, guests);
    expect(guest.state).toBe('shopping');
    expect(guest.currentThought).toBe('Picking out a souvenir.');
    shops.step(2_000, guests);
    expect(guest.souvenirs).toBe(4);
    expect([guest.state, guest.activity]).toEqual(['wandering', 'showOff']);
    expect(guest.money).toBe(17);
    expect(guest.lastPurchaseSatisfaction).toBeGreaterThan(60);
    expect(world.transactions[0]).toMatchObject({ amount: 3, category: 'souvenir-revenue' });
    expect(shops.drainCompletionEvents(), 'a souvenir leaves no packaging').toEqual([]);
    expect([guest.hunger, guest.thirst, guest.toiletNeed], 'no need is touched').toEqual([20, 20, 20]);
  });

  it('a warm drink warms a guest, a cold treat cools one', () => {
    const warm = createService('bean-barrow');
    const guest = createGuest(1, { thirst: 80, warmth: 30 });
    expect(warm.shops.joinQueue(warm.object.id, guest)).toBe('joined');
    guest.destinationObjectId = warm.object.id;
    warm.shops.step(100, guestMap(guest));
    warm.shops.step(3_000, guestMap(guest));
    expect(guest.warmth).toBeGreaterThan(30);
    expect([guest.state, guest.activity]).toEqual(['wandering', 'drink']);
    const cold = createService('glacier-scoop');
    const hot = createGuest(2, { hunger: 80, warmth: 90 });
    expect(cold.shops.joinQueue(cold.object.id, hot)).toBe('joined');
    hot.destinationObjectId = cold.object.id;
    cold.shops.step(100, guestMap(hot));
    cold.shops.step(3_000, guestMap(hot));
    expect(hot.warmth).toBeLessThan(90);
  });
});
