import { COLOUR_SLOT_TAG } from '../../../game/content/colours';
import type { BuildDefinition } from '../../../game/types';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT, slotted } from '../contracts/blueprint';
import type { Blueprint, LightSource, Shape, Vec3 } from '../contracts/blueprint';
import type { ObjectContent } from '../contracts/content';
import { MAT, MAT_COLOR, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { restPose } from '../contracts/rigid';
import type { PartDriver } from '../contracts/rigid';
import { PLOT_TOP_Z } from '../contracts/space';

/**
 * Bespoke cloud-hopper (3×3 tiles, 96 × 96 voxels): a family drop tower. A steel lattice mast
 * around a core in the ride colour carries a winch house and a glowing beacon; a ring car in the
 * ride colour, eight seats facing outward, hugs the mast and makes one trip per ride cycle.
 *
 * Everything is centred on (48, 48), a voxel boundary, so every round shape voxelizes mirror-
 * symmetrically and looks the same at both visual quarter turns. Parts: 'body' (platform, mast,
 * winch house, beacon, landing buffers, operator booth) and 'car', which only ever moves along z:
 * its voxel columns sit outside the mast's (the ring's inner radius clears the mast's corners), so
 * it can never touch the body at any height, and its highest point stays under the winch house.
 *
 * The map turns (Phase 26), so every side of the mast is seen from some view: the lattice's braces
 * and rungs run round all four faces, and the core closes the mast so nothing shows through.
 */

/** Plot centre on both axes (the footprint is 3 × 32 voxels square). */
const CENTRE = 48;

/** Top of the 4-voxel ride platform (art bible: rides stand on a platform 4 voxels tall). */
const DECK_TOP_Z = PLOT_TOP_Z + 4;
const PLATFORM_RADIUS = 40;

/**
 * Mast: 14 × 14 outside with 2 × 2 corner posts. The core in the ride colour sits one voxel behind
 * the posts' outer faces, and the lattice (rungs and X braces, 1 voxel deep) fills that outer layer:
 * a 1-voxel step stays unoutlined (gbuffer.ts), so the braces read as light steel on the coloured
 * core instead of dissolving into outline texels, and the core keeps the tower in the ride colour.
 */
const MAST_MIN = CENTRE - 7;
const MAST_MAX = CENTRE + 7;
const POST_SIZE = 2;
const CORE_MIN = MAST_MIN + 1;
const CORE_MAX = MAST_MAX - 1;
/** The lattice's panels span the gap between two posts. */
const PANEL_MIN = MAST_MIN + POST_SIZE;
const PANEL_SIZE = MAST_MAX - MAST_MIN - 2 * POST_SIZE;
/** One storey: a 2-voxel rung under a PANEL_SIZE² panel with an X brace. */
const RUNG_HEIGHT = 2;
const STOREY_HEIGHT = RUNG_HEIGHT + PANEL_SIZE;
const STOREYS = 10;
/** The top rung closes the last storey; the winch house sits on it. */
export const CLOUD_HOPPER_MAST_TOP_Z = DECK_TOP_Z + STOREYS * STOREY_HEIGHT + RUNG_HEIGHT;

/** Legacy (rideArt.ts createCloudHopper): the car travels 104 px, resting 6 px above the ground. */
export const CLOUD_HOPPER_CAR_TRAVEL = 104;
export const CLOUD_HOPPER_CAR_REST_Z = PLOT_TOP_Z + 6;
/**
 * The car's ring: the inner radius clears the mast's corners (7√2 ≈ 9.9 from the axis) by a
 * voxel, the outer radius makes it about as wide on screen as the classic car (52 px).
 */
const CAR_INNER_RADIUS = 11;
const CAR_OUTER_RADIUS = 20;
const CAR_BAND_HEIGHT = 2;
const CAR_DECK_Z = CLOUD_HOPPER_CAR_REST_Z + 2 * CAR_BAND_HEIGHT;
const SEAT_COUNT = 8;
const SEAT_RING_RADIUS = 14;
const SEAT_SIZE = 4;
/** A seat's back rises under its shoulder restraint; its pan stays low, facing out. */
const SEAT_BACK_HEIGHT = 6;
const SEAT_PAN_HEIGHT = 2;
const RESTRAINT_HEIGHT = 2;
/** Bulb centres sit a voxel and a half inside the deck's outer edge, between the seats. */
const CAR_BULB_RADIUS = CAR_OUTER_RADIUS - 1.5;
/** Landing buffers sit on the diagonals under the ring's middle (11√2 ≈ 15.5 from the axis). */
const BUFFER_OFFSET = 11;
const BUFFER_SIZE = 4;

const EVENING = LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT;
/** Art bible: ride bulbs (the beacon) light radius 16; lit windows 28. */
const RIDE_BULB_LIGHT_RADIUS = 16;
const WINDOW_LIGHT_RADIUS = 28;

/**
 * Winch house on the mast top: a steel slab overhanging the mast by 2 voxels (the car stops below
 * it), a house in the ride colour set 1 voxel in from the mast, a steel roof flush with the mast,
 * then the beacon lantern.
 */
const HOUSE_SLAB_OVERHANG = 2;
const HOUSE_INSET = 1;
const HOUSE_SLAB_Z = CLOUD_HOPPER_MAST_TOP_Z;
const HOUSE_Z = HOUSE_SLAB_Z + 2;
const HOUSE_HEIGHT = 6;
const HOUSE_ROOF_Z = HOUSE_Z + HOUSE_HEIGHT;
const BEACON_Z = HOUSE_ROOF_Z + 2;
const BEACON_HEIGHT = 4;
const BEACON_SIZE = 6;

/**
 * Operator booth on the model +y axis, in front of the car: it then stands front left of the tower
 * at quarter turn 0 and front right at quarter turn 1, beside the car in both views rather than in
 * front of it. 13 voxels wide so its framed window (x 44–52) is centred.
 */
const BOOTH_MIN_X = 42;
const BOOTH_MIN_Y = 74;
const BOOTH_WIDTH = 13;
const BOOTH_DEPTH = 12;
const BOOTH_HEIGHT = 14;
const BOOTH_FRONT_Y = BOOTH_MIN_Y + BOOTH_DEPTH;

const box = (min: Vec3, size: Vec3, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'box', min, size, material, pattern });

