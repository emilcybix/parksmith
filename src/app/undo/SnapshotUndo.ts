import {
  EMPTY_UNDO_STATUS,
  UNDO_BUSY_MESSAGE,
  UNDO_CONFIRM_MIN_GAP_MS,
  UNDO_CONFIRM_REWIND_SECONDS,
  UNDO_CONFIRM_WINDOW_MS,
  UNDO_EMPTY_MESSAGE,
  UNDO_ESTIMATED_BYTES_BASE,
  UNDO_ESTIMATED_BYTES_PER_GUEST,
  UNDO_FAILED_MESSAGE,
  UNDO_MAX_DEPTH,
  UNDO_MEMORY_BUDGET_BYTES,
  UNDO_MIN_DEPTH,
  UNDO_SCENARIO_ENDED_MESSAGE,
  UNDO_SHORTCUT,
  UNDO_STRONG_WARNING_SECONDS,
} from './constants';
import { confirmButtonLabel, formatRewind, rewindSecondsBetween, undoButtonLabel } from './rewindLabel';
import type {
  SnapshotUndo,
  UndoCapture,
  UndoClearReason,
  UndoEntry,
  UndoGestureKind,
  UndoHost,
  UndoOutcome,
  UndoStatus,
  UndoUnavailableReason,
} from './types';

/** What a gesture is called when nobody supplied a label before it was committed (a safety net). */
const FALLBACK_LABELS: Readonly<Record<UndoGestureKind, string>> = {
  paths: 'Path tiles built',
  object: 'Building placed',
  coaster: 'Coaster built',
  demolition: 'Demolition',
  recolour: 'Colours changed',
  card: 'Card played',
  land: 'Land bought',
};

/** The pre-gesture park, held outside the ring until the gesture is known to have changed something. */
interface PendingGesture {
  kind: UndoGestureKind;
  capture: UndoCapture;
  /** Set by `setPendingLabel` while a drag is still growing ("3 tiles demolished"). */
  label: string | null;
}

const estimateBytes = (guestCount: number): number =>
  UNDO_ESTIMATED_BYTES_BASE + UNDO_ESTIMATED_BYTES_PER_GUEST * guestCount;

/**
 * Whether a rewind of this many simulated milliseconds needs the second press. Compared unfloored:
 * "longer than 60 s" must hold at 60.9 s too, where the floored label still reads 60.
 */
const needsConfirmationFor = (rewindMs: number): boolean => rewindMs > UNDO_CONFIRM_REWIND_SECONDS * 1_000;

const dollars = (amount: number): string => `$${Math.round(amount).toLocaleString('en-US')}`;

/**
 * The ring of whole-park snapshots behind the Undo control (Phase 12, step 3). It knows nothing
 * about renderers, the UI store or the session swap: the host captures and restores, so the ring is
 * tested with a fake host and the swap stays shared with load.
 *
 * Why whole-park snapshots: a snapshot restore is always correct. The Phase 11 undo had to withdraw
 * itself whenever a guest used the new building, the player repriced it or another gesture came
 * along, because it inverted only the buildings. A snapshot has no such cases; the price is that it
 * rewinds time, which the status therefore states ("Undo · rewinds 42 s") and, past a minute,
 * confirms with a second press.
 *
 * Allocation: `status()` and `refresh()` allocate only when something the status shows changed (a
 * simulated second ticked, the ring changed, the arm expired), never per frame.
 */
export class ParkSnapshotUndo implements SnapshotUndo {
  /** Oldest first, so eviction is `shift()` and the newest gesture is the last element. */
  private entries: UndoEntry[] = [];
  private pending: PendingGesture | null = null;
  private nextId = 1;
  private totalBytes = 0;
  /** Set when a scenario result latched: nothing is captured and nothing can be rewound. */
  private closed = false;
  private armedEntryId: number | null = null;
  private armedUntilMs = 0;
  private armedAtMs = 0;
  private current: UndoStatus = EMPTY_UNDO_STATUS;

