import { describe, expect, it } from 'vitest';
import { BIOMES } from '../biomes/content';
import { ParkCalendar } from '../calendar/ParkCalendar';
import { GAME_CONFIG } from '../config';
import { hashState } from '../save/hash';
import { ParkSession } from '../session/ParkSession';
import { WeatherSimulation, type WeatherRules } from '../weather/WeatherSimulation';
import { createWeatherView } from '../weather/types';
import { SCENARIO_BY_ID } from './content';
import {
  BASE_PARK_RULES,
  CARD_MODIFIABLE_RULES,
  MULTIPLIER_DIRECTION,
  OPTIONAL_RULE_KEYS,
  PHASE14_RULE_KEYS,
  PHASE16_RULE_KEYS,
  RULE_CLAMPS,
  compileParkRules,
  type CardModifiers,
  type OptionalRuleKey,
} from './rules';

/**
 * Phase 25 (design 2.1): the seven card-modifiable multipliers. Each key: its direction, the clamp of the compiled
 * product, where it sits in a saved ruleset, and one measured consumer test (the number the simulation really reads).
 */

const DAY_TICKS = GAME_CONFIG.calendar.defaultDayLengthSeconds * 10;
/** The tick at `hour` on day 1 of a 720 s day (tick 0 is `startHour`). */
const tickAtHour = (hour: number): number => Math.round((hour - GAME_CONFIG.calendar.startHour) / 24 * DAY_TICKS);

const weatherWith = (rules: Partial<WeatherRules>, tick: { value: number }, climate = { mix: [1, 1, 1, 1, 1], temperature: 0 }): WeatherSimulation => (
  new WeatherSimulation(
    0x5eed1234,
    new ParkCalendar(() => tick.value, true),
    { wetWeatherMultiplier: 1, weatherEffectMultiplier: 1, nightArrivalMultiplier: 1, ...rules },
    () => tick.value,
    climate,
  )
);

/** A Scenario park playing under `modifiers` (compiled like a card on top of the scenario's rules). */
const scenarioSession = (modifiers: CardModifiers, scenarioId = 'sunny-start'): ParkSession => {
  const scenario = SCENARIO_BY_ID.get(scenarioId as never)!;
  return new ParkSession(scenario, [], { rules: compileParkRules(scenario.rules, [modifiers]) });
};

describe('Phase 25 rule keys: declaration', () => {
  it('appends the seven keys after recolourCostMultiplier, all base 1, with the design directions', () => {
    // Phase 21 appended landCostMultiplier the same way (written only when != 1, right after these seven).
    expect(CARD_MODIFIABLE_RULES.slice(-(OPTIONAL_RULE_KEYS.length + 1))).toEqual(['recolourCostMultiplier', ...OPTIONAL_RULE_KEYS]);
    expect(OPTIONAL_RULE_KEYS.at(-1)).toBe('landCostMultiplier');
    const expected: Record<OptionalRuleKey, 'higherIsBetter' | 'lowerIsBetter'> = {
      weatherEffectMultiplier: 'lowerIsBetter',
      nightArrivalMultiplier: 'higherIsBetter',
      dayLengthMultiplier: 'higherIsBetter',
      crowdCapacityMultiplier: 'higherIsBetter',
      litterImpactMultiplier: 'lowerIsBetter',
      breakdownRateMultiplier: 'lowerIsBetter',
      sceneryAppealMultiplier: 'higherIsBetter',
      landCostMultiplier: 'lowerIsBetter',
    };
    for (const key of OPTIONAL_RULE_KEYS) {
      expect(BASE_PARK_RULES[key], key).toBe(1);
      expect(MULTIPLIER_DIRECTION[key], key).toBe(expected[key]);
      expect(compileParkRules()[key], key).toBe(1);
    }
  });

  it('clamps the compiled product of every key to [0.25, 4]', () => {
    for (const key of OPTIONAL_RULE_KEYS) {
      expect(compileParkRules(undefined, [{ [key]: 3 }, { [key]: 3 }])[key], key).toBe(RULE_CLAMPS.maximumMultiplier);
      expect(compileParkRules(undefined, [{ [key]: 0.3 }, { [key]: 0.3 }])[key], key).toBe(RULE_CLAMPS.minimumMultiplier);
      expect(compileParkRules(undefined, [{ [key]: 1.2 }, { [key]: 0.5 }])[key], key).toBe(0.6);
    }
  });

  it('a saved ruleset writes a key only when it is not 1, after recolourCostMultiplier and before the biome and bonus keys', () => {
    const plain = new ParkSession(SCENARIO_BY_ID.get('sunny-start')!).serialize().rules;
    for (const key of OPTIONAL_RULE_KEYS) expect(key in plain, key).toBe(false);
    const scenario = SCENARIO_BY_ID.get('sunny-start')!;
    const rules = compileParkRules(
      scenario.rules,
      [{ sceneryAppealMultiplier: 1.2, weatherEffectMultiplier: 0.8, dayLengthMultiplier: 1.25 }],
      { hungerRateMultiplier: 1.1, thirstRateMultiplier: 1 },
    );
    const saved = new ParkSession(scenario, [], { rules }).serialize().rules;
    const keys = Object.keys(saved);
    expect(keys.slice(keys.indexOf('recolourCostMultiplier'))).toEqual([
      'recolourCostMultiplier', 'weatherEffectMultiplier', 'dayLengthMultiplier', 'sceneryAppealMultiplier', 'hungerRateMultiplier',
      // Phase 16: the two base-layer keys come last, when the config makes them non-neutral.
      ...PHASE16_RULE_KEYS.filter((key) => key in saved),
      // Phase 14: the crowd feedback key after them, when compiled.
      ...PHASE14_RULE_KEYS.filter((key) => key in saved),
      // Phase 40: the front-access key last, when compiled.
      ...['frontAccess'].filter((key) => key in saved),
    ]);
    expect(saved.weatherEffectMultiplier).toBe(0.8);
  });
});

