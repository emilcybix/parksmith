import type { BuildDefinition } from '../../../game/types';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import type { Blueprint, Shape, Vec3 } from '../contracts/blueprint';
import type { ObjectContent } from '../contracts/content';
import { MAT, MAT_COLOR, MATERIAL_EMPTY, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { PLOT_TOP_Z } from '../contracts/space';
import { slotTagger } from './colourTags';
import { footprintCentre } from './scenery';

/**
 * Phase 16: the themed scenery of the seaside, adventure, futuristic and carnival sets, in the style of the confetti tree
 * and the lantern maple (scenery.ts). Five 1x1 pieces (bunting mast, shell planter, tiki torch, jungle idol, neon pylon) and
 * two 2x2 landmarks (harbor lighthouse with an emissive lamp room, orbit globe with two crossed orbit rings).
 *
 * Every piece is one static body (scenery has no ride status for a driver to follow, so the globe's rings stand still),
 * one face-connected solid on the plot, inside its footprint and no taller than 60 voxels (the confetti tree's top, the
 * tallest scenery limit). Colours come only from the definition's colour and accent (through `palette.material`) and
 * existing MAT materials, so the palette does not grow. Recolourable parts are tagged through `slotTagger`: 'primary' is
 * always the catalog colour and 'secondary' the accent (an untagged no-op until the slot table declares them).
 *
 * The camera sees model +y and +x (space.ts), so faces and fronts sit on +y; the pieces are mirror-symmetric about the
 * model's y axis or unchanged by a quarter turn, like the existing scenery.
 */

const box = (min: Vec3, size: Vec3, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'box', min, size, material, pattern });

/** A box of `width` × `depth` centred on (x, y), from `bottom` up `height` voxels. */
const centred = (x: number, y: number, width: number, depth: number, bottom: number, height: number, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  box([x - width / 2, y - depth / 2, bottom], [width, depth, height], material, pattern);

const disc = (x: number, y: number, bottom: number, radius: number, length: number, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'cylinder', base: [x, y, bottom], radius, length, axis: 'z', material, pattern });

const blueprintOf = (kind: string, definition: BuildDefinition, shapes: Shape[], lights?: Blueprint['lights']): Blueprint => ({
  id: `scenery-${kind}:${definition.id}`,
  footprint: definition.footprint,
  parts: [{ id: 'body', pivot: [0, 0, 0], shapes }],
  ...(lights === undefined ? {} : { lights }),
});

/** Lamp-like glows light the park only after dusk, in the lamp glow's own colour. */
const glowLight = (position: Vec3, radius: number): NonNullable<Blueprint['lights']>[number] => ({
  position,
  radius,
  color: MAT_COLOR.LAMP_GLOW,
  presets: LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT,
});

// ------------------------------------------------------------------ bunting mast (carnival, 1x1)

/**
 * A white maypole with two colour bands and an accent finial; four white bunting lines run from under the finial down to
 * short timber pegs near the plot corners, each hung with pennants alternating colour and accent. The four lines are the
 * plot's diagonals, so a quarter turn leaves the mast unchanged.
 */
const MAST_TOP = 52;
const MAST_LINE_TOP = 46;
const MAST_STAKE_TOP = 5;
/** The pegs' inner corners: 3 voxels in from each plot corner. */
const MAST_STAKE_INSET = 3;
const MAST_LINE_RADIUS = 0.9;
/** Pennants at these fractions of each line, hanging below it. */
const MAST_PENNANTS: readonly number[] = [0.14, 0.3, 0.46, 0.62, 0.78];
/** A pennant: a 4×4 head on the line, 2 high, over a 2×2 point 3 high. */
const MAST_PENNANT_HEAD = 2;
const MAST_PENNANT_POINT = 3;

