import type { ScenarioId } from '../../game/scenarios/types';
import type { RunSummary } from '../../game/run/types';
import { GAME_MODES, GAME_MODE_LABELS, type GameMode } from '../../game/modes/types';
import type { AutosaveSlotId, LoadSummary, ManualSaveSlotId, SaveFailure, SaveResult, SaveSlotMeta } from './types';

/**
 * The contract of interrupted-session recovery (Phase 12, step 3). The recovery builder implements
 * `src/app/saves/recovery*.ts` and the SaveManager additions below; the UI builder renders
 * `RecoverySnapshot` and calls `RecoveryCommands`; the integrator constructs the controller in
 * GameApp. DESIGN.md explains the behaviour; this file fixes names and shapes. No React, no DOM
 * types in the interfaces (the monitor takes its browser dependencies as options), so everything
 * is testable with a fake storage, fake locks and a fake clock.
 *
 * The idea in one paragraph: a running park holds a per-tab Web Lock and a localStorage marker. A
 * crashed tab loses the lock without a chance to clean up, so "marker present, lock free" means the
 * tab died. A clean close removes the marker first. Detection happens once at startup and offers to
 * resume the autosave only when the autosave was written by the interrupted tab itself.
 */

// --- Constants (the recovery builder may move these into recoveryConstants.ts) ----------------

/** localStorage key prefix of a tab's marker; one key per tab, so two tabs never overwrite each other. */
export const RECOVERY_MARKER_PREFIX = 'parksmith-session:';

/** Web Lock name prefix; the lock is held (exclusive) for as long as the tab runs a park. */
export const RECOVERY_LOCK_PREFIX = 'parksmith-session-lock:';

/** Marker format version; a marker with another version is ignored and removed. */
export const RECOVERY_MARKER_VERSION = 1;

/** The name of the manual slot an undecided autosave is kept in when the player says "Not now". */
export const RECOVERY_RECOVERED_SLOT_NAME = 'Recovered autosave';

/** Phase 22: the kept autosave names its mode, `Recovered autosave (Scenario)`; no mode keeps the plain name. */
export const recoveredSlotName = (mode?: GameMode): string => (
  mode === undefined ? RECOVERY_RECOVERED_SLOT_NAME : `${RECOVERY_RECOVERED_SLOT_NAME} (${GAME_MODE_LABELS[mode]})`
);

/** Whether a slot name is one `recoveredSlotName` wrote (with or without a mode). */
export const isRecoveredSlotName = (name: string): boolean => (
  name === RECOVERY_RECOVERED_SLOT_NAME
  || GAME_MODES.some((mode) => name === recoveredSlotName(mode))
);

/** Heartbeat fallback only (no Web Locks): how often a running tab refreshes its marker. */
export const RECOVERY_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Heartbeat fallback only: a marker not refreshed for this long belongs to a dead tab, while the
 * tab was last seen VISIBLE. Six beats; a visible tab is never throttled below one timer per second.
 */
export const RECOVERY_STALE_VISIBLE_MS = 45_000;

/**
 * Heartbeat fallback only: the same for a tab last seen HIDDEN. Background timers are throttled to
 * once a minute and a frozen tab runs none, so a hidden tab gets a long grace. The cost of the long
 * grace is that a crash while hidden is not offered until this has passed; the cost of a short one
 * would be offering to "recover" a park a frozen tab is still holding.
 */
export const RECOVERY_STALE_HIDDEN_MS = 30 * 60_000;

/** A marker older than this is junk (a profile that has not run the game in a month): purge, never offer. */
export const RECOVERY_MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

// --- Monitor ----------------------------------------------------------------------------------

/** How the monitor tells a dead tab from a live one. */
export type RecoveryMonitorMode =
  /** navigator.locks exists: crash detection is exact. */
  | 'web-locks'
  /** No Web Locks (old Safari, an insecure origin): markers go stale. */
  | 'heartbeat'
  /** localStorage is unusable: nothing is detected, nothing is written, the game runs normally. */
  | 'unavailable';

/** What the monitor needs to know about the running park. */
export interface RecoveryParkInfo {
  /** Scenario name, 'Sandbox park', or the loaded save's name. For the prompt only. */
  parkName: string;
  scenarioId: ScenarioId | null;
  /** Phase 22: how the park is played (optional; a marker without it reads as before). */
  mode?: GameMode;
}

/** What a tab writes to localStorage while it runs a park. */
export interface RecoveryMarker {
  version: typeof RECOVERY_MARKER_VERSION;
  /** Equal to SaveManager's tabId, so the autosave's writerTabId can be matched to it. */
  sessionId: string;
  /** Epoch ms the first park of this tab started. */
  startedAt: number;
  /** Epoch ms of the last refresh (heartbeat fallback reads it; web-locks mode only records it). */
  heartbeatAt: number;
  /** Visibility at the last refresh; selects the stale threshold in heartbeat mode. */
  hidden: boolean;
  mode: 'web-locks' | 'heartbeat';
  parkName: string;
  scenarioId: ScenarioId | null;
  /** Phase 22: how the park was played (optional; the marker version stays 1, a bad value is ignored on read). */
  gameMode?: GameMode;
}

