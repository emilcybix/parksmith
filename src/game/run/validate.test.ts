import { describe, expect, it } from 'vitest';
import { SaveError } from '../save/version';
import { EMPTY_GRANT } from '../session/ParkSession';
import { abandonRun, acceptOffer, createRun, resolveStage, startStage } from './deck';
import { readRunState } from './validate';
import type { RunState } from './types';

/**
 * Phase 23: the hostile corpus of the saved run (the Phase 12 policy: refuse, never normalise). One case per rule of
 * readRunState, in its order: shape, then ids, then the internal laws.
 */
const ok = (step: { ok: boolean; run?: RunState }): RunState => {
  if (!step.ok || !step.run) throw new Error('refused');
  return step.run;
};
const SPARE = { unlockedBuildingIds: [], bonusIds: ['spare-slot' as const] };

const stageAtLevel2 = (): RunState => {
  let run = ok(acceptOffer(createRun({ seed: 1234, difficulty: 'standard', grant: SPARE })));
  run = ok(startStage(run, run.deck.slice(0, 2)));
  run = ok(resolveStage(run, { outcome: 'succeeded', atSeconds: 250.5, evidence: 'Reached 70 guests.' }));
  run = ok(acceptOffer(run));
  return ok(startStage(run, [run.deck[0]]));
};
const offerAtLevel2 = (): RunState => {
  let run = ok(acceptOffer(createRun({ seed: 1234, difficulty: 'standard', grant: EMPTY_GRANT })));
  run = ok(startStage(run, [run.deck[0]]));
  return ok(resolveStage(run, { outcome: 'succeeded', atSeconds: 250.5, evidence: null }));
};
/** Seed 1234 with the Spare card slot: level 1 played Local Contractors and the one-shot Coach Party (played, $900 owed). */
const playedAtLevel2 = (): RunState => {
  let run = ok(acceptOffer(createRun({ seed: 1234, difficulty: 'standard', grant: SPARE })));
  expect(run.deck.slice(0, 2)).toEqual(['local-contractors', 'coach-party']);
  run = ok(startStage(run, ['local-contractors', 'coach-party']));
  run = ok(resolveStage(run, { outcome: 'succeeded', atSeconds: 250.5, evidence: null, playedCardIds: ['coach-party'], unpaidDebt: 900 }));
  run = ok(acceptOffer(run));
  return ok(startStage(run, [run.deck[0]]));
};
const lostAtStage = (): RunState => ok(resolveStage(stageAtLevel2(), { outcome: 'failed', atSeconds: 1_000, evidence: 'Time expired.' }));
const clone = (run: RunState): Record<string, any> => JSON.parse(JSON.stringify(run));

type Case = [name: string, base: () => RunState, mutate: (run: Record<string, any>) => void, code: 'invalid-state' | 'content-mismatch'];

