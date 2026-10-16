import type {
  ResearchMilestoneDefinition,
  ResearchMilestoneId,
  ResearchProjectDefinition,
  ResearchProjectId,
} from './types';

export const RESEARCH_PROJECTS: readonly ResearchProjectDefinition[] = [
  {
    id: 'spin-studies',
    tier: 1,
    name: 'Spin Studies',
    category: 'rides',
    description: 'Turn guest reactions into a playful spinning attraction.',
    researchPointCost: 30,
    cashCost: 300,
    prerequisiteIds: [],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['comet-cups'],
  },
  {
    id: 'express-service',
    tier: 1,
    name: 'Express Service',
    category: 'services',
    description: 'Develop a compact counter for shorter food queues.',
    researchPointCost: 30,
    cashCost: 250,
    prerequisiteIds: [],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['snack-sprint'],
  },
  {
    id: 'garden-appeal',
    tier: 1,
    name: 'Garden Appeal',
    category: 'decoration',
    description: 'Study gathering places and unlock a landmark fountain.',
    researchPointCost: 25,
    cashCost: 250,
    prerequisiteIds: [],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['ripple-fountain'],
  },
  {
    id: 'vertical-motion',
    tier: 2,
    name: 'Vertical Motion',
    category: 'rides',
    description: 'Build on spin research to send guests skyward — and design taller coasters.',
    researchPointCost: 65,
    cashCost: 750,
    prerequisiteIds: ['spin-studies'],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['cloud-hopper', 'skyline-serpent'],
  },
  {
    id: 'guest-flow',
    tier: 2,
    name: 'Guest Flow',
    category: 'services',
    description: 'Apply faster service methods to a higher-throughput facility.',
    researchPointCost: 60,
    cashCost: 650,
    prerequisiteIds: ['express-service'],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['comfort-pavilion'],
  },
  {
    id: 'skyline-engineering',
    tier: 3,
    name: 'Skyline Engineering',
    category: 'rides',
    description: 'Crown a proven park with a glowing skyline landmark.',
    researchPointCost: 110,
    cashCost: 1_400,
    prerequisiteIds: ['vertical-motion'],
    requiredMilestoneIds: ['rating-70'],
    unlockDefinitionIds: ['aurora-wheel'],
  },
  {
    id: 'family-favorites',
    tier: 1,
    name: 'Family Favorites',
    category: 'rides',
    description: 'Round out the park with a touring train and hearty waffles.',
    researchPointCost: 40,
    cashCost: 400,
    prerequisiteIds: [],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['bumble-coach', 'waffle-windmill'],
  },
  {
    id: 'water-works',
    tier: 2,
    name: 'Water Works',
    category: 'rides',
    description: 'Engineer a splashing channel ride for warm afternoons.',
    researchPointCost: 75,
    cashCost: 850,
    prerequisiteIds: ['family-favorites'],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['splash-rings'],
  },
  {
    id: 'thrill-engineering',
    tier: 3,
    name: 'Thrill Engineering',
    category: 'rides',
    description: 'Push intensity to the limit for the bravest guests.',
    researchPointCost: 95,
    cashCost: 1_100,
    prerequisiteIds: ['vertical-motion'],
    requiredMilestoneIds: ['rating-60'],
    unlockDefinitionIds: ['gale-spinner', 'thunder-drum'],
  },
  // Phase 16: the tree regrown. APPENDED (no building moves project: PROJECT_BY_BUILD_ID is read live by old saves).
  // RP costs are BASE units: a park pays round(base x its ruleset's researchCostScale).
  {
    id: 'refreshment-lab',
    tier: 2,
    name: 'Refreshment Lab',
    category: 'services',
    description: 'Perfect a slow, premium cooler that truly quenches thirst.',
    researchPointCost: 55,
    cashCost: 500,
    prerequisiteIds: ['express-service'],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['coconut-cove'],
  },
  {
    id: 'temple-expeditions',
    tier: 2,
    name: 'Temple Expeditions',
    category: 'rides',
    description: 'Send the family crowd on a covered cart ride into a lost temple.',
    researchPointCost: 80,
    cashCost: 900,
    prerequisiteIds: ['family-favorites'],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['temple-trek'],
  },
  {
    id: 'seaside-styling',
    tier: 2,
    name: 'Seaside Styling',
    category: 'decoration',
    description: 'Bring the coast inland with shell planters and a harbor lighthouse.',
    researchPointCost: 45,
    cashCost: 450,
    prerequisiteIds: ['garden-appeal'],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['shell-planter', 'harbor-lighthouse'],
  },
  {
    id: 'adventure-styling',
    tier: 2,
    name: 'Adventure Styling',
    category: 'decoration',
    description: 'Light the trail with tiki torches and a mossy jungle idol.',
    researchPointCost: 45,
    cashCost: 450,
    prerequisiteIds: ['garden-appeal'],
    requiredMilestoneIds: [],
    unlockDefinitionIds: ['tiki-torch', 'jungle-idol'],
  },
  {
    id: 'future-styling',
    tier: 2,
    name: 'Future Styling',
    category: 'decoration',
    description: 'Neon pylons and a ringed orbit globe for a park on the rise.',
    researchPointCost: 60,
    cashCost: 700,
    prerequisiteIds: ['garden-appeal'],
    requiredMilestoneIds: ['rating-60'],
    unlockDefinitionIds: ['neon-pylon', 'orbit-globe'],
  },
] as const;

