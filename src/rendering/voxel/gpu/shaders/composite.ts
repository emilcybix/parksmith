import {
  CONTOUR_NOT_NEARER,
  DITHER_OFFSET_LIGHT,
  DITHER_OFFSET_OVERLAY,
  DITHER_OFFSET_SHADOW,
  SILHOUETTE_MIN_RESIDUAL,
  SILHOUETTE_RAW_OTHER,
} from '../../contracts/gbuffer';
import { MAT_COLOR } from '../../contracts/palette';
import { SEE_THROUGH } from '../../../seeThrough';
import { PLANE_GRADIENT_TOP, PLANE_GRADIENT_X, PLANE_GRADIENT_Y } from '../../contracts/space';
import { VX_COMMON, VX_PRECISION } from './common';
import { VX_COMPOSITE_LOOK, VX_COMPOSITE_LOOK_LITE, VX_LIGHT_POOL } from './compositeLook';
import { weatherChunks, type WeatherTier } from './compositeWeather';
import { glslFloat, glslIvec2, glslRgb, glslVec2 } from './glsl';
import type { ShaderSource } from './world';

/**
 * The composite pass: one fullscreen triangle over the low-res target, turning the G-buffer into
 * the finished picture. This file is the plumbing — which texels are fetched, how edges and the
 * guard band behave, the overlay — and it calls `vxLook` (compositeLook.ts) for everything visual.
 *
 * Plumbing rules (design §6):
 * - Depth 1.0 is background, and so is every tap outside the target; taps are clamped into it, so a
 *   texel never reads undefined memory. The guard band (GUARD_BAND_TEXELS) keeps the taps of every
 *   texel the upscale shows inside the target.
 * - Background early-out: a background texel fetches only its four neighbours' depth (and gdata
 *   where they are geometry). It calls vxLook only when a neighbour is an occluder — the far-texel
 *   silhouette grows one texel out into the background — and is otherwise the preset's background:
 *   transparent (alpha 0, so the page's gradient shows) unless the preset sets a colour.
 * - The light target is read only when the preset runs the light pass, the overlay only when the
 *   renderer says it is not empty (uniform switches, not recompiles).
 * - Overlay dither: shown where overlay.a > bayer(world texel + DITHER_OFFSET_OVERLAY), un-premultiplied.
 * - gpuMin (`uTaps` = 0): no neighbour taps at all, for the harness's GPU-minimal mode.
 *
 * Written for the HLSL compiler (fxc) behind ANGLE on Windows, which failed on the first version
 * of this shader ("Error compiling dynamic pixel executable") while every other GPU accepted it.
 * fxc inlines every function, unrolls every loop and copies aggregates, so this shader has:
 * no struct at all (a struct holding arrays, passed by value and indexed by a loop variable, made
 * every call copy and unroll the whole neighbourhood), no loops, no array it indexes dynamically
 * apart from the Bayer table, and a single call site for the look. The four neighbours are four
 * explicit, unrolled evaluations of one small function with a constant offset each. The static
 * guard in gpu/compositeFxc.test.ts keeps it that way; `compositeShaderSource('lite')` is the
 * fallback VoxelRenderer builds when even this one is refused (no taps, no outlines, no pools).
 *
 * Contract for compositeLook.ts (keep these names):
 *   vec3 vxLook(...) returning sRGB 0..1 (clamped after) — its parameters are listed there, plain
 *   scalars and vectors only; helpers vxTapInside/vxTapDepth/vxTapGData/vxTapAlbedo/vxDepthKeyAt/
 *   vxPositionAt/vxIsOccluder/vxPlaneGradient; every LightPreset field as a uniform (uAmbient,
 *   uKey, uExposure, uSaturation, uTint, uBackground, uEmissiveScale, uGlassGlow, uLightStrength,
 *   uOutlineTint, uOutlineInkMix, uContourFactor, uShadowStrength, uShadowTint); VX_* constants.
 *   vxLook is called for every geometry texel and for background texels next to an occluder
 *   (background = true, albedo/gdata zero). Fetch budget: see COMPOSITE_FETCHES.
 *
 * Translucent see-through (VX_TRANSLUCENT, full variant only): the occluding buildings are drawn into a
 * small front G-buffer (VoxelGpu) and lit by a second run of THIS shader in `front` mode (VX_FRONT:
 * the same look on the front textures with the front layer's own light pools (a second light pass over the
 * front G-buffer), no rain, shimmer or overlay, and a transparent background; the main depth, bound as
 * `uFront`, switches a texel off where something nearer than the layer stands in front of it); the main run then mixes that lit layer over its own result inside the hole's rectangle
 * (uSeeC = origin x, origin y, width, height in target texels; width 0 = no front layer this frame)
 * with weight k = 1 - coverage * (1 - OCCLUDER_OPACITY): one extra fetch (`uFront`), taken only there.
 *
 * Resource layout, in this order: uAlbedo, uGData, uDepth, uLight, uOverlay, uFront, frameUniforms,
 * compositeUniforms, seeThroughUniforms — the same for every variant (the lite one leaves uLight and
 * uFront unread, the non-translucent builds leave uFront and the see-through uniforms unread) In the main run uFront is
 * the lit front layer; in the front run it is the MAIN depth and uLight is the front layer's own light target.
 */

