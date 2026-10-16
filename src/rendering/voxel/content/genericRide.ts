import { COLOUR_SLOT_TAG, isColourable } from '../../../game/content/colours';
import { GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import type { BuildDefinition } from '../../../game/types';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT, slotted } from '../contracts/blueprint';
import type { Axis, Blueprint, BlueprintPart, LightSource, Shape, Vec3 } from '../contracts/blueprint';
import type { ObjectContent } from '../contracts/content';
import { MAT, MAT_COLOR, PATTERN, SKIN_MATERIALS } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { restPose } from '../contracts/rigid';
import type { PartDriver } from '../contracts/rigid';
import { PLOT_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';

/**
 * One parameterised flat-ride builder for every ride without a bespoke model: petal-roundabout,
 * comet-cups, bumble-coach, harbor-swings, splash-rings, gale-spinner and thunder-drum, and the
 * Phase 16 rides puddle-jumpers (2×2), rocket-pendulum and temple-trek (4×3).
 *
 * Every ride is the same kit — a 4-voxel platform (or track bed) on the plot, a mast or hub in steel
 * and the accent colour, a canopy in the catalog colour, an operator booth whose lit window faces the
 * front, bulbs that glow at dusk and night — plus the moving parts that carry the riders. What makes
 * a ride read as itself at one texel per voxel is its silhouette, so each id's design picks the
 * canopy (a striped umbrella, a hub cap, a crown ring, a vertical gale ring, a station roof), the
 * vehicles (petal bowls, cups, chairs on chains, a drum, pods, a train, round boats) and how they
 * move. Most rides turn one rotor about +z; where the legacy ride has a second motion that defines
 * it, that motion is its own rigid part: cups counter-spin on their plates, swing chairs fly out,
 * the gale arm turns in a vertical plane with counter-rotating pods, the drum tips and rises, and
 * the train and the boats follow an oval. Speeds are the legacy ones (rideArt.ts, renderer-surface
 * §5.3) so a voxel ride turns like its classic twin.
 *
 * Everything is authored relative to the ride centre (x, y) with absolute z and moved into model
 * space (contracts/blueprint.ts: origin at the footprint's minimum corner, front on +y) at the end,
 * so drivers only need centre-relative vectors, never the footprint. One ObjectContent serves all
 * seven ids and its drivers are one record keyed by part id, so every part id carries its ride's key.
 *
 * Box budget (BOX_BUDGET.genericRide) notes, measured with the real compiler: a smooth cone costs a
 * box per distinct chord per layer (a 40-voxel canopy ~430 boxes), and anything that cuts across its
 * rows — radial ribs, a trim ring — splits each row into three runs and costs ~60 boxes per rib.
 * Stripes that follow the cone's layers cost nothing, a trim made of stacked cylinders costs a third
 * of a trim ring, and a disc hidden under a canopy looks exactly like a ring there.
 */

/** Top of the 4-voxel ride platform (art bible: platform 4). */
const DECK_TOP_Z = PLOT_TOP_Z + 4;
/** The platform's skirt stops one voxel short, so its top shows as a rim around the deck layer. */
const DECK_SKIRT_TOP_Z = DECK_TOP_Z - 1;
/** Ride bulbs light a small pool (art bible). */
const BULB_LIGHT_RADIUS = 16;
/** A lit booth window lights like a kiosk window (art bible). */
const WINDOW_LIGHT_RADIUS = 28;
const EVENING = LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT;
/** No ride declares more bulb lights than this, so a park full of rides stays inside LIGHT_CAPACITY. */
const MAX_BULB_LIGHTS = 6;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ materials

interface RideMaterials {
  /** The catalog colour; a `slotted` material (colour slot primary) for a colourable ride. */
  color: number;
  /** The catalog accent; slot secondary. */
  accent: number;
  /** MAT.CANVAS stripes of a canopy: slot trim for a colourable ride (harbor-swings), MAT.CANVAS otherwise. */
  canvas: number;
  /** Rider shirts: guest colours, so riders look like the guests walking the park. */
  shirts: readonly number[];
}

const HAIR_MATERIALS: readonly number[] = [MAT.HAIR_DARK, MAT.HAIR_BROWN, MAT.HAIR_BLOND];

/**
 * Phase 28: a ride with colour slots (game/content/colours.ts) tags the shapes of each slot; the tag
 * changes no geometry (the boxes of the default colours are pinned against a frozen fixture). A ride
 * without slots (the generic spinner stands in for any unknown id) stays untagged.
 */
const materialsFor = (definition: BuildDefinition, palette: Palette): RideMaterials => {
  const colourable = isColourable(definition.id);
  const tagged = (material: number, tag: number): number => (colourable ? slotted(material, tag) : material);
  return {
    color: tagged(palette.material(definition.color), COLOUR_SLOT_TAG.primary),
    accent: tagged(palette.material(definition.accent), COLOUR_SLOT_TAG.secondary),
    canvas: tagged(MAT.CANVAS, COLOUR_SLOT_TAG.trim),
    shirts: GUEST_COLORS.map((rgb) => palette.material(rgb)),
  };
};

// ------------------------------------------------------------------ shapes (centre-relative)

const box = (min: Vec3, size: Vec3, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'box', min, size, material, pattern });

const cylinder = (base: Vec3, radius: number, length: number, axis: Axis, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'cylinder', base, radius, length, axis, material, pattern });

const cone = (base: Vec3, radius: number, height: number, topRadius: number, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'cone', base, radius, height, topRadius, material, pattern });

const ellipsoid = (center: Vec3, radii: Vec3, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'ellipsoid', center, radii, material, pattern });

const ring = (center: Vec3, radius: number, thickness: number, width: number, axis: Axis, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'ring', center, radius, thickness, width, axis, material, pattern });

const segment = (from: Vec3, to: Vec3, radius: number, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'segment', from, to, radius, material, pattern });

/** Moves a centre-relative shape into model space. */
const shifted = (shape: Shape, dx: number, dy: number): Shape => {
  switch (shape.kind) {
    case 'box':
    case 'gable':
      return { ...shape, min: [shape.min[0] + dx, shape.min[1] + dy, shape.min[2]] };
    case 'cylinder':
    case 'cone':
      return { ...shape, base: [shape.base[0] + dx, shape.base[1] + dy, shape.base[2]] };
    case 'ellipsoid':
    case 'ring':
      return { ...shape, center: [shape.center[0] + dx, shape.center[1] + dy, shape.center[2]] };
    case 'segment':
      return {
        ...shape,
        from: [shape.from[0] + dx, shape.from[1] + dy, shape.from[2]],
        to: [shape.to[0] + dx, shape.to[1] + dy, shape.to[2]],
      };
  }
};

/** Integer point at `radius` and `angle` around the centre (pivots and boxes stay on whole voxels). */
const polar = (radius: number, angle: number): [number, number] =>
  [Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)];

/**
 * A seated rider centred on (x, y) with the seat at `z`: shirt, a 4×4×4 head like a walking guest's
 * (art bible) and 2 voxels of hair, 10 tall. `index` varies skin, hair and shirt so a full ride does
 * not look cloned.
 */
const rider = (x: number, y: number, z: number, index: number, materials: RideMaterials): Shape[] => [
  box([x - 2, y - 2, z], [4, 4, 4], materials.shirts[index % materials.shirts.length]),
  box([x - 2, y - 2, z + 4], [4, 4, 4], SKIN_MATERIALS[index % SKIN_MATERIALS.length]),
  box([x - 2, y - 2, z + 8], [4, 4, 2], HAIR_MATERIALS[index % HAIR_MATERIALS.length]),
];

/** Carved stadium band (two semicircles joined by straights along x) between two radii. */
const stadiumBand = (
  halfStraight: number,
  innerRadius: number,
  outerRadius: number,
  z: number,
  height: number,
  material: number,
  pattern: number = PATTERN.PLAIN,
): Shape[] => {
  const middle = (innerRadius + outerRadius) / 2;
  const thickness = outerRadius - innerRadius;
  const centreZ = z + height / 2;
  return [
    ring([-halfStraight, 0, centreZ], middle, thickness, height, 'z', material, pattern),
    ring([halfStraight, 0, centreZ], middle, thickness, height, 'z', material, pattern),
    // The rings' inner halves reach across the island; the straights replace them.
    box([-halfStraight, -innerRadius, z], [2 * halfStraight, 2 * innerRadius, height], 0),
    box([-halfStraight, innerRadius, z], [2 * halfStraight, thickness, height], material, pattern),
    box([-halfStraight, -outerRadius, z], [2 * halfStraight, thickness, height], material, pattern),
  ];
};

