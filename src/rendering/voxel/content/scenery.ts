import type { BuildDefinition } from '../../../game/types';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import type { Blueprint, Shape, Vec3 } from '../contracts/blueprint';
import type { ObjectContent } from '../contracts/content';
import { MAT, MAT_COLOR, MATERIAL_EMPTY, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { PLOT_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import { slotTagger } from './colourTags';

/**
 * Scenery: the confetti tree, lollipop lamp, sunburst flowers and ripple fountain, authored against
 * the art bible (design §12) and the box budgets (contracts/budgets.ts).
 *
 * None of these has a back to hide. The camera shows a model at two quarter turns (space.ts), so
 * each is built symmetric enough that both turns show all of it: the tree is mirror-symmetric about
 * its model y axis, which makes quarter turn 1 the exact mirror image of quarter turn 0, and keeps
 * its accent lobe on model +y, the side that faces the camera in both turns; the lamp, the flower
 * bed and the fountain do not change under a quarter turn at all. Decorations sit at tabulated
 * integer positions rather than computed ones, so a build is exact and deterministic.
 *
 * Every 2×2 decoration (confetti dots, blossom hearts) has its minimum corner on an even x + y. A
 * top face shows only every other voxel along the x = y diagonal (contracts/palette.ts, PATTERN), so
 * a 2×2 top on an even corner shows as a 2×2 dot, but on an odd corner as a 4×1 stripe. A quarter
 * turn keeps the parity: the turned corner is (y, W − 2 − x), and W is even.
 *
 * Every model is one piece: each voxel connects through faces to the plot, even where the camera
 * would never see a gap, so nothing floats.
 *
 * Colours come only from the palette: the catalog colour and accent through `palette.material`
 * (always plain materials), glow and water only as MAT ids.
 */

/** Model-space centre of the footprint on the ground: whole voxels for every catalog footprint. */
export const footprintCentre = (definition: BuildDefinition): [number, number] => [
  (definition.footprint[0] * VOXELS_PER_TILE) / 2,
  (definition.footprint[1] * VOXELS_PER_TILE) / 2,
];

/** Minimum corner of the mirror image, about the axis, of a decoration `width` wide at `offset`. */
const mirroredOffset = (offset: number, width: number): number => -offset - width;

// ------------------------------------------------------------------ confetti tree

/** Art bible: trunk 4×4 up to z 26; crown radii 12–14 around z ≈ 40; top ≤ 60. */
const TREE_TRUNK_SIZE = 4;
const TREE_TRUNK_TOP = 26;

type CrownTone = 'color' | 'accent' | 'foliage';

interface CrownLobe {
  /** Centre: x and y relative to the footprint centre, z absolute. */
  offset: Vec3;
  radii: Vec3;
  tone: CrownTone;
}

/**
 * Three FOLIAGE-patterned lobes on the model's y axis: the catalog colour at the back, the accent
 * (the candy-coloured lobe) at the front, and light FOLIAGE on top so the sunlit top face reads as
 * leaves. Together they span radii 13 × 14 around z ≈ 41 with the top at 55. Legacy art puts the
 * accent disc on the right; a side lobe would hide behind the crown at one of the two quarter turns,
 * so the accent goes to the front instead. The radii were tuned so the compiler keeps the hollow
 * mesh (≈ 545 boxes of BOX_BUDGET.tree 600) rather than a solid one that rasterises 3× more.
 */
const TREE_LOBES: readonly CrownLobe[] = [
  { offset: [0, -3, 39], radii: [13, 11, 9], tone: 'color' },
  { offset: [0, 4, 36], radii: [12, 10, 8], tone: 'accent' },
  { offset: [0, -1, 47], radii: [11, 10, 8], tone: 'foliage' },
];

/**
 * The crown's lowest voxels are at z 28, two above the trunk's top, and the camera never sees that
 * gap under the crown's overhang. So the trunk carries on, hidden, up to the lowest lobe's centre,
 * and the crown rests on it rather than floating. The lobes are drawn after the core and overwrite
 * it inside the crown, which leaves the picture and the box count unchanged.
 */
const TREE_CORE_TOP = Math.min(...TREE_LOBES.map((lobe) => lobe.offset[2]));

/** A 2×2×2 confetti dot, half sunk into a lobe's surface so it reads as a speck on the crown. */
interface Sprinkle {
  /** Minimum corner: x and y relative to the footprint centre, z absolute. */
  at: Vec3;
  tone: 'white' | 'accent';
  /** Whether the dot also appears mirrored about the model's y axis (off-axis dots come in pairs). */
  mirrored: boolean;
}

const SPRINKLE_SIZE = 2;

/**
 * White confetti on every lobe and one accent dot on the green top, all on camera-facing sides,
 * every corner on an even x + y (the footprint centre, 16 + 16, is even).
 */
const TREE_SPRINKLES: readonly Sprinkle[] = [
  { at: [5, 3, 52], tone: 'white', mirrored: true },
  { at: [-1, 7, 48], tone: 'accent', mirrored: false },
  { at: [11, -3, 41], tone: 'white', mirrored: true },
  { at: [7, 11, 36], tone: 'white', mirrored: true },
  { at: [-1, 11, 39], tone: 'white', mirrored: false },
];

export const confettiTree: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    const crownMaterial: Readonly<Record<CrownTone, number>> = {
      color: palette.material(definition.color),
      accent: palette.material(definition.accent),
      foliage: MAT.FOLIAGE,
    };
    const trunkHalf = TREE_TRUNK_SIZE / 2;
    const trunk = (bottom: number, top: number): Shape => ({
      kind: 'box',
      min: [centreX - trunkHalf, centreY - trunkHalf, bottom],
      size: [TREE_TRUNK_SIZE, TREE_TRUNK_SIZE, top - bottom],
      material: MAT.TIMBER,
      pattern: PATTERN.SPECKLE,
    });
    const shapes: Shape[] = [trunk(PLOT_TOP_Z, TREE_TRUNK_TOP), trunk(TREE_TRUNK_TOP, TREE_CORE_TOP)];
    for (const lobe of TREE_LOBES) {
      shapes.push({
        kind: 'ellipsoid',
        center: [centreX + lobe.offset[0], centreY + lobe.offset[1], lobe.offset[2]],
        radii: lobe.radii,
        material: crownMaterial[lobe.tone],
        pattern: PATTERN.FOLIAGE,
      });
    }
    for (const sprinkle of TREE_SPRINKLES) {
      const material = sprinkle.tone === 'white' ? MAT.WHITE : crownMaterial.accent;
      const [x, y, z] = sprinkle.at;
      const xs = sprinkle.mirrored ? [x, mirroredOffset(x, SPRINKLE_SIZE)] : [x];
      for (const offsetX of xs) {
        shapes.push({
          kind: 'box',
          min: [centreX + offsetX, centreY + y, z],
          size: [SPRINKLE_SIZE, SPRINKLE_SIZE, SPRINKLE_SIZE],
          material,
        });
      }
    }
    return {
      id: `scenery-tree:${definition.id}`,
      footprint: definition.footprint,
      parts: [{ id: 'body', pivot: [0, 0, 0], shapes }],
    };
  },
};

