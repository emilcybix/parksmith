import type { OnboardingSnapshot } from '../../game/onboarding/types';
import type { Cell } from '../../game/types';
import type { HintMarker } from '../../rendering/RendererPort';
import { INPUT_CONTEXT_CAPABILITIES, type InputContext } from '../../ui/inputContext';

export interface HintMarkerInput {
  onboarding: OnboardingSnapshot | null;
  /** From `ParkSession.onboardingFocus()`: the cells the current step points at. */
  focusCells: readonly Cell[];
  cleanView: boolean;
  /** The active input context, so a marker never shows behind a modal. */
  context: InputContext;
  /** A ride is selected (its inspector is open). */
  rideSelected: boolean;
}

const NO_MARKERS: readonly HintMarker[] = [];

/**
 * Which world markers the First Day hints want on screen right now. Everything that switches them
 * off lives here, in one pure place: no hints, dismissed or finished, clean view, a modal on top
 * (both build and view off), the price hint while the ride's inspector is already open, and a step
 * with nothing to point at.
 */
export const selectHintMarkers = (input: HintMarkerInput): readonly HintMarker[] => {
  const { onboarding } = input;
  if (onboarding === null || onboarding.dismissed || !onboarding.active || onboarding.currentStepId === null) {
    return NO_MARKERS;
  }
  if (input.cleanView) return NO_MARKERS;
  const capabilities = INPUT_CONTEXT_CAPABILITIES[input.context];
  if (!capabilities.build && !capabilities.view) return NO_MARKERS;
  if (onboarding.currentStepId === 'set-price' && input.rideSelected) return NO_MARKERS;
  if (input.focusCells.length === 0) return NO_MARKERS;
  return [{ cells: input.focusCells.map((cell) => ({ x: cell.x, y: cell.y })) }];
};

/** Change detection: equal markers give equal keys, so a renderer is only told when something moved. */
export const hintMarkerKey = (markers: readonly HintMarker[]): string => (
  markers.map((marker) => marker.cells.map((cell) => `${cell.x},${cell.y}`).join(';')).join('|')
);
