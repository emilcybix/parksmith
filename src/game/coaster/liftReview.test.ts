import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { centreLineFor } from './centreLine';
import { COASTER_TYPE_BY_ID } from './content';
import {
  checkCoasterDesign,
  coasterBaseCost,
  coasterSpeedProfile,
  deriveCoasterStats,
  type CoasterPiece,
} from './design';
import { analyseLiftRuns, describeCoasterLift, liftRunForTarget, liftRuns, setLiftRunChained } from './lift';
import {
  hillDipLayout,
  layoutFromMoves,
  longestLayout,
  OVAL_MOVES,
  ovalLayout,
  randomCircuit,
  withFreeLifts,
  zigzagLayout,
} from './testLayouts';

/**
 * Phase 27 step 4 adversarial gameplay/UX review of lift hills (chain or free). Tests marked
 * `it.fails` document a confirmed finding: they assert the behaviour the spec asks for and fail on
 * the current code; drop the `.fails` once the finding is fixed.
 */

const SERPENT = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
const clone = (pieces: readonly CoasterPiece[]): CoasterPiece[] => pieces.map((piece) => ({ ...piece, cell: { ...piece.cell } }));

describe('free lift is never a cycle-time trap', () => {
  it('the worst extra time a crawling segment costs over a chain is a fraction of a second', () => {
    const creepSpeed = (GAME_CONFIG.coaster.speed.maximum * GAME_CONFIG.coaster.lift.creepPermille) / 1000;
    const perSegment = 1 / creepSpeed - 1 / GAME_CONFIG.coaster.speed.lift;
    expect(perSegment).toBeLessThan(0.25);
  });

  it('over 300 random circuits, freeing every lift that the designer accepts never adds more than 15 % to the cycle', () => {
    let worst = 0;
    let checked = 0;
    for (let seed = 1; checked < 300 && seed < 5000; seed += 1) {
      const layout = randomCircuit(seed, 12 + 2 * (seed % 20), 6 + (seed % 5));
      if (!layout) continue;
      layout.forEach((piece) => { delete piece.special; });
      if (!checkCoasterDesign(layout, SERPENT).validation.ok) continue;
      const free = withFreeLifts(clone(layout));
      if (!checkCoasterDesign(free, SERPENT).validation.ok) continue;
      checked += 1;
      const before = deriveCoasterStats(layout, SERPENT).durationSeconds;
      const after = deriveCoasterStats(free, SERPENT).durationSeconds;
      worst = Math.max(worst, after / before - 1);
    }
    console.log(`LIFT-REVIEW worst free-vs-chained cycle increase ${(worst * 100).toFixed(1)} % over ${checked} circuits`);
    expect(worst).toBeLessThan(0.15);
  }, 20_000);
});

describe('free is not a strictly dominant choice (balance)', () => {
  // A free hill after a drop is quicker, cheaper to build, cheaper per cycle and more exciting than
  // the same hill chained; the chain's upside is reliability (a free run costs some).
  it('a free hill after a drop loses on at least one axis against the same hill chained', () => {
    const chained = hillDipLayout();
    const free = withFreeLifts(hillDipLayout(), [1, 2, 3]);
    const a = deriveCoasterStats(chained, SERPENT);
    const b = deriveCoasterStats(free, SERPENT);
    const freeWinsEverything = b.durationSeconds <= a.durationSeconds
      && coasterBaseCost(free, SERPENT) < coasterBaseCost(chained, SERPENT)
      && b.runningCost < a.runningCost
      && b.excitement >= a.excitement
      && b.reliability >= a.reliability
      && b.ticketPrice >= a.ticketPrice;
    expect(freeWinsEverything).toBe(false);
  });
});

