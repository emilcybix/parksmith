import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  centreLineFor,
  centreLineIndexToDistance,
  createCentreLineSample,
  openLayoutRing,
  sampleCentreLine,
} from '../game/coaster/centreLine';
import { COASTER_TYPE_BY_ID } from '../game/coaster/content';
import { coasterBaseCost, deriveCoasterStats } from '../game/coaster/design';
import type { CoasterPiece } from '../game/coaster/design';
import { hillDipLayout, ovalLayout } from '../game/coaster/testLayouts';
import { GAME_CONFIG } from '../game/config';
import { ParkSession } from '../game/session/ParkSession';
import { buildClassicTrack } from './classicCoaster';
import { CLASSIC_CAR_HALF, CLASSIC_LEAD_HALF, classicCarLean } from './classicTrain';
import { coasterCarFrame, coasterLoadedCars, createCoasterCarFrame, resampleCoasterCarFrame } from './coasterCarFrame';
import { coasterHeadIndex } from './coasterTrain';
import { countGraphicsDrawCalls } from './drawCallCounter';
import { projectX, projectY } from './voxel/contracts/space';
import { placeCoasterCars, createCoasterCarPoses } from './voxel/scene/coasterCars';
import { WorldRenderer } from './WorldRenderer';

/**
 * The classic renderer draws the coaster from the same smooth centre line as the voxel one
 * (game/coaster/centreLine.ts): rails, ties, supports, chain, brake and station are the geometry
 * `classicCoaster.ts` builds from it (tested there), the train rides it, and the draft preview shows
 * the same structure. And it does so without churn: the track is drawn once at construction, the
 * draft into one pooled Graphics, and a frame only moves the pre-built cars.
 */

const START = { x: 4, y: 4 };

interface TrainDisplay {
  cars: { root: Container; upper: Container; riders: Container }[];
  loadedCars: number;
}

const trainsOf = (renderer: WorldRenderer): Map<number, TrainDisplay> =>
  (renderer as unknown as { coasterTrains: Map<number, TrainDisplay> }).coasterTrains;

