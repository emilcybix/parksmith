import type { AudioBufferLike, AudioContextLike, BufferSourceLike, GainNodeLike } from './AudioEngine';
import {
  layerLevel, parseMusicManifest, playableFile, tracksFor, type MusicContext, type MusicManifest, type MusicState, type MusicTrack,
} from './music';

/**
 * Phase 47: plays the produced music on the music bus. Created at the audio unlock; it fetches the manifest then, and
 * a track's stems only when a context first wants that track. All stems of a track start at one context time, so they
 * stay sample-locked while looping; the layers then only move gains (`setTargetAtTime`, a few times a second).
 * Switching track cross-fades: the old one fades out and is stopped a few seconds later. At most two tracks stay
 * decoded (the one playing and the one fading out), because decoded audio is large.
 *
 * Anything that goes wrong (no manifest, a 404, a format the browser cannot decode) leaves that track out for the
 * session and the synthesised loop plays instead; nothing throws into the game.
 *
 * A context with one track loops it. A context with two or more is a playlist: it starts at a random track, plays each
 * through once (intro included, no loop) and cross-fades into the next a moment before the end, fetching the next one
 * ahead of time. The music player (`next`, `previous`, `select`) moves through the same list. Each context keeps its own
 * place, so the start screen and back resumes the park's playlist at the track it was on.
 */

/** Where the music comes from (the browser's fetch in the game, a fake in tests). */
export interface MusicSource {
  /** The manifest JSON, or null when there is none. */
  manifest(): Promise<unknown>;
  /** One file's bytes (a path inside `public/music/`). */
  load(file: string): Promise<ArrayBuffer>;
  /** Whether the browser can decode a file of this name's format. */
  canPlay(file: string): boolean;
}

/** Seconds a cross-fade and a layer change take to settle (setTargetAtTime's time constant). */
export const TRACK_FADE_TIME_CONSTANT = 1.2;
export const LAYER_TIME_CONSTANT = 1.5;
/** A faded-out track is stopped this long after its fade began. */
export const TRACK_STOP_AFTER = 6;
/** The music sits a little under the cues, like the synthesised loop. */
export const MUSIC_SCALE = 0.55;
/** A playlist track hands over to the next this many seconds before its end (the cross-fade covers the tail). */
export const PLAYLIST_END_LEAD = 1.5;
/** The next playlist track is fetched and decoded once the one playing has this little left. */
export const PLAYLIST_PREFETCH = 30;

interface Playing {
  readonly track: MusicTrack;
  readonly gain: GainNodeLike;
  readonly sources: readonly BufferSourceLike[];
  readonly layers: readonly GainNodeLike[];
  /** Context time the track ends at when it plays once (a playlist); null while it loops. */
  readonly endsAt: number | null;
}

/** What the music player shows: the tracks of the context playing, and which one plays. */
export interface MusicPlaylistView {
  readonly context: MusicContext;
  readonly tracks: readonly { readonly id: string; readonly title: string }[];
  readonly currentId: string | null;
}

export class MusicPlayer {
  private manifest: MusicManifest | null = null;
  private state: MusicState = { context: 'menu', intensity: 0 };
  private enabled = true;
  private playing: Playing | null = null;
  private readonly decoded = new Map<string, AudioBufferLike[]>();
  private readonly loading = new Set<string>();
  private readonly failed = new Set<string>();
  /** Tracks started since unlock (tests and the dev readout). */
  readonly started: string[] = [];
  /** The playlist place per context (the context the tracks belong to, after the fallback). */
  private readonly positions = new Map<MusicContext, number>();

  constructor(
    private readonly context: AudioContextLike,
    private readonly bus: GainNodeLike,
    private readonly source: MusicSource,
    /** Called when produced music starts or stops, so the engine can fade the synthesised loop the other way. */
    private readonly onActiveChange: () => void,
    /** Where a playlist starts (0..1); the browser's random in the game, fixed in tests. */
    private readonly random: () => number = Math.random,
  ) {
    void source.manifest().then((raw) => {
      this.manifest = parseMusicManifest(raw);
      this.apply();
    }, () => {
      this.manifest = { tracks: [] };
    });
  }

  /** True while a produced track is playing (the synthesised loop is then silent). */
  get active(): boolean {
    return this.playing !== null;
  }

  /** The id of the track playing, or null. */
  get trackId(): string | null {
    return this.playing?.track.id ?? null;
  }

  /** What the park is doing; cheap when nothing changed. Call a few times a second. */
  setState(state: MusicState, enabled: boolean): void {
    this.state = state;
    this.enabled = enabled;
    this.apply();
  }

  /** The tracks of the context playing and the current one; null before the manifest is read or without tracks. */
  playlist(): MusicPlaylistView | null {
    const list = this.list();
    if (list.length === 0) return null;
    return {
      context: list[0].context,
      tracks: list.map((track) => ({ id: track.id, title: track.title })),
      currentId: this.playing?.track.id ?? null,
    };
  }

  /** The next track of the playlist (a one-track context just keeps playing it). */
  next(): void {
    this.step(1);
  }

  previous(): void {
    this.step(-1);
  }

  /** Plays this track of the current context's list now (it cross-fades in once it is decoded). */
  select(id: string): void {
    const list = this.list();
    const index = list.findIndex((track) => track.id === id);
    if (index < 0) return;
    this.positions.set(list[0].context, index);
    this.apply();
  }

  private list(): readonly MusicTrack[] {
    if (this.manifest === null) return [];
    return tracksFor(this.manifest, this.state.context).filter((track) => !this.failed.has(track.id));
  }