// ------------------------------------------------------------------ lantern maple (Phase 22, profile-gated)

/**
 * A red maple strung with paper lanterns (an unlock of Harvest Festival). The trunk is the confetti tree's; the crown is
 * three FOLIAGE tiers, widest at the bottom in the darker red every park already holds (thunder drum's colour), the
 * catalog colour above it. Five 3×3 and 4×4 paper lanterns hang from the lowest tier on the camera-facing side: accent paper
 * with a LAMP_GLOW band in the middle (so they glow at night for free, with no light source declared). Mirror-symmetric
 * about the model's y axis like the confetti tree, so a quarter turn shows the mirror image. No new palette material:
 * the darker tier and the lantern paper are existing catalog colours.
 */
const MAPLE_DARK_RED = 0xc0392b;
const MAPLE_TIERS: readonly { offset: Vec3; radii: Vec3; tone: 'dark' | 'color' }[] = [
  { offset: [0, 0, 32], radii: [13, 12, 6], tone: 'dark' },
  { offset: [0, 0, 40], radii: [11, 10, 6], tone: 'color' },
  { offset: [0, 0, 48], radii: [8, 8, 5], tone: 'color' },
];
/** Lantern minimum corners (x and y relative to the footprint centre, z absolute); off-axis ones come in mirrored pairs. */
const MAPLE_LANTERNS: readonly { at: Vec3; size: number; mirrored: boolean }[] = [
  { at: [-11, 3, 24], size: 3, mirrored: true },
  { at: [-6, 8, 24], size: 3, mirrored: true },
  // On the axis, so an even width: its own mirror image.
  { at: [-2, 10, 26], size: 4, mirrored: false },
];
const MAPLE_LANTERN_HEIGHT = 6;

