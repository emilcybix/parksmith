import { describe, expect, it } from 'vitest';
import {
  AudioEngine,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioNodeLike,
  type BufferSourceLike,
  type GainNodeLike,
} from './AudioEngine';
import { volumesOf } from './audioDirector';
import { LAYER_RAMP, layerLevel, musicStateOf, parseMusicManifest, pickTrack, playableFile } from './music';
import type { MusicSource } from './MusicPlayer';
import { DEFAULT_SETTINGS } from '../settings/schema';

type FakeGain = GainNodeLike & { connections: AudioNodeLike[] };
type FakeSource = BufferSourceLike & { startedAt: number[]; stoppedAt: number[] };

/** A fake context with decoding: a "file" decodes to a buffer tagged with its name. */
class MusicContext implements AudioContextLike {
  currentTime = 0;
  state = 'running';
  readonly destination: AudioNodeLike = { connect: () => undefined };
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];

  createGain() {
    const gain: FakeGain = {
      connections: [],
      gain: { value: 1, setTargetAtTime: (target: number) => { gain.gain.value = target; } },
      connect: (node: AudioNodeLike) => { gain.connections.push(node); },
    };
    this.gains.push(gain);
    return gain;
  }

  createBuffer() {
    return { copyToChannel: () => undefined };
  }

  createBufferSource() {
    const source: FakeSource = {
      buffer: null,
      loop: false,
      startedAt: [],
      stoppedAt: [],
      connect: () => undefined,
      start: (when = 0) => { source.startedAt.push(when); },
      stop: (when = 0) => { source.stoppedAt.push(when); },
    };
    this.sources.push(source);
    return source;
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    const name = new TextDecoder().decode(data);
    return name.startsWith('bad') ? Promise.reject(new Error('cannot decode')) : Promise.resolve({ name, copyToChannel: () => undefined } as AudioBufferLike);
  }

  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
}

const MANIFEST = {
  tracks: [
    { id: 'theme', context: 'menu', stems: [{ file: 'theme.ogg' }] },
    {
      id: 'day',
      context: 'park',
      stems: [{ file: ['day-base.opus', 'day-base.ogg'] }, { file: 'day-chords.ogg', from: 0.3 }, { file: 'day-melody.ogg', from: 0.6 }],
      loopStart: 2,
      loopEnd: 40,
    },
    { id: 'moon', context: 'night', stems: [{ file: 'bad-moon.ogg' }] },
  ],
};

const source = (manifest: unknown = MANIFEST): MusicSource & { loads: string[] } => {
  const loads: string[] = [];
  return {
    loads,
    manifest: () => Promise.resolve(manifest),
    load: (file) => { loads.push(file); return Promise.resolve(new TextEncoder().encode(file).buffer as ArrayBuffer); },
    canPlay: (file) => !file.endsWith('.opus'),
  };
};

const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

const setup = (manifest?: unknown) => {
  const context = new MusicContext();
  const music = source(manifest);
  const engine = new AudioEngine(() => context, volumesOf(DEFAULT_SETTINGS), music);
  return { context, music, engine };
};

