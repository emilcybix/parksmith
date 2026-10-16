import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { hashState } from '../save/hash';
import { SaveError } from '../save/version';
import { scaledResearchGrant } from '../save/determinismFixtures';
import { ParkSession } from '../session/ParkSession';
import { GameWorld } from '../World';
import { COASTER_TYPE_BY_ID } from './content';
import {
  COASTER_LIFT_SLOW_TEXT, COASTER_VALIDATION_TEXT, checkCoasterDesign, coasterBaseCost, coasterSpeedProfile,
  deriveCoasterStats, validateCoasterLayout,
} from './design';
import type { CoasterPiece } from './design';
import { liftRuns } from './lift';
import { hillDipFreeLayout, hillDipLayout, ovalLayout, tallFreeLayout, tallLayout, withFreeLifts, zigzagLayout } from './testLayouts';

const SERPENT = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
const COMET = COASTER_TYPE_BY_ID.get('comet-trail')!;
const lift = GAME_CONFIG.coaster.lift;

describe('stats mapping', () => {
  it('a coaster with no free climb gets no bonus of any kind', () => {
    const stats = deriveCoasterStats(tallLayout(), SERPENT);
    expect(stats.reliability).toBe(SERPENT.reliability);
    expect(stats.runningCost).toBe(6.88);
  });

  it('one free run adds the per-run bonuses (and the reliability cost) on top of the unchanged top speed', () => {
    const chained = deriveCoasterStats(tallLayout(), SERPENT);
    const free = deriveCoasterStats(tallFreeLayout(), SERPENT);
    expect(free.topSpeed).toBe(chained.topSpeed);
    expect(free.excitement).toBeCloseTo(chained.excitement + lift.freeRunExcitement, 5);
    expect(free.intensity).toBeCloseTo(chained.intensity + lift.freeRunIntensity, 5);
    expect(free.reliability).toBe(chained.reliability - lift.freeRunReliabilityLoss);
    expect(free.ticketPrice).toBeGreaterThanOrEqual(chained.ticketPrice);
  });

  it('the bonuses are bounded however many runs are free', () => {
    const chained = deriveCoasterStats(zigzagLayout(), SERPENT);
    const free = deriveCoasterStats(withFreeLifts(zigzagLayout()), SERPENT);
    expect(liftRuns(zigzagLayout()).length).toBe(3);
    expect(free.excitement - chained.excitement).toBeLessThanOrEqual(lift.maxFreeExcitement + 1e-9);
    expect(free.intensity - chained.intensity).toBeLessThanOrEqual(lift.maxFreeIntensity + 1e-9);
    expect(chained.reliability - free.reliability).toBeLessThanOrEqual(lift.maxFreeReliabilityLoss);
    expect(free.reliability).toBeLessThan(chained.reliability);
    expect(free.excitement).toBeLessThanOrEqual(100);
    expect(free.reliability).toBeLessThanOrEqual(100);
  });

  it('running cost drops by the chain share of every free segment', () => {
    const chained = deriveCoasterStats(tallLayout(), SERPENT);
    const free = deriveCoasterStats(tallFreeLayout(), SERPENT);
    expect(free.runningCost).toBeCloseTo(chained.runningCost - 4 * lift.chainRunningCostPerPiece, 5);
  });

  it('the cycle time is the model total plus the station load, and free climbs change it', () => {
    for (const pieces of [hillDipFreeLayout(), withFreeLifts(ovalLayout())]) {
      const stats = deriveCoasterStats(pieces, SERPENT);
      const total = coasterSpeedProfile(pieces).totalTravelSeconds;
      expect(stats.durationSeconds).toBeCloseTo(total + GAME_CONFIG.coaster.stationLoadSeconds, 1);
      expect(stats.travelSeconds).toEqual(coasterSpeedProfile(pieces).travelSeconds);
    }
    expect(deriveCoasterStats(hillDipFreeLayout(), SERPENT).durationSeconds)
      .toBeLessThan(deriveCoasterStats(hillDipLayout(), SERPENT).durationSeconds);
    expect(deriveCoasterStats(withFreeLifts(ovalLayout()), COMET).durationSeconds)
      .toBeGreaterThan(deriveCoasterStats(ovalLayout(), COMET).durationSeconds);
  });
});