export const buntingMast: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    const tag = slotTagger(definition.id);
    const pink = tag('primary', palette.material(definition.color));
    const yellow = tag('secondary', palette.material(definition.accent));
    const shapes: Shape[] = [
      centred(centreX, centreY, 6, 6, PLOT_TOP_Z, 2, MAT.STONE, PATTERN.SPECKLE),
      centred(centreX, centreY, 2, 2, PLOT_TOP_Z, MAST_TOP - PLOT_TOP_Z, MAT.WHITE),
      centred(centreX, centreY, 4, 4, 18, 2, pink),
      centred(centreX, centreY, 4, 4, 34, 2, pink),
      centred(centreX, centreY, 4, 4, MAST_TOP, 3, yellow),
      centred(centreX, centreY, 2, 2, MAST_TOP + 3, 2, yellow),
    ];
    const [width, depth] = [centreX * 2, centreY * 2];
    for (const [signX, signY] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      // The peg's 2×2 sits MAST_STAKE_INSET voxels in from the corner; the line ends at its centre top.
      const stakeX = signX < 0 ? MAST_STAKE_INSET : width - MAST_STAKE_INSET - 2;
      const stakeY = signY < 0 ? MAST_STAKE_INSET : depth - MAST_STAKE_INSET - 2;
      shapes.push(box([stakeX, stakeY, PLOT_TOP_Z], [2, 2, MAST_STAKE_TOP - PLOT_TOP_Z], MAT.TIMBER));
      const from: Vec3 = [centreX, centreY, MAST_LINE_TOP];
      const to: Vec3 = [stakeX + 1, stakeY + 1, MAST_STAKE_TOP];
      shapes.push({ kind: 'segment', from, to, radius: MAST_LINE_RADIUS, material: MAT.WHITE });
      MAST_PENNANTS.forEach((share, index) => {
        const x = Math.round(from[0] + (to[0] - from[0]) * share);
        const y = Math.round(from[1] + (to[1] - from[1]) * share);
        const z = Math.round(from[2] + (to[2] - from[2]) * share);
        const material = index % 2 === 0 ? pink : yellow;
        shapes.push(
          box([x - 2, y - 2, z - MAST_PENNANT_HEAD], [4, 4, MAST_PENNANT_HEAD], material),
          box([x - 1, y - 1, z - MAST_PENNANT_HEAD - MAST_PENNANT_POINT], [2, 2, MAST_PENNANT_POINT], material),
        );
      });
    }
    return blueprintOf('mast', definition, shapes);
  },
};

// ------------------------------------------------------------------ shell planter (seaside, 1x1)

/**
 * A scallop shell standing on its hinge at the back (model −y), its fan in the catalog colour ribbed in the accent, in
 * front of a low shell-coloured bowl planted with a mound of foliage and pink blossoms. Mirror-symmetric about the
 * model's y axis.
 */
const SHELL_HINGE: Vec3 = [0, -11, 5];
const SHELL_FAN_RADIUS = 15;
const SHELL_FAN_DEPTH = 3;
const SHELL_RIB_ANGLES: readonly number[] = [18, 42, 66, 90, 114, 138, 162];
const SHELL_BOWL_TOP = 7;
/** 2×2×2 blossoms: minimum x and y relative to the footprint centre, z their top; mirrored pairs and one on the axis. */
const SHELL_BLOSSOMS: readonly { at: Vec3; mirrored: boolean }[] = [
  { at: [-6, 1, 9], mirrored: true },
  { at: [-3, 6, 8], mirrored: true },
  { at: [-1, 2, 11], mirrored: false },
];

