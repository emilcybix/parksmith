import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { GameWorld } from '../World';
import { SAVE_MIGRATIONS } from '../save/migrate';
import { centreLineFor } from './centreLine';
import { COASTER_TYPE_BY_ID } from './content';
import { checkCoasterDesign, coasterBaseCost, deriveCoasterStats, validateCoasterLayout } from './design';
import { describeCoasterLift } from './lift';
import { clampLaunchSpeed, isShuttleLayout, isValidLaunchSpeed, shuttleHeadIndex, shuttleProfile } from './shuttle';
import { launchOvalLayout, layoutFromMoves } from './testLayouts';
import { coasterHeadIndex } from '../../rendering/coasterTrain';

/** Phase 44: the shuttle launch coaster (open track, launched from the station, out and back). */
const LAUNCH = COASTER_TYPE_BY_ID.get('thunder-launch')!;
const COMET = COASTER_TYPE_BY_ID.get('comet-trail')!;

/** The station, a flat run-up, and a spike to level 5. */
const spike = (launch = 6, moves = 'EEEEEEEEE', heights: readonly number[] = [0, 0, 0, 0, 1, 2, 3, 4, 5]) => {
  const pieces = layoutFromMoves({ x: 4, y: 4 }, moves, heights);
  pieces[0].launchSpeed = launch;
  return pieces;
};

describe('Phase 44: shuttle layouts', () => {
  it('Thunder Launch is a shuttle type; a launch speed on the first piece makes a layout a shuttle', () => {
    expect(LAUNCH.layout).toBe('shuttle');
    expect(isShuttleLayout(spike())).toBe(true);
    const plain = spike();
    delete plain[0].launchSpeed;
    expect(isShuttleLayout(plain)).toBe(false);
  });

  it('an open out-and-back layout is valid: no closure, no launch piece, the station launches', () => {
    expect(validateCoasterLayout(spike(), LAUNCH)).toEqual({ ok: true });
    expect(checkCoasterDesign(spike(), LAUNCH).validation).toEqual({ ok: true });
    // With turns and a boost on the way out.
    const winding = spike(7, 'EEEEESSSS', [0, 0, 0, 0, 0, 1, 2, 3, 4]);
    expect(validateCoasterLayout(winding, LAUNCH)).toEqual({ ok: true });
  });

  it('refuses what a shuttle cannot be', () => {
    const at = (pieces: ReturnType<typeof spike>) => validateCoasterLayout(pieces, LAUNCH);
    expect(validateCoasterLayout(spike(), COMET), 'a circuit type').toMatchObject({ ok: false, reason: 'shuttle-not-allowed' });
    const launchPiece = spike();
    launchPiece[4].special = 'launch';
    expect(at(launchPiece)).toMatchObject({ ok: false, reason: 'special-not-allowed', pieceIndex: 4 });
    const endSpecial = spike();
    endSpecial[8].special = 'boost';
    expect(at(endSpecial)).toMatchObject({ ok: false, reason: 'shuttle-special-at-end' });
    const second = spike();
    second[3].launchSpeed = 8;
    expect(at(second)).toMatchObject({ ok: false, reason: 'launch-speed-range', pieceIndex: 3 });
    expect(at(spike(6.3))).toMatchObject({ ok: false, reason: 'launch-speed-range', pieceIndex: 0 });
    expect(at(spike(40))).toMatchObject({ ok: false, reason: 'launch-speed-range' });
    const flagged = spike();
    flagged[4].freeClimb = true;
    expect(at(flagged)).toMatchObject({ ok: false, reason: 'lift-flag-not-climbing' });
    expect(at(spike(6, 'EEEEEE', [0, 0, 0, 0, 1, 1])), 'no climb to turn on').toMatchObject({ ok: false, reason: 'shuttle-no-climb' });
    expect(at(spike(6, 'EEEEE', [0, 0, 0, 1, 2])), 'too short').toMatchObject({ ok: false, reason: 'too-short' });
  });

  it('a closed Thunder Launch saved before Phase 44 still validates as a circuit', () => {
    expect(validateCoasterLayout(launchOvalLayout(), LAUNCH)).toEqual({ ok: true });
  });

  it('the launch speed grid', () => {
    const range = GAME_CONFIG.coaster.shuttle.launchSpeed;
    expect(isValidLaunchSpeed(range.default)).toBe(true);
    expect(isValidLaunchSpeed(range.minimum - range.step)).toBe(false);
    expect(clampLaunchSpeed(100)).toBe(range.maximum);
    expect(clampLaunchSpeed(7.3)).toBe(7.5);
  });
});

