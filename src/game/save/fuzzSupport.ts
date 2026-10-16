import { PULSE_CARDS } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { BUILD_CATALOG } from '../content/catalog';
import { ONBOARDING_STEPS } from '../onboarding/content';
import { entranceFrame } from '../maps/frame';
import type { MapId } from '../maps/types';
import { RESEARCH_PROJECTS } from '../progression/content';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { ParkSession } from '../session/ParkSession';
import { seedDevPark } from '../session/devPark';
import type { Rotation } from '../types';
import { WEATHER_KINDS } from '../weather/types';
import type { Act } from './determinismHarness';

/**
 * Seeded random parks and random player edits for the save/restore fuzz tests.
 *
 * WHY this exists next to the hand-written determinism fixtures: a fixture only proves the states its
 * author thought of. A random park under random edits reaches combinations nobody scripted (a
 * queue at a ride that was just bulldozed, a mechanic walking to a rebuilt ride), and every one of
 * them is checked against the same live-graph and hash comparisons. Everything here is a pure
 * function of a seed, so a failure names a seed that replays exactly.
 */

export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const PLACEABLE = BUILD_CATALOG.filter((definition) => definition.kind !== 'path' && definition.custom !== 'coaster' && !definition.profileGate);
const PARK_KINDS = [null, 'sunny-start', 'penny-lane', 'garden-gala', 'starlight-finale', 'dev'] as const;

export interface FuzzPlan {
  kind: (typeof PARK_KINDS)[number];
  cardIds: PulseCardId[];
  seed: number;
  /** Phase 24: a sandbox on this shipped map (absent = Meadow Garden, the plans every earlier seed replays). */
  mapId?: MapId;
}

export const planFor = (seed: number): FuzzPlan => {
  const random = mulberry32(seed);
  const kind = PARK_KINDS[Math.floor(random() * PARK_KINDS.length)];
  const cardIds = PULSE_CARDS.map((card) => card.id).filter(() => random() < 0.4);
  return { kind, cardIds, seed };
};

/** A sandbox plan on a given map: the same random paths, buildings and edits, on that map's land (props, water, its gate). */
export const planOnMap = (seed: number, mapId: MapId): FuzzPlan => ({
  kind: null,
  cardIds: [],
  seed,
  ...(mapId === 'meadow' ? {} : { mapId }),
});

/** A fresh park for the plan: a scenario or the sandbox with random paths and up to 40 random buildings. */
export const buildFuzzPark = (plan: FuzzPlan): ParkSession => {
  const random = mulberry32(plan.seed * 31 + 7);
  const definition = plan.kind && plan.kind !== 'dev' ? SCENARIO_BY_ID.get(plan.kind)! : null;
  const session = new ParkSession(definition, plan.kind === 'dev' ? [] : plan.cardIds, plan.mapId ? { mapId: plan.mapId } : {});
  if (plan.kind === 'dev') seedDevPark(session);
  else {
    if (random() < 0.6) session.world.addMoney(60_000 + Math.floor(random() * 100_000));
    const cells = [];
    if (plan.mapId) {
      // The lane inwards from the gate, in the entrance frame.
      const frame = entranceFrame({ ...session.world.entrance, facing: session.world.entranceFacing });
      const laneLength = 7 + Math.floor(random() * 14);
      for (let depth = 1; depth <= laneLength; depth += 1) cells.push(frame.toWorld(0, depth));
    } else {
      // Unchanged since the earlier seeds: note the loop bound draws a number on every pass, which every replayed seed depends on.
      for (let y = 30; y >= 30 - 6 - Math.floor(random() * 14); y -= 1) cells.push({ x: 15, y });
    }
    for (let street = 0; street < 4; street += 1) {
      const y = 12 + Math.floor(random() * 16);
      const from = 6 + Math.floor(random() * 8);
      const to = 16 + Math.floor(random() * 9);
      for (let x = from; x <= to; x += 1) cells.push({ x, y });
    }
    session.world.buildPaths(cells);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const pick = PLACEABLE[Math.floor(random() * PLACEABLE.length)];
      session.world.buildObject(
        pick.id,
        { x: 5 + Math.floor(random() * 22), y: 6 + Math.floor(random() * 25) },
        Math.floor(random() * 4) as Rotation,
      );
    }
  }
  session.syncWithWorld();
  session.guests.spawnGuests(Math.floor(random() * 250));
  return session;
};

