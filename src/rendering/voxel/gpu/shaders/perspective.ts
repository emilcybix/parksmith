import { VERTICES_PER_BOX } from '../../contracts/boxes';
import { VX_COMMON, VX_PRECISION } from './common';
import { VX_GEOMETRY_COMMON } from './geometryCommon';
import { glslInt } from './glsl';
import { worldShaderSource, type ShaderSource } from './world';
import { compositeShaderSource } from './composite';
import { figureShaderSource } from './figure';

/**
 * Phase 41 step 0 (spike, `&camera3d=1`): the static boxes through a perspective camera instead of the isometric
 * projection. The box data, the index buffer (three faces per box), the world fragment shader and the G-buffer are the
 * ones the isometric view uses; only the vertex stage differs: each axis shows the face that looks toward the eye (an
 * axis-aligned box always shows exactly one face per axis to any eye outside it), and `uViewProj` maps world voxels
 * (z up) to clip space. The composite then lights the G-buffer as it would the isometric picture; what that gets wrong
 * (its depth and position reconstruction assume the isometric key) is part of what the spike records.
 */
const vertex = `#version 300 es
${VX_PRECISION}
${VX_COMMON}
${VX_GEOMETRY_COMMON}
uniform highp sampler2D uBoxes;
uniform highp sampler2D uTransforms;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uZScale;

flat out int vMaterial;
flat out int vPattern;
flat out int vQuarterTurn;
flat out int vPatternFace;
flat out int vFaceCode;
flat out int vGroup;
flat out float vLambert;
flat out vec3 vPatternNormal;
out vec3 vPatternPosition;

void main() {
  int box = gl_VertexID / ${glslInt(VERTICES_PER_BOX)};
  int axisIndex = (gl_VertexID % ${glslInt(VERTICES_PER_BOX)}) / 4;
  int corner = gl_VertexID & 3;
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
  vec3 axisWorld = vxQuatRotate(rotation, vxAxis(axisIndex));
  vec3 centre = pivot + vxQuatRotate(rotation, lower.xyz + extent.xyz * 0.5);
  float side = dot(axisWorld, uEye - vec3(centre.xy, centre.z * uZScale)) >= 0.0 ? 1.0 : -1.0;
  vec3 local = lower.xyz + extent.xyz * vxFaceCorner(axisIndex, corner, side > 0.0 ? 1.0 : 0.0);
  vec3 world = pivot + vxQuatRotate(rotation, local);
  vec3 normal = axisWorld * side;
  gl_Position = uViewProj * vec4(world.xy, world.z * uZScale, 1.0);
  // The G-buffer is a render texture whose row 0 is the top (vxClip flips the isometric path the same way), and the
  // isometric projection is the mirror image of a physical camera (+x runs right AND toward the viewer): x is flipped
  // too, so the cinematic picture has the game's handedness (signs read the right way, a turn lands on the isometric).
  gl_Position.y = -gl_Position.y;
  gl_Position.x = -gl_Position.x;
  vMaterial = word & 255;
  vGroup = (word >> 8) & 255;
  vPattern = (word >> 16) & 31;
  vQuarterTurn = (word >> 21) & 3;
  vPatternFace = vxFaceOfAxis(axisIndex);
  vFaceCode = vxFaceOfNormal(normal);
  // Phase 41: the isometric light comes from the viewer's side, so a face turned away (-x, -y) would be black; the
  // cinematic camera lights both sides of an axis alike.
  vLambert = vxLambert(vec3(abs(normal.x), abs(normal.y), normal.z));
  bool rigid = slot > 0;
  vPatternNormal = rigid ? vxAxis(axisIndex) * side : normal;
  vPatternPosition = rigid ? local : world;
}
`;

/** The spike's program: the vertex stage above with the isometric opaque fragment shader (no view rotation). */
export const perspectiveWorldShaderSource = (): ShaderSource => ({ vertex, fragment: worldShaderSource('opaque', false).fragment });

/** Phase 41: the cinematic camera's composite: the lite look, sky and fog (composite.ts CompositeOptions.perspective). */
export const perspectiveCompositeShaderSource = (): ShaderSource => compositeShaderSource('lite', 'rain', { perspective: true });

/**
 * Phase 41: the guests and staff through the cinematic camera: the isometric figure program (no view rotation) with
 * its face choice and projection replaced, as for the static boxes. The figure fragment shader is unchanged.
 */
