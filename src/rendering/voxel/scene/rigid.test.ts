import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../contracts/blueprint';
import { TRANSFORM_CAPACITY, TRANSFORM_FLOATS, TRANSFORM_TEX_WIDTH, TRANSFORM_TEXELS } from '../contracts/boxes';
import { coasterCarSlotKey, restPose } from '../contracts/rigid';
import type { PartPose } from '../contracts/rigid';
import { quarterTurnQuaternion, rotatePointInFootprint, VOXELS_PER_TILE } from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';
import {
  createTransformTable,
  setPoseRotation,
  TRANSFORM_TABLE_ROWS,
  transformRowOf,
  WORLD_POSE_FLOATS,
  writePartTransform,
  writeRotatedPartTransform,
} from './rigid';
import type { TransformTable } from './rigid';

/**
 * Every moving ride part and coaster car is drawn from one transform slot, so two things must
 * hold: the table stays dense and its dirty rows honest (animated parts upload a few 4 KiB rows,
 * parts at rest upload nothing), and the composition puts every voxel where posing the part in
 * model space and then turning the model would put it — otherwise a rotated wheel spins about the
 * wrong axis. The expected positions are computed the long way, point by point, with the contract
 * helpers (rotatePointInFootprint) and the shader's own quaternion rotation (vxQuatRotate).
 */

type Quaternion = readonly [number, number, number, number];
type Vector = readonly [number, number, number];

/** Hamilton product a ⊗ b: rotating by it applies b first. */
const multiply = (a: Quaternion, b: Quaternion): Quaternion => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

const conjugate = (q: Quaternion): Quaternion => [-q[0], -q[1], -q[2], q[3]];

const normalise = (q: Quaternion): Quaternion => {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
};

/** gpu/shaders/common.ts vxQuatRotate, in TypeScript. */
const rotate = (q: Quaternion, v: Vector): Vector => {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]);
  const ty = 2 * (q[2] * v[0] - q[0] * v[2]);
  const tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + (q[1] * tz - q[2] * ty),
    v[1] + q[3] * ty + (q[2] * tx - q[0] * tz),
    v[2] + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
};

/** What a slot holds, read back from the table's texture data. */
const slotRecord = (table: TransformTable, slot: number): { pivot: Vector; spare: number; rotation: Quaternion } => {
  const at = (slot - 1) * TRANSFORM_FLOATS;
  const data = table.data;
  return {
    pivot: [data[at], data[at + 1], data[at + 2]],
    spare: data[at + 3],
    rotation: [data[at + 4], data[at + 5], data[at + 6], data[at + 7]],
  };
};

/** Where the shader draws a part-local point of the slot. */
const drawn = (table: TransformTable, slot: number, local: Vector): Vector => {
  const { pivot, rotation } = slotRecord(table, slot);
  const turned = rotate(rotation, local);
  return [pivot[0] + turned[0], pivot[1] + turned[1], pivot[2] + turned[2]];
};

const expectVector = (actual: Vector, expected: Vector, message: string, digits = 3): void => {
  for (let axis = 0; axis < 3; axis += 1) expect(actual[axis], `${message} (axis ${axis})`).toBeCloseTo(expected[axis], digits);
};

/** Same rotation (q and −q are one rotation). */
const expectSameRotation = (actual: Quaternion, expected: Quaternion, message: string): void => {
  const dot = actual[0] * expected[0] + actual[1] * expected[1] + actual[2] * expected[2] + actual[3] * expected[3];
  expect(Math.abs(dot), message).toBeCloseTo(1, 6);
};

/** A deterministic stream of numbers in [0, 1), so failures reproduce. */
const randomStream = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

