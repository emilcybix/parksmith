import { describe, expect, it } from 'vitest';
import type { ParkSession } from '../game/session/ParkSession';
import type { ViewInfo } from '../rendering/RendererPort';
import { COASTER_TYPE_BY_ID } from '../game/coaster/content';
import { deriveCoasterStats } from '../game/coaster/design';
import { ovalLayout } from '../game/coaster/testLayouts';
import { GAME_CONFIG } from '../game/config';
import { RideSounds, crestOf } from './rideSounds';
import type { SoundId } from './synth';

/** Just the live maps RideSounds reads: one oval coaster, a carousel and a fountain. */
const park = () => {
  const pieces = ovalLayout({ x: 4, y: 4 });
  const stats = deriveCoasterStats(pieces, COASTER_TYPE_BY_ID.get('comet-trail')!);
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

describe('ride sounds', () => {
  it('a running coaster rolls where its train is, rattles its chain on the lift and screams once over its crest', () => {
    const { session, world, coaster, stats } = park();
    const sounds = new RideSounds();
    const played: SoundId[] = [];
    const loops = new Set<string>();
    const play = (sound: SoundId) => { played.push(sound); };
    for (let seconds = 0; seconds < stats.durationSeconds; seconds += 0.25) {
      coaster.cycleRemainingSeconds = stats.durationSeconds - seconds;
      world.tick = Math.round((seconds * 1_000) / GAME_CONFIG.fixedStepMs);
      for (const emitter of sounds.update(session, view(), false, play)) loops.add(`${emitter.key}:${emitter.loop}`);
    }
    expect(crestOf(ovalLayout()).drop).toBe(2);
    expect(played.filter((sound) => sound === 'scream')).toEqual(['scream']);
    expect(loops).toEqual(new Set(['4:roll', '5:chain', '10:motor', '15:fountain']));
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
});
