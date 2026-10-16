import { describe, expect, it } from 'vitest';
import type { PulseCardId } from '../cards/types';
import { SCENARIOS } from '../scenarios/content';
import { ParkSession, type ParkGrant } from '../session/ParkSession';
import { testStageSession } from '../run/testSupport';
import { rewardEligible } from './eligibility';

const everything: ParkGrant = { unlockedBuildingIds: ['tiki-tumbler'], bonusIds: ['nest-egg', 'research-grant', 'builders-discount', 'spare-slot', 'word-of-mouth', 'trusted-crew'] };
const roundTrip = (session: ParkSession, edit: (state: Record<string, any>) => void = () => undefined): ParkSession => {
  session.syncWithWorld();
  const state = JSON.parse(JSON.stringify(session.serialize()));
  edit(state);
  return ParkSession.fromState(state);
};

describe('rewardEligible: never trust a save for profile rewards', () => {
  it('every scenario park started in this game is eligible, in both reward modes, with and without cards and bonuses', () => {
    for (const scenario of SCENARIOS) {
      for (const grant of [undefined, everything]) {
        const cards: PulseCardId[] = ['grand-opening', 'velvet-ropes', 'local-contractors'];
        const session = new ParkSession(scenario, grant ? cards : cards.slice(0, 2), { mode: 'scenario', grant });
        expect(rewardEligible(session), `${scenario.id} scenario ${grant ? 'bonuses' : 'plain'}`).toBe(true);
      }
    }
  });

  it('a run stage started in this game is eligible, with and without bonuses and cards', () => {
    for (const grant of [undefined, everything]) {
      for (const cardCount of [0, 1, 2]) {
        const { session } = testStageSession({ grant, cardCount: grant ? cardCount : Math.min(cardCount, 1) });
        expect(rewardEligible(session), `${grant ? 'bonuses' : 'plain'} ${cardCount}`).toBe(true);
      }
    }
  });

  it('a legitimately saved and restored park stays eligible', () => {
    for (const scenario of SCENARIOS.slice(0, 5)) {
      const restored = roundTrip(new ParkSession(scenario, ['grand-opening', 'velvet-ropes', 'hungry-tourists'], { mode: 'scenario', grant: everything }));
      expect(rewardEligible(restored), scenario.id).toBe(true);
    }
  });

  it('a Sandbox park is never eligible (it has no result)', () => {
    expect(rewardEligible(new ParkSession(null))).toBe(false);
    expect(rewardEligible(new ParkSession(null, [], { grant: everything }))).toBe(false);
  });

  it('a hand-edited ruleset is not: cash, a multiplier, a locked id, a bonus key', () => {
    const edits: Array<[string, (state: Record<string, any>) => void]> = [
      ['more cash', (state) => { state.rules.startingCash += 5_000; }],
      ['cheaper construction', (state) => { state.rules.constructionCostMultiplier = 0.5; state.world.constructionCostMultiplier = 0.5; }],
      ['slower arrivals made faster', (state) => { state.rules.arrivalIntervalMultiplier = 0.3; }],
      ['an unlocked lock', (state) => { state.rules.lockedDefinitionIds = []; }],
      ['a bonus key without the bonus', (state) => { state.rules.startingResearchPoints = 30; }],
      ['an extra slot without the bonus', (state) => { state.rules.extraCardSlots = 1; }],
    ];
    for (const [label, edit] of edits) {
      const restored = roundTrip(new ParkSession(SCENARIOS[2], ['grand-opening'], { mode: 'scenario' }), edit);
      expect(rewardEligible(restored), label).toBe(false);
    }
  });

  it('three cards with a spare-slot ruleset but a grant that has no spare slot are not eligible', () => {
    const session = new ParkSession(SCENARIOS[0], ['grand-opening', 'velvet-ropes', 'local-contractors'], {
      mode: 'scenario',
      grant: { unlockedBuildingIds: [], bonusIds: ['spare-slot'] },
    });
    const restored = roundTrip(session, (state) => { state.grant.bonusIds = []; });
    expect(restored.activeCards).toHaveLength(3);
    expect(rewardEligible(restored)).toBe(false);
  });

  it('a grant that grants more unlocks does not grant more rewards: only the ruleset is compared', () => {
    const restored = roundTrip(new ParkSession(SCENARIOS[0], [], { mode: 'scenario' }), (state) => {
      state.grant.unlockedBuildingIds = ['tiki-tumbler', 'cactus-cooler'];
    });
    expect(rewardEligible(restored)).toBe(true);
  });

  it('the Phase 16 base-layer keys are left out of the comparison on both sides (a pre-switch-on save stays eligible)', () => {
    const variants: Array<[string, (state: Record<string, any>) => void]> = [
      ['saved before Phase 16: neither key', (state) => { delete state.rules.themeAffinity; delete state.rules.researchCostScale; }],
      ['saved under another balance era', (state) => { state.rules.themeAffinity = 0.2; state.rules.researchCostScale = 5; }],
      ['only one key', (state) => { delete state.rules.themeAffinity; state.rules.researchCostScale = 10; }],
    ];
    for (const [label, edit] of variants) {
      const scenario = roundTrip(new ParkSession(SCENARIOS[1], ['grand-opening'], { mode: 'scenario', grant: everything }), edit);
      expect(rewardEligible(scenario), `scenario: ${label}`).toBe(true);
      const { session } = testStageSession({ grant: everything, cardCount: 1 });
      expect(rewardEligible(roundTrip(session, edit)), `run stage: ${label}`).toBe(true);
    }
    // Every other key is still compared: the exclusion is exactly the two Phase 16 keys.
    const edited = roundTrip(new ParkSession(SCENARIOS[1], [], { mode: 'scenario' }), (state) => {
      delete state.rules.themeAffinity;
      state.rules.startingCash += 1;
    });
    expect(rewardEligible(edited)).toBe(false);
  });

  it('the Phase 14 key (crowdFeedback) is left out of the comparison on both sides (a pre-Phase-14 save stays eligible)', () => {
    // A new park compiles the key live (GAME_CONFIG.crowd.feedback); a park saved before Phase 14 has none, and another
    // balance era may have stored another strength. None of these is a reward exploit.
    // A park playing under a key its recompiled ruleset does not have (or the other way round) is still eligible.
    const plain = new ParkSession(SCENARIOS[1], [], { mode: 'scenario' });
    for (const crowdFeedback of [0.5, 1]) {
      const keyed = new ParkSession(SCENARIOS[1], [], { mode: 'scenario', rules: { ...plain.rules, crowdFeedback } });
      expect(keyed.rules.crowdFeedback).toBe(crowdFeedback);
      expect(rewardEligible(keyed), `live key ${crowdFeedback}`).toBe(true);
    }
    const { crowdFeedback: _live, ...withoutKey } = plain.rules;
    void _live;
    expect(rewardEligible(new ParkSession(SCENARIOS[1], [], { mode: 'scenario', rules: withoutKey })), 'no live key').toBe(true);
    const variants: Array<[string, (state: Record<string, any>) => void]> = [
      ['saved before Phase 14: no key', (state) => { delete state.rules.crowdFeedback; delete state.crowd; }],
      ['saved under another balance era', (state) => { state.rules.crowdFeedback = 0.5; state.crowd = { version: 1, pressure: [] }; }],
    ];
    for (const [label, edit] of variants) {
      const scenario = roundTrip(new ParkSession(SCENARIOS[1], ['grand-opening'], { mode: 'scenario', grant: everything }), edit);
      expect(rewardEligible(scenario), `scenario: ${label}`).toBe(true);
      const { session } = testStageSession({ grant: everything, cardCount: 1 });
      expect(rewardEligible(roundTrip(session, edit)), `run stage: ${label}`).toBe(true);
    }
    const edited = roundTrip(new ParkSession(SCENARIOS[1], [], { mode: 'scenario' }), (state) => {
      delete state.rules.crowdFeedback;
      delete state.crowd;
      state.rules.startingCash += 1;
    });
    expect(rewardEligible(edited)).toBe(false);
  });

  it('removing a bonus from the grant of a park that was played under it makes the park ineligible', () => {
    const restored = roundTrip(
      new ParkSession(SCENARIOS[0], [], { mode: 'scenario', grant: { unlockedBuildingIds: [], bonusIds: ['nest-egg'] } }),
      (state) => { state.grant.bonusIds = []; },
    );
    expect(rewardEligible(restored)).toBe(false);
  });
});
