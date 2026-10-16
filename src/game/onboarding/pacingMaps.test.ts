import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { MAPS } from '../maps/content';
import { generateMap, recipeOf } from '../maps/generator';
import { BIOME_IDS } from '../biomes/types';
import { hashState } from '../save/hash';
import { ParkSession } from '../session/ParkSession';
import { ONBOARDING_STEPS } from './content';
import { buildFirstDayRoute } from './routeInFrame';
import type { OnboardingStepId } from './types';

/**
 * The First Day on other maps (Phase 24). pacing.test.ts stays untouched and pins Meadow. Here the SAME rich
 * route, built through the entrance frame, must latch all ten steps within 15 minutes with the cash never
 * negative on Red Rock Canyon (gate on the north edge facing south, a desert with its own climate and rules);
 * on every other shipped map the route at least builds and the first steps latch. If Red Rock does not latch,
 * the Desert numbers are retuned (and recorded), never this test.
 */

const FIFTEEN_MINUTES_IN_TICKS = (15 * 60 * 1000) / GAME_CONFIG.fixedStepMs;

const run = (mapId: (typeof MAPS)[number]['id'], ticks: number) => {
  const session = new ParkSession(null, [], { mapId });
  buildFirstDayRoute(session);
  let minimumCash = session.world.cash;
  for (let tick = 0; tick < ticks; tick += 1) {
    session.step(GAME_CONFIG.fixedStepMs);
    minimumCash = Math.min(minimumCash, session.world.cash);
  }
  const latchTicks = new Map(session.onboarding!.serialize().completed.map((entry) => [entry.id, entry.tick]));
  return { session, latchTicks, minimumCash };
};

describe('First Day pacing on Red Rock Canyon (the non-Meadow route)', () => {
  const canyon = run('red-rock-canyon', FIFTEEN_MINUTES_IN_TICKS);

  it('the gate is (16, 0) facing south and the route is built in the entrance frame', () => {
    expect(canyon.session.world.entrance).toEqual({ x: 16, y: 0 });
    expect(canyon.session.world.entranceFacing).toBe('south');
    expect(canyon.session.world.paths.has('16,11')).toBe(true);
    expect(canyon.session.world.objects.size).toBe(7);
  });

  it('every step latches within 15 simulated minutes and cash never goes negative', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(canyon.latchTicks.has(step.id), `${step.id} latched`).toBe(true);
      expect(canyon.latchTicks.get(step.id)!, `${step.id} within 15 minutes`).toBeLessThanOrEqual(FIFTEEN_MINUTES_IN_TICKS);
    }
    expect(canyon.minimumCash).toBeGreaterThanOrEqual(0);
  });

  it('the steps arrive in the same sensible order as on Meadow', () => {
    const at = (id: OnboardingStepId): number => canyon.latchTicks.get(id)!;
    expect(at('lay-path')).toBeLessThan(at('first-rider'));
    expect(at('first-ride')).toBeLessThan(at('first-rider'));
    expect(at('first-rider')).toBeLessThan(at('guest-target'));
    expect(at('first-rider')).toBeLessThan(at('first-profit'));
  });
});

describe('the same route on every other shipped map', () => {
  it.each(MAPS.map((map) => [map.id] as const))('%s: the route builds and the first steps latch', (id) => {
    const { session, latchTicks } = run(id, 600);
    expect(session.world.objects.size).toBe(7);
    for (const step of ['lay-path', 'first-ride', 'set-price', 'first-food', 'first-drink'] as const) {
      expect(latchTicks.has(step), `${id} ${step}`).toBe(true);
    }
  });
});

describe('the frame route is the Meadow route', () => {
  it('on Meadow Garden it builds exactly what pacing.test.ts\'s rich route builds (same world, same ledger)', () => {
    const original = new ParkSession(null);
    const cells = [];
    for (let y = 31; y >= 20; y -= 1) cells.push({ x: 15, y });
    original.world.buildPaths(cells);
    for (const [id, x, y] of [['moonpetal-carousel', 16, 26], ['picnic-pocket', 16, 29], ['fizz-foundry', 13, 29], ['petal-roundabout', 16, 22], ['lollipop-lamp', 14, 26], ['lollipop-lamp', 14, 23], ['sunburst-flowers', 14, 22]] as const) {
      original.world.buildObject(id, { x, y });
    }
    original.syncWithWorld();
    const carousel = [...original.world.objects.values()].find((object) => object.definitionId === 'moonpetal-carousel')!;
    original.rides.setTicketPrice(carousel.id, 5);
    original.operations.hireStaff('cleaner');
    const framed = new ParkSession(null);
    buildFirstDayRoute(framed);
    expect(hashState(framed.world.serialize())).toBe(hashState(original.world.serialize()));
    expect(hashState(framed.serialize())).toBe(hashState(original.serialize()));
  });
});

describe('the same route on generated maps (Phase 24 step 2)', () => {
  const FIFTEEN = (15 * 60 * 1000) / GAME_CONFIG.fixedStepMs;
  const generated = BIOME_IDS.flatMap((biome) => [1234, 0xdeadbeef].map((seed) => [biome, seed] as const));

  it.each(generated)('%s seed %i: the route builds in the entrance frame and every First Day step but the optional repair latches within 15 minutes, cash never negative', (biome, seed) => {
    const session = new ParkSession(null, [], { layout: generateMap(recipeOf(biome, seed)).layout });
    buildFirstDayRoute(session);
    expect(session.world.objects.size).toBe(7);
    let minimumCash = session.world.cash;
    for (let tick = 0; tick < FIFTEEN; tick += 1) {
      session.step(GAME_CONFIG.fixedStepMs);
      minimumCash = Math.min(minimumCash, session.world.cash);
    }
    const latched = new Map(session.onboarding!.serialize().completed.map((entry) => [entry.id, entry.tick]));
    // 'fix-problem' is the one optional step ("Or skip"): it needs litter or a breakdown, which depends on the park seed's
    // luck and not on the map (Meadow's own seeds latch it between tick 1,320 and 3,440, some generated seeds not at all).
    for (const step of ONBOARDING_STEPS.filter((candidate) => candidate.id !== 'fix-problem')) {
      expect(latched.has(step.id), `${step.id} latched`).toBe(true);
      expect(latched.get(step.id)!, `${step.id} within 15 minutes`).toBeLessThanOrEqual(FIFTEEN);
    }
    expect(minimumCash).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
