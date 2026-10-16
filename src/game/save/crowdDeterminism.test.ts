import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { compileParkRules, type ParkRuleset } from '../scenarios/rules';
import { seedDevPark } from '../session/devPark';
import { ParkSession } from '../session/ParkSession';
import { runReference, runTwin, viaJson, type RunOptions } from './determinismHarness';
import { hashState } from './hash';

/**
 * Phase 14 determinism (design section 8):
 * 1. A crowded dev park with the congestion feedback really engaged (slowed and severe tiles) saved mid-run, restored
 *    into a fresh session and run on lands on the reference bit for bit (state, events, fingerprints, observables).
 * 2. Inert below threshold: a park that never reaches the lane capacity hashes the same with the feedback on and off once
 *    the two Phase 14 keys (`rules.crowdFeedback`, `crowd`) are stripped.
 * 3. The display never feeds back: a rule-off park's field is presentation only, so perturbing it changes nothing saved.
 */

const STEP_MS = GAME_CONFIG.fixedStepMs;

const rulesWithoutFeedback = (): ParkRuleset => {
  const rules: ParkRuleset = { ...compileParkRules() };
  delete rules.crowdFeedback;
  return Object.freeze(rules);
};

const devPark = (guests: number, feedback: boolean): ParkSession => {
  const session = feedback ? new ParkSession(null) : new ParkSession(null, [], { rules: rulesWithoutFeedback() });
  seedDevPark(session);
  session.syncWithWorld();
  session.guests.spawnGuests(guests);
  return session;
};

/** How many path tiles slow walkers right now, and how many are severe. */
const engagement = (session: ParkSession): { slowed: number; severe: number } => {
  const { width } = session.world;
  let slowed = 0;
  let severe = 0;
  for (const index of session.crowd.shape().cells) {
    const cell = { x: index % width, y: Math.floor(index / width) };
    if (session.crowd.speedFactorAt(cell) < 1) slowed += 1;
    if (session.crowd.isSevereAt(cell)) severe += 1;
  }
  return { slowed, severe };
};

const withoutCrowdKeys = (state: unknown): string => {
  const copy = JSON.parse(JSON.stringify(state)) as { crowd?: unknown; rules?: Record<string, unknown> };
  delete copy.crowd;
  if (copy.rules) delete copy.rules.crowdFeedback;
  return hashState(copy);
};

describe('crowd feedback engaged: save, restore and continue', () => {
  const SAVE_POINTS = [120, 333];
  const options: RunOptions = {
    build: () => devPark(450, true),
    // A path tile rebuilt mid-run: the path shape (lane widths, articulation) is re-derived on both sides.
    act: (session, tick) => {
      if (tick === 200) {
        session.world.bulldoze({ x: 23, y: 11 });
        session.world.buildPaths([{ x: 23, y: 11 }]);
        session.syncWithWorld();
      }
    },
    total: 500,
    checkpointTicks: new Set([0, 100, 200, 300, 400, ...SAVE_POINTS]),
    checkpoints: true,
    observeAtEnd: true,
  };
  const reference = runReference(options);

  it('the park is really crowded at each save point (slowed and severe tiles, a saved field)', () => {
    for (const tick of SAVE_POINTS) {
      const probe = options.build();
      for (let step = 0; step < tick; step += 1) {
        options.act(probe, step);
        probe.step(STEP_MS);
      }
      const { slowed, severe } = engagement(probe);
      expect(slowed, `slowed tiles at ${tick}`).toBeGreaterThan(0);
      expect(severe, `severe tiles at ${tick}`).toBeGreaterThan(0);
      expect(probe.serialize().crowd?.pressure.length, `saved field at ${tick}`).toBeGreaterThan(0);
    }
    expect(reference.finalState.rules.crowdFeedback).toBe(1);
  });

  it.each(SAVE_POINTS)('saved at tick %i, restored into a fresh session, continues identically', (tick) => {
    const { trace, liveDifference, restoredImmediateHash, savedHash } = runTwin(options, tick, viaJson);
    expect(liveDifference).toBeNull();
    expect(restoredImmediateHash).toBe(savedHash);
    expect(reference.checkpointHashes.get(tick)).toBe(savedHash);
    for (const [checkpoint, hash] of trace.checkpointHashes) expect(hash, `checkpoint ${checkpoint}`).toBe(reference.checkpointHashes.get(checkpoint));
    expect(trace.eventHashes).toEqual(reference.eventHashes.slice(tick));
    expect(trace.fingerprints).toEqual(reference.fingerprints.slice(tick));
    expect(trace.finalHash).toBe(reference.finalHash);
    expect(trace.observables).toEqual(reference.observables);
  }, 20_000);
});

describe('inert below the lane capacity', () => {
  it('a park that never reaches load 1 hashes the same with the feedback on and off, apart from the two keys', () => {
    const on = devPark(60, true);
    const off = devPark(60, false);
    const onEvents: string[] = [];
    const offEvents: string[] = [];
    for (let tick = 0; tick < 600; tick += 1) {
      onEvents.push(hashState(on.step(STEP_MS)));
      offEvents.push(hashState(off.step(STEP_MS)));
      expect(engagement(on).slowed, `no tile at load 1 (tick ${tick})`).toBe(0);
    }
    const onState = on.serialize();
    const offState = off.serialize();
    expect(onState.rules.crowdFeedback).toBe(1);
    expect(onState.crowd?.pressure.length, 'the feedback park saved its field').toBeGreaterThan(0);
    expect('crowdFeedback' in offState.rules).toBe(false);
    expect('crowd' in offState).toBe(false);
    expect(onEvents).toEqual(offEvents);
    expect(withoutCrowdKeys(onState)).toBe(hashState(offState));
  });
});

describe('the display never feeds back', () => {
  it('a rule-off park with its field flooded mid-run plays and saves exactly like one left alone', () => {
    const plain = devPark(300, false);
    const flooded = devPark(300, false);
    const events: [string[], string[]] = [[], []];
    for (let tick = 0; tick < 400; tick += 1) {
      if (tick === 100) {
        // Every path tile far above severe on the display field (which a rule-off park never reads).
        const pressure = Math.round((10 * GAME_CONFIG.crowd.bands.severe * GAME_CONFIG.crowd.entryUnits * GAME_CONFIG.crowd.decayDivisor) / 600);
        flooded.crowd.restore({ version: 1, pressure: [...flooded.crowd.shape().cells].map((cell) => [cell, pressure] as [number, number]) });
        expect(flooded.crowdHeatmap().bands.every((band) => band === 3), 'the heatmap shows the flood').toBe(true);
        expect(engagement(flooded), 'but nothing is slowed or severe for play').toEqual({ slowed: 0, severe: 0 });
      }
      events[0].push(hashState(plain.step(STEP_MS)));
      events[1].push(hashState(flooded.step(STEP_MS)));
    }
    expect(events[1]).toEqual(events[0]);
    expect(hashState(flooded.serialize())).toBe(hashState(plain.serialize()));
    expect('crowd' in flooded.serialize()).toBe(false);
  });
});
