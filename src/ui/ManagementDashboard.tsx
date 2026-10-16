import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { GAME_CONFIG } from '../game/config';
import { BUILD_BY_ID } from '../game/content/catalog';
import type { ThoughtInsight } from '../game/guests/types';
import type { SouvenirKind } from '../game/types';
import { sceneryFactorDetail } from '../game/management/ManagementSimulation';
import type { ManagementTrendPoint, OperationsComfort, RatingFactor } from '../game/management/types';
import type { ScenerySnapshot } from '../game/scenery/types';
import type { StaffRole, StaffRoleSnapshot } from '../game/operations/types';
import type { ResearchCategory, ResearchProjectSnapshot } from '../game/progression/types';
import { gameBridge } from '../app/gameBridge';
import { settingsStore, shouldShowManagementNotification } from '../settings';
import type { BuildingGroup, BuildingSnapshot } from '../game/session/types';
import type { BuildingSort, ManagementTab } from './store';
import { handleRovingKey, useFocusReturn } from './a11yHooks';
import { ComplaintLink } from './ComplaintLink';
import { labelWithSubject, planNotificationAnnouncements } from './a11yModel';
import { ActiveCardsSection } from './ScenarioHud';
import { useUiStore } from './store';
import { findingRewardText, RESEARCH_TIER_LABELS, researchBranches, researchBranchLine } from './themeCopy';
import { CAPACITY_SECTION_KICKER, CAPACITY_SECTION_TITLE, describeCapacity } from './capacityModel';
import { FACTOR_SORT_NOTE, ratingFactorRows } from './ratingFactorModel';
import { estateRowStatus, lacksPathAccess, NO_PATH_ACCESS_ROW_CLASS } from './pathAccessModel';
import { NEIGHBORHOODS_TAB_LABEL } from './neighborhoodModel';
import { NeighborhoodsTab } from './NeighborhoodsTab';
import { describeLand } from './landModel';

const formatMoney = (value: number, signed = false): string => {
  const rounded = Math.round(Math.abs(value)).toLocaleString();
  if (!signed || value === 0) return `${value < 0 ? '−' : ''}$${rounded}`;
  return `${value > 0 ? '+' : '−'}$${rounded}`;
};

const formatWait = (seconds: number): string => {
  if (seconds < 1) return 'None';
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  return `${Math.round(seconds / 60)} min`;
};

const categoryLabels: Record<string, string> = {
  construction: 'Construction',
  rideTickets: 'Ride tickets',
  rideRevenue: 'Ride tickets',
  shopSales: 'Shop sales',
  foodSales: 'Food',
  foodRevenue: 'Food',
  drinkSales: 'Drinks',
  drinkRevenue: 'Drinks',
  facilityRevenue: 'Facilities',
  rideOperations: 'Ride operation',
  staffSalaries: 'Staff salaries',
  maintenance: 'Maintenance',
  research: 'Research',
  land: 'Land',
  souvenirSales: 'Souvenirs',
  grants: 'Developer grants',
  refunds: 'Material refunds',
  other: 'Other',
};

interface MiniChartProps {
  label: string;
  values: number[];
  color?: string;
  formatter?: (value: number) => string;
}

