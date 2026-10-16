import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from './coaster/content';
import { coasterBaseCost, deriveCoasterStats } from './coaster/design';
import type { CoasterPiece } from './coaster/design';
import { GAME_CONFIG } from './config';
import { BUILD_BY_ID } from './content/catalog';
import type { Cell, PlacedObject } from './types';
import { GameWorld } from './World';

/**
 * Phase 11 (PA-015): `demolishObject(id)` is the object branch of `bulldoze(cell)`, moved out so the inspector can
 * demolish by id. Two identical worlds, one bulldozed by cell and one demolished by id, must end byte-identical.
 */

const SERPENT = COASTER_TYPE_BY_ID.get('skyline-serpent')!;

/** A 20-piece loop from (10,10) to (17,13); height 2 along the top. */
const rectangularLoop = (): CoasterPiece[] => {
  const pieces: CoasterPiece[] = [];
  for (let x = 10; x <= 17; x += 1) pieces.push({ cell: { x, y: 10 }, height: 0 });
  for (let y = 11; y <= 13; y += 1) pieces.push({ cell: { x: 17, y }, height: 0 });
  for (let x = 16; x >= 10; x -= 1) pieces.push({ cell: { x, y: 13 }, height: 0 });
  for (let y = 12; y >= 11; y -= 1) pieces.push({ cell: { x: 10, y }, height: 0 });
  const heights = [0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
  return pieces.map((piece, index) => ({ ...piece, height: heights[index] }));
};

interface Built { world: GameWorld; ids: Record<'ride' | 'service' | 'coaster' | 'pavilion', number> }

const build = (): Built => {
  const world = new GameWorld(80_000);
  world.buildPaths([{ x: 20, y: 20 }, { x: 21, y: 20 }]);
  const ride = world.buildObject('petal-roundabout', { x: 3, y: 3 }, 1) as PlacedObject;
  const service = world.buildObject('picnic-pocket', { x: 7, y: 5 }) as PlacedObject;
  const pavilion = world.buildObject('comfort-pavilion', { x: 22, y: 4 }, 1) as PlacedObject;
  const pieces = rectangularLoop();
  const coaster = world.placeCoaster('skyline-serpent', pieces, deriveCoasterStats(pieces, SERPENT), coasterBaseCost(pieces, SERPENT));
  if (!ride || !service || !pavilion || 'error' in coaster) throw new Error('the test park should build');
  return { world, ids: { ride: ride.id, service: service.id, coaster: coaster.id, pavilion: pavilion.id } };
};

const occupancyGrid = (world: GameWorld): string => {
  const rows: string[] = [];
  for (let y = 0; y < world.height; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < world.width; x += 1) row.push(String(world.objectAt({ x, y })?.id ?? '.'));
    rows.push(row.join(','));
  }
  return rows.join('\n');
};

describe('World.demolishObject (Phase 11, PA-015)', () => {
  for (const kind of ['ride', 'service', 'coaster', 'pavilion'] as const) {
    it(`demolishes a ${kind} exactly as bulldozing one of its cells does`, () => {
      const byCell = build();
      const byId = build();
      const id = byCell.ids[kind];
      const object = byCell.world.objects.get(id)!;
      // A cell that is not the anchor, so the by-cell path really goes through the occupancy lookup.
      const footprint = byCell.world.objectFootprint(object);
      const cell: Cell = footprint[footprint.length - 1];
      const refund = byId.world.demolitionRefund(id);
      let cellEvents = 0;
      let idEvents = 0;
      byCell.world.subscribe(() => { cellEvents += 1; });
      byId.world.subscribe(() => { idEvents += 1; });

      const viaCell = byCell.world.bulldoze(cell);
      const viaId = byId.world.demolishObject(id);

      expect(viaId).toEqual(viaCell);
      expect(viaId.removed).toBe(true);
      expect(viaId.refund).toBe(refund);
      expect(idEvents).toBe(cellEvents);
      expect(byId.world.demolitions).toBe(byCell.world.demolitions);
      expect(byId.world.cash).toBe(byCell.world.cash);
      expect(byId.world.transactions).toEqual(byCell.world.transactions);
      expect(occupancyGrid(byId.world)).toBe(occupancyGrid(byCell.world));
      expect(JSON.stringify(byId.world.serialize())).toBe(JSON.stringify(byCell.world.serialize()));
      expect(byId.world.objects.has(id)).toBe(false);
      expect(byId.world.demolitionRefund(id), 'gone, so no refund').toBeNull();
    });
  }

  it('refunds a coaster from its paidCost and a flat object from its cost, at the bulldoze rate', () => {
    const { world, ids } = build();
    const coaster = world.coasters.get(ids.coaster)!;
    expect(world.demolitionRefund(ids.coaster)).toBe(Math.floor(coaster.paidCost * GAME_CONFIG.bulldozeRefundRate));
    for (const kind of ['ride', 'service', 'pavilion'] as const) {
      const definition = BUILD_BY_ID.get(world.objects.get(ids[kind])!.definitionId)!;
      expect(world.demolitionRefund(ids[kind]), kind).toBe(Math.floor(world.objectCost(definition) * GAME_CONFIG.bulldozeRefundRate));
    }
  });

  it('is a pure read for refunds and a no-op for an unknown id', () => {
    const { world } = build();
    const before = JSON.stringify(world.serialize());
    let events = 0;
    world.subscribe(() => { events += 1; });
    expect(world.demolitionRefund(9_999)).toBeNull();
    expect(world.demolishObject(9_999)).toEqual({ removed: false, refund: 0, label: null });
    for (const id of world.objects.keys()) world.demolitionRefund(id);
    expect(JSON.stringify(world.serialize())).toBe(before);
    expect(events).toBe(0);
  });
});
