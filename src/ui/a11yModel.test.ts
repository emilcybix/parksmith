import { describe, expect, it } from 'vitest';
import {
  NO_PULSE_ANNOUNCED,
  NO_TOAST_ANNOUNCED,
  PULSE_ANNOUNCE_GAP_MS,
  ROUTINE_ANNOUNCE_GAP_MS,
  columnsFromOffsets,
  contrastRatio,
  labelWithSubject,
  openToggleLabel,
  parseHex,
  percentLabel,
  planNotificationAnnouncements,
  planPulseAnnouncement,
  planToastAnnouncement,
  rovingStop,
  rovingTabIndex,
  rovingTarget,
  stepperLabel,
  toastPoliteness,
} from './a11yModel';

describe('rovingTarget: a tablist', () => {
  const tabs = { orientation: 'horizontal' } as const;
  it('moves with Left and Right and wraps at the ends', () => {
    expect(rovingTarget('ArrowRight', 0, 6, tabs)).toBe(1);
    expect(rovingTarget('ArrowRight', 5, 6, tabs)).toBe(0);
    expect(rovingTarget('ArrowLeft', 0, 6, tabs)).toBe(5);
    expect(rovingTarget('ArrowLeft', 3, 6, tabs)).toBe(2);
  });
  it('Home and End jump to the ends', () => {
    expect(rovingTarget('Home', 4, 6, tabs)).toBe(0);
    expect(rovingTarget('End', 1, 6, tabs)).toBe(5);
  });
  it('leaves Up, Down and every other key to the browser', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'a', 'Tab', 'PageDown']) expect(rovingTarget(key, 2, 6, tabs)).toBeNull();
  });
  it('an empty group never moves', () => {
    expect(rovingTarget('ArrowRight', 0, 0, tabs)).toBeNull();
    expect(rovingTarget('Home', 0, 0, tabs)).toBeNull();
  });
  it('a single tab stays put', () => {
    expect(rovingTarget('ArrowRight', 0, 1, tabs)).toBe(0);
  });
});

describe('rovingTarget: a vertical list', () => {
  it('uses Up and Down only', () => {
    const list = { orientation: 'vertical' } as const;
    expect(rovingTarget('ArrowDown', 0, 3, list)).toBe(1);
    expect(rovingTarget('ArrowUp', 0, 3, list)).toBe(2);
    expect(rovingTarget('ArrowRight', 0, 3, list)).toBeNull();
  });
});

describe('rovingTarget: the build card grid (no wrap)', () => {
  // 7 cards in rows of 3: [0 1 2] [3 4 5] [6]
  const grid = { orientation: 'both', columns: 3, wrap: false } as const;
  it('Left and Right walk the cards in reading order and stop at the ends', () => {
    expect(rovingTarget('ArrowRight', 2, 7, grid)).toBe(3);
    expect(rovingTarget('ArrowRight', 6, 7, grid)).toBe(6);
    expect(rovingTarget('ArrowLeft', 0, 7, grid)).toBe(0);
  });
  it('Down and Up move by a row and keep the column', () => {
    expect(rovingTarget('ArrowDown', 1, 7, grid)).toBe(4);
    expect(rovingTarget('ArrowUp', 4, 7, grid)).toBe(1);
  });
  it('Down into a shorter last row lands on its last card; Down on the last row stays', () => {
    expect(rovingTarget('ArrowDown', 4, 7, grid)).toBe(6);
    expect(rovingTarget('ArrowDown', 6, 7, grid)).toBe(6);
  });
  it('Up on the first row stays', () => {
    expect(rovingTarget('ArrowUp', 1, 7, grid)).toBe(1);
  });
  it('a one-column grid behaves like a list', () => {
    expect(rovingTarget('ArrowDown', 0, 4, { orientation: 'both', columns: 1, wrap: false })).toBe(1);
  });
  it('wrapping grids come round', () => {
    const wrapping = { orientation: 'both', columns: 3, wrap: true } as const;
    expect(rovingTarget('ArrowDown', 6, 7, wrapping)).toBe(0);
    expect(rovingTarget('ArrowUp', 1, 7, wrapping)).toBe(6); // the last row is shorter: its last card
    expect(rovingTarget('ArrowUp', 0, 7, wrapping)).toBe(6);
  });
});

describe('roving tab stop', () => {
  it('exactly one item is tabbable', () => {
    const stops = [0, 1, 2, 3].map((index) => rovingTabIndex(index, 2));
    expect(stops).toEqual([-1, -1, 0, -1]);
  });
  it('prefers the remembered item, then the preferred one, then the first', () => {
    expect(rovingStop(5, 3, 1)).toBe(3);
    expect(rovingStop(5, null, 1)).toBe(1);
    expect(rovingStop(5, null, null)).toBe(0);
  });
  it('forgets a remembered item that no longer exists (the category changed)', () => {
    expect(rovingStop(3, 7, 2)).toBe(2);
    expect(rovingStop(3, 7, null)).toBe(0);
    expect(rovingStop(0, 4, 4)).toBe(0);
  });
});

