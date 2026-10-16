import { describe, expect, it } from 'vitest';
import { ParkSession } from './session/ParkSession';

/**
 * Phase 9 scale regression: a full park with 1,000 guests must simulate fast and
 * stay deterministic. Measured baseline after the optimization pass is ~0.55 ms
 * per 100 ms tick on the dev container; the wall-clock bound below carries ~15×
 * headroom so slower CI machines never flake, while a true O(n²) regression
 * (per-decision route materialization, per-tick connectivity floods) still fails. The bound is
 * on the FASTEST of several batches, not on the total: a parallel test run or a busy CI host
 * steals time from some batches, but a real regression slows every one of them.
 */
const buildBigPark = (): ParkSession => {
  const session = new ParkSession(null);
  const world = session.world;
  world.addMoney(500_000, 'scale test funding');
  const paths: { x: number; y: number }[] = [];
  for (let y = 30; y >= 6; y -= 4) {
    for (let x = 1; x <= 30; x += 1) paths.push({ x, y });
  }
  for (let y = 30; y >= 7; y -= 1) paths.push({ x: 15, y });
  world.buildPaths(paths);
  const rideAnchors = [
    { x: 2, y: 27 }, { x: 6, y: 27 }, { x: 10, y: 27 }, { x: 20, y: 27 }, { x: 24, y: 27 },
    { x: 2, y: 23 }, { x: 6, y: 23 }, { x: 20, y: 23 }, { x: 24, y: 23 }, { x: 28, y: 23 },
  ];
  for (const anchor of rideAnchors) world.buildObject('petal-roundabout', anchor);
  const shopAnchors: { id: string; anchor: { x: number; y: number } }[] = [
    { id: 'picnic-pocket', anchor: { x: 12, y: 17 } },
    { id: 'fizz-foundry', anchor: { x: 17, y: 17 } },
    { id: 'comfort-cabin', anchor: { x: 22, y: 17 } },
    { id: 'picnic-pocket', anchor: { x: 2, y: 13 } },
    { id: 'fizz-foundry', anchor: { x: 6, y: 13 } },
    { id: 'comfort-cabin', anchor: { x: 10, y: 13 } },
  ];
  for (const shop of shopAnchors) world.buildObject(shop.id, shop.anchor);
  for (let x = 2; x <= 28; x += 6) world.buildObject('tidy-totem', { x, y: 29 });
  for (let i = 0; i < 8; i += 1) {
    session.operations.hireStaff('cleaner');
    session.operations.hireStaff('mechanic');
  }
  return session;
};