/** Filled stadium disc. */
const stadiumDisc = (halfStraight: number, radius: number, z: number, height: number, material: number, pattern: number = PATTERN.PLAIN): Shape[] => [
  cylinder([-halfStraight, 0, z], radius, height, 'z', material, pattern),
  cylinder([halfStraight, 0, z], radius, height, 'z', material, pattern),
  box([-halfStraight, -radius, z], [2 * halfStraight, 2 * radius, height], material, pattern),
];

// ------------------------------------------------------------------ drivers

/**
 * Drivers (contracts/rigid.ts PartDriver) pose a part in unrotated model space from the ride's
 * motion state. They allocate nothing, write a unit quaternion, and leave every part at rest while
 * motion is 0 (a closed ride looks exactly like its ghost preview). Angles are the legacy ones:
 * radians per motion-weighted millisecond of `spin`.
 */

/** Rotation about +z through the pivot (a rotor on the ride's centre line). */
const spinAboutZ = (speed: number): PartDriver => (motion, out) => {
  if (!(motion.motion > 0)) {
    restPose(out);
    return;
  }
  const half = (motion.spin * speed) / 2;
  out.dx = 0;
  out.dy = 0;
  out.dz = 0;
  out.qx = 0;
  out.qy = 0;
  out.qz = Math.sin(half);
  out.qw = Math.cos(half);
};

/**
 * A satellite carried round the ride centre at `orbitSpeed` (its pivot at (pivotX, pivotY)
 * relative to the centre) that turns about its own +z axis at `selfSpeed` in absolute terms —
 * comet-cups' plates counter-spin like the legacy cups.
 */
const orbitAndSpin = (orbitSpeed: number, pivotX: number, pivotY: number, selfSpeed: number): PartDriver => (motion, out) => {
  if (!(motion.motion > 0)) {
    restPose(out);
    return;
  }
  const orbit = motion.spin * orbitSpeed;
  const cos = Math.cos(orbit);
  const sin = Math.sin(orbit);
  out.dx = pivotX * cos - pivotY * sin - pivotX;
  out.dy = pivotX * sin + pivotY * cos - pivotY;
  out.dz = 0;
  const half = (motion.spin * selfSpeed) / 2;
  out.qx = 0;
  out.qy = 0;
  out.qz = Math.sin(half);
  out.qw = Math.cos(half);
};

/**
 * A chair hanging from the rotor at (pivotX, pivotY): carried round the centre and swung outward
 * about its tangent by `maxSwing · motion`, so chairs fly out as the ride spins up (the legacy
 * chairs' orbit grows with motion, 26 + 30·motion).
 */
const swingOut = (speed: number, pivotX: number, pivotY: number, maxSwing: number): PartDriver => {
  const radial = Math.hypot(pivotX, pivotY);
  // Swinging about (sin α, −cos α) moves the chair's bottom toward the outside (cos α, sin α).
  const axisX = pivotY / radial;
  const axisY = -pivotX / radial;
  return (motion, out) => {
    if (!(motion.motion > 0)) {
      restPose(out);
      return;
    }
    const orbit = motion.spin * speed;
    const cos = Math.cos(orbit);
    const sin = Math.sin(orbit);
    out.dx = pivotX * cos - pivotY * sin - pivotX;
    out.dy = pivotX * sin + pivotY * cos - pivotY;
    out.dz = 0;
    const swing = maxSwing * Math.min(1, motion.motion);
    const swingSin = Math.sin(swing / 2);
    const swingCos = Math.cos(swing / 2);
    const orbitSin = Math.sin(orbit / 2);
    const orbitCos = Math.cos(orbit / 2);
    // orbit ⊗ swing: the swing happens in the rotor's frame, then the rotor carries it round.
    out.qx = orbitCos * axisX * swingSin - orbitSin * axisY * swingSin;
    out.qy = orbitCos * axisY * swingSin + orbitSin * axisX * swingSin;
    out.qz = orbitSin * swingCos;
    out.qw = orbitCos * swingCos;
  };
};

/**
 * The thunder drum: spins about its own axis, and tips toward (tipX, tipY) and rises with motion
 * while it rocks (legacy: tilt motion·(0.1 + 0.1·sin(spin·0.0009)), lift 6·motion). The rise is
 * always a little more than the tilt lowers the drum's rim, so the drum never dips into its hub.
 */
const DRUM_TILT_BASE = 0.1;
const DRUM_TILT_ROCK = 0.1;
const DRUM_ROCK_SPEED = 0.0009;
const tiltingDrum = (speed: number, tipX: number, tipY: number, rise: number): PartDriver => {
  const length = Math.hypot(tipX, tipY);
  // Tipping the top toward t turns about z × t.
  const axisX = -tipY / length;
  const axisY = tipX / length;
  return (motion, out) => {
    if (!(motion.motion > 0)) {
      restPose(out);
      return;
    }
    const amount = Math.min(1, motion.motion);
    const spin = motion.spin * speed;
    const tilt = amount * (DRUM_TILT_BASE + DRUM_TILT_ROCK * Math.sin(motion.spin * DRUM_ROCK_SPEED));
    const tiltSin = Math.sin(tilt / 2);
    const tiltCos = Math.cos(tilt / 2);
    const spinSin = Math.sin(spin / 2);
    const spinCos = Math.cos(spin / 2);
    // tilt ⊗ spin: the drum turns on its own axis, and that axis tips.
    out.qx = tiltSin * (axisX * spinCos + axisY * spinSin);
    out.qy = tiltSin * (axisY * spinCos - axisX * spinSin);
    out.qz = tiltCos * spinSin;
    out.qw = tiltCos * spinCos;
    out.dx = 0;
    out.dy = 0;
    out.dz = rise * amount;
  };
};

/** Rotation about +y through the pivot: gale-spinner's arm turns in the vertical x–z plane. */
const spinAboutY = (speed: number): PartDriver => (motion, out) => {
  if (!(motion.motion > 0)) {
    restPose(out);
    return;
  }
  const half = (motion.spin * speed) / 2;
  out.dx = 0;
  out.dy = 0;
  out.dz = 0;
  out.qx = 0;
  out.qy = Math.sin(half);
  out.qz = 0;
  out.qw = Math.cos(half);
};

/**
 * A pod at the end of a vertical arm: carried round the hub about +y (offset (offsetX, offsetZ)
 * from it) and turning on its own axis at `podFactor` times the arm's angle (legacy −2.4).
 */
const podOnArm = (speed: number, offsetX: number, offsetZ: number, podFactor: number): PartDriver => (motion, out) => {
  if (!(motion.motion > 0)) {
    restPose(out);
    return;
  }
  const angle = motion.spin * speed;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  out.dx = offsetX * cos + offsetZ * sin - offsetX;
  out.dy = 0;
  out.dz = -offsetX * sin + offsetZ * cos - offsetZ;
  const half = (angle * podFactor) / 2;
  out.qx = 0;
  out.qy = Math.sin(half);
  out.qz = 0;
  out.qw = Math.cos(half);
};

/**
 * Phase 16, rocket-pendulum: a swing about the horizontal +y axis through the pivot, `maxSwing ·
 * motion` radians either side of hanging straight down, sinusoidal in spin (`speed` radians of phase
 * per motion-weighted millisecond). Unlike spinAboutY it never goes over the top: the arm and its
 * gondola sweep an arc in the model x–z plane between the A-frames.
 */
const pendulumAboutAxis = (speed: number, maxSwing: number): PartDriver => (motion, out) => {
  if (!(motion.motion > 0)) {
    restPose(out);
    return;
  }
  const angle = maxSwing * Math.min(1, motion.motion) * Math.sin(motion.spin * speed);
  out.dx = 0;
  out.dy = 0;
  out.dz = 0;
  out.qx = 0;
  out.qy = Math.sin(angle / 2);
  out.qz = 0;
  out.qw = Math.cos(angle / 2);
};

/**
 * Phase 16, puddle-jumpers: a rider carried rigidly round the ride centre at `orbitSpeed` (its pivot
 * at (pivotX, pivotY)) that hops straight up off its pad, `hop · motion` voxels at the top of each
 * jump, `hopSpeed` jumps per π of spin and `phase` apart from its neighbours. The hop is |sin|, so a
 * frog only ever rises from the pad it rests on and never dips into it.
 */
