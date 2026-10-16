import { describe, expect, it } from 'vitest';
import { SaveError } from '../save/version';
import type { OnboardingState } from '../save/state';
import { MAXIMUM_SAVED_AMOUNT, MAXIMUM_SAVED_COUNTER } from '../save/ranges';
import { assertPlainData } from '../save/plainData';
import { OnboardingTracker } from './OnboardingTracker';
import { freshInput, rideInput } from './testInput';

const populated = (): OnboardingTracker => {
  const tracker = new OnboardingTracker();
  tracker.step(freshInput({ tick: 10, connectedPathTiles: 8, rides: [rideInput({ ticketPrice: 5.5 })], operatingProfit: 0 }));
  tracker.step(freshInput({ tick: 20, litterUnits: 4, cleaners: 1, operatingProfit: 123.456 }));
  tracker.skipStep('first-drink');
  return tracker;
};

const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SaveError);
    return (error as SaveError).code;
  }
  return 'none';
};

describe('OnboardingTracker serialize / restore', () => {
  it('round-trips exactly, through JSON, into a fresh instance', () => {
    const source = populated();
    const state = source.serialize();
    expect(state.sawLitter).toBe(true);
    expect(state.completed.length).toBeGreaterThan(3);
    const target = new OnboardingTracker();
    target.restore(JSON.parse(JSON.stringify(state)) as OnboardingState);
    expect(target.serialize()).toEqual(state);
    expect(target.snapshot()).toEqual(source.snapshot());
  });

  it('serialize is plain data and never aliases the live arrays', () => {
    const tracker = populated();
    const state = tracker.serialize();
    expect(() => assertPlainData(state)).not.toThrow();
    state.completed[0].tick = 999;
    state.completed.pop();
    state.skipped.push('lay-path');
    expect(tracker.serialize().completed[0].tick, 'live state untouched').toBe(10);
    expect(tracker.serialize().skipped).toEqual(['first-drink']);
  });

  it('restores exactly into a dirty instance (reset first), and one held state can be restored twice', () => {
    const state = populated().serialize();
    const dirty = new OnboardingTracker();
    dirty.step(freshInput({ tick: 3, totalArrivals: 99, parkRating: 99 }));
    dirty.skipStep('lay-path');
    dirty.dismissAll();
    dirty.restore(state);
    expect(dirty.serialize(), 'nothing of the dirty state survives').toEqual(state);
    dirty.step(freshInput({ tick: 400, totalArrivals: 99 }));
    dirty.restore(state);
    expect(dirty.serialize(), 'second restore of the same held state').toEqual(state);
  });

  it('restore deep-copies: mutating the state afterwards does not reach the tracker', () => {
    const state = populated().serialize();
    const tracker = new OnboardingTracker();
    tracker.restore(state);
    state.completed[0].evidence = 777;
    state.skipped.length = 0;
    expect(tracker.serialize().completed[0].evidence).not.toBe(777);
    expect(tracker.serialize().skipped).toEqual(['first-drink']);
  });

  it('a step that is both done and skipped is legal (completion wins over skip)', () => {
    const state = populated().serialize();
    state.skipped.push('lay-path');
    const tracker = new OnboardingTracker();
    expect(() => tracker.restore(state)).not.toThrow();
    expect(tracker.snapshot().steps[0].status).toBe('done');
  });

  describe('refuses a bad state with a SaveError and leaves the tracker untouched', () => {
    const cases: Array<[string, string, (state: Record<string, unknown>) => void]> = [
      ['dismissed is not a boolean', 'invalid-state', (state) => { state.dismissed = 'yes'; }],
      ['sawLitter is not a boolean', 'invalid-state', (state) => { state.sawLitter = 1; }],
      ['completed is not an array', 'invalid-state', (state) => { state.completed = {}; }],
      ['skipped is not an array', 'invalid-state', (state) => { state.skipped = 'lay-path'; }],
      ['completed is missing', 'invalid-state', (state) => { delete state.completed; }],
      ['skipped is missing', 'invalid-state', (state) => { delete state.skipped; }],
      ['dismissed is missing', 'invalid-state', (state) => { delete state.dismissed; }],
      ['unknown completed id', 'content-mismatch', (state) => { (state.completed as Array<{ id: string }>)[0].id = 'fly-to-the-moon'; }],
      ['unknown skipped id', 'content-mismatch', (state) => { (state.skipped as string[]).push('fly-to-the-moon'); }],
      ['completed id is not a string', 'invalid-state', (state) => { (state.completed as Array<{ id: unknown }>)[0].id = 4; }],
      ['skipped id is not a string', 'invalid-state', (state) => { (state.skipped as unknown[]).push(7); }],
      ['duplicate completed id', 'invalid-state', (state) => { (state.completed as unknown[]).push({ ...(state.completed as object[])[0] }); }],
      ['duplicate skipped id', 'invalid-state', (state) => { (state.skipped as string[]).push('first-drink'); }],
      ['completed entry is not an object', 'invalid-state', (state) => { (state.completed as unknown[])[0] = 5; }],
      ['tick is negative', 'invalid-state', (state) => { (state.completed as Array<{ tick: number }>)[0].tick = -1; }],
      ['tick is fractional', 'invalid-state', (state) => { (state.completed as Array<{ tick: number }>)[0].tick = 1.5; }],
      ['tick is beyond the counter range', 'invalid-state', (state) => { (state.completed as Array<{ tick: number }>)[0].tick = MAXIMUM_SAVED_COUNTER + 1; }],
      ['tick is NaN', 'invalid-state', (state) => { (state.completed as Array<{ tick: number }>)[0].tick = Number.NaN; }],
      ['ticks go backwards', 'invalid-state', (state) => { (state.completed as Array<{ tick: number }>)[0].tick = 999; }],
      ['evidence is negative', 'invalid-state', (state) => { (state.completed as Array<{ evidence: number }>)[0].evidence = -1; }],
      ['evidence is beyond the amount range', 'invalid-state', (state) => { (state.completed as Array<{ evidence: number }>)[0].evidence = MAXIMUM_SAVED_AMOUNT * 2; }],
      ['evidence is Infinity', 'invalid-state', (state) => { (state.completed as Array<{ evidence: number }>)[0].evidence = Number.POSITIVE_INFINITY; }],
      ['evidence is a string', 'invalid-state', (state) => { (state.completed as Array<{ evidence: unknown }>)[0].evidence = '5'; }],
      ['more entries than steps', 'invalid-state', (state) => {
        for (let index = 0; index < 11; index += 1) (state.completed as unknown[]).push({ id: 'lay-path', tick: 50, evidence: 6 });
      }],
      ['the state is null', 'invalid-state', () => undefined],
    ];

    it.each(cases)('%s', (label, code, corrupt) => {
      const tracker = populated();
      const before = tracker.serialize();
      let state: unknown = JSON.parse(JSON.stringify(before));
      if (label === 'the state is null') state = null;
      else corrupt(state as Record<string, unknown>);
      expect(codeOf(() => tracker.restore(state as OnboardingState)), label).toBe(code);
      expect(tracker.serialize(), 'validated before mutating').toEqual(before);
    });
  });

  it('accepts the boundary values of every range', () => {
    const tracker = new OnboardingTracker();
    tracker.restore({
      dismissed: false,
      completed: [{ id: 'lay-path', tick: 0, evidence: 0 }, { id: 'first-ride', tick: MAXIMUM_SAVED_COUNTER, evidence: MAXIMUM_SAVED_AMOUNT }],
      skipped: [],
      sawLitter: false,
    });
    expect(tracker.serialize().completed.length).toBe(2);
  });

  it('serialize writes -0 evidence as 0', () => {
    const tracker = new OnboardingTracker();
    tracker.restore({ dismissed: false, completed: [{ id: 'fix-problem', tick: 3, evidence: -0 }], skipped: [], sawLitter: true });
    expect(Object.is(tracker.serialize().completed[0].evidence, 0)).toBe(true);
  });
});
