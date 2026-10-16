import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { GuestSimulation } from '../guests/GuestSimulation';
import { GameWorld } from '../World';
import { breakdownProbability, conditionWearPerCycle, RideSimulation } from './RideSimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import type { SceneryInfluenceReader } from '../scenery/types';

const createRidePark = (scenery?: SceneryInfluenceReader) => {
  const world = new GameWorld();
  world.buildPaths([{ x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }]);
  const object = world.buildObject('petal-roundabout', { x: 12, y: 27 });
  if (!object) throw new Error('Ride should be placeable');
  const rides = new RideSimulation(world, scenery);
  const guests = new GuestSimulation(world, rides, new ShopSimulation(world), 7);
  rides.syncWithWorld(guests.guests);
  return { world, object, rides, guests };
};

describe('RideSimulation', () => {
  it('calculates bounded wear and increasing breakdown probability from condition and reliability', () => {
    expect(conditionWearPerCycle(20, 30, 100)).toBeGreaterThan(0);
    expect(conditionWearPerCycle(20, 30, 70)).toBeGreaterThan(conditionWearPerCycle(20, 30, 100));
    expect(breakdownProbability(GAME_CONFIG.operations.maintenance.safeConditionThreshold, 50)).toBe(0);
    expect(breakdownProbability(25, 90)).toBeGreaterThan(breakdownProbability(60, 90));
    expect(breakdownProbability(25, 60)).toBeGreaterThan(breakdownProbability(25, 90));
    expect(breakdownProbability(-100, -100)).toBeLessThanOrEqual(1);
  });

  it('charges tickets, posts operating cost, boards, and completes a cycle', () => {
    const { world, object, rides, guests } = createRidePark();
    guests.spawnGuests(1);
    const guest = [...guests.guests.values()][0];
    const cashBefore = world.cash;
    const guestMoneyBefore = guest.money;
    expect(rides.joinQueue(object.id, guest)).toBe('joined');
    rides.step(GAME_CONFIG.rides.maximumDispatchWaitSeconds * 1_000, guests.guests);
    const runtime = rides.getRide(object.id)!;
    expect(runtime.status).toBe('running');
    expect(guest.state).toBe('riding');
    expect(guest.money).toBe(guestMoneyBefore - runtime.ticketPrice);
    expect(world.cash).toBe(cashBefore + runtime.ticketPrice - 6);

    rides.step(38_000, guests.guests);
    expect(runtime.status).toBe('idle');
    expect(guest.state).toBe('wandering');
    expect(guest.lastRideSatisfaction).not.toBeNull();
    expect(runtime.satisfactionCount).toBe(1);
    expect(runtime.condition).toBeLessThan(100);
    expect(runtime.broken).toBe(false);
  });

  it('adds nearby scenery to completed-cycle satisfaction and exposes its exact bonuses', () => {
    const baseline = createRidePark();
    const influence: SceneryInfluenceReader = { scoreAt: () => 0, scoreForObject: () => 80 };
    const decorated = createRidePark(influence);
    baseline.guests.spawnGuests(1);
    decorated.guests.spawnGuests(1);
    const baselineGuest = [...baseline.guests.guests.values()][0];
    const decoratedGuest = [...decorated.guests.guests.values()][0];

    baseline.rides.joinQueue(baseline.object.id, baselineGuest);
    decorated.rides.joinQueue(decorated.object.id, decoratedGuest);
    baseline.rides.step(GAME_CONFIG.rides.maximumDispatchWaitSeconds * 1_000, baseline.guests.guests);
    decorated.rides.step(GAME_CONFIG.rides.maximumDispatchWaitSeconds * 1_000, decorated.guests.guests);
    baseline.rides.step(38_000, baseline.guests.guests);
    decorated.rides.step(38_000, decorated.guests.guests);

    expect(decoratedGuest.lastRideSatisfaction! - baselineGuest.lastRideSatisfaction!).toBeCloseTo(8);
    expect(decorated.rides.snapshot(decorated.object.id)).toMatchObject({
      sceneryScore: 80,
      sceneryChoiceBonus: 9.6,
      scenerySatisfactionBonus: 8,
    });
  });

  it('extends a satisfied rider\'s planned visit, capped at the configured maximum', () => {
    const { rides, object, guests } = createRidePark();
    guests.spawnGuests(1);
    const guest = [...guests.guests.values()][0];
    guest.money = 60;
    guest.preferredIntensity = 20;
    guest.maximumVisitSeconds = 120;
    guest.currentCell = { x: 15, y: 28 };
    expect(rides.joinQueue(object.id, guest)).toBe('joined');
    for (let tick = 0; tick < 500; tick += 1) rides.step(100, guests.guests);
    expect(guest.lastRideSatisfaction).toBeGreaterThanOrEqual(65);
    expect(guest.maximumVisitSeconds).toBe(120 + GAME_CONFIG.guests.goodRideStayBonusSeconds);

    guest.maximumVisitSeconds = GAME_CONFIG.guests.maximumVisitSeconds - 5;
    expect(rides.joinQueue(object.id, guest)).toBe('joined');
    for (let tick = 0; tick < 500; tick += 1) rides.step(100, guests.guests);
    expect(guest.maximumVisitSeconds).toBe(GAME_CONFIG.guests.maximumVisitSeconds);
  });

  it('boards no more than capacity and leaves later guests in the queue', () => {
    const { object, rides, guests } = createRidePark();
    guests.spawnGuests(15);
    for (const guest of guests.guests.values()) expect(rides.joinQueue(object.id, guest)).toBe('joined');
    rides.step(100, guests.guests);
    const runtime = rides.getRide(object.id)!;
    expect(runtime.riderGuestIds).toHaveLength(12);
    expect(runtime.queueGuestIds).toHaveLength(3);
  });

  it('clamps manual ticket prices to the configured range', () => {
    const { object, rides } = createRidePark();
    rides.setTicketPrice(object.id, 100);
    expect(rides.getRide(object.id)?.ticketPrice).toBe(GAME_CONFIG.rides.maximumTicketPrice);
    rides.setTicketPrice(object.id, -5);
    expect(rides.getRide(object.id)?.ticketPrice).toBe(GAME_CONFIG.rides.minimumTicketPrice);
  });

  it('defers a forced breakdown until riders finish safely, then releases the waiting queue', () => {
    const { world, object, rides, guests } = createRidePark();
    guests.spawnGuests(15);
    const guestList = [...guests.guests.values()];
    for (const guest of guestList) expect(rides.joinQueue(object.id, guest)).toBe('joined');
    rides.step(100, guests.guests);
    const runtime = rides.getRide(object.id)!;
    const waitingIds = [...runtime.queueGuestIds];
    const cashAfterDispatch = world.cash;

    expect(runtime.status).toBe('running');
    expect(rides.forceBreakdown(object.id, guests.guests)).toBe(true);
    expect(runtime.pendingBreakdown).toBe(true);
    expect(runtime.broken).toBe(false);
    expect(rides.isAvailable(object.id)).toBe(false);

    rides.step(38_000, guests.guests);

    expect(runtime.status).toBe('broken');
    expect(runtime.broken).toBe(true);
    expect(runtime.pendingBreakdown).toBe(false);
    expect(runtime.breakdownCount).toBe(1);
    expect(runtime.riderGuestIds).toHaveLength(0);
    expect(runtime.queueGuestIds).toHaveLength(0);
    expect(runtime.open).toBe(true);
    expect(world.cash).toBe(cashAfterDispatch);
    for (const guestId of waitingIds) {
      expect(guests.guests.get(guestId)?.currentThought).toBe('The ride broke down while I was waiting.');
    }
    expect(rides.joinQueue(object.id, guestList[0])).toBe('closed');
  });

  it('uses the stable ride and cycle roll to trigger natural failures only after cycle completion', () => {
    const { object, rides, guests } = createRidePark();
    guests.spawnGuests(1);
    const guest = [...guests.guests.values()][0];
    rides.setTicketPrice(object.id, 0);
    expect(rides.joinQueue(object.id, guest)).toBe('joined');
    rides.step(GAME_CONFIG.rides.maximumDispatchWaitSeconds * 1_000, guests.guests);
    const runtime = rides.getRide(object.id)!;
    runtime.condition = 65;

    rides.step(37_900, guests.guests);
    expect(runtime.status).toBe('running');
    expect(runtime.broken).toBe(false);

    rides.step(100, guests.guests);
    expect(runtime.completedCycles).toBe(1);
    expect(runtime.status).toBe('broken');
    expect(runtime.breakdownCount).toBe(1);
    expect(guest.state).toBe('wandering');
  });

  it('repairs and inspects through explicit maintenance states while preserving open intent', () => {
    const { world, object, rides, guests } = createRidePark();
    const runtime = rides.getRide(object.id)!;
    runtime.condition = 30;
    expect(rides.forceBreakdown(object.id, guests.guests)).toBe(true);
    expect(rides.beginMaintenance(object.id, 'inspection', guests.guests)).toBe('invalid');
    expect(rides.beginMaintenance(object.id, 'repair', guests.guests)).toBe('started');
    expect(runtime.status).toBe('maintenance');

    rides.setMaintenanceProgress(object.id, 1.5);
    expect(runtime.maintenanceProgress).toBe(1);
    rides.setOpen(object.id, false);
    const cashBeforeRepair = world.cash;
    expect(rides.completeMaintenance(object.id, 'repair', 27)).toBe(true);
    expect(runtime.broken).toBe(false);
    expect(runtime.condition).toBe(GAME_CONFIG.operations.maintenance.repairRestoreCondition);
    expect(runtime.repairsCompleted).toBe(1);
    expect(runtime.lifetimeMaintenanceCost).toBe(27);
    expect(runtime.open).toBe(false);
    expect(runtime.status).toBe('closed');
    expect(world.cash).toBe(cashBeforeRepair - 27);
    expect(world.transactions[0].category).toBe('maintenance');

    rides.setOpen(object.id, true);
    runtime.condition = 55;
    expect(rides.beginMaintenance(object.id, 'inspection', guests.guests)).toBe('started');
    rides.setMaintenanceProgress(object.id, 0.4);
    expect(rides.snapshot(object.id)?.maintenanceProgress).toBe(0.4);
    expect(rides.completeMaintenance(object.id, 'inspection', 5)).toBe(true);
    expect(runtime.condition).toBe(GAME_CONFIG.operations.maintenance.inspectionRestoreCondition);
    expect(runtime.inspectionsCompleted).toBe(1);
    expect(runtime.status).toBe('idle');
  });

  it('returns running instead of interrupting a live cycle for maintenance', () => {
    const { object, rides, guests } = createRidePark();
    guests.spawnGuests(1);
    const guest = [...guests.guests.values()][0];
    expect(rides.joinQueue(object.id, guest)).toBe('joined');
    rides.step(GAME_CONFIG.rides.maximumDispatchWaitSeconds * 1_000, guests.guests);
    const runtime = rides.getRide(object.id)!;
    runtime.condition = 50;

    expect(rides.beginMaintenance(object.id, 'inspection', guests.guests)).toBe('running');
    expect(runtime.status).toBe('running');
    expect(runtime.maintenanceKind).toBeNull();
  });

  it('completes the full arrival, queue, payment, ride, and satisfaction loop', () => {
    const { object, rides, guests } = createRidePark();
    for (let tick = 0; tick < 520; tick += 1) {
      rides.step(100, guests.guests);
      guests.step(100);
    }
    const runtime = rides.getRide(object.id)!;
    expect(runtime.ridersToday).toBeGreaterThan(0);
    expect(runtime.lifetimeRevenue).toBeGreaterThan(0);
    expect(runtime.completedCycles).toBeGreaterThan(0);
    expect(runtime.satisfactionCount).toBeGreaterThan(0);
  });
});