export const lanternMaple: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    const tone = {
      dark: palette.material(MAPLE_DARK_RED),
      color: palette.material(definition.color),
    } as const;
    const paper = palette.material(definition.accent);
    const trunkHalf = TREE_TRUNK_SIZE / 2;
    const coreTop = Math.min(...MAPLE_TIERS.map((tier) => tier.offset[2]));
    const trunk = (bottom: number, top: number): Shape => ({
      kind: 'box',
      min: [centreX - trunkHalf, centreY - trunkHalf, bottom],
      size: [TREE_TRUNK_SIZE, TREE_TRUNK_SIZE, top - bottom],
      material: MAT.TIMBER,
      pattern: PATTERN.SPECKLE,
    });
    const shapes: Shape[] = [trunk(PLOT_TOP_Z, TREE_TRUNK_TOP), trunk(TREE_TRUNK_TOP, coreTop)];
    for (const tier of MAPLE_TIERS) {
      shapes.push({
        kind: 'ellipsoid',
        center: [centreX + tier.offset[0], centreY + tier.offset[1], tier.offset[2]],
        radii: tier.radii,
        material: tone[tier.tone],
        pattern: PATTERN.FOLIAGE,
      });
    }
    for (const lantern of MAPLE_LANTERNS) {
      const [x, y, z] = lantern.at;
      const xs = lantern.mirrored ? [x, mirroredOffset(x, lantern.size)] : [x];
      for (const offsetX of xs) {
        const band = (height: number, bottom: number, material: number): Shape => ({
          kind: 'box',
          min: [centreX + offsetX, centreY + y, bottom],
          size: [lantern.size, lantern.size, height],
          material,
        });
        shapes.push(band(2, z, paper), band(MAPLE_LANTERN_HEIGHT - 4, z + 2, MAT.LAMP_GLOW), band(2, z + MAPLE_LANTERN_HEIGHT - 2, paper));
      }
    }
    return {
      id: `scenery-tree:${definition.id}`,
      footprint: definition.footprint,
      parts: [{ id: 'body', pivot: [0, 0, 0], shapes }],
    };
  },
};

// ------------------------------------------------------------------ lollipop lamp

/** Art bible: pole 2×2 up to z 44, lantern 6×6×6 at z 44–50, light radius 64. */
const LAMP_POLE_SIZE = 2;
const LAMP_POLE_TOP = 44;
const LAMP_LANTERN_SIZE = 6;
const LAMP_LANTERN_TOP = 50;
const LAMP_LIGHT_RADIUS = 64;
/** A small foot so the pole reads as planted rather than stuck into the plot. */
const LAMP_FOOT_SIZE = 4;
const LAMP_FOOT_HEIGHT = 3;
/** The lantern's rounded layers: the bottom and the cap are 4×4, the body an octagon inside 6×6. */
const LAMP_ROUNDED_SIZE = 4;
const LAMP_CAP_HEIGHT = 1;

