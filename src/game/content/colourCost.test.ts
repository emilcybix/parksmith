import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { BASE_PARK_RULES, CARD_MODIFIABLE_RULES, MULTIPLIER_DIRECTION, RULE_CLAMPS, compileParkRules } from '../scenarios/rules';
import { recolourCharge, type ColourCostMode } from './colourCost';

const MODES: ColourCostMode[] = ['sandbox', 'scenario', 'map'];
const PRICED = { scenario: 25, map: 40 } as const;

describe('recolourCharge', () => {
  it('the shipped config is free in every mode (0 until Phase 22 and 25 decide)', () => {
    expect(GAME_CONFIG.colours.recolourCostPerObject).toEqual({ scenario: 0, map: 0 });
    for (const mode of MODES) {
      for (const objects of [0, 1, 7, 500]) {
        for (const multiplier of [0.25, 1, 4]) expect(recolourCharge(mode, objects, multiplier), `${mode} ${objects} x${multiplier}`).toBe(0);
      }
    }
  });

  it('the Sandbox is free by rule, whatever the config says and whatever the multiplier', () => {
    for (const objects of [0, 1, 7, 500]) for (const multiplier of [0.25, 1, 4, 100]) {
      expect(recolourCharge('sandbox', objects, multiplier, PRICED)).toBe(0);
    }
  });

  it('Scenario and The Map charge per changed object, per their own config entry', () => {
    expect(recolourCharge('scenario', 1, 1, PRICED)).toBe(25);
    expect(recolourCharge('scenario', 6, 1, PRICED)).toBe(150);
    expect(recolourCharge('map', 1, 1, PRICED)).toBe(40);
    expect(recolourCharge('map', 6, 1, PRICED)).toBe(240);
    expect(recolourCharge('scenario', 0, 1, PRICED)).toBe(0);
  });

  it('the multiplier scales the per-object price, rounded per object', () => {
    expect(recolourCharge('scenario', 4, 2, PRICED)).toBe(200);
    expect(recolourCharge('scenario', 4, 0.5, PRICED)).toBe(4 * Math.round(12.5));
    expect(recolourCharge('map', 3, 0.25, PRICED)).toBe(30);
    expect(recolourCharge('scenario', 4, 1, { scenario: 0, map: 0 })).toBe(0);
    expect(recolourCharge('scenario', 4, 4, { scenario: 0, map: 0 }), 'free times anything is free').toBe(0);
  });

  it('never charges NaN, a negative amount or a fraction of an object, and never pays the player', () => {
    for (const objects of [Number.NaN, -3, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 0]) {
      expect(recolourCharge('scenario', objects, 1, PRICED), String(objects)).toBe(0);
    }
    expect(recolourCharge('scenario', 2.9, 1, PRICED)).toBe(50);
    expect(recolourCharge('scenario', 2, Number.NaN, PRICED), 'a hostile multiplier is read as 1').toBe(50);
    expect(recolourCharge('scenario', 2, -4, PRICED)).toBe(50);
    expect(recolourCharge('scenario', 2, 0, PRICED)).toBe(50);
    expect(recolourCharge('scenario', 2, 1, { scenario: -5, map: 0 })).toBe(0);
    expect(recolourCharge('scenario', 2, 1, { scenario: Number.NaN, map: 0 })).toBe(0);
  });

  it('is an integer for any input and never negative', () => {
    for (const mode of MODES) for (const objects of [0, 1, 3, 57]) for (const multiplier of [0.25, 0.333, 1, 1.5, 4]) {
      const amount = recolourCharge(mode, objects, multiplier, { scenario: 7, map: 13 });
      expect(Number.isInteger(amount) && amount >= 0, `${mode} ${objects} ${multiplier}`).toBe(true);
    }
  });
});

describe('the recolourCostMultiplier rule', () => {
  it('is a base rule of 1, card-modifiable and lower is better', () => {
    expect(BASE_PARK_RULES.recolourCostMultiplier).toBe(1);
    expect(compileParkRules().recolourCostMultiplier).toBe(1);
    expect(CARD_MODIFIABLE_RULES).toContain('recolourCostMultiplier');
    expect(MULTIPLIER_DIRECTION.recolourCostMultiplier).toBe('lowerIsBetter');
  });

  it('compiles from a scenario override and from cards, multiplied in order and clamped like every multiplier', () => {
    expect(compileParkRules({ recolourCostMultiplier: 2 }).recolourCostMultiplier).toBe(2);
    expect(compileParkRules({}, [{ recolourCostMultiplier: 1.5 }]).recolourCostMultiplier).toBe(1.5);
    expect(compileParkRules({ recolourCostMultiplier: 2 }, [{ recolourCostMultiplier: 0.5 }, { recolourCostMultiplier: 0.5 }]).recolourCostMultiplier).toBe(0.5);
    expect(compileParkRules({}, [{ recolourCostMultiplier: 9 }]).recolourCostMultiplier).toBe(RULE_CLAMPS.maximumMultiplier);
    expect(compileParkRules({}, [{ recolourCostMultiplier: 0.01 }]).recolourCostMultiplier).toBe(RULE_CLAMPS.minimumMultiplier);
    expect(compileParkRules({ recolourCostMultiplier: Number.NaN }).recolourCostMultiplier).toBe(1);
    expect(compileParkRules({ recolourCostMultiplier: -3 }).recolourCostMultiplier).toBe(1);
  });

  it('a compiled multiplier feeds the charge', () => {
    const rules = compileParkRules({}, [{ recolourCostMultiplier: 2 }]);
    expect(recolourCharge('scenario', 3, rules.recolourCostMultiplier, PRICED)).toBe(150);
  });
});
