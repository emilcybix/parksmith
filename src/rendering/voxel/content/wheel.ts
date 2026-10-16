import { COLOUR_SLOT_TAG } from '../../../game/content/colours';
import type { BuildDefinition } from '../../../game/types';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT, slotted } from '../contracts/blueprint';
import type { Blueprint, BlueprintPart, LightSource, Shape, Vec3 } from '../contracts/blueprint';
import type { ObjectContent } from '../contracts/content';
import { MAT, MAT_COLOR, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { restPose } from '../contracts/rigid';
import type { PartDriver } from '../contracts/rigid';
import { PLOT_TOP_Z } from '../contracts/space';

/**
 * Bespoke aurora-wheel (4×3 tiles, 128 × 96 voxels): an observation wheel on two steel A-frames.
 *
 * The disc stands in the vertical plane of the plot's long axis (model x) and turns about the
 * short axis (model y), so the whole wheel faces the camera in both visual quarter turns — the
 * camera sees model +y at q0 and world +x (= model +y) at q1. Everything that moves sits on the
 * model +y side of the rim: the twelve cabins hang in FRONT of it, never behind the spokes.
 *
 * Parts: 'body' (platform, A-frames, bearings, boarding deck, operator booth), 'wheel' (rim, inner
 * ring, spokes, bulbs, hub and axle — one rigid part turning about the hub), and 'cabin-0' …
 * 'cabin-11'. Cabins are separate parts because they stay level: their drivers only translate them
 * along the circle their rim point travels, so a cabin never tilts however far the wheel has turned.
 *
 * The parts are laid out along y so nothing can collide in motion, whatever the angle: back A-frame
 * y 25–30, rim and spokes y 40–44, cabins y 44–56 (their arms touch the rim's front face), front
 * A-frame y 64–69; the axle runs y 30–64 and meets both bearings face to face.
 */

const TAU = Math.PI * 2;

/** Top of the 4-voxel ride platform (art bible: rides stand on a platform 4 voxels tall). */
const DECK_TOP_Z = PLOT_TOP_Z + 4;

/** Hub centre (model space). The disc's plane is y = 42; the rim occupies y 40–44. */
export const WHEEL_HUB: Vec3 = [64, 42, 82];
const [HUB_X, HUB_Y, HUB_Z] = WHEEL_HUB;

/** Middle radius of the rim; its outer edge is WHEEL_OUTER_RADIUS. */
export const WHEEL_RIM_RADIUS = 54;
const RIM_THICKNESS = 4;
const RIM_WIDTH = 4;
/** Art bible: radius ≤ 56, so the 4-tile plot holds the wheel with room for the cabins' swing. */
export const WHEEL_OUTER_RADIUS = WHEEL_RIM_RADIUS + RIM_THICKNESS / 2;
/** The rim's front face (model y); cabin arms end exactly on it. */
const RIM_FRONT_Y = HUB_Y + RIM_WIDTH / 2;
const INNER_RING_RADIUS = 44;
/**
 * 1.25 around the disc plane y = 42 (a voxel boundary) fills exactly two voxel rows in y and two
 * to three across the spoke in-plane: every spoke stays ≥ 2 voxels thick in both cross-section
 * axes, the minimum for a feature that rotates at one texel per voxel.
 */
const SPOKE_RADIUS = 1.25;
const HUB_RADIUS = 6;
const AXLE_RADIUS = 3;
/** The axle turns with the wheel and ends face to face on the two static bearings. */
const AXLE_FROM_Y = 30;
const AXLE_TO_Y = 64;
/** Legacy (rideArt.ts createAuroraWheel): `wheel.rotation = spin * 0.00045`. */
export const WHEEL_SPIN_RADIANS_PER_MS = 0.00045;
export const WHEEL_CABIN_COUNT = 12;
/** Bulbs sit between the cabin arms (7.5° off every 15°), so no arm ever hides one. */
const BULB_COUNT = 24;
/** Art bible: ride bulbs light radius 16; lit windows 28. */
const RIDE_BULB_LIGHT_RADIUS = 16;
const WINDOW_LIGHT_RADIUS = 28;
const EVENING = LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT;

/** A-frame legs: 3×3 steps, 2 voxels tall, 1 voxel along x per step (see `legSteps`). */
const LEG_STEPS = 36;
const LEG_SIZE = 3;
const BACK_LEG_Y = 26;
const FRONT_LEG_Y = 65;
/** Bearings hold the axle ends; the top leg step meets their underside. */
const BEARING_MIN_X = HUB_X - 4;
const BEARING_MIN_Z = DECK_TOP_Z + 2 * LEG_STEPS;

/** Rest position of cabin i: the rim point at angle i · 30°, measured from +x toward +z. */
const cabinAngle = (index: number): number => (index / WHEEL_CABIN_COUNT) * TAU;

/**
 * Integer pivots of the cabins (the rim points they hang from, rounded to whole voxels so the
 * compiler accepts them). Cabin 0 is at the far right, 3 at the top, 6 at the left and 9 at the
 * bottom, above the boarding deck.
 */
export const WHEEL_CABIN_PIVOTS: readonly Vec3[] = Array.from({ length: WHEEL_CABIN_COUNT }, (_unused, index): Vec3 => [
  Math.round(HUB_X + Math.cos(cabinAngle(index)) * WHEEL_RIM_RADIUS),
  HUB_Y,
  Math.round(HUB_Z + Math.sin(cabinAngle(index)) * WHEEL_RIM_RADIUS),
]);

export const wheelCabinPartId = (index: number): string => `cabin-${index}`;

/**
 * The wheel's angle for a spin value, in radians about +y. A positive turn about +y carries the
 * top of the wheel toward +x, which is clockwise on screen at both quarter turns — the direction
 * the classic wheel turns. Reduced modulo a full turn so float32 transforms stay precise however
 * long the park runs.
 */
export const wheelAngle = (spin: number): number => (spin * WHEEL_SPIN_RADIANS_PER_MS) % TAU;

const box = (min: Vec3, size: Vec3, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'box', min, size, material, pattern });