/** `full` is the picture; `lite` is the degraded fallback for a GPU compiler that refuses `full`. */
export type CompositeVariant = 'full' | 'lite';

/**
 * Texel fetches per low-res texel in the worst case (a geometry texel with four geometry neighbours,
 * a silhouette, the light pass and a non-empty overlay), pinned against COMPOSITE_FETCH_BUDGET
 * (budgets.ts) by gpu/shaders.test.ts. The look may spend what is left, e.g. contact-shadow taps
 * (reuse the up neighbour for the 1-texel tap).
 */
export const COMPOSITE_FETCHES = {
  ownDepth: 1,
  neighbourDepth: 4,
  neighbourGData: 4,
  ownAlbedo: 1,
  ownGData: 1,
  light: 1,
  overlay: 1,
  /**
   * The look's own fetches: the nearest silhouette neighbour's albedo (1) in the silhouette branch, or
   * the contact shadow's 4- and 6-texel taps (2; the 1-texel tap reuses the up neighbour's depth) in the
   * other. The two branches are an if / else, so a texel pays the larger one (shaders.test.ts pins both
   * counts and that they sit on opposite sides of the branch).
   */
  lookBranch: 2,
  /** The translucent see-through layer, only inside the hole's rectangle (VX_TRANSLUCENT). */
  frontLayer: 1,
} as const;

/** The fetches of the look's two exclusive branches, each counted from its call sites. */
export const COMPOSITE_LOOK_BRANCH_FETCHES = { silhouette: 1, shadow: 2 } as const;

/** The lite variant reads only the texel itself (and the overlay). */
export const COMPOSITE_FETCHES_LITE = {
  ownDepth: 1,
  ownAlbedo: 1,
  ownGData: 1,
  overlay: 1,
} as const;

export const compositeFetchCount = (variant: CompositeVariant = 'full', translucent = true): number =>
  Object.entries(variant === 'full' ? COMPOSITE_FETCHES : COMPOSITE_FETCHES_LITE)
    .reduce((sum, [name, fetches]) => sum + (name === 'frontLayer' && !translucent ? 0 : fetches), 0);

