import { Container, Graphics, type GraphicsContext } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ParkSession } from '../game/session/ParkSession';
import type { GameWorld } from '../game/World';
import { WorldRenderer } from './WorldRenderer';

/**
 * Snapshot undo swaps the session on the classic renderer every time the player presses Ctrl+Z
 * (and a load does too). `setSession` rebuilds about a thousand displays from scratch, each a
 * `new Graphics()` that owns a GraphicsContext with GPU buffers. Pixi v8 releases those buffers
 * only when the destroy options say `context: true`; without it every swap leaked ~24 MB of heap
 * and ~2,200 GL buffers (measured at 1,000 guests), so ten undos would leak ~245 MB. A unit test
 * cannot count GL buffers, but it can count what they hang off: every display the swap throws away
 * must have its context destroyed, and displays must not accumulate across swaps.
 */

const buildPark = (world: GameWorld): void => {
  world.addMoney(5_000_000, 'Swap test funding');
  for (let index = 0; index < 12; index += 1) world.buildPaths([{ x: 15, y: 30 - index }]);
  world.buildObject('petal-roundabout', { x: 16, y: 26 });
  world.buildObject('moonpetal-carousel', { x: 11, y: 22 }, 1);
  world.buildObject('picnic-pocket', { x: 13, y: 28 });
  world.buildObject('confetti-tree', { x: 16, y: 29 });
};

/**
 * Every Graphics under any of the renderer's layers, with the context it owns right now. The
 * layers are fields (they are only attached to the camera on mount, which needs a GPU), so they
 * are found by type rather than through the camera.
 */
const graphicsUnder = (renderer: WorldRenderer): Map<Graphics, GraphicsContext> => {
  const found = new Map<Graphics, GraphicsContext>();
  const visit = (node: Container): void => {
    if (node instanceof Graphics) found.set(node, node.context);
    for (const child of node.children) visit(child as Container);
  };
  for (const value of Object.values(renderer)) {
    if (value instanceof Container) visit(value);
  }
  return found;
};

/** `setSession` is a no-op before mount; the displays under test do not need a GPU. */
const markMounted = (renderer: WorldRenderer): void => {
  (renderer as unknown as { mounted: boolean }).mounted = true;
};

const newPark = (): ParkSession => {
  const session = new ParkSession(null);
  buildPark(session.world);
  session.syncWithWorld();
  return session;
};

describe('classic renderer session swap', () => {
  it('destroys the GraphicsContext of every display it throws away', () => {
    const renderer = new WorldRenderer(newPark());
    renderer.syncWorld();
    markMounted(renderer);
    const before = graphicsUnder(renderer);
    expect(before.size, 'the park has displays to throw away').toBeGreaterThan(10);

    renderer.setSession(newPark());
    const after = graphicsUnder(renderer);
    const thrownAway = [...before].filter(([display]) => !after.has(display));
    expect(thrownAway.length, 'the swap replaced the displays').toBeGreaterThan(10);
    const leaked = thrownAway.filter(([, context]) => !context.destroyed);
    expect(leaked.length, 'GraphicsContexts left alive (their GPU buffers leak)').toBe(0);
  });

  it('does not accumulate displays across repeated swaps', () => {
    const renderer = new WorldRenderer(newPark());
    renderer.syncWorld();
    markMounted(renderer);
    renderer.setSession(newPark());
    const baseline = graphicsUnder(renderer).size;
    const everSeen = new Set<Graphics>(graphicsUnder(renderer).keys());
    const contexts: GraphicsContext[] = [...graphicsUnder(renderer).values()];
    for (let swap = 0; swap < 10; swap += 1) {
      renderer.setSession(newPark());
      const now = graphicsUnder(renderer);
      expect(now.size, `swap ${swap}: display count stays flat`).toBe(baseline);
      for (const [display, context] of now) {
        if (everSeen.has(display)) continue;
        everSeen.add(display);
        contexts.push(context);
      }
    }
    const live = contexts.filter((context) => !context.destroyed).length;
    // Only the displays of the current park may hold a live context; every earlier one is released.
    expect(live, 'live contexts equal the displays on screen, not one more per swap').toBe(baseline);
  });
});
