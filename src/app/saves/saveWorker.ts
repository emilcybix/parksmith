import { hashState } from '../../game/save/hash';
import type { ParkSaveV4 } from '../../game/save/state';
import { IdbSaveStore } from './idbSaveStore';
import { computeStateSeal, errorText, persistSealedJob } from './persistJob';
import type { PersistJob, PersistResult } from './types';

/**
 * Module Web Worker entry: seals a park state off the frame. The 30 ms canonical-JSON hash (and the
 * 10 ms size estimate) of a 1,000-guest park would otherwise be a visible hitch in the frame that
 * started an autosave; here they cost the main thread only the structured clone of the message.
 *
 * It can also own the whole write (`PersistRequest`): the structured clone that IndexedDB makes of a
 * 1 MB state costs the calling thread 8 to 12 ms, which no amount of scheduling makes small, so the
 * worker opens its own connection and writes. The main thread then pays one postMessage clone
 * (about 4 ms) and nothing else.
 *
 * Protocol: `{ id, state }` in, `{ id, ok: true, stateHash, sizeBytes, hashMs }` or
 * `{ id, ok: false, message }` out. Errors travel as plain strings: Error instances clone badly in
 * some engines. The main-thread fallback (SaveManager.ts, `computeStateSeal`) computes the same two
 * numbers, so a save never depends on which side ran.
 */

export interface SealRequest {
  id: number;
  state: ParkSaveV4;
}

/** Seal, build the envelope and write it, all in the worker. The job is the manager's own deep copy. */
export interface PersistRequest {
  id: number;
  job: PersistJob;
}

export type WorkerRequest = SealRequest | PersistRequest;

export type SealReply =
  | { id: number; ok: true; stateHash: string; sizeBytes: number; hashMs: number }
  | { id: number; ok: false; message: string };

/** `result` is a PersistResult: store failures (quota, conflict) are results, not worker errors. */
export type PersistReply =
  | { id: number; ok: true; persisted: true; result: PersistResult }
  | { id: number; ok: false; message: string };

interface WorkerScope {
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
  postMessage(message: SealReply | PersistReply): void;
}

/** True only inside a dedicated worker, so importing this file in a test or on the main thread is inert. */
const isWorkerScope = (scope: unknown): scope is WorkerScope => (
  typeof scope === 'object'
  && scope !== null
  && typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === 'function'
  && scope instanceof (globalThis as unknown as { WorkerGlobalScope: new () => object }).WorkerGlobalScope
);

/** Exported for tests; the worker's whole job. */
export const sealRequest = (request: SealRequest): SealReply => {
  try {
    const started = performance.now();
    const stateHash = hashState(request.state);
    const hashMs = performance.now() - started;
    return { id: request.id, ok: true, stateHash, sizeBytes: JSON.stringify(request.state).length, hashMs };
  } catch (error) {
    return { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

let workerStore: IdbSaveStore | null = null;

/** Exported for tests, which pass their own store. Never throws: a failure is a reply. */
export const persistRequest = async (request: PersistRequest, store: IdbSaveStore = (workerStore ??= new IdbSaveStore())): Promise<PersistReply> => {
  try {
    const result = await persistSealedJob(store, request.job, computeStateSeal(request.job.state));
    return { id: request.id, ok: true, persisted: true, result };
  } catch (error) {
    return { id: request.id, ok: false, message: errorText(error) };
  }
};

const scope: unknown = globalThis;
if (isWorkerScope(scope)) {
  scope.onmessage = (event) => {
    const request = event.data;
    if ('job' in request) void persistRequest(request).then((reply) => scope.postMessage(reply));
    else scope.postMessage(sealRequest(request));
  };
}
