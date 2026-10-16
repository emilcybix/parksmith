import { Container, Graphics, type GraphicsContext } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { COLOUR_SWATCHES } from '../game/content/colours';
import { ParkSession } from '../game/session/ParkSession';
import { countGraphicsDrawCalls } from './drawCallCounter';
import { fingerprintNode } from './sceneFingerprint';
import { WorldRenderer } from './WorldRenderer';

/**
 * Phase 28 step 1, classic renderer: a recolour redraws that ride's art ONCE and nothing else.
 *
 * The world replaces an object's colour record on every change, so the renderer's whole cache key is
 * the record's identity. These tests pin the cost model the plan asks for: one redraw per recolour,
 * zero drawing calls and zero display churn on every other sync and frame, the other rides' displays
 * untouched, the old art released with its GPU buffers (nothing accumulates across many recolours),
 * and a scene that is identical to a from-scratch build of the same coloured park.
 */

const LAGOON = COLOUR_SWATCHES.find((swatch) => swatch.id === 'lagoon')!.index;
const ROSE = COLOUR_SWATCHES.find((swatch) => swatch.id === 'rose')!.index;

const buildPark = (session: ParkSession): { petal: number; moon: number; swings: number } => {
  const { world } = session;
  world.addMoney(5_000_000, 'Colour test funding');
  for (let index = 0; index < 12; index += 1) world.buildPaths([{ x: 15, y: 30 - index }]);
  const petal = world.buildObject('petal-roundabout', { x: 16, y: 26 })!.id;
  const moon = world.buildObject('moonpetal-carousel', { x: 11, y: 22 }, 1)!.id;
  const swings = world.buildObject('harbor-swings', { x: 20, y: 22 })!.id;
  world.buildObject('picnic-pocket', { x: 13, y: 28 });
  session.syncWithWorld();
  return { petal, moon, swings };
};

const graphicsUnder = (renderer: WorldRenderer): Map<Graphics, GraphicsContext> => {
  const found = new Map<Graphics, GraphicsContext>();
  const visit = (node: Container): void => {
    if (node instanceof Graphics) found.set(node, node.context);
    for (const child of node.children) visit(child as Container);
  };
  for (const value of Object.values(renderer)) if (value instanceof Container) visit(value);
  return found;
};

const objectContainer = (renderer: WorldRenderer, id: number): Container => (
  renderer.sceneProbe.objects.find((entry) => entry.objectId === id)!.container
);

const setup = (animated = true) => {
  const session = new ParkSession(null);
  const ids = buildPark(session);
  const renderer = new WorldRenderer(session);
  renderer.syncWorld();
  if (animated) renderer.update(16, 16);
  return { session, renderer, ids };
};

