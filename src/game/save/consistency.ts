import { UNITS_PER_DAY, maximumAnchorUnits, positionUnitsAt } from '../calendar/calendarMath';
import { GAME_CONFIG } from '../config';
import { BUILD_BY_ID } from '../content/catalog';
import { MAXIMUM_CROWD_PRESSURE } from './ranges';
import { SaveError, invalidState } from './version';
import type { CrowdState, ParkSaveV7 } from './state';

/**
 * Cross-owner checks on a serialized park, run BEFORE any owner restores.
 *
 * Each owner's restore() validates what it can see of itself and of the collaborators injected
 * into it. What spans owners that cannot see each other lives here: guests against ride and shop
 * queues, id generators against every id referenced, bookkeeping counters against the world.
 * Working on the plain state (not the live session) means a bad save is refused before a single
 * object is built, and it needs no private access into any simulation.
 *
 * The rule for adding a check: it must hold at EVERY tick boundary of a healthy park, including
 * right after a player edit. A check that rejects a legitimate save would make a park unloadable,
 * which is worse than a missed check (the owners already validate their own invariants, and the
 * serializer only writes live state). The determinism test saves at many different ticks to keep
 * these checks honest.
 *
 * Deliberately NOT checked: guest recent-ride and destination ids (a demolished object is legal
 * data), a guest's destination when the ride or service is gone (the guest step re-targets it),
 * and stationary cells being on a path (an edit between steps can legally orphan them).
 */

/**
 * The day length a Scenario or run park plays: the default day scaled by the ruleset's `dayLengthMultiplier`
 * (absent = 1 = exactly the default). The session's constructor and the consistency law share it.
 */
export const scenarioDayLengthSeconds = (dayLengthMultiplier: number | undefined): number => (
  dayLengthMultiplier === undefined || dayLengthMultiplier === 1
    ? GAME_CONFIG.calendar.defaultDayLengthSeconds
    : Math.round(GAME_CONFIG.calendar.defaultDayLengthSeconds * dayLengthMultiplier)
);

const fail = (path: string, problem: string): never => {
  throw new SaveError('invalid-state', `Save is inconsistent: ${path} ${problem}`);
};

/**
 * Drawn weather days must be contiguous (the type already makes them whole days) and cover the day
 * the park is on, so a forecast never has a hole. An empty list is legal: only a migrated, never
 * stepped save has it, and the restore draws the days. Shapes are validated by the owner's restore;
 * this only reads what it can trust.
 */
const checkWeatherAgainstCalendar = (state: ParkSaveV7): void => {
  const { weather, calendar, world } = state;
  if (!Array.isArray(weather.days) || weather.days.length === 0) return;
  const numbers = [weather.firstDay, calendar.dayLengthSeconds, calendar.anchorTick, calendar.anchorUnits, world.tick];
  if (numbers.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return;
  const day = Math.floor(positionUnitsAt(calendar, world.tick) / UNITS_PER_DAY) + 1;
  if (weather.firstDay > day || weather.firstDay + weather.days.length - 1 < day) {
    fail('weather.days', `cover days ${weather.firstDay}..${weather.firstDay + weather.days.length - 1} but the park is on day ${day}`);
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * The crowd field's own law (Phase 14, schema 13), pure so the owner (`CrowdSimulation.restore`) and the session share
 * it: `version` 1; `pressure` an array of `[cell, value]` pairs strictly ascending by cell, `cell` an integer in
 * 0..cellCount-1, `value` an integer in 1..MAXIMUM_CROWD_PRESSURE (zeros are never written). Returns a private copy;
 * throws invalid-state naming `owner` and the path otherwise. Nothing is clamped: a bad field is refused.
 */
export const readCrowdState = (value: unknown, cellCount: number, owner = 'CrowdSimulation'): CrowdState => {
  if (!isPlainRecord(value)) throw invalidState(owner, 'crowd', 'is not an object');
  if (value.version !== 1) throw invalidState(owner, 'crowd.version', 'must be 1');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('pressure')) throw invalidState(owner, 'crowd', 'must have exactly the keys version and pressure');
  const pressure = value.pressure;
  if (!Array.isArray(pressure)) throw invalidState(owner, 'crowd.pressure', 'is not an array');
  if (pressure.length > cellCount) throw invalidState(owner, 'crowd.pressure', `has more entries than the ${cellCount} cells of the map`);
  const copy: Array<[number, number]> = [];
  let previous = -1;
  pressure.forEach((entry: unknown, index) => {
    const path = `crowd.pressure[${index}]`;
    if (!Array.isArray(entry) || entry.length !== 2) throw invalidState(owner, path, 'is not a [cell, value] pair');
    const [cell, amount] = entry as unknown[];
    if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell >= cellCount) {
      throw invalidState(owner, `${path}[0]`, `must be an integer cell index in 0..${cellCount - 1}`);
    }
    if (cell <= previous) throw invalidState(owner, `${path}[0]`, `${cell} is not strictly ascending`);
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MAXIMUM_CROWD_PRESSURE) {
      throw invalidState(owner, `${path}[1]`, `must be an integer in 1..${MAXIMUM_CROWD_PRESSURE}`);
    }
    previous = cell;
    copy.push([cell, amount]);
  });
  return { version: 1, pressure: copy };
};

