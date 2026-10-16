import { hashState } from '../../game/save/hash';
import type { ParkSaveV4 } from '../../game/save/state';
import { SAVE_CONTENT_VERSION, SAVE_SCHEMA_VERSION, type ParkSave } from '../../game/save/version';
import { AUTOSAVE_PREVIOUS_SLOT_ID, AUTOSAVE_SLOT_ID } from './constants';
import { isAutosaveSlotId } from './autosaveGenerations';
import {
  StoreError,
  type PersistJob,
  type PersistResult,
  type SaveSlotMeta,
  type SaveStore,
  type StoreErrorCode,
} from './types';

/**
 * The part of a save that is the same whichever thread runs it: hash and size the state, build the
 * envelope and the list metadata, write through a store. It lives in its own module, with no DOM
 * and no manager imports, because the save worker imports it too: a worker that pulled in
 * SaveManager.ts would drag the whole manager (and the game config) into the worker bundle.
 */

export interface StateSeal {
  stateHash: string;
  /** JSON length of the state: approximate by design, used for the slot list and quota messages. */
  sizeBytes: number;
  hashMs: number;
}

/** The two numbers the worker computes; also the main-thread fallback and the tests. */
export const computeStateSeal = (state: ParkSaveV4): StateSeal => {
  const started = performance.now();
  const stateHash = hashState(state);
  const hashMs = performance.now() - started;
  return { stateHash, sizeBytes: JSON.stringify(state).length, hashMs };
};

/**
 * Builds the envelope from an already computed hash. `createParkSave` would hash again on the
 * calling thread, which is exactly the 30 ms this writer exists to avoid; a test pins that both
 * produce the identical object. If the envelope gains a field, src/game/save/version.ts should grow
 * a `sealParkSave(state, app, epoch, stateHash)` that both use.
 */
export const sealEnvelope = (job: PersistJob, stateHash: string): ParkSave => ({
  schemaVersion: SAVE_SCHEMA_VERSION,
  contentVersion: SAVE_CONTENT_VERSION,
  savedAtTick: job.state.world.tick,
  savedAtEpochMs: job.savedAtEpochMs,
  scenarioId: job.state.scenarioId,
  mode: job.state.mode,
  stateHash,
  app: job.app,
  state: job.state,
});

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const storeCodeOf = (error: unknown): StoreErrorCode => (error instanceof StoreError ? error.code : 'unknown');

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * Why a stored save is certainly damaged, or null when it looks fine. Deliberately the cheap half of
 * validation, because it runs in the writer before the first autosave replaces an old record and
 * must not pull in the load path: the envelope shape, and that the state still hashes to the hash
 * written beside it. The hash covers the state at the schema it was WRITTEN at (`hashState` is
 * canonical JSON of the plain state, no schema input; `migrateSave` checks it the same way before
 * migrating), so an older-schema autosave is checked too (Phase 30; before, only this build's own
 * schema was). An untampered older-schema autosave still passes: it is not damaged, it only needs a
 * migration, and a rolling autosave of a previous session is allowed to be replaced.
 */
export const storedSaveProblem = (payload: unknown): string | null => {
  if (!isPlainObject(payload) || !isPlainObject(payload.state)
    || typeof payload.schemaVersion !== 'number' || typeof payload.stateHash !== 'string') {
    return 'The stored autosave is not a readable Parksmith save.';
  }
  let actual: string;
  try {
    actual = hashState(payload.state);
  } catch {
    // Not plain data (undefined, NaN, a class instance): migrateSave would refuse it as corrupt too.
    return 'The stored autosave fails its integrity check.';
  }
  if (actual !== payload.stateHash) {
    return 'The stored autosave fails its integrity check.';
  }
  return null;
};

/**
 * Phase 31: the store options of a job. Every write to the autosave slot rotates: the record there now
 * becomes the previous generation in the same transaction (`rotateTo`). Manual slots are unchanged.
 */
export const writeOptionsFor = (job: Pick<PersistJob, 'slotId' | 'options'>): PersistJob['options'] => (
  job.slotId === AUTOSAVE_SLOT_ID ? { ...job.options, rotateTo: AUTOSAVE_PREVIOUS_SLOT_ID } : job.options
);

