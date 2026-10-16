import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { OPPOSING_CARD_PAIRS, RUN_CONDITIONS } from '../run/content';
import { CARD_MODIFIABLE_RULES, RULE_CLAMPS, compileParkRules, type CardModifiableRule, type CardModifiers } from '../scenarios/rules';
import { CARD_BY_ID, PULSE_CARDS } from './content';
import { effectVectorOf } from './vector';

/**
 * Phase 25 (design 4): opposing pairs really oppose, and no legal loadout (slot cost <= 4: level 5 with the Spare slot) on
 * top of any condition set reaches a rule clamp.
 */
describe('opposing pairs', () => {
  it('each pair shares an axis with opposite signs, names two known distinct cards, and no card is in two pairs', () => {
    const seen = new Set<string>();
    for (const [a, b] of OPPOSING_CARD_PAIRS) {
      expect(CARD_BY_ID.has(a) && CARD_BY_ID.has(b), `${a} / ${b}`).toBe(true);
      expect(a).not.toBe(b);
      const left = effectVectorOf(CARD_BY_ID.get(a)!);
      const right = effectVectorOf(CARD_BY_ID.get(b)!);
      const opposed = Object.keys(left).filter((axis) => {
        const x = left[axis as keyof typeof left] ?? 0;
        const y = right[axis as keyof typeof right] ?? 0;
        return x * y < 0;
      });
      expect(opposed.length, `${a} / ${b}`).toBeGreaterThan(0);
      for (const id of [a, b]) {
        expect(seen.has(id), `${id} is in two pairs`).toBe(false);
        seen.add(id);
      }
    }
    expect(OPPOSING_CARD_PAIRS).toHaveLength(12);
  });
});

describe('clamp saturation', () => {
  const MAX_SLOTS = GAME_CONFIG.run.slotsByLevel.at(-1)! + 1;
  const stage = PULSE_CARDS.filter((card) => card.kind === 'stage');
  const neutral = (): Record<CardModifiableRule, number> => Object.fromEntries(CARD_MODIFIABLE_RULES.map((rule) => [rule, 1])) as Record<CardModifiableRule, number>;

  /** Per rule: the lowest and highest product over every distinct-card loadout of total slot cost <= MAX_SLOTS. */
  const loadoutExtremes = () => {
    const low = neutral();
    const high = neutral();
    let loadouts = 0;
    const walk = (start: number, cost: number, product: Record<CardModifiableRule, number>) => {
      loadouts += 1;
      for (const rule of CARD_MODIFIABLE_RULES) {
        low[rule] = Math.min(low[rule], product[rule]);
        high[rule] = Math.max(high[rule], product[rule]);
      }
      for (let index = start; index < stage.length; index += 1) {
        const card = stage[index];
        if (cost + card.slotCost > MAX_SLOTS) continue;
        const next = { ...product };
        for (const [rule, value] of Object.entries(card.modifiers) as Array<[CardModifiableRule, number]>) next[rule] *= value;
        walk(index + 1, cost + card.slotCost, next);
      }
    };
    walk(0, 0, neutral());
    return { low, high, loadouts };
  };

  /** Per rule: the lowest and highest product over every condition set of up to maxConditionsPerLevel. */
  const conditionExtremes = () => {
    const low = neutral();
    const high = neutral();
    const walk = (start: number, count: number, product: Record<CardModifiableRule, number>) => {
      for (const rule of CARD_MODIFIABLE_RULES) {
        low[rule] = Math.min(low[rule], product[rule]);
        high[rule] = Math.max(high[rule], product[rule]);
      }
      if (count >= GAME_CONFIG.run.maxConditionsPerLevel) return;
      for (let index = start; index < RUN_CONDITIONS.length; index += 1) {
        const next = { ...product };
        for (const [rule, value] of Object.entries(RUN_CONDITIONS[index].rules)) if (typeof value === 'number') next[rule as CardModifiableRule] *= value;
        walk(index + 1, count + 1, next);
      }
    };
    walk(0, 0, neutral());
    return { low, high };
  };

  it('no compiled rule reaches a clamp for any legal loadout of cost <= 4 on any condition set', () => {
    const cards = loadoutExtremes();
    const conditions = conditionExtremes();
    expect(cards.loadouts).toBeGreaterThan(40_000);
    for (const rule of CARD_MODIFIABLE_RULES) {
      expect(cards.low[rule] * conditions.low[rule], `${rule} low`).toBeGreaterThan(RULE_CLAMPS.minimumMultiplier);
      expect(cards.high[rule] * conditions.high[rule], `${rule} high`).toBeLessThan(RULE_CLAMPS.maximumMultiplier);
    }
    // The design's worst stacks, checked through the real compile (which rounds to 3 decimals; no clamp on the way).
    const compile = (ids: string[], scenario: CardModifiers = {}) => compileParkRules(scenario, ids.map((id) => CARD_BY_ID.get(id as never)!.modifiers));
    expect(compile(['master-builders', 'local-contractors', 'prefab-kits']).constructionCostMultiplier).toBeCloseTo(0.384, 2);
    expect(compile(['weather-station', 'storm-shutters', 'umbrella-stand']).weatherEffectMultiplier).toBeCloseTo(0.357, 2);
    expect(compile(['master-mechanics', 'safety-first']).breakdownRateMultiplier).toBeCloseTo(0.35, 2);
    expect(compile(['master-builders', 'master-mechanics', 'lamplighters'], { staffSalaryMultiplier: 1.15 }).staffSalaryMultiplier).toBeCloseTo(1.3 * 1.25 * 1.15 * 1.15, 2);
  });
});
