import { COLOUR_SLOT_TAG } from '../../../game/content/colours';
import type { BuildDefinition } from '../../../game/types';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT, slotted } from '../contracts/blueprint';
import type { Blueprint, BlueprintPart, LightSource, Shape, Vec3 } from '../contracts/blueprint';
import type { ObjectContent } from '../contracts/content';
import { MAT, MAT_COLOR, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { restPose } from '../contracts/rigid';
import type { PartDriver } from '../contracts/rigid';
import { PLOT_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';

/**
 * Bespoke moonpetal-carousel (3×3 tiles, 96 × 96 voxels): a round platform with a boarding step on
 * the front (+y), a central drum, six horses on gold poles, and a striped tent canopy whose
 * scalloped valance carries a ring of bulbs.
 *
 * Parts: 'body' (everything static), 'rotor' (the six poles, turning about the carousel's axis at
 * the legacy rate) and 'horse-0' … 'horse-5'. Each horse is a part of its own so it can ride up and
 * down its pole out of phase with its neighbours while the rotor carries it round; its pole runs
 * through a 2×2 channel carved out of it, so pole and horse never share a voxel.
 *
 * Budget notes (contracts/budgets.ts BOX_BUDGET.bespokeRide): round shapes cost roughly one box per
 * row per distinct layer, so the canopy is built from 2-voxel terraces (half the layers of a
 * 1-voxel cone) and its stripes are 8 wedges offset by half a wedge. That offset keeps a pink wedge
 * centred on the front (the model diagonal points straight down the screen), gives the same colours
 * at both visual quarter turns (a quarter turn moves the stripes by exactly two wedges), and costs
 * no more than a plain cone. Horses are axis-aligned box models (crisp at rest, cheap), which the
 * drivers turn onto their exact tangent while the ride runs.
 */

const TAU = Math.PI * 2;

/** The catalog footprint the model is authored for (tiles); the content test pins it to the catalog. */
export const CAROUSEL_FOOTPRINT: readonly [number, number] = [3, 3];
/** The carousel's axis (model x and y): the plot centre, a whole voxel so it can be a pivot. */
export const CAROUSEL_CENTRE = (CAROUSEL_FOOTPRINT[0] * VOXELS_PER_TILE) / 2;
const CENTRE = CAROUSEL_CENTRE;

// ---- Platform and drum -------------------------------------------------------------------------

/** Art bible: rides stand on a platform 4 voxels tall. */
const DECK_TOP_Z = PLOT_TOP_Z + 4;
/**
 * The pink skirt; the wooden deck sits two voxels inside it, so the skirt's rim frames the planks
 * with a band wide enough to read at one texel per voxel.
 */
const PLATFORM_RADIUS = 44;
const DECK_RADIUS = 42;
/**
 * Boarding step on the front (+y) edge, half the platform's height, in timber darker than the deck
 * so it reads against the pale plot slab.
 */
const STEP_WIDTH = 20;
const STEP_DEPTH = 8;
const STEP_HEIGHT = 2;

const COLLAR_RADIUS = 12;
const COLLAR_TOP_Z = DECK_TOP_Z + 4;
const DRUM_RADIUS = 9;
/**
 * Mirror panels low on the drum: the valance hides the drum above z ≈ 22 from the camera. The
 * WINDOW lattice frames every 4 voxels, so 12 → 21 shows two framed rows of panes.
 */
const MIRROR_BOTTOM_Z = 12;
const MIRROR_TOP_Z = 21;

// ---- Canopy ------------------------------------------------------------------------------------

/** Underside of the canopy: the valance hangs below it and the poles end on it. */
const CANOPY_Z = 56;
/**
 * Canopy terraces from the rim inward, each 2 voxels tall: 4-voxel treads at the eaves steepening
 * to 2 near the top, so the tent rises to a peak that clears the back rim on screen (a straight
 * 1:2 cone would sit below it and read as a saucer).
 */
const CANOPY_RADII: readonly number[] = [46, 42, 38, 34, 30, 27, 24, 21, 18, 16, 14, 12, 10, 8, 6, 4];
const CANOPY_STEP_HEIGHT = 2;
const CANOPY_TOP_Z = CANOPY_Z + CANOPY_RADII.length * CANOPY_STEP_HEIGHT;
const WEDGE_COUNT = 8;
const WEDGE_OFFSET = TAU / (2 * WEDGE_COUNT);

/** Valance: a 2-voxel ring (voxel centres at radius 42–44) two voxels inside the canopy's eaves. */
const VALANCE_RADIUS = 43;
const VALANCE_THICKNESS = 2;
const VALANCE_BOTTOM_Z = 50;
const VALANCE_INNER = VALANCE_RADIUS - VALANCE_THICKNESS / 2;
const VALANCE_OUTER = VALANCE_RADIUS + VALANCE_THICKNESS / 2;
/** Scallops hang below the valance, three layers, narrowest at the bottom (half-widths along the arc). */
const SCALLOP_COUNT = 24;
const SCALLOP_HALF_WIDTHS: readonly number[] = [2.5, 4, 5.5];
const SCALLOP_BOTTOM_Z = VALANCE_BOTTOM_Z - SCALLOP_HALF_WIDTHS.length;
/** Bulbs (2×2×2) sit against the valance's face, one above every gap between two scallops. */
const BULB_COUNT = 24;
const BULB_Z = 52;
const BULB_SIZE = 2;
/** Where the search for each bulb's 2×2 block starts: half a voxel outside the valance. */
const BULB_RADIUS_START = VALANCE_OUTER + 0.5;

/** Finial: a gold hub on the peak, a pole and a pennant in the ride colour. */
const FINIAL_HUB_RADIUS = 3;
const FINIAL_HUB_HEIGHT = 3;
const FINIAL_POLE_HEIGHT = 10;

/**
 * The space the moving parts turn in, around the carousel's axis: above the deck, below the
 * canopy, outside the drum's collar and inside the valance. The radii keep a voxel of margin
 * because a round shape's staircase corners stand up to ~0.7 voxels off its nominal radius. The
 * content test sweeps every moving part through a full cycle against it; nothing static is in it.
 */
export const CAROUSEL_GALLERY = {
  floorZ: DECK_TOP_Z,
  ceilingZ: CANOPY_Z,
  innerRadius: COLLAR_RADIUS + 1,
  outerRadius: VALANCE_INNER - 1,
} as const;

// ---- Lights (art bible radii) ------------------------------------------------------------------

const EVENING = LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT;
const RIDE_BULB_LIGHT_RADIUS = 16;
/** One pool per two bulbs keeps the light pass cheap; the bulbs are evenly spaced, so it reads even. */
const BULB_LIGHT_COUNT = 12;
const WINDOW_LIGHT_RADIUS = 28;

// ---- Horses and motion -------------------------------------------------------------------------

export const CAROUSEL_HORSE_COUNT = 6;
/** Pole circle; horses and poles stay well inside the plot minus 2 wherever they turn. */
const ORBIT_RADIUS = 34;
/** Horses float 3 voxels above the deck at rest, so the lowest bob still clears it. */
const HOOF_Z = DECK_TOP_Z + 3;
/** Legacy (rideArt.ts createMoonpetalCarousel): the horses orbit at `spin * 0.0008` radians. */
export const CAROUSEL_RADIANS_PER_SPIN_MS = 0.0008;
/** Legacy bob: sin(spin · 0.0055 + index · 1.7), 35 % of the stroke idling, all of it running. */
const BOB_RADIANS_PER_SPIN_MS = 0.0055;
const BOB_PHASE_PER_HORSE = 1.7;
const BOB_IDLE_SHARE = 0.35;
/** Art bible bob: ±2 voxels, rounded to whole voxels so a bobbing horse moves one texel at a time. */
export const CAROUSEL_BOB_VOXELS = 2;

export const CAROUSEL_ROTOR_PART_ID = 'rotor';
export const carouselHorsePartId = (index: number): string => `horse-${index}`;

/**
 * The rotor's angle about +z for a spin value, reduced to one turn so float32 transforms stay
 * precise however long the park runs. A positive turn about +z carries +x toward +y, which is
 * clockwise on screen at both quarter turns — the way the classic carousel turns.
 */
export const carouselAngle = (spin: number): number => (spin * CAROUSEL_RADIANS_PER_SPIN_MS) % TAU;

// ---- Shape helpers -----------------------------------------------------------------------------

const box = (min: Vec3, size: Vec3, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'box', min, size, material, pattern });

const disc = (radius: number, z: number, height: number, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'cylinder', base: [CENTRE, CENTRE, z], radius, length: height, axis: 'z', material, pattern });

