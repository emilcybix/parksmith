import { describe, expect, it } from 'vitest';
import {
  DEMOLISH_CONFIRM_GROUP_LABEL, DEMOLISH_CONFIRM_LABEL, DEMOLISH_KEEP_LABEL, demolishButtonLabel, demolishConfirmText,
} from './demolishModel';

describe('demolish copy (Phase 11, PA-015)', () => {
  it('labels the inspector button with the refund', () => {
    expect(demolishButtonLabel(340)).toBe('Demolish · refund $340');
    expect(demolishButtonLabel(1250)).toBe('Demolish · refund $1,250');
    expect(demolishButtonLabel(0)).toBe('Demolish · refund $0');
    expect(demolishButtonLabel(null)).toBe('Demolish');
  });

  it('asks the confirmation question', () => {
    expect(demolishConfirmText('Comet Coaster', 340)).toBe('Demolish Comet Coaster? You get $340 back.');
    expect(demolishConfirmText('Comfort Pavilion', 2500)).toBe('Demolish Comfort Pavilion? You get $2,500 back.');
    expect(demolishConfirmText('Comet Coaster', null)).toBe('Demolish Comet Coaster?');
  });

  it('names the group and its buttons; the accessible names start with the visible text', () => {
    expect(DEMOLISH_CONFIRM_GROUP_LABEL).toBe('Confirm demolition');
    expect(DEMOLISH_KEEP_LABEL).toBe('Keep it');
    expect(DEMOLISH_CONFIRM_LABEL).toBe('Demolish');
    expect(demolishButtonLabel(340).startsWith(DEMOLISH_CONFIRM_LABEL)).toBe(true);
  });
});
