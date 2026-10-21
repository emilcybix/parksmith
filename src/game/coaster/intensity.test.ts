import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { nauseaGain } from '../guests/life';
import { centreLineFor } from './centreLine';
import { COASTER_TYPE_BY_ID } from './content';
import { checkCoasterDesign, coasterSpeedProfile, deriveCoasterStats, deriveCoasterStatsWithParts, validateCoasterLayout } from './design';
import { INTENSITY_FIXTURES, type IntensityGroup } from './intensityFixtures';
import { OVAL_MOVES, ZIGZAG_MOVES, layoutFromMoves, zigzagLayout } from './testLayouts';

/** Phase 58: gentler coasters possible (a 2-level drop and an S-bend count for less; a circuit may stay at height 1). */
const COMET = COASTER_TYPE_BY_ID.get('comet-trail')!;
const MOUSE = COASTER_TYPE_BY_ID.get('whisker-mouse')!;
const NAUSEA = GAME_CONFIG.guestLife.nausea;

const fixture = (name: string) => INTENSITY_FIXTURES.find((entry) => entry.name.startsWith(name))!;
const statsOf = (entry: (typeof INTENSITY_FIXTURES)[number]) => deriveCoasterStats(entry.pieces(), COASTER_TYPE_BY_ID.get(entry.typeId)!);
const intensities = (group: IntensityGroup): number[] => INTENSITY_FIXTURES.filter((entry) => entry.group === group).map((entry) => statsOf(entry).intensity);

/** A guest's nausea after two rides back to back (the stomach settles for the ride's duration between them). */
const twoRides = (intensity: number, durationSeconds: number, preferred: number, hunger: number): number => {
  const gain = nauseaGain(intensity, preferred, hunger);
  return Math.max(0, gain - NAUSEA.decayPerSecond * durationSeconds) + gain;
};

