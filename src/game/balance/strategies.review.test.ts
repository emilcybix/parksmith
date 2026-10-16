import { describe, expect, it } from 'vitest';
import { MAPS } from '../maps/content';
import { STRATEGIES } from './strategies';
import { formatStrategyRow, healthFailures, runStrategy, type StrategyRuleOverrides } from './strategyBot';

/**
 * Phase 16 opt-in sweep (`STRATEGY_SWEEP=1`; design section 9): the three strategy bots on Meadow with seeds 101-110 and
 * on every shipped map with its own seed, under the final Phase 16 rule values (theme affinity 0.2 after the design-10
 * fallback from 0.3, research cost scale 10). One row per park is printed and appended to `$STRATEGY_SWEEP_OUT` when
 * set; the evidence for BALANCE_NOTES. It asserts nothing about health (the default-run `strategies.test.ts` does that on the default park): it only proves
 * every park ran and every planned building was placed. About 3 x 17 parks at 1 s each.
 */
// The app tsconfig has no node types: the built-ins are reached through process (as in run/marginsSink.ts).
interface NodeBuiltins {
  process: { env: Record<string, string | undefined>; getBuiltinModule(id: string): never };
}
const nodeProcess = (globalThis as unknown as NodeBuiltins).process;
const { appendFileSync } = nodeProcess.getBuiltinModule('node:fs') as { appendFileSync(path: string, data: string): void };

const SWEEP = nodeProcess.env.STRATEGY_SWEEP === '1';
const OUT = nodeProcess.env.STRATEGY_SWEEP_OUT;
const FINAL: StrategyRuleOverrides = { themeAffinity: 0.2, researchCostScale: 10 };
const SEEDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110] as const;

const note = (row: string): void => {
  console.log(row);
  if (OUT) appendFileSync(OUT, `${row}\n`);
};

describe.runIf(SWEEP)('Phase 16 strategy sweep (STRATEGY_SWEEP=1)', () => {
  for (const strategy of STRATEGIES) {
    it(`${strategy.id}: Meadow, seeds ${SEEDS[0]}-${SEEDS[SEEDS.length - 1]}`, () => {
      let healthy = 0;
      for (const seed of SEEDS) {
        const result = runStrategy(strategy, { seed, rules: FINAL });
        note(formatStrategyRow(result));
        if (healthFailures(result).length === 0) healthy += 1;
        expect(result.samples.length).toBe(45 * 60);
        expect(result.essentialSkips, formatStrategyRow(result)).toEqual([]);
      }
      note(`${strategy.id} | meadow seeds | healthy ${healthy} of ${SEEDS.length}`);
    }, 600_000);

    it(`${strategy.id}: every shipped map`, () => {
      let healthy = 0;
      for (const map of MAPS) {
        const result = runStrategy(strategy, { mapId: map.id, rules: FINAL });
        note(formatStrategyRow(result));
        if (healthFailures(result).length === 0) healthy += 1;
        expect(result.samples.length).toBe(45 * 60);
        expect(result.essentialSkips, formatStrategyRow(result)).toEqual([]);
      }
      note(`${strategy.id} | maps | healthy ${healthy} of ${MAPS.length}`);
    }, 600_000);
  }
});
