import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../coaster/content';
import { coasterBaseCost } from '../coaster/design';
import { hillDipFreeLayout } from '../coaster/testLayouts';
import { hashState } from '../save/hash';
import { ParkSession } from '../session/ParkSession';
import { GAME_CONFIG } from '../config';
import {
  BASE_PARK_RULES,
  CARD_MODIFIABLE_RULES,
  compileParkRules,
  MULTIPLIER_DIRECTION,
  RULE_CLAMPS,
} from '../scenarios/rules';
import { CARD_BY_ID, PULSE_CARD_IDS, PULSE_CARDS, STARTING_CARD_IDS, isPulseCardId, rarityOf, slotCostOf, slotCostTotal } from './content';
import { PULSE_CARD_TABLE } from './table';
import type { PulseCardDefinition, PulseCardId } from './types';
import { draftRewardChoices } from './draft';

const POOL_SIZE = 48;
const SHIPPED_SIX = ['grand-opening', 'velvet-ropes', 'local-contractors', 'quick-turnaround', 'hungry-tourists', 'lean-crew'];

describe('Pulse Card content', () => {
  it('ships 48 distinct cards (37 stage, 11 one-shot; 28 common, 16 uncommon, 4 rare), the shipped six first and unchanged', () => {
    expect(PULSE_CARDS).toHaveLength(POOL_SIZE);
    expect(PULSE_CARD_TABLE).toHaveLength(POOL_SIZE);
    expect(new Set(PULSE_CARDS.map((card) => card.id)).size).toBe(POOL_SIZE);
    expect(PULSE_CARDS.slice(0, 6).map((card) => card.id)).toEqual(SHIPPED_SIX);
    const count = <K extends string>(of: (card: PulseCardDefinition) => K): Record<string, number> => (
      PULSE_CARDS.reduce<Record<string, number>>((tally, card) => ({ ...tally, [of(card)]: (tally[of(card)] ?? 0) + 1 }), {})
    );
    expect(count((card) => card.kind)).toEqual({ stage: 37, 'one-shot': 11 });
    expect(count((card) => card.rarity)).toEqual({ common: 28, uncommon: 16, rare: 4 });
    expect(count((card) => card.family)).toEqual({ weather: 7, 'day-night': 6, arrivals: 6, staff: 7, rides: 6, economy: 8, scenery: 4, build: 4 });
    // The shipped six keep their numbers exactly (in-progress Scenario parks keep rewardEligible).
    expect(PULSE_CARDS.slice(0, 6).map((card) => card.modifiers)).toEqual([
      { arrivalIntervalMultiplier: 0.8, guestBudgetMultiplier: 0.85 },
      { guestBudgetMultiplier: 1.25, arrivalIntervalMultiplier: 1.2 },
      { constructionCostMultiplier: 0.8, rideOperatingCostMultiplier: 1.3 },
      { rideDispatchMultiplier: 0.6, rideOperatingCostMultiplier: 1.25 },
      { servicePriceToleranceMultiplier: 1.3, needDecayMultiplier: 1.25 },
      { staffSalaryMultiplier: 0.65, staffSpeedMultiplier: 0.8 },
    ]);
    for (const card of PULSE_CARDS) {
      expect(CARD_BY_ID.get(card.id)).toBe(card);
      expect(isPulseCardId(card.id)).toBe(true);
    }
    expect(isPulseCardId('not-a-card')).toBe(false);
  });

  it('the id type is derived from the table: every table id is a PulseCardId, in table order', () => {
    const ids: PulseCardId[] = PULSE_CARD_TABLE.map((row) => row.id);
    expect(PULSE_CARD_IDS).toEqual(ids);
    // @ts-expect-error a typo is a compile error, not a runtime miss
    const typo: PulseCardId = 'grand-openin';
    expect(CARD_BY_ID.has(typo)).toBe(false);
  });

  it('stage cards: two or more known modifiers, every value in (0, 4] and never 1, copy on both sides', () => {
    for (const card of PULSE_CARDS) {
      expect(card.upside.length, card.id).toBeGreaterThan(0);
      expect(card.downside.length, card.id).toBeGreaterThan(0);
      if (card.kind !== 'stage') continue;
      const entries = Object.entries(card.modifiers);
      expect(entries.length, card.id).toBeGreaterThanOrEqual(2);
      for (const [rule, value] of entries) {
        expect(CARD_MODIFIABLE_RULES).toContain(rule);
        expect(value, `${card.id} ${rule}`).toBeGreaterThan(0);
        expect(value, `${card.id} ${rule}`).toBeLessThanOrEqual(RULE_CLAMPS.maximumMultiplier);
        expect(value, `${card.id} ${rule}`).not.toBe(1);
      }
    }
  });

  it('per-rarity magnitude bounds: common [0.6, 1.5] x2, uncommon [0.5, 1.6] x2-3, rare [0.6, 1.5] x4', () => {
    const bounds = { common: { low: 0.6, high: 1.5, counts: [2] }, uncommon: { low: 0.5, high: 1.6, counts: [2, 3] }, rare: { low: 0.6, high: 1.5, counts: [4] } };
    for (const card of PULSE_CARDS) {
      if (card.kind !== 'stage') continue;
      const bound = bounds[card.rarity];
      const values = Object.values(card.modifiers) as number[];
      expect(bound.counts, `${card.id} modifier count`).toContain(values.length);
      for (const value of values) {
        expect(value, card.id).toBeGreaterThanOrEqual(bound.low);
        expect(value, card.id).toBeLessThanOrEqual(bound.high);
      }
    }
  });

  it('one-shots: modifiers {} and an authored vector; slot cost is 1 / 1 / 2 by rarity', () => {
    for (const card of PULSE_CARDS) {
      expect(card.slotCost, card.id).toBe(card.rarity === 'rare' ? 2 : 1);
      expect(slotCostOf(card.id)).toBe(card.slotCost);
      expect(rarityOf(card.id)).toBe(card.rarity);
      expect(GAME_CONFIG.run.rarity[card.rarity].slotCost).toBe(card.slotCost);
      if (card.kind === 'one-shot') {
        expect(card.modifiers, card.id).toEqual({});
        expect(Object.keys(card.vector).length, card.id).toBeGreaterThanOrEqual(2);
      }
    }
    expect(slotCostTotal(['weather-station', 'grand-opening'])).toBe(3);
  });

  it('gives every card at least one player-positive and one player-negative axis (up iff value != 1 and higher === value > 1)', () => {
    for (const card of PULSE_CARDS) {
      if (card.kind === 'stage') {
        const directions = Object.entries(card.modifiers).map(([rule, value]) => {
          const higher = MULTIPLIER_DIRECTION[rule as keyof typeof MULTIPLIER_DIRECTION] === 'higherIsBetter';
          return value !== 1 && higher === (value as number > 1) ? 'up' : 'down';
        });
        expect(directions, `${card.id} needs an upside`).toContain('up');
        expect(directions, `${card.id} needs a downside`).toContain('down');
      } else {
        const values = Object.values(card.vector) as number[];
        expect(values.some((value) => value > 0), `${card.id} needs an upside`).toBe(true);
        expect(values.some((value) => value < 0), `${card.id} needs a downside`).toBe(true);
      }
    }
  });

  it('starts the collection with a strict subset of the pool so drafts have something to offer', () => {
    expect(STARTING_CARD_IDS).toEqual(['grand-opening', 'local-contractors', 'hungry-tourists']);
    expect(STARTING_CARD_IDS.length).toBeLessThan(PULSE_CARDS.length);
    for (const cardId of STARTING_CARD_IDS) expect(CARD_BY_ID.has(cardId)).toBe(true);
  });
});

