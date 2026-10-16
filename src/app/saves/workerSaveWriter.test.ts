import { describe, expect, it } from 'vitest';
import type { PersistReply, PersistRequest } from './saveWorker';
import { persistRequest } from './saveWorker';
import { createWorkerSaveWriter, type WorkerSaveWriterWorker } from './workerSaveWriter';
import { MemorySaveStore } from './memorySaveStore';
import type { PersistJob, PersistResult, SaveWriter } from './types';

const job = (jobId: number): PersistJob => ({
  jobId,
  slotId: 'autosave',
  state: { world: { tick: 3 }, scenarioId: null } as unknown as PersistJob['state'],
  app: { clock: { simulationTimeMs: 1000 }, tourNodeId: null } as unknown as PersistJob['app'],
  savedAtEpochMs: 1,
  name: 'Autosave',
  scenarioName: 'Sandbox park',
  guestCount: 0,
  cash: 0,
  rating: 0,
  writerTabId: 'tab',
  options: { expectedRevision: null },
});

const okResult = (jobId: number): PersistResult => ({ ok: true, jobId, meta: {} as never, hashMs: 1, writeMs: 1 });

class FakeWorker implements WorkerSaveWriterWorker {
  onmessage: ((event: { data: PersistReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  posted: PersistRequest[] = [];
  terminated = false;
  postMessage(message: PersistRequest): void { this.posted.push(message); }
  terminate(): void { this.terminated = true; }
  reply(reply: PersistReply): void { this.onmessage?.({ data: reply }); }
}

const fallbackWriter = (calls: number[]): SaveWriter => ({
  kind: 'idle',
  persist: async (next) => { calls.push(next.jobId); return okResult(next.jobId); },
  dispose: () => undefined,
});

const rig = (overrides: { indexedDb?: boolean; worker?: FakeWorker | null } = {}) => {
  const worker = overrides.worker === undefined ? new FakeWorker() : overrides.worker;
  const fallbackCalls: number[] = [];
  const deferred: Array<() => void> = [];
  let fallbackBuilt = 0;
  const writer = createWorkerSaveWriter({
    usesIndexedDb: () => overrides.indexedDb ?? true,
    createFallback: () => { fallbackBuilt += 1; return fallbackWriter(fallbackCalls); },
    createWorker: () => worker,
    afterThisTask: (callback) => { deferred.push(callback); },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  return { writer, worker, fallbackCalls, deferred, built: () => fallbackBuilt };
};

describe('createWorkerSaveWriter', () => {
  it('posts the job one task after persist is called, never inside it', async () => {
    const { writer, worker, deferred } = rig();
    const pending = writer.persist(job(1));
    expect(worker!.posted.length, 'nothing is posted in the caller task').toBe(0);
    expect(deferred.length, 'the post is deferred').toBe(1);
    deferred[0]();
    expect(worker!.posted.map((p) => p.id), 'posted after the deferral').toEqual([1]);
    worker!.reply({ id: 1, ok: true, persisted: true, result: okResult(1) });
    expect((await pending).ok, 'the worker result is the persist result').toBe(true);
    expect(writer.kind, 'a healthy writer reports the worker').toBe('worker');
  });

  it('passes a worker-side store failure through as a result', async () => {
    const { writer, worker, deferred } = rig();
    const pending = writer.persist(job(2));
    deferred[0]();
    worker!.reply({ id: 2, ok: true, persisted: true, result: { ok: false, jobId: 2, error: { code: 'quota', message: 'full' } } });
    const result = await pending;
    expect(result.ok === false && result.error.code, 'quota stays quota so the banner logic can see it').toBe('quota');
  });

  it('turns an error reply into seal-failed', async () => {
    const { writer, worker, deferred } = rig();
    const pending = writer.persist(job(3));
    deferred[0]();
    worker!.reply({ id: 3, ok: false, message: 'boom' });
    const result = await pending;
    expect(result.ok === false && result.error.code, 'worker errors are seal-failed').toBe('seal-failed');
  });

  it('uses the fallback, and no worker, while the store is memory-only', async () => {
    const { writer, worker, fallbackCalls } = rig({ indexedDb: false });
    await writer.persist(job(4));
    expect(fallbackCalls, 'the fallback wrote').toEqual([4]);
    expect(worker!.posted.length, 'the worker saw nothing').toBe(0);
  });

  it('uses the fallback when no worker can be created, and builds it once', async () => {
    const { writer, fallbackCalls, built } = rig({ worker: null });
    await writer.persist(job(5));
    await writer.persist(job(6));
    expect(fallbackCalls, 'both jobs went to the fallback').toEqual([5, 6]);
    expect(built(), 'one fallback instance').toBe(1);
    expect(writer.kind, 'kind follows the fallback').toBe('idle');
  });

  it('reruns jobs on the fallback when the worker dies before ever answering', async () => {
    const { writer, worker, deferred, fallbackCalls } = rig();
    const pending = writer.persist(job(7));
    deferred[0]();
    worker!.onerror?.({});
    expect((await pending).ok, 'the rerun succeeded').toBe(true);
    expect(fallbackCalls, 'the fallback ran the job').toEqual([7]);
    expect(worker!.terminated, 'the dead worker was terminated').toBe(true);
  });

  it('fails, instead of rerunning, a job lost by a worker that had answered before', async () => {
    const { writer, worker, deferred, fallbackCalls } = rig();
    const first = writer.persist(job(8));
    deferred[0]();
    worker!.reply({ id: 8, ok: true, persisted: true, result: okResult(8) });
    await first;
    const second = writer.persist(job(9));
    deferred[1]();
    worker!.onerror?.({});
    const result = await second;
    expect(result.ok, 'a possibly written job is not written twice').toBe(false);
    expect(fallbackCalls, 'the fallback did not run it').toEqual([]);
    const third = await writer.persist(job(10));
    expect(third.ok && fallbackCalls, 'later jobs use the fallback').toEqual([10]);
  });

  it('persistRequest writes through the store it is given and reports store failures as results', async () => {
    const store = new MemorySaveStore();
    await store.init();
    const reply = await persistRequest({ id: 11, job: job(11) }, store as never);
    expect(reply.ok && reply.persisted && reply.result.ok, 'the write succeeded').toBe(true);
    expect((await store.list()).map((meta) => meta.id), 'the slot exists').toEqual(['autosave']);
    const again = await persistRequest({ id: 12, job: { ...job(12), options: { expectedRevision: 0 } } }, store as never);
    expect(again.ok && again.result.ok, 'a stale revision expectation is a failed result, not a thrown error').toBe(false);
  });
});