const parkWithCoaster = (layout = ovalLayout(START), typeId = 'star-chaser'): { session: ParkSession; id: number; pieces: CoasterPiece[] } => {
  const type = COASTER_TYPE_BY_ID.get(typeId);
  if (!type) throw new Error(`${typeId} went missing`);
  const session = new ParkSession(null);
  session.world.addMoney(1_000_000, 'test');
  const pieces = layout;
  const placed = session.world.placeCoaster(typeId, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
  if ('error' in placed) throw new Error(`placement failed: ${placed.error}`);
  session.syncWithWorld();
  return { session, id: placed.id, pieces };
};

const draftLayerOf = (renderer: WorldRenderer): Container =>
  (renderer as unknown as { coasterDraftLayer: Container }).coasterDraftLayer;

const objectDisplaysOf = (renderer: WorldRenderer): Map<number, { container: Container }> =>
  (renderer as unknown as { objectDisplays: Map<number, { container: Container }> }).objectDisplays;

/** Every point the geometry would stroke, as "x,y" keys at 1e-6. */
const geometryPoints = (pieces: readonly CoasterPiece[], closed: boolean): Set<string> => {
  const ring = closed ? pieces : openLayoutRing(pieces);
  const offset = closed ? 0 : 1;
  const geometry = buildClassicTrack(centreLineFor(ring), offset, offset + pieces.length - 1, {
    closed, stationLength: GAME_CONFIG.coaster.stationLength,
  });
  const keys = new Set<string>();
  const add = (flat: readonly number[]): void => {
    for (let at = 0; at + 1 < flat.length; at += 2) keys.add(`${flat[at].toFixed(6)},${flat[at + 1].toFixed(6)}`);
  };
  for (const run of [...geometry.spine, ...geometry.left, ...geometry.right, ...geometry.chevrons]) add(run);
  add(geometry.ties);
  add(geometry.chain);
  add(geometry.brake);
  add(geometry.brakeFin);
  for (const support of geometry.supports) {
    add(support.legs);
    add(support.braces);
  }
  for (const station of geometry.stations) {
    add(station.platformEdge);
    add(station.valance);
    add(station.post);
    add(station.gate);
    add(station.light.slice(0, 4));
  }
  return keys;
};

/** Every moveTo / lineTo point a call records while `run` executes, in order. */
const recordPath = (run: () => void): Array<{ x: number; y: number }> => {
  const prototype = Graphics.prototype as unknown as Record<string, (...args: number[]) => unknown>;
  const points: Array<{ x: number; y: number }> = [];
  const originals = (['moveTo', 'lineTo'] as const).map((name) => [name, prototype[name]] as const);
  for (const [name, original] of originals) {
    prototype[name] = function patched(this: Graphics, ...args: number[]): unknown {
      points.push({ x: args[0], y: args[1] });
      return original.apply(this, args);
    };
  }
  try {
    run();
  } finally {
    for (const [name, original] of originals) prototype[name] = original;
  }
  return points;
};

describe('classic coaster track', () => {
  it('strokes exactly the structure classicCoaster.ts builds: rails, ties, supports, chain, brake and station', () => {
    const pieces = hillDipLayout(START);
    const renderer = new WorldRenderer(new ParkSession(null));
    renderer.syncWorld();
    const expected = geometryPoints(pieces, true);
    const points = recordPath(() => renderer.drawCoasterDraft(pieces, 0x1b7f79, true, 'skyline-serpent'));
    const drawn = new Set(points.map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`));
    // Every line point the renderer recorded is a point of the geometry (the lap-closing guide is
    // not drawn for a closable layout), and every geometry point was drawn.
    for (const key of drawn) expect(expected.has(key), `drawn point ${key} comes from the geometry`).toBe(true);
    for (const key of expected) expect(drawn.has(key), `geometry point ${key} was drawn`).toBe(true);
    // Two rails, ties and supports: far more than the step-1 single polyline.
    expect(points.length).toBeGreaterThan(3 * (28 * 4 + 4 * 8));
  });

  it('draws the same curve for an open draft as the built layout shows, ends level', () => {
    const open = ovalLayout(START).slice(0, 10);
    const renderer = new WorldRenderer(new ParkSession(null));
    renderer.syncWorld();
    const points = recordPath(() => renderer.drawCoasterDraft(open, 0xe4572e));
    expect(points.length, 'a draft of ten pieces draws a polyline through all of them').toBeGreaterThan(2 * 10 * 4);
    expect(renderer.coasterDraftVisible).toBe(true);
    const expected = geometryPoints(open, false);
    const drawn = new Set(points.map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`));
    for (const key of expected) expect(drawn.has(key), `geometry point ${key} was drawn`).toBe(true);
  });

  it('draws the layout in progress into one pooled Graphics, cleared and reused, never replaced', () => {
    const renderer = new WorldRenderer(new ParkSession(null));
    renderer.syncWorld();
    const layer = draftLayerOf(renderer);
    const pieces = ovalLayout(START);
    renderer.drawCoasterDraft(pieces.slice(0, 2), 0x7048c9, true, 'star-chaser');
    expect(layer.children).toHaveLength(1);
    const graphic = layer.children[0];
    for (let length = 3; length <= pieces.length; length += 1) {
      renderer.drawCoasterDraft(pieces.slice(0, length), 0x7048c9, length % 2 === 0, 'star-chaser');
      expect(layer.children, 'one display for the draft').toHaveLength(1);
      expect(layer.children[0], 'the same display').toBe(graphic);
    }
    renderer.drawCoasterDraft([], 0);
    expect(renderer.coasterDraftVisible).toBe(false);
    expect(graphic.destroyed, 'parked, not destroyed').toBe(false);
    renderer.drawCoasterDraft(pieces, 0x7048c9, true, 'star-chaser');
    expect(layer.children[0]).toBe(graphic);
    renderer.destroy();
    expect(graphic.destroyed, 'released with the renderer').toBe(true);
  });

  it('draws each built coaster once at construction and never again on a sync', () => {
    const { session, id } = parkWithCoaster(hillDipLayout(START), 'star-chaser');
    const renderer = new WorldRenderer(session);
    const first = countGraphicsDrawCalls(() => renderer.syncWorld());
    expect(first, 'construction strokes the structure').toBeGreaterThan(300);
    expect(countGraphicsDrawCalls(() => renderer.syncWorld()), 'a sync with nothing new draws nothing').toBe(0);
    const display = objectDisplaysOf(renderer).get(id);
    expect(display?.container.destroyed).toBe(false);
    // Bulldozing the coaster destroys its one display, and swapping the session rebuilds from scratch.
    session.world.bulldoze(session.world.coasters.get(id)!.pieces[0].cell);
    renderer.syncWorld();
    expect(display?.container.destroyed, 'the track display was released').toBe(true);
    expect(objectDisplaysOf(renderer).has(id)).toBe(false);
    const other = parkWithCoaster(ovalLayout({ x: 8, y: 8 }), 'comet-trail');
    renderer.setSession(other.session);
    // Unmounted, the swap leaves the sync to the caller: the new coaster is drawn once, then never again.
    expect(countGraphicsDrawCalls(() => renderer.syncWorld())).toBeGreaterThan(100);
    expect(objectDisplaysOf(renderer).get(other.id)?.container.destroyed).toBe(false);
    expect(countGraphicsDrawCalls(() => renderer.syncWorld())).toBe(0);
    renderer.destroy();
  });
});