const vertex = `#version 300 es
${VX_PRECISION}
void main() {
  // One triangle covering the target: (−1, −1), (3, −1), (−1, 3).
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Which composite a source is: the see-through build of the main run, and the `front` run that lights the front layer. */
export interface CompositeOptions {
  /** Compile the translucent see-through mix (VX_TRANSLUCENT; the full variant only). */
  translucent?: boolean;
  /** The front-layer run (VX_FRONT): the full look on the front G-buffer, transparent where nothing is. */
  front?: boolean;
  /**
   * Phase 26 view rotation (default on): the full tier's ground hook maps the texel's view point back to the
   * world for the cloud shadows and puddles (compositeWeather.ts, uniform uView). Only the `full` weather tier
   * of the `full` variant contains any view code; with this false every source is the pre-rotation one.
   */
  viewTurn?: boolean;
  /**
   * Phase 41: the cinematic camera's composite (with the `lite` variant): the lite face light (the G-buffer's depth is
   * a perspective depth, which the full look's outline, shadow and weather taps cannot read), a sky gradient by time
   * of day above the horizon, and distance fog from the linear depth (uniforms `uSkyZenith`, `uSkyHorizon`,
   * `uHorizonY`, `uNearFar`, `uFog`).
   */
  perspective?: boolean;
}

/** Everything both variants share: uniforms, constants, the tap helpers and the overlay. */
const prelude = (options: CompositeOptions & { viewWorld: boolean }): string => `#version 300 es
${options.translucent ? '#define VX_TRANSLUCENT 1' : ''}
${options.front ? '#define VX_FRONT 1' : ''}
${VX_PRECISION}
${VX_COMMON}
uniform highp sampler2D uAlbedo;
uniform highp sampler2D uGData;
uniform highp sampler2D uDepth;
uniform highp sampler2D uLight;
uniform highp sampler2D uOverlay;
uniform highp sampler2D uFront;
uniform vec2 uCameraTexel;
uniform vec2 uLowSize;
uniform vec2 uDepthRange;
uniform float uTime;
uniform float uGrid;
uniform float uTaps;
uniform float uLightEnabled;
uniform float uOverlayEnabled;
uniform vec3 uAmbient;
uniform vec3 uKey;
uniform float uExposure;
uniform float uSaturation;
uniform vec3 uTint;
uniform vec4 uBackground;
uniform float uEmissiveScale;
uniform float uGlassGlow;
uniform float uLightStrength;
uniform vec3 uOutlineTint;
uniform float uOutlineInkMix;
uniform float uContourFactor;
uniform float uShadowStrength;
uniform vec3 uShadowTint;
uniform vec4 uWxA;
uniform vec4 uWxB;
uniform vec4 uWxC;
uniform vec4 uWxD;
${options.viewWorld ? 'uniform vec4 uView;\n' : ''}uniform vec3 uWxCloudTint;
uniform vec3 uWxRainTint;
uniform vec4 uSeeA;
uniform vec4 uSeeB;
uniform vec4 uSeeC;

out vec4 outColor;

const float VX_SILHOUETTE_MIN_RESIDUAL = ${glslFloat(SILHOUETTE_MIN_RESIDUAL)};
const float VX_SILHOUETTE_RAW_OTHER = ${glslFloat(SILHOUETTE_RAW_OTHER)};
const float VX_CONTOUR_NOT_NEARER = ${glslFloat(CONTOUR_NOT_NEARER)};
const vec2 VX_PLANE_GRADIENT_TOP = ${glslVec2(PLANE_GRADIENT_TOP)};
const vec2 VX_PLANE_GRADIENT_X = ${glslVec2(PLANE_GRADIENT_X)};
const vec2 VX_PLANE_GRADIENT_Y = ${glslVec2(PLANE_GRADIENT_Y)};
const vec3 VX_INK = ${glslRgb(MAT_COLOR.INK)};
const ivec2 VX_DITHER_OFFSET_LIGHT = ${glslIvec2(DITHER_OFFSET_LIGHT)};
const ivec2 VX_DITHER_OFFSET_OVERLAY = ${glslIvec2(DITHER_OFFSET_OVERLAY)};
const ivec2 VX_DITHER_OFFSET_SHADOW = ${glslIvec2(DITHER_OFFSET_SHADOW)};
/** Opacity of a faded occluder at full see-through strength (rendering/seeThrough.ts, shared with the classic renderer). */
const float VX_SEE_OPACITY = ${glslFloat(SEE_THROUGH.OCCLUDER_OPACITY)};
/** Depth keys the main G-buffer must be nearer than the front layer to hide it (the front run only). */
const float VX_SEE_NEARER_SLACK = ${glslFloat(SEE_THROUGH.FRONT_NEARER_SLACK)};
/** Texels that never occlude: ghosts, shadow decals and anything flagged no-outline. */
const int VX_NOT_AN_OCCLUDER = VX_GFLAG_GHOST | VX_GFLAG_SHADOW | VX_GFLAG_NO_OUTLINE;