export const lollipopLamp: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    // Phase 28: foot and pole are colour slot 'primary', the cap 'secondary'; the glow globe stays fixed.
    const tag = slotTagger(definition.id);
    const pole = tag('primary', palette.material(definition.color));
    const cap = tag('secondary', palette.material(definition.accent));
    const square = (size: number, z: number, height: number, material: number): Shape => ({
      kind: 'box',
      min: [centreX - size / 2, centreY - size / 2, z],
      size: [size, size, height],
      material,
    });
    const capBottom = LAMP_LANTERN_TOP - LAMP_CAP_HEIGHT;
    const bodyBottom = LAMP_POLE_TOP + 1;
    const bodyHeight = capBottom - bodyBottom;
    const wide = LAMP_LANTERN_SIZE;
    const narrow = LAMP_ROUNDED_SIZE;
    return {
      id: `scenery-lamp:${definition.id}`,
      footprint: definition.footprint,
      parts: [{
        id: 'body',
        pivot: [0, 0, 0],
        shapes: [
          square(LAMP_FOOT_SIZE, PLOT_TOP_Z, LAMP_FOOT_HEIGHT, pole),
          square(LAMP_POLE_SIZE, PLOT_TOP_Z, LAMP_POLE_TOP - PLOT_TOP_Z, pole),
          // The lollipop: a round glowing globe (LAMP_GLOW is emissive: a soft glow by day, fully lit
          // after dusk) under a plain accent cap, so by day the head reads as one yellow sweet and
          // at night the globe is the light and the cap its dark wrapper.
          square(narrow, LAMP_POLE_TOP, 1, MAT.LAMP_GLOW),
          { kind: 'box', min: [centreX - wide / 2, centreY - narrow / 2, bodyBottom], size: [wide, narrow, bodyHeight], material: MAT.LAMP_GLOW },
          { kind: 'box', min: [centreX - narrow / 2, centreY - wide / 2, bodyBottom], size: [narrow, wide, bodyHeight], material: MAT.LAMP_GLOW },
          square(narrow, capBottom, LAMP_CAP_HEIGHT, cap),
        ],
      }],
      lights: [{
        // At the globe's centre, in its own colour; lamps light the park only after dusk.
        position: [centreX, centreY, (LAMP_POLE_TOP + capBottom) / 2],
        radius: LAMP_LIGHT_RADIUS,
        color: MAT_COLOR.LAMP_GLOW,
        presets: LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT,
      }],
    };
  },
};

// ------------------------------------------------------------------ sunburst flowers

/**
 * The bed: an ellipsoid cushion cut flat at z 5, so the blossoms sit on one level top instead of
 * stepping down a dome (every step would split them into more boxes). Art bible: flowers ≤ 10;
 * with the hearts the bed is 7 high, knee height for a guest.
 */
const FLOWER_BED_RADIUS = 15;
const FLOWER_BED_DOME_HEIGHT = 8;
const FLOWER_BED_TOP = 5;
/** Petals stand one voxel proud of the bed; hearts one voxel higher still, in the other colour. */
const FLOWER_PETAL_HEIGHT = 1;
const FLOWER_HEART_HEIGHT = 2;
/** Petals, rays and hearts are 2 voxels wide: the art bible's smallest feature on a top face. */
const FLOWER_FEATURE = 2;

/**
 * Ring blossoms: 4×4 plus-shaped blooms at the tips of the sunburst's eight rays (four on the axes,
 * four on the diagonals, all about 10 from the centre), alternating accent and pink (legacy art
 * alternates the same two). The ring is closed under a quarter turn with the colours in step, so
 * both turns show the same bed. Each bloom centre has an even x + y, so its 2×2 heart shows as a
 * dot and not a stripe (see the parity note at the top of this file).
 */
const FLOWER_RING: readonly (readonly [number, number])[] = [
  [10, 0], [7, 7], [0, 10], [-7, 7], [-10, 0], [-7, -7], [0, -10], [7, -7],
];
const FLOWER_BLOOM_SIZE = 4;
/** The centre "sunburst": a 10-wide star of accent rays around a pink heart. */
const SUNBURST_RAY_LENGTH = 10;
const SUNBURST_CORE_SIZE = 4;
/** Minimum corners of the four diagonal rays, relative to the centre. */
const SUNBURST_DIAGONAL_RAYS: readonly (readonly [number, number])[] = [[-4, -4], [2, -4], [-4, 2], [2, 2]];

