import type { Cell } from '../types';

export type GuestState =
  | 'entering'
  | 'wandering'
  | 'walkingToRide'
  | 'queueing'
  | 'riding'
  | 'walkingToShop'
  | 'queueingForShop'
  | 'shopping'
  | 'usingFacility'
  | 'leaving'
  /** Phase 29: on the way to a free seat on a bench (the seat is reserved in `activity`). */
  | 'walkingToBench'
  /** Phase 29: sitting on a bench (`destinationObjectId`), getting their energy back. */
  | 'resting'
  /** Phase 29: standing still for a moment doing `activity` (admiring, cheering, being sick, ...). */
  | 'pausing';

/**
 * Phase 29: what a 'pausing' guest is doing, which seat a 'walkingToBench' or 'resting' guest has, or the flourish a
 * 'wandering' guest shows while they take in what just happened (cheering after a great ride, eating, drinking, showing
 * off a souvenir) — a flourish changes nothing but the pose, the guest moves on exactly when they would have. The
 * renderer turns each into a pose; the simulation decides what follows a pause.
 */
export const GUEST_ACTIVITIES = [
  'seatLeft', 'seatRight',
  'admire', 'watchRide', 'photo', 'cheer', 'queasy', 'vomit', 'fanSelf', 'shiver', 'sulk', 'eat', 'drink', 'balloonLost',
  'showOff',
] as const;
export type GuestActivity = (typeof GUEST_ACTIVITIES)[number];
export type GuestSeat = Extract<GuestActivity, 'seatLeft' | 'seatRight'>;
export type GuestPause = Exclude<GuestActivity, GuestSeat>;
/** The activities a 'wandering' guest may show in the moment after a ride or a purchase (see GuestActivity). */
export const GUEST_FLOURISHES = ['cheer', 'eat', 'drink', 'showOff'] as const;
export type GuestFlourish = (typeof GUEST_FLOURISHES)[number];

export interface ThoughtInsight {
  text: string;
  count: number;
  /**
   * Phase 30: the building most of these guests complain about (ties: lower id), or null when the thought names none
   * or the object is gone. Only complaint thoughts carry one (see COMPLAINT_THOUGHTS in life.ts).
   */
  objectId: number | null;
  /** The catalog name of that building, for the UI, or null. */
  objectName: string | null;
}

/** Phase 30: a guest's live state for the inspector. Plain data, rebuilt on every UI sync; never saved. */
export interface GuestSnapshot {
  id: number;
  state: GuestState;
  /** Short player-facing label of state+activity, e.g. 'Queueing for Cloud Hopper', 'Resting on a bench', 'Feeling queasy'. */
  doing: string;
  thought: string;
  /** The building the current complaint is about (exists in the world), or null. */
  thoughtObjectId: number | null;
  thoughtObjectName: string | null;
  destinationObjectId: number | null;
  destinationName: string | null;
  happiness: number;
  money: number;
  hunger: number;
  thirst: number;
  toiletNeed: number;
  energy: number;
  nausea: number;
  warmth: number;
  /** 'gentle' | 'family' | 'thrill' from preferredIntensity via the same bands as the build cards (rideBandOf). */
  likes: 'gentle' | 'family' | 'thrill';
  /** Names of the keepsakes held, in SOUVENIR_KINDS order. */
  souvenirs: string[];
  /** Comfort flags for the UI. */
  tired: boolean;
  queasy: boolean;
  hot: boolean;
  cold: boolean;
  soaked: boolean;
  position: { x: number; y: number };
  ageSeconds: number;
}

export interface Guest {
  id: number;
  position: Cell;
  currentCell: Cell;
  route: Cell[];
  routeIndex: number;
  routeVersion: number;
  state: GuestState;
  destinationObjectId: number | null;
  money: number;
  happiness: number;
  hunger: number;
  thirst: number;
  toiletNeed: number;
  energy: number;
  preferredIntensity: number;
  currentThought: string;
  /**
   * Phase 30: the building the current thought complains about (a COMPLAINT_THOUGHTS line), or null. Saved as an
   * optional key written only when non-null, so a park with no complaint is byte-identical at schema 15. May name a
   * demolished object (like recentRideIds); readers check the world. Read by nothing in the simulation.
   */
  thoughtObjectId: number | null;
  patienceSeconds: number;
  lastQueueWaitSeconds: number;
  lastRideSatisfaction: number | null;
  lastPurchaseSatisfaction: number | null;
  servicePriceLimit: number | null;
  recentRideIds: number[];
  recentServiceIds: number[];
  ageSeconds: number;
  maximumVisitSeconds: number;
  stateTimerSeconds: number;
  needTimerSeconds: number;
  color: number;
  accent: number;
  /** Phase 29: 0..100. Rises on rides more intense than the guest enjoys; high enough, they are sick. */
  nausea: number;
  /** Phase 29: 0..100, 50 = comfortable. Drifts toward the park's ambient warmth; hot above 78, cold below 25. */
  warmth: number;
  /** Phase 29: the souvenirs held, one bit per SOUVENIR_KINDS index. */
  souvenirs: number;
  /**
   * Phase 29: the pause or the bench seat of a 'pausing', 'walkingToBench' or 'resting' guest, or the flourish of a
   * 'wandering' one (GUEST_FLOURISHES); null otherwise.
   */
  activity: GuestActivity | null;
}