describe('the stall refusal cannot be dodged by splitting a hill with flat pieces', () => {
  // Station, then a 4-level stairway 0-1-1-2-2-3-3-4-4 (each step its own "lift" because the flat
  // piece between steps ends the run), then down. Same climb as the refused tall layout.
  const STAIR_HEIGHTS = [0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const stairway = (): CoasterPiece[] => layoutFromMoves({ x: 4, y: 4 }, OVAL_MOVES, STAIR_HEIGHTS);
  const TALL = [0, 0, 0, 1, 2, 3, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  it('the unsplit 4-level free climb is refused', () => {
    const tall = withFreeLifts(layoutFromMoves({ x: 4, y: 4 }, OVAL_MOVES, TALL));
    expect(checkCoasterDesign(tall, SERPENT).validation).toMatchObject({ ok: false, reason: 'free-climb-stalls' });
  });

  it('the same climb split by flats (four 1-piece lifts) crawls on more segments yet is still refused', () => {
    const free = withFreeLifts(stairway());
    expect(liftRuns(free).length).toBe(4);
    const runs = analyseLiftRuns(free);
    const crawling = runs.reduce((total, run) => total + run.creepSegments, 0);
    console.log(`LIFT-REVIEW stairway: ${runs.length} runs, ${crawling} creep segments, verdicts ${runs.map((run) => run.verdict).join(',')}`);
    expect(crawling).toBeGreaterThan(GAME_CONFIG.coaster.lift.maxCreepSegments);
    expect(checkCoasterDesign(free, SERPENT).validation.ok).toBe(false);
  });
});

describe('inspector strip legibility vs the validity rule', () => {
  it.fails('the strip marks as many crawling segments as the designer counted', () => {
    const layout = withFreeLifts(layoutFromMoves({ x: 4, y: 4 }, OVAL_MOVES, [0, 0, 0, 1, 2, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const check = checkCoasterDesign(layout, SERPENT);
    expect(check.validation.ok).toBe(true);
    const counted = check.runs.reduce((total, run) => total + run.creepSegments, 0);
    expect(counted).toBeGreaterThan(0);
    const view = describeCoasterLift(layout, coasterSpeedProfile(layout).travelSeconds, SERPENT, 1);
    const shown = view.kinds.filter((kind) => kind === 'creep').length;
    expect(shown).toBe(counted);
  });

  it('the strip speeds equal the speeds the train runs at (length / saved travel time, every segment)', () => {
    for (const layout of [withFreeLifts(hillDipLayout()), withFreeLifts(longestLayout(), [0, 2, 4]), ovalLayout()]) {
      const profile = coasterSpeedProfile(layout);
      const view = describeCoasterLift(layout, profile.travelSeconds, SERPENT, 1);
      view.speeds.forEach((speed, index) => {
        expect(view.lengths[index] / speed).toBeCloseTo(profile.travelSeconds[index], 9);
      });
      const total = view.lengths.reduce((sum, length, index) => sum + length / view.speeds[index], 0);
      expect(total).toBeCloseTo(profile.totalTravelSeconds, 9);
    }
  });
});

describe('toggle targeting', () => {
  it('a hill split by a flat piece is two lifts (zig-zag: every step is its own lift)', () => {
    expect(liftRuns(zigzagLayout()).length).toBe(3);
  });

  it.fails('L with the cursor on a piece that is on no lift does not flip some other lift', () => {
    const layout = hillDipLayout();
    // Piece 25 is on the flat return straight: no lift covers it.
    expect(liftRuns(layout).some((run) => ((25 - run.start + layout.length) % layout.length) <= run.length)).toBe(false);
    expect(liftRunForTarget(layout, 25)).toBeNull();
  });
});

describe('draft chain strip after an in-place toggle', () => {
  // GameApp flips lifts by mutating the draft array in place (setLiftRunChained); a CLOSED draft is
  // drawn from that same array in both renderers (WorldRenderer.drawCoasterTrack `closed ? pieces`,
  // voxel coasterDraft `ringPieces = layout`), so centreLineFor's per-array cache signature must
  // include freeClimb.
  it('centreLineFor sees a lift toggled in place on the same array', () => {
    const draft = hillDipLayout();
    const before = Array.from(centreLineFor(draft).chained);
    const run = liftRuns(draft)[0];
    expect(before[run.start]).toBe(1);
    setLiftRunChained(draft, run.start, false);
    expect(centreLineFor(draft).chained[run.start]).toBe(0);
  });
});

describe('inspector chain cost line vs the ledger', () => {
  it('the chain build share follows the construction multiplier the ledger paid with', () => {
    const layout = hillDipLayout();
    const constructionCostMultiplier = 0.8;
    const paidWithChain = Math.round(coasterBaseCost(layout, SERPENT) * constructionCostMultiplier);
    const paidWithout = Math.round(coasterBaseCost(withFreeLifts(clone(layout)), SERPENT) * constructionCostMultiplier);
    const view = describeCoasterLift(layout, coasterSpeedProfile(layout).travelSeconds, SERPENT, {
      chainLiftCostMultiplier: 1, constructionCostMultiplier, rideOperatingCostMultiplier: 1.3,
    });
    // The line says "$X of the build"; the ledger difference is what the chain actually cost.
    expect(view.chainBuildCost).toBe(paidWithChain - paidWithout);
    expect(view.chainBuildCost).toBe(256);
  });

  it('the per-cycle chain figure is the difference in what RideSimulation posts per dispatch', () => {
    const layout = hillDipLayout();
    const posted = (pieces: readonly CoasterPiece[]): number =>
      Math.round(deriveCoasterStats(pieces, SERPENT).runningCost * 1.3 * 100) / 100;
    const view = describeCoasterLift(layout, coasterSpeedProfile(layout).travelSeconds, SERPENT, {
      constructionCostMultiplier: 0.8, rideOperatingCostMultiplier: 1.3,
    });
    expect(view.chainRunningCost).toBeCloseTo(posted(layout) - posted(withFreeLifts(clone(layout))), 9);
    expect(view.chainRunningCost).toBeGreaterThan(8 * GAME_CONFIG.coaster.lift.chainRunningCostPerPiece);
  });
});
