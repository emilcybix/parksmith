import type { ParkSession } from '../game/session/ParkSession';
import type { ViewInfo, WorldEffect, WorldEffectKind } from '../rendering/RendererPort';
import type { AudioVolumes } from './AudioEngine';
import type { NotificationClass } from '../settings/notify';
import type { SoundId } from './synth';
import type { WeatherKind } from '../game/weather/types';
import { BUILD_BY_ID } from '../game/content/catalog';
import { footprintSize } from '../game/types';
import { GAME_CONFIG } from '../game/config';
import { hash32 } from '../game/weather/random';
import { musicStateOf, type MusicState } from './music';

/**
 * Phase 15: the game's side of the mix, pure (no Web Audio here). Which sound a feedback cue plays, how loud and where
 * a world cue is heard, and how loud the ambience beds are for what the camera shows. Reads the live maps; allocates
 * nothing.
 *
 * Proximity: a world sound is heard by its distance to the middle of the screen, measured in half screen widths
 * (`proximity`): full in the middle, about half at the screen's edge, faint just beyond it and silent a screen away,
 * so a coaster on the other side of the map is not heard. Its stereo place follows where it is on screen (`panFor`).
 *
 * Zoom (`zoomMix`): the park fades in and the music out as the camera comes closer; zoomed all the way in only the park
 * is heard, all the way out only the music (an equal-power cross-fade between).
 */

export const CUE_SOUND: Readonly<Record<WorldEffectKind, SoundId>> = {
  'money-gain': 'coin',
  'money-spend': 'spend',
  build: 'build',
  'ride-cycle': 'chime',
  sale: 'sale',
  breakdown: 'clank',
  repair: 'ratchet',
  happy: 'happy',
  unhappy: 'unhappy',
};

/** The sound a toast plays: a refusal or an error buzzes, a progress event chimes, a confirmation is silent. */
export const TOAST_SOUND: Readonly<Record<NotificationClass, SoundId | null>> = {
  alert: 'error',
  important: 'notify',
  routine: null,
};

/** Builds that splash instead of thud: the rides and scenery made of water. */
export const WATER_BUILDS: ReadonlySet<string> = new Set(['splash-rings', 'ripple-fountain']);

/** Cues the player caused: always heard, wherever the camera is. */
const PLAYER_CUES: ReadonlySet<WorldEffectKind> = new Set(['money-gain', 'money-spend', 'build']);

/** Rides whose cycle ends in a splash instead of a chime. */
const CYCLE_SOUND: ReadonlyMap<string, SoundId> = new Map([['splash-rings', 'splash-big'], ['puddle-jumpers', 'splash-small']]);

/** Guests near the middle of the screen (weighted by proximity) for a full crowd, per square half screen width. */
export const CROWD_DENSITY = 0.25;
/** At least this many weighted guests make a full crowd, however close the camera. */
export const MIN_FULL_CROWD = 12;
/** Running rides near the middle of the screen (weighted) for the full machinery bed. */
export const FULL_MACHINERY_RIDES = 3;
/** The zoom fractions where the cross-fade starts (music only below) and ends (park only above). */
export const MIX_ZOOM_OUT = 0.08;
export const MIX_ZOOM_IN = 0.92;
/** A view with no info (the classic renderer) reads as this zoom over the whole map. */
export const DEFAULT_ZOOM = 0.5;

/** The engine volumes from the settings fields. */
export const volumesOf = (settings: {
  masterVolume: number; musicVolume: number; ambienceVolume: number; ridesVolume: number; guestsVolume: number; uiVolume: number;
}): AudioVolumes => ({
  master: settings.masterVolume,
  music: settings.musicVolume,
  ambience: settings.ambienceVolume,
  rides: settings.ridesVolume,
  guests: settings.guestsVolume,
  ui: settings.uiVolume,
});

/** How loud a world sound at (x, y) is heard, in [0, 1]: 1 in the middle of the screen, ~0.6 at its edge, ~0 a screen away. */
export const proximity = (view: Readonly<ViewInfo>, x: number, y: number): number => {
  const d = Math.hypot(x - view.cx, y - view.cy) / (0.9 * Math.max(1, view.halfWidth));
  const d2 = d * d;
  const level = 1 / (1 + d2 * d2);
  return level < 0.01 ? 0 : level;
};