describe('classic renderer recolour', () => {
  it('redraws only the recoloured ride, once, and leaves every other display alone', () => {
    const { session, renderer, ids } = setup();
    const before = graphicsUnder(renderer);
    const others = [ids.moon, ids.swings].map((id) => fingerprintNode(objectContainer(renderer, id)));
    session.world.setObjectColours(ids.petal, [LAGOON, null]);
    const calls = countGraphicsDrawCalls(() => renderer.syncWorld());
    expect(calls, 'the one ride was drawn again').toBeGreaterThan(5);
    expect(calls, 'and nothing else was').toBeLessThan(400);
    const after = graphicsUnder(renderer);
    const kept = [...before.keys()].filter((display) => after.has(display));
    const dropped = [...before.keys()].filter((display) => !after.has(display));
    const fresh = [...after.keys()].filter((display) => !before.has(display));
    expect(dropped.length, 'only the old art went').toBeGreaterThan(3);
    expect(fresh.length, 'the same number of displays came back').toBe(dropped.length);
    expect(kept.length + dropped.length).toBe(before.size);
    expect(dropped.every((display) => before.get(display)!.destroyed), 'old GPU buffers released').toBe(true);
    expect([ids.moon, ids.swings].map((id) => fingerprintNode(objectContainer(renderer, id)))).toEqual(others);
    expect(fingerprintNode(objectContainer(renderer, ids.petal)).includes(String(COLOUR_SWATCHES[LAGOON].classicRgb))).toBe(true);
    renderer.destroy();
  });

  it('costs nothing on a sync or a frame that recoloured nothing', () => {
    const { session, renderer, ids } = setup();
    session.world.setObjectColours(ids.petal, [LAGOON, ROSE]);
    renderer.syncWorld();
    const settled = graphicsUnder(renderer);
    const calls = countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 300; frame += 1) {
        if (frame % 10 === 0) renderer.syncWorld();
        renderer.update(16, 16 * (frame + 2));
      }
    });
    expect(calls).toBe(0);
    const later = graphicsUnder(renderer);
    expect([...later.keys()]).toEqual([...settled.keys()]);
    // A no-op set keeps the record identity, so it cannot even reach the art.
    session.world.setObjectColours(ids.petal, [LAGOON, ROSE]);
    expect(countGraphicsDrawCalls(() => renderer.syncWorld())).toBe(0);
    renderer.destroy();
  });

  it('does not accumulate displays or leak contexts over many recolours (the old art is the pool)', () => {
    const { session, renderer, ids } = setup();
    const baseline = graphicsUnder(renderer).size;
    const everSeen = new Map<Graphics, GraphicsContext>(graphicsUnder(renderer));
    for (let round = 0; round < 25; round += 1) {
      session.world.setObjectColours(ids.swings, [round % COLOUR_SWATCHES.length, (round * 5 + 1) % COLOUR_SWATCHES.length, null]);
      renderer.syncWorld();
      for (const [display, context] of graphicsUnder(renderer)) everSeen.set(display, context);
      expect(graphicsUnder(renderer).size).toBe(baseline);
    }
    const alive = graphicsUnder(renderer);
    const leaked = [...everSeen].filter(([display, context]) => !alive.has(display) && !context.destroyed);
    expect(leaked.length).toBe(0);
    renderer.destroy();
  });

  it('is identical to a from-scratch build of the same coloured park, and back to default when cleared', () => {
    // Not animated: a from-scratch renderer has not been stepped, so both sides must be at rest.
    const { session, renderer, ids } = setup(false);
    session.world.setObjectColours(ids.moon, [ROSE, null, LAGOON]);
    session.world.setObjectColours(ids.swings, [null, LAGOON, null]);
    renderer.syncWorld();
    const incremental = [ids.petal, ids.moon, ids.swings].map((id) => fingerprintNode(objectContainer(renderer, id)));
    const scratch = new WorldRenderer(session);
    scratch.syncWorld();
    expect([ids.petal, ids.moon, ids.swings].map((id) => fingerprintNode(objectContainer(scratch, id)))).toEqual(incremental);
    scratch.destroy();

    const defaults = new WorldRenderer(setup(false).session);
    defaults.syncWorld();
    const defaultMoon = fingerprintNode(objectContainer(defaults, ids.moon));
    expect(incremental[1]).not.toBe(defaultMoon);
    session.world.clearObjectColours(ids.moon);
    renderer.syncWorld();
    expect(fingerprintNode(objectContainer(renderer, ids.moon))).toBe(defaultMoon);
    defaults.destroy();
    renderer.destroy();
  });

  it('keeps the colours through view turns, including the spare art of the other axis', () => {
    const { session, renderer, ids } = setup();
    renderer.setViewRotation(1, true); // odd turn: the other footprint axis is built and the old one kept as the spare
    session.world.setObjectColours(ids.petal, [LAGOON, null]);
    renderer.syncWorld();
    const lagoon = String(COLOUR_SWATCHES[LAGOON].classicRgb);
    renderer.setViewRotation(0, true); // swaps the spare back in: it must be the NEW colours, not the stale ones
    expect(fingerprintNode(objectContainer(renderer, ids.petal)).includes(lagoon)).toBe(true);
    renderer.setViewRotation(1, true);
    expect(fingerprintNode(objectContainer(renderer, ids.petal)).includes(lagoon)).toBe(true);
    renderer.destroy();
  });

  it('draws recolours that arrive with a session swap (undo and load)', () => {
    const { renderer, ids } = setup();
    const next = new ParkSession(null);
    const nextIds = buildPark(next);
    expect(nextIds).toEqual(ids);
    next.world.setObjectColours(nextIds.swings, [LAGOON, ROSE, null]);
    (renderer as unknown as { mounted: boolean }).mounted = true;
    renderer.setSession(next);
    expect(fingerprintNode(objectContainer(renderer, ids.swings)).includes(String(COLOUR_SWATCHES[LAGOON].classicRgb))).toBe(true);
    (renderer as unknown as { mounted: boolean }).mounted = false;
    renderer.destroy();
  });
});
