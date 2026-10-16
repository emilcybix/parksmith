import { describe, expect, it } from 'vitest';
import { PULSE_CARDS } from './content';
import type { EffectVector, OneShotEffect, OneShotVector, PulseCardDefinition } from './types';
import { dominates, effectVectorOf } from './vector';

/**
 * Phase 25 (design 1.5): no card is strictly better than another. Rarity, kind, slot cost and tags are not axes, so a rare
 * card earns its second slot with a second trade, never with a bigger number on the same axes.
 */
const dominatingPairs = (cards: ReadonlyArray<Pick<PulseCardDefinition, 'id'> & { vector: EffectVector }>): string[] => {
  const pairs: string[] = [];
  for (const a of cards) for (const b of cards) if (a !== b && dominates(a.vector, b.vector)) pairs.push(`${a.id} > ${b.id}`);
  return pairs;
};

const poolVectors = () => PULSE_CARDS.map((card) => ({ id: card.id, vector: effectVectorOf(card) }));

describe('dominance', () => {
  it('no ordered pair of the 48 cards dominates', () => {
    expect(dominatingPairs(poolVectors())).toEqual([]);
  });

  it('dominates: >= on every axis of either and > on one; equal vectors and trades never dominate', () => {
    expect(dominates({ cashNow: 2, research: 1 }, { cashNow: 1, research: 1 })).toBe(true);
    expect(dominates({ cashNow: 1 }, { cashNow: 1 })).toBe(false);
    expect(dominates({ cashNow: 2, research: -1 }, { cashNow: 1 })).toBe(false);
    // A missing axis reads as 0 on both sides.
    expect(dominates({ cashNow: 1 }, { cashNow: 1, spirits: -1 })).toBe(true);
    expect(dominates({}, { spirits: -1 })).toBe(true);
    expect(dominates({}, {})).toBe(false);
    // Stage vectors are logs: a 0.7 lower-is-better multiplier beats a 0.8 one on its axis.
    const a = effectVectorOf({ kind: 'stage', modifiers: { constructionCostMultiplier: 0.7, staffSalaryMultiplier: 1.1 } });
    const b = effectVectorOf({ kind: 'stage', modifiers: { constructionCostMultiplier: 0.8, staffSalaryMultiplier: 1.1 } });
    expect(dominates(a, b)).toBe(true);
    expect(dominates(b, a)).toBe(false);
  });

  it('a rare that dominates a common fails the pool check (rarity is not an axis)', () => {
    const common = PULSE_CARDS.find((card) => card.id === 'grand-opening')!;
    const fakeRare = { id: 'fake-rare' as never, vector: { ...effectVectorOf(common), arrivalIntervalMultiplier: 0.5, sceneryAppealMultiplier: 0.1 } };
    expect(dominatingPairs([...poolVectors(), fakeRare])).toEqual(['fake-rare > grand-opening']);
  });

  it('stage vectors are derived in log space with the rule direction (positive = good for the player)', () => {
    const vector = effectVectorOf({ kind: 'stage', modifiers: { arrivalIntervalMultiplier: 0.8, guestBudgetMultiplier: 0.85 } });
    expect(vector.arrivalIntervalMultiplier).toBeCloseTo(-Math.log(0.8), 12);
    expect(vector.guestBudgetMultiplier).toBeCloseTo(Math.log(0.85), 12);
  });

  it('every one-shot vector matches its effect numbers (cash in $1,000s, research in 10 RP, visitors in 10 guests, spirits in 10 points)', () => {
    const expected = (effect: OneShotEffect): OneShotVector => {
      switch (effect.kind) {
        case 'loan': return { cashNow: effect.amount / 1000, cashLater: -effect.repay / 1000 };
        case 'research': return { research: effect.points / 10, cashNow: -effect.fee / 1000 };
        case 'repair': return {
          repair: 1,
          ...(effect.scope === 'all' ? { condition: 1, queues: -1 } : {}),
          ...(effect.afterSeconds === null ? { cashNow: -effect.perRide / 1000 } : { cashLater: -effect.perRide / 1000 }),
        };
        case 'sweep': return { litter: 1, cashNow: -effect.fee / 1000 };
        case 'forecast': return { forecast: 1, cashNow: -effect.fee / 1000 };
        case 'surge': return { visitors: effect.guests / 10, cashLater: -effect.bill / 1000 };
        case 'cheer': return { spirits: effect.happiness / 10, cashNow: -effect.fee / 1000 };
      }
    };
    for (const card of PULSE_CARDS) {
      if (card.kind !== 'one-shot') continue;
      const want = expected(card.effect);
      expect(Object.keys(card.vector).sort(), card.id).toEqual(Object.keys(want).sort());
      for (const [axis, value] of Object.entries(want)) expect(card.vector[axis as keyof OneShotVector], `${card.id} ${axis}`).toBeCloseTo(value as number, 9);
    }
  });
});
