import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { hashState } from '../save/hash';
import { ParkSession } from './ParkSession';
import { seedDevPark } from './devPark';

/**
 * Phase 25 (design 2.3): the owner methods a one-shot card calls between two steps. None of them posts money (the card
 * does that), none bumps `world.version`, and every state they leave behind is a state a restore accepts and continues
 * identically (a reloaded twin is the same park).
 */

const STEP = GAME_CONFIG.fixedStepMs;

const livingDevPark = (ticks = 600): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  session.guests.spawnGuests(150);
  for (let tick = 0; tick < ticks; tick += 1) session.step(STEP);
  return session;
};

/** The state restores, and the restored twin and the live park stay identical for `ticks` more steps. */
const expectTwinParity = (session: ParkSession, ticks = 50): void => {
  const twin = ParkSession.fromState(structuredClone(session.serialize()));
  expect(hashState(twin.serialize())).toBe(hashState(session.serialize()));
  for (let tick = 0; tick < ticks; tick += 1) {
    session.step(STEP);
    twin.step(STEP);
  }
  expect(hashState(twin.serialize())).toBe(hashState(session.serialize()));
};

type RideList = Array<ParkSession['rides']['rides'] extends Map<number, infer Ride> ? Ride : never>;

const idleRideIds = (session: ParkSession): number[] => [...session.rides.rides.values()]
  .filter((ride) => ride.status !== 'running' && ride.maintenanceKind === null && !ride.broken && !ride.pendingBreakdown)
  .map((ride) => ride.objectId)
  .sort((left, right) => left - right);