describe('construction cost', () => {
  it('a free segment saves the chain, a chained one keeps today\'s price', () => {
    expect(coasterBaseCost(tallLayout(), SERPENT)).toBe(3030);
    expect(coasterBaseCost(tallFreeLayout(), SERPENT)).toBe(3030 - 4 * lift.chainCostPerPiece);
    const mixed = hillDipFreeLayout();
    expect(coasterBaseCost(mixed, SERPENT)).toBe(coasterBaseCost(hillDipLayout(), SERPENT) - 5 * lift.chainCostPerPiece);
  });

  it('the chain lift rule scales only the chained share', () => {
    const mixed = hillDipFreeLayout();
    const chainedSegments = 3;
    const base = coasterBaseCost(mixed, SERPENT, 1);
    expect(coasterBaseCost(mixed, SERPENT)).toBe(base);
    expect(coasterBaseCost(mixed, SERPENT, 1.5) - base).toBe(chainedSegments * (Math.round(lift.chainCostPerPiece * 1.5) - lift.chainCostPerPiece));
    expect(coasterBaseCost(mixed, SERPENT, 0.25) - base).toBe(chainedSegments * (Math.round(lift.chainCostPerPiece * 0.25) - lift.chainCostPerPiece));
    expect(coasterBaseCost(tallFreeLayout(), SERPENT, 4), 'an all-free coaster ignores the rule').toBe(coasterBaseCost(tallFreeLayout(), SERPENT, 1));
  });
});

describe('validity', () => {
  it('refuses a flag on a segment that does not climb', () => {
    const pieces = ovalLayout();
    pieces[8].freeClimb = true;
    expect(validateCoasterLayout(pieces, COMET)).toEqual({ ok: false, reason: 'lift-flag-not-climbing', pieceIndex: 8 });
    expect(COASTER_VALIDATION_TEXT['lift-flag-not-climbing']).toBe('Only climbing track can be chain-free.');
  });

  it('refuses a run that is part chained and part free', () => {
    const pieces = hillDipLayout();
    pieces[10].freeClimb = true;
    expect(validateCoasterLayout(pieces, SERPENT)).toEqual({ ok: false, reason: 'lift-run-mixed', pieceIndex: 10 });
    pieces[9].freeClimb = true;
    pieces[11].freeClimb = true;
    expect(validateCoasterLayout(pieces, SERPENT).ok).toBe(true);
  });

  it('an old failure keeps its old reason ahead of the lift checks', () => {
    const pieces = ovalLayout();
    pieces[8].freeClimb = true;
    pieces[0].height = 1;
    expect(validateCoasterLayout(pieces, COMET)).toMatchObject({ ok: false, reason: 'station-not-flat' });
  });

  it('checkCoasterDesign: ok when chained, a warning for a short crawl, a refusal for a long one', () => {
    expect(checkCoasterDesign(ovalLayout(), COMET)).toMatchObject({ validation: { ok: true }, warning: null });
    const slow = checkCoasterDesign(withFreeLifts(ovalLayout()), COMET);
    expect(slow.validation.ok).toBe(true);
    expect(slow.warning).toBe(COASTER_LIFT_SLOW_TEXT);
    expect(slow.warningRunStart).toBe(2);
    const stalls = checkCoasterDesign(tallFreeLayout(), SERPENT);
    expect(stalls.validation).toEqual({ ok: false, reason: 'free-climb-stalls', pieceIndex: 2 });
    expect(COASTER_VALIDATION_TEXT['free-climb-stalls']).toContain('Chain this hill');
    expect(checkCoasterDesign(tallLayout(), SERPENT).validation.ok).toBe(true);
    expect(checkCoasterDesign(hillDipFreeLayout(), SERPENT)).toMatchObject({ validation: { ok: true }, warning: null });
  });

  it('a geometry failure comes back as it is, with no lift analysis', () => {
    expect(checkCoasterDesign(ovalLayout().slice(0, 5), COMET)).toMatchObject({ validation: { ok: false, reason: 'too-short' }, runs: [] });
  });

  it('the stall rule is NOT part of validateCoasterLayout, so a retune can never break loading a save', () => {
    expect(validateCoasterLayout(tallFreeLayout(), SERPENT).ok).toBe(true);
  });
});

