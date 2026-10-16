import { describe, expect, it } from 'vitest';
import { CARD_BY_ID, PULSE_CARDS, slotCostTotal } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { GAME_CONFIG } from '../config';
import { hashState } from '../save/hash';
import { EMPTY_GRANT } from '../session/ParkSession';
import {
  abandonRun, acceptOffer, createRun, deckCounts, isRunTransition, resolveStage, runHash, runKeyOf, runSummaryOf, slotsOf, startStage, validateLoadout,
} from './deck';
import { readRunState } from './validate';
import { runSnapshotOf } from './snapshot';
import type { RunState } from './types';

/**
 * Phase 23, step 1: every transition and refusal of the run's state machine, the deck rules (consume at start or at
 * clear, `all` or `pick` offers) and card conservation after any random legal sequence.
 */
const SPARE = { unlockedBuildingIds: [], bonusIds: ['spare-slot' as const] };
const fresh = (seed = 1234, grant: typeof EMPTY_GRANT | typeof SPARE = EMPTY_GRANT): RunState => createRun({ seed, difficulty: 'standard', grant });
const ok = (step: ReturnType<typeof acceptOffer>): RunState => {
  if (!step.ok) throw new Error(`refused: ${step.reason}`);
  return step.run;
};
const clearOf = (run: RunState, cards: readonly PulseCardId[] = []): RunState => ok(resolveStage(ok(startStage(run, cards)), { outcome: 'succeeded', atSeconds: 321.04, evidence: 'ok' }));
const withConsume = (run: RunState, consumeAt: RunState['consumeAt']): RunState => ({ ...run, consumeAt });

describe('createRun', () => {
  it('starts at the offer of level 1 with the starter deck and nothing used', () => {
    const run = fresh();
    expect(run).toMatchObject({ version: 2, unplayedOneShots: 'return', phase: 'offer', levelIndex: 0, parkLevelIndex: 0, usedPile: [], loadout: [], offersSeen: [], history: [] });
    expect(run.deck).toEqual(run.starterDeck);
    expect(run.levels).toHaveLength(GAME_CONFIG.run.levelCount);
    expect(run.consumeAt).toBe('stage-start');
    expect(run.offerRule).toEqual({ kind: 'all' });
  });

  it('holds the grant as a run grant: gated ids in catalog order, only the bonuses that apply on The Map', () => {
    const run = createRun({ seed: 1, difficulty: 'standard', grant: { unlockedBuildingIds: ['tiki-tumbler', 'nope', 'lantern-maple'], bonusIds: ['spare-slot', 'nest-egg', 'nope'] } });
    expect(run.grant.unlockedBuildingIds).toEqual(['tiki-tumbler', 'lantern-maple']);
    expect(run.grant.bonusIds).toEqual(['nest-egg', 'spare-slot']);
  });

  it('the grant never changes the content of the run, only the slots', () => {
    const plain = fresh(77);
    const rich = createRun({ seed: 77, difficulty: 'standard', grant: { unlockedBuildingIds: ['tiki-tumbler'], bonusIds: ['nest-egg', 'spare-slot'] } });
    expect(hashState(rich.levels)).toBe(hashState(plain.levels));
    expect(rich.starterDeck).toEqual(plain.starterDeck);
    expect(slotsOf(rich, 0)).toBe(slotsOf(plain, 0) + 1);
  });
});