const orbitAndHop = (orbitSpeed: number, pivotX: number, pivotY: number, hop: number, hopSpeed: number, phase: number): PartDriver => (motion, out) => {
  if (!(motion.motion > 0)) {
    restPose(out);
    return;
  }
  const orbit = motion.spin * orbitSpeed;
  const cos = Math.cos(orbit);
  const sin = Math.sin(orbit);
  out.dx = pivotX * cos - pivotY * sin - pivotX;
  out.dy = pivotX * sin + pivotY * cos - pivotY;
  out.dz = hop * Math.min(1, motion.motion) * Math.abs(Math.sin(motion.spin * hopSpeed + phase));
  out.qx = 0;
  out.qy = 0;
  out.qz = Math.sin(orbit / 2);
  out.qw = Math.cos(orbit / 2);
};

/** Stadium point scratch: x, y (centre-relative) and heading, so path drivers allocate nothing. */
const STADIUM_POINT = new Float64Array(3);

/**
 * Point and heading at arc length `distance` along a stadium centre line: straights along x at
 * y = ±radius, semicircles about (±halfStraight, 0). It starts at the front-left end
 * (−halfStraight, +radius) heading +x and runs along the front (+y) first.
 */
const stadiumPoint = (halfStraight: number, radius: number, distance: number): void => {
  const straight = 2 * halfStraight;
  const arc = Math.PI * radius;
  const perimeter = 2 * straight + 2 * arc;
  let along = distance % perimeter;
  if (along < 0) along += perimeter;
  if (along < straight) {
    STADIUM_POINT[0] = -halfStraight + along;
    STADIUM_POINT[1] = radius;
    STADIUM_POINT[2] = 0;
  } else if (along < straight + arc) {
    const angle = Math.PI / 2 - (along - straight) / radius;
    STADIUM_POINT[0] = halfStraight + radius * Math.cos(angle);
    STADIUM_POINT[1] = radius * Math.sin(angle);
    STADIUM_POINT[2] = angle - Math.PI / 2;
  } else if (along < 2 * straight + arc) {
    STADIUM_POINT[0] = halfStraight - (along - straight - arc);
    STADIUM_POINT[1] = -radius;
    STADIUM_POINT[2] = -Math.PI;
  } else {
    const angle = -Math.PI / 2 - (along - 2 * straight - arc) / radius;
    STADIUM_POINT[0] = -halfStraight + radius * Math.cos(angle);
    STADIUM_POINT[1] = radius * Math.sin(angle);
    STADIUM_POINT[2] = angle - Math.PI / 2;
  }
};

const stadiumPerimeter = (halfStraight: number, radius: number): number => 4 * halfStraight + TAU * radius;

/**
 * The pivot of a vehicle resting at arc length `restDistance`: the track point, on whole voxels
 * (pivots must be integers; blueprint.ts).
 */
const stadiumPivot = (halfStraight: number, radius: number, restDistance: number): [number, number] => {
  stadiumPoint(halfStraight, radius, restDistance);
  return [Math.round(STADIUM_POINT[0]), Math.round(STADIUM_POINT[1])];
};

/**
 * A vehicle following the stadium track, with its pivot at `stadiumPivot(…, restDistance)`: it runs
 * `lapSpeed` laps per spin-millisecond — the legacy lap time whatever the track's length — yawing
 * with the track and turning on its own axis at `selfSpeed`. Offsets are measured from the rounded
 * pivot, not from the exact rest point, so the vehicle's centre runs exactly on the centre line
 * (a rounding error carried round the lap would push a boat into its channel's rim).
 */
const followStadium = (
  halfStraight: number,
  radius: number,
  restDistance: number,
  lapSpeed: number,
  selfSpeed: number,
): PartDriver => {
  const [pivotX, pivotY] = stadiumPivot(halfStraight, radius, restDistance);
  stadiumPoint(halfStraight, radius, restDistance);
  const restHeading = STADIUM_POINT[2];
  const perimeter = stadiumPerimeter(halfStraight, radius);
  return (motion, out) => {
    if (!(motion.motion > 0)) {
      restPose(out);
      return;
    }
    stadiumPoint(halfStraight, radius, restDistance + motion.spin * lapSpeed * perimeter);
    out.dx = STADIUM_POINT[0] - pivotX;
    out.dy = STADIUM_POINT[1] - pivotY;
    out.dz = 0;
    const half = (STADIUM_POINT[2] - restHeading + motion.spin * selfSpeed) / 2;
    out.qx = 0;
    out.qy = 0;
    out.qz = Math.sin(half);
    out.qw = Math.cos(half);
  };
};

// ------------------------------------------------------------------ ride kit

/** A moving part, authored centre-relative like everything else. */
interface MovingPart {
  /** Unique across every flat ride: the drivers of all rides share one record keyed by it. */
  id: string;
  /** Centre-relative x and y, absolute z; whole voxels. */
  pivot: Vec3;
  driver: PartDriver;
  shapes(materials: RideMaterials): Shape[];
}

/** One ride id's parameters: its static body, its moving parts and its lights. */
interface RideDesign {
  key: string;
  body(materials: RideMaterials): Shape[];
  parts: readonly MovingPart[];
  /** Centre-relative light positions. */
  lights: readonly LightSource[];
}

const bulbLight = (x: number, y: number, z: number): LightSource =>
  ({ position: [x, y, z], radius: BULB_LIGHT_RADIUS, color: MAT_COLOR.BULB, presets: EVENING });

interface Bulbs {
  shapes: Shape[];
  lights: LightSource[];
}

/**
 * 2×2×2 BULB boxes around a horizontal circle, and a light at evenly spaced ones (at most
 * MAX_BULB_LIGHTS), each light at its bulb's centre.
 */
const bulbRing = (count: number, radius: number, z: number, phase: number): Bulbs => {
  const bulbs: Bulbs = { shapes: [], lights: [] };
  const lightEvery = Math.max(1, Math.ceil(count / MAX_BULB_LIGHTS));
  for (let index = 0; index < count; index += 1) {
    const [x, y] = polar(radius, phase + (index / count) * TAU);
    bulbs.shapes.push(box([x - 1, y - 1, z], [2, 2, 2], MAT.BULB));
    if (index % lightEvery === 0) bulbs.lights.push(bulbLight(x, y, z + 1));
  }
  return bulbs;
};

/**
 * Round platform, 4 voxels tall (art bible): a skirt in `skirt` whose top shows as a 2-voxel rim
 * around a 1-voxel deck layer. Two stacked cylinders cost ~100 boxes; a trim ring cut into one
 * cylinder costs ~170.
 */
const roundDeck = (radius: number, material: number, pattern: number, skirt: number): Shape[] => [
  cylinder([0, 0, PLOT_TOP_Z], radius, DECK_SKIRT_TOP_Z - PLOT_TOP_Z, 'z', skirt),
  cylinder([0, 0, DECK_SKIRT_TOP_Z], radius - 2, DECK_TOP_Z - DECK_SKIRT_TOP_Z, 'z', material, pattern),
];

interface CanopyStyle {
  baseZ: number;
  radius: number;
  height: number;
  /** Layers per stripe (0: plain); stripes alternate the catalog colour with `stripe`. */
  band: number;
  stripe: number | 'accent' | 'canvas';
  /** Petal scallops in alternating accent and colour around the rim (0: a plain valance). */
  petals: number;
}

/**
 * Umbrella canopy: a cone in the catalog colour — striped layer by layer, which costs no boxes where
 * radial ribs would cost ~60 each — over a valance (a disc: under the cone it looks exactly like a
 * ring and costs 50 boxes instead of 120) or petal scallops, and a finial. Static: legacy canopies
 * never turn.
 */
