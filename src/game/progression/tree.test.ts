import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 16 (design 5 and 9): the research tree regrown to 14 projects, and the research cost scale. The config's scale
 * is mocked (a getter over `knobs`) so one file can build parks at scale 1 (neutral, what W1 ships) and at scale 10
 * (what a new park compiles once Phase 16 is switched on): the base layer reads it at compile time.
 */
const knobs = vi.hoisted(() => ({ scale: 1 }));
vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  const config = actual.GAME_CONFIG;
  return {
    ...actual,
    GAME_CONFIG: {
      ...config,
      research: {
        ...config.research,
        get costScale() { return knobs.scale; },
      },
    },
  };
});

const { applyOneShot } = await import('../cards/effects');
const { CARD_BY_ID } = await import('../cards/content');
const { BUILD_CATALOG } = await import('../content/catalog');
const { ParkSession } = await import('../session/ParkSession');
const { PROJECT_BY_BUILD_ID, RESEARCH_MILESTONES, RESEARCH_PROJECT_BY_ID, RESEARCH_PROJECTS, researchBranchOf, scaledResearchPoints } = await import('./content');

const withScale = <T>(scale: number, build: () => T): T => {
  knobs.scale = scale;
  try {
    return build();
  } finally {
    knobs.scale = 1;
  }
};

const childrenOf = (id: string) => RESEARCH_PROJECTS.filter((project) => (project.prerequisiteIds as readonly string[]).includes(id));