/**
 * The session-level crowd law (schema 13): the `crowd` key exists EXACTLY when the ruleset has congestion feedback
 * (`rules.crowdFeedback` present and not 0; an explicit 0 is off and is dropped by the ruleset restore), and its cells
 * lie on the saved map (`world.mapWidth x world.mapHeight`). Range and shape of the key itself are checked by
 * `readCrowdState`. Holds trivially for every save before Phase 14 (no rule, no key).
 */
export const checkCrowdLaw = (state: Pick<ParkSaveV7, 'rules' | 'world' | 'crowd'>): void => {
  const feedback = isPlainRecord(state.rules) ? state.rules.crowdFeedback : undefined;
  const active = feedback !== undefined && feedback !== 0;
  const present = Object.hasOwn(state, 'crowd');
  if (present !== active) {
    fail('crowd', active ? 'is missing although rules.crowdFeedback is on' : 'exists although rules.crowdFeedback is absent');
  }
  if (!present) return;
  const width = state.world?.mapWidth;
  const height = state.world?.mapHeight;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new SaveError('invalid-state', 'Save is inconsistent: world.mapWidth is not a positive integer map size, so the crowd field cannot be checked');
  }
  readCrowdState(state.crowd, width * height, 'ParkSession');
};

export const checkSessionConsistency = (state: ParkSaveV7): void => {
  if (state.scenarioId !== null) {
    // A scenario park has no editable calendar (day deadlines must stay fair), so the save must
    // carry exactly the calendar a fresh scenario starts with, not just a valid one. The day length is the default
    // scaled by the ruleset's day-length rule (Phase 25; absent = 1, so exactly the default for every older save).
    const { calendar } = state;
    const expectedDayLength = scenarioDayLengthSeconds(state.rules?.dayLengthMultiplier);
    if (calendar.dayLengthSeconds !== expectedDayLength) {
      fail('calendar.dayLengthSeconds', `${calendar.dayLengthSeconds} differs from the fixed scenario day length ${expectedDayLength}`);
    }
    if (calendar.timeLock !== 'auto') fail('calendar.timeLock', 'must be auto in a scenario park');
    if (calendar.anchorTick !== 0 || calendar.anchorUnits !== 0) {
      fail('calendar.anchorTick', 'a scenario park never re-anchors its calendar');
    }
    // Same for the opening hours and the weather switches: a scenario's weather is part of the challenge.
    const hours = GAME_CONFIG.calendar.hours;
    if (calendar.hoursEnabled !== hours.defaultEnabled || calendar.openHour !== hours.defaultOpen || calendar.closeHour !== hours.defaultClose) {
      fail('calendar.hoursEnabled', 'a scenario park keeps the default opening hours');
    }
    if (state.weather.enabled !== true) fail('weather.enabled', 'must be true in a scenario park');
    if (state.weather.severity !== 'normal') fail('weather.severity', 'must be normal in a scenario park');
  }
  const { anchorTick, anchorUnits } = state.calendar;
  if (typeof anchorTick === 'number' && typeof anchorUnits === 'number' && anchorUnits > maximumAnchorUnits(anchorTick)) {
    fail('calendar.anchorUnits', `${anchorUnits} exceeds what anchorTick ${anchorTick} can have produced`);
  }
  checkWeatherAgainstCalendar(state);
  if (state.calendar.anchorTick > state.world.tick) {
    fail('calendar.anchorTick', `${state.calendar.anchorTick} is later than the world tick ${state.world.tick}`);
  }
  const guestIds = new Set<number>();
  let maximumGuestId = 0;
  let previousGuestId = 0;
  state.guests.guests.forEach((guest, index) => {
    if (guest.id <= previousGuestId) fail(`guests.guests[${index}].id`, `${guest.id} is not strictly ascending`);
    previousGuestId = guest.id;
    guestIds.add(guest.id);
    maximumGuestId = Math.max(maximumGuestId, guest.id);
  });
  if (state.guests.nextGuestId <= maximumGuestId) {
    fail('guests.nextGuestId', `${state.guests.nextGuestId} would reuse guest id ${maximumGuestId}`);
  }
  // removeAll() empties the guest Map but leaves ride and shop lists until the next step prunes
  // them, so dangling guest ids are tolerated only when there are no guests at all.
  const guestlessPrune = guestIds.size === 0;
  const requireGuest = (id: number, path: string): void => {
    if (!guestlessPrune && !guestIds.has(id)) fail(path, `names guest ${id}, who does not exist`);
  };

  // A guest belongs to at most one ride queue/rider list, or one shop queue, never both.
  const placement = new Map<number, string>();
  const place = (id: number, where: string, path: string): void => {
    const existing = placement.get(id);
    if (existing !== undefined) fail(path, `puts guest ${id} in ${where} but the guest is already in ${existing}`);
    placement.set(id, where);
  };
  const rideById = new Map(state.rides.rides.map((ride) => [ride.objectId, ride]));
  state.rides.rides.forEach((ride, index) => {
    ride.queueGuestIds.forEach((id, position) => {
      requireGuest(id, `rides.rides[${index}].queueGuestIds[${position}]`);
      place(id, `the queue of ride ${ride.objectId}`, `rides.rides[${index}].queueGuestIds[${position}]`);
    });
    ride.riderGuestIds.forEach((id, position) => {
      requireGuest(id, `rides.rides[${index}].riderGuestIds[${position}]`);
      place(id, `ride ${ride.objectId}`, `rides.rides[${index}].riderGuestIds[${position}]`);
    });
  });
  const serviceById = new Map(state.shops.services.map((service) => [service.objectId, service]));
  const objectById = new Map(state.world.objects.map((object) => [object.id, object]));
  state.shops.services.forEach((service, index) => {
    service.queueGuestIds.forEach((id, position) => {
      requireGuest(id, `shops.services[${index}].queueGuestIds[${position}]`);
      place(id, `the queue of service ${service.objectId}`, `shops.services[${index}].queueGuestIds[${position}]`);
    });
    if (service.activeGuestId !== null) {
      requireGuest(service.activeGuestId, `shops.services[${index}].activeGuestId`);
      place(service.activeGuestId, `service ${service.objectId}`, `shops.services[${index}].activeGuestId`);
    }
  });

  // Guest state against the list it must be in. Skipped when the destination no longer exists
  // (rides.syncWithWorld releases such guests on the same sync that removes the runtime, so a
  // saved guest in this state always has a live runtime; the skip only covers hand-made saves).
  state.guests.guests.forEach((guest, index) => {
    const path = `guests.guests[${index}]`;
    const destination = guest.destinationObjectId;
    if (destination === null) return;
    if (guest.state === 'queueing') {
      const ride = rideById.get(destination);
      if (ride && !ride.queueGuestIds.includes(guest.id)) fail(path, `is queueing for ride ${destination} but is not in its queue`);
    } else if (guest.state === 'riding') {
      const ride = rideById.get(destination);
      if (ride && !ride.riderGuestIds.includes(guest.id)) fail(path, `is riding ride ${destination} but is not among its riders`);
    } else if (guest.state === 'queueingForShop') {
      const service = serviceById.get(destination);
      if (service && !service.queueGuestIds.includes(guest.id)) fail(path, `is queueing for service ${destination} but is not in its queue`);
    } else if (guest.state === 'shopping' || guest.state === 'usingFacility') {
      const service = serviceById.get(destination);
      if (service && service.activeGuestId !== guest.id) fail(path, `is being served by service ${destination} which does not list them as active`);
    } else if (guest.state === 'walkingToBench' || guest.state === 'resting') {
      // Phase 30: a seat is only ever on a bench (an amenity with no amenityType). A bulldozed bench is legal (the
      // next step gets the guest up), so only a standing object is checked.
      const object = objectById.get(destination);
      const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
      if (definition && (definition.kind !== 'amenity' || definition.stats?.amenityType !== undefined)) {
        fail(path, `is ${guest.state} at object ${destination}, which is not a bench`);
      }
    }
  });

  // Id generators must stay ahead of every id they have handed out.
  state.operations.staff.forEach((worker, index) => {
    if (worker.id >= state.operations.nextStaffId) fail(`operations.staff[${index}].id`, `${worker.id} is not below nextStaffId ${state.operations.nextStaffId}`);
  });
  state.shops.completionEvents.forEach((event, index) => {
    if (event.id >= state.shops.nextCompletionEventId) fail(`shops.completionEvents[${index}].id`, `${event.id} is not below nextCompletionEventId`);
    requireGuest(event.guestId, `shops.completionEvents[${index}].guestId`);
  });
  state.progression.pendingEvents.forEach((event, index) => {
    if (event.id >= state.progression.nextEventId) fail(`progression.pendingEvents[${index}].id`, `${event.id} is not below nextEventId ${state.progression.nextEventId}`);
  });
  state.management.pendingNotifications.forEach((notification, index) => {
    if (notification.id >= state.management.nextNotificationId) {
      fail(`management.pendingNotifications[${index}].id`, `${notification.id} is not below nextNotificationId`);
    }
  });

  // Counters that remember what the simulations once held. A rating-entry for a demolished ride is
  // legal (the next step prunes it), so only entries whose runtime still exists are compared.
  for (const [objectId, seen] of state.progression.lastRideCompletionCounts) {
    const ride = rideById.get(objectId);
    if (ride && seen > ride.satisfactionCount) fail(`progression.lastRideCompletionCounts[${objectId}]`, `${seen} exceeds the ride's ${ride.satisfactionCount} completions`);
  }
  for (const [objectId, seen] of state.progression.lastServiceCompletionCounts) {
    const service = serviceById.get(objectId);
    if (service && seen > service.satisfactionCount) fail(`progression.lastServiceCompletionCounts[${objectId}]`, `${seen} exceeds the service's ${service.satisfactionCount} completions`);
  }
  // An uncollected transaction is legal (management reads it next step); an id from the future is not.
  if (state.management.lastProcessedTransactionId >= state.world.nextTransactionId) {
    fail('management.lastProcessedTransactionId', `${state.management.lastProcessedTransactionId} is not below the world's nextTransactionId ${state.world.nextTransactionId}`);
  }
  if (state.scenario && state.scenario.scenarioId !== state.scenarioId) {
    fail('scenario.scenarioId', `${state.scenario.scenarioId} differs from the save's ${String(state.scenarioId)}`);
  }
  state.onboarding?.completed.forEach((entry, index) => {
    if (entry.tick > state.world.tick) fail(`onboarding.completed[${index}].tick`, `${entry.tick} is after the world tick ${state.world.tick}`);
  });
  if (state.operations.elapsedSeconds < 0 || state.rides.elapsedSeconds < 0) {
    fail('elapsedSeconds', 'is negative');
  }
  checkCrowdLaw(state);
};