describe('columnsFromOffsets', () => {
  it('counts the items on the first row', () => {
    expect(columnsFromOffsets([10, 10, 10, 86, 86, 86, 162])).toBe(3);
    expect(columnsFromOffsets([10, 11, 10, 90])).toBe(3);
  });
  it('a single column and an empty grid are 1', () => {
    expect(columnsFromOffsets([10, 90, 170])).toBe(1);
    expect(columnsFromOffsets([])).toBe(1);
  });
  it('everything on one row', () => {
    expect(columnsFromOffsets([5, 5, 5, 5])).toBe(4);
  });
});

describe('toast live regions', () => {
  it('refusals are assertive, everything else polite', () => {
    expect(toastPoliteness('alert')).toBe('assertive');
    expect(toastPoliteness('important')).toBe('polite');
    expect(toastPoliteness('routine')).toBe('polite');
  });
  it('an alert is spoken every time, even the same text twice', () => {
    const first = planToastAnnouncement(NO_TOAST_ANNOUNCED, 'Not enough cash', 'alert', 1000);
    expect(first.say).toEqual({ text: 'Not enough cash', politeness: 'assertive' });
    const second = planToastAnnouncement(first.state, 'Not enough cash', 'alert', 1500);
    expect(second.say).toEqual({ text: 'Not enough cash', politeness: 'assertive' });
  });
  it('a routine confirmation is polite and a repeat of it is dropped', () => {
    const first = planToastAnnouncement(NO_TOAST_ANNOUNCED, 'Carousel built', 'routine', 1000);
    expect(first.say).toEqual({ text: 'Carousel built', politeness: 'polite' });
    expect(planToastAnnouncement(first.state, 'Carousel built', 'routine', 1200).say).toBeNull();
  });
  it('routine messages closer than the gap are dropped, later ones are spoken', () => {
    const first = planToastAnnouncement(NO_TOAST_ANNOUNCED, 'Path built', 'routine', 1000);
    expect(planToastAnnouncement(first.state, 'Bin built', 'routine', 1000 + ROUTINE_ANNOUNCE_GAP_MS - 1).say).toBeNull();
    expect(planToastAnnouncement(first.state, 'Bin built', 'routine', 1000 + ROUTINE_ANNOUNCE_GAP_MS).say?.text).toBe('Bin built');
  });
  it('an important message is never rate-limited by a routine one', () => {
    const first = planToastAnnouncement(NO_TOAST_ANNOUNCED, 'Path built', 'routine', 1000);
    expect(planToastAnnouncement(first.state, 'Milestone reached', 'important', 1100).say).toEqual({ text: 'Milestone reached', politeness: 'polite' });
  });
  it('an alert right after a routine message still interrupts', () => {
    const first = planToastAnnouncement(NO_TOAST_ANNOUNCED, 'Path built', 'routine', 1000);
    expect(planToastAnnouncement(first.state, 'Cannot build here', 'alert', 1050).say?.politeness).toBe('assertive');
  });
  it('a cleared toast says nothing and keeps the state', () => {
    const first = planToastAnnouncement(NO_TOAST_ANNOUNCED, 'Saved', 'important', 1000);
    const cleared = planToastAnnouncement(first.state, null, 'important', 3000);
    expect(cleared.say).toBeNull();
    expect(cleared.state).toBe(first.state);
    expect(planToastAnnouncement(first.state, '', 'important', 3000).say).toBeNull();
  });
  it('the same important text is spoken again once it is old enough to be news', () => {
    const first = planToastAnnouncement(NO_TOAST_ANNOUNCED, 'Saved', 'important', 1000);
    expect(planToastAnnouncement(first.state, 'Saved', 'important', 6000).say?.text).toBe('Saved');
  });
});

