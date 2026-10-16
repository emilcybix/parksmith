import type { Container } from 'pixi.js';
import { afterEach, describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import { ParkSession } from '../game/session/ParkSession';
import { seedDevPark } from '../game/session/devPark';
import { resetSettings, updateSettings } from '../settings';
import { countGraphicsDrawCalls } from './drawCallCounter';
import type { ViewRotation } from './viewRotation';
import { WorldRenderer } from './WorldRenderer';

/**
 * Phase 26 review fixes (classic): a view turn re-places the kept scene instead of rebuilding it,
 * and the animated turn is a flat background-coloured veil over the NEW picture (never a snapshot
 * of the old one, so no frame mixes two orientations).
 */

const devPark = (): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  session.guests.spawnGuests(150);
  for (let step = 0; step < 60; step += 1) session.step(GAME_CONFIG.fixedStepMs);
  return session;
};

interface Internals {
  app: { screen: { width: number; height: number }; stage: Container };
  mounted: boolean;
  terrainLayer: Container;
}

/** The headless stand-in for a mounted renderer: a screen, the mounted flag, and the terrain drawn. */
const mountedHeadless = (session: ParkSession): { renderer: WorldRenderer; internals: Internals } => {
  const renderer = new WorldRenderer(session);
  renderer.syncWorld();
  const internals = renderer as unknown as Internals & { drawTerrain(): void };
  Object.defineProperty(internals.app, 'screen', { value: { x: 0, y: 0, width: 1440, height: 800 }, configurable: true });
  internals.mounted = true;
  internals.drawTerrain();
  return { renderer, internals };
};

/** No GL app was initialised: tear down as an unmounted renderer (the cached terrain still goes). */
const release = (renderer: WorldRenderer, internals: Internals): void => {
  internals.mounted = false;
  renderer.destroy();
};

afterEach(() => resetSettings());

describe('classic view turn: re-place, do not rebuild', () => {
  it('keeps every object container, the gate and the path layer across four turns', () => {
    const renderer = new WorldRenderer(devPark());
    renderer.syncWorld();
    renderer.update(16, 16);
    const before = renderer.sceneProbe;
    const containers = new Map(before.objects.map((entry) => [entry.objectId, entry.container]));
    expect(containers.size).toBeGreaterThan(20);
    for (const view of [1, 2, 3, 0] as ViewRotation[]) {
      renderer.setViewRotation(view, true);
      const after = renderer.sceneProbe;
      expect(after.objects.length).toBe(containers.size);
      for (const entry of after.objects) expect(entry.container, `object ${entry.objectId} in view ${view}`).toBe(containers.get(entry.objectId));
      expect(after.entranceDisplay).toBe(before.entranceDisplay);
      expect(after.pathDisplay).toBe(before.pathDisplay);
      expect(after.entranceDisplay!.destroyed).toBe(false);
    }
  });

  it('a half turn redraws plots and paths but no ride machinery; a quarter turn far less than a scene build', () => {
    const session = devPark();
    const build = countGraphicsDrawCalls(() => {
      const fresh = new WorldRenderer(session);
      fresh.syncWorld();
    });
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    renderer.update(16, 16);
    const quarter = countGraphicsDrawCalls(() => renderer.setViewRotation(1, true));
    const half = countGraphicsDrawCalls(() => renderer.setViewRotation(3, true));
    // Ride machinery depends only on the footprint axis: an even turn keeps every ride art.
    expect(half).toBeLessThan(quarter);
    expect(quarter).toBeLessThan(build);
  });

  it('ride machinery for the other footprint axis is built once and swapped in on later quarter turns', () => {
    const renderer = new WorldRenderer(devPark());
    renderer.syncWorld();
    renderer.update(16, 16);
    const rideArt = (): Map<number, Container> => new Map(renderer.sceneProbe.objects
      .filter((entry) => entry.isRide)
      .map((entry) => [entry.objectId, entry.container.children[1] as Container]));
    const axis0 = rideArt();
    expect(axis0.size).toBeGreaterThan(3);
    renderer.setViewRotation(1, true);
    const axis1 = rideArt();
    for (const [id, art] of axis1) expect(art).not.toBe(axis0.get(id));
    renderer.setViewRotation(2, true);
    for (const [id, art] of rideArt()) expect(art, `ride ${id} back on axis 0`).toBe(axis0.get(id));
    const swap = countGraphicsDrawCalls(() => renderer.setViewRotation(3, true));
    for (const [id, art] of rideArt()) expect(art, `ride ${id} on axis 1`).toBe(axis1.get(id));
    const quarterWithoutRides = countGraphicsDrawCalls(() => renderer.setViewRotation(0, true));
    // Once both axes exist, odd and even turns cost the same: plots, track and paths only.
    expect(swap).toBe(quarterWithoutRides);
    for (const art of [...axis0.values(), ...axis1.values()]) expect(art.destroyed).toBe(false);
  });

  it('terrain is drawn once per view class and swapped in afterwards', () => {
    const { renderer, internals } = mountedHeadless(devPark());
    const terrainOf = (): Container => internals.terrainLayer.children[0] as Container;
    const view0 = terrainOf();
    renderer.setViewRotation(1, true);
    const view1 = terrainOf();
    expect(internals.terrainLayer.children.length).toBe(1);
    renderer.setViewRotation(2, true);
    renderer.setViewRotation(0, true);
    expect(terrainOf()).toBe(view0);
    // A second lap draws no terrain at all.
    const lap = countGraphicsDrawCalls(() => {
      renderer.setViewRotation(1, true);
      expect(terrainOf()).toBe(view1);
      renderer.setViewRotation(0, true);
    });
    expect(terrainOf()).toBe(view0);
    expect(lap).toBeGreaterThan(0);
    // The grid toggle rebuilds the class it shows and forgets the rest.
    renderer.setGridVisible(false);
    expect(terrainOf()).not.toBe(view0);
    expect(view0.destroyed).toBe(true);
    expect(view1.destroyed).toBe(true);
    release(renderer, internals);
  });
});

