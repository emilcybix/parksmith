import { describe, expect, it } from 'vitest';
import type { Cell } from '../game/types';
import { ParkSession } from '../game/session/ParkSession';
import { seedDevPark } from '../game/session/devPark';
import { WorldRenderer } from './WorldRenderer';
import { countGraphicsDrawCalls } from './drawCallCounter';

/**
 * `frameCost.test.ts` guards the steady-state frame, where the answer is zero. This file guards
 * the frame the player is actually in while building, where the answer cannot be zero — geometry
 * genuinely has to change — but must be proportional to what changed.
 *
 * Before PA-006, every world change destroyed and rebuilt every path, ride, coaster and decoration
 * in the park: placing one bench and dragging the bulldozer over one tile each cost a full-park
 * rebuild, and a twelve-tile drag cost twelve of them.
 *
 * Both an absolute ceiling and a fraction of a measured full rebuild are asserted. The ceilings
 * catch a gesture getting more expensive; the fractions catch a return to rebuilding everything,
 * even if the catalog grows and the absolute numbers move with it.
 */
const CEILINGS = {
  /** One decoration appears: its own plot and art, and nothing else. Measured 11. */
  placeScenery: 40,
  /** One ride appears: plot, fence, and its bespoke machinery. Measured 501. */
  placeRide: 650,
  /** One path tile: the walkway graphic, plus the plots whose fence opening actually moved. Measured 550. */
  bulldozePathTile: 750,
  /** A twelve-tile drag: one rebuild for the whole gesture, not twelve. Measured 879. */
  bulldozeDrag: 1_200,
  /** One ride disappears: nothing is rebuilt, only destroyed. Measured 0. */
  bulldozeRide: 10,
};

interface Fixture {
  session: ParkSession;
  renderer: WorldRenderer;
  /** What rebuilding the entire park costs, measured rather than assumed. */
  fullRebuild: number;
}

const devParkRenderer = (): Fixture => {
  const session = new ParkSession(null);
  seedDevPark(session);
  const renderer = new WorldRenderer(session);
  const fullRebuild = countGraphicsDrawCalls(() => renderer.syncWorld());
  expect(fullRebuild, 'the fixture park should be substantial').toBeGreaterThan(1_000);
  return { session, renderer, fullRebuild };
};

/** A free cell with no path and no object, so a placement cannot be rejected. */
const freeCell = (session: ParkSession): Cell => {
  for (let y = 0; y < session.world.height; y += 1) {
    for (let x = 0; x < session.world.width; x += 1) {
      const cell = { x, y };
      if (!session.world.paths.has(`${x},${y}`) && !session.world.objectAt(cell)) return cell;
    }
  }
  throw new Error('the dev park left no free cell');
};

const pathTilesExceptEntrance = (session: ParkSession): string[] =>
  [...session.world.paths].filter((key) => key !== '15,31');

const toCell = (key: string): Cell => {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
};

describe('construction frame cost', () => {
  it('redraws nothing when nothing changed', () => {
    const { renderer } = devParkRenderer();
    const before = renderer.staticDisplayCount;
    expect(countGraphicsDrawCalls(() => renderer.syncWorld())).toBe(0);
    expect(renderer.staticDisplayCount).toBe(before);
  });

  it('places one decoration for the cost of one decoration', () => {
    const { session, renderer, fullRebuild } = devParkRenderer();
    const cell = freeCell(session);
    const calls = countGraphicsDrawCalls(() => {
      session.world.buildObject('confetti-tree', cell);
      renderer.syncWorld();
    });
    expect(session.world.objectAt(cell)).toBeDefined();
    expect(calls, 'placing one decoration redrew more than itself')
      .toBeLessThanOrEqual(CEILINGS.placeScenery);
    expect(calls).toBeLessThan(fullRebuild * 0.05);
  });

  it('places one ride without rebuilding any other ride', () => {
    const { session, renderer, fullRebuild } = devParkRenderer();
    const objectCount = session.world.objects.size;
    const cell = freeCell(session);
    const calls = countGraphicsDrawCalls(() => {
      session.world.buildObject('moonpetal-carousel', cell);
      renderer.syncWorld();
    });
    expect(session.world.objects.size).toBe(objectCount + 1);
    expect(calls, 'placing one ride redrew the rest of the park')
      .toBeLessThanOrEqual(CEILINGS.placeRide);
    expect(calls).toBeLessThan(fullRebuild * 0.25);
  });

  it('clears one path tile without rebuilding ride machinery', () => {
    const { session, renderer, fullRebuild } = devParkRenderer();
    const key = pathTilesExceptEntrance(session)[0];
    const calls = countGraphicsDrawCalls(() => {
      session.world.bulldoze(toCell(key));
      renderer.syncWorld();
    });
    expect(session.world.paths.has(key)).toBe(false);
    expect(calls, 'a single cleared path tile rebuilt the whole park')
      .toBeLessThanOrEqual(CEILINGS.bulldozePathTile);
    expect(calls).toBeLessThan(fullRebuild * 0.25);
  });

  it('treats a bulldozer drag as one gesture, not one rebuild per tile', () => {
    const { session, renderer, fullRebuild } = devParkRenderer();
    const tiles = pathTilesExceptEntrance(session).slice(0, 12);
    expect(tiles.length).toBe(12);

    let notifications = 0;
    const unsubscribe = session.world.subscribe(() => { notifications += 1; });
    const calls = countGraphicsDrawCalls(() => {
      session.world.batch(() => {
        for (const key of tiles) session.world.bulldoze(toCell(key));
      });
      renderer.syncWorld();
    });
    unsubscribe();

    expect(notifications, 'a batched gesture notified listeners more than once').toBe(1);
    for (const key of tiles) expect(session.world.paths.has(key)).toBe(false);
    expect(calls, 'a twelve-tile drag cost more than one rebuild')
      .toBeLessThanOrEqual(CEILINGS.bulldozeDrag);
    expect(calls, 'a twelve-tile drag approached twelve full rebuilds')
      .toBeLessThan(fullRebuild * 0.3);
  });

  it('destroys a removed ride instead of rebuilding the survivors', () => {
    const { session, renderer } = devParkRenderer();
    const ride = [...session.world.objects.values()]
      .find((object) => object.definitionId === 'petal-roundabout');
    expect(ride).toBeDefined();
    const before = renderer.staticDisplayCount;
    const calls = countGraphicsDrawCalls(() => {
      session.world.bulldoze(ride!.anchor);
      renderer.syncWorld();
    });
    expect(renderer.staticDisplayCount).toBe(before - 1);
    expect(calls, 'removing a ride redrew the park').toBeLessThanOrEqual(CEILINGS.bulldozeRide);
  });
});
