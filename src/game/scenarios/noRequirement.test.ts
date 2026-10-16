import { describe, expect, it } from 'vitest';
import { PULSE_CARDS } from '../cards/content';
import { BONUS_IDS } from '../profile/bonuses';
import { PROFILE_GATED_IDS, isProfileGated } from '../profile/unlocks';
import { ProfileManager } from '../profile/ProfileManager';
import { SCENARIOS } from './content';
import { compileParkRules } from './rules';
import type { ScenarioDefinition, ScenarioId } from './types';
import { isScenarioUnlocked } from './unlock';
import { ParkSession } from '../session/ParkSession';

/**
 * Phase 22, "no scenario requires a bonus, an unlock or a specific card". Rewards are alternatives and conveniences,
 * never gates: this file proves it structurally (the types and data cannot say it), by reachability from a brand-new
 * profile, and by the winnability bot (scenarios/winnability.test.ts), which clears every scenario with nothing earned.
 */
const textOf = (scenario: ScenarioDefinition): string => JSON.stringify({
  setup: scenario.setup, objective: scenario.objective, rules: scenario.rules, constraint: scenario.constraint, unlockedBy: scenario.unlockedBy,
});

describe('no requirement, structurally', () => {
  it('unlock conditions are scenario clears and nothing else (the type has no card, bonus or building)', () => {
    for (const scenario of SCENARIOS) {
      const condition = scenario.unlockedBy;
      expect(['always', 'clear-any']).toContain(condition.kind);
      expect(Object.keys(condition).sort(), scenario.id).toEqual(condition.kind === 'always' ? ['kind'] : ['kind', 'scenarioIds']);
    }
  });

  it('no setup, objective, rule or constraint mentions a gated building, a bonus or a card', () => {
    const names = [...PROFILE_GATED_IDS, ...BONUS_IDS, ...PULSE_CARDS.map((card) => card.id)];
    for (const scenario of SCENARIOS) {
      const text = textOf(scenario);
      for (const id of names) expect(text.includes(id), `${scenario.id} mentions ${id}`).toBe(false);
      for (const object of scenario.setup.objects) expect(isProfileGated(object.definitionId)).toBe(false);
      expect((scenario.rules.lockedDefinitionIds ?? []).some(isProfileGated), `${scenario.id} locks a gated id`).toBe(false);
    }
  });

  it('a scenario never locks the only way to do something a card or unlock could otherwise give (locks are the base catalogue ones)', () => {
    for (const scenario of SCENARIOS) {
      const compiled = compileParkRules(scenario.rules);
      expect(compiled.lockedDefinitionIds.every((id) => !isProfileGated(id)), scenario.id).toBe(true);
    }
  });

  it('a brand-new profile reaches every scenario through clears alone, with no bonus, unlock or card', () => {
    const cleared = new Set<ScenarioId>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const scenario of SCENARIOS) {
        if (!cleared.has(scenario.id) && isScenarioUnlocked(scenario, cleared)) { cleared.add(scenario.id); progressed = true; }
      }
    }
    expect(cleared.size).toBe(SCENARIOS.length);
    const fresh = new ProfileManager(null).snapshot();
    expect(fresh.bonusIds).toEqual([]);
    expect(fresh.unlockedBuildingIds).toEqual([]);
    expect(fresh.discoveredCardIds).toEqual([]);
    expect(new ProfileManager(null).scenarioAvailability('sunny-start').unlocked).toBe(true);
  });

  it('a park started by a fresh profile (no grant) is a complete, playable scenario park for every scenario', () => {
    const profile = new ProfileManager(null);
    for (const scenario of SCENARIOS) {
      const session = new ParkSession(scenario, [], { mode: 'scenario', grant: profile.parkGrant('scenario') });
      expect(session.grant).toEqual({ unlockedBuildingIds: [], bonusIds: [] });
      expect(session.activeCards).toEqual([]);
      expect(session.rules.startingResearchPoints).toBeUndefined();
      expect(session.world.cash).toBe(scenario.rules.startingCash);
    }
  });
});

describe('no requirement, in the scenario source', () => {
  it('the scenario data files do not import the profile or the cards (a scenario cannot know what a profile holds)', () => {
    const sources = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], { import: 'default', query: '?raw', eager: true });
    expect(Object.keys(sources).length, 'the scan sees the scenario source files').toBeGreaterThanOrEqual(4);
    for (const [file, source] of Object.entries(sources)) {
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const path of imports) {
        expect(path.includes('ProfileManager') || path.includes('eligibility') || path.includes('/cards/'), `${file} imports ${path}`).toBe(false);
      }
    }
  });
});