export type InterruptedEvidence =
  /** Web Locks: the marker exists and its lock could be acquired, so nobody holds it. */
  | 'lock-free'
  /** Heartbeat fallback: the marker is staler than its threshold. */
  | 'heartbeat-stale';

/** A marker whose tab is judged dead. Never includes this tab's own marker. */
export interface InterruptedSession {
  marker: RecoveryMarker;
  evidence: InterruptedEvidence;
}

/** Why an unclean shutdown did not lead to a resume offer. Each is told to the player once, as a notice. */
export type RecoveryNoOfferReason =
  /** The store is unavailable, or has no autosave slot at all. */
  | 'autosave-missing'
  /** The autosave slot exists but is flagged unreadable (the SaveManager quarantines it). */
  | 'autosave-unreadable'
  /**
   * The autosave was written by a different tab than the interrupted one: either the interrupted
   * park never reached its first autosave (an older session's autosave is untouched), or another
   * live tab owns the autosave. Offering it as "your interrupted park" would be a lie.
   */
  | 'autosave-not-from-interrupted-session';

/** What the prompt shows. Built from the autosave's metadata only, never by reading its payload. */
export interface RecoveryOffer {
  /** Every interrupted session found; all are forgotten when the offer is resolved. */
  interruptedSessionIds: string[];
  /** The interrupted session the autosave belongs to (its marker supplies the park name). */
  sessionId: string;
  parkName: string;
  scenarioId: ScenarioId | null;
  /** Phase 22: how the interrupted park was played (the autosave's slot mode, else the marker's); absent for a legacy marker. */
  mode?: GameMode;
  /** Epoch ms the interrupted tab started its park. */
  startedAt: number;
  /** Epoch ms of the interrupted tab's last sign of life (marker heartbeat or startedAt). */
  lastSeenAt: number;
  autosave: {
    name: string;
    scenarioName: string;
    savedAt: number;
    playtimeSeconds: number;
    guestCount: number;
    cash: number;
    rating: number;
    /** The slot revision the offer was made for; resume and dismiss refuse if it moved. */
    revision: number;
    /**
     * Phase 31: which autosave generation is offered. Absent means the current one; 'autosave-previous' when the
     * current generation is unreadable or was quarantined and the previous one was written by the interrupted tab.
     */
    slotId?: AutosaveSlotId;
    /** Phase 23: where the interrupted run stood ('Recover your run on The Map? Level 3/5 · seed N'); absent for other modes. */
    run?: RunSummary;
  };
  evidence: InterruptedEvidence;
}

export type RecoveryDetection =
  | { kind: 'clean' }
  | { kind: 'no-offer'; reason: RecoveryNoOfferReason; interrupted: InterruptedSession[] }
  | { kind: 'offer'; offer: RecoveryOffer };

export interface RecoveryMonitor {
  /** Random per tab and per page load; the SaveManager is constructed with the same id as its tabId. */
  readonly sessionId: string;
  readonly mode: RecoveryMonitorMode;
  /**
   * A park started in this tab (new, loaded or resumed). First call: acquires the lock, THEN writes
   * the marker (never the other way round: a marker without a lock is exactly what the scan calls
   * a crash). Later calls only update parkName/scenarioId. Resolves when the marker is written;
   * callers do not need to await it. Never rejects.
   */
  start(park: RecoveryParkInfo): Promise<void>;
  /** Refreshes the marker's heartbeatAt and visibility. Called by the monitor's own timer; public for tests. */
  heartbeat(): void;
  /**
   * The tab is closing or reloading (pagehide): removes the marker FIRST, then releases the lock, so
   * at no instant is there a marker without a lock. Idempotent, synchronous, never throws.
   */
  markClean(): void;
  /**
   * Scans every other tab's marker. `autosave` is the autosave slot's metadata from the manager's
   * list (null when the slot is empty or the store is unavailable), `previous` the previous autosave
   * generation's (Phase 31, the fallback when the current one is unreadable or gone). Pure with respect
   * to storage except for purging junk markers; markers of interrupted sessions stay until `forget`.
   */
  detectInterrupted(autosave: SaveSlotMeta | null, previous?: SaveSlotMeta | null): Promise<RecoveryDetection>;
  /** Removes markers of sessions whose offer was resolved (resume, dismiss, withdrawn). */
  forget(sessionIds: readonly string[]): void;
  dispose(): void;
}

// --- Additions to SaveManager (recovery builder implements, GameApp calls) --------------------

/**
 * What SaveManager gains. Declared here because `types.ts` belongs to step 2; the class implements
 * this interface in addition to `SaveManager`.
 */
