import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ParkSession } from '../game/session/ParkSession';
import type { Cell } from '../game/types';
import { SEE_THROUGH } from './seeThrough';
import { WorldRenderer } from './WorldRenderer';

type Internals = {
  objectDisplays: Map<number, { container: Container }>;
  seeThroughFader: { activeCount: number };
};

const build = (): { renderer: WorldRenderer; session: ParkSession; setHover: (cell: Cell | null) => void } => {
  const session = new ParkSession(null);
  session.world.addMoney(5_000_000, 'See-through test funding');
  // A tall ride in front, and the cell behind it where the player is about to build.
  session.world.buildObject('petal-roundabout', { x: 16, y: 16 });
  const renderer = new WorldRenderer(session);
  renderer.syncWorld();
  let hovered: Cell | null = null;
  Object.defineProperty(renderer, 'hoveredCell', { get: () => hovered });
  return { renderer, session, setHover: (cell) => { hovered = cell; } };
};

const frames = (renderer: WorldRenderer, count: number): void => {
  for (let i = 0; i < count; i += 1) renderer.update(16, i * 16);
};

const displays = (renderer: WorldRenderer): Container[] =>
  [...(renderer as unknown as Internals).objectDisplays.values()].map((d) => d.container);

describe('classic renderer see-through', () => {
  it('fades the building in front of an armed cursor and restores it when disarmed', () => {
    const { renderer, setHover } = build();
    const [ride] = displays(renderer);
    setHover({ x: 14, y: 14 });
    renderer.setSeeThrough({ armed: false, peek: false });
    frames(renderer, 30);
    expect(ride.alpha).toBe(1);
    renderer.setSeeThrough({ armed: true, peek: false });
    frames(renderer, 40);
    expect(ride.alpha).toBeCloseTo(SEE_THROUGH.CLASSIC_ALPHA, 5);
    renderer.setSeeThrough({ armed: false, peek: false });
    frames(renderer, 40);
    expect(ride.alpha).toBe(1);
    expect((renderer as unknown as Internals).seeThroughFader.activeCount).toBe(0);
  });

  it('does not fade a building behind the cursor, and fades out when the pointer leaves the map', () => {
    const { renderer, setHover } = build();
    const [ride] = displays(renderer);
    renderer.setSeeThrough({ armed: true, peek: false });
    setHover({ x: 22, y: 22 });
    frames(renderer, 40);
    expect(ride.alpha).toBe(1);
    setHover({ x: 14, y: 14 });
    frames(renderer, 40);
    expect(ride.alpha).toBeLessThan(1);
    setHover(null);
    frames(renderer, 40);
    expect(ride.alpha).toBe(1);
  });

  it('peek works with the pointer tool (armed false)', () => {
    const { renderer, setHover } = build();
    const [ride] = displays(renderer);
    setHover({ x: 14, y: 14 });
    renderer.setSeeThrough({ armed: false, peek: true });
    frames(renderer, 40);
    expect(ride.alpha).toBeLessThan(1);
  });

  it('keeps the demolished object intact in bulldoze mode', () => {
    const { renderer, session, setHover } = build();
    const [ride] = displays(renderer);
    const object = [...session.world.objects.values()][0];
    // Bulldoze previews one cell; the cell hovered here is the ride's back corner, so the ride
    // sorts in front of it and would fade without the demolition key.
    const cell = session.world.objectFootprint(object)[0];
    setHover(cell);
    renderer.setSeeThrough({ armed: true, peek: false });
    renderer.drawPreview([cell], null, true, true);
    frames(renderer, 40);
    expect(ride.alpha).toBe(1);
  });

  it('restores alpha on a session swap and holds no entry for removed objects', () => {
    const { renderer, session, setHover } = build();
    const [ride] = displays(renderer);
    setHover({ x: 14, y: 14 });
    renderer.setSeeThrough({ armed: true, peek: false });
    frames(renderer, 40);
    expect(ride.alpha).toBeLessThan(1);
    const [object] = [...session.world.objects.values()];
    session.world.bulldoze(object.anchor);
    renderer.syncWorld();
    frames(renderer, 5);
    expect((renderer as unknown as Internals).seeThroughFader.activeCount).toBe(0);
    renderer.setSession(new ParkSession(null));
    expect((renderer as unknown as Internals).seeThroughFader.activeCount).toBe(0);
  });

  it('draws the selection, hint and preview layers after the construction layer', () => {
    const { renderer } = build();
    const layers = renderer.cameraLayers();
    const internals = renderer as unknown as Record<string, Container>;
    const index = (name: string): number => layers.indexOf(internals[name]);
    for (const overlay of ['selectionLayer', 'hintLayer', 'coasterDraftLayer', 'previewLayer']) {
      expect(index(overlay)).toBeGreaterThan(index('constructionLayer'));
    }
  });
});
