import { COASTER_TYPE_BY_ID } from '../coaster/content';
import { GAME_CONFIG } from '../config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../content/catalog';
import { isSoaked, PRICEY_SOUVENIR_THOUGHT } from '../guests/life';
import type { Guest } from '../guests/types';
import type { OperationsSnapshot as ParkOperationsSnapshot } from '../operations/types';
import { RESEARCH_MILESTONE_BY_ID, RESEARCH_PROJECT_BY_ID } from '../progression/content';
import type { ProgressionEvent } from '../progression/types';
import type { RideSimulation } from '../rides/RideSimulation';
import type { RideRuntime } from '../rides/types';
import { plainNumber } from '../save/plainData';
import type { ManagementState, Serializable } from '../save/state';
import { MAXIMUM_SAVED_AMOUNT, MAXIMUM_SAVED_COUNTER, MAXIMUM_SAVED_SECONDS } from '../save/ranges';
import { invalidState } from '../save/version';
import type { ScenerySnapshot } from '../scenery/types';
import type { ShopSimulation } from '../shops/ShopSimulation';
import type { ServiceRuntime } from '../shops/types';
import type { Cell, PlacedObject, Transaction, TransactionCategory } from '../types';
import type { ParkConditions } from '../weather/types';
import type { GameWorld } from '../World';
import { assessParkStall } from './parkStall';
import type {
  FinanceCategoryBreakdown,
  FinanceSnapshot,
  FinancialTotals,
  ManagementNotification,
  ManagementNotificationKind,
  ManagementNotificationSeverity,
  ManagementSnapshot,
  ManagementTransactionCategory,
  ManagementTrendPoint,
  OperationsComfort,
  OperationsSnapshot,
  ParkRatingSnapshot,
  RatingFactor,
  RatingFactorKey,
} from './types';

const TRANSACTION_CATEGORIES: readonly ManagementTransactionCategory[] = [
  'construction',
  'rideTickets',
  'foodSales',
  'drinkSales',
  'facilityRevenue',
  'rideOperations',
  'staffSalaries',
  'maintenance',
  'research',
  'grants',
  'refunds',
  'other',
  'land',
  'souvenirSales',
];

/** Categories saved only once they hold a transaction (each was added after parks were already being saved). */
const OPTIONAL_CATEGORIES: ReadonlySet<ManagementTransactionCategory> = new Set<ManagementTransactionCategory>(['land', 'souvenirSales']);

const EXPLICIT_TRANSACTION_CATEGORIES: Readonly<Record<TransactionCategory, ManagementTransactionCategory>> = {
  'ride-revenue': 'rideTickets',
  'food-revenue': 'foodSales',
  'drink-revenue': 'drinkSales',
  'facility-revenue': 'facilityRevenue',
  'ride-operations': 'rideOperations',
  'staff-salaries': 'staffSalaries',
  maintenance: 'maintenance',
  research: 'research',
  construction: 'construction',
  // Phase 24: clearing a prop is construction spending (a new management category would change every save's 12 totals).
  'land-clearing': 'construction',
  // Phase 21: its own category, saved only once used (the 12 totals of every other park stay exactly as they were).
  'land-purchase': 'land',
  // Phase 29: its own category, saved only once used (like land), so every older park keeps its totals byte for byte.
  'souvenir-revenue': 'souvenirSales',
  refund: 'refunds',
  grant: 'grants',
  other: 'other',
};

const FACTOR_WEIGHTS: Readonly<Record<RatingFactorKey, number>> = {
  guestHappiness: 0.17,
  rideSatisfaction: 0.09,
  serviceSatisfaction: 0.07,
  needFulfilment: 0.11,
  accessibility: 0.09,
  contentVariety: 0.08,
  parkSize: 0.06,
  value: 0.07,
  cleanliness: 0.09,
  reliability: 0.08,
  scenery: 0.09,
};

export const MANAGEMENT_CONFIG = {
  trendSampleSeconds: 5,
  maximumTrendPoints: 120,
  maximumPendingNotifications: 20,
  notificationCooldownSeconds: 45,
  lowCashThreshold: GAME_CONFIG.startingCash * 0.1,
  watchCashThreshold: GAME_CONFIG.startingCash * 0.25,
  urgentNeedThreshold: 75,
  urgentNeedClearThreshold: 65,
  urgentNeedFraction: 0.25,
  notificationHysteresisRatio: 0.8,
  rideQueueWarningLength: 20,
  rideQueueWarningSeconds: 90,
  serviceQueueWarningLength: 8,
  serviceQueueWarningSeconds: 30,
  fallingRatingWindowSeconds: 15,
  fallingRatingMinimumDrop: 8,
  lowCleanlinessThreshold: 60,
  lowCleanlinessClearThreshold: 70,
  neutralGuestScore: 65,
  neutralSatisfactionScore: 60,
} as const;

const CARDINALS: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const PRICE_COMPLAINTS = new Set([
  "I'm not paying that much.",
  "I can't afford that anymore.",
  // Phase 30: a souvenir bought at a price the guest resented is a price complaint about a stall, like the two above.
  PRICEY_SOUVENIR_THOUGHT,
]);

/** Phase 30: what management needs from the park conditions (the rain for the soaked count); null when not supplied. */
export type ManagementConditions = Pick<ParkConditions, 'weatherKind' | 'weatherIntensity'>;

const RATING_MILESTONES = [
  { threshold: 50, kind: 'ratingMilestone50' },
  { threshold: 70, kind: 'ratingMilestone70' },
  { threshold: 85, kind: 'ratingMilestone85' },
] as const;

/** Everything management needs from the guest population, computed in one pass per step. */
interface GuestAggregates {
  count: number;
  happinessTotal: number;
  queuedCount: number;
  queuedWaitTotal: number;
  hungryDecision: number;
  thirstyDecision: number;
  toiletDecision: number;
  needPressureTotal: number;
  urgentNeedCount: number;
  priceComplaints: number;
  needAtUrgent: { hunger: number; thirst: number; toiletNeed: number };
  needAtClear: { hunger: number; thirst: number; toiletNeed: number };
  /** Phase 30: the guest part of `OperationsComfort` (sick piles come from the operations snapshot). */
  comfort: Omit<OperationsComfort, 'sickPiles'>;
}

/** Phase 30: the rain management saw last; without conditions nobody counts as soaked (`isSoaked` needs the weather). */
const DRY: ManagementConditions = { weatherKind: 'sunny', weatherIntensity: 0 };

/** Phase 30: the sick litter piles, counted without building a filtered array on the management tick. */
const countSickPiles = (parkOperations: ParkOperationsSnapshot): number => {
  let count = 0;
  for (const pile of parkOperations.litter) if (pile.sick) count += 1;
  return count;
};

const collectGuestAggregates = (
  guests: ReadonlyMap<number, Guest>,
  conditions: ManagementConditions = DRY,
): GuestAggregates => {
  const life = GAME_CONFIG.guestLife;
  const aggregates: GuestAggregates = {
    count: 0,
    happinessTotal: 0,
    queuedCount: 0,
    queuedWaitTotal: 0,
    hungryDecision: 0,
    thirstyDecision: 0,
    toiletDecision: 0,
    needPressureTotal: 0,
    urgentNeedCount: 0,
    priceComplaints: 0,
    needAtUrgent: { hunger: 0, thirst: 0, toiletNeed: 0 },
    needAtClear: { hunger: 0, thirst: 0, toiletNeed: 0 },
    comfort: { tired: 0, queasy: 0, hot: 0, cold: 0, soaked: 0, resting: 0 },
  };
  for (const guest of guests.values()) {
    aggregates.count += 1;
    aggregates.happinessTotal += guest.happiness;
    if (guest.state === 'queueing' || guest.state === 'queueingForShop') {
      aggregates.queuedCount += 1;
      aggregates.queuedWaitTotal += guest.stateTimerSeconds;
    }
    if (guest.hunger >= GAME_CONFIG.services.foodDecisionThreshold) aggregates.hungryDecision += 1;
    if (guest.thirst >= GAME_CONFIG.services.drinkDecisionThreshold) aggregates.thirstyDecision += 1;
    if (guest.toiletNeed >= GAME_CONFIG.services.toiletDecisionThreshold) aggregates.toiletDecision += 1;
    const maximumNeed = Math.max(guest.hunger, guest.thirst, guest.toiletNeed);
    const averageNeed = (guest.hunger + guest.thirst + guest.toiletNeed) / 3;
    aggregates.needPressureTotal += maximumNeed * 0.65 + averageNeed * 0.35;
    if (maximumNeed >= MANAGEMENT_CONFIG.urgentNeedThreshold) aggregates.urgentNeedCount += 1;
    if (PRICE_COMPLAINTS.has(guest.currentThought)) aggregates.priceComplaints += 1;
    for (const need of ['hunger', 'thirst', 'toiletNeed'] as const) {
      if (guest[need] >= MANAGEMENT_CONFIG.urgentNeedThreshold) aggregates.needAtUrgent[need] += 1;
      if (guest[need] >= MANAGEMENT_CONFIG.urgentNeedClearThreshold) aggregates.needAtClear[need] += 1;
    }
    // Phase 30: the comfort thresholds are the guest simulation's own (bench seeking, queasy, hot, cold, soaked).
    if (guest.energy < life.bench.seekEnergy) aggregates.comfort.tired += 1;
    if (guest.nausea >= life.nausea.queasy) aggregates.comfort.queasy += 1;
    if (guest.warmth >= life.warmth.hot) aggregates.comfort.hot += 1;
    if (guest.warmth <= life.warmth.cold) aggregates.comfort.cold += 1;
    if (isSoaked(guest, conditions)) aggregates.comfort.soaked += 1;
    if (guest.state === 'resting') aggregates.comfort.resting += 1;
  }
  return aggregates;
};

