import { describe, expect, it } from 'vitest';
import { sessionWithRules } from '../balance/strategyBot';
import { PULSE_CARDS } from '../cards/content';
import { SCENERY_THEME_IDS } from '../types';
import { RUN_CONDITIONS, combinedConditionRules, lockedIdsOf } from '../run/content';
import { startStage } from '../run/deck';
import { essentialSkips, marginOf, withinMargin } from '../run/runBot';
import { buildStage } from '../run/stage';
import { testRunAtLevel } from '../run/testSupport';
import { EMPTY_GRANT, ParkSession } from '../session/ParkSession';
import { richPlan, WINNING_PLANS } from './bot/plans';
import { runBotOnSession } from './bot/scenarioBot';
import { SCENARIOS } from './content';
import { CARD_MODIFIABLE_RULES, PHASE16_RULE_KEYS, type ParkRuleset } from './rules';

/**
 * Phase 16 (design 4.1 and 9): theme affinity is an edge, never a requirement. Statically, no card, scenario rule,
 * objective, scenario setup or run table can name a theme or the affinity key. Dynamically, the scripted players of
 * Phase 22 and 23 (which never place themed scenery on purpose) clear every scenario and the pinned no-card run stages
 * with the affinity forced to 0 through the `rules` hook, whatever GAME_CONFIG defaults it to.
 */
const NO_AFFINITY = { themeAffinity: 0 } as const;
const THEME_WORD = /theme/i;

describe('theme affinity is not a requirement, structurally', () => {
  it('no card can modify a Phase 16 key, and no card names a theme', () => {
    for (const key of PHASE16_RULE_KEYS) expect((CARD_MODIFIABLE_RULES as readonly string[]).includes(key), key).toBe(false);
    for (const key of CARD_MODIFIABLE_RULES) expect(THEME_WORD.test(key), key).toBe(false);
    for (const card of PULSE_CARDS) {
      for (const key of Object.keys(card.modifiers)) {
        expect(THEME_WORD.test(key) || (PHASE16_RULE_KEYS as readonly string[]).includes(key), `${card.id} modifies ${key}`).toBe(false);
      }
      expect(THEME_WORD.test(JSON.stringify(card)), `${card.id} mentions a theme`).toBe(false);
    }
  });

  it('no scenario rule, objective or setup names a theme', () => {
    for (const scenario of SCENARIOS) {
      for (const key of Object.keys(scenario.rules)) {
        expect(THEME_WORD.test(key) || (PHASE16_RULE_KEYS as readonly string[]).includes(key), `${scenario.id} rule ${key}`).toBe(false);
      }
      const objective = JSON.stringify(scenario.objective);
      expect(THEME_WORD.test(objective), `${scenario.id} objective`).toBe(false);
      for (const theme of SCENERY_THEME_IDS) expect(objective.includes(`"${theme}"`), `${scenario.id} objective names ${theme}`).toBe(false);
      expect(THEME_WORD.test(JSON.stringify(scenario.setup)), `${scenario.id} setup`).toBe(false);
    }
  });

  it('no run condition, level objective or level table names a theme', () => {
    for (const condition of RUN_CONDITIONS) {
      expect(THEME_WORD.test(JSON.stringify(condition)), condition.id).toBe(false);
      const rules = combinedConditionRules([condition.id]);
      for (const key of PHASE16_RULE_KEYS) expect(key in rules, `${condition.id} sets ${key}`).toBe(false);
    }
    for (const seed of [1, 2, 3, 4]) {
      const run = testRunAtLevel(0, { seed, difficulty: 'standard' });
      for (const level of run.levels) {
        expect(THEME_WORD.test(JSON.stringify(level)), `seed ${seed} level`).toBe(false);
        for (const theme of SCENERY_THEME_IDS) expect(JSON.stringify(level.objective).includes(`"${theme}"`)).toBe(false);
      }
    }
  });

  it('the objective, scenario and run sources never mention a theme (no theme parameter can exist)', () => {
    const sources = import.meta.glob<string>(['./types.ts', './content.ts', '../run/types.ts', '../run/content.ts'], { import: 'default', query: '?raw', eager: true });
    expect(Object.keys(sources)).toHaveLength(4);
    for (const [file, source] of Object.entries(sources)) expect(THEME_WORD.test(source), file).toBe(false);
  });
});

describe('theme affinity is not a requirement: every scenario clears with affinity 0', () => {
  const MARGIN = 0.85;
  it.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))('%s: the winning plan clears within 0.85 of the deadline', (_id, scenario) => {
    const session = sessionWithRules((rules?: ParkRuleset) => new ParkSession(scenario, [], {
      mode: 'scenario', grant: EMPTY_GRANT, ...(rules ? { rules } : {}),
    }), NO_AFFINITY);
    expect(session.rules.themeAffinity ?? 0).toBe(0);
    const result = runBotOnSession(session, WINNING_PLANS[scenario.id]);
    expect(result.skipped).toEqual([]);
    expect(result.status).toBe('succeeded');
    expect(result.completedAtSeconds!).toBeLessThanOrEqual(scenario.timeLimitSeconds * MARGIN);
    expect(result.minimumCash).toBeGreaterThanOrEqual(0);
  }, 120_000);
});

describe('theme affinity is not a requirement: the pinned no-card run stages clear with affinity 0', () => {
  const cases = [1, 2, 3, 4].flatMap((seed) => [0, 4].map((levelIndex) => [seed, levelIndex] as const));
  it.each(cases)('seed %i Standard level index %i clears within the margin', (seed, levelIndex) => {
    const run = testRunAtLevel(levelIndex, { seed, difficulty: 'standard' });
    const started = startStage(run, []);
    if (!started.ok) throw new Error(started.reason);
    const level = started.run.levels[started.run.levelIndex];
    const { definition, layout } = buildStage(started.run, started.run.levelIndex);
    const session = sessionWithRules((rules?: ParkRuleset) => new ParkSession(definition, [], {
      mode: 'run', grant: started.run.grant, layout, run: started.run, ...(rules ? { rules } : {}),
    }), NO_AFFINITY);
    expect(session.rules.themeAffinity ?? 0).toBe(0);
    const result = runBotOnSession(session, richPlan(lockedIdsOf(level.conditionIds)));
    const row = `seed ${seed} L${levelIndex + 1} ${level.family}: ${result.status} at ${result.completedAtSeconds}s of ${definition.timeLimitSeconds}s, min cash ${Math.round(result.minimumCash)}, skips ${essentialSkips(result).join(',') || '-'}`;
    expect(withinMargin(result, definition.timeLimitSeconds, marginOf(run)), row).toBe(true);
  }, 120_000);
});