describe('the happy path: offer -> loadout -> stage -> next offer', () => {
  it('walks five levels to a win, with the deck growing by the offer and shrinking by the cards played', () => {
    let run = fresh();
    for (let level = 0; level < GAME_CONFIG.run.levelCount; level += 1) {
      expect(run.phase).toBe('offer');
      expect(run.levelIndex).toBe(level);
      const before = run.deck.length;
      run = ok(acceptOffer(run));
      expect(run.phase).toBe('loadout');
      expect(run.deck).toHaveLength(before + run.levels[level].offer.length);
      expect(run.offersSeen).toEqual(Array.from({ length: level + 1 }, (_, i) => i));
      const pick = run.deck.filter((id, index, all) => all.indexOf(id) === index).slice(0, slotsOf(run));
      run = ok(startStage(run, pick));
      expect(run.phase).toBe('stage');
      expect(run.parkLevelIndex).toBe(level);
      expect(run.loadout).toEqual(pick);
      expect(run.deck).toHaveLength(before + run.levels[level].offer.length - pick.length);
      run = ok(resolveStage(run, { outcome: 'succeeded', atSeconds: 100 + level, evidence: `level ${level + 1}` }));
      expect(run.history).toHaveLength(level + 1);
    }
    expect(run.phase).toBe('won');
    expect(run.levelIndex).toBe(GAME_CONFIG.run.levelCount - 1);
    expect(run.parkLevelIndex).toBe(run.levelIndex);
    expect(run.history.every((entry) => entry.outcome === 'succeeded')).toBe(true);
    expect(() => readRunState(JSON.parse(JSON.stringify(run)))).not.toThrow();
  });

  it('every state along the way passes the save reader', () => {
    let run = fresh(5, SPARE);
    const states: RunState[] = [run];
    for (let level = 0; level < GAME_CONFIG.run.levelCount; level += 1) {
      run = ok(acceptOffer(run)); states.push(run);
      run = ok(startStage(run, run.deck.slice(0, 1))); states.push(run);
      run = ok(resolveStage(run, { outcome: 'succeeded', atSeconds: 50, evidence: null })); states.push(run);
    }
    for (const state of states) expect(() => readRunState(JSON.parse(JSON.stringify(state))), `${state.phase} L${state.levelIndex + 1}`).not.toThrow();
  });

  it('is pure: no transition mutates its input', () => {
    const run = fresh();
    const frozen = JSON.stringify(run);
    const accepted = ok(acceptOffer(run));
    expect(JSON.stringify(run)).toBe(frozen);
    const frozen2 = JSON.stringify(accepted);
    const started = ok(startStage(accepted, accepted.deck.slice(0, 1)));
    expect(JSON.stringify(accepted)).toBe(frozen2);
    const frozen3 = JSON.stringify(started);
    ok(resolveStage(started, { outcome: 'failed', atSeconds: 5, evidence: 'x' }));
    ok(abandonRun(started, 5));
    expect(JSON.stringify(started)).toBe(frozen3);
  });
});

describe('refusals (typed, never a throw)', () => {
  const loadout = (): RunState => ok(acceptOffer(fresh()));

  it('every transition refuses the wrong phase', () => {
    const offer = fresh();
    const stage = ok(startStage(loadout(), []));
    const lost = ok(abandonRun(offer));
    const won = ((): RunState => { let run = offer; for (let i = 0; i < GAME_CONFIG.run.levelCount; i += 1) run = clearOf(ok(acceptOffer(run))); return run; })();
    expect(acceptOffer(loadout())).toEqual({ ok: false, reason: 'wrong-phase' });
    expect(startStage(offer, [])).toEqual({ ok: false, reason: 'wrong-phase' });
    expect(validateLoadout(offer, [])).toEqual({ ok: false, reason: 'wrong-phase' });
    expect(resolveStage(offer, { outcome: 'succeeded', atSeconds: 1, evidence: null })).toEqual({ ok: false, reason: 'wrong-phase' });
    expect(resolveStage(loadout(), { outcome: 'succeeded', atSeconds: 1, evidence: null })).toEqual({ ok: false, reason: 'wrong-phase' });
    expect(acceptOffer(stage)).toEqual({ ok: false, reason: 'wrong-phase' });
    expect(startStage(stage, [])).toEqual({ ok: false, reason: 'wrong-phase' });
    for (const terminal of [won, lost]) {
      expect(terminal.phase === 'won' || terminal.phase === 'lost').toBe(true);
      expect(acceptOffer(terminal)).toEqual({ ok: false, reason: 'wrong-phase' });
      expect(startStage(terminal, [])).toEqual({ ok: false, reason: 'wrong-phase' });
      expect(resolveStage(terminal, { outcome: 'failed', atSeconds: 1, evidence: null })).toEqual({ ok: false, reason: 'wrong-phase' });
      expect(abandonRun(terminal)).toEqual({ ok: false, reason: 'wrong-phase' });
    }
  });

  it('a loadout must be known, distinct, in the deck and within the slots; zero cards is legal', () => {
    const run = loadout();
    const [first, second] = run.deck.filter((id, index, all) => all.indexOf(id) === index);
    expect(validateLoadout(run, [])).toEqual({ ok: true });
    expect(validateLoadout(run, [first])).toEqual({ ok: true });
    expect(validateLoadout(run, [first, second])).toEqual({ ok: false, reason: 'too-many' });
    expect(validateLoadout(run, ['nope'])).toEqual({ ok: false, reason: 'unknown-card' });
    expect(validateLoadout(run, [first, first])).toEqual({ ok: false, reason: 'duplicate' });
    const absent = PULSE_CARDS.map((card) => card.id).find((id) => !run.deck.includes(id));
    expect(absent).toBeDefined();
    expect(validateLoadout(run, [absent as string])).toEqual({ ok: false, reason: 'not-in-deck' });
    expect(validateLoadout(run, 'x' as never)).toEqual({ ok: false, reason: 'bad-pick' });
    expect(startStage(run, [first, second])).toEqual({ ok: false, reason: 'too-many' });
  });

  it('slots grow with the level and with the Spare card slot', () => {
    const run = fresh(3, SPARE);
    expect(GAME_CONFIG.run.slotsByLevel).toEqual([1, 1, 2, 2, 3]);
    GAME_CONFIG.run.slotsByLevel.forEach((slots, index) => expect(slotsOf(run, index)).toBe(slots + 1));
    expect(slotsOf(fresh(3), 4)).toBe(3);
    expect(slotsOf(fresh(3), 99)).toBe(0);
  });

  it('a resolve with an unknown outcome is refused', () => {
    const stage = ok(startStage(loadout(), []));
    expect(resolveStage(stage, { outcome: 'draw' as never, atSeconds: 1, evidence: null })).toEqual({ ok: false, reason: 'bad-pick' });
  });
});

