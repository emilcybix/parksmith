import { describe, expect, it } from 'vitest';
import { COLOUR_SWATCHES } from '../content/colours';
import { ParkSession } from '../session/ParkSession';
import { seedColourTestPark } from '../session/colourTestPark';
import { hashState } from './hash';
import { MAXIMUM_COLOUR_SLOTS, MAXIMUM_COLOUR_SWATCHES } from './ranges';
import type { ParkSaveV7 } from './state';
import { SaveError, createParkSave } from './version';
import { sessionFromSave } from '../session/fromSave';

/**
 * Hostile colour records in a schema-7 envelope that carries a valid hash (so the integrity check
 * cannot save us). The policy under test: colours are NORMALISED, never refused, except values the
 * plain-data rule already refuses for every field (NaN, Infinity, -0, undefined), which are `corrupt`.
 */

const base = (): ParkSession => {
  const session = new ParkSession(null);
  seedColourTestPark(session);
  session.syncWithWorld();
  return session;
};

const target = (session: ParkSession, definitionId: string): number => (
  [...session.world.objects.values()].find((object) => object.definitionId === definitionId)!.id
);

/** A re-hashed envelope in which object `id` carries `colours` verbatim (in memory: no JSON, so NaN survives). */
const envelopeWith = (definitionId: string, colours: unknown): { save: ReturnType<typeof createParkSave>; id: number } => {
  const session = base();
  const id = target(session, definitionId);
  const state = session.serialize() as ParkSaveV7;
  (state.world.objects.find((object) => object.id === id) as { colours?: unknown }).colours = colours;
  return { save: createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0), id };
};

const loadColours = (definitionId: string, colours: unknown): readonly (number | null)[] | null => {
  const { save, id } = envelopeWith(definitionId, colours);
  return sessionFromSave(JSON.parse(JSON.stringify(save))).session.world.objectColours(id);
};

describe('hostile colour records load and normalise (they never fail a save)', () => {
  it('valid records survive, and the ranges module documents the bounds', () => {
    expect(loadColours('comet-cups', [19, null])).toEqual([19, null]);
    expect(loadColours('aurora-wheel', [0, 20, 13])).toEqual([0, 20, 13]);
    expect(MAXIMUM_COLOUR_SWATCHES).toBe(COLOUR_SWATCHES.length);
    expect(MAXIMUM_COLOUR_SLOTS).toBeGreaterThanOrEqual(3);
  });

  it('negative, unknown-swatch, fractional and huge indices fall back to the slot default', () => {
    expect(loadColours('comet-cups', [-1, 21])).toBeNull();
    expect(loadColours('comet-cups', [-1, 5])).toEqual([null, 5]);
    expect(loadColours('comet-cups', [21, 5])).toEqual([null, 5]);
    expect(loadColours('comet-cups', [1.5, 5])).toEqual([null, 5]);
    expect(loadColours('comet-cups', [1e300, 5])).toEqual([null, 5]);
    expect(loadColours('comet-cups', [2 ** 53, 2 ** 31])).toBeNull();
    expect(loadColours('comet-cups', [Number.MAX_SAFE_INTEGER, 5])).toEqual([null, 5]);
    expect(loadColours('comet-cups', [Number.MIN_SAFE_INTEGER, 5])).toEqual([null, 5]);
  });

  it('a wrong slot count is padded or truncated', () => {
    expect(loadColours('comet-cups', [3])).toEqual([3, null]);
    expect(loadColours('comet-cups', [3, 4, 5, 6, 7, 8, 9])).toEqual([3, 4]);
    expect(loadColours('aurora-wheel', [3, 4])).toEqual([3, 4, null]);
    expect(loadColours('comet-cups', [])).toBeNull();
    expect(loadColours('comet-cups', new Array<number>(50_000).fill(2))).toEqual([2, 2]);
  });

  it('wrong types fall back to the default; a non-array record is dropped', () => {
    expect(loadColours('comet-cups', ['3', true])).toBeNull();
    expect(loadColours('comet-cups', [{}, [3]])).toBeNull();
    expect(loadColours('comet-cups', [null, 7])).toEqual([null, 7]);
    for (const value of [null, 5, 'ab', true, {}, { 0: 1, 1: 2, length: 2 }]) {
      expect(loadColours('comet-cups', value), JSON.stringify(value)).toBeNull();
    }
  });

  it('a record on something that is not colourable is dropped, and the rest of the park still loads', () => {
    // Step 2: shops, coasters, scenery and comforts are colourable now; trees (and paths, unknown ids) are not.
    expect(loadColours('confetti-tree', [1, 2])).toBeNull();
    expect(loadColours('confetti-tree', [1])).toBeNull();
  });

  it('a normalised park serializes without the dropped record and reloads to a fixed point', () => {
    const { save } = envelopeWith('comet-cups', [-5, 7, 9]);
    const loaded = sessionFromSave(JSON.parse(JSON.stringify(save))).session;
    const state = loaded.serialize();
    const again = ParkSession.fromState(JSON.parse(JSON.stringify(state)) as typeof state).serialize();
    expect(hashState(again)).toBe(hashState(state));
    expect(state.world.objects.filter((object) => 'colours' in object).map((object) => object.colours)).toEqual([[null, 7]]);
  });

  it('a record in a park with ids the loader never colours does not change the simulation state', () => {
    const plain = base().serialize();
    const { save } = envelopeWith('confetti-tree', [3, 4]);
    const loaded = sessionFromSave(JSON.parse(JSON.stringify(save))).session.serialize();
    expect(hashState(loaded)).toBe(hashState(plain));
  });
});

