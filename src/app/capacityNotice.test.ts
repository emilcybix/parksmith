import { describe, expect, it } from 'vitest';
import {
  CAPACITY_FIRE_TICKS,
  CAPACITY_ON_TICKS,
  INITIAL_CAPACITY_NOTICE,
  capacityReleaseMargin,
  stepCapacityNotice,
  type CapacityNoticeState,
} from './capacityNotice';

/** Drives the tracker like GameApp's 4 Hz snapshot: one step per call, collecting what it said. */
const run = (steps: ReadonlyArray<{ tick: number; guestCount: number; ceiling: number }>, from: CapacityNoticeState = INITIAL_CAPACITY_NOTICE) => {
  let state = from;
  const flags: boolean[] = [];
  const fires: number[] = [];
  for (const input of steps) {
    const step = stepCapacityNotice(state, input);
    state = step.state;
    flags.push(step.atCapacity);
    if (step.fire) fires.push(input.tick);
  }
  return { state, flags, fires, last: flags[flags.length - 1] };
};

/** Steps every 10 ticks (one 4 Hz snapshot at 4x speed is about that) from `start` to `end` inclusive. */
const span = (start: number, end: number, guestCount: number, ceiling: number, every = 10) => {
  const steps: Array<{ tick: number; guestCount: number; ceiling: number }> = [];
  for (let tick = start; tick <= end; tick += every) steps.push({ tick, guestCount, ceiling });
  return steps;
};

describe('capacity notice', () => {
  it('uses 10 and 60 simulated seconds at the 100 ms step', () => {
    expect(CAPACITY_ON_TICKS).toBe(100);
    expect(CAPACITY_FIRE_TICKS).toBe(600);
  });

  it('turns on after the count has held the ceiling for 10 simulated seconds, not before', () => {
    const before = run(span(0, 90, 52, 52));
    expect(before.last).toBe(false);
    const after = run(span(0, 100, 52, 52));
    expect(after.last).toBe(true);
    // Above the ceiling counts too (guests already inside when the ceiling fell).
    expect(run(span(0, 100, 60, 52)).last).toBe(true);
  });

  it('a dip below the ceiling before the 10 s restarts the wait', () => {
    const steps = [...span(0, 80, 52, 52), { tick: 90, guestCount: 51, ceiling: 52 }, ...span(100, 180, 52, 52)];
    expect(run(steps).last).toBe(false);
    expect(run([...steps, { tick: 190, guestCount: 52, ceiling: 52 }]).last).toBe(false);
    expect(run([...steps, { tick: 200, guestCount: 52, ceiling: 52 }]).last).toBe(true);
  });

  it('never turns on with a ceiling of 0 (a closed park is not full)', () => {
    expect(run(span(0, 500, 0, 0)).last).toBe(false);
    expect(run(span(0, 500, 30, 0)).last).toBe(false);
  });

  it('stays on while the count wobbles inside the margin and turns off below it', () => {
    expect(capacityReleaseMargin(52)).toBe(6);
    expect(capacityReleaseMargin(10)).toBe(2);
    expect(capacityReleaseMargin(1000)).toBe(100);
    const on = run(span(0, 100, 52, 52));
    expect(on.last).toBe(true);
    const wobble = run([{ tick: 110, guestCount: 47, ceiling: 52 }], on.state);
    expect(wobble.last).toBe(true);
    const off = run([{ tick: 120, guestCount: 46, ceiling: 52 }], wobble.state);
    expect(off.last).toBe(false);
  });

  it('turns off at once when the ceiling rises above the count, and when the gate shuts', () => {
    const on = run(span(0, 100, 52, 52));
    expect(run([{ tick: 110, guestCount: 52, ceiling: 55 }], on.state).last).toBe(false);
    // A falling ceiling that is still at or under the count keeps it on.
    expect(run([{ tick: 110, guestCount: 52, ceiling: 50 }], on.state).last).toBe(true);
    expect(run([{ tick: 110, guestCount: 52, ceiling: 0 }], on.state).last).toBe(false);
  });

  it('fires once after 60 s at capacity and only re-arms after it turned off', () => {
    const first = run(span(0, 100 + 1_200, 52, 52));
    expect(first.fires).toEqual([100 + 600]);
    const dropped = run([{ tick: 1_310, guestCount: 40, ceiling: 52 }], first.state);
    expect(dropped.last).toBe(false);
    const again = run(span(1_320, 1_320 + 100 + 600, 52, 52), dropped.state);
    expect(again.fires).toEqual([1_320 + 100 + 600]);
  });

  it('a toast that has fired does not fire again while the flag holds', () => {
    const long = run(span(0, 5_000, 52, 52, 25));
    expect(long.fires).toHaveLength(1);
  });

  it('pausing freezes it: steps at the same tick add no time', () => {
    const almost = run(span(0, 90, 52, 52));
    const paused = run(Array.from({ length: 50 }, () => ({ tick: 90, guestCount: 52, ceiling: 52 })), almost.state);
    expect(paused.last).toBe(false);
    expect(run([{ tick: 100, guestCount: 52, ceiling: 52 }], paused.state).last).toBe(true);
  });

  it('restarts from the initial state (a session swap), and a tick that ran backwards restarts the stretch', () => {
    const on = run(span(0, 100, 52, 52));
    expect(run([{ tick: 5, guestCount: 52, ceiling: 52 }], INITIAL_CAPACITY_NOTICE).last).toBe(false);
    const backwards = run([{ tick: 20, guestCount: 52, ceiling: 52 }], on.state);
    expect(backwards.last).toBe(false);
    expect(run(span(30, 120, 52, 52), backwards.state).last).toBe(true);
  });
});
