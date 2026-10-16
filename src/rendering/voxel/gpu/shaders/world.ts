import { VERTICES_PER_BOX } from '../../contracts/boxes';
import { DITHER_OFFSET_GHOST, DITHER_OFFSET_SEE } from '../../contracts/gbuffer';
import { VX_COMMON, VX_PRECISION, VX_VIEW_FORWARD } from './common';
import { VX_GEOMETRY_COMMON } from './geometryCommon';
import { glslFloat, glslInt, glslIvec2 } from './glsl';
import { SEE_THROUGH } from '../../../seeThrough';
import { vxPatternsSource } from './patterns';

/**
 * The world program: every static chunk, every rigid ride part, the litter list and the ghost
 * preview are drawn by it, straight from a box data texture (contracts/boxes.ts) with no vertex
 * attributes at all. Vertex pulling: box = gl_VertexID / 12, local axis k = (gl_VertexID % 12) / 4,
 * quad corner = gl_VertexID & 3; the index buffer is the shared one from buildBoxIndices.
 *
 * Slot 0 boxes are in world voxels and show their +x, +y and +z faces. A box in slot k > 0 is in its
 * part's local voxels relative to transform k − 1 (pivot + quaternion); for each local axis the
 * visible side is the one whose world normal faces the camera, dot(R·e_k, (1, 1, 1)) ≥ 0, which holds
 * for any rotation — spinning rotors, wheels turning about a horizontal axis, pitched coaster cars.
 *
 * Two variants from one source:
 * - OPAQUE (chunks, litter): no `discard` anywhere, so early-Z and hidden-surface removal stay on for
 *   the draws that carry almost all the geometry (Mali, Adreno and Apple GPUs switch them off for a
 *   whole draw when the program can discard).
 * - DITHER (`#define VX_DITHER`, the ghost preview and its x-ray pass): boxes in model-local voxels
 *   placed at uGhostOrigin, a world-anchored Bayer 4×4 discard at uCoverage, the colour mixed toward
 *   uGhostTint, GFLAG_GHOST so the composite never outlines it or treats it as an occluder, and a
 *   small depth-key bias so a ghost over identical geometry wins deterministically.
 *
 * - CUT (`#define VX_CUT`, only the chunk draws that overlap the see-through hole and only while it is
 *   on): the OPAQUE program plus a per-fragment dithered `discard` of everything that stands in front
 *   of the build site (seeThroughView.ts documents the volume; `seeThroughCoverage` there is the
 *   TypeScript twin of the few lines below). The depth key and height of the fragment come from
 *   gl_FragCoord alone, so rotating ride parts need no varyings. The survivors inside the soft rim are
 *   marked NO_OUTLINE, so the composite does not draw outlines around isolated survivors.
 *   With `uSeeC.z > 0` (the translucent rung) the threshold is 0 instead of the Bayer value: every fragment with
 *   coverage above 0 leaves this buffer, and no survivor remains in the soft rim.
 *
 * - FRONT (`#define VX_FRONT`, the translucent rung's front layer): the CUT program with the discard turned round,
 *   keeping exactly the fragments the cut removes (coverage above 0, with a hair of slack on the cut key). It
 *   is drawn into the front G-buffer through its own frame uniforms (camera moved by the layer's origin), so the
 *   vertex stage and all the colour code are the opaque program's, unchanged.
 *
 * View rotation (Phase 26, `viewTurn`, default on): the data stays in WORLD voxels. The vertex stage maps the
 * world point to a VIEW point (`vxViewPoint`, uniform uView = (c, s, ox, oy)), picks each box's visible side
 * from the VIEW normal (the camera still looks along -(1, 1, 1) in view space), and computes the depth key,
 * the projection, the face code and the lambert from the view point and normal. So the key light stays on the
 * screen's upper left in every view and the pipeline after the vertex stage is unchanged. Patterns stay keyed
 * on world (static) or part-local (rigid) positions, so a texture stays on its wall; the one new varying,
 * vCellShift, is the half-voxel top-face cell shift along VIEW +x expressed in the pattern space. With
 * `viewTurn` false every source is byte-identical to the pre-rotation one (the `no-view-rotation` rung).
 *
 * Clip mapping: uClipSize, the power-of-two size of the G-buffer pass's viewport (VoxelGpu), not
 * uLowSize — with it and the sub-texel snap (geometryCommon.ts) window coordinates are exact.
 *
 * Resource layout (identical for every Shader that shares a variant's program, in this order):
 *   uBoxes, uTransforms, uPalette, frameUniforms[, ghostUniforms | seeThroughUniforms]
 * (the front program's frameUniforms group is the shifted copy VoxelGpu keeps for it)
 */

