import { parseWeatherFlags, type WeatherLookFlags } from '../rendering/weatherLook';
import type { RendererKind } from '../rendering/RendererPort';
import { parseSeeThroughLook, type SeeThroughLook } from '../rendering/voxel/gpu/glFailure';
import type { LightPresetName } from '../rendering/voxel/lightPresets';
import { getSettings } from '../settings/settingsStore';
import type { GraphicsDetail, RendererPreference } from '../settings/schema';

/**
 * Renderer selection and the voxel renderer's measurement switches, all read once from the URL when
 * this module loads (switching takes a reload, like `?dev=1`).
 *
 * Unlike the developer flag, none of these is remembered in localStorage, so a choice made while
 * debugging can never stick to a player's browser. A plain URL gets the voxel renderer, which is the
 * game's main renderer.
 *
 * - `?renderer=classic|voxel` — RENDERER_KIND: the classic Pixi renderer or the voxel one; without the flag the
 *   player's Graphics setting decides (voxel by default). The voxel renderer also falls back to the classic one by
 *   itself when it cannot run.
 * - `&light=day|dusk|night` — LIGHT_OVERRIDE: pins the voxel look to one preset (lightPresets.ts),
 *   ignoring the time of day completely. Without it the look follows the park clock (Phase 20).
 *   LIGHT_PRESET is the preset of the very first frame: the override, else 'day'.
 * - `&time=<fraction|hour>` — TIME_OVERRIDE: pins the LOOK to a time of day, as a clock fraction
 *   (`0.75`: needs a decimal point, or is exactly `0`) or in hours (`18`, `18:30`; so `1` is 01:00).
 *   It is a test aid: the HUD clock keeps showing the park's real time, and `&light=` wins over it.
 * - `&zoom=N` — ZOOM_OVERRIDE: a starting zoom of N device px per texel instead of the per-screen
 *   default, clamped by the camera to the levels the screen allows. For repeatable measurements.
 * - `&voxelAllowSoftware=1` — ALLOW_SOFTWARE_GPU: run the voxel renderer on a software rasteriser
 *   (SwiftShader, llvmpipe) instead of falling back. Headless test browsers have nothing else.
 * - `&voxelGpu=min` — VOXEL_GPU_MIN: harness-only. The same CPU work, uploads and draw sequence, with
 *   draws clamped to one box and tiny targets, so frame-rate gates measure the main thread even on a
 *   software GPU.
 * - `&voxelTiming=1` — VOXEL_TIMING: per-pass GPU milliseconds (EXT_disjoint_timer_query_webgl2, where the browser
 *   offers it), the zoom and the low-res target size in the performance overlay (the ⌁ button). For measuring
 *   what a zoom level costs on a real GPU (Phase 55).
 * - `&voxelDebug=1` — VOXEL_DEBUG: checks the GL error queue after every WebGL call and logs the first
 *   failing call with its name and arguments. Slow; for finding which call a driver rejects.
 * - `&weather=sunny|hot|cloudy|rain|storm` (+ `&wintensity=0..1`, default 0.8) — WEATHER_FLAGS.pin: pins the
 *   weather PRESENTATION only (the simulation, the HUD chip and Park Pulse keep the real weather; the pin
 *   wins over the sandbox weather-off switch). `&wclock=<seconds>` freezes the weather animation clock for
 *   deterministic screenshots, `&wmotion=run` keeps it animating while paused, `&wflash=0..1` holds a
 *   constant lightning level. Parsed by parseWeatherFlags (rendering/weatherLook.ts); junk is ignored.
 * - `&voxelSeeThrough=alpha|dither|off` — VOXEL_SEE_THROUGH: how the voxel renderer opens the view onto a build
 *   site behind a building. `alpha` (default; anything else unknown too) draws the buildings in the way
 *   translucent (SEE_THROUGH.OCCLUDER_OPACITY, rendering/seeThrough.ts) and shows the site clearly through
 *   them; `dither` is the earlier look, a 1-texel screen door cut out of them; `off` has no cutaway at all.
 *   The renderer falls back alpha -> dither -> off by itself when a GPU refuses a program of the effect.
 * - `&voxelWeather=off|rain` — VOXEL_WEATHER: voxel diagnostics, start the weather pass at no effects
 *   (`off`) or at the cheap rain-and-flash subset (`rain`).
 */
export interface RendererFlags {
  kind: RendererKind;
  light: LightPresetName | null;
  /** Clock fraction in [0, 1), 0 = midnight, or null. */
  time: number | null;
  zoom: number | null;
  allowSoftware: boolean;
  gpuMin: boolean;
  /** Phase 55: `&voxelTiming=1` shows the GPU time per pass and the low-res target in the performance overlay. */
  timing: boolean;
  debug: boolean;
  weather: Readonly<Partial<WeatherLookFlags>>;
  voxelWeather: VoxelWeatherFlag;
  voxelSeeThrough: VoxelSeeThroughFlag;
  /** Phase 41 step 0 (spike): `&camera3d=1` (or `orbit`) orbits a perspective camera; `low` glides low across the map. */
  camera3d: Camera3dFlag;
}

export type Camera3dFlag = 'orbit' | 'low' | null;

export type VoxelWeatherFlag = 'off' | 'rain' | null;

