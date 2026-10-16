import { BUILD_BY_ID } from '../content/catalog';
import { afterRide, setThought } from '../guests/life';
import { GAME_CONFIG } from '../config';
import type { Guest } from '../guests/types';
import { plainNumber } from '../save/plainData';
import type { RideRuntimeState, RideSimulationState, Serializable } from '../save/state';
import { MAXIMUM_SAVED_AMOUNT, MAXIMUM_SAVED_COUNTER, MAXIMUM_SAVED_PRICE, MAXIMUM_SAVED_SECONDS } from '../save/ranges';
import { invalidState } from '../save/version';
import { ZERO_SCENERY_INFLUENCE, type SceneryInfluenceReader } from '../scenery/types';
import type { GameWorld } from '../World';
import { neutralConditions, type ParkConditions } from '../weather/types';
import type { MaintenanceKind, RideClosureReason, RideRuntime, RideSnapshot, RideStatus } from './types';

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));
const RIDE_EPSILON_SECONDS = 1e-9;

export const conditionWearPerCycle = (
  intensity: number,
  durationSeconds: number,
  reliability: number,
): number => {
  const maintenance = GAME_CONFIG.operations.maintenance;
  const safeIntensity = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 100);
  const safeDuration = clamp(Number.isFinite(durationSeconds) ? durationSeconds : 0, 0, 600);
  const safeReliability = clamp(Number.isFinite(reliability) ? reliability : 100, 0, 100);
  const baseWear = maintenance.conditionLossBasePerCycle
    + safeIntensity * maintenance.conditionLossIntensityFactor
    + safeDuration * maintenance.conditionLossDurationFactor;
  return baseWear * (1 + (100 - safeReliability) / 100);
};

export const breakdownProbability = (condition: number, reliability: number): number => {
  const safeThreshold = GAME_CONFIG.operations.maintenance.safeConditionThreshold;
  const safeCondition = clamp(Number.isFinite(condition) ? condition : 0, 0, 100);
  if (safeCondition >= safeThreshold) return 0;
  const safeReliability = clamp(Number.isFinite(reliability) ? reliability : 0, 0, 100);
  const conditionPressure = (safeThreshold - safeCondition) / Math.max(1, safeThreshold);
  const unreliability = (100 - safeReliability) / 100;
  return clamp(0.04 + conditionPressure ** 1.6 * 0.7 + unreliability * 0.25, 0, 0.95);
};

const deterministicBreakdownRoll = (
  objectId: number,
  completedCycles: number,
  breakdownCount: number,
): number => {
  let hash = Math.imul(objectId ^ 0x9e3779b9, 0x85ebca6b);
  hash ^= Math.imul(completedCycles + 1, 0xc2b2ae35);
  hash ^= Math.imul(breakdownCount + 1, 0x27d4eb2f);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return (hash >>> 0) / 0x1_0000_0000;
};

export type QueueJoinResult = 'joined' | 'closed' | 'full' | 'unaffordable' | 'missing';
export type BeginMaintenanceResult = 'started' | 'running' | 'missing' | 'invalid';

const RIDE_STATUSES: readonly RideStatus[] = ['idle', 'waiting', 'running', 'closed', 'broken', 'maintenance'];
const MAINTENANCE_KINDS: readonly MaintenanceKind[] = ['inspection', 'repair'];
const SAVE_OWNER = 'RideSimulation';
/** Mirrors the throughput window used by trimThroughput. */
const THROUGHPUT_WINDOW_SECONDS = 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Throws invalid-state unless `value` is a finite number within [minimum, maximum]. */
const requireNumber = (value: unknown, path: string, minimum: number, maximum = MAXIMUM_SAVED_AMOUNT): number => {
  if (!isFiniteNumber(value)) throw invalidState(SAVE_OWNER, path, `must be a finite number (got ${String(value)})`);
  if (value < minimum || value > maximum) {
    throw invalidState(SAVE_OWNER, path, `must be within ${minimum}..${maximum} (got ${value})`);
  }
  return value;
};

const requireCount = (value: unknown, path: string): number => {
  const number = requireNumber(value, path, 0, MAXIMUM_SAVED_COUNTER);
  if (!Number.isInteger(number)) throw invalidState(SAVE_OWNER, path, `must be a whole number (got ${number})`);
  return number;
};

const requireBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') throw invalidState(SAVE_OWNER, path, `must be a boolean (got ${String(value)})`);
  return value;
};

const requireIdList = (value: unknown, path: string): number[] => {
  if (!Array.isArray(value)) throw invalidState(SAVE_OWNER, path, 'must be an array of guest ids');
  const seen = new Set<number>();
  return value.map((entry: unknown, index) => {
    const id = requireCount(entry, `${path}[${index}]`);
    if (seen.has(id)) throw invalidState(SAVE_OWNER, `${path}[${index}]`, `repeats guest id ${id}`);
    seen.add(id);
    return id;
  });
};

export class RideSimulation implements Serializable<RideSimulationState> {
  readonly rides = new Map<number, RideRuntime>();
  private elapsedSeconds = 0;
  /** The shared per-tick park conditions; a storm closes open-air rides through it (derived, never saved). */
  private conditions: ParkConditions = neutralConditions();

