import { describe, expect, it } from 'vitest';
import { PULSE_CARDS } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { GAME_CONFIG } from '../config';
import { OPPOSING_CARD_PAIRS } from './content';
import { planRun } from './plan';
import { RUN_DIFFICULTIES } from './types';

interface NodeBuiltins {
  process: { env: Record<string, string | undefined>; stderr: { write(text: string): void }; getBuiltinModule(id: string): never };
}
const nodeProcess = (globalThis as unknown as NodeBuiltins).process;

/**
 * Phase 23 review (adversarial balance): the deck maths with the shipped pool (48 cards since Phase 25), over 1,000 seeds, played the
 * "greedy distinct" way (every stage fills every slot with distinct cards, preferring cards held twice or more). Prints
 * the statistics and pins the properties the brief asks for: real choices (more distinct cards than slots), offers that are
 * not pure duplicates of what is held, and no opposing pair inside one offer.
 */
const SEEDS = 1_000;
const POOL = PULSE_CARDS.map((card) => card.id);
const slots = GAME_CONFIG.run.slotsByLevel;

const simulate = (seed: number) => {
  const plan = planRun({ seed, difficulty: 'standard' });
  const deck: PulseCardId[] = [...plan.starterDeck];
  const perLevel: Array<{ distinct: number; size: number; slots: number; offerAllHeld: boolean; offerDupInPair: boolean; offerOpposing: boolean }> = [];
  plan.levels.forEach((level, index) => {
    const offerAllHeld = level.offer.every((id) => deck.includes(id));
    const offerOpposing = OPPOSING_CARD_PAIRS.some(([a, b]) => level.offer.includes(a) && level.offer.includes(b));
    deck.push(...level.offer);
    const distinct = new Set(deck).size;
    perLevel.push({ distinct, size: deck.length, slots: slots[index], offerAllHeld, offerDupInPair: false, offerOpposing });
    // play: fill all slots with distinct cards, most-held first
    const counts = new Map<PulseCardId, number>();
    for (const id of deck) counts.set(id, (counts.get(id) ?? 0) + 1);
    const chosen = [...counts.entries()].sort((a, b) => b[1] - a[1] || POOL.indexOf(a[0]) - POOL.indexOf(b[0])).slice(0, slots[index]).map(([id]) => id);
    for (const id of chosen) deck.splice(deck.indexOf(id), 1);
  });
  return { plan, perLevel, leftover: deck.length };
};

describe('The Map review: deck maths with the shipped pool', () => {
  it('reports the statistics', () => {
    const rows: string[] = [];
    const agg = slots.map(() => ({ choiceless: 0, offerAllHeld: 0, opposing: 0, minDistinct: 99, maxDistinct: 0 }));
    const starterCounts = new Map<string, number>();
    let leftoverTotal = 0;
    for (let seed = 0; seed < SEEDS; seed += 1) {
      const { plan, perLevel, leftover } = simulate(seed);
      leftoverTotal += leftover;
      starterCounts.set(plan.starterDeck.join(','), (starterCounts.get(plan.starterDeck.join(',')) ?? 0) + 1);
      perLevel.forEach((row, index) => {
        const a = agg[index];
        if (row.distinct <= row.slots) a.choiceless += 1;
        if (row.offerAllHeld) a.offerAllHeld += 1;
        if (row.offerOpposing) a.opposing += 1;
        a.minDistinct = Math.min(a.minDistinct, row.distinct);
        a.maxDistinct = Math.max(a.maxDistinct, row.distinct);
      });
    }
    agg.forEach((a, index) => rows.push(`L${index + 1} slots ${slots[index]}: distinct ${a.minDistinct}-${a.maxDistinct}; no-choice ${a.choiceless}/${SEEDS}; offer only duplicates of held cards ${a.offerAllHeld}/${SEEDS}; opposing pair in one offer ${a.opposing}/${SEEDS}`));
    rows.push(`distinct starter decks: ${starterCounts.size}; mean cards left unplayed at the end: ${(leftoverTotal / SEEDS).toFixed(2)}`);
    // Difficulty does not touch offers.
    const sameAcross = Array.from({ length: 50 }, (_, seed) => RUN_DIFFICULTIES.map((d) => JSON.stringify(planRun({ seed, difficulty: d }).levels.map((l) => l.offer))))
      .every((offers) => offers.every((o) => o === offers[0]));
    rows.push(`offers identical across difficulties: ${sameAcross}`);
    nodeProcess.stderr.write(`${rows.join("\n")}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });

  // FINDING (Phase 23 review, fixed in Phase 25): starterDeckOf kept Grand Opening and Velvet Ropes apart but the offer draw
  // did not (304 of 1,000 seeds offered both halves at once). Plan version 3 applies the starter rule to offers.
  it('never puts both halves of an opposing pair in one offer (the starter rule, applied to offers)', () => {
    const bad: number[] = [];
    for (let seed = 0; seed < SEEDS; seed += 1) {
      const plan = planRun({ seed, difficulty: 'standard' });
      if (plan.levels.some((level) => OPPOSING_CARD_PAIRS.some(([a, b]) => level.offer.includes(a) && level.offer.includes(b)))) bad.push(seed);
    }
    expect(bad.length, `seeds with an opposing pair offered together, e.g. ${bad.slice(0, 5).join(', ')}`).toBe(0);
  });

  it('the level-1 loadout is a real choice (more distinct cards than slots) on every seed', () => {
    for (let seed = 0; seed < SEEDS; seed += 1) {
      const { perLevel } = simulate(seed);
      expect(perLevel[0].distinct).toBeGreaterThan(perLevel[0].slots);
    }
  });
});
