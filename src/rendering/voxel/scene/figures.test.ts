import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import type { Guest, GuestState } from '../../../game/guests/types';
import type { StaffRuntime } from '../../../game/operations/types';
import { seedDevPark } from '../../../game/session/devPark';
import { ParkSession } from '../../../game/session/ParkSession';
import { frontOf, type Cell } from '../../../game/types';
import {
  FIGURE_CAPACITY,
  FIGURE_FLAG_DESATURATE,
  FIGURE_FLOATS,
  FIGURE_FRAME_ARMS_UP,
  FIGURE_FRAME_CAMERA,
  FIGURE_FRAME_EAT,
  FIGURE_FRAME_FAN_A,
  FIGURE_FRAME_FAN_B,
  FIGURE_FRAME_HOLD,
  FIGURE_FRAME_HUNCH,
  FIGURE_FRAME_JUMP,
  FIGURE_FRAME_MS,
  FIGURE_FRAME_POINT,
  FIGURE_FRAME_SHIVER_A,
  FIGURE_FRAME_SHIVER_B,
  FIGURE_FRAME_SIT,
  FIGURE_FRAME_STANDING,
  FIGURE_FRAME_STOMP_A,
  FIGURE_FRAME_STOMP_B,
  FIGURE_FRAME_VOMIT,
  FIGURE_FRAME_WAVE_A,
  FIGURE_FRAME_WAVE_B,
  FIGURE_MODEL_CLEANER,
  FIGURE_MODEL_GUEST,
  FIGURE_MODEL_GUEST_BALLOON,
  FIGURE_MODEL_GUEST_GLOW,
  FIGURE_MODEL_GUEST_HAT,
  FIGURE_MODEL_GUEST_PLUSH,
  FIGURE_MODEL_GUEST_UMBRELLA,
  FIGURE_MODEL_MECHANIC,
  FIGURE_TEX_WIDTH,
  GUEST_FIGURE_MODELS,
  FIGURE_TEXELS,
  queueSlotOffset,
  unpackPaletteWord,
} from '../contracts/figures';
import type { FigureModel } from '../contracts/figures';
import { MAT, SKIN_MATERIALS } from '../contracts/palette';
import { depthKey, PATH_TOP_Z, projectX, projectY, VOXELS_PER_TILE } from '../contracts/space';
import { createViewTransform, setViewTransform, vectorToViewVoxel } from '../contracts/view';
import { buildPalette } from '../palette';
import { createViewFrame, type XY } from '../../viewRotation';
import { createFigurePacker, headingOf } from './figures';
import type { FigureFrame } from './figures';

/**
 * The figure packer turns the simulation's 10 Hz guests and staff into one entity record each per
 * frame. What it must get right, and what this file pins:
 * - which figures are drawn (hidden states skipped) and in which order (grouped by model);
 * - where: the cell centre, interpolated between the last two steps by stepFraction, snapping
 *   instead of gliding across skipped steps, teleports and figures that (re)appear; queued guests
 *   on their legacy slot re-expressed in the ground plane, so each row is nearer the camera;
 * - how: heading, walk keyframe clocked by simulation time, palette word, desaturation;
 * - and at what cost: one reused array whose rows are only marked dirty when they change.
 */

const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const HIDDEN_STATES: ReadonlySet<GuestState> = new Set<GuestState>(['riding', 'shopping', 'usingFacility']);
const ENTITIES_PER_ROW = FIGURE_TEX_WIDTH / FIGURE_TEXELS;

/** Dev park with guests that have had time to spread out, queue, ride and shop. */
const devPark = (guests = 400, steps = 400): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  session.guests.spawnGuests(guests);
  for (let step = 0; step < steps; step += 1) session.step(GAME_CONFIG.fixedStepMs);
  return session;
};

/** Dev park whose guests have just arrived and stand at the entrance: a still scene to steer by hand. */
const quietPark = (guests = 12): ParkSession => devPark(guests, 0);

interface EntityRecord {
  x: number;
  y: number;
  z: number;
  heading: number;
  frame: number;
  model: number;
  paletteWord: number;
  flags: number;
}

const recordAt = (frame: FigureFrame, index: number): EntityRecord => {
  expect(index, 'record index').toBeGreaterThanOrEqual(0);
  expect(index, 'record index').toBeLessThan(frame.count);
  const at = index * FIGURE_FLOATS;
  const data = frame.data;
  return {
    x: data[at],
    y: data[at + 1],
    z: data[at + 2],
    heading: data[at + 3],
    frame: data[at + 4],
    model: data[at + 5],
    paletteWord: data[at + 6],
    flags: data[at + 7],
  };
};

/** Guests in packing order: the session's map order with hidden states skipped. */
const packedGuests = (session: ParkSession): Guest[] =>
  [...session.guests.guests.values()].filter((guest) => !HIDDEN_STATES.has(guest.state));

const workersOf = (session: ParkSession, role: StaffRuntime['role']): StaffRuntime[] =>
  [...session.operations.staff.values()].filter((worker) => worker.role === role);

const guestRecord = (frame: FigureFrame, session: ParkSession, guest: Guest): EntityRecord =>
  recordAt(frame, packedGuests(session).indexOf(guest));

const workerRecord = (frame: FigureFrame, session: ParkSession, worker: StaffRuntime): EntityRecord => {
  const model: FigureModel = worker.role === 'cleaner' ? FIGURE_MODEL_CLEANER : FIGURE_MODEL_MECHANIC;
  return recordAt(frame, frame.ranges[model].firstEntity + workersOf(session, worker.role).indexOf(worker));
};

/** Voxel coordinate of a (fractional) cell coordinate's centre. */
const centre = (cell: number): number => cell * VOXELS_PER_TILE + VOXELS_PER_TILE / 2;

/** Float32 records against float64 expectations: far finer than any real move (≥ 0.1 voxel). */
const expectNear = (actual: number, expected: number, message: string): void => {
  expect(Math.abs(actual - expected), `${message}: ${actual} vs ${expected}`).toBeLessThan(1e-3);
};

