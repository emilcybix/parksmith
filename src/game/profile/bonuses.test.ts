import { describe, expect, it } from 'vitest';
import { hashState } from '../save/hash';
import { SCENARIOS } from '../scenarios/content';
import { BASE_PARK_RULES, CARD_MODIFIABLE_RULES, MULTIPLIER_DIRECTION, compileParkRules, researchCostScaleOf, type ParkRuleset } from '../scenarios/rules';
import { scaledResearchPoints } from '../progression/content';
import { PULSE_CARDS } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { EMPTY_GRANT, ParkSession } from '../session/ParkSession';
import { testRunAtLoadout, testStageSession } from '../run/testSupport';
import { startStage } from '../run/deck';
import { GAME_MODES } from '../modes/types';
import {
  BONUSES,
  BONUS_BY_ID,
  BONUS_CLAMPS,
  NEUTRAL_BONUS_LAYER,
  compileBonusLayer,
  type BonusDefinition,
  type BonusId,
} from './bonuses';

const NEUTRAL_RULES = compileParkRules();
const layerOf = (id: BonusId, mode: 'sandbox' | 'scenario' | 'run' = 'scenario', cash = 9_000) => compileBonusLayer([id], mode, cash);

/** Every compiled key but `except` is identical to the no-bonus compile. */
const otherKeysUnchanged = (rules: ParkRuleset, except: readonly string[], base: ParkRuleset = NEUTRAL_RULES): void => {
  const left = { ...rules } as Record<string, unknown>;
  const right = { ...base } as Record<string, unknown>;
  for (const key of except) { delete left[key]; delete right[key]; }
  expect(left).toEqual(right);
};

describe('the bonus catalogue', () => {
  it('lists six small bonuses within the static budget', () => {
    expect(BONUSES.map((bonus) => bonus.id)).toEqual(['nest-egg', 'research-grant', 'builders-discount', 'spare-slot', 'word-of-mouth', 'trusted-crew', 'land-surveyor']);
    expect(BONUSES.length).toBeLessThanOrEqual(BONUS_CLAMPS.maxBonuses);
    expect(new Set(BONUSES.map((bonus) => bonus.id)).size).toBe(BONUSES.length);
    expect(BONUS_BY_ID.size).toBe(BONUSES.length);
    for (const bonus of BONUSES) {
      expect(bonus.summary.endsWith('.'), bonus.id).toBe(true);
      expect(bonus.name.length, bonus.id).toBeGreaterThan(0);
    }
  });

  it('every shipped bonus is within its per-bonus clamp and is upside-only', () => {
    for (const bonus of BONUSES) {
      const effect = bonus.effect;
      if (effect.kind === 'startingCash') expect(effect.amount).toBeLessThanOrEqual(BONUS_CLAMPS.maxCashBonus);
      if (effect.kind === 'startingResearchPoints') expect(effect.amount).toBeLessThanOrEqual(BONUS_CLAMPS.maxResearchPoints);
      if (effect.kind === 'extraCardSlots') expect(effect.amount).toBe(1);
      if (effect.kind === 'multiplier') {
        expect(effect.factor).toBeGreaterThanOrEqual(BONUS_CLAMPS.minFactor);
        expect(effect.factor).toBeLessThanOrEqual(BONUS_CLAMPS.maxFactor);
        const better = MULTIPLIER_DIRECTION[effect.rule] === 'lowerIsBetter' ? effect.factor < 1 : effect.factor > 1;
        expect(better, `${bonus.id} must help the player`).toBe(true);
      }
    }
  });

  it('exactly one shipped scenario grants each bonus', () => {
    for (const bonus of BONUSES) {
      expect(SCENARIOS.filter((scenario) => scenario.rewards.bonuses.includes(bonus.id)).map((scenario) => scenario.id), bonus.id).toHaveLength(1);
    }
  });
});