describe('Park Pulse announcements', () => {
  const lines = (...texts: string[]) => ({ lines: texts });
  it('the first reading is silent', () => {
    const plan = planPulseAnnouncement(null, lines('Light rain'), 0);
    expect(plan.say).toBeNull();
    expect(plan.state.lines).toEqual(['Light rain']);
  });
  it('a new line is spoken; an unchanged summary is not', () => {
    const start = planPulseAnnouncement(null, lines('guests want a drink'), 0).state;
    const same = planPulseAnnouncement(start, lines('guests want a drink'), 60_000);
    expect(same.say).toBeNull();
    const fresh = planPulseAnnouncement(same.state, lines('guests want a drink', 'the queue is too long'), 120_000);
    expect(fresh.say).toBe('the queue is too long');
  });
  it('a line that goes away is silent, and counts never matter (they are not in the lines)', () => {
    const start = planPulseAnnouncement(null, lines('a', 'b'), 0).state;
    expect(planPulseAnnouncement(start, lines('a'), 60_000).say).toBeNull();
  });
  it('is spaced: a change inside the window waits and is said at the next chance', () => {
    const start = planPulseAnnouncement(null, lines('a'), 0).state;
    const first = planPulseAnnouncement(start, lines('a', 'b'), 20_000);
    expect(first.say).toBe('b');
    const tooSoon = planPulseAnnouncement(first.state, lines('a', 'b', 'c'), 20_000 + PULSE_ANNOUNCE_GAP_MS - 1);
    expect(tooSoon.say).toBeNull();
    const later = planPulseAnnouncement(tooSoon.state, lines('a', 'b', 'c'), 20_000 + PULSE_ANNOUNCE_GAP_MS);
    expect(later.say).toBe('c');
  });
  it('a line that disappears and returns counts as new', () => {
    const start = planPulseAnnouncement(null, lines('a'), 0).state;
    const gone = planPulseAnnouncement(start, lines(), 30_000);
    expect(gone.say).toBeNull();
    expect(planPulseAnnouncement(gone.state, lines('a'), 60_000).say).toBe('a');
  });
  it('does not speak notifications: ManagementNotifications owns those', () => {
    const start = planPulseAnnouncement(null, lines(), 0).state;
    expect(planPulseAnnouncement(start, lines(), 60_000).say).toBeNull();
  });
  it('starts with an empty state that never blocks the first spoken change', () => {
    expect(planPulseAnnouncement(NO_PULSE_ANNOUNCED, lines('x'), 0).say).toBe('x');
  });
});

describe('management notification announcements', () => {
  const note = (id: number, severity: string, title = `T${id}`) => ({ id, severity, title, message: `M${id}` });
  it('speaks only notifications not announced before', () => {
    const first = planNotificationAnnouncements(new Set(), [note(1, 'warning')]);
    expect(first.polite).toBe('T1. M1');
    expect(first.assertive).toBeNull();
    const again = planNotificationAnnouncements(first.announced, [note(1, 'warning'), note(2, 'info')]);
    expect(again.polite).toBe('T2. M2');
  });
  it('critical notifications go to the assertive region', () => {
    const plan = planNotificationAnnouncements(new Set(), [note(1, 'critical'), note(2, 'info')]);
    expect(plan.assertive).toBe('T1. M1');
    expect(plan.polite).toBe('T2. M2');
  });
  it('a burst is summarised by the last two', () => {
    const plan = planNotificationAnnouncements(new Set(), [note(1, 'info'), note(2, 'info'), note(3, 'info')]);
    expect(plan.polite).toBe('T2. M2 T3. M3');
  });
  it('nothing new says nothing', () => {
    const plan = planNotificationAnnouncements(new Set([1]), [note(1, 'info')]);
    expect(plan.polite).toBeNull();
    expect(plan.assertive).toBeNull();
  });
});

describe('labels', () => {
  it('stepper buttons say what they do', () => {
    expect(stepperLabel('lower', 'ticket price', 0.5)).toBe('Lower ticket price by $0.50');
    expect(stepperLabel('raise', 'item price', 1)).toBe('Raise item price by $1.00');
  });
  it('an open toggle keeps the visible word in its name (WCAG 2.5.3)', () => {
    expect(openToggleLabel('Ride', true).toLowerCase()).toContain('open');
    expect(openToggleLabel('Ride', false).toLowerCase()).toContain('closed');
    expect(openToggleLabel('Stall', true)).toBe('Stall is open. Press to close it');
  });
  it('percent labels clamp and round', () => {
    expect(percentLabel('Condition', 81.6)).toBe('Condition 82 percent');
    expect(percentLabel('Condition', 140)).toBe('Condition 100 percent');
    expect(percentLabel('Condition', -3)).toBe('Condition 0 percent');
  });
  it('a button name starts with its visible text', () => {
    expect(labelWithSubject('Research', 'Faster Carousel')).toBe('Research: Faster Carousel');
    expect(labelWithSubject('Locked', 'Faster Carousel').startsWith('Locked')).toBe(true);
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
  it('is symmetric and accepts short hex', () => {
    expect(contrastRatio('#fff', '#173f3b')).toBeCloseTo(contrastRatio('#173f3b', '#ffffff'), 8);
  });
  it('is NaN for a colour it cannot read', () => {
    expect(contrastRatio('red', '#fff')).toBeNaN();
    expect(parseHex('#12')).toBeNull();
  });
});
