import { VERTICES_PER_BOX } from '../../contracts/boxes';
import {
  FIGURE_FLAG_DESATURATE,
  FIGURE_FRAME_COUNT,
  FIGURE_KEYFRAMES,
  PALETTE_ROLE_FIXED,
  PALETTE_ROLE_HAIR,
  PALETTE_ROLE_SHIRT,
  PALETTE_ROLE_SKIN,
  ROLE_COUNT,
} from '../../contracts/figures';
import { DITHER_OFFSET_SHADOW } from '../../contracts/gbuffer';
import { VX_COMMON, VX_PRECISION, VX_VIEW_FORWARD } from './common';
import { VX_GEOMETRY_COMMON } from './geometryCommon';
import { glslFloat, glslInt, glslIvec2 } from './glsl';
import { vxPatternsSource } from './patterns';
import type { GeometryVariant, ShaderSource } from './world';

/**
 * The figure program: guests and staff expanded on the GPU from one entity record each
 * (contracts/figures.ts) and their model's template boxes, with no per-frame geometry at all.
 *
 * One draw per model range: localBox = gl_VertexID / 12, entity = uEntityBase + localBox /
 * uModelBoxCount, template box = uModelFirstBox + localBox % uModelBoxCount. Each template box is
 * moved by its role's integer keyframe offset (forward along the model's front, and up), turned by
 * the entity's heading in whole quarter turns — so every box stays axis-aligned and shows its +x,
 * +y and +z faces — and placed at the entity's feet.
 *
 * Pixel stability: the feet position arrives unsnapped. The shader snaps its projection to whole
 * texels, so a walking figure only ever moves by whole texels and always shows the same texel
 * pattern, and moves the depth by 2·(snappedY − projectedY): a screen-space move of something
 * standing on the ground is a move inside the ground plane (space.ts groundOffsetForTexelOffset), so
 * the feet stay on the paving instead of sinking into it by up to half a texel.
 *
 * Variants: OPAQUE for the figures themselves (no discard), and DITHER for the flat shadow decal
 * drawn under every entity at coverage 0.5, Bayer-anchored to the entity's snapped origin so the
 * pattern walks with the figure instead of crawling under it. The decal ignores the walk keyframes
 * (its template role may be UPPER, which bobs), so it never lifts off the paving.
 *
 * View rotation (Phase 26, `viewTurn`, default on): the entity record stays in WORLD voxels. The vertex stage
 * adds the view's quarter turns to the heading ((h + q) & 3, so a guest walking toward world +x walks toward
 * view +y after one turn), maps the feet to a VIEW point (`vxViewPoint`) and then does exactly what it always
 * did with that point (snap, depth key, projection). The boxes still show their +x, +y and +z faces, which are
 * the view's visible faces, and lambert is the view-0 value in every view. With `viewTurn` false the source is
 * byte-identical to the pre-rotation one.
 *
 * Clip mapping through uClipSize, the G-buffer pass's power-of-two viewport, like the world program.
 *
 * Resource layout, in this order: uEntities, uTemplates, uPalette, frameUniforms, rangeUniforms.
 */

/** Keyframe columns per role: walk frames 0..3, STANDING and the Phase 29 poses. */
export const FIGURE_FRAMES = FIGURE_FRAME_COUNT;

/** Leaving guests and waiting staff: this much of their clothes' colour moves toward grey. */
export const FIGURE_DESATURATE_AMOUNT = 0.45;

/** Coverage of the dithered shadow decal (design §7). */
export const FIGURE_SHADOW_COVERAGE = 0.5;

/**
 * Depth-key bias of the shadow decal. The decal's top (0.25 above the paving) meets the legs'
 * bottom texel row exactly on texel centres, an equal-depth tie; pushing the decal slightly back
 * keeps the feet visible deterministically while it still wins over the paving (a 0.25-voxel rise
 * is 0.75 depth-key units nearer).
 */
export const FIGURE_SHADOW_DEPTH_BIAS = -0.125;

/**
 * FIGURE_KEYFRAMES as a GLSL const array, row-major by role: entry role · FIGURE_FRAMES + frame is
 * ivec2(forward, up). Validated here so a malformed table fails at build time, not as a garbled walk.
 */
export const figureKeyframesGlsl = (
  table: readonly (readonly (readonly [number, number])[])[] = FIGURE_KEYFRAMES,
): string => {
  if (table.length !== ROLE_COUNT) throw new Error(`FIGURE_KEYFRAMES has ${table.length} roles, expected ${ROLE_COUNT}`);
  const entries: string[] = [];
  for (const [role, row] of table.entries()) {
    if (row.length !== FIGURE_FRAMES) throw new Error(`Role ${role} has ${row.length} keyframes, expected ${FIGURE_FRAMES}`);
    for (const offset of row) entries.push(glslIvec2(offset));
  }
  return `const int VX_FIGURE_FRAMES = ${glslInt(FIGURE_FRAMES)};
const int VX_FIGURE_ROLE_COUNT = ${glslInt(ROLE_COUNT)};
const ivec2 VX_FIGURE_KEYFRAMES[${entries.length}] = ivec2[${entries.length}](${entries.join(', ')});`;
};

