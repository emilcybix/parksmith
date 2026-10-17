import { LOOP_IDS, SOUND_IDS, renderLoop, renderSound, type LoopId, type SoundId } from './synth';
import { MusicPlayer, type MusicSource } from './MusicPlayer';
import type { MusicState } from './music';

/**
 * Phase 15: the game's audio. Six buses — master and, under it, music, ambience, rides, guests and UI — each a gain
 * the player sets in Settings (0-100, mapped to gain as (v / 100)^2 so the steps sound even). Nothing exists and
 * nothing plays before the first user gesture (`unlock`, called by GameApp on the first pointer or key press): the
 * AudioContext is created there, every sound and loop is synthesised into buffers once (synth.ts; nothing is decoded
 * or rendered later), the three loops start silent, and from then on:
 *
 * - `play(sound)` starts one buffer on its bus (rate-limited per sound, so a burst of cues is one sound, and refused
 *   while the bus or master is silent). A one-shot source node per play is the Web Audio API's design and the only
 *   allocation: plays come from events, never from the frame loop.
 * - `setAmbience(crowd, machinery)` and `setMusicPlaying` move the loop gains with `setTargetAtTime` (no allocation),
 *   a few times a second from GameApp's 4 Hz publish.
 * - `setSuspended` stops the clock when the page is hidden.
 *
 * The context is injected (`createContext`), so Node tests drive a fake and a browser without Web Audio gets a silent
 * engine that refuses nothing and plays nothing.
 */

export type BusId = 'music' | 'ambience' | 'rides' | 'guests' | 'ui';
export const BUS_IDS: readonly BusId[] = ['music', 'ambience', 'rides', 'guests', 'ui'];

export interface AudioVolumes {
  readonly master: number;
  readonly music: number;
  readonly ambience: number;
  readonly rides: number;
  readonly guests: number;
  readonly ui: number;
}

/** The bus each cue plays on. */
export const SOUND_BUS: Readonly<Record<SoundId, BusId>> = {
  coin: 'ui', spend: 'ui', build: 'ui', click: 'ui', fanfare: 'ui', research: 'ui', fail: 'ui',
  chime: 'rides', clank: 'rides', ratchet: 'rides',
  happy: 'guests', unhappy: 'guests', sale: 'guests',
};

/** The shortest gap between two plays of one sound (ms of context time). */
export const SOUND_GAP_MS: Readonly<Record<SoundId, number>> = {
  coin: 90, spend: 90, build: 120, click: 40, fanfare: 1_500, research: 800, fail: 1_500,
  chime: 400, clank: 600, ratchet: 600, happy: 300, unhappy: 300, sale: 250,
};

/** The synthesis rate: low enough to render everything in a few tens of ms, high enough for these sounds. */
export const SYNTH_RATE = 22_050;
/** Seconds a loop gain takes to settle (setTargetAtTime's time constant). */
export const AMBIENCE_TIME_CONSTANT = 0.6;

/** The slice of the Web Audio API the engine uses (a fake implements it in tests). */
export interface AudioParamLike {
  value: number;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
}
export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
}
export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}
export interface AudioBufferLike {
  /** Seconds (Phase 47: a produced track loops to its end). */
  readonly duration?: number;
  copyToChannel(source: Float32Array, channel: number): void;
}
export interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  loopStart?: number;
  loopEnd?: number;
  start(when?: number): void;
  stop?(when?: number): void;
}
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNodeLike;
  readonly state: string;
  createGain(): GainNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): BufferSourceLike;
  resume(): Promise<unknown>;
  suspend(): Promise<unknown>;
  /** Phase 47: decodes a produced music file (absent: no produced music, the synthesised loop plays). */
  decodeAudioData?(data: ArrayBuffer): Promise<AudioBufferLike>;
}

/** Volume 0-100 to gain: a square law, so the ten steps sound evenly spaced. */
export const gainOf = (volume: number): number => {
  const v = Math.min(100, Math.max(0, Number.isFinite(volume) ? volume : 0)) / 100;
  return v * v;
};

export class AudioEngine {
  private context: AudioContextLike | null = null;
  private master: GainNodeLike | null = null;
  private readonly buses = new Map<BusId, GainNodeLike>();
  private readonly buffers = new Map<SoundId, AudioBufferLike>();
  private readonly loopGains = new Map<LoopId, GainNodeLike>();
  private readonly lastPlayed = new Map<SoundId, number>();
  private volumes: AudioVolumes;
  private failed = false;
  private crowd = 0;
  private machinery = 0;
  private musicOn = true;
  /** Plays started since unlock, by sound (tests and the dev readout). */
  readonly plays = new Map<SoundId, number>();

  /** Phase 47: the produced music, created at unlock when a source was given; null plays only the synthesised loop. */
  private music: MusicPlayer | null = null;
  private musicState: MusicState = { context: 'menu', intensity: 0 };

  constructor(
    private readonly createContext: () => AudioContextLike | null,
    volumes: AudioVolumes,
    private readonly musicSource: MusicSource | null = null,
  ) {
    this.volumes = volumes;
  }

  /** The produced track playing, or null (the synthesised loop, or silence). */
  get musicTrack(): string | null {
    return this.music?.trackId ?? null;
  }