describe('simulation at scale', () => {
  it('runs 1,000 guests deterministically within the performance budget', () => {
    const first = buildBigPark();
    const twin = buildBigPark();
    expect(first.guests.spawnGuests(1_000)).toBe(1_000);
    expect(twin.guests.spawnGuests(1_000)).toBe(1_000);

    // Warm caches the way a running game would.
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

    // Determinism survives the optimization pass: twin sessions stay identical.
    expect(twin.world.cash).toBe(first.world.cash);
    expect(twin.guests.guests.size).toBe(first.guests.guests.size);
    expect(twin.management.snapshot().rating.score).toBe(first.management.snapshot().rating.score);
    const firstGuest = [...first.guests.guests.values()][500];
    const twinGuest = [...twin.guests.guests.values()][500];
    expect(twinGuest.position).toEqual(firstGuest.position);
    expect(twinGuest.happiness).toBe(firstGuest.happiness);

    const snapshot = first.management.snapshot();
    expect(Number.isFinite(snapshot.rating.score)).toBe(true);
    expect(snapshot.operations.averageHappiness).not.toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('NaN');
  }, 60_000);

  it('Phase 14: crowd feedback on, crowdView every 10th tick and the heatmap view, inside the same budget', () => {
    const first = buildBigPark();
    const twin = buildBigPark();
    expect(first.crowd.feedback, 'a new park compiles crowd feedback').toBe(true);
    for (const session of [first, twin]) {
      session.syncWithWorld();
      expect(session.guests.spawnGuests(1_000)).toBe(1_000);
    }
    for (let tick = 0; tick < 200; tick += 1) {
      first.step(100);
      twin.step(100);
    }

    const BATCHES = 5;
    const BATCH_TICKS = 40;
    let heatmap: ReturnType<ParkSession['crowdHeatmap']> | null = null;
    let bestBatchMs = Number.POSITIVE_INFINITY;
    for (let batch = 0; batch < BATCHES; batch += 1) {
      const started = performance.now();
      for (let tick = 0; tick < BATCH_TICKS; tick += 1) {
        first.step(100);
        // The UI cadence at 4x speed asks about every 10th tick: the view, the heatmap and a hover readout.
        if (first.world.tick % 10 === 0) {
          first.crowdView();
          heatmap = first.crowdHeatmap(heatmap);
          first.crowdHoverAt({ x: 15, y: 18 });
        }
      }
      bestBatchMs = Math.min(bestBatchMs, performance.now() - started);
    }
    for (let tick = 0; tick < BATCHES * BATCH_TICKS; tick += 1) twin.step(100);
    expect(bestBatchMs).toBeLessThan(BATCH_TICKS * 8);

    // The feedback path is exercised: severe tiles and several neighborhoods.
    const view = first.crowdView();
    const severe = view.neighborhoods.reduce((sum, neighborhood) => sum + neighborhood.metrics.bands[3], 0);
    expect(severe, 'at least one severe tile').toBeGreaterThan(0);
    expect(view.neighborhoods.length, 'neighborhoods (gate included)').toBeGreaterThanOrEqual(3);
    expect(heatmap!.bands).toContain(3);

    // Viewing never feeds back: the viewed park and its unviewed twin are identical, crowd field included.
    expect(twin.world.cash).toBe(first.world.cash);
    expect(twin.guests.guests.size).toBe(first.guests.guests.size);
    first.syncWithWorld();
    twin.syncWithWorld();
    expect(twin.serialize().crowd).toEqual(first.serialize().crowd);
    const firstGuest = [...first.guests.guests.values()][500];
    const twinGuest = [...twin.guests.guests.values()][500];
    expect(twinGuest.position).toEqual(firstGuest.position);
    expect(twinGuest.happiness).toBe(firstGuest.happiness);
  }, 60_000);

  it('stays inside the same budget in heat and in a storm with 1,000 guests', () => {
    const session = buildBigPark();
    expect(session.guests.spawnGuests(1_000)).toBe(1_000);
    for (let tick = 0; tick < 50; tick += 1) session.step(100);
    const BATCH_TICKS = 40;
    for (const kind of ['hot', 'storm'] as const) {
      session.weather.forceCurrentSlot(kind, 1);
      let best = Number.POSITIVE_INFINITY;
      for (let batch = 0; batch < 5; batch += 1) {
        const started = performance.now();
        for (let tick = 0; tick < BATCH_TICKS; tick += 1) session.step(100);
        best = Math.min(best, performance.now() - started);
      }
      expect(session.weather.conditions.weatherKind).toBe(kind);
      expect(best, `${kind} batch`).toBeLessThan(BATCH_TICKS * 8);
    }
  }, 60_000);

  it('evaluates the weather in O(1) per tick: 200,000 steps (27 game days) keep one conditions object', () => {
    const session = new ParkSession(null);
    const conditions = session.weather.conditions;
    const keys = Object.keys(conditions).join();
    const started = performance.now();
    for (let tick = 0; tick < 200_000; tick += 1) session.weather.step(tick);
    const elapsed = performance.now() - started;
    expect(session.weather.conditions).toBe(conditions);
    expect(Object.keys(conditions).join()).toBe(keys);
    // About 0.2 microseconds per step on the dev container; the bound is two orders looser.
    expect(elapsed).toBeLessThan(2_000);
    // The drawn days never pile up: only yesterday, today and two forecast days are kept.
    expect(session.weather.days.length).toBeLessThanOrEqual(4);
  });
});
