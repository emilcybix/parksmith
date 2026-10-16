import type { Cell } from '../types';
import type { OnboardingStepId } from './types';

/** Most cells a single marker may name, so a malformed footprint cannot build a huge overlay. */
export const MAXIMUM_FOCUS_CELLS = 9;

/**
 * What the focus lookup may ask of the live park. A small interface, built by
 * `ParkSession.onboardingFocus()` from the simulations, so the per-step choice below is pure and
 * tests with a fake.
 */
export interface FocusProbe {
  entrance: Cell;
  connectedPathTiles: number;
  /** A farthest tile of the entrance flood fill; null while no path is joined to the gate. */
  connectedTip: Cell | null;
  /** Footprint of the first ride that is not joined to the entrance path. */
  unconnectedRide(): readonly Cell[] | null;
  /** Footprint of the first connected ride whose ticket is still the default. */
  defaultPricedRide(): readonly Cell[] | null;
  /** The litter pile with the most units; ties go to the lowest y, then x. */
  worstLitter(): Cell | null;
  brokenRide(): readonly Cell[] | null;
}

const tipOrGate = (probe: FocusProbe): readonly Cell[] => [probe.connectedTip ?? probe.entrance];

const cap = (cells: readonly Cell[] | null): readonly Cell[] => (
  cells === null ? [] : cells.slice(0, MAXIMUM_FOCUS_CELLS)
);

/**
 * The cells a hint should point at for one step: a single cell or one footprint, at most nine, or
 * none when the step is about waiting or a number. Read-only advice for the renderers.
 */
export const onboardingFocusCells = (stepId: OnboardingStepId | null, probe: FocusProbe): readonly Cell[] => {
  switch (stepId) {
    case 'lay-path':
      return cap(probe.connectedPathTiles > 0 ? tipOrGate(probe) : [probe.entrance]);
    case 'first-ride': {
      const stranded = probe.unconnectedRide();
      return cap(stranded && stranded.length > 0 ? stranded : tipOrGate(probe));
    }
    case 'set-price':
      return cap(probe.defaultPricedRide());
    case 'first-food':
    case 'first-drink':
      return cap(tipOrGate(probe));
    case 'fix-problem': {
      const litter = probe.worstLitter();
      if (litter) return [litter];
      return cap(probe.brokenRide());
    }
    default:
      return [];
  }
};