const umbrella = (style: CanopyStyle, materials: RideMaterials): Shape[] => {
  const { baseZ, radius, height, band, stripe, petals } = style;
  const apexZ = baseZ + height;
  const topRadius = 2;
  const shapes: Shape[] = [];
  if (band > 0) {
    const stripeMaterial = stripe === 'accent' ? materials.accent : stripe === 'canvas' ? materials.canvas : stripe;
    for (let layer = 0, index = 0; layer < height; layer += band, index += 1) {
      const layers = Math.min(band, height - layer);
      const from = radius + (topRadius - radius) * (layer / height);
      const to = radius + (topRadius - radius) * ((layer + layers) / height);
      shapes.push(cone([0, 0, baseZ + layer], from, layers, to, index % 2 === 0 ? materials.color : stripeMaterial, PATTERN.FABRIC));
    }
  } else {
    shapes.push(cone([0, 0, baseZ], radius, height, topRadius, materials.color, PATTERN.FABRIC));
  }
  if (petals > 0) {
    shapes.push(cylinder([0, 0, baseZ - 3], radius - 4, 3, 'z', materials.accent));
    for (let index = 0; index < petals; index += 1) {
      const [x, y] = polar(radius - 3, (index + 0.5) / petals * TAU);
      shapes.push(cylinder([x, y, baseZ - 3], 5, 3, 'z', index % 2 === 0 ? materials.accent : materials.color));
    }
  } else {
    // One voxel wider than the cone: its top shows a 2-voxel rim (a 1-voxel rim on a top face would
    // break up under the top-face parity rule, contracts/palette.ts).
    shapes.push(cylinder([0, 0, baseZ - 3], radius + 1, 3, 'z', materials.accent));
  }
  shapes.push(ellipsoid([0, 0, apexZ + 2], [3, 3, 4], materials.accent));
  return shapes;
};

/** The operator's booth: steel walls, a roof in the catalog colour and a lit window facing +y (the front). */
const booth = (minX: number, minY: number, materials: RideMaterials): Shape[] => [
  box([minX, minY, PLOT_TOP_Z], [10, 8, 12], MAT.STEEL, PATTERN.METAL),
  box([minX + 2, minY + 7, PLOT_TOP_Z + 5], [6, 1, 4], MAT.WINDOW_GLOW),
  box([minX - 1, minY - 1, PLOT_TOP_Z + 12], [12, 10, 2], materials.color),
  box([minX, minY, PLOT_TOP_Z + 14], [10, 8, 2], materials.accent),
];

const boothLight = (minX: number, minY: number): LightSource =>
  ({ position: [minX + 5, minY + 9, PLOT_TOP_Z + 7], radius: WINDOW_LIGHT_RADIUS, color: MAT_COLOR.WINDOW_GLOW, presets: EVENING });

/** Booth corner for a round ride on a 3×3 plot: outside the platform and every sweep, its roof clear of the fence band. */
const ROUND_BOOTH: readonly [number, number] = [34, 35];

// ------------------------------------------------------------------ the rides

/** Petal Roundabout: six petal bowls on arms from a hub (0.0011), under a striped flower canopy with a scalloped rim. */
const petalRoundabout = (): RideDesign => {
  const key = 'petal-roundabout';
  const speed = 0.0011;
  const canopy: CanopyStyle = { baseZ: 80, radius: 40, height: 18, band: 3, stripe: 'accent', petals: 12 };
  const bulbs = bulbRing(12, canopy.radius - 1, canopy.baseZ - 5, Math.PI / 12);
  const bowlRadius = 30;
  const bowlZ = 26;
  return {
    key,
    body: (materials) => [
      ...roundDeck(43, MAT.WOOD, PATTERN.PLANKS, materials.accent),
      cylinder([0, 0, DECK_TOP_Z], 4, canopy.baseZ + 4 - DECK_TOP_Z, 'z', MAT.STEEL, PATTERN.METAL),
      ...umbrella(canopy, materials),
      ...bulbs.shapes,
      ...booth(ROUND_BOOTH[0], ROUND_BOOTH[1], materials),
    ],
    parts: [{
      id: `${key}:rotor`,
      pivot: [0, 0, DECK_TOP_Z],
      driver: spinAboutZ(speed),
      shapes: (materials) => {
        const shapes: Shape[] = [ring([0, 0, 63], 7, 4, 6, 'z', materials.accent)];
        for (let index = 0; index < 6; index += 1) {
          const angle = (index / 6) * TAU + Math.PI / 6;
          const [x, y] = polar(bowlRadius, angle);
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const material = index % 2 === 0 ? materials.color : materials.accent;
          shapes.push(segment([cos * 8, sin * 8, 63], [cos * 24, sin * 24, bowlZ + 7], 1.2, MAT.STEEL_LIGHT));
          shapes.push(cylinder([x, y, bowlZ], 5, 2, 'z', material));
          shapes.push(cylinder([x, y, bowlZ + 2], 7, 5, 'z', material));
          shapes.push(cylinder([x, y, bowlZ + 3], 5, 6, 'z', 0));
          shapes.push(...rider(x - 2, y, bowlZ + 3, index * 2, materials), ...rider(x + 2, y, bowlZ + 3, index * 2 + 1, materials));
        }
        return shapes;
      },
    }],
    lights: [...bulbs.lights, boothLight(ROUND_BOOTH[0], ROUND_BOOTH[1])],
  };
};

/** Comet Cups: a turntable (0.0009) carrying three plates of two cups that counter-spin (−0.0034). */
const cometCups = (): RideDesign => {
  const key = 'comet-cups';
  const speed = 0.0009;
  const cupSpeed = -0.0034;
  const plateRadius = 24;
  const plateZ = DECK_TOP_Z + 2;
  const bulbs = bulbRing(6, 11, 24, 0);
  const plates: MovingPart[] = [0, 1, 2].map((plate) => {
    const [x, y] = polar(plateRadius, Math.PI / 2 + (plate / 3) * TAU);
    return {
      id: `${key}:plate-${plate}`,
      pivot: [x, y, plateZ],
      driver: orbitAndSpin(speed, x, y, cupSpeed),
      shapes: (materials) => {
        const shapes: Shape[] = [cylinder([x, y, plateZ], 12, 2, 'z', MAT.STEEL, PATTERN.METAL)];
        for (const side of [-1, 1]) {
          const cupX = x + side * 6;
          const material = side < 0 ? materials.color : materials.accent;
          shapes.push(cylinder([cupX, y, plateZ + 2], 5, 8, 'z', material));
          shapes.push(cylinder([cupX, y, plateZ + 4], 3, 6, 'z', 0));
          // The handle is what sells the spin: it sweeps round as the cup turns.
          shapes.push(box([cupX + side * 5 - (side < 0 ? 2 : 0), y - 1, plateZ + 4], [2, 2, 4], material));
          shapes.push(...rider(cupX, y, plateZ + 4, plate * 2 + (side < 0 ? 0 : 1), materials));
        }
        return shapes;
      },
    };
  });
  return {
    key,
    body: (materials) => [
      ...roundDeck(43, MAT.CONCRETE, PATTERN.COBBLE, materials.color),
      cylinder([0, 0, DECK_TOP_Z], 5, 26 - DECK_TOP_Z, 'z', MAT.STEEL, PATTERN.METAL),
      cone([0, 0, 26], 11, 10, 3, materials.color, PATTERN.FABRIC),
      ellipsoid([0, 0, 38], [4, 4, 4], materials.accent),
      ...bulbs.shapes,
      ...booth(ROUND_BOOTH[0], ROUND_BOOTH[1], materials),
    ],
    parts: [
      {
        id: `${key}:turntable`,
        pivot: [0, 0, DECK_TOP_Z],
        driver: spinAboutZ(speed),
        shapes: (materials) => [
          ring([0, 0, DECK_TOP_Z + 1], 25, 34, 2, 'z', MAT.STEEL_LIGHT, PATTERN.METAL),
          ring([0, 0, DECK_TOP_Z + 1], 40.5, 3, 2, 'z', materials.accent),
        ],
      },
      ...plates,
    ],
    lights: [...bulbs.lights, boothLight(ROUND_BOOTH[0], ROUND_BOOTH[1])],
  };
};

