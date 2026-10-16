import { describe, expect, it } from 'vitest';
import { OnboardingTracker } from '../game/onboarding/OnboardingTracker';
import { ONBOARDING_STEPS } from '../game/onboarding/content';
import { freshInput } from '../game/onboarding/testInput';
import { isParkStable, shouldOfferMap } from './firstRun';

const trackerWith = (done: readonly string[]): OnboardingTracker => {
  const tracker = new OnboardingTracker();
  tracker.restore({
    dismissed: false,
    completed: done.map((id, index) => ({ id: id as never, tick: index, evidence: 1 })),
    skipped: [],
    sawLitter: false,
  });
  return tracker;
};

describe('isParkStable', () => {
  it('is false without a tracker and for a fresh park', () => {
    expect(isParkStable(null)).toBe(false);
    const tracker = new OnboardingTracker();
    tracker.step(freshInput());
    expect(isParkStable(tracker.snapshot())).toBe(false);
  });

  it('is true once Fix a problem is done, even with other steps open', () => {
    expect(isParkStable(trackerWith(['fix-problem']).snapshot())).toBe(true);
  });

  it('is true when every step is done or skipped, and false once the hints were dismissed', () => {
    const tracker = new OnboardingTracker();
    for (const step of ONBOARDING_STEPS) tracker.skipStep(step.id);
    expect(isParkStable(tracker.snapshot())).toBe(true);
    tracker.dismissAll();
    expect(isParkStable(tracker.snapshot())).toBe(false);
    const dismissedEarly = trackerWith(['fix-problem']);
    dismissedEarly.dismissAll();
    expect(isParkStable(dismissedEarly.snapshot())).toBe(false);
  });
});

describe('shouldOfferMap', () => {
  const stable = trackerWith(['fix-problem']).snapshot();
  const input = { snapshot: stable, offered: false, isSandbox: true, pending: false };

  it('offers once in a stable sandbox park', () => {
    expect(shouldOfferMap(input)).toBe(true);
  });

  it.each([
    ['already offered', { offered: true }],
    ['already pending', { pending: true }],
    ['a scenario park', { isSandbox: false }],
    ['an unstable park', { snapshot: new OnboardingTracker().snapshot() }],
    ['no tracker', { snapshot: null }],
  ])('does not offer for %s', (_name, override) => {
    expect(shouldOfferMap({ ...input, ...override })).toBe(false);
  });
});
