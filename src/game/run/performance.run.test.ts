import { describe, expect, it } from 'vitest';
import { generateMap } from '../maps/generator';
import { buildPropPark } from '../performanceHarness';
import { acceptedRecipeOf, mapIsAcceptable, planRun } from './plan';

/**
 * Phase 23: the 1,000-guest budget on the heaviest map The Map can ask for. Found once over the 1,000-run Tough corpus
 * (every high-density level, accepted maps only; 4,000 maps) and pinned here by (run seed, level): the heaviest prop box
 * weight (Tough seed 248, level 2: 8,600 of the 8,600 cap, 257 props) and the most props (Tough seed 7, level 5: 300 props).
 * Same budget as performance.maps.test.ts: best of 5 batches below 8 ms per tick, twin sessions identical.
 */
const HEAVIEST = [
  { name: 'heaviest box weight (Tough seed 248, level 2)', seed: 248, level: 1, weight: 8_600, props: 257 },
  { name: 'most props (Tough seed 7, level 5)', seed: 7, level: 4, weight: 7_520, props: 300 },
] as const;

describe.each(HEAVIEST)('simulation at scale on a run map: $name', ({ seed, level, weight, props }) => {
  const planned = planRun({ seed, difficulty: 'tough' }).levels[level];
  const map = generateMap(acceptedRecipeOf(seed, planned).recipe);
  const { layout } = map;

  it('is the map the corpus search found, and it is an accepted level map', () => {
    expect(planned.density).toBe('high');
    expect(map.stats.totalWeight).toBe(weight);
    expect(layout.props.length).toBe(props);
    expect(mapIsAcceptable(map)).toBe(true);
    const { session, rides, paths } = buildPropPark({ layout });
    expect(rides, 'rides placed').toBeGreaterThanOrEqual(6);
    expect(paths, 'path tiles').toBeGreaterThan(60);
    session.guests.navigation.sync(session.world.paths, session.world.pathVersion);
    expect(session.guests.navigation.connectedCells(session.world.entrance).length).toBe(session.world.paths.size);
  });

  it('runs 1,000 guests deterministically within the performance budget (best of 5 batches below 8 ms per tick)', () => {
    const first = buildPropPark({ layout }).session;
    const twin = buildPropPark({ layout }).session;
    expect(first.guests.spawnGuests(1_000)).toBe(1_000);
    expect(twin.guests.spawnGuests(1_000)).toBe(1_000);
    for (let tick = 0; tick < 50; tick += 1) {
      first.step(100);
      twin.step(100);
    }
    const BATCHES = 5;
    const BATCH_TICKS = 40;
    let bestBatchMs = Number.POSITIVE_INFINITY;
    for (let batch = 0; batch < BATCHES; batch += 1) {
      const started = performance.now();
      for (let tick = 0; tick < BATCH_TICKS; tick += 1) first.step(100);
      bestBatchMs = Math.min(bestBatchMs, performance.now() - started);
    }
    for (let tick = 0; tick < BATCHES * BATCH_TICKS; tick += 1) twin.step(100);
    expect(first.guests.guests.size).toBeGreaterThan(900);
    expect(bestBatchMs).toBeLessThan(BATCH_TICKS * 8);
    expect(twin.world.cash).toBe(first.world.cash);
    expect(twin.guests.guests.size).toBe(first.guests.guests.size);
    expect(JSON.stringify(first.management.snapshot())).not.toContain('NaN');
  }, 60_000);
});
