import { vi, describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ParkSession } from './ParkSession';
import { seedDevPark } from './devPark';

/**
 * Phase 16: this test was calibrated on a park without theme affinity and is not about themes, so it runs with the
 * affinity share at 0 (any non-zero share shifts guest choices and so who litters where and when guests arrive).
 * Phase 40: likewise with front-only access off: the dev park's stalls turn toward their paths, which moves where the
 * crowd queues and litters, and this test is about the crew, not about building fronts.
 */
vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  const config = actual.GAME_CONFIG;
  return {
    ...actual,
    GAME_CONFIG: {
      ...config,
      scenery: { ...config.scenery, themeAffinity: { ...config.scenery.themeAffinity, share: 0 } },
      access: { ...config.access, frontOnly: false },
    },
  };
});


/**
 * The reason staff scaling and training exist: at the guest cap, a park stripped down to two
 * bins used to accumulate litter no crew could clear. The run below is deterministic — the
 * dev park, the same seeded guests, the same number of steps — so the two staffing setups are
 * directly comparable.
 */
const runCrowdedPark = (cleaners: number, trainings: number, seconds: number) => {
  const session = new ParkSession(null);
  // This test compares two crews, so weather stays out of it: with weather off the run is bit for bit
  // the one calibrated before weather existed (heat changes thirst and so who litters where).
  session.setWeatherEnabled(false);
  seedDevPark(session);
  while (session.operations.snapshot().staff.cleaners.total > 0) session.operations.fireStaff('cleaner');
  // Only two bins in the whole park, so nearly all waste lands on the paths.
  for (const bin of session.buildingsSnapshot().filter((row) => row.group === 'bin').slice(2)) {
    session.world.bulldoze(bin.anchor);
  }
  session.guests.spawnGuests(GAME_CONFIG.guests.maximum);
  // One step so the crew capacity sees the crowd that just arrived.
  session.step(GAME_CONFIG.fixedStepMs);
  let hired = 0;
  for (let index = 0; index < cleaners; index += 1) {
    if (session.operations.hireStaff('cleaner')) hired += 1;
  }
  for (let index = 0; index < trainings; index += 1) session.operations.trainStaff('cleaner');

  for (let step = 0; step < seconds * 1_000 / GAME_CONFIG.fixedStepMs; step += 1) {
    session.step(GAME_CONFIG.fixedStepMs);
    // Keep the park pinned at the cap instead of letting the crowd drain away.
    if (step % 100 === 0) session.guests.spawnGuests(GAME_CONFIG.guests.maximum);
  }
  const snapshot = session.operations.snapshot();
  return {
    hired,
    guests: session.guests.guests.size,
    litter: snapshot.cleanliness.litterUnits,
    cleanliness: snapshot.cleanliness.score,
  };
};

describe('staffing a park at the guest cap', () => {
  it('lets a scaled, trained crew hold a crowded park cleaner than a minimum crew can', () => {
    const minimum = runCrowdedPark(6, 0, 300);
    const scaled = runCrowdedPark(16, 3, 300);

    // The crowd earns the extra crew room: 6 base plus one per 100 guests.
    expect(minimum.hired).toBe(6);
    expect(scaled.hired).toBe(16);
    expect(scaled.guests).toBeGreaterThan(GAME_CONFIG.guests.maximum * 0.9);

    expect(scaled.litter).toBeLessThan(minimum.litter);
    expect(scaled.cleanliness).toBeGreaterThan(minimum.cleanliness + 10);
    expect(scaled.cleanliness).toBeGreaterThan(80);
    // Two 300-second crowded runs: ~3 s alone, so the 5 s default flakes when the whole suite runs in parallel.
  }, 30_000);
});
