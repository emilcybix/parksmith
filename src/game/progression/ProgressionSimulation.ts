import { BUILD_CATALOG } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import type { RideSimulation } from '../rides/RideSimulation';
import type { ShopSimulation } from '../shops/ShopSimulation';
import { plainNumber } from '../save/plainData';
import type { ProgressionState, Serializable } from '../save/state';
import { MAXIMUM_SAVED_AMOUNT, MAXIMUM_SAVED_COUNTER } from '../save/ranges';
import { invalidState, SaveError } from '../save/version';
import type { BuildAccessPolicy, GameWorld } from '../World';
import {
  PROJECT_BY_BUILD_ID,
  RESEARCH_MILESTONES,
  RESEARCH_PROJECT_BY_ID,
  RESEARCH_PROJECTS,
  scaledResearchPoints,
} from './content';
import type {
  ProgressionEvent,
  ProgressionSnapshot,
  ResearchMilestoneDefinition,
  ResearchMilestoneId,
  ResearchMilestoneSnapshot,
  ResearchProjectDefinition,
  ResearchProjectId,
  ResearchProjectSnapshot,
  ResearchProjectStatus,
  ResearchPurchaseResult,
} from './types';

const roundResearchPoints = (value: number): number => Math.round((value + Number.EPSILON) * 10) / 10;

const safeCounter = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const safeRating = (value: number): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

const OWNER = 'ProgressionSimulation';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * Owns research points, completed projects and milestones, and the completion baselines.
 *
 * Save/restore (Phase 12): `completedExperiences` is DERIVED; `world` and the content tables are
 * CONFIG. restore() never touches the world's build-access policy, because ParkSession wraps this
 * simulation in a closure over the rules-locked ids that must survive a restore.
 */
export class ProgressionSimulation implements BuildAccessPolicy, Serializable<ProgressionState> {
  private researchPoints = 0;
  private completedRideExperiences = 0;
  private completedServiceExperiences = 0;
  private highestParkRating = 0;
  private readonly completedProjectIds = new Set<ResearchProjectId>();
  private readonly completedMilestoneIds = new Set<ResearchMilestoneId>();
  private readonly lastRideCompletionCounts = new Map<number, number>();
  private readonly lastServiceCompletionCounts = new Map<number, number>();
  private pendingEvents: ProgressionEvent[] = [];
  private nextEventId = 1;

  /**
   * The ruleset's research cost scale (Phase 16; 1 = the base costs, every park before Phase 16). Applied at purchase
   * and in the snapshot only; milestone rewards and the saved point totals are never scaled.
   */
  readonly researchCostScale: number;

  constructor(private readonly world: GameWorld, researchCostScale = 1) {
    this.researchCostScale = Number.isFinite(researchCostScale) && researchCostScale > 0 ? researchCostScale : 1;
    this.world.setBuildAccessPolicy(this);
  }

  /** The RP a project costs in this park: round(base x scale), exactly the base at scale 1. */
  researchPointCostOf(project: ResearchProjectDefinition): number {
    return scaledResearchPoints(project.researchPointCost, this.researchCostScale);
  }

  step(
    stepMs: number,
    rides: RideSimulation,
    shops: ShopSimulation,
    parkRating: number,
  ): void {
    const deltaMs = Number.isFinite(stepMs) ? Math.max(0, stepMs) : 0;
    if (deltaMs <= 0) return;

    const rideCompletions = this.collectRideCompletions(rides);
    const serviceCompletions = this.collectServiceCompletions(shops);
    this.completedRideExperiences += rideCompletions;
    this.completedServiceExperiences += serviceCompletions;
    this.highestParkRating = Math.max(this.highestParkRating, safeRating(parkRating));

    this.addResearchPoints(
      rideCompletions * GAME_CONFIG.research.rideCompletionPoints
        + serviceCompletions * GAME_CONFIG.research.serviceCompletionPoints,
    );
    this.evaluateMilestones();
  }

