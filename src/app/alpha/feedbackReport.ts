import { SAVE_CONTENT_VERSION, SAVE_SCHEMA_VERSION, type ParkSave } from '../../game/save/version';
import type { Settings } from '../../settings';

/**
 * Phase 19: the feedback report a player can copy or download (the alpha has no server: nothing is sent anywhere by the
 * game). It always carries the game version, the save format, the renderer and the browser, so a report is
 * reproducible; the park itself is attached only with the player's explicit consent. Pure (the caller passes the
 * environment), so the shape is tested in Node.
 */

export const FEEDBACK_REPORT_KIND = 'parksmith-feedback';
export const FEEDBACK_REPORT_VERSION = 1;
/** A message longer than this is cut (the report stays a reasonable paste). */
export const FEEDBACK_MESSAGE_LIMIT = 4_000;

export interface FeedbackEnvironment {
  readonly gameVersion: string;
  /** 'voxel', 'classic', or null when no renderer started. */
  readonly renderer: string | null;
  readonly userAgent: string;
  readonly screen: { readonly width: number; readonly height: number; readonly pixelRatio: number };
  /** A wall-clock ISO time, supplied by the caller. */
  readonly createdAt: string;
  /** A fatal error message when the report is written from the error screen. */
  readonly fatalError?: string | null;
}

export interface FeedbackReport {
  readonly kind: typeof FEEDBACK_REPORT_KIND;
  readonly reportVersion: number;
  readonly gameVersion: string;
  readonly saveSchema: number;
  readonly contentVersion: number;
  readonly renderer: string | null;
  readonly userAgent: string;
  readonly screen: FeedbackEnvironment['screen'];
  readonly createdAt: string;
  readonly message: string;
  readonly fatalError: string | null;
  /** The settings that change what a player sees (no key bindings: they are personal and long). */
  readonly settings: Pick<Settings, 'uiScale' | 'reducedMotion' | 'weatherEffects' | 'notifications' | 'masterVolume'> | null;
  /** The current park as a save file, present only when the player ticked the box. */
  readonly save: ParkSave | null;
}

export const buildFeedbackReport = (
  message: string,
  environment: FeedbackEnvironment,
  settings: Settings | null,
  save: ParkSave | null,
): FeedbackReport => ({
  kind: FEEDBACK_REPORT_KIND,
  reportVersion: FEEDBACK_REPORT_VERSION,
  gameVersion: environment.gameVersion,
  saveSchema: SAVE_SCHEMA_VERSION,
  contentVersion: SAVE_CONTENT_VERSION,
  renderer: environment.renderer,
  userAgent: environment.userAgent,
  screen: { ...environment.screen },
  createdAt: environment.createdAt,
  message: message.trim().slice(0, FEEDBACK_MESSAGE_LIMIT),
  fatalError: environment.fatalError ?? null,
  settings: settings === null ? null : {
    uiScale: settings.uiScale,
    reducedMotion: settings.reducedMotion,
    weatherEffects: settings.weatherEffects,
    notifications: settings.notifications,
    masterVolume: settings.masterVolume,
  },
  save,
});

/** The file name of a downloaded report: `parksmith-feedback-0.2.0-2026-10-14T12-30-00.json`. */
export const feedbackFileName = (report: Pick<FeedbackReport, 'gameVersion' | 'createdAt'>): string => (
  `parksmith-feedback-${report.gameVersion}-${report.createdAt.slice(0, 19).replace(/:/g, '-')}.json`
);

/** The report as text: pretty JSON (a person reads it first). */
export const feedbackText = (report: FeedbackReport): string => JSON.stringify(report, null, 2);
