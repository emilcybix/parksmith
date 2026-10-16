import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 14 (design Q2 and section 6): the ruleset key `crowdFeedback`, schema 13 with its optional top-level `crowd`
 * field, content version 4. The key is compiled from GAME_CONFIG.crowd.feedback for every NEW park (read at compile
 * time, so the config mock below reaches it), clamped, written LAST and only when not 0, never card- or
 * scenario-modifiable, absent in every save before Phase 14 (absent = off). The `crowd` field exists exactly when the
 * rule does (`checkCrowdLaw`, also enforced on the envelope). The session wiring (serialize / restore of the key and the
 * field) lands in Wave 2; this file covers the compile, the laws and the versions.
 */
const knobs = vi.hoisted(() => ({ feedback: 1 }));
vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  const config = actual.GAME_CONFIG;
  return {
    ...actual,
    GAME_CONFIG: { ...config, crowd: { ...config.crowd, get feedback() { return knobs.feedback; } } },
  };
});

const { GAME_CONFIG } = await import('../config');
const { CARD_MODIFIABLE_RULES, CROWD_FEEDBACK_COMPILED, PHASE14_RULE_KEYS, PHASE16_RULE_KEYS, compileParkRules, crowdFeedbackKeys, crowdFeedbackOf } = await import('../scenarios/rules');
const { SCENARIO_BY_ID } = await import('../scenarios/content');
const { ParkSession } = await import('../session/ParkSession');
const { SAVE_CONTENT_VERSION, SAVE_SCHEMA_VERSION, SaveError, contentDriftOf, createParkSave } = await import('./version');
const { migrateSave } = await import('./migrate');
const { checkCrowdLaw, checkSessionConsistency, readCrowdState } = await import('./consistency');
const { testStageSession } = await import('../run/testSupport');

const fixtures = import.meta.glob<Record<string, unknown>>('./fixtures/*.json', { import: 'default', eager: true });

const withFeedback = <T>(feedback: number, build: () => T): T => {
  knobs.feedback = feedback;
  try {
    return build();
  } finally {
    knobs.feedback = 1;
  }
};

const codeOf = (run: () => unknown): string | null => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SaveError);
    return (error as InstanceType<typeof SaveError>).code;
  }
  return null;
};

/** A park WITHOUT the rule (built under feedback 0; since Wave 2 every new park compiles the key). */
const sandboxState = () => {
  const session = withFeedback(0, () => new ParkSession(null));
  session.syncWithWorld();
  return session.serialize() as ReturnType<InstanceType<typeof ParkSession>['serialize']> & { crowd?: any; rules: { crowdFeedback?: number } };
};

describe('Phase 14 ruleset key: crowdFeedback', () => {
  it('ships on: feedback 1 (the maximum) for every new park', () => {
    expect(PHASE14_RULE_KEYS).toEqual(['crowdFeedback']);
    expect(GAME_CONFIG.crowd.feedback).toBe(1);
    expect(GAME_CONFIG.crowd.maximumFeedback).toBe(1);
  });

  it('is absent in every frozen fixture (v1 to v12), and no fixture carries a crowd field', () => {
    const names = Object.keys(fixtures);
    expect(names.length).toBeGreaterThanOrEqual(38);
    for (const [name, save] of Object.entries(fixtures)) {
      const state = (save as { state: { rules: Record<string, unknown> } }).state;
      expect('crowdFeedback' in state.rules, name).toBe(false);
      expect('crowd' in state, name).toBe(false);
    }
  });

  it('the compile layer: feedback 1 from the config, clamped to 0..maximumFeedback, rounded to 0.001, written only when not 0', () => {
    expect(crowdFeedbackKeys()).toEqual({ crowdFeedback: 1 });
    const at = (feedback: number) => withFeedback(feedback, () => crowdFeedbackKeys());
    expect(at(2)).toEqual({ crowdFeedback: 1 });
    expect(at(0.25)).toEqual({ crowdFeedback: 0.25 });
    expect(at(0.12345)).toEqual({ crowdFeedback: 0.123 });
    for (const neutral of [0, -1, 0.0004, Number.NaN, Number.NEGATIVE_INFINITY]) expect(at(neutral), String(neutral)).toEqual({});
    expect(crowdFeedbackOf({})).toBe(0);
    expect(crowdFeedbackOf({ crowdFeedback: 0.5 })).toBe(0.5);
  });

  it('compileParkRules writes it as the LAST key (after the Phase 16 keys) in every mode once CROWD_FEEDBACK_COMPILED is on, and never before', () => {
    // Wave 1 lands the switch off (the session does not save the key yet); Wave 2 switches it on with the session wiring.
    const rulesets = [
      compileParkRules(),
      compileParkRules(SCENARIO_BY_ID.get('frost-fair')!.rules),
      new ParkSession(null).rules,
      new ParkSession(SCENARIO_BY_ID.get('frost-fair')!).rules,
      testStageSession().session.rules,
    ];
    for (const rules of rulesets) {
      const keys = Object.keys(rules);
      if (!CROWD_FEEDBACK_COMPILED) {
        expect('crowdFeedback' in rules).toBe(false);
        continue;
      }
      expect(rules.crowdFeedback).toBe(1);
      expect(keys.at(-1)).toBe('crowdFeedback');
      for (const key of PHASE16_RULE_KEYS) if (key in rules) expect(keys.indexOf(key)).toBeLessThan(keys.indexOf('crowdFeedback'));
    }
  });

  it('a config with feedback 0 compiles exactly the ruleset of before Phase 14 (the key is not written)', () => {
    const on = compileParkRules();
    const off = withFeedback(0, () => compileParkRules());
    expect('crowdFeedback' in off).toBe(false);
    expect(crowdFeedbackOf(off)).toBe(0);
    const { crowdFeedback: _dropped, ...rest } = on;
    void _dropped;
    expect(JSON.stringify(off)).toBe(JSON.stringify(rest));
  });

  it('is neither card-modifiable nor a scenario override', () => {
    expect((CARD_MODIFIABLE_RULES as readonly string[]).includes('crowdFeedback')).toBe(false);
    const overrides = { crowdFeedback: 0.3 } as unknown as Parameters<typeof compileParkRules>[0];
    const cards = [{ crowdFeedback: 0.5 }] as unknown as Parameters<typeof compileParkRules>[1];
    expect(compileParkRules(overrides, cards).crowdFeedback).toBe(CROWD_FEEDBACK_COMPILED ? 1 : undefined);
    expect('crowdFeedback' in withFeedback(0, () => compileParkRules(overrides, cards))).toBe(false);
  });
});

