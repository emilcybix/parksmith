import type { Vec3 } from '../contracts/blueprint';
import { TRANSFORM_CAPACITY, TRANSFORM_FLOATS, TRANSFORM_TEXELS, TRANSFORM_TEX_WIDTH } from '../contracts/boxes';
import type { PartPose } from '../contracts/rigid';
import { quarterTurnQuaternion, type SingleTurn } from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';

/**
 * Transform slots for rigid parts and coaster cars (contracts/boxes.ts transform layout,
 * contracts/rigid.ts composition).
 *
 * A moving part never re-uploads its boxes: its compiled boxes carry a slot, and each frame only
 * the slot's pivot and quaternion change — 32 bytes per part in a 256-texel-wide texture whose
 * dirty rows are the only thing uploaded. Slots are dense (lowest free first), so a park's
 * animated parts share the first few 4 KiB rows, and a write that changes nothing (a ride at
 * rest) leaves its row clean.
 *
 * Which composition to call depends on the boxes the slot is drawn with:
 * - boxes from `rotateModel(model, q)` / `ModelCache.model(blueprint, q)`, whose moving parts are
 *   already turned about their (turned) pivots → `writeRotatedPartTransform` with that model's
 *   part pivot; the rest pose is then exactly the identity, so a closed ride's parts land on the
 *   same integer voxels as its static body;
 * - pivot-relative boxes of the unrotated model (quarter turn 0) → `writePartTransform`, the
 *   contracts/rigid.ts formula, with the model-space pivot.
 * Coaster cars are posed in world voxels already and go straight to `writeFrom`
 * (coasterCars.ts `writeCoasterCarTransforms`).
 */
export interface TransformTable {
  /** TRANSFORM_FLOATS per slot, slot k at offset (k − 1) · TRANSFORM_FLOATS; whole texture rows. */
  readonly data: Float32Array;
  /**
   * Dense slot (lowest free, starting at 1) for (objectId, partKey); stable until released.
   * Allocation-free when the key already has a slot. Throws a RangeError once all
   * TRANSFORM_CAPACITY slots are taken (a budget failure, not something to render around).
   */
  slotFor(objectId: number, partKey: number): number;
  /**
   * The key a live slot was handed out for, or null for a free slot. Which slot a key gets depends
   * on the order objects came and went, so scene-equivalence checks (an incrementally maintained
   * scene against one built from scratch) compare slots through their keys, never their numbers.
   * Allocates its result: for tests and diagnostics, not per frame.
   */
  keyOfSlot(slot: number): { objectId: number; partKey: number } | null;
  /** Frees every slot of the object (zeroed, rows marked dirty). Unknown ids are a no-op. */
  releaseObject(objectId: number): void;
  /** Frees every slot (session swap); the next slot handed out is 1 again. */
  reset(): void;
  /**
   * Stores a world pivot and unit quaternion into a live slot; true when anything changed. An
   * unchanged write (a ride at rest, a parked train) leaves the dirty rows untouched. Throws a
   * RangeError for a slot that is not live.
   */
  write(slot: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): boolean;
  /**
   * `write` with the seven numbers read from `source[offset … offset + 6]` (WORLD_POSE_FLOATS:
   * pivot x, y, z, then quaternion x, y, z, w — the CoasterCarPoses layout). Per-frame code should
   * prefer it: no number crosses the call, so it never allocates, whereas V8 boxes each non-integer
   * argument of `write` into a heap number wherever it does not inline the call.
   */
  writeFrom(slot: number, source: Float32Array | Float64Array, offset: number): boolean;
  /** Highest slot in use (0 when none): the live record count for the sink's `setDynamic`. */
  readonly highestSlot: number;
  /** Dirty texel rows (TRANSFORM_TEX_WIDTH wide) since clearDirty(); start === end when clean. */
  readonly dirtyRowStart: number;
  readonly dirtyRowEnd: number;
  clearDirty(): void;
}

/** A world pose as `writeFrom` reads it: pivot x, y, z, then unit quaternion x, y, z, w. */
export const WORLD_POSE_FLOATS = 7;

/** Texel row of the transform texture holding `slot` (a slot's two texels share one row). */
export const transformRowOf = (slot: number): number =>
  Math.floor(((slot - 1) * TRANSFORM_TEXELS) / TRANSFORM_TEX_WIDTH);

