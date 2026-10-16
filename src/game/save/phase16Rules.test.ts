import { describe, expect, it, vi } from 'vitest';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 16 (design 4.1, 5 and 7): the two optional ruleset keys `themeAffinity` and `researchCostScale`. They are
 * compiled from GAME_CONFIG for every NEW park (read at compile time, so the config mock below reaches them), clamped,
 * written only when non-neutral, never card- or scenario-modifiable, absent in every save written before Phase 16
 * (absent = neutral) and validated on restore. The mock exposes the two config values as getters over `knobs`.
 */
const knobs = vi.hoisted(() => ({ share: 0, scale: 1 }));
vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  const config = actual.GAME_CONFIG;
  return {
    ...actual,
    GAME_CONFIG: {
      ...config,
      scenery: { ...config.scenery, themeAffinity: { ...config.scenery.themeAffinity, get share() { return knobs.share; } } },
      research: { ...config.research, get costScale() { return knobs.scale; } },
    },
  };
});

const { GAME_CONFIG } = await import('../config');
const { CARD_MODIFIABLE_RULES, compileParkRules } = await import('../scenarios/rules');
const { SCENARIO_BY_ID } = await import('../scenarios/content');
const { ParkSession } = await import('../session/ParkSession');
const { SaveError } = await import('./version');
const { testStageSession } = await import('../run/testSupport');

const fixtures = import.meta.glob<Record<string, unknown>>('./fixtures/*.json', { import: 'default', eager: true });

const KEYS = ['themeAffinity', 'researchCostScale'] as const;

const configured = <T>(share: number, scale: number, build: () => T): T => {
  knobs.share = share;
  knobs.scale = scale;
  try {
    return build();
  } finally {
    knobs.share = 0;
    knobs.scale = 1;
  }
};

const synced = (session: InstanceType<typeof ParkSession>) => {
  session.syncWithWorld();
  return session.serialize();
};

