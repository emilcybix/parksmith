import { describe, expect, it } from 'vitest';
import type { GuestCapacityView } from '../game/guests/GuestSimulation';
import { CAPACITY_INSIGHT, capacityToast, describeCapacity } from './capacityModel';

const view = (patch: Partial<GuestCapacityView> = {}): GuestCapacityView => ({
  ceiling: 52, rideSeats: 38, rating: 61, crowdMultiplier: 1, hardMaximum: 1000, blocked: null, ...patch,
});

const NORMAL = 'Open rides seat 38 guests at a time and the park rating is 61. More ride seats or a higher rating raise the ceiling.';

describe('describeCapacity (Phase 11, PA-009)', () => {
  it('reads the ceiling in the Pulse label, the KPI and the section', () => {
    expect(describeCapacity(view(), 41, false)).toEqual({
      pulseLabel: 'of 52 guests',
      atCapacityTone: false,
      insight: null,
      kpiOf: 'of 52',
      ratio: '41/52',
      text: NORMAL,
    });
  });

  it('rounds the rating and says one ride seat in the singular', () => {
    expect(describeCapacity(view({ rating: 60.6 }), 0, false).text).toContain('the park rating is 61.');
    expect(describeCapacity(view({ rideSeats: 1 }), 0, false).text).toContain('Open rides seat 1 guest at a time');
  });

  it('appends the card multiplier, the hard maximum and the full park, in that order', () => {
    expect(describeCapacity(view({ crowdMultiplier: 1.5 }), 41, false).text).toBe(`${NORMAL} Active cards scale it ×1.5.`);
    expect(describeCapacity(view({ crowdMultiplier: 0.7 }), 41, false).text).toBe(`${NORMAL} Active cards scale it ×0.7.`);
    expect(describeCapacity(view({ ceiling: 1000 }), 41, false).text).toBe(`${NORMAL} This is the most guests a park can hold.`);
    expect(describeCapacity(view({ ceiling: 1000, crowdMultiplier: 1.3 }), 1000, true)).toEqual({
      pulseLabel: 'of 1000 guests',
      atCapacityTone: true,
      insight: 'At capacity: more ride seats or a higher rating let more guests in.',
      kpiOf: 'of 1000',
      ratio: '1000/1000',
      text: `${NORMAL} Active cards scale it ×1.3. This is the most guests a park can hold. The park is full: no new guests arrive until someone leaves.`,
    });
  });

  it('reads the ceiling as a maximum while more guests are inside than it allows', () => {
    const over = describeCapacity(view({ ceiling: 491 }), 1000, true);
    expect(over.pulseLabel).toBe('max 491 guests');
    expect(over.kpiOf).toBe('max 491');
    expect(over.ratio).toBe('1000/491');
    expect(over.atCapacityTone).toBe(true);
    // At the ceiling exactly it is still a share.
    expect(describeCapacity(view(), 52, true).pulseLabel).toBe('of 52 guests');
    expect(describeCapacity(view(), 53, false).pulseLabel).toBe('max 52 guests');
  });

  it('tones and announces only while at capacity', () => {
    const full = describeCapacity(view(), 52, true);
    expect(full.atCapacityTone).toBe(true);
    expect(full.insight).toBe(CAPACITY_INSIGHT);
    expect(full.text).toBe(`${NORMAL} The park is full: no new guests arrive until someone leaves.`);
  });

  it('explains each blocked state and falls back to the plain guests label', () => {
    const cases = {
      'park-closed': 'The park is closed, so no new guests arrive.',
      'after-hours': 'Outside opening hours, so no new guests arrive.',
      'too-few-paths': 'Guests arrive once the park has at least 3 path tiles.',
      'no-open-ride': 'No open ride can be reached from the gate, so no guests arrive.',
    } as const;
    for (const [blocked, text] of Object.entries(cases)) {
      expect(describeCapacity(view({ ceiling: 0, blocked: blocked as keyof typeof cases }), 41, true)).toEqual({
        pulseLabel: 'guests', atCapacityTone: false, insight: null, kpiOf: null, ratio: '41/0', text,
      });
    }
  });

  it('shows the plain label before any view is published', () => {
    expect(describeCapacity(null, 12, true)).toEqual({
      pulseLabel: 'guests', atCapacityTone: false, insight: null, kpiOf: null, ratio: null, text: null,
    });
  });

  it('words the toast', () => {
    expect(capacityToast(52)).toBe('Park at capacity (52 guests). More ride seats or a higher rating let more guests in.');
  });
});
