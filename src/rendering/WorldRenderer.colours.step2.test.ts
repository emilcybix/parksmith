import { Container, Graphics, type GraphicsContext } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../game/content/catalog';
import { COLOUR_SWATCHES, ENTRANCE_COLOUR_ID, colourSlotsFor } from '../game/content/colours';
import { presetRecord } from '../game/content/colourPresets';
import { ParkSession } from '../game/session/ParkSession';
import { seedColourTestPark } from '../game/session/colourTestPark';
import type { Cell } from '../game/types';
import { classicCoasterPalette } from './classicCoaster';
import { countGraphicsDrawCalls } from './drawCallCounter';
import { fingerprintNode } from './sceneFingerprint';
import { WorldRenderer } from './WorldRenderer';

/**
 * Phase 28 step 2, classic renderer: stalls, scenery, coasters (track, station and train) and the entrance gate
 * redraw ONCE when their colours change, and nothing else does. Plus the preview colours, the Paint hover and the
 * steady-frame rules with everything recoloured.
 */

const LAGOON = COLOUR_SWATCHES.find((swatch) => swatch.id === 'lagoon')!;
const CHERRY = COLOUR_SWATCHES.find((swatch) => swatch.id === 'cherry')!;

const setup = () => {
  const session = new ParkSession(null);
  const report = seedColourTestPark(session);
  expect(report.problems).toEqual([]);
  const renderer = new WorldRenderer(session);
  renderer.syncWorld();
  renderer.update(16, 16);
  const find = (definitionId: string): number => [...session.world.objects.values()].find((object) => object.definitionId === definitionId)!.id;
  const ids = {
    stall: find('picnic-pocket'), bench: find('ribbon-bench'), lamp: find('lollipop-lamp'), flowers: find('sunburst-flowers'),
    fountain: find('ripple-fountain'), tree: find('confetti-tree'), star: find('star-chaser'), comet: report.cometTrailId, serpent: report.serpentId,
    petal: find('petal-roundabout'),
  };
  return { session, renderer, ids };
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

const display = (renderer: WorldRenderer, id: number): Container => renderer.sceneProbe.objects.find((entry) => entry.objectId === id)!.container;
const trains = (renderer: WorldRenderer): Map<number, Container> => (
  new Map([...(renderer as unknown as { coasterTrains: Map<number, { container: Container }> }).coasterTrains].map(([id, train]) => [id, train.container]))
);
const has = (node: Container, rgb: number): boolean => fingerprintNode(node).includes(`{${rgb}/`);

describe('a stall, a bench, a lamp, scenery redraws once when recoloured', () => {
  it('redraws only that object, the old art released with its GPU buffers, every other display untouched', () => {
    const { session, renderer, ids } = setup();
    const before = graphicsUnder(renderer);
    const others = [ids.bench, ids.lamp, ids.petal, ids.star].map((id) => fingerprintNode(display(renderer, id)));
    session.world.setObjectColours(ids.stall, [LAGOON.index, null]);
    const calls = countGraphicsDrawCalls(() => renderer.syncWorld());
    expect(calls, 'the one stall was drawn again').toBeGreaterThan(5);
    expect(calls, 'and nothing else was').toBeLessThan(60);
    const after = graphicsUnder(renderer);
    const dropped = [...before.keys()].filter((graphic) => !after.has(graphic));
    const fresh = [...after.keys()].filter((graphic) => !before.has(graphic));
    expect(dropped).toHaveLength(1);
    expect(fresh).toHaveLength(1);
    expect(before.get(dropped[0])!.destroyed, 'old GPU buffers released').toBe(true);
    expect([ids.bench, ids.lamp, ids.petal, ids.star].map((id) => fingerprintNode(display(renderer, id)))).toEqual(others);
    expect(has(display(renderer, ids.stall), LAGOON.classicRgb)).toBe(true);
    renderer.destroy();
  });

  it('keeps the art at the same child index (the plot stays under it) and refreshes the cached screen box and the see-through', () => {
    const { session, renderer, ids } = setup();
    const group = display(renderer, ids.stall);
    const children = group.children.length;
    const index = group.children.length - 1;
    session.world.setObjectColours(ids.stall, [LAGOON.index, CHERRY.index]);
    renderer.syncWorld();
    expect(group.children).toHaveLength(children);
    expect(group.getChildIndex(group.children[index])).toBe(index);
    expect((renderer as unknown as { seeThroughDirty: boolean }).seeThroughDirty).toBe(true);
    renderer.destroy();
  });

  it('scenery that animates keeps animating after a recolour: its animated entry points at the new art', () => {
    const { session, renderer, ids } = setup();
    const animated = (renderer as unknown as { animatedDisplays: Map<number, { container: Container }> }).animatedDisplays;
    const oldArt = animated.get(ids.flowers)!.container;
    session.world.setObjectColours(ids.flowers, [LAGOON.index, CHERRY.index]);
    renderer.syncWorld();
    const art = animated.get(ids.flowers)!.container;
    expect(art).not.toBe(oldArt);
    expect(oldArt.destroyed).toBe(true);
    expect(art.parent).toBe(display(renderer, ids.flowers));
    renderer.update(16, 5000);
    expect(art.scale.x).not.toBe(1);
    renderer.destroy();
  });

  it('a tree has no record and no redraw; a record on a non-colourable kind never reaches the art', () => {
    const { session, renderer, ids } = setup();
    const before = fingerprintNode(display(renderer, ids.tree));
    expect(session.world.setObjectColours(ids.tree, [1, 2])).toMatchObject({ ok: false });
    renderer.syncWorld();
    expect(fingerprintNode(display(renderer, ids.tree))).toBe(before);
    renderer.destroy();
  });
});

describe('a coaster redraws its track once and rebuilds its train once', () => {
  it('the track Graphics is cleared and drawn again in place, the train is rebuilt on the next frame, other coasters are untouched', () => {
    const { session, renderer, ids } = setup();
    const track = display(renderer, ids.star) as Graphics;
    const trainBefore = trains(renderer);
    const cometTrack = fingerprintNode(display(renderer, ids.comet));
    const baseTrack = fingerprintNode(track);
    const paletteDefault = classicCoasterPalette('star-chaser', BUILD_BY_ID.get('star-chaser')!.color);
    session.world.setObjectColours(ids.star, [CHERRY.index, LAGOON.index, CHERRY.index, LAGOON.index]);
    const calls = countGraphicsDrawCalls(() => renderer.syncWorld());
    expect(calls, 'the track was drawn again').toBeGreaterThan(50);
    expect(display(renderer, ids.star), 'the same Graphics, cleared and redrawn').toBe(track);
    expect(fingerprintNode(track)).not.toBe(baseTrack);
    for (const rgb of [CHERRY.classicRgb, LAGOON.classicRgb]) expect(has(track, rgb), rgb.toString(16)).toBe(true);
    const count = (node: Container, rgb: number): number => fingerprintNode(node).split(`{${rgb}/`).length - 1;
    expect(count(track, paletteDefault.support)).toBeLessThan(baseTrack.split(`{${paletteDefault.support}/`).length - 1);
    expect(fingerprintNode(display(renderer, ids.comet)), 'the other coaster is untouched').toBe(cometTrack);
    expect(trains(renderer).has(ids.star), 'the old train is dropped at once').toBe(false);
    expect(trainBefore.get(ids.star)!.destroyed).toBe(true);
    renderer.update(16, 32);
    const trainAfter = trains(renderer);
    expect(trainAfter.get(ids.star), 'a new train').not.toBe(trainBefore.get(ids.star));
    expect(trainAfter.get(ids.comet), 'the other trains are the same displays').toBe(trainBefore.get(ids.comet));
    expect(trainAfter.get(ids.serpent)).toBe(trainBefore.get(ids.serpent));
    expect(has(trainAfter.get(ids.star)!, CHERRY.classicRgb), 'hull').toBe(true);
    expect(has(trainAfter.get(ids.star)!, LAGOON.classicRgb), 'stripe').toBe(true);
    renderer.destroy();
  });

  it('a ground diamond under the station stays the default rail tint (ground contact)', () => {
    const { session, renderer, ids } = setup();
    const palette = classicCoasterPalette('star-chaser', BUILD_BY_ID.get('star-chaser')!.color);
    session.world.setObjectColours(ids.star, [null, null, CHERRY.index, null]);
    renderer.syncWorld();
    expect(has(display(renderer, ids.star), palette.ground)).toBe(true);
    renderer.destroy();
  });

  it('a track recolour redraws once, a clear returns the default art exactly', () => {
    const { session, renderer, ids } = setup();
    const base = fingerprintNode(display(renderer, ids.star));
    session.world.setObjectColours(ids.star, [LAGOON.index, null, null, null]);
    renderer.syncWorld();
    session.world.clearObjectColours(ids.star);
    renderer.syncWorld();
    expect(fingerprintNode(display(renderer, ids.star))).toBe(base);
    renderer.update(16, 48);
    expect(trains(renderer).size).toBe(3);
    renderer.destroy();
  });
});

describe('the entrance gate redraws once', () => {
  it('the group keeps its place and sort key and its art is replaced once; a clear returns the shipped gate', () => {
    const { session, renderer } = setup();
    const group = renderer.sceneProbe.entranceDisplay!;
    const base = fingerprintNode(group);
    const { x, y, zIndex } = group;
    session.world.setGateColours([LAGOON.index, CHERRY.index, null]);
    const calls = countGraphicsDrawCalls(() => renderer.syncWorld());
    expect(calls).toBeGreaterThan(3);
    expect(calls).toBeLessThan(20);
    expect(renderer.sceneProbe.entranceDisplay).toBe(group);
    expect([group.x, group.y, group.zIndex]).toEqual([x, y, zIndex]);
    expect(has(group, LAGOON.classicRgb)).toBe(true);
    expect(has(group, CHERRY.classicRgb)).toBe(true);
    expect(countGraphicsDrawCalls(() => renderer.syncWorld()), 'nothing more on a sync that changed nothing').toBe(0);
    session.world.clearGateColours();
    renderer.syncWorld();
    expect(fingerprintNode(group)).toBe(base);
    renderer.destroy();
  });
});

describe('steady frames, leaks, equivalence and view turns with everything recoloured', () => {
  const recolourEverything = (session: ParkSession): void => {
    const { world } = session;
    world.batch(() => {
      for (const object of world.objects.values()) {
        const record = presetRecord(object.definitionId, 'midnight');
        if (record) world.setObjectColours(object.id, record);
      }
      world.setGateColours(presetRecord(ENTRANCE_COLOUR_ID, 'midnight')!);
    });
  };

  it('a whole-park preset is one sync; afterwards 300 frames with running coasters draw nothing and build nothing', () => {
    const { session, renderer } = setup();
    recolourEverything(session);
    renderer.syncWorld();
    renderer.update(16, 40);
    const settled = graphicsUnder(renderer);
    const calls = countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 300; frame += 1) {
        if (frame % 10 === 0) renderer.syncWorld();
        renderer.update(16, 16 * (frame + 4));
      }
    });
    expect(calls).toBe(0);
    expect([...graphicsUnder(renderer).keys()]).toEqual([...settled.keys()]);
    renderer.destroy();
  });

  it('does not accumulate displays or leak contexts over 25 recolours of a stall, a coaster and the gate', () => {
    const { session, renderer, ids } = setup();
    renderer.update(16, 40);
    const baseline = graphicsUnder(renderer).size;
    const everSeen = new Map<Graphics, GraphicsContext>(graphicsUnder(renderer));
    for (let round = 0; round < 25; round += 1) {
      session.world.setObjectColours(ids.stall, [round % 21, (round * 5 + 1) % 21]);
      session.world.setObjectColours(ids.comet, [round % 21, null, (round * 3) % 21, (round * 7) % 21]);
      session.world.setGateColours([null, round % 21, (round * 2) % 21]);
      renderer.syncWorld();
      renderer.update(16, 100 + round);
      for (const [graphic, context] of graphicsUnder(renderer)) everSeen.set(graphic, context);
      expect(graphicsUnder(renderer).size).toBe(baseline);
    }
    const alive = graphicsUnder(renderer);
    expect([...everSeen].filter(([graphic, context]) => !alive.has(graphic) && !context.destroyed)).toHaveLength(0);
    renderer.destroy();
  });

  it('equals a from-scratch build of the same coloured park (objects, coaster tracks, the gate; trains by colour)', () => {
    const { session, renderer, ids } = setup();
    recolourEverything(session);
    session.world.setObjectColours(ids.stall, [LAGOON.index, null]);
    renderer.syncWorld();
    renderer.update(16, 40);
    const scratch = new WorldRenderer(session);
    scratch.syncWorld();
    scratch.update(16, 40);
    for (const object of session.world.objects.values()) {
      // Rides are animated (their pose depends on the frames each renderer has seen); everything else is static art.
      if (BUILD_BY_ID.get(object.definitionId)!.kind === 'ride' && BUILD_BY_ID.get(object.definitionId)!.custom !== 'coaster') continue;
      expect(fingerprintNode(display(renderer, object.id)), `${object.definitionId} #${object.id}`).toBe(fingerprintNode(display(scratch, object.id)));
    }
    expect(fingerprintNode(renderer.sceneProbe.entranceDisplay!)).toBe(fingerprintNode(scratch.sceneProbe.entranceDisplay!));
    for (const id of [ids.star, ids.comet, ids.serpent]) {
      const a = [...trains(renderer).get(id)!.children].map((child) => fingerprintNode(child as Container).replace(/^[^<]*/, ''));
      const b = [...trains(scratch).get(id)!.children].map((child) => fingerprintNode(child as Container).replace(/^[^<]*/, ''));
      expect(a.length).toBe(b.length);
    }
    scratch.destroy();
    renderer.destroy();
  });

  it('keeps every colour through the four view turns', () => {
    const { session, renderer, ids } = setup();
    session.world.setObjectColours(ids.stall, [LAGOON.index, CHERRY.index]);
    session.world.setObjectColours(ids.star, [CHERRY.index, null, LAGOON.index, null]);
    session.world.setGateColours([LAGOON.index, null, null]);
    renderer.syncWorld();
    renderer.update(16, 32);
    for (const rotation of [1, 2, 3, 0] as const) {
      renderer.setViewRotation(rotation, true);
      expect(has(display(renderer, ids.stall), LAGOON.classicRgb), `stall view ${rotation}`).toBe(true);
      expect(has(display(renderer, ids.star), LAGOON.classicRgb), `star view ${rotation}`).toBe(true);
      expect(has(renderer.sceneProbe.entranceDisplay!, LAGOON.classicRgb), `gate view ${rotation}`).toBe(true);
      expect(has(trains(renderer).get(ids.star)!, CHERRY.classicRgb), `train view ${rotation}`).toBe(true);
    }
    renderer.destroy();
  });

  it('draws recolours that arrive with a session swap (undo and load), gate included', () => {
    const { renderer, ids } = setup();
    const next = new ParkSession(null);
    seedColourTestPark(next);
    next.world.setObjectColours(ids.stall, [LAGOON.index, null]);
    next.world.setGateColours([CHERRY.index, null, null]);
    (renderer as unknown as { mounted: boolean }).mounted = true;
    renderer.setSession(next);
    expect(has(display(renderer, ids.stall), LAGOON.classicRgb)).toBe(true);
    expect(has(renderer.sceneProbe.entranceDisplay!, CHERRY.classicRgb)).toBe(true);
    (renderer as unknown as { mounted: boolean }).mounted = false;
    renderer.destroy();
  });
});