export const sunburstFlowers: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    // Phase 28: the yellow blooms and rays are colour slot 'primary', the pink petals and hearts 'secondary';
    // the green bed stays fixed.
    const tag = slotTagger(definition.id);
    const bed = palette.material(definition.color);
    const accent = tag('primary', palette.material(definition.accent));
    const pink = tag('secondary', MAT.FLOWER_PINK);
    /** A box standing on the flat bed top; x and y relative to the footprint centre. */
    const onBed = (x: number, y: number, sizeX: number, sizeY: number, height: number, material: number): Shape => ({
      kind: 'box',
      min: [centreX + x, centreY + y, FLOWER_BED_TOP],
      size: [sizeX, sizeY, height],
      material,
    });
    const half = FLOWER_FEATURE / 2;
    /** A 2×2 heart centred on (x, y), raised above the petals around it. */
    const heart = (x: number, y: number, material: number): Shape =>
      onBed(x - half, y - half, FLOWER_FEATURE, FLOWER_FEATURE, FLOWER_HEART_HEIGHT, material);
    /** A 4×4 plus of petals centred on (x, y): two crossed 4×2 bars. */
    const bloom = (x: number, y: number, petals: number, middle: number): Shape[] => [
      onBed(x - FLOWER_BLOOM_SIZE / 2, y - half, FLOWER_BLOOM_SIZE, FLOWER_FEATURE, FLOWER_PETAL_HEIGHT, petals),
      onBed(x - half, y - FLOWER_BLOOM_SIZE / 2, FLOWER_FEATURE, FLOWER_BLOOM_SIZE, FLOWER_PETAL_HEIGHT, petals),
      heart(x, y, middle),
    ];
    const shapes: Shape[] = [
      {
        kind: 'ellipsoid',
        center: [centreX, centreY, 0],
        radii: [FLOWER_BED_RADIUS, FLOWER_BED_RADIUS, FLOWER_BED_DOME_HEIGHT],
        material: bed,
        pattern: PATTERN.FOLIAGE,
      },
      // Everything of the dome above the cut is carved away (material 0).
      {
        kind: 'box',
        min: [0, 0, FLOWER_BED_TOP],
        size: [definition.footprint[0] * VOXELS_PER_TILE, definition.footprint[1] * VOXELS_PER_TILE, FLOWER_BED_DOME_HEIGHT],
        material: MATERIAL_EMPTY,
      },
    ];
    FLOWER_RING.forEach(([x, y], index) => {
      const accentPetals = index % 2 === 0;
      shapes.push(...bloom(x, y, accentPetals ? accent : pink, accentPetals ? pink : accent));
    });
    const ray = SUNBURST_RAY_LENGTH / 2;
    const core = SUNBURST_CORE_SIZE / 2;
    shapes.push(
      onBed(-ray, -half, SUNBURST_RAY_LENGTH, FLOWER_FEATURE, FLOWER_PETAL_HEIGHT, accent),
      onBed(-half, -ray, FLOWER_FEATURE, SUNBURST_RAY_LENGTH, FLOWER_PETAL_HEIGHT, accent),
      onBed(-core, -core, SUNBURST_CORE_SIZE, SUNBURST_CORE_SIZE, FLOWER_PETAL_HEIGHT, accent),
      ...SUNBURST_DIAGONAL_RAYS.map(([x, y]) => onBed(x, y, FLOWER_FEATURE, FLOWER_FEATURE, FLOWER_PETAL_HEIGHT, accent)),
      heart(0, 0, pink),
    );
    return {
      id: `scenery-flowers:${definition.id}`,
      footprint: definition.footprint,
      parts: [{ id: 'body', pivot: [0, 0, 0], shapes }],
    };
  },
};

