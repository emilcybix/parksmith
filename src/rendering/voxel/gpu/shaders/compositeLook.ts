/**
 * The look of the composite pass, as GLSL appended after the plumbing inside the composite shader.
 * The composite shader (composite.ts) does the fetches, guard band and overlay and calls exactly
 * this function per low-res texel of geometry, and per background texel that borders an occluder
 * (background = true):
 *
 *   vec3 vxLook(ivec2 texel, bool background, vec4 albedo, vec4 gdata, float depthKey, vec3 light,
 *               vec4 neighbourDepth, vec4 gdataRight, vec4 gdataLeft, vec4 gdataDown, vec4 gdataUp)
 *
 * — the texel, whether it is background (then albedo, gdata, depthKey and light are zero /
 * uDepthRange.x), the Light-pass sum, the raw depth of the right, left, down and up neighbours (x, y,
 * z, w; 1.0 = background or outside) and their gdata (zero where there is no geometry). Plain
 * scalars and vectors only, on purpose: see composite.ts for why a struct of arrays does not
 * belong in this shader. Everything visual — face light from gdata.a with the preset's
 * ambient/key, far-texel plane-residual outlines, id contours, contact shadow, emissive,
 * light-pool contribution, grade — lives here, within COMPOSITE_FETCH_BUDGET.
 *
 * Owner: Wave D look agent. Until then the GPU agent owns this minimal version:
 * - face light = ambient + key · lambert; light pools from the light target in 3 Bayer bands;
 * - FAR-texel silhouettes: texel c is outlined when an occluding 4-neighbour n is nearer than n's own
 *   plane continued to c predicts by more than SILHOUETTE_MIN_RESIDUAL (FACE_OTHER: raw depth
 *   difference over SILHOUETTE_RAW_OTHER) — and, so convex corners of 1-voxel slabs stay clean, also
 *   nearer than c's own plane continued to n predicts (vxFarAcrossEdge) — or when c is background
 *   next to an occluder; colour = albedo_n × outlineTint mixed toward ink, the nearest n winning
 *   (the first of right, left, down, up on a tie);
 * - id contours on the far texel (design §6; visual critique #3): n of another group (figures kept
 *   apart by GFLAG_FIGURE) nearer by more than CONTOUR_NOT_NEARER, or level with it (within
 *   ±CONTOUR_NOT_NEARER) and c has the lower group id — exactly one texel wide;
 * - ghosts, shadow decals, no-outline and glowing texels are never outlined or contoured, and emissive
 *   light is added after the grade, exempt from all darkening;
 * - contact shadow (top faces only): up to three taps straight up the screen, at 1, 4 and 6 texels
 *   (the design says 1, 3 and 5; a tap k texels up sees a wall base d texels away at a rise of
 *   k - d, so with rise >= 3 the shadow is only k - 3 texels wide, and 1/3/5 gave a 2-texel strip
 *   that vanished under the outline). The 1-texel tap reuses the up neighbour's depth, so only two
 *   extra fetches. A tap hits when the point it sees stands >= VX_SHADOW_MIN_RISE voxels above this
 *   texel's own point and within VX_SHADOW_REACH voxels of it horizontally: a wall, a bench back, a
 *   bin, never a path slab (rise 1). Hits are weighted, quantised to three levels with a
 *   world-anchored Bayer and applied as mix(1, shadowTint, shadowStrength * level) on the face
 *   light only (not on pools or glow);
 * - window glass glows warm, scaled by its albedo luminance so frames stay dark and panes light up.
 *
 * How the four neighbours are handled (the fxc-safe shape): vxNeighbourEval is called four times,
 * once per neighbour with a constant step, and returns the neighbour's verdict packed in a vec4
 * (found, depth key, silhouette, contour); vxNearerSilhouette folds the four verdicts, in order,
 * into the winning neighbour (found, key, step.x, step.y). The arithmetic is the loop version's, term
 * for term, so the picture is the same.
 */

