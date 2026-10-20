import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../../biomes/types';
import { hash32 } from '../../weather/random';
import { generateMap, recipeOf } from './index';

const nodeProcess = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cpuUsage(): { user: number; system: number } } }).process;
const REPORT = nodeProcess.env.GENERATOR_REPORT === '1';
/**
 * The median budget: 10 ms locally, 15 ms on CI. The 4-core runner has measured a best-of-3 median of 10.2 ms with no
 * generator change (2026-10-20), so 10 ms was a coin flip there. A real regression (per-cell work going quadratic)
 * lands far past either number.
 */
const MEDIAN_BUDGET_MS = nodeProcess.env.CI ? 15 : 10;
/**
 * CPU milliseconds of this test process (vitest runs each file in its own process): unlike wall time it is not inflated
 * when the whole suite shares the cores, so the budget below measures the generator and not the machine's load.
 */
const cpuMs = (): number => {
  const usage = nodeProcess.cpuUsage();
  return (usage.user + usage.system) / 1000;
};

/** Generation speed in Node (Phase 24 step 2): 600 maps, median about 3 ms alone (budget 10 ms inside the parallel suite), every map below 20 ms (CPU time); a pass over the median budget is re-measured. */
describe('generator performance', () => {
  it('600 maps: median < 10 ms (15 on CI) and max < 20 ms (a busy pass is re-measured, best of 3; a spike is re-measured alone, best of 5)', () => {
    for (const biome of BIOME_IDS) generateMap(recipeOf(biome, 1)); // warm the JIT and the caches
    const spikes: Array<ReturnType<typeof recipeOf>> = [];
    const measurePass = (): number[] => {
      const times: number[] = [];
      for (let i = 0; i < 600; i += 1) {
        const recipe = recipeOf(BIOME_IDS[i % 6], hash32(i, 9), { density: (['low', 'normal', 'high'] as const)[Math.floor(i / 6) % 3] });
        const started = cpuMs();
        generateMap(recipe);
        const elapsed = cpuMs() - started;
        times.push(elapsed);
        if (elapsed >= 20) spikes.push(recipe);
      }
      return [...times].sort((a, b) => a - b);
    };
    // Alone the median is about 3.3 ms and the max about 8 ms (run with GENERATOR_REPORT=1); inside the whole parallel suite the CPU
    // time per map roughly doubles (shared caches, GC and JIT threads), and on a 4-core CI runner it has reached 10 ms, so a pass over
    // the budget is measured again (at most 3 passes, the lowest median counts): a real regression stays slow in every pass.
    let median = Infinity;
    for (let pass = 0; pass < 3 && median >= MEDIAN_BUDGET_MS; pass += 1) {
      const sorted = measurePass();
      median = Math.min(median, sorted[300]);
      if (REPORT) console.log(`generator pass ${pass + 1}: median ${sorted[300].toFixed(2)} ms, p99 ${sorted[594].toFixed(2)} ms, max ${sorted[599].toFixed(2)} ms`);
    }
    expect(median).toBeLessThan(MEDIAN_BUDGET_MS);
    for (const recipe of spikes) {
      let best = Infinity;
      for (let run = 0; run < 5; run += 1) {
        const started = cpuMs();
        generateMap(recipe);
        best = Math.min(best, cpuMs() - started);
      }
      expect(best, `${recipe.biomeId} ${recipe.seed}`).toBeLessThan(20);
    }
  }, 60_000);
});