const header = (variant: GeometryVariant, viewTurn: boolean): string => `#version 300 es
${variant === 'dither' ? '#define VX_DITHER 1' : ''}
${VX_PRECISION}
${VX_COMMON}
${VX_GEOMETRY_COMMON}${viewTurn ? VX_VIEW_FORWARD : ''}
`;

const vertex = (variant: GeometryVariant, viewTurn: boolean): string => `${header(variant, viewTurn)}
${figureKeyframesGlsl()}
const int VX_PALETTE_ROLE_SHIRT = ${glslInt(PALETTE_ROLE_SHIRT)};
const int VX_PALETTE_ROLE_HAIR = ${glslInt(PALETTE_ROLE_HAIR)};
const int VX_PALETTE_ROLE_SKIN = ${glslInt(PALETTE_ROLE_SKIN)};
const int VX_PALETTE_ROLE_FIXED = ${glslInt(PALETTE_ROLE_FIXED)};
const int VX_FIGURE_FLAG_DESATURATE = ${glslInt(FIGURE_FLAG_DESATURATE)};

uniform highp sampler2D uEntities;
uniform highp sampler2D uTemplates;
uniform vec2 uCameraTexel;
uniform vec2 uClipSize;
uniform vec2 uDepthRange;
${viewTurn ? 'uniform vec4 uView;\n' : ''}uniform int uEntityBase;
uniform int uModelFirstBox;
uniform int uModelBoxCount;

flat out int vMaterial;
flat out int vPatternFace;
flat out int vFaceCode;
flat out int vGroup;
flat out int vDesaturate;
flat out float vLambert;
flat out vec3 vPatternNormal;
out vec3 vPatternPosition;
#ifdef VX_DITHER
flat out vec2 vOrigin;
#endif

void main() {
  int localBox = gl_VertexID / ${glslInt(VERTICES_PER_BOX)};
  int axisIndex = (gl_VertexID % ${glslInt(VERTICES_PER_BOX)}) / 4;
  int corner = gl_VertexID & 3;
  int boxCount = max(uModelBoxCount, 1);
  int entityOffset = localBox / boxCount;
  int entity = uEntityBase + entityOffset;
  int templateBox = uModelFirstBox + (localBox - entityOffset * boxCount);

  vec4 place = texelFetch(uEntities, vxTexelOf(entity, VX_FIGURE_TEXELS, VX_FIGURE_TEX_WIDTH, 0), 0);
  vec4 look = texelFetch(uEntities, vxTexelOf(entity, VX_FIGURE_TEXELS, VX_FIGURE_TEX_WIDTH, 1), 0);
  vec4 lower = texelFetch(uTemplates, vxTexelOf(templateBox, VX_FIGURE_TEMPLATE_TEXELS, VX_FIGURE_TEMPLATE_TEX_WIDTH, 0), 0);
  vec4 extent = texelFetch(uTemplates, vxTexelOf(templateBox, VX_FIGURE_TEMPLATE_TEXELS, VX_FIGURE_TEMPLATE_TEX_WIDTH, 1), 0);

${viewTurn ? `  // The view's quarter turns: uView = (c, s, ...) is (1, 0), (0, 1), (-1, 0), (0, -1) for q = 0..3.
  int turn = uView.x > 0.5 ? 0 : (uView.y > 0.5 ? 1 : (uView.x < -0.5 ? 2 : 3));
  int heading = (int(place.w) + turn) & 3;
  vec3 feet = vxViewPoint(place.xyz, uView);
