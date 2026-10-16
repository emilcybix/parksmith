import type { CompositeVariant } from './shaders/composite';
import type { WeatherTier } from './shaders/compositeWeather';

/**
 * Reading a GPU startup failure: which voxel program the driver rejected a draw of. boot.ts's call
 * trace writes `[program voxel-composite-vertex]` after a failing draw (the name Pixi puts in the
 * program's first attached shader, which is the vertex stage), and that line ends up in the message
 * the player and `__voxelFailure` show. Keeping the writer (`programTag`) and the reader
 * (`failedProgramsOf`) side by side means the message format stays the single source of truth —
 * VoxelRenderer decides from it whether the lite composite can rescue a failed startup.
 */

/** The GlProgram name of the composite pass (programs.ts names every program `voxel-<name>`). */
export const COMPOSITE_PROGRAM_NAME = 'voxel-composite';

/** The tag boot.ts appends to a failing draw call in its trace. */
export const programTag = (shaderName: string): string => ` [program ${shaderName}]`;

/** Every program a failure message names, without Pixi's `-vertex` / `-fragment` stage suffix, once each. */
export const failedProgramsOf = (error: unknown): string[] => {
  if (!(error instanceof Error)) return [];
  const names = new Set<string>();
  for (const match of error.message.matchAll(/\[program ([\w-]+)\]/g)) {
    // Pixi names a program's shaders `<name>-vertex` / `<name>-fragment` and suffixes a name it has seen before
    // with `-2`, `-3`... (every rebuild of the pipeline in the fallback chain): both are stripped.
    names.add(match[1].replace(/-(?:vertex|fragment)(?:-\d+)?$/, ''));
  }
  return [...names];
};

/**
 * Whether the composite is the ONLY program the failure names — the one case the lite composite
 * can fix. A failure that names nothing (a link error, an incomplete framebuffer) or any other
 * program has a cause the lite shader does not touch, so retrying would only repeat it.
 */
export const failedOnlyInComposite = (error: unknown): boolean => {
  const names = failedProgramsOf(error);
  return names.length > 0 && names.every((name) => name === COMPOSITE_PROGRAM_NAME);
};

/** The programs whose loss the game survives (see degradePlanFor). */
export const LIGHT_PROGRAM_NAME = 'voxel-lightPass';
export const SHADOW_PROGRAM_NAME = 'voxel-figureDither';
export const SEE_THROUGH_PROGRAM_NAME = 'voxel-worldCut';
/** The translucent see-through's two programs: losing either loses the translucent rung, not the cutaway. */
export const FRONT_WORLD_PROGRAM_NAME = 'voxel-worldFront';
export const FRONT_COMPOSITE_PROGRAM_NAME = 'voxel-compositeFront';

/**
 * The programs of a view-turn build that carry the view code (Phase 26): every geometry program (the
 * see-through's world-cut and front layer included) and the light pass. A failure naming one of them in a
 * view-turn build may be the view code's doing, so it is retried once with `viewTurn: false` first.
 */
export const VIEW_TURN_PROGRAM_NAMES: readonly string[] = [
  'voxel-worldOpaque',
  'voxel-worldDither',
  'voxel-figureOpaque',
  'voxel-figureDither',
  LIGHT_PROGRAM_NAME,
  SEE_THROUGH_PROGRAM_NAME,
  FRONT_WORLD_PROGRAM_NAME,
];

/**
 * The composite programs carry the view code (the inverse map of the cloud shadows and puddles) only in a
 * build of the full composite with the full weather tier; the front composite shares that ground hook.
 */
export const VIEW_TURN_COMPOSITE_PROGRAM_NAMES: readonly string[] = [COMPOSITE_PROGRAM_NAME, FRONT_COMPOSITE_PROGRAM_NAME];

/** Whether a composite rung's programs carry the view code in a view-turn build (shaders/composite.ts `viewWorld`). */
export const compositeCarriesViewCode = (rung: CompositeRung): boolean => rung.variant === 'full' && rung.tier === 'full';

