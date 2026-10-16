import type {
  RecoveryFailure,
  RecoveryFailureCode,
  RecoveryOffer,
  RecoveryPhase,
  RecoverySnapshot,
} from '../app/saves/recoveryTypes';
import { RECOVERY_RECOVERED_SLOT_NAME } from '../app/saves/recoveryTypes';
import { AUTOSAVE_PREVIOUS_SLOT_ID, DEFAULT_AUTOSAVE_NAME, PREVIOUS_AUTOSAVE_LABEL } from '../app/saves/constants';
import { isRecoveryPromptOpen } from './inputContext';
import { knownMode } from './modeLabels';
import { readRunSummary, runIsOver, runLevelTitle, runPositionText } from './runCopy';
import { formatCash, formatLastPlayed, formatPlaytime } from './saveLoadModel';

/**
 * Everything the "resume your last park?" prompt decides, as plain functions: wording, which
 * buttons work, when a second question is needed. The component only renders what these return.
 * The tone is deliberate: a crash is not the player's fault and nothing is lost, so the copy says
 * what happened in one calm sentence and what each button does to the save.
 */

export interface RecoveryStat {
  label: string;
  value: string;
}

export interface RecoveryPromptModel {
  title: string;
  /** One sentence: what happened, to which park, and how old the autosave is. */
  summary: string;
  /** The autosave's own name, shown under the summary so the player can match it to a park. */
  autosaveName: string;
  stats: RecoveryStat[];
  /** What "Not now" does to the save: never "discard", because nothing is deleted. */
  reassurance: string;
}

/**
 * What the interrupted park was, by mode (Phase 22): "your Sandbox park", "the Scenario Penny Lane", "Garden Gala on
 * The Map". A marker that does not say its mode keeps the plain park name.
 */
export const describeInterruptedPark = (offer: Pick<RecoveryOffer, 'parkName' | 'mode'> & { autosave?: { run?: unknown } }): string => {
  const parkName = offer.parkName.trim() === '' ? 'your park' : offer.parkName;
  // Phase 23: the autosave of a park on The Map names its run ("your run on The Map, level 3/5 · seed 1234").
  const run = knownMode(offer.mode) === 'run' ? readRunSummary(offer.autosave?.run) : null;
  if (run !== null && !runIsOver(run.phase)) return `your run on The Map (${runLevelTitle(run)}, ${runPositionText(run)})`;
  switch (knownMode(offer.mode)) {
    case 'sandbox': return 'your Sandbox park';
    case 'scenario': return `the Scenario ${parkName}`;
    case 'run': return `${parkName} on The Map`;
    default: return parkName;
  }
};

/** `now` is a parameter so the result is deterministic. Reads the autosave metadata only. */
export const describeRecoveryOffer = (offer: RecoveryOffer, now: number): RecoveryPromptModel => {
  const age = formatLastPlayed(offer.autosave.savedAt, now);
  // Phase 31: the previous generation is offered when the last autosave could not be read; say so.
  const previous = offer.autosave.slotId === AUTOSAVE_PREVIOUS_SLOT_ID;
  const saved = previous
    ? (age === 'unknown' ? 'The last autosave could not be read, but the one before it is ready.' : `The last autosave could not be read, but the one before it was saved ${age}.`)
    : age === 'unknown' ? 'Your last autosave is ready.' : `Your last autosave was saved ${age}.`;
  const parkName = describeInterruptedPark(offer);
  const run = knownMode(offer.mode) === 'run' ? readRunSummary((offer.autosave as { run?: unknown }).run) : null;
  return {
    title: run !== null && !runIsOver(run.phase) ? 'Pick up your run where you left off?' : 'Pick up where you left off?',
    summary: `Parksmith closed unexpectedly while you were playing ${parkName}. ${saved}`,
    autosaveName: previous && offer.autosave.name === DEFAULT_AUTOSAVE_NAME ? PREVIOUS_AUTOSAVE_LABEL : offer.autosave.name,
    stats: [
      { label: 'Park time', value: formatPlaytime(offer.autosave.playtimeSeconds) },
      { label: 'Guests', value: offer.autosave.guestCount.toLocaleString('en-US') },
      { label: 'Cash', value: formatCash(offer.autosave.cash) },
      { label: 'Rating', value: String(Math.round(offer.autosave.rating)) },
    ],
    reassurance: `Not now keeps it in Save / Load as “${RECOVERY_RECOVERED_SLOT_NAME}”. Nothing is deleted.`,
  };
};

