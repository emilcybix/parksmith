import {
  recoveredSlotName,
  type RecoveryCommands,
  type RecoveryController,
  type RecoveryDetection,
  type RecoveryFailure,
  type RecoveryFailureCode,
  type RecoveryMonitor,
  type RecoveryNoOfferReason,
  type RecoveryParkInfo,
  type RecoveryPhase,
  type RecoveryResult,
  type RecoverySaveAccess,
  type RecoverySnapshot,
} from './recoveryTypes';
import type { AutosaveSlotId, LoadSummary, ManualSaveSlotId, SaveSlotMeta } from './types';
import { AUTOSAVE_SLOT_ID } from './constants';
import { autosaveGenerations } from './autosaveGenerations';

/**
 * The state machine of interrupted-session recovery (DESIGN 6.5). It owns the autosave hold: the
 * hold is taken before anything can start a park and released on EVERY path to `idle`, so the
 * player's old autosave is never overwritten before they have decided, and never held forever.
 * The one path that keeps it held on purpose is a closed tab: nothing resolves, the markers stay,
 * and the next load asks again.
 *
 * Nothing in the offer path destroys data: resume only reads, "Not now" only moves.
 */

export interface RecoveryControllerOptions {
  monitor: RecoveryMonitor;
  saves: RecoverySaveAccess;
}

const NOTICE_TEXT: Record<RecoveryNoOfferReason, string> = {
  'autosave-missing': 'Parksmith closed unexpectedly. There was no autosave to resume.',
  'autosave-unreadable': 'Parksmith closed unexpectedly, and its autosave could not be read. It is kept in Save / Load.',
  'autosave-not-from-interrupted-session': 'Parksmith closed unexpectedly before your last park was autosaved.',
};

const WITHDRAWN_NOTICE = 'That autosave is no longer available, so there is nothing to resume.';

const NO_FREE_SLOT_MESSAGE = 'All 10 save slots are in use. Resume, or delete one in Save / Load first.';

const failure = (code: RecoveryFailureCode, message: string, cause?: RecoveryFailure['cause']): RecoveryFailure => (
  cause === undefined ? { code, message } : { code, message, cause }
);

const refuse = <T>(error: RecoveryFailure): RecoveryResult<T> => ({ ok: false, error });

