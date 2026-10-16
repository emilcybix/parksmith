import { describe, expect, it } from 'vitest';
import { ARRIVAL_TARGET, LITTER_SEEN_UNITS, ONBOARDING_STEPS, PATH_TILE_TARGET } from './content';
import { OnboardingTracker } from './OnboardingTracker';
import { freshInput, rideInput, serviceInput } from './testInput';
import type { OnboardingInput } from './types';

const idsOf = (tracker: OnboardingTracker): string[] => tracker.serialize().completed.map((entry) => entry.id);

/** An input that satisfies every step at once. */
const everything = (tick = 100): OnboardingInput => freshInput({
  tick,
  connectedPathTiles: 12,
  rides: [rideInput({ ticketPrice: 6, satisfactionCount: 3, repairsCompleted: 1 })],
  services: [serviceInput({ objectId: 2, kind: 'food' }), serviceInput({ objectId: 3, kind: 'drink' })],
  totalArrivals: 90,
  operatingProfit: 400,
  parkRating: 75,
});

describe('step', () => {
  it('latches nothing on a fresh park', () => {
    const tracker = new OnboardingTracker();
    tracker.step(freshInput());
    expect(idsOf(tracker)).toEqual([]);
    expect(tracker.snapshot().completedCount).toBe(0);
  });

  it('latches independently and in any order, storing the tick and the evidence', () => {
    const tracker = new OnboardingTracker();
    tracker.step(freshInput({ tick: 30, totalArrivals: ARRIVAL_TARGET + 2 }));
    tracker.step(freshInput({ tick: 40, connectedPathTiles: PATH_TILE_TARGET }));
    expect(tracker.serialize().completed).toEqual([
      { id: 'guest-target', tick: 30, evidence: ARRIVAL_TARGET + 2 },
      { id: 'lay-path', tick: 40, evidence: PATH_TILE_TARGET },
    ]);
  });

  it('is monotone: a worse input later changes nothing, and evidence stays the first observation', () => {
    const tracker = new OnboardingTracker();
    tracker.step(everything(10));
    const before = tracker.serialize();
    expect(before.completed.length).toBe(ONBOARDING_STEPS.length);
    tracker.step(freshInput({ tick: 20 }));
    tracker.step(everything(30));
    expect(tracker.serialize(), 'nothing removed, nothing rewritten').toEqual(before);
  });

  it('a step stays done after the ride is closed, demolished or the litter returns', () => {
    const tracker = new OnboardingTracker();
    tracker.step(freshInput({ tick: 10, connectedPathTiles: 8, rides: [rideInput()] }));
    expect(idsOf(tracker)).toEqual(['lay-path', 'first-ride']);
    tracker.step(freshInput({ tick: 20, connectedPathTiles: 0, rides: [] }));
    expect(idsOf(tracker), 'path bulldozed and ride demolished').toEqual(['lay-path', 'first-ride']);
  });

  it('a price put back to the default after the change stays done', () => {
    const tracker = new OnboardingTracker();
    tracker.step(freshInput({ tick: 10, rides: [rideInput({ ticketPrice: 5 })] }));
    tracker.step(freshInput({ tick: 20, rides: [rideInput({ ticketPrice: 4 })] }));
    expect(idsOf(tracker)).toContain('set-price');
  });

  it('the litter branch works across evaluations: seen, then cleaned', () => {
    const tracker = new OnboardingTracker();
    tracker.step(freshInput({ tick: 10, cleaners: 1, litterUnits: 0 }));
    expect(idsOf(tracker), 'a cleaner in a clean park proves nothing').not.toContain('fix-problem');
    tracker.step(freshInput({ tick: 20, cleaners: 1, litterUnits: LITTER_SEEN_UNITS }));
    expect(tracker.serialize().sawLitter).toBe(true);
    expect(idsOf(tracker)).not.toContain('fix-problem');
    tracker.step(freshInput({ tick: 30, cleaners: 1, litterUnits: 1 }));
    expect(idsOf(tracker)).not.toContain('fix-problem');
    tracker.step(freshInput({ tick: 40, cleaners: 1, litterUnits: 0 }));
    expect(tracker.serialize().completed.find((entry) => entry.id === 'fix-problem')).toEqual({ id: 'fix-problem', tick: 40, evidence: 0 });
  });

  it('never latches a value that could not be saved', () => {
    const tracker = new OnboardingTracker();
    tracker.step(freshInput({ operatingProfit: Number.POSITIVE_INFINITY, parkRating: Number.NaN, totalArrivals: Number.NaN }));
    expect(idsOf(tracker)).toEqual([]);
  });

  it('clamps an absurd but finite value into the saved range', () => {
    const tracker = new OnboardingTracker();
    tracker.step(freshInput({ operatingProfit: 1e300 }));
    expect(tracker.serialize().completed[0].evidence).toBe(1e12);
  });

  it('is deterministic: the same inputs give the same state, also through JSON', () => {
    const inputs = [freshInput({ tick: 10, connectedPathTiles: 7 }), everything(20), freshInput({ tick: 30 })];
    const left = new OnboardingTracker();
    const right = new OnboardingTracker();
    for (const input of inputs) { left.step(input); right.step(input); }
    expect(left.serialize()).toEqual(right.serialize());
    expect(JSON.parse(JSON.stringify(left.serialize()))).toEqual(left.serialize());
  });

  it('idles once dismissed or finished (the input is not even read)', () => {
    const dismissed = new OnboardingTracker();
    dismissed.dismissAll();
    dismissed.step(everything());
    expect(idsOf(dismissed), 'dismissed: nothing new latches').toEqual([]);

    const finished = new OnboardingTracker();
    finished.step(everything(10));
    const poison = new Proxy(freshInput(), { get() { throw new Error('input was read'); } });
    expect(() => finished.step(poison)).not.toThrow();
  });
});