/** What a failed build was built with, as far as the view code is concerned. */
export interface DegradeContext {
  /** The build compiled the view code (VoxelGpuOptions.viewTurn). */
  viewTurn: boolean;
  /** Its composite programs carried it too (compositeCarriesViewCode of the rung); default false. */
  compositeView?: boolean;
}

/** What to switch off when a startup failure names only programs the game can do without. */
export interface DegradePlan {
  /**
   * A program carrying the view code failed in a view-turn build: rebuild once with `viewTurn: false` (today's
   * exact sources; the map can then no longer be turned, `no-view-rotation`). When true, every other field is
   * false: the retry may recover everything else. If the retry fails too, the failure was not (only) the view
   * code's: VoxelRenderer plans the retry's failure without the view context and walks that chain with the view
   * code back on first, then without it.
   */
  viewRotation: boolean;
  /** The composite failed: rebuild with the lite one (which also draws no light pass). */
  composite: boolean;
  /** The light pass failed: no light pools. */
  lights: boolean;
  /** The figure-dither program failed: no figure shadow decals (it draws nothing else). */
  shadows: boolean;
  /** The world-cut program failed: no see-through cutaway (it draws nothing else). */
  seeThrough: boolean;
  /** A front-layer program failed: the cutaway falls back from the translucent rung to the dither rung. */
  translucent: boolean;
}

/**
 * Which optional parts a failure is confined to: the composite (→ lite), the light pass (→ no
 * light pools), the figure shadow decals (→ no shadows) and the see-through cutaway (→ none). Null when it names nothing, or any other
 * program (terrain, figures, the ghost, the upscale: nothing to give up), because rebuilding
 * without these would only repeat it; the caller then falls back to the classic renderer.
 * In a view-turn build (`context.viewTurn`), a failure confined to optional programs and programs carrying the
 * view code, naming at least one of the latter, plans the `viewTurn: false` retry instead (Phase 26).
 */
export const degradePlanFor = (error: unknown, context: DegradeContext = { viewTurn: false }): DegradePlan | null => {
  const names = failedProgramsOf(error);
  if (names.length === 0) return null;
  const carriesView = (name: string): boolean => context.viewTurn && (VIEW_TURN_PROGRAM_NAMES.includes(name)
    || (context.compositeView === true && VIEW_TURN_COMPOSITE_PROGRAM_NAMES.includes(name)));
  const optional = [COMPOSITE_PROGRAM_NAME, LIGHT_PROGRAM_NAME, SHADOW_PROGRAM_NAME, SEE_THROUGH_PROGRAM_NAME, FRONT_WORLD_PROGRAM_NAME, FRONT_COMPOSITE_PROGRAM_NAME];
  // A required program the view code does not touch (the upscale, the ghost...) cannot be rescued by anything.
  if (!names.every((name) => optional.includes(name) || carriesView(name))) return null;
  if (names.some(carriesView)) {
    return { viewRotation: true, composite: false, lights: false, shadows: false, seeThrough: false, translucent: false };
  }
  return {
    viewRotation: false,
    composite: names.includes(COMPOSITE_PROGRAM_NAME),
    lights: names.includes(LIGHT_PROGRAM_NAME),
    shadows: names.includes(SHADOW_PROGRAM_NAME),
    seeThrough: names.includes(SEE_THROUGH_PROGRAM_NAME),
    translucent: names.includes(FRONT_WORLD_PROGRAM_NAME) || names.includes(FRONT_COMPOSITE_PROGRAM_NAME),
  };
};

/** The `window.__voxelDegraded` value of a plan that was applied (what the player lost, for support). */
export const degradedLabelOf = (plan: DegradePlan, requestedLite: boolean): string => {
  const parts: string[] = [];
  if (plan.viewRotation) parts.push('no-view-rotation');
  if (plan.composite && !requestedLite) parts.push('composite-lite');
  if (plan.lights && !plan.composite) parts.push('no-lights');
  if (plan.shadows) parts.push('no-shadows');
  if (plan.seeThrough) parts.push('no-seethrough');
  else if (plan.translucent) parts.push('no-translucent-seethrough');
  return parts.join('+');
};

/**
 * One build of the composite: which variant, how much of the weather pass it compiles, and whether it
 * is built for the translucent see-through (the front layer's programs, the mix in the composite).
 */
