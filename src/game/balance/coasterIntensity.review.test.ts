import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { COASTER_TYPE_BY_ID } from '../coaster/content';
import { deriveCoasterStatsWithParts, validateCoasterLayout } from '../coaster/design';
import { INTENSITY_FIXTURES } from '../coaster/intensityFixtures';
import { nauseaGain } from '../guests/life';

/**
 * Phase 58 measurement: every intensity fixture's excitement, intensity, the part each term adds, and what a rider's
 * stomach does on it: one ride, two rides back to back (the nausea decays for the ride's duration between them), and
 * the two on a full stomach, for a gentle, a family and a thrill guest (preferred intensity 24, 50 and 78: the middle
 * of the three bands `rollPreferredIntensity` draws). Q marks queasy (a stop), V sick. Off by default;
 * `COASTER_INTENSITY_REPORT=1 yarn vitest run src/game/balance/coasterIntensity.review.test.ts` prints the tables
 * recorded in BALANCE_NOTES.md ("Phase 58: coaster intensity").
 */
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const enabled = env.COASTER_INTENSITY_REPORT === '1';

const NAUSEA = GAME_CONFIG.guestLife.nausea;
const GUESTS = [['gentle', 24], ['family', 50], ['thrill', 78]] as const;
const HUNGRY = 50;
const FULL = NAUSEA.fullStomachHunger - 1;

const mark = (nausea: number): string => {
  const shown = Math.round(nausea);
  return nausea >= NAUSEA.vomit ? `**${shown} V**` : nausea >= NAUSEA.queasy ? `${shown} Q` : `${shown}`;
};

/** One ride, two back to back, and two on a full stomach. */
export const stomach = (intensity: number, durationSeconds: number, preferred: number): string => {
  const twice = (hunger: number): number => {
    const gain = nauseaGain(intensity, preferred, hunger);
    return Math.min(100, Math.max(0, gain - NAUSEA.decayPerSecond * durationSeconds) + gain);
  };
  return `${mark(Math.min(100, nauseaGain(intensity, preferred, HUNGRY)))} / ${mark(twice(HUNGRY))} / ${mark(twice(FULL))}`;
};

describe.skipIf(!enabled)('Phase 58: coaster intensity', () => {
  it('prints every fixture: stats, intensity parts and nausea', () => {
    const one = (value: number): string => (Math.round(value * 10) / 10).toString();
    const statRows: string[] = [];
    const stomachRows: string[] = [];
    for (const fixture of INTENSITY_FIXTURES) {
      const type = COASTER_TYPE_BY_ID.get(fixture.typeId)!;
      const pieces = fixture.pieces();
      const { stats, parts } = deriveCoasterStatsWithParts(pieces, type);
      const valid = validateCoasterLayout(pieces, type);
      const name = `${fixture.name}${valid.ok ? '' : ` (refused: ${valid.reason})`}`;
      statRows.push(`| ${name} | ${fixture.typeId} | ${stats.excitement} | **${stats.intensity}** | ${one(parts.base)} | ${one(parts.biggestDrop)} | ${one(parts.descent)} | ${one(parts.steepTurns)} | ${one(parts.speed)} | ${one(parts.specials + parts.elements + parts.freeRuns)} |`);
      stomachRows.push(`| ${fixture.name} | ${stats.intensity} | ${stats.durationSeconds} | ${GUESTS.map(([, preferred]) => stomach(stats.intensity, stats.durationSeconds, preferred)).join(' | ')} |`);
    }
    const statHeader = '| layout | type | excitement | intensity | base | biggest drop | descent | steep turns | speed | specials, elements, free runs |';
    const stomachHeader = `| layout | intensity | ride (s) | ${GUESTS.map(([name, preferred]) => `${name} (${preferred})`).join(' | ')} |`;
    console.log([
      statHeader, statHeader.replace(/[^|]/g, '-'), ...statRows, '',
      'Nausea: one ride / two back to back / two on a full stomach.', '',
      stomachHeader, stomachHeader.replace(/[^|]/g, '-'), ...stomachRows,
    ].join('\n'));
    expect(statRows).toHaveLength(INTENSITY_FIXTURES.length);
  });
});