const MiniChart = ({ label, values, color = '#37bd91', formatter = String }: MiniChartProps): React.JSX.Element => {
  if (values.length < 2) {
    return <div className="mini-chart empty" role="img" aria-label={`${label}: collecting data`}>Collecting trend data…</div>;
  }
  const width = 300;
  const height = 64;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(1, maximum - minimum);
  const points = values.map((value, index) => {
    const x = index / Math.max(1, values.length - 1) * width;
    const y = height - 5 - (value - minimum) / range * (height - 10);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const latest = values[values.length - 1];
  return (
    <div className="mini-chart" role="img" aria-label={`${label}: latest ${formatter(latest)}`}>
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false" preserveAspectRatio="none">
        <polyline points={points} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{formatter(latest)}</span>
    </div>
  );
};

/**
 * Phase 30: one repeated guest thought. An insight whose guests complain about a building (`objectId`, a ride or a stall
 * that still stands) carries a "→ <name>" link that eases the camera there and opens its inspector; `focusBuilding`
 * closes the dashboard on the way so the inspector is visible. The link sits inside the text cell, so the three-column
 * grid of the line keeps its shape. Pure markup: a plain `<p>` with a native button, nothing nested in another control.
 */
export const InsightLine = ({ insight }: { insight: ThoughtInsight }): React.JSX.Element => (
  <p>
    <i aria-hidden="true">✦</i>
    <strong>{insight.count}</strong>
    <span>
      {insight.text}
      {insight.objectId != null && insight.objectName != null && (
        <>
          {' '}
          <ComplaintLink objectId={insight.objectId} objectName={insight.objectName} className="insight-link" />
        </>
      )}
    </span>
  </p>
);

/** Phase 30: the Overview's second chip row. The first five ask for attention when anyone is uncomfortable; resting never does. */
const COMFORT_CHIPS: readonly { key: keyof OperationsComfort; label: string; attention: boolean }[] = [
  { key: 'tired', label: 'Tired', attention: true },
  { key: 'queasy', label: 'Queasy', attention: true },
  { key: 'hot', label: 'Too hot', attention: true },
  { key: 'cold', label: 'Cold', attention: true },
  { key: 'soaked', label: 'Soaked', attention: true },
  { key: 'resting', label: 'Resting', attention: false },
];

/**
 * Phase 30: what a souvenir stall sells and when the keepsake is wanted (the stall-level half of the guests' own desire
 * rule, see `souvenirSellsNow` in guests/life.ts: umbrellas in the rain, sun hats in the heat, glow wands at night,
 * balloons and plush toys any time).
 */
const SOUVENIR_ROW_DETAIL: Readonly<Record<SouvenirKind, string>> = {
  umbrella: 'Umbrellas · sell in the rain',
  hat: 'Sun hats · sell in the heat',
  balloon: 'Balloons · sell any time',
  plush: 'Plush toys · sell any time',
  glowWand: 'Glow wands · sell at night',
};

/**
 * Phase 30: the detail line of an estate row. `ParkSession.buildingsSnapshot` keeps its generic service string (it is in
 * the determinism observables, so it never changes), which says "relieves 0" of a souvenir stall; the row derives the
 * keepsake line from the definition instead. Every other row keeps the snapshot's own detail.
 */
export const buildingRowDetail = (row: Pick<BuildingSnapshot, 'definitionId' | 'detail'>): string => {
  const souvenir = BUILD_BY_ID.get(row.definitionId)?.stats?.souvenir;
  return souvenir === undefined ? row.detail : SOUVENIR_ROW_DETAIL[souvenir];
};

/**
 * The scenery factor's saved `detail` keeps its legacy words (it is in every state hash), so the row says what the score
 * really is from the live scenery snapshot instead (Phase 16): the average around rides and services, or the path fallback.
 */
const factorDetail = (factor: RatingFactor, scenery: ScenerySnapshot | undefined): string => (
  factor.key === 'scenery' && scenery ? sceneryFactorDetail(scenery) : factor.detail
);

/** Phase 11 (PA-016): the third line says the factor's share of the rating and what is left to gain, in reading order before the score. */
const FactorRow = ({ factor, scenery, weightLine }: { factor: RatingFactor; scenery?: ScenerySnapshot; weightLine: string }): React.JSX.Element => (
  <div className="rating-factor">
    <span><strong>{factor.label}</strong><small>{factorDetail(factor, scenery)}</small><em className="factor-weight">{weightLine}</em></span>
    <div aria-hidden="true"><i style={{ width: `${factor.score}%` }} /></div>
    <b>{Math.round(factor.score)}</b>
  </div>
);

const TrendCharts = ({ trends }: { trends: ManagementTrendPoint[] }): React.JSX.Element => (
  <div className="trend-grid">
    <section>
      <header><strong>Park rating</strong><small>Session trend</small></header>
      <MiniChart label="Park rating trend" values={trends.map((point) => point.parkRating)} formatter={(value) => `${Math.round(value)}/100`} />
    </section>
    <section>
      <header><strong>Operating profit</strong><small>Session trend</small></header>
      <MiniChart
        label="Operating profit trend"
        values={trends.map((point) => point.operatingProfit)}
        color="#f4b94e"
        formatter={(value) => formatMoney(value, true)}
      />
    </section>
  </div>
);

const OverviewTab = (): React.JSX.Element | null => {
  const management = useUiStore((state) => state.management);
  const pulseInsights = useUiStore((state) => state.pulseInsights);
  const guestCapacity = useUiStore((state) => state.guestCapacity);
  const atCapacity = useUiStore((state) => state.atCapacity);
  const overviewCrowdLine = useUiStore((state) => state.crowd?.overviewLine ?? null);
  const setTab = useUiStore((state) => state.setManagementTab);
  // Phase 33: an estate (restricted land) adds a Land KPI, from the same figures as the Land button's tooltip.
  const land = useUiStore((state) => state.land);
  if (!management) return null;
  const { operations } = management;
  const landView = land === null ? null : describeLand(land);
  const happiness = operations.averageHappiness === null ? '—' : `${Math.round(operations.averageHappiness)}%`;
  const capacity = describeCapacity(guestCapacity, management.guestCount, atCapacity);
  return (
    <div className="management-tab-panel" role="tabpanel" id="management-overview" aria-labelledby="management-tab-overview">
      <div className={`management-kpis${landView !== null ? ' with-land' : ''}`}>
        <span><small>GUESTS</small><strong>{management.guestCount}{capacity.kpiOf !== null && <> <small className="kpi-of">{capacity.kpiOf}</small></>}</strong></span>
        <span><small>HAPPINESS</small><strong>{happiness}</strong></span>
        <span><small>OPERATING PROFIT</small><strong className={management.finances.operating.profit >= 0 ? 'positive' : 'negative'}>{formatMoney(management.finances.operating.profit, true)}</strong></span>
        <span><small>AVG. QUEUE</small><strong>{formatWait(operations.averageQueueSeconds)}</strong></span>
        {landView !== null && (
          <span className="land-kpi" title={landView.summary}>
            {/* Phase 36: "parcels" moved into the label; "12 / 64 parcels" ellipsised to "12 / 64 p…" in the five-column row. */}
            <small>LAND PARCELS</small>
            <strong>{landView.owned} <small className="kpi-of">{landView.of}</small></strong>
            <em className="kpi-note">{landView.note}</em>
          </span>
        )}
      </div>

      {/* Phase 14: the top neighborhood line (the one Park Pulse shows), as a way into the Neighborhoods tab. */}
      {overviewCrowdLine !== null && (
        <button className="overview-crowd-line" onClick={() => setTab('neighborhoods')}>
          <i aria-hidden="true">≋</i><span>{overviewCrowdLine}</span>
        </button>
      )}

      <ActiveCardsSection />

      <section className="management-section rating-section">
        <header><span><small>OVERALL REPUTATION</small><strong>Park rating</strong></span><b>{Math.round(management.rating.score)}<small>/100</small></b></header>
        <MiniChart label="Park rating trend" values={management.trends.map((point) => point.parkRating)} formatter={(value) => `${Math.round(value)}/100`} />
        <p className="factor-sort-note">{FACTOR_SORT_NOTE}</p>
        <div className="rating-factors">
          {ratingFactorRows(management.rating.factors).map((row) => (
            <FactorRow key={row.factor.key} factor={row.factor} scenery={management.parkScenery} weightLine={row.weightLine} />
          ))}
        </div>
      </section>

      {capacity.ratio !== null && (
        <section className="management-section capacity-section">
          <header><span><small>{CAPACITY_SECTION_KICKER}</small><strong>{CAPACITY_SECTION_TITLE}</strong></span><b className={capacity.atCapacityTone ? 'warning' : undefined}>{capacity.ratio}</b></header>
          <p className="capacity-text">{capacity.text}</p>
        </section>
      )}

      <section className="management-section">
        <header><span><small>LIVE OPERATIONS</small><strong>Flow and demand</strong></span></header>
        <div className="operations-grid">
          <span><small>QUEUED</small><strong>{operations.totalQueued}</strong></span>
          <span><small>RIDES OPEN</small><strong>{operations.rides.open}/{operations.rides.total}</strong></span>
          <span><small>SERVICES OPEN</small><strong>{operations.services.open}/{operations.services.total}</strong></span>
          <span><small>SERVED</small><strong>{operations.rides.ridersToday + operations.services.customersServed}</strong></span>
        </div>
        <div className="need-chips">
          <span className={operations.needs.hungry > 0 ? 'attention' : ''}>Hungry <b>{operations.needs.hungry}</b></span>
          <span className={operations.needs.thirsty > 0 ? 'attention' : ''}>Thirsty <b>{operations.needs.thirsty}</b></span>
          <span className={operations.needs.toilet > 0 ? 'attention' : ''}>Need toilet <b>{operations.needs.toilet}</b></span>
        </div>
        {/* Phase 30: comfort, from the same guest scan; absent while guest life is switched off. */}
        {operations.comfort && (
          <div className="need-chips comfort-chips" role="group" aria-label="Guest comfort">
            {COMFORT_CHIPS.map((chip) => (
              <span key={chip.key} className={chip.attention && operations.comfort![chip.key] > 0 ? 'attention' : ''}>{chip.label} <b>{operations.comfort![chip.key]}</b></span>
            ))}
          </div>
        )}
      </section>

      <section className="management-section">
        <header><span><small>WHAT GUESTS ARE SAYING</small><strong>Live signals</strong></span></header>
        <div className="dashboard-insights">
          {pulseInsights.length > 0 ? pulseInsights.slice(0, 3).map((insight) => (
            <InsightLine key={`${insight.text}|${insight.objectId ?? ''}`} insight={insight} />
          )) : <p className="empty-copy">No repeated concerns right now.</p>}
        </div>
      </section>

    </div>
  );
};

const researchCategoryLabels: Record<ResearchCategory, { label: string; icon: string }> = {
  rides: { label: 'Rides', icon: '✦' },
  services: { label: 'Services', icon: '◒' },
  decoration: { label: 'Decoration', icon: '✿' },
};

interface ResearchProjectCardProps {
  project: ResearchProjectSnapshot;
  focused: boolean;
  projectNames: ReadonlyMap<string, string>;
  milestoneNames: ReadonlyMap<string, string>;
}

const ResearchProjectCard = ({
  project,
  focused,
  projectNames,
  milestoneNames,
}: ResearchProjectCardProps): React.JSX.Element => {
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) cardRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused]);
  const unlockNames = project.unlockDefinitionIds.map((id) => BUILD_BY_ID.get(id)?.name ?? id);
  const prerequisiteNames = project.prerequisiteIds.map((id) => projectNames.get(id) ?? id);
  const milestoneRequirementNames = project.requiredMilestoneIds.map((id) => milestoneNames.get(id) ?? id);
  const missingResources = [
    project.researchPointsRemaining > 0 ? `${project.researchPointsRemaining} RP` : null,
    project.cashRemaining > 0 ? formatMoney(project.cashRemaining) : null,
  ].filter((value): value is string => value !== null);
  const statusLabel = project.status === 'completed'
    ? 'Researched'
    : project.status === 'affordable'
      ? 'Ready'
      : project.status === 'available'
        ? 'Needs resources'
        : 'Locked';

  return (
    <article ref={cardRef} id={`research-project-${project.id}`} className={`research-project ${project.status} ${focused ? 'focused' : ''}`}>
      <header>
        <span>
          <em className={`research-tier tier-${project.tier}`}>{RESEARCH_TIER_LABELS[project.tier]} · {researchCategoryLabels[project.category].label}</em>
          <strong>{project.name}</strong>
          <small>{project.description}</small>
        </span>
        <b>{statusLabel}</b>
      </header>
      <div className="research-project-costs" role="group" aria-label={`${project.name} research cost`}>
        <span><small>RESEARCH</small><strong>{project.researchPointCost} RP</strong></span>
        <span><small>FUNDING</small><strong>{formatMoney(project.cashCost)}</strong></span>
      </div>
      <dl className="research-requirements">
        {prerequisiteNames.length > 0 && (
          <div className={project.missingPrerequisiteIds.length > 0 ? 'missing' : 'met'}><dt>Prerequisite</dt><dd>{prerequisiteNames.join(', ')}</dd></div>
        )}
        {milestoneRequirementNames.length > 0 && (
          <div className={project.missingMilestoneIds.length > 0 ? 'missing' : 'met'}><dt>Milestone</dt><dd>{milestoneRequirementNames.join(', ')}</dd></div>
        )}
        <div className="unlocks"><dt>Unlocks</dt><dd>{unlockNames.join(', ')}</dd></div>
      </dl>
      <div className="research-project-action">
        <span>{project.status === 'completed'
          ? 'Available in the construction catalog.'
          : project.status === 'locked'
            ? 'Complete the highlighted requirements first.'
            : missingResources.length > 0
              ? `Still needed: ${missingResources.join(' and ')}.`
              : 'Purchase once to unlock permanently.'}</span>
        <button
          onClick={() => gameBridge.purchaseResearch(project.id)}
          disabled={project.status !== 'affordable'}
          aria-label={labelWithSubject(project.status === 'completed' ? 'Completed' : project.status === 'affordable' ? 'Research' : project.status === 'locked' ? 'Locked' : 'Not ready', project.name)}
        >
          {project.status === 'completed' ? 'Completed' : project.status === 'affordable' ? 'Research' : project.status === 'locked' ? 'Locked' : 'Not ready'}
        </button>
      </div>
    </article>
  );
};