/** The see-through look of the voxel renderer (see the flag list above). */
export type VoxelSeeThroughFlag = SeeThroughLook;

const DEFAULT_FLAGS: RendererFlags = {
  kind: 'voxel',
  light: null,
  time: null,
  zoom: null,
  allowSoftware: false,
  gpuMin: false,
  timing: false,
  debug: false,
  weather: {},
  voxelWeather: null,
  camera3d: null,
  voxelSeeThrough: 'alpha',
};

const LIGHT_PRESET_NAMES: readonly LightPresetName[] = ['day', 'dusk', 'night'];

const isLightPresetName = (value: string | null): value is LightPresetName =>
  LIGHT_PRESET_NAMES.includes(value as LightPresetName);

/** A positive whole number of device px per texel, or null for anything else. */
const parseZoom = (value: string | null): number | null => {
  if (value === null || !/^\d+$/.test(value)) return null;
  const zoom = Number(value);
  return zoom >= 1 && Number.isSafeInteger(zoom) ? zoom : null;
};

/**
 * `0.75` (a decimal point, or exactly `0`) is a fraction of the day; `18` and `18:30` are clock
 * hours (0..23, minutes 0..59). Anything else, out-of-range values included, is null.
 */
export const parseTimeFlag = (value: string | null): number | null => {
  if (value === null) return null;
  if (value === '0') return 0;
  if (/^\d*\.\d+$/.test(value)) {
    const fraction = Number(value);
    return fraction >= 0 && fraction < 1 ? fraction : null;
  }
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return (hours * 60 + minutes) / 1440;
};

const parseVoxelWeather = (value: string | null): VoxelWeatherFlag => (value === 'off' || value === 'rain' ? value : null);

const parseRendererFlags = (search: string): RendererFlags => {
  const parameters = new URLSearchParams(search);
  const light = parameters.get('light');
  return {
    kind: rendererKindOf(parameters.get('renderer'), bootSetting().renderer),
    light: isLightPresetName(light) ? light : null,
    time: parseTimeFlag(parameters.get('time')),
    zoom: parseZoom(parameters.get('zoom')),
    allowSoftware: parameters.get('voxelAllowSoftware') === '1',
    gpuMin: parameters.get('voxelGpu') === 'min',
    timing: parameters.get('voxelTiming') === '1',
    debug: parameters.get('voxelDebug') === '1',
    weather: parseWeatherFlags(search),
    voxelWeather: parseVoxelWeather(parameters.get('voxelWeather')),
    voxelSeeThrough: parseSeeThroughLook(parameters.get('voxelSeeThrough')),
    camera3d: (() => {
      const value = parameters.get('camera3d');
      return value === '1' || value === 'orbit' ? 'orbit' : value === 'low' ? 'low' : null;
    })(),
  };
};

/** The settings as the page started (a change applies after a reload); defaults where settings cannot be read. */
const bootSetting = (): { renderer: RendererPreference; graphicsDetail: GraphicsDetail } => {
  try {
    const settings = getSettings();
    return { renderer: settings.renderer, graphicsDetail: settings.graphicsDetail };
  } catch {
    return { renderer: 'voxel', graphicsDetail: 'full' };
  }
};

/** The URL flag wins (`classic` or `voxel`); otherwise the setting. */
export const rendererKindOf = (flag: string | null, setting: RendererPreference): RendererKind => (
  flag === 'classic' ? 'classic' : flag === 'voxel' ? 'voxel' : setting
);

/** The Graphics settings this page started with: the settings panel says "after a reload" when they differ. */
export const BOOT_GRAPHICS: Readonly<{ renderer: RendererPreference; graphicsDetail: GraphicsDetail }> = Object.freeze(bootSetting());

const readRendererFlags = (): RendererFlags => {
  if (typeof window === 'undefined') return DEFAULT_FLAGS;
  try {
    return parseRendererFlags(window.location.search);
  } catch {
    // A URL the parser cannot read must never stop the game from starting.
    return DEFAULT_FLAGS;
  }
};

const FLAGS = readRendererFlags();

export const RENDERER_KIND: RendererKind = FLAGS.kind;
export const LIGHT_OVERRIDE: LightPresetName | null = FLAGS.light;
export const LIGHT_PRESET: LightPresetName = FLAGS.light ?? 'day';
export const TIME_OVERRIDE: number | null = FLAGS.time;
export const ZOOM_OVERRIDE: number | null = FLAGS.zoom;
export const ALLOW_SOFTWARE_GPU: boolean = FLAGS.allowSoftware;
export const VOXEL_GPU_MIN: boolean = FLAGS.gpuMin;
export const VOXEL_TIMING: boolean = FLAGS.timing;
export const VOXEL_DEBUG: boolean = FLAGS.debug;
/** Presentation-only weather pins and test aids (reducedMotion is read by the renderer, not the URL). */
export const WEATHER_FLAGS: Readonly<Partial<WeatherLookFlags>> = FLAGS.weather;
export const VOXEL_WEATHER: VoxelWeatherFlag = FLAGS.voxelWeather;
export const VOXEL_SEE_THROUGH: VoxelSeeThroughFlag = FLAGS.voxelSeeThrough;
/** Phase 41 step 0: the perspective camera spike (developer flag; presentation only). */
export const CAMERA_3D: Camera3dFlag = FLAGS.camera3d;
