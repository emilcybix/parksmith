import { BUILD_BY_ID } from '../content/catalog';
import { PRICEY_SOUVENIR_THOUGHT, SOUVENIR_THOUGHT, afterPurchase, setThought } from '../guests/life';
import { GAME_CONFIG } from '../config';
import type { Guest, GuestState } from '../guests/types';
import { plainNumber } from '../save/plainData';
import type { Serializable, ServiceCompletionEventState, ServiceRuntimeState, ShopSimulationState } from '../save/state';
import { MAXIMUM_SAVED_AMOUNT, MAXIMUM_SAVED_COUNTER, MAXIMUM_SAVED_PRICE, MAXIMUM_SAVED_SECONDS } from '../save/ranges';
import { invalidState } from '../save/version';
import { ZERO_SCENERY_INFLUENCE, type SceneryInfluenceReader } from '../scenery/types';
import type { GameWorld } from '../World';
import type { SouvenirKind } from '../types';
import type {
  ServiceCompletionEvent,
  ServiceKind,
  ServiceRuntime,
  ServiceSnapshot,
  ServiceStatus,
  WasteServiceKind,
} from './types';

interface ServiceProfile {
  kind: ServiceKind;
  defaultPrice: number;
  serviceTimeSeconds: number;
  needReduction: number;
}

type ShopGuestState = 'queueingForShop' | 'shopping' | 'usingFacility';

interface PhaseFourGuest extends Omit<Guest, 'state'> {
  state: GuestState | ShopGuestState;
  toiletNeed: number;
  lastPurchaseSatisfaction: number | null;
}

const serviceProfile = (definitionId: string): ServiceProfile | undefined => {
  const stats = BUILD_BY_ID.get(definitionId)?.stats;
  if (!stats?.serviceType) return undefined;
  return {
    kind: stats.serviceType,
    defaultPrice: stats.itemPrice ?? 0,
    serviceTimeSeconds: stats.serviceDuration ?? 1,
    needReduction: stats.needRelief ?? 0,
  };
};

const SERVICE_EPSILON_SECONDS = 1e-9;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const phaseFourGuest = (guest: Guest): PhaseFourGuest => guest as unknown as PhaseFourGuest;

export type ShopQueueJoinResult = 'joined' | 'closed' | 'full' | 'unaffordable' | 'missing' | 'busy';

const SERVICE_STATUSES: readonly ServiceStatus[] = ['idle', 'serving', 'closed'];
const WASTE_KINDS: readonly WasteServiceKind[] = ['food', 'drink'];
const SAVE_OWNER = 'ShopSimulation';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Throws invalid-state unless `value` is a finite number within [minimum, maximum]. */
const requireNumber = (value: unknown, path: string, minimum: number, maximum = MAXIMUM_SAVED_AMOUNT): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidState(SAVE_OWNER, path, `must be a finite number (got ${String(value)})`);
  }
  if (value < minimum || value > maximum) {
    throw invalidState(SAVE_OWNER, path, `must be within ${minimum}..${maximum} (got ${value})`);
  }
  return value;
};

const requireCount = (value: unknown, path: string, minimum = 0): number => {
  const number = requireNumber(value, path, minimum, MAXIMUM_SAVED_COUNTER);
  if (!Number.isInteger(number)) throw invalidState(SAVE_OWNER, path, `must be a whole number (got ${number})`);
  return number;
};

const requireBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') throw invalidState(SAVE_OWNER, path, `must be a boolean (got ${String(value)})`);
  return value;
};

export class ShopSimulation implements Serializable<ShopSimulationState> {
  readonly services = new Map<number, ServiceRuntime>();
  private completionEvents: ServiceCompletionEvent[] = [];
  private nextCompletionEventId = 1;

  constructor(
    private readonly world: GameWorld,
    private readonly scenery: SceneryInfluenceReader = ZERO_SCENERY_INFLUENCE,
    private readonly rules: { serviceDurationMultiplier: number; needReliefMultiplier: number } = {
      serviceDurationMultiplier: 1,
      needReliefMultiplier: 1,
    },
  ) {
    this.syncWithWorld();
  }

