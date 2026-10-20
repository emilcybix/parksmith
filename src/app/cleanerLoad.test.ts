import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import type { WasteTally } from '../game/operations/types';
import { INITIAL_CLEANER_LOAD, cleanerLoadEqual, displayedCleanerLoad, stepCleanerLoad, type CleanerLoadState } from './cleanerLoad';

const TPS = 1_000 / GAME_CONFIG.fixedStepMs;
const tally = (made: number, binned: number, dropped: number, cleared: number): WasteTally => ({ made, binned, dropped, cleared });

/** One sample a simulated second for `seconds`, the tally growing by `perSecond` and `busy` of `cleaners` on a task. */
const run = (
  seconds: number,
  perSecond: WasteTally,
  crew: { cleaners: number; busy: number },
  state: CleanerLoadState = INITIAL_CLEANER_LOAD,
  from = 0,
) => {
  let step = stepCleanerLoad(state, { tick: from, tally: tally(0, 0, 0, 0), ...crew });
  for (let second = 1; second <= seconds; second += 1) {
    step = stepCleanerLoad(step.state, {
      tick: from + second * TPS,
      tally: tally(perSecond.made * second, perSecond.binned * second, perSecond.dropped * second, perSecond.cleared * second),
      ...crew,
    });
  }
  return step;
};

describe('Phase 49: the cleaner load over the last simulated minute', () => {
  it('turns the tally into rates a minute and the share the bins took', () => {
    const { load } = run(30, tally(4, 1, 3, 3), { cleaners: 8, busy: 4 });
    expect(load.seconds).toBe(30);
    expect(load.wastePerMinute).toBeCloseTo(240);
    expect(load.binShare).toBeCloseTo(0.25);
    expect(load.droppedPerMinute).toBeCloseTo(180);
    expect(load.clearedPerMinute).toBeCloseTo(180);
    expect(load.busyShare).toBeCloseTo(0.5);
    expect(load.swamped, 'half the crew idle').toBe(false);
  });

  it('calls the crew swamped only when nearly all of it is busy for long enough while litter lands', () => {
    const busy = { cleaners: 10, busy: 10 };
    expect(run(GAME_CONFIG.crowd.pulse.cleanerMinimumSeconds - 1, tally(5, 0, 5, 5), busy).load.swamped, 'too short a window').toBe(false);
    expect(run(30, tally(5, 0, 5, 5), busy).load.swamped).toBe(true);
    expect(run(30, tally(5, 5, 0, 0), busy).load.swamped, 'the bins take it all: nothing lands').toBe(false);
    expect(run(30, tally(5, 0, 5, 5), { cleaners: 10, busy: 8 }).load.swamped, '80 % busy').toBe(false);
    expect(run(30, tally(5, 0, 5, 0), { cleaners: 0, busy: 0 }).load, 'no crew is not a swamped crew').toMatchObject({ swamped: false, busyShare: null });
  });

  it('keeps one minute: older samples drop out of the window', () => {
    const { state } = run(150, tally(1, 0, 1, 1), { cleaners: 2, busy: 2 });
    const ticks = state.samples.map((sample) => sample.tick);
    expect(ticks[ticks.length - 1] - ticks[0]).toBe(GAME_CONFIG.crowd.pulse.cleanerWindowSeconds * TPS);
  });

  it('starts again on a rewind or a smaller tally (a new simulation), and replaces a second sample in one tick', () => {
    const first = run(30, tally(2, 1, 1, 1), { cleaners: 2, busy: 2 });
    const rewound = stepCleanerLoad(first.state, { tick: 5, tally: tally(60, 30, 30, 30), cleaners: 2, busy: 2 });
    expect(rewound.state.samples).toHaveLength(1);
    const swapped = stepCleanerLoad(first.state, { tick: 31 * TPS, tally: tally(0, 0, 0, 0), cleaners: 2, busy: 2 });
    expect(swapped.state.samples).toHaveLength(1);
    const again = stepCleanerLoad(first.state, { tick: 30 * TPS, tally: tally(60, 30, 30, 30), cleaners: 2, busy: 1 });
    expect(again.state.samples).toHaveLength(first.state.samples.length);
  });

  it('shows whole units and whole percent, so a steady park publishes nothing new', () => {
    const shown = displayedCleanerLoad({
      seconds: 30.4, wastePerMinute: 240.4, binShare: 0.2549, droppedPerMinute: 179.6, clearedPerMinute: 180.2, busyShare: 0.996,
      cleaners: 8, swamped: true,
    });
    expect(shown).toEqual({
      seconds: 30, wastePerMinute: 240, binShare: 0.25, droppedPerMinute: 180, clearedPerMinute: 180, busyShare: 1, cleaners: 8, swamped: true,
    });
    expect(cleanerLoadEqual(shown, { ...shown })).toBe(true);
    expect(cleanerLoadEqual(shown, { ...shown, swamped: false })).toBe(false);
    expect(cleanerLoadEqual(null, null)).toBe(true);
    expect(cleanerLoadEqual(shown, null)).toBe(false);
  });
});