  purchase(projectId: string): ResearchPurchaseResult {
    const project = RESEARCH_PROJECT_BY_ID.get(projectId as ResearchProjectId);
    if (!project) return { ok: false, reason: 'missing' };
    if (this.completedProjectIds.has(project.id)) return { ok: false, reason: 'completed' };
    if (!this.requirementsMet(project)) return { ok: false, reason: 'locked' };
    const researchPointCost = this.researchPointCostOf(project);
    if (this.researchPoints < researchPointCost) return { ok: false, reason: 'insufficient-rp' };
    if (this.world.cash < project.cashCost) return { ok: false, reason: 'insufficient-cash' };

    this.researchPoints = roundResearchPoints(this.researchPoints - researchPointCost);
    this.completedProjectIds.add(project.id);
    this.world.postTransaction(-project.cashCost, `${project.name} research`, 'research');

    const unlockedDefinitionIds = [...project.unlockDefinitionIds];
    this.pendingEvents.push({
      id: this.nextEventId++,
      kind: 'researchCompleted',
      tick: this.world.tick,
      projectId: project.id,
      unlockedDefinitionIds: [...unlockedDefinitionIds],
      researchPointsSpent: researchPointCost,
      cashSpent: project.cashCost,
    });
    return {
      ok: true,
      projectId: project.id,
      unlockedDefinitionIds,
      researchPointsSpent: researchPointCost,
      cashSpent: project.cashCost,
    };
  }

  isUnlocked(definitionId: string): boolean {
    const projectId = PROJECT_BY_BUILD_ID.get(definitionId);
    return projectId === undefined || this.completedProjectIds.has(projectId);
  }

  snapshot(): ProgressionSnapshot {
    return {
      researchPoints: this.researchPoints,
      completedExperiences: this.completedExperiences,
      completedRideExperiences: this.completedRideExperiences,
      completedServiceExperiences: this.completedServiceExperiences,
      completedProjectIds: RESEARCH_PROJECTS
        .filter((project) => this.completedProjectIds.has(project.id))
        .map((project) => project.id),
      unlockedDefinitionIds: BUILD_CATALOG
        .filter((definition) => this.isUnlocked(definition.id))
        .map((definition) => definition.id),
      projects: RESEARCH_PROJECTS.map((project) => this.projectSnapshot(project)),
      milestones: RESEARCH_MILESTONES.map((milestone) => this.milestoneSnapshot(milestone)),
    };
  }

  drainEvents(): ProgressionEvent[] {
    const events = this.pendingEvents.map((event) => event.kind === 'researchCompleted'
      ? { ...event, unlockedDefinitionIds: [...event.unlockedDefinitionIds] }
      : { ...event });
    this.pendingEvents = [];
    return events;
  }

  grantResearchPoints(amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const granted = roundResearchPoints(amount);
    this.addResearchPoints(granted);
    return granted;
  }

  private get completedExperiences(): number {
    return this.completedRideExperiences + this.completedServiceExperiences;
  }

  private collectRideCompletions(rides: RideSimulation): number {
    let completed = 0;
    const liveIds = new Set<number>();
    for (const ride of rides.rides.values()) {
      liveIds.add(ride.objectId);
      const current = safeCounter(ride.satisfactionCount);
      const previous = this.lastRideCompletionCounts.get(ride.objectId) ?? 0;
      completed += Math.max(0, current - previous);
      this.lastRideCompletionCounts.set(ride.objectId, current);
    }
    for (const objectId of this.lastRideCompletionCounts.keys()) {
      if (!liveIds.has(objectId)) this.lastRideCompletionCounts.delete(objectId);
    }
    return completed;
  }

  private collectServiceCompletions(shops: ShopSimulation): number {
    let completed = 0;
    const liveIds = new Set<number>();
    for (const service of shops.services.values()) {
      liveIds.add(service.objectId);
      const current = safeCounter(service.customersServed);
      const previous = this.lastServiceCompletionCounts.get(service.objectId) ?? 0;
      completed += Math.max(0, current - previous);
      this.lastServiceCompletionCounts.set(service.objectId, current);
    }
    for (const objectId of this.lastServiceCompletionCounts.keys()) {
      if (!liveIds.has(objectId)) this.lastServiceCompletionCounts.delete(objectId);
    }
    return completed;
  }