describe('Phase 16 research tree', () => {
  it('has 14 projects: the nine older ones in place, the five new ones appended', () => {
    expect(RESEARCH_PROJECTS.map((project) => project.id)).toEqual([
      'spin-studies', 'express-service', 'garden-appeal', 'vertical-motion', 'guest-flow', 'skyline-engineering',
      'family-favorites', 'water-works', 'thrill-engineering',
      'refreshment-lab', 'temple-expeditions', 'seaside-styling', 'adventure-styling', 'future-styling',
      // Phase 39: the coaster families, appended.
      'tight-turns', 'timber-framing', 'launch-lab', 'suspended-track',
      // Phase 45.
      'hyper-engineering',
    ]);
    expect(new Set(RESEARCH_PROJECTS.map((project) => project.id)).size).toBe(19);
  });

  it('the new projects are exactly the design table (base RP, cash, prerequisite, milestone, unlocks)', () => {
    const row = (id: string) => {
      const project = RESEARCH_PROJECT_BY_ID.get(id as never)!;
      return [project.tier, project.name, project.category, project.researchPointCost, project.cashCost, project.prerequisiteIds, project.requiredMilestoneIds, project.unlockDefinitionIds];
    };
    expect(row('refreshment-lab')).toEqual([2, 'Refreshment Lab', 'services', 55, 500, ['express-service'], [], ['coconut-cove']]);
    expect(row('temple-expeditions')).toEqual([2, 'Temple Expeditions', 'rides', 80, 900, ['family-favorites'], [], ['temple-trek']]);
    expect(row('seaside-styling')).toEqual([2, 'Seaside Styling', 'decoration', 45, 450, ['garden-appeal'], [], ['shell-planter', 'harbor-lighthouse']]);
    expect(row('adventure-styling')).toEqual([2, 'Adventure Styling', 'decoration', 45, 450, ['garden-appeal'], [], ['tiki-torch', 'jungle-idol']]);
    expect(row('future-styling')).toEqual([2, 'Future Styling', 'decoration', 60, 700, ['garden-appeal'], ['rating-60'], ['neon-pylon', 'orbit-globe']]);
  });

  it('the prerequisite graph is acyclic, and a tier is one more than its deepest prerequisite (openers are tier 1)', () => {
    for (const project of RESEARCH_PROJECTS) {
      const seen = new Set<string>();
      const walk = (id: string): void => {
        expect(seen.has(id), `cycle through ${id}`).toBe(false);
        seen.add(id);
        for (const next of RESEARCH_PROJECT_BY_ID.get(id as never)!.prerequisiteIds) walk(next);
        seen.delete(id);
      };
      walk(project.id);
      const deepest = Math.max(0, ...project.prerequisiteIds.map((id) => RESEARCH_PROJECT_BY_ID.get(id)!.tier));
      expect(project.tier, project.id).toBe(deepest + 1);
    }
  });

  it('every non-gated, non-free catalog entry has exactly one project; no project unlocks a gated or unknown entry', () => {
    const unlocks = RESEARCH_PROJECTS.flatMap((project) => project.unlockDefinitionIds);
    expect(new Set(unlocks).size).toBe(unlocks.length);
    const byId = new Map(BUILD_CATALOG.map((definition) => [definition.id, definition]));
    for (const id of unlocks) {
      expect(byId.has(id), id).toBe(true);
      expect(byId.get(id)?.profileGate, id).toBeUndefined();
    }
    // The free first-park set: what a new Sandbox can build without research or a profile unlock.
    const free = BUILD_CATALOG.filter((definition) => !definition.profileGate && !PROJECT_BY_BUILD_ID.has(definition.id)).map((definition) => definition.id);
    expect(free).toEqual([
      'sunstone-path', 'petal-roundabout', 'moonpetal-carousel', 'harbor-swings', 'comet-trail', 'star-chaser',
      'picnic-pocket', 'fizz-foundry', 'glacier-scoop', 'lemon-light', 'comfort-cabin', 'ribbon-bench', 'tidy-totem',
      'lollipop-lamp', 'confetti-tree', 'sunburst-flowers',
      'puddle-jumpers', 'rocket-pendulum', 'pretzel-pram', 'bunting-mast',
      // Phase 29: every souvenir stall and the warm drink barrow are free from the first park.
      'brolly-booth', 'hat-hutch', 'balloon-bouquet', 'plushie-parlour', 'glow-cart', 'bean-barrow',
    ]);
  });

  it('RP is non-decreasing by tier, and the tier totals are the design\'s (base and at scale 10)', () => {
    const costsOf = (tier: number) => RESEARCH_PROJECTS.filter((project) => project.tier === tier).map((project) => project.researchPointCost);
    expect(Math.max(...costsOf(1))).toBeLessThanOrEqual(Math.min(...costsOf(2)));
    expect(Math.max(...costsOf(2))).toBeLessThanOrEqual(Math.min(...costsOf(3)));
    const total = (tier: number) => costsOf(tier).reduce((sum, cost) => sum + scaledResearchPoints(cost, 10), 0);
    // Phase 39 adds two tier-2 projects (500 and 700 RP at scale 10) and, step 2, Launch Lab at tier 3 (1,000), step 3, Suspended Track at tier 3 (1,050);
    // Phase 45 Hyper Engineering at tier 3 (1,200).
    expect([total(1), total(2), total(3)]).toEqual([1_250, 6_050, 5_300]);
    // The design rounds this to "$9,000"; the per-project cash costs of its table sum to $8,950, plus Phase 39's $3,750 and Phase 45's $1,500.
    expect(RESEARCH_PROJECTS.reduce((sum, project) => sum + project.cashCost, 0)).toBe(14_200);
  });

  it('every opener forks (Phase 39) at the next tier, and every project belongs to an opener\'s branch', () => {
    const openers = RESEARCH_PROJECTS.filter((project) => project.tier === 1);
    expect(openers.map((project) => project.id)).toEqual(['spin-studies', 'express-service', 'garden-appeal', 'family-favorites']);
    // Phase 39: Tight Turns gave Spin Studies its second fork, so now every opener forks.
    expect(openers.filter((project) => childrenOf(project.id).length < 2).map((project) => project.id)).toEqual([]);
    // Phase 39 step 2: Launch Lab is Vertical Motion's third fork; Phase 45 Hyper Engineering its fourth.
    expect(childrenOf('vertical-motion').length).toBe(4);
    for (const project of RESEARCH_PROJECTS) {
      expect(openers.map((opener) => opener.id), project.id).toContain(researchBranchOf(project.id));
    }
    expect(researchBranchOf('thrill-engineering')).toBe('spin-studies');
    expect(researchBranchOf('future-styling')).toBe('garden-appeal');
  });
});