  /** The list's current place: the stored one, or a random start for a playlist the first time. */
  private position(list: readonly MusicTrack[]): number {
    const key = list[0].context;
    let index = this.positions.get(key);
    if (index === undefined) {
      index = list.length > 1 ? Math.min(list.length - 1, Math.floor(this.random() * list.length)) : 0;
      this.positions.set(key, index);
    }
    return index % list.length;
  }

  private step(delta: number): void {
    const list = this.list();
    if (list.length < 2) return;
    // From the track that plays (the stored place may already point at one still decoding).
    const playingIndex = list.findIndex((track) => track.id === this.playing?.track.id);
    const from = playingIndex >= 0 ? playingIndex : this.position(list);
    this.positions.set(list[0].context, (from + delta + list.length) % list.length);
    this.apply();
  }

  private apply(): void {
    if (this.manifest === null) return;
    const list = this.list();
    if (list.length === 0) {
      if (this.playing !== null) this.switchTo(null);
      return;
    }
    const key = list[0].context;
    const now = this.context.currentTime;
    const playing = this.playing;
    const playingIndex = playing === null ? -1 : list.findIndex((track) => track.id === playing.track.id);
    // A playlist track near its end hands over to the next one.
    if (playing !== null && playingIndex >= 0 && playing.endsAt !== null && now >= playing.endsAt - PLAYLIST_END_LEAD
      && this.position(list) === playingIndex) {
      this.positions.set(key, (playingIndex + 1) % list.length);
    }
    const index = this.position(list);
    const wanted = list[index];
    if (wanted.id !== playing?.track.id) {
      if (this.decoded.has(wanted.id)) this.switchTo(wanted, list.length === 1);
      else this.fetch(wanted);
    } else if (playing.endsAt !== null && playing.endsAt - now < PLAYLIST_PREFETCH) {
      const following = list[(index + 1) % list.length];
      if (following.id !== wanted.id && !this.decoded.has(following.id)) this.fetch(following);
    }
    this.applyGains();
  }

  private applyGains(): void {
    const playing = this.playing;
    if (playing === null) return;
    const now = this.context.currentTime;
    playing.gain.gain.setTargetAtTime(this.enabled ? playing.track.gain * MUSIC_SCALE : 0, now, TRACK_FADE_TIME_CONSTANT);
    playing.track.stems.forEach((stem, index) => {
      playing.layers[index].gain.setTargetAtTime(layerLevel(stem.from, this.state.intensity), now, LAYER_TIME_CONSTANT);
    });
  }

  private fetch(track: MusicTrack): void {
    if (this.loading.has(track.id)) return;
    const decode = this.context.decodeAudioData?.bind(this.context);
    const files = track.stems.map((stem) => playableFile(stem, (file) => this.source.canPlay(file)));
    if (decode === undefined || files.some((file) => file === null)) {
      this.fail(track);
      return;
    }
    this.loading.add(track.id);
    void Promise.all(files.map(async (file) => decode(await this.source.load(file as string)))).then((buffers) => {
      this.loading.delete(track.id);
      this.decoded.set(track.id, buffers);
      this.apply();
    }, () => {
      this.loading.delete(track.id);
      this.fail(track);
    });
  }

  private fail(track: MusicTrack): void {
    this.failed.add(track.id);
    console.warn(`Music: track "${track.id}" could not be loaded; the built-in music plays instead.`);
    this.apply();
  }

  private switchTo(track: MusicTrack | null, loop = true): void {
    const context = this.context;
    const now = context.currentTime;
    const outgoing = this.playing;
    if (outgoing !== null) {
      outgoing.gain.gain.setTargetAtTime(0, now, TRACK_FADE_TIME_CONSTANT);
      for (const source of outgoing.sources) source.stop?.(now + TRACK_STOP_AFTER);
    }
    this.playing = null;
    if (track !== null) {
      const buffers = this.decoded.get(track.id) as AudioBufferLike[];
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(this.bus);
      // One start time for every stem, a moment ahead, so they begin on the same sample.
      const when = now + 0.1;
      const layers: GainNodeLike[] = [];
      const sources: BufferSourceLike[] = [];
      const length = Math.max(0, ...buffers.map((buffer) => buffer.duration ?? 0));
      // A playlist track plays once; one whose length the browser does not report loops instead of ending unheard.
      const once = !loop && length > 0;
      track.stems.forEach((stem, index) => {
        const layer = context.createGain();
        layer.gain.value = layerLevel(stem.from, this.state.intensity);
        layer.connect(gain);
        const source = context.createBufferSource();
        source.buffer = buffers[index];
        source.loop = !once;
        if (!once && (track.loopStart !== undefined || track.loopEnd !== undefined)) {
          // Web Audio reads a loopEnd of 0 as "loop the whole buffer", so "to the end" is the buffer's own length.
          source.loopStart = track.loopStart ?? 0;
          source.loopEnd = track.loopEnd ?? buffers[index].duration ?? 0;
        }
        source.connect(layer);
        source.start(when);
        layers.push(layer);
        sources.push(source);
      });
      this.playing = { track, gain, sources, layers, endsAt: once ? when + length : null };
      this.started.push(track.id);
    }
    // Decoded audio is large: keep only what is playing or fading out.
    for (const id of [...this.decoded.keys()]) {
      if (id !== track?.id && id !== outgoing?.track.id) this.decoded.delete(id);
    }
    this.onActiveChange();
  }
}