/**
 * One X brace in a PANEL_SIZE² panel, one voxel per row: row j of diagonal A covers columns j − 1
 * and j (2 voxels thick), diagonal B mirrors it. `run(u, uSize, z)` places a run of the panel's own
 * column axis (along the face) at height z.
 */
const crossBrace = (run: (u: number, uSize: number, z: number) => Shape, panelZ: number): Shape[] => {
  const shapes: Shape[] = [];
  for (let row = 0; row < PANEL_SIZE; row += 1) {
    const from = Math.max(0, row - 1);
    const mirrorFrom = PANEL_SIZE - 1 - row;
    const mirrorTo = Math.min(PANEL_SIZE, PANEL_SIZE + 1 - row);
    if (mirrorFrom <= row + 1 && from <= mirrorTo) {
      // The two diagonals touch or cross on this row: one run.
      const start = Math.min(from, mirrorFrom);
      shapes.push(run(start, Math.max(row + 1, mirrorTo) - start, panelZ + row));
    } else {
      shapes.push(run(from, row + 1 - from, panelZ + row));
      shapes.push(run(mirrorFrom, mirrorTo - mirrorFrom, panelZ + row));
    }
  }
  return shapes;
};

/**
 * The four mast faces (model +y, −y, +x and −x; a turned view shows any two of them), each placing a
 * run [u, u + uSize) along the face at height z, `height` voxels tall, in the lattice's outer layer.
 */
const LATTICE_FACES: readonly ((u: number, uSize: number, z: number, height: number) => Shape)[] = [
  (u, uSize, z, height) => box([PANEL_MIN + u, CORE_MAX, z], [uSize, 1, height], MAT.STEEL_LIGHT),
  (u, uSize, z, height) => box([PANEL_MIN + u, MAST_MIN, z], [uSize, 1, height], MAT.STEEL_LIGHT),
  (u, uSize, z, height) => box([CORE_MAX, PANEL_MIN + u, z], [1, uSize, height], MAT.STEEL_LIGHT),
  (u, uSize, z, height) => box([MAST_MIN, PANEL_MIN + u, z], [1, uSize, height], MAT.STEEL_LIGHT),
];

