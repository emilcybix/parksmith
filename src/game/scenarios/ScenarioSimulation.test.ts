import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ScenarioSimulation } from './ScenarioSimulation';
import { compileParkRules, RULE_CLAMPS } from './rules';
import { SCENARIOS, SCENARIO_BY_ID } from './content';
import { TOUR_NODES } from '../tour/content';
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

const scenario = (
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

describe('park rules compilation', () => {
  it('merges scenario overrides over base rules and clamps them without touching config', () => {
    const rules = compileParkRules({
      startingCash: -500,
      arrivalIntervalMultiplier: 99,
      lockedDefinitionIds: ['tidy-totem', 'tidy-totem', 'sunstone-path', 'not-a-real-building'],
    });
    expect(rules.startingCash).toBe(RULE_CLAMPS.minimumStartingCash);
    expect(rules.arrivalIntervalMultiplier).toBe(RULE_CLAMPS.maximumMultiplier);
    expect(rules.lockedDefinitionIds).toEqual(['tidy-totem']);
    expect(compileParkRules().startingCash).toBe(GAME_CONFIG.startingCash);
    expect(compileParkRules({}).arrivalIntervalMultiplier).toBe(1);
  });
});

describe('ScenarioSimulation objectives', () => {
  it('latches an earn objective the moment the cumulative metric reaches the target', () => {
    const simulation = new ScenarioSimulation(scenario({
      id: 'crowd', name: 'Crowd', kind: 'earn', metric: 'cumulativeGuests', target: 10,
    }));
    simulation.step(1_000, metrics({ cumulativeGuests: 9 }));
    expect(simulation.currentStatus).toBe('running');
    expect(simulation.drainEvents()).toEqual([]);

    simulation.step(1_000, metrics({ cumulativeGuests: 10 }));
    expect(simulation.currentStatus).toBe('succeeded');
    const events = simulation.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('scenarioSucceeded');
    expect(events[0].atSeconds).toBe(2);
    expect(events[0].evidence.length).toBeGreaterThan(0);

    // Latched: later drops and further time change nothing and emit nothing.
    simulation.step(1_000, metrics({ cumulativeGuests: 0 }));
    expect(simulation.currentStatus).toBe('succeeded');
    expect(simulation.drainEvents()).toEqual([]);
    expect(simulation.snapshot().completedAtSeconds).toBe(2);
  });

  it('fails exactly at the deadline with the shortfall as evidence, and success on the deadline tick wins', () => {
    const failing = new ScenarioSimulation(scenario(
      { id: 'profit', name: 'Profit', kind: 'earn', metric: 'operatingProfit', target: 500 },
      { timeLimitSeconds: 2 },
    ));
    failing.step(1_900, metrics({ operatingProfit: 120 }));
    expect(failing.currentStatus).toBe('running');
    failing.step(100, metrics({ operatingProfit: 120 }));
    expect(failing.currentStatus).toBe('failed');
    const failure = failing.drainEvents();
    expect(failure[0].kind).toBe('scenarioFailed');
    expect(failing.snapshot().resultEvidence).toContain('120');
    expect(failing.snapshot().resultEvidence).toContain('500');

    const photoFinish = new ScenarioSimulation(scenario(
      { id: 'profit', name: 'Profit', kind: 'earn', metric: 'operatingProfit', target: 500 },
      { timeLimitSeconds: 2 },
    ));
    photoFinish.step(1_900, metrics({ operatingProfit: 499 }));
    photoFinish.step(100, metrics({ operatingProfit: 500 }));
    expect(photoFinish.currentStatus).toBe('succeeded');
  });

  it('requires a sustain objective to hold continuously and resets the streak on a dip', () => {
    const simulation = new ScenarioSimulation(scenario(
      {
        id: 'rating', name: 'Rating', kind: 'sustain', metric: 'parkRating',
        comparison: 'atLeast', target: 65, durationSeconds: 3,
      },
      { timeLimitSeconds: 60 },
    ));
    simulation.step(2_000, metrics({ parkRating: 70 }));
    expect(simulation.snapshot().objective.sustainedSeconds).toBe(2);
    simulation.step(100, metrics({ parkRating: 60 }));
    expect(simulation.snapshot().objective.sustainedSeconds).toBe(0);
    expect(simulation.snapshot().objective.longestSustainedSeconds).toBe(2);

    simulation.step(2_900, metrics({ parkRating: 70 }));
    expect(simulation.currentStatus).toBe('running');
    simulation.step(100, metrics({ parkRating: 70 }));
    expect(simulation.currentStatus).toBe('succeeded');
    expect(simulation.drainEvents()[0].kind).toBe('scenarioSucceeded');
  });

  it('supports at-most sustain objectives such as keeping queues short', () => {
    const simulation = new ScenarioSimulation(scenario(
      {
        id: 'queues', name: 'Queues', kind: 'sustain', metric: 'averageQueueSeconds',
        comparison: 'atMost', target: 30, durationSeconds: 2,
      },
      { timeLimitSeconds: 10 },
    ));
    simulation.step(1_000, metrics({ averageQueueSeconds: 25 }));
    simulation.step(1_000, metrics({ averageQueueSeconds: 45 }));
    expect(simulation.snapshot().objective.sustainedSeconds).toBe(0);
    simulation.step(1_000, metrics({ averageQueueSeconds: 10 }));
    simulation.step(1_000, metrics({ averageQueueSeconds: 30 }));
    expect(simulation.currentStatus).toBe('succeeded');
  });

  it('treats a null metric as unmet instead of crashing or counting streaks', () => {
    const simulation = new ScenarioSimulation(scenario(
      {
        id: 'happy', name: 'Happy', kind: 'sustain', metric: 'averageHappiness',
        comparison: 'atLeast', target: 60, durationSeconds: 2,
      },
      { timeLimitSeconds: 3 },
    ));
    simulation.step(1_000, metrics({ averageHappiness: null }));
    expect(simulation.snapshot().objective.current).toBeNull();
    expect(simulation.snapshot().objective.sustainedSeconds).toBe(0);
    simulation.step(2_000, metrics({ averageHappiness: null }));
    expect(simulation.currentStatus).toBe('failed');
  });

  it('reports exact progress, linear pace projection, and on-pace state while running', () => {
    const simulation = new ScenarioSimulation(scenario(
      { id: 'crowd', name: 'Crowd', kind: 'earn', metric: 'cumulativeGuests', target: 100 },
      { timeLimitSeconds: 100 },
    ));
    simulation.step(20_000, metrics({ cumulativeGuests: 30 }));
    let objective = simulation.snapshot().objective;
    expect(objective.current).toBe(30);
    expect(objective.progressPercent).toBe(30);
    expect(objective.projectedValue).toBe(150);
    expect(objective.onPace).toBe(true);

    simulation.step(40_000, metrics({ cumulativeGuests: 40 }));
    objective = simulation.snapshot().objective;
    expect(objective.projectedValue).toBeCloseTo(40 / 60 * 100, 1);
    expect(objective.onPace).toBe(false);

    const snapshot = simulation.snapshot();
    expect(snapshot.remainingSeconds).toBe(40);
    expect(snapshot.status).toBe('running');
    expect(snapshot.resultEvidence).toBeNull();
  });

  it('reports sustain pace from the remaining window and the current streak', () => {
    const simulation = new ScenarioSimulation(scenario(
      {
        id: 'rating', name: 'Rating', kind: 'sustain', metric: 'parkRating',
        comparison: 'atLeast', target: 65, durationSeconds: 30,
      },
      { timeLimitSeconds: 40 },
    ));
    simulation.step(5_000, metrics({ parkRating: 70 }));
    expect(simulation.snapshot().objective.onPace).toBe(true);

    // 15s in with a broken streak: 25s remain but 30s are needed — impossible now.
    simulation.step(10_000, metrics({ parkRating: 50 }));
    const objective = simulation.snapshot().objective;
    expect(objective.sustainedSeconds).toBe(0);
    expect(objective.onPace).toBe(false);
  });
});

/**
 * Sandbox starting cash is a balance constant that moves (BALANCE_NOTES.md BN-001). Every scenario
 * has its own economy tuned to its own objective, so a scenario that forgot to state its starting
 * cash would silently inherit whatever the sandbox happens to be worth that week — and a balance
 * pass on Sandbox would quietly re-tune the whole Park Tour.
 */
describe('scenario economies are self-contained', () => {
  it('states its own starting cash rather than inheriting the sandbox constant', () => {
    const inheriting = SCENARIOS
      .filter((definition) => definition.rules?.startingCash === undefined)
      .map((definition) => definition.id);
    expect(inheriting, 'these scenarios would inherit sandbox starting cash').toEqual([]);
  });

  it('gives every tour node a scenario that exists', () => {
    const missing = TOUR_NODES
      .filter((node) => !SCENARIO_BY_ID.has(node.scenarioId))
      .map((node) => node.id);
    expect(missing).toEqual([]);
  });

  it('compiles each scenario to its own declared starting cash', () => {
    for (const definition of SCENARIOS) {
      expect(compileParkRules(definition.rules).startingCash, definition.id)
        .toBe(definition.rules?.startingCash);
    }
  });
});
