import { describe, expect, it } from 'vitest';
import {
  GpuPassTimer,
  PASS_COMPOSITE,
  PASS_COUNT,
  PASS_GBUFFER,
  PASS_LIGHT,
  PASS_UPSCALE,
  smoothedMilliseconds,
  TIMER_QUERY_FRAMES,
  TIMER_SMOOTHING,
  VOXEL_GPU_PASSES,
  type TimerQueryContext,
  type TimerQueryExtension,
} from './timing';

/**
 * Per-pass GPU time is only ever read asynchronously: a query's result arrives frames later, a
 * query still in flight must never be reused (that would stall the GPU), and a disjoint event voids
 * whatever was read with it. A fake context plays the GPU so each of those rules is pinned.
 */

const EXTENSION: TimerQueryExtension = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };

interface FakeQuery {
  id: number;
  nanoseconds: number;
  available: boolean;
}

const fakeContext = () => {
  const state = {
    extension: true,
    disjoint: false,
    active: null as FakeQuery | null,
    issued: [] as FakeQuery[],
    begun: 0,
    deleted: 0,
    created: 0,
  };
  const gl: TimerQueryContext = {
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
    getExtension: () => (state.extension ? EXTENSION : null),
    createQuery: () => {
      state.created += 1;
      return { id: state.created, nanoseconds: 0, available: false } as unknown as WebGLQuery;
    },
    deleteQuery: () => {
      state.deleted += 1;
    },
    beginQuery: (target, query) => {
      expect(target).toBe(EXTENSION.TIME_ELAPSED_EXT);
      expect(state.active, 'TIME_ELAPSED queries never nest').toBeNull();
      state.active = query as unknown as FakeQuery;
      state.begun += 1;
    },
    endQuery: () => {
      if (state.active) state.issued.push(state.active);
      state.active = null;
    },
    getQueryParameter: (query, parameter) => {
      const fake = query as unknown as FakeQuery;
      return parameter === 0x8867 ? fake.available : fake.nanoseconds;
    },
    getParameter: (parameter) => (parameter === EXTENSION.GPU_DISJOINT_EXT ? state.disjoint : null),
  };
  /** The GPU finishes every issued query, each pass taking `milliseconds[pass]`. */
  const resolve = (milliseconds: number): void => {
    for (const query of state.issued) {
      query.available = true;
      query.nanoseconds = milliseconds * 1e6;
    }
    state.issued.length = 0;
  };
  return { gl, state, resolve };
};

const timeFrame = (timer: GpuPassTimer, passes: readonly number[]): void => {
  timer.beginFrame();
  for (const pass of passes) {
    timer.begin(pass);
    timer.end();
  }
};

