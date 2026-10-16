import { CARD_BY_ID } from '../game/cards/content';
import { describe, expect, it } from 'vitest';
import { runSnapshotOf, type RunSnapshot } from '../game/run';
import {
  buildRunMap, defaultSelectedLevel, deckRowsOf, IN_POCKET_TEXT, moveLevelFocus, primaryActionOf, runKicker, runSummaryLine, summaryOfSnapshot, usedRowsOf,
} from './runMapModel';
import { runAt, snapshotAt } from './runTestSupport';

const mapOf = (run: RunSnapshot, selected: number | null) => {
  const model = buildRunMap(run, selected);
  if (model === null) throw new Error('no map');
  return model;
};

describe('run map model', () => {
  it('lays the levels out as a path with a status word on every one, never colour alone', () => {
    const run = snapshotAt(2, 'loadout');
    const model = mapOf(run, null);
    expect(model.nodes).toHaveLength(run.levelCount);
    expect(model.nodes.map((node) => node.status)).toEqual(['cleared', 'cleared', 'current', 'ahead', 'ahead']);
    expect(model.nodes.map((node) => node.statusLabel)).toEqual([expect.stringMatching(/^Cleared \d+:\d\d$/), expect.stringMatching(/^Cleared \d+:\d\d$/), 'Next', 'Ahead', 'Ahead']);
    expect(model.nodes.filter((node) => node.current).map((node) => node.index)).toEqual([2]);
    for (const node of model.nodes) {
      expect(node.ariaLabel).toContain(`Level ${node.index + 1}, ${node.biomeName}`);
      expect(node.ariaLabel).toContain(node.statusLabel);
      expect(node.swatches.length).toBeGreaterThan(0);
      for (const colour of node.swatches) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('level 1 is Meadow and the first node is the current one at the start', () => {
    const model = mapOf(snapshotAt(0, 'offer'), null);
    expect(model.nodes[0].biomeName).toBe('Meadow');
    expect(model.nodes[0].current).toBe(true);
    expect(model.nodes[0].statusLabel).toBe('Next');
    expect(model.heading).toBe('Level 1 of 5');
  });

  it('selects the current level by default and any valid pick; a bad pick falls back', () => {
    const run = snapshotAt(2, 'loadout');
    expect(defaultSelectedLevel(run)).toBe(2);
    expect(mapOf(run, null).nodes.filter((node) => node.selected).map((node) => node.index)).toEqual([2]);
    expect(mapOf(run, 4).detail.index).toBe(4);
    expect(mapOf(run, 0).detail.resultLines.some((line) => line.startsWith('Cards used:'))).toBe(true);
    for (const bad of [-1, 5, 99, 1.5]) expect(mapOf(run, bad).detail.index, String(bad)).toBeGreaterThanOrEqual(0);
    expect(mapOf(run, 7).detail.index).toBe(2);
    expect(mapOf(run, -3).detail.index).toBe(2);
  });

  it('the detail says everything about a level ahead: nothing is hidden', () => {
    const run = snapshotAt(0, 'offer');
    const detail = mapOf(run, 3).detail;
    expect(detail.heading).toMatch(/^Level 4 · /);
    expect(detail.objectiveSentence.length).toBeGreaterThan(10);
    expect(detail.deadline).toMatch(/^Time limit [\d.]+ days?$/);
    expect(detail.startingCash).toMatch(/^Starting cash \$[\d,]+$/);
    expect(detail.slots).toBe('2 card slots');
    expect(detail.offer).toBe('Offer before this level: 2 cards');
    expect(detail.conditions.length).toBeGreaterThan(0);
    expect(detail.resultLines).toEqual([]);
  });

  it('the primary action follows the phase', () => {
    expect(primaryActionOf(snapshotAt(2, 'offer'))).toEqual({ id: 'see-offer', label: 'See the offer for level 3' });
    expect(primaryActionOf(snapshotAt(2, 'loadout'))).toEqual({ id: 'choose-cards', label: 'Choose cards for level 3' });
    expect(primaryActionOf(snapshotAt(2, 'stage'))).toEqual({ id: 'back-to-park', label: 'Back to the park' });
    expect(primaryActionOf(snapshotAt(2, 'lost')).id).toBe('none');
    expect(primaryActionOf(snapshotAt(0, 'won')).id).toBe('none');
  });

  it('abandoning is offered only while the run goes on', () => {
    expect(mapOf(snapshotAt(1, 'loadout'), null).canAbandon).toBe(true);
    expect(mapOf(snapshotAt(1, 'stage'), null).canAbandon).toBe(true);
    expect(mapOf(snapshotAt(1, 'lost'), null).canAbandon).toBe(false);
    expect(mapOf(snapshotAt(0, 'won'), null).canAbandon).toBe(false);
  });

  it('marks a failed and an abandoned level by word', () => {
    expect(mapOf(snapshotAt(1, 'lost'), null).nodes[1].statusLabel).toBe('Failed');
    expect(mapOf(snapshotAt(1, 'abandoned'), null).nodes[1].statusLabel).toBe('Abandoned');
    expect(mapOf(snapshotAt(0, 'won'), null).nodes.every((node) => node.status === 'cleared')).toBe(true);
  });

  it('the summary row counts what the run holds', () => {
    const run = snapshotAt(2, 'loadout');
    expect(runSummaryLine(run)).toBe(`Levels cleared 2/5 · Deck ${run.deckSize} cards · Used ${run.usedPile.length}`);
    const model = mapOf(run, null);
    expect(model.deckLabel).toBe(`Deck (${run.deckSize})`);
    expect(model.usedLabel).toBe(`Used (${run.usedPile.length})`);
    expect(runKicker({ difficulty: 'tough', seed: 77 })).toBe('THE MAP · TOUGH · SEED 77');
  });

  it('lists the deck with counts and the used pile with its level', () => {
    const run = snapshotAt(2, 'loadout');
    const deck = deckRowsOf(run);
    expect(deck.reduce((sum, row) => sum + row.count, 0)).toBe(run.deckSize);
    for (const row of deck) {
      expect(row.upside.length).toBeGreaterThan(0);
      expect(row.downside.length).toBeGreaterThan(0);
    }
    const used = usedRowsOf(run);
    expect(used).toHaveLength(run.usedPile.length);
    expect(used.length).toBeGreaterThan(0);
    expect(used[0].where).toMatch(/^Level 1 · Meadow$/);
    expect(deckRowsOf(snapshotAt(0, 'offer')).length).toBeGreaterThan(0);
  });

  it('the drawers carry every card kind, rarity and slot cost (Phase 25 badges)', () => {
    const run = snapshotAt(2, 'stage');
    for (const row of [...deckRowsOf(run), ...usedRowsOf(run)]) {
      const card = CARD_BY_ID.get(row.cardId);
      expect(row).toMatchObject({ kind: card?.kind, rarity: card?.rarity, slotCost: card?.slotCost });
    }
  });

  it('during a stage, the unplayed one-shots of this level are in the pocket, not spent', () => {
    const stage = snapshotAt(2, 'stage');
    const run = { ...stage, usedPile: [...stage.usedPile, { cardId: 'coach-party' as const, levelIndex: 2 }, { cardId: 'bridging-loan' as const, levelIndex: 2 }, { cardId: 'sweep-the-park' as const, levelIndex: 1 }] };
    const rows = usedRowsOf(run, ['bridging-loan']);
    const coach = rows.find((row) => row.cardId === 'coach-party');
    expect(coach?.inPocket).toBe(true);
    expect(coach?.where).toBe(`Level 3 · ${run.levels[2].biomeName} · ${IN_POCKET_TEXT}`);
    expect(IN_POCKET_TEXT).toBe('in your pocket this level');
    expect(rows.find((row) => row.cardId === 'bridging-loan')?.inPocket).toBe(false);
    expect(rows.find((row) => row.cardId === 'sweep-the-park')?.inPocket).toBe(false);
    expect(rows.filter((row) => row.kind === 'stage').every((row) => !row.inPocket)).toBe(true);
    // Between levels nothing is in the pocket: the stage settled (an unplayed one-shot went back to the deck).
    expect(usedRowsOf({ ...run, phase: 'loadout' }).some((row) => row.inPocket)).toBe(false);
  });

  it('a snapshot with no levels is nothing to show, never a crash', () => {
    const run = { ...snapshotAt(1, 'loadout'), levels: [], levelCount: 0 };
    expect(buildRunMap(run, null)).toBeNull();
    expect(defaultSelectedLevel(run)).toBe(0);
  });

  it('moves along the path and wraps like a radio group, Home and End reach the ends', () => {
    expect(moveLevelFocus(5, 0, 'ArrowRight')).toBe(1);
    expect(moveLevelFocus(5, 4, 'ArrowRight')).toBe(0);
    expect(moveLevelFocus(5, 0, 'ArrowLeft')).toBe(4);
    expect(moveLevelFocus(5, 99, 'ArrowRight')).toBe(0);
    expect(moveLevelFocus(5, 2, 'ArrowDown')).toBe(3);
    expect(moveLevelFocus(5, 2, 'ArrowUp')).toBe(1);
    expect(moveLevelFocus(5, 2, 'Home')).toBe(0);
    expect(moveLevelFocus(5, 2, 'End')).toBe(4);
    expect(moveLevelFocus(5, 2, 'Enter')).toBeNull();
    expect(moveLevelFocus(0, 0, 'ArrowRight')).toBeNull();
  });

  it('the summary of a snapshot is what a save header carries', () => {
    const state = runAt(2, 'stage');
    const summary = summaryOfSnapshot(runSnapshotOf(state));
    expect(summary).toEqual({ seed: state.seed, difficulty: state.difficulty, levelNumber: 3, levelCount: 5, biomeId: state.levels[2].biomeId, phase: 'stage', levelsCleared: 2 });
    // A run that has ended names the level it ended on, never a level after the last.
    expect(summaryOfSnapshot(snapshotAt(0, 'won')).levelNumber).toBe(5);
  });
});
