import type { OperationsSnapshot as ParkOperationsSnapshot } from '../operations/types';
import type { ScenerySnapshot } from '../scenery/types';

export type ManagementTransactionCategory =
  | 'construction'
  | 'rideTickets'
  | 'foodSales'
  | 'drinkSales'
  | 'facilityRevenue'
  | 'rideOperations'
  | 'staffSalaries'
  | 'maintenance'
  | 'research'
  | 'grants'
  | 'refunds'
  | 'other'
  /** Phase 21: parcels of land bought. Saved only once a parcel has been bought (see ManagementState). */
  | 'land'
  /** Phase 29: souvenir stall sales. Saved only once a souvenir has been sold, exactly like `land`. */
  | 'souvenirSales';

export interface FinancialTotals {
  revenue: number;
  expenses: number;
  profit: number;
  transactionCount: number;
}

export type FinanceCategoryBreakdown = Record<ManagementTransactionCategory, FinancialTotals>;

export interface FinanceTransactionRow {
  id: number;
  amount: number;
  label: string;
  category: ManagementTransactionCategory;
  tick: number;
}

export interface FinanceSnapshot extends FinancialTotals {
  operating: FinancialTotals;
  categories: FinanceCategoryBreakdown;
  lastTransactionId: number;
  recentTransactions: FinanceTransactionRow[];
}

export type RatingFactorKey =
  | 'guestHappiness'
  | 'rideSatisfaction'
  | 'serviceSatisfaction'
  | 'needFulfilment'
  | 'accessibility'
  | 'contentVariety'
  | 'parkSize'
  | 'value'
  | 'cleanliness'
  | 'reliability'
  | 'scenery';

export interface RatingFactor {
  key: RatingFactorKey;
  label: string;
  score: number;
  weight: number;
  contribution: number;
  detail: string;
}

export interface ParkRatingSnapshot {
  score: number;
  factors: RatingFactor[];
}

export interface ManagementTrendPoint {
  timeSeconds: number;
  cash: number;
  guestCount: number;
  parkRating: number;
  revenue: number;
  expenses: number;
  profit: number;
  operatingProfit: number;
  cleanliness: number;
  reliability: number;
  scenery: number;
}

export interface OperationsSnapshot {
  averageHappiness: number | null;
  averageQueueSeconds: number;
  totalQueued: number;
  rides: {
    open: number;
    total: number;
    queued: number;
    ridersToday: number;
  };
  services: {
    open: number;
    total: number;
    queued: number;
    customersServed: number;
  };
  needs: {
    hungry: number;
    thirsty: number;
    toilet: number;
  };
  /**
   * Phase 30: guest comfort counts from the same one-pass guest scan as `needs`, plus the sick litter piles. Optional:
   * absent while the guest-life switch (`GAME_CONFIG.guestLife.enabled`) is off, so a park that never lived Phase 29
   * observes exactly what it did before (the defaultIdentity observable pins), and older snapshots and tests pass.
   */
  comfort?: OperationsComfort;
}

/** Phase 30: how many guests are uncomfortable right now, and how many litter piles someone was sick on. */
export interface OperationsComfort {
  /** Energy below the bench-seeking threshold (`guestLife.bench.seekEnergy`). */
  tired: number;
  /** Nausea at or above `guestLife.nausea.queasy`. */
  queasy: number;
  /** Warmth at or above `guestLife.warmth.hot`. */
  hot: number;
  /** Warmth at or below `guestLife.warmth.cold`. */
  cold: number;
  /** Out in the rain with no umbrella (`isSoaked`); 0 when the session gave management no conditions. */
  soaked: number;
  /** Sitting on a bench. */
  resting: number;
  /** Litter piles with `sick === true`. */
  sickPiles: number;
}

export type ManagementNotificationKind =
  | 'cashLow'
  | 'cashNegative'
  | 'unmetFood'
  | 'unmetDrink'
  | 'unmetToilet'
  | 'queuesOvercrowded'
  | 'ratingFalling'
  | 'cleanlinessLow'
  | 'binsFull'
  | 'ridesBroken'
  | 'parkStalled'
  | 'researchCompleted'
  | 'researchMilestone'
  | 'ratingMilestone50'
  | 'ratingMilestone70'
  | 'ratingMilestone85';

export type ManagementNotificationSeverity = 'info' | 'warning' | 'critical';

export interface ManagementNotification {
  id: number;
  kind: ManagementNotificationKind;
  severity: ManagementNotificationSeverity;
  title: string;
  message: string;
  createdAtSeconds: number;
}

export interface ManagementSnapshot {
  elapsedSeconds: number;
  parkOpen: boolean;
  cash: number;
  guestCount: number;
  finances: FinanceSnapshot;
  operations: OperationsSnapshot;
  parkOperations: ParkOperationsSnapshot;
  parkScenery: ScenerySnapshot;
  rating: ParkRatingSnapshot;
  trends: ManagementTrendPoint[];
  notifications: ManagementNotification[];
}