/** The compiler's sampling rule: a voxel belongs to a round shape when its centre is inside it. */
const centreWithin = (x: number, y: number, radius: number): boolean => {
  const dx = x + 0.5 - CENTRE;
  const dy = y + 0.5 - CENTRE;
  return dx * dx + dy * dy <= radius * radius;
};

/** Angle of a voxel centre about the axis, in [0, 2π). */
const angleOf = (x: number, y: number): number => {
  const angle = Math.atan2(y + 0.5 - CENTRE, x + 0.5 - CENTRE);
  return angle < 0 ? angle + TAU : angle;
};

/**
 * One box per row run of the voxels `keep` selects inside the square that bounds `radius`, over
 * [z, z + height). Wedges and scallops have no shape of their own, so they are spelled out voxel by
 * voxel with the compiler's own centre rule; the mesher merges the runs again.
 */
const rowRuns = (radius: number, z: number, height: number, material: number, keep: (x: number, y: number) => boolean): Shape[] => {
  const shapes: Shape[] = [];
  const from = Math.floor(CENTRE - radius) - 1;
  const to = Math.ceil(CENTRE + radius) + 1;
  for (let y = from; y < to; y += 1) {
    let start = -1;
    for (let x = from; x <= to; x += 1) {
      const kept = x < to && keep(x, y);
      if (kept && start < 0) start = x;
      if (!kept && start >= 0) {
        shapes.push(box([start, y, z], [x - start, 1, height], material));
        start = -1;
      }
    }
  }
  return shapes;
};

