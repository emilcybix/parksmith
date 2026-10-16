import { describe, expect, it } from 'vitest';
import { countdownText, formatParkClock, timeLimitText } from './scenarioDeadlineModel';

describe('scenario deadline text', () => {
  it('keeps m:ss for a scenario written in seconds', () => {
    expect(timeLimitText({ timeLimitSeconds: 900 })).toBe('15:00');
    expect(countdownText({ timeLimitDays: null, timeLimitSeconds: 900, remainingDays: 1.2, remainingSeconds: 570 })).toBe('9:30');
    expect(formatParkClock(61.4)).toBe('1:01');
    expect(formatParkClock(-5)).toBe('0:00');
  });

  it('reads in days for a scenario written in days', () => {
    expect(timeLimitText({ timeLimitDays: 2, timeLimitSeconds: 1_440 })).toBe('2 days (24:00 min)');
    expect(timeLimitText({ timeLimitDays: 1, timeLimitSeconds: 720 })).toBe('1 day (12:00 min)');
    expect(timeLimitText({ timeLimitDays: 1.25, timeLimitSeconds: 900 })).toBe('1.25 days (15:00 min)');
    expect(timeLimitText({ timeLimitDays: 1.5, timeLimitSeconds: 1_080 })).toBe('1.5 days (18:00 min)');
    expect(countdownText({ timeLimitDays: 2, timeLimitSeconds: 1_440, remainingDays: 1.4, remainingSeconds: 1_008 })).toBe('1.4 days left');
    expect(countdownText({ timeLimitDays: 2, timeLimitSeconds: 1_440, remainingDays: 1, remainingSeconds: 720 })).toBe('1 day left');
    expect(countdownText({ timeLimitDays: 2, timeLimitSeconds: 1_440, remainingDays: 0, remainingSeconds: 0 })).toBe('0:00 left');
  });

  it('counts down in park time when a day-length card makes the park\'s days longer or shorter (Phase 25)', () => {
    const source = { timeLimitDays: 2, timeLimitSeconds: 1_440, remainingDays: 1.4, remainingSeconds: 1_008 };
    expect(countdownText(source, 720), 'the default day keeps the days').toBe('1.4 days left');
    expect(countdownText(source, 1_080)).toBe('16:48 left');
    expect(countdownText(source, 540)).toBe('16:48 left');
    expect(countdownText({ ...source, timeLimitDays: null }, 1_080), 'a deadline in seconds is unchanged').toBe('16:48');
  });
});