  step(stepMs: number, guests: Map<number, Guest>): void {
    const deltaSeconds = Number.isFinite(stepMs) ? Math.max(0, stepMs) / 1_000 : 0;
    this.syncWithWorld(guests);
    const services = [...this.services.values()].sort((left, right) => left.objectId - right.objectId);
    for (const service of services) this.stepService(service, deltaSeconds, guests);
  }

  syncWithWorld(guests?: Map<number, Guest>): void {
    const liveServiceIds = new Set<number>();
    for (const object of this.world.objects.values()) {
      const profile = serviceProfile(object.definitionId);
      if (!profile) continue;
      liveServiceIds.add(object.id);
      if (this.services.has(object.id)) continue;
      this.services.set(object.id, {
        objectId: object.id,
        definitionId: object.definitionId,
        kind: profile.kind,
        open: true,
        status: 'idle',
        itemPrice: profile.defaultPrice,
        serviceTimeSeconds: profile.serviceTimeSeconds * this.rules.serviceDurationMultiplier,
        queueGuestIds: [],
        activeGuestId: null,
        serviceRemainingSeconds: 0,
        customersServed: 0,
        lifetimeRevenue: 0,
        satisfactionTotal: 0,
        satisfactionCount: 0,
      });
    }

    for (const [objectId, service] of this.services) {
      if (liveServiceIds.has(objectId)) continue;
      if (guests) this.releaseAll(service, guests, 'The service was removed.');
      this.services.delete(objectId);
    }
  }

  /**
   * Read-only image of the shops, services in Map order (unsorted consumers iterate that order).
   * Field-by-field literals, so a field added to ServiceRuntimeState without a line here is a
   * compile error. completionEvents is normally empty between session steps but is saved so a save
   * taken between shops.step and operations.step loses no litter.
   */
  serialize(): ShopSimulationState {
    const services: ServiceRuntimeState[] = [];
    for (const service of this.services.values()) {
      const path = `services[${service.objectId}]`;
      services.push({
        objectId: service.objectId,
        definitionId: service.definitionId,
        kind: service.kind,
        open: service.open,
        status: service.status,
        itemPrice: plainNumber(service.itemPrice, `${path}.itemPrice`),
        serviceTimeSeconds: plainNumber(service.serviceTimeSeconds, `${path}.serviceTimeSeconds`),
        queueGuestIds: [...service.queueGuestIds],
        activeGuestId: service.activeGuestId,
        serviceRemainingSeconds: plainNumber(service.serviceRemainingSeconds, `${path}.serviceRemainingSeconds`),
        customersServed: plainNumber(service.customersServed, `${path}.customersServed`),
        lifetimeRevenue: plainNumber(service.lifetimeRevenue, `${path}.lifetimeRevenue`),
        satisfactionTotal: plainNumber(service.satisfactionTotal, `${path}.satisfactionTotal`),
        satisfactionCount: plainNumber(service.satisfactionCount, `${path}.satisfactionCount`),
      });
    }
    const completionEvents: ServiceCompletionEventState[] = this.completionEvents.map((event, index) => ({
      id: event.id,
      serviceObjectId: event.serviceObjectId,
      guestId: event.guestId,
      kind: event.kind,
      cell: {
        x: plainNumber(event.cell.x, `completionEvents[${index}].cell.x`),
        y: plainNumber(event.cell.y, `completionEvents[${index}].cell.y`),
      },
    }));
    return { nextCompletionEventId: this.nextCompletionEventId, completionEvents, services };
  }

