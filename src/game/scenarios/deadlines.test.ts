import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { WEATHER_KINDS } from '../weather/types';
import { MAXIMUM_DEADLINE_DAYS, SCENARIOS, defineScenario, type ScenarioDefinitionInput } from './content';
import { BASE_PARK_RULES, CARD_MODIFIABLE_RULES, MULTIPLIER_DIRECTION, RULE_CLAMPS, compileParkRules } from './rules';
import { ScenarioSimulation } from './ScenarioSimulation';
import type { ScenarioMetrics } from './types';

const DAY = GAME_CONFIG.calendar.defaultDayLengthSeconds;

const input = (overrides: Record<string, unknown>): ScenarioDefinitionInput => ({
  id: 'sunny-start',
  name: 'Days',
  tagline: '',
  description: '',
  seed: 3,
  objective: { id: 'o', name: 'o', kind: 'earn', metric: 'cumulativeGuests', target: 50 },
  constraint: null,
  rules: {},
  setup: { paths: [], objects: [] },
  cardSlots: 2,
  difficulty: 1,
  unlockedBy: { kind: 'always' },
  rewards: { cardDraftChoices: 3, unlocks: [], bonuses: [] },
  ...overrides,
} as unknown as ScenarioDefinitionInput);

const metrics = (guests: number): ScenarioMetrics => ({
  cumulativeGuests: guests, guestCount: guests, parkRating: 50, averageHappiness: null, operatingProfit: 0, averageQueueSeconds: 0,
});

describe('scenario deadlines in days', () => {
  it('the four shipped scenarios keep their deadlines in seconds, untouched', () => {
    const shipped = SCENARIOS.slice(0, 4);
    expect(shipped.map((scenario) => [scenario.id, scenario.timeLimitSeconds])).toEqual([
      ['sunny-start', 900], ['penny-lane', 1_200], ['garden-gala', 1_500], ['starlight-finale', 1_800],
    ]);
    for (const scenario of shipped) {
      expect(scenario.timeLimitDays, scenario.id).toBeUndefined();
      expect(new ScenarioSimulation(scenario).snapshot()).toMatchObject({ timeLimitDays: null, timeLimitSeconds: scenario.timeLimitSeconds });
    }
  });

  it('defineScenario compiles days to seconds at the fixed scenario day length and keeps the days', () => {
    const definition = defineScenario(input({ timeLimitDays: 2 }));
    expect(definition.timeLimitSeconds).toBe(2 * DAY);
    expect(definition.timeLimitDays).toBe(2);
    expect(defineScenario(input({ timeLimitDays: 1.25 })).timeLimitSeconds).toBe(1.25 * DAY);
    expect(defineScenario(input({ timeLimitDays: MAXIMUM_DEADLINE_DAYS })).timeLimitSeconds).toBe(MAXIMUM_DEADLINE_DAYS * DAY);
    const seconds = defineScenario(input({ timeLimitSeconds: 700 }));
    expect(seconds.timeLimitSeconds).toBe(700);
    expect(seconds.timeLimitDays).toBeUndefined();
  });

  it('refuses bad authoring at load: both, neither, non-positive, too long, not a weather slot multiple', () => {
    expect(() => defineScenario(input({ timeLimitDays: 2, timeLimitSeconds: 100 }))).toThrow(/exactly one/);
    expect(() => defineScenario(input({}))).toThrow(/exactly one/);
    for (const days of [0, -1, Number.NaN, Infinity]) expect(() => defineScenario(input({ timeLimitDays: days })), String(days)).toThrow();
    expect(() => defineScenario(input({ timeLimitDays: MAXIMUM_DEADLINE_DAYS + 0.25 }))).toThrow(/exceed/);
    expect(() => defineScenario(input({ timeLimitDays: 1.1 }))).toThrow(/multiple/);
    expect(() => defineScenario(input({ timeLimitSeconds: 0 }))).toThrow();
    expect(() => defineScenario(input({ timeLimitSeconds: -5 }))).toThrow();
  });

  it('a two day scenario succeeds before the deadline and fails exactly at tick 14,400', () => {
    const definition = defineScenario(input({ timeLimitDays: 2 }));
    const winner = new ScenarioSimulation(definition);
    for (let tick = 0; tick < 5_000; tick += 1) winner.step(100, metrics(tick === 4_999 ? 50 : 10));
    expect(winner.currentStatus).toBe('succeeded');

    const loser = new ScenarioSimulation(definition);
    for (let tick = 0; tick < 14_399; tick += 1) loser.step(100, metrics(10));
    expect(loser.currentStatus, 'one tick before the deadline').toBe('running');
    loser.step(100, metrics(10));
    expect(loser.currentStatus).toBe('failed');
  });

  it('the snapshot carries days and the remaining time in days (one decimal)', () => {
    const definition = defineScenario(input({ timeLimitDays: 2 }));
    const simulation = new ScenarioSimulation(definition);
    expect(simulation.snapshot()).toMatchObject({ timeLimitDays: 2, remainingDays: 2, remainingSeconds: 1_440 });
    for (let tick = 0; tick < 6_000; tick += 1) simulation.step(100, metrics(10));
    expect(simulation.snapshot()).toMatchObject({ remainingSeconds: 840, remainingDays: 1.2 });
  });

  it('a one day scenario inside a park fails when the calendar rolls to day 2', () => {
    const park = new ParkSession(defineScenario(input({ timeLimitDays: 1, seed: 11 })));
    for (let tick = 0; tick < 7_200; tick += 1) park.step(100);
    expect(park.scenarioSnapshot()!.status).toBe('failed');
    expect(park.calendarView().day).toBe(2);
  });
});

