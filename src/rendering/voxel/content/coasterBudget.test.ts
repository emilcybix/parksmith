import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { coasterBaseCost, deriveCoasterStats, validateCoasterLayout } from '../../../game/coaster/design';
import type { CoasterPiece } from '../../../game/coaster/design';
import { layoutFromMoves, longestLayout } from '../../../game/coaster/testLayouts';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { seedDevPark } from '../../../game/session/devPark';
import { ParkSession } from '../../../game/session/ParkSession';
import { compileBlueprint, createModelCache } from '../blueprint/compile';
import { BoxWriter, TRANSFORM_CAPACITY } from '../contracts/boxes';
import { BOX_BUDGET, COASTER_BOX_BUDGET, DEV_PARK_BOX_BUDGET } from '../contracts/budgets';
import type { VoxelGpuSink } from '../contracts/frame';
import { chunkIndexOfCell } from '../contracts/space';
import { buildPalette } from '../palette';
import { VoxelScene } from '../scene/VoxelScene';
import { coasterContent } from './coaster';

/**
 * Coaster box budgets at the scale the renderer pays for them (contracts/budgets.ts
 * COASTER_BOX_BUDGET): whole coasters through the real scene, chunk by chunk, with their trains.
 * - The longest layout the designer allows (64 pieces, 44 corners, hills 0 to 4) on an empty map:
 *   box total, the heaviest chunk, and the time of the one frame that rebuilds its chunks.
 * - Three 64-piece coasters on an empty 32 × 32 map: two of the longest serpentine side by side and
 *   a 64-piece rectangle under them (a third serpentine does not fit the map), against the park
 *   budgets: still inside DEV_PARK_BOX_BUDGET, a fraction of MAX_PARK_BOX_BUDGET.
 * - The developer park's coaster, measured piece by piece.
 * Numbers are measured on the software path; the budgets carry about 15 % headroom over them.
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const SERPENT = COASTER_TYPE_BY_ID.get('skyline-serpent')!;

class CountingSink implements VoxelGpuSink {
  readonly chunkBoxes = new Map<number, number>();
  rebuilds = 0;
  setChunk(index: number, _boxes: Float32Array, boxCount: number): void {
    this.chunkBoxes.set(index, boxCount);
    this.rebuilds += 1;
  }
  setDynamic(): void {}
  setFigureRanges(): void {}
  setGhost(): void {}
  setDraft(): void {}
  total(): number {
    let sum = 0;
    for (const count of this.chunkBoxes.values()) sum += count;
    return sum;
  }
  heaviest(): number {
    let most = 0;
    for (const count of this.chunkBoxes.values()) most = Math.max(most, count);
    return most;
  }
}

const emptyPark = (): { session: ParkSession; scene: VoxelScene; sink: CountingSink } => {
  const session = new ParkSession(null);
  session.world.setBuildAccessPolicy(null);
  session.world.addMoney(5_000_000, 'test');
  const sink = new CountingSink();
  const scene = new VoxelScene(session, PALETTE, createModelCache(), { sink, prewarmBudgetMs: 0 });
  session.world.subscribe(() => scene.syncWorld());
  return { session, scene, sink };
};

let clock = 0;
const frame = (scene: VoxelScene): void => {
  clock += 16;
  scene.update(16, clock, 0.5);
};

const place = (session: ParkSession, pieces: CoasterPiece[]): number => {
  expect(validateCoasterLayout(pieces, SERPENT), 'a real coaster').toEqual({ ok: true });
  const placed = session.world.placeCoaster(SERPENT.definitionId, pieces, deriveCoasterStats(pieces, SERPENT), coasterBaseCost(pieces, SERPENT));
  if ('error' in placed) throw new Error(`placement failed: ${placed.error}`);
  session.syncWithWorld();
  return placed.id;
};

/** A 64-piece rectangle 30 × 4 cells with a sawtooth of hills: the third coaster that fits under two serpentines. */
const longRectangle = (start: { x: number; y: number }): CoasterPiece[] => {
  const moves = `${'E'.repeat(29)}${'S'.repeat(3)}${'W'.repeat(29)}${'N'.repeat(3)}`;
  const wave = [1, 2, 3, 4, 3, 2, 1, 0];
  const heights = Array.from({ length: moves.length }, (_unused, index) => (index < 3 ? 0 : wave[(index - 3) % 8]));
  heights[moves.length - 3] = 2;
  heights[moves.length - 2] = 1;
  heights[moves.length - 1] = 0;
  return layoutFromMoves(start, moves, heights);
};

/** The empty-map frame cost: the ground chunks of a 32 × 32 park (terrain, the entrance). */
const emptyMapBoxes = (): number => {
  const { scene, sink } = emptyPark();
  frame(scene);
  return sink.total();
};