// ---- Body --------------------------------------------------------------------------------------

const platformShapes = (color: number): Shape[] => [
  disc(PLATFORM_RADIUS, PLOT_TOP_Z, DECK_TOP_Z - 1 - PLOT_TOP_Z, color),
  disc(DECK_RADIUS, DECK_TOP_Z - 1, 1, MAT.WOOD, PATTERN.PLANKS),
  // The step overlaps the skirt and shows only where it stands proud of the platform's front edge.
  box([CENTRE - STEP_WIDTH / 2, CENTRE + PLATFORM_RADIUS - STEP_DEPTH + 2, PLOT_TOP_Z], [STEP_WIDTH, STEP_DEPTH, STEP_HEIGHT], MAT.TIMBER, PATTERN.PLANKS),
];

const drumShapes = (color: number, accent: number): Shape[] => [
  disc(COLLAR_RADIUS, DECK_TOP_Z, COLLAR_TOP_Z - DECK_TOP_Z, color),
  disc(DRUM_RADIUS, COLLAR_TOP_Z, CANOPY_Z - COLLAR_TOP_Z, accent),
  disc(DRUM_RADIUS, MIRROR_BOTTOM_Z, MIRROR_TOP_Z - MIRROR_BOTTOM_Z, MAT.GLASS, PATTERN.WINDOW),
];

/** Wedge 0 … WEDGE_COUNT − 1 of a voxel column; odd wedges take the accent. */
const wedgeOf = (x: number, y: number): number => {
  const turned = (angleOf(x, y) - WEDGE_OFFSET + TAU) % TAU;
  return Math.floor((turned / TAU) * WEDGE_COUNT) % WEDGE_COUNT;
};

/**
 * The tent: one disc per terrace in the ride colour, and the accent wedges written over the part
 * of each terrace the camera can see (its tread, outside whatever stands on it: the next terrace,
 * or the finial's hub on the top one). Hidden voxels stay one colour so their rows merge into long
 * boxes.
 */
const canopyShapes = (color: number, accent: number): Shape[] => CANOPY_RADII.flatMap((radius, index): Shape[] => {
  const z = CANOPY_Z + index * CANOPY_STEP_HEIGHT;
  const covered = index + 1 < CANOPY_RADII.length ? CANOPY_RADII[index + 1] : FINIAL_HUB_RADIUS;
  return [
    disc(radius, z, CANOPY_STEP_HEIGHT, color),
    ...rowRuns(radius, z, CANOPY_STEP_HEIGHT, accent, (x, y) =>
      centreWithin(x, y, radius) && !centreWithin(x, y, covered) && wedgeOf(x, y) % 2 === 1),
  ];
});

const inValance = (x: number, y: number): boolean =>
  centreWithin(x, y, VALANCE_OUTER) && !centreWithin(x, y, VALANCE_INNER - 1e-9);

/**
 * Minimum corner of bulb `index`: the 2×2 block nearest the valance's face (pushed out a quarter
 * voxel at a time) whose voxels are all outside the ring, so every bulb is a whole 2×2×2 and the
 * valance's layers stay identical (they merge into one box per row).
 */
