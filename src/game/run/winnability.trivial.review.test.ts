import { describe, expect, it } from 'vitest';
import { BASIC_PLAN, LAZY_PLAN } from '../scenarios/bot/plans';
import { runStageBot, withinMargin } from './runBot';
import { hardestLevelOf, testRunWithForcedLevel } from './testSupport';
import { RUN_OBJECTIVE_FAMILIES, type RunDifficulty, type RunObjectiveFamily } from './types';

interface NodeBuiltins {
  process: { env: Record<string, string | undefined>; stderr: { write(text: string): void }; getBuiltinModule(id: string): never };
}
const nodeProcess = (globalThis as unknown as NodeBuiltins).process;

/**
 * Phase 23 review (adversarial balance): is every family a challenge where it is hardest? The builder's "not trivial"
 * check runs the lazy bot on L1 and L5 of one seed only (whatever family those draw). Here each family is forced on the
 * last level that draws it (plan version 2: crowd L2, spirits L4, visitors and profit L5) at Tough in the Meadow: the
 * lazy plan (4 tiles of path, nothing else) and the First Day plan (a carousel, two stalls, a roundabout) must NOT clear
 * it comfortably. Cards alone at Tough on the binding family: winnability.cards.test.ts (Phase 25, a fixed sample).
 */
const levelWith = (family: RunObjectiveFamily, difficulty: RunDifficulty, seed = 41) => (
  testRunWithForcedLevel(hardestLevelOf(family), 'meadow', family, { seed, difficulty })
);

const note = (row: string) => nodeProcess.stderr.write(`${row}\n`);

describe('The Map review: at Tough no family is trivial on the last level that draws it', () => {
  for (const family of RUN_OBJECTIVE_FAMILIES) {
    it(`${family}: the lazy plan fails`, () => {
      const run = levelWith(family, 'tough');
      const result = runStageBot(run, [], LAZY_PLAN);
      note(`trivial | lazy | tough L${hardestLevelOf(family) + 1} meadow ${family} target ${run.levels[hardestLevelOf(family)].objective.target} | ${result.status} at ${result.completedAtSeconds}s, peak guests ${result.guestsPeak}`);
      expect(result.status).not.toBe('succeeded');
    }, 120_000);
    it(`${family}: the First Day plan does not clear it comfortably`, () => {
      const run = levelWith(family, 'tough');
      const result = runStageBot(run, [], BASIC_PLAN);
      note(`trivial | basic | tough L${hardestLevelOf(family) + 1} meadow ${family} target ${run.levels[hardestLevelOf(family)].objective.target} | ${result.status} at ${result.completedAtSeconds}s of ${result.deadlineSeconds}s, peak guests ${result.guestsPeak}`);
      expect(withinMargin(result, result.deadlineSeconds, 0.5)).toBe(false);
    }, 120_000);
  }
});
