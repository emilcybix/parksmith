import { migrateSave } from '../save/migrate';
import { contentDriftOf, type ContentDrift, type ParkSave } from '../save/version';
import { ParkSession } from './ParkSession';

/**
 * The migration entry point: any stored value (any schema version) in, a ready session out. Returns the migrated
 * envelope too, because the app part (clock, tour node) belongs to the caller, not to the session, and how the save's
 * balance generation compares with this build.
 *
 * Phase 34: this was `ParkSession.fromSave`. It lives in its own module so that `ParkSession` (main chunk) does not
 * import the migration chain; only the lazily imported load path (`app/saves/loadSave.ts`) and tests reach it. It is
 * still synchronous: the load path is already behind a dynamic import, so no caller had to become async.
 */
export const sessionFromSave = (raw: unknown): { session: ParkSession; save: ParkSave; contentDrift: ContentDrift } => {
  const save = migrateSave(raw);
  // Saved values always win, so a drifted save still loads; the drift is reported for the UI to say so.
  return { session: ParkSession.fromState(save.state), save, contentDrift: contentDriftOf(save) };
};
