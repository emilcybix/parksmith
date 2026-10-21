import { LOOP_IDS, SOUND_IDS, renderLoop, renderSound, type LoopId, type SoundId } from './synth';
import { MusicPlayer, type MusicPlaylistView, type MusicSource } from './MusicPlayer';
import type { MusicState } from './music';

/**
 * Phase 15: the game's audio. Six buses — master and, under it, music, ambience, rides, guests and UI — each a gain
 * the player sets in Settings (0-100, mapped to gain as (v / 100)^2 so the steps sound even). Nothing exists and
 * nothing plays before the first user gesture (`unlock`, called by GameApp on the first pointer or key press): the
 * AudioContext is created there, every sound and loop is synthesised into buffers once (synth.ts; nothing is decoded
 * or rendered later), the loops start silent, and from then on:
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
 *
 * Recorded sounds: a cue listed in SOUND_FILES is fetched from `public/sfx/` and decoded at unlock too, and its buffer
 * replaces the synthesised one once ready. Until then, and for good when the fetch or the decode fails, the synthesised
 * cue plays, so a missing file is never silence. A RecordedSoundId has no synthesised version: without its file it is
 * not heard.
 *
 * Zoom (`setMix`): the park buses (ambience, rides, guests) and the music bus are scaled by two factors on top of the
 * player's volumes, so zoomed all the way in only the park is heard and zoomed all the way out only the music. The UI
 * bus is never scaled.
 *
 * Proximity: `play(sound, gain, pan)` takes a level and a stereo position (audioDirector computes them from the
 * source's distance to the middle of the screen), and `setEmitters` keeps up to MAX_VOICES looping positional sounds
 * (a train rolling, a chain lift, a ride's motor, a fountain), each a looping source, a gain and a panner created when
 * it becomes audible and stopped after it fades out.
 *
 * Beds: the recorded park ambience (BED_FILES) loops on the ambience bus once decoded and replaces the synthesised
 * crowd and machinery beds. Rain (in rain and storms) and the night's crickets are synthesised beds of their own.
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
  coin: 'ui', spend: 'ui', build: 'ui', splash: 'ui', click: 'ui', fanfare: 'ui', research: 'ui', fail: 'ui', notify: 'ui', error: 'ui',
  chime: 'rides', clank: 'rides', ratchet: 'rides',
  happy: 'guests', unhappy: 'guests', sale: 'guests',
  launch: 'rides', boost: 'rides', scream: 'rides', crash: 'rides', puff: 'rides', 'splash-big': 'rides', 'splash-small': 'rides',
  whoosh: 'rides', brake: 'rides', bell: 'rides',
  flush: 'guests',
  'thunder-near': 'ambience', 'thunder-far': 'ambience',
};

/** The shortest gap between two plays of one sound (ms of context time). */
export const SOUND_GAP_MS: Readonly<Record<SoundId, number>> = {
  coin: 90, spend: 90, build: 120, click: 40, fanfare: 1_500, research: 800, fail: 1_500,
  chime: 400, clank: 600, ratchet: 600, happy: 300, unhappy: 300, sale: 250, splash: 120, notify: 800, error: 300,
  launch: 300, boost: 150, scream: 400, crash: 1_000, puff: 300, 'splash-big': 300, 'splash-small': 200, flush: 400,
  'thunder-near': 1_500, 'thunder-far': 1_500, whoosh: 200, brake: 300, bell: 500,
};

/**
 * The recorded file of a cue (a path inside `public/sfx/`), or its variants: a list plays its files in turn, so a
 * repeated cue does not sound looped. A cue left out is only ever synthesised.
 */