describe('Phase 58: coaster intensity', () => {
  it.each(INTENSITY_FIXTURES.map((entry) => [entry.name, entry] as const))('%s lands in its band and builds', (_name, entry) => {
    const type = COASTER_TYPE_BY_ID.get(entry.typeId)!;
    const pieces = entry.pieces();
    expect(validateCoasterLayout(pieces, type)).toEqual({ ok: true });
    const { stats, parts } = deriveCoasterStatsWithParts(pieces, type);
    expect(stats.intensity).toBeGreaterThanOrEqual(entry.band[0]);
    expect(stats.intensity).toBeLessThanOrEqual(entry.band[1]);
    const sum = Object.values(parts).reduce((total, part) => total + part, 0);
    expect(stats.intensity).toBeCloseTo(Math.min(100, sum), 1);
  });

  it('family coasters stay under the nausea floor, the owner\'s layout sits between them and the thrill rides on top', () => {
    const family = intensities('family');
    const owner = intensities('owner');
    const thrill = intensities('thrill');
    expect(Math.max(...family)).toBeLessThanOrEqual(NAUSEA.minimumIntensity);
    expect(Math.min(...owner)).toBeGreaterThan(Math.max(...family));
    expect(Math.min(...thrill)).toBeGreaterThan(Math.max(...owner));
  });

  it('a gentle coaster unsettles no one; the owner\'s layout makes the gentlest queasy only twice on a full stomach', () => {
    for (const entry of INTENSITY_FIXTURES.filter((candidate) => candidate.group === 'family')) {
      const stats = statsOf(entry);
      for (const preferred of [12, 24, 50, 78]) {
        expect(twoRides(stats.intensity, stats.durationSeconds, preferred, NAUSEA.fullStomachHunger - 1), entry.name).toBe(0);
      }
    }
    const owner = statsOf(fixture("owner's layout"));
    // The gentlest guests (preferred intensity 12) feel it most: queasy only twice on a full stomach, never sick.
    expect(twoRides(owner.intensity, owner.durationSeconds, 12, 50)).toBeLessThan(NAUSEA.queasy);
    expect(twoRides(owner.intensity, owner.durationSeconds, 12, NAUSEA.fullStomachHunger - 1)).toBeLessThan(NAUSEA.vomit);
    // A thrill ride still makes a gentle guest sick when ridden twice on a full stomach.
    const tall = statsOf(fixture('tall'));
    expect(twoRides(tall.intensity, tall.durationSeconds, 24, NAUSEA.fullStomachHunger - 1)).toBeGreaterThanOrEqual(NAUSEA.vomit);
  });

  it('an S-bend counts half a steep turn pair, a hairpin a whole one; the wild mouse keeps its tight turns', () => {
    const steel = deriveCoasterStatsWithParts(zigzagLayout(), COMET).parts.steepTurns;
    const mouseOnFlat = layoutFromMoves({ x: 4, y: 4 }, ZIGZAG_MOVES, []);
    const mouse = deriveCoasterStatsWithParts(mouseOnFlat, MOUSE).parts.steepTurns;
    const steelOnFlat = deriveCoasterStatsWithParts(mouseOnFlat, COMET).parts.steepTurns;
    const family = GAME_CONFIG.coaster.families;
    expect(steelOnFlat).toBeCloseTo(steel, 5);
    // The same pairs, but the steel coaster counts its S-bends half.
    const mousePairs = mouse / family['wild-mouse'].steepTurns;
    const steelPairs = steelOnFlat / family.steel.steepTurns;
    expect(steelPairs).toBeLessThan(mousePairs);
    expect(steelPairs).toBeGreaterThanOrEqual(mousePairs * family.steel.sBendShare);
    // A hairpin: two turns the same way, one piece apart (a U-turn), is a whole pair. This one-wide ring has two, but
    // the pair across the station (the last piece and the first) is not counted, as before.
    const hairpin = layoutFromMoves({ x: 4, y: 4 }, `${'E'.repeat(6)}SW${'W'.repeat(5)}N`, [0, 0, 0, 1, 1, 0]);
    expect(validateCoasterLayout(hairpin, COMET)).toEqual({ ok: true });
    expect(deriveCoasterStatsWithParts(hairpin, COMET).parts.steepTurns).toBeCloseTo(family.steel.steepTurns, 5);
  });

  it('a circuit that only climbs to height 1 validates, runs a whole lap and is the gentlest a type can give', () => {
    const kiddie = fixture('kiddie oval').pieces();
    expect(Math.max(...kiddie.map((piece) => piece.height))).toBe(1);
    expect(checkCoasterDesign(kiddie, COMET).validation).toEqual({ ok: true });
    const profile = coasterSpeedProfile(kiddie);
    expect(profile.travelSeconds).toHaveLength(kiddie.length);
    expect(profile.travelSeconds.every((seconds) => Number.isFinite(seconds) && seconds > 0)).toBe(true);
    expect(profile.topSpeed).toBeGreaterThanOrEqual(GAME_CONFIG.coaster.speed.cruise);
    expect(centreLineFor(kiddie).pieceCount).toBe(kiddie.length);
    const gentlest = statsOf(fixture('kiddie oval')).intensity;
    for (const entry of INTENSITY_FIXTURES) if (entry.typeId === 'comet-trail') expect(statsOf(entry).intensity).toBeGreaterThanOrEqual(gentlest);
  });

  it('a flat circuit (no hill at all) is still refused, and a shuttle still needs a climb of 2', () => {
    const flat = layoutFromMoves({ x: 4, y: 4 }, OVAL_MOVES, []);
    expect(validateCoasterLayout(flat, COMET)).toMatchObject({ ok: false, reason: 'no-drop' });
    const shuttle = COASTER_TYPE_BY_ID.get('thunder-launch')!;
    const low = Array.from({ length: GAME_CONFIG.coaster.shuttle.minimumPieces }, (_unused, index) => ({
      cell: { x: 2 + index, y: 4 }, height: index >= 4 ? 1 : 0,
    }));
    expect(validateCoasterLayout(low, shuttle)).toMatchObject({ ok: false });
  });
});
