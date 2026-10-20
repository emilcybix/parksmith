import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import type { CrowdTile, CrowdView, NeighborhoodMetrics, NeighborhoodView } from '../game/crowd/types';
import {
  CROWD_NOTICE_PRIORITY, crowdConditionsOf, crowdHoldTicks, crowdReleaseTicks, INITIAL_CROWD_NOTICE, stepCrowdNotice,
  type CrowdNoticeState,
} from './crowdNotice';

const TPS = 1_000 / GAME_CONFIG.fixedStepMs;

const metrics = (patch: Partial<NeighborhoodMetrics> = {}): NeighborhoodMetrics => ({
  guests: 0, happiness: null, hunger: null, thirst: null, toilet: null, spending: 0, litter: 0, scenery: 0, queueing: 0,
  longestWaitSeconds: null, demand: 0, coverage: { food: 1, drink: 1, toilet: 1 }, bands: [20, 0, 0, 0], ...patch,
});

const hood = (key: number, name: string, patch: Partial<NeighborhoodView> = {}, m: Partial<NeighborhoodMetrics> = {}): NeighborhoodView => ({
  key, name, sector: 'centre', rideIds: key === 0 ? [] : [key], memberIds: [], tileCount: 20, focus: { x: 1, y: 1 },
  metrics: metrics(m), worst: null, ...patch,
});

const severe = (key: number, bottleneck = true): CrowdTile => ({ cell: { x: 4, y: 5 }, band: 3, perMinute: 600, bottleneck, neighborhoodKey: key });

const view = (neighborhoods: NeighborhoodView[], bottlenecks: CrowdTile[] = []): CrowdView => ({
  tick: 0, neighborhoods, bottlenecks, walking: 0, feedback: true,
});

/** Steps the tracker once per simulated second from `from` to `to` (inclusive) with the same view. */
const run = (state: CrowdNoticeState, v: CrowdView | null, from: number, to: number) => {
  let step = stepCrowdNotice(state, { tick: from, view: v });
  for (let tick = from + TPS; tick <= to; tick += TPS) step = stepCrowdNotice(step.state, { tick, view: v });
  return step;
};

describe('crowd notice conditions (design Q4 thresholds)', () => {
  const open = { food: true, drink: true, toilet: true };
  it('bottleneck from the worst tile or the view list; crowded at 25 % busy or worse', () => {
    expect(crowdConditionsOf(hood(3, 'A', { worst: severe(3) }), view([]), open)).toEqual(['bottleneck']);
    expect(crowdConditionsOf(hood(3, 'A'), view([], [severe(3)]), open)).toEqual(['bottleneck']);
    expect(crowdConditionsOf(hood(3, 'A'), view([], [severe(4)]), open)).toEqual([]);
    expect(crowdConditionsOf(hood(3, 'A', {}, { bands: [15, 0, 4, 1] }), view([]), open)).toEqual(['crowded']);
    expect(crowdConditionsOf(hood(3, 'A', {}, { bands: [16, 0, 3, 1] }), view([]), open)).toEqual([]);
  });

  it('coverage only with enough guests and an open service of that kind elsewhere', () => {
    const none = { food: 0, drink: 0, toilet: 0 };
    expect(crowdConditionsOf(hood(3, 'A', {}, { guests: 5, coverage: none }), view([]), open)).toEqual(['noToilet', 'noFood', 'noDrink']);
    expect(crowdConditionsOf(hood(3, 'A', {}, { guests: 4, coverage: none }), view([]), open)).toEqual([]);
    expect(crowdConditionsOf(hood(3, 'A', {}, { guests: 9, coverage: none }), view([]), { food: false, drink: true, toilet: false })).toEqual(['noDrink']);
  });

  it('unhappy below 50 with at least 10 guests; litter from 5 items', () => {
    expect(crowdConditionsOf(hood(3, 'A', {}, { guests: 10, happiness: 49 }), view([]), open)).toEqual(['unhappy']);
    expect(crowdConditionsOf(hood(3, 'A', {}, { guests: 9, happiness: 10 }), view([]), open)).toEqual([]);
    expect(crowdConditionsOf(hood(3, 'A', {}, { guests: 10, happiness: 50 }), view([]), open)).toEqual([]);
    expect(crowdConditionsOf(hood(3, 'A', {}, { litter: 5 }), view([]), open)).toEqual(['litter']);
    expect(crowdConditionsOf(hood(3, 'A', {}, { litter: 4 }), view([]), open)).toEqual([]);
  });

  it('Phase 49: litter while the cleaners are swamped is the "outpaces" line instead, held as long as litter', () => {
    expect(crowdConditionsOf(hood(3, 'A', {}, { litter: 5 }), view([]), open, true)).toEqual(['litterOutpaces']);
    expect(crowdConditionsOf(hood(3, 'A', {}, { litter: 4 }), view([]), open, true)).toEqual([]);
    expect(crowdHoldTicks('litterOutpaces')).toBe(crowdHoldTicks('litter'));
    const v = view([hood(3, 'Garden Loop', {}, { litter: 9 })]);
    let step = stepCrowdNotice(INITIAL_CROWD_NOTICE, { tick: 0, view: v, cleanersSwamped: true });
    for (let tick = TPS; tick <= crowdHoldTicks('litterOutpaces'); tick += TPS) {
      step = stepCrowdNotice(step.state, { tick, view: v, cleanersSwamped: true });
    }
    expect(step.active).toEqual([{ key: 3, name: 'Garden Loop', kind: 'litterOutpaces' }]);
    expect(CROWD_NOTICE_PRIORITY.indexOf('litterOutpaces')).toBe(CROWD_NOTICE_PRIORITY.indexOf('litter') - 1);
  });
});

