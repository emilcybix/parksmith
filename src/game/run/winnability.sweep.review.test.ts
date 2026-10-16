import { describe, expect, it } from 'vitest';
import { essentialSkips, marginOf, runStageBot, withinMargin } from './runBot';
import { testRunAtLevel } from './testSupport';
import { RUN_DIFFICULTIES, type RunDifficulty } from './types';
import { GAME_CONFIG } from '../config';

interface NodeBuiltins {
  process: { env: Record<string, string | undefined>; stderr: { write(text: string): void }; getBuiltinModule(id: string): never };
}
const nodeProcess = (globalThis as unknown as NodeBuiltins).process;
const { appendFileSync } = nodeProcess.getBuiltinModule('node:fs') as { appendFileSync(path: string, data: string): void };

/**
 * Phase 23 review (adversarial balance): the no-card bot over 20 seeds x 3 difficulties x every level (300 stages).
 * Opt-in (slow): RUN_SWEEP=1 [RUN_SWEEP_DIFFICULTY=standard] [RUN_SWEEP_SEEDS=101..120] [RUN_SWEEP_OUT=file].
 * The seeds are NOT the ones the builder's proof uses (1..4, 11..34). Every stage must clear within the difficulty's
 * bot margin; the rows report the margin per level for BALANCE_NOTES.
 */
const enabled = nodeProcess.env.RUN_SWEEP === '1';
const [from, to] = (nodeProcess.env.RUN_SWEEP_SEEDS ?? '101..120').split('..').map(Number);
const difficulties: RunDifficulty[] = nodeProcess.env.RUN_SWEEP_DIFFICULTY
  ? [nodeProcess.env.RUN_SWEEP_DIFFICULTY as RunDifficulty]
  : [...RUN_DIFFICULTIES];

describe.skipIf(!enabled)('The Map review sweep: no card, 20 fresh seeds', () => {
  for (const difficulty of difficulties) {
    for (let seed = from; seed <= to; seed += 1) {
      it(`seed ${seed} ${difficulty}`, () => {
        const failures: string[] = [];
        for (let levelIndex = 0; levelIndex < GAME_CONFIG.run.levelCount; levelIndex += 1) {
          const run = testRunAtLevel(levelIndex, { seed, difficulty });
          const level = run.levels[levelIndex];
          const result = runStageBot(run);
          const pct = result.completedAtSeconds === null ? null : Math.round((100 * result.completedAtSeconds) / result.deadlineSeconds);
          const ok = withinMargin(result, result.deadlineSeconds, marginOf(run));
          const row = `sweep|${difficulty}|${seed}|L${levelIndex + 1}|${level.biomeId}|${level.family}|${level.objective.target}|${level.conditionIds.join('+') || '-'}|${result.status}|${pct}|${Math.round(result.minimumCash)}|${essentialSkips(result).join(',') || '-'}|${ok ? 'OK' : 'MISS'}`;
          if (nodeProcess.env.RUN_SWEEP_OUT) appendFileSync(nodeProcess.env.RUN_SWEEP_OUT, `${row}\n`);
          if (!ok) failures.push(row);
        }
        expect(failures).toEqual([]);
      }, 600_000);
    }
  }
});