/** Harbor Swings: a tall tower, a striped crown (0.0016) and eight chairs on long chains that swing out. */
const harborSwings = (): RideDesign => {
  const key = 'harbor-swings';
  const speed = 0.0016;
  const crownZ = 84;
  const canopy: CanopyStyle = { baseZ: 95, radius: 34, height: 16, band: 2, stripe: 'canvas', petals: 0 };
  const seatZ = 44;
  const anchorRadius = 22;
  /** Legacy chairs lean out 0.42·motion; 0.4 rad on 40 voxels of chain keeps a flown-out chair clear of the fence band. */
  const maxSwing = 0.4;
  const bulbs = bulbRing(8, canopy.radius - 1, canopy.baseZ - 5, Math.PI / 8);
  /**
   * A legacy swing chair: seat, two side bars beside the rider, a top bar over their head and ONE
   * pale chain up to the crown. Two full-length chains per chair read as a colonnade at one texel
   * per voxel (a 2×2 column is 4 texels wide on screen), so the frame carries the chair instead.
   */
  const frameTopZ = seatZ + 12;
  const chairs: MovingPart[] = Array.from({ length: 8 }, (_unused, index) => {
    const angle = (index / 8) * TAU;
    const [x, y] = polar(anchorRadius, angle);
    // The side bars stand across whichever axis is closer to the tangent, so they stay single boxes.
    const alongX = Math.abs(Math.sin(angle)) > Math.abs(Math.cos(angle));
    return {
      id: `${key}:chair-${index}`,
      pivot: [x, y, crownZ],
      driver: swingOut(speed, x, y, maxSwing),
      shapes: (materials) => {
        const material = index % 2 === 0 ? materials.color : materials.accent;
        const shapes: Shape[] = [box([x - 3, y - 3, seatZ], [6, 6, 2], material)];
        for (const side of [-1, 1]) {
          const barX = alongX ? x + side * 3 - 1 : x - 1;
          const barY = alongX ? y - 1 : y + side * 3 - 1;
          shapes.push(box([barX, barY, seatZ + 2], [2, 2, frameTopZ - seatZ - 2], MAT.STEEL_LIGHT));
        }
        shapes.push(alongX
          ? box([x - 4, y - 1, frameTopZ], [8, 2, 2], material)
          : box([x - 1, y - 4, frameTopZ], [2, 8, 2], material));
        shapes.push(box([x - 1, y - 1, frameTopZ + 2], [2, 2, crownZ - frameTopZ - 2], MAT.FENCE_RAIL));
        shapes.push(...rider(x, y, seatZ + 2, index, materials));
        return shapes;
      },
    };
  });
  return {
    key,
    body: (materials) => [
      ...roundDeck(43, MAT.TIMBER, PATTERN.PLANKS, materials.accent),
      cone([0, 0, DECK_TOP_Z], 7, crownZ - DECK_TOP_Z, 4, MAT.STEEL, PATTERN.METAL),
      cylinder([0, 0, crownZ], 4, canopy.baseZ + 2 - crownZ, 'z', MAT.STEEL, PATTERN.METAL),
      ...umbrella(canopy, materials),
      ...bulbs.shapes,
      ...booth(ROUND_BOOTH[0], ROUND_BOOTH[1], materials),
    ],
    parts: [
      {
        id: `${key}:crown`,
        pivot: [0, 0, crownZ],
        driver: spinAboutZ(speed),
        shapes: (materials) => [ring([0, 0, crownZ + 2.5], 14.5, 15, 5, 'z', materials.accent, PATTERN.STRIPES)],
      },
      ...chairs,
    ],
    lights: [...bulbs.lights, boothLight(ROUND_BOOTH[0], ROUND_BOOTH[1])],
  };
};

/** Thunder Drum: a drum of riders spinning fast (0.0028), tipping and rising under a crown ring. */
const thunderDrum = (): RideDesign => {
  const key = 'thunder-drum';
  const speed = 0.0028;
  const drumZ = DECK_TOP_Z + 4;
  const crownZ = 46;
  const bulbs = bulbRing(8, 40, crownZ + 4, Math.PI / 8);
  return {
    key,
    body: (materials) => {
      const shapes: Shape[] = [
        ...roundDeck(43, MAT.STONE, PATTERN.COBBLE, materials.accent),
        cylinder([0, 0, DECK_TOP_Z], 8, drumZ - DECK_TOP_Z, 'z', MAT.STEEL, PATTERN.METAL),
      ];
      for (let index = 0; index < 4; index += 1) {
        const [x, y] = polar(40, Math.PI / 4 + (index / 4) * TAU);
        shapes.push(box([x - 1, y - 1, DECK_TOP_Z], [3, 3, crownZ - DECK_TOP_Z], MAT.STEEL, PATTERN.METAL));
      }
      shapes.push(ring([0, 0, crownZ + 2], 40, 4, 4, 'z', materials.color, PATTERN.STRIPES));
      shapes.push(...bulbs.shapes, ...booth(ROUND_BOOTH[0], ROUND_BOOTH[1], materials));
      return shapes;
    },
    parts: [{
      id: `${key}:drum`,
      pivot: [0, 0, drumZ],
      driver: tiltingDrum(speed, 1, 1, 6),
      shapes: (materials) => {
        const shapes: Shape[] = [
          cylinder([0, 0, drumZ], 25, 2, 'z', MAT.STEEL_LIGHT, PATTERN.METAL),
          ring([0, 0, drumZ + 13], 26, 4, 26, 'z', materials.color),
          ring([0, 0, drumZ + 13], 26.5, 5, 4, 'z', materials.accent),
          ring([0, 0, drumZ + 25], 26.5, 5, 2, 'z', materials.accent),
        ];
        for (let index = 0; index < 6; index += 1) {
          const [x, y] = polar(21, (index / 6) * TAU);
          shapes.push(...rider(x, y, drumZ + 8, index, materials));
        }
        return shapes;
      },
    }],
    lights: [...bulbs.lights, boothLight(ROUND_BOOTH[0], ROUND_BOOTH[1])],
  };
};

/** Gale Spinner: an arm turning in a vertical plane (0.0013) inside a gale ring, pods counter-rotating ×−2.4. */
const galeSpinner = (): RideDesign => {
  const key = 'gale-spinner';
  const speed = 0.0013;
  const hubZ = 56;
  const armLength = 32;
  const frameY = -8;
  const galeRadius = 42;
  const bulbs: Bulbs = { shapes: [], lights: [] };
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * TAU + Math.PI / 8;
    const x = Math.round(Math.cos(angle) * galeRadius);
    const z = Math.round(hubZ + Math.sin(angle) * galeRadius);
    bulbs.shapes.push(box([x - 1, frameY + 4, z - 1], [2, 2, 2], MAT.BULB));
    if (index % 2 === 0) bulbs.lights.push(bulbLight(x, frameY + 5, z));
  }
  const pods: MovingPart[] = [-1, 1].map((side, index) => {
    const x = side * armLength;
    return {
      id: `${key}:pod-${index}`,
      pivot: [x, 6, hubZ],
      driver: podOnArm(speed, x, 0, -2.4),
      shapes: (materials) => {
        const shapes: Shape[] = [
          cylinder([x, 4, hubZ], 9, 5, 'y', index === 0 ? materials.color : materials.accent),
          cylinder([x, 9, hubZ], 3, 2, 'y', MAT.STEEL),
        ];
        for (let seat = 0; seat < 4; seat += 1) {
          const angle = Math.PI / 4 + (seat / 4) * TAU;
          const seatX = Math.round(x + Math.cos(angle) * 5);
          const seatZ = Math.round(hubZ + Math.sin(angle) * 5);
          shapes.push(box([seatX - 2, 9, seatZ - 2], [4, 3, 4], SKIN_MATERIALS[(seat + index) % SKIN_MATERIALS.length]));
        }
        return shapes;
      },
    };
  });
  return {
    key,
    body: (materials) => [
      ...roundDeck(40, MAT.STEEL_LIGHT, PATTERN.METAL, materials.accent),
      segment([-30, frameY, DECK_TOP_Z], [0, frameY, hubZ], 2, MAT.STEEL, PATTERN.METAL),
      segment([30, frameY, DECK_TOP_Z], [0, frameY, hubZ], 2, MAT.STEEL, PATTERN.METAL),
      segment([-18, frameY, 28], [18, frameY, 28], 1.5, MAT.STEEL),
      // The axle ends face to face on the arm's hub (y = −2), which turns with the arm.
      cylinder([0, frameY - 2, hubZ], 4, -2 - (frameY - 2), 'y', MAT.STEEL_LIGHT, PATTERN.METAL),
      ring([0, frameY + 3, hubZ], galeRadius, 3, 3, 'y', materials.color, PATTERN.STRIPES),
      ...bulbs.shapes,
      ...booth(ROUND_BOOTH[0], ROUND_BOOTH[1], materials),
    ],
    parts: [
      {
        id: `${key}:arm`,
        pivot: [0, 1, hubZ],
        driver: spinAboutY(speed),
        shapes: (materials) => [
          box([-armLength, -1, hubZ - 3], [2 * armLength, 5, 6], materials.color, PATTERN.STRIPES),
          cylinder([0, -2, hubZ], 6, 6, 'y', MAT.STEEL, PATTERN.METAL),
          cylinder([0, 4, hubZ], 3, 2, 'y', materials.accent),
        ],
      },
      ...pods,
    ],
    lights: [...bulbs.lights, boothLight(ROUND_BOOTH[0], ROUND_BOOTH[1])],
  };
};