export const shellPlanter: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    const tag = slotTagger(definition.id);
    const shell = tag('primary', palette.material(definition.color));
    const rib = tag('secondary', palette.material(definition.accent));
    const hingeX = centreX + SHELL_HINGE[0];
    const fanY = centreY + SHELL_HINGE[1];
    const hingeZ = SHELL_HINGE[2];
    const ribY = fanY + SHELL_FAN_DEPTH;
    const shapes: Shape[] = [
      // The fan: a disc standing in the xz plane, its lower part under the plot cut away by the floor.
      { kind: 'cylinder', base: [hingeX, fanY, hingeZ], radius: SHELL_FAN_RADIUS, length: SHELL_FAN_DEPTH, axis: 'y', material: shell },
    ];
    for (const degrees of SHELL_RIB_ANGLES) {
      const radians = (degrees * Math.PI) / 180;
      const tip: Vec3 = [hingeX + Math.cos(radians) * (SHELL_FAN_RADIUS - 1), ribY, hingeZ + Math.sin(radians) * (SHELL_FAN_RADIUS - 1)];
      shapes.push({ kind: 'segment', from: [hingeX, ribY, hingeZ], to: tip, radius: 1.2, material: rib });
    }
    shapes.push(
      // The bowl: a shell-coloured dome cut flat, with an accent lip, filled with a foliage mound.
      { kind: 'ellipsoid', center: [centreX, centreY + 3, PLOT_TOP_Z], radii: [11, 10, 8], material: shell },
      // Cut in front of the ribs only, so the fan keeps its full height.
      box([0, ribY + 1, SHELL_BOWL_TOP], [centreX * 2, centreY * 2 - ribY - 1, 12], MATERIAL_EMPTY),
      { kind: 'ring', center: [centreX, centreY + 3, SHELL_BOWL_TOP - 1], radius: 7, thickness: 2, width: 2, axis: 'z', material: rib },
      { kind: 'ellipsoid', center: [centreX, centreY + 3, SHELL_BOWL_TOP - 1], radii: [7, 6, 4], material: MAT.FOLIAGE, pattern: PATTERN.FOLIAGE },
    );
    for (const blossom of SHELL_BLOSSOMS) {
      const [x, y, z] = blossom.at;
      for (const offsetX of blossom.mirrored ? [x, -x - 2] : [x]) {
        shapes.push(box([centreX + offsetX, centreY + y, z - 2], [2, 2, 2], MAT.FLOWER_PINK));
      }
    }
    return blueprintOf('shell', definition, shapes);
  },
};

// ------------------------------------------------------------------ tiki torch (adventure, 1x1)

/**
 * A bamboo torch on a heap of stones: a wooden pole bound in the catalog colour, a woven timber bowl with a colour rim, and
 * a flame of LAMP_GLOW (emissive, a light source after dusk) licked by four accent tongues. Unchanged by a quarter turn.
 */
const TORCH_POLE_TOP = 34;
const TORCH_BOWL_HEIGHT = 6;
const TORCH_FLAME_HEIGHT = 9;
const TORCH_LIGHT_RADIUS = 48;

export const tikiTorch: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    const tag = slotTagger(definition.id);
    const binding = tag('primary', palette.material(definition.color));
    const tongue = palette.material(definition.accent);
    const bowlTop = TORCH_POLE_TOP + TORCH_BOWL_HEIGHT;
    const shapes: Shape[] = [
      { kind: 'ellipsoid', center: [centreX, centreY, PLOT_TOP_Z], radii: [7, 7, 4], material: MAT.STONE, pattern: PATTERN.SPECKLE },
      centred(centreX, centreY, 4, 4, PLOT_TOP_Z, TORCH_POLE_TOP - PLOT_TOP_Z, MAT.WOOD),
      centred(centreX, centreY, 6, 6, 12, 2, binding),
      centred(centreX, centreY, 6, 6, 24, 2, binding),
      { kind: 'cone', base: [centreX, centreY, TORCH_POLE_TOP], radius: 3, topRadius: 6, height: TORCH_BOWL_HEIGHT, material: MAT.TIMBER, pattern: PATTERN.FABRIC },
      { kind: 'ring', center: [centreX, centreY, bowlTop - 1], radius: 5.5, thickness: 2, width: 2, axis: 'z', material: binding },
      { kind: 'cone', base: [centreX, centreY, bowlTop - 1], radius: 4.5, topRadius: 0.5, height: TORCH_FLAME_HEIGHT + 1, material: MAT.LAMP_GLOW },
    ];
    for (const [x, y] of [[-4, -4], [2, -4], [-4, 2], [2, 2]] as const) {
      shapes.push(box([centreX + x, centreY + y, bowlTop], [2, 2, 3], tongue));
    }
    return blueprintOf('torch', definition, shapes, [glowLight([centreX, centreY, bowlTop + 3], TORCH_LIGHT_RADIUS)]);
  },
};

// ------------------------------------------------------------------ jungle idol (adventure, 1x1)

/**
 * A mossy stone head on a two-step plinth, facing the camera (model +y): a heavy brow over jade accent eyes with ink
 * pupils, a broad nose, a wide ink mouth with white teeth, ears on both sides and an accent crown of three spikes. Mirror-symmetric about the model's y axis.
 */