/** Legacy queue slot of a queued guest (its index in its attraction's queue), or −1. */
const queueIndexOf = (session: ParkSession, guest: Guest): number => {
  if (guest.destinationObjectId === null) return -1;
  if (guest.state === 'queueing') return session.rides.rides.get(guest.destinationObjectId)?.queueGuestIds.indexOf(guest.id) ?? -1;
  if (guest.state === 'queueingForShop') {
    return session.shops.services.get(guest.destinationObjectId)?.queueGuestIds.indexOf(guest.id) ?? -1;
  }
  return -1;
};

/** Puts a guest at (x, y), walking toward `next`, or standing when `next` is null. */
const steerGuest = (guest: Guest, x: number, y: number, next: Cell | null): void => {
  guest.state = 'wandering';
  guest.activity = null;
  guest.destinationObjectId = null;
  guest.position = { x, y };
  guest.currentCell = { x: Math.round(x), y: Math.round(y) };
  guest.route = next ? [{ x, y }, next] : [{ x, y }];
  guest.routeIndex = 1;
};

const walkFrameAt = (session: ParkSession, fraction: number, id: number): number =>
  (Math.floor(((session.world.tick + fraction) * GAME_CONFIG.fixedStepMs) / FIGURE_FRAME_MS) + id) % 4;

const isQueued = (guest: Guest): boolean => guest.state === 'queueing' || guest.state === 'queueingForShop';