/**
 * The 4-neighbours, in this order: right, left, down (+y, nearer on the ground), up. Four named
 * scalar constants instead of an offset array: nothing is ever indexed by the neighbour number.
 */
const ivec2 VX_STEP_RIGHT = ivec2(1, 0);
const ivec2 VX_STEP_LEFT = ivec2(-1, 0);
const ivec2 VX_STEP_DOWN = ivec2(0, 1);
const ivec2 VX_STEP_UP = ivec2(0, -1);

bool vxTapInside(ivec2 p) {
  return all(greaterThanEqual(p, ivec2(0))) && all(lessThan(p, ivec2(uLowSize)));
}

ivec2 vxTapClamp(ivec2 p) {
  return clamp(p, ivec2(0), ivec2(uLowSize) - 1);
}

/** Raw depth at a low-res texel: 1.0 (background) outside the target. One fetch. */
float vxTapDepth(ivec2 p) {
  float depth = texelFetch(uDepth, vxTapClamp(p), 0).r;
  return vxTapInside(p) ? depth : 1.0;
}

vec4 vxTapGData(ivec2 p) {
  return texelFetch(uGData, vxTapClamp(p), 0);
}

vec4 vxTapAlbedo(ivec2 p) {
  return texelFetch(uAlbedo, vxTapClamp(p), 0);
}

float vxDepthKeyAt(float depth) {
  return vxDepthKeyFromTexture(depth, uDepthRange);
}

vec3 vxPositionAt(ivec2 texel, float key) {
  return vxFromTexelAndDepth(uCameraTexel + vec2(texel) + 0.5, key);
}

bool vxIsOccluder(vec4 gdata) {
  return (vxFaceFlagsOf(gdata) & VX_NOT_AN_OCCLUDER) == 0;
}

/** Depth-key change per texel step (right, down) on a face's own plane (space.ts). */
vec2 vxPlaneGradient(int face) {
  if (face == VX_FACE_X) return VX_PLANE_GRADIENT_X;
  if (face == VX_FACE_Y) return VX_PLANE_GRADIENT_Y;
  return VX_PLANE_GRADIENT_TOP;
}

/** The texel's world anchor for dithers: low-res texel + camera texel. */
ivec2 vxWorldTexel(ivec2 texel) {
  return texel + ivec2(uCameraTexel);
}

/**
 * The look's background for a texel nothing touches, premultiplied: alpha 0 is transparent (the page
 * gradient shows), 1 is the opaque night colour, and in between (dusk to night and back) the backdrop
 * fades in over the page. At exactly 0 and 1 this is what the old threshold returned.
 */
vec4 vxBackground() {
  return vec4(uBackground.rgb * uBackground.a * (1.0 + 0.45 * uWxD.x), uBackground.a);
}

/** The overlay target over the finished texel, dithered by coverage (un-premultiplied). */
vec4 vxApplyOverlay(vec4 color, ivec2 texel) {
  vec4 result = color;
  if (uOverlayEnabled > 0.5) {
    vec4 overlay = texelFetch(uOverlay, texel, 0);
    if (overlay.a > vxBayer4(vxWorldTexel(texel) + VX_DITHER_OFFSET_OVERLAY)) result = vec4(overlay.rgb / overlay.a, 1.0);
  }
  return result;
}
`;

/** The see-through coverage helper, compiled only into the translucent main run and the front run. */
const seeCoverage = `
/**
 * The see-through coverage at a texel's centre, the spatial part of the cut in world.ts (strength times
 * one minus the smoothstep of the distance to the hole's rectangle); the depth-key test of the cut is
 * true by construction for every texel of the front layer, so it is not repeated here.
 */
