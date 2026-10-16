import type { OnboardingSnapshot } from '../game/onboarding/types';

/**
 * Phase 23 first-run decision: a brand-new profile keeps landing in the Sandbox First Day park (the boot skips the start
 * menu, as in Phase 13) and nothing opens by itself. The Park Tour map that used to open over it is gone; its one-time
 * offer became the Map offer below. First Day's engine and save invariants are Sandbox-only, so level 1 of a run is not
 * where a tutorial lives.
 */

/**
 * "Stable" sandbox park: the Fix a problem step is done (profit and guests normally came first),
 * or every step is done or skipped. Hints the player dismissed never count.
 */
export const isParkStable = (snapshot: OnboardingSnapshot | null): boolean => {
  if (snapshot === null || snapshot.dismissed) return false;
  if (snapshot.steps.find((step) => step.id === 'fix-problem')?.status === 'done') return true;
  return !snapshot.active;
};

export interface MapOfferInput {
  snapshot: OnboardingSnapshot | null;
  /** The profile's `ui.tourOffered` flag (kept under its Phase 8C name: "the one-time offer was answered"). */
  offered: boolean;
  isSandbox: boolean;
  pending: boolean;
}

/** "Ready for The Map?" is shown once, in a stable sandbox park. */
export const shouldOfferMap = (input: MapOfferInput): boolean => (
  input.isSandbox && !input.offered && !input.pending && isParkStable(input.snapshot)
);
