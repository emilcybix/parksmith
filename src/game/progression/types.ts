export type ResearchCategory = 'rides' | 'services' | 'decoration';

export type ResearchProjectId =
  | 'spin-studies'
  | 'express-service'
  | 'garden-appeal'
  | 'vertical-motion'
  | 'guest-flow'
  | 'skyline-engineering'
  | 'family-favorites'
  | 'water-works'
  | 'thrill-engineering'
  // Phase 16
  | 'refreshment-lab'
  | 'temple-expeditions'
  | 'seaside-styling'
  | 'adventure-styling'
  | 'future-styling'
  // Phase 39
  | 'tight-turns'
  | 'timber-framing'
  | 'launch-lab';

/** Phase 16: 1 = an opener (no prerequisite), 2 = its fork, 3 = the late tier. */
export type ResearchTier = 1 | 2 | 3;

export type ResearchMilestoneId =
  | 'experiences-25'
  | 'experiences-100'
  | 'experiences-250'
  | 'rating-60'
  | 'rating-70';

export type ResearchMilestoneMetric = 'experiences' | 'rating';
export type ResearchProjectStatus = 'locked' | 'available' | 'affordable' | 'completed';

export interface ResearchProjectDefinition {
  id: ResearchProjectId;
  tier: ResearchTier;
  name: string;
  category: ResearchCategory;
  description: string;
  researchPointCost: number;
  cashCost: number;
  prerequisiteIds: readonly ResearchProjectId[];
  requiredMilestoneIds: readonly ResearchMilestoneId[];
  unlockDefinitionIds: readonly string[];
}

export interface ResearchMilestoneDefinition {
  id: ResearchMilestoneId;
  name: string;
  description: string;
  metric: ResearchMilestoneMetric;
  target: number;
  rewardResearchPoints: number;
}

export interface ResearchProjectSnapshot {
  id: ResearchProjectId;
  tier: ResearchTier;
  name: string;
  category: ResearchCategory;
  description: string;
  /** The EFFECTIVE RP cost in this park: round(base x the ruleset's researchCostScale). */
  researchPointCost: number;
  cashCost: number;
  prerequisiteIds: ResearchProjectId[];
  requiredMilestoneIds: ResearchMilestoneId[];
  unlockDefinitionIds: string[];
  status: ResearchProjectStatus;
  missingPrerequisiteIds: ResearchProjectId[];
  missingMilestoneIds: ResearchMilestoneId[];
  researchPointsRemaining: number;
  cashRemaining: number;
}

export interface ResearchMilestoneSnapshot {
  id: ResearchMilestoneId;
  name: string;
  description: string;
  metric: ResearchMilestoneMetric;
  target: number;
  rewardResearchPoints: number;
  progress: number;
  completed: boolean;
}

export interface ProgressionSnapshot {
  researchPoints: number;
  completedExperiences: number;
  completedRideExperiences: number;
  completedServiceExperiences: number;
  completedProjectIds: ResearchProjectId[];
  unlockedDefinitionIds: string[];
  projects: ResearchProjectSnapshot[];
  milestones: ResearchMilestoneSnapshot[];
}

export type ResearchPurchaseFailureReason =
  | 'missing'
  | 'completed'
  | 'locked'
  | 'insufficient-rp'
  | 'insufficient-cash';

export type ResearchPurchaseResult =
  | {
    ok: true;
    projectId: ResearchProjectId;
    unlockedDefinitionIds: string[];
    researchPointsSpent: number;
    cashSpent: number;
  }
  | {
    ok: false;
    reason: ResearchPurchaseFailureReason;
  };

interface ProgressionEventBase {
  id: number;
  tick: number;
}

export interface ResearchCompletedEvent extends ProgressionEventBase {
  kind: 'researchCompleted';
  projectId: ResearchProjectId;
  unlockedDefinitionIds: string[];
  researchPointsSpent: number;
  cashSpent: number;
}

export interface ResearchMilestoneReachedEvent extends ProgressionEventBase {
  kind: 'milestoneReached';
  milestoneId: ResearchMilestoneId;
  rewardResearchPoints: number;
}

export type ProgressionEvent = ResearchCompletedEvent | ResearchMilestoneReachedEvent;