float vxSeeCoverage(ivec2 texel) {
  vec2 centre = vec2(vxWorldTexel(texel)) + 0.5;
  float distanceToHole = length(max(abs(centre - uSeeA.xy) - uSeeA.zw, vec2(0.0)));
  return uSeeB.w * (1.0 - smoothstep(0.4 * uSeeB.z, uSeeB.z, distanceToHole));
}
`;

/**
 * The full main. The offset of every neighbour helper is one of the VX_STEP_* constants, so each
 * call site is a constant-offset fetch with nothing to index.
 */
const fullMain = (front: boolean): string => `
/** One neighbour's raw depth (1.0 = background or outside); taps off (gpuMin) read as background. */
float vxNeighbourDepth(ivec2 texel, ivec2 step) {
  return uTaps < 0.5 ? 1.0 : vxTapDepth(texel + step);
}

/** The neighbour's gdata, fetched only where it is geometry; zero otherwise. */
vec4 vxNeighbourGData(ivec2 texel, ivec2 step, float neighbourDepth) {
  vec4 gdata = vec4(0.0);
  if (neighbourDepth < 1.0) gdata = vxTapGData(texel + step);
  return gdata;
}

bool vxIsOccluderTap(float neighbourDepth, vec4 neighbourGData) {
  return neighbourDepth < 1.0 && vxIsOccluder(neighbourGData);
}

${VX_COMPOSITE_LOOK}

void main() {
${front ? `  // Front layer: front-local texels, no shimmer (it shifts the main run's reads of this layer too).
  ivec2 screenTexel = ivec2(gl_FragCoord.xy);
  ivec2 texel = screenTexel;` : `  // Heat shimmer shifts every read of this texel sideways; the overlay and the rain stay on the screen texel.
  ivec2 screenTexel = ivec2(gl_FragCoord.xy);
  ivec2 texel = vxTapClamp(screenTexel + ivec2(vxShimmerDx(screenTexel), 0));`}
  float depth = texelFetch(uDepth, texel, 0).r;
  bool background = depth >= 1.0;

  float depthRight = vxNeighbourDepth(texel, VX_STEP_RIGHT);
  float depthLeft = vxNeighbourDepth(texel, VX_STEP_LEFT);
  float depthDown = vxNeighbourDepth(texel, VX_STEP_DOWN);
  float depthUp = vxNeighbourDepth(texel, VX_STEP_UP);
  vec4 gdataRight = vxNeighbourGData(texel, VX_STEP_RIGHT, depthRight);
  vec4 gdataLeft = vxNeighbourGData(texel, VX_STEP_LEFT, depthLeft);
  vec4 gdataDown = vxNeighbourGData(texel, VX_STEP_DOWN, depthDown);
  vec4 gdataUp = vxNeighbourGData(texel, VX_STEP_UP, depthUp);
  bool nextToOccluder = vxIsOccluderTap(depthRight, gdataRight)
    || vxIsOccluderTap(depthLeft, gdataLeft)
    || vxIsOccluderTap(depthDown, gdataDown)
    || vxIsOccluderTap(depthUp, gdataUp);

${front ? `  // Transparent where the layer holds nothing. A background texel beside the layer's geometry gets its ink
  // ring only where the cut itself has coverage: at the layer's artificial rim (where fragments switch from
  // this buffer to the main one) an ink curve would cross the building.
  vec4 color = vec4(0.0);
  if (!background || (nextToOccluder && vxSeeCoverage(texel) > 0.0)) {` : `  vec4 color = vxBackground();
  if (!background || nextToOccluder) {`}
    vec4 albedo = vec4(0.0);
    vec4 gdata = vec4(0.0);
    float depthKey = uDepthRange.x;
    vec3 light = vec3(0.0);
    if (!background) {
      albedo = texelFetch(uAlbedo, texel, 0);
      gdata = texelFetch(uGData, texel, 0);
      depthKey = vxDepthKeyAt(depth);
      if (uLightEnabled > 0.5) light = texelFetch(uLight, texel, 0).rgb;
    }
    color = vec4(clamp(vxLook(
      texel, background, albedo, gdata, depthKey, light,
      vec4(depthRight, depthLeft, depthDown, depthUp), gdataRight, gdataLeft, gdataDown, gdataUp
    ), 0.0, 1.0), 1.0);
  }