  /**
   * Replaces every service runtime, the event buffer and the id generator. Validated and built
   * into fresh objects first, so a refused state changes nothing. Never calls syncWithWorld (it
   * would create runtimes in world order and release guests it thinks are orphaned). The saved
   * set must equal the world's services, serviceTimeSeconds is taken as saved (it was frozen at
   * creation from the catalog and ruleset, and the saved value wins), and a guest may occupy only
   * one queue or active slot across all services; pruneInactiveGuests would otherwise heal such a
   * state silently on the first step. Guest state and destination cross-checks belong to the
   * session consistency pass.
   */
  restore(state: ShopSimulationState): void {
    if (!isRecord(state)) throw invalidState(SAVE_OWNER, 'state', 'must be an object');
    const nextCompletionEventId = requireCount(state.nextCompletionEventId, 'nextCompletionEventId', 1);
    if (!Array.isArray(state.services)) throw invalidState(SAVE_OWNER, 'services', 'must be an array');
    if (!Array.isArray(state.completionEvents)) throw invalidState(SAVE_OWNER, 'completionEvents', 'must be an array');

    const restored: ServiceRuntime[] = [];
    const seenIds = new Set<number>();
    const guestSlots = new Map<number, string>();
    const claimGuest = (guestId: number, path: string): void => {
      const previous = guestSlots.get(guestId);
      if (previous !== undefined) throw invalidState(SAVE_OWNER, path, `lists guest ${guestId}, who is already at ${previous}`);
      guestSlots.set(guestId, path);
    };
    state.services.forEach((entry: unknown, index) => {
      const path = `services[${index}]`;
      if (!isRecord(entry)) throw invalidState(SAVE_OWNER, path, 'must be an object');
      const objectId = requireCount(entry.objectId, `${path}.objectId`);
      if (seenIds.has(objectId)) throw invalidState(SAVE_OWNER, `${path}.objectId`, `repeats service ${objectId}`);
      seenIds.add(objectId);
      const worldObject = this.world.objects.get(objectId);
      if (!worldObject) throw invalidState(SAVE_OWNER, `${path}.objectId`, `names service ${objectId}, which is not in the world`);
      const profile = serviceProfile(worldObject.definitionId);
      if (!profile) {
        throw invalidState(SAVE_OWNER, `${path}.objectId`, `names object ${objectId} (${worldObject.definitionId}), which is not a service`);
      }
      if (entry.definitionId !== worldObject.definitionId) {
        throw invalidState(SAVE_OWNER, `${path}.definitionId`, `is ${String(entry.definitionId)} but the world object is ${worldObject.definitionId}`);
      }
      if (entry.kind !== profile.kind) {
        throw invalidState(SAVE_OWNER, `${path}.kind`, `is ${String(entry.kind)} but the catalog kind is ${profile.kind}`);
      }
      const status = entry.status;
      if (typeof status !== 'string' || !SERVICE_STATUSES.includes(status as ServiceStatus)) {
        throw invalidState(SAVE_OWNER, `${path}.status`, `is not a service status (got ${String(status)})`);
      }
      if (!Array.isArray(entry.queueGuestIds)) throw invalidState(SAVE_OWNER, `${path}.queueGuestIds`, 'must be an array of guest ids');
      const queueGuestIds = entry.queueGuestIds.map((value: unknown, queueIndex) => {
        const guestId = requireCount(value, `${path}.queueGuestIds[${queueIndex}]`);
        claimGuest(guestId, `${path}.queueGuestIds[${queueIndex}]`);
        return guestId;
      });
      let activeGuestId: number | null = null;
      if (entry.activeGuestId !== null) {
        activeGuestId = requireCount(entry.activeGuestId, `${path}.activeGuestId`);
        claimGuest(activeGuestId, `${path}.activeGuestId`);
      }
      restored.push({
        objectId,
        definitionId: worldObject.definitionId,
        kind: profile.kind,
        open: requireBoolean(entry.open, `${path}.open`),
        status: status as ServiceStatus,
        itemPrice: requireNumber(entry.itemPrice, `${path}.itemPrice`, 0, MAXIMUM_SAVED_PRICE),
        serviceTimeSeconds: requireNumber(entry.serviceTimeSeconds, `${path}.serviceTimeSeconds`, 0, MAXIMUM_SAVED_SECONDS),
        queueGuestIds,
        activeGuestId,
        serviceRemainingSeconds: requireNumber(entry.serviceRemainingSeconds, `${path}.serviceRemainingSeconds`, 0, MAXIMUM_SAVED_SECONDS),
        customersServed: requireCount(entry.customersServed, `${path}.customersServed`),
        lifetimeRevenue: requireNumber(entry.lifetimeRevenue, `${path}.lifetimeRevenue`, 0),
        satisfactionTotal: requireNumber(entry.satisfactionTotal, `${path}.satisfactionTotal`, 0),
        satisfactionCount: requireCount(entry.satisfactionCount, `${path}.satisfactionCount`),
      });
    });
    for (const object of this.world.objects.values()) {
      if (serviceProfile(object.definitionId) && !seenIds.has(object.id)) {
        throw invalidState(SAVE_OWNER, 'services', `has no runtime for world service ${object.id} (${object.definitionId})`);
      }
    }

    const seenEventIds = new Set<number>();
    const events: ServiceCompletionEvent[] = state.completionEvents.map((value: unknown, index) => {
      const path = `completionEvents[${index}]`;
      if (!isRecord(value)) throw invalidState(SAVE_OWNER, path, 'must be an object');
      const id = requireCount(value.id, `${path}.id`, 1);
      if (id >= nextCompletionEventId) {
        throw invalidState(SAVE_OWNER, `${path}.id`, `${id} is not below nextCompletionEventId ${nextCompletionEventId}`);
      }
      if (seenEventIds.has(id)) throw invalidState(SAVE_OWNER, `${path}.id`, `repeats event id ${id}`);
      seenEventIds.add(id);
      const kind = value.kind;
      if (typeof kind !== 'string' || !WASTE_KINDS.includes(kind as WasteServiceKind)) {
        throw invalidState(SAVE_OWNER, `${path}.kind`, `must be 'food' or 'drink' (got ${String(kind)})`);
      }
      if (!isRecord(value.cell)) throw invalidState(SAVE_OWNER, `${path}.cell`, 'must be an object');
      return {
        id,
        serviceObjectId: requireCount(value.serviceObjectId, `${path}.serviceObjectId`),
        guestId: requireCount(value.guestId, `${path}.guestId`),
        kind: kind as WasteServiceKind,
        cell: {
          x: requireNumber(value.cell.x, `${path}.cell.x`, 0, this.world.width - 1),
          y: requireNumber(value.cell.y, `${path}.cell.y`, 0, this.world.height - 1),
        },
      };
    });

    this.services.clear();
    this.completionEvents = [];
    this.nextCompletionEventId = 1;
    for (const runtime of restored) this.services.set(runtime.objectId, runtime);
    this.completionEvents = events;
    this.nextCompletionEventId = nextCompletionEventId;
  }