const CASES: Case[] = [
  // Shape
  ['not an object', stageAtLevel2, () => undefined, 'invalid-state'],
  ['an unknown top-level key', stageAtLevel2, (r) => { r.extra = 1; }, 'invalid-state'],
  ['a missing key', stageAtLevel2, (r) => { delete r.history; }, 'invalid-state'],
  ['version 1 (run format 1 under schema 12)', stageAtLevel2, (r) => { r.version = 1; }, 'invalid-state'],
  ['version 3', stageAtLevel2, (r) => { r.version = 3; }, 'invalid-state'],
  ['unplayedOneShots missing', stageAtLevel2, (r) => { delete r.unplayedOneShots; }, 'invalid-state'],
  ['unplayedOneShots later', stageAtLevel2, (r) => { r.unplayedOneShots = 'later'; }, 'invalid-state'],
  ['planVersion 0', stageAtLevel2, (r) => { r.planVersion = 0; }, 'invalid-state'],
  ['planVersion too large', stageAtLevel2, (r) => { r.planVersion = 70_000; }, 'invalid-state'],
  ['a fractional seed', stageAtLevel2, (r) => { r.seed = 1.5; }, 'invalid-state'],
  ['a seed above u32', stageAtLevel2, (r) => { r.seed = 4_294_967_296; }, 'invalid-state'],
  ['a string seed', stageAtLevel2, (r) => { r.seed = '1234'; }, 'invalid-state'],
  ['an unknown difficulty', stageAtLevel2, (r) => { r.difficulty = 'brutal'; }, 'invalid-state'],
  ['an unknown phase', stageAtLevel2, (r) => { r.phase = 'shop'; }, 'invalid-state'],
  ['an unknown consumeAt', stageAtLevel2, (r) => { r.consumeAt = 'never'; }, 'invalid-state'],
  ['an offer rule that is not an object', stageAtLevel2, (r) => { r.offerRule = 'all'; }, 'invalid-state'],
  ['an unknown offer rule kind', stageAtLevel2, (r) => { r.offerRule = { kind: 'random' }; }, 'invalid-state'],
  ['a pick rule with pick 0', stageAtLevel2, (r) => { r.offerRule = { kind: 'pick', pick: 0 }; }, 'invalid-state'],
  ['a pick rule with an extra key', stageAtLevel2, (r) => { r.offerRule = { kind: 'pick', pick: 1, more: true }; }, 'invalid-state'],
  ['an all rule with a pick', stageAtLevel2, (r) => { r.offerRule = { kind: 'all', pick: 1 }; }, 'invalid-state'],
  ['a grant that is not an object', stageAtLevel2, (r) => { r.grant = []; }, 'invalid-state'],
  ['a grant bonus that does not apply on The Map order', stageAtLevel2, (r) => { r.grant = { unlockedBuildingIds: [], bonusIds: ['spare-slot', 'nest-egg'] }; }, 'invalid-state'],
  ['a grant with an unknown bonus', stageAtLevel2, (r) => { r.grant.bonusIds = ['free-money']; }, 'content-mismatch'],
  ['no levels', stageAtLevel2, (r) => { r.levels = []; }, 'invalid-state'],
  ['nine levels', stageAtLevel2, (r) => { r.levels = Array.from({ length: 9 }, () => r.levels[0]); }, 'invalid-state'],
  ['a level that is not an object', stageAtLevel2, (r) => { r.levels[1] = 7; }, 'invalid-state'],
  ['a level with an extra key', stageAtLevel2, (r) => { r.levels[1].bonus = 1; }, 'invalid-state'],
  ['a level index that differs from its position', stageAtLevel2, (r) => { r.levels[2].index = 1; }, 'invalid-state'],
  ['an unknown biome', stageAtLevel2, (r) => { r.levels[1].biomeId = 'moon'; r.levels[1].recipe.biomeId = 'moon'; }, 'content-mismatch'],
  ['a biome that is not a string', stageAtLevel2, (r) => { r.levels[1].biomeId = 5; }, 'invalid-state'],
  ['a recipe that is not a recipe', stageAtLevel2, (r) => { r.levels[1].recipe = { seed: 1 }; }, 'invalid-state'],
  ['a recipe for another biome', stageAtLevel2, (r) => { r.levels[1].recipe.biomeId = r.levels[1].biomeId === 'meadow' ? 'winter' : 'meadow'; }, 'invalid-state'],
  ['a park seed that is negative', stageAtLevel2, (r) => { r.levels[1].parkSeed = -1; }, 'invalid-state'],
  ['an unknown family', stageAtLevel2, (r) => { r.levels[1].family = 'rating'; }, 'invalid-state'],
  ['an objective of another family', stageAtLevel2, (r) => { r.levels[1].family = r.levels[1].family === 'visitors' ? 'crowd' : 'visitors'; }, 'invalid-state'],
  ['an objective id that does not match', stageAtLevel2, (r) => { r.levels[1].objective.id = 'run-free'; }, 'invalid-state'],
  ['an objective target of 0', stageAtLevel2, (r) => { r.levels[1].objective.target = 0; }, 'invalid-state'],
  ['an objective target of 1e13', stageAtLevel2, (r) => { r.levels[1].objective.target = 1e13; }, 'invalid-state'],
  ['an objective target that is NaN-like text', stageAtLevel2, (r) => { r.levels[1].objective.target = 'many'; }, 'invalid-state'],
  ['an objective with an extra key', stageAtLevel2, (r) => { r.levels[1].objective.hidden = true; }, 'invalid-state'],
  ['a sustain objective that is atMost', stageAtLevel2, (r) => { const l = r.levels.find((x: any) => x.family === 'spirits'); if (l) l.objective.comparison = 'atMost'; else throw new Error('x'); }, 'invalid-state'],
  ['a deadline that is not a quarter day', stageAtLevel2, (r) => { r.levels[1].timeLimitDays = 2.1; }, 'invalid-state'],
  ['a deadline of 31 days', stageAtLevel2, (r) => { r.levels[1].timeLimitDays = 31; }, 'invalid-state'],
  ['a deadline of 0 days', stageAtLevel2, (r) => { r.levels[1].timeLimitDays = 0; }, 'invalid-state'],
  ['negative starting cash', stageAtLevel2, (r) => { r.levels[1].startingCash = -1; }, 'invalid-state'],
  ['a billion starting cash', stageAtLevel2, (r) => { r.levels[1].startingCash = 1e9; }, 'invalid-state'],
  ['an unknown condition', stageAtLevel2, (r) => { r.levels[1].conditionIds = ['free-lunch']; }, 'content-mismatch'],
  ['a condition that is not a string', stageAtLevel2, (r) => { r.levels[1].conditionIds = [7]; }, 'invalid-state'],
  ['duplicate conditions', stageAtLevel2, (r) => { r.levels[1].conditionIds = ['quiet-season', 'quiet-season']; }, 'invalid-state'],
  ['five slots', stageAtLevel2, (r) => { r.levels[1].slots = 5; }, 'invalid-state'],
  ['a fractional slot count', stageAtLevel2, (r) => { r.levels[1].slots = 1.5; }, 'invalid-state'],
  ['an unknown card in an offer', stageAtLevel2, (r) => { r.levels[1].offer = ['loaded-dice']; }, 'content-mismatch'],
  ['an offer that is not in canonical order', stageAtLevel2, (r) => { r.levels[1].offer = ['lean-crew', 'grand-opening']; }, 'invalid-state'],
  ['an offer with a duplicate', stageAtLevel2, (r) => { r.levels[1].offer = ['lean-crew', 'lean-crew']; }, 'invalid-state'],
  ['a seven-card offer', stageAtLevel2, (r) => { r.levels[1].offer = Array(7).fill('lean-crew'); }, 'invalid-state'],
  // Decks and piles
  ['an unknown card in the starter deck', stageAtLevel2, (r) => { r.starterDeck[0] = 'loaded-dice'; }, 'content-mismatch'],
  ['an unknown card in the deck', stageAtLevel2, (r) => { r.deck[0] = 'loaded-dice'; }, 'content-mismatch'],
  ['a deck that is not canonical', stageAtLevel2, (r) => { r.deck.reverse(); }, 'invalid-state'],
  ['a deck of 65 cards', stageAtLevel2, (r) => { r.deck = Array(65).fill('grand-opening'); }, 'invalid-state'],
  ['a deck that is not an array', stageAtLevel2, (r) => { r.deck = 'grand-opening'; }, 'invalid-state'],
  ['a card in the deck out of thin air', stageAtLevel2, (r) => { r.deck.push('lean-crew'); r.deck.sort(); }, 'invalid-state'],
  ['a card missing from the deck', stageAtLevel2, (r) => { r.deck.pop(); }, 'invalid-state'],
  ['a used pile that does not match the history', stageAtLevel2, (r) => { r.usedPile.pop(); }, 'invalid-state'],
  ['a used pile entry from the future', stageAtLevel2, (r) => { r.usedPile[0].levelIndex = 4; }, 'invalid-state'],
  ['a used pile entry with an extra key', stageAtLevel2, (r) => { r.usedPile[0].extra = 1; }, 'invalid-state'],
  ['a loadout with a duplicate', stageAtLevel2, (r) => { r.loadout = ['lean-crew', 'lean-crew']; }, 'invalid-state'],
  ['a loadout above the slots', stageAtLevel2, (r) => { r.loadout = ['grand-opening', 'lean-crew', 'velvet-ropes', 'hungry-tourists']; }, 'invalid-state'],
  // Index laws
  ['a park level ahead of the level', stageAtLevel2, (r) => { r.parkLevelIndex = 2; }, 'invalid-state'],
  ['a level index out of range', stageAtLevel2, (r) => { r.levelIndex = 5; }, 'invalid-state'],
  ['a park two levels behind', stageAtLevel2, (r) => { r.levelIndex = 3; r.parkLevelIndex = 1; r.phase = 'offer'; }, 'invalid-state'],
  ['a stage whose park is the level before', stageAtLevel2, (r) => { r.parkLevelIndex = 0; }, 'invalid-state'],
  ['offers seen out of order', stageAtLevel2, (r) => { r.offersSeen = [1, 0]; }, 'invalid-state'],
  ['offers seen that skip a level', stageAtLevel2, (r) => { r.offersSeen = [1]; }, 'invalid-state'],
  ['an offer seen that was never reached', offerAtLevel2, (r) => { r.offersSeen = [0, 1]; }, 'invalid-state'],
  // History
  ['a history that is too short', stageAtLevel2, (r) => { r.history = []; }, 'invalid-state'],
  ['a history that is too long', stageAtLevel2, (r) => { r.history.push({ levelIndex: 1, outcome: 'succeeded', atSeconds: 1, evidence: null, cardIds: [] }); }, 'invalid-state'],
  ['a history entry that is not ascending', stageAtLevel2, (r) => { r.history[0].levelIndex = 1; }, 'invalid-state'],
  ['a failed level before the last result', lostAtStage, (r) => { r.history[0].outcome = 'failed'; }, 'invalid-state'],
  ['an unknown outcome', stageAtLevel2, (r) => { r.history[0].outcome = 'tied'; }, 'invalid-state'],
  ['negative result seconds', stageAtLevel2, (r) => { r.history[0].atSeconds = -1; }, 'invalid-state'],
  ['a result later than the deadline', stageAtLevel2, (r) => { r.history[0].atSeconds = 99_999; }, 'invalid-state'],
  ['evidence that is a number', stageAtLevel2, (r) => { r.history[0].evidence = 5; }, 'invalid-state'],
  ['evidence that is too long', stageAtLevel2, (r) => { r.history[0].evidence = 'x'.repeat(501); }, 'invalid-state'],
  ['a history card that is unknown', stageAtLevel2, (r) => { r.history[0].cardIds = ['loaded-dice']; }, 'content-mismatch'],
  ['history cards beyond the slots', stageAtLevel2, (r) => { r.history[0].cardIds = ['a', 'b', 'c', 'd', 'e', 'f'].map(() => 'lean-crew'); }, 'invalid-state'],
  // One-shots (run format 2, design 9.3)
  ['playedCardIds missing', playedAtLevel2, (r) => { delete r.history[0].playedCardIds; }, 'invalid-state'],
  ['unpaidDebt missing', playedAtLevel2, (r) => { delete r.history[0].unpaidDebt; }, 'invalid-state'],
  ['playedCardIds with a stage card', playedAtLevel2, (r) => { r.history[0].playedCardIds = ['local-contractors', 'coach-party']; }, 'invalid-state'],
  ['playedCardIds not a subset of the cards', playedAtLevel2, (r) => { r.history[0].playedCardIds = ['bridging-loan']; }, 'invalid-state'],
  ['playedCardIds duplicated', playedAtLevel2, (r) => { r.history[0].playedCardIds = ['coach-party', 'coach-party']; }, 'invalid-state'],
  ['playedCardIds not an array', playedAtLevel2, (r) => { r.history[0].playedCardIds = 'coach-party'; }, 'invalid-state'],
  ['playedCardIds with an unknown id', playedAtLevel2, (r) => { r.history[0].playedCardIds = ['loaded-dice']; }, 'content-mismatch'],
  ['a negative unpaidDebt', playedAtLevel2, (r) => { r.history[0].unpaidDebt = -1; }, 'invalid-state'],
  ['a fractional unpaidDebt', playedAtLevel2, (r) => { r.history[0].unpaidDebt = 0.5; }, 'invalid-state'],
  ['a NaN unpaidDebt', playedAtLevel2, (r) => { r.history[0].unpaidDebt = Number.NaN; }, 'invalid-state'],
  ['a string unpaidDebt', playedAtLevel2, (r) => { r.history[0].unpaidDebt = '900'; }, 'invalid-state'],
  ['a debt without any play', stageAtLevel2, (r) => { r.history[0].unpaidDebt = 100; }, 'invalid-state'],
  ['a played card that never went to the used pile', playedAtLevel2, (r) => { r.history[0].playedCardIds = []; r.history[0].unpaidDebt = 0; }, 'invalid-state'],
  ['the used pile still holds an unplayed one-shot after a success under return', stageAtLevel2, (r) => {
    expect(r.history[0].cardIds).toContain('coach-party');
    r.usedPile.splice(1, 0, { cardId: 'coach-party', levelIndex: 0 });
    r.deck.splice(r.deck.indexOf('coach-party'), 1);
  }, 'invalid-state'],
  ['the deck misses the returned one-shot', stageAtLevel2, (r) => { r.deck.splice(r.deck.indexOf('coach-party'), 1); }, 'invalid-state'],
  ['a running loadout whose slot cost exceeds the slots (a rare and a common on 2)', stageAtLevel2, (r) => { r.loadout = ['big-loan', r.loadout[0]]; }, 'invalid-state'],
  ['history cards whose slot cost exceeds the slots', stageAtLevel2, (r) => { r.history[0].cardIds = ['local-contractors', 'big-loan']; }, 'invalid-state'],
  ['an abandon between stages that records a play', offerAtLevel2, (r) => {
    r.phase = 'lost';
    r.history.push({ levelIndex: 1, outcome: 'abandoned', atSeconds: 0, evidence: null, cardIds: [], playedCardIds: ['coach-party'], unpaidDebt: 0 });
  }, 'invalid-state'],
  ['an abandon between stages that records a debt', offerAtLevel2, (r) => {
    r.phase = 'lost';
    r.history.push({ levelIndex: 1, outcome: 'abandoned', atSeconds: 0, evidence: null, cardIds: [], playedCardIds: [], unpaidDebt: 10 });
  }, 'invalid-state'],
  ['a run plan key changed to consume without the used pile following', stageAtLevel2, (r) => { r.unplayedOneShots = 'consume'; }, 'invalid-state'],
  // Phase laws
  ['a won run that is not on the last level', stageAtLevel2, (r) => { r.phase = 'won'; }, 'invalid-state'],
  ['a lost run whose last result succeeded', offerAtLevel2, (r) => { r.phase = 'lost'; }, 'invalid-state'],
  ['a lost run with an extra history entry', lostAtStage, (r) => { r.history.push(r.history[0]); }, 'invalid-state'],
  ['a failed stage with other cards than the loadout', lostAtStage, (r) => { r.loadout = []; }, 'invalid-state'],
  ['an offer phase that still has a stage loadout', offerAtLevel2, (r) => { r.loadout = []; }, 'invalid-state'],
  ['an offer phase with the park two behind', offerAtLevel2, (r) => { r.parkLevelIndex = 1; }, 'invalid-state'],
];