describe('stepCrowdNotice: hold and release in simulation time', () => {
  it('hold times: 10 s for bottleneck, crowded and coverage; 20 s for unhappy and litter; release 20 s', () => {
    expect(crowdHoldTicks('bottleneck')).toBe(10 * TPS);
    expect(crowdHoldTicks('noFood')).toBe(10 * TPS);
    expect(crowdHoldTicks('unhappy')).toBe(20 * TPS);
    expect(crowdHoldTicks('litter')).toBe(20 * TPS);
    expect(crowdReleaseTicks()).toBe(20 * TPS);
  });

  it('a bottleneck turns on after 10 s, not before, and stays on through a short gap', () => {
    const jam = view([hood(3, 'Clover Corner', { worst: severe(3) })]);
    const calm = view([hood(3, 'Clover Corner')]);
    expect(run(INITIAL_CROWD_NOTICE, jam, 0, 9 * TPS).active).toEqual([]);
    const on = run(INITIAL_CROWD_NOTICE, jam, 0, 10 * TPS);
    expect(on.active).toEqual([{ key: 3, name: 'Clover Corner', kind: 'bottleneck' }]);
    // 19 s without: still on; 20 s without: off.
    expect(run(on.state, calm, 11 * TPS, 29 * TPS).active).toHaveLength(1);
    expect(run(on.state, calm, 11 * TPS, 30 * TPS).active).toEqual([]);
    // Back inside the window: kept on, and the release clock restarts from the last sighting.
    const back = run(run(on.state, calm, 11 * TPS, 25 * TPS).state, jam, 26 * TPS, 26 * TPS);
    expect(back.active).toHaveLength(1);
    expect(run(back.state, calm, 27 * TPS, 45 * TPS).active).toHaveLength(1);
  });

  it('a broken stretch restarts the hold', () => {
    const jam = view([hood(3, 'A', { worst: severe(3) })]);
    const calm = view([hood(3, 'A')]);
    let step = run(INITIAL_CROWD_NOTICE, jam, 0, 8 * TPS);
    step = stepCrowdNotice(step.state, { tick: 9 * TPS, view: calm });
    expect(run(step.state, jam, 10 * TPS, 18 * TPS).active).toEqual([]);
    expect(run(step.state, jam, 10 * TPS, 20 * TPS).active).toHaveLength(1);
  });

  it('a paused park (same tick) never advances the hold', () => {
    const jam = view([hood(3, 'A', { worst: severe(3) })]);
    let step = stepCrowdNotice(INITIAL_CROWD_NOTICE, { tick: 100, view: jam });
    for (let i = 0; i < 500; i += 1) step = stepCrowdNotice(step.state, { tick: 100, view: jam });
    expect(step.active).toEqual([]);
  });

  it('orders by priority, then gate first and key ascending; the first is the Pulse line', () => {
    const v = view([
      hood(0, 'Meadow Gate', {}, { litter: 9 }),
      hood(3, 'Clover Corner', {}, { guests: 12, happiness: 30, litter: 6 }),
      hood(8, 'Willow Row', { worst: severe(8) }, { bands: [10, 0, 6, 4] }),
    ]);
    const step = run(INITIAL_CROWD_NOTICE, v, 0, 20 * TPS);
    expect(step.active.map((line) => `${line.kind}:${line.key}`)).toEqual([
      'bottleneck:8', 'crowded:8', 'unhappy:3', 'litter:0', 'litter:3',
    ]);
    expect(CROWD_NOTICE_PRIORITY[0]).toBe('bottleneck');
  });

  it('a neighborhood that is gone drops its lines at once; a null view clears all', () => {
    const v = view([hood(3, 'A', { worst: severe(3) }), hood(5, 'B', { worst: severe(5) })]);
    const on = run(INITIAL_CROWD_NOTICE, v, 0, 10 * TPS);
    expect(on.active).toHaveLength(2);
    expect(stepCrowdNotice(on.state, { tick: 11 * TPS, view: view([hood(5, 'B', { worst: severe(5) })]) }).active.map((l) => l.key)).toEqual([5]);
    expect(stepCrowdNotice(on.state, { tick: 11 * TPS, view: null }).active).toEqual([]);
  });

  it('a rewind (tick going backwards) restarts every stretch; the initial state is reusable (session swap)', () => {
    const jam = view([hood(3, 'A', { worst: severe(3) })]);
    const on = run(INITIAL_CROWD_NOTICE, jam, 1_000, 1_000 + 10 * TPS);
    expect(on.active).toHaveLength(1);
    expect(stepCrowdNotice(on.state, { tick: 500, view: jam }).active).toEqual([]);
    expect(INITIAL_CROWD_NOTICE.entries.size).toBe(0);
  });

  it('the name follows the current view (a renamed neighborhood keeps its line)', () => {
    const on = run(INITIAL_CROWD_NOTICE, view([hood(3, 'Old', { worst: severe(3) })]), 0, 10 * TPS);
    const next = stepCrowdNotice(on.state, { tick: 11 * TPS, view: view([hood(3, 'New', { worst: severe(3) })]) });
    expect(next.active[0].name).toBe('New');
  });

  it('coverage uses the open-service counts when given, else any neighborhood that has the kind', () => {
    const none = { food: 0, drink: 0, toilet: 0 };
    const lonely = view([hood(3, 'A', {}, { guests: 8, coverage: none })]);
    expect(run(INITIAL_CROWD_NOTICE, lonely, 0, 10 * TPS).active).toEqual([]);
    const counted = (() => {
      let step = stepCrowdNotice(INITIAL_CROWD_NOTICE, { tick: 0, view: lonely, openServices: { food: 1, drink: 0, toilet: 0 } });
      for (let t = TPS; t <= 10 * TPS; t += TPS) step = stepCrowdNotice(step.state, { tick: t, view: lonely, openServices: { food: 1, drink: 0, toilet: 0 } });
      return step;
    })();
    expect(counted.active.map((line) => line.kind)).toEqual(['noFood']);
    // The view's own counts (ParkSession.crowdView fills them) are the default.
    const withCounts = { ...lonely, openServices: { food: 0, drink: 2, toilet: 0 } };
    expect(run(INITIAL_CROWD_NOTICE, withCounts, 0, 10 * TPS).active.map((line) => line.kind)).toEqual(['noDrink']);
    const pair = view([hood(3, 'A', {}, { guests: 8, coverage: none }), hood(5, 'B', {}, { coverage: { food: 0, drink: 0, toilet: 0.5 } })]);
    expect(run(INITIAL_CROWD_NOTICE, pair, 0, 10 * TPS).active.map((line) => `${line.kind}:${line.key}`)).toEqual(['noToilet:3']);
  });
});
