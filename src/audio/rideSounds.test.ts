import { describe, expect, it } from 'vitest';
import type { ParkSession } from '../game/session/ParkSession';
import type { ViewInfo } from '../rendering/RendererPort';
import { COASTER_TYPE_BY_ID } from '../game/coaster/content';
import { deriveCoasterStats } from '../game/coaster/design';
import type { CoasterPiece } from '../game/coaster/design';
import { hillDipLayout, launchOvalLayout, loopOvalLayout, ovalLayout } from '../game/coaster/testLayouts';
import { GAME_CONFIG } from '../game/config';
import { centreLineFor, centreLineIndexToDistance, createCentreLineSample, sampleCentreLine } from '../game/coaster/centreLine';
import { coasterHeadIndex } from '../rendering/coasterTrain';
import { MAX_AUDIBLE_COASTERS, RideSounds, dispatchScreamChance, dropsOf, screamChance, screamLevel } from './rideSounds';
import type { SoundId } from './synth';

/** Just the live maps RideSounds reads: one coaster (the oval unless given), a carousel and a fountain. */
const park = (pieces: CoasterPiece[] = ovalLayout({ x: 4, y: 4 }), type = 'comet-trail', intensity?: number) => {
  const derived = deriveCoasterStats(pieces, COASTER_TYPE_BY_ID.get(type)!);
  const stats = { ...derived, intensity: intensity ?? derived.intensity };
  const coaster = { status: 'running', objectId: 1, cycleRemainingSeconds: stats.durationSeconds };
  const carousel = { status: 'running', objectId: 2, cycleRemainingSeconds: 10 };
  const world = {
    tick: 0,
    coasters: new Map([[1, { objectId: 1, pieces, stats }]]),
    objects: new Map([
      [1, { id: 1, definitionId: 'comet-trail', anchor: { ...pieces[0].cell }, rotation: 0 }],
      [2, { id: 2, definitionId: 'moonpetal-carousel', anchor: { x: 6, y: 12 }, rotation: 0 }],
      [3, { id: 3, definitionId: 'ripple-fountain', anchor: { x: 10, y: 12 }, rotation: 0 }],
    ]),
  };
  const session = { world, rides: { rides: new Map([[1, coaster], [2, carousel]]) } } as unknown as ParkSession;
  return { session, world, coaster, stats };
};

const view = (patch: Partial<ViewInfo> = {}): ViewInfo => ({
  zoom: 1, x0: 0, y0: 0, x1: 31, y1: 31, cx: 8, cy: 8, halfWidth: 10, rightX: 1, rightY: 0, ...patch,
});

/** Rides `laps` whole cycles, looking four times a second; the one-shots heard, lap by lap. */
const ride = (built: ReturnType<typeof park>, laps: number, paused = false): SoundId[][] => {
  const { session, world, coaster, stats } = built;
  const sounds = new RideSounds();
  const heard: SoundId[][] = [];
  let seconds = 0;
  for (let lap = 0; lap < laps; lap += 1) {
    const played: SoundId[] = [];
    for (let into = 0; into < stats.durationSeconds; into += 0.25, seconds += 0.25) {
      coaster.cycleRemainingSeconds = stats.durationSeconds - into;
      world.tick = Math.round((seconds * 1_000) / GAME_CONFIG.fixedStepMs);
      sounds.update(session, view(), paused, (sound) => { played.push(sound); });
    }
    heard.push(played);
  }
  return heard;
};