  getService(objectId: number): ServiceRuntime | undefined {
    return this.services.get(objectId);
  }

  drainCompletionEvents(): ServiceCompletionEvent[] {
    const events = this.completionEvents.map((event) => ({ ...event, cell: { ...event.cell } }));
    this.completionEvents = [];
    return events;
  }

  joinQueue(objectId: number, guest: Guest): ShopQueueJoinResult {
    const service = this.getService(objectId);
    const profile = service ? serviceProfile(service.definitionId) : undefined;
    if (!service || !profile) return 'missing';
    if (!service.open || service.status === 'closed' || !this.world.gateOpen) return 'closed';

    const currentService = this.serviceContainingGuest(guest.id);
    if (currentService) return currentService.objectId === objectId ? 'joined' : 'busy';
    if (service.queueGuestIds.length >= GAME_CONFIG.services.maximumQueueLength) return 'full';
    if (this.priceRejection(phaseFourGuest(guest), service)) return 'unaffordable';

    service.queueGuestIds.push(guest.id);
    const customer = phaseFourGuest(guest);
    customer.state = 'queueingForShop';
    customer.destinationObjectId = objectId;
    customer.stateTimerSeconds = 0;
    customer.lastQueueWaitSeconds = 0;
    setThought(customer, this.queueThought(service));
    return 'joined';
  }

  leaveQueue(objectId: number, guestId: number): boolean {
    const service = this.services.get(objectId);
    if (!service) return false;
    const index = service.queueGuestIds.indexOf(guestId);
    if (index < 0) return false;
    service.queueGuestIds.splice(index, 1);
    return true;
  }

  setOpen(objectId: number, open: boolean): void {
    const service = this.getService(objectId);
    if (!service) return;
    service.open = open;
    if (!open && service.activeGuestId === null) service.status = 'closed';
    else if (open && service.status === 'closed') service.status = 'idle';
  }

  setPrice(objectId: number, price: number): void {
    const service = this.getService(objectId);
    if (!service || !Number.isFinite(price)) return;
    service.itemPrice = Math.round(clamp(
      price,
      GAME_CONFIG.services.minimumPrice,
      GAME_CONFIG.services.maximumPrice,
    ) / GAME_CONFIG.services.priceStep) * GAME_CONFIG.services.priceStep;
  }

