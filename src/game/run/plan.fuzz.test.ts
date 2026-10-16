import { describe, expect, it } from 'vitest';
import { EMPTY_GRANT } from '../session/ParkSession';
import { createRun } from './deck';
import { planRun } from './plan';
import { RUN_DIFFICULTIES } from './types';

/**
 * The plan never fails to find a map: createRun over 2,000 run seeds x 3 difficulties never throws RunPlanBug (a bug in
 * the plan or the generator, never an input problem), and planRun alone over 1,000 more never throws either.
 */
describe('createRun fuzz', () => {
  for (const difficulty of RUN_DIFFICULTIES) {
    it(`2,000 seeds at ${difficulty}: every level gets an accepted map`, () => {
      for (let index = 0; index < 2_000; index += 1) {
        const seed = (index * 2_147_483 + 17) >>> 0;
        const run = createRun({ seed, difficulty, grant: EMPTY_GRANT });
        expect(run.levels.length).toBe(5);
      }
    }, 300_000);
  }

  it('planRun alone over 1,000 spread seeds never throws', () => {
    for (let index = 0; index < 1_000; index += 1) {
      for (const difficulty of RUN_DIFFICULTIES) expect(() => planRun({ seed: (index * 4_294_967) >>> 0, difficulty })).not.toThrow();
    }
  });
});
