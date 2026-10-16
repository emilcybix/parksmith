import { VX_COMMON, VX_PRECISION, VX_VIEW_FORWARD } from './common';
import { glslFloat } from './glsl';
import type { ShaderSource } from './world';

/**
 * The point-light pass (dusk and night presets only): one screen-space quad per light, pulled from
 * the lights texture (contracts/frame.ts), additively blended into a low-res light target the size
 * of the G-buffer. Every covered texel reconstructs its voxel position from depth (the texel centre
 * is exactly the point the G-buffer rasterised) and gets the light's colour × a smooth radial
 * falloff × a wrapped facing term from its face. Quantisation into the pixel-art bands happens once
 * in the composite, where the Bayer anchor is known.
 *
 * Draw: the shared box index buffer with size = lights · 6 — its first six indices of every group
 * address vertices 4i..4i+3, so light = gl_VertexID / 4 and corner = gl_VertexID & 3. A light whose
 * preset mask excludes the active preset collapses to a point outside the clip volume.
 *
 * Resource layout: uLights, uDepth, uGData, frameUniforms, lightUniforms.
 */

/** sx = x − y changes by √2 per voxel of distance at most, sy = (x + y)/2 − z by √1.5. */
const SCREEN_EXTENT_X = Math.SQRT2;
const SCREEN_EXTENT_Y = Math.sqrt(1.5);

const vertex = (viewTurn: boolean): string => `#version 300 es
${VX_PRECISION}
${VX_COMMON}${viewTurn ? VX_VIEW_FORWARD : ''}
uniform highp sampler2D uLights;
uniform vec2 uCameraTexel;
uniform vec2 uLowSize;
${viewTurn ? 'uniform vec4 uView;\n' : ''}uniform float uPresetBit;

flat out vec4 vLight;
flat out vec3 vColor;

void main() {
  int light = gl_VertexID / 4;
  int corner = gl_VertexID & 3;
  vec4 place = texelFetch(uLights, vxTexelOf(light, VX_LIGHT_TEXELS, VX_LIGHT_TEX_WIDTH, 0), 0);
  vec4 color = texelFetch(uLights, vxTexelOf(light, VX_LIGHT_TEXELS, VX_LIGHT_TEX_WIDTH, 1), 0);
${viewTurn ? `  // The light pass runs in VIEW space (the G-buffer's space): the lamp's world position is mapped first.
  place.xyz = vxViewPoint(place.xyz, uView);
` : ''}  bool on = (int(color.w) & int(uPresetBit)) != 0 && place.w > 0.0;
  vec2 extent = vec2(place.w * ${glslFloat(SCREEN_EXTENT_X)} + 1.0, place.w * ${glslFloat(SCREEN_EXTENT_Y)} + 1.0);
  vec2 texel = vxProject(place.xyz) + extent * (vec2(float(corner & 1), float(corner >> 1)) * 2.0 - 1.0);
  gl_Position = on ? vxClip(texel, uCameraTexel, uLowSize, 0.0) : vec4(2.0, 2.0, 2.0, 1.0);
  vLight = place;
  vColor = color.rgb;
}
`;

const fragment = (): string => `#version 300 es
${VX_PRECISION}
${VX_COMMON}
uniform highp sampler2D uDepth;
uniform highp sampler2D uGData;
uniform vec2 uCameraTexel;
uniform vec2 uDepthRange;

flat in vec4 vLight;
flat in vec3 vColor;

out vec4 outLight;

vec3 vxFaceNormal(int face) {
  if (face == VX_FACE_X) return vec3(1.0, 0.0, 0.0);
  if (face == VX_FACE_Y) return vec3(0.0, 1.0, 0.0);
  return vec3(0.0, 0.0, 1.0);
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  float depth = texelFetch(uDepth, texel, 0).r;
  vec4 gdata = texelFetch(uGData, texel, 0);
  if (depth >= 1.0 || vxHasFlag(gdata, VX_GFLAG_GHOST)) {
    outLight = vec4(0.0);
    return;
  }
  vec3 position = vxFromTexelAndDepth(uCameraTexel + vec2(texel) + 0.5, vxDepthKeyFromTexture(depth, uDepthRange));
  vec3 toLight = vLight.xyz - position;
  float lightDistance = length(toLight);
  float falloff = clamp(1.0 - lightDistance / vLight.w, 0.0, 1.0);
  float facing = 0.5 + 0.5 * max(0.0, dot(vxFaceNormal(vxFaceOf(gdata)), toLight / max(lightDistance, 1e-3)));
  outLight = vec4(vColor * (falloff * falloff * facing), 1.0);
}
`;

/** `viewTurn` false builds the pre-rotation source, byte for byte. */
export const lightPassShaderSource = (viewTurn = true): ShaderSource => ({ vertex: vertex(viewTurn), fragment: fragment() });