` : `  int heading = int(place.w) & 3;
`}  vec3 boxMin = lower.xyz;
  vec3 boxSize = extent.xyz;
#ifndef VX_DITHER
  // The shadow decal (DITHER) stays flat on the paving whatever its role; the body walks.
  int frame = clamp(int(look.x), 0, VX_FIGURE_FRAMES - 1);
  int role = clamp(int(lower.w), 0, VX_FIGURE_ROLE_COUNT - 1);
  ivec2 keyframe = VX_FIGURE_KEYFRAMES[role * VX_FIGURE_FRAMES + frame];
  boxMin += vec3(float(keyframe.x), 0.0, float(keyframe.y));
#endif

  // Heading h turns model +x onto world +x, +y, −x, −y: (x, y) → (−y, x) per quarter turn.
  vec3 turnedMin = boxMin;
  vec3 turnedSize = boxSize;
  if (heading == 1) {
    turnedMin = vec3(-(boxMin.y + boxSize.y), boxMin.x, boxMin.z);
    turnedSize = boxSize.yxz;
  } else if (heading == 2) {
    turnedMin = vec3(-(boxMin.x + boxSize.x), -(boxMin.y + boxSize.y), boxMin.z);
  } else if (heading == 3) {
    turnedMin = vec3(boxMin.y, -(boxMin.x + boxSize.x), boxMin.z);
    turnedSize = boxSize.yxz;
  }
  vec3 offset = turnedMin + turnedSize * vxFaceCorner(axisIndex, corner, 1.0);

  vec2 projected = vxProject(${viewTurn ? 'feet' : 'place.xyz'});
  vec2 snapped = floor(projected + 0.5);
  float key = vxDepthKey(${viewTurn ? 'feet' : 'place.xyz'}) + vxDepthKey(offset) + 2.0 * (snapped.y - projected.y);
#ifdef VX_DITHER
  key += ${glslFloat(FIGURE_SHADOW_DEPTH_BIAS)};
  vOrigin = snapped;
#endif
  gl_Position = vxClip(snapped + vxProject(offset), uCameraTexel, uClipSize, vxDepthNdc(key, uDepthRange));

  int paletteWord = int(look.z);
  int paletteCode = int(extent.w);
  int paletteRole = paletteCode & 3;
  int material = paletteCode >> 2;
  if (paletteRole == VX_PALETTE_ROLE_SHIRT) material = paletteWord & 255;
  else if (paletteRole == VX_PALETTE_ROLE_HAIR) material = (paletteWord >> 8) & 255;
  else if (paletteRole == VX_PALETTE_ROLE_SKIN) material = (paletteWord >> 16) & 255;
  vMaterial = material;
  vec3 normal = vxAxis(axisIndex);
  vFaceCode = vxFaceOfAxis(axisIndex);
  vPatternFace = vFaceCode;
  vLambert = vxLambert(normal);
  vPatternNormal = normal;
  vPatternPosition = ${viewTurn ? 'feet' : 'place.xyz'} + offset;
#ifdef VX_DITHER
  // Shadows join the ground's group: no id contour ring around every decal.
  vGroup = 0;
#else
  vGroup = 1 + entity % 255;
#endif
  vDesaturate = ((int(look.w) & VX_FIGURE_FLAG_DESATURATE) != 0 && paletteRole != VX_PALETTE_ROLE_SKIN) ? 1 : 0;
}
`;

const fragment = (variant: GeometryVariant, viewTurn: boolean): string => `${header(variant, viewTurn)}
${vxPatternsSource(viewTurn)}
uniform highp sampler2D uPalette;
uniform float uTime;
uniform float uGrid;
#ifdef VX_DITHER
uniform vec2 uCameraTexel;
#endif

flat in int vMaterial;
flat in int vPatternFace;
flat in int vFaceCode;
flat in int vGroup;
flat in int vDesaturate;
flat in float vLambert;
flat in vec3 vPatternNormal;
in vec3 vPatternPosition;
#ifdef VX_DITHER
flat in vec2 vOrigin;
#endif

layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outGData;

void main() {
#ifdef VX_DITHER
  ivec2 anchor = ivec2(gl_FragCoord.xy) + ivec2(uCameraTexel) - ivec2(vOrigin) + ${glslIvec2(DITHER_OFFSET_SHADOW)};
  if (${glslFloat(FIGURE_SHADOW_COVERAGE)} <= vxBayer4(anchor)) discard;
#endif
  // Template boxes carry no pattern: figures are flat-coloured (PATTERN.PLAIN).
  vec3 color = vxSurfaceColor(uPalette, vMaterial, 0, 0, vPatternFace, vPatternPosition, vPatternNormal, ${viewTurn ? 'vec3(0.5, 0.0, 0.0), ' : ''}uTime, uGrid);
  if (vDesaturate != 0) {
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(luma), ${glslFloat(FIGURE_DESATURATE_AMOUNT)});
  }
  vec4 props = vxMaterialProps(uPalette, vMaterial);
  int materialFlags = int(props.x);
#ifdef VX_DITHER
  int faceAndFlags = vFaceCode | VX_GFLAG_SHADOW | VX_GFLAG_NO_OUTLINE;
  float emissive = 0.0;
#else
  int faceAndFlags = vFaceCode | vxGFlagsOfMaterial(materialFlags) | VX_GFLAG_FIGURE;
  float emissive = vxEmissiveOf(materialFlags, props.y);
#endif
  outAlbedo = vec4(color, 1.0);
  outGData = vxPackGData(vGroup, faceAndFlags, emissive, vLambert);
}
`;

export const figureShaderSource = (variant: GeometryVariant, viewTurn = true): ShaderSource => ({
  vertex: vertex(variant, viewTurn),
  fragment: fragment(variant, viewTurn),
});