const pose = (): PartPose => {
  const out = { dx: 0, dy: 0, dz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  restPose(out);
  return out;
};

const randomPose = (random: () => number): PartPose => {
  const out = pose();
  out.dx = Math.round(random() * 16 - 8);
  out.dy = Math.round(random() * 16 - 8);
  out.dz = Math.round(random() * 16 - 8);
  setPoseRotation(out, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, random() * Math.PI * 4 - Math.PI * 2);
  return out;
};

/** The long way: pose the model-space point about the pivot, then turn the model into the world. */
const posedModelPointInWorld = (
  model: Vector,
  pivot: Vec3,
  part: PartPose,
  origin: Vector,
  quarterTurn: QuarterTurn,
  footprintWidth: number,
): Vector => {
  const local = rotate([part.qx, part.qy, part.qz, part.qw], [model[0] - pivot[0], model[1] - pivot[1], model[2] - pivot[2]]);
  const posedX = pivot[0] + part.dx + local[0];
  const posedY = pivot[1] + part.dy + local[1];
  const posedZ = pivot[2] + part.dz + local[2];
  const turned = rotatePointInFootprint(posedX, posedY, quarterTurn, footprintWidth);
  return [origin[0] + turned.x, origin[1] + turned.y, origin[2] + posedZ];
};

describe('transform table slots', () => {
  it('hands out dense slots from 1, stable per object and part', () => {
    const table = createTransformTable();
    expect(table.highestSlot).toBe(0);
    expect(table.slotFor(10, 1)).toBe(1);
    expect(table.slotFor(10, 2)).toBe(2);
    expect(table.slotFor(11, 1)).toBe(3);
    expect(table.slotFor(10, 1), 'asking again returns the same slot').toBe(1);
    expect(table.slotFor(12, coasterCarSlotKey(0))).toBe(4);
    expect(table.slotFor(12, coasterCarSlotKey(1))).toBe(5);
    expect(table.slotFor(12, 1), 'car keys and part keys of one object never collide').toBe(6);
    expect(table.highestSlot).toBe(6);
  });

  it('reuses the lowest free slots after a release and keeps highestSlot tight', () => {
    const table = createTransformTable();
    const first = [1, 2, 3].map((part) => table.slotFor(1, part));
    const second = [1, 2].map((part) => table.slotFor(2, part));
    const third = table.slotFor(3, 1);
    expect([...first, ...second, third]).toEqual([1, 2, 3, 4, 5, 6]);
    table.releaseObject(2);
    expect(table.highestSlot, 'releasing the middle leaves the top in place').toBe(6);
    expect([1, 2, 3].map((part) => table.slotFor(4, part)), 'holes fill lowest first').toEqual([4, 5, 7]);
    table.releaseObject(4);
    expect(table.highestSlot).toBe(6);
    table.releaseObject(3);
    expect(table.highestSlot, 'releasing the top shrinks to the next live slot').toBe(3);
    table.releaseObject(99);
    expect(table.highestSlot, 'an unknown object is a no-op').toBe(3);
    expect(table.slotFor(1, 2), 'survivors keep their slots').toBe(2);
    table.releaseObject(1);
    expect(table.highestSlot).toBe(0);
    expect(table.slotFor(5, 1)).toBe(1);
  });

  it.each([11, 12, 13, 14])('stays dense and collision-free under random churn (seed %i)', (seed) => {
    const random = randomStream(seed);
    const table = createTransformTable();
    const model = new Map<number, Map<number, number>>();
    const liveSlots = (): Set<number> => new Set([...model.values()].flatMap((parts) => [...parts.values()]));
    let nextObject = 1;
    for (let operation = 0; operation < 600; operation += 1) {
      const ids = [...model.keys()];
      if (ids.length > 0 && random() < 0.4) {
        const id = ids[Math.floor(random() * ids.length)];
        table.releaseObject(id);
        model.delete(id);
      } else {
        const id = random() < 0.2 && ids.length > 0 ? ids[Math.floor(random() * ids.length)] : nextObject;
        if (id === nextObject) nextObject += 1;
        const parts = model.get(id) ?? new Map<number, number>();
        const count = 1 + Math.floor(random() * 8);
        for (let index = 0; index < count; index += 1) {
          const key = random() < 0.2 ? coasterCarSlotKey(index) : 1 + index;
          const live = liveSlots();
          let lowestFree = 1;
          while (live.has(lowestFree)) lowestFree += 1;
          const slot = table.slotFor(id, key);
          const known = parts.get(key);
          if (known !== undefined) expect(slot, 'a known key keeps its slot').toBe(known);
          else expect(slot, `operation ${operation}: a new key gets the lowest free slot`).toBe(lowestFree);
          parts.set(key, slot);
          model.set(id, parts);
        }
      }
      const live = [...liveSlots()];
      expect(new Set(live).size, 'no two keys share a slot').toBe([...model.values()].reduce((sum, parts) => sum + parts.size, 0));
      expect(table.highestSlot, 'highestSlot is the top live slot').toBe(live.length === 0 ? 0 : Math.max(...live));
    }
  });

  it('names the key behind every live slot, so tables with different histories compare equal by key', () => {
    const keys: (readonly [number, number])[] = [[7, 1], [7, 2], [9, coasterCarSlotKey(0)], [9, coasterCarSlotKey(1)], [11, 1]];
    const fresh = createTransformTable();
    for (const [objectId, partKey] of keys) fresh.slotFor(objectId, partKey);
    // The same park reached another way: a ride came and went first, and a hole was filled and freed.
    const churned = createTransformTable();
    for (const part of [1, 2, 3]) churned.slotFor(5, part);
    for (const [objectId, partKey] of keys) churned.slotFor(objectId, partKey);
    churned.releaseObject(5);
    churned.slotFor(12, 1);
    churned.releaseObject(12);
    keys.forEach(([objectId, partKey], index) => {
      for (const table of [fresh, churned]) table.write(table.slotFor(objectId, partKey), index, 2 * index, 3, 0, 0, 0, 1);
    });
    const slotsOf = (table: TransformTable): number[] => keys.map(([objectId, partKey]) => table.slotFor(objectId, partKey));
    expect(slotsOf(churned), 'history decides the slot numbers').not.toEqual(slotsOf(fresh));

    const recordsByKey = (table: TransformTable): Map<string, number[]> => {
      const records = new Map<string, number[]>();
      for (let slot = 1; slot <= table.highestSlot; slot += 1) {
        const key = table.keyOfSlot(slot);
        if (key) records.set(`${key.objectId}:${key.partKey}`, Array.from(table.data.subarray((slot - 1) * TRANSFORM_FLOATS, slot * TRANSFORM_FLOATS)));
      }
      return records;
    };
    expect(recordsByKey(churned), 'but by key the two tables hold the same transforms').toEqual(recordsByKey(fresh));
    for (const [objectId, partKey] of keys) {
      expect(churned.keyOfSlot(churned.slotFor(objectId, partKey)), `key ${objectId}:${partKey}`).toEqual({ objectId, partKey });
    }
    expect([churned.keyOfSlot(1), churned.keyOfSlot(0), churned.keyOfSlot(TRANSFORM_CAPACITY + 1)], 'free or invalid slots').toEqual([null, null, null]);
  });

  it('refuses slots that are not live and runs out loudly at capacity', () => {
    const table = createTransformTable();
    expect(() => table.write(1, 0, 0, 0, 0, 0, 0, 1), 'an unallocated slot').toThrow(RangeError);
    for (let part = 0; part < TRANSFORM_CAPACITY; part += 1) table.slotFor(1, part);
    expect(table.highestSlot).toBe(TRANSFORM_CAPACITY);
    expect(() => table.slotFor(2, 0)).toThrow(RangeError);
    expect(() => table.write(0, 0, 0, 0, 0, 0, 0, 1), 'slot 0 is the static slot').toThrow(RangeError);
    expect(() => table.write(TRANSFORM_CAPACITY + 1, 0, 0, 0, 0, 0, 0, 1)).toThrow(RangeError);
    expect(() => table.write(1.5, 0, 0, 0, 0, 0, 0, 1)).toThrow(RangeError);
    expect(table.write(TRANSFORM_CAPACITY, 1, 2, 3, 0, 0, 0, 1)).toBe(true);
  });

  it('reset frees every slot and zeroes the records', () => {
    const table = createTransformTable();
    for (let part = 0; part < 300; part += 1) table.write(table.slotFor(7, part), part, 1, 2, 0, 0, 0, 1);
    table.clearDirty();
    table.reset();
    expect(table.highestSlot).toBe(0);
    expect(table.data.every((value) => value === 0), 'reset leaves no stale transform').toBe(true);
    expect([table.dirtyRowStart, table.dirtyRowEnd], 'the zeroed rows must reach the GPU').toEqual([0, transformRowOf(300) + 1]);
    expect(table.slotFor(8, 1)).toBe(1);
    expect(() => table.write(2, 0, 0, 0, 0, 0, 0, 1), 'old slots died with the reset').toThrow(RangeError);
  });
});

describe('transform table layout and dirty rows', () => {
  it('writes pivot and quaternion into the transform layout at (slot − 1) · TRANSFORM_FLOATS', () => {
    const table = createTransformTable();
    for (let part = 0; part < 4; part += 1) table.slotFor(1, part);
    expect(table.data.length).toBe(TRANSFORM_CAPACITY * TRANSFORM_FLOATS);
    expect(table.data.length % (TRANSFORM_TEX_WIDTH * 4), 'whole texture rows').toBe(0);
    expect(table.write(3, 101.5, -7, 44, 0.5, -0.5, 0.5, 0.5)).toBe(true);
    expect(Array.from(table.data.subarray(2 * TRANSFORM_FLOATS, 3 * TRANSFORM_FLOATS))).toEqual([101.5, -7, 44, 0, 0.5, -0.5, 0.5, 0.5]);
    expect(Array.from(table.data.subarray(0, 2 * TRANSFORM_FLOATS)).every((value) => value === 0), 'neighbours untouched').toBe(true);
    expect(Array.from(table.data.subarray(3 * TRANSFORM_FLOATS, 4 * TRANSFORM_FLOATS)).every((value) => value === 0)).toBe(true);
  });

  it('maps slots onto 256-texel rows, two texels per slot', () => {
    const slotsPerRow = TRANSFORM_TEX_WIDTH / TRANSFORM_TEXELS;
    expect(TRANSFORM_TABLE_ROWS).toBe((TRANSFORM_CAPACITY * TRANSFORM_TEXELS) / TRANSFORM_TEX_WIDTH);
    expect(transformRowOf(1)).toBe(0);
    expect(transformRowOf(slotsPerRow)).toBe(0);
    expect(transformRowOf(slotsPerRow + 1)).toBe(1);
    expect(transformRowOf(TRANSFORM_CAPACITY)).toBe(TRANSFORM_TABLE_ROWS - 1);
  });

  it('tracks the dirty rows and leaves them clean for a write that changes nothing', () => {
    const slotsPerRow = TRANSFORM_TEX_WIDTH / TRANSFORM_TEXELS;
    const table = createTransformTable();
    for (let part = 0; part < 3 * slotsPerRow; part += 1) table.slotFor(1, part);
    expect(table.dirtyRowStart, 'allocating writes nothing').toBe(table.dirtyRowEnd);

    expect(table.write(1, 1, 2, 3, 0, 0, 0, 1)).toBe(true);
    expect([table.dirtyRowStart, table.dirtyRowEnd]).toEqual([0, 1]);
    table.write(2 * slotsPerRow + 5, 1, 2, 3, 0, 0, 0, 1);
    expect([table.dirtyRowStart, table.dirtyRowEnd], 'the range spans both rows').toEqual([0, 3]);
    table.clearDirty();
    expect(table.dirtyRowStart).toBe(table.dirtyRowEnd);

    expect(table.write(1, 1, 2, 3, 0, 0, 0, 1), 'same values').toBe(false);
    expect(table.write(2 * slotsPerRow + 5, 1, 2, 3, 0, 0, 0, 1)).toBe(false);
    expect(table.dirtyRowStart, 'a ride at rest uploads nothing').toBe(table.dirtyRowEnd);
    // Values are compared as stored (float32), so re-writing an unrepresentable double is a no-op.
    expect(table.write(slotsPerRow + 1, 0.1, 0.2, 0.3, 0, 0, Math.SQRT1_2, Math.SQRT1_2)).toBe(true);
    table.clearDirty();
    expect(table.write(slotsPerRow + 1, 0.1, 0.2, 0.3, 0, 0, Math.SQRT1_2, Math.SQRT1_2)).toBe(false);
    expect(table.dirtyRowStart).toBe(table.dirtyRowEnd);

    table.write(slotsPerRow + 1, 0.1, 0.2, 0.3, 0, 0, 0, 1);
    expect([table.dirtyRowStart, table.dirtyRowEnd], 'only the changed slot’s row').toEqual([1, 2]);
    table.clearDirty();
    table.releaseObject(1);
    expect([table.dirtyRowStart, table.dirtyRowEnd], 'released slots are zeroed, so their rows re-upload').toEqual([0, 3]);
    expect(table.data.every((value) => value === 0)).toBe(true);
  });

  it('copies a world pose from a typed array at an offset exactly as write stores the same numbers', () => {
    const random = randomStream(21);
    const byWrite = createTransformTable();
    const byCopy = createTransformTable();
    for (let part = 0; part < 300; part += 1) {
      byWrite.slotFor(1, part);
      byCopy.slotFor(1, part);
    }
    expect(WORLD_POSE_FLOATS, 'pivot xyz + quaternion xyzw').toBe(7);
    const wide = new Float64Array(40);
    const narrow = new Float32Array(40);
    for (let sample = 0; sample < 200; sample += 1) {
      const slot = 1 + Math.floor(random() * 300);
      const offset = Math.floor(random() * (40 - WORLD_POSE_FLOATS));
      const source = sample % 2 === 0 ? wide : narrow;
      for (let index = 0; index < WORLD_POSE_FLOATS; index += 1) source[offset + index] = random() * 2_000 - 1_000;
      byWrite.write(slot, source[offset], source[offset + 1], source[offset + 2], source[offset + 3], source[offset + 4], source[offset + 5], source[offset + 6]);
      expect(byCopy.writeFrom(slot, source, offset), `sample ${sample} changes the slot`).toBe(true);
      expect(byCopy.writeFrom(slot, source, offset), `sample ${sample} again: nothing to upload`).toBe(false);
      expect([byCopy.dirtyRowStart, byCopy.dirtyRowEnd]).toEqual([byWrite.dirtyRowStart, byWrite.dirtyRowEnd]);
    }
    expect(Array.from(byCopy.data), 'identical texture contents').toEqual(Array.from(byWrite.data));
    expect(() => byCopy.writeFrom(301, wide, 0), 'an unallocated slot').toThrow(RangeError);
  });
});

describe('part transform composition', () => {
  it.each([0, 1] as QuarterTurn[])('places the pivot where rotatePointInFootprint puts the posed pivot (quarter turn %i)', (quarterTurn) => {
    const random = randomStream(100 + quarterTurn);
    const table = createTransformTable();
    const slot = table.slotFor(1, 1);
    for (let sample = 0; sample < 200; sample += 1) {
      const footprintWidth = VOXELS_PER_TILE * (1 + Math.floor(random() * 4));
      const origin: Vector = [Math.floor(random() * 32) * 32, Math.floor(random() * 32) * 32, Math.floor(random() * 3)];
      const pivot: Vec3 = [Math.floor(random() * footprintWidth), Math.floor(random() * 96), Math.floor(random() * 60)];
      const part = randomPose(random);
      writePartTransform(table, slot, origin[0], origin[1], origin[2], quarterTurn, footprintWidth, pivot, part);
      const record = slotRecord(table, slot);
      const expected = rotatePointInFootprint(pivot[0] + part.dx, pivot[1] + part.dy, quarterTurn, footprintWidth);
      expectVector(record.pivot, [origin[0] + expected.x, origin[1] + expected.y, origin[2] + pivot[2] + part.dz], `pivot ${sample}`);
      expect(record.spare).toBe(0);
      const expectedRotation = normalise(multiply(quarterTurnQuaternion(quarterTurn), [part.qx, part.qy, part.qz, part.qw]));
      for (let component = 0; component < 4; component += 1) {
        expect(record.rotation[component], `rotation ${sample}`).toBeCloseTo(expectedRotation[component], 6);
      }
      expect(Math.hypot(...record.rotation), 'unit quaternion').toBeCloseTo(1, 6);
    }
  });

  it.each([0, 1] as QuarterTurn[])('moves every voxel as posing it in model space and then turning the model (quarter turn %i)', (quarterTurn) => {
    const random = randomStream(200 + quarterTurn);
    const table = createTransformTable();
    const slot = table.slotFor(1, 1);
    const footprintWidth = 4 * VOXELS_PER_TILE;
    const origin: Vector = [320, 96, 0];
    for (let sample = 0; sample < 100; sample += 1) {
      const pivot: Vec3 = [Math.floor(random() * footprintWidth), Math.floor(random() * 96), 20 + Math.floor(random() * 40)];
      const part = randomPose(random);
      writePartTransform(table, slot, origin[0], origin[1], origin[2], quarterTurn, footprintWidth, pivot, part);
      for (let point = 0; point < 8; point += 1) {
        const model: Vector = [Math.floor(random() * footprintWidth), Math.floor(random() * 96), Math.floor(random() * 90)];
        const local: Vector = [model[0] - pivot[0], model[1] - pivot[1], model[2] - pivot[2]];
        expectVector(
          drawn(table, slot, local),
          posedModelPointInWorld(model, pivot, part, origin, quarterTurn, footprintWidth),
          `sample ${sample} point ${point}`,
        );
      }
    }
  });

  it('rests a part inside the turned footprint with the plain quarter-turn orientation', () => {
    const table = createTransformTable();
    const slot = table.slotFor(1, 1);
    const pivot: Vec3 = [70, 20, 34];
    const width = 4 * VOXELS_PER_TILE;
    writePartTransform(table, slot, 64, 32, 0, 1, width, pivot, pose());
    const record = slotRecord(table, slot);
    expect(record.pivot).toEqual([64 + 20, 32 + width - 70, 34]);
    expectSameRotation(record.rotation, quarterTurnQuaternion(1), 'rest orientation is the quarter turn');
    // The model's front (+y) must face world +x after the turn, as for static boxes.
    expectVector(rotate(record.rotation, [0, 1, 0]), [1, 0, 0], 'model +y → world +x', 6);
  });

  it('turns a part rotating about model x about the world axis model x maps to', () => {
    const table = createTransformTable();
    const pivot: Vec3 = [64, 48, 40];
    const width = 4 * VOXELS_PER_TILE;
    const part = pose();
    setPoseRotation(part, 1, 0, 0, Math.PI / 2);
    for (const quarterTurn of [0, 1] as QuarterTurn[]) {
      const slot = table.slotFor(2, quarterTurn + 1);
      writePartTransform(table, slot, 0, 0, 0, quarterTurn, width, pivot, part);
      const record = slotRecord(table, slot);
      // q = 0: model +x is world +x; q = 1: (x, y) → (y, −x) sends it to world −y.
      const axis: Vector = quarterTurn === 0 ? [1, 0, 0] : [0, -1, 0];
      const worldTurn = multiply(record.rotation, conjugate(quarterTurnQuaternion(quarterTurn)));
      expectSameRotation(worldTurn, [axis[0] * Math.SQRT1_2, axis[1] * Math.SQRT1_2, axis[2] * Math.SQRT1_2, Math.SQRT1_2], `world rotation for q ${quarterTurn}`);
      // Points on the axle stay put; a spoke above the pivot swings a quarter turn about it.
      const onAxle = drawn(table, slot, [9, 0, 0]);
      const restAxle = posedModelPointInWorld([pivot[0] + 9, pivot[1], pivot[2]], pivot, pose(), [0, 0, 0], quarterTurn, width);
      expectVector(onAxle, restAxle, `axle point for q ${quarterTurn}`);
      const spoke = drawn(table, slot, [0, 0, 5]);
      const expectedSpoke: Vector = quarterTurn === 0
        ? [record.pivot[0], record.pivot[1] - 5, record.pivot[2]]
        : [record.pivot[0] - 5, record.pivot[1], record.pivot[2]];
      expectVector(spoke, expectedSpoke, `spoke for q ${quarterTurn}`);
    }
  });

  it('normalises the orientation and treats a degenerate pose rotation as the identity', () => {
    const table = createTransformTable();
    const slot = table.slotFor(1, 1);
    const part = pose();
    part.qx = 0;
    part.qy = 0;
    part.qz = 3;
    part.qw = 3;
    writePartTransform(table, slot, 0, 0, 0, 1, 64, [0, 0, 0], part);
    expect(Math.hypot(...slotRecord(table, slot).rotation)).toBeCloseTo(1, 6);
    for (const broken of [[0, 0, 0, 0], [Number.NaN, 0, 0, 1], [Number.POSITIVE_INFINITY, 0, 0, 1]]) {
      [part.qx, part.qy, part.qz, part.qw] = broken;
      writePartTransform(table, slot, 0, 0, 0, 1, 64, [0, 0, 0], part);
      expectSameRotation(slotRecord(table, slot).rotation, quarterTurnQuaternion(1), `pose rotation ${broken.join(', ')}`);
      writeRotatedPartTransform(table, slot, 0, 0, 0, 1, [0, 0, 0], part);
      expectSameRotation(slotRecord(table, slot).rotation, [0, 0, 0, 1], `turned boxes, pose rotation ${broken.join(', ')}`);
    }
  });

  it.each([0, 1] as QuarterTurn[])('lands boxes already turned by rotateModel on the same voxels via writeRotatedPartTransform (quarter turn %i)', (quarterTurn) => {
    const random = randomStream(300 + quarterTurn);
    const table = createTransformTable();
    const unturned = table.slotFor(1, 1);
    const turned = table.slotFor(1, 2);
    const width = 3 * VOXELS_PER_TILE;
    for (let sample = 0; sample < 100; sample += 1) {
      const pivot: Vec3 = [Math.floor(random() * width), Math.floor(random() * 64), Math.floor(random() * 50)];
      const part = sample === 0 ? pose() : randomPose(random);
      const turnedPivot = rotatePointInFootprint(pivot[0], pivot[1], quarterTurn, width);
      writePartTransform(table, unturned, 96, 160, 0, quarterTurn, width, pivot, part);
      writeRotatedPartTransform(table, turned, 96, 160, 0, quarterTurn, [turnedPivot.x, turnedPivot.y, pivot[2]], part);
      if (sample === 0) expectSameRotation(slotRecord(table, turned).rotation, [0, 0, 0, 1], 'turned boxes rest at the identity');
      for (let point = 0; point < 8; point += 1) {
        const local: Vector = [random() * 40 - 20, random() * 40 - 20, random() * 40 - 20];
        // rotateModel turns pivot-relative boxes by the linear part of the quarter turn.
        const turnedLocal: Vector = quarterTurn === 0 ? local : [local[1], -local[0], local[2]];
        expectVector(drawn(table, turned, turnedLocal), drawn(table, unturned, local), `sample ${sample} point ${point}`);
      }
    }
  });
});

describe('pose rotation helper', () => {
  it('follows the right-hand rule, normalises the axis and keeps the offset', () => {
    const part = pose();
    part.dx = 3;
    setPoseRotation(part, 0, 0, 5, Math.PI / 2);
    expectVector(rotate([part.qx, part.qy, part.qz, part.qw], [1, 0, 0]), [0, 1, 0], '+x about +z → +y', 9);
    expect(Math.hypot(part.qx, part.qy, part.qz, part.qw)).toBeCloseTo(1, 12);
    expect(part.dx).toBe(3);
    setPoseRotation(part, 0, 0, 0, 1);
    expect([part.qx, part.qy, part.qz, part.qw], 'a zero axis is the identity').toEqual([0, 0, 0, 1]);
  });
});
