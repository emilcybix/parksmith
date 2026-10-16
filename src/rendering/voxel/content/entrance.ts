import type { Blueprint, LightSource, Shape, Vec3 } from '../contracts/blueprint';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import { MAT, MAT_COLOR } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { PATH_TOP_Z, projectY, VOXELS_PER_TILE } from '../contracts/space';
import { ENTRANCE_COLOUR_ID } from '../../../game/content/colours';
import { slotTagger } from './colourTags';

/**
 * The park gate over the entrance path tile (design §12: posts 6×6×48, top ≤ 64, a sign with a tiny
 * voxel "WELCOME", front on model +y).
 *
 * Model space is the 1×1 tile, x and y in [0, 32), shapes from the path top z = 1 up. Guests walk
 * through along y (the gate stands on the map's +y edge and the park lies toward −y), so the gate is
 * a frame across x: a post on a plinth at each x edge, a yellow sign board hung on the posts' front
 * faces, a pink arch springing from the post tops behind the sign, and a pink-roofed lantern on each
 * post's front face. Between the plinths nothing solid comes below z 40, so guests (at most 22
 * voxels tall) walk under the sign. The left plinth reaches the tile's west edge, where the static
 * world lays a curb when no path adjoins; it cuts its curbs wherever the gate stands on them.
 *
 * The frame is symmetric about x = 15.5, not the tile centre 16: a 7-letter word of 3-voxel glyphs
 * and 1-voxel gaps is 27 columns and cannot be centred on a whole voxel, and lettering one voxel off
 * its own sign shows far more than a gate half a voxel off its tile.
 */

const box = (min: Vec3, size: Vec3, material: number): Shape => ({ kind: 'box', min, size, material });

/** Blueprint id: there is exactly one gate, so the id only has to be unique among builders. */
export const ENTRANCE_BLUEPRINT_ID = 'entrance:park-gate';

/** Highest z the gate may reach (art bible). */
export const ENTRANCE_TOP_LIMIT = 64;

/** Nothing solid in the walkway below this z, so every guest and staff member walks through. */
export const ENTRANCE_WALKWAY_CLEAR_Z = 40;

/** The posts (art bible 6×6×48) at the tile's x edges, symmetric about x = 15.5. */
export const ENTRANCE_POST_SIZE = 6;
export const ENTRANCE_POST_HEIGHT = 48;
export const ENTRANCE_POST_MIN_X: readonly [number, number] = [1, 24];
export const ENTRANCE_POST_MIN_Y = 13;
const POST_TOP_Z = PATH_TOP_Z + ENTRANCE_POST_HEIGHT;
/** The x the whole frame is symmetric about: 15.5 (see above). */
const GATE_CENTER_X = (ENTRANCE_POST_MIN_X[0] + ENTRANCE_POST_MIN_X[1] + ENTRANCE_POST_SIZE) / 2;

/** A plinth one voxel wider than its post on every side grounds the post on the paving. */
const PLINTH_OVERHANG = 1;
const PLINTH_HEIGHT = 4;

/** The walkway: x between the plinths' inner faces, across the whole tile in y. */
export const ENTRANCE_WALKWAY_MIN_X = ENTRANCE_POST_MIN_X[0] + ENTRANCE_POST_SIZE + PLINTH_OVERHANG;
export const ENTRANCE_WALKWAY_MAX_X = ENTRANCE_POST_MIN_X[1] - PLINTH_OVERHANG;

/**
 * The sign board hangs on the posts' front (+y) faces, overhanging each post by a voxel; its front
 * face carries the word. Ten rows centre five-row lettering once the shear compensation below has
 * lifted every third column by a row.
 */
const SIGN_MIN_X = 0;
const SIGN_WIDTH = 31;
const SIGN_DEPTH = 2;
const SIGN_MIN_Z = ENTRANCE_WALKWAY_CLEAR_Z;
const SIGN_HEIGHT = 10;
/** Model y of the plane the sign's front face (and the lettering) lies in. */
export const SIGN_FRONT_Y = ENTRANCE_POST_MIN_Y + ENTRANCE_POST_SIZE + SIGN_DEPTH;

/** The word, drawn in a 3×5 pixel font with 1-voxel gaps: 7 · 3 + 6 = 27 columns. */
export const WELCOME_TEXT = 'WELCOME';
export const GLYPH_WIDTH = 3;
export const GLYPH_HEIGHT = 5;
/** Model x from one letter's first column to the next letter's. */
export const LETTER_PITCH = GLYPH_WIDTH + 1;
/** First text column: a 2-voxel margin inside the sign on both sides. */
export const TEXT_MIN_X = SIGN_MIN_X + 2;
/** z of the glyphs' top row in each letter's first column (later columns are lifted, see below). */
const TEXT_TOP_Z = SIGN_MIN_Z + 6;