export type GeometryVariant = 'opaque' | 'dither' | 'cut' | 'front';

export interface ShaderSource {
  vertex: string;
  fragment: string;
}

const header = (variant: GeometryVariant, viewTurn: boolean): string => `#version 300 es
${variant === 'dither' ? '#define VX_DITHER 1' : ''}
${variant === 'cut' || variant === 'front' ? '#define VX_CUT 1' : ''}
${variant === 'front' ? '#define VX_FRONT 1' : ''}
${VX_PRECISION}
${VX_COMMON}
${VX_GEOMETRY_COMMON}${viewTurn ? VX_VIEW_FORWARD : ''}
`;

const vertex = (variant: GeometryVariant, viewTurn: boolean): string => `${header(variant, viewTurn)}
uniform highp sampler2D uBoxes;
uniform highp sampler2D uTransforms;
uniform vec2 uCameraTexel;
uniform vec2 uClipSize;
uniform vec2 uDepthRange;
${viewTurn ? 'uniform vec4 uView;\n' : ''}#ifdef VX_DITHER
uniform vec3 uGhostOrigin;
uniform float uGhostDepthBias;
#endif

flat out int vMaterial;
flat out int vPattern;
flat out int vQuarterTurn;
flat out int vPatternFace;
flat out int vFaceCode;
flat out int vGroup;
flat out float vLambert;
flat out vec3 vPatternNormal;
out vec3 vPatternPosition;
${viewTurn ? 'flat out vec3 vCellShift;\n' : ''}
void main() {
  int box = gl_VertexID / ${glslInt(VERTICES_PER_BOX)};
  int axisIndex = (gl_VertexID % ${glslInt(VERTICES_PER_BOX)}) / 4;
  int corner = gl_VertexID & 3;
  // Chunk textures are BOX_TEX_WIDTH wide, litter and ghost DYNAMIC_BOX_TEX_WIDTH: ask the texture.
  int width = textureSize(uBoxes, 0).x;
  vec4 lower = texelFetch(uBoxes, vxTexelOf(box, VX_BOX_TEXELS, width, 0), 0);
  vec4 extent = texelFetch(uBoxes, vxTexelOf(box, VX_BOX_TEXELS, width, 1), 0);
  int word = int(lower.w);
  int slot = int(extent.w);

  vec3 pivot = vec3(0.0);
  vec4 rotation = vec4(0.0, 0.0, 0.0, 1.0);
  if (slot > 0) {
    pivot = texelFetch(uTransforms, vxTexelOf(slot - 1, VX_TRANSFORM_TEXELS, VX_TRANSFORM_TEX_WIDTH, 0), 0).xyz;
    rotation = texelFetch(uTransforms, vxTexelOf(slot - 1, VX_TRANSFORM_TEXELS, VX_TRANSFORM_TEX_WIDTH, 1), 0);
  }
${viewTurn ? `  // The identity quaternion rotates exactly (every cross product is zero), so static boxes keep
  // their integer corners bit for bit. The visible side is chosen in VIEW space.
  vec3 axisWorld = vxQuatRotate(rotation, vxAxis(axisIndex));
  vec3 axisNormal = vxViewVector(axisWorld, uView);
  float side = dot(axisNormal, vec3(1.0)) >= 0.0 ? 1.0 : -1.0;
  vec3 local = lower.xyz + extent.xyz * vxFaceCorner(axisIndex, corner, side > 0.0 ? 1.0 : 0.0);
  vec3 world = pivot + vxQuatRotate(rotation, local);