${front ? `  // The main G-buffer holds something nearer than this layer (a guest, litter, the coaster draft in front of the
  // faded building): it is not behind the building, so the layer must not tint it. The same texel of the main
  // depth (uFront is bound to it in this run; the rectangle starts at uSeeC.xy). A ring texel (no geometry of
  // its own) compares against its nearest geometry neighbour. One fetch, in this run only.
  float mainDepth = texelFetch(uFront, texel + ivec2(uSeeC.xy), 0).r;
  float layerDepth = background ? min(min(depthRight, depthLeft), min(depthDown, depthUp)) : depth;
  if (mainDepth < 1.0 && layerDepth < 1.0 && vxDepthKeyAt(mainDepth) > vxDepthKeyAt(layerDepth) + VX_SEE_NEARER_SLACK) color = vec4(0.0);
  outColor = color;` : `#ifdef VX_TRANSLUCENT
  // The lit front layer (the occluding buildings of the see-through volume) over this result, inside the
  // hole's rectangle only: one fetch, in range by the explicit compare. Premultiplied over.
  ivec2 frontTexel = texel - ivec2(uSeeC.xy);
  if (uSeeC.z > 0.0 && frontTexel.x >= 0 && frontTexel.y >= 0 && float(frontTexel.x) < uSeeC.z && float(frontTexel.y) < uSeeC.w) {
    vec4 frontLit = texelFetch(uFront, frontTexel, 0);
    float weight = frontLit.a * (1.0 - vxSeeCoverage(texel) * (1.0 - VX_SEE_OPACITY));
    color = vec4(frontLit.rgb * weight + color.rgb * (1.0 - weight), weight + color.a * (1.0 - weight));
  }
#endif
  color = vxApplyRain(color, screenTexel);
  outColor = vxApplyOverlay(color, screenTexel);`}
}
`;

/** The lite main: the texel itself only, no neighbour reads of any kind. */
const liteMain = `
${VX_COMPOSITE_LOOK_LITE}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  float depth = texelFetch(uDepth, texel, 0).r;
  vec4 color = vxBackground();
  if (depth < 1.0) {
    color = vec4(clamp(vxLook(texelFetch(uAlbedo, texel, 0), texelFetch(uGData, texel, 0)), 0.0, 1.0), 1.0);
  }
  color = vxApplyRain(color, texel);
  outColor = vxApplyOverlay(color, texel);
}
`;

/** Phase 41: the cinematic camera's main (see CompositeOptions.perspective). */
const perspectiveMain = `
${VX_COMPOSITE_LOOK_LITE}
${VX_LIGHT_POOL}
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
/** The horizon's row as a fraction of the target from the top (row 0); may lie outside 0..1. */
uniform float uHorizonY;
uniform vec2 uNearFar;
/** Fog start and end distance (voxels). */
uniform vec2 uFog;
/** 1 for a view turn: the isometric background (no sky) and a silhouette outline, so the turn keeps the map's look. */
uniform float uIsoFrame;
/** A neighbour this many voxels nearer (linear depth) is across a silhouette: well above the ~1.2 voxels a texel of ground spans at 30°. */
const float VX_TURN_SILHOUETTE_VOXELS = 4.0;

vec3 vxSky(float rowFraction) {
  float up = clamp((uHorizonY - rowFraction) / max(uHorizonY, 0.05), 0.0, 1.0);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, sqrt(up));
  return vxGrade(sky);
}