describe('ride sounds', () => {
  it('a crest is a piece the next one is lower than; its drop runs to the bottom of the fall', () => {
    const crests = (pieces: CoasterPiece[]) => Object.fromEntries(dropsOf(pieces).flatMap((drop, index) => (drop > 0 ? [[index, drop]] : [])));
    expect(crests(ovalLayout())).toEqual({ 9: 2 });
    expect(crests(hillDipLayout())).toEqual({ 6: 3, 12: 2, 17: 2, 21: 1 });
  });

  it('a lap: the bell as it leaves, a whoosh and screams over the crest, the brakes into the station, once each', () => {
    const [first, second] = ride(park(ovalLayout(), 'comet-trail', 100), 2);
    // The first lap is seen from the station (the first look is the parked train): nothing is missed.
    for (const lap of [first, second]) {
      expect(lap[0]).toBe('bell');
      expect(lap.at(-1)).toBe('brake');
      expect(lap.filter((sound) => sound === 'whoosh')).toEqual(['whoosh']);
      expect(lap.lastIndexOf('scream')).toBeGreaterThan(lap.indexOf('whoosh'));
      expect(lap.filter((sound) => sound === 'bell' || sound === 'brake')).toEqual(['bell', 'brake']);
    }
  });

  it('inversions scream, boosts and launches fire on their pieces, once a lap', () => {
    const [loops] = ride(park(loopOvalLayout(), 'skyline-serpent', 100), 1);
    expect(loops.filter((sound) => sound === 'boost')).toEqual(['boost']);
    // Two loops and the crest; perhaps one more as it leaves.
    expect(loops.filter((sound) => sound === 'scream').length).toBeGreaterThanOrEqual(3);
    const [launch] = ride(park(launchOvalLayout(), 'thunder-launch'), 1);
    expect(launch.filter((sound) => sound === 'launch')).toEqual(['launch']);
  });

  it('a gentle ride screams less often and more quietly than an intense one; paused, nothing is heard', () => {
    const count = (intensity: number) => ride(park(ovalLayout(), 'comet-trail', intensity), 40).flat().filter((sound) => sound === 'scream').length;
    expect(count(10)).toBeLessThan(count(90));
    expect(count(90)).toBeGreaterThanOrEqual(40);
    expect(screamChance(0)).toBeCloseTo(0.2);
    expect(screamChance(80)).toBe(1);
    expect(dispatchScreamChance(40)).toBe(0);
    expect(screamLevel(20)).toBeLessThan(screamLevel(90));
    expect(ride(park(), 1, true)).toEqual([[]]);
  });

  it('a running coaster rolls where its train is, higher the faster it goes, and rattles its chain on the lift', () => {
    const { session, world, coaster, stats } = park();
    const sounds = new RideSounds();
    const played: SoundId[] = [];
    const loops = new Set<string>();
    const rates: number[] = [];
    const play = (sound: SoundId) => { played.push(sound); };
    for (let seconds = 0; seconds < stats.durationSeconds; seconds += 0.25) {
      coaster.cycleRemainingSeconds = stats.durationSeconds - seconds;
      world.tick = Math.round((seconds * 1_000) / GAME_CONFIG.fixedStepMs);
      for (const emitter of sounds.update(session, view(), false, play)) {
        loops.add(`${emitter.key}:${emitter.loop}`);
        if (emitter.loop === 'roll') rates.push(emitter.rate!);
      }
    }
    expect(loops).toEqual(new Set(['4:roll', '5:chain', '10:motor', '15:fountain']));
    expect(Math.min(...rates)).toBeGreaterThanOrEqual(0.75);
    expect(Math.max(...rates)).toBeLessThanOrEqual(1.25);
    expect(Math.max(...rates)).toBeGreaterThan(Math.min(...rates));
  });

  it('a ride across the map is not heard; paused, only the fountain plays', () => {
    const { session, coaster, stats } = park();
    const sounds = new RideSounds();
    coaster.cycleRemainingSeconds = stats.durationSeconds - GAME_CONFIG.coaster.stationLoadSeconds - 2;
    expect(sounds.update(session, view({ cx: 80, cy: 80 }), false, () => undefined)).toEqual([]);
    expect(sounds.update(session, view(), true, () => undefined).map((emitter) => emitter.loop)).toEqual(['fountain']);
    // The emitters are reused between looks: copy them.
    const near = { ...sounds.update(session, view(), false, () => undefined).find((emitter) => emitter.loop === 'roll')! };
    const edge = { ...sounds.update(session, view({ cx: 8 - 10 }), false, () => undefined).find((emitter) => emitter.loop === 'roll')! };
    expect(edge.gain).toBeLessThan(near.gain);
    expect(edge.pan).toBeGreaterThan(0);
  });

  it('a park seen for the first time mid-ride launches and screams nothing', () => {
    const { session, coaster, stats } = park();
    const sounds = new RideSounds();
    const played: SoundId[] = [];
    coaster.cycleRemainingSeconds = 3;
    expect(stats.durationSeconds).toBeGreaterThan(10);
    sounds.update(session, view(), false, (sound) => { played.push(sound); });
    expect(played).toEqual([]);
  });

  describe('at most two coasters heard (owner, 2026-10-21)', () => {
    /** Three ovals stacked down the map (y 4, 14 and 24), all running at the same point of their cycle. */
    const three = () => {
      const stats = deriveCoasterStats(ovalLayout(), COASTER_TYPE_BY_ID.get('comet-trail')!);
      const coasters = new Map<number, { objectId: number; pieces: ReturnType<typeof ovalLayout>; stats: typeof stats }>();
      const objects = new Map<number, { id: number; definitionId: string; anchor: { x: number; y: number }; rotation: number }>();
      const rides = new Map<number, { status: string; objectId: number; cycleRemainingSeconds: number }>();
      for (const [index, y] of [4, 14, 24].entries()) {
        const id = index + 1;
        const pieces = ovalLayout({ x: 4, y });
        coasters.set(id, { objectId: id, pieces, stats });
        objects.set(id, { id, definitionId: 'comet-trail', anchor: { ...pieces[0].cell }, rotation: 0 });
        rides.set(id, { status: 'running', objectId: id, cycleRemainingSeconds: stats.durationSeconds });
      }
      const world = { tick: 0, coasters, objects };
      const session = { world, rides: { rides } } as unknown as ParkSession;
      return { session, world, rides, stats };
    };
    const heardIds = (emitters: readonly { key: number }[]): number[] => [...new Set(emitters.map((emitter) => emitter.key >> 2))].sort();

    it('three coasters in view: only the two nearest the middle roll, ring and scream', () => {
      const { session, world, rides, stats } = three();
      const sounds = new RideSounds();
      const played: number[] = [];
      const ids = new Set<number>();
      let seconds = 0;
      for (let into = 0; into < stats.durationSeconds; into += 0.25, seconds += 0.25) {
        for (const ride of rides.values()) ride.cycleRemainingSeconds = stats.durationSeconds - into;
        world.tick = Math.round((seconds * 1_000) / GAME_CONFIG.fixedStepMs);
        // The middle of the screen between the first two ovals, the third further down.
        const emitters = sounds.update(session, view({ cx: 8, cy: 10, halfWidth: 16 }), false, () => { played.push(1); });
        for (const id of heardIds(emitters)) ids.add(id);
      }
      expect(MAX_AUDIBLE_COASTERS).toBe(2);
      expect([...ids].sort()).toEqual([1, 2]);
      // Two bells and two brakes a lap: two coasters, not three.
      expect(played.length).toBeGreaterThanOrEqual(4);
      expect(sounds.coasterAudible(3)).toBe(false);
      expect(sounds.coasterAudible(1)).toBe(true);
    });

    it('the third comes in when one leaves the screen, and a heard coaster is not swapped for a barely louder one', () => {
      const { session, rides, stats } = three();
      for (const ride of rides.values()) ride.cycleRemainingSeconds = stats.durationSeconds - GAME_CONFIG.coaster.stationLoadSeconds - 2;
      const sounds = new RideSounds();
      expect(heardIds(sounds.update(session, view({ cx: 8, cy: 10, halfWidth: 16 }), false, () => undefined))).toEqual([1, 2]);
      // Down the map: the first oval is now the furthest, so the third takes its place.
      expect(heardIds(sounds.update(session, view({ cx: 8, cy: 20, halfWidth: 16 }), false, () => undefined))).toEqual([2, 3]);
      // Where the first train is a touch nearer than the third (the trains are 20 cells apart in y), the heard 3 stays;
      // clearly nearer, 1 comes back.
      const record = session.world.coasters.get(1)!;
      const line = centreLineFor(record.pieces);
      const train = sampleCentreLine(line, centreLineIndexToDistance(line, coasterHeadIndex(record, rides.get(1)!.cycleRemainingSeconds)), createCentreLineSample());
      const middle = train.y + 10;
      expect(heardIds(sounds.update(session, view({ cx: train.x, cy: middle - 0.3, halfWidth: 16 }), false, () => undefined))).toEqual([2, 3]);
      expect(heardIds(sounds.update(session, view({ cx: train.x, cy: middle - 6, halfWidth: 16 }), false, () => undefined))).toEqual([1, 2]);
    });
  });
});
