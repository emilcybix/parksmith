import { describe, expect, it } from 'vitest';
import { PULSE_CARDS } from '../cards/content';
import { EMPTY_GRANT } from '../session/ParkSession';
import { abandonRun, acceptOffer, createRun, resolveStage, runKeyOf, startStage } from './deck';
import { runOutcomeOf, runRewardEligible } from './rewards';
import type { RunState } from './types';

/** Phase 23: what the end of a run means for the profile (discovered cards only) and which runs are trusted. */
const ok = (result: { ok: boolean; run?: RunState }): RunState => { if (!result.ok || !result.run) throw new Error('refused'); return result.run; };
const played = (run: RunState, outcomes: Array<'succeeded' | 'failed'>, cards = 1): RunState => {
  let current = run;
  for (const outcome of outcomes) {
    current = ok(acceptOffer(current));
    current = ok(startStage(current, current.deck.filter((id, index, all) => all.indexOf(id) === index).slice(0, cards)));
    current = ok(resolveStage(current, { outcome, atSeconds: 120, evidence: outcome }));
  }
  return current;
};

describe('runOutcomeOf', () => {
  const fresh = createRun({ seed: 321, difficulty: 'standard', grant: EMPTY_GRANT });

  it('is null while the run goes on', () => {
    expect(runOutcomeOf(fresh)).toBeNull();
    expect(runOutcomeOf(ok(acceptOffer(fresh)))).toBeNull();
    expect(runOutcomeOf(played(fresh, ['succeeded', 'succeeded']))).toBeNull();
  });

  it('a victory counts every level and lists every card that joined the deck, used or not, once, in canonical order', () => {
    const won = played(fresh, ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
    const outcome = runOutcomeOf(won)!;
    expect(outcome.outcome).toBe('won');
    expect(outcome.levelsCleared).toBe(5);
    const everAdded = new Set([...won.starterDeck, ...won.levels.flatMap((level) => level.offer)]);
    expect(outcome.deckCardIds).toEqual(PULSE_CARDS.map((card) => card.id).filter((id) => everAdded.has(id)));
  });

  it('a loss counts the levels cleared before it, and its deck is what the run held (the starter plus accepted offers)', () => {
    const lost = played(fresh, ['succeeded', 'succeeded', 'failed']);
    const outcome = runOutcomeOf(lost)!;
    expect(outcome).toMatchObject({ outcome: 'lost', levelsCleared: 2 });
    const held = new Set([...lost.starterDeck, ...lost.levels.slice(0, 3).flatMap((level) => level.offer)]);
    expect(outcome.deckCardIds).toEqual(PULSE_CARDS.map((card) => card.id).filter((id) => held.has(id)));
    expect(runOutcomeOf(ok(abandonRun(fresh)))).toMatchObject({ outcome: 'lost', levelsCleared: 0 });
  });
});

describe('runRewardEligible: a run earns rewards only when it is what this build plans for its seed', () => {
  const run = played(createRun({ seed: 555, difficulty: 'tough', grant: { unlockedBuildingIds: [], bonusIds: ['spare-slot'] } }), ['succeeded', 'failed']);

  it('a run created by this build is eligible, at any point of its life', () => {
    expect(runRewardEligible(run)).toBe(true);
    expect(runRewardEligible(createRun({ seed: 0, difficulty: 'relaxed', grant: EMPTY_GRANT }))).toBe(true);
  });

  it('a hand-edited plan is not: an easier target, a longer deadline, more cash, fewer conditions, a different offer, a different map', () => {
    const edit = (change: (value: RunState) => void): RunState => { const copy = structuredClone(run); change(copy); return copy; };
    expect(runRewardEligible(edit((r) => { r.levels[2].objective.target = 1; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { r.levels[1].timeLimitDays = 30; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { r.levels[1].startingCash += 1; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { r.levels[3].conditionIds = []; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { r.levels[0].offer = ['lean-crew']; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { (r.levels[0].recipe as { seed: number }).seed += 1; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { (r.levels[0].recipe as { generatorVersion: number }).generatorVersion = 1; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { r.starterDeck = ['grand-opening']; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { r.planVersion = 99; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { r.consumeAt = 'stage-clear'; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { r.offerRule = { kind: 'pick', pick: 1 }; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { r.difficulty = 'relaxed'; }))).toBe(false);
    expect(runRewardEligible(edit((r) => { r.seed += 1; }))).toBe(false);
  });

  it('what the player did (cards, history, deck) does not matter: the plan is what is checked, and the key is stable', () => {
    const start = createRun({ seed: 555, difficulty: 'tough', grant: { unlockedBuildingIds: [], bonusIds: ['spare-slot'] } });
    expect(runKeyOf(run)).toBe(runKeyOf(start));
    expect(runRewardEligible(ok(abandonRun(start)))).toBe(true);
  });

  it('garbage is not eligible and never throws', () => {
    expect(runRewardEligible({ seed: 'x' } as never)).toBe(false);
  });
});
