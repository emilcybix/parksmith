import { describe, expect, it } from 'vitest';
import { ParkSession } from '../game/session/ParkSession';
import { GAME_CONFIG } from '../game/config';
import type { ViewInfo, WorldEffect } from '../rendering/RendererPort';
import {
  AudioEngine,
  BUS_IDS,
  SOUND_BUS,
  BED_FILES,
  EMITTER_FILES,
  MAX_VOICES,
  SOUND_FILES,
  SOUND_GAP_MS,
  type Emitter,
  gainOf,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioNodeLike,
  type BufferSourceLike,
  type GainNodeLike,
} from './AudioEngine';
import {
  TOAST_SOUND, ambienceFor, cueVoice, panFor, proximity, soundForCue, thunderBetween, volumesOf, wholeMapView, zoomMix, type CueVoice,
} from './audioDirector';
import { stormFlashAt } from '../game/weather/flash';
import { LOOP_IDS, SOUND_IDS, renderLoop, renderSound } from './synth';
import { DEFAULT_SETTINGS } from '../settings/schema';

/** A fake Web Audio context that records the graph and every call. */
class FakeContext implements AudioContextLike {
  currentTime = 0;
  state = 'running';
  readonly destination: AudioNodeLike = { connect: () => undefined };
  readonly gains: Array<GainNodeLike & { targets: number[]; connections: AudioNodeLike[] }> = [];
  readonly sources: Array<BufferSourceLike & { started: number; connections: AudioNodeLike[] }> = [];
  readonly buffers: Array<AudioBufferLike & { length: number }> = [];
  suspended = 0;

  createGain() {
    const connections: AudioNodeLike[] = [];
    const targets: number[] = [];
    const gain = {
      connections,
      targets,
      gain: { value: 1, setTargetAtTime: (target: number) => { targets.push(target); gain.gain.value = target; } },
      connect: (node: AudioNodeLike) => { connections.push(node); },
    };
    this.gains.push(gain);
    return gain;
  }