describe('GpuPassTimer', () => {
  it('names the four passes of a voxel frame in order', () => {
    expect(VOXEL_GPU_PASSES).toEqual(['gbuffer', 'light', 'composite', 'upscale']);
    expect([PASS_GBUFFER, PASS_LIGHT, PASS_COMPOSITE, PASS_UPSCALE]).toEqual([0, 1, 2, 3]);
    expect(PASS_COUNT).toBe(4);
  });

  it('is not created without the extension (most mobile browsers)', () => {
    const { gl, state } = fakeContext();
    state.extension = false;
    expect(GpuPassTimer.create(gl)).toBeNull();
  });

  it('reads results only once they are available, in the frames after they were issued', () => {
    const { gl, resolve } = fakeContext();
    const timer = GpuPassTimer.create(gl) as GpuPassTimer;
    timeFrame(timer, [PASS_GBUFFER, PASS_COMPOSITE]);
    timeFrame(timer, []);
    expect(Array.from(timer.samples), 'nothing has arrived yet').toEqual([0, 0, 0, 0]);
    resolve(2);
    timeFrame(timer, []);
    expect(timer.milliseconds[PASS_GBUFFER]).toBe(2);
    expect(timer.milliseconds[PASS_COMPOSITE]).toBe(2);
    expect(Array.from(timer.samples)).toEqual([1, 0, 1, 0]);
  });

  it('smooths samples, starting from the first one instead of zero', () => {
    expect(smoothedMilliseconds(0, 5, 0)).toBe(5);
    expect(smoothedMilliseconds(2, 4, 1)).toBeCloseTo(2 + 2 * TIMER_SMOOTHING, 12);
    const { gl, resolve } = fakeContext();
    const timer = GpuPassTimer.create(gl) as GpuPassTimer;
    timeFrame(timer, [PASS_UPSCALE]);
    resolve(2);
    timeFrame(timer, [PASS_UPSCALE]);
    resolve(4);
    timeFrame(timer, []);
    expect(timer.milliseconds[PASS_UPSCALE]).toBeCloseTo(2.2, 12);
  });

  it('skips a pass whose ring slot is still in flight instead of reusing its query', () => {
    const { gl, state, resolve } = fakeContext();
    const timer = GpuPassTimer.create(gl) as GpuPassTimer;
    for (let frame = 0; frame < TIMER_QUERY_FRAMES; frame += 1) timeFrame(timer, [PASS_LIGHT]);
    expect(state.begun).toBe(TIMER_QUERY_FRAMES);
    timeFrame(timer, [PASS_LIGHT]);
    expect(state.begun, 'every slot of the ring is pending: this frame is not timed').toBe(TIMER_QUERY_FRAMES);
    resolve(1);
    timeFrame(timer, [PASS_LIGHT]);
    expect(state.begun, 'free again once read').toBe(TIMER_QUERY_FRAMES + 1);
    expect(timer.samples[PASS_LIGHT]).toBe(TIMER_QUERY_FRAMES);
  });

  it('discards what it read during a disjoint event, but frees the slots', () => {
    const { gl, state, resolve } = fakeContext();
    const timer = GpuPassTimer.create(gl) as GpuPassTimer;
    timeFrame(timer, [PASS_GBUFFER]);
    resolve(50);
    state.disjoint = true;
    timeFrame(timer, [PASS_GBUFFER]);
    expect(timer.samples[PASS_GBUFFER]).toBe(0);
    state.disjoint = false;
    resolve(3);
    timeFrame(timer, []);
    expect(timer.samples[PASS_GBUFFER]).toBe(1);
    expect(timer.milliseconds[PASS_GBUFFER]).toBe(3);
  });

  it('ends an unended pass before starting the next, so queries never nest', () => {
    const { gl, state } = fakeContext();
    const timer = GpuPassTimer.create(gl) as GpuPassTimer;
    timer.beginFrame();
    timer.begin(PASS_GBUFFER);
    timer.begin(PASS_COMPOSITE);
    timer.end();
    expect(state.issued).toHaveLength(2);
  });

  it('starts over on a restored context, re-enabling the extension (or going quiet without it)', () => {
    const { gl, state, resolve } = fakeContext();
    const timer = GpuPassTimer.create(gl) as GpuPassTimer;
    timeFrame(timer, [PASS_GBUFFER]);
    resolve(4);
    timeFrame(timer, []);
    const created = state.created;
    timer.reset(gl);
    expect(state.created - created, 'a fresh ring of queries').toBe(PASS_COUNT * TIMER_QUERY_FRAMES);
    timeFrame(timer, [PASS_GBUFFER]);
    expect(timer.milliseconds[PASS_GBUFFER], 'averages survive').toBe(4);

    state.extension = false;
    timer.reset(gl);
    const begun = state.begun;
    timeFrame(timer, [PASS_GBUFFER, PASS_COMPOSITE]);
    expect(state.begun, 'no extension on the restored context: nothing is timed').toBe(begun);
  });

  it('deletes its queries when destroyed', () => {
    const { gl, state } = fakeContext();
    const timer = GpuPassTimer.create(gl) as GpuPassTimer;
    timer.destroy();
    expect(state.deleted).toBe(PASS_COUNT * TIMER_QUERY_FRAMES);
  });
});
