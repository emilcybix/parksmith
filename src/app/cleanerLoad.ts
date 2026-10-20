import { GAME_CONFIG } from '../game/config';
import type { WasteTally } from '../game/operations/types';

/**
 * Phase 49: how the cleaners are coping, over the last simulated minute. Feeds the Staff window's capacity read and the
 * Park Pulse line "Litter outpaces your cleaners: bins near X would help".
 *
 * App layer on purpose, like `crowdNotice.ts`: never saved, reset on every session swap (start again from
 * `INITIAL_CLEANER_LOAD`), and driven by the session tick only, so a paused park freezes it. Each sample is the
 * operations' running `WasteTally` plus how many cleaners have a task; rates are the difference across the window.
 * A tick that ran backwards (a rewind) or a tally that shrank (a new simulation) starts the window again.
 */

const TICKS_PER_SECOND = 1_000 / GAME_CONFIG.fixedStepMs;
const TICKS_PER_MINUTE = 60 * TICKS_PER_SECOND;

export interface CleanerLoadSample {
  readonly tick: number;
  readonly tally: Readonly<WasteTally>;
  readonly cleaners: number;
  /** Cleaners with a task (walking to it or working). */
  readonly busy: number;
}

export interface CleanerLoadState {
  /** Oldest first, all inside the window. */
  readonly samples: readonly CleanerLoadSample[];
}

export const INITIAL_CLEANER_LOAD: CleanerLoadState = Object.freeze({ samples: [] });

export interface CleanerLoad {
  /** Simulated seconds the figures cover (up to `cleanerWindowSeconds`). */
  seconds: number;
  /** Purchase waste made a minute. */
  wastePerMinute: number;
  /** The share (0..1) of that waste a bin took; null before any waste. */
  binShare: number | null;
  /** Litter units that landed on the paths a minute (no bin in reach, a full bin, someone being sick). */
  droppedPerMinute: number;
  /** Units the cleaners swept up a minute. */
  clearedPerMinute: number;
  /** The average share (0..1) of the crew with a task; null without cleaners. */
  busyShare: number | null;
  cleaners: number;
  /** Every cleaner busy nearly all the window while litter lands: more of them alone will not catch up, bins will. */
  swamped: boolean;
}

const shrank = (later: Readonly<WasteTally>, earlier: Readonly<WasteTally>): boolean => (
  later.made < earlier.made || later.binned < earlier.binned || later.dropped < earlier.dropped || later.cleared < earlier.cleared
);

export const stepCleanerLoad = (state: CleanerLoadState, sample: CleanerLoadSample): { state: CleanerLoadState; load: CleanerLoad } => {
  const pulse = GAME_CONFIG.crowd.pulse;
  const last = state.samples[state.samples.length - 1];
  const restart = last !== undefined && (sample.tick < last.tick || shrank(sample.tally, last.tally));
  const kept = restart ? [] : state.samples.filter((entry) => sample.tick - entry.tick <= pulse.cleanerWindowSeconds * TICKS_PER_SECOND);
  // One sample per tick: a second publish inside the same tick replaces the first.
  const samples = kept.length > 0 && kept[kept.length - 1].tick === sample.tick ? [...kept.slice(0, -1), sample] : [...kept, sample];
  const first = samples[0];
  const ticks = sample.tick - first.tick;
  const perMinute = (now: number, then: number): number => (ticks > 0 ? (now - then) / ticks * TICKS_PER_MINUTE : 0);
  const made = sample.tally.made - first.tally.made;
  const staffed = samples.filter((entry) => entry.cleaners > 0);
  const busyShare = staffed.length === 0 ? null : staffed.reduce((total, entry) => total + entry.busy / entry.cleaners, 0) / staffed.length;
  const droppedPerMinute = perMinute(sample.tally.dropped, first.tally.dropped);
  const seconds = ticks / TICKS_PER_SECOND;
  return {
    state: { samples },
    load: {
      seconds,
      wastePerMinute: perMinute(sample.tally.made, first.tally.made),
      binShare: made > 0 ? (sample.tally.binned - first.tally.binned) / made : null,
      droppedPerMinute,
      clearedPerMinute: perMinute(sample.tally.cleared, first.tally.cleared),
      busyShare,
      cleaners: sample.cleaners,
      swamped: sample.cleaners > 0
        && seconds >= pulse.cleanerMinimumSeconds
        && busyShare !== null && busyShare >= pulse.cleanersSwampedShare
        && droppedPerMinute > 0,
    },
  };
};

/** The load as the UI shows it (whole units a minute, whole percent), so a steady park publishes nothing new. */
export const displayedCleanerLoad = (load: Readonly<CleanerLoad>): CleanerLoad => {
  const share = (value: number | null): number | null => (value === null ? null : Math.round(value * 100) / 100);
  return {
    seconds: Math.floor(load.seconds),
    wastePerMinute: Math.round(load.wastePerMinute),
    binShare: share(load.binShare),
    droppedPerMinute: Math.round(load.droppedPerMinute),
    clearedPerMinute: Math.round(load.clearedPerMinute),
    busyShare: share(load.busyShare),
    cleaners: load.cleaners,
    swamped: load.swamped,
  };
};

export const cleanerLoadEqual = (left: Readonly<CleanerLoad> | null, right: Readonly<CleanerLoad> | null): boolean => {
  if (left === null || right === null) return left === right;
  return (Object.keys(left) as (keyof CleanerLoad)[]).every((key) => left[key] === right[key]);
};