  private addResearchPoints(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.researchPoints = roundResearchPoints(this.researchPoints + amount);
  }

  private evaluateMilestones(): void {
    for (const milestone of RESEARCH_MILESTONES) {
      if (this.completedMilestoneIds.has(milestone.id)) continue;
      if (this.milestoneProgress(milestone) < milestone.target) continue;
      this.completedMilestoneIds.add(milestone.id);
      this.addResearchPoints(milestone.rewardResearchPoints);
      this.pendingEvents.push({
        id: this.nextEventId++,
        kind: 'milestoneReached',
        tick: this.world.tick,
        milestoneId: milestone.id,
        rewardResearchPoints: milestone.rewardResearchPoints,
      });
    }
  }

  private requirementsMet(project: ResearchProjectDefinition): boolean {
    return project.prerequisiteIds.every((id) => this.completedProjectIds.has(id))
      && project.requiredMilestoneIds.every((id) => this.completedMilestoneIds.has(id));
  }

  private projectSnapshot(project: ResearchProjectDefinition): ResearchProjectSnapshot {
    const missingPrerequisiteIds = project.prerequisiteIds
      .filter((id) => !this.completedProjectIds.has(id));
    const missingMilestoneIds = project.requiredMilestoneIds
      .filter((id) => !this.completedMilestoneIds.has(id));
    const researchPointCost = this.researchPointCostOf(project);
    let status: ResearchProjectStatus;
    if (this.completedProjectIds.has(project.id)) status = 'completed';
    else if (missingPrerequisiteIds.length > 0 || missingMilestoneIds.length > 0) status = 'locked';
    else if (this.researchPoints >= researchPointCost && this.world.cash >= project.cashCost) status = 'affordable';
    else status = 'available';

    return {
      id: project.id,
      tier: project.tier,
      name: project.name,
      category: project.category,
      description: project.description,
      researchPointCost,
      cashCost: project.cashCost,
      prerequisiteIds: [...project.prerequisiteIds],
      requiredMilestoneIds: [...project.requiredMilestoneIds],
      unlockDefinitionIds: [...project.unlockDefinitionIds],
      status,
      missingPrerequisiteIds: [...missingPrerequisiteIds],
      missingMilestoneIds: [...missingMilestoneIds],
      researchPointsRemaining: roundResearchPoints(Math.max(0, researchPointCost - this.researchPoints)),
      cashRemaining: Math.max(0, project.cashCost - this.world.cash),
    };
  }

  private milestoneSnapshot(milestone: ResearchMilestoneDefinition): ResearchMilestoneSnapshot {
    return {
      id: milestone.id,
      name: milestone.name,
      description: milestone.description,
      metric: milestone.metric,
      target: milestone.target,
      rewardResearchPoints: milestone.rewardResearchPoints,
      progress: this.milestoneProgress(milestone),
      completed: this.completedMilestoneIds.has(milestone.id),
    };
  }

  private milestoneProgress(milestone: ResearchMilestoneDefinition): number {
    return milestone.metric === 'experiences' ? this.completedExperiences : this.highestParkRating;
  }

  /**
   * Pure copy of every field that influences the future; Sets are written in definition order.
   * That is a deliberate exception to "Maps and Sets keep insertion order": every reader of the two
   * completed-id Sets uses has() or filters in catalog order, so their insertion order is not
   * observable. Anything that starts iterating these Sets for order must save insertion order first.
   */
  serialize(): ProgressionState {
    return {
      researchPoints: plainNumber(this.researchPoints, 'researchPoints'),
      completedRideExperiences: plainNumber(this.completedRideExperiences, 'completedRideExperiences'),
      completedServiceExperiences: plainNumber(this.completedServiceExperiences, 'completedServiceExperiences'),
      highestParkRating: plainNumber(this.highestParkRating, 'highestParkRating'),
      completedProjectIds: RESEARCH_PROJECTS
        .filter((project) => this.completedProjectIds.has(project.id))
        .map((project) => project.id),
      completedMilestoneIds: RESEARCH_MILESTONES
        .filter((milestone) => this.completedMilestoneIds.has(milestone.id))
        .map((milestone) => milestone.id),
      lastRideCompletionCounts: [...this.lastRideCompletionCounts].map(([id, count]) => [id, count]),
      lastServiceCompletionCounts: [...this.lastServiceCompletionCounts].map(([id, count]) => [id, count]),
      pendingEvents: this.pendingEvents.map((event) => event.kind === 'researchCompleted'
        ? { ...event, unlockedDefinitionIds: [...event.unlockedDefinitionIds] }
        : { ...event }),
      nextEventId: plainNumber(this.nextEventId, 'nextEventId'),
    };
  }

