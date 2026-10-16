import type { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import { BUILD_BY_ID } from '../game/content/catalog';
import { ParkSession } from '../game/session/ParkSession';
import { seedDevPark } from '../game/session/devPark';
import type { Cell, Rotation } from '../game/types';
import { footprintSize } from '../game/types';
import { countGraphicsDrawCalls } from './drawCallCounter';
import { fingerprintNode } from './sceneFingerprint';
import { VIEW_ROTATIONS, cellToView, createViewFrame, rectToView, rotationInView, type ViewRotation } from './viewRotation';
import { WorldRenderer } from './WorldRenderer';

/**
 * Phase 26 adversarial review (classic). The strongest statement of "view q is drawn correctly" is a
 * differential one: drawing a park in view q must give the same object displays (position, depth
 * key, plot, fences, art) as drawing, in view 0, the park PHYSICALLY turned by q. That covers depth
 * order, footprint anchoring, fence openings toward paths and the ride art orientation at once.
 */

interface Placement { id: string; anchor: Cell; rotation: Rotation }

/** A square map, so the turned park fits the same world. Asymmetric rides at every rotation, paths touching single sides. */
const PLACEMENTS: Placement[] = [
  { id: 'bumble-coach', anchor: { x: 2, y: 3 }, rotation: 0 },
  { id: 'bumble-coach', anchor: { x: 9, y: 2 }, rotation: 1 },
  { id: 'bumble-coach', anchor: { x: 2, y: 12 }, rotation: 2 },
  { id: 'bumble-coach', anchor: { x: 9, y: 12 }, rotation: 3 },
  { id: 'splash-rings', anchor: { x: 18, y: 3 }, rotation: 0 },
  { id: 'splash-rings', anchor: { x: 18, y: 12 }, rotation: 1 },
  { id: 'comet-cups', anchor: { x: 24, y: 20 }, rotation: 0 },
  { id: 'picnic-pocket', anchor: { x: 6, y: 20 }, rotation: 0 },
  { id: 'comfort-cabin', anchor: { x: 9, y: 22 }, rotation: 0 },
  { id: 'confetti-tree', anchor: { x: 13, y: 22 }, rotation: 0 },
  { id: 'ribbon-bench', anchor: { x: 14, y: 22 }, rotation: 0 },
  { id: 'lollipop-lamp', anchor: { x: 15, y: 21 }, rotation: 0 },
];

const PATHS: Cell[] = (() => {
  const cells: Cell[] = [];
  for (let x = 1; x <= 28; x += 1) cells.push({ x, y: 8 });
  for (let y = 9; y <= 26; y += 1) cells.push({ x: 16, y });
  for (let x = 2; x <= 15; x += 1) cells.push({ x, y: 25 });
  return cells;
})();

const SIZE = 32;

/** The park, optionally turned by q in the WORLD (anchors through rectToView, rotation r + q). */
const buildPark = (turn: ViewRotation): { session: ParkSession; ids: number[] } => {
  const session = new ParkSession(null);
  const world = session.world;
  expect(world.width).toBe(SIZE);
  expect(world.height).toBe(SIZE);
  world.addMoney(10_000_000, 'Test funding');
  const frame = createViewFrame(turn, SIZE, SIZE);
  const out = { x: 0, y: 0 };
  // Move the fixed entrance too, so the turned park is the same park (test-only surgery).
  const mutable = world as unknown as { entrance: Cell; occupancy: Map<string, number>; paths: Set<string> };
  const oldKey = `${world.entrance.x},${world.entrance.y}`;
  cellToView(frame, world.entrance.x, world.entrance.y, out);
  mutable.occupancy.delete(oldKey);
  mutable.paths.delete(oldKey);
  mutable.entrance = { x: out.x, y: out.y };
  mutable.occupancy.set(`${out.x},${out.y}`, 0);
  mutable.paths.add(`${out.x},${out.y}`);
  const turned = PATHS.map((cell) => { cellToView(frame, cell.x, cell.y, out); return { x: out.x, y: out.y }; });
  expect(world.buildPaths(turned).built).toBe(PATHS.length);
  const ids: number[] = [];
  const rect = { x: 0, y: 0, width: 0, depth: 0 };
  for (const placement of PLACEMENTS) {
    const definition = BUILD_BY_ID.get(placement.id)!;
    const [width, depth] = footprintSize(definition, placement.rotation);
    rectToView(frame, placement.anchor.x, placement.anchor.y, width, depth, rect);
    const object = world.seedScenarioObject(placement.id, { x: rect.x, y: rect.y }, rotationInView(placement.rotation, turn));
    expect(object, `${placement.id} at ${rect.x},${rect.y}`).not.toBeNull();
    ids.push(object!.id);
  }
  return { session, ids };
};

const displayOf = (renderer: WorldRenderer, objectId: number): Container =>
  renderer.sceneProbe.objects.find((entry) => entry.objectId === objectId)!.container;

/** Instruction multiset: path order (and the implicit pen-up before the first shape) is not part of the picture. */
const normalise = (fingerprint: string): string =>
  fingerprint.split('moveTo([0,0]);').join('').split(/[|<>~()]/).filter(Boolean).sort().join('|');

/**
 * Position, depth key and the drawing. Footprint cells are visited in world order, so the same
 * picture can be recorded in a different instruction order: the instructions are compared as a
 * multiset (the picture of opaque-free plot tiles and fence lines does not depend on that order).
 */
const describeDisplay = (display: Container): string =>
  `${Math.round(display.x * 1000) / 1000},${Math.round(display.y * 1000) / 1000} z=${display.zIndex} `
  + normalise(fingerprintNode(display));

describe('classic view rotation: view q of a park equals view 0 of the park turned by q (review)', () => {
  for (const q of [1, 2, 3] as ViewRotation[]) {
    it(`view ${q}: every object display (position, depth key, plot, fences, art) matches the turned park`, () => {
      const plain = buildPark(0);
      const turned = buildPark(q);
      const inView = new WorldRenderer(plain.session);
      inView.syncWorld();
      inView.setViewRotation(q, true);
      const reference = new WorldRenderer(turned.session);
      reference.syncWorld();
      for (let index = 0; index < PLACEMENTS.length; index += 1) {
        const a = describeDisplay(displayOf(inView, plain.ids[index]));
        const b = describeDisplay(displayOf(reference, turned.ids[index]));
        expect(a, `${PLACEMENTS[index].id} r=${PLACEMENTS[index].rotation} in view ${q}`).toEqual(b);
      }
      // The gate too.
      const gateA = inView.sceneProbe.entranceDisplay!;
      const gateB = reference.sceneProbe.entranceDisplay!;
      expect(describeDisplay(gateA)).toEqual(describeDisplay(gateB));
    });

    it(`view ${q}: the painter order of the construction layer is the turned park's order`, () => {
      const plain = buildPark(0);
      const turned = buildPark(q);
      const inView = new WorldRenderer(plain.session);
      inView.syncWorld();
      inView.setViewRotation(q, true);
      const reference = new WorldRenderer(turned.session);
      reference.syncWorld();
      const order = (renderer: WorldRenderer, ids: number[]): number[] =>
        ids.map((id, index) => [displayOf(renderer, id).zIndex, index] as const)
          .sort((p, r) => p[0] - r[0] || p[1] - r[1]).map(([, index]) => index);
      expect(order(inView, plain.ids)).toEqual(order(reference, turned.ids));
    });
  }

  it('the selection ring, hint ring and ghost are drawn where the turned park draws them', () => {
    for (const q of [1, 2, 3] as ViewRotation[]) {
      const plain = buildPark(0);
      const turned = buildPark(q);
      const frame = createViewFrame(q, SIZE, SIZE);
      const out = { x: 0, y: 0 };
      const toView = (cell: Cell): Cell => { cellToView(frame, cell.x, cell.y, out); return { x: out.x, y: out.y }; };
      const a = new WorldRenderer(plain.session);
      a.syncWorld();
      a.setViewRotation(q, true);
      const b = new WorldRenderer(turned.session);
      b.syncWorld();
      a.selectObject(plain.session.world.objects.get(plain.ids[1])!);
      b.selectObject(turned.session.world.objects.get(turned.ids[1])!);
      const hint = [{ x: 4, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 6 }];
      a.setHintMarkers([{ cells: hint }]);
      b.setHintMarkers([{ cells: hint.map(toView) }]);
      // Ghost: a 4x2 bumble coach at build rotation 1 over free cells.
      const definition = BUILD_BY_ID.get('bumble-coach')!;
      const [width, depth] = footprintSize(definition, 1);
      const cells: Cell[] = [];
      for (let dy = 0; dy < depth; dy += 1) for (let dx = 0; dx < width; dx += 1) cells.push({ x: 22 + dx, y: 26 + dy });
      a.drawPreview(cells, definition, true, false, 1);
      b.drawPreview(cells.map(toView), definition, true, false, rotationInView(1, q));
      const layers = (renderer: WorldRenderer): string[] => {
        const all = renderer.cameraLayers();
        // selection, hint, preview layers (see cameraLayers order).
        return [all[5], all[6], all[8]].map((layer) => layer.children.map((child) => normalise(fingerprintNode(child as Container))).sort().join('~'));
      };
      expect(layers(a), `view ${q}`).toEqual(layers(b));
    }
  });
});

describe('classic view rotation: no churn (review)', () => {
  const devPark = (): ParkSession => {
    const session = new ParkSession(null);
    seedDevPark(session);
    session.guests.spawnGuests(150);
    for (let step = 0; step < 60; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    return session;
  };

  const countNodes = (node: Container): number => {
    let total = 1;
    for (const child of node.children) total += countNodes(child as Container);
    return total;
  };

  it('10k frames across rotations: steady frames rebuild nothing, a turn leaves the node count unchanged', () => {
    const session = devPark();
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    renderer.update(16, 0);
    const nodes = (): number => renderer.cameraLayers().reduce((sum, layer) => sum + countNodes(layer), 0);
    const baseline = nodes();
    let steadyCalls = 0;
    let elapsed = 16;
    const counts: number[] = [];
    for (let frame = 0; frame < 10_000; frame += 1) {
      elapsed += 16;
      if (frame % 500 === 0) {
        renderer.setViewRotation(((frame / 500) & 3) as ViewRotation, true);
        renderer.update(16, elapsed);
        counts.push(nodes());
        continue;
      }
      if (frame % 50 === 0) steadyCalls += countGraphicsDrawCalls(() => renderer.update(16, elapsed));
      else renderer.update(16, elapsed);
    }
    expect(steadyCalls).toBe(0);
    for (const count of counts) expect(count).toBe(baseline);
  });

  it('a steady frame allocates no new display objects in any view (heap trend over 10k frames)', () => {
    const session = devPark();
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    const gc = (globalThis as { gc?: () => void }).gc;
    const samples: number[] = [];
    let elapsed = 0;
    for (const view of VIEW_ROTATIONS) {
      renderer.setViewRotation(view, true);
      for (let frame = 0; frame < 2_500; frame += 1) {
        elapsed += 16;
        renderer.update(16, elapsed);
      }
      gc?.();
      samples.push((globalThis as unknown as { process: { memoryUsage: () => { heapUsed: number } } }).process.memoryUsage().heapUsed);
    }
    // Without --expose-gc the heap reading is GC-timing noise (tens of MB either way under a full
    // parallel suite), so only the exposed-gc run asserts on it; the node-count test above is the
    // allocation guard that always runs.
    if (!gc) return;
    const growth = samples[samples.length - 1] - samples[0];
    expect(growth, `heap samples ${samples.map((s) => Math.round(s / 1e6)).join(',')} MB`).toBeLessThan(2e6);
  });
});

describe('classic view rotation: camera helpers in turned views (review)', () => {
  // focusEntrance ("Center camera on the park entrance", also run after the start-screen sweep)
  // used to centre the hard-coded cell (15.5, 20) at 18% of the screen height in every view, which
  // only puts the gate on screen in view 0. Turned views now frame the gate and the map centre.
  it('the entrance button puts the gate on screen in every view', () => {
    const session = new ParkSession(null);
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    const internals = renderer as unknown as {
      app: { screen: { width: number; height: number } };
      camera: Container;
    };
    // No GL here: give the unmounted Application a screen the size of the reference viewport.
    Object.defineProperty(internals.app, 'screen', { value: { x: 0, y: 0, width: 1440, height: 800 }, configurable: true });
    for (const view of VIEW_ROTATIONS) {
      renderer.setViewRotation(view, true);
      renderer.focusEntrance();
      const gate = renderer.sceneProbe.entranceDisplay!;
      const camera = internals.camera;
      const screenX = camera.x + gate.x * camera.scale.x;
      const screenY = camera.y + gate.y * camera.scale.y;
      expect(screenX, `view ${view}`).toBeGreaterThan(0);
      expect(screenX, `view ${view}`).toBeLessThan(1440);
      expect(screenY, `view ${view}: gate at screen y ${Math.round(screenY)}`).toBeGreaterThan(60);
      expect(screenY, `view ${view}: gate at screen y ${Math.round(screenY)}`).toBeLessThan(800);
    }
  });
});
