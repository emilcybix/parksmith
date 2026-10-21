import { BOX_TEXELS, BOX_TEX_WIDTH, DYNAMIC_BOX_TEX_WIDTH, TRANSFORM_TEXELS, TRANSFORM_TEX_WIDTH } from '../../contracts/boxes';
import { FIGURE_TEMPLATE_TEXELS, FIGURE_TEMPLATE_TEX_WIDTH, FIGURE_TEXELS, FIGURE_TEX_WIDTH } from '../../contracts/figures';
import { LIGHT_TEXELS, LIGHT_TEX_WIDTH } from '../../contracts/frame';
import {
  BAYER_4X4,
  FACE_OTHER,
  FACE_TOP,
  FACE_X,
  FACE_Y,
  GFLAG_EMISSIVE,
  GFLAG_FIGURE,
  GFLAG_GHOST,
  GFLAG_NO_OUTLINE,
  GFLAG_SHADOW,
  GFLAG_WATER,
  LIGHT_DIRECTION,
} from '../../contracts/gbuffer';

/**
 * GLSL shared by every voxel program, generated from the TypeScript contracts so the constants can
 * never drift between CPU packing and GPU unpacking.
 *
 * Rules for every shader in gpu/shaders:
 * - Both stages start with `#version 300 es` (Pixi only detects ES 3.00 from the fragment, and a
 *   vertex-only directive breaks the preprocessor), then VX_PRECISION.
 * - Chunks like this one declare NO uniforms and NO samplers; functions take them as parameters.
 *   Top-level shaders declare the uniforms they use, once.
 * - Shared uniform names (Pixi UniformGroup `frameUniforms`, all vec2<f32>/f32 holding integers
 *   where noted): uCameraTexel (low-res texel (0,0) in world texels, guard band included),
 *   uLowSize, uClipSize (power-of-two viewport the geometry programs map through, so rotated edges
 *   stay put on 1-texel pans), uTexelScale (Phase 55: world texels per low-res texel, 1, 2 or 4;
 *   uCameraTexel is a multiple of it), uDepthRange (min, max depth key), uTime (seconds, wrapped on
 *   the CPU), uGrid (0/1).
 * - Samplers are `highp sampler2D`; data is fetched with texelFetch only.
 * - No program used for an opaque draw contains `discard` (it disables early-Z / hidden-surface
 *   removal on Mali, Adreno and Apple GPUs). Dithered draws use a separate DITHER variant.
 */

const glslFloat = (value: number): string => (Number.isInteger(value) ? `${value}.0` : `${value}`);

export const VX_PRECISION = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
`;

export const VX_COMMON = /* glsl */ `
const int VX_BOX_TEXELS = ${BOX_TEXELS};
const int VX_BOX_TEX_WIDTH = ${BOX_TEX_WIDTH};
const int VX_DYNAMIC_BOX_TEX_WIDTH = ${DYNAMIC_BOX_TEX_WIDTH};
const int VX_TRANSFORM_TEXELS = ${TRANSFORM_TEXELS};
const int VX_TRANSFORM_TEX_WIDTH = ${TRANSFORM_TEX_WIDTH};
const int VX_FIGURE_TEXELS = ${FIGURE_TEXELS};
const int VX_FIGURE_TEX_WIDTH = ${FIGURE_TEX_WIDTH};
const int VX_FIGURE_TEMPLATE_TEXELS = ${FIGURE_TEMPLATE_TEXELS};
const int VX_FIGURE_TEMPLATE_TEX_WIDTH = ${FIGURE_TEMPLATE_TEX_WIDTH};
const int VX_LIGHT_TEXELS = ${LIGHT_TEXELS};
const int VX_LIGHT_TEX_WIDTH = ${LIGHT_TEX_WIDTH};

const int VX_FACE_TOP = ${FACE_TOP};
const int VX_FACE_X = ${FACE_X};
const int VX_FACE_Y = ${FACE_Y};
const int VX_FACE_OTHER = ${FACE_OTHER};
const int VX_GFLAG_EMISSIVE = ${GFLAG_EMISSIVE};
const int VX_GFLAG_WATER = ${GFLAG_WATER};
const int VX_GFLAG_FIGURE = ${GFLAG_FIGURE};
const int VX_GFLAG_NO_OUTLINE = ${GFLAG_NO_OUTLINE};
const int VX_GFLAG_GHOST = ${GFLAG_GHOST};
const int VX_GFLAG_SHADOW = ${GFLAG_SHADOW};

const vec3 VX_LIGHT_DIRECTION = vec3(${LIGHT_DIRECTION.map(glslFloat).join(', ')});

/** Texel coordinate of item \`index\` whose records are \`texels\` wide in a \`width\`-wide texture. */
ivec2 vxTexelOf(int index, int texels, int width, int field) {
  int linear = index * texels + field;
  return ivec2(linear % width, linear / width);
}