const bulbCorner = (index: number): [number, number] => {
  const angle = (index / BULB_COUNT) * TAU;
  let corner: [number, number] = [0, 0];
  // Two voxels outside the ring every 2×2 block is clear of it, so the search always ends on one.
  for (let radius = BULB_RADIUS_START; radius <= VALANCE_OUTER + BULB_SIZE; radius += 0.25) {
    corner = [Math.round(CENTRE + Math.cos(angle) * radius) - 1, Math.round(CENTRE + Math.sin(angle) * radius) - 1];
    const [x, y] = corner;
    if (!inValance(x, y) && !inValance(x + 1, y) && !inValance(x, y + 1) && !inValance(x + 1, y + 1)) break;
  }
  return corner;
};

const valanceShapes = (color: number, accent: number): Shape[] => {
  const spacing = TAU / SCALLOP_COUNT;
  const scallops = SCALLOP_HALF_WIDTHS.flatMap((halfWidth, layer) =>
    rowRuns(VALANCE_OUTER, SCALLOP_BOTTOM_Z + layer, 1, accent, (x, y) => {
      if (!inValance(x, y)) return false;
      // Scallops are centred between bulbs, half a spacing round from bulb 0.
      const along = angleOf(x, y) / spacing - 0.5;
      return Math.abs(along - Math.round(along)) * spacing * VALANCE_RADIUS <= halfWidth;
    }));
  return [
    { kind: 'ring', center: [CENTRE, CENTRE, (VALANCE_BOTTOM_Z + CANOPY_Z) / 2], radius: VALANCE_RADIUS, thickness: VALANCE_THICKNESS, width: CANOPY_Z - VALANCE_BOTTOM_Z, axis: 'z', material: color },
    ...scallops,
    ...Array.from({ length: BULB_COUNT }, (_unused, index): Shape => {
      const [x, y] = bulbCorner(index);
      return box([x, y, BULB_Z], [BULB_SIZE, BULB_SIZE, BULB_SIZE], MAT.BULB);
    }),
  ];
};

const finialShapes = (color: number, gold: number): Shape[] => {
  const poleZ = CANOPY_TOP_Z + FINIAL_HUB_HEIGHT;
  const pennantZ = poleZ + FINIAL_POLE_HEIGHT - 4;
  return [
    disc(FINIAL_HUB_RADIUS, CANOPY_TOP_Z, FINIAL_HUB_HEIGHT, gold),
    box([CENTRE - 1, CENTRE - 1, poleZ], [2, 2, FINIAL_POLE_HEIGHT], gold),
    // A stepped pennant flying toward +x: 6 long at the hoist, tapering to a 2-voxel tip.
    box([CENTRE + 1, CENTRE - 1, pennantZ], [6, 2, 4], color),
    box([CENTRE + 7, CENTRE - 1, pennantZ + 1], [3, 2, 2], color),
  ];
};

const lights = (): LightSource[] => [
  ...Array.from({ length: BULB_LIGHT_COUNT }, (_unused, index): LightSource => {
    const angle = ((index + 0.5) / BULB_LIGHT_COUNT) * TAU;
    const radius = VALANCE_OUTER + BULB_SIZE;
    return {
      position: [CENTRE + Math.cos(angle) * radius, CENTRE + Math.sin(angle) * radius, BULB_Z + BULB_SIZE / 2],
      radius: RIDE_BULB_LIGHT_RADIUS,
      color: MAT_COLOR.BULB,
      presets: EVENING,
    };
  }),
  // The mirrors glow at dusk and night like a lit window; this pool lights the deck round the drum.
  { position: [CENTRE, CENTRE, (MIRROR_BOTTOM_Z + MIRROR_TOP_Z) / 2], radius: WINDOW_LIGHT_RADIUS, color: MAT_COLOR.WINDOW_GLOW, presets: EVENING },
];

// ---- Horses ------------------------------------------------------------------------------------

/** Heading of a horse box model: 0 faces +x, 1 +y, 2 −x, 3 −y (quarter turns about +z). */
type Heading = 0 | 1 | 2 | 3;

export interface CarouselHorse {
  /** Centre of the horse's pole (model x, y); the pole's 2×2 section is centred on it. */
  poleX: number;
  poleY: number;
  /** The axis direction the box model faces at rest: the one nearest its direction of travel. */
  heading: Heading;
  /** Radians from `heading` to the exact tangent; the driver adds it while the ride runs. */
  yaw: number;
}