/** Phase 29: a guest the packer draws in a pose rather than walking or standing. */
const isPosing = (guest: Guest, walking: boolean): boolean => guest.state === 'pausing' || guest.state === 'resting'
  || guest.state === 'entering' || (guest.state === 'wandering' && guest.activity !== null && !walking);

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  next(): number {
    this.state = (this.state * 1_664_525 + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(maximum: number): number {
    return Math.floor(this.next() * maximum);
  }
}

/** The interpolation contract (design §7) restated independently: one guest's remembered steps. */
interface Remembered {
  previousX: number;
  previousY: number;
  currentX: number;
  currentY: number;
  visible: boolean;
}

const STEP_DX = [1, 0, -1, 0];
const STEP_DY = [0, 1, 0, -1];

describe('figure packing', () => {
  it('packs every visible guest in session order, then cleaners, then mechanics', () => {
    const session = devPark();
    const guests = [...session.guests.guests.values()];
    // The dev park has nobody in a toilet at this moment; send one wanderer in.
    (guests.find((guest) => guest.state === 'wandering') as Guest).state = 'usingFacility';
    for (const state of HIDDEN_STATES) {
      expect(guests.some((guest) => guest.state === state), `the fixture has ${state} guests`).toBe(true);
    }
    const visible = packedGuests(session);
    const cleaners = workersOf(session, 'cleaner');
    const mechanics = workersOf(session, 'mechanic');
    expect([cleaners.length, mechanics.length]).toEqual([4, 2]);

    const frame = createFigurePacker(palette).pack(session, 0.4);
    expect(frame.count, 'one record per visible guest and per staff member').toBe(visible.length + 6);
    // Indexed by model; nobody here carries a souvenir, so the Phase 29 guest models are empty ranges after the guests.
    expect(frame.ranges).toEqual([
      { model: FIGURE_MODEL_GUEST, firstEntity: 0, entityCount: visible.length },
      { model: FIGURE_MODEL_CLEANER, firstEntity: visible.length, entityCount: 4 },
      { model: FIGURE_MODEL_MECHANIC, firstEntity: visible.length + 4, entityCount: 2 },
      ...GUEST_FIGURE_MODELS.slice(1).map((model) => ({ model, firstEntity: visible.length, entityCount: 0 })),
    ]);
    for (const range of frame.ranges) {
      for (let index = range.firstEntity; index < range.firstEntity + range.entityCount; index += 1) {
        const record = recordAt(frame, index);
        expect(record.model, `record ${index} model`).toBe(range.model);
        expect(record.z, `record ${index} stands on the path`).toBe(PATH_TOP_Z);
      }
    }
    // A fresh packer has no history, so everything is drawn exactly where the simulation has it.
    visible.forEach((guest, index) => {
      const record = recordAt(frame, index);
      const slot = queueIndexOf(session, guest);
      const offset = slot >= 0 ? queueSlotOffset(slot) : { dvx: 0, dvy: 0 };
      expectNear(record.x, centre(guest.position.x) + offset.dvx, `guest ${guest.id} x`);
      expectNear(record.y, centre(guest.position.y) + offset.dvy, `guest ${guest.id} y`);
    });
    [...cleaners, ...mechanics].forEach((worker) => {
      const record = workerRecord(frame, session, worker);
      expectNear(record.x, centre(worker.position.x), `worker ${worker.id} x`);
      expectNear(record.y, centre(worker.position.y), `worker ${worker.id} y`);
    });
  });

  it('puts queued guests on their legacy slot, re-expressed in the ground plane', () => {
    const session = devPark();
    const queued = packedGuests(session).filter(isQueued);
    expect(queued.some((guest) => guest.state === 'queueingForShop'), 'the fixture has shop queues').toBe(true);
    expect(queued.some((guest) => queueIndexOf(session, guest) >= 14), 'the fixture has queues three rows deep').toBe(true);
    const packer = createFigurePacker(palette);
    // The first pack finds new guests' slots by searching their queue; later packs use the one
    // pass over all queues. Both must agree with legacy's indexOf.
    for (const pass of ['first pack', 'queue pass']) {
      const frame = packer.pack(session, 0.5);
      for (const guest of queued) {
        const slot = queueIndexOf(session, guest);
        expect(slot, `guest ${guest.id} is in its queue`).toBeGreaterThanOrEqual(0);
        const record = guestRecord(frame, session, guest);
        const dvx = record.x - centre(guest.position.x);
        const dvy = record.y - centre(guest.position.y);
        const row = Math.floor(slot / 7);
        // Same picture as legacy (7 columns 7 px apart, rows 5 px down)…
        expectNear(projectX(dvx, dvy), ((slot % 7) - 3) * 7, `${pass}: slot ${slot} screen x`);
        expectNear(projectY(dvx, dvy, 0), row * 5, `${pass}: slot ${slot} screen y`);
        // …but each row lower on screen is nearer the camera instead of sinking into the paving.
        expectNear(depthKey(dvx, dvy, 0), 2 * row * 5, `${pass}: slot ${slot} depth`);
        expect(record.frame, 'queued guests stand still').toBe(FIGURE_FRAME_STANDING);
      }
    }
  });

  it('keeps the legacy queue layout ON SCREEN in every view (phase 26), rewriting only the queued records on a turn', () => {
    const session = devPark();
    const queued = packedGuests(session).filter(isQueued);
    const packer = createFigurePacker(palette);
    packer.pack(session, 0.5);
    const steady = packer.pack(session, 0.5);
    expect(steady.rowEnd, 'a repeat pack in view 0 dirties nothing').toBe(steady.rowStart);
    const turned = createViewTransform();
    const view: XY = { x: 0, y: 0 };
    for (const rotation of [1, 2, 3, 0] as const) {
      packer.setView(rotation);
      setViewTransform(createViewFrame(rotation, session.world.width, session.world.height), turned);
      const frame = packer.pack(session, 0.5);
      expect(frame.rowEnd > frame.rowStart, `view ${rotation}: the turn rewrites the queued records`).toBe(true);
      for (const guest of queued) {
        const slot = queueIndexOf(session, guest);
        const record = guestRecord(frame, session, guest);
        vectorToViewVoxel(turned, record.x - centre(guest.position.x), record.y - centre(guest.position.y), view);
        const row = Math.floor(slot / 7);
        expectNear(projectX(view.x, view.y), ((slot % 7) - 3) * 7, `view ${rotation}: slot ${slot} screen x`);
        expectNear(projectY(view.x, view.y, 0), row * 5, `view ${rotation}: slot ${slot} screen y`);
        expectNear(depthKey(view.x, view.y, 0), 2 * row * 5, `view ${rotation}: slot ${slot} nearer the camera per row`);
      }
      const again = packer.pack(session, 0.5);
      expect(again.rowEnd, `view ${rotation}: a steady pack dirties nothing`).toBe(again.rowStart);
    }
  });

  it('interpolates between the last two steps by stepFraction', () => {
    const session = quietPark();
    const guest = packedGuests(session)[3];
    steerGuest(guest, 10, 20, { x: 12, y: 20 });
    const packer = createFigurePacker(palette);
    const first = guestRecord(packer.pack(session, 0.9), session, guest);
    expectNear(first.x, centre(10), 'a new figure is drawn where it is');

    session.world.advanceTick();
    guest.position = { x: 10.3, y: 20 };
    for (const fraction of [0, 0.25, 0.75]) {
      const record = guestRecord(packer.pack(session, fraction), session, guest);
      expectNear(record.x, centre(10 + 0.3 * fraction), `x at fraction ${fraction}`);
      expectNear(record.y, centre(20), `y at fraction ${fraction}`);
    }
    const xAt = (fraction: number): number => guestRecord(packer.pack(session, fraction), session, guest).x;
    expectNear(xAt(1.7), centre(10.3), 'a fraction above 1 clamps to the latest step');
    expectNear(xAt(-0.3), centre(10), 'below 0 to the previous one');
    expectNear(xAt(Number.NaN), centre(10), 'and so does NaN');
    // The guest's position object is replaced at waypoints; the history copied the numbers.
    session.world.advanceTick();
    guest.position.x = 10.5;
    expectNear(guestRecord(packer.pack(session, 0.5), session, guest).x, centre(10.4), 'next step');
  });

  it('snaps instead of gliding across skipped steps, teleports and figures that (re)appear', () => {
    const session = quietPark();
    const guest = packedGuests(session)[2];
    steerGuest(guest, 10, 20, { x: 20, y: 20 });
    const packer = createFigurePacker(palette);
    packer.pack(session, 0.5);
    const xAt = (fraction: number): number => guestRecord(packer.pack(session, fraction), session, guest).x;

    // Positions are binary fractions so the 2-cell boundary below is exact.
    session.world.advanceTick();
    session.world.advanceTick();
    guest.position = { x: 10.25, y: 20 };
    expectNear(xAt(0.5), centre(10.25), 'two steps in one frame: no interpolation');

    session.world.advanceTick();
    guest.position = { x: 12.25, y: 20 };
    expectNear(xAt(0.5), centre(11.25), 'a move of exactly 2 cells still interpolates');

    session.world.advanceTick();
    guest.position = { x: 14.5, y: 20 };
    expectNear(xAt(0.5), centre(14.5), 'more than 2 cells is a teleport');

    guest.state = 'riding';
    const hiddenFrame = packer.pack(session, 0.5);
    expect(hiddenFrame.count, 'a riding guest is not drawn').toBe(packedGuests(session).length + 6);
    session.world.advanceTick();
    guest.position = { x: 14.75, y: 20 };
    guest.state = 'wandering';
    expectNear(xAt(0.5), centre(14.75), 'a guest leaving a ride appears where it is');

    session.world.advanceTick();
    guest.position = { x: 15, y: 20 };
    expectNear(xAt(0.5), centre(14.875), 'and walks on smoothly');

    // Guests spawned between steps (the dev buttons) appear where they stand, whatever the fraction.
    session.guests.spawnGuests(1);
    const newcomer = [...session.guests.guests.values()].at(-1) as Guest;
    newcomer.position = { x: 15.4, y: 30.6 };
    const record = guestRecord(packer.pack(session, 0.8), session, newcomer);
    expectNear(record.x, centre(15.4), 'newcomer x');
    expectNear(record.y, centre(30.6), 'newcomer y');
  });

  it('heads the way it walks, turns with its drawn position and keeps its heading standing', () => {
    expect(headingOf(1, 0)).toBe(0);
    expect(headingOf(0.1, 0.9)).toBe(1);
    expect(headingOf(-1, 0.2)).toBe(2);
    expect(headingOf(0.3, -0.9)).toBe(3);
    expect(headingOf(0.5, 0.5), 'ties go to x').toBe(0);
    expect(headingOf(-0.5, -0.5)).toBe(2);

    const session = quietPark();
    const guest = packedGuests(session)[5];
    const packer = createFigurePacker(palette);
    const headingNow = (): number => guestRecord(packer.pack(session, 0.5), session, guest).heading;

    // The route's last leg runs +x, so only steering by the next waypoint gives +y here.
    steerGuest(guest, 10, 20, { x: 10, y: 22 });
    guest.route.push({ x: 12, y: 22 });
    expect(headingNow(), 'toward the next waypoint before the first step').toBe(1);
    session.world.advanceTick();
    guest.position = { x: 10, y: 20.2 };
    expect(headingNow(), 'walking +y').toBe(1);

    // The route turns at this waypoint, but the drawn figure is still finishing its +y step.
    session.world.advanceTick();
    guest.position = { x: 10, y: 20.4 };
    guest.route = [{ x: 10, y: 20.4 }, { x: 8, y: 20.4 }];
    guest.routeIndex = 1;
    expect(headingNow(), 'still drawn moving +y').toBe(1);
    session.world.advanceTick();
    guest.position = { x: 9.8, y: 20.4 };
    expect(headingNow(), 'turned to −x with its drawn position').toBe(2);
    session.world.advanceTick();
    guest.position = { x: 9.8, y: 20.2 };
    expect(headingNow(), 'walking −y').toBe(3);

    guest.routeIndex = guest.route.length;
    session.world.advanceTick();
    expect(headingNow(), 'standing keeps the last heading').toBe(3);
    session.world.advanceTick();
    expect(headingNow(), 'still standing').toBe(3);
  });

  it('faces figures without a route toward the camera, so figures on one spot coincide', () => {
    // Fresh arrivals and idle staff all stand on the entrance tile with nowhere to go yet; with
    // mixed headings their boxes would interpenetrate into one many-armed figure.
    const session = quietPark(30);
    const frame = createFigurePacker(palette).pack(session, 0.5);
    const entrance = session.world.entrance;
    for (let index = 0; index < frame.count; index += 1) {
      const record = recordAt(frame, index);
      expect([record.x, record.y, record.heading], `record ${index}`).toEqual([centre(entrance.x), centre(entrance.y), 1]);
    }
  });

  it('turns queued guests toward their attraction and staff toward their work', () => {
    const session = devPark();
    const frame = createFigurePacker(palette).pack(session, 0.5);
    const queued = packedGuests(session).filter(isQueued);
    expect(queued.length).toBeGreaterThan(50);
    const toward = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
    for (const guest of queued) {
      const heading = guestRecord(frame, session, guest).heading;
      const ahead = { x: guest.currentCell.x + toward[heading].x, y: guest.currentCell.y + toward[heading].y };
      expect(session.world.objectAt(ahead)?.id, `guest ${guest.id} faces its attraction`).toBe(guest.destinationObjectId);
    }

    // A mechanic repairing a ride from one of its access tiles faces it, and greys out while waiting.
    const sample = queued.find((guest) => guest.state === 'queueing') as Guest;
    const rideId = sample.destinationObjectId as number;
    const mechanic = workersOf(session, 'mechanic')[0];
    const cell = { ...sample.currentCell };
    mechanic.position = { ...cell };
    mechanic.currentCell = { ...cell };
    mechanic.route = [{ ...cell }];
    mechanic.routeIndex = 1;
    mechanic.state = 'working';
    mechanic.task = {
      kind: 'repairRide',
      targetObjectId: rideId,
      targetCell: { ...cell },
      workRemainingSeconds: 5,
      workDurationSeconds: 5,
      maintenanceStarted: true,
    };
    const packer = createFigurePacker(palette);
    const working = workerRecord(packer.pack(session, 0.5), session, mechanic);
    const ahead = { x: cell.x + toward[working.heading].x, y: cell.y + toward[working.heading].y };
    expect(session.world.objectAt(ahead)?.id, 'the mechanic faces the ride').toBe(rideId);
    expect([working.frame, working.flags]).toEqual([FIGURE_FRAME_STANDING, 0]);
    mechanic.state = 'waiting';
    expect(workerRecord(packer.pack(session, 0.5), session, mechanic).flags).toBe(FIGURE_FLAG_DESATURATE);
  });

  it('animates walkers by simulation time and holds everyone else still, even while paused', () => {
    const session = devPark();
    const packer = createFigurePacker(palette);
    const fraction = 0.3;
    const frame = packer.pack(session, fraction);
    let walkers = 0;
    let standing = 0;
    for (const guest of packedGuests(session)) {
      const walking = !isQueued(guest) && guest.routeIndex < guest.route.length;
      // Phase 29: a pause, a seat, an arrival's wave or a flourish shows a pose instead (its own test below).
      if (isPosing(guest, walking)) continue;
      const expected = walking ? walkFrameAt(session, fraction, guest.id) : FIGURE_FRAME_STANDING;
      expect(guestRecord(frame, session, guest).frame, `guest ${guest.id} (${guest.state})`).toBe(expected);
      if (walking) walkers += 1;
      else standing += 1;
    }
    expect([walkers > 20, standing > 20], 'the fixture has walkers and standers').toEqual([true, true]);
    for (const worker of session.operations.staff.values()) {
      const walking = worker.state === 'walking' && worker.routeIndex < worker.route.length;
      const expected = walking ? walkFrameAt(session, fraction, worker.id) : FIGURE_FRAME_STANDING;
      expect(workerRecord(frame, session, worker).frame, `worker ${worker.id} (${worker.state})`).toBe(expected);
    }

    // Paused: the tick and the fraction stay put, so does every texel — and nothing is uploaded.
    const before = frame.data.slice(0, frame.count * FIGURE_FLOATS);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const paused = packer.pack(session, fraction);
      expect(paused.data.subarray(0, paused.count * FIGURE_FLOATS), 'a paused frame is identical').toEqual(before);
      expect(paused.rowEnd, 'a paused frame marks no rows dirty').toBe(paused.rowStart);
    }

    // Running again: the walk cycle advances with simulation time.
    const later = packer.pack(session, 0.95);
    for (const guest of packedGuests(session)) {
      const walking = !isQueued(guest) && guest.routeIndex < guest.route.length;
      if (!walking) continue;
      expect(guestRecord(later, session, guest).frame).toBe(walkFrameAt(session, 0.95, guest.id));
    }
  });

  it('greys out leaving guests and waiting staff, and nobody else', () => {
    const session = devPark(200, 200);
    const leaver = packedGuests(session).find((guest) => !isQueued(guest)) as Guest;
    leaver.state = 'leaving';
    const cleaner = workersOf(session, 'cleaner')[1];
    cleaner.state = 'waiting';
    const frame = createFigurePacker(palette).pack(session, 0.5);
    for (const guest of packedGuests(session)) {
      expect(guestRecord(frame, session, guest).flags, `guest ${guest.id} (${guest.state})`)
        .toBe(guest === leaver ? FIGURE_FLAG_DESATURATE : 0);
    }
    for (const worker of session.operations.staff.values()) {
      expect(workerRecord(frame, session, worker).flags, `worker ${worker.id} (${worker.state})`)
        .toBe(worker === cleaner ? FIGURE_FLAG_DESATURATE : 0);
    }
  });

  it('dresses guests in their shirt colour with hair, hats and skin chosen by id', () => {
    const session = devPark();
    const frame = createFigurePacker(palette).pack(session, 0.5);
    const again = createFigurePacker(palette).pack(session, 0.5);
    const hairs = new Set<number>([MAT.HAIR_DARK, MAT.HAIR_BROWN, MAT.HAIR_BLOND]);
    const seenHair = new Set<number>();
    const seenSkin = new Set<number>();
    let hats = 0;
    for (const guest of packedGuests(session)) {
      const record = guestRecord(frame, session, guest);
      expect(guestRecord(again, session, guest).paletteWord, 'deterministic by id').toBe(record.paletteWord);
      const { shirt, hair, skin } = unpackPaletteWord(record.paletteWord);
      expect(shirt, `guest ${guest.id} shirt`).toBe(palette.material(guest.color));
      expect(SKIN_MATERIALS, `guest ${guest.id} skin`).toContain(skin);
      if (hair === palette.material(guest.accent) && !hairs.has(hair)) hats += 1;
      else expect(hairs.has(hair), `guest ${guest.id} hair ${hair}`).toBe(true);
      seenHair.add(hair);
      seenSkin.add(skin);
    }
    expect(seenSkin.size, 'every skin tone appears in a crowd').toBe(SKIN_MATERIALS.length);
    expect([...hairs].every((hair) => seenHair.has(hair)), 'every hair colour appears').toBe(true);
    expect(hats, 'some guests wear a hat in their accent colour').toBeGreaterThan(10);
    for (const worker of session.operations.staff.values()) {
      const { shirt, skin } = unpackPaletteWord(workerRecord(frame, session, worker).paletteWord);
      expect(shirt).toBe(worker.role === 'cleaner' ? MAT.CLEANER_UNIFORM : MAT.MECHANIC_UNIFORM);
      expect(SKIN_MATERIALS).toContain(skin);
    }
  });

  it('reuses one data array, range array and frame object for every frame and session', () => {
    const packer = createFigurePacker(palette);
    const first = packer.pack(devPark(50, 50), 0.2);
    const { data, ranges } = first;
    expect(data.length).toBe(FIGURE_CAPACITY * FIGURE_FLOATS);
    const other = devPark(80, 80);
    for (let frame = 0; frame < 5; frame += 1) {
      const next = packer.pack(other, frame / 5);
      expect(next, 'the frame object').toBe(first);
      expect(next.data, 'the data array').toBe(data);
      expect(next.ranges, 'the range array').toBe(ranges);
      other.step(GAME_CONFIG.fixedStepMs);
    }
    packer.reset();
    expect(packer.remembered, 'reset forgets everyone').toBe(0);
    expect(packer.pack(other, 0.5).data).toBe(data);
    expect(packer.remembered).toBe(other.guests.guests.size + other.operations.staff.size);
  });

  it('forgets every history on reset and when the session changes', () => {
    const session = quietPark();
    const guest = packedGuests(session)[1];
    steerGuest(guest, 10, 20, { x: 12, y: 20 });
    const packer = createFigurePacker(palette);
    packer.pack(session, 0.5);
    session.world.advanceTick();
    guest.position = { x: 10.4, y: 20 };
    packer.reset();
    expectNear(guestRecord(packer.pack(session, 0.5), session, guest).x, centre(10.4), 'reset: no glide');

    // A new session reuses guest ids and may even continue the tick count; nothing carries over.
    const next = quietPark();
    next.world.tick = session.world.tick + 1;
    const twin = [...next.guests.guests.values()].find((candidate) => candidate.id === guest.id) as Guest;
    steerGuest(twin, 10.8, 20, { x: 12, y: 20 });
    expectNear(guestRecord(packer.pack(next, 0.5), next, twin).x, centre(10.8), 'new session: no glide');
  });

  it('marks only the texture rows whose records changed', () => {
    const session = devPark();
    const packer = createFigurePacker(palette);
    const frame = packer.pack(session, 0.5);
    expect(frame.count, 'the fixture spans several rows').toBeGreaterThan(ENTITIES_PER_ROW + 5);
    expect([frame.rowStart, frame.rowEnd]).toEqual([0, Math.ceil(frame.count / ENTITIES_PER_ROW)]);
    const still = packer.pack(session, 0.5);
    expect(still.rowEnd, 'nothing changed').toBe(still.rowStart);

    // One guest nudged between steps (a sync outside the fixed step) dirties its row alone.
    const visible = packedGuests(session);
    const index = ENTITIES_PER_ROW + 5;
    const guest = visible[index];
    guest.position = { x: guest.position.x + 0.05, y: guest.position.y };
    const nudged = packer.pack(session, 0.5);
    expect([nudged.rowStart, nudged.rowEnd]).toEqual([1, 2]);
  });

  it('never writes past FIGURE_CAPACITY', () => {
    const session = devPark(GAME_CONFIG.guests.maximum, 0);
    const template = [...session.guests.guests.values()][0];
    let id = Math.max(...session.guests.guests.keys());
    while (session.guests.guests.size < FIGURE_CAPACITY + 40) {
      id += 1;
      session.guests.guests.set(id, { ...template, id, position: { ...template.position } });
    }
    const frame = createFigurePacker(palette).pack(session, 0.5);
    expect(frame.count).toBe(FIGURE_CAPACITY);
    expect(frame.ranges.map((range) => range.entityCount)).toEqual([FIGURE_CAPACITY, 0, 0, 0, 0, 0, 0, 0]);
    expect(frame.rowEnd).toBe((FIGURE_CAPACITY * FIGURE_TEXELS) / FIGURE_TEX_WIDTH);
  });
});