const clamp = (value: number, minimum = 0, maximum = 100): number =>
  Math.min(maximum, Math.max(minimum, value));

const round = (value: number, decimals = 1): number => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const money = (value: number): number => round(value, 2);
const cellKey = ({ x, y }: Cell): string => `${x},${y}`;

const emptyTotals = (): FinancialTotals => ({
  revenue: 0,
  expenses: 0,
  profit: 0,
  transactionCount: 0,
});

const emptyBreakdown = (): FinanceCategoryBreakdown => {
  const breakdown = {} as FinanceCategoryBreakdown;
  for (const category of TRANSACTION_CATEGORIES) breakdown[category] = emptyTotals();
  return breakdown;
};

type CategorisableTransaction = Pick<Transaction, 'amount' | 'label'> & {
  category?: TransactionCategory;
};

/** Uses the explicit world category when present and legacy labels only as a fallback. */
export const classifyTransaction = (transaction: CategorisableTransaction): ManagementTransactionCategory => {
  if (transaction.category && transaction.category !== 'other') {
    return EXPLICIT_TRANSACTION_CATEGORIES[transaction.category];
  }

  const label = transaction.label.trim().toLowerCase();
  if (/^built\b|construction|path tile/.test(label)) return 'construction';
  if (/\btickets?\b|ride revenue/.test(label)) return 'rideTickets';
  if (/food|snack|picnic/.test(label) && /sales?|revenue/.test(label)) return 'foodSales';
  if (/drink|fizz|beverage/.test(label) && /sales?|revenue/.test(label)) return 'drinkSales';
  if (/toilet|facility|comfort cabin/.test(label) && /sales?|revenue/.test(label)) return 'facilityRevenue';
  if (/\bsales?\b/.test(label)) return 'other';
  if (/cycle operation|ride operation|operating cost/.test(label)) return 'rideOperations';
  if (/recover|refund|returned materials/.test(label)) return 'refunds';
  if (/grant|funding|cash injection/.test(label)) return 'grants';
  return 'other';
};

const severityRank = (severity: ManagementNotificationSeverity): number =>
  severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0;

const emptyParkOperations = (): ParkOperationsSnapshot => ({
  elapsedSeconds: 0,
  cleanliness: {
    score: 100,
    litterUnits: 0,
    dirtyPathTiles: 0,
    binsTotal: 0,
    binsFull: 0,
    averageBinFillPercent: 0,
  },
  maintenance: {
    averageRideCondition: null,
    wornRides: 0,
    brokenRides: 0,
    awaitingMechanic: 0,
  },
  staff: {
    cleaners: {
      total: 0,
      busy: 0,
      salaryPerInterval: GAME_CONFIG.operations.cleaner.salaryPerInterval,
      trainingLevel: 0,
      trainingCost: GAME_CONFIG.operations.staff.training.cleanerCost,
    },
    mechanics: {
      total: 0,
      busy: 0,
      salaryPerInterval: GAME_CONFIG.operations.mechanic.salaryPerInterval,
      trainingLevel: 0,
      trainingCost: GAME_CONFIG.operations.staff.training.mechanicCost,
    },
    payrollIntervalSeconds: GAME_CONFIG.operations.payrollIntervalSeconds,
    capacityPerRole: GAME_CONFIG.operations.staff.baseCapacityPerRole,
    maximumTrainingLevel: GAME_CONFIG.operations.staff.training.maximumLevel,
  },
  litter: [],
  bins: [],
  workers: [],
});

const emptyOperations = (): OperationsSnapshot => ({
  averageHappiness: null,
  averageQueueSeconds: 0,
  totalQueued: 0,
  rides: { open: 0, total: 0, queued: 0, ridersToday: 0 },
  services: { open: 0, total: 0, queued: 0, customersServed: 0 },
  needs: { hungry: 0, thirsty: 0, toilet: 0 },
});

const OWNER = 'ManagementSimulation';

const NOTIFICATION_KINDS: readonly ManagementNotificationKind[] = [
  'cashLow', 'cashNegative', 'unmetFood', 'unmetDrink', 'unmetToilet', 'queuesOvercrowded',
  'ratingFalling', 'cleanlinessLow', 'binsFull', 'ridesBroken', 'parkStalled', 'researchCompleted',
  'researchMilestone', 'ratingMilestone50', 'ratingMilestone70', 'ratingMilestone85',
];

const NOTIFICATION_SEVERITIES: readonly ManagementNotificationSeverity[] = ['info', 'warning', 'critical'];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const copyTotals = (totals: FinancialTotals, path: string): FinancialTotals => ({
  revenue: plainNumber(totals.revenue, `${path}.revenue`),
  expenses: plainNumber(totals.expenses, `${path}.expenses`),
  profit: plainNumber(totals.profit, `${path}.profit`),
  transactionCount: plainNumber(totals.transactionCount, `${path}.transactionCount`),
});

/**
 * Phase 16: the scenery factor's display detail, saying what the score really is: the average scenery appeal around
 * the reachable rides and services; only a park without one falls back to its decorated paths. Derived from the live
 * scenery snapshot and never saved. (The factor's own `detail` string is saved in `latestRating` and therefore stays
 * the legacy text, so no state hash moves; the UI renders this instead.)
 */
export const sceneryFactorDetail = (scenery: ScenerySnapshot): string => {
  const pieces = `${scenery.sourceCount} scenery ${scenery.sourceCount === 1 ? 'piece' : 'pieces'}`;
  const count = scenery.destinations.length;
  return count > 0
    ? `Average scenery appeal around your ${count} ${count === 1 ? 'ride or service' : 'rides and services'}; ${pieces}.`
    : `No rides or services yet: scored on decorated paths (${scenery.decoratedPathTiles} of ${scenery.connectedPathTiles}).`;
};

const emptyScenery = (): ScenerySnapshot => ({
  version: 0,
  sourceCount: 0,
  influencedCells: 0,
  connectedPathTiles: 0,
  decoratedPathTiles: 0,
  coveragePercent: 0,
  averagePathScore: 0,
  averageDestinationScore: 0,
  parkScore: 0,
  themeAffinity: 0,
  cells: [],
  sources: [],
  destinations: [],
});

/**
 * Save/restore (Phase 12): the RAW private accumulators are saved (never the rounded snapshot).
 * `latestOperations`, `latestParkOperations` and `latestScenery` are not saved: step() re-supplies
 * them, so snapshot() between restore() and the next step shows empty sections. The connectivity
 * cache is DERIVED and invalidated on restore. serialize() never calls snapshot() or
 * collectTransactions(), because both mutate the transaction cursor and cash baseline.
 */
export class ManagementSimulation implements Serializable<ManagementState> {
  private elapsedSeconds = 0;
  private trendAccumulatorSeconds = 0;
  private lastObservedCash: number = GAME_CONFIG.startingCash;
  private connectivityWorldVersion = -1;
  private connectivityPathVersion = -1;
  private readonly connectedObjectIds = new Set<number>();
  private entranceConnectedPathCount = 0;
  private entranceConnectedTip: Cell | null = null;
  private lastProcessedTransactionId = 0;
  private latestGuestCount = 0;
  private readonly categoryTotals = emptyBreakdown();
  private readonly totals = emptyTotals();
  private latestOperations: OperationsSnapshot = emptyOperations();
  private latestParkOperations: ParkOperationsSnapshot = emptyParkOperations();
  private latestScenery: ScenerySnapshot = emptyScenery();
  private latestRating: ParkRatingSnapshot;
  private readonly trendPoints: ManagementTrendPoint[] = [];
  private pendingNotifications: ManagementNotification[] = [];
  private nextNotificationId = 1;
  private readonly lastNotificationAt = new Map<ManagementNotificationKind, number>();
  private readonly activeNotificationSeverities = new Map<ManagementNotificationKind, ManagementNotificationSeverity>();
  private ratingMilestonesInitialized = false;
  private readonly emittedRatingMilestones = new Set<number>();

