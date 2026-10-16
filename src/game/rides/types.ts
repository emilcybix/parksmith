export type RideStatus = 'idle' | 'waiting' | 'running' | 'closed' | 'broken' | 'maintenance';

/** Why a ride is closed for guests: the player's switch, or the weather (a storm closes open-air rides). */
export type RideClosureReason = 'player' | 'storm';

export type MaintenanceKind = 'inspection' | 'repair';

export interface RideRuntime {
  objectId: number;
  open: boolean;
  status: RideStatus;
  ticketPrice: number;
  queueGuestIds: number[];
  riderGuestIds: number[];
  dispatchTimerSeconds: number;
  cycleRemainingSeconds: number;
  lifetimeRevenue: number;
  lifetimeOperatingCost: number;
  ridersToday: number;
  completedCycles: number;
  satisfactionTotal: number;
  satisfactionCount: number;
  boardedAtSeconds: number[];
  condition: number;
  reliability: number;
  broken: boolean;
  pendingBreakdown: boolean;
  breakdownCount: number;
  inspectionsCompleted: number;
  repairsCompleted: number;
  lifetimeMaintenanceCost: number;
  maintenanceKind: MaintenanceKind | null;
  maintenanceProgress: number;
}

export interface RideSnapshot {
  objectId: number;
  definitionId: string;
  name: string;
  open: boolean;
  /** Why the ride is closed for guests: 'player' (their switch wins), 'storm', or null while it is open. Broken and maintenance have their own status. */
  closureReason: RideClosureReason | null;
  status: RideStatus;
  ticketPrice: number;
  queueLength: number;
  estimatedWaitSeconds: number;
  capacity: number;
  rideDurationSeconds: number;
  cycleRemainingSeconds: number;
  ridersToday: number;
  lifetimeRevenue: number;
  operatingCost: number;
  throughputPerHour: number;
  satisfaction: number | null;
  condition: number;
  reliability: number;
  broken: boolean;
  pendingBreakdown: boolean;
  breakdownChance: number;
  breakdownCount: number;
  inspectionsCompleted: number;
  repairsCompleted: number;
  lifetimeMaintenanceCost: number;
  maintenanceKind: MaintenanceKind | null;
  maintenanceProgress: number;
  sceneryScore: number;
  sceneryChoiceBonus: number;
  scenerySatisfactionBonus: number;
  excitement: number;
  intensity: number;
  /** Present for custom coasters: the exact track evidence behind the derived stats. */
  coaster: {
    pieces: number;
    turns: number;
    drops: number;
    totalDescent: number;
    highestHeight: number;
    topSpeed: number;
    loops: number;
    boosts: number;
  } | null;
}
