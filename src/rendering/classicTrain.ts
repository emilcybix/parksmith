import { Container, Graphics } from 'pixi.js';
import { coasterCarSeats, COASTER_MAX_SEATS_PER_CAR } from './coasterCarFrame';
import { classicViewVector } from './classicCoaster';
import { ridePaintFor } from './classicPaint';
import type { ObjectColours } from '../game/content/colours';
import { createSegment } from './parts';

/**
 * The classic renderer's coaster train (Phase 27 step 3): cars built once from Pixi graphics and
 * moved every frame by transform alone (position, rotation, one small offset and one visibility flag).
 * Deliberately simpler than the voxel train, the same recipe:
 * - a clear front: the lead car is longer, has a nose cone, a headlight and a fin in the type's style;
 * - each car has a hull with a darker underside, two bogies (wheel pairs) peeking out below, two seat
 *   rows with backs and a lap bar, and a coupling bar between cars (drawn by the renderer, see
 *   `CLASSIC_CAR_*`);
 * - riders are small dots on the seats, one per seat of the car (coasterCarFrame.ts `coasterCarSeats`),
 *   shown on the cars `coasterLoadedCars` names while the ride runs (`setClassicLoadedCars`), the same
 *   cars the voxel view fills;
 * - orientation: the car sits on the shared car frame (coasterCarFrame.ts, the bogie chord and the
 *   banked up axis, as the voxel cars): its rotation is the screen angle of the car's forward axis (so
 *   it pitches with slope), and banking leans the upper part (seats, riders) by `classicCarLean`.
 * Nothing here draws after construction.
 */

export type ClassicTrainStyle = 'comet-trail' | 'star-chaser' | 'skyline-serpent';

/** Half length of a lead car and of the following cars, screen px (the coupling attaches at the ends). */
export const CLASSIC_LEAD_HALF = 8;
export const CLASSIC_CAR_HALF = 6;
/** Seat rows per car. */
export const CLASSIC_SEAT_ROWS = 2;
/** Screen px of lean per unit of sideways shift of the cross-section's up vector (about 3 px at a steep bank). */
export const CLASSIC_LEAN_PX = 7;

const COUPLING_COLOR = 0x2b2d42;
const WHEEL_COLOR = 0x20232d;
const TYRE_COLOR = 0xe8ecf1;
const SEAT_COLOR = 0xfff1d6;
const BAR_COLOR = 0xe9edf2;
const RIDER_COLORS = [0xff5d73, 0x4cc9f0, 0xffd166, 0x7bd88f, 0xb388ff, 0xff9f43] as const;

/** What a train is drawn from: colours and proportions. The three shipped styles are values of it. */
export interface ClassicTrainSpec {
  /** Lead car hull. */
  lead: number;
  /** Following cars' hull. */
  body: number;
  /** Stripe and fin accent. */
  accent: number;
  /** Nose length in px (lead car), and whether it is pointed (otherwise rounded). */
  nose: number;
  pointed: boolean;
  /** Hull half width of a car (px). */
  halfWidth: number;
  /** Two-tone: following cars alternate between body and lead colours. */
  alternate: boolean;
}

const STYLES: Readonly<Record<ClassicTrainStyle, ClassicTrainSpec>> = {
  // Family coaster: short blunt cars in warm red, a round nose, wide.
  'comet-trail': { lead: 0xff6a3d, body: 0xffb24a, accent: 0xfff4c9, nose: 3, pointed: false, halfWidth: 3.8, alternate: true },
  // Thrill coaster: purple cars, a pointed nose and a cyan stripe.
  'star-chaser': { lead: 0x8a5cf0, body: 0x6f48d9, accent: 0x61e7d3, nose: 5, pointed: true, halfWidth: 3.4, alternate: false },
  // Looping coaster: slim teal cars, a long sharp nose and a yellow fin.
  'skyline-serpent': { lead: 0x1fb5aa, body: 0x178f87, accent: 0xf5f06c, nose: 7, pointed: true, halfWidth: 3, alternate: false },
};

export const classicTrainStyle = (definitionId: string | undefined): ClassicTrainStyle =>
  definitionId === 'star-chaser' || definitionId === 'skyline-serpent' ? definitionId : 'comet-trail';