  constructor(
    private readonly world: GameWorld,
    private readonly scenery: SceneryInfluenceReader = ZERO_SCENERY_INFLUENCE,
    private readonly rules: {
      rideOperatingCostMultiplier: number;
      rideDispatchMultiplier: number;
      /** Phase 25: scales the per-cycle breakdown probability (capped at 0.95 only when it is not 1). */
      breakdownRateMultiplier: number;
    } = {
      rideOperatingCostMultiplier: 1,
      rideDispatchMultiplier: 1,
      breakdownRateMultiplier: 1,
    },
  ) {
    this.syncWithWorld();
  }

  /** The breakdown rule: `p` untouched at 1 (no new float on that path), otherwise `min(0.95, p x m)`. */
  private scaledBreakdownProbability(probability: number): number {
    const multiplier = this.rules.breakdownRateMultiplier;
    return multiplier === 1 ? probability : Math.min(0.95, probability * multiplier);
  }

  private get dispatchWaitSeconds(): number {
    return GAME_CONFIG.rides.maximumDispatchWaitSeconds * this.rules.rideDispatchMultiplier;
  }

  step(stepMs: number, guests: Map<number, Guest>): void {
    const deltaSeconds = Number.isFinite(stepMs) ? Math.max(0, stepMs) / 1000 : 0;
    this.elapsedSeconds += deltaSeconds;
    this.syncWithWorld(guests);
    const orderedRides = [...this.rides.values()].sort((left, right) => left.objectId - right.objectId);
    for (const ride of orderedRides) this.stepRide(ride, deltaSeconds, guests);
  }

