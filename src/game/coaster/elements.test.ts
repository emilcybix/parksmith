import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { GameWorld } from '../World';
import { centreLineFor, centreLineRollAt, createCentreLineFrame, sampleCentreLineFrame } from './centreLine';
import { COASTER_TYPE_BY_ID, coasterSpecialSpan, isCoasterElement } from './content';
import { checkCoasterDesign, coasterBaseCost, coasterHelixRuns, deriveCoasterStats, isExclusiveCoasterPiece, validateCoasterLayout } from './design';
import { shuttleProfile } from './shuttle';
import { layoutFromMoves } from './testLayouts';

/** Phase 46: the coaster elements. */
const TITAN = COASTER_TYPE_BY_ID.get('titan-hyper')!;
const OVAL_MOVES = `${'E'.repeat(10)}${'S'.repeat(4)}${'W'.repeat(10)}${'N'.repeat(4)}`;
const OVAL_HEIGHTS = [0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 2, 1, 0];
type Specials = Parameters<typeof layoutFromMoves>[3];
const oval = (specials: Record<number, string> = {}) => layoutFromMoves({ x: 2, y: 2 }, OVAL_MOVES, OVAL_HEIGHTS, specials as Specials);
/** A 7 x 2 loop: pieces 6 and 7 are the U-turn at its east end. */
const uTurn = (specials: Record<number, string> = {}) =>
  layoutFromMoves({ x: 2, y: 2 }, 'EEEEEESWWWWWWN', [0, 0, 0, 1, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0], specials as Specials);

describe('Phase 46: element rules', () => {
  it('names four elements, two of them two pieces long', () => {
    expect(['airtime-hill', 'corkscrew', 'zero-g-roll', 'cobra-roll'].every((kind) => isCoasterElement(kind as never))).toBe(true);
    expect(isCoasterElement('loop')).toBe(false);
    expect(coasterSpecialSpan('corkscrew')).toBe(2);
    expect(coasterSpecialSpan('airtime-hill')).toBe(1);
    expect(TITAN.allowedSpecials).toEqual(expect.arrayContaining(['airtime-hill', 'corkscrew', 'zero-g-roll', 'cobra-roll']));
  });

  it('places elements where they fit', () => {
    for (const kind of ['airtime-hill', 'corkscrew', 'zero-g-roll']) {
      expect(validateCoasterLayout(oval({ 5: kind }), TITAN), kind).toEqual({ ok: true });
    }
    expect(validateCoasterLayout(uTurn({ 6: 'cobra-roll' }), TITAN)).toEqual({ ok: true });
    // A roll's second piece must be straight too: piece 9 is the last straight before the corner.
    expect(validateCoasterLayout(oval({ 9: 'corkscrew' }), TITAN)).toMatchObject({ ok: false, reason: 'special-not-straight', pieceIndex: 10 });
    expect(validateCoasterLayout(oval({ 5: 'cobra-roll' }), TITAN)).toMatchObject({ ok: false, reason: 'cobra-needs-u-turn' });
    expect(validateCoasterLayout(oval({ 5: 'corkscrew' }), COASTER_TYPE_BY_ID.get('star-chaser')!)).toMatchObject({ ok: false, reason: 'special-not-allowed' });
    // The piece after a roll is the roll's: the next special waits a plain piece after it.
    expect(validateCoasterLayout(oval({ 4: 'corkscrew', 6: 'airtime-hill' }), TITAN)).toMatchObject({ ok: false, reason: 'specials-too-close' });
    expect(validateCoasterLayout(oval({ 3: 'corkscrew', 6: 'airtime-hill' }), TITAN)).toEqual({ ok: true });
    const pieces = oval({ 5: 'corkscrew' });
    expect(isExclusiveCoasterPiece(pieces, 6), 'the roll keeps its second cell to itself').toBe(true);
  });

  it('elements cost, slow the train a little and add excitement and intensity', () => {
    const plain = oval();
    for (const kind of ['airtime-hill', 'corkscrew', 'zero-g-roll'] as const) {
      const with_ = oval({ 5: kind });
      const stats = deriveCoasterStats(with_, TITAN);
      const base = deriveCoasterStats(plain, TITAN);
      expect(stats.excitement, kind).toBeGreaterThan(base.excitement);
      expect(stats.intensity, kind).toBeGreaterThan(base.intensity);
      expect(coasterBaseCost(with_, TITAN) - coasterBaseCost(plain, TITAN), kind).toBe(GAME_CONFIG.coaster.specials[kind].cost);
    }
    expect(checkCoasterDesign(oval({ 5: 'corkscrew' }), TITAN).validation).toEqual({ ok: true });
  });

  it('a shuttle rides an element out and back, and needs the speed for an inversion', () => {
    const launch = COASTER_TYPE_BY_ID.get('thunder-launch')!;
    const pieces = layoutFromMoves({ x: 2, y: 2 }, 'E'.repeat(14), [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7], {});
    pieces[0].launchSpeed = 9;
    pieces[4].special = 'corkscrew';
    expect(validateCoasterLayout(pieces, launch)).toEqual({ ok: true });
    expect(shuttleProfile(pieces).outcome).toBe('ok');
    const slow = layoutFromMoves({ x: 2, y: 2 }, 'E'.repeat(14), [0, 0, 0, 0, 1, 2, 2, 2, 2, 3, 4, 5, 6, 7], {});
    slow[0].launchSpeed = 6;
    slow[6].special = 'corkscrew';
    expect(shuttleProfile(slow).outcome).toBe('loop-slow');
  });
});

