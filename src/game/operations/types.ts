import type { Cell } from '../types';

export type StaffRole = 'cleaner' | 'mechanic';

export type StaffState = 'idle' | 'walking' | 'waiting' | 'working';

export type StaffTaskKind = 'cleanLitter' | 'emptyBin' | 'inspectRide' | 'repairRide';

export type RideMaintenanceKind = 'inspection' | 'repair';

export type StaffTrainingResult =
  | { ok: true; level: number; cost: number }
  | { ok: false; reason: 'maxLevel' | 'noStaff' | 'funds' };

export interface StaffRoleSnapshot {
  total: number;
  busy: number;
  salaryPerInterval: number;
  /** 0..maximumTrainingLevel; raises work and walking speed, and wages with them. */
  trainingLevel: number;
  /** Cost of the next training level, or null when the crew is fully trained. */
  trainingCost: number | null;
}

export interface StaffTaskRuntime {
  kind: StaffTaskKind;
  targetObjectId: number | null;
  targetCell: Cell;
  workRemainingSeconds: number;
  workDurationSeconds: number;
  maintenanceStarted: boolean;
}

/**
 * Why a role cannot be taken on right now. Wages are billed whether or not the park is open, so
 * hiring without cover was a one-way trip into debt (PA-028): the crew keeps billing, and a park
 * with no reachable ride has no way to earn it back.
 */
export type HireBlock =
  | { reason: 'capacity'; capacity: number }
  | { reason: 'funds'; required: number; available: number };

export interface StaffRuntime {
  id: number;
  role: StaffRole;
  state: StaffState;
  position: Cell;
  currentCell: Cell;
  route: Cell[];
  routeIndex: number;
  routeVersion: number;
  task: StaffTaskRuntime | null;
  payrollRemainingSeconds: number;
}

export interface LitterPileRuntime {
  cell: Cell;
  units: number;
  assignedCleanerId: number | null;
  /** Phase 29: someone was sick on this pile (guests mind it more; it is cleaned like any litter). */
  sick: boolean;
}

export interface BinRuntime {
  objectId: number;
  capacity: number;
  fill: number;
  assignedCleanerId: number | null;
}

export interface LitterPileSnapshot {
  cell: Cell;
  units: number;
  assignedCleanerId: number | null;
  sick: boolean;
}

export interface BinSnapshot {
  objectId: number;
  fill: number;
  capacity: number;
  full: boolean;
  assignedCleanerId: number | null;
}

export interface StaffTaskSnapshot {
  kind: StaffTaskKind;
  targetObjectId: number | null;
  targetCell: Cell;
  progress: number;
}

export interface StaffSnapshot {
  id: number;
  role: StaffRole;
  state: StaffState;
  position: Cell;
  currentCell: Cell;
  task: StaffTaskSnapshot | null;
}

export interface OperationsSnapshot {
  elapsedSeconds: number;
  cleanliness: {
    score: number;
    litterUnits: number;
    dirtyPathTiles: number;
    binsTotal: number;
    binsFull: number;
    averageBinFillPercent: number;
  };
  maintenance: {
    averageRideCondition: number | null;
    wornRides: number;
    brokenRides: number;
    awaitingMechanic: number;
  };
  staff: {
    cleaners: StaffRoleSnapshot;
    mechanics: StaffRoleSnapshot;
    payrollIntervalSeconds: number;
    /** Live hiring ceiling per role: it grows with the crowd. */
    capacityPerRole: number;
    maximumTrainingLevel: number;
  };
  litter: LitterPileSnapshot[];
  bins: BinSnapshot[];
  workers: StaffSnapshot[];
}