describe('classic view turn: the veil', () => {
  it('fades a flat background-coloured veil 0.55 -> 0 over the new picture in 180 ms, then hides it', () => {
    updateSettings({ reducedMotion: 'off' });
    const { renderer, internals } = mountedHeadless(devPark());
    expect(renderer.turnVeilAlpha).toBe(0);
    renderer.setViewRotation(1);
    expect(renderer.viewRotation, 'the picture is already the new view').toBe(1);
    expect(renderer.turnVeilAlpha).toBeCloseTo(0.55, 5);
    const stage = internals.app.stage;
    const veil = stage.children[stage.children.length - 1];
    // No snapshot texture of the old frame: the veil is one pooled sprite and nothing else was added.
    const stageChildren = stage.children.length;
    let previous = renderer.turnVeilAlpha;
    let elapsed = 16;
    for (let frame = 0; frame < 12; frame += 1) {
      elapsed += 16;
      renderer.update(16, elapsed);
      expect(renderer.turnVeilAlpha).toBeLessThanOrEqual(previous);
      previous = renderer.turnVeilAlpha;
    }
    expect(renderer.turnVeilAlpha, 'hidden after 180 ms').toBe(0);
    expect(veil.visible).toBe(false);
    // A second turn reuses the same sprite.
    renderer.setViewRotation(2);
    expect(stage.children[stage.children.length - 1]).toBe(veil);
    expect(stage.children.length).toBe(stageChildren);
    release(renderer, internals);
  });

  it('reduced motion and instant turns never show the veil', () => {
    updateSettings({ reducedMotion: 'on' });
    const { renderer, internals } = mountedHeadless(devPark());
    renderer.setViewRotation(1);
    expect(renderer.turnVeilAlpha).toBe(0);
    updateSettings({ reducedMotion: 'off' });
    renderer.setViewRotation(2, true);
    expect(renderer.turnVeilAlpha).toBe(0);
    release(renderer, internals);
  });
});
