import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS } from '../game/onboarding/content';
import { OnboardingTracker } from '../game/onboarding/OnboardingTracker';
import type { OnboardingSnapshot, OnboardingStepId } from '../game/onboarding/types';
import {
  composeAnnouncement,
  describeFirstDay,
  dockTabWording,
  inspectorBesidePulse,
  EMPTY_CELEBRATION,
  nextCelebration,
  type CelebrationState,
} from './firstDayModel';

const trackerWith = (done: readonly OnboardingStepId[], skipped: readonly OnboardingStepId[] = []): OnboardingTracker => {
  const tracker = new OnboardingTracker();
  tracker.restore({
    dismissed: false,
    completed: done.map((id, index) => ({ id, tick: index, evidence: 1 })),
    skipped: [...skipped],
    sawLitter: false,
  });
  return tracker;
};
const snap = (done: readonly OnboardingStepId[] = [], skipped: readonly OnboardingStepId[] = []): OnboardingSnapshot =>
  trackerWith(done, skipped).snapshot();
const ALL = ONBOARDING_STEPS.map((step) => step.id);

describe('describeFirstDay', () => {
  it('is hidden without a tracker and once the hints are dismissed', () => {
    expect(describeFirstDay(null)).toEqual({ mode: 'hidden' });
    const tracker = new OnboardingTracker();
    tracker.dismissAll();
    expect(describeFirstDay(tracker.snapshot())).toEqual({ mode: 'hidden' });
  });

  it.each(ONBOARDING_STEPS.map((step, index) => [step.id, index] as const))(
    'shows %s as the current step with its own title and hint',
    (id, index) => {
      const view = describeFirstDay(snap(ALL.slice(0, index)));
      if (view.mode !== 'step') throw new Error('expected a step view');
      const definition = ONBOARDING_STEPS[index];
      expect(view.stepId).toBe(id);
      expect(view.title).toBe(definition.title);
      expect(view.hint).toBe(dockTabWording(definition.hint));
      // Phase 33: the card names the build tab as the dock does (Shops, once Treats).
      expect(view.hint).not.toMatch(/\bTreats\b/);
      expect(view.progressText).toBe(`${index} of ${ALL.length} done`);
      expect(view.canSkip).toBe(true);
      expect(view.pips).toHaveLength(ALL.length);
      expect(view.pips[index]).toBe('current');
      expect(view.pips.slice(0, index).every((pip) => pip === 'done')).toBe(true);
      expect(view.announcement).toContain(definition.title);
    },
  );

  it('counts done steps rather than the position, since steps latch in any order', () => {
    const view = describeFirstDay(snap(['guest-target', 'first-profit']));
    if (view.mode !== 'step') throw new Error('expected a step view');
    expect(view.stepId).toBe('lay-path');
    expect(view.progressText).toBe('2 of 10 done');
  });

  it('names skipped steps in words and marks them in the pips', () => {
    const view = describeFirstDay(snap([], ['lay-path']));
    if (view.mode !== 'step') throw new Error('expected a step view');
    expect(view.skippedText).toBe('1 skipped');
    expect(view.pips[0]).toBe('skipped');
    expect(view.stepId).toBe('first-ride');
    const none = describeFirstDay(snap());
    if (none.mode !== 'step') throw new Error('expected a step view');
    expect(none.skippedText).toBeNull();
  });

  it('finishes when every step is done, or done and skipped', () => {
    const complete = describeFirstDay(snap(ALL));
    if (complete.mode !== 'finished') throw new Error('expected finished');
    expect(complete.headline).toBe('First Day complete');
    expect(complete.progressText).toBe('10 of 10 done');
    const wrapped = describeFirstDay(snap(ALL.slice(0, 9), ['good-rating']));
    if (wrapped.mode !== 'finished') throw new Error('expected finished');
    expect(wrapped.headline).toBe('First Day wrapped up');
    expect(wrapped.skippedText).toBe('1 skipped');
  });

  it('skipping the last open step finishes the card', () => {
    const tracker = trackerWith(ALL.slice(0, 9));
    expect(describeFirstDay(tracker.snapshot()).mode).toBe('step');
    tracker.skipCurrent();
    expect(describeFirstDay(tracker.snapshot()).mode).toBe('finished');
  });
});