/** World texel of a voxel-space point (== legacy world px). */
vec2 vxProject(vec3 v) {
  return vec2(v.x - v.y, (v.x + v.y) * 0.5 - v.z);
}

/** Depth key: larger is nearer. */
float vxDepthKey(vec3 v) {
  return v.x + v.y + v.z;
}

/** NDC z for depth test LESS, clear depth 1. range = (min, max) depth key. */
float vxDepthNdc(float key, vec2 range) {
  return 1.0 - 2.0 * (key - range.x) / (range.y - range.x);
}

/** Depth key from a sampled depth-texture value (1.0 = background). */
float vxDepthKeyFromTexture(float value, vec2 range) {
  return range.x + (1.0 - value) * (range.y - range.x);
}

/** Voxel-space point seen at world texel \`t\` with depth key \`key\`. */
vec3 vxFromTexelAndDepth(vec2 t, float key) {
  float sum = (t.y + key) / 1.5;
  return vec3((sum + t.x) * 0.5, (sum - t.x) * 0.5, key - sum);
}

/**
 * Clip-space position of a world texel in a low-res target whose texel (0,0) is at \`cameraTexel\`, holding \`scale\`
 * world texels per texel (Phase 55; dividing by 1.0 is exact, so k = 1 maps as before).
 */
vec4 vxClip(vec2 worldTexel, vec2 cameraTexel, vec2 lowSize, float scale, float ndcZ) {
  vec2 p = (worldTexel - cameraTexel) / scale / lowSize * 2.0 - 1.0;
  return vec4(p, ndcZ, 1.0);
}

vec3 vxQuatRotate(vec4 q, vec3 v) {
  vec3 t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

/** Bayer 4×4 threshold in (0, 1); \`p\` must be WORLD-anchored (fragment texel + camera texel). */
float vxBayer4(ivec2 p) {
  const float M[16] = float[16](${BAYER_4X4.map(glslFloat).join(', ')});
  return M[(p.y & 3) * 4 + (p.x & 3)];
}

/** Lambert term written to gdata.a: max(0, n·L) / (up·L), clamped to 1. */
float vxLambert(vec3 n) {
  return clamp(dot(n, VX_LIGHT_DIRECTION) / VX_LIGHT_DIRECTION.z, 0.0, 1.0);
}

vec4 vxPackGData(int group, int faceAndFlags, float emissive, float lambert) {
  return vec4(float(group) / 255.0, float(faceAndFlags) / 255.0, emissive, lambert);
}

int vxGroupOf(vec4 gdata) { return int(gdata.r * 255.0 + 0.5); }
int vxFaceFlagsOf(vec4 gdata) { return int(gdata.g * 255.0 + 0.5); }
int vxFaceOf(vec4 gdata) { return vxFaceFlagsOf(gdata) & 3; }
bool vxHasFlag(vec4 gdata, int flag) { return (vxFaceFlagsOf(gdata) & flag) != 0; }

vec3 vxRgb(int rgb) {
  return vec3(float((rgb >> 16) & 255), float((rgb >> 8) & 255), float(rgb & 255)) / 255.0;
}
`;

/**
 * Phase 26 view rotation (VX_VIEW builds only, appended after VX_COMMON by the programs that use it; the
 * VX_VIEW-off sources never contain it, which keeps them byte-identical to the pre-rotation ones).
 * `view` is uView = (c, s, ox, oy): u = c*x - s*y + ox, v = s*x + c*y + oy, z unchanged. c and s are
 * -1, 0 or 1 and ox, oy are multiples of 32, so every integer corner stays an integer and view 0
 * (1, 0, 0, 0) returns its input bit for bit. The TypeScript twins are contracts/view.ts. Like VX_COMMON
 * this chunk declares no uniform: the caller passes the uniform in.
 */
export const VX_VIEW_FORWARD = /* glsl */ `
/** World voxel to view voxel (whole point). */
vec3 vxViewPoint(vec3 p, vec4 view) {
  return vec3(view.x * p.x - view.y * p.y + view.z, view.y * p.x + view.x * p.y + view.w, p.z);
}

/** World vector to view vector (linear part only). */
vec3 vxViewVector(vec3 n, vec4 view) {
  return vec3(view.x * n.x - view.y * n.y, view.y * n.x + view.x * n.y, n.z);
}
`;

/** The inverse map alone, for the composite's world-anchored weather (it never maps forward). */
export const VX_VIEW_INVERSE = /* glsl */ `
/** View (u, v) back to world (x, y): the inverse map, for the things that stay anchored to the world. */
vec2 vxWorldXYOfView(vec2 uv, vec4 view) {
  float du = uv.x - view.z;
  float dv = uv.y - view.w;
  return vec2(view.x * du + view.y * dv, -view.y * du + view.x * dv);
}
`;

/** Forward and inverse maps, for the geometry programs. */
export const VX_VIEW_COMMON = VX_VIEW_FORWARD + VX_VIEW_INVERSE;
