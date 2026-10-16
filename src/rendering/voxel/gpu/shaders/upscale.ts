import { GUARD_BAND_TEXELS } from '../../contracts/budgets';
import { VX_PRECISION } from './common';
import { FULLSCREEN_VERTEX } from './composite';
import { glslInt } from './glsl';
import type { ShaderSource } from './world';

/**
 * The integer upscale: every device pixel of the canvas shows exactly one low-res texel, N×N pixels
 * each, so the pixel art stays crisp at any zoom. The camera (voxel/camera.ts) snaps its origin to
 * a whole texel plus a device-pixel shift in [−(N − 1), 0]; device pixel p (top-left origin) shows
 * low-res texel floor((p − offset) / N) + GUARD_BAND_TEXELS — exactly the inverse cssToWorld picks
 * with. Texel fetches only (no filtering, no Sprite maths).
 *
 * The root framebuffer counts gl_FragCoord.y from the bottom, a render texture from the top (Pixi's
 * row 0 = top), so uFlipY says which one this pass is drawing into.
 *
 * Resource layout, in this order: uComposite, upscaleUniforms.
 */
const fragment = `#version 300 es
${VX_PRECISION}
uniform highp sampler2D uComposite;
/** x = N (device px per texel), y = target height in device px, zw = device-px offset (≤ 0). */
uniform vec4 uUpscale;
uniform float uFlipY;

out vec4 outColor;

void main() {
  ivec2 fragment = ivec2(gl_FragCoord.xy);
  int row = uFlipY > 0.5 ? int(uUpscale.y) - 1 - fragment.y : fragment.y;
  ivec2 device = ivec2(fragment.x, row) - ivec2(uUpscale.zw);
  ivec2 texel = device / max(int(uUpscale.x), 1) + ${glslInt(GUARD_BAND_TEXELS)};
  outColor = texelFetch(uComposite, clamp(texel, ivec2(0), textureSize(uComposite, 0) - 1), 0);
}
`;

export const upscaleShaderSource = (): ShaderSource => ({ vertex: FULLSCREEN_VERTEX, fragment });
