import { PATTERN } from '../../contracts/palette';
import type { PatternName } from '../../contracts/palette';

/**
 * Surface patterns (contracts/palette.ts PATTERN table), as GLSL appended after VX_COMMON.
 *
 * Contract (used by the world and figure shaders):
 *   vec3 vxSurfaceColor(highp sampler2D palette, int material, int pattern, int quarterTurn,
 *                       int face, vec3 pos, vec3 normal, float time, float grid)
 *     material     palette id (row 0 base, row 1 props, row 2 secondary)
 *     pattern      PATTERN id; quarterTurn swaps x/y of directional patterns
 *     face         VX_FACE_* of the fragment
 *     pos          pattern-space voxel position of the fragment (world voxels for static boxes,
 *                  part-local for rigid parts and figures), interpolated
 *     normal       unit normal in the same space
 *     time         seconds, wrapped on the CPU
 *     grid         1.0 when the tile grid is shown (GRASS draws it), else 0.0
 *   returns the UNLIT sRGB colour of that point.
 * Cell addressing: top faces use floor(pos + vec3(0.5, 0.0, -0.5)) (one texel pair per voxel);
 * other faces floor(pos - 0.5 * normal). Refined here (see below): bands and tiles (STRIPES, ROOF,
 * GRASS's tile checker and grid line) use floor(pos - 0.5 * normal) on top faces too.
 *
 *   vec4 vxMaterialProps(highp sampler2D palette, int material)
 *     returns (flags, emissive strength 0..1, pattern amplitude 0..1, 0) from palette row 1.
 *
 * How the patterns work, and why:
 * - Everything is integer hashing of the voxel cell a fragment lies on: no textures, no loops, a
 *   handful of ALU ops per pattern, so a low-tier GPU pays almost nothing for them, and the pattern
 *   is anchored to the world (or to the moving part), so nothing crawls while the camera pans.
 * - Two addressings, because a top face has exactly as many texels as voxels but the texel centres
 *   sit at voxel fractions (¾, ¼) and (¼, ¾), two in every voxel with an even x + y and none in the
 *   others:
 *   · the CELL (the contract rule) adds half a voxel along x on upward faces before flooring, which
 *     maps every voxel to exactly one texel. Everything 2D at voxel scale needs it — value noise,
 *     blades, pebbles, the 2×2 weave, ripples, clusters, and the meshes of panes, panels, bricks,
 *     cobbles and boards: with the voxel below they would show only even voxels as 2-texel dashes,
 *     a 2×2 checker would turn into vertical stripes (critique gpu #6, visual #11), and lines
 *     crossing in both directions would fall on one texel phase and read as bricks, not a mesh.
 *     Its price: at a face's x edges it samples half a voxel off, so a feature boundary that lies
 *     exactly on the edge shows a 1-texel sliver of the next feature on alternate rows;
 *   · the VOXEL, floor(pos − ½·normal), is the voxel under the sample. Pure bands and tiles use it
 *     (STRIPES, ROOF rows and tabs, GRASS's tile checker and grid line): a band loses nothing to
 *     the missing odd voxels (a 1-voxel line along an axis is still a continuous 2:1 line, two
 *     texels per row), and its edges then fall exactly on the box's edges. That matters most for
 *     the grid line, which lies on a face's edge at every plot, path and terrain step: with the
 *     cell it thins to one texel per row there and leaks onto the neighbouring tile.
 *   Both are keyed on the normal rather than on `face`, so a part-local top face and a flipped
 *   part's bottom face address the voxel they belong to. On static boxes every sample point sits at
 *   least ¼ voxel from a boundary, so interpolation error never flips a cell.
 * - Cells are offset by PATTERN_ORIGIN (3·2^14, a multiple of every period used here), so shifts,
 *   masks, / and % never see a negative coordinate (terrain and part-local positions are negative)
 *   while every line still falls on the world coordinate it would without the offset.
 * - Faces address a plane (u, v) in MODEL axes, so directional patterns follow a rotated model:
 *   floors and roofs use (model x, model y), walls (their horizontal model axis, z), so wall courses
 *   stay level. A visual quarter turn maps model (x, y) to world (y, W − x) with W a multiple of 32
 *   (space.ts), so model x is PATTERN_MIRROR − world y: that is a swap AND a mirror, and it keeps
 *   every lattice whose period divides 32 (panes, paving and cobbles, boards, stripes, roof tabs,
 *   panels, weave) in the same place on the model in both rotations. BRICK's 6×3 bond and FOLIAGE's
 *   3³ clusters cannot keep their phase and only keep their direction. GRASS's tile checker and grid
 *   line, SOIL's strata, SPECKLE and FOLIAGE stay in world axes: the lawn must line up with the
 *   legacy tile grid whatever stands on it (blades and pebbles are random, so any axes do). Static
 *   boxes carry the model's quarter turn in their box word; rigid parts and figures pattern in
 *   their own local space, which already turns with them, so their words carry 0.
 * - Content can rely on these alignments (model voxels): pane frames on multiples of 4 (a wall
 *   window from 4a to 4b + 1 is framed on every side); mortar under every 4th paving row and every
 *   8th voxel along it; board seams on multiples of 4; a base-colour stripe starting at every
 *   multiple of 8; metal seams on multiples of 8.
 * - Features are at least 2 voxels, periods at least 4 (art bible), except the 1-voxel mortar,
 *   seams, frames, shingle tabs and grid line, and BRICK's 3-voxel courses and FOLIAGE's 3³ clusters,
 *   which the art bible names explicitly.
 * - The material's amplitude (row 1 b, 6–12 %) is the ± value variation of everything a pattern
 *   varies; the secondary colour (row 2) is the second colour of mortar, gaps, seams, strata,
 *   stripes, frames, water crests and the second grass shade.
 *
 * Patterns: PLAIN base · SPECKLE ±amplitude on 2×2×2 cells · GRASS the legacy two-colour lawn
 * (tiles with an even x + y in the base, the others in the secondary), sparse ±amplitude 2×2 blades
 * stratified at most one light and one dark per 8×8 block (≤ 1/8), and, on top faces while the grid
 * is shown, the legacy grid stroke on the first voxel row and column of every tile (1 voxel wide) ·
 * PAVING running-bond bricks 8×4, 1-voxel mortar in the secondary, ±amplitude per brick · COBBLE
 * 6×6 stones on an 8 lattice with 2-voxel gaps in the secondary, staggered rows · PLANKS 4-voxel
 * boards running along model x, seams and staggered end joints every 16 in the secondary,
 * ±amplitude per board length · ROOF one row per step of height (a 1-voxel step of the 1:2 stepped
 * gable is 2 voxels along the slope) on roof tops, 2-voxel rows on the vertical faces, alternate rows
 * ×ROOF_ROW_SHADE, darker 1-voxel shingle tabs every 4 along model x, staggered by row; nothing
 * depends on which way the ridge runs · STRIPES 4-wide bands base/secondary across model x, vertical
 * on walls · FOLIAGE ±amplitude over 3³ clusters · WATER two travelling waves on 2×2 cells, crests
 * in the secondary, troughs −amplitude, three colours only, looping every WATER_LOOP_SECONDS ·
 * WINDOW 3×3 panes on a 4 lattice, frames in the secondary · SOIL strata alternating base/secondary
 * every 4 voxels of height with sparse 2×2 pebbles (≤ 1/8) · METAL 8×8 panels, seams in the
 * secondary · FABRIC a 2-voxel weave, alternate cells −amplitude · BRICK wall bricks 6×3 running
 * bond, mortar in the secondary, ±amplitude per brick.
 *
 * Owner: Wave B3 (Wave D look agent afterwards).
 */

