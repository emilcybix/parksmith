import type { OnboardingInput, OnboardingRideInput, OnboardingServiceInput } from './types';

/** Test helpers: a fresh-park input and one-line builders for rides and services. */
export const freshInput = (overrides: Partial<OnboardingInput> = {}): OnboardingInput => ({
  tick: 0,
  connectedPathTiles: 0,
  rides: [],
  services: [],
  totalArrivals: 0,
  operatingProfit: 0,
  litterUnits: 0,
  cleaners: 0,
  parkRating: 0,
  ...overrides,
});

export const rideInput = (overrides: Partial<OnboardingRideInput> = {}): OnboardingRideInput => ({
  objectId: 1,
  connected: true,
  ticketPrice: 4,
  defaultTicketPrice: 4,
  satisfactionCount: 0,
  repairsCompleted: 0,
  ...overrides,
});

export const serviceInput = (overrides: Partial<OnboardingServiceInput> = {}): OnboardingServiceInput => ({
  objectId: 2,
  kind: 'food',
  connected: true,
  ...overrides,
});
