import { getSettings, shouldShowNotification, type NotificationClass } from '../settings';
import { useUiStore } from './store';

/**
 * Shows a toast from UI code, honouring the notification-intensity setting. The class is required
 * so every call site decides whether its message is an alert (never hidden), an important event or
 * routine confirmation. Returns whether the toast was shown. A suppressed toast is not announced
 * either: the visible toast and the screen-reader live region share the one store field.
 */
export const showToast = (message: string, cls: NotificationClass): boolean => {
  if (!shouldShowNotification(cls, getSettings().notifications)) return false;
  useUiStore.getState().setToast(message, cls);
  return true;
};