export const RESEARCH_PROJECT_BY_ID = new Map<ResearchProjectId, ResearchProjectDefinition>(
  RESEARCH_PROJECTS.map((project) => [project.id, project]),
);

export const PROJECT_BY_BUILD_ID = new Map<string, ResearchProjectId>(
  RESEARCH_PROJECTS.flatMap((project) =>
    project.unlockDefinitionIds.map((definitionId) => [definitionId, project.id] as const),
  ),
);

/**
 * Phase 16: the branch of a project is the tier-1 opener its prerequisite chain starts from (an opener is its own
 * branch). Derived, for grouping in the research panel.
 */
export const researchBranchOf = (projectId: ResearchProjectId): ResearchProjectId => {
  let project = RESEARCH_PROJECT_BY_ID.get(projectId);
  let branch = projectId;
  while (project && project.prerequisiteIds.length > 0) {
    branch = project.prerequisiteIds[0];
    project = RESEARCH_PROJECT_BY_ID.get(branch);
  }
  return branch;
};

/** Phase 16: the effective RP cost of a base cost under a ruleset's research cost scale (scale 1 = the base, exactly). */
export const scaledResearchPoints = (base: number, scale: number): number => (scale === 1 ? base : Math.round(base * scale));

export const RESEARCH_MILESTONES: readonly ResearchMilestoneDefinition[] = [
  {
    id: 'experiences-25',
    name: 'First Findings',
    description: 'Complete 25 guest experiences.',
    metric: 'experiences',
    target: 25,
    rewardResearchPoints: 15,
  },
  {
    id: 'experiences-100',
    name: 'Growing Knowledge',
    description: 'Complete 100 guest experiences.',
    metric: 'experiences',
    target: 100,
    rewardResearchPoints: 30,
  },
  {
    id: 'experiences-250',
    name: 'Park Laboratory',
    description: 'Complete 250 guest experiences.',
    metric: 'experiences',
    target: 250,
    rewardResearchPoints: 50,
  },
  {
    id: 'rating-60',
    name: 'Rising Reputation',
    description: 'Reach a park rating of 60.',
    metric: 'rating',
    target: 60,
    rewardResearchPoints: 20,
  },
  {
    id: 'rating-70',
    name: 'Destination Park',
    description: 'Reach a park rating of 70.',
    metric: 'rating',
    target: 70,
    rewardResearchPoints: 35,
  },
] as const;

export const RESEARCH_MILESTONE_BY_ID = new Map<ResearchMilestoneId, ResearchMilestoneDefinition>(
  RESEARCH_MILESTONES.map((milestone) => [milestone.id, milestone]),
);
