import type { ParkScenarioId } from '../scenarios/types';
import type { TourNodeId } from '../tour/types';
import { hashState } from './hash';
import type { ParkSaveV15, SimulationClockState } from './state';
import type { GameMode } from '../modes/types';

/**
 * Save schema versioning and the envelope. The migration chain and the load-side envelope checks live in
 * `migrate.ts` (Phase 34), which only the lazily loaded load path imports.
 *
 * Policy for unreadable saves: they are surfaced, never silently discarded or half-loaded. Every
 * failure is a SaveError with a stable `code` so the UI (step 2) can say what happened and offer
 * the right choice, and so a tester can assert on the cause instead of on message text.
 */

/** Bumped whenever the shape of ParkSaveV15 (or the envelope) changes. Add a migration with it. */
export const SAVE_SCHEMA_VERSION = 17;

/**
 * Bumped when catalog, GAME_CONFIG or card/scenario content changes in a way that alters how an
 * old save continues (prices, durations, balance). It is NOT a reason to refuse a save: saved
 * values always win, so the park keeps doing what it was doing. The loader reports the drift so
 * the UI can say "this park was saved under an older balance".
 */
/**
 * History: 1 = the first shipped balance; 2 = weather and the arrival curve; 3 = Phase 16 (12 catalog entries, 5 research
 * projects, and the `themeAffinity` / `researchCostScale` ruleset keys a NEW park stores; a v2 park keeps neither and
 * plays exactly as it did); 4 = Phase 14 (`crowdFeedback` for new parks; a v3 park keeps it off); 5 = Phase 29 (guest life:
 * benches, nausea, warmth, pauses, six new stalls; every park, old or new, plays by it once loaded); 6 = Phase 39 (two
 * coaster families, the Whisker Mouse and the Timber Twister, and their research projects Tight Turns and Timber
 * Framing; an older park can research them too, and its coasters keep the numbers they were built with); 7 = Phase 44-46
 * (Thunder Launch builds shuttles, taller coasters, coaster elements; built coasters keep their saved numbers); 8 = Phase 58
 * (a new coaster's intensity is gentler: a 2-level biggest drop and an S-bend count for less, and a circuit may stay at
 * height 1; built coasters keep their saved numbers).
 */
export const SAVE_CONTENT_VERSION = 8;

export type SaveErrorCode =
  /** The data is not a save envelope at all (not an object, no integer schemaVersion). */
  | 'not-a-save'
  /** It claims to be a save but is malformed or not plain data. */
  | 'corrupt'
  /** Written by a newer build than this one understands. Never downgrade silently. */
  | 'too-new'
  /** Older than the first migration this build still carries. */
  | 'no-migration-path'
  /** A migration threw or produced an envelope that is not at the version it promised. */
  | 'migration-failed'
  /** A state failed an owner's validation during restore (names the owner and path). */
  | 'invalid-state'
  /**
   * serialize() was called while a world edit had not yet been synced into the owners' caches.
   * Raised at SAVE time, so a save that could never be loaded is never written (and never replaces
   * a good one). The caller syncs the session and tries again.
   */
  | 'unsynced'
  /** The save refers to content (scenario, card, definition, project id) this build does not have. */
  | 'content-mismatch';

export class SaveError extends Error {
  readonly code: SaveErrorCode;

  constructor(code: SaveErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SaveError';
    this.code = code;
  }
}

/**
 * The one way an owner's restore() refuses a state: `owner` is the class name, `path` points into
 * the owner's state ("guests[17].routeIndex"). Owners call this BEFORE mutating anything.
 */
export const invalidState = (owner: string, path: string, problem: string): SaveError => (
  new SaveError('invalid-state', `${owner} cannot restore: ${path} ${problem}`)
);

/** App-level data that belongs to a saved park but not to the simulation. */
export interface ParkSaveAppState {
  /**
   * Simulation clock. The accumulator is deliberately absent (it restarts at 0); speed is stored
   * so the loader can choose to honour or override it (the alpha loads paused).
   */
  clock: SimulationClockState;
  /**
   * Legacy (Phase 23): the Park Tour is retired, so this is always written null and ignored on load. The format keeps it
   * (validated as a known node or null) so every older save stays readable.
   */
  tourNodeId: TourNodeId | null;
  /**
   * Phase 26: the map view in quarter turns (0 to 3), a camera orientation and not part of the
   * world. Optional and absent in older saves (= 0), so adding it needed no schema bump: the app
   * block is not hashed and no simulation code reads it.
   */
  viewRotation?: 0 | 1 | 2 | 3;
}

/** The envelope around the park state. Header fields are readable without restoring anything. */
export interface ParkSave {
  schemaVersion: number;
  contentVersion: number;
  /** World tick at save time: park age, and the only "playtime" the simulation itself knows. */
  savedAtTick: number;
  /**
   * Wall-clock time. Supplied by the caller (the persistence layer) because src/game must not read
   * the clock, and it never feeds the simulation, so it is not part of any determinism hash.
   */
  savedAtEpochMs: number;
  /** Duplicated from the state so slot lists can show it from the header. null = Sandbox. */
  scenarioId: ParkScenarioId | null;
  /** Duplicated from the state (schema 10) so slot lists can show how the park was played without restoring it. */
  mode: GameMode;
  /**
   * Integrity fingerprint of `state` (hashState, 16 hex characters). Per-owner validation cannot
   * notice that an element was removed from an array or that a file was cut short and re-closed:
   * the smaller park is perfectly valid. This can. It guards against damage, not against forgery
   * (see the boundary note in ARCHITECTURE.md: a save may be edited on purpose).
   */
  stateHash: string;
  app: ParkSaveAppState;
  state: ParkSaveV15;
}

/**
 * Stamps the current schema and content versions and the integrity hash on a freshly serialized
 * state. The hash is the expensive part (about 30 ms for a 1,000-guest park, canonical JSON with
 * sorted keys), while ParkSession.serialize() itself costs about 3 ms. serialize() must run at a
 * tick boundary; this does not: the state it receives is an independent deep copy, so the
 * persistence layer should call it off the frame (idle callback or worker) after serialize().
 */
export const createParkSave = (
  state: ParkSaveV15,
  app: ParkSaveAppState,
  savedAtEpochMs: number,
): ParkSave => ({
  schemaVersion: SAVE_SCHEMA_VERSION,
  contentVersion: SAVE_CONTENT_VERSION,
  savedAtTick: state.world.tick,
  savedAtEpochMs,
  scenarioId: state.scenarioId,
  mode: state.mode,
  stateHash: hashState(state),
  app,
  state,
});

/** How a save's balance generation compares with this build; see SAVE_CONTENT_VERSION. */
export type ContentDrift = 'none' | 'older' | 'newer';

export const contentDriftOf = (save: Pick<ParkSave, 'contentVersion'>): ContentDrift => (
  save.contentVersion === SAVE_CONTENT_VERSION ? 'none' : save.contentVersion < SAVE_CONTENT_VERSION ? 'older' : 'newer'
);

