import { describe, expect, it } from 'vitest';
import { RUN_PLAN_VERSION } from '../game/run/types';
import { cardBadgeLabels, cardNames, continueRunNote, daysText, DIFFICULTY_DETAIL, OLDER_RUN_NOTE, mapModeDetail, MAP_INTRO, numberWord, objectiveShort, readRunSummary, runLevelTitle, runPositionText, runRowText } from './runCopy';
import { baseRun } from './runTestSupport';
import { runSummaryOf } from '../game/run';

describe('run copy', () => {
  it('names a level the same way everywhere', () => {
    const summary = { seed: 1234, difficulty: 'standard', levelNumber: 3, levelCount: 5, biomeId: 'desert-canyon', phase: 'loadout', levelsCleared: 2 } as const;
    expect(runPositionText(summary)).toBe('level 3/5 · seed 1234');
    expect(runLevelTitle(summary)).toBe('Level 3 · Desert Canyon');
    expect(runRowText(summary)).toBe('level 3/5 · seed 1234 · Standard');
  });

  it('says the run size in words, from the config', () => {
    expect(numberWord(5)).toBe('five');
    expect(numberWord(12)).toBe('12');
    expect(mapModeDetail(5)).toBe('Five generated parks, one deck of cards');
    expect(mapModeDetail(7)).toBe('Seven generated parks, one deck of cards');
    expect(MAP_INTRO(5)).toMatch(/^Five generated parks in a row\./);
    expect(MAP_INTRO(5)).toContain('cards you play are used up');
  });

  it('reads the RunSummary of a real run and rejects every malformed one', () => {
    const summary = runSummaryOf(baseRun());
    expect(readRunSummary(summary)).toEqual(summary);
    const bad: unknown[] = [
      null, undefined, 3, 'run', [], {},
      { ...summary, seed: -1 }, { ...summary, seed: 1.5 }, { ...summary, seed: '1234' },
      { ...summary, difficulty: 'brutal' }, { ...summary, levelNumber: 0 }, { ...summary, levelCount: 0 },
      { ...summary, levelNumber: 6, levelCount: 5 }, { ...summary, phase: 'paused' }, { ...summary, biomeId: 7 }, { ...summary, levelsCleared: -1 },
    ];
    for (const value of bad) expect(readRunSummary(value), JSON.stringify(value)).toBeNull();
  });

  it('writes objectives short and days plainly', () => {
    expect(objectiveShort({ kind: 'reach', metric: 'cumulativeGuests', target: 150 })).toBe('150 total visitors');
    expect(objectiveShort({ kind: 'earn', metric: 'operatingProfit', target: 2500 })).toBe('$2,500 operating profit');
    expect(objectiveShort({ kind: 'sustain', metric: 'averageHappiness', target: 72, durationSeconds: 360, comparison: 'atLeast' })).toBe('average happiness ≥ 72% for 6:00');
    expect([1, 1.5, 2, 2.25].map(daysText)).toEqual(['1 day', '1.5 days', '2 days', '2.25 days']);
  });

  it('lists card names and says "none" for no cards', () => {
    expect(cardNames([])).toBe('none');
    expect(cardNames(['grand-opening', 'lean-crew'])).toBe('Grand Opening, Lean Crew');
  });
});

describe('run copy: Phase 25', () => {
  it('card badges are words: one-shot, uncommon, rare with its two slots; a common stage card has none', () => {
    expect(cardBadgeLabels({ kind: 'stage', rarity: 'common', slotCost: 1 })).toEqual([]);
    expect(cardBadgeLabels({})).toEqual([]);
    expect(cardBadgeLabels({ kind: 'one-shot', rarity: 'common', slotCost: 1 })).toEqual(['One-shot']);
    expect(cardBadgeLabels({ kind: 'stage', rarity: 'uncommon', slotCost: 1 })).toEqual(['Uncommon']);
    expect(cardBadgeLabels({ kind: 'stage', rarity: 'rare', slotCost: 2 })).toEqual(['Rare · 2 slots']);
    expect(cardBadgeLabels({ kind: 'one-shot', rarity: 'rare', slotCost: 2 })).toEqual(['One-shot', 'Rare · 2 slots']);
  });

  it('the difficulty details say what the retune did', () => {
    expect(DIFFICULTY_DETAIL.relaxed).toBe("Room to breathe: the first release's deadlines and targets.");
    expect(DIFFICULTY_DETAIL.standard).toBe('Shorter deadlines, higher targets, a little less cash.');
    expect(DIFFICULTY_DETAIL.tough).toBe('An extra condition from level 2 and a cash squeeze: cards make it comfortable.');
  });

  it('the Continue note: shown unless the summary says the run was made by this plan; a plan version survives reading', () => {
    const summary = runSummaryOf(baseRun());
    expect(OLDER_RUN_NOTE).toBe('Runs started before this update finish without rewards.');
    expect(continueRunNote(readRunSummary({ ...summary, planVersion: RUN_PLAN_VERSION })!)).toBeNull();
    expect(continueRunNote(readRunSummary({ ...summary, planVersion: RUN_PLAN_VERSION - 1 })!)).toBe(OLDER_RUN_NOTE);
    const withoutVersion: Record<string, unknown> = { ...summary };
    delete withoutVersion.planVersion;
    expect(continueRunNote(readRunSummary(withoutVersion)!)).toBe(OLDER_RUN_NOTE);
    expect(readRunSummary({ ...withoutVersion, planVersion: 'x' })).toEqual(withoutVersion);
    expect(readRunSummary({ ...withoutVersion, planVersion: 2.5 })).toEqual(withoutVersion);
  });
});

