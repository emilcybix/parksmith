import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { deriveCoasterStats, validateCoasterLayout, type CoasterPiece } from '../../../game/coaster/design';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { ParkSession } from '../../../game/session/ParkSession';
import type { BuildDefinition } from '../../../game/types';
import { createModelCache } from '../blueprint/compile';
import { BOX_FLOATS, BoxWriter, withOutlineGroup } from '../contracts/boxes';
import type { GhostState, VoxelGpuSink } from '../contracts/frame';
import { GHOST_COVERAGE_VALID } from '../contracts/gbuffer';
import { buildPalette } from '../palette';
import { CoasterDraft, DRAFT_COVERAGE_PARKED, DRAFT_TRAIN_OBJECT_ID } from './coasterDraft';
import { coasterCarSlotKey, coasterCouplingSlotKey, coasterRiderSlotKey } from '../contracts/rigid';
import { createTransformTable } from './rigid';
import { REGISTRY_CONTENT, SceneModels } from './staticWorld';
import { VoxelScene } from './VoxelScene';

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const TYPE = COASTER_TYPE_BY_ID.get('star-chaser')!;
const DEFINITION: BuildDefinition = BUILD_BY_ID.get(TYPE.definitionId)!;
const models = (): SceneModels => new SceneModels(PALETTE, createModelCache(), REGISTRY_CONTENT, (message) => {
  throw new Error(message);
});

/** A 6x4 ring: flat station, one hill, back to 0. Closed, with a ramp and four turns. */
const ring = (open: boolean): CoasterPiece[] => {
  const cells: { x: number; y: number }[] = [];
  for (let x = 0; x < 6; x += 1) cells.push({ x: 4 + x, y: 4 });
  for (let y = 1; y < 4; y += 1) cells.push({ x: 9, y: 4 + y });
  for (let x = 4; x >= 0; x -= 1) cells.push({ x: 4 + x, y: 7 });
  for (let y = 2; y >= 1; y -= 1) cells.push({ x: 4, y: 4 + y });
  const descent = cells.length - 3;
  const pieces = cells.map((cell, index): CoasterPiece => {
    let height = 0;
    if (index >= 3 && index < descent) height = Math.min(2, index - 2);
    else if (index >= descent) height = Math.max(0, cells.length - 1 - index);
    return { cell, height };
  });
  return open ? pieces.slice(0, 9) : pieces;
};

/** The multiset of boxes with the outline group erased, as comparable strings. */
const boxKeys = (data: Float32Array, count: number): string[] => {
  const keys: string[] = [];
  for (let box = 0; box < count; box += 1) {
    const at = box * BOX_FLOATS;
    const word = withOutlineGroup(data[at + 3], 0);
    keys.push([data[at], data[at + 1], data[at + 2], word, data[at + 4], data[at + 5], data[at + 6]].join(','));
  }
  return keys.sort();
};

class Sink implements VoxelGpuSink {
  drafts: (GhostState | null)[] = [];
  chunks: string[][] = [];
  setChunk(_index: number, boxes: Float32Array, count: number): void {
    this.chunks.push(boxKeys(boxes, count));
  }
  setDynamic(): void {}
  setFigureRanges(): void {}
  setGhost(): void {}
  setDraft(draft: GhostState | null): void {
    this.drafts.push(draft === null ? null : { ...draft });
  }
}

const rig = (): { scene: VoxelScene; sink: Sink; frame: () => void } => {
  const sink = new Sink();
  const scene = new VoxelScene(new ParkSession(null), PALETTE, createModelCache(), { sink, prewarmBudgetMs: 0 });
  return { scene, sink, frame: () => scene.update(16, 16, 0) };
};