describe('consumption', () => {
  it('stage-start (the default): the played cards leave the deck at once, onto the used pile in loadout order', () => {
    const run = ok(acceptOffer(fresh(9, SPARE)));
    const cards = run.deck.filter((id, index, all) => all.indexOf(id) === index).slice(0, 2);
    const started = ok(startStage(run, cards));
    expect(started.usedPile).toEqual(cards.map((cardId) => ({ cardId, levelIndex: 0 })));
    expect(started.deck).toHaveLength(run.deck.length - 2);
    // Failing does not give the stage cards back: they were used when the stage started. An unplayed one-shot returns.
    const lost = ok(resolveStage(started, { outcome: 'failed', atSeconds: 10, evidence: null }));
    const stageCards = cards.filter((id) => CARD_BY_ID.get(id)?.kind === 'stage');
    expect(lost.usedPile).toEqual(stageCards.map((cardId) => ({ cardId, levelIndex: 0 })));
    expect(lost.deck).toHaveLength(run.deck.length - stageCards.length);
  });

  it('only one copy of a card leaves the deck when the deck holds copies', () => {
    const base = ok(acceptOffer(fresh()));
    const card = base.deck[0];
    const doubled = { ...base, deck: [card, card, ...base.deck.filter((id) => id !== card)].sort((a, b) => PULSE_CARDS.findIndex((c) => c.id === a) - PULSE_CARDS.findIndex((c) => c.id === b)) };
    const started = ok(startStage(doubled, [card]));
    expect(started.deck.filter((id) => id === card)).toHaveLength(doubled.deck.filter((id) => id === card).length - 1);
  });

  it('stage-clear: the deck is untouched during the stage, the loadout is consumed on a clear and kept after a failure', () => {
    const run = withConsume(ok(acceptOffer(fresh())), 'stage-clear');
    const card = run.deck[0];
    const started = ok(startStage(run, [card]));
    expect(started.deck).toEqual(run.deck);
    expect(started.usedPile).toEqual([]);
    const cleared = ok(resolveStage(started, { outcome: 'succeeded', atSeconds: 90, evidence: null }));
    expect(cleared.usedPile).toEqual([{ cardId: card, levelIndex: 0 }]);
    expect(cleared.deck).toHaveLength(run.deck.length - 1);
    expect(cleared.phase).toBe('offer');
    expect(cleared.loadout).toEqual([card]);
    const failed = ok(resolveStage(started, { outcome: 'failed', atSeconds: 90, evidence: null }));
    expect(failed.deck).toEqual(run.deck);
    expect(failed.usedPile).toEqual([]);
    for (const state of [started, cleared, failed]) expect(() => readRunState(JSON.parse(JSON.stringify(state)))).not.toThrow();
  });

  it('on a clear the park and loadout still describe the park on screen, and the level moves on', () => {
    const cleared = clearOf(ok(acceptOffer(fresh())), []);
    expect(cleared).toMatchObject({ phase: 'offer', levelIndex: 1, parkLevelIndex: 0, loadout: [] });
  });
});

