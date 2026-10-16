import { GlProgram } from 'pixi.js';
import { compositeShaderSource, type CompositeVariant } from './shaders/composite';
import type { WeatherTier } from './shaders/compositeWeather';
import { figureShaderSource } from './shaders/figure';
import { lightPassShaderSource } from './shaders/lightPass';
import { upscaleShaderSource } from './shaders/upscale';
import { worldShaderSource } from './shaders/world';
import type { ShaderSource } from './shaders/world';

/**
 * Every GLSL program of the voxel pipeline, one per resource layout (Pixi generates one sync
 * function per program, so two layouts on one program crash, and a program is never shared with a
 * Mesh). Only programs whose name ends in `Dither`, and `worldCut` and `worldFront`, may contain `discard`.
 */
export type VoxelProgramName =
  | 'worldOpaque'
  | 'worldDither'
  | 'worldCut'
  | 'worldFront'
  | 'figureOpaque'
  | 'figureDither'
  | 'lightPass'
  | 'composite'
  | 'compositeFront'
  | 'upscale';

export const VOXEL_PROGRAM_NAMES: readonly VoxelProgramName[] = [
  'worldOpaque',
  'worldDither',
  'worldCut',
  'worldFront',
  'figureOpaque',
  'figureDither',
  'lightPass',
  'composite',
  'compositeFront',
  'upscale',
];

/** The programs of the translucent see-through only (the front layer): dropped with that feature, never needed without it. */
export const TRANSLUCENT_PROGRAM_NAMES: readonly VoxelProgramName[] = ['worldFront', 'compositeFront'];

/**
 * Pure: the GLSL of every program (Node tests inspect it; nothing here touches the GPU).
 * `compositeVariant` and `weatherTier` only change the `composite` program (see compositeShaderSource).
 * `viewTurn` (Phase 26, default on) compiles the view-rotation code (VX_VIEW) into the geometry programs, the light
 * pass and the composite's ground hook; false is the pre-rotation source of every program, byte for byte
 * (the `no-view-rotation` rung, pinned by shaders.test.ts).
 */
export const voxelProgramSource = (
  name: VoxelProgramName,
  compositeVariant: CompositeVariant = 'full',
  weatherTier?: WeatherTier,
  translucent = false,
  viewTurn = true,
): ShaderSource => {
  switch (name) {
    case 'worldOpaque': return worldShaderSource('opaque', viewTurn);
    case 'worldDither': return worldShaderSource('dither', viewTurn);
    case 'worldCut': return worldShaderSource('cut', viewTurn);
    case 'worldFront': return worldShaderSource('front', viewTurn);
    case 'figureOpaque': return figureShaderSource('opaque', viewTurn);
    case 'figureDither': return figureShaderSource('dither', viewTurn);
    case 'lightPass': return lightPassShaderSource(viewTurn);
    case 'composite': return compositeShaderSource(compositeVariant, weatherTier, { translucent, viewTurn });
    case 'compositeFront': return compositeShaderSource('full', weatherTier, { front: true, viewTurn });
    case 'upscale': return upscaleShaderSource();
  }
};

/** The GlPrograms in use; the front-layer ones exist only in a translucent pipeline. */
export type VoxelPrograms = Readonly<Record<Exclude<VoxelProgramName, 'worldFront' | 'compositeFront'>, GlProgram>> & Readonly<{ worldFront?: GlProgram; compositeFront?: GlProgram }>;

/**
 * Builds the GlPrograms. Browser only: `new GlProgram` probes a WebGL context through the DOM, so
 * this must never run at module load or in anything a Node test imports and calls.
 */
export const createVoxelPrograms = (compositeVariant: CompositeVariant = 'full', weatherTier?: WeatherTier, translucent = false, viewTurn = true): VoxelPrograms => {
  const programs: Partial<Record<VoxelProgramName, GlProgram>> = {};
  for (const name of VOXEL_PROGRAM_NAMES) {
    // Never compiled (and never destroyed) without the translucent see-through: a driver that refuses
    // them must not even be offered the sources.
    if (!translucent && TRANSLUCENT_PROGRAM_NAMES.includes(name)) continue;
    const { vertex, fragment } = voxelProgramSource(name, compositeVariant, weatherTier, translucent, viewTurn);
    programs[name] = new GlProgram({
      name: `voxel-${name}`,
      vertex,
      fragment,
      preferredVertexPrecision: 'highp',
      preferredFragmentPrecision: 'highp',
    });
  }
  return programs as VoxelPrograms;
};
