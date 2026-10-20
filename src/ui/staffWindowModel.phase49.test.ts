import { describe, expect, it } from 'vitest';
import type { CleanerLoad } from '../app/cleanerLoad';
import { cleanerCapacityRead, staffOverview } from './staffWindowModel';

/** Phase 49: the Staff window's cleaner capacity read and the bins hint (BALANCE_NOTES "Phase 49: litter against cleaners"). */

const operations = {
  cleanliness: { score: 40, litterUnits: 90, dirtyPathTiles: 30, binsTotal: 0, binsFull: 0, averageBinFillPercent: 0 },
  maintenance: { averageRideCondition: 80, wornRides: 0, brokenRides: 0, awaitingMechanic: 0 },
  staff: {
    cleaners: { total: 16, busy: 16, salaryPerInterval: 12, trainingLevel: 0, trainingCost: 240 },
    mechanics: { total: 1, busy: 0, salaryPerInterval: 18, trainingLevel: 0, trainingCost: 360 },
    payrollIntervalSeconds: 30, capacityPerRole: 16, maximumTrainingLevel: 3,
  },
  litter: [
    { cell: { x: 1, y: 1 }, units: 3, assignedCleanerId: null, sick: true },
    { cell: { x: 2, y: 1 }, units: 5, assignedCleanerId: 2, sick: false },
  ],
};

const load = (patch: Partial<CleanerLoad> = {}): CleanerLoad => ({
  seconds: 60, wastePerMinute: 424, binShare: 0, droppedPerMinute: 424, clearedPerMinute: 423, busyShare: 0.99, cleaners: 16,
  swamped: true, ...patch,
});

describe('Phase 49: Staff window', () => {
  it('says bins, not more cleaners, when the crew is swamped', () => {
    expect(staffOverview(operations as never, load()).hints).toEqual([
      'Litter outpaces your cleaners (busy 99% of the last minute): bins near the stalls would help, they catch 0% of the waste now.',
    ]);
    expect(staffOverview(operations as never, load({ binShare: null })).hints[0]).toMatch(/would help\.$/);
    expect(staffOverview(operations as never, load({ swamped: false })).hints, 'not swamped: the Phase 42 hint')
      .toEqual(['The paths are getting dirty at the crew cap: train the cleaners or add bins.']);
    expect(staffOverview(operations as never).hints, 'no load yet: as before').toEqual(['The paths are getting dirty at the crew cap: train the cleaners or add bins.']);
  });

  it('counts sick piles for the litter figure', () => {
    expect(staffOverview(operations as never).sickPiles).toBe(1);
    expect(staffOverview({ ...operations, litter: undefined } as never).sickPiles).toBe(0);
  });

  it('reads the last minute: waste, bins, paths, swept, and whether the crew keeps up', () => {
    expect(cleanerCapacityRead(null)).toBeNull();
    expect(cleanerCapacityRead(load({ seconds: 4 }))).toBeNull();
    expect(cleanerCapacityRead(load())).toEqual({
      line: '424 waste a minute · 0% into bins · 424 onto the paths · 423 swept up',
      status: 'Falling behind: crew busy 99%',
      behind: true,
    });
    expect(cleanerCapacityRead(load({ swamped: false, busyShare: 0.58, binShare: 0.99, droppedPerMinute: 2, clearedPerMinute: 2 }))).toEqual({
      line: '424 waste a minute · 99% into bins · 2 onto the paths · 2 swept up',
      status: 'Keeping up: crew busy 58%',
      behind: false,
    });
    expect(cleanerCapacityRead(load({ cleaners: 0, busyShare: null, swamped: false, clearedPerMinute: 0 }))).toMatchObject({
      status: 'No cleaners: litter stays where it lands', behind: true,
    });
    expect(cleanerCapacityRead(load({ wastePerMinute: 0, binShare: null, droppedPerMinute: 0, clearedPerMinute: 0, swamped: false, busyShare: 0 })))
      .toEqual({ line: '0 waste a minute · 0 onto the paths · 0 swept up', status: 'Keeping up: crew busy 0%', behind: false });
  });
});
