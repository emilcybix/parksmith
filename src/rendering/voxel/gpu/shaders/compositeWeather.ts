import { DITHER_OFFSET_WEATHER } from '../../contracts/gbuffer';
import { VX_VIEW_INVERSE } from './common';
import { glslIvec2 } from './glsl';

/**
 * The weather pass of the composite (Phase 20): GLSL chunks appended after the composite prelude
 * and before its main. Presentation only; everything here is a pure function of the
 * `uWx*` uniforms (WeatherEffects, rendering/weatherLook.ts) and the texel's world position.
 *
 * Uniform layout (the composite declares them in BOTH variants, the compiler drops unused ones):
 *   uWxA = (enabled 0/1, cloudCover, cloudStrength, wetness)
 *   uWxB = (rainDensity, rainSlant (unused by the voxel pass, see vxRainLayer), puddle, shimmer)
 *   uWxC = (cloudOffsetX, cloudOffsetY, rainPhaseA, rainPhaseB)
 *   uWxD = (flash, shimmerPhase, ripple, 0)
 *   uWxCloudTint, uWxRainTint (vec3)
 * A clear sky costs a uniform compare per texel: every effect sits behind `uWxA.x > 0.5`.
 *
 * Tiers (WeatherTier): `full` = rain + clouds + wet ground + puddles + shimmer; `rain` = rain only
 * (the lite composite's default, no noise octaves or neighbour reads); `none` compiles no effect
 * and keeps the hooks as pass-throughs, so the mains in composite.ts read the same for every tier.
 * The flash lives in vxGrade (compositeLook.ts) and costs nothing when uWxD.x is 0.
 *
 * The three hooks the composite mains call (each ONCE per main, fxc rule):
 *   vec4 vxApplyRain(vec4 color, ivec2 screenTexel)      all tiers
 *   int vxShimmerDx(ivec2 screenTexel)                   full tier (stub 0 otherwise)
 *   vec3 vxWeatherSurface(lit, world, texel, flags, faceC, group)   full tier (stub = lit)
 *
 * View rotation (Phase 26, `viewTurn`, full tier only): the composite works in VIEW voxels, but the cloud
 * shadows and puddles are anchored to the WORLD (they must stay over the same buildings when the map turns),
 * so the ground hook maps the texel's view point back with `vxWorldXYOfView(view.xy, uView)` before it reads
 * any noise. Cloud drift (uWxC.xy) stays in world axes. This is the only view code of the composite: the
 * contact shadow, light pools, outlines, rain and shimmer are view- or screen-anchored by design. The rain,
 * lite and no-weather builds contain none (the lite composite has no ground hook).
 *
 * Rules kept from the rest of the voxel renderer: opaque binary texels only (no alpha blending: rain
 * heads replace, tails are a colour mix or a world-anchored Bayer dither on the transparent
 * backdrop), world-anchored dithers (nothing crawls when the camera pans), integer hashes, no
 * texture fetches, no loops, no arrays, no structs, no dynamic indexing (compositeFxc.test.ts).
 *
 * Periods (all the phases wrap at 4096 rows and the cloud offset at 448 voxels, see weatherLook.ts,
 * so every pattern below repeats EXACTLY over its wrap, no pop): rain columns repeat every 32
 * rows (4096 = 128 x 32); the ripple clock is phase / 64 cycles (4096 = 64 x 64); the shimmer
 * band moves by 2 pi / 32 per row of phase; the cloud octaves have 8 cells of 56 voxels and 16
 * cells of 28 voxels (both 448).
 */

export type WeatherTier = 'full' | 'rain' | 'none';

const VX_WEATHER_HASH = /* glsl */ `
const ivec2 VX_DITHER_OFFSET_WEATHER = ${glslIvec2(DITHER_OFFSET_WEATHER)};

/** Hash of an integer cell in 0..1 (lowbias32 finaliser, the shape of vxPatternHash). */
float vxWxHash(ivec2 c, int salt) {
  uint h = (uint(c.x & 1023) * 0x8DA6B343u) ^ (uint(c.y & 1023) * 0xD8163841u) ^ (uint(salt) * 0xCB1AB31Fu);
  h ^= h >> 16;
  h *= 0x7FEB352Du;
  h ^= h >> 15;
  h *= 0x846CA68Bu;
  h ^= h >> 16;
  return float(h >> 8) / 16777216.0;
}
`;

