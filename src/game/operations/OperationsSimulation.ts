import { BUILD_BY_ID } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import { setThought } from '../guests/life';
import type { Guest } from '../guests/types';
import { PathNetwork } from '../navigation/PathNetwork';
import type { RideSimulation } from '../rides/RideSimulation';
import { plainNumber } from '../save/plainData';
import type {
  BinState,
  CellState,
  LitterPileState,
  OperationsState,
  Serializable,
  StaffTaskState,
  StaffWorkerState,
} from '../save/state';
import { MAXIMUM_LOOP_ITERATIONS, MAXIMUM_SAVED_COUNTER, MAXIMUM_SAVED_SECONDS } from '../save/ranges';
import { invalidState } from '../save/version';
import type { RideRuntime } from '../rides/types';
import type { ShopSimulation } from '../shops/ShopSimulation';
import type { Cell, PlacedObject } from '../types';
import type { GameWorld } from '../World';
import type {
  BinRuntime,
  HireBlock,
  StaffTrainingResult,
  LitterPileRuntime,
  OperationsSnapshot,
  RideMaintenanceKind,
  StaffRole,
  StaffRuntime,
  WorkerSnapshot,
  StaffState,
  StaffTaskKind,
  StaffTaskRuntime,
} from './types';

type MaintenanceStartResult = 'started' | 'running' | 'missing' | 'invalid';

interface PhaseSixRideRuntime extends RideRuntime {
  condition: number;
  broken: boolean;
}

type PhaseSixRideSimulation = RideSimulation & {
  beginMaintenance(
    objectId: number,
    kind: RideMaintenanceKind,
    guests: Map<number, Guest>,
  ): MaintenanceStartResult;
  setMaintenanceProgress(objectId: number, progress: number): void;
  cancelMaintenance(objectId: number): void;
  completeMaintenance(objectId: number, kind: RideMaintenanceKind, cost: number): void;
};

interface CleanerCandidate {
  priority: number;
  severity: number;
  kind: 'cleanLitter' | 'emptyBin';
  targetObjectId: number | null;
  targetCell: Cell;
  targetKey: string;
  route: Cell[];
}

interface MechanicCandidate {
  priority: number;
  condition: number;
  kind: 'inspectRide' | 'repairRide';
  targetObjectId: number;
  targetCell: Cell;
  route: Cell[];
}

const CARDINALS: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const EPSILON_SECONDS = 1e-9;
const keyOf = ({ x, y }: Cell): string => `${x},${y}`;
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));
const round = (value: number, decimals = 1): number => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};
/** One formula for bin capacity, shared by syncWithWorld and restore validation. */
const binCapacityOf = (definition: { stats?: { binCapacity?: number } }): number => (
  Math.max(1, Math.floor(definition.stats?.binCapacity ?? 1))
);
const STAFF_ROLES: readonly StaffRole[] = ['cleaner', 'mechanic'];
const STAFF_STATES: readonly StaffState[] = ['idle', 'walking', 'waiting', 'working'];
const STAFF_TASK_KINDS: readonly StaffTaskKind[] = ['cleanLitter', 'emptyBin', 'inspectRide', 'repairRide'];
const compareCells = (left: Cell, right: Cell): number => left.y - right.y || left.x - right.x;

export class OperationsSimulation implements Serializable<OperationsState> {
  readonly bins = new Map<number, BinRuntime>();
  readonly litter = new Map<string, LitterPileRuntime>();
  readonly staff = new Map<number, StaffRuntime>();
  readonly navigation = new PathNetwork();

  private elapsedSeconds = 0;
  private happinessAccumulatorSeconds = 0;
  private nextStaffId = 1;
  /** Last observed crowd size; the crew cap scales with it. */
  private guestPopulation = 0;
  private readonly trainingLevel: Record<StaffRole, number> = { cleaner: 0, mechanic: 0 };

  constructor(
    private readonly world: GameWorld,
    private readonly rides: RideSimulation,
    private readonly shops: ShopSimulation,
    private readonly rules: {
      staffSalaryMultiplier: number;
      staffSpeedMultiplier: number;
      /** Phase 25: scales what litter does (the rating penalty and the guests' happiness loss), not how much there is. */
      litterImpactMultiplier: number;
    } = {
      staffSalaryMultiplier: 1,
      staffSpeedMultiplier: 1,
      litterImpactMultiplier: 1,
    },
  ) {
    this.syncWithWorld();
  }

  step(stepMs: number, guests: Map<number, Guest>): void {
    const deltaSeconds = Number.isFinite(stepMs) ? Math.max(0, stepMs) / 1_000 : 0;
    this.elapsedSeconds += deltaSeconds;
    this.guestPopulation = guests.size;
    this.syncWithWorld();
    this.consumeWasteEvents();
    this.reconcileStaffTasks();
    this.assignIdleStaff();

    const workers = [...this.staff.values()].sort((left, right) => left.id - right.id);
    for (const worker of workers) {
      if (deltaSeconds > 0) this.processPayroll(worker, deltaSeconds);
      this.advanceStaff(worker, deltaSeconds, guests);
    }

    if (deltaSeconds > 0) this.updateGuestCleanliness(deltaSeconds, guests);
  }

  syncWithWorld(): void {
    this.navigation.sync(this.world.paths, this.world.pathVersion);
    const liveBinIds = new Set<number>();
    const objects = [...this.world.objects.values()].sort((left, right) => left.id - right.id);
    for (const object of objects) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (definition?.stats?.amenityType !== 'bin') continue;
      liveBinIds.add(object.id);
      const capacity = binCapacityOf(definition);
      const existing = this.bins.get(object.id);
      if (existing) {
        existing.capacity = capacity;
        existing.fill = Math.min(existing.fill, capacity);
      } else {
        this.bins.set(object.id, { objectId: object.id, capacity, fill: 0, assignedCleanerId: null });
      }
    }

    for (const objectId of [...this.bins.keys()]) {
      if (liveBinIds.has(objectId)) continue;
      this.cancelTasks((task) => task.kind === 'emptyBin' && task.targetObjectId === objectId);
      this.bins.delete(objectId);
    }