  createBuffer(_channels: number, length: number) {
    const buffer = { length, copyToChannel: () => undefined };
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource() {
    const connections: AudioNodeLike[] = [];
    const source = {
      buffer: null as AudioBufferLike | null,
      loop: false,
      started: 0,
      connections,
      connect: (node: AudioNodeLike) => { connections.push(node); },
      start: () => { source.started += 1; },
    };
    this.sources.push(source);
    return source;
  }

  resume() { return Promise.resolve(); }
  suspend() { this.suspended += 1; return Promise.resolve(); }
}

const volumes = volumesOf(DEFAULT_SETTINGS);
const unlocked = () => {
  const context = new FakeContext();
  const engine = new AudioEngine(() => context, volumes);
  engine.unlock();
  return { context, engine };
};

describe('synthesis (Phase 15)', () => {
  it('every cue and loop is finite, inside [-1, 1], audible and deterministic', () => {
    for (const id of SOUND_IDS) {
      const samples = renderSound(id, 22_050);
      expect(samples.length, id).toBeGreaterThan(200);
      let peak = 0;
      for (const value of samples) {
        expect(Number.isFinite(value)).toBe(true);
        peak = Math.max(peak, Math.abs(value));
      }
      expect(peak, id).toBeGreaterThan(0.05);
      expect(peak, id).toBeLessThanOrEqual(1);
      expect(renderSound(id, 22_050), `${id} twice`).toEqual(samples);
    }
    for (const id of LOOP_IDS) {
      const samples = renderLoop(id, 22_050);
      expect(samples.length, id).toBeGreaterThan(22_050);
      expect(samples.every((value) => Number.isFinite(value) && Math.abs(value) <= 1), id).toBe(true);
    }
  });
});

describe('AudioEngine (Phase 15)', () => {
  it('nothing exists and nothing plays before the first gesture', () => {
    let created = 0;
    const engine = new AudioEngine(() => { created += 1; return new FakeContext(); }, volumes);
    expect(engine.play('coin')).toBe(false);
    engine.setAmbience(1, 1);
    engine.setVolumes(volumes);
    expect(created).toBe(0);
    expect(engine.ready).toBe(false);
  });

  it('the gesture builds master and five buses, every buffer once, and three silent looping beds', () => {
    const { context, engine } = unlocked();
    expect(engine.ready).toBe(true);
    // master + 5 buses + 3 loop gains
    expect(context.gains.length).toBe(1 + BUS_IDS.length + LOOP_IDS.length);
    expect(context.buffers.length).toBe(SOUND_IDS.length + LOOP_IDS.length);
    const loops = context.sources.filter((source) => source.loop);
    expect(loops.length).toBe(3);
    expect(loops.every((source) => source.started === 1)).toBe(true);
    engine.unlock();
    expect(context.buffers.length, 'idempotent').toBe(SOUND_IDS.length + LOOP_IDS.length);
  });

  it('a cue plays on its bus, at most once per its gap; a silent bus or master refuses it', () => {
    const { context, engine } = unlocked();
    const busOf = (index: number) => context.gains[1 + index];
    expect(engine.play('chime')).toBe(true);
    const source = context.sources.at(-1)!;
    expect(source.connections[0]).toBe(busOf(BUS_IDS.indexOf(SOUND_BUS.chime)));
    expect(engine.play('chime'), 'too soon').toBe(false);
    context.currentTime += SOUND_GAP_MS.chime / 1_000;
    expect(engine.play('chime')).toBe(true);
    engine.setVolumes({ ...volumes, rides: 0 });
    context.currentTime += 10;
    expect(engine.play('chime'), 'rides bus off').toBe(false);
    expect(engine.play('coin'), 'ui bus on').toBe(true);
    engine.setVolumes({ ...volumes, master: 0 });
    context.currentTime += 10;
    expect(engine.play('coin'), 'master off').toBe(false);
  });

  it('volumes map to square-law gains; ambience and music move loop gains without creating anything', () => {
    const { context, engine } = unlocked();
    expect(gainOf(0)).toBe(0);
    expect(gainOf(50)).toBe(0.25);
    expect(gainOf(100)).toBe(1);
    expect(gainOf(Number.NaN)).toBe(0);
    expect(context.gains[0].gain.value).toBe(gainOf(volumes.master));
    const nodes = [context.gains.length, context.sources.length, context.buffers.length];
    for (let step = 0; step < 100; step += 1) engine.setAmbience(step / 100, 1 - step / 100);
    engine.setMusicPlaying(false);
    expect([context.gains.length, context.sources.length, context.buffers.length]).toEqual(nodes);
    expect(engine.loopLevel('crowd')).toBe(0.99);
    expect(engine.loopLevel('music')).toBe(0);
  });

  it('no Web Audio: silent for good, never throws', () => {
    const engine = new AudioEngine(() => null, volumes);
    engine.unlock();
    engine.unlock();
    expect(engine.ready).toBe(false);
    expect(engine.play('coin')).toBe(false);
    const throwing = new AudioEngine(() => { throw new Error('no audio'); }, volumes);
    expect(() => throwing.unlock()).not.toThrow();
    expect(throwing.ready).toBe(false);
  });

  it('a recorded cue replaces its synthesised buffer once decoded; a failed file keeps the synthesised one', async () => {
    const context = new FakeContext();
    const decoded: AudioBufferLike = { copyToChannel: () => undefined };
    const decoding = context as FakeContext & { decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> };
    decoding.decodeAudioData = () => Promise.resolve(decoded);
    const asked: string[] = [];
    const engine = new AudioEngine(() => context, volumes, null, {
      load: (file) => {
        asked.push(file);
        return file === SOUND_FILES.error ? Promise.reject(new Error('404')) : Promise.resolve(new ArrayBuffer(8));
      },
    });
    engine.unlock();
    expect(asked.sort()).toEqual([...Object.values(SOUND_FILES), ...Object.values(EMITTER_FILES), ...Object.values(BED_FILES)].sort());
    expect(engine.play('click')).toBe(true);
    expect(context.sources.at(-1)!.buffer, 'synthesised before the decode').not.toBe(decoded);
    await new Promise((resolve) => setTimeout(resolve, 0));
    context.currentTime += 10;
    expect(engine.play('click')).toBe(true);
    expect(context.sources.at(-1)!.buffer).toBe(decoded);
    expect(engine.play('error')).toBe(true);
    const error = context.sources.at(-1)!.buffer;
    expect(error).not.toBeNull();
    expect(error, 'the failed file keeps the synthesised cue').not.toBe(decoded);
    expect(engine.play('coin')).toBe(true);
    expect(context.sources.at(-1)!.buffer, 'a cue with no file stays synthesised').not.toBe(decoded);
  });

  it('the zoom mix scales the park buses and the music, never the UI; a muted park refuses its cues', () => {
    const { context, engine } = unlocked();
    const bus = (id: (typeof BUS_IDS)[number]) => context.gains[1 + BUS_IDS.indexOf(id)];
    engine.setMix(0, 1);
    expect(bus('rides').gain.value).toBe(0);
    expect(bus('ambience').gain.value).toBe(0);
    expect(bus('guests').gain.value).toBe(0);
    expect(bus('music').gain.value).toBe(gainOf(volumes.music));
    expect(bus('ui').gain.value).toBe(gainOf(volumes.ui));
    expect(engine.play('chime'), 'park muted').toBe(false);
    expect(engine.play('coin'), 'ui still on').toBe(true);
    engine.setMix(1, 0);
    expect(bus('music').gain.value).toBe(0);
    expect(bus('rides').gain.value).toBe(gainOf(volumes.rides));
    expect(engine.play('chime')).toBe(true);
  });

  it('a cue plays at its proximity and pan; too faint is not started; a recorded-only cue waits for its file', () => {
    const context = new FakeContext();
    const panners: Array<{ pan: { value: number } }> = [];
    (context as unknown as { createStereoPanner: () => unknown }).createStereoPanner = () => {
      const panner = { pan: { value: 0, setTargetAtTime: (v: number) => { panner.pan.value = v; } }, connect: () => undefined };
      panners.push(panner);
      return panner;
    };
    const engine = new AudioEngine(() => context, volumes);
    engine.unlock();
    const gains = context.gains.length;
    expect(engine.play('chime', 0.5, -0.4)).toBe(true);
    expect(context.gains.length).toBe(gains + 1);
    expect(context.gains.at(-1)!.gain.value).toBe(0.5);
    expect(panners.at(-1)!.pan.value).toBe(-0.4);
    context.currentTime += 10;
    expect(engine.play('chime', 0.001)).toBe(false);
    expect(engine.play('scream'), 'no file decoded').toBe(false);
  });

  it('positional loops: a voice per audible key, the loudest MAX_VOICES, faded out and stopped when gone', async () => {
    const context = new FakeContext();
    const stopped: number[] = [];
    const create = context.createBufferSource.bind(context);
    context.createBufferSource = () => {
      const source = create();
      (source as BufferSourceLike).stop = () => { stopped.push(1); };
      return source;
    };
    (context as unknown as { decodeAudioData: () => Promise<AudioBufferLike> }).decodeAudioData = () => Promise.resolve({ copyToChannel: () => undefined });
    const engine = new AudioEngine(() => context, volumes, null, { load: () => Promise.resolve(new ArrayBuffer(8)) });
    engine.unlock();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const emitters = (count: number, gain = 0.5): Emitter[] => Array.from({ length: count }, (_, key) => ({ key, loop: 'roll', gain: gain + key / 100, pan: 0 }));
    engine.setEmitters(emitters(3));
    expect(engine.voiceCount).toBe(3);
    const sources = context.sources.length;
    engine.setEmitters(emitters(3));
    expect(context.sources.length, 'kept voices create nothing').toBe(sources);
    engine.setEmitters(emitters(MAX_VOICES + 5));
    expect(engine.voiceCount).toBe(MAX_VOICES);
    engine.setEmitters([]);
    expect(engine.voiceCount).toBe(0);
    expect(stopped.length, 'the three quietest gave way, then all').toBe(3 + MAX_VOICES);
    engine.setEmitters(emitters(2, 0.001));
    expect(engine.voiceCount, 'too faint').toBe(0);
    // The recorded beds replaced the synthesised crowd and machinery.
    engine.setAmbience(0.5, 0.5, 1);
    expect(engine.loopLevel('crowd')).toBe(0);
    expect(engine.bedLevel('crowd')).toBe(0.5);
    expect(engine.bedLevel('chatter')).toBe(0.25);
    expect(engine.bedLevel('day')).toBe(1);
  });

  it('suspends while hidden', () => {
    const { context, engine } = unlocked();
    engine.setSuspended(true);
    expect(context.suspended).toBe(1);
  });
});

describe('audio director (Phase 15)', () => {
  const view = (patch: Partial<ViewInfo> = {}): ViewInfo => ({
    zoom: 1, x0: 0, y0: 0, x1: 31, y1: 31, cx: 16, cy: 16, halfWidth: 10, rightX: 1, rightY: 0, ...patch,
  });
  const voice = (): CueVoice => ({ sound: 'click', gain: 0, pan: 0 });

  it('player cues are heard in full anywhere; world cues by their distance to the middle of the screen', () => {
    const session = new ParkSession(null);
    const ride = session.world.seedScenarioObject('petal-roundabout', { x: 15, y: 15 })!;
    expect(cueVoice({ kind: 'money-spend', x: 99, y: 99, objectId: null, amount: -5 }, view(), session, voice())).toEqual({ sound: 'spend', gain: 1, pan: 0 });
    const near = cueVoice({ kind: 'ride-cycle', x: 0, y: 0, objectId: ride.id, amount: 0 }, view(), session, voice())!;
    expect(near.sound).toBe('chime');
    expect(near.gain).toBeGreaterThan(0.9);
    const edge = cueVoice({ kind: 'ride-cycle', x: 0, y: 0, objectId: ride.id, amount: 0 }, view({ cx: 6 }), session, voice())!;
    expect(edge.gain).toBeLessThan(near.gain);
    expect(edge.gain).toBeGreaterThan(0.3);
    expect(edge.pan, 'the ride is right of the middle').toBeGreaterThan(0);
    expect(cueVoice({ kind: 'ride-cycle', x: 0, y: 0, objectId: ride.id, amount: 0 }, view({ cx: 60 }), session, voice()), 'far away').toBeNull();
    expect(cueVoice({ kind: 'repair', x: 0, y: 0, objectId: 9_999, amount: 0 }, view(), session, voice())).toBeNull();
    expect(proximity(view(), 16, 16)).toBe(1);
    expect(proximity(view(), 16 + 15, 16)).toBeLessThan(0.15);
    expect(proximity(view(), 16 + 30, 16)).toBe(0);
    expect(panFor(view({ rightX: 0, rightY: -1 }), 16, 10), 'a turned view pans by the screen, not the map').toBeGreaterThan(0);
  });

  it('a water build splashes, a water ride ends in a splash, a coaster breaks down with a crash, a toilet flushes', () => {
    const session = new ParkSession(null);
    const fountain = session.world.seedScenarioObject('ripple-fountain', { x: 4, y: 4 })!;
    const ride = session.world.seedScenarioObject('petal-roundabout', { x: 10, y: 10 })!;
    const rings = session.world.seedScenarioObject('splash-rings', { x: 20, y: 20 })!;
    const cabin = session.world.seedScenarioObject('comfort-cabin', { x: 4, y: 20 })!;
    session.syncWithWorld();
    const cue = (kind: WorldEffect['kind'], objectId: number | null) => soundForCue({ kind, x: 3, y: 3, objectId, amount: 0 }, session);
    expect(cue('build', fountain.id)).toBe('splash');
    expect(cue('build', ride.id)).toBe('build');
    expect(cue('build', null)).toBe('build');
    expect(cue('ride-cycle', rings.id)).toBe('splash-big');
    expect(cue('ride-cycle', ride.id)).toBe('chime');
    expect(cue('breakdown', ride.id)).toBe('clank');
    expect(cue('sale', cabin.id)).toBe('flush');
    expect(TOAST_SOUND).toEqual({ alert: 'error', important: 'notify', routine: null });
  });

  it('zoomed in only the park is heard, zoomed out only the music, the start screen is all music', () => {
    const out = { park: 0, music: 0 };
    expect(zoomMix(1, false, out)).toEqual({ park: 1, music: 0 });
    expect(zoomMix(0, false, out)).toEqual({ park: 0, music: 1 });
    const middle = { ...zoomMix(0.5, false, out) };
    expect(middle.park).toBeCloseTo(Math.SQRT1_2);
    expect(middle.music).toBeCloseTo(Math.SQRT1_2);
    expect(zoomMix(1, true, out)).toEqual({ park: 0, music: 1 });
  });

  it('thunder follows the bolts the sky draws, once each', () => {
    const seed = 12_345;
    let bolts = 0;
    for (let t = 0; t < 600; t += 0.25) {
      const bolt = thunderBetween(seed, t, t + 0.25);
      if (bolt === 0) continue;
      bolts += 1;
      // The sky flashes within the flash's duration after the bolt's start.
      let flashed = false;
      for (let u = t; u < t + 0.6; u += 0.05) if (stormFlashAt(seed, u).boltSeed === bolt) flashed = true;
      expect(flashed).toBe(true);
    }
    expect(bolts).toBeGreaterThan(10);
    expect(thunderBetween(0, 0, 10)).toBe(0);
    expect(thunderBetween(seed, 10, 10)).toBe(0);
  });

  it('the beds follow the guests and running rides near the middle of the screen, and machinery stops while paused', () => {
    const session = new ParkSession(null);
    expect(ambienceFor(view(), session, false)).toEqual({ crowd: 0, machinery: 0 });
    session.world.addMoney(20_000);
    session.world.buildPaths(Array.from({ length: 10 }, (_, index) => ({ x: 15, y: 30 - index })));
    session.world.buildObject('petal-roundabout', { x: 16, y: 24 });
    session.syncWithWorld();
    session.guests.spawnGuests(240);
    for (let tick = 0; tick < 600; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
    const over = ambienceFor(view({ cx: 15, cy: 26 }), session, false);
    const away = ambienceFor(view({ cx: 15, cy: 2 }), session, false);
    expect(over.crowd).toBeGreaterThan(away.crowd);
    expect(over.crowd).toBeGreaterThan(0);
    expect(ambienceFor(view({ cx: 80, cy: 80 }), session, false).crowd).toBe(0);
    expect(ambienceFor(view({ cx: 15, cy: 26 }), session, true).machinery).toBe(0);
    expect(wholeMapView(session, view())).toEqual({ zoom: 0.5, x0: 0, y0: 0, x1: 31, y1: 31, cx: 16, cy: 16, halfWidth: 16, rightX: 1, rightY: 0 });
  });
});