/**
 * Rain, both tiers. A column of the world texel grid (slanted by a FIXED quarter column per row: a slant that eased with the
 * intensity would re-hash every streak column on each step, so the voxel pass keeps it constant and uWxB.y is unused; the classic layer rotates its streaks) is a
 * streak when its hash is under the density; the streak is 6 rows of a 32-row cycle, falling with
 * the phase. A second, sparser layer with its own salt and phase gives depth.
 */
const VX_WEATHER_RAIN = /* glsl */ `
vec4 vxRainLayer(vec4 base, ivec2 w, int shift, float scale, float phase, int salt) {
  int col = w.x - int(floor(float(w.y) * 0.25)) + shift;
  if (vxWxHash(ivec2(col, 0), salt) >= uWxB.x * 0.42 * scale) return base;
  float u = fract((float(w.y) - phase) / 32.0 + vxWxHash(ivec2(col, 1), salt + 8)) * 32.0;
  if (u >= 6.0) return base;
  // Opaque colour mixes, never alpha: the head leans on the tint, the tail is a ghost of it, so a rain-lit
  // night backdrop does not turn into white speckle. On the transparent page backdrop the texel is dithered.
  if (base.a < 0.5) return vxBayer4(w + VX_DITHER_OFFSET_WEATHER) > (u >= 4.5 ? 0.0 : 0.5) ? vec4(uWxRainTint, 1.0) : base;
  return vec4(mix(base.rgb, uWxRainTint, u >= 4.5 ? 0.8 : 0.4), 1.0);
}

vec4 vxApplyRain(vec4 color, ivec2 screenTexel) {
  vec4 result = color;
  if (uWxA.x > 0.5 && uWxB.x > 0.0) {
    ivec2 w = vxWorldTexel(screenTexel);
    result = vxRainLayer(result, w, 0, 1.0, uWxC.z, 0);
    result = vxRainLayer(result, w, 7, 0.6, uWxC.w, 1);
  }
  return result;
}
`;

/**
 * Cloud shadows, wet ground and puddles (full tier). `world` is the true voxel point of the texel
 * (vxPositionAt), so a wall and the ground below it are shaded by their own position and nothing
 * skews with the camera.
 */