/** Where on the stereo field a world sound at (x, y) sits: -1 at the screen's left edge, 1 at its right (softened). */
export const panFor = (view: Readonly<ViewInfo>, x: number, y: number): number => {
  const across = ((x - view.cx) * view.rightX + (y - view.cy) * view.rightY) / Math.max(1, view.halfWidth);
  return 0.7 * Math.min(1, Math.max(-1, across));
};

/** The world point a sound of this object comes from: its footprint centre (a coaster's station). */
export const objectPoint = (session: ParkSession, objectId: number, out: { x: number; y: number }): boolean => {
  const object = session.world.objects.get(objectId);
  if (!object) return false;
  const definition = BUILD_BY_ID.get(object.definitionId);
  if (definition === undefined || definition.custom === 'coaster') {
    out.x = object.anchor.x;
    out.y = object.anchor.y;
    return true;
  }
  const [w, h] = footprintSize(definition, object.rotation);
  out.x = object.anchor.x + (w - 1) / 2;
  out.y = object.anchor.y + (h - 1) / 2;
  return true;
};

/** The sound a cue plays (wherever it is). */
export const soundForCue = (effect: Readonly<WorldEffect>, session: ParkSession): SoundId => {
  const object = effect.objectId === null ? undefined : session.world.objects.get(effect.objectId);
  if (object !== undefined) {
    if (effect.kind === 'build' && WATER_BUILDS.has(object.definitionId)) return 'splash';
    if (effect.kind === 'ride-cycle') return CYCLE_SOUND.get(object.definitionId) ?? 'chime';
    if (effect.kind === 'breakdown' && session.world.coasters.has(object.id)) return 'crash';
    if (effect.kind === 'sale' && session.shops.services.get(object.id)?.kind === 'toilet') return 'flush';
  }
  return CUE_SOUND[effect.kind];
};

/** How a cue is heard: its sound, level and stereo place. */
export interface CueVoice {
  sound: SoundId;
  gain: number;
  pan: number;
}

const cuePoint = { x: 0, y: 0 };

/**
 * Fills `out` with how a cue is heard and returns it, or null when it is not heard at all. The player's own cues
 * (money, builds) are always heard in full and centred; a world cue by its proximity to the middle of the screen.
 */
export const cueVoice = (effect: Readonly<WorldEffect>, view: Readonly<ViewInfo>, session: ParkSession, out: CueVoice): CueVoice | null => {
  out.sound = soundForCue(effect, session);
  if (PLAYER_CUES.has(effect.kind)) {
    out.gain = 1;
    out.pan = 0;
    return out;
  }
  if (effect.objectId !== null) {
    if (!objectPoint(session, effect.objectId, cuePoint)) return null;
  } else {
    cuePoint.x = effect.x;
    cuePoint.y = effect.y;
  }
  out.gain = proximity(view, cuePoint.x, cuePoint.y);
  out.pan = panFor(view, cuePoint.x, cuePoint.y);
  return out.gain > 0 ? out : null;
};

/** The zoom mix (see the header): the park's and the music's levels. The start screen is all music. */
export const zoomMix = (zoom: number, menu: boolean, out: { park: number; music: number }): { park: number; music: number } => {
  if (menu) {
    out.park = 0;
    out.music = 1;
    return out;
  }
  const t = Math.min(1, Math.max(0, (zoom - MIX_ZOOM_OUT) / (MIX_ZOOM_IN - MIX_ZOOM_OUT)));
  out.park = Math.sin((t * Math.PI) / 2);
  out.music = Math.cos((t * Math.PI) / 2);
  if (out.park < 1e-6) out.park = 0;
  if (out.music < 1e-6) out.music = 0;
  return out;
};

/**
 * The storm bolt whose flash begins in (fromSeconds, toSeconds] of a storm slot, or 0: the same cells and offsets as
 * `stormFlashAt`, so the thunder follows the lightning the sky draws.
 */