#ifdef VX_DITHER
  world += uGhostOrigin;
#endif
  vec3 view = vxViewPoint(world, uView);
  vec3 normal = axisNormal * side;
  float key = vxDepthKey(view);
#ifdef VX_DITHER
  key += uGhostDepthBias;
#endif
  gl_Position = vxClip(vxSnapSubtexel(vxProject(view)), uCameraTexel, uClipSize, vxDepthNdc(key, uDepthRange));

` : `  // The identity quaternion rotates exactly (every cross product is zero), so static boxes keep
  // their integer corners bit for bit.
  vec3 axisNormal = vxQuatRotate(rotation, vxAxis(axisIndex));
  float side = dot(axisNormal, vec3(1.0)) >= 0.0 ? 1.0 : -1.0;
  vec3 local = lower.xyz + extent.xyz * vxFaceCorner(axisIndex, corner, side > 0.0 ? 1.0 : 0.0);
  vec3 world = pivot + vxQuatRotate(rotation, local);
#ifdef VX_DITHER
  world += uGhostOrigin;
#endif
  vec3 normal = axisNormal * side;
  float key = vxDepthKey(world);
#ifdef VX_DITHER
  key += uGhostDepthBias;
#endif
  gl_Position = vxClip(vxSnapSubtexel(vxProject(world)), uCameraTexel, uClipSize, vxDepthNdc(key, uDepthRange));

`}  vMaterial = word & 255;
  vGroup = (word >> 8) & 255;
  vPattern = (word >> 16) & 31;
  vQuarterTurn = (word >> 21) & 3;
  vPatternFace = vxFaceOfAxis(axisIndex);
  vFaceCode = vxFaceOfNormal(normal);
  vLambert = vxLambert(normal);
  // Static boxes pattern in world voxels; rigid parts in their own voxels, so patterns ride along.
  bool rigid = slot > 0;
${viewTurn ? `  // Patterns stay in world / part-local space; the normal is the face's WORLD normal (static) or local one (rigid).
  vPatternNormal = rigid ? vxAxis(axisIndex) * side : axisWorld * side;
  vPatternPosition = rigid ? local : world;
  // Top faces shift half a voxel along VIEW +x (see patterns.ts); a rigid part expresses that in its own voxels,
  // as a correction on top of today's (0.5, 0, 0), so view 0 keeps exactly the old value.
  vec3 cellShift = vec3(0.5 * uView.x, -0.5 * uView.y, 0.0);
  vCellShift = rigid ? vec3(0.5, 0.0, 0.0) + vxQuatRotate(vec4(-rotation.xyz, rotation.w), cellShift - vec3(0.5, 0.0, 0.0)) : cellShift;
` : `  vPatternNormal = rigid ? vxAxis(axisIndex) * side : normal;
  vPatternPosition = rigid ? local : world;
`}}
`;

