import { describe, expect, it } from 'vitest';
import { ParkSession } from '../game/session/ParkSession';
import { GAME_CONFIG } from '../game/config';
import type { ViewInfo } from '../rendering/RendererPort';
import {
  AudioEngine,
  BUS_IDS,
  SOUND_BUS,
  SOUND_GAP_MS,
  gainOf,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioNodeLike,
  type BufferSourceLike,
  type GainNodeLike,
} from './AudioEngine';
import { ambienceFor, soundForCue, volumesOf, wholeMapView } from './audioDirector';
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

  it('suspends while hidden', () => {
    const { context, engine } = unlocked();
    engine.setSuspended(true);
    expect(context.suspended).toBe(1);
  });
});

describe('audio director (Phase 15)', () => {
  const view = (patch: Partial<ViewInfo> = {}): ViewInfo => ({ zoom: 1, x0: 0, y0: 0, x1: 31, y1: 31, ...patch });

  it('player cues are always heard; world cues only on screen', () => {
    const session = new ParkSession(null);
    const ride = session.world.seedScenarioObject('petal-roundabout', { x: 8, y: 8 })!;
    expect(soundForCue({ kind: 'money-spend', x: 99, y: 99, objectId: null, amount: -5 }, view({ x1: 1, y1: 1 }), session)).toBe('spend');
    expect(soundForCue({ kind: 'ride-cycle', x: 0, y: 0, objectId: ride.id, amount: 0 }, view(), session)).toBe('chime');
    expect(soundForCue({ kind: 'ride-cycle', x: 0, y: 0, objectId: ride.id, amount: 0 }, view({ x0: 20, y0: 20 }), session)).toBeNull();
    expect(soundForCue({ kind: 'happy', x: 3, y: 3, objectId: null, amount: 0 }, view(), session)).toBe('happy');
    expect(soundForCue({ kind: 'repair', x: 0, y: 0, objectId: 9_999, amount: 0 }, view(), session)).toBeNull();
  });

  it('the beds follow the guests and running rides in view, louder closer, and machinery stops while paused', () => {
    const session = new ParkSession(null);
    expect(ambienceFor(view(), session, false)).toEqual({ crowd: 0, machinery: 0 });
    session.world.addMoney(20_000);
    session.world.buildPaths(Array.from({ length: 10 }, (_, index) => ({ x: 15, y: 30 - index })));
    session.world.buildObject('petal-roundabout', { x: 16, y: 24 });
    session.syncWithWorld();
    session.guests.spawnGuests(240);
    for (let tick = 0; tick < 600; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
    const near = ambienceFor(view({ zoom: 1 }), session, false);
    const far = ambienceFor(view({ zoom: 0 }), session, false);
    expect(near.crowd).toBeGreaterThan(far.crowd);
    expect(near.crowd).toBeGreaterThan(0);
    expect(ambienceFor(view({ x0: 0, y0: 0, x1: 2, y1: 2 }), session, false).crowd).toBe(0);
    expect(ambienceFor(view(), session, true).machinery).toBe(0);
    expect(wholeMapView(session, view())).toEqual({ zoom: 0.5, x0: 0, y0: 0, x1: 31, y1: 31 });
  });
});