/** The legacy grid stroke (WorldRenderer.drawTerrain: 0x5faa66 at alpha 0.28), mixed into grass on tile borders. */
export const GRID_LINE_COLOR = 0x5faa66;
export const GRID_LINE_MIX = 0.28;
/** Alternate roof rows are this much darker (art bible). */
export const ROOF_ROW_SHADE = 0.88;
/** WATER repeats exactly every this many seconds: wrap uTime at a multiple of it and nothing jumps. */
export const WATER_LOOP_SECONDS = 12;
/** Waves per loop of the two WATER swells (periods of 3 s and 4 s). */
const WATER_WAVES_A = 4;
const WATER_WAVES_B = 3;
/** Added to every pattern cell: 3·2^14 is a multiple of every period below and keeps cells positive. */
const PATTERN_ORIGIN = 49_152;
/**
 * Model x of a turned box is PATTERN_MIRROR − (world y + PATTERN_ORIGIN) = PATTERN_ORIGIN − 1 − world y:
 * non-negative, and congruent to W − 1 − world y (the model voxel) modulo 32 for any footprint.
 */
const PATTERN_MIRROR = 2 * PATTERN_ORIGIN - 1;
/** WATER wave numbers are whole multiples of 2π/64 per 2-voxel cell, so masking cells to 64 is seamless. */
const WATER_CELL_WRAP = 64;

