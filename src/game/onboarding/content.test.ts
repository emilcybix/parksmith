import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_TARGET,
  ONBOARDING_STEPS,
  PATH_TILE_TARGET,
  PROFIT_TARGET,
  RATING_MIN_ARRIVALS,
  RATING_TARGET,
} from './content';

describe('First Day step texts', () => {
  it.each(ONBOARDING_STEPS.map((step) => [step.id, step] as const))('%s fits the Park Pulse card', (_id, step) => {
    expect(step.title.length).toBeLessThanOrEqual(32);
    expect(step.hint.length).toBeGreaterThan(5);
    expect(step.hint.length).toBeLessThanOrEqual(90);
  });

  it('names stalls that really count, and says closed rides and parks add no riders', async () => {
    const hint = (id: string): string => ONBOARDING_STEPS.find((step) => step.id === id)?.hint ?? '';
    const { BUILD_BY_ID } = await import('../content/catalog');
    const serviceOf = (name: string): string | undefined => {
      const entry = [...BUILD_BY_ID.values()].find((definition) => definition.name === name);
      return entry?.stats?.serviceType;
    };
    for (const name of ['Picnic Pocket', 'Glacier Scoop']) {
      expect(hint('first-food')).toContain(name);
      expect(serviceOf(name)).toBe('food');
    }
    for (const name of ['Fizz Foundry', 'Lemon Light']) {
      expect(hint('first-drink')).toContain(name);
      expect(serviceOf(name)).toBe('drink');
    }
    expect(hint('first-rider')).toMatch(/open/);
    expect(hint('guest-target')).toMatch(/open/);
    expect(hint('set-price')).toContain('Ticket price');
  });

  it('quotes the engine targets, so a retune cannot make a hint lie', () => {
    const hint = (id: string): string => ONBOARDING_STEPS.find((step) => step.id === id)?.hint ?? '';
    expect(hint('lay-path')).toContain(String(PATH_TILE_TARGET));
    expect(hint('guest-target')).toContain(String(ARRIVAL_TARGET));
    expect(hint('first-profit')).toContain(String(PROFIT_TARGET));
    expect(hint('good-rating')).toContain(String(RATING_TARGET));
    expect(hint('good-rating')).toContain(String(RATING_MIN_ARRIVALS));
  });
});
