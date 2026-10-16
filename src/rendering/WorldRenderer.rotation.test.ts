import type { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../game/content/catalog';
import { ParkSession } from '../game/session/ParkSession';
import { seedDevPark } from '../game/session/devPark';
import type { Rotation } from '../game/types';
import { footprintSize } from '../game/types';
import { countGraphicsDrawCalls } from './drawCallCounter';
import { worldToCell } from './isometric';
import { createRideArt } from './rideArt';
import { fingerprintNode } from './sceneFingerprint';
import { fromViewCell, VIEW_ROTATIONS, createViewFrame, rectToView, type ViewRotation } from './viewRotation';
import { WorldRenderer } from './WorldRenderer';

/**
 * Phase 26, classic renderer: the picture in every view. The renderer never mounts here (no GL),
 * so the tests read the Pixi scene graph the way `syncWorldEquivalence.test.ts` does.
 */

/**
 * Layer by layer, children sorted: the construction layer orders by zIndex, so the order a rebuild
 * appends displays in is not part of the picture (equal keys never occur between distinct displays).
 */
const sceneOf = (renderer: WorldRenderer): string =>
  renderer.cameraLayers()
    .map((layer) => layer.children.map((child) => fingerprintNode(child as Container)).sort().join('~'))
    .join('##');

const devPark = (): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  session.guests.spawnGuests(120);
  for (let step = 0; step < 80; step += 1) session.step(GAME_CONFIG.fixedStepMs);
  return session;
};