describe('one test per bonus: the effect is exact, nothing else moves, the id is listed', () => {
  it('nest-egg: +$500 starting cash (Scenario cash 9,000; Sandbox 5,000 is capped at 10% = $500)', () => {
    const layer = layerOf('nest-egg', 'scenario', 9_000);
    expect(layer.appliedBonusIds).toEqual(['nest-egg']);
    const rules = compileParkRules({ startingCash: 9_000 }, [], undefined, layer);
    expect(rules.startingCash).toBe(9_500);
    otherKeysUnchanged(rules, ['startingCash'], compileParkRules({ startingCash: 9_000 }));
    const sandbox = compileParkRules(undefined, [], undefined, layerOf('nest-egg', 'sandbox', 5_000));
    expect(sandbox.startingCash).toBe(5_500);
    // The 10% cap: a $2,000 start gets at most $200.
    expect(compileBonusLayer(['nest-egg'], 'scenario', 2_000).startingCashBonus).toBe(200);
    expect(compileBonusLayer(['nest-egg'], 'scenario', 2_050).startingCashBonus, 'rounded down to $10').toBe(200);
  });

  it('research-grant: a new park has 15 research points, a restore does not add them again, the rules key exists only then', () => {
    const grant = { unlockedBuildingIds: [], bonusIds: ['research-grant' as const] };
    const layer = layerOf('research-grant');
    expect(layer.appliedBonusIds).toEqual(['research-grant']);
    const rules = compileParkRules(undefined, [], undefined, layer);
    expect(rules.startingResearchPoints).toBe(15);
    otherKeysUnchanged(rules, ['startingResearchPoints']);
    expect('startingResearchPoints' in NEUTRAL_RULES).toBe(false);
    const session = new ParkSession(SCENARIOS[0], [], { mode: 'scenario', grant });
    // Phase 16: the saved key stays 15 base RP; the park receives it scaled by its research cost scale (150 at scale 10).
    const granted = scaledResearchPoints(15, researchCostScaleOf(session.rules));
    expect(session.progression.snapshot().researchPoints).toBe(granted);
    expect(new ParkSession(SCENARIOS[0], [], { mode: 'scenario' }).progression.snapshot().researchPoints).toBe(0);
    session.syncWithWorld();
    const restored = ParkSession.fromState(JSON.parse(JSON.stringify(session.serialize())));
    expect(restored.progression.snapshot().researchPoints).toBe(granted);
  });

  it("builders-discount: construction costs x0.97 (paths, objects, refunds)", () => {
    const layer = layerOf('builders-discount');
    expect(layer.appliedBonusIds).toEqual(['builders-discount']);
    const rules = compileParkRules(undefined, [], undefined, layer);
    expect(rules.constructionCostMultiplier).toBe(0.97);
    otherKeysUnchanged(rules, ['constructionCostMultiplier']);
    const plain = new ParkSession(SCENARIOS[0], [], { mode: 'scenario' });
    const discounted = new ParkSession(SCENARIOS[0], [], { mode: 'scenario', grant: { unlockedBuildingIds: [], bonusIds: ['builders-discount'] } });
    const cost = (session: ParkSession): number => {
      const before = session.world.cash;
      expect(session.world.buildObject('moonpetal-carousel', { x: 17, y: 25 }, 0)).not.toBeNull();
      return before - session.world.cash;
    };
    expect(cost(plain)).toBe(900);
    expect(cost(discounted)).toBe(Math.round(900 * 0.97));
  });

  it('spare-slot: three cards are accepted with it and two without; ignored in Sandbox', () => {
    const cards: PulseCardId[] = ['grand-opening', 'velvet-ropes', 'local-contractors'];
    const layer = layerOf('spare-slot');
    expect(layer.extraCardSlots).toBe(1);
    expect(compileParkRules(undefined, [], undefined, layer).extraCardSlots).toBe(1);
    otherKeysUnchanged(compileParkRules(undefined, [], undefined, layer), ['extraCardSlots']);
    const grant = { unlockedBuildingIds: [], bonusIds: ['spare-slot' as const] };
    expect(new ParkSession(SCENARIOS[0], cards, { mode: 'scenario', grant }).activeCards).toHaveLength(3);
    // On The Map level 1 has one slot: the Spare card slot makes two, and a third card is cut.
    expect(testStageSession({ grant, cardCount: 2 }).session.activeCards).toHaveLength(2);
    expect(testStageSession({ cardCount: 1 }).session.activeCards).toHaveLength(1);
    expect(startStage(testRunAtLoadout({ grant }), testRunAtLoadout({ grant }).deck.slice(0, 3)), 'the loadout model refuses a third card').toMatchObject({ ok: false, reason: 'too-many' });
    expect(startStage(testRunAtLoadout(), testRunAtLoadout().deck.slice(0, 2)), 'without the bonus a second card is refused').toMatchObject({ ok: false, reason: 'too-many' });
    expect(new ParkSession(SCENARIOS[0], cards, { mode: 'scenario' }).activeCards).toHaveLength(2);
    expect(compileBonusLayer(['spare-slot'], 'sandbox', 5_000)).toMatchObject({ extraCardSlots: 0, appliedBonusIds: [] });
    const sandbox = new ParkSession(null, [], { grant });
    expect(sandbox.grant.bonusIds).toEqual([]);
    expect(sandbox.rules.extraCardSlots).toBeUndefined();
  });

  it('word-of-mouth: arrivalIntervalMultiplier = scenario x 0.97 before the cards', () => {
    const layer = layerOf('word-of-mouth');
    expect(layer.appliedBonusIds).toEqual(['word-of-mouth']);
    const scenario = { arrivalIntervalMultiplier: 1.3 };
    const rules = compileParkRules(scenario, [], undefined, layer);
    expect(rules.arrivalIntervalMultiplier).toBe(Math.round(1.3 * 0.97 * 1000) / 1000);
    otherKeysUnchanged(rules, ['arrivalIntervalMultiplier'], compileParkRules(scenario));
    const card = PULSE_CARDS.find((candidate) => candidate.modifiers.arrivalIntervalMultiplier !== undefined)!;
    const withCard = compileParkRules(scenario, [card.modifiers], undefined, layer);
    expect(withCard.arrivalIntervalMultiplier).toBe(Math.round(1.3 * 0.97 * card.modifiers.arrivalIntervalMultiplier! * 1000) / 1000);
  });

  it('trusted-crew: staffSalaryMultiplier x 0.95', () => {
    const layer = layerOf('trusted-crew');
    expect(layer.appliedBonusIds).toEqual(['trusted-crew']);
    const rules = compileParkRules(undefined, [], undefined, layer);
    expect(rules.staffSalaryMultiplier).toBe(0.95);
    otherKeysUnchanged(rules, ['staffSalaryMultiplier']);
  });
});

