import { describe, expect, it } from 'vitest';
import { managementClass, shouldShowManagementNotification, shouldShowNotification, type NotificationClass } from './notify';
import { SETTING_OPTIONS } from './schema';

describe('notification filtering table', () => {
  const table: Record<NotificationClass, [boolean, boolean, boolean]> = {
    // all, important, minimal
    alert: [true, true, true],
    important: [true, true, false],
    routine: [true, false, false],
  };
  for (const [cls, expected] of Object.entries(table) as [NotificationClass, [boolean, boolean, boolean]][]) {
    SETTING_OPTIONS.notifications.forEach((level, index) => {
      it(`${cls} at ${level} is ${expected[index] ? 'shown' : 'hidden'}`, () => {
        expect(shouldShowNotification(cls, level)).toBe(expected[index]);
      });
    });
  }

  it('an alert (refusal, error, decision) is never suppressed at any level', () => {
    for (const level of SETTING_OPTIONS.notifications) expect(shouldShowNotification('alert', level)).toBe(true);
  });

  it('maps management severity: critical alert, warning important, info routine', () => {
    expect(managementClass('critical')).toBe('alert');
    expect(managementClass('warning')).toBe('important');
    expect(managementClass('info')).toBe('routine');
    expect(shouldShowManagementNotification('critical', 'minimal')).toBe(true);
    expect(shouldShowManagementNotification('warning', 'minimal')).toBe(false);
    expect(shouldShowManagementNotification('warning', 'important')).toBe(true);
    expect(shouldShowManagementNotification('info', 'important')).toBe(false);
    expect(shouldShowManagementNotification('info', 'all')).toBe(true);
  });
});