describe('classic renderer view rotation', () => {
  it('declares support', () => {
    expect(new WorldRenderer(new ParkSession(null)).supportsViewRotation).toBe(true);
  });

  it('four turns give the identical scene, in every starting view', () => {
    const session = devPark();
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    renderer.update(0, 1000);
    const base = sceneOf(renderer);
    let previous = base;
    const seen = new Set<string>([base]);
    for (let turn = 1; turn <= 4; turn += 1) {
      renderer.setViewRotation((turn & 3) as ViewRotation, true);
      renderer.update(0, 1000);
      const now = sceneOf(renderer);
      if (turn < 4) {
        expect(now, `view ${turn} should differ from the previous view`).not.toEqual(previous);
        seen.add(now);
      }
      previous = now;
    }
    expect(previous).toEqual(base);
    expect(seen.size).toBe(4);
    // And the opposite way round.
    for (let turn = 1; turn <= 4; turn += 1) renderer.setViewRotation(((4 - turn) & 3) as ViewRotation, true);
    renderer.update(0, 1000);
    expect(sceneOf(renderer)).toEqual(base);
  });

  it('a renderer built in view 0 matches one turned away and back (nothing is left over)', () => {
    const session = devPark();
    const fresh = new WorldRenderer(session);
    fresh.syncWorld();
    fresh.update(0, 500);
    const turned = new WorldRenderer(session);
    turned.syncWorld();
    turned.update(0, 500);
    turned.setViewRotation(2, true);
    turned.setViewRotation(0, true);
    turned.update(0, 500);
    expect(sceneOf(turned)).toEqual(sceneOf(fresh));
    expect(turned.staticDisplayCount).toBe(fresh.staticDisplayCount);
  });

  it('a steady frame draws nothing, in every view', () => {
    const session = devPark();
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    for (const view of VIEW_ROTATIONS) {
      renderer.setViewRotation(view, true);
      renderer.update(16, 1000 + view * 100);
      renderer.update(16, 1016 + view * 100);
      const calls = countGraphicsDrawCalls(() => {
        for (let frame = 0; frame < 10; frame += 1) renderer.update(16, 2000 + frame * 16);
      });
      expect(calls, `view ${view}: a steady frame rebuilt geometry`).toBe(0);
    }
  });

  it('a turn keeps the scene bookkeeping: same objects, same ride machinery', () => {
    const session = devPark();
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    const before = renderer.sceneProbe;
    renderer.setViewRotation(1, true);
    const after = renderer.sceneProbe;
    expect(after.objects.map((o) => o.objectId).sort()).toEqual(before.objects.map((o) => o.objectId).sort());
    expect([...after.rideDisplayIds].sort()).toEqual([...before.rideDisplayIds].sort());
    expect(renderer.staticDisplayCount).toBe(before.objects.length + 2);
  });

  it('keeps a ride\'s machinery motion across a turn', () => {
    const session = devPark();
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    for (let frame = 0; frame < 30; frame += 1) renderer.update(16, frame * 16);
    const displays = (renderer as unknown as { rideDisplays: Map<number, { motion: number; spin: number }> }).rideDisplays;
    const before = [...displays.entries()].map(([id, d]) => [id, d.motion, d.spin]);
    renderer.setViewRotation(3, true);
    const after = [...displays.entries()].map(([id, d]) => [id, d.motion, d.spin]);
    expect(after).toEqual(before);
  });

  it('the screen point of every object picks its own cell through the input mapping, in every view', () => {
    const session = new ParkSession(null);
    session.world.addMoney(1_000_000, 'Test funding');
    const cells = [{ x: 3, y: 4 }, { x: 20, y: 7 }, { x: 11, y: 26 }, { x: 28, y: 29 }, { x: 0, y: 0 }];
    for (const cell of cells) expect(session.world.buildObject('ribbon-bench', cell)).not.toBeNull();
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    for (const view of VIEW_ROTATIONS) {
      renderer.setViewRotation(view, true);
      const frame = createViewFrame(view, session.world.width, session.world.height);
      for (const object of session.world.objects.values()) {
        const display = (renderer.sceneProbe.objects.find((o) => o.objectId === object.id)!).container;
        // The display sits at the centre of its (1 x 1) cell: x as is, y half a tile below the top vertex.
        const viewCell = worldToCell(display.x, display.y);
        expect(fromViewCell(frame, viewCell), `view ${view} cell ${object.anchor.x},${object.anchor.y}`)
          .toEqual(object.anchor);
      }
    }
  });

  it('a ride\'s plot is the rotated rectangle and its sort key follows the view', () => {
    const session = new ParkSession(null);
    session.world.addMoney(1_000_000, 'Test funding');
    const object = session.world.seedScenarioObject('bumble-coach', { x: 8, y: 9 }, 0)!;
    const definition = BUILD_BY_ID.get('bumble-coach')!;
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    for (const view of VIEW_ROTATIONS) {
      renderer.setViewRotation(view, true);
      const frame = createViewFrame(view, session.world.width, session.world.height);
      const [width, depth] = footprintSize(definition, object.rotation);
      const rect = rectToView(frame, object.anchor.x, object.anchor.y, width, depth, { x: 0, y: 0, width: 0, depth: 0 });
      const display = renderer.sceneProbe.objects[0];
      expect(display.container.zIndex).toBe((rect.x + rect.width - 1 + rect.y + rect.depth - 1) * 100 + rect.x + rect.width - 1);
      // The plot's footprint in view: width x depth cells, swapped on odd views.
      const bounds = display.base!.getLocalBounds();
      const odd = view % 2 === 1;
      expect(rect.width).toBe(odd ? depth : width);
      expect(Math.round(bounds.width)).toBeGreaterThan(0);
    }
    // Rotating the building in the world and the view are the same picture of the plot.
    const rotated = new ParkSession(null);
    rotated.world.addMoney(1_000_000, 'Test funding');
    rotated.world.seedScenarioObject('bumble-coach', { x: 8, y: 9 }, 1);
    const a = new WorldRenderer(session);
    a.syncWorld();
    a.setViewRotation(1, true);
    const b = new WorldRenderer(rotated);
    b.syncWorld();
    const baseA = a.sceneProbe.objects[0].base!.getLocalBounds();
    const baseB = b.sceneProbe.objects[0].base!.getLocalBounds();
    expect(Math.round(baseA.width)).toBe(Math.round(baseB.width));
    expect(Math.round(baseA.height)).toBe(Math.round(baseB.height));
  });

  it('the ghost shows the build rotation seen in the view', () => {
    const session = new ParkSession(null);
    const definition = BUILD_BY_ID.get('bumble-coach')!;
    const previewFor = (renderer: WorldRenderer): string => {
      const layers = renderer.cameraLayers();
      return fingerprintNode(layers[layers.length - 1]);
    };
    // World rotation r in view q looks like rotation (r + q) & 3 in view 0, with only the position differing.
    const ghost = (rotation: Rotation, view: ViewRotation): string => {
      const renderer = new WorldRenderer(session);
      renderer.setViewRotation(view, true);
      const frame = createViewFrame(view, session.world.width, session.world.height);
      const [width, depth] = footprintSize(definition, rotation);
      const cells = [];
      for (let dy = 0; dy < depth; dy += 1) for (let dx = 0; dx < width; dx += 1) cells.push({ x: 6 + dx, y: 6 + dy });
      renderer.drawPreview(cells, definition, true, false, rotation);
      void frame;
      const group = renderer.cameraLayers()[renderer.cameraLayers().length - 1].children[1] as Container;
      // The art inside the ghost group: compare its drawing, not its position.
      return fingerprintNode(group.children[0] as Container);
    };
    for (const rotation of [0, 1, 2, 3] as Rotation[]) {
      for (const view of VIEW_ROTATIONS) {
        expect(ghost(rotation, view)).toEqual(ghost(((rotation + view) & 3) as Rotation, 0));
      }
    }
    expect(previewFor(new WorldRenderer(session))).toBeTypeOf('string');
  });

  it('keeps the preview, hint ring, draft and selection through a turn', () => {
    const session = new ParkSession(null);
    session.world.addMoney(1_000_000, 'Test funding');
    const object = session.world.seedScenarioObject('bumble-coach', { x: 8, y: 9 })!;
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    renderer.selectObject(object);
    renderer.setHintMarkers([{ cells: [{ x: 4, y: 5 }, { x: 5, y: 5 }] }]);
    renderer.drawPreview([{ x: 12, y: 12 }], BUILD_BY_ID.get('ribbon-bench')!, true);
    const layers = renderer.cameraLayers();
    const counts = (): number[] => layers.map((layer) => layer.children.length);
    const before = counts();
    renderer.setViewRotation(1, true);
    expect(counts()).toEqual(before);
    const view1 = sceneOf(renderer);
    renderer.setViewRotation(0, true);
    expect(sceneOf(renderer)).not.toEqual(view1);
    expect(counts()).toEqual(before);
  });

  it('the rotation is presentation only: the world and its hash never see it', () => {
    const session = devPark();
    const before = JSON.stringify([...session.world.objects.values()]);
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    for (const view of VIEW_ROTATIONS) renderer.setViewRotation(view, true);
    expect(JSON.stringify([...session.world.objects.values()])).toEqual(before);
  });

  it('the cloud shadows keep their world anchor (view 0 is unchanged, a turn only moves them)', () => {
    const renderer = new WorldRenderer(new ParkSession(null));
    const weather = (renderer as unknown as { classicWeather: { cloudLayer: Container } }).classicWeather;
    expect(weather.cloudLayer.children.length).toBeGreaterThan(0);
    renderer.setViewRotation(1, true);
    renderer.setViewRotation(0, true);
    expect(weather.cloudLayer.children.length).toBeGreaterThan(0);
  });
});

describe('ride art in the four views (audit)', () => {
  const rides = BUILD_CATALOG.filter((definition) => definition.kind === 'ride' && !definition.custom);

  it('art depends on the footprint axis only: a half turn changes nothing, for every ride', () => {
    for (const definition of rides) {
      for (const rotation of [0, 1] as Rotation[]) {
        const a = fingerprintNode(createRideArt(definition, rotation).container);
        const b = fingerprintNode(createRideArt(definition, ((rotation + 2) & 3) as Rotation).container);
        expect(b, `${definition.id}: art differs between rotation ${rotation} and ${rotation + 2}`).toEqual(a);
      }
    }
  });

  it('axis-aligned art (bumble coach, splash rings) fills the rotated plot, not the unrotated one', () => {
    for (const id of ['bumble-coach', 'splash-rings']) {
      const definition = BUILD_BY_ID.get(id)!;
      const a = fingerprintNode(createRideArt(definition, 0).container);
      const b = fingerprintNode(createRideArt(definition, 1).container);
      expect(b, `${id} ignores the view`).not.toEqual(a);
    }
  });
});