describe('the offer rule', () => {
  const pickRun = (pick: number): RunState => ({ ...fresh(), offerRule: { kind: 'pick', pick } });

  it('all: the whole offer joins the deck and a pick argument is ignored', () => {
    const run = fresh();
    const accepted = ok(acceptOffer(run, ['grand-opening']));
    expect(accepted.deck).toHaveLength(run.deck.length + run.levels[0].offer.length);
  });

  it('pick: exactly `pick` distinct cards of the offer join the deck; anything else is refused', () => {
    const run = pickRun(1);
    const [first, second] = run.levels[0].offer;
    const accepted = ok(acceptOffer(run, [second]));
    expect(accepted.deck).toHaveLength(run.deck.length + 1);
    expect(accepted.deck.filter((id) => id === second).length).toBe(run.deck.filter((id) => id === second).length + 1);
    expect(acceptOffer(run)).toEqual({ ok: false, reason: 'bad-pick' });
    expect(acceptOffer(run, [])).toEqual({ ok: false, reason: 'bad-pick' });
    expect(acceptOffer(run, [first, second])).toEqual({ ok: false, reason: 'too-many' });
    expect(acceptOffer(run, ['nope' as never])).toEqual({ ok: false, reason: 'unknown-card' });
    const outside = PULSE_CARDS.map((card) => card.id).find((id) => !run.levels[0].offer.includes(id))!;
    expect(acceptOffer(run, [outside])).toEqual({ ok: false, reason: 'bad-pick' });
    expect(acceptOffer(pickRun(2), [first, first])).toEqual({ ok: false, reason: 'duplicate' });
    expect(() => readRunState(JSON.parse(JSON.stringify(accepted)))).not.toThrow();
  });

  it('pick: a pick larger than a shrunken offer takes the whole offer', () => {
    const run = { ...pickRun(5), levels: fresh().levels.map((level, index) => (index === 0 ? { ...level, offer: [level.offer[0]] } : level)) };
    const accepted = ok(acceptOffer(run, [run.levels[0].offer[0]]));
    expect(accepted.deck).toHaveLength(run.deck.length + 1);
  });
});

describe('failure, victory and abandon', () => {
  it('a failed stage ends the run on that level, with the stage in the history', () => {
    const started = ok(startStage(ok(acceptOffer(fresh())), []));
    // Standard level 1 is 1.25 park days (900 s) since plan version 4 (Phase 25 retune).
    const lost = ok(resolveStage(started, { outcome: 'failed', atSeconds: 900.04, evidence: 'Time expired.' }));
    expect(lost).toMatchObject({ phase: 'lost', levelIndex: 0, parkLevelIndex: 0 });
    expect(lost.history).toEqual([{ levelIndex: 0, outcome: 'failed', atSeconds: 900, evidence: 'Time expired.', cardIds: [], playedCardIds: [], unpaidDebt: 0 }]);
    expect(() => readRunState(JSON.parse(JSON.stringify(lost)))).not.toThrow();
  });

  it('seconds and evidence are sanitised: NaN and negatives become 0, a long text is cut', () => {
    const started = ok(startStage(ok(acceptOffer(fresh())), []));
    const nan = ok(resolveStage(started, { outcome: 'failed', atSeconds: Number.NaN, evidence: 'x'.repeat(900) }));
    expect(nan.history[0].atSeconds).toBe(0);
    expect(nan.history[0].evidence).toHaveLength(500);
    expect(ok(resolveStage(started, { outcome: 'failed', atSeconds: -5, evidence: null })).history[0].atSeconds).toBe(0);
  });

  it('abandon ends the run from any non-terminal phase, recording the stage cards only inside a stage', () => {
    const offer = fresh();
    const loadout = ok(acceptOffer(offer));
    const card = loadout.deck[0];
    const stage = ok(startStage(loadout, [card]));
    const fromOffer = ok(abandonRun(offer));
    const fromLoadout = ok(abandonRun(loadout, 77));
    const fromStage = ok(abandonRun(stage, 77.26));
    expect([fromOffer.phase, fromLoadout.phase, fromStage.phase]).toEqual(['lost', 'lost', 'lost']);
    expect(fromOffer.history).toEqual([{ levelIndex: 0, outcome: 'abandoned', atSeconds: 0, evidence: null, cardIds: [], playedCardIds: [], unpaidDebt: 0 }]);
    expect(fromLoadout.history[0]).toMatchObject({ atSeconds: 0, cardIds: [] });
    expect(fromStage.history).toEqual([{ levelIndex: 0, outcome: 'abandoned', atSeconds: 77.3, evidence: null, cardIds: [card], playedCardIds: [], unpaidDebt: 0 }]);
    for (const state of [fromOffer, fromLoadout, fromStage]) expect(() => readRunState(JSON.parse(JSON.stringify(state)))).not.toThrow();
    // Between stages after a clear.
    const between = clearOf(loadout, []);
    const abandonedLater = ok(abandonRun(between));
    expect(abandonedLater.history.map((entry) => entry.outcome)).toEqual(['succeeded', 'abandoned']);
    expect(() => readRunState(JSON.parse(JSON.stringify(abandonedLater)))).not.toThrow();
  });
});