export const createRecoveryController = (options: RecoveryControllerOptions): RecoveryController => {
  const { monitor, saves } = options;
  const listeners = new Set<(snapshot: RecoverySnapshot) => void>();
  let current: RecoverySnapshot = { phase: 'checking', offer: null, error: null, notice: null };
  let noticeCounter = 0;
  let lastPark: RecoveryParkInfo | null = null;
  let started = false;
  let disposed = false;

  // Idempotent: GameApp already held in its constructor, this keeps the invariant local.
  saves.holdAutosave();

  const publish = (patch: Partial<RecoverySnapshot>): void => {
    current = { ...current, ...patch };
    for (const listener of [...listeners]) listener(current);
  };

  const notice = (text: string): RecoverySnapshot['notice'] => {
    noticeCounter += 1;
    return { id: noticeCounter, text };
  };

  const setPhase = (phase: RecoveryPhase, patch: Partial<RecoverySnapshot> = {}): void => publish({ phase, ...patch });

  /** The single exit to idle: forget the interrupted markers, release the autosave, close the offer. */
  const resolve = (interruptedSessionIds: readonly string[], text: string | null): void => {
    monitor.forget(interruptedSessionIds);
    saves.releaseAutosave();
    publish({ phase: 'idle', offer: null, error: null, ...(text === null ? {} : { notice: notice(text) }) });
  };

  /** The row of an autosave generation, through the shared helper (Phase 31: the offer may be the previous one). */
  const autosaveRow = (slotId: AutosaveSlotId = AUTOSAVE_SLOT_ID): SaveSlotMeta | null => {
    const generations = autosaveGenerations(saves.snapshot().slots);
    return slotId === AUTOSAVE_SLOT_ID ? generations.current : generations.previous;
  };

  const resume = async (): Promise<RecoveryResult<LoadSummary>> => {
    const offer = current.offer;
    if (offer === null || disposed) return refuse(failure('no-offer', 'There is nothing to recover'));
    if (current.phase !== 'offered') return refuse(failure('busy', 'Another recovery step is running'));
    setPhase('resuming', { error: null });
    const slotId = offer.autosave.slotId ?? AUTOSAVE_SLOT_ID;
    try {
      await saves.refresh();
      const row = autosaveRow(slotId);
      if (row === null) {
        resolve(offer.interruptedSessionIds, WITHDRAWN_NOTICE);
        return refuse(failure('not-found', 'The autosave is gone'));
      }
      if (row.revision !== offer.autosave.revision || row.writerTabId !== offer.sessionId) {
        // Another tab wrote the autosave since the offer: loading it would put a different park
        // under the "your interrupted park" label.
        resolve(offer.interruptedSessionIds, WITHDRAWN_NOTICE);
        return refuse(failure('changed', 'The autosave was changed by another tab'));
      }
      const loaded = await saves.load(slotId);
      if (loaded.ok) {
        resolve(offer.interruptedSessionIds, null);
        return { ok: true, value: loaded.value };
      }
      await saves.refresh();
      if (loaded.error.code === 'not-found' || autosaveRow(slotId) === null) {
        resolve(offer.interruptedSessionIds, WITHDRAWN_NOTICE);
        return refuse(failure('not-found', loaded.error.message, loaded.error));
      }
      if (autosaveRow(slotId)?.status.state !== 'ok') {
        // Flagged unreadable by the load: the SaveManager quarantines it at the next autosave.
        const error = failure('unreadable', loaded.error.message, loaded.error);
        resolve(offer.interruptedSessionIds, NOTICE_TEXT['autosave-unreadable']);
        return refuse(error);
      }
      const error = failure(loaded.error.code === 'busy' ? 'busy' : 'store', loaded.error.message, loaded.error);
      setPhase('offered', { error });
      return refuse(error);
    } catch (thrown) {
      const error = failure('store', thrown instanceof Error ? thrown.message : 'The autosave could not be loaded');
      setPhase('offered', { error });
      return refuse(error);
    }
  };

  const dismiss = async (): Promise<RecoveryResult<ManualSaveSlotId>> => {
    const offer = current.offer;
    if (offer === null || disposed) return refuse(failure('no-offer', 'There is nothing to recover'));
    if (current.phase !== 'offered') return refuse(failure('busy', 'Another recovery step is running'));
    setPhase('dismissing', { error: null });
    try {
      const kept = await saves.keepAutosaveAsRecovered(offer.autosave.revision, offer.autosave.slotId ?? AUTOSAVE_SLOT_ID);
      if (kept.ok) {
        resolve(offer.interruptedSessionIds, `Your autosave was kept as '${recoveredSlotName(offer.mode)}' in ${kept.value}.`);
        return kept;
      }
      const { code } = kept.error;
      if (code === 'changed' || code === 'not-found') {
        resolve(offer.interruptedSessionIds, WITHDRAWN_NOTICE);
        return kept;
      }
      // no-free-slot and store errors: the autosave is untouched and still held, so the offer stays.
      const error = code === 'no-free-slot' ? failure('no-free-slot', NO_FREE_SLOT_MESSAGE, kept.error.cause) : kept.error;
      setPhase('offered', { error });
      return refuse(error);
    } catch (thrown) {
      const error = failure('store', thrown instanceof Error ? thrown.message : 'The autosave could not be kept');
      setPhase('offered', { error });
      return refuse(error);
    }
  };

  const commands: RecoveryCommands = { resume, dismiss };

  /** One scan of the other tabs' markers against the autosave row the slot list currently shows. */
  const detect = (): Promise<RecoveryDetection> => {
    const store = saves.snapshot();
    if (store.persistence.state === 'unavailable') return monitor.detectInterrupted(null, null);
    const { current, previous } = autosaveGenerations(store.slots);
    return monitor.detectInterrupted(current, previous);
  };

  const apply = (detection: RecoveryDetection): void => {
    if (detection.kind === 'clean') {
      resolve([], null);
    } else if (detection.kind === 'no-offer') {
      resolve(detection.interrupted.map((session) => session.marker.sessionId), NOTICE_TEXT[detection.reason]);
    } else {
      setPhase('offered', { offer: detection.offer, error: null });
    }
  };

  const start = async (): Promise<void> => {
    if (started || disposed) return;
    started = true;
    try {
      const detection = await detect();
      if (disposed) return;
      apply(detection);
    } catch {
      // The safety net must never block the player: no offer, autosave released.
      if (!disposed) resolve([], null);
    }
  };

  let rescanning = false;

  /**
   * Detection runs once per page load, but a tab that was idle when its sibling crashed starts its
   * own parks later, and the first autosave of one would replace the dead tab's autosave before
   * anyone decided. So every park start in an idle tab holds the autosave (synchronously, before
   * any frame can ask for a save) and scans again; the hold is released on every path out.
   * The slot list is refreshed only when a dead tab is found: the cheap scan needs no store read.
   */
  const rescan = async (): Promise<void> => {
    rescanning = true;
    saves.holdAutosave();
    try {
      let detection = await detect();
      if (detection.kind !== 'clean') {
        await saves.refresh();
        detection = await detect();
      }
      if (!disposed) apply(detection);
    } catch {
      if (!disposed) resolve([], null);
    } finally {
      rescanning = false;
    }
  };

  return {
    commands,
    start,
    parkStarted(park) {
      lastPark = park;
      void monitor.start(park);
      if (started && !disposed && !rescanning && current.phase === 'idle') {
        saves.holdAutosave();
        void rescan();
      }
    },
    markClean() {
      monitor.markClean();
    },
    pageRestored() {
      if (lastPark !== null) void monitor.start(lastPark);
    },
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
};