export interface RecoveryButtons {
  resumeLabel: string;
  notNowLabel: string;
  /** Both buttons wait while either command is in flight: one decision at a time. */
  disabled: boolean;
}

export const describeRecoveryButtons = (phase: RecoveryPhase): RecoveryButtons => ({
  resumeLabel: phase === 'resuming' ? 'Resuming…' : 'Resume autosave',
  notNowLabel: phase === 'dismissing' ? 'Keeping…' : 'Not now',
  disabled: phase === 'resuming' || phase === 'dismissing',
});

export type ResumePlan = 'resume-now' | 'confirm-replace';

/**
 * Resuming replaces the park being played. The default sandbox right after a start has nothing to
 * lose and resumes at once; a park the player already changed gets the same question the load
 * dialog asks.
 */
export const planRecoveryResume = (unsavedChanges: boolean): ResumePlan => (unsavedChanges ? 'confirm-replace' : 'resume-now');

export const RECOVERY_REPLACE_TEXT = 'This replaces the park you are playing now, which has unsaved changes.';

const FAILURE_TEXT: Readonly<Record<RecoveryFailureCode, string>> = {
  'no-offer': 'There is nothing to recover any more.',
  changed: 'Another Parksmith tab changed the autosave, so this offer no longer applies.',
  'no-free-slot': `All ten save slots are full, so the autosave cannot be kept as “${RECOVERY_RECOVERED_SLOT_NAME}”. Delete a save in Save / Load, or resume it now.`,
  unreadable: 'The autosave could not be read. It is kept in Save / Load.',
  'not-found': 'That autosave no longer exists.',
  busy: 'Another save or load is still running. Try again in a moment.',
  store: 'Browser storage did not respond. Try again in a moment.',
};

/** One sentence per code, mapped here rather than shown raw: a store failure's message can be a browser's internal text. */
export const describeRecoveryFailure = (error: RecoveryFailure): string => FAILURE_TEXT[error.code];

/** Only this failure has something the player can do about it from the prompt. */
export const recoveryFailureOffersSaveDialog = (error: RecoveryFailure | null): boolean => error?.code === 'no-free-slot';

export interface RecoveryBannerModel {
  /** Identifies one banner, so closing it does not close the next. */
  key: string;
  text: string;
}

/**
 * The line shown when there is no prompt to carry the news: an unclean shutdown without a usable
 * autosave (the controller's notice), or an offer that was withdrawn or unreadable (an error left
 * on an idle controller). While the prompt is open it speaks for itself.
 */
export const recoveryBanner = (recovery: RecoverySnapshot): RecoveryBannerModel | null => {
  if (isRecoveryPromptOpen(recovery.phase) || recovery.phase === 'checking') return null;
  if (recovery.notice !== null) return { key: `notice:${recovery.notice.id}`, text: recovery.notice.text };
  if (recovery.error !== null) return { key: `error:${recovery.error.code}`, text: describeRecoveryFailure(recovery.error) };
  return null;
};

/** The banner to render now: null once its key was dismissed. */
export const visibleRecoveryBanner = (recovery: RecoverySnapshot, dismissedKey: string | null): RecoveryBannerModel | null => {
  const banner = recoveryBanner(recovery);
  return banner !== null && banner.key !== dismissedKey ? banner : null;
};

/** How long the banner stays before it lets go on its own. Longer than a save notice: it is news about a crash. */
export const RECOVERY_BANNER_VISIBLE_MS = 12_000;
