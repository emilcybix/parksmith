import type { AudioContextLike } from './AudioEngine';
import type { MusicSource } from './MusicPlayer';

/**
 * Phase 15: the real Web Audio context, or null where there is none (Node, an old browser): the engine then stays
 * silent. Only ever called from a user gesture (AudioEngine.unlock).
 */
export const createBrowserAudioContext = (): AudioContextLike | null => {
  const scope = globalThis as unknown as { AudioContext?: new (options?: { latencyHint?: string }) => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  return Context ? new Context({ latencyHint: 'interactive' }) : null;
};

/** Phase 47: the MIME type of a music file, by its extension, for `canPlayType`. */
const MUSIC_TYPES: Readonly<Record<string, string>> = {
  ogg: 'audio/ogg; codecs="vorbis"',
  opus: 'audio/ogg; codecs="opus"',
  webm: 'audio/webm; codecs="opus"',
  m4a: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

/**
 * Phase 47: the produced music, fetched from `music/` next to the page (under the hosted build's base path). Only
 * asked for after the first gesture, so a page that is never clicked fetches nothing.
 */
export const createBrowserMusicSource = (): MusicSource => {
  const base = `${(import.meta.env as Record<string, string | undefined>).BASE_URL ?? '/'}music/`;
  let probe: HTMLAudioElement | null = null;
  return {
    manifest: async () => {
      const response = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
      // A dev server answers an unknown path with the page itself: anything that is not JSON is "no manifest".
      if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return null;
      return response.json();
    },
    load: async (file) => {
      const response = await fetch(`${base}${file}`);
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      return response.arrayBuffer();
    },
    canPlay: (file) => {
      const type = MUSIC_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];
      if (type === undefined) return false;
      probe ??= document.createElement('audio');
      return probe.canPlayType(type) !== '';
    },
  };
};
