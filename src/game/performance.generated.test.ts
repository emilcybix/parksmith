import { describe, expect, it } from 'vitest';
import { generateMap, recipeOf } from './maps/generator';
import { buildPropPark } from './performanceHarness';

/**
 * Phase 24 step 2: the 1,000-guest budget on the HEAVIEST generated maps, picked from the 500-seed x 6-biome high-density
 * fuzz and pinned here by recipe: the most prop cells (Autumn Forest, 300 props, open area 406: the generator's tightest
 * connected map) and the heaviest prop box weight (Meadow, 8,594 of the 8,600 cap). Same budget as performance.maps.test.ts:
 * best of 5 batches below 8 ms per tick, twin sessions identical.
 */
const HEAVIEST = [
  { name: 'most prop cells', recipe: recipeOf('autumn-forest', 45298323, { density: 'high' }), props: 300 },
  { name: 'heaviest box weight', recipe: recipeOf('meadow', 2475515309, { density: 'high' }), props: 254 },
] as const;

describe.each(HEAVIEST)('simulation at scale on the heaviest generated map: $name', ({ recipe, props }) => {
  const layout = generateMap(recipe).layout;

  it('is the map the fuzz found, and a prop-heavy park can be built on it', () => {
    expect(layout.props.length).toBe(props);
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
    const firstGuest = [...first.guests.guests.values()][500];
    const twinGuest = [...twin.guests.guests.values()][500];
    expect(twinGuest.position).toEqual(firstGuest.position);
    expect(twinGuest.happiness).toBe(firstGuest.happiness);
    expect(JSON.stringify(first.management.snapshot())).not.toContain('NaN');
  }, 60_000);
});