describe('schema 13 and content version 4', () => {
  it('stamps schema 15 (Phase 21 and Phase 29 followed) and content 6 (Phase 39); a content-3 save reports an older balance', () => {
    expect(SAVE_SCHEMA_VERSION).toBe(15);
    expect(SAVE_CONTENT_VERSION).toBe(6);
    expect(contentDriftOf({ contentVersion: 3 })).toBe('older');
    const state = sandboxState();
    const save = createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 1);
    expect([save.schemaVersion, save.contentVersion]).toEqual([15, 6]);
    expect(() => migrateSave(JSON.parse(JSON.stringify(save)))).not.toThrow();
  });

  it('the envelope refuses a crowd field without the rule, and the rule without the field (corrupt)', () => {
    const app = { clock: { speed: 1 as const, simulationTimeMs: 0 }, tourNodeId: null };
    const fieldOnly = sandboxState();
    fieldOnly.crowd = { version: 1, pressure: [] };
    expect(codeOf(() => migrateSave(JSON.parse(JSON.stringify(createParkSave(fieldOnly, app, 1)))))).toBe('corrupt');
    const ruleOnly = sandboxState();
    ruleOnly.rules.crowdFeedback = 1;
    expect(codeOf(() => migrateSave(JSON.parse(JSON.stringify(createParkSave(ruleOnly, app, 1)))))).toBe('corrupt');
    const both = sandboxState();
    both.rules.crowdFeedback = 1;
    both.crowd = { version: 1, pressure: [[5, 1024]] };
    expect(codeOf(() => migrateSave(JSON.parse(JSON.stringify(createParkSave(both, app, 1)))))).toBeNull();
    const explicitZero = sandboxState();
    explicitZero.rules.crowdFeedback = 0;
    expect(codeOf(() => migrateSave(JSON.parse(JSON.stringify(createParkSave(explicitZero, app, 1)))))).toBeNull();
  });
});

describe('the crowd law (consistency.ts)', () => {
  it('holds for every park without the rule and without the field', () => {
    expect(() => checkCrowdLaw(sandboxState())).not.toThrow();
    expect(() => checkSessionConsistency(sandboxState())).not.toThrow();
  });

  it('the field exists exactly when rules.crowdFeedback is present and not 0 (invalid-state)', () => {
    const fieldOnly = sandboxState();
    fieldOnly.crowd = { version: 1, pressure: [] };
    expect(codeOf(() => checkCrowdLaw(fieldOnly))).toBe('invalid-state');
    expect(codeOf(() => checkSessionConsistency(fieldOnly))).toBe('invalid-state');
    expect(codeOf(() => ParkSession.fromState(structuredClone(fieldOnly)))).toBe('invalid-state');
    const ruleOnly = sandboxState();
    ruleOnly.rules.crowdFeedback = 0.5;
    expect(codeOf(() => checkCrowdLaw(ruleOnly))).toBe('invalid-state');
    const zeroWithField = sandboxState();
    zeroWithField.rules.crowdFeedback = 0;
    zeroWithField.crowd = { version: 1, pressure: [] };
    expect(codeOf(() => checkCrowdLaw(zeroWithField))).toBe('invalid-state');
    const both = sandboxState();
    both.rules.crowdFeedback = 1;
    both.crowd = { version: 1, pressure: [[0, 1], [1023, 2 ** 31 - 1]] };
    expect(codeOf(() => checkCrowdLaw(both))).toBeNull();
  });

  it('the field lies on the saved map and in range: cells 0..w*h-1 ascending, integer values 1..2^31-1', () => {
    const state = sandboxState();
    state.rules.crowdFeedback = 1;
    const cells = state.world.mapWidth * state.world.mapHeight;
    expect(cells).toBe(1024);
    for (const pressure of [[[cells, 1]], [[-1, 1]], [[3, 0]], [[3, 1.5]], [[3, 2 ** 31]], [[4, 1], [4, 1]], [[5, 1], [4, 1]]]) {
      state.crowd = { version: 1, pressure };
      expect(codeOf(() => checkCrowdLaw(state)), JSON.stringify(pressure)).toBe('invalid-state');
    }
    state.crowd = { version: 2, pressure: [] };
    expect(codeOf(() => checkCrowdLaw(state))).toBe('invalid-state');
  });

  it('readCrowdState returns a private copy', () => {
    const input = { version: 1, pressure: [[2, 7]] };
    const copy = readCrowdState(input, 4);
    input.pressure[0][1] = 99;
    expect(copy).toEqual({ version: 1, pressure: [[2, 7]] });
  });
});
