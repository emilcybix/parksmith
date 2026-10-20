import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import type { Guest } from '../guests/types';
import { RideSimulation } from '../rides/RideSimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { GameWorld } from '../World';
import { OperationsSimulation } from './OperationsSimulation';

/** Phase 49: the running waste tally (where waste went) that the Staff window and the Pulse line read. */

const guestAt = (id: number): Guest => ({
  id, position: { x: 15, y: 28 }, currentCell: { x: 15, y: 28 }, route: [{ x: 15, y: 28 }], routeIndex: 1, routeVersion: 0,
  state: 'wandering', destinationObjectId: null, money: 500, happiness: 70, hunger: 90, thirst: 20, toiletNeed: 20, energy: 80,
  preferredIntensity: 30, currentThought: '', thoughtObjectId: null, patienceSeconds: 60, lastQueueWaitSeconds: 0,
  lastRideSatisfaction: null, lastPurchaseSatisfaction: null, servicePriceLimit: null, recentRideIds: [], recentServiceIds: [],
  ageSeconds: 0, maximumVisitSeconds: 120, stateTimerSeconds: 10, needTimerSeconds: 0, color: 0xffffff, accent: 0xffffff,
  nausea: 0, warmth: 50, souvenirs: 0, activity: null,
});

const path = (lastY = 24) => Array.from({ length: 31 - lastY }, (_, index) => ({ x: 15, y: 30 - index }));

describe('Phase 49: the waste tally', () => {
  it('counts purchase waste, what a bin took, what landed on the path (sick piles too) and what cleaners swept', () => {
    const world = new GameWorld();
    world.buildPaths(path());
    const food = world.buildObject('picnic-pocket', { x: 16, y: 28 });
    const bin = world.buildObject('tidy-totem', { x: 16, y: 26 });
    if (!food || !bin) throw new Error('Service and bin should be placeable');
    const shops = new ShopSimulation(world);
    const operations = new OperationsSimulation(world, new RideSimulation(world), shops);
    const guest = guestAt(1);
    const guests = new Map([[guest.id, guest]]);
    expect(operations.wasteTally()).toEqual({ made: 0, binned: 0, dropped: 0, cleared: 0 });

    // Eleven meals: the bin takes ten, the eleventh lands on the path.
    for (let purchase = 0; purchase < 11; purchase += 1) {
      guest.hunger = 90;
      expect(shops.joinQueue(food.id, guest)).toBe('joined');
      shops.step(3_200, guests);
      operations.step(0, guests);
    }
    expect(operations.wasteTally()).toEqual({ made: 11, binned: 10, dropped: 1, cleared: 0 });
    operations.addSick({ x: 15, y: 25 });
    expect(operations.wasteTally().dropped).toBe(1 + GAME_CONFIG.operations.litter.sickUnits);

    // A cleaner empties the full bin (not a sweep) and sweeps both piles, one unit at a time.
    world.addMoney(1_000, 'test');
    expect(operations.hireStaff('cleaner')).not.toBeNull();
    for (let tick = 0; tick < 600; tick += 1) operations.step(100, new Map());
    expect(operations.litter.size).toBe(0);
    expect(operations.wasteTally()).toEqual({ made: 11, binned: 10, dropped: 4, cleared: 4 });
  });

  it('is never saved: a restored copy plays and serialises the same whatever the tally held', () => {
    const world = new GameWorld();
    world.buildPaths(path(28));
    const operations = new OperationsSimulation(world, new RideSimulation(world), new ShopSimulation(world));
    operations.addLitter({ x: 15, y: 29 }, 4);
    const state = operations.serialize();
    expect(JSON.stringify(state)).not.toMatch(/made|binned|dropped|cleared/);
    const copy = new OperationsSimulation(world, new RideSimulation(world), new ShopSimulation(world));
    copy.restore(state);
    expect(copy.wasteTally()).toEqual({ made: 0, binned: 0, dropped: 0, cleared: 0 });
    expect(copy.serialize()).toEqual(state);
  });
});
