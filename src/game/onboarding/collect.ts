import type { ManagementSnapshot } from '../management/types';
import type { ManagementSimulation } from '../management/ManagementSimulation';
import type { GuestSimulation } from '../guests/GuestSimulation';
import type { RideSimulation } from '../rides/RideSimulation';
import type { ShopSimulation } from '../shops/ShopSimulation';
import type { GameWorld } from '../World';
import type { OnboardingInput } from './types';

/**
 * Builds the read-only input the First Day steps evaluate. It reads runtime fields directly rather
 * than through `RideSimulation.snapshot()` (which trims throughput history), and it reuses the
 * management snapshot the session step already took, so collecting changes no simulation state.
 */
export const collectOnboardingInput = (
  world: GameWorld,
  rides: RideSimulation,
  shops: ShopSimulation,
  guests: GuestSimulation,
  management: ManagementSimulation,
  managementSnapshot: ManagementSnapshot,
): OnboardingInput => {
  const connectivity = management.connectivity();
  const rideInputs = [...rides.rides.values()].map((ride) => ({
    objectId: ride.objectId,
    connected: connectivity.objectIds.has(ride.objectId),
    ticketPrice: ride.ticketPrice,
    // A ride without a profile cannot exist in a synced park; treat it as unchanged.
    defaultTicketPrice: world.rideProfile(ride.objectId)?.ticketPrice ?? ride.ticketPrice,
    satisfactionCount: ride.satisfactionCount,
    repairsCompleted: ride.repairsCompleted,
  }));
  const serviceInputs = [...shops.services.values()].map((service) => ({
    objectId: service.objectId,
    kind: service.kind,
    connected: connectivity.objectIds.has(service.objectId),
  }));
  return {
    tick: world.tick,
    connectedPathTiles: connectivity.pathTiles,
    rides: rideInputs,
    services: serviceInputs,
    totalArrivals: guests.totalArrivals,
    operatingProfit: managementSnapshot.finances.operating.profit,
    litterUnits: managementSnapshot.parkOperations.cleanliness.litterUnits,
    cleaners: managementSnapshot.parkOperations.staff.cleaners.total,
    parkRating: managementSnapshot.rating.score,
  };
};
