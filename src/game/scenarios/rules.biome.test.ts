import { describe, expect, it } from 'vitest';
import { BIOMES } from '../biomes/content';
import { GAME_CONFIG } from '../config';
import { hashState } from '../save/hash';
import { ParkSession } from '../session/ParkSession';
import { BASE_PARK_RULES, BIOME_RULE_KEYS, CARD_MODIFIABLE_RULES, MULTIPLIER_DIRECTION, NEUTRAL_RULES_OF_BIOME, PHASE14_RULE_KEYS, PHASE16_RULE_KEYS, RULE_CLAMPS, compileParkRules } from './rules';

describe('the biome rule layer', () => {
  it('is absent for Meadow and for any neutral biome: the compiled ruleset is exactly what it always was', () => {
    const plain = compileParkRules();
    expect(compileParkRules(undefined, [], NEUTRAL_RULES_OF_BIOME)).toEqual(plain);
    expect(JSON.stringify(compileParkRules(undefined, [], NEUTRAL_RULES_OF_BIOME))).toBe(JSON.stringify(plain));
    for (const key of BIOME_RULE_KEYS) expect(key in plain).toBe(false);
    expect(BASE_PARK_RULES).not.toHaveProperty('hungerRateMultiplier');
  });

  it('writes a key only when it is not 1, from the biome, after the card multipliers', () => {
    const winter = BIOMES.find((biome) => biome.id === 'winter')!;
    const rules = compileParkRules(undefined, [], winter.rules);
    expect(rules.hungerRateMultiplier).toBe(1.08);
    expect(rules.thirstRateMultiplier).toBe(0.9);
    const desert = compileParkRules(undefined, [], BIOMES.find((biome) => biome.id === 'desert-canyon')!.rules);
    expect('hungerRateMultiplier' in desert).toBe(false);
    expect(desert.thirstRateMultiplier).toBe(1.12);
    // Phase 16's two base-layer keys and Phase 14's one, when written, come after the biome keys.
    const phase16: readonly string[] = [...PHASE16_RULE_KEYS, ...PHASE14_RULE_KEYS];
    expect(Object.keys(rules).filter((key) => !phase16.includes(key)).slice(-2)).toEqual(['hungerRateMultiplier', 'thirstRateMultiplier']);
  });

  it('clamps to 0.8..1.25 and rounds like the other multipliers; a non-finite value is neutral', () => {
    const wild = compileParkRules(undefined, [], { hungerRateMultiplier: 9, thirstRateMultiplier: 0.01 });
    expect(wild.hungerRateMultiplier).toBe(RULE_CLAMPS.maximumBiomeMultiplier);
    expect(wild.thirstRateMultiplier).toBe(RULE_CLAMPS.minimumBiomeMultiplier);
    const bad = compileParkRules(undefined, [], { hungerRateMultiplier: Number.NaN, thirstRateMultiplier: Number.POSITIVE_INFINITY });
    expect('hungerRateMultiplier' in bad).toBe(false);
    expect('thirstRateMultiplier' in bad).toBe(false);
    expect(compileParkRules(undefined, [], { hungerRateMultiplier: 1.0004, thirstRateMultiplier: 1 }).hungerRateMultiplier).toBeUndefined();
    expect(GAME_CONFIG.maps.biomeRuleClamp.minimum).toBe(RULE_CLAMPS.minimumBiomeMultiplier);
    expect(GAME_CONFIG.maps.biomeRuleClamp.maximum).toBe(RULE_CLAMPS.maximumBiomeMultiplier);
  });

  it('is not card-modifiable and not a scenario override', () => {
    for (const key of BIOME_RULE_KEYS) {
      expect((CARD_MODIFIABLE_RULES as readonly string[]).includes(key)).toBe(false);
      expect(key in MULTIPLIER_DIRECTION).toBe(false);
    }
    const scenario = compileParkRules({ hungerRateMultiplier: 1.2 } as never, [{ hungerRateMultiplier: 2 } as never]);
    expect('hungerRateMultiplier' in scenario).toBe(false);
  });

  it('is serialized only when not 1, absent reads as 1, and a restore compares the normalised forms', () => {
    const meadow = new ParkSession(null);
    meadow.syncWithWorld();
    expect(Object.keys(meadow.serialize().rules)).not.toContain('thirstRateMultiplier');
    const winter = new ParkSession(null, [], { mapId: 'frosted-hollow' });
    winter.syncWithWorld();
    const state = JSON.parse(JSON.stringify(winter.serialize()));
    expect(state.rules.hungerRateMultiplier).toBe(1.08);
    expect(state.rules.thirstRateMultiplier).toBe(0.9);
    const restored = ParkSession.fromState(structuredClone(state));
    expect(restored.rules.hungerRateMultiplier).toBe(1.08);
    expect(hashState(restored.serialize())).toBe(hashState(state));
    // An in-place restore of a different biome's ruleset is refused.
    expect(() => meadow.restoreState(structuredClone(state))).toThrow();
  });
});

describe('hunger and thirst growth per biome', () => {
  type NeedsHook = { updateNeeds(guest: { hunger: number; thirst: number; toiletNeed: number; energy: number; state: string; currentCell: { x: number; y: number } }, seconds: number): void };
  /** One need update of a lone guest, by the same call the step makes (the guest has no ride to go to and would leave on a real step). */
  const grown = (mapId: 'meadow' | 'frosted-hollow' | 'red-rock-canyon', field: 'hunger' | 'thirst'): number => {
    const session = new ParkSession(null, [], { mapId, seed: 77 });
    session.setWeatherEnabled(false);
    session.guests.spawnGuests(1);
    const guest = [...session.guests.guests.values()][0];
    guest.hunger = 10;
    guest.thirst = 10;
    const before = guest[field];
    (session.guests as unknown as NeedsHook).updateNeeds(guest, 1);
    return guest[field] - before;
  };

  it('Winter: hunger x1.08 and thirst x0.9; Desert: thirst x1.12 and hunger unchanged', () => {
    const meadowHunger = grown('meadow', 'hunger');
    const meadowThirst = grown('meadow', 'thirst');
    expect(meadowHunger).toBeGreaterThan(0);
    expect(grown('frosted-hollow', 'hunger') / meadowHunger).toBeCloseTo(1.08, 9);
    expect(grown('frosted-hollow', 'thirst') / meadowThirst).toBeCloseTo(0.9, 9);
    expect(grown('red-rock-canyon', 'hunger') / meadowHunger).toBeCloseTo(1, 12);
    expect(grown('red-rock-canyon', 'thirst') / meadowThirst).toBeCloseTo(1.12, 9);
  });

  it('Meadow\'s growth is the exact historical product (a trailing * 1 is exact)', () => {
    const session = new ParkSession(null);
    session.guests.spawnGuests(1);
    const guest = [...session.guests.guests.values()][0];
    guest.hunger = 10;
    guest.thirst = 10;
    (session.guests as unknown as NeedsHook).updateNeeds(guest, 1);
    expect(guest.hunger).toBe(10 + GAME_CONFIG.guests.hungerPerSecond * 1);
    expect(guest.thirst).toBe(10 + GAME_CONFIG.guests.thirstPerSecond * 1 * session.weather.conditions.thirstFactor);
  });
});