  constructor(private readonly world: GameWorld) {
    this.collectTransactions();
    this.latestRating = this.computeRating(collectGuestAggregates(new Map()), [], []);
  }

  step(
    stepMs: number,
    guests: ReadonlyMap<number, Guest>,
    rides: RideSimulation,
    shops: ShopSimulation,
    parkOperations: ParkOperationsSnapshot = emptyParkOperations(),
    scenery: ScenerySnapshot = emptyScenery(),
    /** Phase 30: the park conditions of this tick, for the soaked count; null counts nobody as soaked. */
    conditions: ManagementConditions | null = null,
  ): void {
    const deltaSeconds = Number.isFinite(stepMs) ? Math.max(0, stepMs) / 1_000 : 0;
    this.elapsedSeconds += deltaSeconds;
    this.collectTransactions();

    const aggregates = collectGuestAggregates(guests, conditions ?? DRY);
    this.latestGuestCount = aggregates.count;
    const rideList = [...rides.rides.values()];
    const serviceList = [...shops.services.values()];
    this.latestParkOperations = parkOperations;
    this.latestScenery = scenery;
    this.latestOperations = this.computeOperations(aggregates, rideList, serviceList, rides, parkOperations);
    const previousRating = this.latestRating.score;
    this.latestRating = this.computeRating(aggregates, rideList, serviceList, parkOperations, scenery);
    if (this.ratingMilestonesInitialized) this.evaluateRatingMilestones(previousRating, this.latestRating.score);
    else {
      this.ratingMilestonesInitialized = true;
      for (const milestone of RATING_MILESTONES) {
        if (this.latestRating.score >= milestone.threshold) this.emittedRatingMilestones.add(milestone.threshold);
      }
    }
    this.recordTrend(deltaSeconds);
    this.evaluateNotifications(aggregates, rides, shops);
  }

  snapshot(): ManagementSnapshot {
    this.collectTransactions();
    return {
      elapsedSeconds: round(this.elapsedSeconds, 3),
      parkOpen: this.world.parkOpen,
      cash: money(this.world.cash),
      guestCount: this.latestGuestCount,
      finances: this.financeSnapshot(),
      operations: {
        ...this.latestOperations,
        rides: { ...this.latestOperations.rides },
        services: { ...this.latestOperations.services },
        needs: { ...this.latestOperations.needs },
        ...(this.latestOperations.comfort ? { comfort: { ...this.latestOperations.comfort } } : {}),
      },
      parkOperations: {
        ...this.latestParkOperations,
        cleanliness: { ...this.latestParkOperations.cleanliness },
        maintenance: { ...this.latestParkOperations.maintenance },
        staff: {
          ...this.latestParkOperations.staff,
          cleaners: { ...this.latestParkOperations.staff.cleaners },
          mechanics: { ...this.latestParkOperations.staff.mechanics },
        },
        litter: this.latestParkOperations.litter.map((pile) => ({ ...pile, cell: { ...pile.cell } })),
        bins: this.latestParkOperations.bins.map((bin) => ({ ...bin })),
        workers: this.latestParkOperations.workers.map((worker) => ({
          ...worker,
          position: { ...worker.position },
          currentCell: { ...worker.currentCell },
          task: worker.task ? { ...worker.task, targetCell: { ...worker.task.targetCell } } : null,
        })),
      },
      parkScenery: {
        ...this.latestScenery,
        cells: this.latestScenery.cells.map((entry) => ({ ...entry, cell: { ...entry.cell } })),
        sources: this.latestScenery.sources.map((source) => ({ ...source })),
        destinations: this.latestScenery.destinations.map((destination) => ({ ...destination })),
      },
      rating: {
        score: this.latestRating.score,
        factors: this.latestRating.factors.map((factor) => ({ ...factor })),
      },
      trends: this.trendPoints.map((point) => ({ ...point })),
      notifications: this.pendingNotifications.map((notification) => ({ ...notification })),
    };
  }

  consumeNotifications(): ManagementNotification[] {
    const notifications = this.pendingNotifications.map((notification) => ({ ...notification }));
    this.pendingNotifications = [];
    return notifications;
  }

  ingestProgressionEvents(events: readonly ProgressionEvent[]): void {
    for (const event of events) {
      if (event.kind === 'researchCompleted') {
        const project = RESEARCH_PROJECT_BY_ID.get(event.projectId);
        const unlockNames = event.unlockedDefinitionIds
          .map((definitionId) => BUILD_BY_ID.get(definitionId)?.name ?? definitionId)
          .join(', ');
        this.pushNotification(
          'researchCompleted',
          'info',
          `${project?.name ?? 'Research'} completed`,
          `${unlockNames || 'New content'} is now available to build.`,
        );
      } else {
        const milestone = RESEARCH_MILESTONE_BY_ID.get(event.milestoneId);
        this.pushNotification(
          'researchMilestone',
          'info',
          milestone?.name ?? 'Research milestone reached',
          `Park evidence awarded ${event.rewardResearchPoints} research points.`,
        );
      }
    }
  }

  private collectTransactions(): void {
    const unseen = this.world.transactions
      .filter((transaction) => transaction.id > this.lastProcessedTransactionId)
      .sort((left, right) => left.id - right.id);
    let visibleCashChange = 0;
    for (const transaction of unseen) {
      this.recordCashFlow(transaction.amount, classifyTransaction(transaction), true);
      visibleCashChange += transaction.amount;
      this.lastProcessedTransactionId = Math.max(this.lastProcessedTransactionId, transaction.id);
    }

    // Reconcile direct cash changes or a burst larger than the world's bounded history.
    // The total remains exact even when the lost category cannot be reconstructed.
    const actualCashChange = this.world.cash - this.lastObservedCash;
    const unclassifiedCashChange = actualCashChange - visibleCashChange;
    if (Math.abs(unclassifiedCashChange) > 0.000_001) {
      this.recordCashFlow(unclassifiedCashChange, 'other', false);
    }
    this.lastObservedCash = this.world.cash;
  }

  private recordCashFlow(
    amount: number,
    category: ManagementTransactionCategory,
    countsAsTransaction: boolean,
  ): void {
    if (!Number.isFinite(amount)) return;
    const categoryTotals = this.categoryTotals[category];
    if (amount >= 0) {
      categoryTotals.revenue += amount;
      this.totals.revenue += amount;
    } else {
      categoryTotals.expenses -= amount;
      this.totals.expenses -= amount;
    }
    categoryTotals.profit += amount;
    this.totals.profit += amount;
    if (countsAsTransaction) {
      categoryTotals.transactionCount += 1;
      this.totals.transactionCount += 1;
    }
  }

  private financeSnapshot(): FinanceSnapshot {
    const categories = {} as FinanceCategoryBreakdown;
    for (const category of TRANSACTION_CATEGORIES) categories[category] = this.cloneTotals(this.categoryTotals[category]);
    const operatingCategories: readonly ManagementTransactionCategory[] = [
      'rideTickets', 'foodSales', 'drinkSales', 'facilityRevenue', 'souvenirSales', 'rideOperations', 'staffSalaries', 'maintenance',
    ];
    const operating = emptyTotals();
    for (const category of operatingCategories) {
      const totals = this.categoryTotals[category];
      operating.revenue += totals.revenue;
      operating.expenses += totals.expenses;
      operating.profit += totals.profit;
      operating.transactionCount += totals.transactionCount;
    }
    return {
      ...this.cloneTotals(this.totals),
      operating: this.cloneTotals(operating),
      categories,
      lastTransactionId: this.lastProcessedTransactionId,
      recentTransactions: this.world.transactions.slice(0, 12).map((transaction) => ({
        id: transaction.id,
        amount: money(transaction.amount),
        label: transaction.label,
        category: classifyTransaction(transaction),
        tick: transaction.tick,
      })),
    };
  }

  private cloneTotals(totals: FinancialTotals): FinancialTotals {
    return {
      revenue: money(totals.revenue),
      expenses: money(totals.expenses),
      profit: money(totals.profit),
      transactionCount: totals.transactionCount,
    };
  }

