import type { AudioBufferLike, AudioContextLike, BufferSourceLike, GainNodeLike } from './AudioEngine';
import { layerLevel, parseMusicManifest, pickTrack, playableFile, type MusicManifest, type MusicState, type MusicTrack } from './music';

/**
 * Phase 47: plays the produced music on the music bus. Created at the audio unlock; it fetches the manifest then, and
 * a track's stems only when a context first wants that track. All stems of a track start at one context time, so they
 * stay sample-locked while looping; the layers then only move gains (`setTargetAtTime`, a few times a second).
 * Switching track cross-fades: the old one fades out and is stopped a few seconds later. At most two tracks stay
 * decoded (the one playing and the one fading out), because decoded audio is large.
 *
 * Anything that goes wrong (no manifest, a 404, a format the browser cannot decode) leaves that track out for the
 * session and the synthesised loop plays instead; nothing throws into the game.
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

interface Playing {
  readonly track: MusicTrack;
  readonly gain: GainNodeLike;
  readonly sources: readonly BufferSourceLike[];
  readonly layers: readonly GainNodeLike[];
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

  constructor(
    private readonly context: AudioContextLike,
    private readonly bus: GainNodeLike,
    private readonly source: MusicSource,
    /** Called when produced music starts or stops, so the engine can fade the synthesised loop the other way. */
    private readonly onActiveChange: () => void,
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

  private apply(): void {
    if (this.manifest === null) return;
    const wanted = pickTrack(this.manifest, this.state.context);
    const usable = wanted !== null && !this.failed.has(wanted.id) ? wanted : null;
    if (usable?.id !== this.playing?.track.id) {
      if (usable === null) this.switchTo(null);
      else if (this.decoded.has(usable.id)) this.switchTo(usable);
      else this.fetch(usable);
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

  private switchTo(track: MusicTrack | null): void {
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
      track.stems.forEach((stem, index) => {
        const layer = context.createGain();
        layer.gain.value = layerLevel(stem.from, this.state.intensity);
        layer.connect(gain);
        const source = context.createBufferSource();
        source.buffer = buffers[index];
        source.loop = true;
        if (track.loopEnd !== undefined) {
          source.loopStart = track.loopStart ?? 0;
          source.loopEnd = track.loopEnd;
        }
        source.connect(layer);
        source.start(when);
        layers.push(layer);
        sources.push(source);
      });
      this.playing = { track, gain, sources, layers };
      this.started.push(track.id);
    }
    // Decoded audio is large: keep only what is playing or fading out.
    for (const id of [...this.decoded.keys()]) {
      if (id !== track?.id && id !== outgoing?.track.id) this.decoded.delete(id);
    }
    this.onActiveChange();
  }
}