const glslFloat = (value: number): string => (Number.isInteger(value) ? `${value}.0` : `${value}`);

const glslRgb = (rgb: number): string =>
  `vec3(${[16, 8, 0].map((shift) => glslFloat(((rgb >> shift) & 255) / 255)).join(', ')})`;

const waveNumber = (waves: number): string => glslFloat((2 * Math.PI * waves) / WATER_CELL_WRAP);

const PATTERN_CONSTANTS = (Object.keys(PATTERN) as PatternName[])
  .map((name) => `const int VX_PATTERN_${name} = ${PATTERN[name]};`)
  .join('\n');

/**
 * The pattern chunk. `viewTurn` adds a `vec3 cellShift` parameter to vxSurfaceColor (after `normal`): the
 * top-face cell offset (the half voxel of the CELL rule above) along VIEW +x expressed in pattern space,
 * (0.5, 0, 0) in view 0. A top face's texel centres sit at VIEW fractions (3/4, 1/4) and (1/4, 3/4); in world
 * coordinates under a quarter turn they become (1/4, 1/4) and (3/4, 3/4), where a fixed +x shift would map
 * the voxels to texels along a different screen diagonal. Shifting along view +x reproduces the view-0
 * sampling of the turned world, so every top voxel still gets exactly one texel in every view. Bands and
 * tiles use floor(pos - 0.5 * normal), which is rotation invariant. With `viewTurn` false the text is the
 * pre-rotation chunk, byte for byte.
 */
