import { describe, expect, it } from 'vitest';
import { SCENARIOS } from './content';
import { LAZY_PLAN, WINNING_PLANS, delayPlan } from './bot/plans';
import { runBot } from './bot/scenarioBot';

/**
 * Phase 22: every scenario is winnable by a scripted player who uses NOTHING a profile could have earned: no Pulse Card,
 * no profile unlock, no permanent bonus, no research (BALANCE_NOTES, "Phase 22 scenarios (PROVISIONAL)"). The bot builds only
 * what is open at park start and plays on the same simulation the player does.
 */
const MARGIN = 0.85;

describe.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))('%s is winnable without cards, unlocks or bonuses', (_id, scenario) => {
  it('the scripted plan clears it with margin and never goes broke', () => {
    const result = runBot(scenario, WINNING_PLANS[scenario.id]);
    expect(result.skipped, 'every placement of the plan was built').toEqual([]);
    expect(result.status).toBe('succeeded');
    expect(result.completedAtSeconds!).toBeLessThanOrEqual(scenario.timeLimitSeconds * MARGIN);
    expect(result.minimumCash, 'the plan never goes into debt').toBeGreaterThanOrEqual(0);
  }, 180_000);

  // One seed and buildings at tick 0 prove one point, not a strategy: the same plan must also clear with the margin on
  // other seeds and when a human needs time to build it (Phase 22 review: a rating sustain was won or lost by luck).
  it.each([
    ['seed +1', 1, 0], ['seed +2', 2, 0], ['seed +3', 3, 0],
    ['30 s late', 0, 30], ['90 s late', 0, 90], ['240 s late', 0, 240],
  ] as const)('the plan still clears with margin: %s', (_label, seedStep, delaySeconds) => {
    const variant = { ...scenario, seed: (scenario.seed + seedStep * 7919) >>> 0 };
    const plan = delaySeconds === 0 ? WINNING_PLANS[scenario.id] : delayPlan(WINNING_PLANS[scenario.id], delaySeconds);
    const result = runBot(variant, plan);
    expect(result.skipped).toEqual([]);
    expect(result.status).toBe('succeeded');
    expect(result.completedAtSeconds!).toBeLessThanOrEqual(scenario.timeLimitSeconds * MARGIN);
  }, 180_000);

  it('a lazy bot (the setup stub plus four path tiles, nothing else) fails: the scenario is not trivial', () => {
    const result = runBot(scenario, LAZY_PLAN);
    expect(result.status).toBe('failed');
    expect(result.completedAtSeconds).toBe(scenario.timeLimitSeconds);
  }, 180_000);

  it('the same plan run twice clears on the same tick, with the same cash floor', () => {
    const first = runBot(scenario, WINNING_PLANS[scenario.id]);
    const second = runBot(scenario, WINNING_PLANS[scenario.id]);
    expect(second.completedAtSeconds).toBe(first.completedAtSeconds);
    expect(second.minimumCash).toBe(first.minimumCash);
    expect(second.guestsPeak).toBe(first.guestsPeak);
  }, 180_000);
});