describe('nextCelebration', () => {
  const run = (state: CelebrationState, snapshot: OnboardingSnapshot, epoch = 1, canShow = true) =>
    nextCelebration(state, snapshot, epoch, canShow);

  it('seeds silently on the first snapshot of an epoch, even with steps already done', () => {
    const first = run(EMPTY_CELEBRATION, snap(['lay-path', 'first-ride']));
    expect(first.celebrate).toBeNull();
    expect(first.state.seen).toEqual(['lay-path', 'first-ride']);
  });

  it('celebrates a newly done step once', () => {
    const seeded = run(EMPTY_CELEBRATION, snap()).state;
    const done = run(seeded, snap(['lay-path']));
    expect(done.celebrate).toEqual({ stepId: 'lay-path', title: 'Lay a path' });
    expect(run(done.state, snap(['lay-path'])).celebrate).toBeNull();
  });

  it('does not celebrate a step again after an undo rewound it and it was redone', () => {
    let state = run(EMPTY_CELEBRATION, snap()).state;
    state = run(state, snap(['lay-path'])).state;
    state = run(state, snap()).state;
    expect(run(state, snap(['lay-path'])).celebrate).toBeNull();
  });

  it('re-seeds for a new epoch, so a new park or a load never celebrates old progress', () => {
    const state = run(EMPTY_CELEBRATION, snap()).state;
    const other = run(state, snap(['lay-path', 'first-ride', 'set-price']), 2);
    expect(other.celebrate).toBeNull();
    expect(other.state.epoch).toBe(2);
    expect(run(other.state, snap(['lay-path', 'first-ride', 'set-price', 'first-rider']), 2).celebrate?.stepId)
      .toBe('first-rider');
  });

  it('hands out two steps that latched together one after the other, in catalog order', () => {
    const state = run(EMPTY_CELEBRATION, snap()).state;
    const both = snap(['first-ride', 'lay-path']);
    const first = run(state, both);
    expect(first.celebrate?.stepId).toBe('lay-path');
    const second = run(first.state, both);
    expect(second.celebrate?.stepId).toBe('first-ride');
    expect(run(second.state, both).celebrate).toBeNull();
  });

  it('queues but does not hand out while a row is on screen', () => {
    const state = run(EMPTY_CELEBRATION, snap()).state;
    const waiting = run(state, snap(['lay-path']), 1, false);
    expect(waiting.celebrate).toBeNull();
    expect(run(waiting.state, snap(['lay-path']), 1, true).celebrate?.stepId).toBe('lay-path');
  });

  it('keeps the same state object when nothing changed, and ignores a null snapshot', () => {
    const seeded = run(EMPTY_CELEBRATION, snap(['lay-path'])).state;
    expect(run(seeded, snap(['lay-path'])).state).toBe(seeded);
    expect(nextCelebration(seeded, null, 1).state).toBe(seeded);
  });
});

describe('composeAnnouncement', () => {
  it('puts the done step before what is next, and is empty when hidden', () => {
    const view = describeFirstDay(snap(['lay-path']));
    expect(composeAnnouncement(view, { stepId: 'lay-path', title: 'Lay a path' }))
      .toMatch(/^Step done: Lay a path\. Next: Build a ride by the path\./);
    expect(composeAnnouncement(view, null)).toMatch(/^Next: /);
    expect(composeAnnouncement({ mode: 'hidden' }, null)).toBe('');
  });
});

describe('inspectorBesidePulse', () => {
  it('steps aside while the card or the map offer is showing, and only then', () => {
    const active = trackerWith([]).snapshot();
    expect(inspectorBesidePulse(active, false)).toBe(true);
    expect(inspectorBesidePulse(null, false)).toBe(false);
    expect(inspectorBesidePulse(null, true)).toBe(true);
    const dismissed = new OnboardingTracker();
    dismissed.dismissAll();
    expect(inspectorBesidePulse(dismissed.snapshot(), false)).toBe(false);
  });
});

describe('Phase 33: the Shops tab in the First Day hints', () => {
  it('names the tab Shops while the shipped (pinned) step text keeps its old word', () => {
    expect(ONBOARDING_STEPS.some((step) => /\bTreats\b/.test(step.hint))).toBe(true);
    expect(dockTabWording('From Treats, place a Picnic Pocket.')).toBe('From Shops, place a Picnic Pocket.');
    expect(dockTabWording('cold treats sell')).toBe('cold treats sell');
  });
});

describe('Phase 40: the First Day stall steps name the front', () => {
  it('says front instead of side for the food and drink steps', () => {
    expect(dockTabWording('From Treats, place a Picnic Pocket or Glacier Scoop (food) with a side on the path.'))
      .toBe('From Shops, place a Picnic Pocket or Glacier Scoop (food) with its front on the path.');
    expect(dockTabWording('Place a Fizz Foundry or Lemon Light (drinks) beside the path, from Treats.'))
      .toBe('Place a Fizz Foundry or Lemon Light (drinks) facing the path, from Shops.');
    expect(dockTabWording('Pick Rides and place one so a side touches your path.')).toBe('Pick Rides and place one so a side touches your path.');
  });
});
