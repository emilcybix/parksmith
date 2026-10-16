import type { OperationsSnapshot, StaffRole, WorkerSnapshot } from '../game/operations/types';

/**
 * Phase 42: the Staff window's pure model: a generated name per worker (presentation only, derived from the id, so no
 * save field), what each one is doing in words, and the overview hints. No store, no DOM.
 */

const NAMES: readonly string[] = [
  'Ash', 'Bo', 'Cam', 'Dee', 'Eli', 'Fen', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kit', 'Lou',
  'Max', 'Noa', 'Oli', 'Pip', 'Quinn', 'Rae', 'Sam', 'Tam', 'Uli', 'Val', 'Wren', 'Yan',
];

/** A stable, friendly name for worker `id`: a first name and an initial, both from the id (24 x 26 combinations). */
export const workerName = (id: number): string => {
  const first = NAMES[(id * 7) % NAMES.length];
  const initial = String.fromCharCode(65 + ((id * 11 + Math.floor(id / NAMES.length)) % 26));
  return `${first} ${initial}.`;
};

export const roleLabel = (role: StaffRole): string => (role === 'cleaner' ? 'Cleaner' : 'Mechanic');

/** What the worker is doing, in words: "Repairing Aurora Wheel", "Walking to empty Tidy Totem", "Idle". */
export const workerActivity = (worker: Pick<WorkerSnapshot, 'state' | 'task'>, nameOf: (objectId: number) => string | null): string => {
  const task = worker.task;
  if (task === null || worker.state === 'idle') return 'Idle';
  const target = task.targetObjectId === null ? null : nameOf(task.targetObjectId);
  const doing = (() => {
    switch (task.kind) {
      case 'cleanLitter': return { verb: 'Cleaning litter', infinitive: 'clean litter' };
      case 'emptyBin': return { verb: `Emptying ${target ?? 'a bin'}`, infinitive: `empty ${target ?? 'a bin'}` };
      case 'inspectRide': return { verb: `Inspecting ${target ?? 'a ride'}`, infinitive: `inspect ${target ?? 'a ride'}` };
      default: return { verb: `Repairing ${target ?? 'a ride'}`, infinitive: `repair ${target ?? 'a ride'}` };
    }
  })();
  if (worker.state === 'walking') return `Walking to ${doing.infinitive}`;
  if (worker.state === 'waiting') return `Waiting to ${doing.infinitive}`;
  return doing.verb;
};

export interface StaffOverview {
  litterUnits: number;
  dirtyPathTiles: number;
  awaitingMechanic: number;
  brokenRides: number;
  /** Plain advice lines, most urgent first; empty when the crew keeps up. */
  hints: string[];
}

/**
 * The window's overview figures and hints. "More cleaners" when the park is getting dirty while every cleaner is busy
 * (the same picture the Operations tab's advice reads); "another mechanic" when a breakdown waits for one.
 */
export const staffOverview = (operations: Pick<OperationsSnapshot, 'cleanliness' | 'maintenance' | 'staff'>): StaffOverview => {
  const { cleanliness, maintenance, staff } = operations;
  const hints: string[] = [];
  if (maintenance.awaitingMechanic > 0) {
    hints.push(staff.mechanics.total < staff.capacityPerRole
      ? `${maintenance.awaitingMechanic} breakdown${maintenance.awaitingMechanic === 1 ? '' : 's'} waiting: hire another mechanic.`
      : `${maintenance.awaitingMechanic} breakdown${maintenance.awaitingMechanic === 1 ? '' : 's'} waiting: train the mechanics to work faster.`);
  }
  const cleanersStretched = staff.cleaners.total === 0 || staff.cleaners.busy >= staff.cleaners.total;
  if (cleanliness.score < 75 && cleanersStretched) {
    hints.push(staff.cleaners.total < staff.capacityPerRole
      ? 'The paths are getting dirty and every cleaner is busy: more cleaners needed.'
      : 'The paths are getting dirty at the crew cap: train the cleaners or add bins.');
  }
  return {
    litterUnits: cleanliness.litterUnits,
    dirtyPathTiles: cleanliness.dirtyPathTiles,
    awaitingMechanic: maintenance.awaitingMechanic,
    brokenRides: maintenance.brokenRides,
    hints,
  };
};