const mastShapes = (color: number): Shape[] => {
  const height = CLOUD_HOPPER_MAST_TOP_Z - DECK_TOP_Z;
  const shapes: Shape[] = [box([CORE_MIN, CORE_MIN, DECK_TOP_Z], [CORE_MAX - CORE_MIN, CORE_MAX - CORE_MIN, height], color)];
  for (const x of [MAST_MIN, MAST_MAX - POST_SIZE]) {
    for (const y of [MAST_MIN, MAST_MAX - POST_SIZE]) shapes.push(box([x, y, DECK_TOP_Z], [POST_SIZE, POST_SIZE, height], MAT.STEEL));
  }
  for (const face of LATTICE_FACES) {
    for (let storey = 0; storey <= STOREYS; storey += 1) {
      const rungZ = DECK_TOP_Z + storey * STOREY_HEIGHT;
      shapes.push(face(0, PANEL_SIZE, rungZ, RUNG_HEIGHT));
      if (storey < STOREYS) shapes.push(...crossBrace((u, uSize, z) => face(u, uSize, z, 1), rungZ + RUNG_HEIGHT));
    }
  }
  return shapes;
};

/** Winch house on the mast top and the beacon: a glowing lantern with accent corner bars and cap. */
const topShapes = (color: number, accent: number): Shape[] => {
  const beaconMin = CENTRE - BEACON_SIZE / 2;
  const beaconMax = CENTRE + BEACON_SIZE / 2;
  const bar = (x: number, y: number): Shape => box([x, y, BEACON_Z], [2, 2, BEACON_HEIGHT], accent);
  const mastWidth = MAST_MAX - MAST_MIN;
  const slabMin = MAST_MIN - HOUSE_SLAB_OVERHANG;
  const houseMin = MAST_MIN + HOUSE_INSET;
  return [
    box([slabMin, slabMin, HOUSE_SLAB_Z], [mastWidth + 2 * HOUSE_SLAB_OVERHANG, mastWidth + 2 * HOUSE_SLAB_OVERHANG, 2], MAT.STEEL, PATTERN.METAL),
    box([houseMin, houseMin, HOUSE_Z], [mastWidth - 2 * HOUSE_INSET, mastWidth - 2 * HOUSE_INSET, HOUSE_HEIGHT], color, PATTERN.METAL),
    box([MAST_MIN, MAST_MIN, HOUSE_ROOF_Z], [mastWidth, mastWidth, 2], MAT.STEEL),
    box([beaconMin, beaconMin, BEACON_Z], [BEACON_SIZE, BEACON_SIZE, BEACON_HEIGHT], MAT.LAMP_GLOW),
    bar(beaconMin, beaconMin),
    bar(beaconMax - 2, beaconMin),
    bar(beaconMin, beaconMax - 2),
    bar(beaconMax - 2, beaconMax - 2),
    box([beaconMin, beaconMin, BEACON_Z + BEACON_HEIGHT], [BEACON_SIZE, BEACON_SIZE, 2], accent),
  ];
};

const bodyShapes = (color: number, accent: number): Shape[] => [
  { kind: 'cylinder', base: [CENTRE, CENTRE, PLOT_TOP_Z], radius: PLATFORM_RADIUS, length: DECK_TOP_Z - PLOT_TOP_Z, axis: 'z', material: MAT.CONCRETE, pattern: PATTERN.COBBLE },
  ...mastShapes(color),
  ...topShapes(color, accent),
  // Landing buffers under the car's ring: the car rests on them between rides.
  ...[-BUFFER_OFFSET, BUFFER_OFFSET].flatMap((dx) => [-BUFFER_OFFSET, BUFFER_OFFSET].map((dy) => box(
    [CENTRE + dx - BUFFER_SIZE / 2, CENTRE + dy - BUFFER_SIZE / 2, DECK_TOP_Z],
    [BUFFER_SIZE, BUFFER_SIZE, CLOUD_HOPPER_CAR_REST_Z - DECK_TOP_Z],
    MAT.STEEL_LIGHT,
  ))),
  // Operator booth: steel walls, an accent band, a roof in the ride colour and a lit window on the
  // front face, framed on every side by the WINDOW lattice (x 44–52 and z 8–12 are multiples of 4).
  box([BOOTH_MIN_X, BOOTH_MIN_Y, DECK_TOP_Z], [BOOTH_WIDTH, BOOTH_DEPTH, BOOTH_HEIGHT], MAT.STEEL, PATTERN.METAL),
  box([BOOTH_MIN_X, BOOTH_MIN_Y, DECK_TOP_Z + BOOTH_HEIGHT - 4], [BOOTH_WIDTH, BOOTH_DEPTH, 2], accent),
  box([BOOTH_MIN_X - 1, BOOTH_MIN_Y - 1, DECK_TOP_Z + BOOTH_HEIGHT], [BOOTH_WIDTH + 2, BOOTH_DEPTH + 2, 2], color),
  box([BOOTH_MIN_X + 2, BOOTH_FRONT_Y - 1, 8], [9, 1, 5], MAT.GLASS, PATTERN.WINDOW),
];