/** Exposure, saturation and tint; shared by both looks. */
const VX_COMPOSITE_GRADE = /* glsl */ `
vec3 vxGrade(vec3 color) {
  // Lightning (uWxD.x, 0..1 and capped on the CPU): a soft lift of at most +45 % of the lit colour.
  color = color * uExposure * (1.0 + 0.45 * uWxD.x) + uWxD.x * vec3(0.05, 0.06, 0.09);
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(luma), color, uSaturation) * uTint;
}
`;

export const VX_COMPOSITE_LOOK = /* glsl */ `
${VX_COMPOSITE_GRADE}
/** Contact shadow: a tap counts when it sees something this many voxels higher, this near. */
const float VX_SHADOW_MIN_RISE = 3.0;
const float VX_SHADOW_REACH = 8.0;
/** Level weights of the 1, 4 and 6 texel taps (sum 1): the 6-texel tap reaches furthest, so it weighs most. */
const float VX_SHADOW_WEIGHT_1 = 0.25;
const float VX_SHADOW_WEIGHT_4 = 0.35;
const float VX_SHADOW_WEIGHT_6 = 0.4;
/** What window glass glows (warm, like the reference's lit panes) before the albedo scales it. */
const vec3 VX_WINDOW_WARM = vec3(1.0, 0.8, 0.45);

vec3 vxOutlineColor(vec3 neighbourAlbedo) {
  return mix(neighbourAlbedo * uOutlineTint, VX_INK, uOutlineInkMix);
}

/** Light-pool colour for this texel, quantised to 3 bands with a world-anchored Bayer threshold. */
vec3 vxLightPool(vec3 light, ivec2 worldTexel) {
  vec3 pool = light * uLightStrength;
  float amount = max(pool.r, max(pool.g, pool.b));
  if (amount <= 0.0) return vec3(0.0);
  // The Bayer threshold is squeezed to +-0.1 around the band edge: wide bands with a narrow dithered
  // seam read as pixel-art pools, a full-range dither reads as noise (visual critique).
  float seam = 0.5 + (vxBayer4(worldTexel + VX_DITHER_OFFSET_LIGHT) - 0.5) * 0.2;
  // The light pass falls off with the square of the distance, which leaves a lamp 47 voxels above
  // the path with a few percent at its foot: the square root turns that into a pool you can see.
  float band = floor(sqrt(min(amount, 1.0)) * 3.0 + seam) / 3.0;
  return pool / amount * min(band, 1.0);
}

/** Whether the point seen at \`tapTexel\` (raw \`tapDepth\`) towers over \`p\` closely enough to shade it. */
bool vxShadowHit(vec3 p, ivec2 tapTexel, float tapDepth) {
  if (tapDepth >= 1.0) return false;
  vec3 q = vxPositionAt(tapTexel, vxDepthKeyAt(tapDepth));
  return q.z - p.z >= VX_SHADOW_MIN_RISE && length(q.xy - p.xy) <= VX_SHADOW_REACH;
}

/** One extra contact-shadow tap at a constant offset: one depth fetch. */
bool vxShadowTap(ivec2 texel, ivec2 step, vec3 p) {
  return vxShadowHit(p, texel + step, vxTapDepth(texel + step));
}

/**
 * Contact-shadow level 0..1 of a top-face texel at voxel point p, quantised to thirds with the
 * world-anchored shadow dither. depthUp is the already fetched raw depth of the up neighbour.
 */
float vxContactShadow(ivec2 texel, vec3 p, float depthUp) {
  float amount = 0.0;
  if (vxShadowHit(p, texel + VX_STEP_UP, depthUp)) amount += VX_SHADOW_WEIGHT_1;
  if (vxShadowTap(texel, ivec2(0, -4), p)) amount += VX_SHADOW_WEIGHT_4;
  if (vxShadowTap(texel, ivec2(0, -6), p)) amount += VX_SHADOW_WEIGHT_6;
  if (amount <= 0.0) return 0.0;
  return floor(amount * 3.0 + vxBayer4(vxWorldTexel(texel) + VX_DITHER_OFFSET_SHADOW)) / 3.0;
}

/** Outline groups with figures kept apart from objects (they share the 8-bit id space). */
int vxContourId(vec4 gdata) {
  return vxGroupOf(gdata) + (vxHasFlag(gdata, VX_GFLAG_FIGURE) ? 256 : 0);
}

/**
 * Whether geometry texel c is the far side of a depth edge against occluding neighbour n, given the
 * depth-key difference n − c (raw), the step from c to n, and both faces.
 * The residual continues n's plane back to c (contracts/gbuffer.ts) AND c's own plane on to n, and
 * both must exceed the threshold: continuing only n's plane past n's own edge misreads convex corners
 * — above the top row of a 1-voxel slab's side face it predicts a point one voxel ABOVE the slab, so
 * the ground behind every path end and plot corner would get a stray outline dot (residual 5.25).
 * A real silhouette is far by both planes. Rotated faces (FACE_OTHER) compare raw depth keys.
 */
bool vxFarAcrossEdge(float raw, vec2 step, int faceN, int faceC) {
  bool farByN = faceN == VX_FACE_OTHER
    ? raw > VX_SILHOUETTE_RAW_OTHER
    : raw - dot(vxPlaneGradient(faceN), step) > VX_SILHOUETTE_MIN_RESIDUAL;
  bool farByC = faceC == VX_FACE_OTHER
    ? raw > VX_SILHOUETTE_RAW_OTHER
    : raw - dot(vxPlaneGradient(faceC), step) > VX_SILHOUETTE_MIN_RESIDUAL;
  return farByN && farByC;
}

/**
 * One neighbour's verdict for the texel (own depthKey, faceC, contourId; background = no geometry
 * here): vec4(found, key, silhouette, contour), found = 1 only for an occluding neighbour with
 * geometry; the other fields are 0 otherwise. step is the constant offset to the neighbour.
 */
vec4 vxNeighbourEval(float neighbourDepth, vec4 neighbourGData, vec2 step, bool background, float depthKey, int faceC, int contourId) {
  vec4 verdict = vec4(0.0);
  if (neighbourDepth < 1.0 && vxIsOccluder(neighbourGData)) {
    float key = vxDepthKeyAt(neighbourDepth);
    bool silhouette = background || vxFarAcrossEdge(key - depthKey, step, vxFaceOf(neighbourGData), faceC);
    bool contour = false;
    if (!background) {
      int neighbourId = vxContourId(neighbourGData);
      float nearer = key - depthKey;
      contour = neighbourId != contourId
        && (nearer > VX_CONTOUR_NOT_NEARER || (nearer >= -VX_CONTOUR_NOT_NEARER && contourId < neighbourId));
    }
    verdict = vec4(1.0, key, silhouette ? 1.0 : 0.0, contour ? 1.0 : 0.0);
  }
  return verdict;
}

/**
 * Folds one verdict into the best silhouette so far, (found, key, step.x, step.y): the nearer key
 * wins, and the earlier neighbour on a tie.
 */
vec4 vxNearerSilhouette(vec4 best, vec4 verdict, vec2 step) {
  vec4 result = best;
  if (verdict.z > 0.5 && (best.x < 0.5 || verdict.y > best.y)) result = vec4(1.0, verdict.y, step);
  return result;
}

vec3 vxLook(
  ivec2 texel, bool background, vec4 albedo, vec4 gdata, float depthKey, vec3 light,
  vec4 neighbourDepth, vec4 gdataRight, vec4 gdataLeft, vec4 gdataDown, vec4 gdataUp
) {
  int flags = vxFaceFlagsOf(gdata);
  bool isGlass = (flags & VX_GFLAG_EMISSIVE) == 0;
  float glow = isGlass ? uGlassGlow : uEmissiveScale;
  // Glass glows by how light its colour is: a pane (luma ~0.8) fully, a dark frame hardly at all.
  float luma = dot(albedo.rgb, vec3(0.2126, 0.7152, 0.0722));
  float emissive = gdata.b * glow * (isGlass ? clamp(luma * 1.8 - 0.2, 0.15, 1.0) : 1.0);
  bool exempt = !background && ((flags & VX_NOT_AN_OCCLUDER) != 0 || emissive > 0.0);
  int faceC = vxFaceOf(gdata);
  int contourId = vxContourId(gdata);

  vec2 stepRight = vec2(VX_STEP_RIGHT);
  vec2 stepLeft = vec2(VX_STEP_LEFT);
  vec2 stepDown = vec2(VX_STEP_DOWN);
  vec2 stepUp = vec2(VX_STEP_UP);
  vec4 right = vxNeighbourEval(neighbourDepth.x, gdataRight, stepRight, background, depthKey, faceC, contourId);
  vec4 left = vxNeighbourEval(neighbourDepth.y, gdataLeft, stepLeft, background, depthKey, faceC, contourId);
  vec4 down = vxNeighbourEval(neighbourDepth.z, gdataDown, stepDown, background, depthKey, faceC, contourId);
  vec4 up = vxNeighbourEval(neighbourDepth.w, gdataUp, stepUp, background, depthKey, faceC, contourId);

  vec4 outline = vxNearerSilhouette(vec4(0.0), right, stepRight);
  outline = vxNearerSilhouette(outline, left, stepLeft);
  outline = vxNearerSilhouette(outline, down, stepDown);
  outline = vxNearerSilhouette(outline, up, stepUp);
  bool contour = right.w > 0.5 || left.w > 0.5 || down.w > 0.5 || up.w > 0.5;

  vec3 color;
  if (outline.x > 0.5 && !exempt) {
    color = vxGrade(vxOutlineColor(vxTapAlbedo(texel + ivec2(outline.zw)).rgb));
  } else {
    vec3 base = albedo.rgb;
    vec3 lit = base * (uAmbient + uKey * gdata.a);
    vec3 world = vec3(0.0);
    if (!background && !exempt) world = vxPositionAt(texel, depthKey);
    if (!background && !exempt && faceC == VX_FACE_TOP && uTaps > 0.5) {
      float shade = vxContactShadow(texel, world, neighbourDepth.w);
      lit *= mix(vec3(1.0), uShadowTint, uShadowStrength * shade);
    }
    if (uWxA.x > 0.5 && !background && !exempt) lit = vxWeatherSurface(lit, world, texel, flags, faceC, vxGroupOf(gdata));
    if (uLightEnabled > 0.5) {
      // Mostly the surface's own colour lit warm, plus a little of the light itself so a pool also
      // reads on dark or blue surfaces (a warm window on a blue wall).
      vec3 pool = vxLightPool(light, vxWorldTexel(texel));
      lit += base * pool * 0.85 + pool * 0.3;
    }
    if (contour && !exempt) lit *= uContourFactor;
    color = vxGrade(lit) + (isGlass ? mix(base, VX_WINDOW_WARM, 0.8) : base) * emissive;
  }
  return color;
}
`;

/**
 * The lite look, the fallback for a GPU compiler that refuses the full one: face light, emissive
 * after the grade and the grade — no neighbour reads, no outlines or contours, no light pools.
 * The picture is flat-shaded voxels, readable and honest, not the intended look.
 *   vec3 vxLook(vec4 albedo, vec4 gdata)
 */
export const VX_COMPOSITE_LOOK_LITE = /* glsl */ `
${VX_COMPOSITE_GRADE}
vec3 vxLook(vec4 albedo, vec4 gdata) {
  int flags = vxFaceFlagsOf(gdata);
  float glow = (flags & VX_GFLAG_EMISSIVE) != 0 ? uEmissiveScale : uGlassGlow;
  float emissive = gdata.b * glow;
  vec3 lit = albedo.rgb * (uAmbient + uKey * gdata.a);
  return vxGrade(lit) + albedo.rgb * emissive;
}
`;