/**
 * The train of a coaster with its colour record (Phase 28): Train (primary) is the hull (the lead car's tone
 * follows it, `RidePaint.tone`), Seats (secondary) the stripe and fin. A record with nothing set answers the
 * shipped style itself. Seats' and wheels' own colours, the couplings and the riders stay fixed.
 */
export const classicTrainSpec = (definitionId: string | undefined, colours: ObjectColours | null): ClassicTrainSpec => {
  const base = STYLES[classicTrainStyle(definitionId)];
  if (!colours || !definitionId) return base;
  const paint = ridePaintFor(definitionId, colours);
  if (!paint.isSet('primary') && !paint.isSet('secondary')) return base;
  return {
    ...base,
    body: paint('primary', base.body),
    lead: paint.tone('primary', base.lead, base.body),
    accent: paint('secondary', base.accent),
  };
};

/** One car: `root` is moved and rotated per frame, `upper` is leaned, `riders` is shown while running. */
export interface ClassicCar {
  root: Container;
  upper: Container;
  riders: Container;
  /** Half length along the tangent: where the coupling attaches. */
  halfLength: number;
}

export interface ClassicTrain {
  container: Container;
  cars: ClassicCar[];
  couplings: Graphics[];
  /** Cars, front first, that show their riders (coasterLoadedCars). */
  loadedCars: number;
  /** Rider capacity of the train (the type's), spread over the cars as seats. */
  capacity: number;
}

/** What the lean reads of a car's frame: its banking and its (rolled) up and left axes. */
export interface ClassicLeanFrame {
  roll: number;
  upX: number;
  upY: number;
  upZ: number;
  leftX: number;
  leftY: number;
  leftZ: number;
}

const leanScratch = { x: 0, y: 0 };

/**
 * Sideways lean of the car's upper part, in car-local px (+y = to the right of the screen travel
 * direction rotated by `rotation`): the screen shift of the banked up vector B′ against the unbanked
 * one. Writes into `out` (x, y) and returns it; no allocation. `frame` is a car frame
 * (coasterCarFrame.ts) whose `left` is the banked normal N′. Cheap scalars only.
 */
export const classicCarLean = (
  frame: ClassicLeanFrame,
  rotation: number,
  out: { x: number; y: number },
): { x: number; y: number } => {
  // Unbanked up: B = B′ rotated back by −roll about T; the shift is B′ − B = (cos φ − 1)·B + sin φ·N,
  // expressed with the banked pair: B′ − B = (1 − cos φ)·... computed directly from N′ and B′:
  // B = cos φ B′ + sin φ N′, so B′ − B = (1 − cos φ) B′ − sin φ N′.
  const sine = Math.sin(frame.roll);
  const gain = 1 - Math.cos(frame.roll);
  const shiftX = gain * frame.upX - sine * frame.leftX;
  const shiftY = gain * frame.upY - sine * frame.leftY;
  const shiftZ = gain * frame.upZ - sine * frame.leftZ;
  // The shift is a world-plan vector: the active view turns it before the isometric projection.
  const view = classicViewVector(shiftX, shiftY, leanScratch);
  const screenX = (view.x - view.y) * 0.5;
  const screenY = (view.x + view.y) * 0.25 - shiftZ * 0.5;
  const cosine = Math.cos(rotation);
  const sineRot = Math.sin(rotation);
  // Into the car's local axes (rotate by −rotation).
  out.x = (screenX * cosine + screenY * sineRot) * CLASSIC_LEAN_PX;
  out.y = (-screenX * sineRot + screenY * cosine) * CLASSIC_LEAN_PX;
  return out;
};

const hullPoints = (half: number, width: number, nose: number, pointed: boolean): number[] => {
  const tail = -half;
  const shoulder = half;
  if (nose <= 0) return [tail, -width, shoulder, -width, shoulder, width, tail, width];
  const tip = shoulder + nose;
  return pointed
    ? [tail, -width, shoulder, -width, tip, 0, shoulder, width, tail, width]
    : [tail, -width, shoulder, -width, tip, -width * 0.45, tip, width * 0.45, shoulder, width, tail, width];
};