/**
 * Bumble Coach: a locomotive and three coaches on an oval along the plot's long axis (model x, so
 * a quarter turn carries it with the footprint), lap 2π/0.0007 spin-ms like legacy. The station
 * stands behind the back straight: a roof over the front straight would hide the train from the
 * camera, which looks down from the front.
 */
const bumbleCoach = (): RideDesign => {
  const key = 'bumble-coach';
  const lapSpeed = 0.0007 / TAU;
  const halfStraight = 28;
  const radius = 16;
  const trackZ = PLOT_TOP_Z + 3;
  const carGap = 13;
  const stationY = -29;
  const roofZ = 22;
  const boothAt: readonly [number, number] = [48, 20];
  const bulbs: Bulbs = { shapes: [], lights: [] };
  for (const x of [-18, -6, 6, 18]) {
    bulbs.shapes.push(box([x - 1, stationY + 7, roofZ - 4], [2, 2, 2], MAT.BULB));
    bulbs.lights.push(bulbLight(x, stationY + 8, roofZ - 3));
  }
  const cars: MovingPart[] = [0, 1, 2, 3].map((index) => {
    const restDistance = 2 * halfStraight - 9 - index * carGap;
    const [x, y] = stadiumPivot(halfStraight, radius, restDistance);
    return {
      id: `${key}:car-${index}`,
      pivot: [x, y, trackZ],
      driver: followStadium(halfStraight, radius, restDistance, lapSpeed, 0),
      shapes: (materials) => {
        const shapes: Shape[] = [box([x - 5, y - 4, trackZ], [10, 8, 2], materials.accent)];
        if (index === 0) {
          shapes.push(box([x - 5, y - 4, trackZ + 2], [4, 8, 8], materials.color));
          shapes.push(box([x - 6, y - 5, trackZ + 10], [6, 10, 2], materials.accent));
          shapes.push(cylinder([x - 1, y, trackZ + 5.5], 3.5, 6, 'x', materials.color, PATTERN.STRIPES));
          shapes.push(box([x + 2, y - 1, trackZ + 8], [2, 2, 5], materials.accent));
          shapes.push(box([x + 3, y - 1, trackZ + 3], [2, 2, 2], MAT.BULB));
        } else {
          shapes.push(box([x - 5, y - 4, trackZ + 2], [10, 8, 4], materials.color, PATTERN.STRIPES));
          shapes.push(...rider(x - 2, y, trackZ + 3, index * 2, materials), ...rider(x + 3, y, trackZ + 3, index * 2 + 1, materials));
        }
        return shapes;
      },
    };
  });
  return {
    key,
    body: (materials) => [
      ...stadiumBand(halfStraight, radius - 6, radius + 6, PLOT_TOP_Z, 2, MAT.STONE, PATTERN.SPECKLE),
      ...stadiumBand(halfStraight, radius - 4, radius - 2, PLOT_TOP_Z + 2, 1, MAT.STEEL_LIGHT),
      ...stadiumBand(halfStraight, radius + 2, radius + 4, PLOT_TOP_Z + 2, 1, MAT.STEEL_LIGHT),
      box([-2, -2, PLOT_TOP_Z], [4, 4, 16], MAT.TIMBER, PATTERN.PLANKS),
      ellipsoid([0, 0, 22], [9, 8, 7], MAT.FOLIAGE, PATTERN.FOLIAGE),
      ellipsoid([3, 1, 26], [6, 6, 5], MAT.FOLIAGE_DARK, PATTERN.FOLIAGE),
      box([-24, stationY, PLOT_TOP_Z], [48, 6, 4], MAT.CONCRETE, PATTERN.PAVING),
      box([-22, stationY, DECK_TOP_Z], [2, 2, roofZ - DECK_TOP_Z], MAT.STEEL),
      box([20, stationY, DECK_TOP_Z], [2, 2, roofZ - DECK_TOP_Z], MAT.STEEL),
      box([-26, stationY - 1, roofZ], [52, 9, 3], materials.color, PATTERN.STRIPES),
      box([-26, stationY + 8, roofZ - 2], [52, 2, 5], materials.accent),
      ...bulbs.shapes,
      ...booth(boothAt[0], boothAt[1], materials),
    ],
    parts: cars,
    lights: [...bulbs.lights, boothLight(boothAt[0], boothAt[1])],
  };
};

/** Splash Rings: round boats (lap 2π/0.0006 spin-ms) circling an oval water channel through two hoops. */
const splashRings = (): RideDesign => {
  const key = 'splash-rings';
  const lapSpeed = 0.0006 / TAU;
  const halfStraight = 20;
  const radius = 28;
  /** The channel is 18 wide and a boat 15: a voxel and a half of water on each side, turning or not. */
  const channelHalfWidth = 9;
  const waterZ = PLOT_TOP_Z + 3;
  const perimeter = stadiumPerimeter(halfStraight, radius);
  const boothAt: readonly [number, number] = [48, 37];
  const bulbs: Bulbs = { shapes: [], lights: [] };
  for (const side of [-1, 1]) {
    bulbs.shapes.push(box([-1, side * radius - 1, 22], [2, 2, 2], MAT.BULB));
    bulbs.lights.push(bulbLight(0, side * radius, 23));
  }
  const boats: MovingPart[] = [0, 1, 2, 3].map((index) => {
    const restDistance = halfStraight + index * (perimeter / 4);
    const [x, y] = stadiumPivot(halfStraight, radius, restDistance);
    return {
      id: `${key}:boat-${index}`,
      pivot: [x, y, waterZ],
      driver: followStadium(halfStraight, radius, restDistance, lapSpeed, 0.0015),
      shapes: (materials) => [
        ring([x, y, waterZ + 1.5], 5.5, 4, 3, 'z', index % 2 === 0 ? materials.color : materials.accent),
        cylinder([x, y, waterZ], 3, 2, 'z', MAT.STEEL),
        ...rider(x - 2, y, waterZ + 2, index * 2, materials),
        ...rider(x + 2, y, waterZ + 2, index * 2 + 1, materials),
      ],
    };
  });
  return {
    key,
    body: (materials) => [
      ...stadiumDisc(halfStraight, radius + channelHalfWidth + 3, PLOT_TOP_Z, DECK_TOP_Z - PLOT_TOP_Z, MAT.CONCRETE, PATTERN.COBBLE),
      ...stadiumBand(halfStraight, radius - channelHalfWidth, radius + channelHalfWidth, PLOT_TOP_Z, waterZ - PLOT_TOP_Z, MAT.WATER, PATTERN.WATER),
      ...stadiumBand(halfStraight, radius - channelHalfWidth, radius + channelHalfWidth, waterZ, DECK_TOP_Z - waterZ, 0),
      ring([0, radius, 6], 15, 3, 4, 'x', materials.color, PATTERN.STRIPES),
      ring([0, -radius, 6], 15, 3, 4, 'x', materials.color, PATTERN.STRIPES),
      cylinder([0, 0, DECK_TOP_Z], 4, 28, 'z', materials.accent, PATTERN.STRIPES),
      box([-2, -2, DECK_TOP_Z + 28], [4, 4, 4], MAT.BULB),
      cone([0, 0, DECK_TOP_Z + 32], 6, 6, 1, materials.color),
      ...bulbs.shapes,
      ...booth(boothAt[0], boothAt[1], materials),
    ],
    parts: boats,
    lights: [...bulbs.lights, bulbLight(0, 0, DECK_TOP_Z + 30), boothLight(boothAt[0], boothAt[1])],
  };
};