describe('skipping and dismissing', () => {
  it('skipCurrent moves on to the next step and skipStep ignores done, skipped and unknown steps', () => {
    const tracker = new OnboardingTracker();
    expect(tracker.currentStepId()).toBe('lay-path');
    tracker.skipCurrent();
    expect(tracker.currentStepId()).toBe('first-ride');
    tracker.skipStep('lay-path');
    tracker.skipStep('nope' as never);
    expect(tracker.serialize().skipped).toEqual(['lay-path']);
    tracker.step(freshInput({ connectedPathTiles: 9 }));
    tracker.skipStep('lay-path');
    expect(tracker.serialize().skipped, 'already skipped, stays one entry').toEqual(['lay-path']);
    tracker.skipStep('first-rider');
    tracker.step(freshInput({ tick: 5, rides: [rideInput({ satisfactionCount: 1 })] }));
    tracker.skipStep('first-rider');
    expect(tracker.serialize().skipped, 'a done step cannot be skipped later').toEqual(['lay-path', 'first-rider']);
  });

  it('a skipped step still completes when its evidence arrives (completion wins)', () => {
    const tracker = new OnboardingTracker();
    tracker.skipStep('guest-target');
    tracker.step(freshInput({ tick: 50, totalArrivals: 60 }));
    const entry = tracker.snapshot().steps.find((step) => step.id === 'guest-target')!;
    expect(entry.status).toBe('done');
    expect(entry.completedAtTick).toBe(50);
  });

  it('dismissAll is permanent and switches the current step off', () => {
    const tracker = new OnboardingTracker();
    tracker.dismissAll();
    expect(tracker.currentStepId()).toBeNull();
    const snapshot = tracker.snapshot();
    expect(snapshot.active).toBe(false);
    expect(snapshot.dismissed).toBe(true);
    expect(snapshot.steps.some((step) => step.status === 'current')).toBe(false);
  });

  it('adoptDismissals re-applies the player choices of a newer timeline after a rewind and only ever adds', () => {
    const live = new OnboardingTracker();
    live.skipStep('lay-path');
    live.skipStep('set-price');
    live.dismissAll();
    const lateSnapshot = live.snapshot();

    const rewound = new OnboardingTracker();
    rewound.step(freshInput({ tick: 10, rides: [rideInput({ ticketPrice: 9 })] }));
    rewound.adoptDismissals(lateSnapshot);
    const state = rewound.serialize();
    expect(state.dismissed).toBe(true);
    expect(state.skipped, 'set-price completed in the restored timeline, so it is not marked skipped').toEqual(['lay-path']);
    expect(state.completed.map((entry) => entry.id)).toEqual(['first-ride', 'set-price']);

    const calm = new OnboardingTracker();
    calm.skipStep('first-ride');
    calm.adoptDismissals(new OnboardingTracker().snapshot());
    expect(calm.serialize().skipped, 'nothing is un-skipped').toEqual(['first-ride']);
    expect(calm.serialize().dismissed).toBe(false);
  });
});