const createCar = (style: ClassicTrainSpec, lead: boolean, index: number, riderSeats: number): ClassicCar => {
  const half = lead ? CLASSIC_LEAD_HALF : CLASSIC_CAR_HALF;
  const width = style.halfWidth;
  const hull = lead || !style.alternate || index % 2 === 0 ? (lead ? style.lead : style.body) : style.lead;
  const root = new Container();

  // Bogies and wheels first: they sit below (screen-lower edge of) the hull.
  const wheels = new Graphics();
  for (const at of [-half * 0.55, half * 0.55]) {
    wheels.roundRect(at - 2.2, width - 0.6, 4.4, 2.6, 1).fill(WHEEL_COLOR);
    wheels.circle(at, width + 0.9, 1.1).fill(TYRE_COLOR);
  }
  root.addChild(wheels);

  // Hull: a darker underside strip and the lit body on top.
  const body = new Graphics();
  body.poly(hullPoints(half, width, lead ? style.nose : 0, style.pointed))
    .fill(hull).stroke({ color: 0xffffff, width: 1 });
  body.rect(-half + 1, width - 1.4, half * 2 - 1, 1.4).fill({ color: 0x000000, alpha: 0.25 });
  body.rect(-half + 1, -0.6, half * 2, 1.2).fill(style.accent);
  if (lead) {
    // Headlight on the nose and a fin: the front reads at once.
    body.circle(half + style.nose - 1.2, 0, 1.5).fill(0xfff7c2);
    body.poly([-half + 1, -width, -half + 4, -width - 3.2, half - 2, -width]).fill(style.accent);
  }
  root.addChild(body);

  // Upper part (seat backs, lap bar, riders): leaned by banking.
  const upper = new Container();
  const seats = new Graphics();
  const seatBack = half * 2 / CLASSIC_SEAT_ROWS;
  for (let row = 0; row < CLASSIC_SEAT_ROWS; row += 1) {
    const x = -half + 1.4 + row * seatBack;
    seats.roundRect(x, -width + 0.8, 2, width * 2 - 1.6, 0.8).fill(SEAT_COLOR);
  }
  // A lap bar across each seat row, in front of the seat back.
  for (let row = 0; row < CLASSIC_SEAT_ROWS; row += 1) {
    const x = -half + 1.4 + row * seatBack + 3.2;
    seats.moveTo(x, -width + 1).lineTo(x, width - 1).stroke({ color: BAR_COLOR, width: 0.9 });
  }
  upper.addChild(seats);
  const riders = new Container();
  const dots = new Graphics();
  // One dot per seat, front row first (left, right), like the voxel riders; a lone rider sits mid-row.
  for (let seat = 0; seat < Math.min(riderSeats, COASTER_MAX_SEATS_PER_CAR); seat += 1) {
    const row = CLASSIC_SEAT_ROWS - 1 - Math.floor(seat / 2);
    const x = -half + 2.8 + row * seatBack + 1.2;
    const side = riderSeats === 1 ? 0 : seat % 2 === 0 ? -1 : 1;
    const color = RIDER_COLORS[(index * 3 + seat) % RIDER_COLORS.length];
    dots.circle(x, side * width * 0.42, 1.55).fill(color);
  }
  riders.addChild(dots);
  riders.visible = false;
  upper.addChild(riders);
  root.addChild(upper);
  return { root, upper, riders, halfLength: half };
};

/**
 * Cars point along +x so one rotation puts each on the track. Built once. `capacity` is the train's
 * rider capacity: each car gets its share of seats (coasterCarSeats) as rider dots.
 */
export const createClassicTrain = (carCount: number, style: ClassicTrainStyle | ClassicTrainSpec, capacity = carCount * 2): ClassicTrain => {
  const spec = typeof style === 'string' ? STYLES[style] : style;
  const container = new Container();
  const couplings = Array.from({ length: Math.max(0, carCount - 1) }, () => {
    const segment = createSegment(COUPLING_COLOR, 2.2);
    container.addChild(segment);
    return segment;
  });
  const cars = Array.from({ length: carCount }, (_unused, index) => {
    const car = createCar(spec, index === 0, index, coasterCarSeats(index, capacity, carCount));
    container.addChild(car.root);
    return car;
  });
  return { container, cars, couplings, loadedCars: 0, capacity };
};

/**
 * Cars 0 … `loadedCars − 1` show their riders (coasterLoadedCars: 0 unless the ride runs with someone
 * aboard); an integer compare per frame, visibility writes only when it changes.
 */
export const setClassicLoadedCars = (train: ClassicTrain, loadedCars: number): void => {
  if (train.loadedCars === loadedCars) return;
  train.loadedCars = loadedCars;
  for (let index = 0; index < train.cars.length; index += 1) train.cars[index].riders.visible = index < loadedCars;
};
