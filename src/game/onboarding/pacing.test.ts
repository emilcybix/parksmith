import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { ONBOARDING_STEPS } from './content';
import type { OnboardingStepId } from './types';

/**
 * The only place the provisional step targets (path tiles, arrivals, profit, rating) are justified:
 * a scripted player walks the cheapest sensible route through a real sandbox session, and every
 * step must latch inside the first 15 simulated minutes, without the cash ever going negative.
 * The measured ticks are recorded in BALANCE_NOTES.md ("First Day pacing").
 */

const FIFTEEN_MINUTES_IN_TICKS = (15 * 60 * 1000) / GAME_CONFIG.fixedStepMs;

const place = (session: ParkSession, definitionId: string, x: number, y: number): void => {
  if (!session.world.buildObject(definitionId, { x, y })) throw new Error(`pacing route could not place ${definitionId}`);
};

const route = (session: ParkSession, options: { rich: boolean }): number[] => {
  const cells = [];
  for (let y = 31; y >= (options.rich ? 20 : 24); y -= 1) cells.push({ x: 15, y });
  session.world.buildPaths(cells);
  place(session, 'moonpetal-carousel', 16, 26);
  place(session, 'picnic-pocket', 16, 29);
  place(session, 'fizz-foundry', 13, 29);
  if (options.rich) {
    // A second ride and some scenery: the cheapest route to the rating target, deliberately without
    // bins so the litter branch of "Fix a problem" can still occur.
    place(session, 'petal-roundabout', 16, 22);
    place(session, 'lollipop-lamp', 14, 26);
    place(session, 'lollipop-lamp', 14, 23);
    place(session, 'sunburst-flowers', 14, 22);
  }
  session.syncWithWorld();
  const carousel = [...session.world.objects.values()].find((object) => object.definitionId === 'moonpetal-carousel')!;
  session.rides.setTicketPrice(carousel.id, 5);
  session.operations.hireStaff('cleaner');
  return [carousel.id];
};

interface PacingRun {
  latchTicks: Map<OnboardingStepId, number>;
  minimumCash: number;
}

const run = (options: { rich: boolean }, ticks: number): PacingRun => {
  const session = new ParkSession(null);
  route(session, options);
  let minimumCash = session.world.cash;
  for (let tick = 0; tick < ticks; tick += 1) {
    session.step(GAME_CONFIG.fixedStepMs);
    minimumCash = Math.min(minimumCash, session.world.cash);
  }
  const latchTicks = new Map(session.onboarding!.serialize().completed.map((entry) => [entry.id, entry.tick]));
  return { latchTicks, minimumCash };
};

describe('First Day pacing', () => {
  const rich = run({ rich: true }, FIFTEEN_MINUTES_IN_TICKS);

  it('every step latches within 15 simulated minutes on the scripted route, and cash never goes negative', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(rich.latchTicks.has(step.id), `${step.id} latched`).toBe(true);
      expect(rich.latchTicks.get(step.id)!, `${step.id} within 15 minutes`).toBeLessThanOrEqual(FIFTEEN_MINUTES_IN_TICKS);
    }
    expect(rich.minimumCash, 'the route is affordable from the starting cash').toBeGreaterThanOrEqual(0);
  });

  it('the passive and the earned steps arrive in a sensible order', () => {
    const at = (id: OnboardingStepId): number => rich.latchTicks.get(id)!;
    expect(at('lay-path'), 'path before the first rider').toBeLessThan(at('first-rider'));
    expect(at('first-ride'), 'ride before the first rider').toBeLessThan(at('first-rider'));
    expect(at('set-price'), 'price before the first rider').toBeLessThan(at('first-rider'));
    expect(at('first-rider'), 'first rider before the guest target').toBeLessThan(at('guest-target'));
    expect(at('first-rider'), 'first rider before the first profit').toBeLessThan(at('first-profit'));
  });

  it('nothing is complete at creation: a fresh sandbox latches no step however long it idles', () => {
    const session = new ParkSession(null);
    for (let tick = 0; tick < 600; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(session.onboarding!.snapshot().completedCount).toBe(0);
  });

  it('the rating step ignores the default rating of a park nobody has visited yet', () => {
    const early = run({ rich: true }, 100);
    expect(early.latchTicks.has('good-rating'), 'a rich park at 10 s has no guest opinions yet').toBe(false);
    expect(early.latchTicks.has('first-drink'), 'while its connected stalls are counted at once').toBe(true);
  });
});