export const jungleIdol: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    const tag = slotTagger(definition.id);
    const stone = tag('primary', palette.material(definition.color));
    const jade = tag('secondary', palette.material(definition.accent));
    /** A box with x and y relative to the footprint centre, z absolute. */
    const at = (x: number, y: number, z: number, sizeX: number, sizeY: number, sizeZ: number, material: number, pattern: number = PATTERN.PLAIN): Shape =>
      box([centreX + x, centreY + y, z], [sizeX, sizeY, sizeZ], material, pattern);
    const front = 7;
    const shapes: Shape[] = [
      at(-12, -12, PLOT_TOP_Z, 24, 24, 3, MAT.STONE, PATTERN.SPECKLE),
      at(-10, -10, 4, 20, 20, 3, MAT.STONE, PATTERN.SPECKLE),
      // Moss at two front corners of the lower step.
      { kind: 'ellipsoid', center: [centreX - 10, centreY + 10, 4], radii: [3, 3, 2], material: MAT.FOLIAGE, pattern: PATTERN.FOLIAGE },
      { kind: 'ellipsoid', center: [centreX + 10, centreY + 10, 4], radii: [3, 3, 2], material: MAT.FOLIAGE, pattern: PATTERN.FOLIAGE },
      // The head.
      at(-8, -7, 7, 16, 14, 24, stone, PATTERN.SPECKLE),
      // Ears.
      at(-10, -3, 14, 2, 6, 8, stone),
      at(8, -3, 14, 2, 6, 8, stone),
      // Brow, eyes, nose and mouth on the face.
      at(-8, front, 24, 16, 2, 3, stone),
      at(-7, front, 19, 6, 1, 5, jade),
      at(1, front, 19, 6, 1, 5, jade),
      at(-5, front + 1, 20, 2, 1, 2, MAT.INK),
      at(3, front + 1, 20, 2, 1, 2, MAT.INK),
      at(-2, front, 14, 4, 3, 5, stone),
      at(-6, front, 8, 12, 1, 5, MAT.INK),
      at(-5, front, 12, 10, 1, 1, MAT.WHITE),
      at(-5, front, 8, 10, 1, 1, MAT.WHITE),
      // The crown: a band and three spikes.
      at(-9, -8, 31, 18, 16, 2, jade),
      at(-7, -2, 33, 4, 4, 5, jade),
      at(-2, -2, 33, 4, 4, 5, jade),
      at(3, -2, 33, 4, 4, 5, jade),
    ];
    return blueprintOf('idol', definition, shapes);
  },
};

// ------------------------------------------------------------------ neon pylon (futuristic, 1x1)

/**
 * A slender obelisk in the catalog colour on a light steel plinth, a vertical accent "neon" strip down the middle of
 * every face, two accent bands, and an emissive BULB beacon under a steel tip. Unchanged by a quarter turn.
 */
const PYLON_SHAFT_TOP = 46;
const PYLON_NECK_TOP = 52;
const PYLON_BEACON_TOP = 56;

export const neonPylon: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    const tag = slotTagger(definition.id);
    const body = tag('primary', palette.material(definition.color));
    const neon = tag('secondary', palette.material(definition.accent));
    const stripHeight = PYLON_SHAFT_TOP - 4 - 8;
    const shapes: Shape[] = [
      centred(centreX, centreY, 12, 12, PLOT_TOP_Z, 4, MAT.STEEL_LIGHT, PATTERN.METAL),
      centred(centreX, centreY, 8, 8, 5, PYLON_SHAFT_TOP - 5, body),
      centred(centreX, centreY, 6, 6, PYLON_SHAFT_TOP, PYLON_NECK_TOP - PYLON_SHAFT_TOP, body),
      // Neon strips, one voxel proud of each face.
      box([centreX - 1, centreY + 4, 8], [2, 1, stripHeight], neon),
      box([centreX - 1, centreY - 5, 8], [2, 1, stripHeight], neon),
      box([centreX + 4, centreY - 1, 8], [1, 2, stripHeight], neon),
      box([centreX - 5, centreY - 1, 8], [1, 2, stripHeight], neon),
      centred(centreX, centreY, 10, 10, 18, 2, neon),
      centred(centreX, centreY, 10, 10, 32, 2, neon),
      centred(centreX, centreY, 4, 4, PYLON_NECK_TOP, PYLON_BEACON_TOP - PYLON_NECK_TOP, MAT.BULB),
      centred(centreX, centreY, 2, 2, PYLON_BEACON_TOP, 2, MAT.STEEL),
    ];
    return blueprintOf('pylon', definition, shapes);
  },
};