describe('rule composition', () => {
  it('composes base → scenario → cards in order and never mutates the base rules', () => {
    const cardA = CARD_BY_ID.get('grand-opening')!;
    const cardB = CARD_BY_ID.get('velvet-ropes')!;
    const rules = compileParkRules(
      { arrivalIntervalMultiplier: 1.3, startingCash: 8_000 },
      [cardA.modifiers, cardB.modifiers],
    );
    // 1.3 (scenario) × 0.8 (Grand Opening) × 1.2 (Velvet Ropes) = 1.248
    expect(rules.arrivalIntervalMultiplier).toBeCloseTo(1.248, 3);
    // 0.85 × 1.25 = 1.0625 — cards compose multiplicatively with each other too.
    expect(rules.guestBudgetMultiplier).toBeCloseTo(1.0625, 3);
    expect(rules.startingCash).toBe(8_000);
    expect(BASE_PARK_RULES.arrivalIntervalMultiplier).toBe(1);
    // The scenario's override must not have leaked into the shared config.
    expect(BASE_PARK_RULES.startingCash).toBe(GAME_CONFIG.startingCash);
  });

  it('clamps stacked multipliers to the safety range', () => {
    const rules = compileParkRules({ needDecayMultiplier: 3 }, [
      { needDecayMultiplier: 3 },
      { needDecayMultiplier: 3 },
    ]);
    expect(rules.needDecayMultiplier).toBe(RULE_CLAMPS.maximumMultiplier);
    const floor = compileParkRules({}, [{ staffSalaryMultiplier: 0.01 }]);
    expect(floor.staffSalaryMultiplier).toBe(RULE_CLAMPS.minimumMultiplier);
  });

  it('is pure: the same inputs always compile to the same ruleset', () => {
    const card = CARD_BY_ID.get('local-contractors')!;
    const first = compileParkRules({ startingCash: 9_000 }, [card.modifiers]);
    const second = compileParkRules({ startingCash: 9_000 }, [card.modifiers]);
    expect(second).toEqual(first);
  });
});