/**
 * 3×5 glyphs (Tom Thumb shapes), rows top to bottom, columns left to right as seen on screen ('#' is
 * ink). Letters run along model +x on the +y face, which projects left to right (screen x = vx − vy)
 * at both visual quarter turns — the preview is the judge of that (contracts/space.ts handedness),
 * not model-space intuition. W and M are mirror images with doubled bars, so neither reads as an H.
 */
export const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  W: ['#.#', '#.#', '###', '###', '#.#'],
  E: ['###', '#..', '##.', '#..', '###'],
  L: ['#..', '#..', '#..', '#..', '###'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
};

/**
 * Texel row (screen y, down) on which the voxel at (x, z) of the sign's front face lands: the texel
 * that holds the face's projected centre (contracts/space.ts), which is the texel the rasteriser
 * gives that voxel.
 */
const signFaceTexelRow = (x: number, z: number): number =>
  Math.floor(projectY(x + 0.5, SIGN_FRONT_Y, z + 0.5));

/**
 * Rows a glyph column slips down the screen relative to its letter's first column. At one texel per
 * voxel a +y face shears half a texel per column, so two neighbouring columns share a texel row and
 * the next one lands a row lower: sheared that way a 3×5 W reads as an H and an O as a U. Lifting
 * each column by its slip lands every letter on screen as its upright bitmap, and the word steps
 * down the sign one letter at a time, the way pixel artists letter an isometric sign.
 *
 * This compensates the quarter turn the gate is drawn at: the static world always places the
 * entrance at quarter turn 0. At quarter turn 1 the face shears the other way, so the letters lean
 * twice as far; the word still reads left to right.
 */
const columnSlip = (letterMinX: number, x: number): number =>
  signFaceTexelRow(x, 0) - signFaceTexelRow(letterMinX, 0);

/**
 * Ink voxels of the word as vertical runs, one box per run of each glyph column: the lettering is
 * flush with the sign (it replaces the board's front voxel layer), so it adds no depth edge and the
 * composite draws no outline around each stroke.
 */
const lettering = (ink: number): Shape[] => {
  const shapes: Shape[] = [];
  [...WELCOME_TEXT].forEach((letter, index) => {
    const letterMinX = TEXT_MIN_X + index * LETTER_PITCH;
    const rows = GLYPHS[letter];
    for (let column = 0; column < GLYPH_WIDTH; column += 1) {
      const x = letterMinX + column;
      const topZ = TEXT_TOP_Z + columnSlip(letterMinX, x);
      let row = 0;
      while (row < GLYPH_HEIGHT) {
        if (rows[row][column] !== '#') {
          row += 1;
          continue;
        }
        const first = row;
        while (row < GLYPH_HEIGHT && rows[row][column] === '#') row += 1;
        shapes.push(box([x, SIGN_FRONT_Y - 1, topZ - (row - 1)], [1, 1, row - first], ink));
      }
    }
  });
  return shapes;
};

/**
 * Pink arch crowning the gate: the upper half of a ring in the posts' middle plane, its feet on the
 * post tops. Two voxels deep, so the stair steps of its curve read as a clean edge rather than the
 * diagonal hatching a deeper band's step tops draw.
 */
const ARCH_CENTER: Vec3 = [GATE_CENTER_X, ENTRANCE_POST_MIN_Y + ENTRANCE_POST_SIZE / 2, POST_TOP_Z];
const ARCH_RADIUS = 12;
const ARCH_THICKNESS = 4;
const ARCH_DEPTH = 2;

/**
 * A lantern on each post's front face under the sign: a glowing core on a pink foot under a pink roof
 * that overhangs it by a voxel, so it reads as a lamp against the dark post by day and lights the
 * gate by night.
 */
const LANTERN_CORE_MIN_Z = 29;
const LANTERN_CORE_HEIGHT = 5;
const LANTERN_CORE_DEPTH = 3;
const LANTERN_ROOF_HEIGHT = 2;
/** The core is 4 wide, inset a voxel from each side of the post's front face. */
const LANTERN_INSET = 1;

/** Lamp light (art bible: light radius 64), on at dusk and night. */
export const ENTRANCE_LAMP_LIGHT_RADIUS = 64;
export const ENTRANCE_LIGHT_PRESETS = LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT;