describe('composition and clamps', () => {
  const oversized = (id: BonusId, effect: BonusDefinition['effect'], modes: BonusDefinition['modes'] = GAME_MODES): BonusDefinition => ({
    id, name: id, icon: '?', summary: 'Oversized.', effect, modes,
  });

  it('every bonus together stays inside the total clamps', () => {
    const layer = compileBonusLayer(BONUSES.map((bonus) => bonus.id), 'scenario', 9_000);
    expect(layer.appliedBonusIds).toEqual(BONUSES.map((bonus) => bonus.id));
    expect(layer.startingCashBonus).toBeLessThanOrEqual(BONUS_CLAMPS.maxCashBonus);
    expect(layer.startingResearchPoints).toBeLessThanOrEqual(BONUS_CLAMPS.maxResearchPoints);
    expect(layer.extraCardSlots).toBeLessThanOrEqual(BONUS_CLAMPS.maxExtraCardSlots);
    for (const factor of Object.values(layer.multipliers)) {
      expect(factor).toBeGreaterThanOrEqual(BONUS_CLAMPS.minFactor);
      expect(factor).toBeLessThanOrEqual(1 / BONUS_CLAMPS.minFactor);
    }
  });

  it('oversized injected bonuses are clamped per bonus and in total', () => {
    const table: BonusDefinition[] = [
      oversized('nest-egg', { kind: 'startingCash', amount: 9_999_999 }),
      oversized('research-grant', { kind: 'startingResearchPoints', amount: 500 }),
      oversized('builders-discount', { kind: 'multiplier', rule: 'constructionCostMultiplier', factor: 0.1 }),
      oversized('word-of-mouth', { kind: 'multiplier', rule: 'constructionCostMultiplier', factor: 0.5 }),
      oversized('trusted-crew', { kind: 'multiplier', rule: 'guestBudgetMultiplier', factor: 9 }),
      oversized('spare-slot', { kind: 'extraCardSlots', amount: 1 }),
    ];
    const layer = compileBonusLayer(table.map((bonus) => bonus.id), 'scenario', 100_000, table);
    expect(layer.startingCashBonus).toBe(BONUS_CLAMPS.maxCashBonus);
    expect(layer.startingResearchPoints).toBe(BONUS_CLAMPS.maxResearchPoints);
    expect(layer.multipliers.constructionCostMultiplier, 'two 0.95 factors multiply to 0.9025, clamped to 0.95').toBe(BONUS_CLAMPS.minFactor);
    expect(layer.multipliers.guestBudgetMultiplier).toBe(BONUS_CLAMPS.maxFactor);
    expect(layer.extraCardSlots).toBe(1);
    const small = compileBonusLayer(['nest-egg'], 'scenario', 3_000, table);
    expect(small.startingCashBonus, '10% of the pre-bonus cash').toBe(300);
    expect(compileBonusLayer(['nest-egg'], 'scenario', Number.NaN, table).startingCashBonus).toBe(0);
    expect(compileBonusLayer(['nest-egg'], 'scenario', -5, table).startingCashBonus).toBe(0);
  });

  it('a wrong-way multiplier is neutralised (a bonus is upside-only), a non-finite one is ignored', () => {
    const table: BonusDefinition[] = [
      oversized('builders-discount', { kind: 'multiplier', rule: 'constructionCostMultiplier', factor: 1.04 }),
      oversized('trusted-crew', { kind: 'multiplier', rule: 'guestBudgetMultiplier', factor: 0.96 }),
      oversized('word-of-mouth', { kind: 'multiplier', rule: 'arrivalIntervalMultiplier', factor: Number.NaN }),
    ];
    const layer = compileBonusLayer(table.map((bonus) => bonus.id), 'scenario', 9_000, table);
    expect(layer.multipliers).toEqual({});
    expect(compileParkRules(undefined, [], undefined, layer)).toEqual(NEUTRAL_RULES);
  });

  it('at most eight bonuses ever apply', () => {
    const table = Array.from({ length: 12 }, (_, index): BonusDefinition => oversized(`b${index}` as BonusId, { kind: 'startingResearchPoints', amount: 1 }));
    const layer = compileBonusLayer(table.map((bonus) => bonus.id), 'scenario', 9_000, table);
    expect(layer.appliedBonusIds).toHaveLength(BONUS_CLAMPS.maxBonuses);
  });

  it('a hostile id list is ignored: unknown ids, duplicates, numbers, objects and __proto__', () => {
    const hostile = ['nest-egg', 'nest-egg', 7, null, {}, '__proto__', 'constructor', 'toString', undefined, ['nest-egg']];
    const layer = compileBonusLayer(hostile as unknown[], 'scenario', 9_000);
    expect(layer.appliedBonusIds).toEqual(['nest-egg']);
    expect(layer.startingCashBonus).toBe(500);
    expect(compileBonusLayer('nest-egg' as never, 'scenario', 9_000)).toBe(NEUTRAL_BONUS_LAYER);
    expect(compileBonusLayer([], 'scenario', 9_000)).toBe(NEUTRAL_BONUS_LAYER);
  });

  it('filters by mode and applies in canonical order whatever order the ids come in', () => {
    const layer = compileBonusLayer(['word-of-mouth', 'nest-egg', 'spare-slot'], 'sandbox', 5_000);
    expect(layer.appliedBonusIds).toEqual(['nest-egg', 'word-of-mouth']);
    expect(compileBonusLayer(['word-of-mouth', 'nest-egg', 'spare-slot'], 'run', 5_000).appliedBonusIds).toEqual(['nest-egg', 'spare-slot', 'word-of-mouth']);
  });

  it('every bonus is a player-better direction: no bonus makes any rule worse', () => {
    const all = compileParkRules(undefined, [], undefined, compileBonusLayer(BONUSES.map((bonus) => bonus.id), 'scenario', 9_000));
    for (const rule of CARD_MODIFIABLE_RULES) {
      if (MULTIPLIER_DIRECTION[rule] === 'lowerIsBetter') expect(all[rule], rule).toBeLessThanOrEqual(BASE_PARK_RULES[rule]);
      else expect(all[rule], rule).toBeGreaterThanOrEqual(BASE_PARK_RULES[rule]);
    }
    expect(all.startingCash).toBeGreaterThanOrEqual(BASE_PARK_RULES.startingCash);
  });

  it('the bonus-only keys are never card-modifiable and never a multiplier direction', () => {
    expect(CARD_MODIFIABLE_RULES as readonly string[]).not.toContain('startingResearchPoints');
    expect(CARD_MODIFIABLE_RULES as readonly string[]).not.toContain('extraCardSlots');
    expect(Object.keys(MULTIPLIER_DIRECTION)).not.toContain('startingResearchPoints');
    expect(Object.keys(MULTIPLIER_DIRECTION)).not.toContain('extraCardSlots');
  });
});