describe('readRunState: a valid run reads back byte for byte', () => {
  it.each([['a stage at level 2', stageAtLevel2], ['an offer at level 2', offerAtLevel2], ['a lost run', lostAtStage], ['a stage after a level with a play and a debt', playedAtLevel2]] as const)('%s', (_name, make) => {
    const run = make();
    const read = readRunState(clone(run));
    expect(JSON.stringify(read)).toBe(JSON.stringify(run));
    expect(read).not.toBe(run);
  });
});

describe('readRunState: the hostile corpus', () => {
  it('has at least 60 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
  });

  it.each(CASES.map((entry, index) => [`${index}: ${entry[0]}`, entry] as const))('%s is refused', (_label, [name, base, mutate, code]) => {
    const raw = clone(base());
    if (name === 'not an object') {
      for (const value of [null, undefined, 5, 'run', [], true]) expect(() => readRunState(value), String(value)).toThrow(SaveError);
      return;
    }
    mutate(raw);
    let thrown: unknown;
    try {
      readRunState(raw);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `${name} must be refused`).toBeInstanceOf(SaveError);
    expect((thrown as SaveError).code, name).toBe(code);
  });

  it('never throws anything but a SaveError, even on random mutations of every leaf (2,000 mutations)', () => {
    let state = 99;
    const next = (): number => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 4_294_967_296; };
    const junk: unknown[] = [null, undefined, -1, 1e300, 'x', [], {}, true, Number.NaN, 0.5, '__proto__'];
    const bases = [stageAtLevel2(), offerAtLevel2(), lostAtStage(), playedAtLevel2()];
    for (let index = 0; index < 2_000; index += 1) {
      const raw = clone(bases[index % bases.length]);
      const paths: Array<Array<string | number>> = [];
      const walk = (value: unknown, path: Array<string | number>): void => {
        if (typeof value === 'object' && value !== null) for (const [key, child] of Object.entries(value)) { paths.push([...path, key]); walk(child, [...path, key]); }
      };
      walk(raw, []);
      const target = paths[Math.floor(next() * paths.length)];
      let holder: any = raw;
      for (const key of target.slice(0, -1)) holder = holder[key];
      holder[target[target.length - 1]] = junk[Math.floor(next() * junk.length)];
      try {
        readRunState(raw);
      } catch (error) {
        expect(error, `mutation ${index} at ${target.join('.')}`).toBeInstanceOf(SaveError);
      }
    }
  });

  it('a hand-edited easier run is readable (it plays) but is not what this build plans: runRewardEligible catches it elsewhere', () => {
    const raw = clone(offerAtLevel2());
    raw.levels[2].objective.target = 1;
    expect(() => readRunState(raw)).not.toThrow();
  });
});

describe('abandon', () => {
  it('an abandoned stage and an abandon between stages read back', () => {
    const withPlay = ok(abandonRun(ok(startStage(ok(acceptOffer(createRun({ seed: 1234, difficulty: 'standard', grant: SPARE }))), ['local-contractors', 'coach-party'])), 12, ['coach-party'], 900));
    expect(withPlay.history[0]).toMatchObject({ playedCardIds: ['coach-party'], unpaidDebt: 900 });
    for (const run of [ok(abandonRun(stageAtLevel2(), 33)), ok(abandonRun(offerAtLevel2())), ok(abandonRun(ok(acceptOffer(offerAtLevel2())))), withPlay]) {
      expect(() => readRunState(clone(run))).not.toThrow();
    }
  });
});
