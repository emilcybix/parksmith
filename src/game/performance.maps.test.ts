import { describe, expect, it } from 'vitest';
import { buildPropPark } from './performanceHarness';

/**
 * Phase 24 scale regression on the heaviest maps (Frosted Hollow: 279 props; Maple Ridge: 278 props and the
 * most walls). The 1,000-guest budget of performance.test.ts must hold with props in the world: obstruction is
 * one typed-array read in canPlace*, and guests never see props (they walk the path network), so the tick cost
 * must not move. Paths are laid as a comb over the open cells reachable from the gate, rides on free 3x3
 * plots beside them. Best-of-5 batch below 8 ms per tick, and twin sessions stay identical.
 */
// Phase 21: Meadow Estate fully bought is the largest map (64 x 64): its path network, crowd field and distance fields
// are the biggest the game builds, so it carries the same 1,000-guest budget.
describe.each([['frosted-hollow'], ['maple-ridge'], ['meadow-estate']] as const)('simulation at scale on %s', (mapId) => {
  it('a prop-heavy park is actually prop-heavy, with a connected comb and a working set of rides', () => {
    const { session, rides, paths } = buildPropPark({ mapId });
    // Some trees were bought for plots; the forest is still thick (the estate has 194 on four times the land).
    expect(session.world.props.size).toBeGreaterThanOrEqual(mapId === 'meadow-estate' ? 150 : 200);
    if (mapId === 'meadow-estate') expect(session.world.land.ownedCount, 'the whole estate is bought').toBe(64);
    expect(rides, 'rides placed').toBeGreaterThanOrEqual(6);
    expect(paths, 'path tiles').toBeGreaterThan(60);
    session.guests.navigation.sync(session.world.paths, session.world.pathVersion);
    expect(session.guests.navigation.connectedCells(session.world.entrance).length).toBe(session.world.paths.size);
  });

  it('runs 1,000 guests deterministically within the performance budget (best of 5 batches below 8 ms per tick)', () => {
    const first = buildPropPark({ mapId }).session;
    const twin = buildPropPark({ mapId }).session;
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

  it('clearing a forest while 1,000 guests are in the park changes nothing but the cash and the land', () => {
    const { session } = buildPropPark({ mapId });
    session.guests.spawnGuests(1_000);
    for (let tick = 0; tick < 20; tick += 1) session.step(100);
    const before = session.world.cash;
    let cleared = 0;
    let spent = 0;
    for (const prop of [...session.world.props.values()].slice(0, 60)) {
      const result = session.world.bulldoze(prop);
      if (result.removed) {
        cleared += 1;
        spent += result.cost ?? 0;
      }
    }
    expect(cleared).toBeGreaterThan(20);
    expect(session.world.cash).toBe(before - spent);
    session.syncWithWorld();
    const started = performance.now();
    for (let tick = 0; tick < 40; tick += 1) session.step(100);
    expect(performance.now() - started).toBeLessThan(40 * 25);
    expect(session.guests.guests.size).toBeGreaterThan(900);
  }, 60_000);
});