export interface SaveManagerRecoveryHooks {
  /**
   * Suspends every AUTOSAVE trigger (park start, interval, scenario result, hide) until released.
   * A separate flag from the existing conflict/unreadable suspension (refresh() clears those).
   * Manual saves are unaffected. Safe to call before init(): GameApp calls it in its constructor,
   * so the player cannot start a park and overwrite the autosave before detection has run.
   */
  holdAutosave(): void;
  releaseAutosave(): void;
  /**
   * Moves the autosave slot's record to a free manual slot named RECOVERY_RECOVERED_SLOT_NAME,
   * without ever deleting it (store.move, then updateMeta, like the unreadable quarantine).
   * Serialized through the manager's single-flight queue. Picks the free slot from a fresh store
   * list and retries once if a concurrent manual save took it. Fails with 'no-free-slot'
   * when every slot is taken, and with 'changed' when the autosave's revision is no longer `expectedRevision`.
   */
  keepAutosaveAsRecovered(expectedRevision: number, slotId?: AutosaveSlotId): Promise<RecoveryResult<ManualSaveSlotId>>;
  /**
   * The live park was replaced by an earlier snapshot of itself (undo). Marks it unsaved against
   * every slot and bumps the park generation so an autosave still in flight for the pre-undo state
   * cannot mark the rewound park clean when it finishes. Does NOT reset the autosave timers, the
   * first-autosave flag or the quick-save slot choice (a rewind is not a new park).
   */
  notifyParkRewound(): void;
}

// --- Controller (recovery builder implements, integrator constructs) --------------------------

export type RecoveryFailureCode =
  | 'no-offer'
  /** Another tab wrote the autosave since the offer was made; the offer was withdrawn. */
  | 'changed'
  /** Dismiss only: all manual slots are taken, so the autosave cannot be kept non-destructively. */
  | 'no-free-slot'
  /** Resume only: the autosave turned out to be unreadable; it is flagged and the offer is closed. */
  | 'unreadable'
  | 'not-found'
  | 'busy'
  | 'store';

export interface RecoveryFailure {
  code: RecoveryFailureCode;
  message: string;
  /** The underlying save-layer failure, when there is one. */
  cause?: SaveFailure;
}

export type RecoveryResult<T> = { ok: true; value: T } | { ok: false; error: RecoveryFailure };

/** UI -> app. Registered by GameApp through registerRecoveryCommands (see gameBridge.ts). */
export interface RecoveryCommands {
  /**
   * Loads the autosave through the normal load flow (the park loads paused) and resolves the offer.
   * If the live park has unsaved changes the UI has already asked, as the load dialog does.
   */
  resume(): Promise<RecoveryResult<LoadSummary>>;
  /**
   * "Not now": keeps the autosave in a manual slot named 'Recovered autosave', resolves the offer
   * and releases autosave. On failure the offer stays open and the error says why.
   */
  dismiss(): Promise<RecoveryResult<ManualSaveSlotId>>;
}

/**
 * - checking:   detection has not finished; the autosave is held. The UI shows nothing.
 * - idle:       nothing to decide (no interruption, or resolved, or withdrawn).
 * - offered:    the prompt is up; the autosave is held.
 * - resuming / dismissing: the command is in flight; both buttons disabled.
 */
export type RecoveryPhase = 'checking' | 'idle' | 'offered' | 'resuming' | 'dismissing';

/** The slice of the Zustand store the prompt renders from. */
export interface RecoverySnapshot {
  phase: RecoveryPhase;
  offer: RecoveryOffer | null;
  /** The last failed command, shown inside the prompt, cleared by the next attempt. */
  error: RecoveryFailure | null;
  /**
   * One informational line the HUD may toast once ("Parksmith closed unexpectedly before your last
   * park was autosaved."), with a monotonic id so it is shown once. Null when there is none.
   */
  notice: { id: number; text: string } | null;
}

/** The ports the controller needs from the save layer; SaveManager satisfies it structurally. */
export interface RecoverySaveAccess extends SaveManagerRecoveryHooks {
  snapshot(): { slots: SaveSlotMeta[]; persistence: { state: 'checking' | 'ready' | 'unavailable' } };
  load(id: AutosaveSlotId): Promise<SaveResult<LoadSummary>>;
  /** Re-reads the slot list from the store (the controller needs a fresh autosave row). */
  refresh(): Promise<void>;
}

export interface RecoveryController {
  readonly commands: RecoveryCommands;
  /**
   * Runs detection once. Call after SaveManager.init() resolved (the slot list must exist). Ends
   * with the autosave released (clean, no offer) or held (offer up). Never rejects: a failure to
   * detect means no offer and a released autosave, because the player must never be blocked by
   * the safety net.
   */
  start(): Promise<void>;
  /** A park started in this tab: new, loaded or resumed. Forwards to the monitor. */
  parkStarted(park: RecoveryParkInfo): void;
  /** pagehide with persisted === false (or true: a page in the back/forward cache is not running). */
  markClean(): void;
  /** pageshow with persisted === true: the page came back from the cache, so register it again. */
  pageRestored(): void;
  snapshot(): RecoverySnapshot;
  subscribe(listener: (snapshot: RecoverySnapshot) => void): () => void;
  dispose(): void;
}