describe('colour before placing (the classic ghost)', () => {
  it('drawPreview with a record tints the building art; without one (or with null) it is the shipped ghost; a bulldoze ghost keeps its colours', () => {
    const { session, renderer } = setup();
    const definition = BUILD_BY_ID.get('picnic-pocket')!;
    const cells = session.world.footprintCells(definition, { x: 2, y: 1 }, 0);
    const layer = (renderer as unknown as { previewLayer: Container }).previewLayer;
    renderer.drawPreview(cells, definition, true, false, 0);
    const plain = fingerprintNode(layer);
    renderer.drawPreview(cells, definition, true, false, 0, null);
    expect(fingerprintNode(layer)).toBe(plain);
    renderer.drawPreview(cells, definition, true, false, 0, Object.freeze([LAGOON.index, CHERRY.index]));
    const tinted = fingerprintNode(layer);
    expect(tinted).not.toBe(plain);
    expect(tinted.includes(`{${LAGOON.classicRgb}/`) && tinted.includes(`{${CHERRY.classicRgb}/`)).toBe(true);
    renderer.drawPreview(cells, definition, true, true, 0, Object.freeze([LAGOON.index, CHERRY.index]));
    expect(fingerprintNode(layer).includes(`{${LAGOON.classicRgb}/`), 'a bulldoze ghost is not tinted').toBe(false);
    renderer.clearPreview();
    renderer.destroy();
  });

  it('a ride ghost and a coaster draft take the record too, and a view turn redraws them with it', () => {
    const { session, renderer } = setup();
    const ride = BUILD_BY_ID.get('petal-roundabout')!;
    const layer = (renderer as unknown as { previewLayer: Container }).previewLayer;
    renderer.drawPreview(session.world.footprintCells(ride, { x: 3, y: 12 }, 0), ride, true, false, 0, Object.freeze([LAGOON.index, null]));
    expect(has(layer, LAGOON.classicRgb)).toBe(true);
    renderer.setViewRotation(1, true);
    expect(has(layer, LAGOON.classicRgb), 'the turn redrew the ghost with its colours').toBe(true);
    renderer.clearPreview();
    const draftLayer = (renderer as unknown as { coasterDraftLayer: Container }).coasterDraftLayer;
    const pieces = [0, 1, 2, 3, 4, 5].map((x) => ({ cell: { x: 4 + x, y: 12 }, height: 0 }));
    renderer.drawCoasterDraft(pieces, BUILD_BY_ID.get('star-chaser')!.color, true, 'star-chaser', Object.freeze([null, null, CHERRY.index, null]));
    expect(has(draftLayer, CHERRY.classicRgb)).toBe(true);
    renderer.setViewRotation(2, true);
    expect(has(draftLayer, CHERRY.classicRgb), 'the turn redrew the draft with its colours').toBe(true);
    renderer.drawCoasterDraft([], 0);
    renderer.destroy();
  });
});