/** Any other ride id: the legacy generic spinner (six cars on a hub, 0.0012) under a small umbrella. */
const genericSpinner = (): RideDesign => {
  const key = 'generic';
  const speed = 0.0012;
  const canopy: CanopyStyle = { baseZ: 60, radius: 30, height: 14, band: 2, stripe: MAT.WHITE, petals: 0 };
  const bulbs = bulbRing(8, canopy.radius - 1, canopy.baseZ - 5, Math.PI / 8);
  return {
    key,
    body: (materials) => [
      ...roundDeck(40, MAT.CONCRETE, PATTERN.COBBLE, materials.accent),
      cylinder([0, 0, DECK_TOP_Z], 4, canopy.baseZ + 2 - DECK_TOP_Z, 'z', MAT.STEEL, PATTERN.METAL),
      ...umbrella(canopy, materials),
      ...bulbs.shapes,
      ...booth(ROUND_BOOTH[0], ROUND_BOOTH[1], materials),
    ],
    parts: [{
      id: `${key}:rotor`,
      pivot: [0, 0, DECK_TOP_Z],
      driver: spinAboutZ(speed),
      shapes: (materials) => {
        const shapes: Shape[] = [ring([0, 0, DECK_TOP_Z + 13], 7, 4, 4, 'z', materials.accent)];
        for (let index = 0; index < 6; index += 1) {
          const angle = (index / 6) * TAU;
          const [x, y] = polar(26, angle);
          shapes.push(segment([Math.cos(angle) * 8, Math.sin(angle) * 8, DECK_TOP_Z + 13], [x, y, DECK_TOP_Z + 13], 1.2, MAT.STEEL_LIGHT));
          shapes.push(box([x - 5, y - 4, DECK_TOP_Z + 8], [10, 8, 6], index % 2 === 0 ? materials.color : materials.accent));
          shapes.push(...rider(x, y, DECK_TOP_Z + 11, index, materials));
        }
        return shapes;
      },
    }],
    lights: [...bulbs.lights, boothLight(ROUND_BOOTH[0], ROUND_BOOTH[1])],
  };
};

// ------------------------------------------------------------------ Phase 16 rides

/**
 * Puddle Jumpers (2×2): four frogs, each with a rider, on lily pads round a pond. The pad ring turns
 * slowly (0.0010) and each frog hops off its pad and lands back on it, the frogs a quarter jump apart,
 * under a small lily-leaf umbrella on a mast that stands on a stone island.
 */
const puddleJumpers = (): RideDesign => {
  const key = 'puddle-jumpers';
  const speed = 0.001;
  const hop = 6;
  const hopSpeed = 0.004;
  const padZ = DECK_TOP_Z;
  const frogZ = padZ + 2;
  const frogRadius = 15;
  const canopy: CanopyStyle = { baseZ: 44, radius: 19, height: 10, band: 2, stripe: 'accent', petals: 0 };
  const bulbs = bulbRing(6, canopy.radius - 2, canopy.baseZ - 5, Math.PI / 6);
  const boothAt: readonly [number, number] = [18, 20];
  const frogs: MovingPart[] = [0, 1, 2, 3].map((index) => {
    const angle = Math.PI / 4 + (index / 4) * TAU;
    const [x, y] = polar(frogRadius, angle);
    // The frog faces along its orbit: its head leads.
    const [headX, headY] = polar(4, angle + Math.PI / 2);
    return {
      id: `${key}:frog-${index}`,
      pivot: [x, y, frogZ],
      driver: orbitAndHop(speed, x, y, hop, hopSpeed, (index * Math.PI) / 4),
      shapes: (materials) => [
        ellipsoid([x, y, frogZ + 3], [5, 5, 3], materials.color),
        ellipsoid([x + headX, y + headY, frogZ + 6], [3, 3, 2], materials.color),
        box([x + headX - 3, y + headY - 1, frogZ + 7], [2, 2, 2], materials.accent),
        box([x + headX + 1, y + headY - 1, frogZ + 7], [2, 2, 2], materials.accent),
        ...rider(x - Math.round(headX / 2), y - Math.round(headY / 2), frogZ + 5, index, materials),
      ],
    };
  });
  return {
    key,
    body: (materials) => [
      ...roundDeck(25, MAT.WATER, PATTERN.WATER, materials.accent),
      cylinder([0, 0, DECK_TOP_Z], 7, 3, 'z', MAT.STONE, PATTERN.COBBLE),
      cylinder([0, 0, DECK_TOP_Z + 3], 3, canopy.baseZ + 2 - DECK_TOP_Z - 3, 'z', MAT.STEEL, PATTERN.METAL),
      ...umbrella(canopy, materials),
      ...bulbs.shapes,
      ...booth(boothAt[0], boothAt[1], materials),
    ],
    parts: [
      {
        id: `${key}:pads`,
        pivot: [0, 0, padZ],
        driver: spinAboutZ(speed),
        shapes: (materials) => {
          const shapes: Shape[] = [ring([0, 0, padZ + 1], 15, 10, 2, 'z', MAT.FOLIAGE_DARK, PATTERN.FOLIAGE)];
          for (let index = 0; index < 4; index += 1) {
            const [x, y] = polar(frogRadius, Math.PI / 4 + (index / 4) * TAU);
            shapes.push(cylinder([x, y, padZ], 6, 2, 'z', materials.accent));
          }
          return shapes;
        },
      },
      ...frogs,
    ],
    lights: [...bulbs.lights, boothLight(boothAt[0], boothAt[1])],
  };
};

/**
 * Rocket Pendulum (3×3): a rocket gondola of six riders on an arm that swings (0.0011, ±0.5 rad)
 * between two A-frames in the catalog colour. The A-frames stand either side of the swing plane, the
 * axle ends face to face on the arm's hub like the gale spinner's, and bulbs climb the legs.
 */
const rocketPendulum = (): RideDesign => {
  const key = 'rocket-pendulum';
  const speed = 0.0011;
  const maxSwing = 0.5;
  const pivotZ = 82;
  const frameY = 19;
  const legX = 32;
  const hubHalf = 7;
  const rocketZ = 26;
  const seatZ = rocketZ + 4;
  const bulbs: Bulbs = { shapes: [], lights: [] };
  for (const side of [-1, 1]) {
    for (const along of [0.35, 0.7]) {
      const x = Math.round(side * legX * (1 - along));
      const z = Math.round(DECK_TOP_Z + (pivotZ - DECK_TOP_Z) * along);
      bulbs.shapes.push(box([x - 1, frameY + 2, z - 1], [2, 2, 2], MAT.BULB));
      bulbs.lights.push(bulbLight(x, frameY + 3, z));
    }
  }
  return {
    key,
    body: (materials) => {
      const shapes: Shape[] = [...roundDeck(42, MAT.CONCRETE, PATTERN.COBBLE, materials.accent)];
      for (const y of [-frameY, frameY]) {
        shapes.push(segment([-legX, y, DECK_TOP_Z], [0, y, pivotZ + 2], 2.5, materials.color));
        shapes.push(segment([legX, y, DECK_TOP_Z], [0, y, pivotZ + 2], 2.5, materials.color));
        shapes.push(segment([-legX / 2, y, (DECK_TOP_Z + pivotZ) / 2], [legX / 2, y, (DECK_TOP_Z + pivotZ) / 2], 1.5, MAT.STEEL));
        shapes.push(box([-legX - 3, y - 3, DECK_TOP_Z], [6, 6, 3], MAT.STEEL, PATTERN.METAL));
        shapes.push(box([legX - 3, y - 3, DECK_TOP_Z], [6, 6, 3], MAT.STEEL, PATTERN.METAL));
        shapes.push(ellipsoid([0, y, pivotZ + 5], [4, 4, 4], materials.accent));
      }
      // The axle runs from each A-frame to the hub face, never into the turning hub.
      shapes.push(cylinder([0, -frameY, pivotZ], 3, frameY - hubHalf, 'y', MAT.STEEL_LIGHT, PATTERN.METAL));
      shapes.push(cylinder([0, hubHalf, pivotZ], 3, frameY - hubHalf, 'y', MAT.STEEL_LIGHT, PATTERN.METAL));
      shapes.push(...bulbs.shapes, ...booth(ROUND_BOOTH[0], ROUND_BOOTH[1], materials));
      return shapes;
    },
    parts: [{
      id: `${key}:arm`,
      pivot: [0, 0, pivotZ],
      driver: pendulumAboutAxis(speed, maxSwing),
      shapes: (materials) => {
        const shapes: Shape[] = [
          cylinder([0, -hubHalf, pivotZ], 5, 2 * hubHalf, 'y', MAT.STEEL, PATTERN.METAL),
          box([-2, -2, rocketZ + 24], [4, 4, pivotZ - 4 - rocketZ - 24], materials.color, PATTERN.STRIPES),
          // The rocket: a nose cone up into the arm, a body striped in both colours, fins and a nozzle.
          cone([0, 0, rocketZ + 16], 6, 8, 2, materials.accent),
          cylinder([0, 0, rocketZ + 10], 6, 6, 'z', materials.color),
          cylinder([0, 0, rocketZ + 6], 6, 4, 'z', materials.accent),
          cylinder([0, 0, rocketZ], 6, 6, 'z', materials.color),
          cylinder([0, 0, rocketZ - 4], 4, 4, 'z', MAT.STEEL, PATTERN.METAL),
          box([-10, -1, rocketZ - 4], [4, 2, 8], materials.accent),
          box([6, -1, rocketZ - 4], [4, 2, 8], materials.accent),
          box([-1, -10, rocketZ - 4], [2, 4, 8], materials.accent),
          box([-1, 6, rocketZ - 4], [2, 4, 8], materials.accent),
          ring([0, 0, seatZ - 1], 9, 4, 2, 'z', materials.accent),
        ];
        for (let index = 0; index < 6; index += 1) {
          const [x, y] = polar(9, Math.PI / 6 + (index / 6) * TAU);
          shapes.push(...rider(x, y, seatZ, index, materials));
        }
        return shapes;
      },
    }],
    lights: [...bulbs.lights, boothLight(ROUND_BOOTH[0], ROUND_BOOTH[1])],
  };
};