export const vxPatternsSource = (viewTurn: boolean): string => `
${PATTERN_CONSTANTS}
const int VX_PATTERN_ORIGIN = ${PATTERN_ORIGIN};
const int VX_PATTERN_MIRROR = ${PATTERN_MIRROR};
const vec3 VX_GRID_LINE = ${glslRgb(GRID_LINE_COLOR)};
const float VX_GRID_LINE_MIX = ${glslFloat(GRID_LINE_MIX)};
const float VX_ROOF_ROW_SHADE = ${glslFloat(ROOF_ROW_SHADE)};
const float VX_WATER_LOOP_SECONDS = ${glslFloat(WATER_LOOP_SECONDS)};

vec4 vxMaterialProps(highp sampler2D palette, int material) {
  vec4 raw = texelFetch(palette, ivec2(material, 1), 0);
  return vec4(floor(raw.r * 255.0 + 0.5), raw.g, raw.b, 0.0);
}

/** Integer hash of a (non-negative) pattern cell: lowbias32 finaliser, no tables. */
uint vxPatternHash(ivec3 cell) {
  uint h = (uint(cell.x) * 0x8DA6B343u) ^ (uint(cell.y) * 0xD8163841u) ^ (uint(cell.z) * 0xCB1AB31Fu);
  h ^= h >> 16;
  h *= 0x7FEB352Du;
  h ^= h >> 15;
  h *= 0x846CA68Bu;
  h ^= h >> 16;
  return h;
}

/** -1, 0 or +1, evenly, from a hash. */
float vxPatternLevel(uint h) {
  return float(int(h % 3u) - 1);
}

/**
 * Sparse 2×2 specks, stratified: every 8×8 block of a face holds one light speck and at most one
 * dark one, on hashed 2-aligned spots, so coverage never exceeds 1/8 and specks never clump.
 * +1 light, -1 dark, 0 none.
 */
float vxPatternSpeck(ivec2 plane, int depth) {
  uint h = vxPatternHash(ivec3(plane >> 3, depth));
  uint spot = uint(((plane.x >> 1) & 3) | ((plane.y & 6) << 1));
  return spot == (h & 15u) ? 1.0 : (spot == ((h >> 4) & 15u) ? -1.0 : 0.0);
}

/** The voxel under a fragment, floor(pos − ½·normal), offset by VX_PATTERN_ORIGIN (bands and tiles). */
ivec3 vxPatternVoxel(vec3 pos, vec3 normal) {
  return ivec3(floor(pos - 0.5 * normal)) + VX_PATTERN_ORIGIN;
}

/** The contract's 1:1 cell: upward faces shift half a voxel along x first (see the file comment). */
ivec3 vxPatternCell(vec3 pos, vec3 normal${viewTurn ? ', vec3 cellShift' : ''}) {
  vec3 p = normal.z > 0.5 ? pos + ${viewTurn ? 'cellShift + vec3(0.0, 0.0, -0.5)' : 'vec3(0.5, 0.0, -0.5)'} : pos - 0.5 * normal;
  return ivec3(floor(p)) + VX_PATTERN_ORIGIN;
}

/**
 * (u, v, depth) of a cell in the face's MODEL plane: floors and roofs (model x, model y), walls
 * (their horizontal model axis, z); depth is the model coordinate constant across the face. A
 * quarter turn swaps x and y and mirrors model x (see the file comment).
 */
ivec3 vxPatternPlane(ivec3 cell, bool horizontal, bool modelFacesX, bool turned) {
  int modelX = turned ? VX_PATTERN_MIRROR - cell.y : cell.x;
  int modelY = turned ? cell.x : cell.y;
  if (horizontal) return ivec3(modelX, modelY, cell.z);
  return modelFacesX ? ivec3(modelY, cell.z, modelX) : ivec3(modelX, cell.z, modelY);
}

vec3 vxSurfaceColor(highp sampler2D palette, int material, int pattern, int quarterTurn,
                    int face, vec3 pos, vec3 normal, ${viewTurn ? 'vec3 cellShift, ' : ''}float time, float grid) {
  vec3 base = texelFetch(palette, ivec2(material, 0), 0).rgb;
  if (pattern == VX_PATTERN_PLAIN) return base;
  vec3 second = texelFetch(palette, ivec2(material, 2), 0).rgb;
  float amplitude = texelFetch(palette, ivec2(material, 1), 0).b;
  vec3 axis = abs(normal);
  bool horizontal = axis.z > 0.5;
  bool turned = (quarterTurn & 1) == 1;
  bool modelFacesX = !horizontal && ((axis.x > 0.5) != turned);
  ivec3 voxel = vxPatternVoxel(pos, normal);
  ivec3 cell = vxPatternCell(pos, normal${viewTurn ? ', cellShift' : ''});
  // (u, v) of the 1:1 cell in the face's model plane, and the model coordinate constant across the
  // face (feature ids). Bands and tiles use the voxel instead (see the file comment).
  ivec3 cellPlane = vxPatternPlane(cell, horizontal, modelFacesX, turned);
  ivec2 plane = cellPlane.xy;
  int depth = cellPlane.z;
  vec3 color = base;

  if (pattern == VX_PATTERN_SPECKLE) {
    color = base * (1.0 + amplitude * vxPatternLevel(vxPatternHash(cell >> 1)));
  } else if (pattern == VX_PATTERN_GRASS) {
    // Tiles (world axes, like the legacy checkerboard) switch colour and draw the grid line on the
    // voxel under the sample, so a tile edge is exact on every plot slab and terrain step.
    color = (((voxel.x >> 5) + (voxel.y >> 5)) & 1) == 0 ? base : second;
    // The cell sits half a voxel off the voxel along x, so a speck on a tile's first or last column
    // pair would straddle two tiles' shades and draw a seam at tile column 0: keep those pairs plain.
    int speckPair = (plane.x >> 1) & 15;
    if (speckPair != 0 && speckPair != 15) color *= 1.0 + amplitude * vxPatternSpeck(plane, depth);
    bool border = (voxel.x & 31) == 0 || (voxel.y & 31) == 0;
    if (grid > 0.5 && face == VX_FACE_TOP && border) color = mix(color, VX_GRID_LINE, VX_GRID_LINE_MIX);
  } else if (pattern == VX_PATTERN_PAVING) {
    int course = plane.y >> 2;
    int along = plane.x + ((course & 1) << 2);
    bool mortar = (along & 7) == 0 || (plane.y & 3) == 0;
    color = mortar ? second
      : base * (1.0 + amplitude * vxPatternLevel(vxPatternHash(ivec3(along >> 3, course, depth))));
  } else if (pattern == VX_PATTERN_COBBLE) {
    int row = plane.y >> 3;
    int along = plane.x + ((row & 1) << 2);
    int u = along & 7;
    int v = plane.y & 7;
    bool gap = u == 0 || u == 7 || v == 0 || v == 7;
    color = gap ? second
      : base * (1.0 + amplitude * vxPatternLevel(vxPatternHash(ivec3(along >> 3, row, depth))));
  } else if (pattern == VX_PATTERN_PLANKS) {
    int board = plane.y >> 2;
    int run = plane.x + int(vxPatternHash(ivec3(board, depth, VX_PATTERN_PLANKS)) & 15u);
    bool seam = (plane.y & 3) == 0 || (run & 15) == 0;
    color = seam ? second
      : base * (1.0 + amplitude * vxPatternLevel(vxPatternHash(ivec3(run >> 4, board, depth))));
  } else if (pattern == VX_PATTERN_ROOF) {
    // A 1:2 stepped gable or cone is 1-voxel slabs: every tread is one row, 2 voxels deep along the
    // slope, whichever way the ridge runs. Vertical faces (risers, gable ends, fascias) take 2-voxel
    // rows, so a tall face never shows a 1-voxel stripe. Rows and tabs are bands: voxel addressing.
    int row = horizontal ? voxel.z : voxel.z >> 1;
    int along = vxPatternPlane(voxel, horizontal, modelFacesX, turned).x;
    bool tab = ((along + ((row & 1) << 1)) & 3) == 0;
    color = base * ((row & 1) == 1 ? VX_ROOF_ROW_SHADE : 1.0) * (tab ? 1.0 - amplitude : 1.0);
  } else if (pattern == VX_PATTERN_STRIPES) {
    color = ((vxPatternPlane(voxel, horizontal, modelFacesX, turned).x >> 2) & 1) == 0 ? base : second;
  } else if (pattern == VX_PATTERN_FOLIAGE) {
    color = base * (1.0 + 0.5 * amplitude * float(int(vxPatternHash(cell / 3) % 5u) - 2));
  } else if (pattern == VX_PATTERN_WATER) {
    vec2 wave = vec2((plane >> 1) & ${WATER_CELL_WRAP - 1});
    float loop = fract(time / VX_WATER_LOOP_SECONDS) * 6.2831853;
    float swell = sin(wave.x * ${waveNumber(9)} + wave.y * ${waveNumber(5)} + loop * ${glslFloat(WATER_WAVES_A)})
      + sin(wave.y * ${waveNumber(7)} - wave.x * ${waveNumber(4)} - loop * ${glslFloat(WATER_WAVES_B)});
    color = swell > 1.4 ? second : (swell < -1.3 ? base * (1.0 - amplitude) : base);
  } else if (pattern == VX_PATTERN_WINDOW) {
    bool frame = (plane.x & 3) == 0 || (plane.y & 3) == 0;
    color = frame ? second
      : base * (1.0 + amplitude * vxPatternLevel(vxPatternHash(ivec3(plane >> 2, depth))));
  } else if (pattern == VX_PATTERN_SOIL) {
    color = ((voxel.z >> 2) & 1) == 0 ? base : second;
    color *= 1.0 + amplitude * vxPatternSpeck(plane, depth);
  } else if (pattern == VX_PATTERN_METAL) {
    bool seam = (plane.x & 7) == 0 || (plane.y & 7) == 0;
    color = seam ? second
      : base * (1.0 + amplitude * vxPatternLevel(vxPatternHash(ivec3(plane >> 3, depth))));
  } else if (pattern == VX_PATTERN_FABRIC) {
    color = (((plane.x >> 1) + (plane.y >> 1)) & 1) == 0 ? base : base * (1.0 - amplitude);
  } else if (pattern == VX_PATTERN_BRICK) {
    int course = plane.y / 3;
    int along = plane.x + (course & 1) * 3;
    bool mortar = along % 6 == 0 || plane.y % 3 == 0;
    color = mortar ? second
      : base * (1.0 + amplitude * vxPatternLevel(vxPatternHash(ivec3(along / 6, course, depth))));
  }
  return clamp(color, 0.0, 1.0);
}
`;

/** The pre-rotation chunk (no cellShift parameter). */
export const VX_PATTERNS = vxPatternsSource(false);