  private computeOperations(
    guests: GuestAggregates,
    rides: readonly RideRuntime[],
    services: readonly ServiceRuntime[],
    rideSimulation: RideSimulation,
    parkOperations: ParkOperationsSnapshot,
  ): OperationsSnapshot {
    const rideQueued = rides.reduce((total, ride) => total + ride.queueGuestIds.length, 0);
    const serviceQueued = services.reduce((total, service) => total + service.queueGuestIds.length, 0);
    return {
      averageHappiness: guests.count > 0
        ? round(guests.happinessTotal / guests.count)
        : null,
      averageQueueSeconds: guests.queuedCount > 0
        ? round(guests.queuedWaitTotal / guests.queuedCount)
        : 0,
      totalQueued: rideQueued + serviceQueued,
      rides: {
        // A storm closure is temporary and not the player's doing: it is not counted as open, but
        // reliability and reachability deliberately still count the ride, so a storm never dents the rating.
        open: rides.filter((ride) => ride.open && !ride.broken && ride.maintenanceKind === null
          && !rideSimulation.isStormClosed(ride.objectId)).length,
        total: rides.length,
        queued: rideQueued,
        ridersToday: rides.reduce((total, ride) => total + ride.ridersToday, 0),
      },
      services: {
        open: services.filter((service) => service.open).length,
        total: services.length,
        queued: serviceQueued,
        customersServed: services.reduce((total, service) => total + service.customersServed, 0),
      },
      needs: {
        hungry: guests.hungryDecision,
        thirsty: guests.thirstyDecision,
        toilet: guests.toiletDecision,
      },
      // Phase 30: only while guests live Phase 29 (the switch off keeps the snapshot, and the observable pins, as before).
      ...(GAME_CONFIG.guestLife.enabled
        ? { comfort: { ...guests.comfort, sickPiles: countSickPiles(parkOperations) } }
        : {}),
    };
  }

  private computeRating(
    guests: GuestAggregates,
    rides: readonly RideRuntime[],
    services: readonly ServiceRuntime[],
    parkOperations: ParkOperationsSnapshot = this.latestParkOperations,
    scenery: ScenerySnapshot = this.latestScenery,
  ): ParkRatingSnapshot {
    const happiness = guests.count > 0
      ? guests.happinessTotal / guests.count
      : MANAGEMENT_CONFIG.neutralGuestScore;
    const rideSatisfaction = this.weightedSatisfaction(rides);
    const serviceSatisfaction = this.weightedSatisfaction(services);
    const needPressure = guests.count > 0
      ? guests.needPressureTotal / guests.count
      : 100 - MANAGEMENT_CONFIG.neutralGuestScore;
    const accessibility = this.accessibilityScore();
    const variety = this.varietyScore(rides, services);
    const parkSize = this.parkSizeScore(rides, services);
    const value = this.valueScore(guests, rides, services);
    const reliability = this.reliabilityScore(rides);
    const urgentNeeds = guests.urgentNeedCount;

    const factors: RatingFactor[] = [
      this.factor(
        'guestHappiness',
        'Guest happiness',
        happiness,
        guests.count > 0
          ? `Across ${guests.count} guests.`
          : 'No guests yet; using a neutral baseline.',
      ),
      this.factor(
        'rideSatisfaction',
        'Ride satisfaction',
        rideSatisfaction.score,
        rideSatisfaction.count > 0
          ? `${rideSatisfaction.count} completed ride ratings.`
          : 'No completed rides yet; using a neutral baseline.',
      ),
      this.factor(
        'serviceSatisfaction',
        'Service satisfaction',
        serviceSatisfaction.score,
        serviceSatisfaction.count > 0
          ? `${serviceSatisfaction.count} completed service ratings.`
          : 'No completed services yet; using a neutral baseline.',
      ),
      this.factor(
        'needFulfilment',
        'Need fulfilment',
        100 - needPressure,
        guests.count > 0
          ? `${urgentNeeds} of ${guests.count} guests have an urgent need.`
          : 'No guests yet; using a neutral baseline.',
      ),
      this.factor('accessibility', 'Accessibility', accessibility.score, accessibility.detail),
      this.factor('contentVariety', 'Content variety', variety.score, variety.detail),
      this.factor('parkSize', 'Park size', parkSize.score, parkSize.detail),
      this.factor('value', 'Value for money', value.score, value.detail),
      this.factor(
        'cleanliness',
        'Cleanliness',
        parkOperations.cleanliness.score,
        `${parkOperations.cleanliness.litterUnits} litter units and ${parkOperations.cleanliness.binsFull} full bins.`,
      ),
      this.factor('reliability', 'Ride reliability', reliability.score, reliability.detail),
      this.factor(
        'scenery',
        'Scenery appeal',
        scenery.parkScore,
        // The SAVED detail (latestRating is part of the save, so this text is in every state hash): kept verbatim.
        // The dashboard shows `sceneryFactorDetail` instead (Phase 16), which says what the score really is.
        `${scenery.decoratedPathTiles} of ${scenery.connectedPathTiles} connected path tiles decorated; ${scenery.sourceCount} scenery sources.`,
      ),
    ];
    return {
      score: Math.round(clamp(factors.reduce((total, factor) => total + factor.contribution, 0))),
      factors,
    };
  }

  private factor(key: RatingFactorKey, label: string, rawScore: number, detail: string): RatingFactor {
    const score = round(clamp(Number.isFinite(rawScore) ? rawScore : MANAGEMENT_CONFIG.neutralGuestScore));
    const weight = FACTOR_WEIGHTS[key];
    return { key, label, score, weight, contribution: round(score * weight), detail };
  }

  private weightedSatisfaction(runtimes: readonly (RideRuntime | ServiceRuntime)[]): { score: number; count: number } {
    let total = 0;
    let count = 0;
    for (const runtime of runtimes) {
      total += runtime.satisfactionTotal;
      count += runtime.satisfactionCount;
    }
    return {
      score: count > 0 ? total / count : MANAGEMENT_CONFIG.neutralSatisfactionScore,
      count,
    };
  }

  private reliabilityScore(rides: readonly RideRuntime[]): { score: number; detail: string } {
    const activeRides = rides.filter((ride) => ride.open);
    if (activeRides.length === 0) {
      return { score: MANAGEMENT_CONFIG.neutralSatisfactionScore, detail: 'No open rides yet; using a neutral baseline.' };
    }
    const score = activeRides.reduce((total, ride) => total + (ride.broken ? 0 : ride.condition), 0)
      / activeRides.length;
    const broken = activeRides.filter((ride) => ride.broken).length;
    return {
      score,
      detail: `${broken} broken; average condition across ${activeRides.length} open rides.`,
    };
  }