/** Rows the whole table spans (the transform texture's height). */
export const TRANSFORM_TABLE_ROWS = (TRANSFORM_CAPACITY * TRANSFORM_TEXELS) / TRANSFORM_TEX_WIDTH;

class DenseTransformTable implements TransformTable {
  readonly data = new Float32Array(TRANSFORM_CAPACITY * TRANSFORM_FLOATS);
  /** 1 where the slot (1-based, index 0 unused) is live. */
  private readonly live = new Uint8Array(TRANSFORM_CAPACITY + 1);
  /** The (objectId, partKey) each live slot belongs to. */
  private readonly slotObjects = new Float64Array(TRANSFORM_CAPACITY + 1);
  private readonly slotPartKeys = new Float64Array(TRANSFORM_CAPACITY + 1);
  private readonly slotsByObject = new Map<number, Map<number, number>>();
  /** `write`'s arguments, staged so both entry points share one compare-and-store. */
  private readonly staged = new Float64Array(WORLD_POSE_FLOATS);
  /** No slot below this is free, so allocation scans from here. */
  private lowestCandidate = 1;
  private highest = 0;
  private rowStart = 0;
  private rowEnd = 0;

  get highestSlot(): number {
    return this.highest;
  }

  get dirtyRowStart(): number {
    return this.rowStart;
  }

  get dirtyRowEnd(): number {
    return this.rowEnd;
  }

  slotFor(objectId: number, partKey: number): number {
    let parts = this.slotsByObject.get(objectId);
    const existing = parts?.get(partKey);
    if (existing !== undefined) return existing;
    const slot = this.allocate();
    if (!parts) {
      parts = new Map();
      this.slotsByObject.set(objectId, parts);
    }
    parts.set(partKey, slot);
    this.slotObjects[slot] = objectId;
    this.slotPartKeys[slot] = partKey;
    return slot;
  }

  keyOfSlot(slot: number): { objectId: number; partKey: number } | null {
    if (!(slot >= 1 && slot <= TRANSFORM_CAPACITY && this.live[slot] === 1)) return null;
    return { objectId: this.slotObjects[slot], partKey: this.slotPartKeys[slot] };
  }

  releaseObject(objectId: number): void {
    const parts = this.slotsByObject.get(objectId);
    if (!parts) return;
    for (const slot of parts.values()) this.release(slot);
    this.slotsByObject.delete(objectId);
  }

  reset(): void {
    if (this.highest > 0) {
      this.data.fill(0, 0, this.highest * TRANSFORM_FLOATS);
      this.markRows(0, transformRowOf(this.highest) + 1);
    }
    this.live.fill(0);
    this.slotsByObject.clear();
    this.lowestCandidate = 1;
    this.highest = 0;
  }

  write(slot: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): boolean {
    const staged = this.staged;
    staged[0] = px;
    staged[1] = py;
    staged[2] = pz;
    staged[3] = qx;
    staged[4] = qy;
    staged[5] = qz;
    staged[6] = qw;
    return this.writeFrom(slot, staged, 0);
  }

  writeFrom(slot: number, source: Float32Array | Float64Array, offset: number): boolean {
    if (!(slot >= 1 && slot <= TRANSFORM_CAPACITY && this.live[slot] === 1)) {
      throw new RangeError(`transform slot ${slot} is not live`);
    }
    // Compared as stored (float32), so re-writing a double the texture cannot hold is a no-op.
    const px = Math.fround(source[offset]);
    const py = Math.fround(source[offset + 1]);
    const pz = Math.fround(source[offset + 2]);
    const qx = Math.fround(source[offset + 3]);
    const qy = Math.fround(source[offset + 4]);
    const qz = Math.fround(source[offset + 5]);
    const qw = Math.fround(source[offset + 6]);
    const data = this.data;
    const at = (slot - 1) * TRANSFORM_FLOATS;
    if (
      data[at] === px && data[at + 1] === py && data[at + 2] === pz
      && data[at + 4] === qx && data[at + 5] === qy && data[at + 6] === qz && data[at + 7] === qw
    ) {
      return false;
    }
    data[at] = px;
    data[at + 1] = py;
    data[at + 2] = pz;
    data[at + 3] = 0;
    data[at + 4] = qx;
    data[at + 5] = qy;
    data[at + 6] = qz;
    data[at + 7] = qw;
    const row = transformRowOf(slot);
    this.markRows(row, row + 1);
    return true;
  }