    for (const [key, pile] of this.litter) {
      if (this.world.paths.has(key)) continue;
      this.cancelTasks((task) => task.kind === 'cleanLitter' && keyOf(task.targetCell) === key);
      this.litter.delete(key);
      pile.assignedCleanerId = null;
    }
  }

  /**
   * One-shot card primitive (Phase 25, the sweep card): clears every litter pile at once. Cleaners on a litter task are
   * released first (as when a path under a pile is removed, see syncWithWorld), so the state between two steps keeps
   * the assignment laws a restore checks. Free here (the card posts its own fee). Returns how many piles it cleared.
   */
  sweepLitter(): number {
    const piles = this.litter.size;
    this.cancelTasks((task) => task.kind === 'cleanLitter');
    this.litter.clear();
    return piles;
  }

  /**
   * One-shot card primitive (Phase 25, the sweep card): empties every bin (`fill = 0`, as a cleaner does). Cleaners on
   * a bin task are released (the bins are empty now). Returns how many bins held anything.
   */
  emptyBins(): number {
    const used = this.usedBinCount();
    this.cancelTasks((task) => task.kind === 'emptyBin');
    for (const bin of this.bins.values()) bin.fill = 0;
    return used;
  }

  /** Bins holding anything (with `litter.size`, what the sweep card's "can play" check reads). */
  usedBinCount(): number {
    let count = 0;
    for (const bin of this.bins.values()) if (bin.fill > 0) count += 1;
    return count;
  }

  /**
   * Read-only image of everything that decides the future. PURE: it never calls snapshot() or
   * syncWithWorld() (both touch caches, and sync can cancel tasks). Maps are written in iteration
   * order because assignCleaner iterates bins and litter unsorted and breaks ties by that order.
   * Bin capacity is not saved (derived from the catalog); a route is saved because it is not
   * re-derivable (it was planned at an older position and path version).
   */
  serialize(): OperationsState {
    const cell = (value: Cell, path: string): CellState => ({
      x: plainNumber(value.x, `${path}.x`),
      y: plainNumber(value.y, `${path}.y`),
    });
    const bins: BinState[] = [...this.bins.values()].map((bin) => ({
      objectId: bin.objectId,
      fill: plainNumber(bin.fill, `bins[${bin.objectId}].fill`),
      assignedCleanerId: bin.assignedCleanerId,
    }));
    const litter: LitterPileState[] = [...this.litter.entries()].map(([key, pile]) => ({
      cell: cell(pile.cell, `litter[${key}].cell`),
      units: plainNumber(pile.units, `litter[${key}].units`),
      assignedCleanerId: pile.assignedCleanerId,
      // Phase 29: only a sick pile carries the key, so every other pile is saved exactly as before.
      ...(pile.sick ? { sick: true as const } : {}),
    }));
    const staff: StaffWorkerState[] = [...this.staff.values()].map((worker) => {
      const path = `staff[${worker.id}]`;
      const task: StaffTaskState | null = worker.task ? {
        kind: worker.task.kind,
        targetObjectId: worker.task.targetObjectId,
        targetCell: cell(worker.task.targetCell, `${path}.task.targetCell`),
        workRemainingSeconds: plainNumber(worker.task.workRemainingSeconds, `${path}.task.workRemainingSeconds`),
        workDurationSeconds: plainNumber(worker.task.workDurationSeconds, `${path}.task.workDurationSeconds`),
        maintenanceStarted: worker.task.maintenanceStarted,
      } : null;
      return {
        id: worker.id,
        role: worker.role,
        state: worker.state,
        position: cell(worker.position, `${path}.position`),
        currentCell: cell(worker.currentCell, `${path}.currentCell`),
        route: worker.route.map((step, index) => cell(step, `${path}.route[${index}]`)),
        routeIndex: plainNumber(worker.routeIndex, `${path}.routeIndex`),
        routeVersion: plainNumber(worker.routeVersion, `${path}.routeVersion`),
        task,
        payrollRemainingSeconds: plainNumber(worker.payrollRemainingSeconds, `${path}.payrollRemainingSeconds`),
      };
    });
    return {
      elapsedSeconds: plainNumber(this.elapsedSeconds, 'elapsedSeconds'),
      happinessAccumulatorSeconds: plainNumber(this.happinessAccumulatorSeconds, 'happinessAccumulatorSeconds'),
      nextStaffId: this.nextStaffId,
      guestPopulation: this.guestPopulation,
      trainingLevel: { cleaner: this.trainingLevel.cleaner, mechanic: this.trainingLevel.mechanic },
      bins,
      litter,
      staff,
    };
  }

  /**
   * Validates the whole state into fresh local objects, THEN replaces the Maps' contents. Nothing
   * here steps, hires, posts a transaction or touches a ride: wages were already paid, and a
   * mechanic's ride state is the rides owner's to restore (it is only checked, here).
   *
   * routeVersion is applied verbatim and never "fixed": a path edit between steps legitimately
   * leaves routeVersion !== world.pathVersion, and the next step must reroute exactly as the
   * reference run does.
   */
  restore(state: OperationsState): void {
    const owner = 'OperationsSimulation';
    const fail = (path: string, problem: string): never => { throw invalidState(owner, path, problem); };
    const isRecord = (value: unknown): value is Record<string, unknown> => (
      typeof value === 'object' && value !== null && !Array.isArray(value)
    );
    const finite = (value: unknown, path: string, minimum = 0, maximum = MAXIMUM_SAVED_SECONDS): number => (
      typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
        ? value
        : fail(path, `is not a finite number in ${minimum}..${maximum}`)
    );
    const integer = (value: unknown, path: string, minimum: number, maximum = MAXIMUM_SAVED_COUNTER): number => (
      typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
        ? value
        : fail(path, `is not an integer in ${minimum}..${maximum}`)
    );
    const flag = (value: unknown, path: string): boolean => (
      typeof value === 'boolean' ? value : fail(path, 'is not a boolean')
    );
    const oneOf = <Value extends string>(value: unknown, allowed: readonly Value[], path: string): Value => (
      allowed.includes(value as Value) ? value as Value : fail(path, `is not one of ${allowed.join(', ')}`)
    );
    const nullableId = (value: unknown, path: string): number | null => (
      value === null ? null : integer(value, path, 0)
    );
    const readCell = (value: unknown, path: string, whole: boolean): Cell => {
      if (!isRecord(value)) return fail(path, 'is not a cell');
      return whole
        ? { x: integer(value.x, `${path}.x`, 0, this.world.width - 1), y: integer(value.y, `${path}.y`, 0, this.world.height - 1) }
        : { x: finite(value.x, `${path}.x`, 0, this.world.width - 1), y: finite(value.y, `${path}.y`, 0, this.world.height - 1) };
    };
    const list = (value: unknown, path: string): unknown[] => (
      Array.isArray(value) ? value : fail(path, 'is not an array')
    );

    if (!isRecord(state)) fail('$', 'is not an object');
    const elapsedSeconds = finite(state.elapsedSeconds, 'elapsedSeconds');
    // updateGuestCleanliness drains this in a `while (accumulator >= interval)` loop: a value far
    // above the interval would spin for ages (or forever once x - interval === x), so the saved
    // value must be what a finished step can leave behind, strictly below one interval.
    const happinessAccumulatorSeconds = finite(
      state.happinessAccumulatorSeconds,
      'happinessAccumulatorSeconds',
      0,
      GAME_CONFIG.operations.litter.happinessIntervalSeconds,
    );
    const nextStaffId = integer(state.nextStaffId, 'nextStaffId', 1);
    const guestPopulation = integer(state.guestPopulation, 'guestPopulation', 0);
    const levels = isRecord(state.trainingLevel) ? state.trainingLevel : fail('trainingLevel', 'is not an object');
    const maximumLevel = GAME_CONFIG.operations.staff.training.maximumLevel;
    const trainingLevel = {
      cleaner: integer(levels.cleaner, 'trainingLevel.cleaner', 0, maximumLevel),
      mechanic: integer(levels.mechanic, 'trainingLevel.mechanic', 0, maximumLevel),
    };

    const bins = new Map<number, BinRuntime>();
    list(state.bins, 'bins').forEach((entry, position) => {
      const path = `bins[${position}]`;
      if (!isRecord(entry)) return fail(path, 'is not an object');
      const objectId = integer(entry.objectId, `${path}.objectId`, 0);
      if (bins.has(objectId)) fail(`${path}.objectId`, `${objectId} appears twice`);
      const object = this.world.objects.get(objectId);
      const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
      if (!definition || definition.stats?.amenityType !== 'bin') {
        fail(`${path}.objectId`, `${objectId} is not a bin in the world`);
      }
      const capacity = binCapacityOf(definition!);
      bins.set(objectId, {
        objectId,
        capacity,
        fill: integer(entry.fill, `${path}.fill`, 0, capacity),
        assignedCleanerId: nullableId(entry.assignedCleanerId, `${path}.assignedCleanerId`),
      });
    });

    const litter = new Map<string, LitterPileRuntime>();
    let litterTotal = 0;
    list(state.litter, 'litter').forEach((entry, position) => {
      const path = `litter[${position}]`;
      if (!isRecord(entry)) return fail(path, 'is not an object');
      const cell = readCell(entry.cell, `${path}.cell`, true);
      const key = keyOf(cell);
      if (litter.has(key)) fail(`${path}.cell`, `${key} appears twice`);
      const units = integer(entry.units, `${path}.units`, 1);
      litterTotal += units;
      if (entry.sick !== undefined && entry.sick !== true) fail(`${path}.sick`, 'must be true when present');
      litter.set(key, { cell, units, assignedCleanerId: nullableId(entry.assignedCleanerId, `${path}.assignedCleanerId`), sick: entry.sick === true });
    });
    if (litterTotal > GAME_CONFIG.operations.litter.maximumUnits) {
      fail('litter', `holds ${litterTotal} units, above the cap of ${GAME_CONFIG.operations.litter.maximumUnits}`);
    }

    const staff = new Map<number, StaffRuntime>();
    let maximumId = 0;
    list(state.staff, 'staff').forEach((entry, position) => {
      const path = `staff[${position}]`;
      if (!isRecord(entry)) return fail(path, 'is not an object');
      const id = integer(entry.id, `${path}.id`, 1);
      if (staff.has(id)) fail(`${path}.id`, `${id} appears twice`);
      maximumId = Math.max(maximumId, id);
      const role = oneOf(entry.role, STAFF_ROLES, `${path}.role`);
      const activity = oneOf(entry.state, STAFF_STATES, `${path}.state`);
      const routeEntries = list(entry.route, `${path}.route`);
      if (routeEntries.length === 0) fail(`${path}.route`, 'is empty');
      const route = routeEntries.map((step, index) => readCell(step, `${path}.route[${index}]`, true));
      let task: StaffTaskRuntime | null = null;
      if (entry.task !== null) {
        const taskPath = `${path}.task`;
        if (!isRecord(entry.task)) return fail(taskPath, 'is not an object or null');
        const kind = oneOf(entry.task.kind, STAFF_TASK_KINDS, `${taskPath}.kind`);
        if ((role === 'cleaner') !== (kind === 'cleanLitter' || kind === 'emptyBin')) {
          fail(`${taskPath}.kind`, `${kind} does not belong to a ${role}`);
        }
        const targetObjectId = nullableId(entry.task.targetObjectId, `${taskPath}.targetObjectId`);
        if ((kind === 'cleanLitter') !== (targetObjectId === null)) {
          fail(`${taskPath}.targetObjectId`, kind === 'cleanLitter' ? 'must be null for cleanLitter' : `must name an object for ${kind}`);
        }
        const maintenanceStarted = flag(entry.task.maintenanceStarted, `${taskPath}.maintenanceStarted`);
        if (maintenanceStarted && role !== 'mechanic') fail(`${taskPath}.maintenanceStarted`, 'is true for a cleaner');
        task = {
          kind,
          targetObjectId,
          targetCell: readCell(entry.task.targetCell, `${taskPath}.targetCell`, true),
          workRemainingSeconds: finite(entry.task.workRemainingSeconds, `${taskPath}.workRemainingSeconds`),
          workDurationSeconds: finite(entry.task.workDurationSeconds, `${taskPath}.workDurationSeconds`),
          maintenanceStarted,
        };
      }
      if ((activity === 'idle') !== (task === null)) fail(`${path}.state`, `${activity} does not fit ${task ? 'a task' : 'no task'}`);
      if (activity === 'waiting' && (role !== 'mechanic' || task === null)) fail(`${path}.state`, 'waiting is only for a mechanic with a task');
      if (task && role === 'mechanic' && activity === 'waiting' && task.maintenanceStarted) {
        fail(`${path}.state`, 'a waiting mechanic has not started maintenance');
      }
      if (task && role === 'mechanic' && activity === 'working' && !task.maintenanceStarted) {
        fail(`${path}.state`, 'a working mechanic has started maintenance');
      }
      staff.set(id, {
        id,
        role,
        state: activity,
        position: readCell(entry.position, `${path}.position`, false),
        currentCell: readCell(entry.currentCell, `${path}.currentCell`, true),
        route,
        routeIndex: integer(entry.routeIndex, `${path}.routeIndex`, 0, route.length),
        routeVersion: integer(entry.routeVersion, `${path}.routeVersion`, 0),
        task,
        // processPayroll pays once per whole interval it is behind: a hugely negative value would
        // post thousands of salaries in one step, so only a value a healthy step leaves is accepted.
        payrollRemainingSeconds: finite(
          entry.payrollRemainingSeconds,
          `${path}.payrollRemainingSeconds`,
          0,
          GAME_CONFIG.operations.payrollIntervalSeconds,
        ),
      });
    });
    if (nextStaffId <= maximumId) fail('nextStaffId', `${nextStaffId} would reuse staff id ${maximumId}`);

    // Assignments, both directions: a reservation without its worker (or a task without its
    // reservation) would leave a bin or pile nobody serves, or two cleaners on one target.
    const isCleanerOn = (id: number, kind: StaffTaskKind, matches: (task: StaffTaskRuntime) => boolean): boolean => {
      const worker = staff.get(id);
      return worker?.role === 'cleaner' && worker.task?.kind === kind && matches(worker.task);
    };
    for (const bin of bins.values()) {
      if (bin.assignedCleanerId === null) continue;
      if (!isCleanerOn(bin.assignedCleanerId, 'emptyBin', (task) => task.targetObjectId === bin.objectId)) {
        fail(`bins[${bin.objectId}].assignedCleanerId`, `${bin.assignedCleanerId} is not a cleaner emptying this bin`);
      }
    }
    for (const [key, pile] of litter) {
      if (pile.assignedCleanerId === null) continue;
      if (!isCleanerOn(pile.assignedCleanerId, 'cleanLitter', (task) => keyOf(task.targetCell) === key)) {
        fail(`litter[${key}].assignedCleanerId`, `${pile.assignedCleanerId} is not a cleaner cleaning this pile`);
      }
    }
    const claimedRides = new Set<number>();
    const maintainers = new Set<number>();
    for (const worker of staff.values()) {
      const task = worker.task;
      if (!task) continue;
      const path = `staff[${worker.id}].task`;
      if (task.kind === 'emptyBin') {
        if (bins.get(task.targetObjectId!)?.assignedCleanerId !== worker.id) fail(path, `targets bin ${task.targetObjectId} which is not assigned to worker ${worker.id}`);
      } else if (task.kind === 'cleanLitter') {
        if (litter.get(keyOf(task.targetCell))?.assignedCleanerId !== worker.id) fail(path, `targets a pile at ${keyOf(task.targetCell)} which is not assigned to worker ${worker.id}`);
      } else {
        const rideId = task.targetObjectId!;
        if (claimedRides.has(rideId)) fail(path, `ride ${rideId} is claimed by two mechanics`);
        claimedRides.add(rideId);
        if (task.maintenanceStarted) {
          const expectedKind = task.kind === 'inspectRide' ? 'inspection' : 'repair';
          const ride = this.rides.rides.get(rideId);
          if (!ride) fail(path, `maintenance has started on ride ${rideId}, which does not exist`);
          if (ride!.maintenanceKind !== expectedKind) {
            fail(path, `${task.kind} has started but ride ${rideId} reports maintenance ${String(ride!.maintenanceKind)}`);
          }
          maintainers.add(rideId);
        }
      }
    }
    for (const worker of staff.values()) {
      const task = worker.task;
      if (!task || task.maintenanceStarted || task.targetObjectId === null || task.kind === 'emptyBin') continue;
      const ride = this.rides.rides.get(task.targetObjectId);
      if (ride && ride.maintenanceKind !== null && !maintainers.has(task.targetObjectId)) {
        fail(`staff[${worker.id}].task`, `ride ${task.targetObjectId} is under maintenance by someone who is not on the crew`);
      }
    }

    // Apply. Containers keep identity (Maps are shared with the UI and the session).
    this.elapsedSeconds = elapsedSeconds;
    this.happinessAccumulatorSeconds = happinessAccumulatorSeconds;
    this.nextStaffId = nextStaffId;
    this.guestPopulation = guestPopulation;
    this.trainingLevel.cleaner = trainingLevel.cleaner;
    this.trainingLevel.mechanic = trainingLevel.mechanic;
    this.bins.clear();
    this.litter.clear();
    this.staff.clear();
    for (const [id, bin] of bins) this.bins.set(id, bin);
    for (const [key, pile] of litter) this.litter.set(key, pile);
    for (const [id, worker] of staff) this.staff.set(id, worker);
    // A restored world carries its saved pathVersion, which may equal the number this network last
    // saw for different paths; forget it so the sync really rebuilds.
    this.navigation.invalidate();
    this.navigation.sync(this.world.paths, this.world.pathVersion);
    // LAST, after the Maps are filled: for a consistent save this is a no-op (a sync can cancel
    // tasks and, through them, rides' maintenance).
    this.syncWithWorld();
  }

  /**
   * How many of one role this park may employ right now: a fixed base plus room that grows
   * with the crowd, so a park that scales to a thousand guests can staff for them.
   */
  staffCapacity(): number {
    const { baseCapacityPerRole, guestsPerExtraStaff, maximumCapacityPerRole } = GAME_CONFIG.operations.staff;
    const earned = baseCapacityPerRole + Math.floor(this.guestPopulation / guestsPerExtraStaff);
    return clamp(earned, baseCapacityPerRole, maximumCapacityPerRole);
  }

  staffTrainingLevel(role: StaffRole): number {
    return this.trainingLevel[role];
  }

  /** Cost of the next training step for a role, or null once the crew is fully trained. */
  trainingCost(role: StaffRole): number | null {
    const training = GAME_CONFIG.operations.staff.training;
    if (this.trainingLevel[role] >= training.maximumLevel) return null;
    const base = role === 'cleaner' ? training.cleanerCost : training.mechanicCost;
    return Math.round(base * (this.trainingLevel[role] + 1));
  }

  /**
   * Buys the whole role one training level: faster work, faster walking, higher wages.
   * Charged once, up front, from park cash.
   */
  trainStaff(role: StaffRole): StaffTrainingResult {
    const cost = this.trainingCost(role);
    if (cost === null) return { ok: false, reason: 'maxLevel' };
    const crew = [...this.staff.values()].filter((worker) => worker.role === role).length;
    if (crew === 0) return { ok: false, reason: 'noStaff' };
    if (this.world.cash < cost) return { ok: false, reason: 'funds' };
    this.trainingLevel[role] += 1;
    this.world.postTransaction(
      -cost,
      `${role === 'cleaner' ? 'Cleaner' : 'Mechanic'} crew training (level ${this.trainingLevel[role]})`,
      'staff-salaries',
    );
    return { ok: true, level: this.trainingLevel[role], cost };
  }

  /**
   * Why this role cannot be taken on, or null when it can. Separate from `hireStaff` so the UI can
   * explain the refusal with real numbers instead of a greyed-out button.
   */
  hireBlock(role: StaffRole): HireBlock | null {
    const capacity = this.staffCapacity();
    const roleCount = [...this.staff.values()].filter((worker) => worker.role === role).length;
    if (roleCount >= capacity) return { reason: 'capacity', capacity };
    const required = this.hireRequirement(role);
    if (this.world.cash < required) {
      return { reason: 'funds', required, available: this.world.cash };
    }
    return null;
  }

  /**
   * A hire costs its first shift immediately and then bills every payroll interval, alongside
   * everyone already on the crew. Requiring all of that up front is what stops a park from
   * hiring its way into a debt it has no way to earn back.
   */
  private hireRequirement(role: StaffRole): number {
    const crewNextShift = [...this.staff.values()]
      .reduce((total, worker) => total + this.effectiveSalary(worker.role), 0);
    const newHire = this.effectiveSalary(role);
    return Math.round((newHire * 2 + crewNextShift) * 100) / 100;
  }

  hireStaff(role: StaffRole): StaffRuntime | null {
    if (this.hireBlock(role) !== null) return null;
    const id = this.nextStaffId++;
    const entrance = { ...this.world.entrance };
    const worker: StaffRuntime = {
      id,
      role,
      state: 'idle',
      position: { ...entrance },
      currentCell: { ...entrance },
      route: [{ ...entrance }],
      routeIndex: 1,
      routeVersion: this.world.pathVersion,
      task: null,
      payrollRemainingSeconds: GAME_CONFIG.operations.payrollIntervalSeconds,
    };
    this.staff.set(id, worker);
    this.postSalary(role, true);
    return worker;
  }

  fireStaff(role: StaffRole): StaffRuntime | null {
    const candidate = [...this.staff.values()]
      .filter((worker) => worker.role === role)
      .sort((left, right) => Number(Boolean(left.task)) - Number(Boolean(right.task)) || right.id - left.id)[0];
    if (!candidate) return null;
    this.releaseTask(candidate, true);
    this.staff.delete(candidate.id);
    return candidate;
  }

  /**
   * Phase 42: dismisses one particular worker (the Staff window's "Fire this one"). Their task is released exactly as
   * `fireStaff` releases the one it picks. Null when there is no such worker.
   */
  fireStaffById(id: number): StaffRuntime | null {
    const worker = this.staff.get(id);
    if (!worker) return null;
    this.releaseTask(worker, true);
    this.staff.delete(worker.id);
    return worker;
  }

  /** Phase 42: every worker as plain data, ascending by id (a pure read). */
  workersSnapshot(): WorkerSnapshot[] {
    return [...this.staff.values()]
      .sort((left, right) => left.id - right.id)
      .map((worker) => ({
        id: worker.id,
        role: worker.role,
        state: worker.state,
        cell: { x: worker.currentCell.x, y: worker.currentCell.y },
        task: worker.task === null
          ? null
          : { kind: worker.task.kind, targetObjectId: worker.task.targetObjectId, targetCell: { ...worker.task.targetCell } },
      }));
  }

  getBin(objectId: number): BinRuntime | undefined {
    return this.bins.get(objectId);
  }

  /** Phase 29: a guest was sick on `cell`: litter like any other (cleaners clean it), but marked as sick. */
  addSick(cell: Cell): number {
    const accepted = this.addLitter(cell, GAME_CONFIG.operations.litter.sickUnits);
    if (accepted > 0) {
      const target = this.world.paths.has(keyOf(cell)) ? cell : this.nearestEntranceConnectedPath(cell);
      const pile = target ? this.litter.get(keyOf(target)) : undefined;
      if (pile) pile.sick = true;
    }
    return accepted;
  }

  addLitter(cell: Cell, units = 1): number {
    this.navigation.sync(this.world.paths, this.world.pathVersion);
    const requested = Math.max(0, Math.floor(Number.isFinite(units) ? units : 0));
    const available = Math.max(0, GAME_CONFIG.operations.litter.maximumUnits - this.totalLitterUnits());
    const accepted = Math.min(requested, available);
    if (accepted <= 0) return 0;
    const target = this.world.paths.has(keyOf(cell)) ? { ...cell } : this.nearestEntranceConnectedPath(cell);
    if (!target) return 0;
    const key = keyOf(target);
    const pile = this.litter.get(key);
    if (pile) pile.units += accepted;
    else this.litter.set(key, { cell: target, units: accepted, assignedCleanerId: null, sick: false });
    return accepted;
  }

  snapshot(): OperationsSnapshot {
    this.navigation.sync(this.world.paths, this.world.pathVersion);
    const litterUnits = this.totalLitterUnits();
    const bins = [...this.bins.values()].sort((left, right) => left.objectId - right.objectId);
    const binsFull = bins.filter((bin) => bin.fill >= bin.capacity).length;
    const connectedPathTiles = Math.max(0, this.navigation.connectedCells(this.world.entrance).length - 1);
    const pathDivisor = Math.max(GAME_CONFIG.operations.cleanliness.minimumPathDivisor, connectedPathTiles);
    const litterPenalty = Math.min(
      GAME_CONFIG.operations.cleanliness.maximumLitterPenalty,
      litterUnits / pathDivisor * GAME_CONFIG.operations.cleanliness.litterDensityMultiplier * this.rules.litterImpactMultiplier,
    );
    const fullBinPenalty = bins.length > 0
      ? binsFull / bins.length * GAME_CONFIG.operations.cleanliness.fullBinFractionPenalty
      : 0;
    const rideRuntimes = [...this.rides.rides.values()] as PhaseSixRideRuntime[];
    const conditions = rideRuntimes.map((ride) => this.rideCondition(ride));
    const brokenRideIds = new Set(rideRuntimes.filter((ride) => this.rideIsBroken(ride)).map((ride) => ride.objectId));
    const assignedBrokenRideIds = new Set([...this.staff.values()]
      .filter((worker) => worker.task?.kind === 'repairRide' && worker.task.targetObjectId !== null)
      .map((worker) => worker.task!.targetObjectId!));
    const cleaners = [...this.staff.values()].filter((worker) => worker.role === 'cleaner');
    const mechanics = [...this.staff.values()].filter((worker) => worker.role === 'mechanic');

    return {
      elapsedSeconds: round(this.elapsedSeconds, 3),
      cleanliness: {
        score: round(clamp(100 - litterPenalty - fullBinPenalty, 0, 100)),
        litterUnits,
        dirtyPathTiles: this.litter.size,
        binsTotal: bins.length,
        binsFull,
        averageBinFillPercent: bins.length > 0
          ? round(bins.reduce((total, bin) => total + bin.fill / bin.capacity * 100, 0) / bins.length)
          : 0,
      },
      maintenance: {
        averageRideCondition: conditions.length > 0
          ? round(conditions.reduce((total, condition) => total + condition, 0) / conditions.length)
          : null,
        wornRides: rideRuntimes.filter((ride) =>
          !this.rideIsBroken(ride)
          && this.rideCondition(ride) <= GAME_CONFIG.operations.maintenance.preventiveConditionThreshold,
        ).length,
        brokenRides: brokenRideIds.size,
        awaitingMechanic: [...brokenRideIds].filter((id) => !assignedBrokenRideIds.has(id)).length,
      },
      staff: {
        cleaners: {
          total: cleaners.length,
          busy: cleaners.filter((worker) => worker.state !== 'idle').length,
          salaryPerInterval: this.effectiveSalary('cleaner'),
          trainingLevel: this.trainingLevel.cleaner,
          trainingCost: this.trainingCost('cleaner'),
        },
        mechanics: {
          total: mechanics.length,
          busy: mechanics.filter((worker) => worker.state !== 'idle').length,
          salaryPerInterval: this.effectiveSalary('mechanic'),
          trainingLevel: this.trainingLevel.mechanic,
          trainingCost: this.trainingCost('mechanic'),
        },
        payrollIntervalSeconds: GAME_CONFIG.operations.payrollIntervalSeconds,
        capacityPerRole: this.staffCapacity(),
        maximumTrainingLevel: GAME_CONFIG.operations.staff.training.maximumLevel,
      },
      litter: [...this.litter.values()]
        .sort((left, right) => compareCells(left.cell, right.cell))
        .map((pile) => ({ ...pile, cell: { ...pile.cell } })),
      bins: bins.map((bin) => ({
        objectId: bin.objectId,
        fill: bin.fill,
        capacity: bin.capacity,
        full: bin.fill >= bin.capacity,
        assignedCleanerId: bin.assignedCleanerId,
      })),
      workers: [...this.staff.values()].sort((left, right) => left.id - right.id).map((worker) => ({
        id: worker.id,
        role: worker.role,
        state: worker.state,
        position: { ...worker.position },
        currentCell: { ...worker.currentCell },
        task: worker.task ? {
          kind: worker.task.kind,
          targetObjectId: worker.task.targetObjectId,
          targetCell: { ...worker.task.targetCell },
          progress: worker.task.workDurationSeconds > 0
            ? round(clamp(1 - worker.task.workRemainingSeconds / worker.task.workDurationSeconds, 0, 1), 3)
            : 0,
        } : null,
      })),
    };
  }

  private consumeWasteEvents(): void {
    const events = this.shops.drainCompletionEvents().sort((left, right) => left.id - right.id);
    for (const event of events) {
      const bin = this.nearestAvailableBin(event.cell);
      if (bin) bin.fill = Math.min(bin.capacity, bin.fill + 1);
      else this.addLitter(event.cell, 1);
    }
  }

  private nearestAvailableBin(origin: Cell): BinRuntime | null {
    let best: { bin: BinRuntime; distance: number } | null = null;
    for (const bin of [...this.bins.values()].sort((left, right) => left.objectId - right.objectId)) {
      if (bin.fill >= bin.capacity) continue;
      const object = this.world.objects.get(bin.objectId);
      if (!object) continue;
      const route = this.navigation.findNearestRoute(origin, this.accessCells(object));
      if (!route) continue;
      const distance = route.length - 1;
      if (distance > GAME_CONFIG.operations.litter.binUseRangeCells) continue;
      if (!best || distance < best.distance || (distance === best.distance && bin.objectId < best.bin.objectId)) {
        best = { bin, distance };
      }
    }
    return best?.bin ?? null;
  }

  private reconcileStaffTasks(): void {
    for (const worker of [...this.staff.values()].sort((left, right) => left.id - right.id)) {
      if (worker.task && !this.taskStillValid(worker.task)) {
        this.releaseTask(worker, true);
        continue;
      }
      if (worker.routeVersion === this.world.pathVersion) continue;
      const safeCell = this.navigation.contains(worker.currentCell)
        ? { ...worker.currentCell }
        : this.nearestEntranceConnectedPath(worker.position);
      if (!safeCell) {
        this.releaseTask(worker, true);
        worker.state = 'idle';
        continue;
      }
      worker.currentCell = safeCell;
      worker.position = { ...safeCell };
      worker.routeVersion = this.world.pathVersion;
      if (worker.task?.maintenanceStarted && this.navigation.contains(worker.task.targetCell)) {
        worker.route = [{ ...safeCell }];
        worker.routeIndex = 1;
        continue;
      }
      if (!worker.task) {
        worker.route = [{ ...safeCell }];
        worker.routeIndex = 1;
        continue;
      }
      const route = this.routeForTask(worker.currentCell, worker.task);
      if (!route) {
        this.releaseTask(worker, true);
        continue;
      }
      worker.task.targetCell = { ...route[route.length - 1] };
      worker.route = route;
      worker.routeIndex = Math.min(1, route.length);
      worker.state = 'walking';
    }
  }

  private taskStillValid(task: StaffTaskRuntime): boolean {
    if (task.kind === 'cleanLitter') return (this.litter.get(keyOf(task.targetCell))?.units ?? 0) > 0;
    if (task.kind === 'emptyBin') return task.targetObjectId !== null && this.bins.has(task.targetObjectId);
    if (task.targetObjectId === null) return false;
    const ride = this.rides.rides.get(task.targetObjectId) as PhaseSixRideRuntime | undefined;
    if (!ride) return false;
    if (task.maintenanceStarted) return true;
    return task.kind === 'repairRide'
      ? this.rideIsBroken(ride)
      : !this.rideIsBroken(ride)
        && this.rideCondition(ride) <= GAME_CONFIG.operations.maintenance.preventiveConditionThreshold;
  }

  private assignIdleStaff(): void {
    for (const worker of [...this.staff.values()].sort((left, right) => left.id - right.id)) {
      if (worker.task) continue;
      if (worker.role === 'cleaner') this.assignCleaner(worker);
      else this.assignMechanic(worker);
    }
  }

  private assignCleaner(worker: StaffRuntime): void {
    const candidates: CleanerCandidate[] = [];
    for (const bin of this.bins.values()) {
      if (bin.assignedCleanerId !== null) continue;
      const full = bin.fill >= bin.capacity;
      const ready = bin.fill >= Math.min(bin.capacity, GAME_CONFIG.operations.litter.binEmptyThreshold);
      if (!full && !ready) continue;
      const object = this.world.objects.get(bin.objectId);
      if (!object) continue;
      const route = this.navigation.findNearestRoute(worker.currentCell, this.accessCells(object));
      if (!route) continue;
      candidates.push({
        priority: full ? 0 : 2,
        severity: bin.fill,
        kind: 'emptyBin',
        targetObjectId: bin.objectId,
        targetCell: route[route.length - 1],
        targetKey: String(bin.objectId),
        route,
      });
    }
    for (const [key, pile] of this.litter) {
      if (pile.assignedCleanerId !== null) continue;
      const route = this.navigation.findRoute(worker.currentCell, pile.cell);
      if (!route) continue;
      candidates.push({
        priority: 1,
        severity: pile.units,
        kind: 'cleanLitter',
        targetObjectId: null,
        targetCell: pile.cell,
        targetKey: key,
        route,
      });
    }
    candidates.sort((left, right) => left.priority - right.priority
      || right.severity - left.severity
      || left.route.length - right.route.length
      || left.targetKey.localeCompare(right.targetKey));
    const candidate = candidates[0];
    if (!candidate) {
      worker.state = 'idle';
      return;
    }
    const duration = this.workSeconds('cleaner', candidate.kind === 'cleanLitter'
      ? GAME_CONFIG.operations.cleaner.litterSecondsPerUnit
      : GAME_CONFIG.operations.cleaner.binEmptySeconds);
    worker.task = {
      kind: candidate.kind,
      targetObjectId: candidate.targetObjectId,
      targetCell: { ...candidate.targetCell },
      workRemainingSeconds: duration,
      workDurationSeconds: duration,
      maintenanceStarted: false,
    };
    worker.route = candidate.route;
    worker.routeIndex = Math.min(1, candidate.route.length);
    worker.routeVersion = this.world.pathVersion;
    worker.state = 'walking';
    if (candidate.kind === 'cleanLitter') this.litter.get(candidate.targetKey)!.assignedCleanerId = worker.id;
    else this.bins.get(candidate.targetObjectId!)!.assignedCleanerId = worker.id;
  }

  private assignMechanic(worker: StaffRuntime): void {
    const claimedRideIds = new Set([...this.staff.values()]
      .map((candidate) => candidate.task?.targetObjectId)
      .filter((id): id is number => id !== null && id !== undefined));
    const candidates: MechanicCandidate[] = [];
    for (const ride of [...this.rides.rides.values()].sort((left, right) => left.objectId - right.objectId) as PhaseSixRideRuntime[]) {
      if (claimedRideIds.has(ride.objectId)) continue;
      const broken = this.rideIsBroken(ride);
      const condition = this.rideCondition(ride);
      if (!broken && condition > GAME_CONFIG.operations.maintenance.preventiveConditionThreshold) continue;
      const object = this.world.objects.get(ride.objectId);
      if (!object) continue;
      const route = this.navigation.findNearestRoute(worker.currentCell, this.accessCells(object));
      if (!route) continue;
      candidates.push({
        priority: broken ? 0 : 1,
        condition,
        kind: broken ? 'repairRide' : 'inspectRide',
        targetObjectId: ride.objectId,
        targetCell: route[route.length - 1],
        route,
      });
    }
    candidates.sort((left, right) => left.priority - right.priority
      || left.condition - right.condition
      || left.route.length - right.route.length
      || left.targetObjectId - right.targetObjectId);
    const candidate = candidates[0];
    if (!candidate) {
      worker.state = 'idle';
      return;
    }
    const duration = this.workSeconds('mechanic', candidate.kind === 'repairRide'
      ? GAME_CONFIG.operations.mechanic.repairSeconds
      : GAME_CONFIG.operations.mechanic.inspectionSeconds);
    worker.task = {
      kind: candidate.kind,
      targetObjectId: candidate.targetObjectId,
      targetCell: { ...candidate.targetCell },
      workRemainingSeconds: duration,
      workDurationSeconds: duration,
      maintenanceStarted: false,
    };
    worker.route = candidate.route;
    worker.routeIndex = Math.min(1, candidate.route.length);
    worker.routeVersion = this.world.pathVersion;
    worker.state = 'walking';
  }

  private advanceStaff(worker: StaffRuntime, deltaSeconds: number, guests: Map<number, Guest>): void {
    let remainingSeconds = deltaSeconds;
    let transitions = 0;
    const transitionLimit = this.world.paths.size + GAME_CONFIG.operations.litter.maximumUnits + 20;
    while (worker.task && transitions < transitionLimit) {
      transitions += 1;
      if (worker.state === 'walking') {
        if (worker.routeIndex >= worker.route.length) {
          this.arriveAtTask(worker, guests);
          continue;
        }
        if (remainingSeconds <= EPSILON_SECONDS) return;
        const target = worker.route[worker.routeIndex];
        const dx = target.x - worker.position.x;
        const dy = target.y - worker.position.y;
        const distance = Math.hypot(dx, dy);
        const travelSeconds = distance / this.walkingCellsPerSecond(worker.role);
        if (travelSeconds - remainingSeconds > EPSILON_SECONDS) {
          const fraction = remainingSeconds / Math.max(EPSILON_SECONDS, travelSeconds);
          worker.position.x += dx * fraction;
          worker.position.y += dy * fraction;
          return;
        }
        worker.position = { ...target };
        worker.currentCell = { ...target };
        worker.routeIndex += 1;
        remainingSeconds = Math.max(0, remainingSeconds - travelSeconds);
        continue;
      }
      if (worker.state === 'waiting') {
        this.tryStartMechanicWork(worker, guests);
        if (worker.state === 'waiting' || !worker.task) return;
        continue;
      }
      if (worker.state === 'working') {
        if (!this.taskStillValid(worker.task)) {
          this.releaseTask(worker, true);
          return;
        }
        if (remainingSeconds <= EPSILON_SECONDS) return;
        if (worker.task.workRemainingSeconds - remainingSeconds > EPSILON_SECONDS) {
          worker.task.workRemainingSeconds -= remainingSeconds;
          this.publishMaintenanceProgress(worker);
          return;
        }
        remainingSeconds = Math.max(0, remainingSeconds - worker.task.workRemainingSeconds);
        worker.task.workRemainingSeconds = 0;
        this.publishMaintenanceProgress(worker);
        this.completeWork(worker);
        continue;
      }
      return;
    }
  }

  private arriveAtTask(worker: StaffRuntime, guests: Map<number, Guest>): void {
    if (!worker.task) return;
    if (worker.role === 'mechanic') {
      this.tryStartMechanicWork(worker, guests);
      return;
    }
    worker.state = 'working';
  }

  private tryStartMechanicWork(worker: StaffRuntime, guests: Map<number, Guest>): void {
    const task = worker.task;
    if (!task || task.targetObjectId === null) {
      this.releaseTask(worker, true);
      return;
    }
    const kind = this.maintenanceKind(task.kind);
    if (!kind) {
      this.releaseTask(worker, true);
      return;
    }
    const result = this.phaseSixRides().beginMaintenance(task.targetObjectId, kind, guests);
    if (result === 'running') {
      worker.state = 'waiting';
      return;
    }
    if (result !== 'started') {
      this.releaseTask(worker, true);
      return;
    }
    task.maintenanceStarted = true;
    worker.state = 'working';
    this.phaseSixRides().setMaintenanceProgress(task.targetObjectId, 0);
  }

  private publishMaintenanceProgress(worker: StaffRuntime): void {
    const task = worker.task;
    if (worker.role !== 'mechanic' || !task?.maintenanceStarted || task.targetObjectId === null) return;
    const progress = task.workDurationSeconds > 0
      ? clamp(1 - task.workRemainingSeconds / task.workDurationSeconds, 0, 1)
      : 1;
    this.phaseSixRides().setMaintenanceProgress(task.targetObjectId, progress);
  }

  private completeWork(worker: StaffRuntime): void {
    const task = worker.task;
    if (!task) return;
    if (task.kind === 'cleanLitter') {
      const key = keyOf(task.targetCell);
      const pile = this.litter.get(key);
      if (!pile) {
        this.releaseTask(worker, false);
        return;
      }
      pile.units -= 1;
      if (pile.units > 0) {
        const unitSeconds = this.workSeconds('cleaner', GAME_CONFIG.operations.cleaner.litterSecondsPerUnit);
        task.workRemainingSeconds = unitSeconds;
        task.workDurationSeconds = unitSeconds;
        return;
      }
      this.litter.delete(key);
      this.releaseTask(worker, false);
      return;
    }
    if (task.kind === 'emptyBin') {
      if (task.targetObjectId !== null) {
        const bin = this.bins.get(task.targetObjectId);
        if (bin) bin.fill = 0;
      }
      this.releaseTask(worker, false);
      return;
    }
    if (task.targetObjectId !== null) {
      const kind = this.maintenanceKind(task.kind);
      const object = this.world.objects.get(task.targetObjectId);
      const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
      if (kind && definition) {
        const maintenance = GAME_CONFIG.operations.maintenance;
        const cost = kind === 'repair'
          ? Math.max(maintenance.minimumRepairCost, Math.round(definition.buildCost * maintenance.repairCostBuildFraction))
          : Math.max(maintenance.minimumInspectionCost, Math.round(definition.buildCost * maintenance.inspectionCostBuildFraction));
        this.phaseSixRides().completeMaintenance(task.targetObjectId, kind, cost);
      }
    }
    this.releaseTask(worker, false);
  }

  private maintenanceKind(kind: StaffTaskKind): RideMaintenanceKind | null {
    if (kind === 'inspectRide') return 'inspection';
    if (kind === 'repairRide') return 'repair';
    return null;
  }

  private releaseTask(worker: StaffRuntime, cancelRide: boolean): void {
    const task = worker.task;
    if (task?.kind === 'cleanLitter') {
      const pile = this.litter.get(keyOf(task.targetCell));
      if (pile?.assignedCleanerId === worker.id) pile.assignedCleanerId = null;
    } else if (task?.kind === 'emptyBin' && task.targetObjectId !== null) {
      const bin = this.bins.get(task.targetObjectId);
      if (bin?.assignedCleanerId === worker.id) bin.assignedCleanerId = null;
    } else if (cancelRide && task && task.targetObjectId !== null) {
      this.phaseSixRides().cancelMaintenance(task.targetObjectId);
    }
    worker.task = null;
    worker.state = 'idle';
    worker.route = [{ ...worker.currentCell }];
    worker.routeIndex = 1;
    worker.routeVersion = this.world.pathVersion;
  }

  private cancelTasks(predicate: (task: StaffTaskRuntime) => boolean): void {
    for (const worker of this.staff.values()) {
      if (worker.task && predicate(worker.task)) this.releaseTask(worker, true);
    }
  }

  private routeForTask(start: Cell, task: StaffTaskRuntime): Cell[] | null {
    if (task.kind === 'cleanLitter') return this.navigation.findRoute(start, task.targetCell);
    if (task.targetObjectId === null) return null;
    const object = this.world.objects.get(task.targetObjectId);
    return object ? this.navigation.findNearestRoute(start, this.accessCells(object)) : null;
  }

  private accessCells(object: PlacedObject): Cell[] {
    const definition = BUILD_BY_ID.get(object.definitionId);
    if (!definition) return [];
    const footprint = this.world.objectFootprint(object);
    const occupied = new Set(footprint.map(keyOf));
    const access = new Map<string, Cell>();
    for (const cell of footprint) {
      for (const direction of CARDINALS) {
        const candidate = { x: cell.x + direction.x, y: cell.y + direction.y };
        const key = keyOf(candidate);
        if (!occupied.has(key) && this.world.paths.has(key)) access.set(key, candidate);
      }
    }
    return [...access.values()].sort(compareCells);
  }

  private nearestEntranceConnectedPath(origin: Cell): Cell | null {
    const connected = this.navigation.connectedCells(this.world.entrance);
    let best: Cell | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const cell of connected) {
      const distance = Math.abs(cell.x - origin.x) + Math.abs(cell.y - origin.y);
      if (distance < bestDistance || (distance === bestDistance && best && compareCells(cell, best) < 0)) {
        best = cell;
        bestDistance = distance;
      }
    }
    return best ? { ...best } : null;
  }

  private processPayroll(worker: StaffRuntime, deltaSeconds: number): void {
    worker.payrollRemainingSeconds -= deltaSeconds;
    // Bounded: a step is at most a few seconds, so more than a handful of paydays in one call can
    // only come from corrupt state, and an unbounded loop would freeze the tab.
    for (let paydays = 0; paydays < MAXIMUM_LOOP_ITERATIONS && worker.payrollRemainingSeconds <= EPSILON_SECONDS; paydays += 1) {
      this.postSalary(worker.role, false);
      worker.payrollRemainingSeconds += GAME_CONFIG.operations.payrollIntervalSeconds;
    }
  }

  private effectiveSalary(role: StaffRole): number {
    const base = role === 'cleaner'
      ? GAME_CONFIG.operations.cleaner.salaryPerInterval
      : GAME_CONFIG.operations.mechanic.salaryPerInterval;
    const trained = 1 + this.trainingLevel[role] * GAME_CONFIG.operations.staff.training.salaryPerLevel;
    return Math.round(base * this.rules.staffSalaryMultiplier * trained * 100) / 100;
  }

  /** A task takes less time the better the crew is trained. */
  private workSeconds(role: StaffRole, baseSeconds: number): number {
    const speed = 1 + this.trainingLevel[role] * GAME_CONFIG.operations.staff.training.workSpeedPerLevel;
    return baseSeconds / speed;
  }

  private walkingCellsPerSecond(role: StaffRole): number {
    const trained = 1 + this.trainingLevel[role] * GAME_CONFIG.operations.staff.training.walkSpeedPerLevel;
    return GAME_CONFIG.operations.staffWalkingCellsPerSecond * this.rules.staffSpeedMultiplier * trained;
  }

  private postSalary(role: StaffRole, firstShift: boolean): void {
    const amount = this.effectiveSalary(role);
    const label = `${role === 'cleaner' ? 'Cleaner' : 'Mechanic'} ${firstShift ? 'first shift wage' : 'payroll'}`;
    this.world.postTransaction(-amount, label, 'staff-salaries');
  }

  private updateGuestCleanliness(deltaSeconds: number, guests: Map<number, Guest>): void {
    this.happinessAccumulatorSeconds += deltaSeconds;
    const interval = GAME_CONFIG.operations.litter.happinessIntervalSeconds;
    for (let rounds = 0; rounds < MAXIMUM_LOOP_ITERATIONS && this.happinessAccumulatorSeconds + EPSILON_SECONDS >= interval; rounds += 1) {
      this.happinessAccumulatorSeconds -= interval;
      for (const guest of [...guests.values()].sort((left, right) => left.id - right.id)) {
        if (guest.state === 'riding' || guest.state === 'shopping' || guest.state === 'usingFacility') continue;
        const localUnits = this.localLitterUnits(guest.currentCell);
        if (localUnits <= 0) continue;
        const sickNearby = this.sickLitterNear(guest.currentCell);
        const penalty = Math.min(
          GAME_CONFIG.operations.litter.maximumHappinessPenalty,
          localUnits * GAME_CONFIG.operations.litter.happinessPenaltyPerUnit * this.rules.litterImpactMultiplier,
        ) * (sickNearby ? GAME_CONFIG.guestLife.sickLitterFactor : 1);
        guest.happiness = Math.max(0, guest.happiness - penalty);
        const canComment = guest.state === 'wandering' || guest.state === 'walkingToRide'
          || guest.state === 'walkingToShop' || guest.state === 'entering' || guest.state === 'walkingToBench';
        if (canComment && (sickNearby || guest.stateTimerSeconds >= interval)) {
          // Phase 30: through setThought, so a complaint's building link does not outlive the complaint.
          setThought(guest, sickNearby ? 'Eww, someone was sick here!' : 'This area is messy.');
        }
      }
    }
  }

  /** Phase 29: a sick pile within the litter radius of `cell`. */
  private sickLitterNear(cell: Cell): boolean {
    const radius = GAME_CONFIG.operations.litter.happinessRadiusCells;
    for (let y = cell.y - radius; y <= cell.y + radius; y += 1) {
      for (let x = cell.x - radius; x <= cell.x + radius; x += 1) {
        if (Math.abs(x - cell.x) + Math.abs(y - cell.y) > radius) continue;
        if (this.litter.get(`${x},${y}`)?.sick) return true;
      }
    }
    return false;
  }

  private localLitterUnits(cell: Cell): number {
    const radius = GAME_CONFIG.operations.litter.happinessRadiusCells;
    let total = 0;
    for (let y = cell.y - radius; y <= cell.y + radius; y += 1) {
      for (let x = cell.x - radius; x <= cell.x + radius; x += 1) {
        if (Math.abs(x - cell.x) + Math.abs(y - cell.y) > radius) continue;
        total += this.litter.get(`${x},${y}`)?.units ?? 0;
      }
    }
    return total;
  }

  private totalLitterUnits(): number {
    let total = 0;
    for (const pile of this.litter.values()) total += pile.units;
    return total;
  }

  private rideCondition(ride: PhaseSixRideRuntime): number {
    return Number.isFinite(ride.condition) ? clamp(ride.condition, 0, 100) : 100;
  }

  private rideIsBroken(ride: PhaseSixRideRuntime): boolean {
    return Boolean(ride.broken) || String(ride.status) === 'broken';
  }

  private phaseSixRides(): PhaseSixRideSimulation {
    return this.rides as PhaseSixRideSimulation;
  }
}
