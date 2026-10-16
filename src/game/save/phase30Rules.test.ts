import { describe, expect, it } from 'vitest';
import { setThought } from '../guests/life';
import { ParkSession } from '../session/ParkSession';
import { observe } from './determinismHarness';
import { hashState } from './hash';
import { stripGuestLife } from './schema14TestSupport';
import type { ParkSaveV14 } from './state';

/**
 * Phase 30: the complaint link in a save. `thoughtObjectId` is an optional guest key (schema 15 unchanged): written only
 * when a complaint names a building, dropped from the determinism observables while null, stripped by the older pins'
 * helper, and refused when malformed. Plus the consistency law for a seat: a resting guest sits on a bench.
 */

const createPark = (): ParkSession => {
  const session = new ParkSession(null);
  const street = [];
  for (let y = 31; y >= 24; y -= 1) street.push({ x: 15, y });
  session.world.buildPaths(street);
  session.world.buildObject('petal-roundabout', { x: 16, y: 26 });
  session.world.buildObject('ribbon-bench', { x: 14, y: 25 });
  session.syncWithWorld();
  session.guests.spawnGuests(3);
  return session;
};

const objectIdOf = (session: ParkSession, definitionId: string): number => (
  [...session.world.objects.values()].find((object) => object.definitionId === definitionId)!.id
);

describe('thoughtObjectId in a save', () => {
  it('a park with no complaint is saved exactly as before (no key); a complaint writes the key and it round trips', () => {
    const session = createPark();
    const before = session.serialize();
    expect(before.guests.guests.every((guest) => !('thoughtObjectId' in guest))).toBe(true);
    const ride = objectIdOf(session, 'petal-roundabout');
    const [guest] = session.guests.guests.values();
    setThought(guest, 'This queue is taking forever.', ride);
    const saved = session.serialize();
    expect(saved.guests.guests[0].thoughtObjectId).toBe(ride);
    expect(hashState(saved)).not.toBe(hashState(before));
    const json = JSON.stringify(saved);
    const restored = ParkSession.fromState(JSON.parse(json) as ParkSaveV14);
    expect(restored.guests.guests.get(guest.id)?.thoughtObjectId).toBe(ride);
    expect(JSON.stringify(restored.serialize()), 'byte-identical after a round trip').toBe(json);
    expect(restored.guests.thoughtInsights(10)).toEqual([]);
    setThought(restored.guests.guests.get(guest.id)!, 'That was fun.');
    expect('thoughtObjectId' in restored.serialize().guests.guests[0], 'cleared with the thought').toBe(false);
  });

  it('a malformed thoughtObjectId is refused like the other guest fields', () => {
    const session = createPark();
    for (const bad of [-1, 1.5, '3', Number.NaN]) {
      const state = JSON.parse(JSON.stringify(session.serialize())) as ParkSaveV14;
      (state.guests.guests[0] as { thoughtObjectId: unknown }).thoughtObjectId = bad;
      expect(() => ParkSession.fromState(state), String(bad)).toThrow(/thoughtObjectId/);
    }
  });

  it('stripGuestLife drops the key, so the older pins hash as if it never existed', () => {
    const session = createPark();
    const [guest] = session.guests.guests.values();
    setThought(guest, 'That ride is closed.', null);
    const plain = hashState(stripGuestLife(session.serialize()));
    setThought(guest, 'That ride is closed.', objectIdOf(session, 'petal-roundabout'));
    expect(hashState(session.serialize())).not.toBe(plain);
    expect(hashState(stripGuestLife(session.serialize()))).toBe(plain);
  });

  it('the determinism observables carry no link while there is none, and no link on an insight at all', () => {
    const session = createPark();
    const ride = objectIdOf(session, 'petal-roundabout');
    for (const guest of session.guests.guests.values()) setThought(guest, 'This queue is taking forever.', ride);
    expect(session.guests.thoughtInsights()[0]).toMatchObject({ objectId: ride, objectName: 'Petal Roundabout' });
    const observed = observe(session) as { spawned: Array<Record<string, unknown>>; insights: Array<Record<string, unknown>> };
    expect(observed.spawned.length).toBe(3);
    for (const spawned of observed.spawned) expect('thoughtObjectId' in spawned, 'a fresh guest has no link').toBe(false);
    expect(observed.insights.length).toBeGreaterThan(0);
    for (const insight of observed.insights) expect(Object.keys(insight).sort()).toEqual(['count', 'text']);
  });
});

describe('the consistency law for a seat', () => {
  it('a resting guest whose destination stands and is not a bench is refused; a bench or a gone object passes', () => {
    const session = createPark();
    const ride = objectIdOf(session, 'petal-roundabout');
    const bench = objectIdOf(session, 'ribbon-bench');
    const seated = (destination: number): ParkSaveV14 => {
      const state = JSON.parse(JSON.stringify(session.serialize())) as ParkSaveV14;
      const guest = state.guests.guests[0];
      guest.state = 'resting';
      guest.activity = 'seatLeft';
      guest.destinationObjectId = destination;
      return state;
    };
    expect(() => ParkSession.fromState(seated(ride))).toThrow(/not a bench/);
    expect(() => ParkSession.fromState(seated(bench))).not.toThrow();
    expect(() => ParkSession.fromState(seated(99_999)), 'a bulldozed bench is legal').not.toThrow();
  });
});
