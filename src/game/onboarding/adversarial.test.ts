import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';

/** Adversarial spec/gameplay review of the First Day engine, run against real sandbox sessions. */

const ticks = (session: ParkSession, count: number): void => {
  for (let i = 0; i < count; i += 1) session.step(GAME_CONFIG.fixedStepMs);
};
const done = (session: ParkSession): string[] => session.onboarding!.serialize().completed.map((entry) => entry.id);
const column = (yFrom: number, yTo: number) => {
  const cells = [];
  for (let y = yFrom; y >= yTo; y -= 1) cells.push({ x: 15, y });
  return cells;
};

describe('adversarial: ordering and shape', () => {
  it('a ride placed BEFORE its path is connected counts once the path arrives', () => {
    const session = new ParkSession(null);
    expect(session.world.buildObject('moonpetal-carousel', { x: 16, y: 26 })).not.toBeNull();
    session.syncWithWorld();
    ticks(session, 30);
    expect(done(session)).not.toContain('first-ride');
    session.world.buildPaths(column(31, 24));
    ticks(session, 30);
    expect(done(session)).toContain('first-ride');
    expect(done(session)).toContain('lay-path');
  });

  it('a path built sideways from the gate still counts', () => {
    const session = new ParkSession(null);
    const cells = [];
    for (let x = 15; x <= 22; x += 1) cells.push({ x, y: 31 });
    session.world.buildPaths(cells);
    ticks(session, 20);
    expect(done(session)).toContain('lay-path');
  });

  it('a path that is NOT linked to the gate never counts', () => {
    const session = new ParkSession(null);
    const cells = [];
    for (let y = 20; y >= 10; y -= 1) cells.push({ x: 5, y });
    session.world.buildPaths(cells);
    ticks(session, 20);
    expect(done(session)).not.toContain('lay-path');
  });

  it('closing the only ride never completes, undoes or blocks a step; reopening lets the first rider arrive', () => {
    const session = new ParkSession(null);
    session.world.buildPaths(column(31, 24));
    const ride = session.world.buildObject('moonpetal-carousel', { x: 16, y: 26 })!;
    session.syncWithWorld();
    session.rides.setOpen(ride.id, false);
    ticks(session, 1500);
    expect(done(session)).not.toContain('first-rider');
    expect(done(session)).toContain('first-ride');
    session.rides.setOpen(ride.id, true);
    ticks(session, 2500);
    expect(done(session)).toContain('first-rider');
  });

  it('demolishing the ride after it completed steps keeps them, and a replacement ride can still finish the rest', () => {
    const session = new ParkSession(null);
    session.world.buildPaths(column(31, 24));
    const ride = session.world.buildObject('moonpetal-carousel', { x: 16, y: 26 })!;
    session.syncWithWorld();
    session.rides.setTicketPrice(ride.id, 7);
    ticks(session, 20);
    expect(done(session)).toEqual(expect.arrayContaining(['first-ride', 'set-price']));
    session.world.bulldoze({ x: 16, y: 26 });
    session.syncWithWorld();
    ticks(session, 20);
    expect(done(session)).toEqual(expect.arrayContaining(['first-ride', 'set-price']));
    expect(session.world.buildObject('petal-roundabout', { x: 16, y: 26 })).not.toBeNull();
    session.syncWithWorld();
    ticks(session, 3000);
    expect(done(session)).toContain('first-rider');
  });

  it('setting the price to the value it already has does NOT complete set-price (hint trap)', () => {
    const session = new ParkSession(null);
    session.world.buildPaths(column(31, 24));
    const ride = session.world.buildObject('moonpetal-carousel', { x: 16, y: 26 })!;
    session.syncWithWorld();
    session.rides.setTicketPrice(ride.id, session.rides.rides.get(ride.id)!.ticketPrice);
    ticks(session, 20);
    expect(done(session)).not.toContain('set-price');
  });

  it('every ride in the catalog starts at its profile price, so set-price never completes at placement', () => {
    const session = new ParkSession(null);
    session.world.buildPaths(column(31, 10));
    const ids = ['moonpetal-carousel', 'petal-roundabout', 'comet-cups'];
    let y = 28;
    for (const id of ids) {
      const placed = session.world.buildObject(id, { x: 16, y });
      if (placed) y -= 4;
    }
    session.syncWithWorld();
    ticks(session, 20);
    expect(done(session)).not.toContain('set-price');
  });
});

describe('adversarial: litter branch in a live park', () => {
  it('a cleaner hired AFTER the litter appeared still completes fix-problem', () => {
    const session = new ParkSession(null);
    session.world.buildPaths(column(31, 24));
    session.world.buildObject('moonpetal-carousel', { x: 16, y: 26 });
    session.syncWithWorld();
    ticks(session, 20);
    session.operations.addLitter({ x: 15, y: 28 }, 5);
    ticks(session, 20);
    expect(done(session)).not.toContain('fix-problem');
    expect(session.operations.hireStaff('cleaner')).not.toBeNull();
    ticks(session, 1200);
    expect(done(session)).toContain('fix-problem');
  });

  it('hiring a cleaner and firing them before litter is cleaned never completes it', () => {
    const session = new ParkSession(null);
    session.world.buildPaths(column(31, 24));
    session.syncWithWorld();
    session.operations.addLitter({ x: 15, y: 28 }, 5);
    ticks(session, 20);
    session.operations.hireStaff('cleaner');
    session.operations.fireStaff('cleaner');
    ticks(session, 600);
    expect(done(session)).not.toContain('fix-problem');
  });

  it('litter below the seen threshold, cleaned by a cleaner, does not count as a problem', () => {
    const session = new ParkSession(null);
    session.world.buildPaths(column(31, 24));
    session.syncWithWorld();
    session.operations.addLitter({ x: 15, y: 28 }, 2);
    session.operations.hireStaff('cleaner');
    ticks(session, 600);
    expect(done(session)).not.toContain('fix-problem');
  });
});

describe('adversarial: cost and scope', () => {
  it('a dismissed tracker still pays for collecting the input every 10th tick (reported, not asserted)', () => {
    const session = new ParkSession(null);
    session.onboarding!.dismissAll();
    let collected = 0;
    const original = session.onboarding!.step.bind(session.onboarding!);
    session.onboarding!.step = (input) => { collected += 1; original(input); };
    ticks(session, 100);
    // ParkSession calls collectOnboardingInput before step() can early-return.
    expect(collected).toBe(10);
  });
});
