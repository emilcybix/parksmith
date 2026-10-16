import { feedbackFileName, feedbackText, type FeedbackReport } from '../app/alpha/feedbackReport';

/**
 * Phase 19: what the feedback form and the error screen do with a report — copy it, download it, or open the alpha's
 * feedback page (configured at build time with VITE_FEEDBACK_URL; absent = no such button). Nothing is ever sent by the
 * game itself.
 */

export const FEEDBACK_URL: string | null = (() => {
  const raw = (import.meta.env as Record<string, string | undefined>).VITE_FEEDBACK_URL;
  return typeof raw === 'string' && /^(https:|mailto:)/.test(raw) ? raw : null;
})();

/** Copies the report text; false when the clipboard is unavailable or refused. */
export const copyReport = async (report: FeedbackReport): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(feedbackText(report));
    return true;
  } catch {
    return false;
  }
};

/** Saves the report as a JSON file through a temporary link. */
export const downloadReport = (report: FeedbackReport): void => {
  const blob = new Blob([feedbackText(report)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = feedbackFileName(report);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};