export interface CompositeRung {
  variant: CompositeVariant;
  tier: WeatherTier;
  translucent: boolean;
}

/**
 * What to try, in order, after a composite that failed as `failed` (Phase 20 fallback chain):
 * first, in a translucent build, the SAME composite without the translucent mix (the newest code in that
 * shader), then the same composite without the weather pass, then the lite composite with rain only, then
 * the lite composite without weather. The lite composite never builds the front layer.
 *   full+translucent -> full -> full, no weather -> lite+rain -> lite, no weather
 * A tier that is already `none` is skipped; lite never goes back to full.
 */
export const compositeRungsAfter = (failed: CompositeRung): CompositeRung[] => {
  const rungs: CompositeRung[] = [];
  if (failed.translucent) rungs.push({ variant: failed.variant, tier: failed.tier, translucent: false });
  if (failed.tier !== 'none') rungs.push({ variant: failed.variant, tier: 'none', translucent: false });
  if (failed.variant === 'full') {
    rungs.push({ variant: 'lite', tier: failed.tier === 'none' ? 'none' : 'rain', translucent: false });
    if (failed.tier !== 'none') rungs.push({ variant: 'lite', tier: 'none', translucent: false });
  }
  return rungs;
};

/** The see-through rung the player asked for (`&voxelSeeThrough=`, default alpha). */
export type SeeThroughLook = 'alpha' | 'dither' | 'off';

/** `&voxelSeeThrough=`: `dither` and `off` are themselves; anything else, missing or unknown, is the default `alpha`. */
export const parseSeeThroughLook = (value: string | null): SeeThroughLook => (value === 'dither' || value === 'off' ? value : 'alpha');

/** One retry of a startup failure that names no program: whether it keeps the translucent rung and the cutaway. */
export interface SeeThroughRung {
  translucent: boolean;
  /** True: do not create the cut shaders at all (the `no-seethrough` rung). */
  skipSeeThrough: boolean;
}

/**
 * What to try after a startup failure that names no program (a link error cannot be tied to one draw): the
 * see-through programs are the newest ones, so step down one rung at a time: translucent -> dither -> off.
 * A failure that names a program is planned by degradePlanFor instead (empty here), and a start that
 * has no see-through to give up (`off`) has nothing to try.
 */
export const seeThroughRungsFor = (error: unknown, mode: SeeThroughLook): readonly SeeThroughRung[] => {
  if (failedProgramsOf(error).length > 0) return [];
  if (mode === 'alpha') return [{ translucent: false, skipSeeThrough: false }, { translucent: false, skipSeeThrough: true }];
  if (mode === 'dither') return [{ translucent: false, skipSeeThrough: true }];
  return [];
};

/**
 * The `window.__voxelDegraded` value of a startup that settled on `applied` after asking for
 * `requested`: `no-view-rotation` (the map cannot be turned), `composite-lite`, `no-weather`, `no-lights`, `no-shadows`, `no-translucent-seethrough` (the
 * cutaway fell back to the dither rung) or `no-seethrough`, joined with `+`.
 */
export const degradedLabelFor = (plan: DegradePlan, requested: CompositeRung, applied: CompositeRung): string => {
  const parts: string[] = [];
  if (plan.viewRotation) parts.push('no-view-rotation');
  if (applied.variant === 'lite' && requested.variant !== 'lite') parts.push('composite-lite');
  if (applied.tier === 'none' && requested.tier !== 'none') parts.push('no-weather');
  if (plan.lights && applied.variant === 'full') parts.push('no-lights');
  if (plan.shadows) parts.push('no-shadows');
  if (plan.seeThrough) parts.push('no-seethrough');
  else if (requested.translucent && !applied.translucent) parts.push('no-translucent-seethrough');
  return parts.join('+');
};

/** Adds `label` to a `+` joined degradation string once (idempotent); the runtime weather failure uses it. */
export const appendDegradedLabel = (current: string | undefined, label: string): string => {
  const parts = current === undefined || current === '' ? [] : current.split('+');
  if (!parts.includes(label)) parts.push(label);
  return parts.join('+');
};
