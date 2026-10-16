import type { ParkSession } from '../game/session/ParkSession';
import type { ViewInfo, WorldEffect, WorldEffectKind } from '../rendering/RendererPort';
import type { AudioVolumes } from './AudioEngine';
import type { SoundId } from './synth';

/**
 * Phase 15: the game's side of the mix, pure (no Web Audio here). Which sound a feedback cue plays, whether a world cue
 * is on screen (a ride chiming off-screen is not heard), and how loud the two ambience beds are for what the camera
 * shows: the crowd murmur follows the guests in view, the machinery follows the running rides in view, both louder
 * the closer the camera is. Paused: no machinery. Reads the live maps; allocates nothing.
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

/** Cues the player caused: always heard, wherever the camera is. */
const PLAYER_CUES: ReadonlySet<WorldEffectKind> = new Set(['money-gain', 'money-spend', 'build']);

/** Guests in view for a full crowd bed, at the closest zoom; running rides in view for full machinery. */
export const FULL_CROWD_GUESTS = 120;
export const FULL_MACHINERY_RIDES = 4;
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

const inside = (view: Readonly<ViewInfo>, x: number, y: number): boolean => (
  x >= view.x0 - 0.5 && x <= view.x1 + 0.5 && y >= view.y0 - 0.5 && y <= view.y1 + 0.5
);

/** The sound a cue plays, or null when it is a world cue the camera does not show. */
export const soundForCue = (effect: Readonly<WorldEffect>, view: Readonly<ViewInfo>, session: ParkSession): SoundId | null => {
  if (PLAYER_CUES.has(effect.kind)) return CUE_SOUND[effect.kind];
  let x = effect.x;
  let y = effect.y;
  if (effect.objectId !== null) {
    const object = session.world.objects.get(effect.objectId);
    if (!object) return null;
    x = object.anchor.x;
    y = object.anchor.y;
  }
  return inside(view, x, y) ? CUE_SOUND[effect.kind] : null;
};

/** The two bed levels in [0, 1] for what the camera shows. */
export const ambienceFor = (
  view: Readonly<ViewInfo>,
  session: ParkSession,
  paused: boolean,
): { crowd: number; machinery: number } => {
  let guests = 0;
  for (const guest of session.guests.guests.values()) if (inside(view, guest.position.x, guest.position.y)) guests += 1;
  let rides = 0;
  if (!paused) {
    for (const ride of session.rides.rides.values()) {
      if (ride.status !== 'running') continue;
      const object = session.world.objects.get(ride.objectId);
      if (object && inside(view, object.anchor.x, object.anchor.y)) rides += 1;
    }
  }
  const closeness = 0.4 + 0.6 * Math.min(1, Math.max(0, view.zoom));
  return {
    crowd: Math.min(1, guests / FULL_CROWD_GUESTS) * closeness * (paused ? 0.5 : 1),
    machinery: Math.min(1, rides / FULL_MACHINERY_RIDES) * closeness,
  };
};

/** A view of the whole map at the default zoom (before the renderer answers, or for the classic renderer). */
export const wholeMapView = (session: ParkSession, out: ViewInfo): ViewInfo => {
  out.zoom = DEFAULT_ZOOM;
  out.x0 = 0;
  out.y0 = 0;
  out.x1 = session.world.width - 1;
  out.y1 = session.world.height - 1;
  return out;
};