export const thunderBetween = (flashSeed: number, fromSeconds: number, toSeconds: number): number => {
  if (flashSeed === 0 || !(toSeconds > fromSeconds) || toSeconds - fromSeconds > 60) return 0;
  const { slotSeconds, chancePerSlot, durationSeconds, flickerGapSeconds } = GAME_CONFIG.weather.flash;
  const span = durationSeconds + flickerGapSeconds + durationSeconds / 2;
  for (let cell = Math.max(0, Math.floor(fromSeconds / slotSeconds)); cell <= Math.floor(toSeconds / slotSeconds); cell += 1) {
    if (hash32(flashSeed, cell) / 4294967296 >= chancePerSlot) continue;
    const start = cell * slotSeconds + hash32(flashSeed, cell, 1) / 4294967296 * (slotSeconds - span);
    if (start > fromSeconds && start <= toSeconds) return hash32(flashSeed, cell, 2) || 1;
  }
  return 0;
};

/** Whether a bolt's thunder is the near crack or the far rumble: stronger storms are nearer. */
export const thunderIsNear = (boltSeed: number, intensity: number): boolean => (boltSeed % 1000) / 1000 < 0.2 + 0.4 * intensity;

/**
 * The bed levels in [0, 1] for what the camera shows: the crowd follows the guests near the middle of the screen (a
 * density, so it is as full zoomed in on a busy plaza as zoomed out over a busy park), the machinery the running rides
 * near it. Paused: no machinery and half the crowd.
 */
export const ambienceFor = (
  view: Readonly<ViewInfo>,
  session: ParkSession,
  paused: boolean,
): { crowd: number; machinery: number } => {
  let guests = 0;
  for (const guest of session.guests.guests.values()) guests += proximity(view, guest.position.x, guest.position.y);
  let rides = 0;
  if (!paused) {
    for (const ride of session.rides.rides.values()) {
      if (ride.status !== 'running' || !objectPoint(session, ride.objectId, cuePoint)) continue;
      rides += proximity(view, cuePoint.x, cuePoint.y);
    }
  }
  const fullCrowd = Math.max(MIN_FULL_CROWD, CROWD_DENSITY * view.halfWidth * view.halfWidth);
  return {
    crowd: Math.min(1, guests / fullCrowd) * (paused ? 0.5 : 1),
    machinery: Math.min(1, rides / FULL_MACHINERY_RIDES),
  };
};

/**
 * The beds that follow the time of day and the sky, in [0, 1]: rain in rain and storms (fuller the harder it rains),
 * the daytime park bed by day and the crickets by night, each pushed down by the rain. The start screen has none.
 */
export const atmosphereFor = (
  menu: boolean,
  night: boolean,
  weather: WeatherKind,
  intensity: number,
  out: { day: number; rain: number; night: number },
): { day: number; rain: number; night: number } => {
  const strength = Math.min(1, Math.max(0, intensity));
  const rain = menu ? 0 : weather === 'storm' ? 0.8 + 0.2 * strength : weather === 'rain' ? 0.5 + 0.5 * strength : 0;
  out.rain = rain;
  out.day = menu || night ? 0 : 1 - 0.6 * rain;
  out.night = menu || !night ? 0 : 1 - 0.7 * rain;
  return out;
};

/** A view of the whole map at the default zoom (before the renderer answers, or for the classic renderer). */
export const wholeMapView = (session: ParkSession, out: ViewInfo): ViewInfo => {
  out.zoom = DEFAULT_ZOOM;
  out.x0 = 0;
  out.y0 = 0;
  out.x1 = session.world.width - 1;
  out.y1 = session.world.height - 1;
  out.cx = session.world.width / 2;
  out.cy = session.world.height / 2;
  out.halfWidth = Math.max(session.world.width, session.world.height) / 2;
  out.rightX = 1;
  out.rightY = 0;
  return out;
};

/** Phase 47: the produced music's state: the start screen, night or day, and how lively the whole park is. */
export const musicStateFor = (session: ParkSession, menu: boolean, night: boolean): MusicState => {
  let runningRides = 0;
  for (const ride of session.rides.rides.values()) if (ride.status === 'running') runningRides += 1;
  return musicStateOf({ menu, night, guests: session.guests.guests.size, runningRides });
};