/**
 * One A-frame leg as a staircase of LEG_SIZE² steps two voxels tall, shifting one voxel along x
 * per step. An exact 1:2 slope draws as an even stair of texels in the 2:1 projection (a voxelized
 * slanted cylinder leaves a ragged edge) and costs one box per step. `footX` is the bottom step's
 * minimum x; `direction` is +1 for a leg leaning right as it rises, −1 for one leaning left.
 */
const legSteps = (footX: number, direction: 1 | -1, y: number): Shape[] =>
  Array.from({ length: LEG_STEPS }, (_unused, step) =>
    box([footX + direction * step, y, DECK_TOP_Z + 2 * step], [LEG_SIZE, LEG_SIZE, 2], MAT.STEEL));

const LEFT_FOOT_X = BEARING_MIN_X - 1 - (LEG_STEPS - 1);
const RIGHT_FOOT_X = 2 * HUB_X - LEG_SIZE - LEFT_FOOT_X;

/** Two legs, a bearing on the axle end, a tie beam and foot pads: one A-frame at `legY`. */
const aFrame = (legY: number, bearingY: number): Shape[] => [
  box([LEFT_FOOT_X - 2, legY - 2, DECK_TOP_Z], [LEG_SIZE + 4, LEG_SIZE + 4, 2], MAT.STEEL),
  box([RIGHT_FOOT_X - 2, legY - 2, DECK_TOP_Z], [LEG_SIZE + 4, LEG_SIZE + 4, 2], MAT.STEEL),
  ...legSteps(LEFT_FOOT_X, 1, legY),
  ...legSteps(RIGHT_FOOT_X, -1, legY),
  // Tie beam between the legs, level with step 14 (z 33–35).
  box([LEFT_FOOT_X + 14 + LEG_SIZE, legY, DECK_TOP_Z + 28], [RIGHT_FOOT_X - LEFT_FOOT_X - 28 - LEG_SIZE, LEG_SIZE, 2], MAT.STEEL_LIGHT),
  box([BEARING_MIN_X, bearingY, BEARING_MIN_Z], [8, 5, 10], MAT.STEEL, PATTERN.METAL),
];

/** Point at `angle` on a circle of `radius` around the hub, in the disc plane (x, z). */
const discPoint = (angle: number, radius: number): [number, number] => [
  HUB_X + Math.cos(angle) * radius,
  HUB_Z + Math.sin(angle) * radius,
];