describe('Phase 16 research cost scale', () => {
  it('the effective cost is round(base x scale); scale 1 is exactly the base', () => {
    expect(scaledResearchPoints(25, 1)).toBe(25);
    expect(scaledResearchPoints(25, 10)).toBe(250);
    expect(scaledResearchPoints(55, 2.5)).toBe(138);
  });

  it('a park at scale 10 shows and charges round(base x 10); cash costs are unscaled', () => {
    const session = withScale(10, () => new ParkSession(null));
    expect(session.rules.researchCostScale).toBe(10);
    expect(session.progression.researchCostScale).toBe(10);
    const snapshot = session.progression.snapshot();
    for (const project of snapshot.projects) {
      const base = RESEARCH_PROJECT_BY_ID.get(project.id)!;
      expect(project.researchPointCost, project.id).toBe(Math.round(base.researchPointCost * 10));
      expect(project.cashCost, project.id).toBe(base.cashCost);
      expect(project.tier, project.id).toBe(base.tier);
    }
    expect(session.progression.purchase('garden-appeal')).toEqual({ ok: false, reason: 'insufficient-rp' });
    session.progression.grantResearchPoints(249);
    expect(session.progression.purchase('garden-appeal')).toEqual({ ok: false, reason: 'insufficient-rp' });
    session.progression.grantResearchPoints(1);
    const result = session.progression.purchase('garden-appeal');
    expect(result).toMatchObject({ ok: true, researchPointsSpent: 250, cashSpent: 250 });
    expect(session.progression.snapshot().researchPoints).toBe(0);
    const [event] = session.progression.drainEvents();
    expect(event).toMatchObject({ kind: 'researchCompleted', researchPointsSpent: 250 });
  });

  it('a park at scale 1 (neutral) writes no key and charges the base cost', () => {
    const session = withScale(1, () => new ParkSession(null));
    expect('researchCostScale' in session.rules).toBe(false);
    expect(session.progression.researchCostScale).toBe(1);
    session.progression.grantResearchPoints(25);
    expect(session.progression.purchase('garden-appeal')).toMatchObject({ ok: true, researchPointsSpent: 25 });
  });

  it('milestone rewards are unscaled', () => {
    const session = withScale(10, () => new ParkSession(null));
    const milestones = session.progression.snapshot().milestones;
    expect(milestones.map((milestone) => milestone.rewardResearchPoints)).toEqual(RESEARCH_MILESTONES.map((milestone) => milestone.rewardResearchPoints));
    expect(milestones.reduce((sum, milestone) => sum + milestone.rewardResearchPoints, 0)).toBe(150);
  });

  it('the profile Research grant bonus (15 base RP, saved as 15) grants base x scale to a new park', () => {
    const grant = { unlockedBuildingIds: [], bonusIds: ['research-grant' as const] };
    const scaled = withScale(10, () => new ParkSession(null, [], { grant }));
    expect(scaled.rules.startingResearchPoints).toBe(15);
    expect(scaled.progression.snapshot().researchPoints).toBe(150);
    const neutral = withScale(1, () => new ParkSession(null, [], { grant }));
    expect(neutral.progression.snapshot().researchPoints).toBe(15);
  });

  it('the Research Grant card (20 base RP) grants base x the park\'s scale through the session\'s progression', () => {
    const card = CARD_BY_ID.get('research-grant')!;
    if (card.kind !== 'one-shot') throw new Error('research-grant is a one-shot');
    for (const [scale, expected] of [[1, 20], [10, 200]] as const) {
      const session = withScale(scale, () => new ParkSession(null));
      const host = {
        levelRunning: () => true, cash: () => session.world.cash, tick: () => session.world.tick,
        postTransaction: (amount: number, label: string, category: 'research') => session.world.postTransaction(amount, label, category),
        grantResearchPoints: (points: number) => session.progression.grantResearchPoints(points),
        researchCostScale: () => session.progression.researchCostScale,
      } as unknown as Parameters<typeof applyOneShot>[1];
      applyOneShot(card.effect, host, card.name);
      expect(session.progression.snapshot().researchPoints, `scale ${scale}`).toBe(expected);
    }
  });
});