export const SOUND_FILES: Readonly<Partial<Record<SoundId, string | readonly string[]>>> = {
  click: 'ui/ui_click.ogg',
  build: 'ui/build_land.ogg',
  splash: 'ui/build_water.ogg',
  spend: 'ui/purchase_cash.ogg',
  ratchet: 'ui/repair_hammer.ogg',
  notify: 'ui/notify_message.ogg',
  error: 'ui/ui_error.ogg',
  flush: 'ui/facility_toilet_flush.ogg',
  'splash-big': 'ui/water_splash_big.ogg',
  'splash-small': 'ui/water_splash_small.ogg',
  launch: 'coasters/ride_launch_long.ogg',
  boost: 'coasters/ride_launch_short.ogg',
  scream: 'coasters/scream.mp3',
  crash: 'coasters/ride_crash.ogg',
  puff: 'coasters/ride_steam.ogg',
  'thunder-near': 'ambience/weather_thunder_near.ogg',
  'thunder-far': 'ambience/weather_thunder_far.ogg',
};

/** The looping positional sounds (recorded only) and their files. */
export type EmitterLoopId = 'roll' | 'chain' | 'motor' | 'engine' | 'steam' | 'fountain';
export const EMITTER_FILES: Readonly<Record<EmitterLoopId, string>> = {
  roll: 'coasters/ride_track_roll.ogg',
  chain: 'coasters/ride_lift_chain.ogg',
  motor: 'coasters/ride_lift_motor.ogg',
  engine: 'coasters/ride_train_engine.ogg',
  steam: 'coasters/ride_train_steam.ogg',
  fountain: 'ui/water_splash_crackle.ogg',
};
export const EMITTER_BUS: Readonly<Record<EmitterLoopId, BusId>> = {
  roll: 'rides', chain: 'rides', motor: 'rides', engine: 'rides', steam: 'rides', fountain: 'ambience',
};

/**
 * One looping positional sound for `setEmitters`. `key` names the source across updates (a ride and its sound), so a
 * sound that keeps playing keeps its voice; `gain` is its level after proximity, `pan` its place in [-1, 1], `rate`
 * its playback rate (a rolling train's pitch follows its speed; 1 when absent).
 */
export interface Emitter {
  key: number;
  loop: EmitterLoopId;
  gain: number;
  pan: number;
  rate?: number;
}

/** At most this many positional loops at once (the loudest win). */
export const MAX_VOICES = 10;
/** Below this level a cue or a loop is not started. */
export const AUDIBLE = 0.02;
/** Seconds the zoom mix takes to settle. */
export const MIX_TIME_CONSTANT = 0.25;

/**
 * The recorded park ambience: `day` under every daytime park, `crowd` and `chatter` with the guests near the middle of
 * the screen (chatter only when it is busy), `rides` with the running rides near it.
 */
export type BedId = 'day' | 'crowd' | 'chatter' | 'rides';
export const BED_IDS: readonly BedId[] = ['day', 'crowd', 'chatter', 'rides'];
export const BED_FILES: Readonly<Record<BedId, string>> = {
  day: 'ambience/park_ambience1.mp3',
  crowd: 'ambience/park_ambience3.mp3',
  chatter: 'ambience/park_ambience4.mp3',
  rides: 'ambience/park_ambience2.mp3',
};
/** Each bed's level at full (they are texture, not signal). */
const BED_SCALE: Readonly<Record<BedId, number>> = { day: 0.35, crowd: 0.55, chatter: 0.4, rides: 0.35 };

/** Where the recorded sounds come from (the browser's fetch in the game, a fake in tests). */
export interface SampleSource {
  /** One file's bytes (a path inside `public/sfx/`). */
  load(file: string): Promise<ArrayBuffer>;
}

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
  /** Absent: positional loops play at their own pitch. */
  readonly playbackRate?: AudioParamLike;
  loop: boolean;
  loopStart?: number;
  loopEnd?: number;
  start(when?: number): void;
  stop?(when?: number): void;
}
export interface StereoPannerLike extends AudioNodeLike {
  readonly pan: AudioParamLike;
}
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNodeLike;
  readonly state: string;
  createGain(): GainNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): BufferSourceLike;
  /** Absent: positional sounds play centred. */
  createStereoPanner?(): StereoPannerLike;
  resume(): Promise<unknown>;
  suspend(): Promise<unknown>;
  /** Phase 47: decodes a produced music file (absent: no produced music, the synthesised loop plays). */
  decodeAudioData?(data: ArrayBuffer): Promise<AudioBufferLike>;
}