  syncWithWorld(guests?: Map<number, Guest>): void {
    const liveRideIds = new Set<number>();
    for (const object of this.world.objects.values()) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (definition?.kind !== 'ride') continue;
      liveRideIds.add(object.id);
      if (!this.rides.has(object.id)) {
        const profile = this.world.rideProfile(object.id);
        this.rides.set(object.id, {
          objectId: object.id,
          open: true,
          status: 'idle',
          ticketPrice: profile?.ticketPrice ?? 4,
          queueGuestIds: [],
          riderGuestIds: [],
          dispatchTimerSeconds: 0,
          cycleRemainingSeconds: 0,
          lifetimeRevenue: 0,
          lifetimeOperatingCost: 0,
          ridersToday: 0,
          completedCycles: 0,
          satisfactionTotal: 0,
          satisfactionCount: 0,
          boardedAtSeconds: [],
          condition: 100,
          reliability: clamp(profile?.reliability ?? 90, 0, 100),
          broken: false,
          pendingBreakdown: false,
          breakdownCount: 0,
          inspectionsCompleted: 0,
          repairsCompleted: 0,
          lifetimeMaintenanceCost: 0,
          maintenanceKind: null,
          maintenanceProgress: 0,
        });
      }
    }
    for (const [objectId, ride] of this.rides) {
      if (liveRideIds.has(objectId)) continue;
      if (guests) this.releaseGuests(ride, guests, 'The ride was removed.');
      this.rides.delete(objectId);
    }
  }

  /**
   * Read-only image of every ride, in Map order (unsorted consumers sum floats in that order, and it
   * differs from objectId order after a demolish and rebuild). Written as field-by-field literals so
   * a field added to RideRuntimeState without a line here is a compile error. It never calls
   * snapshot() or trimThroughput() on the live arrays: those mutate, and a save must not change
   * the simulation it describes.
   */
  serialize(): RideSimulationState {
    const cutoff = this.elapsedSeconds - THROUGHPUT_WINDOW_SECONDS;
    const rides: RideRuntimeState[] = [];
    for (const ride of this.rides.values()) {
      const path = `rides[${ride.objectId}]`;
      // Canonical trimmed form of a COPY: the same leading-prefix rule as trimThroughput.
      let firstKept = 0;
      while (firstKept < ride.boardedAtSeconds.length && ride.boardedAtSeconds[firstKept] < cutoff) firstKept += 1;
      rides.push({
        objectId: ride.objectId,
        open: ride.open,
        status: ride.status,
        ticketPrice: plainNumber(ride.ticketPrice, `${path}.ticketPrice`),
        queueGuestIds: [...ride.queueGuestIds],
        riderGuestIds: [...ride.riderGuestIds],
        dispatchTimerSeconds: plainNumber(ride.dispatchTimerSeconds, `${path}.dispatchTimerSeconds`),
        cycleRemainingSeconds: plainNumber(ride.cycleRemainingSeconds, `${path}.cycleRemainingSeconds`),
        lifetimeRevenue: plainNumber(ride.lifetimeRevenue, `${path}.lifetimeRevenue`),
        lifetimeOperatingCost: plainNumber(ride.lifetimeOperatingCost, `${path}.lifetimeOperatingCost`),
        ridersToday: plainNumber(ride.ridersToday, `${path}.ridersToday`),
        completedCycles: plainNumber(ride.completedCycles, `${path}.completedCycles`),
        satisfactionTotal: plainNumber(ride.satisfactionTotal, `${path}.satisfactionTotal`),
        satisfactionCount: plainNumber(ride.satisfactionCount, `${path}.satisfactionCount`),
        boardedAtSeconds: ride.boardedAtSeconds
          .slice(firstKept)
          .map((seconds, index) => plainNumber(seconds, `${path}.boardedAtSeconds[${index}]`)),
        condition: plainNumber(ride.condition, `${path}.condition`),
        reliability: plainNumber(ride.reliability, `${path}.reliability`),
        broken: ride.broken,
        pendingBreakdown: ride.pendingBreakdown,
        breakdownCount: plainNumber(ride.breakdownCount, `${path}.breakdownCount`),
        inspectionsCompleted: plainNumber(ride.inspectionsCompleted, `${path}.inspectionsCompleted`),
        repairsCompleted: plainNumber(ride.repairsCompleted, `${path}.repairsCompleted`),
        lifetimeMaintenanceCost: plainNumber(ride.lifetimeMaintenanceCost, `${path}.lifetimeMaintenanceCost`),
        maintenanceKind: ride.maintenanceKind,
        maintenanceProgress: plainNumber(ride.maintenanceProgress, `${path}.maintenanceProgress`),
      });
    }
    return { elapsedSeconds: plainNumber(this.elapsedSeconds, 'elapsedSeconds'), rides };
  }

  /**
   * Replaces every runtime with the saved ones. Everything is validated and built into fresh
   * objects first, so a refused state leaves the simulation untouched. The Map is cleared and
   * refilled in saved order (never via syncWithWorld, which would create runtimes in world order
   * and, given guests, release the guests of any runtime it considered missing). The saved set must
   * equal the world's rides exactly, because the first step's syncWithWorld would otherwise
   * silently add or drop runtimes. Guest cross-checks belong to the session consistency pass.
   */
  restore(state: RideSimulationState): void {
    if (!isRecord(state)) throw invalidState(SAVE_OWNER, 'state', 'must be an object');
    const elapsedSeconds = requireNumber(state.elapsedSeconds, 'elapsedSeconds', 0, MAXIMUM_SAVED_SECONDS);
    if (!Array.isArray(state.rides)) throw invalidState(SAVE_OWNER, 'rides', 'must be an array');
    const restored: RideRuntime[] = [];
    const seenIds = new Set<number>();
    state.rides.forEach((entry: unknown, index) => {
      const path = `rides[${index}]`;
      if (!isRecord(entry)) throw invalidState(SAVE_OWNER, path, 'must be an object');
      const objectId = requireCount(entry.objectId, `${path}.objectId`);
      if (seenIds.has(objectId)) throw invalidState(SAVE_OWNER, `${path}.objectId`, `repeats ride ${objectId}`);
      seenIds.add(objectId);
      const worldObject = this.world.objects.get(objectId);
      if (!worldObject) throw invalidState(SAVE_OWNER, `${path}.objectId`, `names ride ${objectId}, which is not in the world`);
      if (BUILD_BY_ID.get(worldObject.definitionId)?.kind !== 'ride') {
        throw invalidState(SAVE_OWNER, `${path}.objectId`, `names object ${objectId} (${worldObject.definitionId}), which is not a ride`);
      }
      const status = entry.status;
      if (typeof status !== 'string' || !RIDE_STATUSES.includes(status as RideStatus)) {
        throw invalidState(SAVE_OWNER, `${path}.status`, `is not a ride status (got ${String(status)})`);
      }
      const maintenanceKind = entry.maintenanceKind;
      if (maintenanceKind !== null
        && (typeof maintenanceKind !== 'string' || !MAINTENANCE_KINDS.includes(maintenanceKind as MaintenanceKind))) {
        throw invalidState(SAVE_OWNER, `${path}.maintenanceKind`, `is not null, 'inspection' or 'repair' (got ${String(maintenanceKind)})`);
      }
      // The status, kind and progress travel together; operations validates them against a mechanic task.
      if ((status === 'maintenance') !== (maintenanceKind !== null)) {
        throw invalidState(SAVE_OWNER, `${path}.maintenanceKind`, `disagrees with status '${status}'`);
      }
      const queueGuestIds = requireIdList(entry.queueGuestIds, `${path}.queueGuestIds`);
      const riderGuestIds = requireIdList(entry.riderGuestIds, `${path}.riderGuestIds`);
      const queued = new Set(queueGuestIds);
      riderGuestIds.forEach((id, riderIndex) => {
        if (queued.has(id)) throw invalidState(SAVE_OWNER, `${path}.riderGuestIds[${riderIndex}]`, `lists guest ${id}, who is also in the queue`);
      });
      if (!Array.isArray(entry.boardedAtSeconds)) throw invalidState(SAVE_OWNER, `${path}.boardedAtSeconds`, 'must be an array');
      let previous = Number.NEGATIVE_INFINITY;
      const boardedAtSeconds = entry.boardedAtSeconds.map((value: unknown, boardedIndex) => {
        const seconds = requireNumber(value, `${path}.boardedAtSeconds[${boardedIndex}]`, 0, MAXIMUM_SAVED_SECONDS);
        if (seconds < previous) {
          throw invalidState(SAVE_OWNER, `${path}.boardedAtSeconds[${boardedIndex}]`, 'is out of ascending order');
        }
        previous = seconds;
        return seconds;
      });
      restored.push({
        objectId,
        open: requireBoolean(entry.open, `${path}.open`),
        status: status as RideStatus,
        ticketPrice: requireNumber(entry.ticketPrice, `${path}.ticketPrice`, 0, MAXIMUM_SAVED_PRICE),
        queueGuestIds,
        riderGuestIds,
        dispatchTimerSeconds: requireNumber(entry.dispatchTimerSeconds, `${path}.dispatchTimerSeconds`, 0, MAXIMUM_SAVED_SECONDS),
        cycleRemainingSeconds: requireNumber(entry.cycleRemainingSeconds, `${path}.cycleRemainingSeconds`, 0, MAXIMUM_SAVED_SECONDS),
        lifetimeRevenue: requireNumber(entry.lifetimeRevenue, `${path}.lifetimeRevenue`, 0),
        lifetimeOperatingCost: requireNumber(entry.lifetimeOperatingCost, `${path}.lifetimeOperatingCost`, 0),
        ridersToday: requireCount(entry.ridersToday, `${path}.ridersToday`),
        completedCycles: requireCount(entry.completedCycles, `${path}.completedCycles`),
        satisfactionTotal: requireNumber(entry.satisfactionTotal, `${path}.satisfactionTotal`, 0),
        satisfactionCount: requireCount(entry.satisfactionCount, `${path}.satisfactionCount`),
        boardedAtSeconds,
        condition: requireNumber(entry.condition, `${path}.condition`, 0, 100),
        reliability: requireNumber(entry.reliability, `${path}.reliability`, 0, 100),
        broken: requireBoolean(entry.broken, `${path}.broken`),
        pendingBreakdown: requireBoolean(entry.pendingBreakdown, `${path}.pendingBreakdown`),
        breakdownCount: requireCount(entry.breakdownCount, `${path}.breakdownCount`),
        inspectionsCompleted: requireCount(entry.inspectionsCompleted, `${path}.inspectionsCompleted`),
        repairsCompleted: requireCount(entry.repairsCompleted, `${path}.repairsCompleted`),
        lifetimeMaintenanceCost: requireNumber(entry.lifetimeMaintenanceCost, `${path}.lifetimeMaintenanceCost`, 0),
        maintenanceKind: maintenanceKind as MaintenanceKind | null,
        maintenanceProgress: requireNumber(entry.maintenanceProgress, `${path}.maintenanceProgress`, 0, 1),
      });
    });
    for (const object of this.world.objects.values()) {
      if (BUILD_BY_ID.get(object.definitionId)?.kind === 'ride' && !seenIds.has(object.id)) {
        throw invalidState(SAVE_OWNER, 'rides', `has no runtime for world ride ${object.id} (${object.definitionId})`);
      }
    }

    this.rides.clear();
    this.elapsedSeconds = 0;
    for (const runtime of restored) this.rides.set(runtime.objectId, runtime);
    this.elapsedSeconds = elapsedSeconds;
  }

  getRide(objectId: number): RideRuntime | undefined {
    return this.rides.get(objectId);
  }

  /** Shares the session's conditions object, which the weather owner overwrites in place every tick. */
  setConditions(conditions: ParkConditions): void {
    this.conditions = conditions;
  }

  /**
   * Open-air rides are closed for the duration of a storm. This is DERIVED from the weather and the
   * catalog's openAir flag: the player's `open` switch is never touched, so the ride reopens by
   * itself when the storm ends unless the player closed it, and nothing extra is saved.
   */
  isStormClosed(objectId: number): boolean {
    if (!this.conditions.stormActive) return false;
    const object = this.world.objects.get(objectId);
    return object !== undefined && BUILD_BY_ID.get(object.definitionId)?.openAir !== false;
  }

  /** How many rides the storm is holding closed right now (the player's own closures do not count). */
  stormClosedCount(): number {
    let count = 0;
    for (const ride of this.rides.values()) if (ride.open && this.isStormClosed(ride.objectId)) count += 1;
    return count;
  }

  private closedForGuests(ride: RideRuntime): boolean {
    return !ride.open || this.isStormClosed(ride.objectId);
  }

  isAvailable(objectId: number): boolean {
    const ride = this.rides.get(objectId);
    return Boolean(ride?.open
      && !this.isStormClosed(objectId)
      && !ride.broken
      && !ride.pendingBreakdown
      && ride.maintenanceKind === null
      && ride.status !== 'broken'
      && ride.status !== 'maintenance');
  }

  forceBreakdown(objectId: number, guests: Map<number, Guest>): boolean {
    const ride = this.rides.get(objectId);
    if (!ride || ride.broken || ride.pendingBreakdown || ride.maintenanceKind !== null) return false;
    if (ride.status === 'running') {
      ride.pendingBreakdown = true;
      return true;
    }
    this.breakRide(ride, guests);
    return true;
  }

  beginMaintenance(
    objectId: number,
    kind: MaintenanceKind,
    guests: Map<number, Guest>,
  ): BeginMaintenanceResult {
    const ride = this.rides.get(objectId);
    if (!ride) return 'missing';
    if (ride.status === 'running') return 'running';
    if (ride.maintenanceKind !== null) return 'invalid';
    if (kind === 'repair' ? !ride.broken : ride.broken || ride.condition >= 100) return 'invalid';
    if (ride.queueGuestIds.length > 0) {
      this.releaseQueue(
        ride,
        guests,
        kind === 'repair'
          ? 'The ride is awaiting repairs.'
          : 'The ride closed for an inspection.',
        2,
      );
    }
    ride.maintenanceKind = kind;
    ride.maintenanceProgress = 0;
    ride.status = 'maintenance';
    return 'started';
  }

  /**
   * One-shot card primitive (Phase 25): repairs every broken ride that no maintenance has started on and that is not
   * mid-cycle, at once and free here (the card posts its own cost). Each goes through `beginMaintenance('repair')`
   * (which releases its queue) and `completeMaintenance(..., 0)`; a mechanic's queued task for it drops on its own next
   * step (`taskStillValid`). Returns the repaired ride ids, ascending. Never touches `world.version`.
   */
  repairBroken(guests: Map<number, Guest>): number[] {
    const repaired: number[] = [];
    for (const objectId of this.sortedRideIds()) {
      const ride = this.rides.get(objectId);
      if (!ride || !this.repairEligible(ride)) continue;
      if (this.beginMaintenance(objectId, 'repair', guests) !== 'started') continue;
      if (this.completeMaintenance(objectId, 'repair', 0)) repaired.push(objectId);
    }
    return repaired;
  }

  /**
   * One-shot card primitive (Phase 25, scope `all`): repairs every broken ride as `repairBroken` does, inspects every
   * other ride below condition 100 that no maintenance has started on and that is not mid-cycle (its queue is released:
   * the declared downside), and leaves every ride it touched at condition 100. Returns the serviced ids, ascending.
   */
  serviceAll(guests: Map<number, Guest>): number[] {
    const serviced: number[] = [];
    for (const objectId of this.sortedRideIds()) {
      const ride = this.rides.get(objectId);
      if (!ride) continue;
      const kind: MaintenanceKind | null = this.repairEligible(ride) ? 'repair' : this.inspectionEligible(ride) ? 'inspection' : null;
      if (kind === null || this.beginMaintenance(objectId, kind, guests) !== 'started') continue;
      if (!this.completeMaintenance(objectId, kind, 0)) continue;
      ride.condition = 100;
      serviced.push(objectId);
    }
    return serviced;
  }

  /** How many rides `repairBroken` would repair now (the card's "can play" check). */
  repairableCount(): number {
    let count = 0;
    for (const ride of this.rides.values()) if (this.repairEligible(ride)) count += 1;
    return count;
  }

  /** How many rides `serviceAll` would touch now. */
  serviceableCount(): number {
    let count = 0;
    for (const ride of this.rides.values()) if (this.repairEligible(ride) || this.inspectionEligible(ride)) count += 1;
    return count;
  }

  private repairEligible(ride: RideRuntime): boolean {
    return ride.broken && ride.maintenanceKind === null && ride.status !== 'running';
  }

  private inspectionEligible(ride: RideRuntime): boolean {
    return !ride.broken && ride.maintenanceKind === null && ride.status !== 'running' && ride.condition < 100;
  }

  private sortedRideIds(): number[] {
    return [...this.rides.keys()].sort((left, right) => left - right);
  }

  setMaintenanceProgress(objectId: number, progress: number): void {
    const ride = this.rides.get(objectId);
    if (!ride || ride.maintenanceKind === null || !Number.isFinite(progress)) return;
    ride.maintenanceProgress = clamp(progress, 0, 1);
  }

  cancelMaintenance(objectId: number): void {
    const ride = this.rides.get(objectId);
    if (!ride || ride.maintenanceKind === null) return;
    ride.maintenanceKind = null;
    ride.maintenanceProgress = 0;
    ride.status = ride.broken ? 'broken' : this.closedForGuests(ride) ? 'closed' : 'idle';
  }

  completeMaintenance(objectId: number, kind: MaintenanceKind, cost: number): boolean {
    const ride = this.rides.get(objectId);
    if (!ride || ride.maintenanceKind !== kind) return false;
    const safeCost = Number.isFinite(cost) ? Math.max(0, cost) : 0;
    const restoreCondition = kind === 'repair'
      ? GAME_CONFIG.operations.maintenance.repairRestoreCondition
      : GAME_CONFIG.operations.maintenance.inspectionRestoreCondition;
    ride.condition = clamp(Math.max(ride.condition, restoreCondition), 0, 100);
    if (kind === 'repair') {
      ride.broken = false;
      ride.repairsCompleted += 1;
    } else {
      ride.inspectionsCompleted += 1;
    }
    ride.pendingBreakdown = false;
    ride.maintenanceKind = null;
    ride.maintenanceProgress = 0;
    ride.lifetimeMaintenanceCost += safeCost;
    ride.status = this.closedForGuests(ride) ? 'closed' : 'idle';
    if (safeCost > 0) {
      const object = this.world.objects.get(objectId);
      const name = object ? BUILD_BY_ID.get(object.definitionId)?.name : undefined;
      this.world.postTransaction(-safeCost, `${name ?? 'Ride'} ${kind}`, 'maintenance');
    }
    return true;
  }

  joinQueue(objectId: number, guest: Guest): QueueJoinResult {
    const ride = this.getRide(objectId);
    if (!ride) return 'missing';
    if (!this.isAvailable(objectId)) return 'closed';
    if (ride.queueGuestIds.length >= GAME_CONFIG.rides.maximumQueueLength) return 'full';
    if (guest.money < ride.ticketPrice) return 'unaffordable';
    if (!ride.queueGuestIds.includes(guest.id)) ride.queueGuestIds.push(guest.id);
    guest.state = 'queueing';
    guest.stateTimerSeconds = 0;
    guest.lastQueueWaitSeconds = 0;
    setThought(guest, `Queueing — $${ride.ticketPrice.toFixed(2)}.`);
    if (!guest.recentRideIds.includes(objectId)) guest.recentRideIds.unshift(objectId);
    guest.recentRideIds = guest.recentRideIds.slice(0, 3);
    return 'joined';
  }

  leaveQueue(objectId: number, guestId: number): boolean {
    const ride = this.rides.get(objectId);
    if (!ride) return false;
    const index = ride.queueGuestIds.indexOf(guestId);
    if (index < 0) return false;
    ride.queueGuestIds.splice(index, 1);
    if (ride.queueGuestIds.length === 0) ride.dispatchTimerSeconds = 0;
    return true;
  }

  setOpen(objectId: number, open: boolean): void {
    const ride = this.getRide(objectId);
    if (!ride) return;
    ride.open = open;
    if (ride.status === 'running') return;
    if (ride.maintenanceKind !== null) ride.status = 'maintenance';
    else if (ride.broken) ride.status = 'broken';
    else ride.status = this.closedForGuests(ride) ? 'closed' : 'idle';
  }

  setTicketPrice(objectId: number, price: number): void {
    const ride = this.getRide(objectId);
    if (!ride) return;
    ride.ticketPrice = Math.round(clamp(
      price,
      GAME_CONFIG.rides.minimumTicketPrice,
      GAME_CONFIG.rides.maximumTicketPrice,
    ) * 2) / 2;
  }

  estimatedWaitSeconds(objectId: number): number {
    const ride = this.rides.get(objectId);
    const profile = this.world.rideProfile(objectId);
    if (!ride || !profile) return 0;
    const capacity = profile.capacity;
    const duration = profile.duration;
    if (ride.queueGuestIds.length === 0) return 0;
    const fullCyclesAhead = Math.floor((ride.queueGuestIds.length - 1) / capacity);
    const dispatchWait = Math.max(0, this.dispatchWaitSeconds - ride.dispatchTimerSeconds);
    return (ride.status === 'running' ? ride.cycleRemainingSeconds : 0) + dispatchWait + fullCyclesAhead * duration;
  }

  queueIndex(objectId: number, guestId: number): number {
    return this.rides.get(objectId)?.queueGuestIds.indexOf(guestId) ?? -1;
  }

  snapshot(objectId: number): RideSnapshot | null {
    const ride = this.getRide(objectId);
    const object = this.world.objects.get(objectId);
    const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
    if (!ride || !object || !definition) return null;
    this.trimThroughput(ride);
    const profile = this.world.rideProfile(objectId);
    if (!profile) return null;
    const coaster = this.world.coasters.get(objectId);
    const sceneryScore = this.scenery.scoreForObject(objectId);
    return {
      objectId,
      definitionId: definition.id,
      name: definition.name,
      open: ride.open,
      closureReason: this.closureReason(ride),
      status: ride.status,
      ticketPrice: ride.ticketPrice,
      queueLength: ride.queueGuestIds.length,
      estimatedWaitSeconds: this.estimatedWaitSeconds(objectId),
      capacity: profile.capacity,
      rideDurationSeconds: profile.duration,
      cycleRemainingSeconds: ride.cycleRemainingSeconds,
      ridersToday: ride.ridersToday,
      lifetimeRevenue: ride.lifetimeRevenue,
      operatingCost: profile.runningCost,
      throughputPerHour: ride.boardedAtSeconds.length * 60,
      satisfaction: ride.satisfactionCount > 0 ? ride.satisfactionTotal / ride.satisfactionCount : null,
      condition: ride.condition,
      reliability: ride.reliability,
      broken: ride.broken,
      pendingBreakdown: ride.pendingBreakdown,
      breakdownChance: breakdownProbability(ride.condition, ride.reliability),
      breakdownCount: ride.breakdownCount,
      inspectionsCompleted: ride.inspectionsCompleted,
      repairsCompleted: ride.repairsCompleted,
      lifetimeMaintenanceCost: ride.lifetimeMaintenanceCost,
      maintenanceKind: ride.maintenanceKind,
      maintenanceProgress: ride.maintenanceProgress,
      sceneryScore,
      sceneryChoiceBonus: sceneryScore * GAME_CONFIG.scenery.rideChoiceWeight,
      scenerySatisfactionBonus: sceneryScore * GAME_CONFIG.scenery.rideSatisfactionWeight,
      excitement: profile.excitement,
      intensity: profile.intensity,
      coaster: coaster
        ? {
          pieces: coaster.stats.pieces,
          turns: coaster.stats.turns,
          drops: coaster.stats.drops,
          totalDescent: coaster.stats.totalDescent,
          highestHeight: coaster.stats.highestHeight,
          topSpeed: coaster.stats.topSpeed,
          loops: coaster.stats.loops,
          boosts: coaster.stats.boosts,
        }
        : null,
    };
  }

  /**
   * Why a ride is closed for guests, or null: the player's switch wins, and a breakdown or
   * maintenance is its own status, not a closure, so the storm is never blamed for it.
   */
  private closureReason(ride: RideRuntime): RideClosureReason | null {
    if (!ride.open) return 'player';
    if (ride.broken || ride.maintenanceKind !== null) return null;
    return this.isStormClosed(ride.objectId) ? 'storm' : null;
  }

  private stepRide(ride: RideRuntime, deltaSeconds: number, guests: Map<number, Guest>): void {
    this.pruneMissingGuests(ride, guests);
    this.trimThroughput(ride);
    if (ride.maintenanceKind !== null) {
      if (ride.queueGuestIds.length > 0) {
        this.releaseQueue(ride, guests, 'The ride closed for maintenance.', 2);
      }
      ride.status = 'maintenance';
      return;
    }
    if (ride.broken) {
      if (ride.queueGuestIds.length > 0) {
        this.releaseQueue(ride, guests, 'The ride broke down while I was waiting.', 7);
      }
      ride.status = 'broken';
      return;
    }
    const stormClosed = ride.open && this.isStormClosed(ride.objectId);
    if (!ride.open || stormClosed) {
      if (ride.queueGuestIds.length > 0) {
        if (stormClosed) this.releaseQueue(ride, guests, 'The ride closed for the storm.', 2);
        else this.releaseQueue(ride, guests, 'The ride closed while I was waiting.');
      }
      if (ride.status !== 'running') ride.status = 'closed';
    }
    if (ride.status === 'running') {
      ride.cycleRemainingSeconds = Math.max(0, ride.cycleRemainingSeconds - deltaSeconds);
      if (ride.cycleRemainingSeconds <= RIDE_EPSILON_SECONDS) this.completeCycle(ride, guests);
      return;
    }
    if (!ride.open || stormClosed) return;
    if (!this.world.gateOpen) {
      if (ride.queueGuestIds.length === 0) ride.status = 'idle';
      return;
    }
    if (ride.queueGuestIds.length === 0) {
      ride.status = 'idle';
      ride.dispatchTimerSeconds = 0;
      return;
    }
    ride.status = 'waiting';
    ride.dispatchTimerSeconds += deltaSeconds;
    const capacity = this.world.rideProfile(ride.objectId)?.capacity ?? 1;
    if (ride.queueGuestIds.length >= capacity || ride.dispatchTimerSeconds >= this.dispatchWaitSeconds) {
      this.dispatch(ride, guests);
    }
  }

  private dispatch(ride: RideRuntime, guests: Map<number, Guest>): void {
    const profile = this.world.rideProfile(ride.objectId);
    if (!profile) return;
    const capacity = profile.capacity;
    const candidates = ride.queueGuestIds.splice(0, capacity);
    const riders: number[] = [];
    for (const guestId of candidates) {
      const guest = guests.get(guestId);
      if (!guest) continue;
      if (guest.money < ride.ticketPrice) {
        guest.state = 'wandering';
        guest.destinationObjectId = null;
        // Phase 30: the price complaint names this ride.
        setThought(guest, "I'm not paying that much.", ride.objectId);
        guest.happiness = Math.max(0, guest.happiness - 3);
        guest.stateTimerSeconds = 0;
        continue;
      }
      guest.money -= ride.ticketPrice;
      guest.lastQueueWaitSeconds = guest.stateTimerSeconds;
      guest.state = 'riding';
      setThought(guest, `Riding ${profile.name}!`);
      guest.stateTimerSeconds = 0;
      riders.push(guestId);
      ride.lifetimeRevenue += ride.ticketPrice;
      ride.ridersToday += 1;
      ride.boardedAtSeconds.push(this.elapsedSeconds);
      this.world.postTransaction(ride.ticketPrice, `${profile.name} tickets`, 'ride-revenue');
    }
    if (riders.length === 0) {
      ride.status = ride.queueGuestIds.length > 0 ? 'waiting' : 'idle';
      ride.dispatchTimerSeconds = 0;
      return;
    }
    const operatingCost = Math.round(profile.runningCost
      * this.rules.rideOperatingCostMultiplier * 100) / 100;
    this.world.postTransaction(-operatingCost, `${profile.name} cycle operation`, 'ride-operations');
    ride.lifetimeOperatingCost += operatingCost;
    ride.riderGuestIds = riders;
    ride.status = 'running';
    ride.cycleRemainingSeconds = profile.duration;
    ride.dispatchTimerSeconds = 0;
  }

  private completeCycle(ride: RideRuntime, guests: Map<number, Guest>): void {
    const profile = this.world.rideProfile(ride.objectId);
    if (!profile) return;
    for (const guestId of ride.riderGuestIds) {
      const guest = guests.get(guestId);
      if (!guest) continue;
      const preferenceMatch = 1 - Math.abs(profile.intensity - guest.preferredIntensity) / 100;
      const satisfaction = clamp(
        45 + profile.excitement * 0.35 + preferenceMatch * 22
          - guest.lastQueueWaitSeconds * 0.2 - ride.ticketPrice * 1.2
          + this.scenery.scoreForObject(ride.objectId) * GAME_CONFIG.scenery.rideSatisfactionWeight,
        0,
        100,
      );
      guest.lastRideSatisfaction = satisfaction;
      guest.happiness = clamp(guest.happiness + (satisfaction - 50) * 0.12, 0, 100);
      // A great ride convinces the guest to stay longer — good parks hold their crowd.
      if (satisfaction >= 65) {
        guest.maximumVisitSeconds = Math.min(
          GAME_CONFIG.guests.maximumVisitSeconds,
          guest.maximumVisitSeconds + GAME_CONFIG.guests.goodRideStayBonusSeconds,
        );
      }
      guest.state = 'wandering';
      guest.destinationObjectId = null;
      setThought(guest, satisfaction >= 70 ? 'That was fantastic!' : satisfaction >= 45 ? 'That was fun.' : 'That was not for me.');
      guest.stateTimerSeconds = 0;
      // Phase 29: the ride settles in the stomach; a queasy rider stops to recover, a delighted one cheers.
      afterRide(guest, profile.intensity, satisfaction);
      ride.satisfactionTotal += satisfaction;
      ride.satisfactionCount += 1;
    }
    ride.riderGuestIds = [];
    ride.completedCycles += 1;
    ride.cycleRemainingSeconds = 0;
    ride.condition = clamp(ride.condition - conditionWearPerCycle(
      profile.intensity,
      profile.duration,
      ride.reliability,
    ), 0, 100);
    const failureProbability = this.scaledBreakdownProbability(breakdownProbability(ride.condition, ride.reliability));
    if (!ride.pendingBreakdown && failureProbability > 0) {
      ride.pendingBreakdown = deterministicBreakdownRoll(
        ride.objectId,
        ride.completedCycles,
        ride.breakdownCount,
      ) < failureProbability;
    }
    if (ride.pendingBreakdown) {
      this.breakRide(ride, guests);
      return;
    }
    ride.status = this.closedForGuests(ride) ? 'closed' : (ride.queueGuestIds.length > 0 ? 'waiting' : 'idle');
  }

  private breakRide(ride: RideRuntime, guests: Map<number, Guest>): void {
    ride.broken = true;
    ride.pendingBreakdown = false;
    ride.breakdownCount += 1;
    ride.status = 'broken';
    this.releaseQueue(ride, guests, 'The ride broke down while I was waiting.', 7);
  }

  private releaseQueue(
    ride: RideRuntime,
    guests: Map<number, Guest>,
    thought: string,
    happinessPenalty = 4,
  ): void {
    for (const guestId of ride.queueGuestIds) {
      const guest = guests.get(guestId);
      if (!guest) continue;
      guest.state = 'wandering';
      guest.destinationObjectId = null;
      setThought(guest, thought);
      guest.happiness = Math.max(0, guest.happiness - happinessPenalty);
      guest.stateTimerSeconds = 0;
    }
    ride.queueGuestIds = [];
    ride.dispatchTimerSeconds = 0;
  }

  private releaseGuests(ride: RideRuntime, guests: Map<number, Guest>, thought: string): void {
    this.releaseQueue(ride, guests, thought);
    for (const guestId of ride.riderGuestIds) {
      const guest = guests.get(guestId);
      if (!guest) continue;
      guest.state = 'wandering';
      guest.destinationObjectId = null;
      setThought(guest, thought);
      guest.stateTimerSeconds = 0;
    }
    ride.riderGuestIds = [];
  }

  private pruneMissingGuests(ride: RideRuntime, guests: Map<number, Guest>): void {
    ride.queueGuestIds = ride.queueGuestIds.filter((id) => guests.has(id));
    ride.riderGuestIds = ride.riderGuestIds.filter((id) => guests.has(id));
  }

  private trimThroughput(ride: RideRuntime): void {
    const cutoff = this.elapsedSeconds - 60;
    while (ride.boardedAtSeconds.length > 0 && ride.boardedAtSeconds[0] < cutoff) ride.boardedAtSeconds.shift();
  }
}