/**
 * Seat `index` of SEAT_COUNT around the deck, facing outward along the model axis its direction is
 * closest to (the seats pair up, two to a side): a dark back with an accent shoulder restraint on
 * the mast side and a low pan on the outer side, each half of the SEAT_SIZE² footprint, so every
 * seat keeps whole-voxel, axis-aligned edges.
 */
const seatShapes = (index: number, accent: number): Shape[] => {
  const angle = ((index + 0.5) / SEAT_COUNT) * Math.PI * 2;
  const offsetX = Math.round(Math.cos(angle) * SEAT_RING_RADIUS);
  const offsetY = Math.round(Math.sin(angle) * SEAT_RING_RADIUS);
  const x = CENTRE + offsetX - SEAT_SIZE / 2;
  const y = CENTRE + offsetY - SEAT_SIZE / 2;
  const half = SEAT_SIZE / 2;
  const alongX = Math.abs(offsetX) > Math.abs(offsetY);
  const facesPositive = (alongX ? offsetX : offsetY) > 0;
  const backShift = facesPositive ? 0 : half;
  const panShift = facesPositive ? half : 0;
  const back: Vec3 = alongX ? [x + backShift, y, CAR_DECK_Z] : [x, y + backShift, CAR_DECK_Z];
  const pan: Vec3 = alongX ? [x + panShift, y, CAR_DECK_Z] : [x, y + panShift, CAR_DECK_Z];
  const [sizeX, sizeY] = alongX ? [half, SEAT_SIZE] : [SEAT_SIZE, half];
  return [
    box(back, [sizeX, sizeY, SEAT_BACK_HEIGHT], MAT.STEEL),
    box([back[0], back[1], CAR_DECK_Z + SEAT_BACK_HEIGHT], [sizeX, sizeY, RESTRAINT_HEIGHT], accent),
    box(pan, [sizeX, sizeY, SEAT_PAN_HEIGHT], MAT.STEEL),
  ];
};

/**
 * The ring car at rest: a steel under-band, a deck in the ride colour, eight seats facing outward,
 * four guide shoes that run on the mast, and eight bulbs set flush into the deck's outer edge
 * between the seats. The bulbs glow wherever the car is, but they declare no LightSource: lights
 * are static in model space, and a pool left at the car's rest position would light the empty
 * platform while the car hangs at the top.
 */