// ------------------------------------------------------------------ harbor lighthouse (seaside, 2x2 landmark)

/**
 * A striped tower on a rock island: six tapering bands alternating the catalog colour and the accent, a door and two
 * windows, an accent gallery with an ink railing, an emissive LAMP_GLOW lamp room behind four steel mullions (a light
 * source after dusk, the widest in the park's scenery), a colour roof and an ink finial. Round, so a quarter turn
 * changes only the door's and windows' side.
 */
const LIGHTHOUSE_TOWER_BOTTOM = 6;
const LIGHTHOUSE_BAND_HEIGHT = 6;
const LIGHTHOUSE_BANDS = 6;
const LIGHTHOUSE_RADIUS_BOTTOM = 11;
const LIGHTHOUSE_RADIUS_TOP = 7;
const LIGHTHOUSE_LAMP_RADIUS = 5;
const LIGHTHOUSE_LAMP_HEIGHT = 8;
const LIGHTHOUSE_ROOF_HEIGHT = 6;
const LIGHTHOUSE_LIGHT_RADIUS = 96;

export const harborLighthouse: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    const tag = slotTagger(definition.id);
    const stripe = tag('primary', palette.material(definition.color));
    const band = tag('secondary', palette.material(definition.accent));
    const towerTop = LIGHTHOUSE_TOWER_BOTTOM + LIGHTHOUSE_BANDS * LIGHTHOUSE_BAND_HEIGHT;
    const radiusAt = (z: number): number => LIGHTHOUSE_RADIUS_BOTTOM
      + (LIGHTHOUSE_RADIUS_TOP - LIGHTHOUSE_RADIUS_BOTTOM) * ((z - LIGHTHOUSE_TOWER_BOTTOM) / (towerTop - LIGHTHOUSE_TOWER_BOTTOM));
    const shapes: Shape[] = [
      { kind: 'ellipsoid', center: [centreX, centreY, 0], radii: [26, 26, 8], material: MAT.STONE, pattern: PATTERN.SPECKLE },
      { kind: 'ellipsoid', center: [centreX - 15, centreY + 13, 6], radii: [5, 4, 3], material: MAT.FOLIAGE, pattern: PATTERN.FOLIAGE },
      { kind: 'ellipsoid', center: [centreX + 14, centreY - 15, 6], radii: [4, 5, 3], material: MAT.FOLIAGE, pattern: PATTERN.FOLIAGE },
      // The tower is solid down into the rock so it stands on it.
      disc(centreX, centreY, PLOT_TOP_Z, LIGHTHOUSE_RADIUS_BOTTOM, LIGHTHOUSE_TOWER_BOTTOM - PLOT_TOP_Z, MAT.STONE, PATTERN.SPECKLE),
    ];
    for (let index = 0; index < LIGHTHOUSE_BANDS; index += 1) {
      const bottom = LIGHTHOUSE_TOWER_BOTTOM + index * LIGHTHOUSE_BAND_HEIGHT;
      shapes.push({
        kind: 'cone',
        base: [centreX, centreY, bottom],
        radius: radiusAt(bottom),
        topRadius: radiusAt(bottom + LIGHTHOUSE_BAND_HEIGHT),
        height: LIGHTHOUSE_BAND_HEIGHT,
        material: index % 2 === 0 ? stripe : band,
      });
    }
    // The door and two windows on the front (+y), sunk one voxel into the wall.
    const wallY = (z: number): number => centreY + Math.floor(radiusAt(z)) - 1;
    shapes.push(
      box([centreX - 2, wallY(13), LIGHTHOUSE_TOWER_BOTTOM], [4, 2, 7], MAT.TIMBER, PATTERN.PLANKS),
      box([centreX - 1, wallY(24), 21], [2, 2, 4], MAT.INK),
      box([centreX - 1, wallY(36), 31], [2, 2, 4], MAT.INK),
    );
    const galleryTop = towerTop + 2;
    const lampTop = galleryTop + LIGHTHOUSE_LAMP_HEIGHT;
    shapes.push(
      disc(centreX, centreY, towerTop, LIGHTHOUSE_RADIUS_TOP + 3, 2, band),
      { kind: 'ring', center: [centreX, centreY, galleryTop + 1], radius: LIGHTHOUSE_RADIUS_TOP + 2, thickness: 2, width: 2, axis: 'z', material: MAT.INK },
      disc(centreX, centreY, galleryTop, LIGHTHOUSE_LAMP_RADIUS, LIGHTHOUSE_LAMP_HEIGHT, MAT.LAMP_GLOW),
    );
    for (const [x, y] of [[-1, -LIGHTHOUSE_LAMP_RADIUS - 1], [-1, LIGHTHOUSE_LAMP_RADIUS - 1], [-LIGHTHOUSE_LAMP_RADIUS - 1, -1], [LIGHTHOUSE_LAMP_RADIUS - 1, -1]] as const) {
      shapes.push(box([centreX + x, centreY + y, galleryTop], [2, 2, LIGHTHOUSE_LAMP_HEIGHT], MAT.STEEL));
    }
    shapes.push(
      { kind: 'cone', base: [centreX, centreY, lampTop], radius: LIGHTHOUSE_LAMP_RADIUS + 2, topRadius: 1, height: LIGHTHOUSE_ROOF_HEIGHT, material: stripe },
      centred(centreX, centreY, 2, 2, lampTop + LIGHTHOUSE_ROOF_HEIGHT, 2, MAT.INK),
    );
    return blueprintOf('lighthouse', definition, shapes, [
      glowLight([centreX, centreY, galleryTop + LIGHTHOUSE_LAMP_HEIGHT / 2], LIGHTHOUSE_LIGHT_RADIUS),
    ]);
  },
};

