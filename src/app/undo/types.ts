import type { ParkSaveV4, SimulationClockState } from '../../game/save/state';

/**
 * The contract of snapshot undo (Phase 12, step 3). Three builders work against this file and
 * `constants.ts` in parallel; DESIGN.md next to this phase explains the behaviour, this file fixes
 * the names and shapes. Nothing here imports React, Pixi or a renderer, so the ring can be tested
 * with a fake host.
 *
 * What undo IS: a bounded stack of whole-park snapshots, each taken just before a construction
 * gesture and restored through the same boundary as a load. It therefore REWINDS THE WHOLE PARK to
 * that moment (simulation time, guests, cash, ledger, research, ride runtime state), never only
 * the buildings. `rewindSeconds` is how far.
 */

/**
 * The gestures that take a snapshot. A demolition is a gesture like any other. A `recolour` (Phase 28)
 * is the one COSMETIC gesture: it is captured like the others, but undoing it only puts the colours
 * back (no session swap, no rewound time, no returned cash), so it never needs the long-rewind
 * confirmation and the status says it rewinds nothing.
 *
 * A `card` (Phase 25) is a one-shot played in a run stage: it moves no `world.version`, so the app's undo stamp counts
 * plays itself; undoing it rewinds the whole park like a build (the card comes back ready, its cost and effect rewind).
 */
export type UndoGestureKind = 'paths' | 'object' | 'coaster' | 'demolition' | 'recolour' | 'card' | 'land';

/** Why nothing can be rewound right now; the control says so instead of going quiet. */
export type UndoUnavailableReason =
  /** The ring is empty: nothing has been built since the park started, was loaded or resumed. */
  | 'empty'
  /** The scenario latched success or failure; the ring was cleared and stays closed. */
  | 'scenario-ended'
  /** A load, a resume or an undo is in flight. */
  | 'busy';

/** Why the ring was emptied, so a test (and a future toast) can name it. */
export type UndoClearReason =
  /** startScenario, restartScenario, the dev park: a new park. */
  | 'new-park'
  /** A slot was loaded or an interrupted session resumed. */
  | 'loaded'
  /** The scenario result latched: rewinding past a win would undo an awarded reward. */
  | 'scenario-ended'
  /** The renderer or session was torn down. */
  | 'disposed';

/**
 * One ring entry: the park as it was immediately before a gesture. `state` is a plain-data deep
 * copy that nothing else references (measured: serialize() output is independent of the live
 * park, and fromState never mutates or aliases its input), so an entry can be restored without
 * being consumed, and a failed restore leaves it intact.
 */
export interface UndoEntry {
  /** Monotonic within one ring; also the key a UI list would use. */
  id: number;
  kind: UndoGestureKind;
  /**
   * What the gesture was, in the words the button and toast use: "Ferris Wheel built",
   * "12 path tiles built", "Ferris Wheel demolished", "3 tiles demolished". Set by `commit`.
   */
  label: string;
  state: ParkSaveV4;
  /** The clock as it was; speed inside it is ignored on restore (the current speed is kept). */
  clock: SimulationClockState;
  /** `clock.simulationTimeMs` at capture, duplicated so status needs no deep read. */
  simulationTimeMs: number;
  /** Cash at capture: what the tooltip says the balance returns to. */
  cash: number;
  /** Heuristic retained size from constants.ts, never measured per entry. */
  estimatedBytes: number;
}

/** What the host hands the ring at capture time. */
export interface UndoCapture {
  state: ParkSaveV4;
  clock: SimulationClockState;
  cash: number;
  guestCount: number;
  worldVersion: number;
}

/**
 * What GameApp provides to the ring. A port, so the ring is tested without a renderer and so the
 * session swap (a GameApp concern, shared with load) stays out of it.
 */
export interface UndoHost {
  /**
   * Serializes the live park at a step boundary (a DOM input handler or the ticker, never inside
   * `world.batch`: GameWorld.serialize throws in an open batch). Runs session.syncWithWorld() first
   * and retries once on SaveError('unsynced'), exactly as the autosave capture does.
   */
  capture(): UndoCapture;
  worldVersion(): number;
  simulationTimeMs(): number;
  cash(): number;
  /** False once a scenario result has latched. A sandbox is always running in this sense. */
  scenarioRunning(): boolean;
  /** True while a load, resume or undo swap is in flight. */
  busy(): boolean;
  /**
   * Swaps in a fresh `ParkSession.fromState(entry.state)` through the same path as `installLoaded`
   * (see DESIGN.md section 3 for what is kept and what is reset). ATOMIC: everything that can
   * fail happens before the live park is touched, and a throw leaves the live park exactly as it
   * was. Returns normally only when the first frame of the rewound park can be painted.
   */
  restore(entry: UndoEntry): void;
  /** Called after a successful restore: dirty flag for the autosave layer (`notifyParkRewound`). */
  afterRestore(): void;
  /** Wall-clock ms; injected so the confirmation window is testable. */
  now(): number;
}