/** The bus each synthesised loop plays on. */
const LOOP_BUS: Readonly<Record<LoopId, BusId>> = { music: 'music', crowd: 'ambience', machinery: 'rides', rain: 'ambience', night: 'ambience' };
/** Each loop's level at full: the music sits a little under the cues; the beds are quiet by design (texture, not signal). */
const LOOP_SCALE: Readonly<Record<LoopId, number>> = { music: 0.55, crowd: 0.5, machinery: 0.35, rain: 0.5, night: 0.3 };

/** Volume 0-100 to gain: a square law, so the ten steps sound evenly spaced. */
export const gainOf = (volume: number): number => {
  const v = Math.min(100, Math.max(0, Number.isFinite(volume) ? volume : 0)) / 100;
  return v * v;
};

interface Voice {
  readonly loop: EmitterLoopId;
  readonly source: BufferSourceLike;
  readonly gain: GainNodeLike;
  readonly panner: StereoPannerLike | null;
  seen: boolean;
}

export class AudioEngine {
  private context: AudioContextLike | null = null;
  private master: GainNodeLike | null = null;
  private readonly buses = new Map<BusId, GainNodeLike>();
  private readonly buffers = new Map<SoundId, AudioBufferLike>();
  /** The decoded variants of a recorded cue (they replace its synthesised buffer). */
  private readonly recorded = new Map<SoundId, AudioBufferLike[]>();
  private readonly loopGains = new Map<LoopId, GainNodeLike>();
  private readonly lastPlayed = new Map<SoundId, number>();
  private volumes: AudioVolumes;
  private failed = false;
  private crowd = 0;
  private machinery = 0;
  private musicOn = true;
  private day = 0;
  private rain = 0;
  private night = 0;
  /** The zoom mix on top of the volumes, per bus (1 = as the player set it). */
  private readonly busMix: Record<BusId, number> = { music: 1, ambience: 1, rides: 1, guests: 1, ui: 1 };
  private readonly emitterBuffers = new Map<EmitterLoopId, AudioBufferLike>();
  private readonly voices = new Map<number, Voice>();
  private readonly bedGains = new Map<BedId, GainNodeLike>();
  /** Plays started since unlock, by sound (tests and the dev readout). */
  readonly plays = new Map<SoundId, number>();

  /** Phase 47: the produced music, created at unlock when a source was given; null plays only the synthesised loop. */
  private music: MusicPlayer | null = null;
  private musicState: MusicState = { context: 'menu', intensity: 0 };

  constructor(
    private readonly createContext: () => AudioContextLike | null,
    volumes: AudioVolumes,
    private readonly musicSource: MusicSource | null = null,
    private readonly sampleSource: SampleSource | null = null,
  ) {
    this.volumes = volumes;
  }

  /** The produced track playing, or null (the synthesised loop, or silence). */
  get musicTrack(): string | null {
    return this.music?.trackId ?? null;
  }

  /** The music player's view: the tracks of the context playing and which one plays; null without produced music. */
  musicPlaylist(): MusicPlaylistView | null {
    return this.music?.playlist() ?? null;
  }

  /** The music player's controls (no-ops before unlock or without produced music). */
  musicNext(): void {
    this.music?.next();
  }

  musicPrevious(): void {
    this.music?.previous();
  }

  musicSelect(id: string): void {
    this.music?.select(id);
  }

  /** True once the first gesture created the context and every buffer is ready. */
  get ready(): boolean {
    return this.context !== null;
  }