describe('isRunTransition (the advanceRun guard)', () => {
  const offer = fresh();
  const loadout = ok(acceptOffer(offer));
  const stage = ok(startStage(loadout, [loadout.deck[0]]));

  it('is true for acceptOffer, resolveStage and abandonRun results, and nothing else', () => {
    expect(isRunTransition(offer, loadout)).toBe(true);
    expect(isRunTransition(stage, ok(resolveStage(stage, { outcome: 'succeeded', atSeconds: 90, evidence: 'e' })))).toBe(true);
    expect(isRunTransition(stage, ok(resolveStage(stage, { outcome: 'failed', atSeconds: 90, evidence: 'e' })))).toBe(true);
    expect(isRunTransition(stage, ok(abandonRun(stage, 12)))).toBe(true);
    expect(isRunTransition(offer, ok(abandonRun(offer)))).toBe(true);
    expect(isRunTransition(loadout, ok(abandonRun(loadout)))).toBe(true);
  });

  it('is false for startStage (a new session), for no change, for a skipped step and for any tampering', () => {
    expect(isRunTransition(loadout, stage)).toBe(false);
    expect(isRunTransition(offer, offer)).toBe(false);
    expect(isRunTransition(offer, stage)).toBe(false);
    const cleared = ok(resolveStage(stage, { outcome: 'succeeded', atSeconds: 90, evidence: null }));
    expect(isRunTransition(offer, cleared)).toBe(false);
    expect(isRunTransition(stage, { ...cleared, deck: [...cleared.deck, 'lean-crew'] })).toBe(false);
    expect(isRunTransition(stage, { ...cleared, levels: cleared.levels.map((level, index) => (index === 1 ? { ...level, startingCash: 1 } : level)) })).toBe(false);
    expect(isRunTransition(stage, { ...cleared, seed: 5 })).toBe(false);
    expect(isRunTransition(stage, { ...cleared, grant: { unlockedBuildingIds: ['tiki-tumbler'], bonusIds: [] } })).toBe(false);
    expect(isRunTransition(stage, { ...cleared, parkLevelIndex: 1 })).toBe(false);
    // The result's seconds and evidence are the app's to report (any value is a legal result); its cards are not.
    expect(isRunTransition(stage, { ...cleared, history: [{ ...cleared.history[0], atSeconds: 1 }] })).toBe(true);
    expect(isRunTransition(stage, { ...cleared, history: [{ ...cleared.history[0], cardIds: [] }] })).toBe(false);
    expect(isRunTransition(cleared, stage)).toBe(false);
    expect(isRunTransition(offer, null as never)).toBe(false);
  });

  it('under the pick rule the guard accepts any legal pick and refuses a card from outside the offer', () => {
    const run = { ...fresh(), offerRule: { kind: 'pick', pick: 1 } as const };
    const [first, second] = run.levels[0].offer;
    expect(isRunTransition(run, ok(acceptOffer(run, [first])))).toBe(true);
    expect(isRunTransition(run, ok(acceptOffer(run, [second])))).toBe(true);
    const cheat = { ...ok(acceptOffer(run, [first])), deck: [...run.deck, ...run.levels[0].offer].sort() as PulseCardId[] };
    expect(isRunTransition(run, cheat)).toBe(false);
  });
});