  estimatedWaitSeconds(objectId: number, guestId?: number): number {
    const service = this.services.get(objectId);
    if (!service) return 0;
    if (guestId !== undefined && service.activeGuestId === guestId) return 0;
    const activeWait = service.activeGuestId === null ? 0 : service.serviceRemainingSeconds;
    if (guestId === undefined) return activeWait + service.queueGuestIds.length * service.serviceTimeSeconds;
    const index = service.queueGuestIds.indexOf(guestId);
    return index < 0 ? activeWait + service.queueGuestIds.length * service.serviceTimeSeconds
      : activeWait + index * service.serviceTimeSeconds;
  }

  queueIndex(objectId: number, guestId: number): number {
    return this.services.get(objectId)?.queueGuestIds.indexOf(guestId) ?? -1;
  }

  snapshot(objectId: number): ServiceSnapshot | null {
    const service = this.getService(objectId);
    const definition = service ? BUILD_BY_ID.get(service.definitionId) : undefined;
    if (!service || !definition) return null;
    const sceneryScore = this.scenery.scoreForObject(objectId);
    return {
      objectId,
      definitionId: service.definitionId,
      name: definition.name,
      kind: service.kind,
      open: service.open,
      status: service.status,
      itemPrice: service.itemPrice,
      serviceTimeSeconds: service.serviceTimeSeconds,
      serviceRemainingSeconds: service.serviceRemainingSeconds,
      queueLength: service.queueGuestIds.length,
      activeGuestId: service.activeGuestId,
      estimatedWaitSeconds: this.estimatedWaitSeconds(objectId),
      customersServed: service.customersServed,
      lifetimeRevenue: service.lifetimeRevenue,
      satisfaction: service.satisfactionCount > 0
        ? service.satisfactionTotal / service.satisfactionCount
        : null,
      sceneryScore,
      sceneryChoiceBonus: sceneryScore * GAME_CONFIG.scenery.serviceChoiceWeight,
      scenerySatisfactionBonus: sceneryScore * GAME_CONFIG.scenery.serviceSatisfactionWeight,
    };
  }

  private stepService(service: ServiceRuntime, deltaSeconds: number, guests: Map<number, Guest>): void {
    this.pruneInactiveGuests(service, guests);
    if (!service.open || !this.world.gateOpen) {
      const thought = service.open ? 'The park is closing.' : 'The service closed while I was waiting.';
      this.releaseAll(service, guests, thought);
      service.status = service.open ? 'idle' : 'closed';
      return;
    }

    let remainingSeconds = deltaSeconds;
    let transitions = 0;
    const transitionLimit = 3 + service.queueGuestIds.length * 2;
    while (transitions < transitionLimit) {
      transitions += 1;
      if (service.activeGuestId !== null) {
        if (service.serviceRemainingSeconds - remainingSeconds > SERVICE_EPSILON_SECONDS) {
          service.serviceRemainingSeconds -= remainingSeconds;
          return;
        }
        remainingSeconds = Math.max(0, remainingSeconds - service.serviceRemainingSeconds);
        service.serviceRemainingSeconds = 0;
        this.completeService(service, guests);
        continue;
      }

      if (service.queueGuestIds.length === 0) {
        service.status = 'idle';
        return;
      }
      if (!this.startNextCustomer(service, guests)) continue;
      if (remainingSeconds <= SERVICE_EPSILON_SECONDS) return;
    }
  }

  private startNextCustomer(service: ServiceRuntime, guests: Map<number, Guest>): boolean {
    const guestId = service.queueGuestIds.shift();
    if (guestId === undefined) return false;
    const guest = guests.get(guestId);
    if (!guest) return false;
    const customer = phaseFourGuest(guest);
    const rejection = this.priceRejection(customer, service);
    if (rejection) {
      this.releaseGuest(customer, rejection, 2, service.objectId);
      return false;
    }

    service.activeGuestId = guestId;
    service.serviceRemainingSeconds = service.serviceTimeSeconds;
    service.status = 'serving';
    customer.lastQueueWaitSeconds = customer.stateTimerSeconds;
    customer.state = service.kind === 'toilet' ? 'usingFacility' : 'shopping';
    customer.stateTimerSeconds = 0;
    setThought(customer, service.kind === 'food'
      ? 'Picking up something to eat.'
      : service.kind === 'drink'
        ? 'Getting a refreshing drink.'
        : service.kind === 'souvenir'
          ? 'Picking out a souvenir.'
          : 'Using the comfort cabin.');
    return true;
  }