const ResearchTab = (): React.JSX.Element => {
  const progression = useUiStore((state) => state.progression);
  const focusedProjectId = useUiStore((state) => state.focusedResearchProjectId);
  if (!progression) return <div className="management-tab-panel" role="tabpanel" id="management-research" aria-labelledby="management-tab-research"><p className="management-loading">Collecting research data…</p></div>;
  const completedMilestones = progression.milestones.filter((milestone) => milestone.completed).length;
  const projectNames = new Map(progression.projects.map((project) => [project.id, project.name]));
  const milestoneNames = new Map(progression.milestones.map((milestone) => [milestone.id, milestone.name]));

  return (
    <div className="management-tab-panel research-tab" role="tabpanel" id="management-research" aria-labelledby="management-tab-research">
      <div className="research-summary">
        <span><small>RESEARCH POINTS</small><strong>{progression.researchPoints} RP</strong></span>
        <span><small>EXPERIENCES</small><strong>{progression.completedExperiences}</strong><em>{progression.completedRideExperiences} rides · {progression.completedServiceExperiences} services</em></span>
        <span><small>PROJECTS</small><strong>{progression.completedProjectIds.length}/{progression.projects.length}</strong></span>
        <span><small>MILESTONES</small><strong>{completedMilestones}/{progression.milestones.length}</strong></span>
      </div>

      <section className="management-section research-intro">
        <header><span><small>PARK KNOWLEDGE</small><strong>Research through real experiences</strong></span></header>
        <p>Completed rides and services create research points; projects spend points and cash to unlock new construction choices. Four openers start four branches, and each branch forks: pick a direction first. Park milestones add small findings on the way.</p>
      </section>

      <section className="management-section research-milestones-section">
        <header><span><small>PARK GROWTH</small><strong>Milestones</strong></span><b>{completedMilestones}<small>reached</small></b></header>
        <div className="research-milestones">
          {progression.milestones.map((milestone) => {
            const percent = Math.min(100, milestone.progress / Math.max(1, milestone.target) * 100);
            return (
              <article key={milestone.id} className={milestone.completed ? 'completed' : ''}>
                <i aria-hidden="true">{milestone.completed ? '✓' : milestone.metric === 'rating' ? '★' : '✦'}</i>
                <span><strong>{milestone.name}</strong><small>{milestone.description}</small><em>{findingRewardText(milestone.rewardResearchPoints)}</em></span>
                <b>{Math.min(milestone.target, Math.round(milestone.progress))}/{milestone.target}</b>
                <div role="progressbar" aria-label={`${milestone.name} progress`} aria-valuemin={0} aria-valuemax={milestone.target} aria-valuenow={Math.min(milestone.target, milestone.progress)}><i style={{ width: `${percent}%` }} /></div>
              </article>
            );
          })}
        </div>
      </section>

      {researchBranches(progression.projects).map((branch) => {
        const opener = branch.projects[0];
        const copy = researchCategoryLabels[opener.category];
        const headingId = `research-branch-${branch.id}`;
        return (
          <section className="management-section research-category research-branch" key={branch.id} aria-labelledby={headingId}>
            <header>
              <span><small><span aria-hidden="true">{copy.icon}</span> BRANCH</small><strong id={headingId}>{branch.name}</strong></span>
              <b>{branch.projects.filter((project) => project.status === 'completed').length}<small>of {branch.projects.length}</small></b>
            </header>
            <p>{researchBranchLine(branch)}</p>
            <div className="research-projects">
              {branch.projects.map((project) => (
                <ResearchProjectCard
                  key={project.id}
                  project={project}
                  focused={focusedProjectId === project.id}
                  projectNames={projectNames}
                  milestoneNames={milestoneNames}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};

const FinancesTab = (): React.JSX.Element | null => {
  const management = useUiStore((state) => state.management);
  if (!management) return null;
  const categories = Object.entries(management.finances.categories)
    .map(([key, totals]) => ({ key, totals }))
    .filter(({ totals }) => totals.transactionCount > 0);
  const largest = Math.max(1, ...categories.map(({ totals }) => Math.abs(totals.profit)));
  return (
    <div className="management-tab-panel" role="tabpanel" id="management-finances" aria-labelledby="management-tab-finances">
      <div className="finance-summary">
        <span><small>AVAILABLE CASH</small><strong>{formatMoney(management.cash)}</strong></span>
        <span><small>SESSION CASH IN</small><strong className="positive">+{formatMoney(management.finances.revenue)}</strong></span>
        <span><small>SESSION CASH OUT</small><strong className="negative">−{formatMoney(management.finances.expenses)}</strong></span>
        <span><small>NET CASH FLOW</small><strong className={management.finances.profit >= 0 ? 'positive' : 'negative'}>{formatMoney(management.finances.profit, true)}</strong></span>
      </div>

      <TrendCharts trends={management.trends} />

      <section className="management-section">
        <header>
          <span><small>WHERE MONEY MOVES</small><strong>Session breakdown</strong></span>
          <b className={management.finances.operating.profit >= 0 ? 'positive' : 'negative'}>{formatMoney(management.finances.operating.profit, true)}<small> operating</small></b>
        </header>
        <div className="finance-categories">
          {categories.length > 0 ? categories.map(({ key, totals }) => (
            <div key={key}>
              <span><strong>{categoryLabels[key] ?? key}</strong><small>{totals.transactionCount} transaction{totals.transactionCount === 1 ? '' : 's'}</small></span>
              <i><b className={totals.profit >= 0 ? 'income' : 'expense'} style={{ width: `${Math.abs(totals.profit) / largest * 100}%` }} /></i>
              <em className={totals.profit >= 0 ? 'positive' : 'negative'}>{formatMoney(totals.profit, true)}</em>
            </div>
          )) : <p className="empty-copy">No financial activity yet.</p>}
        </div>
      </section>

      <section className="management-section">
        <header><span><small>LATEST CASH MOVEMENTS</small><strong>Recent transactions</strong></span></header>
        <div className="recent-transactions">
          {management.finances.recentTransactions.length > 0
            ? management.finances.recentTransactions.map((transaction) => (
              <div key={transaction.id}>
                <span><strong>{transaction.label}</strong><small>{categoryLabels[transaction.category] ?? transaction.category} · tick {transaction.tick}</small></span>
                <b className={transaction.amount >= 0 ? 'positive' : 'negative'}>{formatMoney(transaction.amount, true)}</b>
              </div>
            ))
            : <p className="empty-copy">No transactions yet.</p>}
        </div>
      </section>
    </div>
  );
};

const scoreTone = (score: number): 'good' | 'warning' | 'critical' => {
  if (score >= 75) return 'good';
  if (score >= 45) return 'warning';
  return 'critical';
};

interface StaffCardProps {
  role: StaffRole;
  title: string;
  description: string;
  crew: StaffRoleSnapshot;
  payrollIntervalSeconds: number;
  capacityPerRole: number;
  maximumTrainingLevel: number;
  cash: number;
}

const StaffCard = ({
  role,
  title,
  description,
  crew,
  payrollIntervalSeconds,
  capacityPerRole,
  maximumTrainingLevel,
  cash,
}: StaffCardProps): React.JSX.Element => {
  const atCapacity = crew.total >= capacityPerRole;
  const trained = crew.trainingLevel > 0;
  const affordable = crew.trainingCost !== null && cash >= crew.trainingCost;
  return (
    <article className="staff-card">
      <span className={`staff-icon ${role}`} aria-hidden="true">{role === 'cleaner' ? '✦' : '◆'}</span>
      <span className="staff-copy">
        <strong>{title}</strong>
        <small>{description}</small>
        <b>{crew.busy}/{crew.total} busy · crew cap {capacityPerRole}</b>
        <em className={`staff-training-level ${trained ? 'trained' : ''}`}>
          {trained
            ? `Training ${crew.trainingLevel}/${maximumTrainingLevel} · +${crew.trainingLevel * 25}% work speed, +${crew.trainingLevel * 10}% walking`
            : `Untrained crew · training ${maximumTrainingLevel} levels available`}
        </em>
      </span>
      <span className="staff-payroll">
        <small>PAYROLL</small>
        <strong>{formatMoney(crew.total * crew.salaryPerInterval)}</strong>
        <em>every {payrollIntervalSeconds}s</em>
      </span>
      <div className="staff-actions" role="group" aria-label={`${title} staffing controls`}>
        <button onClick={() => gameBridge.fireStaff(role)} disabled={crew.total === 0} title={`Fire one ${role}`}>− Fire</button>
        <button
          className="hire"
          onClick={() => gameBridge.hireStaff(role)}
          disabled={atCapacity}
          title={atCapacity
            ? `Crew cap reached: ${capacityPerRole} ${role}s at this park size. It grows with the crowd.`
            : `Hire one ${role}`}
        >＋ Hire</button>
        <button
          className="train"
          onClick={() => gameBridge.trainStaff(role)}
          disabled={crew.trainingCost === null || crew.total === 0 || !affordable}
          title={crew.trainingCost === null
            ? 'This crew is fully trained'
            : `Train the whole ${role} crew one level for ${formatMoney(crew.trainingCost)}. Wages rise 20% per level.`}
        >
          {crew.trainingCost === null ? '★ Fully trained' : `★ Train ${formatMoney(crew.trainingCost)}`}
        </button>
      </div>
    </article>
  );
};

const OperationsTab = (): React.JSX.Element | null => {
  const management = useUiStore((state) => state.management);
  const cash = useUiStore((state) => state.cash);
  if (!management) return null;
  const { cleanliness, maintenance, staff } = management.parkOperations;
  const sickPiles = management.operations.comfort?.sickPiles ?? null;
  const condition = maintenance.averageRideCondition;
  const conditionDisplay = condition === null ? '—' : `${Math.round(condition)}%`;
  const payrollPerInterval = staff.cleaners.total * staff.cleaners.salaryPerInterval
    + staff.mechanics.total * staff.mechanics.salaryPerInterval;
  const cleanlinessTone = scoreTone(cleanliness.score);
  const conditionTone = condition === null ? 'good' : scoreTone(condition);

  return (
    <div className="management-tab-panel" role="tabpanel" id="management-operations" aria-labelledby="management-tab-operations">
      <div className="operations-summary">
        <span className={cleanlinessTone}><small>CLEANLINESS</small><strong>{Math.round(cleanliness.score)}%</strong></span>
        <span className={cleanliness.litterUnits > 0 ? 'warning' : 'good'}><small>LITTER</small><strong>{cleanliness.litterUnits}</strong></span>
        <span className={conditionTone}><small>RIDE CONDITION</small><strong>{conditionDisplay}</strong></span>
        <span><small>STAFF PAYROLL</small><strong>{formatMoney(payrollPerInterval)}</strong><em>/{staff.payrollIntervalSeconds}s</em></span>
      </div>

      <div className="trend-grid operations-trends">
        <section>
          <header><strong>Cleanliness</strong><small>Session trend</small></header>
          <MiniChart
            label="Park cleanliness trend"
            values={management.trends.map((point) => point.cleanliness)}
            formatter={(value) => `${Math.round(value)}%`}
          />
        </section>
        <section>
          <header><strong>Ride reliability</strong><small>Session trend</small></header>
          <MiniChart
            label="Ride reliability trend"
            values={management.trends.map((point) => point.reliability)}
            color="#f0ad3e"
            formatter={(value) => `${Math.round(value)}%`}
          />
        </section>
      </div>

      <section className="management-section operations-care-section">
        <header>
          <span><small>PARK CARE</small><strong>Cleanliness and bins</strong></span>
          <b className={cleanlinessTone}>{Math.round(cleanliness.score)}<small>/100 clean</small></b>
        </header>
        <div className={`condition-meter ${cleanlinessTone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(cleanliness.score)} aria-label={`Park cleanliness ${Math.round(cleanliness.score)} percent`}>
          <i style={{ width: `${cleanliness.score}%` }} />
        </div>
        <div className="operations-detail-grid">
          <span><small>LITTER UNITS</small><strong>{cleanliness.litterUnits}</strong></span>
          <span><small>DIRTY PATHS</small><strong>{cleanliness.dirtyPathTiles}</strong></span>
          <span><small>FULL BINS</small><strong>{cleanliness.binsFull}/{cleanliness.binsTotal}</strong></span>
          <span><small>AVG. BIN FILL</small><strong>{Math.round(cleanliness.averageBinFillPercent)}%</strong></span>
          {/* Phase 30: piles someone was sick on (guests mind them more); absent while guest life is switched off. */}
          {sickPiles !== null && <span className={sickPiles > 0 ? 'warning' : ''}><small>SICK PILES</small><strong>{sickPiles}</strong></span>}
        </div>
        {cleanliness.binsTotal === 0 && cleanliness.litterUnits > 0
          ? <p className="operations-advice warning">Place bins beside busy paths, then hire a cleaner to empty them.</p>
          : cleanliness.binsFull > 0
            ? <p className="operations-advice warning">Full bins need an available cleaner before litter pressure grows.</p>
            : <p className="operations-advice">Cleaners automatically collect reachable litter and empty bins.</p>}
      </section>

      <section className="management-section operations-maintenance-section">
        <header>
          <span><small>RIDE CARE</small><strong>Condition and reliability</strong></span>
          <b className={conditionTone}>{conditionDisplay}<small>average condition</small></b>
        </header>
        <div className={`condition-meter ${conditionTone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(condition ?? 0)} aria-label={`Average ride condition ${conditionDisplay}`}>
          <i style={{ width: `${condition ?? 0}%` }} />
        </div>
        <div className="operations-detail-grid">
          <span><small>WORN RIDES</small><strong>{maintenance.wornRides}</strong></span>
          <span className={maintenance.brokenRides > 0 ? 'critical' : ''}><small>BROKEN</small><strong>{maintenance.brokenRides}</strong></span>
          <span className={maintenance.awaitingMechanic > 0 ? 'warning' : ''}><small>AWAITING MECHANIC</small><strong>{maintenance.awaitingMechanic}</strong></span>
          <span><small>MECHANICS BUSY</small><strong>{staff.mechanics.busy}/{staff.mechanics.total}</strong></span>
        </div>
        {maintenance.awaitingMechanic > 0
          ? <p className="operations-advice critical">Breakdowns are waiting. Hire another mechanic or reduce the workload.</p>
          : <p className="operations-advice">Mechanics inspect worn rides and repair breakdowns automatically.</p>}
      </section>

      <section className="management-section">
        <header>
          <span><small>STAFFING</small><strong>Park crew</strong></span>
          <b>{staff.cleaners.total + staff.mechanics.total}<small>of {staff.capacityPerRole * 2} places</small></b>
        </header>
        <p className="operations-advice">
          The crew cap grows with the crowd: {GAME_CONFIG.operations.staff.baseCapacityPerRole} per role plus one
          per {GAME_CONFIG.operations.staff.guestsPerExtraStaff} guests, up to {GAME_CONFIG.operations.staff.maximumCapacityPerRole}.
          Training makes the crew you have faster instead of larger.
        </p>
        <div className="staff-roster">
          <StaffCard
            role="cleaner"
            title="Cleaners"
            description="Collect litter and empty reachable bins."
            crew={staff.cleaners}
            payrollIntervalSeconds={staff.payrollIntervalSeconds}
            capacityPerRole={staff.capacityPerRole}
            maximumTrainingLevel={staff.maximumTrainingLevel}
            cash={cash}
          />
          <StaffCard
            role="mechanic"
            title="Mechanics"
            description="Inspect worn rides and repair breakdowns."
            crew={staff.mechanics}
            payrollIntervalSeconds={staff.payrollIntervalSeconds}
            capacityPerRole={staff.capacityPerRole}
            maximumTrainingLevel={staff.maximumTrainingLevel}
            cash={cash}
          />
        </div>
      </section>
    </div>
  );
};

const ActivityTab = (): React.JSX.Element | null => {
  const management = useUiStore((state) => state.management);
  const pulseInsights = useUiStore((state) => state.pulseInsights);
  if (!management) return null;
  return (
    <div className="management-tab-panel" role="tabpanel" id="management-activity" aria-labelledby="management-tab-activity">
      <section className="management-section activity-section">
        <header><span><small>ACTIONABLE EVENTS</small><strong>Activity</strong></span></header>
        <div className="activity-list">
          {management.notifications.length > 0 ? [...management.notifications].reverse().map((notification) => (
            <article key={notification.id} className={notification.severity}>
              <i aria-hidden="true">{notification.severity === 'critical' ? '!' : notification.severity === 'warning' ? '△' : '✦'}</i>
              <span><strong>{notification.title}</strong><p>{notification.message}</p><small>{Math.round(notification.createdAtSeconds)}s into this session</small></span>
            </article>
          )) : <p className="empty-copy">No actionable events yet. Park Pulse is watching.</p>}
        </div>
      </section>
      <section className="management-section">
        <header><span><small>CURRENT GUEST SIGNALS</small><strong>Repeated thoughts</strong></span></header>
        <div className="dashboard-insights">
          {pulseInsights.length > 0 ? pulseInsights.map((insight) => (
            <InsightLine key={`${insight.text}|${insight.objectId ?? ''}`} insight={insight} />
          )) : <p className="empty-copy">No repeated guest concerns right now.</p>}
        </div>
      </section>
    </div>
  );
};


const GROUP_LABELS: Record<BuildingGroup, string> = {
  ride: 'Rides',
  food: 'Food',
  drink: 'Drinks',
  toilet: 'Facilities',
  souvenir: 'Souvenirs',
  bin: 'Bins',
  scenery: 'Scenery',
  other: 'Other',
};

const SORTS: { id: BuildingSort; label: string }[] = [
  { id: 'revenue', label: 'Revenue' },
  { id: 'queue', label: 'Queue' },
  { id: 'satisfaction', label: 'Satisfaction' },
  { id: 'condition', label: 'Condition' },
  { id: 'name', label: 'Name' },
  { id: 'position', label: 'Placed' },
];

/** Missing values always sort last, so a list ordered by revenue is not headed by scenery. */
const sortBuildings = (rows: readonly BuildingSnapshot[], sort: BuildingSort): BuildingSnapshot[] => {
  const descending = (pick: (row: BuildingSnapshot) => number | null) => (
    left: BuildingSnapshot,
    right: BuildingSnapshot,
  ): number => {
    const a = pick(left);
    const b = pick(right);
    if (a === null && b === null) return left.objectId - right.objectId;
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a || left.objectId - right.objectId;
  };
  const copy = [...rows];
  if (sort === 'name') return copy.sort((left, right) => left.name.localeCompare(right.name));
  if (sort === 'position') return copy.sort((left, right) => left.objectId - right.objectId);
  if (sort === 'queue') return copy.sort(descending((row) => row.queueLength));
  if (sort === 'satisfaction') return copy.sort(descending((row) => row.satisfaction));
  if (sort === 'condition') return copy.sort(descending((row) => row.condition));
  return copy.sort(descending((row) => row.revenue));
};

const BuildingRow = ({ row, noAccess }: { row: BuildingSnapshot; noAccess: boolean }): React.JSX.Element => {
  const definition = BUILD_BY_ID.get(row.definitionId);
  const conditionTone = row.condition === null ? '' : scoreTone(row.condition);
  const placement = `${GROUP_LABELS[row.group]} · ${row.footprint[0]}×${row.footprint[1]} at ${row.anchor.x}, ${row.anchor.y}`
    + `${row.open === null ? '' : row.open ? ' · open' : ' · closed'}${row.status === null ? '' : ` · ${row.status}`}`;
  return (
    <button
      className={`building-row${noAccess ? ` ${NO_PATH_ACCESS_ROW_CLASS}` : ''}`}
      onClick={() => gameBridge.focusBuilding(row.objectId)}
      title={`Show ${row.name} at ${row.anchor.x}, ${row.anchor.y}`}
    >
      <span
        className="building-icon"
        aria-hidden="true"
        style={{ '--item-color': `#${(definition?.color ?? 0x57d9ad).toString(16).padStart(6, '0')}` } as React.CSSProperties}
      >{row.icon}</span>
      <span className="building-identity">
        <strong>{row.name}</strong>
        <small>{buildingRowDetail(row)}</small>
        {/* Phase 11 (PA-024): ` · no path access` is appended here, never to the saved status string. */}
        <em>{estateRowStatus(placement, noAccess)}</em>
      </span>
      <span className="building-metric"><small>PRICE</small><strong>{row.price === null ? '—' : `$${row.price.toFixed(2)}`}</strong></span>
      <span className="building-metric"><small>QUEUE</small><strong>{row.queueLength === null ? '—' : row.queueLength}</strong></span>
      <span className="building-metric"><small>SERVED</small><strong>{row.served === null ? '—' : row.served}</strong></span>
      <span className="building-metric"><small>REVENUE</small><strong className={row.revenue ? 'positive' : ''}>{row.revenue === null ? '—' : formatMoney(row.revenue)}</strong></span>
      <span className="building-metric"><small>SATISFIED</small><strong>{row.satisfaction === null ? '—' : `${Math.round(row.satisfaction)}%`}</strong></span>
      <span className={`building-metric ${conditionTone}`}><small>CONDITION</small><strong>{row.condition === null ? '—' : `${Math.round(row.condition)}%`}</strong></span>
    </button>
  );
};

const BuildingsTab = (): React.JSX.Element => {
  const buildings = useUiStore((state) => state.buildings);
  const noPathAccessIds = useUiStore((state) => state.noPathAccessIds);
  const sort = useUiStore((state) => state.buildingSort);
  const setSort = useUiStore((state) => state.setBuildingSort);
  const rows = sortBuildings(buildings, sort);
  const revenue = buildings.reduce((total, row) => total + (row.revenue ?? 0), 0);
  const queued = buildings.reduce((total, row) => total + (row.queueLength ?? 0), 0);
  const closed = buildings.filter((row) => row.open === false).length;
  const groups = new Map<BuildingGroup, number>();
  for (const row of buildings) groups.set(row.group, (groups.get(row.group) ?? 0) + 1);

  return (
    <div className="management-tab-panel" role="tabpanel" id="management-buildings" aria-labelledby="management-tab-buildings">
      <div className="management-kpis">
        <span><small>BUILDINGS</small><strong>{buildings.length}</strong></span>
        <span><small>TOTAL REVENUE</small><strong className="positive">{formatMoney(revenue)}</strong></span>
        <span><small>QUEUED NOW</small><strong>{queued}</strong></span>
        <span className={closed > 0 ? 'warning' : ''}><small>CLOSED</small><strong>{closed}</strong></span>
      </div>

      <section className="management-section">
        <header>
          <span><small>EVERY PLACED BUILDING</small><strong>Estate overview</strong></span>
          <b>{[...groups.entries()].map(([group, count]) => `${count} ${GROUP_LABELS[group].toLowerCase()}`).join(' · ') || '—'}</b>
        </header>
        <div className="building-sort" role="group" aria-label="Sort buildings">
          {SORTS.map((candidate) => (
            <button
              key={candidate.id}
              className={sort === candidate.id ? 'active' : ''}
              aria-pressed={sort === candidate.id}
              onClick={() => setSort(candidate.id)}
            >{candidate.label}</button>
          ))}
        </div>
        <div className="building-list" role="group" aria-label={`Buildings sorted by ${SORTS.find((candidate) => candidate.id === sort)?.label.toLowerCase() ?? sort}`}>
          {rows.length > 0
            ? rows.map((row) => <BuildingRow key={row.objectId} row={row} noAccess={lacksPathAccess(noPathAccessIds, row.objectId)} />)
            : <p className="empty-copy">Nothing built yet. Place a path and your first attraction.</p>}
        </div>
        {/* Phase 30: only rides, stalls and facilities have an inspector; a bin, bench or scenery row just moves the camera. */}
        <p className="operations-advice">Select a row to centre the camera on it. Rides, stalls and facilities also open their inspector.</p>
      </section>
    </div>
  );
};

const tabs: { id: ManagementTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'buildings', label: 'Buildings' },
  { id: 'neighborhoods', label: NEIGHBORHOODS_TAB_LABEL },
  { id: 'research', label: 'Research' },
  { id: 'operations', label: 'Operations' },
  { id: 'finances', label: 'Finances' },
  { id: 'activity', label: 'Activity' },
];

export const ManagementDashboard = (): React.JSX.Element | null => {
  const open = useUiStore((state) => state.managementOpen);
  const tab = useUiStore((state) => state.managementTab);
  const management = useUiStore((state) => state.management);
  const close = useUiStore((state) => state.closeManagement);
  const setTab = useUiStore((state) => state.setManagementTab);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Declared before the focus effect below: it records the opener (the Park Pulse card, the cash pill,
  // a building row's neighbour) before focus moves in, and gives it back when the dashboard closes.
  useFocusReturn(open);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;
  const notificationCount = management?.notifications.length ?? 0;
  return (
    <aside className="management-dashboard" id="management-dashboard" aria-label="Park Pulse management dashboard">
      <header className="management-header">
        <span className="pulse-wave" aria-hidden="true">⌁</span>
        <span><small>LIVE MANAGEMENT</small><strong role="heading" aria-level={2}>Park Pulse</strong></span>
        <b>{Math.round(management?.rating.score ?? 0)}<small> rating</small></b>
        <button ref={closeRef} onClick={close} title="Close dashboard (Esc)" aria-label="Close Park Pulse dashboard"><span aria-hidden="true">×</span></button>
      </header>
      <nav
        className="management-tabs"
        role="tablist"
        aria-label="Management sections"
        onKeyDown={(event) => handleRovingKey(event, { orientation: 'horizontal' }, (element) => setTab(element.dataset.tab as ManagementTab))}
      >
        {tabs.map((candidate) => (
          <button
            key={candidate.id}
            id={`management-tab-${candidate.id}`}
            role="tab"
            aria-selected={tab === candidate.id}
            aria-controls={tab === candidate.id ? `management-${candidate.id}` : undefined}
            tabIndex={tab === candidate.id ? 0 : -1}
            data-roving-item
            data-tab={candidate.id}
            className={tab === candidate.id ? 'active' : ''}
            onClick={() => setTab(candidate.id)}
          >
            {candidate.label}
            {candidate.id === 'activity' && notificationCount > 0 && (
              <>
                <span aria-hidden="true">{notificationCount}</span>
                <span className="sr-only">, {notificationCount} notification{notificationCount === 1 ? '' : 's'}</span>
              </>
            )}
          </button>
        ))}
      </nav>
      {/* A Tab stop of its own, so a keyboard can scroll a tab that holds no control (the overview with the Phase 25 card list
          overflows at 800 px; axe scrollable-region-focusable). */}
      <div className="management-scroll" role="region" aria-label="Report" tabIndex={0}>
        {!management ? <div className="management-tab-panel" role="tabpanel" id={`management-${tab}`} aria-labelledby={`management-tab-${tab}`}><p className="management-loading">Collecting park data…</p></div> : tab === 'overview'
          ? <OverviewTab />
          : tab === 'buildings'
            ? <BuildingsTab />
          : tab === 'neighborhoods'
            ? <NeighborhoodsTab />
          : tab === 'research'
            ? <ResearchTab />
          : tab === 'operations'
            ? <OperationsTab />
          : tab === 'finances'
            ? <FinancesTab />
            : <ActivityTab />}
      </div>
    </aside>
  );
};

/**
 * Pop-ups for fresh management notifications. The visible cards are buttons (they open the Activity
 * tab); the speech is a separate always-mounted pair of live regions, because a region that appears
 * together with its text is not reliably announced. Each notification is spoken once, filtered by the
 * same intensity setting as the pop-ups; critical ones are assertive, the rest polite.
 */
export const ManagementNotifications = (): React.JSX.Element | null => {
  const management = useUiStore((state) => state.management);
  const dashboardOpen = useUiStore((state) => state.managementOpen);
  const toast = useUiStore((state) => state.toast);
  const openManagement = useUiStore((state) => state.openManagement);
  const intensity = useStore(settingsStore, (state) => state.settings.notifications);
  const announced = useRef<ReadonlySet<number | string> | null>(null);
  // A pop-up the player waved away stays away (Escape on a focused one); the Activity tab keeps the history.
  const [dismissed, setDismissed] = useState<ReadonlySet<number | string>>(() => new Set());
  // A pop-up that has keyboard focus stays until focus leaves it: it must not vanish under the player's hands.
  const [heldId, setHeldId] = useState<number | string | null>(null);
  const [spoken, setSpoken] = useState<{ polite: string | null; assertive: string | null; key: number }>({ polite: null, assertive: null, key: 0 });
  // Only the transient pop-ups are filtered; the Activity list and the Pulse badge keep the history.
  const visible = management && !dashboardOpen
    ? management.notifications
      .filter((notification) => shouldShowManagementNotification(notification.severity, intensity))
      .filter((notification) => management.elapsedSeconds - notification.createdAtSeconds <= 8 || notification.id === heldId)
      .filter((notification) => !dismissed.has(notification.id))
      .slice(-2)
      .reverse()
    : [];
  const signature = visible.map((notification) => notification.id).join(',');
  useEffect(() => {
    // The first look at a park (a load, a new game) speaks nothing: those notifications are history.
    if (announced.current === null) {
      announced.current = new Set(visible.map((notification) => notification.id));
      return;
    }
    const plan = planNotificationAnnouncements(announced.current, [...visible].reverse());
    announced.current = plan.announced;
    if (plan.assertive !== null || plan.polite !== null) setSpoken((previous) => ({ polite: plan.polite, assertive: plan.assertive, key: previous.key + 1 }));
  // `visible` is derived from the same inputs as `signature`.
  }, [signature]);
  if (!management) return null;
  const critical = visible.some((notification) => notification.severity === 'critical');
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" aria-label="Park Pulse notifications">
        {spoken.polite ? <span key={`p${spoken.key}`}>{spoken.polite}</span> : null}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {spoken.assertive ? <span key={`a${spoken.key}`}>{spoken.assertive}</span> : null}
      </div>
      {visible.length > 0 && (
        <div className={`management-notifications ${toast ? 'with-toast' : ''}`} role="group" aria-label={critical ? 'Park Pulse alerts' : 'Park Pulse notifications'}>
          {visible.map((notification) => (
            <button
              key={notification.id}
              className={notification.severity}
              onClick={() => openManagement('activity')}
              title="Open Park Pulse activity (Esc dismisses this)"
              onFocus={() => setHeldId(notification.id)}
              onBlur={() => setHeldId((current) => (current === notification.id ? null : current))}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                // Not the pause menu: Escape on a pop-up only puts the pop-up away.
                event.preventDefault();
                event.stopPropagation();
                setDismissed((previous) => new Set(previous).add(notification.id));
                // The pop-up is about to unmount: hand the keyboard to the Park Pulse card beside it.
                document.querySelector<HTMLElement>('.pulse-launcher')?.focus();
              }}
            >
              <i aria-hidden="true">{notification.severity === 'critical' ? '!' : notification.severity === 'warning' ? '△' : '✦'}</i>
              <span><strong>{notification.title}</strong><small>{notification.message}</small></span>
            </button>
          ))}
        </div>
      )}
    </>
  );
};