  // The fields the cached status was built from; compared scalar by scalar so a refresh that finds
  // nothing new allocates nothing.
  private keyTargetId = 0;
  private keyTargetLabel: string | null = null;
  private keyDepth = 0;
  private keyMaxDepth = UNDO_MAX_DEPTH;
  private keySeconds = 0;
  private keyArmed = false;
  private keyNeedsConfirmation = false;
  private keyReason: UndoUnavailableReason | null = 'empty';

  constructor(private readonly host: UndoHost) {}

  get depth(): number { return this.entries.length; }

  get estimatedBytes(): number { return this.totalBytes; }

  /**
   * The newest entry, for tests and for the host's diagnostics. Entries are plain data that nothing
   * else references, so handing one out cannot corrupt the ring unless the caller mutates it.
   */
  get newest(): UndoEntry | null { return this.entries[this.entries.length - 1] ?? null; }

  // --- Capture ----------------------------------------------------------------------------------

  begin(kind: UndoGestureKind): boolean {
    if (this.closed || !this.host.scenarioRunning()) return false;
    if (this.pending !== null) {
      // Idempotent within one bulldozer drag (GameApp settles a drag whose pointer-up never came
      // when the next pointer-down starts); a different kind settles the old one first.
      if (this.pending.kind === kind) return true;
      this.commit(this.pending.label ?? FALLBACK_LABELS[this.pending.kind]);
    }
    let capture: UndoCapture;
    try {
      capture = this.host.capture();
    } catch (error) {
      // Undo is a convenience and must never veto the build it guards: a park that cannot be
      // serialized (autosave reports the same failure on its own) simply gets no entry this time.
      console.error('Undo snapshot failed; this step cannot be undone', error);
      this.pending = null;
      return false;
    }
    this.pending = { kind, capture, label: null };
    // A new gesture is the answer to "are you sure?", and the arm belonged to the old target.
    this.armedEntryId = null;
    return true;
  }

  /** Names a still-growing gesture, so an undo press mid-drag commits it under its latest name. */
  setPendingLabel(label: string): void {
    if (this.pending !== null) this.pending.label = label;
  }

  /** True while a snapshot waits for its gesture to finish (the host needs it to commit a drag). */
  get hasPending(): boolean { return this.pending !== null; }