  /**
   * Validates everything first, then resets and applies in place. Unknown content ids throw
   * 'content-mismatch' rather than being dropped: silently losing a completed project would
   * re-lock buildings the player already owns.
   */
  restore(state: ProgressionState): void {
    const validated = this.validate(state);
    this.researchPoints = 0;
    this.completedRideExperiences = 0;
    this.completedServiceExperiences = 0;
    this.highestParkRating = 0;
    this.completedProjectIds.clear();
    this.completedMilestoneIds.clear();
    this.lastRideCompletionCounts.clear();
    this.lastServiceCompletionCounts.clear();
    this.pendingEvents = [];
    this.nextEventId = 1;

    this.researchPoints = validated.researchPoints;
    this.completedRideExperiences = validated.completedRideExperiences;
    this.completedServiceExperiences = validated.completedServiceExperiences;
    this.highestParkRating = validated.highestParkRating;
    for (const id of validated.completedProjectIds) this.completedProjectIds.add(id);
    for (const id of validated.completedMilestoneIds) this.completedMilestoneIds.add(id);
    for (const [id, count] of validated.lastRideCompletionCounts) this.lastRideCompletionCounts.set(id, count);
    for (const [id, count] of validated.lastServiceCompletionCounts) this.lastServiceCompletionCounts.set(id, count);
    this.pendingEvents = validated.pendingEvents;
    this.nextEventId = validated.nextEventId;
  }

