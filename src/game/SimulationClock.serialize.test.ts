import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from './config';
import { hashState } from './save/hash';
import { assertPlainData, assertStructuredCloneSafe, auditOwnProperties } from './save/plainData';
import { SaveError } from './save/version';
import { SimulationClock } from './SimulationClock';
import type { GameSpeed } from './types';

const STEP = GAME_CONFIG.fixedStepMs;
const noop = (): void => undefined;

describe('SimulationClock serialize and restore', () => {
  it('round trips speed and simulation time, through JSON as well', () => {
    const clock = new SimulationClock(noop);
    clock.setSpeed(4);
    clock.update(STEP * 3.5);
    const state = clock.serialize();
    expect(state).toEqual({ speed: 4, simulationTimeMs: STEP * 8 });
    assertPlainData(state);
    assertStructuredCloneSafe(state);

    const fresh = new SimulationClock(noop);
    fresh.restore(JSON.parse(JSON.stringify(state)) as typeof state);
    expect(hashState(fresh.serialize()), 'same hash after a JSON round trip').toBe(hashState(state));
  });

  it('restarts the partial step and the telemetry, and never touches onStep', () => {
    const steps: number[] = [];
    const clock = new SimulationClock((stepMs) => steps.push(stepMs));
    clock.update(STEP * 1.7);
    expect(clock.stepFraction).toBeGreaterThan(0);
    clock.restore({ speed: 2, simulationTimeMs: 5000 });
    expect(clock.stepFraction, 'accumulator reset').toBe(0);
    expect(clock.stepsLastFrame).toBe(0);
    expect(clock.lastStepDurationMs).toBe(0);
    expect(clock.simulationTimeMs).toBe(5000);
    steps.length = 0;
    clock.update(STEP);
    expect(steps, 'the original step callback still fires').toHaveLength(2);
  });

  it('keeps a paused clock paused and accepts every legal speed', () => {
    for (const speed of [0, 1, 2, 4] as GameSpeed[]) {
      const clock = new SimulationClock(noop);
      clock.restore({ speed, simulationTimeMs: 0 });
      expect(clock.speed).toBe(speed);
    }
  });

  it('rejects malformed state with an invalid-state error and changes nothing', () => {
    const clock = new SimulationClock(noop);
    clock.setSpeed(2);
    clock.update(STEP * 2);
    const before = JSON.stringify(clock.serialize());
    const bad: unknown[] = [
      { speed: 3, simulationTimeMs: 0 },
      { speed: 1, simulationTimeMs: -100 },
      { speed: 1, simulationTimeMs: 1.5 },
      { speed: 1, simulationTimeMs: Number.NaN },
      { speed: 1, simulationTimeMs: Number.POSITIVE_INFINITY },
      { speed: 1 },
      {},
    ];
    for (const state of bad) {
      let caught: unknown;
      try {
        clock.restore(state as never);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(state)).toBeInstanceOf(SaveError);
      expect((caught as SaveError).code).toBe('invalid-state');
      expect(JSON.stringify(clock.serialize()), 'untouched').toBe(before);
    }
  });

  it('accounts for every own field (add new fields to the lists below, or to serialize())', () => {
    const clock = new SimulationClock(noop);
    expect(auditOwnProperties(clock, {
      serialized: ['speed', 'simulationTimeMs'],
      // Telemetry and the partial step restart on load (see SimulationClock.restore).
      derived: [],
      config: ['onStep'],
      transient: ['lastStepDurationMs', 'stepsLastFrame', 'accumulator'],
    }), 'a field was added or removed: decide whether it belongs in SimulationClockState').toEqual([]);

    const mutate: Record<string, (target: SimulationClock) => void> = {
      speed: (target) => target.setSpeed(4),
      simulationTimeMs: (target) => { target.simulationTimeMs += 100; },
    };
    const baseline = hashState(new SimulationClock(noop).serialize());
    for (const [field, change] of Object.entries(mutate)) {
      const changed = new SimulationClock(noop);
      change(changed);
      expect(hashState(changed.serialize()), `serialize() must read ${field}`).not.toBe(baseline);
    }
  });
});