describe('classic coaster train', () => {
  it('rides the centre line, on the same screen spot the voxel train projects to (the classic car sits 1 px higher)', () => {
    const { session, id, pieces } = parkWithCoaster();
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    const record = session.world.coasters.get(id);
    const runtime = session.rides.getRide(id);
    if (!record || !runtime) throw new Error('coaster not built');
    const line = centreLineFor(pieces);
    const sample = createCentreLineSample();
    const poses = createCoasterCarPoses(8);
    const frame = createCoasterCarFrame();
    let checked = 0;
    for (let step = 0; step < 40; step += 1) {
      runtime.status = 'running';
      runtime.cycleRemainingSeconds = record.stats.durationSeconds * (1 - (step + 0.5) / 41);
      renderer.update(16, 16 * (step + 1));
      const train = trainsOf(renderer).get(id);
      expect(train, 'the train is built').toBeDefined();
      const head = coasterHeadIndex(record, runtime.cycleRemainingSeconds);
      placeCoasterCars(record, head, train?.cars.length ?? 0, poses);
      train?.cars.forEach((carPart, index) => {
        const car = carPart.root;
        // The shared car frame (coasterCarFrame.ts): the bogie-chord midpoint, near the line (sagitta).
        coasterCarFrame(line, centreLineIndexToDistance(line, head), index, frame);
        expect(car.position.x, `car ${index} x`).toBeCloseTo((frame.x - frame.y) * 32, 6);
        expect(car.position.y, `car ${index} y`).toBeCloseTo((frame.x + frame.y) * 16 - frame.z * 13 - 4, 6);
        sampleCentreLine(line, centreLineIndexToDistance(line, head) - index * 0.62, sample);
        expect(Math.hypot(frame.x - sample.x, frame.y - sample.y) * 32, `car ${index} stays on the line in plan`).toBeLessThan(0.5);
        // The voxel train's car projects to the same screen spot, one px lower (rail top 5 above the level, not 4).
        const vx = poses.data[index * 7];
        const vy = poses.data[index * 7 + 1];
        const vz = poses.data[index * 7 + 2];
        expect(projectX(vx, vy), `car ${index} against the voxel train (x)`).toBeCloseTo(car.position.x, 3);
        expect(projectY(vx, vy, vz) - car.position.y, `car ${index} against the voxel train (y)`).toBeCloseTo(-1, 3);
        checked += 1;
      });
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('moves the pre-built cars over 10,000 frames without drawing, creating or replacing a display', () => {
    const { session, id } = parkWithCoaster();
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    const record = session.world.coasters.get(id);
    const runtime = session.rides.getRide(id);
    if (!record || !runtime) throw new Error('coaster not built');
    runtime.status = 'running';
    runtime.cycleRemainingSeconds = record.stats.durationSeconds * 0.9;
    // The first frames create the train displays (which draws once).
    renderer.update(16, 16);
    renderer.update(16, 32);
    const train = trainsOf(renderer).get(id);
    expect(train?.cars.length).toBeGreaterThan(2);
    const before = [...(train?.cars ?? [])];
    const container = train?.cars[0].root.parent;
    const childCount = container?.children.length ?? 0;
    const startX = train?.cars[0].root.position.x ?? 0;
    const calls = countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 10_000; frame += 1) {
        runtime.cycleRemainingSeconds = Math.max(0.1, record.stats.durationSeconds * (0.9 - (frame % 500) * 0.0015));
        renderer.update(16, 48 + frame * 16);
      }
    });
    expect(calls, 'a steady-state frame with a running coaster drew').toBe(0);
    expect(trainsOf(renderer).get(id)?.cars, 'the same car displays').toEqual(before);
    expect(container?.children.length, 'no display added or removed').toBe(childCount);
    expect(train?.cars[0].root.position.x, 'and the train moved').not.toBe(startX);
  });

  it('shows riders only while the ride runs, with a longer lead car and one coupling between cars', () => {
    const { session, id } = parkWithCoaster(ovalLayout(START), 'star-chaser');
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    const runtime = session.rides.getRide(id);
    const record = session.world.coasters.get(id);
    if (!runtime || !record) throw new Error('coaster not built');
    runtime.status = 'idle';
    renderer.update(16, 16);
    const train = trainsOf(renderer).get(id);
    expect(train?.cars.length).toBe(COASTER_TYPE_BY_ID.get('star-chaser')?.trainCars);
    expect(train?.cars.every((car) => !car.riders.visible), 'no riders on a parked train').toBe(true);
    runtime.status = 'running';
    runtime.cycleRemainingSeconds = record.stats.durationSeconds * 0.5;
    renderer.update(16, 32);
    expect(train?.cars.every((car) => !car.riders.visible), 'running with nobody aboard: no riders').toBe(true);
    const type = COASTER_TYPE_BY_ID.get('star-chaser')!;
    runtime.riderGuestIds = Array.from({ length: type.trainCapacity }, (_, guest) => 900 + guest);
    renderer.update(16, 40);
    expect(train?.cars.every((car) => car.riders.visible), 'a full train shows riders in every car').toBe(true);
    // Three riders on the star chaser (two seats a car) fill cars 0 and 1, as in the voxel view.
    runtime.riderGuestIds = [900, 901, 902];
    renderer.update(16, 44);
    expect(train?.cars.map((car) => car.riders.visible)).toEqual(
      train?.cars.map((_car, index) => index < coasterLoadedCars('running', 3, type.trainCapacity, type.trainCars)),
    );
    expect(train?.cars.map((car) => car.riders.visible)).toEqual([true, true, false, false, false]);
    runtime.status = 'idle';
    renderer.update(16, 48);
    expect(train?.cars.every((car) => !car.riders.visible), 'and gone again').toBe(true);
    expect(train?.cars[0].root.children.length).toBeGreaterThan(2);
    expect(CLASSIC_LEAD_HALF).toBeGreaterThan(CLASSIC_CAR_HALF);
    session.world.bulldoze(record.pieces[0].cell);
    renderer.update(16, 64);
    expect(train?.cars[0].root.destroyed, 'released with the coaster').toBe(true);
    expect(trainsOf(renderer).has(id)).toBe(false);
    renderer.destroy();
  });

  it('leans the upper part with banking and not at all on flat track', () => {
    const line = centreLineFor(hillDipLayout(START));
    const frame = createCoasterCarFrame();
    const lean = { x: 0, y: 0 };
    let maxLean = 0;
    for (let at = 0; at < line.totalLength; at += 0.05) {
      frame.distance = at;
      resampleCoasterCarFrame(line, frame);
      classicCarLean(frame, 0.3, lean);
      expect(Number.isFinite(lean.x) && Number.isFinite(lean.y)).toBe(true);
      if (frame.roll === 0) expect(Math.hypot(lean.x, lean.y)).toBeCloseTo(0, 9);
      maxLean = Math.max(maxLean, Math.hypot(lean.x, lean.y));
    }
    expect(maxLean, 'a banked corner leans the seats').toBeGreaterThan(0.2);
    expect(maxLean, 'but only a few px').toBeLessThan(5);
  });
});
