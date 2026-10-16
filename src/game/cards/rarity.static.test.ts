import { describe, expect, it } from 'vitest';

/**
 * Phase 25 (design 1.4, D9): rarity is frequency and slot cost, nothing else. A static guard in the pattern of
 * scenarios/noRequirement.test.ts: a card's `rarity` and `tags` are read only under src/game/cards, src/game/run and
 * src/ui (and the config table that defines the tiers); its slot cost also where loadouts are sized (the session's card
 * slice and restore check, reward eligibility, the app). No simulation owner ever sees them. Scans src/game and src/app
 * (the UI is a reader by design).
 */
const raw = import.meta.glob<string>(['../**/*.ts', '../../app/**/*.ts', '!../**/*.test.ts', '!../../app/**/*.test.ts'], { query: '?raw', import: 'default', eager: true });
/** Vite keys files relative to this directory ('./x.ts', '../run/x.ts', '../../app/x.ts'): normalise to a path under src/. */
const underSrc = (key: string): string => {
  const parts = ['game', 'cards'];
  for (const part of key.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
};
const sources: Record<string, string> = Object.fromEntries(Object.entries(raw).map(([path, text]) => [underSrc(path), text]));

const RARITY_OR_TAGS = /\brarity\b|\brarityOf\b|\bCardRarity\b|\bCardTag\b|\bcard\.tags\b|\bCARD_RARITIES\b/;
const SLOT_COST = /\bslotCost\b|\bslotCostOf\b|\bslotCostTotal\b/;
const READERS = ['game/cards/', 'game/run/', 'ui/'];
const CONFIG = ['game/config.ts'];
const SLOT_COST_READERS = [...READERS, ...CONFIG, 'game/session/ParkSession.ts', 'game/profile/eligibility.ts', 'app/'];

describe('static guard: rarity, tags and slot cost stay out of the simulation', () => {
  it('the scan sees the whole source tree', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(150);
    expect(sources['game/cards/table.ts']).toMatch(RARITY_OR_TAGS);
    expect(sources['game/session/ParkSession.ts']).toBeDefined();
  });

  it('rarity and tags are read only under src/game/cards, src/game/run, src/ui and the config table', () => {
    const offenders = Object.entries(sources)
      .filter(([path, text]) => RARITY_OR_TAGS.test(text) && ![...READERS, ...CONFIG].some((prefix) => path.startsWith(prefix)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('slot cost is read only where loadouts are sized', () => {
    const offenders = Object.entries(sources)
      .filter(([path, text]) => SLOT_COST.test(text) && !SLOT_COST_READERS.some((prefix) => path.startsWith(prefix)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