describe('reward drafts', () => {
  it('is deterministic for the same collection and seed, and never offers owned cards', () => {
    const owned = new Set(STARTING_CARD_IDS);
    const first = draftRewardChoices(owned, 12345);
    const second = draftRewardChoices(owned, 12345);
    expect(second).toEqual(first);
    expect(first).toHaveLength(3);
    for (const cardId of first) {
      expect(owned.has(cardId)).toBe(false);
      expect(CARD_BY_ID.has(cardId)).toBe(true);
    }
    expect(new Set(first).size).toBe(first.length);
  });

  it('owning all but one stage card yields exactly that one; a complete stage collection yields nothing', () => {
    const stage = PULSE_CARDS.filter((card) => card.kind === 'stage').map((card) => card.id);
    expect(draftRewardChoices(stage.slice(0, -1), 7)).toEqual([stage.at(-1)]);
    expect(draftRewardChoices(stage, 7)).toEqual([]);
    expect(draftRewardChoices(PULSE_CARDS.map((card) => card.id), 7)).toEqual([]);
  });
});

describe('chain lift cost rule', () => {
  it('is a lower-is-better card rule that defaults to 1', () => {
    expect(CARD_MODIFIABLE_RULES).toContain('chainLiftCostMultiplier');
    expect(MULTIPLIER_DIRECTION.chainLiftCostMultiplier).toBe('lowerIsBetter');
    expect(BASE_PARK_RULES.chainLiftCostMultiplier).toBe(1);
    expect(compileParkRules().chainLiftCostMultiplier).toBe(1);
  });

  it('a synthetic modifier compiles to 1.5, clamps at both ends and survives a save round trip', () => {
    expect(compileParkRules({}, [{ chainLiftCostMultiplier: 1.5 }]).chainLiftCostMultiplier).toBe(1.5);
    expect(compileParkRules({}, [{ chainLiftCostMultiplier: 9 }]).chainLiftCostMultiplier).toBe(RULE_CLAMPS.maximumMultiplier);
    expect(compileParkRules({}, [{ chainLiftCostMultiplier: 0.01 }]).chainLiftCostMultiplier).toBe(RULE_CLAMPS.minimumMultiplier);
    const rules = compileParkRules({ chainLiftCostMultiplier: 1.5 });
    const session = new ParkSession(null, [], { rules });
    const state = session.serialize();
    expect(state.rules.chainLiftCostMultiplier).toBe(1.5);
    const restored = ParkSession.fromState(JSON.parse(JSON.stringify(state)) as typeof state);
    expect(restored.rules.chainLiftCostMultiplier).toBe(1.5);
    expect(hashState(restored.serialize())).toBe(hashState(state));
  });

  it('dearer chains raise the base cost by the chained share only', () => {
    const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
    const layout = hillDipFreeLayout();
    const chainedSegments = 3;
    expect(coasterBaseCost(layout, type, 1.5) - coasterBaseCost(layout, type, 1))
      .toBe(chainedSegments * (GAME_CONFIG.coaster.lift.chainCostPerPiece * 1.5 - GAME_CONFIG.coaster.lift.chainCostPerPiece));
  });
});