const bodyShapes = (color: number, accent: number): Shape[] => [
  // The 4-voxel ride platform; its x edges (6, 122) fall inside cobbles, never on a gap line.
  box([6, 12, PLOT_TOP_Z], [116, 74, DECK_TOP_Z - PLOT_TOP_Z], MAT.CONCRETE, PATTERN.COBBLE),
  ...aFrame(BACK_LEG_Y, AXLE_FROM_Y - 5),
  ...aFrame(FRONT_LEG_Y, AXLE_TO_Y),
  // Boarding deck under the bottom cabin, with a step down toward the front (+y).
  box([52, 46, DECK_TOP_Z], [24, 16, 4], MAT.WOOD, PATTERN.PLANKS),
  box([56, 62, DECK_TOP_Z], [16, 3, 2], MAT.WOOD, PATTERN.PLANKS),
  // Operator booth at the front left: steel walls, an accent band, a roof in the ride colour
  // and a lit window on the front (+y) face.
  box([8, 70, DECK_TOP_Z], [12, 12, 14], MAT.STEEL, PATTERN.METAL),
  box([8, 70, DECK_TOP_Z + 10], [12, 12, 2], accent),
  box([7, 69, DECK_TOP_Z + 14], [14, 14, 2], color),
  // Framed on every side by the WINDOW lattice: x 8–16 and z 8–12 are multiples of 4.
  box([8, 81, 8], [9, 1, 5], MAT.GLASS, PATTERN.WINDOW),
];

const wheelShapes = (color: number, accent: number): Shape[] => [
  // Axle first: the hub is written over its middle.
  { kind: 'cylinder', base: [HUB_X, AXLE_FROM_Y, HUB_Z], radius: AXLE_RADIUS, length: AXLE_TO_Y - AXLE_FROM_Y, axis: 'y', material: MAT.STEEL_LIGHT },
  { kind: 'cylinder', base: [HUB_X, HUB_Y - 4, HUB_Z], radius: HUB_RADIUS, length: 8, axis: 'y', material: MAT.STEEL },
  { kind: 'cylinder', base: [HUB_X, HUB_Y + 4, HUB_Z], radius: AXLE_RADIUS, length: 2, axis: 'y', material: accent },
  { kind: 'ring', center: WHEEL_HUB, radius: WHEEL_RIM_RADIUS, thickness: RIM_THICKNESS, width: RIM_WIDTH, axis: 'y', material: color },
  { kind: 'ring', center: WHEEL_HUB, radius: INNER_RING_RADIUS, thickness: 2, width: 2, axis: 'y', material: color },
  ...Array.from({ length: WHEEL_CABIN_COUNT }, (_unused, index): Shape => {
    const [fromX, fromZ] = discPoint(cabinAngle(index), HUB_RADIUS);
    const [toX, toZ] = discPoint(cabinAngle(index), WHEEL_RIM_RADIUS - RIM_THICKNESS / 2);
    return { kind: 'segment', from: [fromX, HUB_Y, fromZ], to: [toX, HUB_Y, toZ], radius: SPOKE_RADIUS, material: accent };
  }),
  // Bulbs set into the front half of the rim, flush with its face.
  ...Array.from({ length: BULB_COUNT }, (_unused, index): Shape => {
    const [x, z] = discPoint(((index + 0.5) / BULB_COUNT) * TAU, WHEEL_RIM_RADIUS);
    return box([Math.round(x) - 1, HUB_Y, Math.round(z) - 1], [2, 2, 2], MAT.BULB);
  }),
];

/**
 * A cabin hanging from rim point `pivot`: an arm from the rim's front face, a hanger, a roof in
 * the ride colour, and a body with a window band all round (the camera sees model +y and +x at
 * q0, model +y and −x at q1). Part-local window lattice: frames at x −4, 0, 4, y 4, 8, 12 and
 * z −12 (the roof closes the top), so both faces show two framed 3×3 panes.
 */
