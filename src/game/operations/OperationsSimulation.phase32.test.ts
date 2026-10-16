import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import type { Guest } from '../guests/types';
import { RideSimulation } from '../rides/RideSimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { GameWorld } from '../World';
import { OperationsSimulation } from './OperationsSimulation';

/**
 * Phase 32: the Phase 29 sick pile in OperationsSimulation, which no earlier test pinned. A guest near a sick pile minds
 * it `guestLife.sickLitterFactor` times as much as plain litter and says "Eww, someone was sick here!" at once (plain
 * litter waits for the comment interval). Tests only; every number comes from GAME_CONFIG.
 */

const LITTER = GAME_CONFIG.operations.litter;
const FACTOR = GAME_CONFIG.guestLife.sickLitterFactor;
const EWW = 'Eww, someone was sick here!';

const createGuest = (id: number, overrides: Partial<Guest> = {}): Guest => ({
  id,
  position: { x: 15, y: 28 },
  currentCell: { x: 15, y: 28 },
  route: [{ x: 15, y: 28 }],
  routeIndex: 1,
  routeVersion: 0,
  state: 'wandering',
  destinationObjectId: null,
  money: 200,
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
  // Fresh: under the comment interval, so plain litter alone would not set a thought.
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

/** A street from (15, 30) up to (15, 20) and the operations over it (no staff, so nothing is cleaned). */
const createStreet = () => {
  const world = new GameWorld();
  const cells = [];
  for (let y = 30; y >= 20; y -= 1) cells.push({ x: 15, y });
  world.buildPaths(cells);
  const operations = new OperationsSimulation(world, new RideSimulation(world), new ShopSimulation(world));
  return { world, operations };
};

/** One comment interval of guest cleanliness for `guests`. */
const interval = (operations: OperationsSimulation, guests: readonly Guest[]): void => {
  operations.step(LITTER.happinessIntervalSeconds * 1000, new Map(guests.map((guest) => [guest.id, guest])));
};

describe('the sick pile (Phase 29)', () => {
  it('a sick pile costs sickLitterFactor times the plain litter penalty, and the guest says "Eww" at once', () => {
    const plain = createStreet();
    plain.operations.addLitter({ x: 15, y: 28 }, LITTER.sickUnits);
    const plainGuest = createGuest(1);
    interval(plain.operations, [plainGuest]);
    const plainPenalty = Math.min(LITTER.maximumHappinessPenalty, LITTER.sickUnits * LITTER.happinessPenaltyPerUnit);
    expect(70 - plainGuest.happiness).toBeCloseTo(plainPenalty, 9);
    expect(plainGuest.currentThought, 'plain litter waits for the comment interval').toBe('');

    const sick = createStreet();
    expect(sick.operations.addSick({ x: 15, y: 28 })).toBe(LITTER.sickUnits);
    expect(sick.operations.litter.get('15,28')).toMatchObject({ units: LITTER.sickUnits, sick: true });
    const sickGuest = createGuest(1, { currentThought: 'This queue is taking forever.', thoughtObjectId: 7 });
    interval(sick.operations, [sickGuest]);
    expect(70 - sickGuest.happiness).toBeCloseTo(plainPenalty * FACTOR, 9);
    expect([sickGuest.currentThought, sickGuest.thoughtObjectId], 'the Eww line is no complaint: the link is cleared')
      .toEqual([EWW, null]);
  });

  it('the factor reaches across the litter radius and doubles the capped penalty', () => {
    const { operations } = createStreet();
    operations.addLitter({ x: 15, y: 28 }, 10);
    operations.addSick({ x: 15, y: 27 });
    const onTop = createGuest(1);
    const beside = createGuest(2, { currentCell: { x: 15, y: 26 } });
    const away = createGuest(3, { currentCell: { x: 15, y: 25 } });
    interval(operations, [onTop, beside, away]);
    // On (15, 28): 13 units in reach, capped, then doubled for the pile one cell away.
    expect(70 - onTop.happiness).toBeCloseTo(LITTER.maximumHappinessPenalty * FACTOR, 9);
    expect(onTop.currentThought).toBe(EWW);
    // On (15, 26): only the sick pile in reach (radius 1).
    expect(70 - beside.happiness).toBeCloseTo(
      Math.min(LITTER.maximumHappinessPenalty, LITTER.sickUnits * LITTER.happinessPenaltyPerUnit) * FACTOR, 9);
    expect(beside.currentThought).toBe(EWW);
    // Two cells from the sick pile: nothing in reach.
    expect(away.happiness).toBe(70);
    expect(away.currentThought).toBe('');
  });

  it('a queueing guest minds it without saying so; a rider or shopper is not touched', () => {
    const { operations } = createStreet();
    operations.addSick({ x: 15, y: 28 });
    const queued = createGuest(1, { state: 'queueing', destinationObjectId: 5, currentThought: 'Queueing.' });
    const rider = createGuest(2, { state: 'riding' });
    const shopper = createGuest(3, { state: 'shopping' });
    const benchBound = createGuest(4, { state: 'walkingToBench' });
    interval(operations, [queued, rider, shopper, benchBound]);
    expect(queued.happiness).toBeLessThan(70);
    expect(queued.currentThought).toBe('Queueing.');
    expect([rider.happiness, shopper.happiness]).toEqual([70, 70]);
    expect(benchBound.currentThought, 'a guest walking to a bench comments like any walker').toBe(EWW);
  });

  it('being sick off the path marks the pile it lands on', () => {
    const { operations } = createStreet();
    expect(operations.addSick({ x: 3, y: 3 })).toBe(LITTER.sickUnits);
    const piles = [...operations.litter.values()];
    expect(piles).toHaveLength(1);
    expect(piles[0]).toMatchObject({ units: LITTER.sickUnits, sick: true });
  });
});