export const perspectiveFigureShaderSource = (): ShaderSource => {
  const base = figureShaderSource('opaque', false);
  const replace = (source: string, from: string, to: string): string => {
    if (!source.includes(from)) throw new Error(`perspectiveFigureShaderSource: the figure program changed (${from.slice(0, 40)})`);
    return source.replace(from, to);
  };
  let vertex = replace(base.vertex, 'uniform int uModelBoxCount;', 'uniform int uModelBoxCount;\nuniform mat4 uViewProj;\nuniform vec3 uEye;\nuniform float uZScale;');
  vertex = replace(vertex, '  vec3 offset = turnedMin + turnedSize * vxFaceCorner(axisIndex, corner, 1.0);',
    `  vec3 centre = place.xyz + turnedMin + turnedSize * 0.5;
  float side = dot(vxAxis(axisIndex), uEye - vec3(centre.xy, centre.z * uZScale)) >= 0.0 ? 1.0 : -1.0;
  vec3 offset = turnedMin + turnedSize * vxFaceCorner(axisIndex, corner, side > 0.0 ? 1.0 : 0.0);`);
  vertex = replace(vertex, '  gl_Position = vxClip(snapped + vxProject(offset), uCameraTexel, uClipSize, vxDepthNdc(key, uDepthRange));',
    `  vec3 placed = place.xyz + offset;
  gl_Position = uViewProj * vec4(placed.xy, placed.z * uZScale, 1.0);
  gl_Position.y = -gl_Position.y;
  gl_Position.x = -gl_Position.x;`);
  vertex = replace(vertex, '  vec3 normal = vxAxis(axisIndex);', '  vec3 normal = vxAxis(axisIndex) * side;');
  vertex = replace(vertex, '  vLambert = vxLambert(normal);', '  vLambert = vxLambert(vec3(abs(normal.x), abs(normal.y), normal.z));');
  return { vertex, fragment: base.fragment };
};

/**
 * The point lights through the cinematic camera (a view turn at dusk or night; owner report 2026-10-19: every lamp went
 * out while the map turned). The isometric light pass (lightPass.ts) reads isometric positions, so this one projects
 * each light's bounding cube with `uViewProj` to a screen quad and reconstructs every covered texel's world voxel from
 * the perspective depth through `uInvViewProj`. Falloff and facing are the isometric pass's; a face the isometric view
 * never shows (-x, -y: FACE_OTHER in the G-buffer) takes the average facing. Same resources as the isometric pass plus
 * `perspectiveUniforms` (which carries the inverse).
 */
const lightVertex = `#version 300 es
${VX_PRECISION}
${VX_COMMON}
uniform highp sampler2D uLights;
uniform mat4 uViewProj;
uniform float uZScale;
uniform float uPresetBit;

flat out vec4 vLight;
flat out vec3 vColor;

vec2 vxScreenOf(vec3 p) {
  vec4 clip = uViewProj * vec4(p.xy, p.z * uZScale, 1.0);
  // The geometry flips both axes after the projection (perspective world program).
  return -clip.xy / max(clip.w, 1e-3);
}

void main() {
  int light = gl_VertexID / 4;
  int corner = gl_VertexID & 3;
  vec4 place = texelFetch(uLights, vxTexelOf(light, VX_LIGHT_TEXELS, VX_LIGHT_TEX_WIDTH, 0), 0);
  vec4 color = texelFetch(uLights, vxTexelOf(light, VX_LIGHT_TEXELS, VX_LIGHT_TEX_WIDTH, 1), 0);
  bool on = (int(color.w) & int(uPresetBit)) != 0 && place.w > 0.0;
  vec2 lo = vec2(1e9);
  vec2 hi = vec2(-1e9);
  for (int i = 0; i < 8; i += 1) {
    vec3 offset = vec3(float(i & 1), float((i >> 1) & 1), float(i >> 2)) * 2.0 - 1.0;
    vec2 screen = vxScreenOf(place.xyz + offset * place.w);
    lo = min(lo, screen);
    hi = max(hi, screen);
  }
  vec2 ndc = mix(lo, hi, vec2(float(corner & 1), float(corner >> 1)));
  gl_Position = on ? vec4(ndc, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  vLight = place;
  vColor = color.rgb;
}
`;

const lightFragment = `#version 300 es
${VX_PRECISION}
${VX_COMMON}
uniform highp sampler2D uDepth;
uniform highp sampler2D uGData;
uniform vec2 uLowSize;
uniform mat4 uInvViewProj;
uniform float uZScale;

flat in vec4 vLight;
flat in vec3 vColor;

out vec4 outLight;

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  float depth = texelFetch(uDepth, texel, 0).r;
  vec4 gdata = texelFetch(uGData, texel, 0);
  if (depth >= 1.0) {
    outLight = vec4(0.0);
    return;
  }
  vec2 ndc = gl_FragCoord.xy / uLowSize * 2.0 - 1.0;
  vec4 world = uInvViewProj * vec4(-ndc, depth * 2.0 - 1.0, 1.0);
  vec3 position = world.xyz / world.w;
  position.z /= uZScale;
  vec3 toLight = vLight.xyz - position;
  float lightDistance = length(toLight);
  float falloff = clamp(1.0 - lightDistance / vLight.w, 0.0, 1.0);
  int face = vxFaceOf(gdata);
  vec3 normal = face == VX_FACE_X ? vec3(1.0, 0.0, 0.0) : face == VX_FACE_Y ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  float facing = face == VX_FACE_OTHER ? 0.75 : 0.5 + 0.5 * max(0.0, dot(normal, toLight / max(lightDistance, 1e-3)));
  outLight = vec4(vColor * (falloff * falloff * facing), 1.0);
}
`;

/** Phase 41: the cinematic camera's light pass (see lightVertex). */
export const perspectiveLightShaderSource = (): ShaderSource => ({ vertex: lightVertex, fragment: lightFragment });