const fragment = (variant: GeometryVariant, viewTurn: boolean): string => `${header(variant, viewTurn)}
${vxPatternsSource(viewTurn)}
uniform highp sampler2D uPalette;
uniform float uTime;
uniform float uGrid;
#ifdef VX_DITHER
uniform vec2 uCameraTexel;
uniform float uCoverage;
uniform vec3 uGhostTint;
uniform float uGhostMix;
#endif
#ifdef VX_CUT
uniform vec2 uCameraTexel;
uniform vec2 uDepthRange;
uniform vec4 uSeeA;
uniform vec4 uSeeB;
uniform vec4 uSeeC;
#ifdef VX_FRONT
const float VX_SEE_KEY_SLACK = ${glslFloat(SEE_THROUGH.KEY_SLACK)};
#else
const float VX_SEE_KEY_SLACK = 0.0;
#endif
#endif

flat in int vMaterial;
flat in int vPattern;
flat in int vQuarterTurn;
flat in int vPatternFace;
flat in int vFaceCode;
flat in int vGroup;
flat in float vLambert;
flat in vec3 vPatternNormal;
in vec3 vPatternPosition;
${viewTurn ? 'flat in vec3 vCellShift;\n' : ''}
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outGData;

void main() {
#ifdef VX_DITHER
  // World-anchored: the ghost's screen door stays put on the ground while the camera pans.
  ivec2 anchor = ivec2(gl_FragCoord.xy) + ivec2(uCameraTexel) + ${glslIvec2(DITHER_OFFSET_GHOST)};
  if (uCoverage <= vxBayer4(anchor)) discard;
#endif
#ifdef VX_CUT
  // uSeeA: hole rectangle centre and half size (world texels); uSeeB: cut key, floor z, margin, strength.
  vec2 seeTexel = gl_FragCoord.xy + uCameraTexel;
  float seeDistance = length(max(abs(seeTexel - uSeeA.xy) - uSeeA.zw, vec2(0.0)));
  float seeKey = vxDepthKeyFromTexture(gl_FragCoord.z, uDepthRange);
  float seeZ = (seeKey - 2.0 * seeTexel.y) / 3.0;
  float seeCut = (seeZ >= uSeeB.y && seeKey >= uSeeB.x - VX_SEE_KEY_SLACK)
    ? uSeeB.w * (1.0 - smoothstep(0.4 * uSeeB.z, uSeeB.z, seeDistance))
    : 0.0;
#ifdef VX_FRONT
  // The front layer keeps exactly what the translucent main pass discards (seeCut > 0), plus a hair
  // of slack on the key so a rasteriser rounding never leaves a fragment in neither layer.
  if (!(seeCut > 0.0)) discard;
#else
  // uSeeC.z > 0: the translucent rung, every occluder fragment leaves this buffer (the front layer holds
  // it); 0: the dither rung, the world-anchored screen door.
  float seeThreshold = uSeeC.z > 0.0 ? 0.0 : vxBayer4(ivec2(gl_FragCoord.xy) + ivec2(uCameraTexel) + ${glslIvec2(DITHER_OFFSET_SEE)});
  if (seeCut > seeThreshold) discard;
#endif
#endif
  vec3 color = vxSurfaceColor(uPalette, vMaterial, vPattern, vQuarterTurn, vPatternFace,
                              vPatternPosition, vPatternNormal, ${viewTurn ? 'vCellShift, ' : ''}uTime, uGrid);
  vec4 props = vxMaterialProps(uPalette, vMaterial);
  int materialFlags = int(props.x);
  int faceAndFlags = vFaceCode | vxGFlagsOfMaterial(materialFlags);
  float emissive = vxEmissiveOf(materialFlags, props.y);
#ifdef VX_DITHER
  color = mix(color, uGhostTint, uGhostMix);
  faceAndFlags |= VX_GFLAG_GHOST;
  emissive = 0.0;
#endif
#ifdef VX_CUT
  // Survivors of the soft rim must not outline themselves against the revealed geometry behind.
  if (seeCut > 0.0) faceAndFlags |= VX_GFLAG_NO_OUTLINE;
#endif
  outAlbedo = vec4(color, 1.0);
  outGData = vxPackGData(vGroup, faceAndFlags, emissive, vLambert);
}
`;

/** `viewTurn` false builds the pre-rotation source, byte for byte (the `no-view-rotation` rung). */
export const worldShaderSource = (variant: GeometryVariant, viewTurn = true): ShaderSource => ({
  vertex: vertex(variant, viewTurn),
  fragment: fragment(variant, viewTurn),
});