const weatherGround = (viewTurn: boolean): string => `
const vec3 VX_PUDDLE_SKY = vec3(0.62, 0.78, 1.0);

/** Value noise on a lattice of \`mask + 1\` cells of \`cell\` voxels, periodic over (mask + 1) * cell. */
float vxCloudNoise(vec2 q, float cell, int mask, int salt) {
  vec2 g = q / cell;
  vec2 fl = floor(g);
  ivec2 i = ivec2(fl);
  vec2 f = g - fl;
  f = f * f * (3.0 - 2.0 * f);
  float a = vxWxHash(i & mask, salt);
  float b = vxWxHash((i + ivec2(1, 0)) & mask, salt);
  float c = vxWxHash((i + ivec2(0, 1)) & mask, salt);
  float d = vxWxHash((i + ivec2(1, 1)) & mask, salt);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** Multiply for the lit colour: white outside a cloud shadow, uWxCloudTint inside, in four dithered levels. */
vec3 vxCloudShade(vec3 world, ivec2 texel) {
  vec2 q = world.xy + uWxC.xy;
  float n = 0.65 * vxCloudNoise(q, 56.0, 7, 1) + 0.35 * vxCloudNoise(q + 117.0, 28.0, 15, 2);
  float s = smoothstep(1.0 - uWxA.y - 0.12, 1.0 - uWxA.y + 0.12, n);
  float level = floor(s * 3.0 + vxBayer4(vxWorldTexel(texel) + VX_DITHER_OFFSET_WEATHER)) / 3.0;
  return mix(vec3(1.0), uWxCloudTint, level);
}

/** Puddle sheen on wet ground: round pools on a 14-voxel lattice, dithered edge, sparse glints and rings. */
vec3 vxWetGround(vec3 lit, vec3 world, ivec2 texel) {
  // Wet ground darkens a little and keeps its colour (a saturation lift offsets the cool, dim grade).
  vec3 result = lit * mix(1.0, 0.93, uWxA.w);
  result = mix(vec3(dot(result, vec3(0.2126, 0.7152, 0.0722))), result, 1.0 + 0.14 * uWxA.w);
  if (uWxB.z > 0.0) {
    vec2 cellF = world.xy / 14.0;
    vec2 fl = floor(cellF);
    ivec2 cell = ivec2(fl);
    vec2 f = cellF - fl;
    float h1 = vxWxHash(cell, 3);
    float h2 = vxWxHash(cell, 4);
    float h3 = vxWxHash(cell, 5);
    float d = length(f - vec2(0.3 + 0.4 * h1, 0.3 + 0.4 * h2));
    float r = h3 < 0.6 ? uWxB.z * 0.4 * (0.5 + 0.5 * h2) : 0.0;
    ivec2 wt = vxWorldTexel(texel);
    if (clamp((r - d) / 0.05, 0.0, 1.0) > vxBayer4(wt + VX_DITHER_OFFSET_WEATHER)) {
      float luma = dot(result, vec3(0.2126, 0.7152, 0.0722));
      result = mix(result, VX_PUDDLE_SKY * (uAmbient + 0.35 * uKey) * (0.35 + luma), 0.3);
      if (vxWxHash(wt, 7) < 0.06) result += 0.12;
      if (uWxD.z > 0.0 && abs(d - fract(uWxC.z * 0.015625 + h1) * r) < 0.03) result += 0.1 * uWxD.z;
    }
  }
  return result;
}

/** What the weather does to a lit, non-exempt surface texel (cloud shadow; wet ground on terrain and paths). */
VX_SURFACE_HEAD
  if (uWxA.z > 0.0) result *= vxCloudShade(world, texel);
  if (uWxA.w > 0.0 && faceC == VX_FACE_TOP && group == 0 && (flags & (VX_GFLAG_WATER | VX_GFLAG_FIGURE)) == 0) {
    result = vxWetGround(result, world, texel);
  }
  return result;
}

/**
 * Heat shimmer: whole-texel horizontal steps of world-anchored rows. Two opposite bands per wave
 * (one row-block shifts right, the next left) read as a drifting wave, not a comb; at most ~15 % of
 * the rows move at the strongest setting.
 */
int vxShimmerDx(ivec2 screenTexel) {
  if (uWxA.x < 0.5 || uWxB.w <= 0.0) return 0;
  ivec2 w = vxWorldTexel(screenTexel);
  float wave = sin(float(w.y) * 0.45 + uWxD.y * 0.19634954);
  float limit = 1.0 - 0.6 * uWxB.w;
  if (wave > limit) return 1;
  return -wave > limit ? -1 : 0;
}
`.replace('VX_SURFACE_HEAD', viewTurn
  ? `vec3 vxWeatherSurface(vec3 lit, vec3 viewPoint, ivec2 texel, int flags, int faceC, int group) {
  vec3 world = vec3(vxWorldXYOfView(viewPoint.xy, uView), viewPoint.z);
  vec3 result = lit;`
  : `vec3 vxWeatherSurface(vec3 lit, vec3 world, ivec2 texel, int flags, int faceC, int group) {
  vec3 result = lit;`);

const VX_WEATHER_STUBS_GROUND = /* glsl */ `
vec3 vxWeatherSurface(vec3 lit, vec3 world, ivec2 texel, int flags, int faceC, int group) {
  return lit;
}

int vxShimmerDx(ivec2 screenTexel) {
  return 0;
}
`;

const VX_WEATHER_STUB_RAIN = /* glsl */ `
vec4 vxApplyRain(vec4 color, ivec2 screenTexel) {
  return color;
}
`;

/** The chunks a composite of this tier compiles, hooks included. */
export const weatherChunks = (tier: WeatherTier, viewTurn = false): string => {
  switch (tier) {
    case 'full': return VX_WEATHER_HASH + VX_WEATHER_RAIN + (viewTurn ? VX_VIEW_INVERSE : '') + weatherGround(viewTurn);
    case 'rain': return VX_WEATHER_HASH + VX_WEATHER_RAIN + VX_WEATHER_STUBS_GROUND;
    case 'none': return VX_WEATHER_STUB_RAIN + VX_WEATHER_STUBS_GROUND;
  }
};
