import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from './config';
import { BUILD_BY_ID } from './content/catalog';
import { frontEdgeCells, isFrontOnly } from './access';
import { MAPS } from './maps/content';
import { SCENARIOS } from './scenarios/content';
import { ParkSession } from './session/ParkSession';
import { seedDevPark } from './session/devPark';
import { GameWorld } from './World';

/** Phase 40b: services and benches are used from their front only, in a park whose ruleset says so. */
const unreachableFrontOnly = (session: ParkSession): string[] => {
  const { world } = session;
  return [...world.objects.values()]
    .filter((object) => isFrontOnly(BUILD_BY_ID.get(object.definitionId)!))
    .filter((object) => !world.frontFacesPath(BUILD_BY_ID.get(object.definitionId)!, object.anchor, object.rotation))
    .map((object) => `${object.definitionId}@${object.anchor.x},${object.anchor.y}`);
};

describe('Phase 40b: front-only access', () => {
  it('a new park compiles the rule; the world follows it', () => {
    const session = new ParkSession(null);
    expect(GAME_CONFIG.access.frontOnly).toBe(true);
    expect(session.rules.frontAccess).toBe(1);
    expect(session.world.frontAccessRule).toBe(true);
    session.syncWithWorld();
    expect(Object.keys(session.serialize().rules).at(-1)).toBe('frontAccess');
  });

  it('front edge cells: one per front cell, on the side the rotation names, for a two-wide front too', () => {
    const snack = BUILD_BY_ID.get('snack-sprint')!; // 2 x 1
    expect(frontEdgeCells(snack, { x: 5, y: 5 }, 0)).toEqual([{ x: 5, y: 6 }, { x: 6, y: 6 }]);
    expect(frontEdgeCells(snack, { x: 5, y: 5 }, 1)).toEqual([{ x: 6, y: 5 }, { x: 6, y: 6 }]);
    expect(frontEdgeCells(snack, { x: 5, y: 5 }, 2)).toEqual([{ x: 5, y: 4 }, { x: 6, y: 4 }]);
    expect(frontEdgeCells(snack, { x: 5, y: 5 }, 3)).toEqual([{ x: 4, y: 5 }, { x: 4, y: 6 }]);
  });

  it('a stall facing the path is a destination; one with its back to the path is not', () => {
    const session = new ParkSession(null);
    const { world } = session;
    world.addMoney(100_000);
    // A spine north from the gate (15, 31) and a stall beside it at x 16..17, rows 27..28 (2 x 2).
    world.buildPaths(Array.from({ length: 6 }, (_unused, index) => ({ x: 15, y: 30 - index })));
    const facing = world.buildObject('picnic-pocket', { x: 16, y: 27 }, 3, { exactRotation: true })!;
    const away = world.buildObject('fizz-foundry', { x: 16, y: 29 }, 1, { exactRotation: true })!;
    session.syncWithWorld();
    session.step(GAME_CONFIG.fixedStepMs);
    expect(world.frontFacesPath(BUILD_BY_ID.get('picnic-pocket')!, facing.anchor, facing.rotation)).toBe(true);
    expect(world.frontFacesPath(BUILD_BY_ID.get('fizz-foundry')!, away.anchor, away.rotation)).toBe(false);
    const destinations = (session.guests as unknown as { refreshDestinations(): void; serviceDestinations: Array<{ object: { id: number }; accessCells: unknown[] }> });
    destinations.refreshDestinations();
    const ids = destinations.serviceDestinations.map((destination) => destination.object.id);
    expect(ids).toContain(facing.id);
    expect(ids, 'its back to the path: guests cannot reach it').not.toContain(away.id);
    const two = destinations.serviceDestinations.find((destination) => destination.object.id === facing.id)!;
    expect(two.accessCells, 'a two-wide front gives two access cells').toHaveLength(2);
  });

  it('anything but the player turns a building to face its path; the player gets exactly the turn they chose', () => {
    const world = new GameWorld(100_000);
    world.setFrontAccess(true);
    world.buildPaths(Array.from({ length: 6 }, (_unused, index) => ({ x: 15, y: 30 - index })));
    const turned = world.buildObject('picnic-pocket', { x: 16, y: 27 }, 0)!;
    expect(turned.rotation, 'turned to face west, onto the path').toBe(3);
    const exact = world.buildObject('fizz-foundry', { x: 16, y: 29 }, 0, { exactRotation: true })!;
    expect(exact.rotation).toBe(0);
    const off = new GameWorld(100_000);
    off.buildPaths(Array.from({ length: 6 }, (_unused, index) => ({ x: 15, y: 30 - index })));
    expect(off.buildObject('picnic-pocket', { x: 16, y: 27 }, 0)!.rotation, 'rule off: as given').toBe(0);
  });

  it('every starting park (dev park, scenarios, maps) has every service and bench facing a path', () => {
    const dev = new ParkSession(null);
    expect(seedDevPark(dev).skipped).toEqual([]);
    expect(unreachableFrontOnly(dev)).toEqual([]);
    for (const scenario of SCENARIOS) expect(unreachableFrontOnly(new ParkSession(scenario)), scenario.id).toEqual([]);
    for (const map of MAPS) expect(unreachableFrontOnly(new ParkSession(null, [], { mapId: map.id })), map.id).toEqual([]);
  });

  it('every dev park service sells within five minutes', () => {
    const session = new ParkSession(null);
    session.setWeatherEnabled(false);
    seedDevPark(session);
    session.guests.spawnGuests(600);
    for (let step = 0; step < 300_000 / GAME_CONFIG.fixedStepMs; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    const services = [...session.world.objects.values()].filter((object) => BUILD_BY_ID.get(object.definitionId)?.stats?.serviceType !== undefined);
    const shops = session.shops.serialize() as unknown as { services: Array<{ objectId: number; customersServed: number }> };
    for (const service of services) {
      const record = shops.services.find((entry) => entry.objectId === service.id);
      expect(record?.customersServed ?? 0, `${service.definitionId}@${service.anchor.x},${service.anchor.y}`).toBeGreaterThan(0);
    }
  }, 60_000);
});
