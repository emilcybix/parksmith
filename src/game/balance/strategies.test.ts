import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { RESEARCH_PROJECTS, scaledResearchPoints } from '../progression/content';
import { hashState } from '../save/hash';
import { ParkSession } from '../session/ParkSession';
import { CHEAP_AND_WIDE, ONE_PREMIUM, SERVICE_AND_SCENERY, STRATEGIES } from './strategies';
import {
  formatStrategyRow, healthFailures, researchEarnedBy, runStrategy, sessionWithRules,
  type StrategyDefinition, type StrategyResult, type StrategyRuleOverrides,
} from './strategyBot';

/**
 * Phase 16 (design sections 2, 5 and 9): the three early strategies are healthy, distinct and research-paced on a new
 * Meadow Sandbox park over 45 park minutes, under the FINAL Phase 16 rule values (theme affinity 0.2, research cost
 * scale 10; the design's 0.3 was stepped to 0.2 by the design-10 fallback when a Phase 25 margin broke), and each
 * stays healthy with theme affinity 0 (themes are an edge, never a requirement). The values are passed explicitly
 * through the `rules` hook, so this file does not depend on what GAME_CONFIG currently defaults to.
 * Health: lowest cash >= 0, and over minutes 35 to 45 mean rating >= 60, mean happiness >= 60, mean guests >= 50,
 * operating profit > 0, and every planned ride, stall, bin and toilet built. Six parks at about 1 s each.
 */
const FINAL: StrategyRuleOverrides = { themeAffinity: 0.2, researchCostScale: 10 };
const NO_AFFINITY: StrategyRuleOverrides = { themeAffinity: 0, researchCostScale: 10 };

const cache = new Map<string, StrategyResult>();
const resultOf = (strategy: StrategyDefinition, rules: StrategyRuleOverrides): StrategyResult => {
  const key = `${strategy.id}|${JSON.stringify(rules)}`;
  let result = cache.get(key);
  if (!result) {
    result = runStrategy(strategy, { rules });
    cache.set(key, result);
  }
  return result;
};

const OPENERS = RESEARCH_PROJECTS.filter((project) => project.prerequisiteIds.length === 0);
const openersCost = OPENERS.reduce((sum, project) => sum + scaledResearchPoints(project.researchPointCost, FINAL.researchCostScale!), 0);
const treeCost = RESEARCH_PROJECTS.reduce((sum, project) => sum + scaledResearchPoints(project.researchPointCost, FINAL.researchCostScale!), 0);

describe('Phase 16 strategies: healthy under the final rules', () => {
  it.each(STRATEGIES.map((strategy) => [strategy.id, strategy] as const))('%s is healthy over minutes 35 to 45', (_id, strategy) => {
    const result = resultOf(strategy, FINAL);
    expect(healthFailures(result), formatStrategyRow(result)).toEqual([]);
    expect(result.skipped, 'every placement, scenery included, fits on Meadow').toEqual([]);
  }, 60_000);

  it.each(STRATEGIES.map((strategy) => [strategy.id, strategy] as const))('%s: its opening is the scarce choice (leaves $1,000 to $1,700 of $5,000)', (_id, strategy) => {
    const result = resultOf(strategy, FINAL);
    const left = GAME_CONFIG.startingCash - result.openingSpend;
    expect(left, formatStrategyRow(result)).toBeGreaterThanOrEqual(1_000);
    expect(left, formatStrategyRow(result)).toBeLessThanOrEqual(1_700);
  }, 60_000);
});

describe('Phase 16 strategies: research paces the park (PA-014)', () => {
  it.each(STRATEGIES.map((strategy) => [strategy.id, strategy] as const))('%s buys its first project between 3 and 8 park minutes', (_id, strategy) => {
    const result = resultOf(strategy, FINAL);
    expect(result.purchases.length).toBeGreaterThan(0);
    expect(result.purchases[0].atSeconds, formatStrategyRow(result)).toBeGreaterThanOrEqual(3 * 60);
    expect(result.purchases[0].atSeconds, formatStrategyRow(result)).toBeLessThanOrEqual(8 * 60);
    expect(result.purchases[0].projectId, 'the strategy researches its own priority first').toBe(strategy.research[0]);
  }, 60_000);

  it.each(STRATEGIES.map((strategy) => [strategy.id, strategy] as const))('%s cannot hold all four openers before 12 minutes: its RP cannot pay for them', (_id, strategy) => {
    const result = resultOf(strategy, FINAL);
    expect(OPENERS).toHaveLength(4);
    expect(researchEarnedBy(result, 12 * 60), formatStrategyRow(result)).toBeLessThan(openersCost);
    const openersBy12 = result.purchases.filter((purchase) => purchase.atSeconds < 12 * 60 && OPENERS.some((project) => project.id === purchase.projectId));
    expect(openersBy12.length).toBeLessThan(4);
  }, 60_000);

  it.each(STRATEGIES.map((strategy) => [strategy.id, strategy] as const))('%s does not complete the tree by 45 minutes', (_id, strategy) => {
    const result = resultOf(strategy, FINAL);
    expect(result.purchases.length, formatStrategyRow(result)).toBeLessThan(RESEARCH_PROJECTS.length);
    expect(result.samples[result.samples.length - 1].researchPointsEarned).toBeLessThan(treeCost);
  }, 60_000);
});

