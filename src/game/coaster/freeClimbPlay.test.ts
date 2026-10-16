import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { scaledResearchGrant } from '../save/determinismFixtures';
import { ParkSession } from '../session/ParkSession';
import { seedDevPark } from '../session/devPark';
import { COASTER_TYPE_BY_ID } from './content';
import { coasterBaseCost, deriveCoasterStats } from './design';
import { hillDipNorthLayout } from './testLayouts';

/**
 * Scripted play test (lift hills): two identical dev parks, one with a hill-dip coaster whose lifts
 * are all chained and one with the same coaster whose three hills after the drops are free. Both
 * must keep earning and carrying guests. The printed numbers feed BALANCE_NOTES.md (PROVISIONAL).
 */

const TICKS = 6_000;

interface Outcome {
  riders: number;
  cycles: number;
  revenue: number;
  opCost: number;
  excitement: number;
  duration: number;
  cost: number;
}

const play = (free: boolean): Outcome => {
  const session = new ParkSession(null);
  seedDevPark(session);
  session.syncWithWorld();
  session.guests.spawnGuests(160);
  session.world.addMoney(300_000, 'Play test grant');
  session.progression.grantResearchPoints(scaledResearchGrant(session, 500, ['spin-studies', 'vertical-motion']));
  for (const project of ['spin-studies', 'vertical-motion']) {
    if (!session.progression.purchase(project).ok) throw new Error(`could not research ${project}`);
  }
  const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
  const layout = hillDipNorthLayout(free);
  const stats = deriveCoasterStats(layout, type);
  const cost = coasterBaseCost(layout, type);
  const placed = session.world.placeCoaster(type.definitionId, layout, stats, cost);
  if ('error' in placed) throw new Error(`could not place the coaster: ${placed.error}`);
  session.syncWithWorld();
  for (let tick = 0; tick < TICKS; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
  const ride = session.rides.rides.get(placed.id)!;
  return {
    riders: ride.ridersToday,
    cycles: ride.completedCycles,
    revenue: Math.round(ride.lifetimeRevenue * 100) / 100,
    opCost: Math.round(ride.lifetimeOperatingCost * 100) / 100,
    excitement: stats.excitement,
    duration: stats.durationSeconds,
    cost,
  };
};

describe('free-climb coaster play test', () => {
  const chained = play(false);
  const free = play(true);

  it('prints the numbers for BALANCE_NOTES', () => {
    console.log(`FREE-CLIMB PLAY ${JSON.stringify({ chained, free })}`);
  });

  it('both coasters carry guests, complete cycles and earn more than they cost to run', () => {
    for (const outcome of [chained, free]) {
      expect(outcome.riders).toBeGreaterThan(0);
      expect(outcome.cycles).toBeGreaterThan(0);
      expect(outcome.revenue).toBeGreaterThan(outcome.opCost);
    }
  });

  it('the free coaster has the shorter cycle, runs at least as many cycles and is cheaper to build', () => {
    expect(free.duration).toBeLessThan(chained.duration);
    expect(free.cycles).toBeGreaterThanOrEqual(chained.cycles);
    expect(free.cost).toBeLessThan(chained.cost);
  });

  it('stays inside the balance bound: revenue within +35 percent of the chained twin (target +25, measured about +26)', () => {
    // The gain is the shorter cycle (a free hill after a drop keeps its speed), not the ticket price.
    expect(free.revenue).toBeLessThanOrEqual(chained.revenue * 1.35);
    expect(free.revenue).toBeGreaterThan(chained.revenue * 0.5);
  });
});