describe('Phase 25 rule keys: measured consumers', () => {
  it('nightArrivalMultiplier: arrivals x1.6 at 23:00, untouched at 14:00 (and x1 is the exact old float)', () => {
    const tick = { value: 0 };
    const base = weatherWith({}, tick);
    const night = weatherWith({ nightArrivalMultiplier: 1.6 }, tick);
    tick.value = tickAtHour(23);
    base.refresh(tick.value);
    night.refresh(tick.value);
    expect(base.conditions.arrivalRate).toBeGreaterThan(0);
    expect(night.conditions.arrivalRate).toBe(base.conditions.arrivalRate * 1.6);
    tick.value = tickAtHour(28.5);
    base.refresh(tick.value);
    night.refresh(tick.value);
    expect(night.conditions.arrivalRate).toBe(base.conditions.arrivalRate * 1.6);
    tick.value = tickAtHour(14);
    base.refresh(tick.value);
    night.refresh(tick.value);
    expect(night.conditions.arrivalRate).toBe(base.conditions.arrivalRate);
    expect(base.conditions.arrivalRate).toBeGreaterThan(0);
  });

  it('weatherEffectMultiplier: rain 0.8 bites as 0.48 at 0.6 (view, forecast and conditions); sunny is untouched', () => {
    const tick = { value: DAY_TICKS + 100 };
    const base = weatherWith({}, tick);
    const mild = weatherWith({ weatherEffectMultiplier: 0.6 }, tick);
    for (const weather of [base, mild]) {
      weather.refresh(tick.value);
      expect(weather.forceCurrentSlot('rain', 0.8, tick.value)).toBe(true);
    }
    expect(base.viewInto(createWeatherView(), tick.value).intensity).toBe(0.8);
    expect(mild.viewInto(createWeatherView(), tick.value).intensity).toBeCloseTo(0.48, 12);
    expect(mild.conditions.arrivalWeatherFactor).toBeGreaterThan(base.conditions.arrivalWeatherFactor);
    for (const weather of [base, mild]) weather.forceCurrentSlot('sunny', 0.8, tick.value);
    expect(mild.viewInto(createWeatherView(), tick.value).intensity).toBe(base.viewInto(createWeatherView(), tick.value).intensity);
    expect(mild.conditions).toEqual(base.conditions);
    // The forecast scales the same way, slot by slot (sunny exempt).
    const forecastBase = base.forecast(6, tick.value);
    const forecastMild = mild.forecast(6, tick.value);
    expect(forecastMild.map((entry) => entry.kind)).toEqual(forecastBase.map((entry) => entry.kind));
    forecastBase.forEach((entry, index) => {
      const expected = entry.kind === 'sunny' ? entry.intensity : Math.min(1, entry.intensity * 0.6);
      expect(forecastMild[index].intensity).toBeCloseTo(expected, 12);
    });
  });

  it('dayLengthMultiplier: 1.5 plays 1,080 s days in a Scenario park, the deadline in seconds does not move, the save reloads', () => {
    const base = scenarioSession({});
    const long = scenarioSession({ dayLengthMultiplier: 1.5 });
    expect(base.calendar.dayLengthSeconds).toBe(720);
    expect(long.calendar.dayLengthSeconds).toBe(1_080);
    expect(long.scenarioDefinition!.timeLimitSeconds).toBe(base.scenarioDefinition!.timeLimitSeconds);
    expect(long.calendar.isEditable).toBe(false);
    for (let tick = 0; tick < 50; tick += 1) long.step(GAME_CONFIG.fixedStepMs);
    const state = long.serialize();
    expect(state.rules.dayLengthMultiplier).toBe(1.5);
    expect(hashState(ParkSession.fromState(structuredClone(state)).serialize())).toBe(hashState(state));
    // The consistency law reads the rules: 720 s days under a 1.5 ruleset are refused, and so is 1,080 under none.
    const wrong = structuredClone(state);
    wrong.calendar.dayLengthSeconds = 720;
    expect(() => ParkSession.fromState(wrong)).toThrow(/dayLengthSeconds/);
    const plain = structuredClone(base.serialize());
    plain.calendar.dayLengthSeconds = 1_080;
    expect(() => ParkSession.fromState(plain)).toThrow(/dayLengthSeconds/);
    // The Sandbox keeps its own clock (its day length is the player's).
    expect(new ParkSession(null).calendar.isEditable).toBe(true);
  });

  it('dayLengthMultiplier direction: in the same stage seconds, 1.5 keeps more of the stage on the fixed sunny first day (Jungle)', () => {
    const jungle = BIOMES.find((biome) => biome.id === 'jungle')!;
    const stageSeconds = 3 * 720;
    const shareOf = (dayLengthSeconds: number): { firstDay: number; drawnDays: number } => {
      const tick = { value: 0 };
      const calendar = new ParkCalendar(() => tick.value, false, dayLengthSeconds);
      const weather = new WeatherSimulation(0x5eed1234, calendar, { wetWeatherMultiplier: 1, weatherEffectMultiplier: 1, nightArrivalMultiplier: 1 }, () => tick.value, { mix: jungle.weatherMix, temperature: jungle.temperature });
      const view = createWeatherView();
      let firstDay = 0;
      let lastDay = 1;
      for (let second = 0; second < stageSeconds; second += 5) {
        tick.value = second * 10;
        weather.refresh(tick.value);
        weather.viewInto(view, tick.value);
        if (view.day === 1) firstDay += 1;
        lastDay = Math.max(lastDay, view.day);
      }
      const samples = stageSeconds / 5;
      // Day 1 is the fixed sunny day (no draw); every later day is drawn from the biome's chain.
      return { firstDay: firstDay / samples, drawnDays: lastDay - 1 };
    };
    const base = shareOf(720);
    const long = shareOf(1_080);
    expect(base.firstDay).toBeCloseTo(1 / 3, 2);
    expect(long.firstDay).toBeCloseTo(1 / 2, 2);
    expect(base.drawnDays).toBe(2);
    expect(long.drawnDays).toBe(1);
  });

  it('crowdCapacityMultiplier: the organic guest potential x1.3', () => {
    const base = scenarioSession({});
    const crowd = scenarioSession({ crowdCapacityMultiplier: 1.3 });
    for (const session of [base, crowd]) {
      session.world.cash = 100_000;
      session.world.buildPaths([{ x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 }]);
      session.world.buildObject('petal-roundabout', { x: 16, y: 26 });
      session.world.setParkOpen(true);
      session.syncWithWorld();
    }
    const potential = base.guests.organicGuestPotential();
    expect(potential).toBeGreaterThan(0);
    const scaled = crowd.guests.organicGuestPotential();
    expect(scaled).toBeGreaterThanOrEqual(Math.floor(potential * 1.3));
    expect(scaled).toBeLessThanOrEqual(Math.floor((potential + 1) * 1.3));
    expect(scaled).toBeGreaterThan(potential);
  });

  it('litterImpactMultiplier: the rating penalty and the guests\' happiness loss x0.6 under their caps (litter itself unchanged)', () => {
    const run = (factor: number): { penalty: number; loss: number; units: number } => {
      const session = scenarioSession({ litterImpactMultiplier: factor });
      session.world.buildPaths([{ x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 }, { x: 15, y: 25 }]);
      session.syncWithWorld();
      const before = session.operations.snapshot().cleanliness.score;
      session.operations.addLitter({ x: 15, y: 26 }, 2);
      const penalty = before - session.operations.snapshot().cleanliness.score;
      session.guests.spawnGuests(1);
      const guest = [...session.guests.guests.values()][0];
      guest.currentCell = { x: 15, y: 26 };
      guest.happiness = 80;
      const operations = session.operations as unknown as { updateGuestCleanliness: (seconds: number, guests: Map<number, unknown>) => void };
      operations.updateGuestCleanliness(GAME_CONFIG.operations.litter.happinessIntervalSeconds, session.guests.guests);
      return { penalty, loss: 80 - guest.happiness, units: session.operations.snapshot().cleanliness.litterUnits };
    };
    const base = run(1);
    const tidy = run(0.6);
    expect(base.penalty).toBeGreaterThan(0);
    expect(base.penalty).toBeLessThan(GAME_CONFIG.operations.cleanliness.maximumLitterPenalty);
    expect(tidy.penalty).toBeCloseTo(base.penalty * 0.6, 0);
    expect(base.loss).toBeGreaterThan(0);
    expect(base.loss).toBeLessThan(GAME_CONFIG.operations.litter.maximumHappinessPenalty);
    expect(tidy.loss).toBeCloseTo(base.loss * 0.6, 10);
    expect(tidy.units).toBe(base.units);
  });

  it('breakdownRateMultiplier: the per-cycle probability x0.5, capped at 0.95 only off 1, untouched at 1', () => {
    const probabilityOf = (factor: number, p: number): number => {
      const session = scenarioSession({ breakdownRateMultiplier: factor });
      return (session.rides as unknown as { scaledBreakdownProbability: (value: number) => number }).scaledBreakdownProbability(p);
    };
    expect(probabilityOf(0.5, 0.1)).toBe(0.05);
    expect(probabilityOf(1, 0.1 + 0.2)).toBe(0.1 + 0.2);
    expect(probabilityOf(1, 0.99)).toBe(0.99);
    expect(probabilityOf(3, 0.5)).toBe(0.95);
    expect(probabilityOf(2, 0.2)).toBe(0.4);
  });

  it('sceneryAppealMultiplier: every source\'s appeal x1.5 inside its signature; a restore under the same ruleset is byte-identical', () => {
    const appealOf = (factor: number): { appeal: number; signature: string; session: ParkSession } => {
      const session = scenarioSession({ sceneryAppealMultiplier: factor });
      session.world.cash = 100_000;
      session.world.buildPaths([{ x: 15, y: 28 }, { x: 15, y: 27 }]);
      session.world.buildObject('lollipop-lamp', { x: 16, y: 27 });
      session.syncWithWorld();
      const source = session.scenery.snapshot().sources[0];
      const signature = (session.scenery as unknown as { sources: Map<number, { signature: string }> }).sources.get(source.objectId)!.signature;
      return { appeal: source.appeal, signature, session };
    };
    const base = appealOf(1);
    const bright = appealOf(1.5);
    expect(base.appeal).toBe(8);
    expect(bright.appeal).toBe(12);
    expect(bright.signature).toContain(':12:');
    for (let tick = 0; tick < 20; tick += 1) bright.session.step(GAME_CONFIG.fixedStepMs);
    const state = bright.session.serialize();
    const restored = ParkSession.fromState(structuredClone(state));
    expect(restored.scenery.isSyncedWithWorld()).toBe(true);
    expect(hashState(restored.serialize())).toBe(hashState(state));
    for (let tick = 0; tick < 20; tick += 1) {
      bright.session.step(GAME_CONFIG.fixedStepMs);
      restored.step(GAME_CONFIG.fixedStepMs);
    }
    expect(hashState(restored.serialize())).toBe(hashState(bright.session.serialize()));
  });
});
