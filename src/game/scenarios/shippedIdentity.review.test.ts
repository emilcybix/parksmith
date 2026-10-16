import { describe, expect, it } from 'vitest';
import { hashState } from '../save/hash';
import { FOUNDING_SCENARIO_IDS, SCENARIO_BY_ID } from './content';

/**
 * Phase 22: the four shipped scenarios keep their rules, maps, objectives and setup byte for byte. These pins are
 * hashState({ id, seed, mapId, timeLimitSeconds, timeLimitDays, objective, constraint, rules, setup, cardSlots,
 * cardDraftChoices }) taken from the schema-9 code BEFORE the data was widened with difficulty, unlockedBy and rewards.
 * A moved value means a shipped scenario changed: the fix is in the content, not here.
 */
const PINS: Record<string, string> = {
  'sunny-start': '34702d6ac7c821e6',
  'penny-lane': 'ed7e14b5b635fe79',
  'garden-gala': '94e9542532f8ff4b',
  'starlight-finale': '0df4dd9d97a81047',
};

describe('the four shipped scenarios are unchanged', () => {
  it.each(FOUNDING_SCENARIO_IDS)('%s: rules, map, objective, deadline, setup and card slots', (id) => {
    const d = SCENARIO_BY_ID.get(id)!;
    const identity = hashState({
      id: d.id, seed: d.seed, mapId: d.mapId ?? null, timeLimitSeconds: d.timeLimitSeconds, timeLimitDays: d.timeLimitDays ?? null,
      objective: d.objective, constraint: d.constraint, rules: d.rules, setup: d.setup, cardSlots: d.cardSlots, cardDraftChoices: d.rewards.cardDraftChoices,
    });
    expect(identity).toBe(PINS[id]);
    expect(d.mapId, 'the four stay on the Meadow Garden').toBeUndefined();
  });

  it('only gained data: a difficulty, an unlock condition and bonus rewards (no building unlocks)', () => {
    expect([...FOUNDING_SCENARIO_IDS].map((id) => [id, SCENARIO_BY_ID.get(id)!.difficulty, SCENARIO_BY_ID.get(id)!.rewards.bonuses])).toEqual([
      ['sunny-start', 1, ['nest-egg']],
      ['penny-lane', 2, ['research-grant']],
      ['garden-gala', 2, ['builders-discount']],
      ['starlight-finale', 3, ['spare-slot']],
    ]);
    for (const id of FOUNDING_SCENARIO_IDS) expect(SCENARIO_BY_ID.get(id)!.rewards.unlocks, id).toEqual([]);
  });
});