describe('Phase 44: the shuttle ride', () => {
  it('a faster launch climbs higher before it turns', () => {
    const slow = shuttleProfile(spike(6));
    const faster = shuttleProfile(spike(7));
    expect(slow.outcome).toBe('ok');
    expect(faster.outcome).toBe('ok');
    expect(faster.turnSegment + faster.turnFraction).toBeGreaterThan(slow.turnSegment + slow.turnFraction);
    expect(faster.topSpeed).toBe(7);
  });

  it('the designer refuses a train that would fly off the end, stop on the flat, or crawl back over a hill', () => {
    expect(checkCoasterDesign(spike(10), LAUNCH).validation).toMatchObject({ ok: false, reason: 'shuttle-overshoots' });
    // Long flat run-out: the friction drains the launch on level track.
    const flat = spike(6, 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', [0, 0, 0, ...new Array(25).fill(0), 1, 2]);
    expect(checkCoasterDesign(flat, LAUNCH).validation).toMatchObject({ ok: false, reason: 'shuttle-stops-flat' });
    // A hill as tall as the climb it turns on: rolling back from the dip, the train cannot get back over it.
    const hill = spike(7.5, 'EEEEEEEEEEEEEEEE', [0, 0, 0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5]);
    const profile = shuttleProfile(hill);
    expect(profile.outcome).toBe('ok');
    expect(profile.returnCreepSegments).toBeGreaterThan(GAME_CONFIG.coaster.shuttle.maxReturnCreepSegments);
    expect(checkCoasterDesign(hill, LAUNCH).validation).toMatchObject({ ok: false, reason: 'shuttle-stalls-back' });
    // None of these is a load rule: the layouts are valid.
    expect(validateCoasterLayout(spike(10), LAUNCH)).toEqual({ ok: true });
  });

  it('warns (without refusing) when the train turns before the last climb', () => {
    const early = spike(6, 'EEEEEEEEEEEEE', [0, 0, 0, 0, 1, 2, 3, 4, 3, 2, 3, 4, 5]);
    const check = checkCoasterDesign(early, LAUNCH);
    expect(check.validation).toEqual({ ok: true });
    expect(check.warning).toMatch(/turns back/);
  });

  it('the train goes out to the turnaround and back, and ends the cycle parked', () => {
    const pieces = spike(7);
    const profile = shuttleProfile(pieces);
    const parked = GAME_CONFIG.coaster.stationLength - 1;
    const turnAt = profile.turnSegment + profile.turnFraction;
    expect(shuttleHeadIndex(pieces, 0)).toBe(parked);
    let previous = parked;
    let peak = parked;
    let falling = false;
    for (let step = 1; step <= 400; step += 1) {
      const index = shuttleHeadIndex(pieces, (profile.totalSeconds * step) / 400 - 1e-9);
      if (index < previous - 1e-9) falling = true;
      if (falling) expect(index).toBeLessThanOrEqual(previous + 1e-9);
      else expect(index).toBeGreaterThanOrEqual(previous - 1e-9);
      peak = Math.max(peak, index);
      previous = index;
    }
    expect(falling).toBe(true);
    expect(peak).toBeCloseTo(turnAt, 1);
    expect(previous).toBeCloseTo(parked, 2);
    expect(shuttleHeadIndex(pieces, profile.totalSeconds + 1)).toBe(parked);
  });

  it('stats: out and back, the ride time is both ways plus loading; saved travel times are positive per piece', () => {
    const pieces = spike(7);
    const stats = deriveCoasterStats(pieces, LAUNCH);
    const profile = shuttleProfile(pieces);
    expect(stats.durationSeconds).toBeCloseTo(profile.totalSeconds + GAME_CONFIG.coaster.stationLoadSeconds, 1);
    expect(stats.travelSeconds).toHaveLength(pieces.length);
    expect(stats.travelSeconds.every((seconds) => seconds > 0)).toBe(true);
    // The spike is a drop on the way back.
    expect(stats.drops).toBe(1);
    expect(stats.biggestDrop).toBe(5);
    expect(stats.topSpeed).toBe(7);
    // The train animation reads the shuttle timeline: mid-ride it is out on the track.
    const record = { pieces, stats };
    const midway = stats.durationSeconds - GAME_CONFIG.coaster.stationLoadSeconds - profile.forwardSeconds.reduce((a, b) => a + b, 0);
    expect(coasterHeadIndex(record, midway)).toBeCloseTo(profile.turnSegment + profile.turnFraction, 1);
    // The inspector's strip: no chain anywhere.
    const view = describeCoasterLift(pieces, stats.travelSeconds, LAUNCH);
    expect(view.chainedPieces).toBe(0);
    expect(view.kinds).not.toContain('chain');
  });

  it('costs the station launch and no chain', () => {
    const pieces = spike(7);
    const config = GAME_CONFIG.coaster;
    const heights = pieces.reduce((total, piece) => total + piece.height, 0);
    expect(coasterBaseCost(pieces, LAUNCH)).toBe(LAUNCH.stationCost + pieces.length * LAUNCH.pieceCost
      + heights * LAUNCH.heightCostPerLevel + config.specials.launch.cost - 5 * config.lift.chainCostPerPiece);
  });

  it('the centre line is open: real pieces keep their indices, nothing is chained, the spike ends climbing', () => {
    const pieces = spike(7);
    const line = centreLineFor(pieces);
    expect(line.realPieceCount).toBe(pieces.length);
    expect(line.pieceCount).toBe(pieces.length + 2);
    expect([...line.chained].every((flag) => flag === 0)).toBe(true);
    expect(line.turn[pieces.length - 1]).toBe(0);
    expect(line.nodeSlope[pieces.length - 1]).toBeGreaterThan(0);
  });
});

describe('Phase 44: shuttles in the world and in saves', () => {
  const build = (world: GameWorld, pieces: ReturnType<typeof spike>) =>
    world.placeCoaster('thunder-launch', pieces, deriveCoasterStats(pieces, LAUNCH), coasterBaseCost(pieces, LAUNCH));

  it('builds, saves (with its launch speed) and loads', () => {
    const world = new GameWorld(100_000);
    world.setBuildAccessPolicy(null);
    const placed = build(world, spike(7));
    expect('error' in placed).toBe(false);
    const state = world.serialize();
    expect(state.coasters[0].pieces[0].launchSpeed).toBe(7);
    expect(state.coasters[0].pieces.slice(1).some((piece) => 'launchSpeed' in piece)).toBe(false);
    const restored = new GameWorld();
    restored.restore(structuredClone(state));
    expect(restored.serialize()).toEqual(state);
  });

  it('refuses a save with a launch speed off the grid', () => {
    const world = new GameWorld(100_000);
    world.setBuildAccessPolicy(null);
    build(world, spike(7));
    const state = structuredClone(world.serialize());
    state.coasters[0].pieces[0].launchSpeed = 6.2;
    expect(() => new GameWorld().restore(state)).toThrow(/launch-speed-range/);
  });

  it('a schema-16 save loses a hand-edited launch speed in migration', () => {
    const world = new GameWorld(100_000);
    world.setBuildAccessPolicy(null);
    build(world, spike(7));
    const state = structuredClone(world.serialize()) as unknown as Record<string, unknown>;
    const migrated = SAVE_MIGRATIONS.find((migration) => migration.from === 16)!.migrate({ schemaVersion: 16, state });
    const coasters = (migrated.state as unknown as { coasters: Array<{ pieces: Array<Record<string, unknown>> }> }).coasters;
    expect(migrated.schemaVersion).toBe(17);
    expect(coasters[0].pieces.some((piece) => 'launchSpeed' in piece)).toBe(false);
  });
});
