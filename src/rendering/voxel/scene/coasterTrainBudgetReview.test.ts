import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { coasterBaseCost, deriveCoasterStats } from '../../../game/coaster/design';
import type { CoasterPiece } from '../../../game/coaster/design';
import { layoutFromMoves, longestLayout, loopOvalLayout, ovalLayout } from '../../../game/coaster/testLayouts';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { ParkSession } from '../../../game/session/ParkSession';
import { createModelCache } from '../blueprint/compile';
import { TRANSFORM_CAPACITY, TRANSFORM_FLOATS } from '../contracts/boxes';
import type { VoxelGpuSink } from '../contracts/frame';
import { coasterCarSlotKey, coasterCouplingSlotKey, coasterRiderSlotKey } from '../contracts/rigid';
import { buildPalette } from '../palette';
import { DRAFT_TRAIN_OBJECT_ID } from './coasterDraft';
import type { TransformTable } from './rigid';
import { VoxelScene } from './VoxelScene';

/**
 * Adversarial review, Phase 27 step 3 (gameplay and budget): the train's rigid parts (cars, riders,
 * couplings) live in transform slots. Status flips must swap riders by pose only (no chunk rebuild,
 * no change in the transform record count), a parked train must dirty nothing, slot keys must stay
 * unique, the draft's slots must be freed, and a map packed with coasters must fit the table.
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

class RecordingSink implements VoxelGpuSink {
  chunks: number[] = [];
  transforms: Array<{ count: number; start: number; end: number }> = [];
  setChunk(index: number): void { this.chunks.push(index); }
  setDynamic(texture: string, _data: Float32Array, count: number, start: number, end: number): void {
    if (texture === 'transforms') this.transforms.push({ count, start, end });
  }
  setFigureRanges(): void {}
  setGhost(): void {}
  setDraft(): void {}
}

const tableOf = (scene: VoxelScene): TransformTable => (scene as unknown as { transforms: TransformTable }).transforms;

const quaternionOf = (table: TransformTable, slot: number): number[] => {
  const at = (slot - 1) * TRANSFORM_FLOATS;
  return [table.data[at + 4], table.data[at + 5], table.data[at + 6], table.data[at + 7]];
};

const setUp = (): { session: ParkSession; scene: VoxelScene; sink: RecordingSink; frame: (fraction?: number) => void } => {
  const session = new ParkSession(null);
  session.world.setBuildAccessPolicy(null);
  session.world.addMoney(500_000_000, 'test');
  const sink = new RecordingSink();
  const scene = new VoxelScene(session, PALETTE, createModelCache(), { sink, prewarmBudgetMs: 0 });
  session.world.subscribe(() => scene.syncWorld());
  let clock = 0;
  const frame = (fraction = 0.5): void => {
    clock += 16;
    scene.update(16, clock, fraction);
  };
  frame();
  return { session, scene, sink, frame };
};

const place = (session: ParkSession, id: string, pieces: CoasterPiece[]): number | null => {
  const type = COASTER_TYPE_BY_ID.get(id)!;
  const placed = session.world.placeCoaster(id, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
  if ('error' in placed) return null;
  session.syncWithWorld();
  return placed.id;
};

describe('coaster train slots and status flips (review)', () => {
  it('swaps riders by pose only: status and rider-count flips over 3 types rebuild nothing and keep the record count', () => {
    const { session, scene, sink, frame } = setUp();
    expect(place(session, 'skyline-serpent', longestLayout({ x: 2, y: 2 }))).not.toBeNull();
    expect(place(session, 'star-chaser', ovalLayout({ x: 18, y: 25 }))).not.toBeNull();
    expect(place(session, 'comet-trail', ovalLayout({ x: 18, y: 2 }))).not.toBeNull();
    frame();
    frame();
    const table = tableOf(scene);
    const coasters = [...session.world.coasters.values()].map((record) => ({
      record,
      runtime: session.rides.getRide(record.objectId)!,
      type: COASTER_TYPE_BY_ID.get(session.world.objects.get(record.objectId)!.definitionId)!,
    }));
    // A train is cars + riders + couplings of two halves.
    for (const { record, type } of coasters) {
      let slots = 0;
      for (let slot = 1; slot <= table.highestSlot; slot += 1) if (table.keyOfSlot(slot)?.objectId === record.objectId) slots += 1;
      expect(slots, type.definitionId).toBe(4 * type.trainCars - 2);
    }
    const statuses = ['running', 'waiting', 'running', 'idle', 'broken', 'running', 'maintenance', 'closed'] as const;
    const riderLists = [[1], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], []];
    sink.chunks = [];
    sink.transforms = [];
    const counts = new Set<number>();
    for (let index = 0; index < 2_000; index += 1) {
      const status = statuses[Math.floor(index / 23) % statuses.length];
      const riders = riderLists[Math.floor(index / 41) % riderLists.length];
      for (const { record, runtime } of coasters) {
        runtime.status = status;
        runtime.riderGuestIds = riders;
        runtime.cycleRemainingSeconds = Math.max(0.2, record.stats.durationSeconds - 0.016 * (index % 500));
      }
      frame((index % 10) / 10);
      expect(scene.stats.chunksRebuilt).toBe(0);
      for (const call of sink.transforms) counts.add(call.count);
      sink.transforms = [];
      // Riders are shown exactly on running trains with someone aboard; otherwise collapsed.
      for (const { record, type } of coasters) {
        const showing = status === 'running' && riders.length > 0;
        const rider = quaternionOf(table, table.slotFor(record.objectId, coasterRiderSlotKey(0)));
        const car = quaternionOf(table, table.slotFor(record.objectId, coasterCarSlotKey(0)));
        if (showing) expect(rider).toEqual(car);
        else expect(rider).toEqual([0.5, 0.5, 0, 0]);
        const last = quaternionOf(table, table.slotFor(record.objectId, coasterRiderSlotKey(type.trainCars - 1)));
        if (!showing) expect(last).toEqual([0.5, 0.5, 0, 0]);
      }
    }
    expect(sink.chunks, 'no chunk sent').toEqual([]);
    expect(counts.size, 'the transform record count never changes').toBeLessThanOrEqual(1);
  });

  it('a parked train, and a running train while paused, stage no transform rows', () => {
    const { session, scene, sink, frame } = setUp();
    expect(place(session, 'skyline-serpent', loopOvalLayout({ x: 4, y: 4 }))).not.toBeNull();
    frame();
    frame();
    sink.transforms = [];
    for (let index = 0; index < 300; index += 1) frame(0.5);
    expect(sink.transforms.filter((call) => call.end > call.start)).toEqual([]);
    const [record] = session.world.coasters.values();
    const runtime = session.rides.getRide(record.objectId)!;
    runtime.status = 'running';
    runtime.riderGuestIds = [1, 2];
    runtime.cycleRemainingSeconds = 5;
    frame(0.5);
    sink.transforms = [];
    // Paused: the cycle does not move and the step fraction is frozen.
    for (let index = 0; index < 300; index += 1) frame(0.5);
    expect(sink.transforms.filter((call) => call.end > call.start)).toEqual([]);
    expect(scene.stats.chunksRebuilt).toBe(0);
  });

  it('keeps slot keys unique and fits a map packed with minimum-length serpents plus a draft; the draft frees its slots', () => {
    const { session, scene, frame } = setUp();
    let placed = 0;
    for (let y = 0; y + 2 < 32; y += 3) {
      for (let x = 0; x + 4 < 32; x += 5) {
        const pieces = layoutFromMoves({ x, y }, 'EEEESSWWWWNN', [0, 0, 0, 1, 2, 2, 1, 0, 0, 0, 0, 0]);
        if (place(session, 'skyline-serpent', pieces) !== null) placed += 1;
      }
    }
    expect(placed).toBeGreaterThan(40);
    scene.setCoasterDraft(ovalLayout({ x: 1, y: 1 }).slice(0, 12), BUILD_BY_ID.get('skyline-serpent')!, true);
    frame();
    frame();
    const table = tableOf(scene);
    const seen = new Set<string>();
    let draftSlots = 0;
    for (let slot = 1; slot <= table.highestSlot; slot += 1) {
      const key = table.keyOfSlot(slot);
      if (!key) continue;
      const id = `${key.objectId}:${key.partKey}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
      if (key.objectId === DRAFT_TRAIN_OBJECT_ID) draftSlots += 1;
    }
    const serpent = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
    expect(draftSlots, 'the draft train: cars and couplings of two halves, no riders').toBe(3 * serpent.trainCars - 2);
    expect(table.highestSlot).toBeLessThanOrEqual(TRANSFORM_CAPACITY / 2);
    const keys = new Set<number>();
    for (let car = 0; car < 50; car += 1) {
      for (const key of [coasterCarSlotKey(car), coasterRiderSlotKey(car), coasterCouplingSlotKey(car, 0), coasterCouplingSlotKey(car, 1)]) {
        expect(keys.has(key), `key ${key} of car ${car}`).toBe(false);
        keys.add(key);
      }
    }
    scene.setCoasterDraft([], null, true);
    frame();
    for (let slot = 1; slot <= table.highestSlot; slot += 1) expect(table.keyOfSlot(slot)?.objectId).not.toBe(DRAFT_TRAIN_OBJECT_ID);
  });
});