// ------------------------------------------------------------------ orbit globe (futuristic, 2x2 landmark)

/**
 * A globe in the catalog colour on a steel stalk and a stepped plinth, inside an armillary of two accent orbit rings
 * (one vertical, standing on the stalk; one horizontal, crossing it at the equator) carrying two white moons, with an
 * accent equator band. Static: scenery has no ride motion, so the rings do not spin.
 */
const GLOBE_CENTRE_Z = 36;
const GLOBE_RADIUS = 12;
const GLOBE_ORBIT_RADIUS = 19;
const GLOBE_MOON_RADIUS = 3;

export const orbitGlobe: ObjectContent = {
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [centreX, centreY] = footprintCentre(definition);
    const tag = slotTagger(definition.id);
    const globe = tag('primary', palette.material(definition.color));
    const orbit = tag('secondary', palette.material(definition.accent));
    const centre: Vec3 = [centreX, centreY, GLOBE_CENTRE_Z];
    const shapes: Shape[] = [
      disc(centreX, centreY, PLOT_TOP_Z, 16, 3, MAT.CONCRETE, PATTERN.SPECKLE),
      disc(centreX, centreY, 4, 12, 2, MAT.STEEL_LIGHT, PATTERN.METAL),
      disc(centreX, centreY, 6, 3, GLOBE_CENTRE_Z - GLOBE_RADIUS + 2 - 6, MAT.STEEL, PATTERN.METAL),
      { kind: 'ellipsoid', center: centre, radii: [GLOBE_RADIUS, GLOBE_RADIUS, GLOBE_RADIUS], material: globe },
      { kind: 'ring', center: centre, radius: GLOBE_RADIUS, thickness: 2, width: 2, axis: 'z', material: orbit },
      { kind: 'ring', center: centre, radius: GLOBE_ORBIT_RADIUS, thickness: 2, width: 2, axis: 'x', material: orbit },
      { kind: 'ring', center: centre, radius: GLOBE_ORBIT_RADIUS, thickness: 2, width: 2, axis: 'z', material: orbit },
      { kind: 'ellipsoid', center: [centreX - GLOBE_ORBIT_RADIUS, centreY, GLOBE_CENTRE_Z], radii: [GLOBE_MOON_RADIUS, GLOBE_MOON_RADIUS, GLOBE_MOON_RADIUS], material: MAT.WHITE },
      { kind: 'ellipsoid', center: [centreX + GLOBE_ORBIT_RADIUS, centreY, GLOBE_CENTRE_Z], radii: [GLOBE_MOON_RADIUS, GLOBE_MOON_RADIUS, GLOBE_MOON_RADIUS], material: MAT.WHITE },
    ];
    return blueprintOf('globe', definition, shapes);
  },
};