  clearDirty(): void {
    this.rowStart = 0;
    this.rowEnd = 0;
  }

  private allocate(): number {
    let slot = this.lowestCandidate;
    while (slot <= TRANSFORM_CAPACITY && this.live[slot] === 1) slot += 1;
    if (slot > TRANSFORM_CAPACITY) {
      throw new RangeError(`all ${TRANSFORM_CAPACITY} transform slots are in use`);
    }
    this.live[slot] = 1;
    this.lowestCandidate = slot + 1;
    if (slot > this.highest) this.highest = slot;
    return slot;
  }

  /**
   * Zeroes the record, so a freed slot never shows a stale transform and every record's contents
   * depend only on the live key that owns it (which slot that is still depends on history; see
   * keyOfSlot).
   */
  private release(slot: number): void {
    this.live[slot] = 0;
    this.data.fill(0, (slot - 1) * TRANSFORM_FLOATS, slot * TRANSFORM_FLOATS);
    const row = transformRowOf(slot);
    this.markRows(row, row + 1);
    if (slot < this.lowestCandidate) this.lowestCandidate = slot;
    while (this.highest > 0 && this.live[this.highest] === 0) this.highest -= 1;
  }

  private markRows(start: number, end: number): void {
    if (this.rowStart === this.rowEnd) {
      this.rowStart = start;
      this.rowEnd = end;
      return;
    }
    if (start < this.rowStart) this.rowStart = start;
    if (end > this.rowEnd) this.rowEnd = end;
  }
}

export const createTransformTable = (): TransformTable => new DenseTransformTable();

/** quarterTurnQuaternion per turn, computed once so composing a pose allocates nothing. */
const QUARTER_TURN_ROTATIONS: readonly (readonly [number, number, number, number])[] = [
  quarterTurnQuaternion(0),
  quarterTurnQuaternion(1),
  quarterTurnQuaternion(2),
  quarterTurnQuaternion(3),
];

/** Below this a pose quaternion carries no usable rotation (a driver bug); the part stays at rest. */
const MIN_QUATERNION_LENGTH = 1e-9;

/**
 * The composed world pose, handed to `writeFrom` so no computed number crosses a call (see
 * TransformTable.writeFrom); the compositions below run once per moving part per frame.
 */
const COMPOSED = new Float64Array(WORLD_POSE_FLOATS);

/**
 * Normalises the quaternion staged in COMPOSED[3 … 6], or replaces it with (fx, fy, fz, fw) when it
 * has no usable length (zero, NaN or infinite components).
 */
const normaliseComposedRotation = (fallback: readonly [number, number, number, number]): void => {
  const qx = COMPOSED[3];
  const qy = COMPOSED[4];
  const qz = COMPOSED[5];
  const qw = COMPOSED[6];
  const length = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  if (!(length > MIN_QUATERNION_LENGTH && length < Number.POSITIVE_INFINITY)) {
    COMPOSED[3] = fallback[0];
    COMPOSED[4] = fallback[1];
    COMPOSED[5] = fallback[2];
    COMPOSED[6] = fallback[3];
    return;
  }
  COMPOSED[3] = qx / length;
  COMPOSED[4] = qy / length;
  COMPOSED[5] = qz / length;
  COMPOSED[6] = qw / length;
};

/**
 * Composes a part's model-space pose with its object's placement and writes the slot
 * (contracts/rigid.ts):
 *   world pivot       = origin + R_q · (pivot + offset)   (R_q: the quarter turn inside the footprint)
 *   world orientation = q_q ⊗ pose rotation, normalised
 * `pivot` is the MODEL-space pivot — BlueprintPart.pivot, or CompiledPart.pivot of the unrotated
 * (quarter turn 0) model — and `footprintWidthVoxels` is 32 · the unrotated footprint width. The
 * slot's boxes must be the part's pivot-relative boxes in the unrotated model frame; for boxes
 * already turned by rotateModel use `writeRotatedPartTransform`. A zero or non-finite pose
 * quaternion is treated as the identity. Returns whether the slot changed; allocation-free.
 */