const placeFree = (world: GameWorld, pieces: CoasterPiece[], type = SERPENT): number => {
  const result = world.placeCoaster(type.definitionId, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
  if ('error' in result) throw new Error(result.error);
  return result.id;
};

describe('world: placement, save state and restore', () => {
  /** A sandbox park with the Skyline Serpent researched and plenty of cash. */
  const richSession = (): ParkSession => {
    const session = new ParkSession(null);
    session.world.addMoney(200_000, 'test');
    session.progression.grantResearchPoints(scaledResearchGrant(session, 500, ['spin-studies', 'vertical-motion']));
    for (const project of ['spin-studies', 'vertical-motion']) {
      if (!session.progression.purchase(project).ok) throw new Error(`could not research ${project}`);
    }
    return session;
  };

  it('stores the flag only on free pieces, live and in the saved state', () => {
    const session = richSession();
    const pieces = hillDipFreeLayout({ x: 4, y: 20 });
    const id = placeFree(session.world, pieces, SERPENT);
    const record = session.world.coasters.get(id)!;
    expect(record.pieces.filter((piece) => 'freeClimb' in piece).length).toBe(5);
    expect(record.pieces.filter((piece) => piece.freeClimb === true).length).toBe(5);
    session.syncWithWorld();
    const saved = session.serialize().world.coasters.find((coaster) => coaster.objectId === id)!;
    const flagged = saved.pieces.flatMap((piece, index) => ('freeClimb' in piece ? [index] : []));
    expect(flagged).toEqual([9, 10, 11, 15, 20]);
    expect(saved.pieces.every((piece) => piece.freeClimb === undefined || piece.freeClimb === true)).toBe(true);
    expect(JSON.stringify(saved.pieces[0])).not.toContain('freeClimb');
  });

  it('round trips a free coaster through JSON with an identical hash and identical live pieces', () => {
    const session = richSession();
    const id = placeFree(session.world, hillDipFreeLayout({ x: 4, y: 20 }));
    session.syncWithWorld();
    for (let tick = 0; tick < 50; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
    const state = session.serialize();
    const restored = ParkSession.fromState(JSON.parse(JSON.stringify(state)) as typeof state);
    expect(hashState(restored.serialize())).toBe(hashState(state));
    expect(restored.world.coasters.get(id)!.pieces).toEqual(session.world.coasters.get(id)!.pieces);
    expect(restored.world.coasters.get(id)!.pieces.map((piece) => piece.freeClimb)).toEqual(session.world.coasters.get(id)!.pieces.map((piece) => piece.freeClimb));
  });

  const stateWith = (mutate: (pieces: Array<Record<string, unknown>>) => void): ReturnType<ParkSession['serialize']> => {
    const session = richSession();
    const id = placeFree(session.world, hillDipLayout({ x: 4, y: 20 }));
    session.syncWithWorld();
    const state = JSON.parse(JSON.stringify(session.serialize())) as ReturnType<ParkSession['serialize']>;
    mutate(state.world.coasters.find((coaster) => coaster.objectId === id)!.pieces as unknown as Array<Record<string, unknown>>);
    return state;
  };
  const refuses = (state: ReturnType<ParkSession['serialize']>): string => {
    try { ParkSession.fromState(state); } catch (error) { expect(error).toBeInstanceOf(SaveError); return (error as SaveError).message; }
    return 'accepted';
  };

  it('restore refuses a flag that is not exactly true, on a flat segment, or on part of a run', () => {
    expect(refuses(stateWith((pieces) => { pieces[9].freeClimb = false; }))).toContain('freeClimb');
    expect(refuses(stateWith((pieces) => { pieces[9].freeClimb = 1; }))).toContain('freeClimb');
    expect(refuses(stateWith((pieces) => { pieces[0].freeClimb = true; }))).toContain('lift-flag-not-climbing');
    expect(refuses(stateWith((pieces) => { pieces[10].freeClimb = true; }))).toContain('lift-run-mixed');
  });

  it('restore accepts a whole run marked free, and a free coaster that the designer would refuse for stalling', () => {
    expect(refuses(stateWith((pieces) => { for (const index of [9, 10, 11]) pieces[index].freeClimb = true; }))).toBe('accepted');
    const session = richSession();
    // Built through the world directly, as a retuned balance could leave an old save.
    placeFree(session.world, tallFreeLayout({ x: 4, y: 20 }));
    session.syncWithWorld();
    const state = JSON.parse(JSON.stringify(session.serialize())) as ReturnType<ParkSession['serialize']>;
    expect(() => ParkSession.fromState(state)).not.toThrow();
  });
});