float vxLinearDepth(float depth) {
  float z = depth * 2.0 - 1.0;
  return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}

/**
 * The isometric look's silhouette, in linear depth: the far side of an edge (or background beside geometry) takes the
 * outline colour of the nearest neighbour across it. Returns vec4(colour, 1) on an outline, else alpha 0.
 */
vec4 vxTurnOutline(ivec2 texel, float depth) {
  float own = depth < 1.0 ? vxLinearDepth(depth) : 1e30;
  float best = own - VX_TURN_SILHOUETTE_VOXELS;
  ivec2 nearest = ivec2(0);
  bool found = false;
  ivec2 steps[4] = ivec2[4](VX_STEP_RIGHT, VX_STEP_LEFT, VX_STEP_DOWN, VX_STEP_UP);
  for (int i = 0; i < 4; i += 1) {
    float neighbour = vxTapDepth(texel + steps[i]);
    if (neighbour >= 1.0) continue;
    float linear = vxLinearDepth(neighbour);
    if (linear < best) {
      best = linear;
      nearest = steps[i];
      found = true;
    }
  }
  if (!found) return vec4(0.0);
  return vec4(clamp(vxGrade(mix(vxTapAlbedo(texel + nearest).rgb * uOutlineTint, VX_INK, uOutlineInkMix)), 0.0, 1.0), 1.0);
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  float rowFraction = (gl_FragCoord.y) / uLowSize.y;
  float depth = texelFetch(uDepth, texel, 0).r;
  vec3 horizon = vxGrade(uSkyHorizon);
  vec4 color;
  if (uIsoFrame > 0.5) {
    vec4 outline = vxTurnOutline(texel, depth);
    if (outline.a > 0.5) {
      color = outline;
    } else if (depth < 1.0) {
      vec4 albedo = texelFetch(uAlbedo, texel, 0);
      vec3 lit = vxLook(albedo, texelFetch(uGData, texel, 0));
      // The lamps' pools, as the full look adds them (its own pass: perspectiveLightShaderSource).
      if (uLightEnabled > 0.5) {
        vec3 pool = vxLightPool(texelFetch(uLight, texel, 0).rgb, vxWorldTexel(texel));
        lit += vxGrade(albedo.rgb * pool * 0.85 + pool * 0.3);
      }
      color = vec4(clamp(lit, 0.0, 1.0), 1.0);
    } else {
      color = vxBackground();
    }
  } else if (depth < 1.0) {
    vec3 lit = vxLook(texelFetch(uAlbedo, texel, 0), texelFetch(uGData, texel, 0));
    float fog = smoothstep(uFog.x, uFog.y, vxLinearDepth(depth));
    color = vec4(clamp(mix(lit, horizon, fog), 0.0, 1.0), 1.0);
  } else {
    color = vec4(clamp(rowFraction <= uHorizonY ? vxSky(rowFraction) : horizon, 0.0, 1.0), 1.0);
  }
  color = vxApplyRain(color, texel);
  outColor = color;
}
`;

/**
 * The composite program of a variant and weather tier (compositeWeather.ts). The default tier is
 * the whole weather pass for `full` and rain only for `lite`.
 */
export const compositeShaderSource = (
  variant: CompositeVariant = 'full',
  tier: WeatherTier = variant === 'full' ? 'full' : 'rain',
  options: CompositeOptions = {},
): ShaderSource => {
  const translucent = variant === 'full' && options.translucent === true;
  const front = variant === 'full' && options.front === true;
  const viewWorld = (options.viewTurn ?? true) && variant === 'full' && tier === 'full';
  return {
    vertex,
    fragment: prelude({ translucent, front, viewWorld }) + (translucent || front ? seeCoverage : '') + weatherChunks(tier, viewWorld)
      + (variant === 'full' ? fullMain(front) : options.perspective === true ? perspectiveMain : liteMain),
  };
};

/** The fullscreen-triangle vertex stage, shared with the upscale pass. */
export const FULLSCREEN_VERTEX = vertex;
