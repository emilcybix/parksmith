import { WORKER_JOB_TIMEOUT_MS } from './constants';
import { errorText } from './persistJob';
import type { PersistReply, PersistRequest } from './saveWorker';
import type { PersistJob, PersistResult, SaveWriter } from './types';

/**
 * The default SaveWriter when IndexedDB works: the save worker hashes, seals and WRITES, so the main
 * thread pays for one postMessage clone of the state and nothing else. Measured with a 1,000-guest
 * park at 1x: capture + postMessage about 8 ms in one task, and a main-thread IndexedDB put (the
 * store's own structured clone) another 8 to 12 ms in the next. With the worker owning the write
 * the second cost is gone, and the post itself moves one task after the capture, so the two halves
 * never share a task.
 *
 * It only runs while the main store is really IndexedDB. When the store fell back to memory the
 * saves have to land in that in-memory store, which the worker cannot reach, so those jobs go to the
 * fallback writer (the hashing writer, which writes through the store on the main thread). A worker
 * that cannot start, errors, or stops answering is abandoned for good and the fallback takes over.
 */

export interface WorkerSaveWriterWorker {
  postMessage(message: PersistRequest): void;
  terminate(): void;
  onmessage: ((event: { data: PersistReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface WorkerSaveWriterOptions {
  /** True while the main store is IndexedDB-backed. */
  usesIndexedDb(): boolean;
  /** Built on first use, so a healthy worker writer never starts a second worker. */
  createFallback(): SaveWriter;
  /** Returns null (or throws) when workers are unavailable. */
  createWorker(): WorkerSaveWriterWorker | null;
  /** Runs `callback` in a later task than the caller's. Default: a MessageChannel ping. */
  afterThisTask?(callback: () => void): void;
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(handle: unknown): void;
  jobTimeoutMs?: number;
}

interface PendingJob {
  job: PersistJob;
  resolve(result: PersistResult): void;
  timer: unknown;
}

const defaultAfterThisTask = (callback: () => void): void => {
  if (typeof MessageChannel === 'undefined') {
    setTimeout(callback, 0);
    return;
  }
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    callback();
  };
  channel.port2.postMessage(null);
};

export const createWorkerSaveWriter = (options: WorkerSaveWriterOptions): SaveWriter => {
  const afterThisTask = options.afterThisTask ?? defaultAfterThisTask;
  const startTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const stopTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const jobTimeoutMs = options.jobTimeoutMs ?? WORKER_JOB_TIMEOUT_MS;
  const pending = new Map<number, PendingJob>();
  let worker: WorkerSaveWriterWorker | null = null;
  let workerTried = false;
  let workerAnswered = false;
  let fallback: SaveWriter | null = null;
  let disposed = false;

  const fallbackWriter = (): SaveWriter => (fallback ??= options.createFallback());

  const startWorker = (): void => {
    if (workerTried) return;
    workerTried = true;
    try {
      worker = options.createWorker();
    } catch {
      worker = null;
    }
    if (worker === null) return;
    worker.onmessage = (event) => {
      const reply = event.data;
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      stopTimer(entry.timer);
      workerAnswered = true;
      if (reply.ok) entry.resolve(reply.result);
      else entry.resolve({ ok: false, jobId: entry.job.jobId, error: { code: 'seal-failed', message: reply.message } });
    };
    worker.onerror = () => abandonWorker();
  };

  /**
   * A worker that never answered did not write anything, so its jobs are safe to run again on the
   * fallback. One that had answered before and then died may have written the job already; running
   * it again with the same revision expectation would be reported as a conflict with ourselves, so
   * those jobs fail and the next autosave starts clean on the fallback.
   */
  const abandonWorker = (): void => {
    const dying = worker;
    worker = null;
    if (dying) {
      dying.onmessage = null;
      dying.onerror = null;
      try { dying.terminate(); } catch { /* a dead worker may refuse; it is replaced anyway */ }
    }
    const orphans = [...pending.values()];
    pending.clear();
    for (const entry of orphans) {
      stopTimer(entry.timer);
      if (workerAnswered) {
        entry.resolve({ ok: false, jobId: entry.job.jobId, error: { code: 'seal-failed', message: 'The save worker stopped while saving. The next save will run without it.' } });
      } else {
        fallbackWriter().persist(entry.job).then(entry.resolve, (error: unknown) => entry.resolve({
          ok: false, jobId: entry.job.jobId, error: { code: 'unknown', message: errorText(error) },
        }));
      }
    }
  };

  const persistInWorker = (job: PersistJob): Promise<PersistResult> => new Promise<PersistResult>((resolve) => {
    // The job is already the manager's own copy, so posting it a task later cannot see newer state.
    afterThisTask(() => {
      if (disposed) {
        resolve({ ok: false, jobId: job.jobId, error: { code: 'unknown', message: 'The save writer was disposed.' } });
        return;
      }
      if (worker === null) {
        fallbackWriter().persist(job).then(resolve);
        return;
      }
      const timer = startTimer(() => abandonWorker(), jobTimeoutMs);
      pending.set(job.jobId, { job, resolve, timer });
      try {
        worker.postMessage({ id: job.jobId, job });
      } catch {
        abandonWorker();
      }
    });
  });

  return {
    get kind() { return worker !== null ? 'worker' : (fallback?.kind ?? 'worker'); },
    persist(job) {
      if (disposed) return Promise.resolve({ ok: false, jobId: job.jobId, error: { code: 'unknown', message: 'The save writer was disposed.' } });
      if (!options.usesIndexedDb()) return fallbackWriter().persist(job);
      startWorker();
      if (worker === null) return fallbackWriter().persist(job);
      return persistInWorker(job);
    },
    dispose() {
      disposed = true;
      for (const entry of pending.values()) stopTimer(entry.timer);
      pending.clear();
      const dying = worker;
      worker = null;
      if (dying) {
        dying.onmessage = null;
        dying.onerror = null;
        try { dying.terminate(); } catch { /* nothing left to clean up */ }
      }
      fallback?.dispose();
    },
  };
};
