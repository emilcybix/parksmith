import { describe, expect, it } from 'vitest';
import { noteMargin } from './marginsSink';
import { GAME_CONFIG } from '../config';
import { essentialSkips, marginOf, runStageBot, withinMargin } from './runBot';
import { testRunAtLevel } from './testSupport';
import { RUN_DIFFICULTIES } from './types';

/**
 * Phase 23 winnability proof, suite 1 ("no single card is required"): the Phase 22 scripted player, with NO card, on every
 * level of 4 fixed run seeds at every difficulty (60 stage runs), each built exactly as the app builds a stage. A level is
 * cleared when the bot succeeds with no ride, stall or amenity skipped, never goes below $0 and is done within
 * GAME_CONFIG.run.difficulties[d].botMargin of the deadline. The margins table is printed (and appended to
 * $RUN_MARGINS_OUT when set) for BALANCE_NOTES.
 */
const SEEDS = [1, 2, 3, 4] as const;

describe('The Map winnability: no card, every level, every difficulty', () => {
  for (const seed of SEEDS) {
    for (const difficulty of RUN_DIFFICULTIES) {
      it(`seed ${seed} ${difficulty}: all ${GAME_CONFIG.run.levelCount} levels are cleared within the margin`, () => {
        for (let levelIndex = 0; levelIndex < GAME_CONFIG.run.levelCount; levelIndex += 1) {
          const run = testRunAtLevel(levelIndex, { seed, difficulty });
          const level = run.levels[levelIndex];
          const result = runStageBot(run);
          const percent = result.completedAtSeconds === null ? null : Math.round((100 * result.completedAtSeconds) / result.deadlineSeconds);
          const row = `nocard | seed ${seed} | ${difficulty} | L${levelIndex + 1} | ${level.biomeId} | ${level.family} | target ${level.objective.target} | ${level.conditionIds.join('+') || '-'} | ${result.status} at ${result.completedAtSeconds}s of ${result.deadlineSeconds}s (${percent}%) | min cash ${Math.round(result.minimumCash)} | peak guests ${result.guestsPeak} | scenery skipped ${result.skipped.length - essentialSkips(result).length}`;
          noteMargin(row);
          expect(withinMargin(result, result.deadlineSeconds, marginOf(run)), row).toBe(true);
        }
      }, 120_000);
    }
  }
});