describe('Phase 16 strategies: three distinct parks', () => {
  const results = (): StrategyResult[] => STRATEGIES.map((strategy) => resultOf(strategy, FINAL));
  const table = (): string => results().map(formatStrategyRow).join('\n');

  it('cheap-and-wide draws the biggest crowd (mean guests over minutes 35 to 45)', () => {
    const [wide, premium, scenery] = results();
    expect(wide.window.guests, table()).toBeGreaterThan(Math.max(premium.window.guests, scenery.window.guests));
  }, 60_000);

  it('one-premium earns the most ticket revenue per rider', () => {
    const [wide, premium, scenery] = results();
    expect(premium.revenuePerRider, table()).toBeGreaterThan(Math.max(wide.revenuePerRider, scenery.revenuePerRider));
  }, 60_000);

  it('service-and-scenery has the highest scenery score and the steadiest park', () => {
    const [wide, premium, scenery] = results();
    expect(scenery.window.sceneryScore, table()).toBeGreaterThan(Math.max(wide.window.sceneryScore, premium.window.sceneryScore));
    // Steadiness from minute 5 to 45 (standard deviation of per-second values). The rating is the steadiest of the three;
    // happiness is steadier than the wide park's (it ties with one-premium across seeds, so that pair is not asserted).
    expect(scenery.steadiness.rating, table()).toBeLessThan(Math.min(wide.steadiness.rating, premium.steadiness.rating));
    expect(scenery.steadiness.happiness, table()).toBeLessThan(wide.steadiness.happiness);
  }, 60_000);

  it('the strategies are what their names say: their openings differ as designed', () => {
    const openingRides = (strategy: StrategyDefinition): string[] => strategy.opening.map((placement) => placement.definitionId)
      .filter((id) => ['puddle-jumpers', 'moonpetal-carousel', 'petal-roundabout', 'rocket-pendulum'].includes(id));
    expect(openingRides(CHEAP_AND_WIDE)).toHaveLength(3);
    expect(openingRides(ONE_PREMIUM)).toEqual(['rocket-pendulum']);
    expect(SERVICE_AND_SCENERY.opening.filter((placement) => 'at' in placement).length).toBeGreaterThanOrEqual(8);
  });
});

describe('Phase 16 strategies: theme affinity is never a requirement', () => {
  it.each(STRATEGIES.map((strategy) => [strategy.id, strategy] as const))('%s is healthy with theme affinity 0', (_id, strategy) => {
    const result = resultOf(strategy, NO_AFFINITY);
    expect(healthFailures(result), formatStrategyRow(result)).toEqual([]);
  }, 60_000);

  it('the rules hook reaches the park: affinity raises the themed park\'s scenery score, and only that', () => {
    const themed = resultOf(SERVICE_AND_SCENERY, FINAL);
    const plain = resultOf(SERVICE_AND_SCENERY, NO_AFFINITY);
    expect(themed.window.sceneryScore).toBeGreaterThan(plain.window.sceneryScore);
    // The two scenery-less strategies have no themed scenery: affinity cannot change them at all.
    for (const strategy of [CHEAP_AND_WIDE, ONE_PREMIUM]) {
      expect(resultOf(strategy, FINAL).samples).toEqual(resultOf(strategy, NO_AFFINITY).samples);
    }
  }, 60_000);

  it('rebuilding a park with its own compiled ruleset is inert (the hook adds nothing but the overrides)', () => {
    // Maple Ridge: its biome sets a non-default Sandbox clock, which the rebuild must reapply.
    const build = (rules?: ParkSession['rules']): ParkSession => new ParkSession(null, [], { mapId: 'maple-ridge', ...(rules ? { rules } : {}) });
    const plain = build();
    const rebuilt = sessionWithRules(build, {
      themeAffinity: plain.rules.themeAffinity ?? 0,
      researchCostScale: plain.rules.researchCostScale ?? 1,
    });
    for (let tick = 0; tick < 600; tick += 1) {
      plain.step(GAME_CONFIG.fixedStepMs);
      rebuilt.step(GAME_CONFIG.fixedStepMs);
    }
    expect(hashState(rebuilt.serialize())).toBe(hashState(plain.serialize()));
  }, 60_000);
});
