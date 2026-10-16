import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { hashState } from '../save/hash';
import { ParkSession } from '../session/ParkSession';
import { collectOnboardingInput } from './collect';

const collect = (session: ParkSession) => collectOnboardingInput(
  session.world, session.rides, session.shops, session.guests, session.management, session.management.snapshot(),
);

/** A sandbox with a path, a ride and a food stall beside it, and a drink stall off the path. */
const park = (): ParkSession => {
  const session = new ParkSession(null);
  const cells = [];
  for (let y = 31; y >= 24; y -= 1) cells.push({ x: 15, y });
  session.world.buildPaths(cells);
  expect(session.world.buildObject('moonpetal-carousel', { x: 16, y: 26 })).not.toBeNull();
  expect(session.world.buildObject('picnic-pocket', { x: 16, y: 29 })).not.toBeNull();
  expect(session.world.buildObject('fizz-foundry', { x: 4, y: 10 }), 'far from the path').not.toBeNull();
  session.syncWithWorld();
  for (let tick = 0; tick < 40; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
  return session;
};

describe('collectOnboardingInput', () => {
  it('reads a fresh sandbox as an empty park', () => {
    const session = new ParkSession(null);
    const input = collect(session);
    expect(input.connectedPathTiles).toBe(0);
    expect(input.rides).toEqual([]);
    expect(input.services).toEqual([]);
    expect(input.totalArrivals).toBe(0);
    expect(input.operatingProfit).toBe(0);
    expect(input.cleaners).toBe(0);
  });

  it('flags connected and unconnected content and counts the connected path', () => {
    const input = collect(park());
    expect(input.connectedPathTiles, 'eight cells, the entrance tile excluded').toBe(7);
    expect(input.rides.map((ride) => ride.connected)).toEqual([true]);
    const byKind = new Map(input.services.map((service) => [service.kind, service.connected]));
    expect(byKind.get('food')).toBe(true);
    expect(byKind.get('drink'), 'a stall away from the path').toBe(false);
  });

  it('reports the default price of a new ride and the changed price after setTicketPrice', () => {
    const session = park();
    const before = collect(session).rides[0];
    expect(before.ticketPrice).toBe(before.defaultTicketPrice);
    session.rides.setTicketPrice(before.objectId, before.defaultTicketPrice + 2);
    const after = collect(session).rides[0];
    expect(after.ticketPrice).toBe(before.defaultTicketPrice + 2);
    expect(after.defaultTicketPrice, 'the default is the catalog value, not the live one').toBe(before.defaultTicketPrice);
  });

  it('a closed ride is still collected, unchanged in every field the steps read', () => {
    const session = park();
    const open = collect(session);
    session.rides.setOpen(open.rides[0].objectId, false);
    expect(collect(session)).toEqual(open);
  });

  it('a demolished ride is absent after the sync, and so are its completions', () => {
    const session = park();
    const ride = [...session.world.objects.values()].find((object) => object.definitionId === 'moonpetal-carousel')!;
    session.world.bulldoze(ride.anchor);
    session.syncWithWorld();
    expect(collect(session).rides).toEqual([]);
  });

  it('is pure: collecting changes neither the saved state nor the run that follows', () => {
    const probed = park();
    const control = park();
    const hashBefore = hashState(probed.serialize());
    for (let index = 0; index < 5; index += 1) collect(probed);
    expect(hashState(probed.serialize())).toBe(hashBefore);
    for (let tick = 0; tick < 200; tick += 1) {
      probed.step(GAME_CONFIG.fixedStepMs);
      collect(probed);
      control.step(GAME_CONFIG.fixedStepMs);
    }
    expect(hashState(probed.serialize()), 'a run that collects every tick equals one that never does').toBe(hashState(control.serialize()));
  });
});
