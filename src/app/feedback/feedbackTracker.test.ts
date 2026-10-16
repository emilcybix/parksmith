import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../game/config';
import { hashState } from '../../game/save/hash';
import { ParkSession } from '../../game/session/ParkSession';
import type { WorldEffect } from '../../rendering/RendererPort';
import { CUES_PER_SECOND, FeedbackTracker, REACTIONS_PER_SAMPLE, reactionOf } from './feedbackTracker';

const recorder = () => {
  const cues: WorldEffect[] = [];
  const tracker = new FeedbackTracker((effect) => cues.push({ ...effect }));
  return { cues, tracker };
};

/** A small working park: a spine, a ride, a stall, guests. */
const busyPark = (): ParkSession => {
  const session = new ParkSession(null);
  session.world.addMoney(50_000);
  session.world.buildPaths(Array.from({ length: 12 }, (_, index) => ({ x: 15, y: 30 - index })));
  session.world.buildObject('petal-roundabout', { x: 16, y: 24 });
  session.world.buildObject('picnic-pocket', { x: 13, y: 26 });
  session.world.buildObject('fizz-foundry', { x: 13, y: 22 });
  session.syncWithWorld();
  return session;
};

const run = (session: ParkSession, tracker: FeedbackTracker, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick += 1) {
    session.step(GAME_CONFIG.fixedStepMs);
    tracker.observe();
  }
};

describe('FeedbackTracker (Phase 15)', () => {
  it('classifies delight and complaints, and ignores passing needs and plans', () => {
    expect(reactionOf('That was fantastic!')).toBe('happy');
    expect(reactionOf('That snack hit the spot!')).toBe('happy');
    expect(reactionOf('This queue is taking forever.')).toBe('unhappy');
    expect(reactionOf("I'm not paying that much.")).toBe('unhappy');
    expect(reactionOf('I am getting hungry.')).toBeNull();
    expect(reactionOf('Heading for Petal Roundabout.')).toBeNull();
  });

  it('cues ride cycles, sales and reactions from a running park, within the per-second budget', () => {
    const session = busyPark();
    const timed: Array<{ second: number; kind: string }> = [];
    const cues: WorldEffect[] = [];
    const tracker = new FeedbackTracker((effect) => {
      cues.push({ ...effect });
      timed.push({ second: Math.floor((session.world.tick * GAME_CONFIG.fixedStepMs) / 1_000), kind: effect.kind });
    });
    tracker.attach(session);
    run(session, tracker, 3_000);
    const kinds = new Set(cues.map((cue) => cue.kind));
    expect(kinds.has('ride-cycle')).toBe(true);
    expect(kinds.has('sale')).toBe(true);
    expect(kinds.has('happy') || kinds.has('unhappy')).toBe(true);
    // Never more than the budget in one simulated second, and never more than two reactions a sample.
    const perSecond = new Map<number, number>();
    const reactionsPerSecond = new Map<number, number>();
    for (const cue of timed) {
      perSecond.set(cue.second, (perSecond.get(cue.second) ?? 0) + 1);
      if (cue.kind === 'happy' || cue.kind === 'unhappy') reactionsPerSecond.set(cue.second, (reactionsPerSecond.get(cue.second) ?? 0) + 1);
    }
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(CUES_PER_SECOND);
    expect(Math.max(0, ...reactionsPerSecond.values())).toBeLessThanOrEqual(REACTIONS_PER_SAMPLE);
  }, 60_000);

  it('a fresh attach replays nothing that already happened', () => {
    const session = busyPark();
    const { cues, tracker } = recorder();
    tracker.attach(session);
    run(session, tracker, 1_500);
    cues.length = 0;
    const later = new FeedbackTracker((effect) => cues.push({ ...effect }));
    later.attach(session);
    later.observe();
    expect(cues).toEqual([]);
  }, 60_000);

  it('player money cues are never dropped and carry the amount; zero moves nothing', () => {
    const { cues, tracker } = recorder();
    tracker.attach(new ParkSession(null));
    for (let index = 0; index < CUES_PER_SECOND * 2; index += 1) tracker.money(-100, 3, 4);
    tracker.money(0, 3, 4);
    expect(cues.length).toBe(CUES_PER_SECOND * 2);
    expect(cues[0]).toEqual({ kind: 'money-spend', x: 3, y: 4, objectId: null, amount: -100 });
    tracker.money(40, 1, 1, 7);
    expect(cues.at(-1)).toEqual({ kind: 'money-gain', x: 1, y: 1, objectId: 7, amount: 40 });
  });

  it('is presentation only: a park observed every tick plays bit-identically to one never observed', () => {
    const watched = busyPark();
    const plain = busyPark();
    const { tracker } = recorder();
    tracker.attach(watched);
    run(watched, tracker, 1_200);
    for (let tick = 0; tick < 1_200; tick += 1) plain.step(GAME_CONFIG.fixedStepMs);
    expect(hashState(watched.serialize())).toBe(hashState(plain.serialize()));
  }, 60_000);
});