  /**
   * The first user gesture: creates the context, the bus graph, every buffer and the silent loops. Idempotent;
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
      gain.connect(this.buses.get(LOOP_BUS[loop]) as GainNodeLike);
      const source = context.createBufferSource();
      source.buffer = toBuffer(renderLoop(loop, SYNTH_RATE));
      source.loop = true;
      source.connect(gain);
      source.start();
      this.loopGains.set(loop, gain);
    }
    this.context = context;
    this.loadSamples(context);
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
   * Plays a cue on its bus, at `gain` (proximity) and `pan` (-1 left .. 1 right). False when it did not play: before
   * unlock, a silent bus, master or zoom mix, too faint, a recorded cue whose file is not decoded (yet), or the same
   * sound too soon after the last one.
   */
  play(sound: SoundId, gain = 1, pan = 0): boolean {
    const context = this.context;
    if (context === null) return false;
    const bus = SOUND_BUS[sound];
    if (gainOf(this.volumes.master) === 0 || gainOf(this.volumes[bus]) === 0 || gain * this.busMix[bus] < AUDIBLE) return false;
    const variants = this.recorded.get(sound);
    const buffer = variants === undefined ? this.buffers.get(sound) : variants[(this.plays.get(sound) ?? 0) % variants.length];
    if (buffer === undefined) return false;
    const nowMs = context.currentTime * 1_000;
    const last = this.lastPlayed.get(sound);
    if (last !== undefined && nowMs - last < SOUND_GAP_MS[sound]) return false;
    this.lastPlayed.set(sound, nowMs);
    const source = context.createBufferSource();
    source.buffer = buffer;
    let into: AudioNodeLike = this.buses.get(bus) as GainNodeLike;
    if (pan !== 0 && context.createStereoPanner) {
      const panner = context.createStereoPanner();
      panner.pan.value = Math.min(1, Math.max(-1, pan));
      panner.connect(into);
      into = panner;
    }
    if (gain < 1) {
      const level = context.createGain();
      level.gain.value = gain;
      level.connect(into);
      into = level;
    }
    source.connect(into);
    source.start();
    this.plays.set(sound, (this.plays.get(sound) ?? 0) + 1);
    return true;
  }

  /** Fetches and decodes every recorded cue; each replaces its synthesised buffer when ready (a failure keeps it). */
  private loadSamples(context: AudioContextLike): void {
    const source = this.sampleSource;
    const decode = context.decodeAudioData?.bind(context);
    if (source === null || decode === undefined) return;
    for (const [sound, files] of Object.entries(SOUND_FILES) as Array<[SoundId, string | readonly string[]]>) {
      for (const file of typeof files === 'string' ? [files] : files) {
        void source.load(file).then(decode).then((buffer) => {
          const variants = this.recorded.get(sound);
          if (variants === undefined) this.recorded.set(sound, [buffer]);
          else variants.push(buffer);
        }).catch(() => undefined);
      }
    }
    for (const [loop, file] of Object.entries(EMITTER_FILES) as Array<[EmitterLoopId, string]>) {
      void source.load(file).then(decode).then((buffer) => {
        this.emitterBuffers.set(loop, buffer);
      }).catch(() => undefined);
    }
    for (const bed of BED_IDS) {
      void source.load(BED_FILES[bed]).then(decode).then((buffer) => {
        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(this.buses.get('ambience') as GainNodeLike);
        const loop = context.createBufferSource();
        loop.buffer = buffer;
        loop.loop = true;
        loop.connect(gain);
        loop.start();
        this.bedGains.set(bed, gain);
        this.applyLoops();
      }).catch(() => undefined);
    }
  }

  /** A bed's target level (tests): 0 until its file is decoded. */
  bedLevel(bed: BedId): number {
    if (!this.bedGains.has(bed)) return 0;
    return bed === 'day' ? this.day : bed === 'crowd' ? this.crowd : bed === 'chatter' ? this.crowd * this.crowd : this.machinery;
  }

  /**
   * The ambience beds' levels in [0, 1] (crowd murmur, ride machinery, the daytime park bed, rain and the night's
   * crickets; audioDirector's `atmosphereFor` gives the last three). Cheap; call a few times a second.
   */
  setAmbience(crowd: number, machinery: number, day = 0, rain = 0, night = 0): void {
    const unit = (value: number): number => Math.min(1, Math.max(0, value));
    this.crowd = unit(crowd);
    this.machinery = unit(machinery);
    this.day = unit(day);
    this.rain = unit(rain);
    this.night = unit(night);
    this.applyLoops();
  }