describe('conservation after any random legal sequence (500 sequences, both consume rules, both offer rules, both one-shot rules, random plays)', () => {
  const random = (seed: number): (() => number) => { let state = seed >>> 0; return () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 4_294_967_296; }; };

  it('starter + accepted offers = deck + used pile, every state reads back, the guard agrees, and the run ends', () => {
    for (let sequence = 0; sequence < 500; sequence += 1) {
      const next = random(sequence + 1);
      const consumeAt = next() < 0.5 ? 'stage-start' : 'stage-clear';
      const offerRule = next() < 0.5 ? ({ kind: 'all' } as const) : ({ kind: 'pick', pick: 1 } as const);
      const unplayedOneShots = next() < 0.5 ? 'return' : 'consume';
      let run: RunState = { ...fresh(sequence, next() < 0.5 ? SPARE : EMPTY_GRANT), consumeAt, offerRule, unplayedOneShots };
      for (let steps = 0; steps < 40 && run.phase !== 'won' && run.phase !== 'lost'; steps += 1) {
        const before = run;
        if (run.phase === 'offer') {
          const offer = run.levels[run.levelIndex].offer;
          const pick = offerRule.kind === 'pick' ? [offer[Math.floor(next() * offer.length)]] : undefined;
          run = next() < 0.05 ? ok(abandonRun(run)) : ok(acceptOffer(run, pick));
          expect(isRunTransition(before, run)).toBe(true);
        } else if (run.phase === 'loadout') {
          if (next() < 0.05) { run = ok(abandonRun(run)); expect(isRunTransition(before, run)).toBe(true); } else {
            const distinct = run.deck.filter((id, index, all) => all.indexOf(id) === index);
            const count = Math.min(slotsOf(run), Math.floor(next() * (slotsOf(run) + 1)), distinct.length);
            const chosen: PulseCardId[] = [];
            for (const id of [...distinct].sort(() => next() - 0.5)) if (chosen.length < count && slotCostTotal([...chosen, id]) <= slotsOf(run)) chosen.push(id);
            run = ok(startStage(run, chosen));
          }
        } else {
          const roll = next();
          const played = run.loadout.filter((id) => CARD_BY_ID.get(id)?.kind === 'one-shot' && next() < 0.5);
          const debt = played.length > 0 && next() < 0.5 ? Math.floor(next() * 3_000) : 0;
          run = roll < 0.1
            ? ok(abandonRun(run, next() * 100, played, debt))
            : ok(resolveStage(run, { outcome: roll < 0.35 ? 'failed' : 'succeeded', atSeconds: next() * 900, evidence: 'e', playedCardIds: played, unpaidDebt: debt }));
          expect(isRunTransition(before, run)).toBe(true);
        }
        const accepted = [...run.starterDeck, ...run.offersSeen.flatMap((index) => (offerRule.kind === 'all' ? run.levels[index].offer : []))];
        if (offerRule.kind === 'all') expect([...run.deck, ...run.usedPile.map((used) => used.cardId)].sort()).toEqual([...accepted].sort());
        else expect(run.deck.length + run.usedPile.length).toBe(run.starterDeck.length + run.offersSeen.length);
        expect(() => readRunState(JSON.parse(JSON.stringify(run))), `sequence ${sequence} step ${steps} ${run.phase}`).not.toThrow();
      }
    }
  }, 120_000);
});

