import { describe, expect, it } from 'vitest';
import { ParkSession } from '../session/ParkSession';
import { DETERMINISM_FIXTURES } from './determinismFixtures';
import {
  firstDifference,
  ownerHashes,
  runReference,
  runTwin,
  viaJson,
  type RunOptions,
  type RunTrace,
} from './determinismHarness';
import { hashState } from './hash';
import { assertPlainData, assertStructuredCloneSafe } from './plainData';
import type { ParkSaveV7 } from './state';

/**
 * THE HARD ACCEPTANCE CRITERION of Phase 12: save mid-park, load into a fresh session, run on, and
 * land on a byte-identical state to a run that was never saved.
 *
 * For each fixture park and each of its save points K:
 *   reference  = build, then act+step to the end, never saved;
 *   twin       = the same to K, serialize, JSON round trip, ParkSession.fromState (a fresh session),
 *                continue to the end.
 * Compared: the hash of the whole serialized state at every 50th tick and at the end, the hash of
 * every step's event stream, a per-tick fingerprint, and (end of run, public API only) the
 * observables in determinismHarness.observe, so an omission the state hash cannot see still shows.
 * A mismatch names the first divergent tick and the first differing state path, and the owner
 * hashes narrow it to the owner that diverged first.
 */

const CHECKPOINT_EVERY = 50;

const optionsFor = (fixture: (typeof DETERMINISM_FIXTURES)[number], checkpoints: boolean): RunOptions => {
  const ticks = new Set<number>();
  for (let tick = 0; tick < fixture.total; tick += CHECKPOINT_EVERY) ticks.add(tick);
  for (const point of fixture.savePoints) ticks.add(point.tick);
  return {
    build: fixture.build,
    act: fixture.act,
    total: fixture.total,
    checkpointTicks: ticks,
    checkpoints,
    observeAtEnd: true,
  };
};

const describeDivergence = (reference: RunTrace, twin: RunTrace, saveTick: number): string => {
  const lines: string[] = [];
  for (const tick of [...twin.checkpointHashes.keys()].sort((a, b) => a - b)) {
    if (twin.checkpointHashes.get(tick) === reference.checkpointHashes.get(tick)) continue;
    const left = reference.checkpointStates.get(tick)!;
    const right = twin.checkpointStates.get(tick)!;
    const leftOwners = ownerHashes(left);
    const rightOwners = ownerHashes(right);
    const owners = Object.keys(leftOwners).filter((key) => leftOwners[key] !== rightOwners[key]);
    lines.push(`first divergent checkpoint: tick ${tick} (saved at ${saveTick}); owners: ${owners.join(', ')}; first path: ${firstDifference(left, right)}`);
    break;
  }
  const eventIndex = twin.eventHashes.findIndex((hash, index) => hash !== reference.eventHashes[saveTick + index]);
  if (eventIndex >= 0) lines.push(`events first differ at tick ${saveTick + eventIndex}`);
  const fingerprintIndex = twin.fingerprints.findIndex((value, index) => value !== reference.fingerprints[saveTick + index]);
  if (fingerprintIndex >= 0) lines.push(`fingerprint first differs at tick ${saveTick + fingerprintIndex}`);
  if (lines.length === 0) lines.push(`end state first path: ${firstDifference(reference.finalState, twin.finalState)}`);
  return lines.join(' | ');
};

