import type { NotificationIntensity } from './schema';

/**
 * alert: a refusal of or an error in something the player just did, a system failure, anything
 *   needing a decision. Never suppressed.
 * important: progress and world events the player might otherwise miss.
 * routine: confirmation of a successful player action, hints and developer chatter.
 */
export type NotificationClass = 'alert' | 'important' | 'routine';
export type ManagementSeverity = 'info' | 'warning' | 'critical';

export const shouldShowNotification = (cls: NotificationClass, level: NotificationIntensity): boolean => {
  if (cls === 'alert') return true;
  if (cls === 'important') return level !== 'minimal';
  return level === 'all';
};

export const managementClass = (severity: ManagementSeverity): NotificationClass => (
  severity === 'critical' ? 'alert' : severity === 'warning' ? 'important' : 'routine'
);

export const shouldShowManagementNotification = (severity: ManagementSeverity, level: NotificationIntensity): boolean => (
  shouldShowNotification(managementClass(severity), level)
);
