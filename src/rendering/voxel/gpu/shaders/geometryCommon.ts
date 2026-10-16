import {
  MATERIAL_FLAG_EMISSIVE,
  MATERIAL_FLAG_GLASS,
  MATERIAL_FLAG_NO_OUTLINE,
  MATERIAL_FLAG_SHADOW,
  MATERIAL_FLAG_WATER,
} from '../../contracts/palette';
import { glslFloat, glslInt } from './glsl';

/** Sub-texel grid projected vertex positions snap to (the GLES minimum of 4 sub-pixel bits). */
export const SUBTEXEL_STEPS = 16;

/**
 * GLSL shared by the geometry programs (world boxes and figures), appended after VX_COMMON in both
 * stages. Like VX_COMMON it declares no uniforms: it is the vertex-pulling face walk and the one
 * place that turns palette material flags into G-buffer flags, so boxes, rigid parts, litter and
 * figures can never disagree about what a lamp or a pane of glass writes.
 *
 * Face walk: a box emits three quads, one per local axis k (0 = x, 1 = y, 2 = z), each on the side
 * of the box that faces the camera. `corner` (gl_VertexID & 3) picks the quad corner along the two
 * other axes, so the index pattern [q, q+1, q+2, q+2, q+1, q+3] covers the face.
 */
export const VX_GEOMETRY_COMMON = /* glsl */ `
const int VX_MATERIAL_FLAG_EMISSIVE = ${glslInt(MATERIAL_FLAG_EMISSIVE)};
const int VX_MATERIAL_FLAG_GLASS = ${glslInt(MATERIAL_FLAG_GLASS)};
const int VX_MATERIAL_FLAG_WATER = ${glslInt(MATERIAL_FLAG_WATER)};
const int VX_MATERIAL_FLAG_NO_OUTLINE = ${glslInt(MATERIAL_FLAG_NO_OUTLINE)};
const int VX_MATERIAL_FLAG_SHADOW = ${glslInt(MATERIAL_FLAG_SHADOW)};

/**
 * Projected vertex positions snap to 1/VX_SUBTEXEL_STEPS texel in WORLD texels, before the camera
 * is subtracted. Together with the power-of-two clip size the geometry passes map through
 * (uClipSize, see VoxelGpu), this makes every window coordinate an exact translate of the world
 * position: world − camera is exact, ×2/size and −1 are exact for values on this grid, and so is the
 * viewport transform back. A rotated edge that passes close to a texel centre — a spinning ride part —
 * then rasterises identically whatever the camera texel, so panning by whole texels moves every
 * texel exactly (with a rounded mapping it flipped such texels on a float-edge rasteriser). Integer
 * geometry (static boxes, figures) is already on the grid and never moves.
 */
const float VX_SUBTEXEL_STEPS = ${glslFloat(SUBTEXEL_STEPS)};

vec2 vxSnapSubtexel(vec2 texel) {
  return floor(texel * VX_SUBTEXEL_STEPS + 0.5) / VX_SUBTEXEL_STEPS;
}

/** One-hot vector of local axis k (0 = x, 1 = y, 2 = z). */
vec3 vxAxis(int k) {
  return vec3(equal(ivec3(k), ivec3(0, 1, 2)));
}

/** 0/1 offsets of quad corner \`corner\` on the face of axis k at side \`sideMax\` (1 = the box's max). */
vec3 vxFaceCorner(int k, int corner, float sideMax) {
  return vxAxis(k) * sideMax
    + vxAxis((k + 1) % 3) * float(corner & 1)
    + vxAxis((k + 2) % 3) * float(corner >> 1);
}

/** Face code of an unrotated face of local axis k. */
int vxFaceOfAxis(int k) {
  return k == 2 ? VX_FACE_TOP : (k == 0 ? VX_FACE_X : VX_FACE_Y);
}

/**
 * G-buffer face code of a visible face with unit world normal n. A visible axis-aligned face always
 * points to +x, +y or +z (the camera looks along −(1, 1, 1)); anything else — a spinning rotor, a
 * turning wheel, a pitched car — is FACE_OTHER, which has no fixed plane gradient.
 */
int vxFaceOfNormal(vec3 n) {
  if (n.z > 0.9999) return VX_FACE_TOP;
  if (n.x > 0.9999) return VX_FACE_X;
  if (n.y > 0.9999) return VX_FACE_Y;
  return VX_FACE_OTHER;
}

/** G-buffer flags implied by a material's palette flags (row 1, red). */
int vxGFlagsOfMaterial(int flags) {
  int result = 0;
  if ((flags & VX_MATERIAL_FLAG_EMISSIVE) != 0) result |= VX_GFLAG_EMISSIVE;
  if ((flags & VX_MATERIAL_FLAG_WATER) != 0) result |= VX_GFLAG_WATER;
  if ((flags & VX_MATERIAL_FLAG_NO_OUTLINE) != 0) result |= VX_GFLAG_NO_OUTLINE;
  if ((flags & VX_MATERIAL_FLAG_SHADOW) != 0) result |= VX_GFLAG_SHADOW;
  return result;
}

/**
 * Emissive strength written to gdata.b. Lamps carry the EMISSIVE flag and glow by the preset's
 * emissiveScale; glass has no flag bit of its own in the G-buffer, so it writes its strength without
 * the EMISSIVE flag and the composite scales it by glassGlow (0 by day). A glass material authored
 * with strength 0 still glows fully at dusk and night.
 */
float vxEmissiveOf(int flags, float strength) {
  if ((flags & VX_MATERIAL_FLAG_EMISSIVE) != 0) return strength;
  if ((flags & VX_MATERIAL_FLAG_GLASS) != 0) return strength > 0.0 ? strength : 1.0;
  return 0.0;
}
`;