describe('current-step selection and snapshot', () => {
  it('shows the first step that is neither done nor skipped', () => {
    const tracker = new OnboardingTracker();
    tracker.step(freshInput({ tick: 7, connectedPathTiles: 9, rides: [rideInput()] }));
    expect(tracker.currentStepId(), 'path and ride done, price next').toBe('set-price');
    tracker.skipStep('set-price');
    expect(tracker.currentStepId()).toBe('first-rider');
  });

  it('has no current step and is inactive once every step is done or skipped', () => {
    const tracker = new OnboardingTracker();
    tracker.step(everything(5));
    const snapshot = tracker.snapshot();
    expect(snapshot.currentStepId).toBeNull();
    expect(snapshot.active).toBe(false);
    expect(snapshot.completedCount).toBe(snapshot.totalCount);
    const mixed = new OnboardingTracker();
    for (const step of ONBOARDING_STEPS) mixed.skipStep(step.id);
    expect(mixed.snapshot().active, 'everything skipped').toBe(false);
    expect(mixed.snapshot().completedCount).toBe(0);
  });

  it('lists all steps in catalog order with a status, evidence sentence and tick', () => {
    const tracker = new OnboardingTracker();
    tracker.step(freshInput({ tick: 12, totalArrivals: 55 }));
    tracker.skipStep('first-ride');
    const snapshot = tracker.snapshot();
    expect(snapshot.steps.map((step) => step.id)).toEqual(ONBOARDING_STEPS.map((step) => step.id));
    expect(snapshot.steps.map((step) => step.status)).toEqual([
      'current', 'skipped', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'done', 'upcoming', 'upcoming', 'upcoming',
    ]);
    const done = snapshot.steps.find((step) => step.id === 'guest-target')!;
    expect(done.evidence).toBe('55 guests have visited');
    expect(done.completedAtTick).toBe(12);
    expect(snapshot.steps[0].evidence).toBeNull();
    expect(snapshot.active).toBe(true);
    expect(snapshot.totalCount).toBe(10);
  });

  it('the snapshot is a copy: mutating it never touches the tracker', () => {
    const tracker = new OnboardingTracker();
    const snapshot = tracker.snapshot();
    snapshot.steps[0].status = 'done';
    expect(tracker.snapshot().steps[0].status).toBe('current');
  });
});

describe('never blocks a build', () => {
  it('imports nothing that can build, place or refuse: only types, save plumbing and its own catalog', () => {
    const sources = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], { query: '?raw', import: 'default', eager: true });
    const source = (name: string): string => {
      expect(sources[`./${name}`], `${name} was found`).toBeTypeOf('string');
      return sources[`./${name}`] ?? '';
    };
    for (const name of ['OnboardingTracker.ts', 'evidence.ts', 'content.ts', 'types.ts']) {
      const imports = [...source(name).matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const path of imports) {
        expect(path, `${name} imports ${path}`).not.toMatch(/World|Simulation|session|GameApp/);
      }
    }
  });

  it('exposes no method that returns a verdict about building', () => {
    const methods = Object.getOwnPropertyNames(OnboardingTracker.prototype);
    expect(methods.some((name) => /canBuild|isUnlocked|allow|block|refuse/i.test(name))).toBe(false);
  });

  it('a dismissed and an active tracker never differ in what they ask of the world (they ask nothing)', () => {
    const active = new OnboardingTracker();
    const dismissed = new OnboardingTracker();
    dismissed.dismissAll();
    expect(() => { active.step(everything()); dismissed.step(everything()); }).not.toThrow();
  });
});
