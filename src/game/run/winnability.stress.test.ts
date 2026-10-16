import { describe, expect, it } from 'vitest';
import { noteMargin } from './marginsSink';
import { BIOME_IDS } from '../biomes/types';
import { GAME_CONFIG } from '../config';
import { LAZY_PLAN, delayPlan, richPlan } from '../scenarios/bot/plans';
import { lockedIdsOf } from './content';
import { acceptedRecipeOf, planLevelForTest } from './plan';
import { marginOf, runStageBot, withinMargin } from './runBot';
import { hardestLevelOf, testRunAtLevel, withLevel } from './testSupport';
import { RUN_OBJECTIVE_FAMILIES } from './types';

/**
 * Phase 23 winnability proof, suites 2 to 5: the biome x family stress at the hardest setting, seed and delay
 * robustness, and the "not trivial" check. See winnability.noCards.test.ts for the margin rule. The card proofs (every card
 * alone, a Tough sample, a plausible deck, the starter deck) are winnability.cards.test.ts (Phase 25).
 */
const note = noteMargin;
const LAST = GAME_CONFIG.run.levelCount - 1;

describe('The Map winnability: at Tough, every biome x every family on the last level that draws it (no card)', () => {
  // Plan version 2: crowd is drawn up to level 2, spirits up to level 4, visitors and profit up to level 5.
  for (const biomeId of BIOME_IDS) {
    it(`${biomeId}: all four families are cleared within the Tough margin`, () => {
      for (const family of RUN_OBJECTIVE_FAMILIES) {
        const at = hardestLevelOf(family);
        // A different run seed per cell, so the conditions and the maps differ across the 24 cells.
        const seed = 11 + BIOME_IDS.indexOf(biomeId) * 4 + RUN_OBJECTIVE_FAMILIES.indexOf(family);
        const base = testRunAtLevel(at, { seed, difficulty: 'tough' });
        const planned = planLevelForTest(seed, at, biomeId, family, 'tough');
        const { density, ...rest } = planned;
        const level = { ...rest, recipe: acceptedRecipeOf(seed, planned).recipe };
        const run = withLevel(base, { ...level, offer: base.levels[at].offer });
        const result = runStageBot(run, [], richPlan(lockedIdsOf(level.conditionIds)));
        const row = `stress | tough L${at + 1} | ${biomeId} | ${family} | target ${level.objective.target} | ${level.conditionIds.join('+') || '-'} | ${result.status} at ${result.completedAtSeconds}s of ${result.deadlineSeconds}s | min cash ${Math.round(result.minimumCash)} | density ${density}`;
        note(row);
        expect(withinMargin(result, result.deadlineSeconds, marginOf(run)), row).toBe(true);
      }
    }, 120_000);
  }
});

describe('The Map winnability: a human is slower and the park seed is not special', () => {
  it('Standard, seed 1, every level: a plan delayed by 90 s, and the next park seed, still clears within the margin', () => {
    for (let levelIndex = 0; levelIndex <= LAST; levelIndex += 1) {
      const run = testRunAtLevel(levelIndex, { seed: 1, difficulty: 'standard' });
      const level = run.levels[levelIndex];
      const locked = lockedIdsOf(level.conditionIds);
      const delayed = runStageBot(run, [], delayPlan(richPlan(locked), 90));
      const shifted = runStageBot(withLevel(run, { ...level, parkSeed: (level.parkSeed + 1) >>> 0 }), [], richPlan(locked));
      note(`robust | standard seed 1 | L${levelIndex + 1} | ${level.biomeId} | ${level.family} | delayed 90 s: ${delayed.completedAtSeconds}s | park seed +1: ${shifted.completedAtSeconds}s | of ${delayed.deadlineSeconds}s`);
      // Standard's bot margin (0.90 since the Phase 25 retune; it was a flat 0.85 when Standard was today's Relaxed).
      expect(withinMargin(delayed, delayed.deadlineSeconds, marginOf(run)), `delayed L${levelIndex + 1}`).toBe(true);
      expect(withinMargin(shifted, shifted.deadlineSeconds, marginOf(run)), `shifted L${levelIndex + 1}`).toBe(true);
    }
  }, 300_000);
});

describe('The Map winnability: the levels are not trivial', () => {
  it('a bot that only lays four path tiles clears nothing: level 1 of seeds 1 and 2 and level 5 of seed 1', () => {
    for (const [seed, levelIndex] of [[1, 0], [2, 0], [1, LAST]] as const) {
      const run = testRunAtLevel(levelIndex, { seed, difficulty: 'standard' });
      const result = runStageBot(run, [], LAZY_PLAN);
      note(`lazy | seed ${seed} L${levelIndex + 1} | ${result.status}`);
      expect(result.status, `seed ${seed} level ${levelIndex + 1}`).toBe('failed');
    }
  }, 120_000);
});