  commit(label: string): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    // The version, not a flag the caller sets: a rejected placement or a click on an empty tile
    // changed nothing and must leave no entry.
    if (this.closed || this.host.worldVersion() === pending.capture.worldVersion) {
      this.refresh();
      return;
    }
    const { capture } = pending;
    const entry: UndoEntry = {
      id: this.nextId,
      kind: pending.kind,
      label,
      state: capture.state,
      clock: capture.clock,
      simulationTimeMs: capture.clock.simulationTimeMs,
      cash: capture.cash,
      estimatedBytes: estimateBytes(capture.guestCount),
    };
    this.nextId += 1;
    this.entries.push(entry);
    this.totalBytes += entry.estimatedBytes;
    this.evict();
    this.refresh();
  }

  abandon(): void {
    this.pending = null;
    this.refresh();
  }

  clear(reason: UndoClearReason): void {
    this.entries = [];
    this.pending = null;
    this.totalBytes = 0;
    this.armedEntryId = null;
    // Only a latched scenario keeps the ring shut; every other reason starts a fresh timeline.
    this.closed = reason === 'scenario-ended';
    this.refresh();
  }

  /** Oldest first: depth cap, then the memory budget, never below the minimum. */
  private evict(): void {
    while (this.entries.length > UNDO_MAX_DEPTH) this.dropOldest();
    while (this.totalBytes > UNDO_MEMORY_BUDGET_BYTES && this.entries.length > UNDO_MIN_DEPTH) this.dropOldest();
  }

  private dropOldest(): void {
    const dropped = this.entries.shift();
    if (dropped) this.totalBytes -= dropped.estimatedBytes;
  }

  /** The depth the ring can actually hold at the current entry weight, between the minimum and the cap. */
  private currentMaxDepth(): number {
    if (this.entries.length === 0) return UNDO_MAX_DEPTH;
    const average = this.totalBytes / this.entries.length;
    const byBudget = Math.floor(UNDO_MEMORY_BUDGET_BYTES / Math.max(1, average));
    return Math.min(UNDO_MAX_DEPTH, Math.max(UNDO_MIN_DEPTH, byBudget));
  }

  // --- Status -----------------------------------------------------------------------------------

  status(): UndoStatus { return this.current; }

  refresh(): boolean {
    if (this.armedEntryId !== null && this.host.now() >= this.armedUntilMs) this.armedEntryId = null;

    const reason = this.unavailableReason();
    const pendingChanged = this.pending !== null && this.host.worldVersion() !== this.pending.capture.worldVersion;
    const entry = this.entries[this.entries.length - 1] ?? null;
    let targetId = 0;
    let targetLabel: string | null = null;
    let targetTimeMs = 0;
    let targetCash = 0;
    let targetKind: UndoGestureKind | null = null;
    if (reason === null) {
      if (pendingChanged && this.pending !== null) {
        // The partial drag: counted, and named by whatever the gesture has called itself so far.
        targetId = -1;
        targetLabel = this.pending.label ?? FALLBACK_LABELS[this.pending.kind];
        targetTimeMs = this.pending.capture.clock.simulationTimeMs;
        targetCash = this.pending.capture.cash;
        targetKind = this.pending.kind;
      } else if (entry !== null) {
        targetId = entry.id;
        targetLabel = entry.label;
        targetTimeMs = entry.simulationTimeMs;
        targetCash = entry.cash;
        targetKind = entry.kind;
      }
    }
    // A recolour takes back colours only: it rewinds no time, whatever the clock says since.
    const cosmetic = targetKind === 'recolour';
    const rewindMs = targetLabel === null || cosmetic ? 0 : Math.max(0, this.host.simulationTimeMs() - targetTimeMs);
    const seconds = cosmetic ? 0 : rewindSecondsBetween(targetTimeMs, this.host.simulationTimeMs());
    const needsConfirmation = targetLabel !== null && needsConfirmationFor(rewindMs);
    const depth = reason === null ? this.entries.length + (pendingChanged ? 1 : 0) : 0;
    const maxDepth = this.currentMaxDepth();
    const armed = reason === null && this.armedEntryId !== null && this.armedEntryId === targetId;

    if (
      targetId === this.keyTargetId && targetLabel === this.keyTargetLabel && depth === this.keyDepth
      && maxDepth === this.keyMaxDepth && seconds === this.keySeconds && armed === this.keyArmed
      && needsConfirmation === this.keyNeedsConfirmation
      && reason === this.keyReason
    ) {
      return false;
    }
    this.keyTargetId = targetId;
    this.keyTargetLabel = targetLabel;
    this.keyDepth = depth;
    this.keyMaxDepth = maxDepth;
    this.keySeconds = seconds;
    this.keyArmed = armed;
    this.keyNeedsConfirmation = needsConfirmation;
    this.keyReason = reason;
    this.current = this.buildStatus(reason, targetLabel, targetCash, seconds, needsConfirmation, depth, maxDepth, armed, targetKind);
    return true;
  }

  private unavailableReason(): UndoUnavailableReason | null {
    if (this.closed || !this.host.scenarioRunning()) return 'scenario-ended';
    if (this.host.busy()) return 'busy';
    const pendingChanged = this.pending !== null && this.host.worldVersion() !== this.pending.capture.worldVersion;
    return this.entries.length === 0 && !pendingChanged ? 'empty' : null;
  }

  private buildStatus(
    reason: UndoUnavailableReason | null,
    target: string | null,
    cashAfter: number,
    seconds: number,
    needsConfirmation: boolean,
    depth: number,
    maxDepth: number,
    armed: boolean,
    kind: UndoGestureKind | null,
  ): UndoStatus {
    if (reason !== null || target === null) {
      const message = reason === 'scenario-ended'
        ? UNDO_SCENARIO_ENDED_MESSAGE
        : reason === 'busy' ? UNDO_BUSY_MESSAGE : UNDO_EMPTY_MESSAGE;
      return {
        ...EMPTY_UNDO_STATUS,
        maxDepth,
        reason: reason ?? 'empty',
        message,
        tooltip: reason === 'empty' || reason === null ? EMPTY_UNDO_STATUS.tooltip : message,
      };
    }
    const goesBack = seconds >= 1
      ? `Rewinds the whole park ${formatRewind(seconds)}: guests, cash and research go back too. `
      : '';
    const confirm = armed ? `Press ${UNDO_SHORTCUT} again to confirm. ` : needsConfirmation ? 'Needs a second press to confirm. ' : '';
    return {
      canUndo: true,
      depth,
      maxDepth,
      label: armed ? confirmButtonLabel(seconds) : undoButtonLabel(seconds),
      tooltip: kind === 'recolour'
        ? `Takes back ${target}. Nothing else changes: no time is rewound and cash stays as it is. `
          + `${depth} step${depth === 1 ? '' : 's'} available (${UNDO_SHORTCUT})`
        : `Takes back ${target}. ${goesBack}Cash returns to ${dollars(cashAfter)}. ${confirm}`
          + `${depth} step${depth === 1 ? '' : 's'} available (${UNDO_SHORTCUT})`,
      target,
      kind,
      rewindSeconds: seconds,
      cashAfterUndo: cashAfter,
      needsConfirmation,
      armed,
      reason: null,
      message: '',
    };
  }

  // --- The press --------------------------------------------------------------------------------

  requestUndo(): UndoOutcome {
    if (this.host.busy()) return this.refuse('busy', UNDO_BUSY_MESSAGE);
    // Ctrl+Z mid-drag undoes the partial drag: the pending snapshot is committed first.
    if (this.pending !== null) this.commit(this.pending.label ?? FALLBACK_LABELS[this.pending.kind]);
    if (this.closed || !this.host.scenarioRunning()) return this.refuse('scenario-ended', UNDO_SCENARIO_ENDED_MESSAGE);
    const entry = this.entries[this.entries.length - 1];
    if (!entry) return this.refuse('empty', UNDO_EMPTY_MESSAGE);

    const cosmetic = entry.kind === 'recolour';
    const rewindMs = cosmetic ? 0 : Math.max(0, this.host.simulationTimeMs() - entry.simulationTimeMs);
    const seconds = cosmetic ? 0 : rewindSecondsBetween(entry.simulationTimeMs, this.host.simulationTimeMs());
    if (needsConfirmationFor(rewindMs)) {
      const now = this.host.now();
      const armed = this.armedEntryId === entry.id && now < this.armedUntilMs;
      // A press right on the heels of the arming is the double-click, not the confirmation; the
      // control stays armed and the window does not restart.
      const tooSoon = armed && now - this.armedAtMs < UNDO_CONFIRM_MIN_GAP_MS;
      if (!armed || tooSoon) {
        if (!armed) {
          this.armedEntryId = entry.id;
          this.armedAtMs = now;
          this.armedUntilMs = now + UNDO_CONFIRM_WINDOW_MS;
          this.refresh();
        }
        return { kind: 'confirm', target: entry.label, rewindSeconds: seconds, strong: seconds > UNDO_STRONG_WARNING_SECONDS };
      }
    }
    this.armedEntryId = null;
    try {
      this.host.restore(entry);
    } catch (error) {
      // The host guarantees the live park is untouched; the entry will fail again, so it goes.
      console.error(error);
      this.removeEntry(entry);
      this.refresh();
      return { kind: 'failed', message: UNDO_FAILED_MESSAGE };
    }
    this.removeEntry(entry);
    this.host.afterRestore();
    this.refresh();
    return { kind: 'undone', target: entry.label, rewoundSeconds: seconds, cash: entry.cash };
  }

  private removeEntry(entry: UndoEntry): void {
    const index = this.entries.indexOf(entry);
    if (index < 0) return;
    this.entries.splice(index, 1);
    this.totalBytes -= entry.estimatedBytes;
  }

  private refuse(reason: UndoUnavailableReason, message: string): UndoOutcome {
    this.refresh();
    return { kind: 'refused', reason, message };
  }
}
