import { describe, expect, it } from 'vitest';
import type { BiomeId } from '../biomes/types';
import { PULSE_CARDS } from '../cards/content';
import type { CardFamily, PulseCardDefinition, PulseCardId } from '../cards/types';
import { EMPTY_GRANT, type ParkSession } from '../session/ParkSession';
import { slotsOf } from './deck';
import { runStageBotWithCards } from './runBot';
import { SPARE_SLOT_GRANT, testRunWithForcedLevel, withDeck } from './testSupport';
import type { RunDifficulty, RunObjectiveFamily } from './types';

interface NodeBuiltins {
  process: { env: Record<string, string | undefined>; stderr: { write(text: string): void }; getBuiltinModule(id: string): never };
}
const nodeProcess = (globalThis as unknown as NodeBuiltins).process;
const { appendFileSync } = nodeProcess.getBuiltinModule('node:fs') as { appendFileSync(path: string, data: string): void };
const env = nodeProcess.env;

/**
 * Phase 25 balance script (design 8): every card alone against a no-card baseline in four binding cells, three seeds
 * each, the stage built exactly as the app builds it and the bot playing a one-shot through `ParkSession.playCard`
 * (BotActions.playCards) at its `oneShotPlayTimes`. Opt-in (slow, minutes):
 *   CARD_BALANCE=1 [CARD_BALANCE_SEEDS=101,102,103] [CARD_BALANCE_CARDS=id,id] [CARD_BALANCE_FAMILIES=weather,...]
 *   [CARD_BALANCE_OUT=file]
 * Rows (pipe-separated): card | kind | rarity | cell | seed | pct | dPct | minCash | dMinCash | peak | status | debt |
 * progress | plays (each one-shot play: second and the session's answer). `pct` is the clear time as % of the deadline (100 when the stage failed), `dPct` the card minus the baseline
 * (negative = the card made it faster). The summary on stderr flags DEAD (every |dPct| < 2), DOMINANT (median dPct <= -20)
 * and TRAP (a stage fails that the baseline cleared); a bot-blind card is reported with its unit test instead.
 */
const enabled = env.CARD_BALANCE === '1';
const SEEDS = (env.CARD_BALANCE_SEEDS ?? '101,102,103').split(',').map(Number);
const ONLY_CARDS = env.CARD_BALANCE_CARDS ? new Set(env.CARD_BALANCE_CARDS.split(',')) : null;
const ONLY_FAMILIES = env.CARD_BALANCE_FAMILIES ? new Set(env.CARD_BALANCE_FAMILIES.split(',')) : null;

interface Cell { id: string; difficulty: RunDifficulty; levelIndex: number; family: RunObjectiveFamily; biomeId: BiomeId }
const CELLS: readonly Cell[] = [
  { id: 'C1 standard L2 crowd meadow', difficulty: 'standard', levelIndex: 1, family: 'crowd', biomeId: 'meadow' },
  { id: 'C2 standard L3 spirits jungle', difficulty: 'standard', levelIndex: 2, family: 'spirits', biomeId: 'jungle' },
  { id: 'C3 standard L5 visitors seaside', difficulty: 'standard', levelIndex: 4, family: 'visitors', biomeId: 'seaside' },
  { id: 'C4 tough L5 profit meadow', difficulty: 'tough', levelIndex: 4, family: 'profit', biomeId: 'meadow' },
];

/** The bot cannot show these (no coaster, no re-pricing, four scenery pieces): their lever is proven by a unit test. */
const BOT_BLIND: Readonly<Partial<Record<PulseCardId, string>>> = {
  'chain-gang': 'chain lift cost x0.5 (rules: chainLiftCostMultiplier; the bot builds no coaster)',
  'master-builders': 'chain half only (construction x0.6 is measured here)',
  'heritage-trail': 'scenery appeal x1.2 (rules: sceneryAppealMultiplier inside the signature; four scenery pieces)',
  'garden-club': 'scenery appeal x1.3 (four scenery pieces)',
  'plastic-flowers': 'scenery appeal x0.7 (four scenery pieces)',
  'value-menu': 'price tolerance x0.8 (the bot never re-prices; need relief is measured)',
  'premium-pricing': 'price tolerance x1.5 (the bot never re-prices; shop purchases still move)',
};

interface Measured { pct: number; minCash: number; peak: number; status: string; debt: number; progress: number; plays: string }

