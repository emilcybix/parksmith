import { SaveError, type SaveErrorCode } from '../../game/save/version';
import type { LoadedPark, LoadPathModule, SaveFailureCode } from './types';
import { sessionFromSave } from '../../game/session/fromSave';

/**
 * The lazily imported load path. GameApp reaches it only through `import('./loadSave')`, so the
 * code that turns a stored record into a session (and explains why it could not) is a separate
 * chunk that a player who never loads a save never downloads.
 *
 * Phase 34: the migration chain (`game/save/migrate.ts`) is reached only through `sessionFromSave`
 * (`game/session/fromSave.ts`), which only this module imports, so it is part of this lazy chunk and
 * no longer of the main one (pinned by `src/app/bundleSplit.static.test.ts`). The per-owner restore
 * validation stays in the main chunk because snapshot undo restores through `ParkSession.fromState`.
 */

/** Builds a FRESH session or throws SaveError; never touches the live park. */
export const loadParkFromPayload: LoadPathModule['loadParkFromPayload'] = (payload: unknown): LoadedPark => (
  sessionFromSave(payload)
);

/** Player-facing text for every reason a stored record cannot become a park. */
const LOAD_ERROR_TEXT: Readonly<Record<SaveErrorCode, string>> = {
  'not-a-save': 'This record is not a Parksmith save.',
  corrupt: 'This save is damaged and cannot be read.',
  'too-new': 'This save was written by a newer version of the game. Update the game to open it.',
  'no-migration-path': 'This save is too old for this version of the game to convert.',
  'migration-failed': 'Converting this save to the current version failed.',
  'invalid-state': 'This save contains values the game cannot restore.',
  'content-mismatch': 'This save uses a park or card that this version of the game does not have.',
  unsynced: 'The park changed while it was being read. Try again.',
};

export interface LoadFailureDescription {
  code: SaveFailureCode;
  /** Player-facing; also what the slot row shows once the record is marked unreadable. */
  message: string;
  /**
   * Set when the stored record itself is bad, so the slot should be flagged unreadable with this
   * code (a retry will not help). Null for failures that say nothing about the record.
   */
  unreadableCode: SaveErrorCode | null;
}

/** Maps anything `loadParkFromPayload` can throw to a typed failure with a stable code. */
export const loadFailureFrom = (error: unknown): LoadFailureDescription => {
  if (error instanceof SaveError) {
    return { code: error.code, message: LOAD_ERROR_TEXT[error.code], unreadableCode: error.code === 'unsynced' ? null : error.code };
  }
  return {
    code: 'unknown',
    message: `This save could not be loaded (${error instanceof Error ? error.message : String(error)}).`,
    unreadableCode: null,
  };
};
