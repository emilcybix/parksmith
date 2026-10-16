import type { ServiceKind } from '../shops/types';

/**
 * The First Day progression: a short ladder of real accomplishments that teaches a new sandbox
 * park its loop. Every step is decided by simulation data, never by a click, and the whole thing is
 * advisory: nothing here can refuse or delay a build.
 */

export type OnboardingStepId =
  | 'lay-path'
  | 'first-ride'
  | 'set-price'
  | 'first-rider'
  | 'first-food'
  | 'first-drink'
  | 'guest-target'
  | 'first-profit'
  | 'fix-problem'
  | 'good-rating';

export interface OnboardingStepDefinition {
  id: OnboardingStepId;
  title: string;
  /** One imperative sentence shown while the step is current. */
  hint: string;
  /** Player-facing sentence for the stored evidence value ("52 guests have visited"). */
  evidenceLabel(value: number): string;
}

/** One live ride, as the steps see it. `open` is deliberately absent: a closed ride changes nothing. */
export interface OnboardingRideInput {
  objectId: number;
  /** The ride's access side touches a path that is flood-connected to the entrance. */
  connected: boolean;
  ticketPrice: number;
  /** The price a freshly built ride of this kind starts at. */
  defaultTicketPrice: number;
  /** Lifetime completed rides with a rider (RideRuntime.satisfactionCount). */
  satisfactionCount: number;
  repairsCompleted: number;
}

export interface OnboardingServiceInput {
  objectId: number;
  kind: ServiceKind;
  connected: boolean;
}

/**
 * Plain, read-only snapshot of everything the steps read. Built by `collectOnboardingInput` from the
 * live simulations; the evidence functions are pure over it, so they test without a session.
 */
export interface OnboardingInput {
  tick: number;
  /** Path tiles flood-connected to the entrance, the entrance tile itself excluded. */
  connectedPathTiles: number;
  rides: readonly OnboardingRideInput[];
  services: readonly OnboardingServiceInput[];
  /** Cumulative guests who entered the park (GuestSimulation.totalArrivals). */
  totalArrivals: number;
  /** Operating profit of the finance report: revenue minus running costs, construction excluded. */
  operatingProfit: number;
  litterUnits: number;
  /** Cleaners currently employed. */
  cleaners: number;
  parkRating: number;
}

/** Latches the steps own besides their completion list. */
export interface OnboardingFlags {
  /** Litter of at least `LITTER_SEEN_UNITS` was seen at some evaluation; never cleared. */
  sawLitter: boolean;
}

export type OnboardingStepStatus = 'done' | 'skipped' | 'current' | 'upcoming';

export interface OnboardingStepSnapshot {
  id: OnboardingStepId;
  title: string;
  hint: string;
  status: OnboardingStepStatus;
  /** Sentence describing what completed the step, or null while it is not done. */
  evidence: string | null;
  completedAtTick: number | null;
}

export interface OnboardingSnapshot {
  /** Sandbox park, not dismissed, and at least one step neither done nor skipped. */
  active: boolean;
  dismissed: boolean;
  currentStepId: OnboardingStepId | null;
  completedCount: number;
  totalCount: number;
  steps: OnboardingStepSnapshot[];
}