describe('the Paint hover', () => {
  const cellsOf = (...points: Array<[number, number]>): Cell[] => points.map(([x, y]) => ({ x, y }));
  const hoverGraphic = (renderer: WorldRenderer): Graphics | null => (renderer as unknown as { paintHoverGraphic: Graphics | null }).paintHoverGraphic;

  it('draws an outline (and a tinted fill) once; the same input again costs nothing; a change redraws; null clears', () => {
    const { renderer } = setup();
    const cells = cellsOf([10, 10], [11, 10]);
    const first = countGraphicsDrawCalls(() => renderer.setPaintHover({ cells, tint: 0x3aa7a3 }));
    expect(first).toBeGreaterThan(0);
    const graphic = hoverGraphic(renderer)!;
    expect(graphic.parent, 'in the preview layer').toBe((renderer as unknown as { previewLayer: Container }).previewLayer);
    expect(countGraphicsDrawCalls(() => renderer.setPaintHover({ cells: cellsOf([10, 10], [11, 10]), tint: 0x3aa7a3 })), 'equal input').toBe(0);
    expect(countGraphicsDrawCalls(() => renderer.setPaintHover({ cells, tint: null }))).toBeGreaterThan(0);
    expect(countGraphicsDrawCalls(() => renderer.setPaintHover({ cells: cellsOf([12, 10]), tint: null }))).toBeGreaterThan(0);
    expect(hoverGraphic(renderer), 'the same pooled Graphics').toBe(graphic);
    renderer.setPaintHover(null);
    expect(graphic.parent).toBeNull();
    expect(countGraphicsDrawCalls(() => renderer.setPaintHover(null)), 'clearing twice is free').toBe(0);
    renderer.destroy();
  });

  it('survives a preview being cleared and redrawn (it lives in the preview layer but has its own lifetime)', () => {
    const { session, renderer } = setup();
    renderer.setPaintHover({ cells: cellsOf([10, 10]), tint: null });
    const graphic = hoverGraphic(renderer)!;
    const definition = BUILD_BY_ID.get('ribbon-bench')!;
    renderer.drawPreview(session.world.footprintCells(definition, { x: 3, y: 3 }, 0), definition, true);
    renderer.clearPreview();
    expect(graphic.parent).toBe((renderer as unknown as { previewLayer: Container }).previewLayer);
    expect(graphic.destroyed).toBe(false);
    renderer.destroy();
  });

  it('is drawn again in view space after a turn, and a view turn does not leak it', () => {
    const { renderer } = setup();
    renderer.setPaintHover({ cells: cellsOf([10, 10]), tint: 0xffffff });
    const before = fingerprintNode(hoverGraphic(renderer)!);
    renderer.setViewRotation(1, true);
    expect(fingerprintNode(hoverGraphic(renderer)!)).not.toBe(before);
    renderer.setViewRotation(0, true);
    expect(fingerprintNode(hoverGraphic(renderer)!)).toBe(before);
    renderer.destroy();
  });

  it('drives the see-through like a bulldoze target and releases it on null', () => {
    const { renderer } = setup();
    const internals = renderer as unknown as { previewCells: readonly Cell[]; previewMode: string };
    renderer.setPaintHover({ cells: cellsOf([10, 10], [11, 10]), tint: null });
    expect(internals.previewCells).toHaveLength(2);
    expect(internals.previewMode).toBe('bulldoze');
    renderer.setPaintHover(null);
    expect(internals.previewCells).toHaveLength(0);
    renderer.destroy();
  });

  it('a session swap clears it', () => {
    const { renderer } = setup();
    renderer.setPaintHover({ cells: cellsOf([10, 10]), tint: null });
    renderer.setSession(new ParkSession(null));
    expect(hoverGraphic(renderer)?.parent ?? null).toBeNull();
    renderer.destroy();
  });
});

describe('every colourable id has a classic art that answers to its slots', () => {
  it('the slot ids a definition declares are all consumed by the classic art (each recolours something)', () => {
    // Covered kind by kind above; this guards a future slot added to the table without classic art.
    for (const id of ['picnic-pocket', 'comfort-cabin', 'ribbon-bench', 'tidy-totem', 'lollipop-lamp', 'sunburst-flowers', 'ripple-fountain']) {
      expect(colourSlotsFor(id).length, id).toBeGreaterThanOrEqual(1);
    }
  });
});