describe('coaster draft', () => {
  it('shows exactly the boxes the built coaster has for the same pieces', () => {
    const pieces = ring(false);
    expect(validateCoasterLayout(pieces, TYPE).ok).toBe(true);
    const built = new ParkSession(null);
    const placed = built.world.placeCoaster(TYPE.definitionId, pieces, deriveCoasterStats(pieces, TYPE), 1);
    expect(placed, 'the layout can be built').not.toHaveProperty('error');
    const builtSink = new Sink();
    const builtScene = new VoxelScene(built, PALETTE, createModelCache(), { sink: builtSink, prewarmBudgetMs: 0 });
    builtScene.update(16, 16, 0);
    const inWorld = new Map<string, number>();
    for (const chunk of builtSink.chunks) for (const key of chunk) inWorld.set(key, (inWorld.get(key) ?? 0) + 1);

    const { scene, sink, frame } = rig();
    scene.setCoasterDraft(pieces, DEFINITION, true);
    frame();
    const draft = sink.drafts.at(-1)!;
    expect(draft.boxCount).toBeGreaterThan(50);
    expect([draft.originX, draft.originY, draft.originZ], 'world voxels').toEqual([0, 0, 0]);
    for (const key of boxKeys(draft.boxes, draft.boxCount)) {
      const left = inWorld.get(key) ?? 0;
      expect(left, `built coaster has ${key}`).toBeGreaterThan(0);
      inWorld.set(key, left - 1);
    }
  });

  it('matches pieceBoxes exactly for a closable layout, and follows added and removed pieces', () => {
    const shared = models();
    const draft = new CoasterDraft();
    const pieces = ring(false);
    const expected = (list: readonly CoasterPiece[]): string[] => {
      const writer = new BoxWriter();
      for (let index = 0; index < list.length; index += 1) shared.pieceBoxes(list, index, DEFINITION, 0, writer);
      return boxKeys(writer.data, writer.count);
    };
    const full = draft.resolve(pieces, DEFINITION, true, shared)!;
    expect(boxKeys(full.boxes, full.boxCount)).toEqual(expected(pieces));
    const fullCount = full.boxCount;
    // The state object is reused, so counts are read right after each resolve.
    const fewer = draft.resolve(pieces.slice(0, 10), DEFINITION, true, shared)!.boxCount;
    expect(fewer, 'removing pieces removes their boxes').toBeLessThan(fullCount);
    const grown = draft.resolve(pieces.slice(0, 12), DEFINITION, true, shared)!.boxCount;
    expect(grown, 'appending adds boxes').toBeGreaterThan(fewer);
  });

  it('draws an open layout, whose ends have no neighbour to bend toward', () => {
    const shared = models();
    const open = ring(true);
    const draft = new CoasterDraft().resolve(open, DEFINITION, true, shared)!;
    // Piece by piece against the same pieces followed by a level straight-ahead piece.
    const last = open[open.length - 1];
    const before = open[open.length - 2];
    const ahead: CoasterPiece = {
      cell: { x: last.cell.x + Math.sign(last.cell.x - before.cell.x), y: last.cell.y + Math.sign(last.cell.y - before.cell.y) },
      height: last.height,
    };
    const writer = new BoxWriter();
    shared.pieceBoxes([...open, ahead], open.length - 1, DEFINITION, 0, writer);
    const lastKeys = boxKeys(writer.data, writer.count);
    const all = boxKeys(draft.boxes, draft.boxCount);
    for (const key of lastKeys) expect(all, 'the last piece ends level and straight').toContain(key);
  });

  it('keeps the station furniture on pieces 0 to 2 of an open draft, as built (not shifted one piece along)', () => {
    const shared = models();
    const closed = ring(false);
    const open = closed.slice(0, 6);
    const draft = new CoasterDraft().resolve(open, DEFINITION, true, shared)!;
    const drafted = boxKeys(draft.boxes, draft.boxCount);
    // Pieces 1 and 2 have the same neighbours in the draft as in the built ring (piece 0 closes into
    // a corner when built, which the draft deliberately does not show).
    for (const index of [1, 2]) {
      const writer = new BoxWriter();
      shared.pieceBoxes(closed, index, DEFINITION, 0, writer);
      const keys = boxKeys(writer.data, writer.count);
      expect(keys.length).toBeGreaterThan(6);
      for (const key of keys) expect(drafted, `piece ${index} box ${key}`).toContain(key);
    }
  });

  it('draws a single piece and a 64-piece layout without throwing', () => {
    const shared = models();
    const draft = new CoasterDraft();
    expect(draft.resolve([{ cell: { x: 3, y: 3 }, height: 0 }], DEFINITION, true, shared)!.boxCount).toBeGreaterThan(0);
    const long: CoasterPiece[] = Array.from({ length: 64 }, (_, index) => ({ cell: { x: index % 32, y: index < 32 ? 0 : 1 }, height: 0 }));
    expect(draft.resolve(long, DEFINITION, true, shared)!.boxCount).toBeGreaterThan(64);
  });

  it('screens by armed state', () => {
    const shared = models();
    const draft = new CoasterDraft();
    const pieces = ring(false);
    expect(draft.resolve(pieces, DEFINITION, true, shared)!.coverage).toBe(GHOST_COVERAGE_VALID);
    expect(draft.resolve(pieces, DEFINITION, false, shared)!.coverage).toBe(DRAFT_COVERAGE_PARKED);
  });

  it('does not rebuild when nothing changed, and does when one piece did', () => {
    const shared = models();
    const draft = new CoasterDraft();
    const pieces = ring(false);
    const boxes = draft.resolve(pieces, DEFINITION, true, shared)!.boxes;
    expect(draft.resolve(pieces.map((piece) => ({ ...piece })), DEFINITION, true, shared)!.boxes, 'same content, same array').toBe(boxes);
    pieces[5].height = 1;
    const changed = draft.resolve(pieces, DEFINITION, true, shared)!.boxes;
    expect(changed, 'in-place edit is seen and re-uploaded').not.toBe(boxes);
    pieces[5].special = 'loop';
    expect(draft.resolve(pieces, DEFINITION, true, shared)!.boxes).not.toBe(changed);
  });

  it('is cleared by an empty layout or no definition', () => {
    const shared = models();
    const draft = new CoasterDraft();
    expect(draft.resolve(ring(false), DEFINITION, true, shared)).not.toBeNull();
    expect(draft.resolve([], DEFINITION, true, shared)).toBeNull();
    expect(draft.resolve(ring(false), null, true, shared)).toBeNull();
  });
});