describe('music manifest (Phase 47)', () => {
  it('reads tracks forgivingly: bad entries are dropped, layers spread evenly when unset', () => {
    const manifest = parseMusicManifest({
      tracks: [
        { id: 'a', context: 'park', stems: [{ file: 'a1.ogg' }, { file: 'a2.ogg' }, { file: 'a3.ogg' }, { file: 'a4.ogg' }, { file: 'a5.ogg' }], gain: 9 },
        { id: 'a', context: 'park', stems: [{ file: 'dup.ogg' }] },
        { id: 'b', context: 'space', stems: [{ file: 'b.ogg' }] },
        { id: 'c', context: 'menu', stems: [{ file: '../secret.ogg' }, { file: 'https://x.y/z.ogg' }] },
        { id: 'd', context: 'night', stems: [{ file: 'd.ogg', from: 2 }], loopStart: 5, loopEnd: 3 },
        { id: 'e', context: 'night', stems: [{ file: 'Main theme.ogg' }], loopStart: 7.619048 },
        'nonsense',
      ],
    });
    expect(manifest.tracks.map((track) => track.id)).toEqual(['a', 'd', 'e']);
    expect(manifest.tracks[0].stems.map((stem) => stem.from)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(manifest.tracks[0].gain).toBe(2);
    expect(manifest.tracks[1].stems[0].from).toBe(1);
    expect(manifest.tracks[1].loopStart).toBeUndefined();
    expect(manifest.tracks[1].loopEnd).toBeUndefined();
    expect(manifest.tracks[2]).toMatchObject({ loopStart: 7.619048, stems: [{ files: ['Main theme.ogg'] }] });
    expect(manifest.tracks[2].loopEnd).toBeUndefined();
    expect(parseMusicManifest(null).tracks).toEqual([]);
    expect(parseMusicManifest('<!doctype html>').tracks).toEqual([]);
  });

  it('menu and night fall back to the park track; no park track means the synthesised loop', () => {
    const full = parseMusicManifest(MANIFEST);
    expect(pickTrack(full, 'menu')?.id).toBe('theme');
    expect(pickTrack(full, 'night')?.id).toBe('moon');
    const dayOnly = parseMusicManifest({ tracks: [MANIFEST.tracks[1]] });
    expect(pickTrack(dayOnly, 'menu')?.id).toBe('day');
    expect(pickTrack(dayOnly, 'night')?.id).toBe('day');
    expect(pickTrack(parseMusicManifest({ tracks: [MANIFEST.tracks[0]] }), 'park')).toBeNull();
  });

  it('a layer is full from its intensity and fades in over the ramp below it', () => {
    expect(layerLevel(0, 0)).toBe(1);
    expect(layerLevel(0.5, 0.5)).toBe(1);
    expect(layerLevel(0.5, 0.5 - LAYER_RAMP / 2)).toBeCloseTo(0.5);
    expect(layerLevel(0.5, 0.5 - LAYER_RAMP)).toBe(0);
    expect(layerLevel(0.5, 0)).toBe(0);
  });

  it('the state follows the start screen, the night and how lively the park is', () => {
    expect(musicStateOf({ menu: true, night: true, guests: 999, runningRides: 99 })).toEqual({ context: 'menu', intensity: 0 });
    expect(musicStateOf({ menu: false, night: true, guests: 0, runningRides: 0 })).toEqual({ context: 'night', intensity: 0 });
    expect(musicStateOf({ menu: false, night: false, guests: 400, runningRides: 8 })).toEqual({ context: 'park', intensity: 1 });
    expect(musicStateOf({ menu: false, night: false, guests: 200, runningRides: 0 }).intensity).toBeCloseTo(0.3);
  });

  it('picks the first file format the browser can play', () => {
    const stem = parseMusicManifest(MANIFEST).tracks[1].stems[0];
    expect(playableFile(stem, (file) => !file.endsWith('.opus'))).toBe('day-base.ogg');
    expect(playableFile(stem, () => false)).toBeNull();
  });
});

describe('music player (Phase 47)', () => {
  it('fetches nothing before the first gesture, then only the track the context wants', async () => {
    const { music, engine } = setup();
    await settle();
    expect(music.loads).toEqual([]);
    engine.unlock();
    await settle();
    expect(music.loads).toEqual(['theme.ogg']);
    expect(engine.musicTrack).toBe('theme');
    // The synthesised music gives way to the produced track.
    expect(engine.loopLevel('music')).toBe(0);
  });

  it('starts every stem of a track at one time, looping at its loop points, layers by intensity', async () => {
    const { context, engine } = setup();
    engine.setMusicState({ context: 'park', intensity: 0.4 });
    engine.unlock();
    await settle();
    expect(engine.musicTrack).toBe('day');
    const stems = context.sources.filter((candidate) => (candidate.buffer as unknown as { name?: string } | null)?.name?.startsWith('day'));
    expect(stems).toHaveLength(3);
    expect(new Set(stems.map((stem) => stem.startedAt[0])).size).toBe(1);
    expect(stems.every((stem) => stem.loop && stem.loopStart === 2 && stem.loopEnd === 40)).toBe(true);
    const layers = context.gains.slice(-3);
    expect(layers.map((layer) => layer.gain.value)).toEqual([1, 1, 0]);
    engine.setMusicState({ context: 'park', intensity: 1 });
    expect(layers.map((layer) => layer.gain.value)).toEqual([1, 1, 1]);
  });

  it('a loopStart alone loops from there to the end of the file', async () => {
    const { context, engine } = setup({ tracks: [{ id: 'main', context: 'park', loopStart: 7.5, stems: [{ file: 'main.ogg' }] }] });
    const decode = context.decodeAudioData.bind(context);
    context.decodeAudioData = async (data) => ({ ...(await decode(data)), duration: 83.8 });
    engine.unlock();
    await settle();
    const main = context.sources.at(-1) as FakeSource;
    expect(engine.musicTrack).toBe('main');
    expect([main.loop, main.loopStart, main.loopEnd]).toEqual([true, 7.5, 83.8]);
  });

  it('cross-fades between tracks and stops the old one after its fade', async () => {
    const { context, engine } = setup();
    engine.unlock();
    await settle();
    const theme = context.sources.find((candidate) => (candidate.buffer as unknown as { name: string } | null)?.name === 'theme.ogg') as FakeSource;
    engine.setMusicState({ context: 'park', intensity: 0 });
    // The menu theme plays on while the day track loads.
    expect(engine.musicTrack).toBe('theme');
    await settle();
    expect(engine.musicTrack).toBe('day');
    expect(theme.stoppedAt).toHaveLength(1);
  });

  it('a track that fails to load falls back to the synthesised loop, for the session', async () => {
    const { music, engine } = setup();
    engine.setMusicState({ context: 'night', intensity: 0 });
    engine.unlock();
    await settle();
    expect(engine.musicTrack).toBeNull();
    expect(engine.loopLevel('music')).toBe(1);
    engine.setMusicState({ context: 'night', intensity: 0.5 });
    await settle();
    expect(music.loads.filter((file) => file === 'bad-moon.ogg')).toHaveLength(1);
  });

  it('no manifest: only the synthesised loop, nothing throws', async () => {
    const { engine } = setup(null);
    engine.unlock();
    engine.setMusicState({ context: 'park', intensity: 1 });
    await settle();
    expect(engine.musicTrack).toBeNull();
    expect(engine.loopLevel('music')).toBe(1);
  });

  it('music off fades the produced track too', async () => {
    const { context, engine } = setup();
    engine.unlock();
    await settle();
    const trackGain = context.gains.at(-2) as FakeGain;
    expect(trackGain.gain.value).toBeGreaterThan(0);
    engine.setMusicPlaying(false);
    expect(trackGain.gain.value).toBe(0);
  });
});