describe('one-shot settlement (design 3.5): every outcome, both consume rules, both one-shot rules', () => {
  // Seed 1234: level 1's deck is local-contractors, coach-party (a one-shot), tidy-town, plastic-flowers, timber-tariff.
  // Seed 18 deals two one-shots at level 1: bridging-loan and research-grant.
  const atLoadout = (seed: number, consumeAt: RunState['consumeAt'], unplayedOneShots: RunState['unplayedOneShots']): RunState => (
    { ...ok(acceptOffer(fresh(seed, SPARE))), consumeAt, unplayedOneShots }
  );
  const stageCards = ['local-contractors'] as PulseCardId[];
  type Settle = 'succeeded' | 'failed' | 'abandoned';
  const settleWith = (run: RunState, outcome: Settle, played: PulseCardId[], debt = 0): RunState => (
    outcome === 'abandoned'
      ? ok(abandonRun(run, 30, played, debt))
      : ok(resolveStage(run, { outcome, atSeconds: 30, evidence: null, playedCardIds: played, unpaidDebt: debt }))
  );

  it.each([
    // [consumeAt, policy, outcome, played?, the used pile after, the cards back in the deck]
    ['stage-start', 'return', 'succeeded', false, ['local-contractors'], ['coach-party']],
    ['stage-start', 'return', 'succeeded', true, ['local-contractors', 'coach-party'], []],
    ['stage-start', 'return', 'failed', false, ['local-contractors'], ['coach-party']],
    ['stage-start', 'return', 'abandoned', false, ['local-contractors'], ['coach-party']],
    ['stage-start', 'consume', 'succeeded', false, ['local-contractors', 'coach-party'], []],
    ['stage-start', 'consume', 'failed', false, ['local-contractors', 'coach-party'], []],
    ['stage-clear', 'return', 'succeeded', false, ['local-contractors'], ['coach-party']],
    ['stage-clear', 'return', 'succeeded', true, ['local-contractors', 'coach-party'], []],
    ['stage-clear', 'return', 'failed', true, ['coach-party'], ['local-contractors']],
    ['stage-clear', 'return', 'failed', false, [], ['local-contractors', 'coach-party']],
    ['stage-clear', 'consume', 'succeeded', false, ['local-contractors', 'coach-party'], []],
    ['stage-clear', 'consume', 'abandoned', true, ['coach-party'], ['local-contractors']],
    ['stage-clear', 'consume', 'abandoned', false, [], ['local-contractors', 'coach-party']],
  ] as const)('%s / %s / %s (played: %s): used %j, in the deck %j', (consumeAt, policy, outcome, playedIt, used, inDeck) => {
    const loadout = atLoadout(1234, consumeAt, policy);
    const started = ok(startStage(loadout, [...stageCards, 'coach-party']));
    const played: PulseCardId[] = playedIt ? ['coach-party'] : [];
    const after = settleWith(started, outcome, played, playedIt ? 900 : 0);
    expect(after.usedPile).toEqual(used.map((cardId) => ({ cardId, levelIndex: 0 })));
    const loadoutCards: PulseCardId[] = ['local-contractors', 'coach-party'];
    const counts = (deck: readonly PulseCardId[], id: PulseCardId): number => deck.filter((card) => card === id).length;
    for (const id of loadoutCards) {
      expect(counts(after.deck, id), `${id} in the deck`).toBe(counts(loadout.deck, id) - (inDeck.includes(id as never) ? 0 : 1));
    }
    expect(after.history.at(-1)).toMatchObject({ cardIds: loadoutCards, playedCardIds: played, unpaidDebt: playedIt ? 900 : 0 });
    expect(isRunTransition(started, after)).toBe(true);
    expect(() => readRunState(JSON.parse(JSON.stringify(after)))).not.toThrow();
  });

  it('records the played one-shots in loadout order whatever order they are given in, and sanitises the debt', () => {
    const loadout = atLoadout(18, 'stage-start', 'return');
    expect(loadout.deck).toEqual(expect.arrayContaining(['bridging-loan', 'research-grant']));
    const order = loadout.deck.filter((id) => id === 'bridging-loan' || id === 'research-grant');
    const started = ok(startStage(loadout, order));
    const cleared = ok(resolveStage(started, { outcome: 'succeeded', atSeconds: 9, evidence: null, playedCardIds: [...order].reverse(), unpaidDebt: 2_400.4 }));
    expect(cleared.history[0].playedCardIds).toEqual(order);
    expect(cleared.history[0].unpaidDebt).toBe(2_400);
    for (const [debt, expected] of [[Number.NaN, 0], [-5, 0], [1e15, 1e12]] as const) {
      expect(ok(resolveStage(started, { outcome: 'failed', atSeconds: 9, evidence: null, playedCardIds: [order[0]], unpaidDebt: debt })).history[0].unpaidDebt).toBe(expected);
    }
  });

  it('refuses plays that are not a distinct subset of the loadout one-shots (bad-pick), and ignores them outside a stage', () => {
    const started = ok(startStage(atLoadout(1234, 'stage-start', 'return'), ['local-contractors', 'coach-party']));
    const result = { outcome: 'succeeded' as const, atSeconds: 9, evidence: null };
    expect(resolveStage(started, { ...result, playedCardIds: ['local-contractors'] })).toEqual({ ok: false, reason: 'bad-pick' });
    expect(resolveStage(started, { ...result, playedCardIds: ['bridging-loan'] })).toEqual({ ok: false, reason: 'bad-pick' });
    expect(resolveStage(started, { ...result, playedCardIds: ['coach-party', 'coach-party'] })).toEqual({ ok: false, reason: 'bad-pick' });
    expect(resolveStage(started, { ...result, playedCardIds: 'coach-party' as never })).toEqual({ ok: false, reason: 'bad-pick' });
    expect(abandonRun(started, 1, ['nope' as PulseCardId])).toEqual({ ok: false, reason: 'bad-pick' });
    const between = ok(abandonRun(fresh(), 5, ['coach-party'], 900));
    expect(between.history[0]).toMatchObject({ cardIds: [], playedCardIds: [], unpaidDebt: 0 });
  });

  it('isRunTransition replays the plays and the debt: the piles must follow the recorded plays', () => {
    const started = ok(startStage(atLoadout(1234, 'stage-start', 'return'), ['local-contractors', 'coach-party']));
    const cleared = settleWith(started, 'succeeded', ['coach-party'], 900);
    expect(isRunTransition(started, cleared)).toBe(true);
    const entry = cleared.history[0];
    // The plays move cards: a recorded play whose card went back to the deck (or the reverse) is no transition.
    expect(isRunTransition(started, { ...cleared, history: [{ ...entry, playedCardIds: [], unpaidDebt: 0 }] })).toBe(false);
    const unplayed = settleWith(started, 'succeeded', []);
    expect(isRunTransition(started, { ...unplayed, history: [{ ...unplayed.history[0], playedCardIds: ['coach-party'] }] })).toBe(false);
    // The debt, like the seconds, is the park's to report (ParkSession.advanceRun pins it to the ledger): any consistent value replays.
    expect(isRunTransition(started, { ...cleared, history: [{ ...entry, unpaidDebt: 1 }] })).toBe(true);
    expect(isRunTransition(started, { ...cleared, history: [{ ...entry, unpaidDebt: 0.5 }] })).toBe(false);
    const abandoned = settleWith(started, 'abandoned', ['coach-party'], 900);
    expect(isRunTransition(started, abandoned)).toBe(true);
    expect(isRunTransition(started, { ...abandoned, history: [{ ...abandoned.history[0], playedCardIds: [] }] })).toBe(false);
    // The policy is a plan key: it never changes.
    expect(isRunTransition(started, { ...cleared, unplayedOneShots: 'consume' })).toBe(false);
  });

  it('the one-shot policy is a plan key: in the planned part hash (run key) and fixed by createRun from the config', () => {
    const run = fresh(4321);
    expect(run.unplayedOneShots).toBe(GAME_CONFIG.run.unplayedOneShots);
    expect(runKeyOf({ ...run, unplayedOneShots: 'consume' })).not.toBe(runKeyOf(run));
  });
});

