import { describe, expect, it } from 'vitest';
import { CHANGELOG, GAME_VERSION, latestChangelogEntry } from './aboutModel';

/** Phase 35: the 0.3.2 entry (Phases 34 and 35) leads the changelog and matches package.json. */
describe('the changelog', () => {
  it('leads with 0.3.2, the version package.json carries, newest first', () => {
    expect(GAME_VERSION).toBe('0.3.2');
    expect(latestChangelogEntry()).toBe(CHANGELOG[0]);
    expect(CHANGELOG[0].version).toBe(GAME_VERSION);
    expect(CHANGELOG.map((entry) => entry.version)).toEqual(['0.3.2', '0.3.1', '0.3.0', '0.2.0', '0.1.0']);
  });

  it('0.3.2 names what Phases 34 and 35 shipped', () => {
    const text = CHANGELOG[0].changes.join('\n');
    for (const expected of ['faster first load', 'background', 'mute key (M)', 'crowd heatmap key (T)', 'more cards below']) {
      expect(text).toContain(expected);
    }
    expect(CHANGELOG[0].changes.length).toBeLessThanOrEqual(8);
  });

  it('0.3.1 names what Phases 31 to 33 shipped', () => {
    const text = CHANGELOG[1].changes.join('\n');
    for (const expected of ['Two autosave generations', 'Locked build cards', 'Shops', 'Overview', 'weather', 'top bar', 're-measured']) {
      expect(text).toContain(expected);
    }
    expect(CHANGELOG[1].changes.length).toBeLessThanOrEqual(8);
  });

  it('0.3.0 names what Phases 26 to 30 shipped and reassures about older saves', () => {
    const text = CHANGELOG[2].changes.join('\n');
    for (const expected of ['guest inspector', 'Complaint links', 'map view', 'coasters', 'paint', 'Build filters', 'souvenir', 'Older saves still load.']) {
      expect(text).toContain(expected);
    }
    expect(CHANGELOG[2].changes.length).toBeLessThanOrEqual(8);
    for (const entry of CHANGELOG) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.date).toMatch(/^\d{4}-\d{2}$/);
    }
  });
});