  private completeService(service: ServiceRuntime, guests: Map<number, Guest>): void {
    const guestId = service.activeGuestId;
    service.activeGuestId = null;
    service.serviceRemainingSeconds = 0;
    if (guestId === null) return;
    const guest = guests.get(guestId);
    if (!guest) return;
    const customer = phaseFourGuest(guest);
    const profile = serviceProfile(service.definitionId);
    const definition = BUILD_BY_ID.get(service.definitionId);
    if (!profile || !definition) {
      this.releaseGuest(customer, 'That service is unavailable.');
      return;
    }
    const rejection = this.priceRejection(customer, service);
    if (rejection) {
      this.releaseGuest(customer, rejection, 2, service.objectId);
      return;
    }

    const needBefore = this.needFor(customer, service.kind);
    const needAfter = Math.max(0, needBefore - profile.needReduction * this.rules.needReliefMultiplier);
    this.setNeed(customer, service.kind, needAfter);
    customer.money -= service.itemPrice;
    if (service.itemPrice > 0) {
      const category = service.kind === 'food'
        ? 'food-revenue'
        : service.kind === 'drink'
          ? 'drink-revenue'
          : service.kind === 'souvenir'
            ? 'souvenir-revenue'
            : 'facility-revenue';
      this.world.postTransaction(service.itemPrice, `${definition.name} sales`, category);
    }

    const relief = needBefore - needAfter;
    const pricePremium = Math.max(0, service.itemPrice - profile.defaultPrice);
    // Phase 29: a souvenir meets no need; the delight of the keepsake stands in for the relief.
    const base = service.kind === 'souvenir'
      ? GAME_CONFIG.guestLife.souvenir.purchaseSatisfaction
      : 48 + relief * 0.55 + needBefore * 0.12;
    const satisfaction = clamp(
      base - pricePremium * 4 - customer.lastQueueWaitSeconds * 0.35
        + this.scenery.scoreForObject(service.objectId) * GAME_CONFIG.scenery.serviceSatisfactionWeight,
      0,
      100,
    );
    customer.lastPurchaseSatisfaction = satisfaction;
    customer.happiness = clamp(customer.happiness + (satisfaction - 50) * 0.1, 0, 100);
    if (satisfaction >= 60) {
      customer.maximumVisitSeconds = Math.min(
        GAME_CONFIG.guests.maximumVisitSeconds,
        customer.maximumVisitSeconds + GAME_CONFIG.guests.goodPurchaseStayBonusSeconds,
      );
    }
    customer.state = 'wandering';
    customer.destinationObjectId = null;
    customer.servicePriceLimit = null;
    customer.stateTimerSeconds = 0;
    // Phase 30: a pricey keepsake is a complaint about this stall; the thought links to it.
    setThought(
      customer,
      this.completedThought(service.kind, satisfaction, definition.stats?.souvenir, pricePremium),
      service.objectId,
    );
    // Phase 29: warm or cold in the hand, a keepsake kept, and a moment to eat, drink or show it off.
    afterPurchase(guest, service.kind, definition.serves, definition.stats?.souvenir);

    service.customersServed += 1;
    service.lifetimeRevenue += service.itemPrice;
    service.satisfactionTotal += satisfaction;
    service.satisfactionCount += 1;
    if (service.kind === 'food' || service.kind === 'drink') {
      this.completionEvents.push({
        id: this.nextCompletionEventId++,
        serviceObjectId: service.objectId,
        guestId: customer.id,
        kind: service.kind,
        cell: { ...customer.currentCell },
      });
    }
  }

  private needFor(guest: PhaseFourGuest, kind: ServiceKind): number {
    if (kind === 'food') return guest.hunger;
    if (kind === 'drink') return guest.thirst;
    if (kind === 'souvenir') return 0;
    return guest.toiletNeed;
  }

