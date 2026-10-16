import { describe, expect, it } from 'vitest';
import { CARD_BY_ID, PULSE_CARD_IDS } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { GAME_CONFIG } from '../config';
import type { ParkSession } from '../session/ParkSession';
import { noteMargin } from './marginsSink';
import { deckMarginOf, essentialSkips, plausibleLoadout, runStageBotWithCards, withinMargin } from './runBot';
import { EMPTY_GRANT } from '../session/ParkSession';
import { SPARE_SLOT_GRANT, testRunAtLevel, testRunWithForcedLevel, withDeck } from './testSupport';
import type { RunState } from './types';

/**
 * Phase 25 winnability proofs with cards (design 7.3 and 11.2), sampled so the default run stays inside its budget (the
 * full effect matrix is the opt-in cardBalance.review.test.ts). The bot plays every one-shot it brought through
 * `ParkSession.playCard` (BotActions.playCards), exactly as the HUD does.
 */
const LAST = GAME_CONFIG.run.levelCount - 1;

/** A loan's repayment second (played at `playedAt`), else null: the one cash dip a proof forgives. */
const repaymentAt = (cardId: PulseCardId, playedAt: number): number | null => {
  const card = CARD_BY_ID.get(cardId);
  return card?.kind === 'one-shot' && card.effect.kind === 'loan' ? playedAt + card.effect.afterSeconds : null;
};

/**
 * The card alone (the deck holds just it) with its one-shot, if any, played at `oneShotAt`. `cashBeforeRepayment` is the
 * lowest cash before a loan's repayment falls due (the whole stage for any other card).
 */
const alone = (run: RunState, cardId: PulseCardId, oneShotAt?: number) => {
  const repayment = oneShotAt === undefined ? null : repaymentAt(cardId, oneShotAt);
  let cashBeforeRepayment = Infinity;
  const trace = (session: ParkSession, seconds: number): void => {
    if (repayment === null || seconds < repayment) cashBeforeRepayment = Math.min(cashBeforeRepayment, session.world.cash);
  };
  const result = runStageBotWithCards(withDeck(run, [cardId]), [cardId], { oneShotAt, options: { trace } });
  return { result, cashBeforeRepayment: Math.min(cashBeforeRepayment, repayment === null ? result.minimumCash : Infinity) };
};

const grantFor = (cardId: PulseCardId) => (CARD_BY_ID.get(cardId)!.slotCost > 1 ? SPARE_SLOT_GRANT : EMPTY_GRANT);

describe('The Map with cards: every card alone clears Standard level 1 (visitors, Meadow, seed 1)', () => {
  it.each(PULSE_CARD_IDS.map((id) => [id] as const))('%s', (cardId) => {
    // A 2-slot rare needs the Spare card slot on a 1-slot level (design 1.4); the grant changes nothing else.
    const run = testRunWithForcedLevel(0, 'meadow', 'visitors', { seed: 1, difficulty: 'standard', grant: grantFor(cardId) });
    const { result, cashBeforeRepayment } = alone(run, cardId, 30);
    const plays = result.cardPlays.map((play) => `${play.atSeconds}s ${play.outcome}`).join(', ') || '-';
    const row = `cards | standard L1 meadow visitors seed 1 | ${cardId} | ${result.status} at ${result.completedAtSeconds}s of ${result.deadlineSeconds}s | min cash ${Math.round(result.minimumCash)} (before a repayment ${Math.round(cashBeforeRepayment)}) | plays ${plays}`;
    noteMargin(row);
    expect(result.status, row).toBe('succeeded');
    expect(essentialSkips(result), row).toEqual([]);
    expect(cashBeforeRepayment, row).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

/** The 4 rares, 4 one-shots and the 4 heaviest visitors-axis downsides (design 11.2). */
const TOUGH_SAMPLE: readonly PulseCardId[] = [
  'weather-station', 'season-ticket', 'big-loan', 'master-builders',
  'coach-party', 'bridging-loan', 'sponsor-banner', 'inspection-day',
  'velvet-ropes', 'premium-pricing', 'word-on-the-street', 'brisk-days',
];

describe('The Map with cards: no sampled card is a trap at Tough level 5 (visitors, Meadow)', () => {
  it.each(TOUGH_SAMPLE.map((id) => [id] as const))('%s alone clears within the Tough margin', (cardId) => {
    const run = testRunWithForcedLevel(LAST, 'meadow', 'visitors', { seed: 41, difficulty: 'tough' });
    const { result, cashBeforeRepayment } = alone(run, cardId, 30);
    const row = `cards | tough L5 meadow visitors seed 41 | ${cardId} | ${result.status} at ${result.completedAtSeconds}s of ${result.deadlineSeconds}s | min cash ${Math.round(result.minimumCash)} (before a repayment ${Math.round(cashBeforeRepayment)})`;
    noteMargin(row);
    // The margin rule, with a loan's dip after its repayment forgiven (the cash rule then holds before it falls due).
    expect(withinMargin({ ...result, minimumCash: cashBeforeRepayment }, result.deadlineSeconds, 1), row).toBe(true);
  }, 60_000);
});

describe('The Map with cards: a plausible deck clears Tough levels 4 and 5 within the deck margin (design 7.3)', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`seed ${seed}`, () => {
      for (const levelIndex of [LAST - 1, LAST]) {
        const run = testRunAtLevel(levelIndex, { seed, difficulty: 'tough' });
        const level = run.levels[levelIndex];
        const cards = plausibleLoadout(run);
        const deadline = level.timeLimitDays * GAME_CONFIG.calendar.defaultDayLengthSeconds;
        const result = runStageBotWithCards(run, cards, { oneShotAt: Math.round(deadline * 0.25) });
        const percent = result.completedAtSeconds === null ? null : Math.round((100 * result.completedAtSeconds) / result.deadlineSeconds);
        const row = `deck | tough seed ${seed} L${levelIndex + 1} | ${level.biomeId} | ${level.family} | target ${level.objective.target} | ${level.conditionIds.join('+') || '-'} | ${cards.join('+') || '-'} | ${result.status} at ${result.completedAtSeconds}s of ${result.deadlineSeconds}s (${percent}%) | min cash ${Math.round(result.minimumCash)}`;
        noteMargin(row);
        expect(withinMargin(result, result.deadlineSeconds, deckMarginOf(run)), row).toBe(true);
      }
    }, 120_000);
  }
});

describe('The Map with cards: the starter deck clears Standard level 5', () => {
  for (const seed of [1, 2]) {
    it(`seed ${seed}: all three starter cards, within 0.85`, () => {
      const run = testRunAtLevel(LAST, { seed, difficulty: 'standard' });
      const cards = run.starterDeck.slice(0, run.levels[LAST].slots);
      const result = runStageBotWithCards(withDeck(run, cards), cards);
      const row = `starter | standard seed ${seed} L5 | ${run.levels[LAST].family} | ${cards.join('+')} | ${result.status} at ${result.completedAtSeconds}s of ${result.deadlineSeconds}s | min cash ${Math.round(result.minimumCash)}`;
      noteMargin(row);
      expect(withinMargin(result, result.deadlineSeconds, 0.85), row).toBe(true);
    }, 120_000);
  }
});