/**
 * Six horses 60° apart, horse 0 on the +x side. Six headings cannot all lie on the voxel axes, so
 * each box model faces the axis nearest its tangent (two sit exactly on it, four 30° off) and the
 * driver turns it the rest of the way once the rotor moves.
 */
export const CAROUSEL_HORSES: readonly CarouselHorse[] = Array.from({ length: CAROUSEL_HORSE_COUNT }, (_unused, index) => {
  const angle = (index / CAROUSEL_HORSE_COUNT) * TAU;
  const poleX = Math.round(CENTRE + Math.cos(angle) * ORBIT_RADIUS);
  const poleY = Math.round(CENTRE + Math.sin(angle) * ORBIT_RADIUS);
  const travel = Math.atan2(poleY - CENTRE, poleX - CENTRE) + Math.PI / 2;
  const turns = Math.round(travel / (Math.PI / 2));
  const heading = (((turns % 4) + 4) % 4) as Heading;
  return { poleX, poleY, heading, yaw: travel - turns * (Math.PI / 2) };
});

type HorseBox = readonly [u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, material: number];

const WHITE = MAT.WHITE;
/** The brass of poles, finial, manes and tails: the carousel's colour slot `trim` (default MAT.RAIL). */
const GOLD = slotted(MAT.RAIL, COLOUR_SLOT_TAG.trim);
/** Stands for the ride colour in HORSE_BOXES. */
const SADDLE = -1;

/**
 * One horse facing +u (u forward, v to its left, z up from the hooves), boxes around its pole at
 * u = v = 0. Every box is at least 2 voxels across in both directions that turn with it (the rule
 * for anything rotating at one texel per voxel), and the silhouette is a carousel jumper: hind legs
 * reaching back, forelegs tucked, head forward, gold mane and tail, saddle in the ride colour.
 */
const HORSE_BOXES: readonly HorseBox[] = [
  // Hind leg reaching back to the hoof, foreleg tucked up.
  [-7, -5, -2, 2, 2, 7, WHITE],
  [-9, -7, -2, 2, 0, 3, WHITE],
  [4, 6, -2, 2, 3, 7, WHITE],
  [6, 8, -2, 2, 3, 5, WHITE],
  // Barrel and chest.
  [-8, 7, -2, 2, 7, 12, WHITE],
  [5, 9, -2, 2, 9, 15, WHITE],
  // Neck, head, muzzle and ears.
  [6, 10, -1, 1, 15, 18, WHITE],
  [8, 13, -1, 1, 17, 21, WHITE],
  [12, 14, -1, 1, 17, 19, WHITE],
  [8, 10, -1, 1, 21, 23, WHITE],
  // Mane down the back of the neck, and a tail flowing down behind.
  [4, 8, -1, 1, 15, 20, GOLD],
  [6, 8, -1, 1, 20, 22, GOLD],
  [-10, -8, -1, 1, 7, 12, GOLD],
  [-12, -10, -1, 1, 4, 9, GOLD],
  // Saddle cloth over the barrel and the saddle on top.
  [-3, 2, -2, 2, 8, 12, SADDLE],
  [-3, 2, -2, 2, 12, 14, SADDLE],
];
/** Height of the horse model above its hooves. */
const HORSE_HEIGHT = 23;
/** The channel the pole runs through, carved over the horse's full height. */
const POLE_CHANNEL: HorseBox = [-1, 1, -1, 1, 0, HORSE_HEIGHT, 0];

/** A horse box in (u, v, z-from-hooves) turned to `heading` about the pole and moved into model space. */
const horseBox = (horse: CarouselHorse, [u0, u1, v0, v1, z0, z1, material]: HorseBox, saddle: number): Shape => {
  const { poleX: x, poleY: y } = horse;
  const zMin = HOOF_Z + z0;
  const height = z1 - z0;
  const resolved = material === SADDLE ? saddle : material;
  // Quarter turns of (u, v): +x (u, v) · +y (−v, u) · −x (−u, −v) · −y (v, −u).
  switch (horse.heading) {
    case 0: return box([x + u0, y + v0, zMin], [u1 - u0, v1 - v0, height], resolved);
    case 1: return box([x - v1, y + u0, zMin], [v1 - v0, u1 - u0, height], resolved);
    case 2: return box([x - u1, y - v1, zMin], [u1 - u0, v1 - v0, height], resolved);
    default: return box([x + v0, y - u1, zMin], [v1 - v0, u1 - u0, height], resolved);
  }
};

