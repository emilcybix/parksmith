import { describe, expect, it } from 'vitest';
import { hashState } from '../save/hash';
import { assertPlainData, assertStructuredCloneSafe, auditOwnProperties } from '../save/plainData';
import type { ScenarioState } from '../save/state';
import { SaveError } from '../save/version';
import { SCENARIO_BY_ID } from './content';
import { ScenarioSimulation } from './ScenarioSimulation';
import type { ObjectiveDefinition, ScenarioDefinition, ScenarioMetrics } from './types';

const metrics = (overrides: Partial<ScenarioMetrics> = {}): ScenarioMetrics => ({
  cumulativeGuests: 0,
  guestCount: 0,
  parkRating: 0,
  averageHappiness: null,
  operatingProfit: 0,
  averageQueueSeconds: 0,
  ...overrides,
});

const definitionWith = (
  objective: ObjectiveDefinition,
  overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition => ({
  id: 'sunny-start',
  name: 'Test Park',
  tagline: '',
  description: '',
  seed: 7,
  timeLimitSeconds: 60,
  objective,
  constraint: null,
  rules: {},
  setup: { paths: [], objects: [] },
  cardSlots: 2,
  difficulty: 1,
  unlockedBy: { kind: 'always' },
  rewards: { cardDraftChoices: 3, unlocks: [], bonuses: [] },
  ...overrides,
});

const sustain: ObjectiveDefinition = {
  id: 'rating', name: 'Rating', kind: 'sustain', metric: 'parkRating',
  comparison: 'atLeast', target: 65, durationSeconds: 5,
};

const create = (overrides: Partial<ScenarioDefinition> = {}) => new ScenarioSimulation(definitionWith(sustain, overrides));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Mid streak: 3 s of a required 5 s, with a longer earlier streak. */
const midStreak = (): ScenarioSimulation => {
  const simulation = create();
  simulation.step(4_000, metrics({ parkRating: 70, averageHappiness: 55.5 }));
  simulation.step(1_000, metrics({ parkRating: 10 }));
  simulation.step(3_000, metrics({ parkRating: 70, averageHappiness: 61.25, operatingProfit: -0.0001 }));
  return simulation;
};

describe('ScenarioSimulation serialize', () => {
  it('is plain, structured-clone safe and JSON byte identical', () => {
    const state = midStreak().serialize();
    assertPlainData(state);
    assertStructuredCloneSafe(state);
    expect(JSON.stringify(clone(state))).toBe(JSON.stringify(state));
    expect(state.status).toBe('running');
    expect(state.sustainedSeconds).toBe(3);
    expect(state.longestSustainedSeconds).toBe(4);
  });

  it('keeps a null averageHappiness as null and never writes -0', () => {
    const simulation = create();
    simulation.step(1_000, metrics({ operatingProfit: -0, parkRating: -0 }));
    const state = simulation.serialize();
    expect(state.latestMetrics.averageHappiness).toBeNull();
    assertPlainData(state);
    expect(Object.is(state.latestMetrics.operatingProfit, 0), 'no negative zero').toBe(true);
  });

  it('is read only and does not drain events', () => {
    const simulation = create({ timeLimitSeconds: 2 });
    simulation.step(2_000, metrics());
    const first = simulation.serialize();
    expect(simulation.serialize()).toEqual(first);
    expect(simulation.drainEvents(), 'event still pending').toHaveLength(1);
  });

  it('round trips mid streak and continues exactly like a never-saved run', () => {
    const source = midStreak();
    const state = source.serialize();
    const target = create();
    target.restore(clone(state));
    expect(hashState(target.serialize())).toBe(hashState(state));
    for (const simulation of [source, target]) {
      simulation.step(1_000, metrics({ parkRating: 70 }));
      simulation.step(1_000, metrics({ parkRating: 70 }));
    }
    expect(source.currentStatus).toBe('succeeded');
    expect(target.serialize()).toEqual(source.serialize());
    expect(target.drainEvents()).toEqual(source.drainEvents());
  });

  it('restores into a dirty instance exactly as into a fresh one', () => {
    const state = midStreak().serialize();
    const dirty = create({ timeLimitSeconds: 3 });
    dirty.step(5_000, metrics({ parkRating: 99 }));
    expect(dirty.currentStatus, 'dirty one is latched').not.toBe('running');
    dirty.restore(state);
    const fresh = create();
    fresh.restore(state);
    expect(dirty.serialize()).toEqual(fresh.serialize());
    expect(dirty.currentStatus).toBe('running');
    expect(dirty.drainEvents(), 'leftover events from the dirty life are gone').toEqual([]);
  });

  for (const outcome of ['succeeded', 'failed'] as const) {
    it(`never re-emits a result event after a latched ${outcome}`, () => {
      const source = create({ timeLimitSeconds: outcome === 'failed' ? 3 : 60 });
      for (let index = 0; index < 8; index += 1) {
        source.step(1_000, metrics({ parkRating: outcome === 'succeeded' ? 80 : 10 }));
      }
      expect(source.currentStatus).toBe(outcome);
      const state = source.serialize();
      expect(state.pendingEvents, 'undrained latch event is carried').toHaveLength(1);

      const target = create({ timeLimitSeconds: outcome === 'failed' ? 3 : 60 });
      target.restore(clone(state));
      expect(target.drainEvents()).toEqual(source.drainEvents());
      for (let index = 0; index < 20; index += 1) target.step(1_000, metrics({ parkRating: outcome === 'succeeded' ? 0 : 99 }));
      expect(target.drainEvents(), 'no second event over further steps').toEqual([]);
      expect(target.currentStatus).toBe(outcome);
      expect(target.snapshot().completedAtSeconds).toBe(state.completedAtSeconds);
      expect(target.snapshot().resultEvidence).toBe(state.resultEvidence);
    });
  }

  it('restores a drained latch with no pending events and no re-emission', () => {
    const source = create({ timeLimitSeconds: 2 });
    source.step(2_000, metrics());
    source.drainEvents();
    const target = create({ timeLimitSeconds: 2 });
    target.restore(source.serialize());
    target.step(1_000, metrics({ parkRating: 90 }));
    expect(target.drainEvents()).toEqual([]);
    expect(target.currentStatus).toBe('failed');
  });
});

describe('ScenarioSimulation restore validation', () => {
  const rejects = (mutate: (state: ScenarioState) => void, code: string) => {
    const target = midStreak();
    const before = target.serialize();
    const state = clone(before);
    mutate(state);
    let thrown: unknown;
    try {
      target.restore(state);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'restore throws').toBeInstanceOf(SaveError);
    expect((thrown as SaveError).code).toBe(code);
    expect(target.serialize(), 'unchanged after refusal').toEqual(before);
  };

  it('throws content-mismatch for the wrong scenario id', () => {
    rejects((state) => { state.scenarioId = 'penny-lane'; }, 'content-mismatch');
    const real = SCENARIO_BY_ID.get('penny-lane');
    if (!real) throw new Error('penny-lane exists');
    expect(() => new ScenarioSimulation(real).restore(midStreak().serialize())).toThrow(SaveError);
  });

  it('rejects bad status, numbers, latch consistency and events', () => {
    rejects((state) => { state.status = 'paused' as never; }, 'invalid-state');
    rejects((state) => { state.elapsedSeconds = Number.NaN; }, 'invalid-state');
    rejects((state) => { state.sustainedSeconds = -1; }, 'invalid-state');
    rejects((state) => { state.elapsedSeconds = 1e300; }, 'invalid-state');
    rejects((state) => { state.sustainedSeconds = state.elapsedSeconds + 50; }, 'invalid-state');
    rejects((state) => { state.longestSustainedSeconds = state.elapsedSeconds + 50; }, 'invalid-state');
    rejects((state) => { state.longestSustainedSeconds = state.sustainedSeconds - 5; state.sustainedSeconds += 5; }, 'invalid-state');
    rejects((state) => { state.latestMetrics.operatingProfit = 1e300; }, 'invalid-state');
    rejects((state) => { state.completedAtSeconds = 4; }, 'invalid-state');
    rejects((state) => { state.status = 'failed'; }, 'invalid-state');
    rejects((state) => { state.resultEvidence = 5 as never; }, 'invalid-state');
    rejects((state) => { state.latestMetrics.parkRating = Number.POSITIVE_INFINITY; }, 'invalid-state');
    rejects((state) => { (state.latestMetrics as unknown as Record<string, unknown>).averageHappiness = 'x'; }, 'invalid-state');
    rejects((state) => { state.pendingEvents = [{ kind: 'nope' as never, scenarioId: 'sunny-start', atSeconds: 1, evidence: '' }]; }, 'invalid-state');
    rejects((state) => { state.pendingEvents = [{ kind: 'scenarioFailed', scenarioId: 'penny-lane', atSeconds: 1, evidence: '' }]; }, 'content-mismatch');
  });
});

describe('ScenarioSimulation field coverage', () => {
  /**
   * HOW TO FIX A FAILURE HERE: you added a field to ScenarioSimulation. If it influences the
   * future, add it to ScenarioState, serialize(), restore() and the `mutators` table; if it is
   * derived or configuration, list it below with the reason.
   */
  const accounting = {
    serialized: [
      'status', 'elapsedSeconds', 'sustainedSeconds', 'longestSustainedSeconds', 'completedAtSeconds',
      'resultEvidence', 'latestMetrics', 'pendingEvents',
    ],
    derived: [] as string[],
    // definition is resolved by id (scenarioId is validated); lockedDefinitionIds is compiled from it.
    config: ['definition', 'lockedDefinitionIds'],
    transient: [] as string[],
  };
  type Internals = {
    status: string;
    elapsedSeconds: number;
    sustainedSeconds: number;
    longestSustainedSeconds: number;
    completedAtSeconds: number | null;
    resultEvidence: string | null;
    latestMetrics: ScenarioMetrics;
    pendingEvents: unknown[];
  };
  const mutators: Record<string, (target: Internals) => void> = {
    status: (target) => { target.status = 'failed'; },
    elapsedSeconds: (target) => { target.elapsedSeconds += 1; },
    sustainedSeconds: (target) => { target.sustainedSeconds += 1; },
    longestSustainedSeconds: (target) => { target.longestSustainedSeconds += 1; },
    completedAtSeconds: (target) => { target.completedAtSeconds = 9; },
    resultEvidence: (target) => { target.resultEvidence = 'x'; },
    latestMetrics: (target) => { target.latestMetrics.guestCount += 1; },
    pendingEvents: (target) => { target.pendingEvents.push({ kind: 'scenarioFailed', scenarioId: 'sunny-start', atSeconds: 1, evidence: '' }); },
  };

  it('accounts for every own property of a live instance', () => {
    expect(auditOwnProperties(midStreak(), accounting)).toEqual([]);
  });

  it('proves each serialized field is read by serialize() by mutating it', () => {
    expect(Object.keys(mutators).sort()).toEqual([...accounting.serialized].sort());
    for (const name of accounting.serialized) {
      const target = midStreak();
      const before = hashState(target.serialize());
      const mutate = mutators[name];
      if (!mutate) throw new Error(`no mutator for ${name}`);
      mutate(target as unknown as Internals);
      expect(hashState(target.serialize()), `serialize() ignores ${name}`).not.toBe(before);
    }
  });
});