const carShapes = (color: number, accent: number): Shape[] => {
  const ring = (z: number, material: number): Shape => ({
    kind: 'ring',
    center: [CENTRE, CENTRE, z + CAR_BAND_HEIGHT / 2],
    radius: (CAR_INNER_RADIUS + CAR_OUTER_RADIUS) / 2,
    thickness: CAR_OUTER_RADIUS - CAR_INNER_RADIUS,
    width: CAR_BAND_HEIGHT,
    axis: 'z',
    material,
  });
  const shoeLength = CAR_INNER_RADIUS - (MAST_MAX - CENTRE);
  const shoeZ = CLOUD_HOPPER_CAR_REST_Z;
  const shoeHeight = CAR_DECK_Z - CLOUD_HOPPER_CAR_REST_Z;
  return [
    ring(CLOUD_HOPPER_CAR_REST_Z, MAT.STEEL),
    ring(CLOUD_HOPPER_CAR_REST_Z + CAR_BAND_HEIGHT, color),
    box([CENTRE - 2, MAST_MAX, shoeZ], [4, shoeLength, shoeHeight], MAT.STEEL),
    box([CENTRE - 2, MAST_MIN - shoeLength, shoeZ], [4, shoeLength, shoeHeight], MAT.STEEL),
    box([MAST_MAX, CENTRE - 2, shoeZ], [shoeLength, 4, shoeHeight], MAT.STEEL),
    box([MAST_MIN - shoeLength, CENTRE - 2, shoeZ], [shoeLength, 4, shoeHeight], MAT.STEEL),
    ...Array.from({ length: SEAT_COUNT }, (_unused, index) => seatShapes(index, accent)).flat(),
    ...Array.from({ length: SEAT_COUNT }, (_unused, index): Shape => {
      const angle = (index / SEAT_COUNT) * Math.PI * 2;
      const x = CENTRE + Math.round(Math.cos(angle) * CAR_BULB_RADIUS);
      const y = CENTRE + Math.round(Math.sin(angle) * CAR_BULB_RADIUS);
      return box([x - 1, y - 1, CAR_DECK_Z - CAR_BAND_HEIGHT], [2, 2, CAR_BAND_HEIGHT], MAT.BULB);
    }),
  ];
};

const LIGHTS: readonly LightSource[] = [
  { position: [CENTRE, CENTRE, BEACON_Z + BEACON_HEIGHT / 2], radius: RIDE_BULB_LIGHT_RADIUS, color: MAT_COLOR.LAMP_GLOW, presets: EVENING },
  { position: [BOOTH_MIN_X + 6.5, BOOTH_FRONT_Y + 1, 10.5], radius: WINDOW_LIGHT_RADIUS, color: MAT_COLOR.WINDOW_GLOW, presets: EVENING },
];

const hex = (rgb: number): string => rgb.toString(16).padStart(6, '0');

/** Builds the cloud-hopper blueprint. Deterministic: same definition and palette, same blueprint. */
export const buildCloudHopper = (definition: BuildDefinition, palette: Palette): Blueprint => {
  // Phase 28 colour slots (game/content/colours.ts): primary and secondary.
  const color = slotted(palette.material(definition.color), COLOUR_SLOT_TAG.primary);
  const accent = slotted(palette.material(definition.accent), COLOUR_SLOT_TAG.secondary);
  return {
    id: `drop-tower:${definition.id}:${hex(definition.color)}:${hex(definition.accent)}`,
    footprint: definition.footprint,
    parts: [
      { id: 'body', pivot: [0, 0, 0], shapes: bodyShapes(color, accent) },
      { id: 'car', pivot: [CENTRE, CENTRE, CLOUD_HOPPER_CAR_REST_Z], shapes: carShapes(color, accent) },
    ],
    lights: LIGHTS,
  };
};

/**
 * The car's height through one ride cycle, 0..1 of the travel (legacy createCloudHopper): hold,
 * winch up on a smoothstep until 0.5, hang at the top until 0.62, a cubic drop until 0.72, one
 * rebound to 0.14 until 0.82, then rest until the cycle ends.
 */
export const cloudHopperHeight = (progress: number): number => {
  if (progress > 0.06 && progress <= 0.5) {
    const climb = (progress - 0.06) / 0.44;
    return climb * climb * (3 - 2 * climb);
  }
  if (progress > 0.5 && progress <= 0.62) return 1;
  if (progress > 0.62 && progress <= 0.72) {
    const fall = (progress - 0.62) / 0.1;
    return 1 - fall * fall * fall;
  }
  if (progress > 0.72 && progress <= 0.82) return Math.abs(Math.sin(((progress - 0.72) / 0.1) * Math.PI)) * 0.14;
  return 0;
};

/** Lifts the car along z only; at rest while the machine is stopped (progress is 0 then too). */
const carDriver: PartDriver = (motion, out) => {
  restPose(out);
  if (motion.motion === 0) return;
  out.dz = CLOUD_HOPPER_CAR_TRAVEL * cloudHopperHeight(motion.progress);
};

export const cloudHopper: ObjectContent = {
  blueprint: buildCloudHopper,
  drivers: { car: carDriver },
};