describe('the wet weather rule', () => {
  const wetDays = (rules: ReturnType<typeof compileParkRules>, days = 400): number => {
    const session = new ParkSession(null, [], { rules });
    let wet = 0;
    for (let day = 0; day < days; day += 1) {
      session.weather.step(day * 7_200);
      const view = session.weather.days[session.weather.days.findIndex((_, index) => session.weather.firstDay + index === day + 1)];
      if (view && (view.kind === 'rain' || view.kind === 'storm')) wet += 1;
    }
    return wet;
  };

  it('is a card-modifiable multiplier where lower is better, base 1, clamped like the others', () => {
    expect(BASE_PARK_RULES.wetWeatherMultiplier).toBe(1);
    expect(CARD_MODIFIABLE_RULES).toContain('wetWeatherMultiplier');
    expect(MULTIPLIER_DIRECTION.wetWeatherMultiplier).toBe('lowerIsBetter');
    expect(compileParkRules().wetWeatherMultiplier).toBe(1);
    expect(compileParkRules({ wetWeatherMultiplier: 0.5 }).wetWeatherMultiplier).toBe(0.5);
    expect(compileParkRules({}, [{ wetWeatherMultiplier: 0.5 }, { wetWeatherMultiplier: 0.5 }]).wetWeatherMultiplier).toBe(RULE_CLAMPS.minimumMultiplier);
    expect(compileParkRules({}, [{ wetWeatherMultiplier: 100 }]).wetWeatherMultiplier).toBe(RULE_CLAMPS.maximumMultiplier);
    expect(compileParkRules({ wetWeatherMultiplier: Number.NaN }).wetWeatherMultiplier).toBe(1);
  });

  it('changes the wet share in the stated direction over 400 seeded days (cards and scenario overrides alike)', () => {
    const base = wetDays(compileParkRules());
    const drier = wetDays(compileParkRules({}, [{ wetWeatherMultiplier: 0.5 }]));
    const wetter = wetDays(compileParkRules({}, [{ wetWeatherMultiplier: 1.5 }]));
    const viaScenario = wetDays(compileParkRules({ wetWeatherMultiplier: 0.5 }));
    expect(drier).toBeLessThan(base);
    expect(wetter).toBeGreaterThan(base);
    expect(viaScenario).toBe(drier);
    expect(base).toBeGreaterThan(40);
  });

  it('is saved with the rules, restored, and drives only days drawn after the start', () => {
    const rules = compileParkRules({}, [{ wetWeatherMultiplier: 0.5 }]);
    const session = new ParkSession(null, [], { rules });
    expect(session.serialize().rules.wetWeatherMultiplier).toBe(0.5);
    const loaded = ParkSession.fromState(JSON.parse(JSON.stringify(session.serialize())) as ReturnType<ParkSession['serialize']>);
    expect(loaded.rules.wetWeatherMultiplier).toBe(0.5);
    // Days already drawn are saved values: a different rule on the restored session cannot rewrite them.
    expect(loaded.weather.serialize().days).toEqual(session.weather.serialize().days);
    expect(WEATHER_KINDS.length).toBe(5);
  });
});
