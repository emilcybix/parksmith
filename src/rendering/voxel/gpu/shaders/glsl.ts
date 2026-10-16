/**
 * Tiny helpers that turn TypeScript contract values into GLSL literals, so every constant a shader
 * uses is generated from the one table the CPU packs with and can never drift from it.
 */

/** A GLSL float literal: integers keep a trailing `.0`, because `1` is an int in GLSL. */
export const glslFloat = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error(`Cannot write ${value} as a GLSL float`);
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
};

/** A GLSL int literal; throws for anything that is not a whole number. */
export const glslInt = (value: number): string => {
  if (!Number.isInteger(value)) throw new Error(`Cannot write ${value} as a GLSL int`);
  return `${value}`;
};

export const glslVec2 = (values: readonly [number, number]): string =>
  `vec2(${glslFloat(values[0])}, ${glslFloat(values[1])})`;

export const glslIvec2 = (values: readonly [number, number]): string =>
  `ivec2(${glslInt(values[0])}, ${glslInt(values[1])})`;

/** An sRGB colour 0xRRGGBB as a GLSL vec3 in 0..1 (the voxel renderer grades in sRGB, like the palette). */
export const glslRgb = (rgb: number): string => {
  const channel = (shift: number): string => glslFloat(((rgb >> shift) & 255) / 255);
  return `vec3(${channel(16)}, ${channel(8)}, ${channel(0)})`;
};

/** 0xRRGGBB → [r, g, b] in 0..1, for colour uniforms. */
export const rgbToUnit = (rgb: number, out: Float32Array | number[], offset = 0): void => {
  out[offset] = ((rgb >> 16) & 255) / 255;
  out[offset + 1] = ((rgb >> 8) & 255) / 255;
  out[offset + 2] = (rgb & 255) / 255;
};
