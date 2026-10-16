import { describe, expect, it } from 'vitest';
import type { RunRewardResult } from '../game/profile/types';
import type { RunSnapshot } from '../game/run/types';
import { buildRunEnd, buildStageResult, carriedDebtNote, levelCardsText, sentence, startingCashAfterDebt } from './runResultModel';
import { snapshotAt } from './runTestSupport';

const rewards = (overrides: Partial<RunRewardResult> = {}): RunRewardResult => ({
  eligible: true, alreadyRecorded: false, outcome: 'won', newlyDiscoveredCardIds: [], newlyUnlockedDifficulties: [], newBestLevel: false, previousBestLevel: 0, bestLevel: 5, ...overrides,
});

describe('stage result', () => {
  it('names the level cleared, its evidence, time, cards used and what comes next', () => {
    const model = buildStageResult(snapshotAt(1, 'cleared'));
    expect(model?.heading).toBe('Level 2 cleared');
    expect(model?.evidence).toBe('Reached 150 total visitors at 6:52');
    expect(model?.parkTime).toBe('Park time 6:52');
    expect(model?.cardsUsed).toMatch(/^Cards used: /);
    expect(model?.next).toMatch(/^Level 3 · .+ — .+/);
    expect(model?.primaryLabel).toBe('Continue to The Map');
  });

  it('has no "next" after the last level, and nothing at all before a level was cleared', () => {
    expect(buildStageResult(snapshotAt(0, 'won'))?.next).toBeNull();
    expect(buildStageResult(snapshotAt(0, 'offer'))).toBeNull();
    expect(buildStageResult(snapshotAt(2, 'lost'))?.heading).toBe('Level 2 cleared');
  });

  it('capitalises an evidence clause into a sentence', () => {
    expect(sentence('operating profit $2,310')).toBe('Operating profit $2,310');
    expect(sentence('  ')).toBeNull();
    expect(sentence(null)).toBeNull();
  });
});

describe('run end', () => {
  it('victory: a table of every level, totals, the rewards and the three buttons', () => {
    const model = buildRunEnd(snapshotAt(0, 'won'), rewards({ newlyDiscoveredCardIds: ['velvet-ropes'], newlyUnlockedDifficulties: ['tough'], newBestLevel: true, bestLevel: 5 }));
    expect(model?.kind).toBe('won');
    expect(model?.heading).toBe('The Map is yours!');
    expect(model?.rows).toHaveLength(5);
    expect(model?.rows.every((row) => row.outcome.startsWith('Cleared'))).toBe(true);
    expect(model?.totals).toMatch(/^Park time [\d:]+ · \d+ cards? played$/);
    expect(model?.rewardLines.map((line) => line.text)).toEqual([
      'New cards discovered: Velvet Ropes', 'Tough difficulty unlocked', 'New best on Standard: 5/5 levels',
    ]);
    expect(model?.actions.map((action) => action.id)).toEqual(['same-seed', 'new-run', 'main-menu']);
    expect(model?.actions.filter((action) => action.primary)).toHaveLength(1);
    expect(model?.actions[0].label).toBe('New run with this seed');
  });

  it('victory with every card known says so, and a repeat says it was recorded', () => {
    expect(buildRunEnd(snapshotAt(0, 'won'), rewards())?.rewardLines.map((line) => line.text)).toContain('Every card was already in your collection.');
    expect(buildRunEnd(snapshotAt(0, 'won'), rewards({ alreadyRecorded: true }))?.rewardLines.map((line) => line.text)).toContain('This run was already recorded.');
  });

  it('failure: the level reached, the evidence, the levels played and "Try this seed again"', () => {
    const model = buildRunEnd(snapshotAt(2, 'lost'), rewards({ outcome: 'lost', bestLevel: 2, previousBestLevel: 2 }));
    expect(model?.kind).toBe('lost');
    expect(model?.heading).toBe('Run over — level 3 of 5');
    expect(model?.evidence).toBe('Operating profit $2,310 of $3,500 when time ran out');
    expect(model?.rows.map((row) => row.outcome)).toEqual([expect.stringMatching(/^Cleared/), expect.stringMatching(/^Cleared/), 'Failed']);
    expect(model?.rewardLines.map((line) => line.text)).toEqual(['Best on Standard: 2/5 levels']);
    expect(model?.note).toBe('Cards are discovered when you win a run.');
    expect(model?.actions[0]).toEqual({ id: 'same-seed', label: 'Try this seed again', primary: true });
  });

  it('an abandoned run says so instead of an evidence line', () => {
    const model = buildRunEnd(snapshotAt(1, 'abandoned'), rewards({ outcome: 'lost', bestLevel: 1 }));
    expect(model?.kind).toBe('abandoned');
    expect(model?.evidence).toBe('You abandoned the run.');
    expect(model?.rows[1].outcome).toBe('Abandoned');
  });

  it('an ineligible run gets one honest line instead of rewards', () => {
    const model = buildRunEnd(snapshotAt(0, 'won'), rewards({ eligible: false }));
    expect(model?.rewardLines).toHaveLength(1);
    expect(model?.rewardLines[0].text).toMatch(/^No rewards:/);
  });

  it('no reward answer yet shows no reward lines, and a run still going has no end screen', () => {
    expect(buildRunEnd(snapshotAt(0, 'won'), null)?.rewardLines).toEqual([]);
    expect(buildRunEnd(snapshotAt(1, 'stage'), null)).toBeNull();
    expect(buildRunEnd(snapshotAt(1, 'offer'), null)).toBeNull();
  });
});

