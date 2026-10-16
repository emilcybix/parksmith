import { describe, expect, it } from 'vitest';
import { OnboardingTracker } from '../../game/onboarding/OnboardingTracker';
import { ONBOARDING_STEPS } from '../../game/onboarding/content';
import type { OnboardingStepId } from '../../game/onboarding/types';
import { INPUT_CONTEXT_CAPABILITIES, type InputContext } from '../../ui/inputContext';
import { hintMarkerKey, selectHintMarkers, type HintMarkerInput } from './hintMarkers';

const snapshotAt = (stepIndex: number) => {
  const tracker = new OnboardingTracker();
  for (const step of ONBOARDING_STEPS.slice(0, stepIndex)) tracker.skipStep(step.id);
  return tracker.snapshot();
};

const CELLS = [{ x: 4, y: 5 }, { x: 5, y: 5 }];
const base = (overrides: Partial<HintMarkerInput> = {}): HintMarkerInput => ({
  onboarding: snapshotAt(0),
  focusCells: CELLS,
  cleanView: false,
  context: 'world',
  rideSelected: false,
  ...overrides,
});

describe('selectHintMarkers', () => {
  it('returns one marker with the focus cells while a hint is live', () => {
    expect(selectHintMarkers(base())).toEqual([{ cells: CELLS }]);
  });

  it('is off without a tracker', () => {
    expect(selectHintMarkers(base({ onboarding: null }))).toEqual([]);
  });

  it('is off once dismissed', () => {
    const tracker = new OnboardingTracker();
    tracker.dismissAll();
    expect(selectHintMarkers(base({ onboarding: tracker.snapshot() }))).toEqual([]);
  });

  it('is off when every step is done or skipped', () => {
    expect(selectHintMarkers(base({ onboarding: snapshotAt(ONBOARDING_STEPS.length) }))).toEqual([]);
  });

  it('is off in clean view', () => {
    expect(selectHintMarkers(base({ cleanView: true }))).toEqual([]);
  });

  it('is off behind every context that blocks both build and view, and on elsewhere', () => {
    for (const [name, capabilities] of Object.entries(INPUT_CONTEXT_CAPABILITIES)) {
      const markers = selectHintMarkers(base({ context: name as InputContext }));
      expect(markers.length > 0, name).toBe(capabilities.build || capabilities.view);
    }
    expect(selectHintMarkers(base({ context: 'management' }))).toHaveLength(1);
    expect(selectHintMarkers(base({ context: 'inspector' }))).toHaveLength(1);
  });

  it('is off for the price step while a ride is selected, but not for other steps', () => {
    const priceIndex = ONBOARDING_STEPS.findIndex((step) => step.id === ('set-price' as OnboardingStepId));
    expect(selectHintMarkers(base({ onboarding: snapshotAt(priceIndex), rideSelected: true }))).toEqual([]);
    expect(selectHintMarkers(base({ onboarding: snapshotAt(priceIndex), rideSelected: false }))).toHaveLength(1);
    expect(selectHintMarkers(base({ rideSelected: true }))).toHaveLength(1);
  });

  it('is off when there is nothing to point at', () => {
    expect(selectHintMarkers(base({ focusCells: [] }))).toEqual([]);
  });

  it('copies the cells so later changes to the input cannot reach a renderer', () => {
    const [marker] = selectHintMarkers(base());
    expect(marker.cells[0]).not.toBe(CELLS[0]);
  });
});

describe('hintMarkerKey', () => {
  it('is equal for equal cells and different otherwise', () => {
    const a = selectHintMarkers(base());
    const b = selectHintMarkers(base({ focusCells: [{ x: 4, y: 5 }, { x: 5, y: 5 }] }));
    const c = selectHintMarkers(base({ focusCells: [{ x: 4, y: 5 }] }));
    expect(hintMarkerKey(a)).toBe(hintMarkerKey(b));
    expect(hintMarkerKey(a)).not.toBe(hintMarkerKey(c));
    expect(hintMarkerKey([])).toBe('');
  });
});