/**
 * The same contract under seeded random sequences: frames with no step, one step or several, small
 * moves, teleports, moves between steps, guests boarding and leaving rides, guests removed and new
 * ones spawned (so histories are recycled through the free list). A reference model written from
 * the design, not from the packer, says where every visible guest must be drawn.
 */
describe('figure interpolation under random step patterns', () => {
  const SEEDS = [1, 7, 42, 313, 0x5eed, 0xbeef];

  it.each(SEEDS)('matches the reference model through steps, jumps, teleports, rides and churn (seed %i)', (seed) => {
    const rng = new Rng(seed);
    const session = quietPark(16);
    const packer = createFigurePacker(palette);
    const model = new Map<number, Remembered>();
    let lastTick = Number.NaN;
    for (let iteration = 0; iteration < 150; iteration += 1) {
      const roll = rng.next();
      const steps = roll < 0.4 ? 0 : roll < 0.85 ? 1 : roll < 0.95 ? 2 : 3;
      for (let step = 0; step < steps; step += 1) session.world.advanceTick();
      for (const guest of [...session.guests.guests.values()]) {
        const event = rng.next();
        if (event < 0.02) {
          session.guests.guests.delete(guest.id);
          continue;
        }
        if (event < 0.07) guest.state = guest.state === 'riding' ? 'wandering' : 'riding';
        // Figures move on simulation steps; now and then something moves them between steps.
        if (rng.next() >= (steps > 0 ? 0.6 : 0.03)) continue;
        const distance = rng.next() < 0.05 ? 2 + rng.next() * 3 : rng.next() * 0.3;
        const direction = rng.int(4);
        guest.position = {
          x: guest.position.x + STEP_DX[direction] * distance,
          y: guest.position.y + STEP_DY[direction] * distance,
        };
      }
      if (rng.next() < 0.1) {
        session.guests.spawnGuests(1);
        const newcomer = [...session.guests.guests.values()].at(-1) as Guest;
        newcomer.position = { x: 2 + rng.next() * 28, y: 2 + rng.next() * 28 };
      }
      const fraction = rng.next();
      const frame = packer.pack(session, fraction);

      const tick = session.world.tick;
      const stepped = tick !== lastTick;
      const jumped = stepped && tick !== lastTick + 1;
      lastTick = tick;
      for (const guest of session.guests.guests.values()) {
        const visible = !HIDDEN_STATES.has(guest.state);
        const { x, y } = guest.position;
        const known = model.get(guest.id);
        if (!known) {
          model.set(guest.id, { previousX: x, previousY: y, currentX: x, currentY: y, visible });
          continue;
        }
        if (stepped) {
          const teleported = (x - known.currentX) ** 2 + (y - known.currentY) ** 2 > 4;
          const snap = jumped || !known.visible || teleported;
          known.previousX = snap ? x : known.currentX;
          known.previousY = snap ? y : known.currentY;
          known.currentX = x;
          known.currentY = y;
        } else if (x !== known.currentX || y !== known.currentY || (visible && !known.visible)) {
          known.previousX = x;
          known.previousY = y;
          known.currentX = x;
          known.currentY = y;
        }
        known.visible = visible;
      }
      for (const id of [...model.keys()]) if (!session.guests.guests.has(id)) model.delete(id);

      const population = session.guests.guests.size + session.operations.staff.size;
      expect(packer.remembered, `iteration ${iteration}: histories of departed guests are recycled`).toBe(population);
      const visibleGuests = packedGuests(session);
      expect(frame.ranges[FIGURE_MODEL_GUEST].entityCount, `iteration ${iteration} guests drawn`).toBe(visibleGuests.length);
      expect(frame.count, `iteration ${iteration} records`).toBe(visibleGuests.length + 6);
      visibleGuests.forEach((guest, index) => {
        const known = model.get(guest.id) as Remembered;
        const record = recordAt(frame, index);
        const what = `seed ${seed} iteration ${iteration} guest ${guest.id}`;
        expectNear(record.x, centre(known.previousX + (known.currentX - known.previousX) * fraction), `${what} x`);
        expectNear(record.y, centre(known.previousY + (known.currentY - known.previousY) * fraction), `${what} y`);
        // A recycled history must never carry its previous owner's clothes.
        expect(unpackPaletteWord(record.paletteWord).shirt, `${what} shirt`).toBe(palette.material(guest.color));
      });
    }
    const fresh = createFigurePacker(palette).pack(session, 0.5);
    const words = (frame: FigureFrame): number[] =>
      Array.from({ length: frame.count }, (_, index) => recordAt(frame, index).paletteWord);
    expect(words(packer.pack(session, 0.5)), 'palette words do not depend on history').toEqual(words(fresh));
  });
});