/**
 * Temple Trek (4×3): a covered dark ride. A stepped temple in the catalog colour on a stone base fills
 * the back of the plot; one mine cart (lap 2π/0.0005 spin-ms) runs an oval whose front straight passes
 * the courtyard and whose back half runs through a tunnel inside the temple, in at one doorway and out
 * at the other. Torches flank both doorways.
 */
const templeTrek = (): RideDesign => {
  const key = 'temple-trek';
  const lapSpeed = 0.0005 / TAU;
  const halfStraight = 32;
  const radius = 16;
  /** The oval's centre, toward the front: its back half is inside the temple. */
  const loopY = 6;
  /** The facade: the temple fills y < frontY. */
  const frontY = loopY + 2;
  const trackZ = PLOT_TOP_Z + 3;
  const tunnelTopZ = trackZ + 18;
  const baseTopZ = tunnelTopZ + 5;
  const boothAt: readonly [number, number] = [48, 34];
  const shiftY = (shapes: Shape[]): Shape[] => shapes.map((shape) => shifted(shape, 0, loopY));
  const torches: [number, number][] = [[40, frontY + 3], [58, frontY + 3], [-40, frontY + 3], [-58, frontY + 3]];
  const bulbs: Bulbs = { shapes: [], lights: [] };
  for (const [x, y] of torches) {
    bulbs.shapes.push(box([x - 1, y - 1, PLOT_TOP_Z + 14], [2, 2, 2], MAT.BULB));
    bulbs.lights.push(bulbLight(x, y, PLOT_TOP_Z + 15));
  }
  const restDistance = halfStraight;
  const [cartX, cartY] = stadiumPivot(halfStraight, radius, restDistance);
  const cart: MovingPart = {
    id: `${key}:cart`,
    pivot: [cartX, cartY + loopY, trackZ],
    driver: followStadium(halfStraight, radius, restDistance, lapSpeed, 0),
    shapes: (materials) => {
      const x = cartX;
      const y = cartY + loopY;
      return [
        box([x - 5, y - 4, trackZ], [10, 8, 2], MAT.STEEL, PATTERN.METAL),
        box([x - 5, y - 4, trackZ + 2], [10, 8, 5], materials.accent, PATTERN.PLANKS),
        box([x - 4, y - 3, trackZ + 3], [8, 6, 4], 0),
        ...rider(x - 2, y, trackZ + 3, 0, materials),
        ...rider(x + 2, y, trackZ + 3, 1, materials),
      ];
    },
  };
  return {
    key,
    body: (materials) => [
      // The stepped temple: a stone base, two terraces in the catalog colour and a shrine with a gold roof.
      box([-56, -42, PLOT_TOP_Z], [112, frontY + 42, baseTopZ - PLOT_TOP_Z], MAT.STONE, PATTERN.BRICK),
      box([-56, frontY - 3, baseTopZ - 4], [112, 3, 4], materials.accent),
      box([-44, -40, baseTopZ], [88, frontY + 30, 14], materials.color, PATTERN.BRICK),
      box([-30, -38, baseTopZ + 14], [60, frontY + 20, 12], materials.color, PATTERN.BRICK),
      box([-14, -34, baseTopZ + 26], [28, 20, 12], MAT.STONE, PATTERN.BRICK),
      box([-6, -14, baseTopZ + 26], [12, 1, 9], MAT.INK),
      box([-17, -37, baseTopZ + 38], [34, 26, 3], materials.accent, PATTERN.ROOF),
      box([-10, -32, baseTopZ + 41], [20, 16, 3], materials.accent, PATTERN.ROOF),
      ellipsoid([0, -24, baseTopZ + 47], [3, 3, 3], materials.accent),
      // The tunnel: the oval's whole band carved to cart height (outside the temple there is nothing to carve), the
      // carve's island put back, then the track bed and rails all the way round.
      ...shiftY(stadiumBand(halfStraight, radius - 6, radius + 6, trackZ - 1, tunnelTopZ - trackZ + 1, 0)),
      box([-halfStraight, loopY - (radius - 6), trackZ - 1], [2 * halfStraight, frontY - loopY + radius - 6, tunnelTopZ - trackZ + 1], MAT.STONE, PATTERN.BRICK),
      ...shiftY(stadiumBand(halfStraight, radius - 6, radius + 6, PLOT_TOP_Z, 2, MAT.STONE, PATTERN.SPECKLE)),
      ...shiftY(stadiumBand(halfStraight, radius - 4, radius - 2, PLOT_TOP_Z + 2, 1, MAT.STEEL_LIGHT)),
      ...shiftY(stadiumBand(halfStraight, radius + 2, radius + 4, PLOT_TOP_Z + 2, 1, MAT.STEEL_LIGHT)),
      // Torch posts by the doorways.
      ...torches.map(([x, y]) => box([x - 1, y - 1, PLOT_TOP_Z], [2, 2, 13], MAT.TIMBER, PATTERN.PLANKS)),
      ...bulbs.shapes,
      ...booth(boothAt[0], boothAt[1], materials),
    ],
    parts: [cart],
    lights: [...bulbs.lights, boothLight(boothAt[0], boothAt[1])],
  };
};

const DESIGNS: Readonly<Record<string, RideDesign>> = {
  'petal-roundabout': petalRoundabout(),
  'comet-cups': cometCups(),
  'harbor-swings': harborSwings(),
  'thunder-drum': thunderDrum(),
  'gale-spinner': galeSpinner(),
  'bumble-coach': bumbleCoach(),
  'splash-rings': splashRings(),
  // Phase 16.
  'puddle-jumpers': puddleJumpers(),
  'rocket-pendulum': rocketPendulum(),
  'temple-trek': templeTrek(),
};

const GENERIC_DESIGN = genericSpinner();

const designFor = (definitionId: string): RideDesign => DESIGNS[definitionId] ?? GENERIC_DESIGN;

// ------------------------------------------------------------------ the builder

/** Ride ids with their own parameters; any other id gets the generic spinner. */
export const GENERIC_RIDE_IDS: readonly string[] = Object.keys(DESIGNS);

/**
 * The blueprint of a flat ride: the design for `definition.id` in its catalog colours, moved from
 * centre-relative to model space. Its id names the design and the definition, which fixes the
 * colours too, so it is unique per builder and parameters (the compile cache key).
 */
export const flatRideBlueprint = (definition: BuildDefinition, palette: Palette): Blueprint => {
  const design = designFor(definition.id);
  const materials = materialsFor(definition, palette);
  const centreX = (definition.footprint[0] * VOXELS_PER_TILE) / 2;
  const centreY = (definition.footprint[1] * VOXELS_PER_TILE) / 2;
  const parts: BlueprintPart[] = [
    { id: 'body', pivot: [0, 0, 0], shapes: design.body(materials).map((shape) => shifted(shape, centreX, centreY)) },
    ...design.parts.map((part): BlueprintPart => ({
      id: part.id,
      pivot: [part.pivot[0] + centreX, part.pivot[1] + centreY, part.pivot[2]],
      shapes: part.shapes(materials).map((shape) => shifted(shape, centreX, centreY)),
    })),
  ];
  return {
    id: `flat-ride:${design.key}:${definition.id}`,
    footprint: [definition.footprint[0], definition.footprint[1]],
    parts,
    lights: design.lights.map((light) => ({
      ...light,
      position: [light.position[0] + centreX, light.position[1] + centreY, light.position[2]],
    })),
  };
};

const DRIVERS: Readonly<Record<string, PartDriver>> = Object.fromEntries(
  [...Object.values(DESIGNS), GENERIC_DESIGN].flatMap((design) => design.parts.map((part) => [part.id, part.driver])),
);

export const genericRide: ObjectContent = {
  blueprint: flatRideBlueprint,
  drivers: DRIVERS,
};