describe('Phase 46: element shapes on the centre line', () => {
  const frame = createCentreLineFrame();
  it('a corkscrew rolls a full turn, upside down halfway, swinging round its heartline', () => {
    const pieces = oval({ 5: 'corkscrew' });
    const line = centreLineFor(pieces);
    const start = line.tileStart[5];
    const middle = line.tileStart[6];
    sampleCentreLineFrame(line, middle, frame);
    expect(Math.abs(frame.roll)).toBeCloseTo(Math.PI, 5);
    expect(frame.upZ, 'inverted').toBeLessThan(-0.9);
    // The track has swung up by twice the heartline (11 voxels each way) at the top of the roll.
    expect(frame.z - 3).toBeGreaterThan(1.5);
    sampleCentreLineFrame(line, start, frame);
    expect(frame.z, 'the element starts on the plain line').toBeCloseTo(sampleCentreLineFrame(centreLineFor(oval()), start, createCentreLineFrame()).z, 5);
    expect(centreLineRollAt(line, line.tileStart[7])).toBe(0);
    // Continuous: no jump in position across the element.
    let previous = sampleCentreLineFrame(line, start - 0.05, createCentreLineFrame());
    for (let arc = start; arc <= line.tileStart[7] + 0.05; arc += 0.01) {
      const sample = sampleCentreLineFrame(line, arc, createCentreLineFrame());
      const jump = Math.hypot(sample.x - previous.x, sample.y - previous.y, (sample.z - previous.z) * 13 / 32);
      // The track swings round its heartline, so it travels a little further than the arc between samples.
      expect(jump).toBeLessThan(0.1);
      previous = sample;
    }
  });

  it('an airtime hill humps the track without a roll; a cobra rolls over its U-turn', () => {
    const hill = centreLineFor(oval({ 5: 'airtime-hill' }));
    sampleCentreLineFrame(hill, hill.tileStart[5] + 0.5, frame);
    expect(frame.z).toBeCloseTo(3.8, 5);
    expect(frame.roll).toBe(0);
    const cobra = centreLineFor(uTurn({ 6: 'cobra-roll' }));
    sampleCentreLineFrame(cobra, cobra.tileStart[7], frame);
    expect(frame.upZ).toBeLessThan(-0.9);
    expect(frame.z).toBeGreaterThan(2 + 2);
  });
});

describe('Phase 46: helices', () => {
  /** Out of the station, round a 2 x 2 block climbing a level a piece, back out over the entry (the designer's helix). */
  const helixLayout = () => {
    const moves = 'EEEE' + 'ESWN' + 'E' + 'EEESSWWWWWWWWWNNN';
    const heights = [0, 0, 0, 0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return layoutFromMoves({ x: 4, y: 4 }, moves, heights);
  };
  it('four turns the same way that climb are a helix: they score and bank steeper', () => {
    const pieces = helixLayout();
    const runs = coasterHelixRuns(pieces, true);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(validateCoasterLayout(pieces, TITAN)).toEqual({ ok: true });
    const line = centreLineFor(pieces);
    const [first] = runs[0];
    expect(line.helix[first]).toBe(1);
  });

  it('builds, saves and loads a coaster with every element', () => {
    const world = new GameWorld(200_000);
    world.setBuildAccessPolicy(null);
    const pieces = oval({ 3: 'corkscrew', 6: 'airtime-hill', 15: 'zero-g-roll' });
    expect(validateCoasterLayout(pieces, TITAN)).toEqual({ ok: true });
    const placed = world.placeCoaster('titan-hyper', pieces, deriveCoasterStats(pieces, TITAN), coasterBaseCost(pieces, TITAN));
    expect('error' in placed).toBe(false);
    const state = world.serialize();
    const restored = new GameWorld();
    restored.restore(structuredClone(state));
    expect(restored.serialize()).toEqual(state);
  });
});