const cabinShapes = (pivot: Vec3, color: number, bodyMaterial: number): Shape[] => {
  const [x, y, z] = pivot;
  return [
    box([x - 1, RIM_FRONT_Y, z - 1], [2, y + 9 - RIM_FRONT_Y, 2], MAT.STEEL_LIGHT),
    box([x - 1, y + 7, z - 6], [2, 2, 5], MAT.STEEL_LIGHT),
    box([x - 5, y + 3, z - 8], [11, 11, 2], color),
    box([x - 4, y + 4, z - 17], [9, 9, 9], bodyMaterial),
    box([x - 4, y + 4, z - 12], [9, 9, 4], MAT.GLASS, PATTERN.WINDOW),
  ];
};

const lights = (): LightSource[] => [
  // The bulbs turn with the rim but lights are static: a ring of pools between the cabins at
  // rest reads the same at every angle, because the bulbs are evenly spaced around it.
  ...Array.from({ length: WHEEL_CABIN_COUNT }, (_unused, index): LightSource => {
    const [x, z] = discPoint(((index + 0.5) / WHEEL_CABIN_COUNT) * TAU, WHEEL_RIM_RADIUS);
    return { position: [x, RIM_FRONT_Y + 1, z], radius: RIDE_BULB_LIGHT_RADIUS, color: MAT_COLOR.BULB, presets: EVENING };
  }),
  { position: [12.5, 83, 10.5], radius: WINDOW_LIGHT_RADIUS, color: MAT_COLOR.WINDOW_GLOW, presets: EVENING },
];

const hex = (rgb: number): string => rgb.toString(16).padStart(6, '0');

/** Builds the aurora-wheel blueprint. Deterministic: same definition and palette, same blueprint. */
export const buildAuroraWheel = (definition: BuildDefinition, palette: Palette): Blueprint => {
  // Phase 28 colour slots (game/content/colours.ts): primary, secondary, and trim = the cream cabins.
  const color = slotted(palette.material(definition.color), COLOUR_SLOT_TAG.primary);
  const accent = slotted(palette.material(definition.accent), COLOUR_SLOT_TAG.secondary);
  const cream = slotted(MAT.CANVAS, COLOUR_SLOT_TAG.trim);
  const cabins = WHEEL_CABIN_PIVOTS.map((pivot, index): BlueprintPart => ({
    id: wheelCabinPartId(index),
    pivot,
    // Legacy alternates cream and accent cabins, starting with cream.
    shapes: cabinShapes(pivot, color, index % 2 === 0 ? cream : accent),
  }));
  return {
    id: `wheel:${definition.id}:${hex(definition.color)}:${hex(definition.accent)}`,
    footprint: definition.footprint,
    parts: [
      { id: 'body', pivot: [0, 0, 0], shapes: bodyShapes(color, accent) },
      { id: 'wheel', pivot: WHEEL_HUB, shapes: wheelShapes(color, accent) },
      ...cabins,
    ],
    lights: lights(),
  };
};

/** Turns the wheel part about +y by the wheel angle; at rest while the machine is stopped. */
const wheelDriver: PartDriver = (motion, out) => {
  restPose(out);
  if (motion.motion === 0) return;
  const half = wheelAngle(motion.spin) / 2;
  out.qy = Math.sin(half);
  out.qw = Math.cos(half);
};

/**
 * Keeps a cabin on its rim point: offset = R_y(angle) · r − r for the cabin's rest vector r from
 * the hub, with the identity rotation, so the cabin rides the rim and stays level. R_y is the
 * rotation the wheel's quaternion applies, so arm and rim never part. Allocation-free: the rest
 * vector is captured once, at module load.
 */
const cabinDriver = (pivot: Vec3): PartDriver => {
  const restX = pivot[0] - HUB_X;
  const restZ = pivot[2] - HUB_Z;
  return (motion, out) => {
    restPose(out);
    if (motion.motion === 0) return;
    const angle = wheelAngle(motion.spin);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    out.dx = restX * cos + restZ * sin - restX;
    out.dz = restZ * cos - restX * sin - restZ;
  };
};

const drivers: Record<string, PartDriver> = { wheel: wheelDriver };
WHEEL_CABIN_PIVOTS.forEach((pivot, index) => {
  drivers[wheelCabinPartId(index)] = cabinDriver(pivot);
});

export const auroraWheel: ObjectContent = {
  blueprint: buildAuroraWheel,
  drivers,
};
