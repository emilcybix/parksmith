/**
 * Light presets: the whole look of the composite pass as data. These three are the authored looks;
 * the park clock never edits them, it only blends between them (dayLook.ts: dawn is a mix of dusk
 * and night). `&light=dusk|night` still pins the voxel look to one preset as an explicit override.
 *
 * Face light = ambient + key · lambert (gdata.a). With the key light from the upper left, a top face
 * is lit exactly 1.0 in daylight, so a top face shows its catalog colour and the park matches the
 * HUD swatches. Warm/cool is a property of the light, not of albedo: key light is warm, ambient cool.
 *
 * Owner: the look agent (Wave D). Values here are the starting point from the design critique.
 */

export type LightPresetName = 'day' | 'dusk' | 'night';

export type Rgb = readonly [number, number, number];

export interface LightPreset {
  ambient: Rgb;
  key: Rgb;
  /** Global grade after lighting: exposure multiplier, saturation (1 = unchanged), tint. */
  exposure: number;
  saturation: number;
  tint: Rgb;
  /** Background: null keeps the page's own gradient (transparent canvas), else an sRGB colour. */
  background: number | null;
  /** Emissive materials' strength (lamps). */
  emissiveScale: number;
  /** Glass/window glow (0 by day). */
  glassGlow: number;
  /** Whether the point-light pass runs, and its strength. */
  lightPass: boolean;
  lightStrength: number;
  /** Outline colour = neighbour albedo × outlineTint, mixed toward UI ink by outlineInkMix. */
  outlineTint: Rgb;
  outlineInkMix: number;
  /** Id contours multiply the far texel by this. */
  contourFactor: number;
  /** Contact-shadow darkening strength 0..1 and its cool tint. */
  shadowStrength: number;
  shadowTint: Rgb;
}

/** A LightPreset whose numbers can be written in place (a reusable per-frame scratch, see dayLook.ts). */
export type MutableRgb = [number, number, number];
export type MutableLightPreset = {
  -readonly [Key in keyof LightPreset]: LightPreset[Key] extends Rgb ? MutableRgb : LightPreset[Key];
};

export const LIGHT_PRESETS: Readonly<Record<LightPresetName, LightPreset>> = {
  day: {
    ambient: [0.5, 0.53, 0.62],
    key: [0.5, 0.47, 0.38],
    exposure: 1,
    saturation: 1,
    tint: [1, 1, 1],
    background: null,
    emissiveScale: 0.35,
    glassGlow: 0,
    lightPass: false,
    lightStrength: 0,
    outlineTint: [0.42, 0.45, 0.55],
    outlineInkMix: 0.3,
    contourFactor: 0.8,
    shadowStrength: 1,
    shadowTint: [0.5, 0.56, 0.84],
  },
  dusk: {
    ambient: [0.4, 0.4, 0.62],
    key: [0.7, 0.5, 0.3],
    exposure: 1,
    saturation: 1.12,
    tint: [1.02, 0.97, 0.95],
    background: null,
    emissiveScale: 0.9,
    glassGlow: 0.9,
    lightPass: true,
    lightStrength: 0.9,
    outlineTint: [0.4, 0.4, 0.55],
    outlineInkMix: 0.35,
    contourFactor: 0.78,
    shadowStrength: 1,
    shadowTint: [0.6, 0.62, 0.86],
  },
  night: {
    ambient: [0.27, 0.32, 0.52],
    key: [0.12, 0.15, 0.26],
    exposure: 1,
    saturation: 1.1,
    tint: [0.95, 0.99, 1.08],
    background: 0x10201e,
    emissiveScale: 1,
    glassGlow: 1,
    lightPass: true,
    lightStrength: 1.3,
    outlineTint: [0.35, 0.38, 0.55],
    outlineInkMix: 0.4,
    contourFactor: 0.75,
    shadowStrength: 1,
    shadowTint: [0.6, 0.64, 0.9],
  },
};