describe('values the plain-data rule refuses never reach restore: the save is corrupt', () => {
  /** The hash cannot even be computed over these, so the record is swapped in after the envelope is stamped. */
  const loadPoisoned = (colours: unknown): SaveError => {
    const { save } = envelopeWith('comet-cups', [1, 1]);
    const object = (save.state as ParkSaveV7).world.objects.find((entry) => 'colours' in entry) as { colours?: unknown };
    object.colours = colours;
    try {
      sessionFromSave(save);
    } catch (error) {
      return error as SaveError;
    }
    throw new Error('the poisoned save loaded');
  };

  it('NaN, Infinity, -Infinity, -0 and undefined inside a record', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, undefined]) {
      const error = loadPoisoned([bad, 1]);
      expect(error, String(bad)).toBeInstanceOf(SaveError);
      expect(error.code, String(bad)).toBe('corrupt');
    }
  });

  it('a class instance as a record', () => {
    expect(loadPoisoned(new Map()).code).toBe('corrupt');
  });
});

/** Step 2: coasters, stalls, comforts, scenery and the gate. */
describe('hostile records on the step-2 kinds load and normalise', () => {
  it('coasters: padded to four slots, truncated, invalid entries default, a non-array is dropped', () => {
    expect(loadColours('star-chaser', [19, null, 4, 12])).toEqual([19, null, 4, 12]);
    expect(loadColours('star-chaser', [19, 4])).toEqual([19, 4, null, null]);
    expect(loadColours('comet-trail', [null, null, null, 4, 9, 9, 9])).toEqual([null, null, null, 4]);
    expect(loadColours('star-chaser', [-1, 21, 1.5, '3'])).toBeNull();
    expect(loadColours('star-chaser', [1e300, null, null, 2])).toEqual([null, null, null, 2]);
    expect(loadColours('star-chaser', new Array<number>(50_000).fill(2))).toEqual([2, 2, 2, 2]);
    for (const value of [null, 5, 'abcd', true, {}, { 0: 1, 1: 2, 2: 3, 3: 4, length: 4 }]) expect(loadColours('star-chaser', value), JSON.stringify(value)).toBeNull();
  });

  it('stalls, facilities, benches, bins, lamps, flowers and the fountain use their own slot counts', () => {
    expect(loadColours('picnic-pocket', [19, 6])).toEqual([19, 6]);
    expect(loadColours('picnic-pocket', [19])).toEqual([19, null]);
    expect(loadColours('picnic-pocket', [1, 2, 3, 4])).toEqual([1, 2]);
    expect(loadColours('comfort-pavilion', [null, 20])).toEqual([null, 20]);
    expect(loadColours('ribbon-bench', [0, 21])).toEqual([0, null]);
    expect(loadColours('tidy-totem', [3.5, 3])).toEqual([null, 3]);
    expect(loadColours('lollipop-lamp', [{}, 5])).toEqual([null, 5]);
    expect(loadColours('sunburst-flowers', [7, 8, 9])).toEqual([7, 8]);
    expect(loadColours('ripple-fountain', [7, 8])).toEqual([7]);
    expect(loadColours('ripple-fountain', [null, 8])).toBeNull();
    expect(loadColours('picnic-pocket', [-1, 99])).toBeNull();
  });

  it('a record on a tree is dropped, a hostile record on a tree too', () => {
    expect(loadColours('confetti-tree', [1, 2])).toBeNull();
    expect(loadColours('confetti-tree', [Number.MAX_SAFE_INTEGER, {}])).toBeNull();
  });

  it('a step-2 record leaves the simulation state exactly as it was (only the colour record differs)', () => {
    const plain = base().serialize();
    for (const id of ['star-chaser', 'picnic-pocket', 'ripple-fountain'] as const) {
      const { save } = envelopeWith(id, [3, 4, 5, 6]);
      const loaded = sessionFromSave(JSON.parse(JSON.stringify(save))).session.serialize();
      const strip = (state: ParkSaveV7): unknown => {
        const copy = JSON.parse(JSON.stringify(state)) as ParkSaveV7;
        for (const object of copy.world.objects) delete (object as { colours?: unknown }).colours;
        return copy;
      };
      expect(hashState(strip(loaded) as ParkSaveV7), id).toBe(hashState(strip(plain) as ParkSaveV7));
    }
  });
});