  private accessibilityScore(): { score: number; detail: string } {
    this.refreshConnectivity();
    let total = 0;
    let reachable = 0;
    for (const object of this.world.objects.values()) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition || (definition.kind !== 'ride' && !definition.stats?.serviceType)) continue;
      total += 1;
      if (this.connectedObjectIds.has(object.id)) reachable += 1;
    }
    return total > 0
      ? { score: reachable / total * 100, detail: `${reachable} of ${total} rides and services are entrance-connected.` }
      : { score: 0, detail: 'No rides or services have been built.' };
  }

  /**
   * Entrance connectivity (path flood + per-object access) only changes when the
   * world does, so it is cached per world/path version instead of being recomputed
   * by every rating factor on every tick.
   */
  private refreshConnectivity(): void {
    if (this.connectivityWorldVersion === this.world.version
      && this.connectivityPathVersion === this.world.pathVersion) return;
    this.connectivityWorldVersion = this.world.version;
    this.connectivityPathVersion = this.world.pathVersion;

    const connected = new Set<string>();
    const entranceKey = cellKey(this.world.entrance);
    this.entranceConnectedTip = null;
    if (this.world.paths.has(entranceKey)) {
      const queue: Cell[] = [{ ...this.world.entrance }];
      connected.add(entranceKey);
      for (let index = 0; index < queue.length; index += 1) {
        const cell = queue[index];
        for (const direction of CARDINALS) {
          const neighbor = { x: cell.x + direction.x, y: cell.y + direction.y };
          const key = cellKey(neighbor);
          if (connected.has(key) || !this.world.paths.has(key)) continue;
          connected.add(key);
          queue.push(neighbor);
        }
      }
      // The flood fill visits by distance, so the last tile is a farthest one: where to extend.
      if (queue.length > 1) this.entranceConnectedTip = queue[queue.length - 1];
    }
    this.entranceConnectedPathCount = Math.max(0, connected.size - 1);

    this.connectedObjectIds.clear();
    for (const object of this.world.objects.values()) {
      const footprint = this.world.objectFootprint(object);
      const footprintKeys = new Set(footprint.map(cellKey));
      const hasAccess = footprint.some((cell) => CARDINALS.some((direction) => {
        const neighbor = { x: cell.x + direction.x, y: cell.y + direction.y };
        return !footprintKeys.has(cellKey(neighbor)) && connected.has(cellKey(neighbor));
      }));
      if (hasAccess) this.connectedObjectIds.add(object.id);
    }
  }

  /**
   * Entrance connectivity for read-only consumers (First Day): the connected path tiles (entrance
   * excluded) and the ids of objects whose access side touches them. Only refreshes the derived
   * cache, so it never changes saved state; the set is live and must not be mutated or held.
   */
  connectivity(): { pathTiles: number; objectIds: ReadonlySet<number>; tip: Cell | null } {
    this.refreshConnectivity();
    return { pathTiles: this.entranceConnectedPathCount, objectIds: this.connectedObjectIds, tip: this.entranceConnectedTip };
  }

  /**
   * Whether a path from the gate reaches this object's access side (Phase 11, PA-024): `connectivity().objectIds.has`
   * without the wrapper object, so the per-frame badge pass allocates nothing once the cache is warm. Only refreshes the
   * derived cache, so it never changes saved state. False for an unknown id.
   */
  hasPathAccess(objectId: number): boolean {
    this.refreshConnectivity();
    return this.connectedObjectIds.has(objectId);
  }

  private reachableOpenContent(
    rides: readonly RideRuntime[],
    services: readonly ServiceRuntime[],
  ): PlacedObject[] {
    this.refreshConnectivity();
    const openIds = new Set<number>();
    for (const ride of rides) if (ride.open && !ride.broken && ride.maintenanceKind === null) openIds.add(ride.objectId);
    for (const service of services) if (service.open) openIds.add(service.objectId);
    return [...this.world.objects.values()].filter((object) =>
      openIds.has(object.id) && this.connectedObjectIds.has(object.id),
    );
  }

  private varietyScore(
    rides: readonly RideRuntime[],
    services: readonly ServiceRuntime[],
  ): { score: number; detail: string } {
    const rideTypes = new Set<string>();
    const serviceTypes = new Set<string>();
    for (const object of this.reachableOpenContent(rides, services)) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition) continue;
      if (definition.kind === 'ride') rideTypes.add(definition.id);
      if (definition.stats?.serviceType) serviceTypes.add(definition.stats.serviceType);
    }
    const score = Math.min(5, rideTypes.size) / 5 * 55
      + Math.min(3, serviceTypes.size) / 3 * 45;
    return {
      score,
      detail: `${rideTypes.size} ride types and ${serviceTypes.size} service types.`,
    };
  }

  private parkSizeScore(
    rides: readonly RideRuntime[],
    services: readonly ServiceRuntime[],
  ): { score: number; detail: string } {
    const guestContent = this.reachableOpenContent(rides, services).length;
    const pathCount = this.entranceConnectedPathCount;
    const score = Math.min(75, guestContent / 6 * 75) + Math.min(25, pathCount / 40 * 25);
    return {
      score,
      detail: `${guestContent} reachable open guest destinations connected by ${pathCount} path tiles.`,
    };
  }

  private valueScore(
    guests: GuestAggregates,
    rides: readonly RideRuntime[],
    services: readonly ServiceRuntime[],
  ): { score: number; detail: string } {
    const priceScores: number[] = [];
    for (const ride of rides) {
      const baseline = this.world.rideProfile(ride.objectId)?.ticketPrice;
      if (baseline && baseline > 0) priceScores.push(clamp(85 - (ride.ticketPrice / baseline - 1) * 35));
    }
    for (const service of services) {
      const baseline = BUILD_BY_ID.get(service.definitionId)?.stats?.itemPrice;
      if (baseline && baseline > 0) priceScores.push(clamp(85 - (service.itemPrice / baseline - 1) * 35));
    }
    const complaints = guests.priceComplaints;
    const baseScore = priceScores.length > 0
      ? priceScores.reduce((total, score) => total + score, 0) / priceScores.length
      : MANAGEMENT_CONFIG.neutralGuestScore;
    const complaintPenalty = guests.count > 0 ? complaints / guests.count * 50 : 0;
    return {
      score: baseScore - complaintPenalty,
      detail: priceScores.length > 0
        ? `${priceScores.length} prices assessed; ${complaints} current guest price complaints.`
        : 'No attraction or service prices to assess.',
    };
  }

  private recordTrend(deltaSeconds: number): void {
    this.trendAccumulatorSeconds += deltaSeconds;
    if (this.trendPoints.length > 0 && this.trendAccumulatorSeconds < MANAGEMENT_CONFIG.trendSampleSeconds) return;
    this.trendAccumulatorSeconds = this.trendPoints.length === 0
      ? 0
      : this.trendAccumulatorSeconds % MANAGEMENT_CONFIG.trendSampleSeconds;
    const finances = this.financeSnapshot();
    this.trendPoints.push({
      timeSeconds: round(this.elapsedSeconds, 3),
      cash: money(this.world.cash),
      guestCount: this.latestGuestCount,
      parkRating: this.latestRating.score,
      revenue: finances.revenue,
      expenses: finances.expenses,
      profit: finances.profit,
      operatingProfit: finances.operating.profit,
      cleanliness: this.latestParkOperations.cleanliness.score,
      reliability: this.latestRating.factors.find((factor) => factor.key === 'reliability')?.score
        ?? MANAGEMENT_CONFIG.neutralSatisfactionScore,
      scenery: this.latestScenery.parkScore,
    });
    if (this.trendPoints.length > MANAGEMENT_CONFIG.maximumTrendPoints) {
      this.trendPoints.splice(0, this.trendPoints.length - MANAGEMENT_CONFIG.maximumTrendPoints);
    }
  }

  private evaluateNotifications(
    guests: GuestAggregates,
    rides: RideSimulation,
    shops: ShopSimulation,
  ): void {
    const cash = this.world.cash;
    const cashLowWasActive = this.activeNotificationSeverities.has('cashLow');
    const cashLowThreshold = MANAGEMENT_CONFIG.lowCashThreshold
      * (cashLowWasActive ? 1 / MANAGEMENT_CONFIG.notificationHysteresisRatio : 1);
    this.evaluateCondition(
      'cashNegative',
      cash < 0,
      'critical',
      'Park funds are negative',
      `Available cash is $${money(cash)}. Pause expansion and restore operating profit.`,
    );
    this.evaluateCondition(
      'cashLow',
      cash >= 0 && cash <= cashLowThreshold,
      'warning',
      'Cash reserve is running low',
      `Only $${money(cash)} remains available.`,
    );

    this.evaluateParkStall(guests);

    this.evaluateNeedNotification('hunger', 'unmetFood', guests);
    this.evaluateNeedNotification('thirst', 'unmetDrink', guests);
    this.evaluateNeedNotification('toiletNeed', 'unmetToilet', guests);

    const cleanlinessWasActive = this.activeNotificationSeverities.has('cleanlinessLow');
    const cleanlinessThreshold = cleanlinessWasActive
      ? MANAGEMENT_CONFIG.lowCleanlinessClearThreshold
      : MANAGEMENT_CONFIG.lowCleanlinessThreshold;
    this.evaluateCondition(
      'cleanlinessLow',
      this.latestParkOperations.cleanliness.score <= cleanlinessThreshold,
      this.latestParkOperations.cleanliness.score <= 35 ? 'critical' : 'warning',
      'The park needs cleaning',
      `Cleanliness is ${Math.round(this.latestParkOperations.cleanliness.score)}/100 with ${this.latestParkOperations.cleanliness.litterUnits} litter units.`,
    );
    this.evaluateCondition(
      'binsFull',
      this.latestParkOperations.cleanliness.binsFull > 0,
      this.latestParkOperations.cleanliness.binsFull >= 3 ? 'critical' : 'warning',
      'Bins need emptying',
      `${this.latestParkOperations.cleanliness.binsFull} bin${this.latestParkOperations.cleanliness.binsFull === 1 ? ' is' : 's are'} full. Hire or redirect cleaners.`,
    );
    this.evaluateCondition(
      'ridesBroken',
      this.latestParkOperations.maintenance.brokenRides > 0,
      this.latestParkOperations.maintenance.brokenRides >= 2 ? 'critical' : 'warning',
      'A ride has broken down',
      `${this.latestParkOperations.maintenance.brokenRides} ride${this.latestParkOperations.maintenance.brokenRides === 1 ? ' is' : 's are'} closed and awaiting repairs.`,
    );

    let worstQueueLength = 0;
    let worstWaitSeconds = 0;
    for (const ride of rides.rides.values()) {
      worstQueueLength = Math.max(worstQueueLength, ride.queueGuestIds.length);
      worstWaitSeconds = Math.max(worstWaitSeconds, rides.estimatedWaitSeconds(ride.objectId));
    }
    for (const service of shops.services.values()) {
      worstQueueLength = Math.max(worstQueueLength, service.queueGuestIds.length);
      worstWaitSeconds = Math.max(worstWaitSeconds, shops.estimatedWaitSeconds(service.objectId));
    }
    const queueWasActive = this.activeNotificationSeverities.has('queuesOvercrowded');
    const queueThresholdRatio = queueWasActive ? MANAGEMENT_CONFIG.notificationHysteresisRatio : 1;
    const rideOvercrowded = [...rides.rides.values()].some((ride) =>
      ride.queueGuestIds.length >= MANAGEMENT_CONFIG.rideQueueWarningLength * queueThresholdRatio
      || rides.estimatedWaitSeconds(ride.objectId) >= MANAGEMENT_CONFIG.rideQueueWarningSeconds * queueThresholdRatio,
    );
    const serviceOvercrowded = [...shops.services.values()].some((service) =>
      service.queueGuestIds.length >= MANAGEMENT_CONFIG.serviceQueueWarningLength * queueThresholdRatio
      || shops.estimatedWaitSeconds(service.objectId) >= MANAGEMENT_CONFIG.serviceQueueWarningSeconds * queueThresholdRatio,
    );
    this.evaluateCondition(
      'queuesOvercrowded',
      rideOvercrowded || serviceOvercrowded,
      worstQueueLength >= 40 || worstWaitSeconds >= 180 ? 'critical' : 'warning',
      'Queues are overcrowded',
      `The busiest queue has ${worstQueueLength} guests and a wait near ${Math.round(worstWaitSeconds)} seconds.`,
    );

    const reference = this.fallingRatingReference();
    const ratingDrop = reference ? reference.parkRating - this.latestRating.score : 0;
    const fallingWasActive = this.activeNotificationSeverities.has('ratingFalling');
    const fallingThreshold = MANAGEMENT_CONFIG.fallingRatingMinimumDrop
      * (fallingWasActive ? MANAGEMENT_CONFIG.notificationHysteresisRatio : 1);
    this.evaluateCondition(
      'ratingFalling',
      ratingDrop >= fallingThreshold,
      ratingDrop >= 20 ? 'critical' : 'warning',
      'Park rating is falling',
      `Rating fell ${Math.round(ratingDrop)} points in about ${MANAGEMENT_CONFIG.fallingRatingWindowSeconds} seconds.`,
    );
  }

  /**
   * PA-028: the park has stopped being able to earn and cannot buy its way back. Uses
   * `evaluateCondition`, so it is announced once and only re-arms after income becomes possible
   * again — a critical alarm that repeated every 45 seconds would just be noise.
   */
  private evaluateParkStall(guests: GuestAggregates): void {
    this.refreshConnectivity();
    let reachableRides = 0;
    let unreachableRides = 0;
    let reachableServices = 0;
    let demolitionValue = 0;
    for (const object of this.world.objects.values()) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition) continue;
      const coaster = this.world.coasters.get(object.id);
      demolitionValue += Math.floor(
        (coaster ? coaster.paidCost : this.world.objectCost(definition)) * GAME_CONFIG.bulldozeRefundRate,
      );
      const reachable = this.connectedObjectIds.has(object.id);
      if (definition.kind === 'ride') {
        // A broken ride under repair still counts: repairs need no cash from the player.
        if (reachable) reachableRides += 1;
        else unreachableRides += 1;
      } else if (definition.stats?.serviceType && reachable) {
        reachableServices += 1;
      }
    }
    demolitionValue += Math.floor(
      Math.max(0, this.world.paths.size - 1) * this.world.pathCost * GAME_CONFIG.bulldozeRefundRate,
    );

    const staff = this.latestParkOperations.staff;
    const assessment = assessParkStall({
      cash: this.world.cash,
      pathCost: this.world.pathCost,
      cheapestRideCost: this.cheapestBuildableRideCost(),
      guestCount: guests.count,
      reachableRides,
      unreachableRides,
      reachableServices,
      dismissableStaff: staff.cleaners.total + staff.mechanics.total,
      staffWageBill: staff.cleaners.total * staff.cleaners.salaryPerInterval
        + staff.mechanics.total * staff.mechanics.salaryPerInterval,
      demolitionValue,
    });
    this.evaluateCondition(
      'parkStalled',
      assessment.stalled,
      'critical',
      'The park can no longer earn',
      assessment.message,
    );
  }

  /**
   * The cheapest route back to a working ride, research locks included. A coaster's catalog price
   * is only its station, so the real floor is the station plus the minimum legal run of track —
   * quoting the station alone would tell a stuck player they can afford something they cannot.
   */
  private cheapestBuildableRideCost(): number {
    let cheapest = Number.POSITIVE_INFINITY;
    for (const definition of BUILD_CATALOG) {
      if (definition.kind !== 'ride' || !this.world.isDefinitionUnlocked(definition.id)) continue;
      const type = COASTER_TYPE_BY_ID.get(definition.id);
      const base = type
        ? type.stationCost + GAME_CONFIG.coaster.minimumPieces * type.pieceCost
        : definition.buildCost;
      cheapest = Math.min(cheapest, Math.round(base * this.world.constructionMultiplier));
    }
    return Number.isFinite(cheapest) ? cheapest : Number.POSITIVE_INFINITY;
  }

  private evaluateNeedNotification(
    need: 'hunger' | 'thirst' | 'toiletNeed',
    kind: 'unmetFood' | 'unmetDrink' | 'unmetToilet',
    guests: GuestAggregates,
  ): void {
    const wasActive = this.activeNotificationSeverities.has(kind);
    const urgent = wasActive ? guests.needAtClear[need] : guests.needAtUrgent[need];
    const minimumCount = Math.max(1, Math.ceil(guests.count * MANAGEMENT_CONFIG.urgentNeedFraction));
    const active = guests.count > 0 && urgent >= minimumCount;
    const ratio = guests.count > 0 ? urgent / guests.count : 0;
    const labels = need === 'hunger'
      ? ['Guests need food', 'hungry']
      : need === 'thirst'
        ? ['Guests need drinks', 'thirsty']
        : ['Guests need toilets', 'in need of a toilet'];
    this.evaluateCondition(
      kind,
      active,
      ratio >= 0.6 ? 'critical' : 'warning',
      labels[0],
      `${urgent} of ${guests.count} guests are urgently ${labels[1]}.`,
    );
  }

  private fallingRatingReference(): ManagementTrendPoint | undefined {
    for (let index = this.trendPoints.length - 2; index >= 0; index -= 1) {
      const point = this.trendPoints[index];
      if (this.elapsedSeconds - point.timeSeconds >= MANAGEMENT_CONFIG.fallingRatingWindowSeconds) return point;
    }
    return undefined;
  }

  private evaluateRatingMilestones(previousRating: number, currentRating: number): void {
    for (const milestone of RATING_MILESTONES) {
      if (this.emittedRatingMilestones.has(milestone.threshold)
        || previousRating >= milestone.threshold
        || currentRating < milestone.threshold) continue;
      this.emittedRatingMilestones.add(milestone.threshold);
      this.pushNotification(
        milestone.kind,
        'info',
        `Park rating reached ${milestone.threshold}`,
        `Your park crossed the ${milestone.threshold}-point rating milestone.`,
      );
    }
  }

  private evaluateCondition(
    kind: ManagementNotificationKind,
    active: boolean,
    severity: ManagementNotificationSeverity,
    title: string,
    message: string,
  ): void {
    const previousSeverity = this.activeNotificationSeverities.get(kind);
    if (!active) {
      this.activeNotificationSeverities.delete(kind);
      return;
    }
    this.activeNotificationSeverities.set(kind, severity);
    if (previousSeverity && severityRank(severity) <= severityRank(previousSeverity)) return;
    const lastAt = this.lastNotificationAt.get(kind);
    if (!previousSeverity
      && lastAt !== undefined
      && this.elapsedSeconds - lastAt < MANAGEMENT_CONFIG.notificationCooldownSeconds) return;
    this.lastNotificationAt.set(kind, this.elapsedSeconds);
    this.pushNotification(kind, severity, title, message);
  }

  private pushNotification(
    kind: ManagementNotificationKind,
    severity: ManagementNotificationSeverity,
    title: string,
    message: string,
  ): void {
    this.pendingNotifications.push({
      id: this.nextNotificationId++,
      kind,
      severity,
      title,
      message,
      createdAtSeconds: round(this.elapsedSeconds, 3),
    });
    if (this.pendingNotifications.length > MANAGEMENT_CONFIG.maximumPendingNotifications) {
      this.pendingNotifications.splice(
        0,
        this.pendingNotifications.length - MANAGEMENT_CONFIG.maximumPendingNotifications,
      );
    }
  }

  /** Pure: copies the raw fields; every number goes through plainNumber (round() can yield -0). */
  serialize(): ManagementState {
    const categoryTotals = {} as ManagementState['categoryTotals'];
    for (const category of TRANSACTION_CATEGORIES) {
      if (OPTIONAL_CATEGORIES.has(category) && this.categoryTotals[category].transactionCount === 0) continue;
      categoryTotals[category] = copyTotals(this.categoryTotals[category], `categoryTotals.${category}`);
    }
    return {
      elapsedSeconds: plainNumber(this.elapsedSeconds, 'elapsedSeconds'),
      trendAccumulatorSeconds: plainNumber(this.trendAccumulatorSeconds, 'trendAccumulatorSeconds'),
      lastObservedCash: plainNumber(this.lastObservedCash, 'lastObservedCash'),
      lastProcessedTransactionId: plainNumber(this.lastProcessedTransactionId, 'lastProcessedTransactionId'),
      latestGuestCount: plainNumber(this.latestGuestCount, 'latestGuestCount'),
      categoryTotals,
      totals: copyTotals(this.totals, 'totals'),
      latestRating: {
        score: plainNumber(this.latestRating.score, 'latestRating.score'),
        factors: this.latestRating.factors.map((factor, index) => ({
          key: factor.key,
          label: factor.label,
          score: plainNumber(factor.score, `latestRating.factors[${index}].score`),
          weight: plainNumber(factor.weight, `latestRating.factors[${index}].weight`),
          contribution: plainNumber(factor.contribution, `latestRating.factors[${index}].contribution`),
          detail: factor.detail,
        })),
      },
      trendPoints: this.trendPoints.map((point, index) => ({
        timeSeconds: plainNumber(point.timeSeconds, `trendPoints[${index}].timeSeconds`),
        cash: plainNumber(point.cash, `trendPoints[${index}].cash`),
        guestCount: plainNumber(point.guestCount, `trendPoints[${index}].guestCount`),
        parkRating: plainNumber(point.parkRating, `trendPoints[${index}].parkRating`),
        revenue: plainNumber(point.revenue, `trendPoints[${index}].revenue`),
        expenses: plainNumber(point.expenses, `trendPoints[${index}].expenses`),
        profit: plainNumber(point.profit, `trendPoints[${index}].profit`),
        operatingProfit: plainNumber(point.operatingProfit, `trendPoints[${index}].operatingProfit`),
        cleanliness: plainNumber(point.cleanliness, `trendPoints[${index}].cleanliness`),
        reliability: plainNumber(point.reliability, `trendPoints[${index}].reliability`),
        scenery: plainNumber(point.scenery, `trendPoints[${index}].scenery`),
      })),
      pendingNotifications: this.pendingNotifications.map((notification, index) => ({
        id: plainNumber(notification.id, `pendingNotifications[${index}].id`),
        kind: notification.kind,
        severity: notification.severity,
        title: notification.title,
        message: notification.message,
        createdAtSeconds: plainNumber(notification.createdAtSeconds, `pendingNotifications[${index}].createdAtSeconds`),
      })),
      nextNotificationId: plainNumber(this.nextNotificationId, 'nextNotificationId'),
      lastNotificationAt: [...this.lastNotificationAt].map(([kind, at]) => [kind, plainNumber(at, `lastNotificationAt.${kind}`)]),
      activeNotificationSeverities: [...this.activeNotificationSeverities].map(([kind, severity]) => [kind, severity]),
      ratingMilestonesInitialized: this.ratingMilestonesInitialized,
      emittedRatingMilestones: [...this.emittedRatingMilestones].sort((left, right) => left - right),
    };
  }

  /**
   * Validates first, then resets to constructor defaults and applies. It deliberately never calls
   * collectTransactions, step(0), refreshManagement or evaluateNotifications: those mutate the
   * cash baseline, the hysteresis/cooldown maps and push a trend point.
   */
  restore(state: ManagementState): void {
    const validated = this.validate(state);

    this.elapsedSeconds = 0;
    this.trendAccumulatorSeconds = 0;
    this.lastObservedCash = GAME_CONFIG.startingCash;
    this.lastProcessedTransactionId = 0;
    this.latestGuestCount = 0;
    const emptyCategories = emptyBreakdown();
    for (const category of TRANSACTION_CATEGORIES) {
      Object.assign(this.categoryTotals[category], emptyCategories[category]);
    }
    Object.assign(this.totals, emptyTotals());
    this.latestOperations = emptyOperations();
    this.latestParkOperations = emptyParkOperations();
    this.latestScenery = emptyScenery();
    this.trendPoints.length = 0;
    this.pendingNotifications = [];
    this.nextNotificationId = 1;
    this.lastNotificationAt.clear();
    this.activeNotificationSeverities.clear();
    this.ratingMilestonesInitialized = false;
    this.emittedRatingMilestones.clear();
    this.connectivityWorldVersion = -1;
    this.connectivityPathVersion = -1;
    this.connectedObjectIds.clear();
    this.entranceConnectedPathCount = 0;
    this.entranceConnectedTip = null;

    this.elapsedSeconds = validated.elapsedSeconds;
    this.trendAccumulatorSeconds = validated.trendAccumulatorSeconds;
    this.lastObservedCash = validated.lastObservedCash;
    this.lastProcessedTransactionId = validated.lastProcessedTransactionId;
    this.latestGuestCount = validated.latestGuestCount;
    for (const category of TRANSACTION_CATEGORIES) {
      Object.assign(this.categoryTotals[category], validated.categoryTotals[category]);
    }
    Object.assign(this.totals, validated.totals);
    this.latestRating = validated.latestRating;
    this.trendPoints.push(...validated.trendPoints);
    this.pendingNotifications = validated.pendingNotifications;
    this.nextNotificationId = validated.nextNotificationId;
    for (const [kind, at] of validated.lastNotificationAt) this.lastNotificationAt.set(kind, at);
    for (const [kind, severity] of validated.activeNotificationSeverities) {
      this.activeNotificationSeverities.set(kind, severity);
    }
    this.ratingMilestonesInitialized = validated.ratingMilestonesInitialized;
    for (const threshold of validated.emittedRatingMilestones) this.emittedRatingMilestones.add(threshold);
  }

  private validate(state: ManagementState): ManagementState {
    if (!isRecord(state)) throw invalidState(OWNER, 'state', 'is not an object');
    const finite = (value: unknown, path: string): number => {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAXIMUM_SAVED_AMOUNT) {
        throw invalidState(OWNER, path, `must be a finite number within +-${MAXIMUM_SAVED_AMOUNT}`);
      }
      return value === 0 ? 0 : value;
    };
    const nonNegative = (value: unknown, path: string, integer = false): number => {
      const number = finite(value, path);
      if (number < 0) throw invalidState(OWNER, path, 'must be >= 0');
      if (integer && (!Number.isInteger(number) || number > MAXIMUM_SAVED_COUNTER)) {
        throw invalidState(OWNER, path, `must be an integer in 0..${MAXIMUM_SAVED_COUNTER}`);
      }
      return number;
    };
    const text = (value: unknown, path: string): string => {
      if (typeof value !== 'string') throw invalidState(OWNER, path, 'must be a string');
      return value;
    };
    const oneOf = <T extends string>(value: unknown, allowed: readonly T[], path: string): T => {
      if (typeof value !== 'string' || !allowed.includes(value as T)) {
        throw invalidState(OWNER, path, `must be one of ${allowed.join(', ')}`);
      }
      return value as T;
    };
    const totalsOf = (value: unknown, path: string): FinancialTotals => {
      if (!isRecord(value)) throw invalidState(OWNER, path, 'must be an object');
      return {
        revenue: finite(value.revenue, `${path}.revenue`),
        expenses: finite(value.expenses, `${path}.expenses`),
        profit: finite(value.profit, `${path}.profit`),
        transactionCount: nonNegative(value.transactionCount, `${path}.transactionCount`, true),
      };
    };
    const array = (value: unknown, path: string): unknown[] => {
      if (!Array.isArray(value)) throw invalidState(OWNER, path, 'must be an array');
      return value;
    };

    const elapsedSeconds = nonNegative(state.elapsedSeconds, 'elapsedSeconds');
    const trendAccumulatorSeconds = nonNegative(state.trendAccumulatorSeconds, 'trendAccumulatorSeconds');
    if (elapsedSeconds > MAXIMUM_SAVED_SECONDS) throw invalidState(OWNER, 'elapsedSeconds', `must be at most ${MAXIMUM_SAVED_SECONDS}`);
    if (trendAccumulatorSeconds > MAXIMUM_SAVED_SECONDS) throw invalidState(OWNER, 'trendAccumulatorSeconds', `must be at most ${MAXIMUM_SAVED_SECONDS}`);
    const lastObservedCash = finite(state.lastObservedCash, 'lastObservedCash');
    const lastProcessedTransactionId = nonNegative(state.lastProcessedTransactionId, 'lastProcessedTransactionId', true);
    const latestGuestCount = nonNegative(state.latestGuestCount, 'latestGuestCount', true);

    if (!isRecord(state.categoryTotals)) throw invalidState(OWNER, 'categoryTotals', 'must be an object');
    // `land` (Phase 21) and `souvenirSales` (Phase 29) are optional: present once used, absent in every other park.
    const totalsState = state.categoryTotals;
    const present = (category: ManagementTransactionCategory): boolean => !OPTIONAL_CATEGORIES.has(category) || Object.hasOwn(totalsState, category);
    const keys = Object.keys(state.categoryTotals).sort();
    const expectedKeys = TRANSACTION_CATEGORIES.filter(present).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw invalidState(OWNER, 'categoryTotals', `must have exactly the keys ${expectedKeys.join(', ')}`);
    }
    const categoryTotals = {} as Record<ManagementTransactionCategory, FinancialTotals>;
    for (const category of TRANSACTION_CATEGORIES) {
      const raw = (state.categoryTotals as Partial<Record<ManagementTransactionCategory, FinancialTotals>>)[category];
      categoryTotals[category] = present(category) ? totalsOf(raw, `categoryTotals.${category}`) : emptyTotals();
    }
    const totals = totalsOf(state.totals, 'totals');

    if (!isRecord(state.latestRating)) throw invalidState(OWNER, 'latestRating', 'must be an object');
    const factorKeys = Object.keys(FACTOR_WEIGHTS) as RatingFactorKey[];
    const factors = array(state.latestRating.factors, 'latestRating.factors').map((raw, index): RatingFactor => {
      const path = `latestRating.factors[${index}]`;
      if (!isRecord(raw)) throw invalidState(OWNER, path, 'must be an object');
      return {
        key: oneOf(raw.key, factorKeys, `${path}.key`),
        label: text(raw.label, `${path}.label`),
        score: finite(raw.score, `${path}.score`),
        weight: finite(raw.weight, `${path}.weight`),
        contribution: finite(raw.contribution, `${path}.contribution`),
        detail: text(raw.detail, `${path}.detail`),
      };
    });
    const ratingScore = finite(state.latestRating.score, 'latestRating.score');
    if (ratingScore < 0 || ratingScore > 100) throw invalidState(OWNER, 'latestRating.score', 'must be within 0..100');
    const latestRating: ParkRatingSnapshot = { score: ratingScore, factors };

    const trendRows = array(state.trendPoints, 'trendPoints');
    if (trendRows.length > MANAGEMENT_CONFIG.maximumTrendPoints) {
      throw invalidState(OWNER, 'trendPoints', `has more than ${MANAGEMENT_CONFIG.maximumTrendPoints} points`);
    }
    const trendPoints = trendRows.map((raw, index): ManagementTrendPoint => {
      const path = `trendPoints[${index}]`;
      if (!isRecord(raw)) throw invalidState(OWNER, path, 'must be an object');
      return {
        timeSeconds: finite(raw.timeSeconds, `${path}.timeSeconds`),
        cash: finite(raw.cash, `${path}.cash`),
        guestCount: finite(raw.guestCount, `${path}.guestCount`),
        parkRating: finite(raw.parkRating, `${path}.parkRating`),
        revenue: finite(raw.revenue, `${path}.revenue`),
        expenses: finite(raw.expenses, `${path}.expenses`),
        profit: finite(raw.profit, `${path}.profit`),
        operatingProfit: finite(raw.operatingProfit, `${path}.operatingProfit`),
        cleanliness: finite(raw.cleanliness, `${path}.cleanliness`),
        reliability: finite(raw.reliability, `${path}.reliability`),
        scenery: finite(raw.scenery, `${path}.scenery`),
      };
    });

    const nextNotificationId = nonNegative(state.nextNotificationId, 'nextNotificationId', true);
    if (nextNotificationId < 1) throw invalidState(OWNER, 'nextNotificationId', 'must be >= 1');
    const notificationRows = array(state.pendingNotifications, 'pendingNotifications');
    if (notificationRows.length > MANAGEMENT_CONFIG.maximumPendingNotifications) {
      throw invalidState(OWNER, 'pendingNotifications', `has more than ${MANAGEMENT_CONFIG.maximumPendingNotifications} entries`);
    }
    const seenIds = new Set<number>();
    const pendingNotifications = notificationRows.map((raw, index): ManagementNotification => {
      const path = `pendingNotifications[${index}]`;
      if (!isRecord(raw)) throw invalidState(OWNER, path, 'must be an object');
      const id = nonNegative(raw.id, `${path}.id`, true);
      if (id < 1 || id >= nextNotificationId) throw invalidState(OWNER, `${path}.id`, `must be in [1, nextNotificationId=${nextNotificationId})`);
      if (seenIds.has(id)) throw invalidState(OWNER, `${path}.id`, `duplicates ${id}`);
      seenIds.add(id);
      return {
        id,
        kind: oneOf(raw.kind, NOTIFICATION_KINDS, `${path}.kind`),
        severity: oneOf(raw.severity, NOTIFICATION_SEVERITIES, `${path}.severity`),
        title: text(raw.title, `${path}.title`),
        message: text(raw.message, `${path}.message`),
        createdAtSeconds: finite(raw.createdAtSeconds, `${path}.createdAtSeconds`),
      };
    });

    const entries = <V>(value: unknown, path: string, readValue: (raw: unknown, entryPath: string) => V): Array<[ManagementNotificationKind, V]> => {
      const seen = new Set<string>();
      return array(value, path).map((raw, index) => {
        const entryPath = `${path}[${index}]`;
        if (!Array.isArray(raw) || raw.length !== 2) throw invalidState(OWNER, entryPath, 'must be a [kind, value] pair');
        const kind = oneOf(raw[0], NOTIFICATION_KINDS, `${entryPath}[0]`);
        if (seen.has(kind)) throw invalidState(OWNER, entryPath, `repeats kind ${kind}`);
        seen.add(kind);
        return [kind, readValue(raw[1], `${entryPath}[1]`)];
      });
    };
    const lastNotificationAt = entries(state.lastNotificationAt, 'lastNotificationAt', finite);
    const activeNotificationSeverities = entries(
      state.activeNotificationSeverities,
      'activeNotificationSeverities',
      (raw, path) => oneOf(raw, NOTIFICATION_SEVERITIES, path),
    );

    if (typeof state.ratingMilestonesInitialized !== 'boolean') {
      throw invalidState(OWNER, 'ratingMilestonesInitialized', 'must be a boolean');
    }
    const allowedMilestones = RATING_MILESTONES.map((milestone) => milestone.threshold) as number[];
    const emittedRatingMilestones = array(state.emittedRatingMilestones, 'emittedRatingMilestones').map((raw, index) => {
      const value = finite(raw, `emittedRatingMilestones[${index}]`);
      if (!allowedMilestones.includes(value)) {
        throw invalidState(OWNER, `emittedRatingMilestones[${index}]`, `must be one of ${allowedMilestones.join(', ')}`);
      }
      return value;
    });
    if (new Set(emittedRatingMilestones).size !== emittedRatingMilestones.length) {
      throw invalidState(OWNER, 'emittedRatingMilestones', 'has duplicates');
    }

    return {
      elapsedSeconds,
      trendAccumulatorSeconds,
      lastObservedCash,
      lastProcessedTransactionId,
      latestGuestCount,
      categoryTotals,
      totals,
      latestRating,
      trendPoints,
      pendingNotifications,
      nextNotificationId,
      lastNotificationAt,
      activeNotificationSeverities,
      ratingMilestonesInitialized: state.ratingMilestonesInitialized,
      emittedRatingMilestones: [...emittedRatingMilestones].sort((left, right) => left - right),
    };
  }
}