  /** True once the first gesture created the context and every buffer is ready. */
  get ready(): boolean {
    return this.context !== null;
  }

  /**
   * The first user gesture: creates the context, the bus graph, every buffer and the three silent loops. Idempotent;
   * a context that cannot be created (no Web Audio, or it throws) leaves the engine silent for good.
   */
  unlock(): void {
    if (this.context !== null || this.failed) return;
    let context: AudioContextLike | null = null;
    try {
      context = this.createContext();
    } catch {
      context = null;
    }
    if (context === null) {
      this.failed = true;
      return;
    }
    const master = context.createGain();
    master.connect(context.destination);
    this.master = master;
    for (const bus of BUS_IDS) {
      const gain = context.createGain();
      gain.connect(master);
      this.buses.set(bus, gain);
    }
    const toBuffer = (samples: Float32Array): AudioBufferLike => {
      const buffer = context.createBuffer(1, samples.length, SYNTH_RATE);
      buffer.copyToChannel(samples, 0);
      return buffer;
    };
    for (const sound of SOUND_IDS) this.buffers.set(sound, toBuffer(renderSound(sound, SYNTH_RATE)));
    for (const loop of LOOP_IDS) {
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(this.buses.get(loop === 'music' ? 'music' : loop === 'crowd' ? 'ambience' : 'rides') as GainNodeLike);
      const source = context.createBufferSource();
      source.buffer = toBuffer(renderLoop(loop, SYNTH_RATE));
      source.loop = true;
      source.connect(gain);
      source.start();
      this.loopGains.set(loop, gain);
    }
    this.context = context;
    if (this.musicSource !== null) {
      this.music = new MusicPlayer(context, this.buses.get('music') as GainNodeLike, this.musicSource, () => this.applyLoops());
      this.music.setState(this.musicState, this.musicOn);
    }
    this.applyVolumes();
    this.applyLoops();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
  }

  /** New volumes from Settings (applied at once, before or after unlock). */
  setVolumes(volumes: AudioVolumes): void {
    this.volumes = volumes;
    this.applyVolumes();
  }

  /**
   * Plays a cue on its bus. False when it did not play: before unlock, a silent bus or master, or the same sound too
   * soon after the last one.
   */
  play(sound: SoundId): boolean {
    const context = this.context;
    if (context === null) return false;
    const bus = SOUND_BUS[sound];
    if (gainOf(this.volumes.master) === 0 || gainOf(this.volumes[bus]) === 0) return false;
    const nowMs = context.currentTime * 1_000;
    const last = this.lastPlayed.get(sound);
    if (last !== undefined && nowMs - last < SOUND_GAP_MS[sound]) return false;
    this.lastPlayed.set(sound, nowMs);
    const source = context.createBufferSource();
    source.buffer = this.buffers.get(sound) ?? null;
    source.connect(this.buses.get(bus) as GainNodeLike);
    source.start();
    this.plays.set(sound, (this.plays.get(sound) ?? 0) + 1);
    return true;
  }

  /** The ambience beds' levels in [0, 1] (crowd murmur, ride machinery). Cheap; call a few times a second. */
  setAmbience(crowd: number, machinery: number): void {
    this.crowd = Math.min(1, Math.max(0, crowd));
    this.machinery = Math.min(1, Math.max(0, machinery));
    this.applyLoops();
  }

  /** The music loop on or off (it fades either way). */
  setMusicPlaying(playing: boolean): void {
    if (playing === this.musicOn) return;
    this.musicOn = playing;
    this.music?.setState(this.musicState, playing);
    this.applyLoops();
  }

  /** Phase 47: what the park is doing, for the produced music's track and layers. Cheap; call a few times a second. */
  setMusicState(state: MusicState): void {
    this.musicState = state;
    this.music?.setState(state, this.musicOn);
  }

  /** Stops (true) or restarts the audio clock, e.g. while the page is hidden. */
  setSuspended(suspended: boolean): void {
    const context = this.context;
    if (context === null) return;
    void (suspended ? context.suspend() : context.resume()).catch(() => undefined);
  }

  /** The current target level of a loop (tests). */
  loopLevel(loop: LoopId): number {
    // The synthesised music gives way while a produced track plays.
    return loop === 'music' ? (this.musicOn && !this.music?.active ? 1 : 0) : loop === 'crowd' ? this.crowd : this.machinery;
  }

  private applyVolumes(): void {
    if (this.master === null || this.context === null) return;
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(gainOf(this.volumes.master), now, 0.05);
    for (const bus of BUS_IDS) this.buses.get(bus)?.gain.setTargetAtTime(gainOf(this.volumes[bus]), now, 0.05);
  }

  private applyLoops(): void {
    const context = this.context;
    if (context === null) return;
    const now = context.currentTime;
    for (const loop of LOOP_IDS) {
      // The music sits a little under the cues; the beds are quiet by design (they are texture, not signal).
      const scale = loop === 'music' ? 0.55 : loop === 'crowd' ? 0.5 : 0.35;
      this.loopGains.get(loop)?.gain.setTargetAtTime(this.loopLevel(loop) * scale, now, AMBIENCE_TIME_CONSTANT);
    }
  }
}