export const writePartTransform = (
  table: TransformTable,
  slot: number,
  originX: number,
  originY: number,
  originZ: number,
  quarterTurn: SingleTurn,
  footprintWidthVoxels: number,
  pivot: Vec3,
  pose: Readonly<PartPose>,
): boolean => {
  const modelX = pivot[0] + pose.dx;
  const modelY = pivot[1] + pose.dy;
  // rotatePointInFootprint, inlined because the contract helper returns a fresh object per call;
  // rigid.test.ts pins the two against each other.
  COMPOSED[0] = originX + (quarterTurn === 0 ? modelX : modelY);
  COMPOSED[1] = originY + (quarterTurn === 0 ? modelY : footprintWidthVoxels - modelX);
  COMPOSED[2] = originZ + pivot[2] + pose.dz;
  const turn = QUARTER_TURN_ROTATIONS[quarterTurn];
  const ax = turn[0];
  const ay = turn[1];
  const az = turn[2];
  const aw = turn[3];
  const bx = pose.qx;
  const by = pose.qy;
  const bz = pose.qz;
  const bw = pose.qw;
  // Hamilton product turn ⊗ pose: the pose acts in model space, then the turn carries it to world.
  COMPOSED[3] = aw * bx + ax * bw + ay * bz - az * by;
  COMPOSED[4] = aw * by - ax * bz + ay * bw + az * bx;
  COMPOSED[5] = aw * bz + ax * by - ay * bx + az * bw;
  COMPOSED[6] = aw * bw - ax * bx - ay * by - az * bz;
  normaliseComposedRotation(turn);
  return table.writeFrom(slot, COMPOSED, 0);
};

const IDENTITY_ROTATION: readonly [number, number, number, number] = [0, 0, 0, 1];
/** R_q's linear part per turn as (cos-like, cos-like, x-from-y, y-from-x): x' = c·x + s·y, y' = t·x + c·y. */
const TURN_LINEAR: readonly (readonly [number, number, number, number])[] = [
  [1, 1, 0, 0],
  [0, 0, 1, -1],
  [-1, -1, 0, 0],
  [0, 0, -1, 1],
];

/**
 * The same world transform for a part whose boxes come from `rotateModel(model, q)`, i.e. are
 * already turned by R_q about the pivot, with `rotatedPivot` that model's (turned) part pivot:
 *   world pivot       = origin + rotatedPivot + R_q · offset
 *   world orientation = q_q ⊗ pose rotation ⊗ q_q⁻¹   (un-turn, pose in model space, turn back)
 * so the rest pose is exactly the identity. Applied to the turned boxes this lands every voxel
 * where `writePartTransform` lands the unturned ones (rigid.test.ts); use whichever matches the
 * boxes the slot is drawn with. Allocation-free.
 */
export const writeRotatedPartTransform = (
  table: TransformTable,
  slot: number,
  originX: number,
  originY: number,
  originZ: number,
  quarterTurn: QuarterTurn,
  rotatedPivot: Vec3,
  pose: Readonly<PartPose>,
): boolean => {
  // R_1's linear part is (x, y) → (y, −x), and R_q is it applied q times (R_2: (−x, −y), R_3: (−y, x));
  // conjugating a quaternion by q_q turns its vector part by the same map and keeps its scalar part.
  const [cx, cy, sx, sy] = TURN_LINEAR[quarterTurn];
  COMPOSED[0] = originX + rotatedPivot[0] + cx * pose.dx + sx * pose.dy;
  COMPOSED[1] = originY + rotatedPivot[1] + sy * pose.dx + cy * pose.dy;
  COMPOSED[2] = originZ + rotatedPivot[2] + pose.dz;
  COMPOSED[3] = cx * pose.qx + sx * pose.qy;
  COMPOSED[4] = sy * pose.qx + cy * pose.qy;
  COMPOSED[5] = pose.qz;
  COMPOSED[6] = pose.qw;
  normaliseComposedRotation(IDENTITY_ROTATION);
  return table.writeFrom(slot, COMPOSED, 0);
};

/**
 * Sets a pose's rotation to `angle` radians about (axisX, axisY, axisZ) in model space
 * (right-handed; the axis need not be unit length), leaving its offset alone. For drivers:
 * allocation-free, and a zero axis gives the identity.
 */
export const setPoseRotation = (out: PartPose, axisX: number, axisY: number, axisZ: number, angle: number): void => {
  const length = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
  if (!(length > 0)) {
    out.qx = 0;
    out.qy = 0;
    out.qz = 0;
    out.qw = 1;
    return;
  }
  const scale = Math.sin(angle / 2) / length;
  out.qx = axisX * scale;
  out.qy = axisY * scale;
  out.qz = axisZ * scale;
  out.qw = Math.cos(angle / 2);
};