  private setNeed(guest: PhaseFourGuest, kind: ServiceKind, value: number): void {
    if (kind === 'food') guest.hunger = value;
    else if (kind === 'drink') guest.thirst = value;
    else if (kind === 'toilet') guest.toiletNeed = value;
  }

  private queueThought(service: ServiceRuntime): string {
    const price = service.itemPrice > 0 ? ` — $${service.itemPrice.toFixed(2)}` : '';
    if (service.kind === 'food') return `Queueing for food${price}.`;
    if (service.kind === 'drink') return `Queueing for a drink${price}.`;
    if (service.kind === 'souvenir') return `Queueing for a souvenir${price}.`;
    return `Queueing for the toilet${price}.`;
  }

  private completedThought(
    kind: ServiceKind,
    satisfaction: number,
    souvenir: SouvenirKind | undefined,
    pricePremium: number,
  ): string {
    if (kind === 'toilet') return satisfaction >= 55 ? 'Much better.' : 'That facility could be better.';
    if (kind === 'drink') return satisfaction >= 70 ? 'That was refreshing!' : 'That drink was okay.';
    // Phase 30: the keepsake's own line (life.ts) unless a price above the default disappointed, when the price
    // complaint stands and links the stall. A slow queue at the default price is not the price's fault (review fix).
    if (kind === 'souvenir') {
      if (satisfaction < 60 && pricePremium > 1e-9) return PRICEY_SOUVENIR_THOUGHT;
      return souvenir !== undefined ? SOUVENIR_THOUGHT[souvenir] : 'What a lovely souvenir!';
    }
    return satisfaction >= 70 ? 'That snack hit the spot!' : 'That food was okay.';
  }

  private releaseQueue(service: ServiceRuntime, guests: Map<number, Guest>, thought: string): void {
    for (const guestId of service.queueGuestIds) {
      const guest = guests.get(guestId);
      if (guest) this.releaseGuest(phaseFourGuest(guest), thought, 3);
    }
    service.queueGuestIds = [];
  }

  private releaseAll(service: ServiceRuntime, guests: Map<number, Guest>, thought: string): void {
    this.releaseQueue(service, guests, thought);
    if (service.activeGuestId !== null) {
      const guest = guests.get(service.activeGuestId);
      if (guest) this.releaseGuest(phaseFourGuest(guest), thought);
    }
    service.activeGuestId = null;
    service.serviceRemainingSeconds = 0;
  }

  /** Sends a guest off wandering with `thought`; Phase 30: `objectId` is the stall a price complaint is about. */
  private releaseGuest(guest: PhaseFourGuest, thought: string, happinessPenalty = 0, objectId: number | null = null): void {
    guest.state = 'wandering';
    guest.destinationObjectId = null;
    guest.servicePriceLimit = null;
    guest.stateTimerSeconds = 0;
    setThought(guest, thought, objectId);
    guest.happiness = Math.max(0, guest.happiness - happinessPenalty);
  }

  private priceRejection(guest: PhaseFourGuest, service: ServiceRuntime): string | null {
    if (guest.money < service.itemPrice) return "I can't afford that anymore.";
    if (guest.servicePriceLimit !== null && service.itemPrice - guest.servicePriceLimit > 1e-9) {
      return "I'm not paying that much.";
    }
    return null;
  }

  private pruneInactiveGuests(service: ServiceRuntime, guests: Map<number, Guest>): void {
    service.queueGuestIds = service.queueGuestIds.filter((id) => {
      const guest = guests.get(id);
      return guest?.destinationObjectId === service.objectId && guest.state === 'queueingForShop';
    });
    if (service.activeGuestId === null) return;
    const active = guests.get(service.activeGuestId);
    const validState = service.kind === 'toilet' ? 'usingFacility' : 'shopping';
    if (active?.destinationObjectId === service.objectId && active.state === validState) return;
    service.activeGuestId = null;
    service.serviceRemainingSeconds = 0;
  }

  private serviceContainingGuest(guestId: number): ServiceRuntime | undefined {
    return [...this.services.values()].find((service) =>
      service.activeGuestId === guestId || service.queueGuestIds.includes(guestId));
  }
}
