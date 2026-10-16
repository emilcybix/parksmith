import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { OPTIONAL_RULE_KEYS } from '../scenarios/rules';
import { ParkSession } from '../session/ParkSession';
import { hashState } from './hash';
import { SaveError } from './version';

/**
 * Phase 25: the seven card-modifiable rule keys are optional in a saved ruleset. Absent = 1, an explicit 1 normalises
 * away (the same park, the same hash), anything outside 0.01..100 is refused. Every frozen fixture's own replay test
 * (v1..v11) already proves the m = 1 path is bit-identical; this file proves the save round trip of the keys.
 */
const fixtures = import.meta.glob<Record<string, unknown>>('./fixtures/park-v11-scenario-cards.json', { import: 'default', eager: true });
const fixture = (): Record<string, any> => structuredClone(fixtures['./fixtures/park-v11-scenario-cards.json']) as Record<string, any>;
/** The pinned AFTER_600 of the scenario-cards fixture (v11Fixtures.test.ts, captured on the schema-11 code). */
const AFTER_600 = '89a59f74e5337ae7';

describe('Phase 25 rule keys in a save', () => {
  it('absent reads as 1 in memory and stays absent in the save', () => {
    const state = fixture().state;
    for (const key of OPTIONAL_RULE_KEYS) expect(key in state.rules, key).toBe(false);
    const session = ParkSession.fromState(state);
    for (const key of OPTIONAL_RULE_KEYS) expect(session.rules[key], key).toBe(1);
    expect(hashState(session.serialize())).toBe(fixture().stateHash);
  });

  it('an explicit 1 on every key normalises away: same serialisation, same hash, and the pinned AFTER_600', () => {
    const state = fixture().state;
    for (const key of OPTIONAL_RULE_KEYS) state.rules[key] = 1;
    const session = ParkSession.fromState(state);
    expect(hashState(session.serialize())).toBe(fixture().stateHash);
    for (const key of OPTIONAL_RULE_KEYS) expect(key in session.serialize().rules, key).toBe(false);
    for (let tick = 0; tick < 600; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(hashState(session.serialize())).toBe(AFTER_600);
  });

  it('a value other than 1 round-trips; 0, negatives, non-numbers and values above 100 are refused', () => {
    for (const key of OPTIONAL_RULE_KEYS) {
      if (key === 'dayLengthMultiplier') continue; // its calendar law is covered in phase25Rules.test.ts
      const state = fixture().state;
      state.rules[key] = 0.8;
      if (key === 'sceneryAppealMultiplier') {
        // The appeal is inside every scenery signature: a ruleset edited under a park with scenery is refused.
        expect(() => ParkSession.fromState(state), key).toThrow(/scenery content changed/);
        continue;
      }
      const session = ParkSession.fromState(state);
      expect(session.rules[key], key).toBe(0.8);
      expect(session.serialize().rules[key], key).toBe(0.8);
      for (const bad of [0, -1, 0.001, 101, Number.NaN, '1', null]) {
        const hostile = fixture().state;
        hostile.rules[key] = bad;
        expect(() => ParkSession.fromState(hostile), `${key} = ${String(bad)}`).toThrow(SaveError);
      }
    }
  });
});