describe('coaster box budgets (COASTER_BOX_BUDGET)', () => {
  it('builds the longest allowed coaster within its budget, in one rebuild of its own chunks', () => {
    const { session, scene, sink } = emptyPark();
    frame(scene);
    const ground = sink.total();
    sink.rebuilds = 0;
    const pieces = longestLayout({ x: 2, y: 2 });
    expect(pieces.length).toBe(GAME_CONFIG.coaster.maximumPieces);
    place(session, pieces);
    const started = performance.now();
    frame(scene);
    const rebuildMs = performance.now() - started;
    const touched = new Set(pieces.map((piece) => chunkIndexOfCell(piece.cell.x, piece.cell.y, session.world.width)));
    expect(sink.rebuilds, 'each chunk the coaster touches, once').toBe(touched.size);
    const coasterBoxes = sink.total() - ground;
    // Track pieces plus the serpent's train (cars, riders and couplings: 311 boxes in the station's chunk).
    expect(coasterBoxes, 'the longest coaster with its train').toBeLessThanOrEqual(COASTER_BOX_BUDGET.longest);
    expect(coasterBoxes, 'and it is a real coaster').toBeGreaterThan(4_000);
    expect(sink.heaviest(), 'the heaviest chunk').toBeLessThanOrEqual(COASTER_BOX_BUDGET.heaviestChunk);
    expect(rebuildMs, 'the one frame that rebuilds its chunks (software, ms)').toBeLessThan(1_000);
    // The next frames rebuild nothing.
    sink.rebuilds = 0;
    frame(scene);
    frame(scene);
    expect(sink.rebuilds, 'a steady frame rebuilds no chunk').toBe(0);
  });

  it('keeps three 64-piece coasters on an empty map inside the developer-park budget', () => {
    const { session, scene, sink } = emptyPark();
    frame(scene);
    const ground = sink.total();
    place(session, longestLayout({ x: 1, y: 1 }));
    place(session, longestLayout({ x: 16, y: 1 }));
    place(session, longRectangle({ x: 1, y: 24 }));
    frame(scene);
    const coasters = sink.total() - ground;
    expect(coasters, 'three 64-piece coasters with their trains').toBeLessThanOrEqual(COASTER_BOX_BUDGET.threeLongest);
    expect(coasters, 'three real coasters').toBeGreaterThan(10_000);
    expect(sink.total(), 'the whole map').toBeLessThanOrEqual(DEV_PARK_BOX_BUDGET);
    expect(sink.heaviest(), 'the heaviest chunk').toBeLessThanOrEqual(COASTER_BOX_BUDGET.heaviestChunk);
  });

  it('builds the developer park coaster within its budget', () => {
    const session = new ParkSession(null);
    seedDevPark(session);
    const [record] = session.world.coasters.values();
    expect(record, 'the dev park has a coaster').toBeDefined();
    const object = session.world.objects.get(record!.objectId);
    const definition = BUILD_BY_ID.get(object?.definitionId ?? 'star-chaser')!;
    const writer = new BoxWriter(64);
    for (let index = 0; index < record!.pieces.length; index += 1) {
      coasterContent.pieceBoxes(record!.pieces, index, definition, PALETTE, 1, writer);
    }
    expect(writer.count, 'the dev park coaster (16 pieces)').toBeLessThanOrEqual(COASTER_BOX_BUDGET.devPark);
    let train = 0;
    const cars = COASTER_TYPE_BY_ID.get(definition.id)!.trainCars;
    for (let car = 0; car < cars; car += 1) {
      train += compileBlueprint(coasterContent.carBlueprint(definition, car, PALETTE)).boxCount
        + compileBlueprint(coasterContent.riderBlueprint(definition, car, PALETTE)).boxCount;
    }
    train += 2 * (cars - 1) * compileBlueprint(coasterContent.couplingBlueprint(definition, PALETTE)).boxCount;
    expect(train, 'the dev park coaster\'s train').toBeLessThanOrEqual(BOX_BUDGET.coasterTrain);
    expect(writer.count + train, 'the dev park coaster and its train').toBeLessThanOrEqual(COASTER_BOX_BUDGET.devPark + BOX_BUDGET.coasterTrain);
    expect(PALETTE.count, 'materials in use stay far inside the 256 slots').toBeLessThanOrEqual(128);
    expect(emptyMapBoxes(), 'an empty map is cheap').toBeLessThan(3_000);
  });

  it('keeps the transform table far from full: a train is 4 · cars − 2 slots, and a map of minimum-length coasters fits', () => {
    const slots = (cars: number): number => 4 * cars - 2;
    const worstTrain = Math.max(...[...COASTER_TYPE_BY_ID.values()].map((type) => slots(type.trainCars)));
    expect(worstTrain, 'serpent: 6 cars, 6 rider parts, 5 couplings of two halves').toBe(22);
    // 32 × 32 cells, one coaster per minimumPieces cells at the very most, every one a serpent.
    const mostCoasters = Math.floor((32 * 32) / GAME_CONFIG.coaster.minimumPieces);
    expect(mostCoasters * worstTrain, 'slots of a map packed with serpents').toBeLessThan(TRANSFORM_CAPACITY / 1.5);
  });
});