describe('coaster draft in the scene', () => {
  it('sends the draft to the sink once per change, clears it, and resets with the session', () => {
    const { scene, sink, frame } = rig();
    const pieces = ring(false);
    scene.setCoasterDraft(pieces, DEFINITION, true);
    frame();
    scene.setCoasterDraft(pieces, DEFINITION, true);
    frame();
    const [first, again] = sink.drafts;
    expect(again!.boxes, 'identity-stable while unchanged').toBe(first!.boxes);
    scene.setCoasterDraft([], DEFINITION, true);
    frame();
    expect(sink.drafts.at(-1), 'cleared when empty').toBeNull();
    scene.setCoasterDraft(pieces, DEFINITION, true);
    frame();
    expect(sink.drafts.at(-1)).not.toBeNull();
    scene.setSession(new ParkSession(null));
    frame();
    expect(sink.drafts.at(-1), 'a new session forgets the draft').toBeNull();
  });

  it('sends the draft again to a new sink', () => {
    const { scene, frame } = rig();
    scene.setCoasterDraft(ring(false), DEFINITION, false);
    frame();
    const next = new Sink();
    scene.setSink(next);
    frame();
    expect(next.drafts.at(-1)?.coverage).toBe(DRAFT_COVERAGE_PARKED);
  });
});