  /**
   * The zoom mix: `park` scales the ambience, rides and guests buses and `music` the music bus, each in [0, 1]. Cheap;
   * call a few times a second.
   */
  setMix(park: number, music: number): void {
    const p = Math.min(1, Math.max(0, park));
    const m = Math.min(1, Math.max(0, music));
    if (p === this.busMix.rides && m === this.busMix.music) return;
    this.busMix.ambience = p;
    this.busMix.rides = p;
    this.busMix.guests = p;
    this.busMix.music = m;
    this.applyVolumes(MIX_TIME_CONSTANT);
  }

  /**
   * The looping positional sounds now (sorted in place, loudest first). A key that stays keeps
   * its voice and glides to its new level and pan; a new audible key starts one (at most MAX_VOICES); a key that is
   * gone, or no longer among the loudest, fades out and is stopped. A loop whose file is not decoded is skipped.
   */
  setEmitters(emitters: Emitter[]): void {
    const context = this.context;
    if (context === null) return;
    const now = context.currentTime;
    for (const voice of this.voices.values()) voice.seen = false;
    emitters.sort((a, b) => b.gain - a.gain);
    let started = 0;
    for (const emitter of emitters) {
      if (started >= MAX_VOICES || emitter.gain < AUDIBLE) break;
      let voice = this.voices.get(emitter.key);
      if (voice !== undefined && voice.loop !== emitter.loop) {
        this.release(emitter.key, voice, now);
        voice = undefined;
      }
      if (voice === undefined) {
        const buffer = this.emitterBuffers.get(emitter.loop);
        if (buffer === undefined) continue;
        voice = this.voice(context, emitter.loop, buffer);
        this.voices.set(emitter.key, voice);
      }
      voice.seen = true;
      voice.gain.gain.setTargetAtTime(Math.min(1, emitter.gain), now, 0.12);
      voice.panner?.pan.setTargetAtTime(Math.min(1, Math.max(-1, emitter.pan)), now, 0.12);
      voice.source.playbackRate?.setTargetAtTime(emitter.rate ?? 1, now, 0.12);
      started += 1;
    }
    for (const [key, voice] of this.voices) if (!voice.seen) this.release(key, voice, now);
  }

  /** How many positional loops are playing (tests). */
  get voiceCount(): number {
    return this.voices.size;
  }

  private voice(context: AudioContextLike, loop: EmitterLoopId, buffer: AudioBufferLike): Voice {
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(this.buses.get(EMITTER_BUS[loop]) as GainNodeLike);
    const panner = context.createStereoPanner?.() ?? null;
    panner?.connect(gain);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(panner ?? gain);
    source.start();
    return { loop, source, gain, panner, seen: true };
  }

  private release(key: number, voice: Voice, now: number): void {
    voice.gain.gain.setTargetAtTime(0, now, 0.15);
    voice.source.stop?.(now + 1);
    this.voices.delete(key);
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
    // The synthesised music gives way while a produced track plays, the synthesised beds to the recorded ones.
    if (loop === 'music') return this.musicOn && !this.music?.active ? 1 : 0;
    if (loop === 'crowd') return this.bedGains.has('crowd') ? 0 : this.crowd;
    if (loop === 'rain') return this.rain;
    if (loop === 'night') return this.night;
    return this.bedGains.has('rides') ? 0 : this.machinery;
  }

  /** A bus's gain: the player's volume times the zoom mix. */
  private busLevel(bus: BusId): number {
    return gainOf(this.volumes[bus]) * this.busMix[bus];
  }

  private applyVolumes(timeConstant = 0.05): void {
    if (this.master === null || this.context === null) return;
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(gainOf(this.volumes.master), now, 0.05);
    for (const bus of BUS_IDS) this.buses.get(bus)?.gain.setTargetAtTime(this.busLevel(bus), now, timeConstant);
  }

  private applyLoops(): void {
    const context = this.context;
    if (context === null) return;
    const now = context.currentTime;
    for (const loop of LOOP_IDS) {
      this.loopGains.get(loop)?.gain.setTargetAtTime(this.loopLevel(loop) * LOOP_SCALE[loop], now, AMBIENCE_TIME_CONSTANT);
    }
    for (const [bed, gain] of this.bedGains) gain.gain.setTargetAtTime(this.bedLevel(bed) * BED_SCALE[bed], now, AMBIENCE_TIME_CONSTANT);
  }
}