describe('Phase 16 ruleset keys', () => {
  it('ship neutral in this wave: share 0, scale 1, with the designed bounds', () => {
    expect(knobs).toEqual({ share: 0, scale: 1 });
    expect(GAME_CONFIG.scenery.themeAffinity).toMatchObject({ maximumBonus: 10, maximumShare: 0.5 });
    expect(GAME_CONFIG.research.costScaleBounds).toEqual({ minimum: 1, maximum: 20 });
  });

  it('are absent in every frozen fixture (v1 to v12): a save written before Phase 16 keeps no affinity and scale 1', () => {
    const names = Object.keys(fixtures);
    expect(names.length).toBeGreaterThanOrEqual(38);
    for (const [name, save] of Object.entries(fixtures)) {
      const rules = (save as { state: { rules: Record<string, unknown> } }).state.rules;
      for (const key of KEYS) expect(key in rules, `${name}: ${key}`).toBe(false);
    }
    const { session } = sessionFromSave(structuredClone(fixtures['./fixtures/park-v12-sandbox-themed.json']));
    expect(session.scenery.themeAffinity).toBe(0);
    expect(session.progression.researchCostScale).toBe(1);
    expect(session.scenery.snapshot().themeAffinity).toBe(0);
    // Even when the config is switched on, a loaded old park keeps its own (absent) keys.
    const later = configured(0.3, 10, () => sessionFromSave(structuredClone(fixtures['./fixtures/park-v12-sandbox-themed.json'])).session);
    expect(KEYS.filter((key) => key in later.rules)).toEqual([]);
    expect(later.progression.researchCostScale).toBe(1);
  });

  it('are not written under a neutral config, in any mode', () => {
    for (const rules of [compileParkRules(), compileParkRules(SCENARIO_BY_ID.get('frost-fair')!.rules)]) {
      for (const key of KEYS) expect(key in rules, key).toBe(false);
    }
    const sandbox = synced(new ParkSession(null));
    const scenario = synced(new ParkSession(SCENARIO_BY_ID.get('frost-fair')!));
    const stage = synced(testStageSession().session);
    for (const state of [sandbox, scenario, stage]) {
      for (const key of KEYS) expect(key in state.rules, `${state.mode}: ${key}`).toBe(false);
    }
  });

  it('a new park under the switched-on config writes both, as the last keys, in every mode', () => {
    const states = configured(0.3, 10, () => [
      synced(new ParkSession(null)),
      synced(new ParkSession(SCENARIO_BY_ID.get('frost-fair')!)),
      synced(testStageSession().session),
    ]);
    for (const state of states) {
      expect(state.rules.themeAffinity, state.mode).toBe(0.3);
      expect(state.rules.researchCostScale, state.mode).toBe(10);
      // Phase 14's `crowdFeedback` (when compiled) is written after them: the Phase 16 keys end the rest.
      expect(Object.keys(state.rules).filter((key) => key !== 'crowdFeedback').slice(-2), state.mode).toEqual([...KEYS]);
    }
  });

  it('round-trip: a restored park keeps its keys and plays under them (scenery and progression)', () => {
    const state = configured(0.3, 10, () => synced(new ParkSession(null)));
    const restored = ParkSession.fromState(structuredClone(state));
    expect(restored.rules.themeAffinity).toBe(0.3);
    expect(restored.rules.researchCostScale).toBe(10);
    expect(restored.scenery.themeAffinity).toBe(0.3);
    expect(restored.progression.researchCostScale).toBe(10);
    expect(restored.progression.snapshot().projects[0].researchPointCost).toBe(300);
    expect(synced(restored).rules).toEqual(state.rules);
  });

  it('the compile clamps to the bounds and writes only a non-neutral result', () => {
    const at = (share: number, scale: number) => configured(share, scale, () => compileParkRules());
    expect(at(0.9, 50)).toMatchObject({ themeAffinity: 0.5, researchCostScale: 20 });
    const low = at(-1, 0.5);
    expect(KEYS.filter((key) => key in low)).toEqual([]);
    const notANumber = at(Number.NaN, Number.NaN);
    expect(KEYS.filter((key) => key in notANumber)).toEqual([]);
    expect(at(0.25, 2.5)).toMatchObject({ themeAffinity: 0.25, researchCostScale: 2.5 });
  });

  it('are neither card-modifiable nor scenario overrides', () => {
    for (const key of KEYS) expect((CARD_MODIFIABLE_RULES as readonly string[]).includes(key), key).toBe(false);
    const overrides = { themeAffinity: 0.4, researchCostScale: 5 } as unknown as Parameters<typeof compileParkRules>[0];
    const neutral = compileParkRules(overrides);
    expect(KEYS.filter((key) => key in neutral)).toEqual([]);
    const cards = [{ themeAffinity: 2, researchCostScale: 2 }] as unknown as Parameters<typeof compileParkRules>[1];
    expect(configured(0.3, 10, () => compileParkRules(overrides, cards))).toMatchObject({ themeAffinity: 0.3, researchCostScale: 10 });
  });

  it('restore refuses out-of-range values and drops an explicit neutral one', () => {
    const base = synced(new ParkSession(null));
    const withRules = (patch: Record<string, unknown>) => {
      const state = structuredClone(base);
      Object.assign(state.rules, patch);
      return state;
    };
    const refused = [
      { themeAffinity: 0.51 }, { themeAffinity: -0.1 }, { themeAffinity: Number.NaN }, { themeAffinity: '0.3' }, { themeAffinity: null },
      { researchCostScale: 0.5 }, { researchCostScale: 20.5 }, { researchCostScale: Number.POSITIVE_INFINITY }, { researchCostScale: '10' },
    ];
    for (const patch of refused) {
      let error: unknown = null;
      try {
        ParkSession.fromState(withRules(patch));
      } catch (caught) {
        error = caught;
      }
      expect(error, JSON.stringify(patch)).toBeInstanceOf(SaveError);
      expect((error as InstanceType<typeof SaveError>).code, JSON.stringify(patch)).toBe('invalid-state');
    }
    const accepted = ParkSession.fromState(withRules({ themeAffinity: 0.5, researchCostScale: 20 }));
    expect([accepted.rules.themeAffinity, accepted.rules.researchCostScale]).toEqual([0.5, 20]);
    const explicitNeutral = ParkSession.fromState(withRules({ themeAffinity: 0, researchCostScale: 1 }));
    expect(KEYS.filter((key) => key in explicitNeutral.rules)).toEqual([]);
  });
});
