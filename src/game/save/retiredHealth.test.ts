import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { MANAGEMENT_CONFIG } from '../management/ManagementSimulation';
import { ParkSession } from '../session/ParkSession';
import { withRetiredHealthKey } from './determinismHarness';

/**
 * Phase 11 (PA-023) deleted `ManagementSnapshot.health`, which nothing read. Saved state never held it: these are the
 * `ManagementState` keys recorded in the Phase 11 Wave 0 baseline, and they must not move. The observables pins see
 * the retired key through `withRetiredHealthKey`, which must compute it exactly as the deleted code did.
 */
const WAVE0_MANAGEMENT_STATE_KEYS = [
  'activeNotificationSeverities', 'categoryTotals', 'elapsedSeconds', 'emittedRatingMilestones', 'lastNotificationAt',
  'lastObservedCash', 'lastProcessedTransactionId', 'latestGuestCount', 'latestRating', 'nextNotificationId',
  'pendingNotifications', 'ratingMilestonesInitialized', 'totals', 'trendAccumulatorSeconds', 'trendPoints',
];
const WAVE0_MANAGEMENT_SNAPSHOT_KEYS_WITHOUT_HEALTH = [
  'cash', 'elapsedSeconds', 'finances', 'guestCount', 'notifications', 'operations', 'parkOpen', 'parkOperations',
  'parkScenery', 'rating', 'trends',
];

describe('retired ManagementSnapshot.health (Phase 11, PA-023)', () => {
  it('leaves the saved ManagementState keys as Wave 0 recorded them', () => {
    const session = new ParkSession();
    session.step(GAME_CONFIG.fixedStepMs);
    expect(Object.keys(session.management.serialize()).sort()).toEqual(WAVE0_MANAGEMENT_STATE_KEYS);
  });

  it('drops exactly health from the snapshot', () => {
    const session = new ParkSession();
    session.step(GAME_CONFIG.fixedStepMs);
    expect(Object.keys(session.management.snapshot()).sort()).toEqual(WAVE0_MANAGEMENT_SNAPSHOT_KEYS_WITHOUT_HEALTH);
  });

  it('re-inserts health in the observable exactly as the deleted healthSnapshot computed it', () => {
    const session = new ParkSession();
    const snapshot = session.management.snapshot();
    const start = GAME_CONFIG.startingCash;
    const cases: Array<[number, { cashScore: number; cashStatus: string }]> = [
      [-500, { cashScore: 0, cashStatus: 'negative' }],
      [0, { cashScore: 0, cashStatus: 'low' }],
      [MANAGEMENT_CONFIG.lowCashThreshold, { cashScore: 10, cashStatus: 'low' }],
      [MANAGEMENT_CONFIG.lowCashThreshold + 1, { cashScore: Math.round(((MANAGEMENT_CONFIG.lowCashThreshold + 1) / start * 100 + Number.EPSILON) * 10) / 10, cashStatus: 'watch' }],
      [MANAGEMENT_CONFIG.watchCashThreshold, { cashScore: 25, cashStatus: 'watch' }],
      [start / 3, { cashScore: 33.3, cashStatus: 'healthy' }],
      [start, { cashScore: 100, cashStatus: 'healthy' }],
      [start * 3, { cashScore: 100, cashStatus: 'healthy' }],
    ];
    for (const [cash, health] of cases) {
      const observed = withRetiredHealthKey(snapshot, cash);
      expect(observed.health, `cash ${cash}`).toEqual(health);
      expect({ ...observed, health: undefined }).toEqual({ ...snapshot, health: undefined });
    }
  });
});