describe('one-shots and debt on the result screens (Phase 25)', () => {
  const result = (patch: Record<string, unknown>) => ({ levelIndex: 1, outcome: 'succeeded', atSeconds: 300, evidence: null, cardIds: [], playedCardIds: [], unpaidDebt: 0, ...patch }) as never;

  it('names each card of a level: stage cards plainly, one-shots played or unplayed and where they went', () => {
    const level = { index: 1, result: result({ cardIds: ['grand-opening', 'coach-party', 'bridging-loan'], playedCardIds: ['coach-party'] }) };
    expect(levelCardsText({ usedPile: [] }, level)).toBe('Grand Opening · Coach Party (played) · Bridging Loan (unplayed, back in your deck)');
    // Under the 'consume' policy the unplayed one-shot stays in the used pile for that level.
    expect(levelCardsText({ usedPile: [{ cardId: 'bridging-loan', levelIndex: 1 }] }, level)).toContain('Bridging Loan (unplayed, used up)');
    expect(levelCardsText({ usedPile: [{ cardId: 'bridging-loan', levelIndex: 0 }] }, level), 'another level\'s copy does not count').toContain('back in your deck');
    expect(levelCardsText({ usedPile: [] }, { index: 0, result: result({}) })).toBe('none');
  });

  const withDebt = (base: RunSnapshot, levelIndex: number, debt: number): RunSnapshot => {
    const run = structuredClone(base);
    run.levels[levelIndex].result = { ...run.levels[levelIndex].result!, unpaidDebt: debt };
    return run;
  };

  it('a cleared level with costs still pending says they come off the next level, and the next level starts lower', () => {
    const base = snapshotAt(1, 'cleared');
    expect(buildStageResult(base)?.debt).toBeNull();
    const run = withDebt(base, 1, 2_400);
    expect(buildStageResult(run)?.debt).toBe("Unpaid: $2,400 comes off level 3's starting cash");
    expect(startingCashAfterDebt(run, 2)).toBe(Math.max(0, run.levels[2].startingCash - 2_400));
    expect(startingCashAfterDebt(run, 1), 'only the next level').toBe(run.levels[1].startingCash);
    expect(carriedDebtNote(run, 2)).toBe(' (−$2,400 unpaid from level 2)');
    expect(carriedDebtNote(run, 1)).toBe('');
    expect(startingCashAfterDebt(withDebt(base, 1, 10_000_000), 2), 'never below zero').toBe(0);
  });

  it('the end screens say what was left unpaid when the run ended (forgiven)', () => {
    const won = snapshotAt(0, 'won');
    expect(buildRunEnd(won, null)?.debt).toBeNull();
    const last = won.levels.length - 1;
    expect(buildRunEnd(withDebt(won, last, 2_400), null)?.debt).toBe('Unpaid at the end: $2,400');
    expect(buildStageResult(withDebt(won, last, 2_400))?.debt).toBe('Unpaid at the end: $2,400');
    const lost = snapshotAt(2, 'lost');
    expect(buildRunEnd(withDebt(lost, 2, 900), null)?.debt).toBe('Unpaid at the end: $900');
  });
});