const horseShapes = (horse: CarouselHorse, saddle: number): Shape[] => [
  ...HORSE_BOXES.map((entry) => horseBox(horse, entry, saddle)),
  horseBox(horse, POLE_CHANNEL, saddle),
];

const poleShapes = (): Shape[] => CAROUSEL_HORSES.map((horse) =>
  box([horse.poleX - 1, horse.poleY - 1, DECK_TOP_Z], [2, 2, CANOPY_Z - DECK_TOP_Z], GOLD));

/** Every moving part turns about the carousel's axis at deck height. */
const AXIS_PIVOT: Vec3 = [CENTRE, CENTRE, DECK_TOP_Z];

const hex = (rgb: number): string => rgb.toString(16).padStart(6, '0');

/** Builds the carousel blueprint. Deterministic: same definition and palette, same blueprint. */
export const buildMoonpetalCarousel = (definition: BuildDefinition, palette: Palette): Blueprint => {
  // Phase 28 colour slots (game/content/colours.ts): primary, secondary and trim (GOLD).
  const color = slotted(palette.material(definition.color), COLOUR_SLOT_TAG.primary);
  const accent = slotted(palette.material(definition.accent), COLOUR_SLOT_TAG.secondary);
  return {
    id: `carousel:${definition.id}:${hex(definition.color)}:${hex(definition.accent)}`,
    footprint: CAROUSEL_FOOTPRINT,
    parts: [
      {
        id: 'body',
        pivot: [0, 0, 0],
        shapes: [
          ...platformShapes(color),
          ...drumShapes(color, accent),
          ...valanceShapes(color, accent),
          ...canopyShapes(color, accent),
          ...finialShapes(color, GOLD),
        ],
      },
      { id: CAROUSEL_ROTOR_PART_ID, pivot: AXIS_PIVOT, shapes: poleShapes() },
      ...CAROUSEL_HORSES.map((horse, index): BlueprintPart => ({
        id: carouselHorsePartId(index),
        pivot: AXIS_PIVOT,
        shapes: horseShapes(horse, color),
      })),
    ],
    lights: lights(),
  };
};

// ---- Drivers -----------------------------------------------------------------------------------

/** Turns the poles about the axis by the carousel angle; at rest while the machine has not moved. */
const rotorDriver: PartDriver = (motion, out) => {
  restPose(out);
  if (motion.motion === 0) return;
  const half = carouselAngle(motion.spin) / 2;
  out.qz = Math.sin(half);
  out.qw = Math.cos(half);
};

/**
 * Carries horse `index` round with the rotor, turned onto its exact tangent, and bobs it. The
 * pose turns the horse by (angle + yaw) about the axis; the offset then slides it back so its pole
 * channel sits on the rotor's pole, which only turned by `angle`. The bob is whole voxels and
 * scales with motion like legacy (35 % of the stroke while idling). Allocation-free: the rest
 * position is captured once, at module load.
 */
const horseDriver = (horse: CarouselHorse, index: number): PartDriver => {
  const restX = horse.poleX - CENTRE;
  const restY = horse.poleY - CENTRE;
  const phase = index * BOB_PHASE_PER_HORSE;
  return (motion, out) => {
    restPose(out);
    if (motion.motion === 0) return;
    const angle = carouselAngle(motion.spin);
    const heading = angle + horse.yaw;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cosHeading = Math.cos(heading);
    const sinHeading = Math.sin(heading);
    out.dx = restX * cos - restY * sin - (restX * cosHeading - restY * sinHeading);
    out.dy = restX * sin + restY * cos - (restX * sinHeading + restY * cosHeading);
    const stroke = BOB_IDLE_SHARE + (1 - BOB_IDLE_SHARE) * Math.min(1, motion.motion);
    out.dz = Math.round(CAROUSEL_BOB_VOXELS * stroke * Math.sin(motion.spin * BOB_RADIANS_PER_SPIN_MS + phase));
    out.qz = Math.sin(heading / 2);
    out.qw = Math.cos(heading / 2);
  };
};

const drivers: Record<string, PartDriver> = { [CAROUSEL_ROTOR_PART_ID]: rotorDriver };
CAROUSEL_HORSES.forEach((horse, index) => {
  drivers[carouselHorsePartId(index)] = horseDriver(horse, index);
});

export const moonpetalCarousel: ObjectContent = {
  blueprint: buildMoonpetalCarousel,
  drivers,
};