/** Plinth and post whose minimum x is `postX`. */
const post = (postX: number, material: number): Shape[] => [
  box(
    [postX - PLINTH_OVERHANG, ENTRANCE_POST_MIN_Y - PLINTH_OVERHANG, PATH_TOP_Z],
    [ENTRANCE_POST_SIZE + 2 * PLINTH_OVERHANG, ENTRANCE_POST_SIZE + 2 * PLINTH_OVERHANG, PLINTH_HEIGHT],
    material,
  ),
  box([postX, ENTRANCE_POST_MIN_Y, PATH_TOP_Z], [ENTRANCE_POST_SIZE, ENTRANCE_POST_SIZE, ENTRANCE_POST_HEIGHT], material),
];

/** Foot, glowing core and roof of the lantern on the post whose minimum x is `postX`. */
const lantern = (postX: number, trim: number): Shape[] => {
  const faceY = ENTRANCE_POST_MIN_Y + ENTRANCE_POST_SIZE;
  const coreX = postX + LANTERN_INSET;
  const coreWidth = ENTRANCE_POST_SIZE - 2 * LANTERN_INSET;
  return [
    box([coreX, faceY, LANTERN_CORE_MIN_Z - 1], [coreWidth, LANTERN_CORE_DEPTH, 1], trim),
    box([coreX, faceY, LANTERN_CORE_MIN_Z], [coreWidth, LANTERN_CORE_DEPTH, LANTERN_CORE_HEIGHT], MAT.LAMP_GLOW),
    box(
      [postX, faceY, LANTERN_CORE_MIN_Z + LANTERN_CORE_HEIGHT],
      [ENTRANCE_POST_SIZE, LANTERN_CORE_DEPTH + 1, LANTERN_ROOF_HEIGHT],
      trim,
    ),
  ];
};

/** The light at the centre of the lantern core on the post whose minimum x is `postX`. */
const lanternLight = (postX: number): LightSource => ({
  position: [
    postX + ENTRANCE_POST_SIZE / 2,
    ENTRANCE_POST_MIN_Y + ENTRANCE_POST_SIZE + LANTERN_CORE_DEPTH / 2,
    LANTERN_CORE_MIN_Z + LANTERN_CORE_HEIGHT / 2,
  ],
  radius: ENTRANCE_LAMP_LIGHT_RADIUS,
  color: MAT_COLOR.LAMP_GLOW,
  presets: ENTRANCE_LIGHT_PRESETS,
});

/**
 * The gate. Plain colours are looked up by colour through the palette, the way content names every
 * plain material, so the gate shows exactly the legacy art's post, sign, arch and ink colours; the
 * glowing lantern core is named by its MAT id, because a colour never resolves to a flagged material.
 */
export const entranceBlueprint = (palette: Palette): Blueprint => {
  // Phase 28: the arch ring and lantern housings are colour slot 'primary', the sign board 'secondary', the
  // posts and plinths 'trim' (park-level record, game/content/colours.ts ENTRANCE_COLOUR_ID). Lettering and
  // lantern cores stay fixed. Tags change no geometry.
  const tag = slotTagger(ENTRANCE_COLOUR_ID);
  const postMaterial = tag('trim', palette.material(MAT_COLOR.ENTRANCE_POST));
  const signMaterial = tag('secondary', palette.material(MAT_COLOR.SIGN));
  const pink = tag('primary', palette.material(MAT_COLOR.ARCH_PINK));
  const ink = palette.material(MAT_COLOR.INK);
  const archMinY = ARCH_CENTER[1] - ARCH_DEPTH / 2;
  const shapes: Shape[] = [
    // The arch's ring first, then a carve of everything in its plane below the post tops: that
    // leaves the upper half, and the posts placed after the carve are untouched by it.
    { kind: 'ring', center: ARCH_CENTER, radius: ARCH_RADIUS, thickness: ARCH_THICKNESS, width: ARCH_DEPTH, axis: 'y', material: pink },
    box([0, archMinY, 0], [VOXELS_PER_TILE, ARCH_DEPTH, POST_TOP_Z], 0),
    ...ENTRANCE_POST_MIN_X.flatMap((x) => post(x, postMaterial)),
    box([SIGN_MIN_X, SIGN_FRONT_Y - SIGN_DEPTH, SIGN_MIN_Z], [SIGN_WIDTH, SIGN_DEPTH, SIGN_HEIGHT], signMaterial),
    ...lettering(ink),
    ...ENTRANCE_POST_MIN_X.flatMap((x) => lantern(x, pink)),
  ];
  return {
    id: ENTRANCE_BLUEPRINT_ID,
    footprint: [1, 1],
    parts: [{ id: 'body', pivot: [0, 0, 0], shapes }],
    lights: ENTRANCE_POST_MIN_X.map(lanternLight),
  };
};