// ------------------------------------------------------------------ ripple fountain

/**
 * Art bible: rim 6 high (z 1–7), jet ≤ 40, WATER material and pattern. The rim is stone under a
 * 2-voxel coping in the catalog colour. Legacy art edges its basin in the accent, but here the
 * accent is the spray. If only the bowl were in the catalog colour, the fountain's blue would hide
 * behind the jet and arcs; the coping is the most visible surface of the model, so it carries the
 * colour instead.
 */
const FOUNTAIN_RIM_RADIUS = 27;
const FOUNTAIN_RIM_THICKNESS = 4;
const FOUNTAIN_RIM_HEIGHT = 6;
const FOUNTAIN_COPING_HEIGHT = 2;
/** The basin's water surface: two voxels under the rim's top, so the rim reads as a lip. */
const FOUNTAIN_WATER_TOP = 5;
const FOUNTAIN_PEDESTAL_RADIUS = 3;
/**
 * The bowl on the pedestal: a straight catalog-colour wall 3 voxels high on a tapered underside,
 * holding one layer of water one voxel under its lip. The wall is straight because the camera
 * looks down at 2:1. A frustum that flares 1.5 voxels per layer hides each layer under the one
 * above it, so only a 1-texel hoop showed. The wall shows as a 3-texel band, and the underside
 * (layer radii 6 and 8 under the wall's 10) rounds the bowl's silhouette at the sides.
 */
const FOUNTAIN_BOWL_TOP = 18;
const FOUNTAIN_BOWL_RADIUS = 10;
const FOUNTAIN_BOWL_WALL_HEIGHT = 3;
const FOUNTAIN_BOWL_UNDERSIDE_HEIGHT = 2;
const FOUNTAIN_BOWL_FOOT_RADIUS = 5;
const FOUNTAIN_BOWL_UNDERSIDE_RADIUS = 9;
/** The wall's thickness. The pool's radius is the wall's inner radius, so no water shows through. */
const FOUNTAIN_BOWL_WALL = 2;
/**
 * The jet: a tapering spout of accent water rising out of the bowl's pool, its top voxel inside a
 * white foam tip that ends at z 40.
 */
const FOUNTAIN_JET_RADIUS = 3;
const FOUNTAIN_JET_TIP_RADIUS = 1;
const FOUNTAIN_JET_CONE_TOP = 38;
const FOUNTAIN_JET_TOP = 40;
const FOUNTAIN_FOAM_SIZE = 2;
const FOUNTAIN_FOAM_HEIGHT = 3;
/**
 * Four arcs leave the jet, crest and fall into the basin: (distance from the axis, z) waypoints.
 * They run along the model axes, so the fountain is unchanged by a quarter turn, and they are
 * ≥ 2 voxels thick (a 1.2 radius around lines through voxel corners).
 */