/** What `requestUndo` did, so GameApp can toast without re-deriving anything. */
export type UndoOutcome =
  | { kind: 'undone'; target: string; rewoundSeconds: number; cash: number }
  /**
   * The rewind is longer than UNDO_CONFIRM_REWIND_SECONDS: the first press only arms the control.
   * A second press inside UNDO_CONFIRM_WINDOW_MS performs it.
   */
  | { kind: 'confirm'; target: string; rewindSeconds: number; strong: boolean }
  | { kind: 'refused'; reason: UndoUnavailableReason; message: string }
  /** The snapshot could not be restored; the live park is untouched and the entry was dropped. */
  | { kind: 'failed'; message: string };

/**
 * The slice of the UI store the dock button, the tooltip and the toast render from. Flat on
 * purpose (nullable fields instead of a union) so a selector reads it without narrowing, and so
 * the object can be compared field by field to avoid publishing an identical one every frame.
 */
export interface UndoStatus {
  canUndo: boolean;
  /** Entries a chain of undos can step through, counting a gesture still in progress. */
  depth: number;
  /** The depth cap currently in force (the memory budget can lower it, never below the minimum). */
  maxDepth: number;
  /**
   * The button text. Enabled: "Undo · rewinds 42 s" (just "Undo" below one second, for example
   * while paused). Disabled: "Undo". Armed: "Confirm rewind 3 min 20 s". Never a bare "Undo build".
   */
  label: string;
  /** The full sentence for the tooltip, including the shortcut and what else goes back. */
  tooltip: string;
  /** What the next press takes back ("Ferris Wheel demolished"), null when disabled. */
  target: string | null;
  kind: UndoGestureKind | null;
  /** Whole simulated seconds the next press rewinds; 0 when disabled or paused since the gesture. */
  rewindSeconds: number;
  /** The balance after the next press, null when disabled. */
  cashAfterUndo: number | null;
  /** Whether the next press needs a second press (rewind > UNDO_CONFIRM_REWIND_SECONDS). */
  needsConfirmation: boolean;
  /** True between the arming press and its expiry; the button shows the confirm wording. */
  armed: boolean;
  reason: UndoUnavailableReason | null;
  /** The refusal in words ("Nothing to undo yet"); empty when canUndo. */
  message: string;
}

/**
 * The ring. All methods are synchronous and cheap except `begin` (one serialize, measured 2 ms
 * median at 1,000 guests, 12.5 ms at 6x CPU throttle) and `requestUndo` (one fromState and a
 * renderer swap). `status` and `refresh` allocate nothing unless the status actually changed.
 */
export interface SnapshotUndo {
  /**
   * Captures the pre-gesture snapshot into a PENDING slot, before the first mutation. Idempotent
   * while a gesture is pending, so a bulldozer drag calls it on every pointer move and captures
   * once. Must run outside `world.batch`. A pending snapshot is not in the ring yet. Returns false
   * when no snapshot was taken (scenario over, or the capture threw): the gesture still proceeds.
   */
  begin(kind: UndoGestureKind): boolean;
  /**
   * Moves the pending snapshot into the ring if the world changed since `begin` (world version
   * differs), otherwise drops it, so a click on an empty tile costs no entry. Evicts the oldest
   * entries over depth or budget. No-op without a pending snapshot.
   */
  commit(label: string): void;
  /** Drops the pending snapshot without committing (a rejected placement, a cancelled drag). */
  abandon(): void;
  /** Empties the ring and any pending snapshot. */
  clear(reason: UndoClearReason): void;
  /** The cached status; allocation-free. */
  status(): UndoStatus;
  /**
   * Recomputes the status only when something it shows can have changed (the simulated second
   * ticked, the confirmation expired, the ring changed). True when `status()` now returns a new
   * object, so the caller publishes to the store only then. Called from the same cadence as syncUi.
   */
  refresh(): boolean;
  /**
   * The undo press. Commits a pending gesture first (Ctrl+Z during a bulldozer drag undoes the
   * partial drag). Implements the two-press confirmation, then restores the newest entry.
   */
  requestUndo(): UndoOutcome;
  /** Number of committed entries. */
  readonly depth: number;
  /** Sum of the entries' estimatedBytes. */
  readonly estimatedBytes: number;
}

/** Registered by GameApp through registerGameCommands; the dock button and Ctrl+Z both end here. */
export interface UndoCommands {
  /** Routes exactly as the keyboard does: a half-drawn coaster track steps back a piece first. */
  requestUndo(): void;
}