describe('coaster draft: the parked train', () => {
  const slotsOf = (draft: GhostState): number[] => {
    const slots: number[] = [];
    for (let box = 0; box < draft.boxCount; box += 1) slots.push(draft.boxes[box * BOX_FLOATS + 7]);
    return slots;
  };

  it('stands the cars and their couplings at the end of the station on transform slots, with no riders', () => {
    const shared = models();
    const table = createTransformTable();
    const draft = new CoasterDraft();
    const pieces = ring(false);
    const plain = new CoasterDraft().resolve(pieces, DEFINITION, true, shared)!.boxCount;
    const state = draft.resolve(pieces, DEFINITION, true, shared, table)!;
    const cars = TYPE.trainCars;
    expect(table.highestSlot, `${cars} cars and ${cars - 1} couplings of two halves, no rider slots`).toBe(3 * cars - 2);
    for (let car = 0; car < cars; car += 1) {
      expect(table.slotFor(DRAFT_TRAIN_OBJECT_ID, coasterCarSlotKey(car))).toBeGreaterThan(0);
    }
    expect(table.keyOfSlot(1)?.objectId, 'a negative id never collides with a real object').toBe(DRAFT_TRAIN_OBJECT_ID);
    let expected = 0;
    for (let car = 0; car < cars; car += 1) expected += shared.carFlat(DEFINITION, car).boxCount;
    expected += 2 * (cars - 1) * shared.couplingFlat(DEFINITION).boxCount;
    const slots = slotsOf(state);
    expect(slots.filter((slot) => slot > 0).length, 'exactly the cars and couplings are on slots').toBe(expected);
    expect(state.boxCount, 'track plus train').toBe(plain + expected);
    let riderBoxes = 0;
    for (let car = 0; car < cars; car += 1) riderBoxes += shared.riderFlat(DEFINITION, car).boxCount;
    expect(riderBoxes).toBeGreaterThan(0);
    for (const car of [0, cars - 1]) {
      const slot = table.slotFor(DRAFT_TRAIN_OBJECT_ID, coasterCarSlotKey(car));
      const at = (slot - 1) * 8;
      expect(Math.hypot(...table.data.subarray(at + 4, at + 8)), `car ${car} has a unit quaternion`).toBeCloseTo(1, 5);
    }
    // Parked on the station: the lead car at the end of the third station piece, level.
    const lead = (table.slotFor(DRAFT_TRAIN_OBJECT_ID, coasterCarSlotKey(0)) - 1) * 8;
    expect(table.data[lead], 'lead car near x of the third piece').toBeGreaterThan((pieces[2].cell.x) * 32);
    expect(table.data[lead], 'inside it').toBeLessThan((pieces[2].cell.x + 1) * 32 + 1);
    // The coupling slots exist; rider slots were never allocated.
    expect(table.slotFor(DRAFT_TRAIN_OBJECT_ID, coasterCouplingSlotKey(0, 0))).toBeGreaterThan(0);
    expect(table.slotFor(DRAFT_TRAIN_OBJECT_ID, coasterCouplingSlotKey(cars - 2, 1))).toBeLessThanOrEqual(3 * cars - 2);
    for (let slot = 1; slot <= table.highestSlot; slot += 1) {
      const key = table.keyOfSlot(slot)!.partKey;
      expect(key === coasterRiderSlotKey(0) || key === coasterRiderSlotKey(cars - 1), `slot ${slot} is not a rider part`).toBe(false);
    }
  });

  it('rebuilds only when the layout changes, keeps its slots stable, and frees them on clear or when the layout empties', () => {
    const shared = models();
    const table = createTransformTable();
    const draft = new CoasterDraft();
    const pieces = ring(false);
    const first = draft.resolve(pieces, DEFINITION, true, shared, table)!;
    const boxes = first.boxes;
    const slots = table.highestSlot;
    expect(draft.resolve(pieces, DEFINITION, true, shared, table)!.boxes, 'unchanged: the same boxes').toBe(boxes);
    expect(table.highestSlot).toBe(slots);
    draft.resolve(pieces.slice(0, 12), DEFINITION, true, shared, table);
    expect(table.highestSlot, 'a rebuild re-poses the same slots, no leak').toBe(slots);
    draft.clear();
    expect(table.highestSlot, 'clear frees the slots').toBe(0);
    draft.resolve(pieces, DEFINITION, true, shared, table);
    expect(table.highestSlot).toBe(slots);
    expect(draft.resolve([], DEFINITION, true, shared, table)).toBeNull();
    expect(table.highestSlot, 'an empty layout frees them too').toBe(0);
  });

  it('shows the train on an open draft once its station is drawn, and none before', () => {
    const shared = models();
    const table = createTransformTable();
    const draft = new CoasterDraft();
    const open = ring(true);
    draft.resolve(open.slice(0, 2), DEFINITION, true, shared, table);
    expect(table.highestSlot, 'two pieces: no station yet').toBe(0);
    const state = draft.resolve(open, DEFINITION, true, shared, table)!;
    expect(table.highestSlot).toBe(3 * TYPE.trainCars - 2);
    expect(slotsOf(state).some((slot) => slot > 0)).toBe(true);
  });
});