describe('one-shot primitives (Phase 25)', () => {
  it('rides.repairBroken repairs every eligible broken ride for free, skips one under a started maintenance, and leaves a restorable park', () => {
    const session = livingDevPark(5);
    const guests = session.guests.guests;
    const candidates = idleRideIds(session).slice(0, 3);
    expect(candidates).toHaveLength(3);
    for (const id of candidates) expect(session.rides.forceBreakdown(id, guests)).toBe(true);
    const [started, ...rest] = candidates;
    expect(session.rides.beginMaintenance(started, 'repair', guests)).toBe('started');
    const version = session.world.version;
    const transactions = session.world.transactions.length;
    const cash = session.world.cash;
    expect(session.rides.repairableCount()).toBeGreaterThanOrEqual(2);
    const repaired = session.rides.repairBroken(guests);
    expect(repaired).toEqual(expect.arrayContaining(rest));
    expect(repaired).not.toContain(started);
    expect([...repaired].sort((left, right) => left - right)).toEqual(repaired);
    for (const id of rest) {
      const ride = session.rides.rides.get(id)!;
      expect(ride.broken).toBe(false);
      expect(ride.maintenanceKind).toBeNull();
      expect(ride.condition).toBeGreaterThanOrEqual(GAME_CONFIG.operations.maintenance.repairRestoreCondition);
    }
    expect(session.rides.rides.get(started)!.maintenanceKind).toBe('repair');
    expect(session.rides.repairableCount()).toBe(0);
    expect(session.rides.repairBroken(guests)).toEqual([]);
    expect(session.world.version).toBe(version);
    expect(session.world.transactions.length).toBe(transactions);
    expect(session.world.cash).toBe(cash);
    expectTwinParity(session);
  });

  it('rides.serviceAll repairs and inspects every idle ride, releases its queue, leaves it at condition 100 and never touches a running ride', () => {
    const session = livingDevPark(1_500);
    const guests = session.guests.guests;
    // Step to a moment with two worn rides between cycles, one of them with a queue.
    const between = (): RideList => [...session.rides.rides.values()].filter((ride) => ride.status !== 'running' && ride.maintenanceKind === null && !ride.broken && ride.condition < 100);
    for (let tick = 0; tick < 3_000 && !(between().length >= 2 && between().some((ride) => ride.queueGuestIds.length > 0)); tick += 1) session.step(STEP);
    const [broken] = between().map((ride) => ride.objectId);
    expect(broken).toBeDefined();
    session.rides.forceBreakdown(broken, guests);
    const running = [...session.rides.rides.values()].filter((ride) => ride.status === 'running').map((ride) => ({ id: ride.objectId, condition: ride.condition }));
    const queued = [...session.rides.rides.values()].filter((ride) => ride.status !== 'running' && ride.maintenanceKind === null && ride.queueGuestIds.length > 0);
    const version = session.world.version;
    const transactions = session.world.transactions.length;
    const serviced = session.rides.serviceAll(guests);
    expect(serviced).toContain(broken);
    expect(serviced.length).toBeGreaterThan(1);
    expect(queued.length, 'some idle ride had a queue to release').toBeGreaterThan(0);
    expect(running.length, 'some ride was mid-cycle').toBeGreaterThan(0);
    for (const id of serviced) {
      const ride = session.rides.rides.get(id)!;
      expect(ride.condition, `ride ${id}`).toBe(100);
      expect(ride.broken).toBe(false);
      expect(ride.queueGuestIds).toEqual([]);
    }
    for (const ride of queued) if (ride.condition < 100 || ride.broken) expect(serviced).toContain(ride.objectId);
    for (const { id, condition } of running) {
      expect(serviced).not.toContain(id);
      expect(session.rides.rides.get(id)!.condition).toBe(condition);
    }
    expect(session.rides.serviceableCount()).toBe(0);
    expect(session.world.version).toBe(version);
    expect(session.world.transactions.length).toBe(transactions);
    expectTwinParity(session);
  });

  it('operations.sweepLitter clears every pile and releases the cleaners on them at once; emptyBins empties every bin', () => {
    const session = livingDevPark();
    const paths = [...session.world.paths].slice(0, 12).map((key) => {
      const [x, y] = String(key).split(',').map(Number);
      return { x, y };
    });
    for (const path of paths) session.operations.addLitter(path, 3);
    // Let the cleaners take litter tasks.
    for (let tick = 0; tick < 30; tick += 1) session.step(STEP);
    const tasksOf = (kind: string): number => [...session.operations.staff.values()].filter((worker) => worker.task?.kind === kind).length;
    expect(tasksOf('cleanLitter')).toBeGreaterThan(0);
    const firstBin = [...session.operations.bins.values()][0];
    expect(firstBin).toBeDefined();
    firstBin.fill = 2;
    const version = session.world.version;
    const piles = session.operations.litter.size;
    expect(piles).toBeGreaterThan(0);
    expect(session.operations.usedBinCount()).toBeGreaterThanOrEqual(1);
    expect(session.operations.sweepLitter()).toBe(piles);
    expect(session.operations.litter.size).toBe(0);
    expect(tasksOf('cleanLitter')).toBe(0);
    expect(session.operations.emptyBins()).toBeGreaterThanOrEqual(1);
    for (const bin of session.operations.bins.values()) expect(bin.fill).toBe(0);
    expect(tasksOf('emptyBin')).toBe(0);
    expect(session.operations.usedBinCount()).toBe(0);
    expect(session.operations.sweepLitter()).toBe(0);
    expect(session.operations.snapshot().cleanliness.litterUnits).toBe(0);
    expect(session.world.version).toBe(version);
    // Saved between steps, the assignment laws still hold.
    expectTwinParity(session);
  });

  it('weather.rewriteForecast writes exactly `count` slots after the current one, never a day kind; the restore accepts it', () => {
    const session = new ParkSession(null);
    for (let tick = 0; tick < 2_000; tick += 1) session.step(STEP);
    const weather = session.weather;
    const kindsBefore = weather.days.map((day) => day.kind);
    const chainKind = weather.chainKind;
    const before = weather.forecast(8);
    const written = weather.rewriteForecast('sunny', 4, 0.5);
    expect(written).toBe(4);
    const after = weather.forecast(8);
    expect(after.slice(0, 4).map((entry) => [entry.day, entry.slot, entry.kind, entry.intensity]))
      .toEqual(before.slice(0, 4).map((entry) => [entry.day, entry.slot, 'sunny', 0.5]));
    expect(after.slice(4)).toEqual(before.slice(4));
    expect(weather.days.map((day) => day.kind)).toEqual(kindsBefore);
    expect(weather.chainKind).toBe(chainKind);
    expect(weather.rewriteForecast('sunny', 0, 0.5)).toBe(0);
    // `forecastDays` (2) guarantees at least four future slots at any time of day.
    expect(GAME_CONFIG.weather.forecastDays * GAME_CONFIG.weather.slotsPerDay).toBeGreaterThanOrEqual(4);
    expectTwinParity(session);
  });

  it('weather.rewriteForecast draws the horizon first: the stream is what the park would have drawn', () => {
    const tick = 7_200 * 3 - 1;
    const plain = new ParkSession(null);
    const carded = new ParkSession(null);
    plain.world.tick = tick;
    carded.world.tick = tick;
    carded.weather.rewriteForecast('sunny', 3, 0.4);
    plain.weather.refresh(tick);
    expect(carded.weather.rngStateForTest()).toBe(plain.weather.rngStateForTest());
    expect(carded.weather.firstDay).toBe(plain.weather.firstDay);
    expect(carded.weather.days.length).toBe(plain.weather.days.length);
  });

  it('guests.adjustHappiness adds to every guest who is not leaving, clamped to 0..100', () => {
    const session = livingDevPark(300);
    const guests = [...session.guests.guests.values()];
    const leaving = guests.find((guest) => guest.state === 'leaving') ?? guests[0];
    leaving.state = 'leaving';
    leaving.happiness = 40;
    const others = guests.filter((guest) => guest !== leaving && guest.state !== 'leaving');
    expect(others.length).toBeGreaterThan(0);
    const before = new Map(others.map((guest) => [guest.id, guest.happiness]));
    expect(session.guests.adjustHappiness(5)).toBe(others.length);
    for (const guest of others) expect(guest.happiness).toBe(Math.min(100, before.get(guest.id)! + 5));
    expect(leaving.happiness).toBe(40);
    session.guests.adjustHappiness(500);
    for (const guest of others) expect(guest.happiness).toBe(100);
    session.guests.adjustHappiness(-500);
    for (const guest of others) expect(guest.happiness).toBe(0);
    expect(leaving.happiness).toBe(40);
    expect(session.guests.adjustHappiness(Number.NaN)).toBe(0);
    expectTwinParity(session);
  });

  it('guests.spawnGuests consumes the saved guest stream: a reloaded twin spawns the same guests, and arrivals count them', () => {
    const session = livingDevPark(200);
    const twin = ParkSession.fromState(structuredClone(session.serialize()));
    const arrivals = session.guests.totalArrivals;
    const rng = session.serialize().guests.randomState;
    expect(session.guests.spawnGuests(5)).toBe(5);
    expect(twin.guests.spawnGuests(5)).toBe(5);
    expect(session.guests.totalArrivals).toBe(arrivals + 5);
    expect(session.serialize().guests.randomState).not.toBe(rng);
    expect(hashState(twin.serialize())).toBe(hashState(session.serialize()));
    expectTwinParity(session);
  });
});