/**
 * Phase 31, the rotation rule: a record is rotated into the previous generation only when it is known to
 * be good, because a damaged record must never push the good previous generation out. Known good means
 * one of two things:
 * - the write expects a revision (`expectedRevision` is a number) and this is not the first autosave of
 *   the page session: the store then refuses unless the slot is still at the revision this tab itself
 *   sealed and wrote, or loaded and validated, so the record is this tab's own;
 * - otherwise the record is checked here first (`storedSaveProblem`, the Phase 30 integrity check). That is
 *   the first autosave of a session (`verifyExisting`, a record an earlier session wrote that nobody has
 *   loaded) and a write that expects nothing at all. A record that fails is refused with 'unreadable-slot'
 *   before anything is written: the manager marks it unreadable and quarantines it to a manual slot, and
 *   the save that follows finds the autosave slot empty, so nothing rotates and the previous generation
 *   stays. A write that expects an empty slot (`expectedRevision: null`) has nothing to rotate.
 */
export const mustVerifyBeforeWrite = (job: Pick<PersistJob, 'slotId' | 'options' | 'verifyExisting'>): boolean => (
  job.verifyExisting === true || (job.slotId === AUTOSAVE_SLOT_ID && job.options.expectedRevision === undefined)
);

/** Seals the envelope around an already hashed state and writes it through `store`. */
export const persistSealedJob = async (store: SaveStore, job: PersistJob, seal: StateSeal): Promise<PersistResult> => {
  if (job.slotId === AUTOSAVE_PREVIOUS_SLOT_ID) {
    return { ok: false, jobId: job.jobId, error: { code: 'unknown', message: 'The previous autosave is read-only.' } };
  }
  if (mustVerifyBeforeWrite(job)) {
    let problem: string | null = null;
    try {
      problem = storedSaveProblem((await store.read(job.slotId)).payload);
    } catch {
      // Nothing stored (not-found) or unreadable right now: the write itself reports real failures.
    }
    if (problem !== null) return { ok: false, jobId: job.jobId, error: { code: 'unreadable-slot', message: problem } };
  }
  const save = sealEnvelope(job, seal.stateHash);
  const meta: SaveSlotMeta = {
    id: job.slotId,
    kind: isAutosaveSlotId(job.slotId) ? 'auto' : 'manual',
    name: job.name,
    scenarioId: job.state.scenarioId,
    scenarioName: job.scenarioName,
    mode: job.state.mode,
    ...(job.mapName !== undefined ? { mapName: job.mapName } : {}),
    ...(job.biomeName !== undefined ? { biomeName: job.biomeName } : {}),
    ...(job.run !== undefined ? { run: job.run } : {}),
    playtimeSeconds: job.app.clock.simulationTimeMs / 1000,
    savedAt: job.savedAtEpochMs,
    schemaVersion: save.schemaVersion,
    contentVersion: save.contentVersion,
    savedAtTick: save.savedAtTick,
    guestCount: job.guestCount,
    cash: job.cash,
    rating: job.rating,
    sizeBytes: seal.sizeBytes,
    revision: 0,
    writerTabId: job.writerTabId,
    status: { state: 'ok' },
  };
  const writeStarted = performance.now();
  try {
    await store.write(job.slotId, save, meta, writeOptionsFor(job));
  } catch (error) {
    return { ok: false, jobId: job.jobId, error: { code: storeCodeOf(error), message: errorText(error) } };
  }
  const writeMs = performance.now() - writeStarted;
  // The store assigns the revision. With an expectation it is exactly expected + 1; without one
  // (a manual save) it is read back, so the row and the conflict check never rely on a guess.
  const expected = job.options.expectedRevision;
  if (typeof expected === 'number') meta.revision = expected + 1;
  else if (expected === null) meta.revision = 1;
  else {
    try {
      meta.revision = (await store.list()).find((row) => row.id === job.slotId)?.revision ?? 0;
    } catch {
      meta.revision = 0;
    }
  }
  return { ok: true, jobId: job.jobId, meta, hashMs: seal.hashMs, writeMs };
};