describe.each(DETERMINISM_FIXTURES)('determinism: $name', (fixture) => {
  const withCheckpoints = optionsFor(fixture, true);
  const reference = runReference(withCheckpoints);
  const pure = runReference(optionsFor(fixture, false));

  it('a run that serializes at every checkpoint is identical to one that never does (saving is pure)', () => {
    expect(reference.finalHash, 'serializing mid-run changed the final state').toBe(pure.finalHash);
    expect(reference.eventHashes, 'serializing mid-run changed the event stream').toEqual(pure.eventHashes);
    expect(reference.fingerprints).toEqual(pure.fingerprints);
    expect(hashState(reference.observables), 'observables differ after serializing mid-run').toBe(hashState(pure.observables));
  });

  it.each(fixture.savePoints.map((point) => [point.tick, point] as const))(
    'saved at tick %i, restored into a fresh session, continues identically',
    (tick, point) => {
      // The state the save point exists to cover is really there (checked on a pristine replay).
      if (point.expect) {
        const probe = fixture.build();
        for (let step = 0; step <= tick; step += 1) {
          fixture.act(probe, step);
          if (step < tick) probe.step(100);
        }
        expect(point.expect(probe), `fixture ${fixture.name} is not in the state save point ${tick} is meant to cover`).toEqual([]);
      }

      const { trace, savedJson, restoredImmediateHash, savedHash, liveDifference } = runTwin(withCheckpoints, tick, viaJson);
      // The state hash cannot see a field that serialize() drops (both sides lack it), so the live
      // object graphs are compared too: any default that restore falls back to shows here.
      expect(liveDifference, 'the restored session differs from the session that was saved').toBeNull();
      expect(restoredImmediateHash, 'restoring and re-serializing changed the state').toBe(savedHash);
      expect(reference.checkpointHashes.get(tick), 'the saved state differs from the reference at the save tick').toBe(savedHash);
      expect(JSON.stringify(ParkSession.fromState(JSON.parse(savedJson) as ParkSaveV7).serialize()), 'JSON of a restored session is not byte-identical').toBe(savedJson);

      const message = describeDivergence(reference, trace, tick);
      for (const [checkpoint, hash] of trace.checkpointHashes) {
        expect(hash, `${message}`).toBe(reference.checkpointHashes.get(checkpoint));
      }
      expect(trace.eventHashes, `event streams: ${message}`).toEqual(reference.eventHashes.slice(tick));
      expect(trace.fingerprints, `fingerprints: ${message}`).toEqual(reference.fingerprints.slice(tick));
      expect(trace.finalHash, message).toBe(reference.finalHash);
      expect(trace.observables, 'public-API observables differ after the run').toEqual(reference.observables);
    },
    // A replay of the 1,000-guest dev park can pass 5 s under a loaded full-suite run.
    20_000,
  );

  it('survives structuredClone as well as JSON (the IndexedDB transport) at the middle save point', () => {
    const point = fixture.savePoints[Math.floor(fixture.savePoints.length / 2)];
    const { trace } = runTwin(withCheckpoints, point.tick, (state) => {
      assertStructuredCloneSafe(state);
      return structuredClone(state);
    });
    expect(trace.finalHash).toBe(reference.finalHash);
    expect(trace.observables).toEqual(reference.observables);
  });

  it('the saved states are plain data', () => {
    for (const state of reference.checkpointStates.values()) assertPlainData(state);
    assertPlainData(reference.finalState);
  });
});

describe('fixture 2c (Phase 25): the one-shot ledger has the same hash in every process', () => {
  it('the reference run of the run stage with a played one-shot lands on its pinned final hash', () => {
    const fixture = DETERMINISM_FIXTURES.find((entry) => entry.name.startsWith('run stage, one-shot'))!;
    const trace = runReference({ build: fixture.build, act: fixture.act, total: fixture.total, checkpointTicks: new Set(), checkpoints: false, observeAtEnd: false });
    // Plan version 4 (Phase 25 retune): the run state carries planVersion 4 and Standard level 1 starts with $9,750 (was
    // 4745db6d67866695 at plan version 3).
    // Re-pinned 2026-10-13, Phase 16 (content version 3): a new run stage's ruleset gains themeAffinity 0.2 and
    // researchCostScale 10 (was c89b96829fea63a9). Only the two rule keys move it: with them removed the final state hashes
    // exactly as before (58e247b2a6d210a6 under both configs).
    // Re-pinned 2026-10-14, Phase 14 (content version 4): a new run stage's ruleset gains crowdFeedback 1 and the save the
    // crowd field (was d161fbe4f931a5cf). Only the two keys move it: the stage never reaches the lane capacity, so with them
    // removed the final state hashes exactly as before (and d161fbe4f931a5cf is the raw hash with the feedback mocked to 0).
    // Re-pinned 2026-10-15, Phase 29 (schema 15, content version 5): guest life changes how the stage plays (was
    // 67c4bce665660211, and d161fbe4f931a5cf without the two Phase 14 keys).
    // Phase 30 (2026-10-15) moved nothing here: the need gate on life activities sits at the leave thresholds (its
    // designed level, 72, moved this to f26de45713f9ad70 and two run-margin proofs to exactly 90%, so it was not kept),
    // and no guest in this stage ends with a complaint link (the optional thoughtObjectId key).
    // Re-pinned 2026-10-16, Phase 40 (schema 16): a new run stage's ruleset gains frontAccess 1 (was 1084c7e6bdd7acf4).
    // Only the key moves it: every service of the stage already faces its path, so with the key removed the final
    // state hashes exactly as before (the assertion below).
    expect(trace.finalHash).toBe('e2363ed1a989f9fe');
    const withoutFront = JSON.parse(JSON.stringify(trace.finalState)) as { rules: Record<string, unknown> };
    expect(withoutFront.rules.frontAccess).toBe(1);
    delete withoutFront.rules.frontAccess;
    expect(hashState(withoutFront)).toBe('1084c7e6bdd7acf4');
    const withoutCrowd = JSON.parse(JSON.stringify(trace.finalState)) as { crowd?: unknown; rules?: Record<string, unknown> };
    expect(withoutCrowd.rules?.crowdFeedback).toBe(1);
    expect(withoutCrowd.crowd).toBeDefined();
    delete withoutCrowd.crowd;
    delete withoutCrowd.rules?.crowdFeedback;
    delete withoutCrowd.rules?.frontAccess;
    expect(hashState(withoutCrowd), 'the stage without the two Phase 14 keys (and the Phase 40 one)').toBe('d2b6a7663d9ded75');
  }, 20_000);
});
