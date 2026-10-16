import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../../biomes/types';
import { hash32 } from '../../weather/random';
import { generateMap, recipeOf } from './index';

const nodeProcess = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cpuUsage(): { user: number; system: number } } }).process;
const REPORT = nodeProcess.env.GENERATOR_REPORT === '1';
/**
 * CPU milliseconds of this test process (vitest runs each file in its own process): unlike wall time it is not inflated
 * when the whole suite shares the cores, so the budget below measures the generator and not the machine's load.
 */
const cpuMs = (): number => {
  const usage = nodeProcess.cpuUsage();
  return (usage.user + usage.system) / 1000;
};

/** Generation speed in Node (Phase 24 step 2): 600 maps, median about 3 ms alone (budget 10 ms inside the parallel suite), every map below 20 ms (CPU time). */
describe('generator performance', () => {
  it('600 maps: median < 10 ms and max < 20 ms (a spike is re-measured alone, best of 5)', () => {
    for (const biome of BIOME_IDS) generateMap(recipeOf(biome, 1)); // warm the JIT and the caches
    const times: number[] = [];
    const spikes: Array<ReturnType<typeof recipeOf>> = [];
    for (let i = 0; i < 600; i += 1) {
      const recipe = recipeOf(BIOME_IDS[i % 6], hash32(i, 9), { density: (['low', 'normal', 'high'] as const)[Math.floor(i / 6) % 3] });
      const started = cpuMs();
      generateMap(recipe);
      const elapsed = cpuMs() - started;
      times.push(elapsed);
      if (elapsed >= 20) spikes.push(recipe);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[300];
    if (REPORT) console.log(`generator: median ${median.toFixed(2)} ms, p99 ${sorted[594].toFixed(2)} ms, max ${sorted[599].toFixed(2)} ms`);
    // Alone the median is about 3.3 ms and the max about 8 ms (run with GENERATOR_REPORT=1); inside the whole parallel suite the CPU
    // time per map roughly doubles (shared caches, GC and JIT threads), so the median budget here is 10 ms and the hard limit 20 ms.
    expect(median).toBeLessThan(10);
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
