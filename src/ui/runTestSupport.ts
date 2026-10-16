import { acceptOffer, abandonRun, createRun, resolveStage, runSnapshotOf, startStage, type RunDifficulty, type RunSnapshot, type RunState } from '../game/run';

/**
 * Runs for the UI tests: the real run model (`createRun` makes the five generated maps once per seed and difficulty and
 * is cached), driven to a level and phase with the real transitions. Never a hand-built run.
 */

const NO_GRANT = { unlockedBuildingIds: [], bonusIds: [] } as const;
const created = new Map<string, RunState>();

export const baseRun = (seed = 1234, difficulty: RunDifficulty = 'standard'): RunState => {
  const key = `${seed}:${difficulty}`;
  let run = created.get(key);
  if (run === undefined) {
    run = createRun({ seed, difficulty, grant: NO_GRANT });
    created.set(key, run);
  }
  return structuredClone(run);
};

const must = (step: ReturnType<typeof acceptOffer>): RunState => {
  if (!step.ok) throw new Error(`run refusal: ${step.reason}`);
  return step.run;
};

export type TestPhase = 'offer' | 'loadout' | 'stage' | 'cleared' | 'won' | 'lost' | 'abandoned';

/** The run after `level` cleared levels (0-based level to be on), in `phase` of that level. 'cleared' = that level just cleared. */
export const runAt = (level: number, phase: TestPhase, options: { seed?: number; difficulty?: RunDifficulty } = {}): RunState => {
  let run = baseRun(options.seed, options.difficulty);
  const play = (cards: readonly string[] = []): void => {
    run = must(acceptOffer(run));
    run = must(startStage(run, cards as never));
    run = must(resolveStage(run, { outcome: 'succeeded', atSeconds: 300 + run.levelIndex * 40, evidence: 'reached the goal in time' }));
  };
  for (let index = 0; index < level; index += 1) play(index === 0 ? [run.deck[0]] : []);
  if (phase === 'offer') return run;
  if (phase === 'won') {
    play();
    while (run.phase !== 'won') play();
    return run;
  }
  run = must(acceptOffer(run));
  if (phase === 'loadout') return run;
  const slots = run.levels[run.levelIndex].slots;
  const picked = [...new Set(run.deck)].slice(0, Math.min(2, slots));
  run = must(startStage(run, picked));
  if (phase === 'stage') return run;
  if (phase === 'abandoned') return must(abandonRun(run, 90));
  run = must(resolveStage(run, { outcome: phase === 'lost' ? 'failed' : 'succeeded', atSeconds: 412, evidence: phase === 'lost' ? 'operating profit $2,310 of $3,500 when time ran out' : 'reached 150 total visitors at 6:52' }));
  return run;
};

export const snapshotAt = (level: number, phase: TestPhase, options: { seed?: number; difficulty?: RunDifficulty } = {}): RunSnapshot => runSnapshotOf(runAt(level, phase, options));