  private validate(state: ProgressionState): ProgressionState {
    if (!isRecord(state)) throw invalidState(OWNER, 'state', 'is not an object');
    const nonNegative = (value: unknown, path: string, integer: boolean): number => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (integer ? MAXIMUM_SAVED_COUNTER : MAXIMUM_SAVED_AMOUNT)) {
        throw invalidState(OWNER, path, `must be a finite number in 0..${integer ? MAXIMUM_SAVED_COUNTER : MAXIMUM_SAVED_AMOUNT}`);
      }
      if (integer && !Number.isInteger(value)) throw invalidState(OWNER, path, 'must be an integer');
      return value === 0 ? 0 : value;
    };
    const researchPoints = nonNegative(state.researchPoints, 'researchPoints', false);
    const completedRideExperiences = nonNegative(state.completedRideExperiences, 'completedRideExperiences', true);
    const completedServiceExperiences = nonNegative(state.completedServiceExperiences, 'completedServiceExperiences', true);
    const highestParkRating = nonNegative(state.highestParkRating, 'highestParkRating', false);
    if (highestParkRating > 100) throw invalidState(OWNER, 'highestParkRating', 'must be <= 100');
    const nextEventId = nonNegative(state.nextEventId, 'nextEventId', true);
    if (nextEventId < 1) throw invalidState(OWNER, 'nextEventId', 'must be >= 1');

    const ids = <T extends string>(
      value: unknown,
      path: string,
      known: (id: string) => boolean,
      what: string,
    ): T[] => {
      if (!Array.isArray(value)) throw invalidState(OWNER, path, 'must be an array');
      const seen = new Set<string>();
      return value.map((id, index) => {
        if (typeof id !== 'string') throw invalidState(OWNER, `${path}[${index}]`, 'must be a string');
        if (!known(id)) {
          throw new SaveError('content-mismatch', `${OWNER} cannot restore: unknown ${what} '${id}' at ${path}[${index}]`);
        }
        if (seen.has(id)) throw invalidState(OWNER, `${path}[${index}]`, `duplicates '${id}'`);
        seen.add(id);
        return id as T;
      });
    };
    const completedProjectIds = ids<ResearchProjectId>(
      state.completedProjectIds, 'completedProjectIds', (id) => RESEARCH_PROJECT_BY_ID.has(id as ResearchProjectId), 'research project',
    );
    const milestoneIds = new Set<string>(RESEARCH_MILESTONES.map((milestone) => milestone.id));
    const completedMilestoneIds = ids<ResearchMilestoneId>(
      state.completedMilestoneIds, 'completedMilestoneIds', (id) => milestoneIds.has(id), 'research milestone',
    );

    const counts = (value: unknown, path: string): Array<[number, number]> => {
      if (!Array.isArray(value)) throw invalidState(OWNER, path, 'must be an array');
      const seen = new Set<number>();
      return value.map((entry, index) => {
        if (!Array.isArray(entry) || entry.length !== 2) throw invalidState(OWNER, `${path}[${index}]`, 'must be an [objectId, count] pair');
        const id = nonNegative(entry[0], `${path}[${index}][0]`, true);
        const count = nonNegative(entry[1], `${path}[${index}][1]`, true);
        if (seen.has(id)) throw invalidState(OWNER, `${path}[${index}]`, `repeats object id ${id}`);
        seen.add(id);
        return [id, count];
      });
    };
    const lastRideCompletionCounts = counts(state.lastRideCompletionCounts, 'lastRideCompletionCounts');
    const lastServiceCompletionCounts = counts(state.lastServiceCompletionCounts, 'lastServiceCompletionCounts');

    if (!Array.isArray(state.pendingEvents)) throw invalidState(OWNER, 'pendingEvents', 'must be an array');
    const pendingEvents = state.pendingEvents.map((raw: unknown, index): ProgressionEvent => {
      const path = `pendingEvents[${index}]`;
      if (!isRecord(raw)) throw invalidState(OWNER, path, 'must be an object');
      const id = nonNegative(raw.id, `${path}.id`, true);
      if (id < 1 || id >= nextEventId) throw invalidState(OWNER, `${path}.id`, `must be in [1, nextEventId=${nextEventId})`);
      const tick = nonNegative(raw.tick, `${path}.tick`, true);
      if (raw.kind === 'researchCompleted') {
        const [projectId] = ids<ResearchProjectId>(
          [raw.projectId], `${path}.projectId`, (value) => RESEARCH_PROJECT_BY_ID.has(value as ResearchProjectId), 'research project',
        );
        if (!Array.isArray(raw.unlockedDefinitionIds) || raw.unlockedDefinitionIds.some((value) => typeof value !== 'string')) {
          throw invalidState(OWNER, `${path}.unlockedDefinitionIds`, 'must be an array of strings');
        }
        return {
          id,
          kind: 'researchCompleted',
          tick,
          projectId,
          unlockedDefinitionIds: [...(raw.unlockedDefinitionIds as string[])],
          researchPointsSpent: nonNegative(raw.researchPointsSpent, `${path}.researchPointsSpent`, false),
          cashSpent: nonNegative(raw.cashSpent, `${path}.cashSpent`, false),
        };
      }
      if (raw.kind === 'milestoneReached') {
        const [milestoneId] = ids<ResearchMilestoneId>(
          [raw.milestoneId], `${path}.milestoneId`, (value) => milestoneIds.has(value), 'research milestone',
        );
        return {
          id,
          kind: 'milestoneReached',
          tick,
          milestoneId,
          rewardResearchPoints: nonNegative(raw.rewardResearchPoints, `${path}.rewardResearchPoints`, false),
        };
      }
      throw invalidState(OWNER, `${path}.kind`, 'is not a known progression event kind');
    });

    return {
      researchPoints,
      completedRideExperiences,
      completedServiceExperiences,
      highestParkRating,
      completedProjectIds,
      completedMilestoneIds,
      lastRideCompletionCounts,
      lastServiceCompletionCounts,
      pendingEvents,
      nextEventId,
    };
  }
}