describe('slot cost (a rare takes two slots)', () => {
  it('validateLoadout and startStage count slot cost, not cards', () => {
    const rare = PULSE_CARDS.find((card) => card.rarity === 'rare')!;
    const common = PULSE_CARDS.find((card) => card.rarity === 'common')!;
    expect(rare.slotCost).toBe(2);
    const base = ok(acceptOffer(fresh(3, SPARE)));
    const run: RunState = { ...base, deck: [...base.deck, rare.id, common.id].sort((a, b) => PULSE_CARDS.findIndex((c) => c.id === a) - PULSE_CARDS.findIndex((c) => c.id === b)) };
    expect(slotsOf(run)).toBe(2);
    expect(validateLoadout(run, [rare.id])).toEqual({ ok: true });
    expect(validateLoadout(run, [rare.id, common.id])).toEqual({ ok: false, reason: 'too-many' });
    expect(startStage(run, [common.id, rare.id])).toEqual({ ok: false, reason: 'too-many' });
    expect(ok(startStage(run, [rare.id])).loadout).toEqual([rare.id]);
  });
});

describe('reading', () => {
  it('deckCounts lists each distinct card once with its count, in canonical order', () => {
    expect(deckCounts(['lean-crew', 'grand-opening', 'grand-opening'].sort() as PulseCardId[])).toEqual([
      { cardId: 'grand-opening', count: 2 },
      { cardId: 'lean-crew', count: 1 },
    ]);
    expect(deckCounts([])).toEqual([]);
  });

  it('runSummaryOf and runKeyOf: the summary text fields, and a key that does not change while the run is played', () => {
    const run = fresh(4321);
    expect(runSummaryOf(run)).toEqual({ planVersion: run.planVersion, seed: 4321, difficulty: 'standard', levelNumber: 1, levelCount: 5, biomeId: 'meadow', phase: 'offer', levelsCleared: 0 });
    const later = clearOf(ok(acceptOffer(run)), []);
    expect(runSummaryOf(later)).toMatchObject({ levelNumber: 2, levelsCleared: 1, phase: 'offer' });
    expect(runKeyOf(later)).toBe(runKeyOf(run));
    expect(runKeyOf(run)).toMatch(/^4321-standard-[0-9a-f]{16}$/);
    expect(runKeyOf(fresh(4322))).not.toBe(runKeyOf(run));
    expect(runHash(later)).not.toBe(runHash(run));
    expect(runHash(run)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('runSnapshotOf: statuses, structured data and the pending offer', () => {
    const run = fresh(4321);
    const snapshot = runSnapshotOf(run);
    expect(snapshot.levels.map((level) => level.status)).toEqual(['current', 'ahead', 'ahead', 'ahead', 'ahead']);
    expect(snapshot.pendingOffer).toEqual(run.levels[0].offer);
    expect(snapshot.slotsNow).toBe(1);
    expect(snapshot.levels[0]).toMatchObject({ biomeId: 'meadow', biomeName: 'Meadow', index: 0 });
    expect(snapshot.outcome).toBeNull();
    const after = runSnapshotOf(clearOf(ok(acceptOffer(run)), []));
    expect(after.levels.map((level) => level.status)).toEqual(['cleared', 'current', 'ahead', 'ahead', 'ahead']);
    expect(after.pendingOffer).toEqual(run.levels[1].offer);
    expect(after.levelsCleared).toBe(1);
    const abandoned = runSnapshotOf(ok(abandonRun(run)));
    expect(abandoned.levels[0].status).toBe('abandoned');
    expect(abandoned.outcome).toBe('lost');
    expect(abandoned.pendingOffer).toBeNull();
    let won = run;
    for (let i = 0; i < 5; i += 1) won = clearOf(ok(acceptOffer(won)), []);
    expect(runSnapshotOf(won).levels.map((level) => level.status)).toEqual(['cleared', 'cleared', 'cleared', 'cleared', 'cleared']);
    expect(runSnapshotOf(won).outcome).toBe('won');
  });
});
