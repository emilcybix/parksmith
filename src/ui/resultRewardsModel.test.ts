import { describe, expect, it } from 'vitest';
import type { ScenarioRewardResult } from '../game/profile/types';
import { buildResultActions, buildRewardsSection, bonusScope, NO_REWARDS_TEXT, UNLOCK_NOTE } from './resultRewardsModel';
import { profileAfter } from './profileTestSupport';

const result = (over: Partial<ScenarioRewardResult> = {}): ScenarioRewardResult => ({
  scenarioId: 'sunny-start',
  outcome: 'succeeded',
  firstClear: true,
  newlyUnlockedBuildingIds: [],
  newlyEarnedBonusIds: [],
  newlyAvailableScenarioIds: [],
  previousBestSeconds: null,
  newBest: true,
  eligible: true,
  ...over,
});

const profile = profileAfter([]).snapshot;

describe('rewards section', () => {
  it('lists an unlock, a bonus with where it applies, new scenarios and the best time on a first clear', () => {
    const section = buildRewardsSection(result({
      newlyUnlockedBuildingIds: ['tiki-tumbler'],
      newlyEarnedBonusIds: ['nest-egg'],
      newlyAvailableScenarioIds: ['canyon-caravan'],
    }), profile, 725);
    expect(section?.title).toBe('Rewards earned for good');
    expect(section?.lines.map((line) => line.text)).toEqual([
      'Tiki Tumbler unlocked — build it in any new park',
      'Nest egg — parks start with $500 more cash (on in The Map and Scenario)',
      'New scenario available: Canyon Caravan',
      'Best: 12:05',
    ]);
    expect(section?.note).toBe(UNLOCK_NOTE);
  });

  it('a repeat clear says the rewards are already earned and compares the time', () => {
    const better = buildRewardsSection(result({ firstClear: false, previousBestSeconds: 872, newBest: true }), profile, 725);
    expect(better?.title).toBe('Cleared again');
    expect(better?.lines.map((line) => line.text)).toEqual(['Rewards already earned', 'New best: 12:05 (was 14:32)']);
    const worse = buildRewardsSection(result({ firstClear: false, previousBestSeconds: 700, newBest: false }), profile, 725);
    expect(worse?.lines[1].text).toBe('Best: 11:40 · this run 12:05');
    expect(better?.note).toBeNull();
  });

  it('an ineligible park gets the no-rewards line and nothing else', () => {
    const section = buildRewardsSection(result({ eligible: false, newlyUnlockedBuildingIds: ['tiki-tumbler'] }), profile, 725);
    expect(section?.lines).toEqual([{ id: 'ineligible', icon: '⚠', text: NO_REWARDS_TEXT }]);
  });

  it('a failure and a missing result have no section', () => {
    expect(buildRewardsSection(result({ outcome: 'failed' }), profile, 725)).toBeNull();
    expect(buildRewardsSection(null, profile, 725)).toBeNull();
  });

  it('a first clear that earns nothing new still says so', () => {
    expect(buildRewardsSection(result({ previousBestSeconds: null }), profile, null)?.lines).toEqual([
      { id: 'first', icon: '✓', text: 'Cleared for the first time' },
    ]);
  });

  it('says where a bonus applies from the profile switches, including "off everywhere"', () => {
    const { manager } = profileAfter([]);
    expect(bonusScope('nest-egg', manager.snapshot())).toBe('on in The Map and Scenario');
    manager.setUseBonuses('sandbox', true);
    expect(bonusScope('nest-egg', manager.snapshot())).toBe('on in The Map, Scenario and Sandbox');
    // Spare card slot has no Sandbox effect (no cards there)
    expect(bonusScope('spare-slot', manager.snapshot())).toBe('on in The Map and Scenario');
    manager.setUseBonuses('run', false);
    manager.setUseBonuses('scenario', false);
    manager.setUseBonuses('sandbox', false);
    expect(bonusScope('nest-egg', manager.snapshot())).toBe('switched off in every mode, change it in Collection');
    expect(bonusScope('nest-egg', null)).toBe('on in The Map and Scenario');
  });
});

describe('result actions', () => {
  it('Scenario success: Back to scenarios first, Next when one opened, Keep exploring', () => {
    expect(buildResultActions(true, result()).map((action) => action.label)).toEqual(['Back to scenarios', 'Keep exploring']);
    const withNext = buildResultActions(true, result({ newlyAvailableScenarioIds: ['canyon-caravan', 'frost-fair'] }));
    expect(withNext.map((action) => action.label)).toEqual(['Back to scenarios', 'Next: Canyon Caravan', 'Keep exploring']);
    expect(withNext[1].scenarioId).toBe('canyon-caravan');
    expect(withNext.filter((action) => action.primary)).toHaveLength(1);
    expect(withNext[0].primary).toBe(true);
  });

  it('an ineligible success offers no Next', () => {
    const actions = buildResultActions(true, result({ eligible: false, newlyAvailableScenarioIds: ['canyon-caravan'] }));
    expect(actions.map((action) => action.id)).toEqual(['back-to-scenarios', 'keep-exploring']);
  });

  it('Scenario failure: Try again with the same seed first', () => {
    const actions = buildResultActions(false, null);
    expect(actions.map((action) => action.label)).toEqual([
      'Try again (same seed)', 'Quick restart (same cards)', 'Back to scenarios', 'Keep exploring',
    ]);
    expect(actions[0].primary).toBe(true);
  });
});
