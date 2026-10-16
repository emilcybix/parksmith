import { describe, expect, it } from 'vitest';
import { MAXIMUM_FOCUS_CELLS, onboardingFocusCells, type FocusProbe } from './focus';
import type { OnboardingStepId } from './types';

const GATE = { x: 15, y: 31 };
const TIP = { x: 15, y: 25 };

const probe = (overrides: Partial<FocusProbe> = {}): FocusProbe => ({
  entrance: GATE,
  connectedPathTiles: 4,
  connectedTip: TIP,
  unconnectedRide: () => null,
  defaultPricedRide: () => null,
  worstLitter: () => null,
  brokenRide: () => null,
  ...overrides,
});

describe('onboardingFocusCells', () => {
  it('points lay-path at the tip, or at the gate while no path is joined to it', () => {
    expect(onboardingFocusCells('lay-path', probe())).toEqual([TIP]);
    expect(onboardingFocusCells('lay-path', probe({ connectedPathTiles: 0, connectedTip: null }))).toEqual([GATE]);
  });

  it('points first-ride at a stranded ride before the tip', () => {
    const ride = [{ x: 3, y: 3 }, { x: 4, y: 3 }];
    expect(onboardingFocusCells('first-ride', probe({ unconnectedRide: () => ride }))).toEqual(ride);
    expect(onboardingFocusCells('first-ride', probe())).toEqual([TIP]);
    expect(onboardingFocusCells('first-ride', probe({ connectedPathTiles: 0, connectedTip: null }))).toEqual([GATE]);
  });

  it('points set-price at the default-priced connected ride, and nowhere without one', () => {
    const ride = [{ x: 9, y: 9 }];
    expect(onboardingFocusCells('set-price', probe({ defaultPricedRide: () => ride }))).toEqual(ride);
    expect(onboardingFocusCells('set-price', probe())).toEqual([]);
  });

  it('points the two stall steps at the tip', () => {
    expect(onboardingFocusCells('first-food', probe())).toEqual([TIP]);
    expect(onboardingFocusCells('first-drink', probe())).toEqual([TIP]);
  });

  it('prefers litter, then a broken ride, for fix-problem', () => {
    const broken = [{ x: 7, y: 7 }];
    expect(onboardingFocusCells('fix-problem', probe({ worstLitter: () => ({ x: 2, y: 2 }), brokenRide: () => broken })))
      .toEqual([{ x: 2, y: 2 }]);
    expect(onboardingFocusCells('fix-problem', probe({ brokenRide: () => broken }))).toEqual(broken);
    expect(onboardingFocusCells('fix-problem', probe())).toEqual([]);
  });

  it.each<OnboardingStepId | null>(['first-rider', 'guest-target', 'first-profit', 'good-rating', null])(
    'marks nothing for %s',
    (stepId) => {
      expect(onboardingFocusCells(stepId, probe({ worstLitter: () => ({ x: 1, y: 1 }) }))).toEqual([]);
    },
  );

  it('caps a malformed footprint', () => {
    const huge = Array.from({ length: 40 }, (_, index) => ({ x: index, y: 0 }));
    expect(onboardingFocusCells('set-price', probe({ defaultPricedRide: () => huge }))).toHaveLength(MAXIMUM_FOCUS_CELLS);
  });
});
