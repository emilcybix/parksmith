/**
 * Phase 47: produced music, pure (no Web Audio here). The game ships no music of its own beyond the synthesised loop;
 * a composer drops audio files in `public/music/` and lists them in `public/music/manifest.json` (see MUSIC.md). A
 * track is one to four stems of equal length that start together and loop together; the stems are vertical layers,
 * each audible from an intensity of the park upward, so a busy park plays more of the arrangement than an empty one.
 *
 * Three contexts pick the track: the start screen (`menu`), the park by day (`park`) and the park at night (`night`).
 * A missing context falls back (menu and night to park); with no park track the synthesised loop keeps playing.
 */

export type MusicContext = 'menu' | 'park' | 'night';
export const MUSIC_CONTEXTS: readonly MusicContext[] = ['menu', 'park', 'night'];

export interface MusicStem {
  /** Files of the same audio in different formats, best first; the first the browser can play is used. */
  readonly files: readonly string[];
  /** The park intensity (0-1) from which the stem is fully audible; it fades in over the RAMP below that. */
  readonly from: number;
}

export interface MusicTrack {
  readonly id: string;
  readonly context: MusicContext;
  readonly stems: readonly MusicStem[];
  /** Loudness trim for the whole track (0-2, default 1), so tracks mastered differently sit level. */
  readonly gain: number;
  /** Loop points in seconds (an intro before `loopStart` plays once; no `loopEnd`: to the end); absent: the whole file loops. */
  readonly loopStart?: number;
  readonly loopEnd?: number;
}

export interface MusicManifest {
  readonly tracks: readonly MusicTrack[];
}

export interface MusicState {
  readonly context: MusicContext;
  /** How lively the park is, 0-1: picks how many layers play. */
  readonly intensity: number;
}

export const MAX_STEMS = 4;
/** The intensity span over which a layer fades in below its `from`. */
export const LAYER_RAMP = 0.15;
/** Guests in the park and running rides that make a full-intensity park. */
export const FULL_PARK_GUESTS = 400;
export const FULL_PARK_RIDES = 8;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A file name inside `public/music/`: no folders up, no absolute paths or URLs. */
const safeFile = (value: unknown): string | null => (
  typeof value === 'string' && /^[\w][\w.\- /]*$/.test(value) && !value.includes('..') ? value : null
);

const parseStem = (raw: unknown, index: number, count: number): MusicStem | null => {
  if (!isRecord(raw)) return null;
  const list = Array.isArray(raw.file) ? raw.file : [raw.file];
  const files = list.map(safeFile).filter((file): file is string => file !== null);
  if (files.length === 0) return null;
  // Unset `from`: the layers spread evenly, the first always on.
  const from = typeof raw.from === 'number' ? clamp01(raw.from) : index / count;
  return { files, from };
};

const positive = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * The manifest from its JSON, forgiving: an entry that does not make sense is dropped, never thrown on, so a typo in
 * one track cannot silence the others. Anything that is not a manifest at all reads as no tracks.
 */
export const parseMusicManifest = (raw: unknown): MusicManifest => {
  if (!isRecord(raw) || !Array.isArray(raw.tracks)) return { tracks: [] };
  const tracks: MusicTrack[] = [];
  const seen = new Set<string>();
  for (const entry of raw.tracks) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '' || seen.has(entry.id)) continue;
    if (!MUSIC_CONTEXTS.includes(entry.context as MusicContext) || !Array.isArray(entry.stems)) continue;
    const rawStems = entry.stems.slice(0, MAX_STEMS);
    const stems = rawStems.map((stem, index) => parseStem(stem, index, rawStems.length)).filter((stem): stem is MusicStem => stem !== null);
    if (stems.length === 0) continue;
    const gain = typeof entry.gain === 'number' && Number.isFinite(entry.gain) ? Math.min(2, Math.max(0, entry.gain)) : 1;
    const loopStart = positive(entry.loopStart);
    const loopEnd = positive(entry.loopEnd);
    // loopEnd absent: the loop runs to the end of the file. One that is not after loopStart is dropped with it.
    const valid = loopEnd === undefined || loopEnd > (loopStart ?? 0);
    seen.add(entry.id);
    tracks.push({
      id: entry.id,
      context: entry.context as MusicContext,
      stems,
      gain,
      ...(valid && loopStart !== undefined ? { loopStart } : {}),
      ...(valid && loopEnd !== undefined ? { loopEnd } : {}),
    });
  }
  return { tracks };
};

/** The contexts tried, in order, for each context. */
const FALLBACK: Readonly<Record<MusicContext, readonly MusicContext[]>> = {
  menu: ['menu', 'park'],
  park: ['park'],
  night: ['night', 'park'],
};

/** The track a context plays (the first listed), or null: the synthesised loop then plays. */
export const pickTrack = (manifest: MusicManifest, context: MusicContext): MusicTrack | null => {
  for (const wanted of FALLBACK[context]) {
    const track = manifest.tracks.find((candidate) => candidate.context === wanted);
    if (track) return track;
  }
  return null;
};

/** A layer's level at an intensity: full from its `from`, fading in over LAYER_RAMP below it. */
export const layerLevel = (from: number, intensity: number): number => (
  from <= 0 ? 1 : clamp01(1 + (clamp01(intensity) - from) / LAYER_RAMP)
);

/** The music state from what the park is doing (guests in it, rides running, night or not, start screen or not). */
export const musicStateOf = (input: { menu: boolean; night: boolean; guests: number; runningRides: number }): MusicState => ({
  context: input.menu ? 'menu' : input.night ? 'night' : 'park',
  intensity: input.menu ? 0 : clamp01(0.6 * Math.min(1, input.guests / FULL_PARK_GUESTS) + 0.4 * Math.min(1, input.runningRides / FULL_PARK_RIDES)),
});

/** The file of a stem the browser can play (`canPlay` asks by file name), or null. */
export const playableFile = (stem: MusicStem, canPlay: (file: string) => boolean): string | null => (
  stem.files.find(canPlay) ?? null
);