const FOUNTAIN_ARC: readonly (readonly [number, number])[] = [[2, 24], [7, 28], [13, 23], [18, 15], [19, FOUNTAIN_WATER_TOP]];
const FOUNTAIN_ARC_RADIUS = 1.2;
const FOUNTAIN_ARC_DIRECTIONS: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export const rippleFountain: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    // Phase 28: the coping, bowl wall and underside are colour slot 'primary' (Basin); stone, water, spray and foam stay fixed.
    const tag = slotTagger(definition.id);
    const blue = tag('primary', palette.material(definition.color));
    const spray = palette.material(definition.accent);
    const rim = (bottom: number, height: number, material: number, pattern: number): Shape => ({
      kind: 'ring',
      center: [centreX, centreY, bottom + height / 2],
      radius: FOUNTAIN_RIM_RADIUS,
      thickness: FOUNTAIN_RIM_THICKNESS,
      width: height,
      axis: 'z',
      material,
      pattern,
    });
    /** A solid disc `length` layers high on the fountain's axis, from `bottom` up. */
    const disc = (bottom: number, radius: number, length: number, material: number, pattern: number = PATTERN.PLAIN): Shape => ({
      kind: 'cylinder',
      base: [centreX, centreY, bottom],
      radius,
      length,
      axis: 'z',
      material,
      pattern,
    });
    const rimTop = PLOT_TOP_Z + FOUNTAIN_RIM_HEIGHT;
    const copingBottom = rimTop - FOUNTAIN_COPING_HEIGHT;
    const wallBottom = FOUNTAIN_BOWL_TOP - FOUNTAIN_BOWL_WALL_HEIGHT;
    const undersideBottom = wallBottom - FOUNTAIN_BOWL_UNDERSIDE_HEIGHT;
    // Inside the lip, the bowl's top layer is carved clear and the layer under it is the pool.
    const lipLayer = FOUNTAIN_BOWL_TOP - 1;
    const poolLayer = lipLayer - 1;
    const poolRadius = FOUNTAIN_BOWL_RADIUS - FOUNTAIN_BOWL_WALL;
    const shapes: Shape[] = [
      rim(PLOT_TOP_Z, copingBottom - PLOT_TOP_Z, MAT.STONE, PATTERN.SPECKLE),
      rim(copingBottom, FOUNTAIN_COPING_HEIGHT, blue, PATTERN.PLAIN),
      disc(PLOT_TOP_Z, FOUNTAIN_RIM_RADIUS - FOUNTAIN_RIM_THICKNESS / 2, FOUNTAIN_WATER_TOP - PLOT_TOP_Z, MAT.WATER, PATTERN.WATER),
      disc(FOUNTAIN_WATER_TOP, FOUNTAIN_PEDESTAL_RADIUS, undersideBottom - FOUNTAIN_WATER_TOP, MAT.STONE, PATTERN.SPECKLE),
      {
        kind: 'cone',
        base: [centreX, centreY, undersideBottom],
        radius: FOUNTAIN_BOWL_FOOT_RADIUS,
        topRadius: FOUNTAIN_BOWL_UNDERSIDE_RADIUS,
        height: FOUNTAIN_BOWL_UNDERSIDE_HEIGHT,
        material: blue,
      },
      disc(wallBottom, FOUNTAIN_BOWL_RADIUS, FOUNTAIN_BOWL_WALL_HEIGHT, blue),
      disc(lipLayer, poolRadius, 1, MATERIAL_EMPTY),
      disc(poolLayer, poolRadius, 1, MAT.WATER, PATTERN.WATER),
      {
        kind: 'cone',
        base: [centreX, centreY, poolLayer],
        radius: FOUNTAIN_JET_RADIUS,
        topRadius: FOUNTAIN_JET_TIP_RADIUS,
        height: FOUNTAIN_JET_CONE_TOP - poolLayer,
        material: spray,
        pattern: PATTERN.WATER,
      },
      {
        kind: 'box',
        min: [centreX - FOUNTAIN_FOAM_SIZE / 2, centreY - FOUNTAIN_FOAM_SIZE / 2, FOUNTAIN_JET_TOP - FOUNTAIN_FOAM_HEIGHT],
        size: [FOUNTAIN_FOAM_SIZE, FOUNTAIN_FOAM_SIZE, FOUNTAIN_FOAM_HEIGHT],
        material: MAT.WHITE,
      },
    ];
    for (const [directionX, directionY] of FOUNTAIN_ARC_DIRECTIONS) {
      const point = ([distance, z]: readonly [number, number]): Vec3 =>
        [centreX + directionX * distance, centreY + directionY * distance, z];
      for (let index = 1; index < FOUNTAIN_ARC.length; index += 1) {
        shapes.push({
          kind: 'segment',
          from: point(FOUNTAIN_ARC[index - 1]),
          to: point(FOUNTAIN_ARC[index]),
          radius: FOUNTAIN_ARC_RADIUS,
          material: spray,
          pattern: PATTERN.WATER,
        });
      }
    }
    return {
      id: `scenery-fountain:${definition.id}`,
      footprint: definition.footprint,
      parts: [{ id: 'body', pivot: [0, 0, 0], shapes }],
    };
  },
};