/** Scripted randomness for one tick: about one tick in twenty applies one random player action. */
export const fuzzAct = (plan: FuzzPlan): Act => (session, tick) => {
  const random = mulberry32(plan.seed * 104_729 + tick * 13 + 1);
  if (random() > 0.05) return;
  const rideIds = [...session.rides.rides.keys()];
  const serviceIds = [...session.shops.services.keys()];
  const pickFrom = <Item>(items: readonly Item[]): Item | undefined => items[Math.floor(random() * items.length)];
  const edit = (change: () => void): void => {
    change();
    session.syncWithWorld();
  };
  const randomCell = () => ({ x: 5 + Math.floor(random() * 22), y: 6 + Math.floor(random() * 25) });
  switch (Math.floor(random() * 22)) {
    case 0: { const id = pickFrom(rideIds); if (id !== undefined) session.rides.setTicketPrice(id, Math.floor(random() * 12)); break; }
    case 1: { const id = pickFrom(rideIds); if (id !== undefined) session.rides.setOpen(id, random() < 0.5); break; }
    case 2: { const id = pickFrom(serviceIds); if (id !== undefined) session.shops.setPrice(id, Math.floor(random() * 10)); break; }
    case 3: { const id = pickFrom(serviceIds); if (id !== undefined) session.shops.setOpen(id, random() < 0.5); break; }
    case 4: { const id = pickFrom(rideIds); if (id !== undefined) session.rides.forceBreakdown(id, session.guests.guests); break; }
    case 5: session.operations.hireStaff(random() < 0.5 ? 'cleaner' : 'mechanic'); break;
    case 6: session.operations.fireStaff(random() < 0.5 ? 'cleaner' : 'mechanic'); break;
    case 7: session.operations.trainStaff(random() < 0.5 ? 'cleaner' : 'mechanic'); break;
    case 8: session.operations.addLitter({ x: 8 + Math.floor(random() * 16), y: 8 + Math.floor(random() * 22) }, 1 + Math.floor(random() * 3)); break;
    case 9: session.progression.grantResearchPoints(Math.floor(random() * 400)); break;
    case 10: edit(() => { session.world.bulldoze(randomCell()); }); break;
    case 11: edit(() => { session.world.buildPaths([randomCell()]); }); break;
    case 12: { const pick = pickFrom(PLACEABLE)!; edit(() => { session.world.buildObject(pick.id, randomCell(), Math.floor(random() * 4) as Rotation); }); break; }
    case 13: session.world.setParkOpen(random() < 0.8); break;
    case 14: session.guests.spawnGuests(Math.floor(random() * 30)); break;
    case 15: session.refreshManagement(); session.management.consumeNotifications(); break;
    case 16: { const step = pickFrom(ONBOARDING_STEPS); if (step) session.onboarding?.skipStep(step.id); break; }
    case 17: if (random() < 0.25) session.onboarding?.dismissAll(); else session.onboarding?.skipCurrent(); break;
    case 19: {
      // Weather switches; a scenario park refuses them, which is part of what is being fuzzed.
      const severities = ['low', 'normal', 'high'] as const;
      if (random() < 0.4) session.setWeatherEnabled(random() < 0.5);
      else session.setWeatherSeverity(severities[Math.floor(random() * 3)]);
      break;
    }
    case 20: session.setOpeningHours(random() < 0.6, 5 + Math.floor(random() * 8), 15 + Math.floor(random() * 9)); break;
    case 21: session.weather.forceCurrentSlot(WEATHER_KINDS[Math.floor(random() * WEATHER_KINDS.length)], random()); break;
    default: session.shops.drainCompletionEvents(); session.world.addMoney(Math.floor(random() * 5000)); break;
  }
  if (random() < 0.3) {
    const project = pickFrom(RESEARCH_PROJECTS);
    if (project) {
      session.progression.purchase(project.id);
      session.syncWithWorld();
    }
  }
};

/** Interesting situations present in a session, so save points can be aimed at them. */
export const situationsIn = (session: ParkSession): string[] => {
  const found: string[] = [];
  for (const ride of session.rides.rides.values()) {
    if (ride.status === 'running' && ride.cycleRemainingSeconds > 0) found.push('mid-cycle');
    if (ride.queueGuestIds.length > 2) found.push('queue');
    if (ride.status === 'broken') found.push('broken');
    if (ride.status === 'maintenance') found.push('maintenance');
    if (ride.pendingBreakdown) found.push('pending-breakdown');
  }
  for (const service of session.shops.services.values()) if (service.activeGuestId !== null) found.push('shopping');
  for (const worker of session.operations.staff.values()) {
    if (worker.state === 'walking') found.push('staff-walking');
    if (worker.state === 'working') found.push('staff-working');
  }
  if (session.operations.litter.size > 0) found.push('litter');
  return found;
};