describe('hostile gate records', () => {
  const gateEnvelope = (gateColours: unknown): ReturnType<typeof createParkSave> => {
    const state = base().serialize() as ParkSaveV7;
    (state.world as { gateColours?: unknown }).gateColours = gateColours;
    return createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
  };
  const loadGate = (gateColours: unknown): readonly (number | null)[] | null => (
    sessionFromSave(JSON.parse(JSON.stringify(gateEnvelope(gateColours)))).session.world.gateColours
  );

  it('a valid record survives', () => {
    expect(loadGate([19, null, 13])).toEqual([19, null, 13]);
    expect(MAXIMUM_COLOUR_SLOTS).toBeGreaterThanOrEqual(3);
  });

  it('wrong lengths are padded or truncated, bad entries default, junk is dropped', () => {
    expect(loadGate([5])).toEqual([5, null, null]);
    expect(loadGate([5, 6, 7, 8, 9])).toEqual([5, 6, 7]);
    expect(loadGate(new Array<number>(50_000).fill(2))).toEqual([2, 2, 2]);
    expect(loadGate([-1, 21, 1.5])).toBeNull();
    expect(loadGate([1e300, '2', {}])).toBeNull();
    expect(loadGate([null, null, null])).toBeNull();
    expect(loadGate([])).toBeNull();
    for (const value of [null, 5, 'abc', true, {}, { 0: 1, 1: 2, 2: 3, length: 3 }]) expect(loadGate(value), JSON.stringify(value)).toBeNull();
  });

  it('a normalised gate serializes without the dropped record and reloads to a fixed point', () => {
    const loaded = sessionFromSave(JSON.parse(JSON.stringify(gateEnvelope([-5, 7, 9])))).session;
    const state = loaded.serialize();
    expect(state.world.gateColours).toEqual([null, 7, 9]);
    const again = ParkSession.fromState(JSON.parse(JSON.stringify(state)) as typeof state).serialize();
    expect(hashState(again)).toBe(hashState(state));
    const junk = sessionFromSave(JSON.parse(JSON.stringify(gateEnvelope('abc')))).session.serialize();
    expect(junk.world).not.toHaveProperty('gateColours');
  });

  it('NaN, Infinity, -0 and undefined inside a gate record are corrupt, like every other plain-data violation', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, undefined]) {
      const save = gateEnvelope([1, 1, 1]);
      ((save.state as ParkSaveV7).world as { gateColours?: unknown[] }).gateColours = [bad, 1, 1];
      let error: unknown;
      try { sessionFromSave(save); } catch (caught) { error = caught; }
      expect(error, String(bad)).toBeInstanceOf(SaveError);
      expect((error as SaveError).code, String(bad)).toBe('corrupt');
    }
  });

  it('a gate record on a v6 envelope is dropped by the migration, whatever it holds', () => {
    const v6 = JSON.parse(JSON.stringify(gateEnvelope([1, 2, 3]))) as { schemaVersion: number; stateHash: string; state: { rules: Record<string, unknown> } };
    v6.schemaVersion = 6;
    delete v6.state.rules.recolourCostMultiplier;
    v6.stateHash = hashState(v6.state as never);
    expect(sessionFromSave(v6).session.world.gateColours).toBeNull();
  });
});

describe('the recolour cost rule in a hostile save', () => {
  const withRule = (value: unknown): ReturnType<typeof createParkSave> => {
    const state = base().serialize() as ParkSaveV7;
    if (value === undefined) delete (state.rules as unknown as Record<string, unknown>).recolourCostMultiplier;
    else (state.rules as unknown as Record<string, unknown>).recolourCostMultiplier = value;
    return createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
  };
  const load = (value: unknown): SaveError | ParkSession => {
    try {
      return sessionFromSave(JSON.parse(JSON.stringify(withRule(value)))).session;
    } catch (error) {
      return error as SaveError;
    }
  };

  it('values inside the range of every other multiplier load as saved', () => {
    for (const value of [0.01, 0.25, 1, 2.5, 4, 100]) {
      const result = load(value);
      expect(result, String(value)).toBeInstanceOf(ParkSession);
      expect((result as ParkSession).rules.recolourCostMultiplier).toBe(value);
    }
  });

  it('zero, negative, huge, non-numbers and a missing key are invalid-state', () => {
    for (const value of [0, -1, 100.5, 1e9, '1', null, true, {}, [], undefined]) {
      const result = load(value);
      expect(result, JSON.stringify(value)).toBeInstanceOf(SaveError);
      expect((result as SaveError).code, JSON.stringify(value)).toBe('invalid-state');
    }
  });

  it('NaN and Infinity are corrupt (the plain-data rule), never a free recolour', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const save = withRule(1);
      (((save.state as ParkSaveV7).rules) as unknown as Record<string, unknown>).recolourCostMultiplier = value;
      let error: unknown;
      try { sessionFromSave(save); } catch (caught) { error = caught; }
      expect((error as SaveError).code, String(value)).toBe('corrupt');
    }
  });
});