describe('figure culling (voxel leftovers)', () => {
  it('packs only the entities inside the cull rectangle, and everyone again once cleared', () => {
    const session = devPark();
    const packer = createFigurePacker(palette);
    const all = packer.pack(session, 0).count;
    expect(all).toBeGreaterThan(50);
    let inside = 0;
    session.guests.guests.forEach((guest) => {
      const hidden = guest.state === 'riding' || guest.state === 'shopping' || guest.state === 'usingFacility';
      if (!hidden && guest.position.x <= 15 && guest.position.y <= 31) inside += 1;
    });
    session.operations.staff.forEach((worker) => { if (worker.position.x <= 15 && worker.position.y <= 31) inside += 1; });
    packer.setCull(0, 0, 15, 31);
    const culled = packer.pack(session, 0);
    expect(culled.count).toBe(inside);
    expect(culled.count).toBeLessThan(all);
    const ranges = culled.ranges;
    expect(ranges.reduce((sum, range) => sum + range.entityCount, 0)).toBe(culled.count);
    expect(packer.remembered, 'off-screen entities keep their history').toBe(session.guests.guests.size + session.operations.staff.size);
    packer.clearCull();
    expect(packer.pack(session, 0).count).toBe(all);
  });
});

describe('guest life poses, seats and souvenirs (Phase 29)', () => {
  const POSE_FRAMES = new Set([
    FIGURE_FRAME_SIT, FIGURE_FRAME_HUNCH, FIGURE_FRAME_VOMIT, FIGURE_FRAME_JUMP, FIGURE_FRAME_ARMS_UP, FIGURE_FRAME_FAN_A,
    FIGURE_FRAME_FAN_B, FIGURE_FRAME_SHIVER_A, FIGURE_FRAME_SHIVER_B, FIGURE_FRAME_POINT, FIGURE_FRAME_CAMERA, FIGURE_FRAME_STOMP_A,
    FIGURE_FRAME_STOMP_B, FIGURE_FRAME_EAT, FIGURE_FRAME_WAVE_A, FIGURE_FRAME_WAVE_B, FIGURE_FRAME_HOLD, FIGURE_FRAME_STANDING,
  ]);

  it('shows a pose for every pause and flourish, and animates the lively ones by simulation time', () => {
    const session = quietPark(4);
    const [guest] = [...session.guests.guests.values()];
    steerGuest(guest, 15, 28, null);
    const packer = createFigurePacker(palette);
    const framesOf = (activity: Guest['activity'], state: Guest['state'] = 'pausing'): Set<number> => {
      guest.state = state;
      guest.activity = activity;
      const seen = new Set<number>();
      for (let fraction = 0; fraction < 1; fraction += 0.05) {
        for (let tick = 0; tick < 6; tick += 1) {
          session.world.advanceTick();
          seen.add(guestRecord(packer.pack(session, fraction), session, guest).frame);
        }
      }
      return seen;
    };
    expect(framesOf('queasy')).toEqual(new Set([FIGURE_FRAME_HUNCH]));
    expect(framesOf('vomit')).toEqual(new Set([FIGURE_FRAME_VOMIT, FIGURE_FRAME_HUNCH]));
    expect(framesOf('fanSelf')).toEqual(new Set([FIGURE_FRAME_FAN_A, FIGURE_FRAME_FAN_B]));
    expect(framesOf('shiver')).toEqual(new Set([FIGURE_FRAME_SHIVER_A, FIGURE_FRAME_SHIVER_B]));
    expect(framesOf('sulk')).toEqual(new Set([FIGURE_FRAME_STOMP_A, FIGURE_FRAME_STOMP_B]));
    expect(framesOf('photo')).toEqual(new Set([FIGURE_FRAME_CAMERA]));
    // Flourishes: a wandering guest standing after a ride or a purchase.
    expect(framesOf('cheer', 'wandering')).toEqual(new Set([FIGURE_FRAME_JUMP, FIGURE_FRAME_ARMS_UP]));
    expect(framesOf('eat', 'wandering')).toEqual(new Set([FIGURE_FRAME_EAT, FIGURE_FRAME_STANDING]));
    // New arrivals wave.
    expect(framesOf(null, 'entering')).toEqual(new Set([FIGURE_FRAME_WAVE_A, FIGURE_FRAME_WAVE_B]));
    for (const frame of framesOf('admire')) expect(POSE_FRAMES.has(frame)).toBe(true);
  });

  it('a paused park holds every pose still: two packs at the same tick are identical', () => {
    const session = quietPark(4);
    const [guest] = [...session.guests.guests.values()];
    steerGuest(guest, 15, 28, null);
    guest.state = 'pausing';
    guest.activity = 'cheer';
    const packer = createFigurePacker(palette);
    const first = guestRecord(packer.pack(session, 0.3), session, guest).frame;
    expect(guestRecord(packer.pack(session, 0.3), session, guest).frame).toBe(first);
  });

  it('seats a resting guest on their side of the bench, facing its front, and turns with the bench', () => {
    const session = quietPark(4);
    const bench = [...session.world.objects.values()].find((object) => object.definitionId === 'ribbon-bench')!;
    expect(bench, 'the dev park has a bench').toBeDefined();
    const [left, right] = [...session.guests.guests.values()];
    for (const [guest, seat] of [[left, 'seatLeft'], [right, 'seatRight']] as const) {
      steerGuest(guest, 15, 28, null);
      guest.state = 'resting';
      guest.destinationObjectId = bench.id;
      guest.activity = seat;
    }
    const packer = createFigurePacker(palette);
    const frame = packer.pack(session, 0.5);
    const a = guestRecord(frame, session, left);
    const b = guestRecord(frame, session, right);
    for (const record of [a, b]) {
      expect(record.frame).toBe(FIGURE_FRAME_SIT);
      expect(Math.floor(record.x / VOXELS_PER_TILE), 'on the bench tile (x)').toBe(bench.anchor.x);
      expect(Math.floor(record.y / VOXELS_PER_TILE), 'on the bench tile (y)').toBe(bench.anchor.y);
      // Phase 40: the bench faces one of four ways (the dev park turns it toward its path).
      expect(record.heading, 'facing the bench front').toBe(frontOf(bench.rotation).heading);
    }
    expect(Math.hypot(a.x - b.x, a.y - b.y), 'two seats, side by side').toBeCloseTo(10, 5);
  });

  it('sits down and stands up smoothly: the first seated frame and the first frame after standing interpolate (Phase 32)', () => {
    const session = quietPark(4);
    const bench = [...session.world.objects.values()].find((object) => object.definitionId === 'ribbon-bench')!;
    const [guest] = [...session.guests.guests.values()];
    // The path cell beside the bench, where the simulation keeps a resting guest.
    const pathX = bench.anchor.x;
    const pathY = bench.anchor.y + 1;
    const sit = (): void => {
      guest.state = 'resting';
      guest.destinationObjectId = bench.id;
      guest.activity = 'seatLeft';
    };
    // Where the seat is drawn: a fresh packer snaps a seated guest straight onto it.
    steerGuest(guest, pathX, pathY, null);
    sit();
    const seat = guestRecord(createFigurePacker(palette).pack(session, 0.5), session, guest);
    expect(Math.hypot(seat.x - centre(pathX), seat.y - centre(pathY)), 'the seat is off the path').toBeGreaterThan(VOXELS_PER_TILE / 4);

    steerGuest(guest, pathX, pathY, null);
    const packer = createFigurePacker(palette);
    packer.pack(session, 0.5);
    const at = (fraction: number): EntityRecord => guestRecord(packer.pack(session, fraction), session, guest);

    // The step the guest sits down: drawn from the path to the seat, not jumping onto it.
    session.world.advanceTick();
    sit();
    for (const fraction of [0, 0.5, 1]) {
      const record = at(fraction);
      expectNear(record.x, centre(pathX) + (seat.x - centre(pathX)) * fraction, `sitting down, x at ${fraction}`);
      expectNear(record.y, centre(pathY) + (seat.y - centre(pathY)) * fraction, `sitting down, y at ${fraction}`);
      expect(record.frame).toBe(FIGURE_FRAME_SIT);
      expect(record.heading, 'facing the bench front from the first frame').toBe(seat.heading);
    }
    // Seated over the next steps: still on the seat at every fraction.
    for (let tick = 0; tick < 3; tick += 1) {
      session.world.advanceTick();
      for (const fraction of [0, 0.7]) {
        const record = at(fraction);
        expectNear(record.x, seat.x, `seated x, tick ${tick} fraction ${fraction}`);
        expectNear(record.y, seat.y, `seated y, tick ${tick} fraction ${fraction}`);
      }
    }
    // The step the guest stands up: drawn from the seat back to the path.
    session.world.advanceTick();
    steerGuest(guest, pathX, pathY, null);
    for (const fraction of [0, 0.5, 1]) {
      const record = at(fraction);
      expectNear(record.x, seat.x + (centre(pathX) - seat.x) * fraction, `standing up, x at ${fraction}`);
      expectNear(record.y, seat.y + (centre(pathY) - seat.y) * fraction, `standing up, y at ${fraction}`);
    }
  });

  it('draws a guest with the model of the souvenir that shows: an umbrella only in the rain, a glow wand only at night', () => {
    const session = quietPark(4);
    const [guest] = [...session.guests.guests.values()];
    steerGuest(guest, 15, 28, null);
    const packer = createFigurePacker(palette);
    const modelOf = (): number => {
      const frame = packer.pack(session, 0.5);
      const range = frame.ranges.find((candidate) => candidate.entityCount > 0 && Array.from({ length: candidate.entityCount }, (_, at) => recordAt(frame, candidate.firstEntity + at))
        .some((record) => Math.abs(record.x - centre(15)) < 1e-3 && Math.abs(record.y - centre(28)) < 1e-3));
      return range?.model ?? -1;
    };
    const conditions = session.weather.conditions;
    expect(modelOf()).toBe(FIGURE_MODEL_GUEST);
    guest.souvenirs = 1; // umbrella
    expect(modelOf(), 'dry weather keeps it folded').toBe(FIGURE_MODEL_GUEST);
    conditions.weatherKind = 'rain';
    conditions.weatherIntensity = 1;
    expect(modelOf()).toBe(FIGURE_MODEL_GUEST_UMBRELLA);
    guest.souvenirs = 4 | 2; // balloon and hat: the balloon shows
    expect(modelOf()).toBe(FIGURE_MODEL_GUEST_BALLOON);
    guest.souvenirs = 2;
    expect(modelOf()).toBe(FIGURE_MODEL_GUEST_HAT);
    guest.souvenirs = 16;
    expect(modelOf(), 'a glow wand in daylight is not drawn').toBe(FIGURE_MODEL_GUEST);
    conditions.night = true;
    expect(modelOf()).toBe(FIGURE_MODEL_GUEST_GLOW);
    guest.souvenirs = 8;
    expect(modelOf()).toBe(FIGURE_MODEL_GUEST_PLUSH);
  });

  it('a sun hat shows the guest accent colour on its crown', () => {
    const session = quietPark(4);
    const [guest] = [...session.guests.guests.values()];
    steerGuest(guest, 15, 28, null);
    guest.souvenirs = 2;
    const frame = createFigurePacker(palette).pack(session, 0.5);
    const range = frame.ranges[FIGURE_MODEL_GUEST_HAT];
    expect(range.entityCount).toBe(1);
    const word = recordAt(frame, range.firstEntity).paletteWord;
    expect((word >>> 8) & 255).toBe(palette.material(guest.accent));
  });
});