const measure = (cell: Cell, seed: number, card: PulseCardDefinition | null): Measured => {
  const grant = card !== null && card.slotCost > 1 ? SPARE_SLOT_GRANT : EMPTY_GRANT;
  const run = testRunWithForcedLevel(cell.levelIndex, cell.biomeId, cell.family, { seed, difficulty: cell.difficulty, grant });
  if (card !== null && card.slotCost > slotsOf(run)) throw new Error(`${card.id} does not fit ${cell.id}`);
  const cards = card === null ? [] : [card.id];
  let progress = 0;
  const trace = (session: ParkSession): void => { progress = session.scenarioSnapshot()?.objective.progressPercent ?? 0; };
  const result = runStageBotWithCards(withDeck(run, cards), cards, { options: { trace } });
  const pct = result.status === 'succeeded' && result.completedAtSeconds !== null
    ? Math.round((1000 * result.completedAtSeconds) / result.deadlineSeconds) / 10
    : 100;
  const plays = result.cardPlays.map((play) => `${Math.round(play.atSeconds)}s ${play.outcome}`).join(', ') || '-';
  return { pct, minCash: Math.round(result.minimumCash), peak: result.guestsPeak, status: result.status, debt: result.unpaidDebt, progress: Math.round(progress), plays };
};

const baselines = new Map<string, Measured>();
const baselineOf = (cell: Cell, seed: number): Measured => {
  const key = `${cell.id}|${seed}`;
  if (!baselines.has(key)) {
    const measured = measure(cell, seed, null);
    baselines.set(key, measured);
    if (env.CARD_BALANCE_OUT) appendFileSync(env.CARD_BALANCE_OUT, `baseline | - | - | ${cell.id} | ${seed} | ${measured.pct} | 0 | ${measured.minCash} | 0 | ${measured.peak} | ${measured.status} | 0 | ${measured.progress} | -\n`);
  }
  return baselines.get(key)!;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const FAMILIES: readonly CardFamily[] = ['weather', 'day-night', 'arrivals', 'staff', 'rides', 'economy', 'scenery', 'build'];

describe.skipIf(!enabled)('Phase 25 balance script: every card alone against the no-card baseline', () => {
  for (const family of FAMILIES) {
    if (ONLY_FAMILIES !== null && !ONLY_FAMILIES.has(family)) continue;
    it(`${family} cards`, () => {
      const cards = PULSE_CARDS.filter((card) => card.family === family && (ONLY_CARDS === null || ONLY_CARDS.has(card.id)));
      const summary: string[] = [];
      for (const card of cards) {
        const deltas: number[] = [];
        let trap = false;
        for (const cell of CELLS) {
          for (const seed of SEEDS) {
            const base = baselineOf(cell, seed);
            const measured = measure(cell, seed, card);
            const dPct = Math.round((measured.pct - base.pct) * 10) / 10;
            deltas.push(dPct);
            if (base.status === 'succeeded' && measured.status !== 'succeeded') trap = true;
            const row = `${card.id} | ${card.kind} | ${card.rarity} | ${cell.id} | ${seed} | ${measured.pct} | ${dPct} | ${measured.minCash} | ${measured.minCash - base.minCash} | ${measured.peak} | ${measured.status} | ${measured.debt} | ${measured.progress} | ${measured.plays}`;
            if (env.CARD_BALANCE_OUT) appendFileSync(env.CARD_BALANCE_OUT, `${row}\n`);
          }
        }
        const flags = [
          // Every rule key has a measured-consumer unit test (scenarios/phase25Rules.test.ts): DEAD here means dead in the bot.
          deltas.every((delta) => Math.abs(delta) < 2) ? (BOT_BLIND[card.id] ? 'bot-blind, unit-proven' : 'DEAD') : '',
          median(deltas) <= -20 ? 'DOMINANT' : '',
          trap ? 'TRAP' : '',
        ].filter((flag) => flag !== '');
        summary.push(`summary | ${card.id} | ${card.kind} | ${card.rarity} | median dPct ${median(deltas)} | range ${Math.min(...deltas)}..${Math.max(...deltas)} | ${flags.join(', ') || '-'}`);
      }
      nodeProcess.stderr.write(`${summary.join('\n')}\n`);
      expect(summary.length).toBe(cards.length);
    }, 900_000);
  }
});