describe('the neutral layer is the compile that existed before (byte for byte)', () => {
  it('compileParkRules with the neutral layer equals the call without it, for the Sandbox and every scenario', () => {
    expect(JSON.stringify(compileParkRules(undefined, [], undefined, NEUTRAL_BONUS_LAYER))).toBe(JSON.stringify(compileParkRules()));
    for (const scenario of SCENARIOS) {
      const cards = PULSE_CARDS.slice(0, 2).map((card) => card.modifiers);
      expect(JSON.stringify(compileParkRules(scenario.rules, cards, undefined, NEUTRAL_BONUS_LAYER)), scenario.id).toBe(JSON.stringify(compileParkRules(scenario.rules, cards)));
    }
  });

  it('a park with an empty grant serialises the rules it always did, and hashes like a park without a grant', () => {
    for (const scenario of [null, ...SCENARIOS]) {
      const plain = new ParkSession(scenario);
      const empty = new ParkSession(scenario, [], { grant: EMPTY_GRANT });
      plain.syncWithWorld();
      empty.syncWithWorld();
      expect(hashState(empty.serialize()), scenario?.id ?? 'sandbox').toBe(hashState(plain.serialize()));
      expect(Object.keys(plain.serialize().rules), scenario?.id ?? 'sandbox').not.toContain('startingResearchPoints');
    }
  });
});
