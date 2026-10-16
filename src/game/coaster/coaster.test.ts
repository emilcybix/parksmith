import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { GuestSimulation } from '../guests/GuestSimulation';
import type { Guest } from '../guests/types';
import { RideSimulation } from '../rides/RideSimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { GameWorld } from '../World';
import { COASTER_TYPE_BY_ID } from './content';
import {
  coasterBaseCost,
  coasterSpeedProfile,
  deriveCoasterStats,
  validateCoasterLayout,
  type CoasterPiece,
} from './design';

const COMET = COASTER_TYPE_BY_ID.get('comet-trail')!;
const CHASER = COASTER_TYPE_BY_ID.get('star-chaser')!;
const SERPENT = COASTER_TYPE_BY_ID.get('skyline-serpent')!;

/**
 * A 20-piece rectangular loop from (10,10) to (17,13): a 3-piece flat station heading
 * east, a climb to height 2 along the top, and a drop back to ground on the way home.
 */
const rectangularLoop = (): CoasterPiece[] => {
  const pieces: CoasterPiece[] = [];
  for (let x = 10; x <= 17; x += 1) pieces.push({ cell: { x, y: 10 }, height: 0 });
  for (let y = 11; y <= 13; y += 1) pieces.push({ cell: { x: 17, y }, height: 0 });
  for (let x = 16; x >= 10; x -= 1) pieces.push({ cell: { x, y: 13 }, height: 0 });
  for (let y = 12; y >= 11; y -= 1) pieces.push({ cell: { x: 10, y }, height: 0 });
  const heights = [0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
  return pieces.map((piece, index) => ({ ...piece, height: heights[index] }));
};

const createGuest = (id: number, overrides: Partial<Guest> = {}): Guest => ({
  id,
  position: { x: 11, y: 14 },
  currentCell: { x: 11, y: 14 },
  route: [{ x: 11, y: 14 }],
  routeIndex: 1,
  routeVersion: 0,
  state: 'wandering',
  destinationObjectId: null,
  money: 60,
  happiness: 70,
  hunger: 10,
  thirst: 10,
  toiletNeed: 10,
  energy: 90,
  preferredIntensity: 45,
  currentThought: '',
  thoughtObjectId: null,
  patienceSeconds: 120,
  lastQueueWaitSeconds: 0,
  lastRideSatisfaction: null,
  lastPurchaseSatisfaction: null,
  servicePriceLimit: null,
  recentRideIds: [],
  recentServiceIds: [],
  ageSeconds: 0,
  maximumVisitSeconds: 10_000,
  stateTimerSeconds: 0,
  needTimerSeconds: 0,
  color: 0xffffff,
  accent: 0xffffff,
  nausea: 0,
  warmth: 50,
  souvenirs: 0,
  activity: null,
  ...overrides,
});

describe('coaster layout validation', () => {
  it('accepts the reference loop and reports precise failures otherwise', () => {
    expect(validateCoasterLayout(rectangularLoop(), COMET)).toEqual({ ok: true });

    expect(validateCoasterLayout(rectangularLoop().slice(0, 14), COMET))
      .toMatchObject({ ok: false, reason: 'not-closed' });
    expect(validateCoasterLayout(rectangularLoop().slice(0, 5), COMET))
      .toMatchObject({ ok: false, reason: 'too-short' });

    const gap = rectangularLoop();
    gap.splice(6, 1);
    expect(validateCoasterLayout(gap, COMET)).toMatchObject({ ok: false, reason: 'not-adjacent' });

    const crossing = [...rectangularLoop(), { cell: { x: 10, y: 10 }, height: 0 }];
    expect(validateCoasterLayout(crossing, COMET)).toMatchObject({ ok: false, reason: 'overlapping' });

    const bumpyStation = rectangularLoop();
    bumpyStation[1] = { ...bumpyStation[1], height: 1 };
    bumpyStation[2] = { ...bumpyStation[2], height: 1 };
    bumpyStation[3] = { ...bumpyStation[3], height: 1 };
    expect(validateCoasterLayout(bumpyStation, COMET)).toMatchObject({ ok: false, reason: 'station-not-flat' });

    const cliff = rectangularLoop();
    cliff[4] = { ...cliff[4], height: 3 };
    expect(validateCoasterLayout(cliff, CHASER)).toMatchObject({ ok: false, reason: 'height-step' });

    const flat = rectangularLoop().map((piece) => ({ ...piece, height: 0 }));
    expect(validateCoasterLayout(flat, COMET)).toMatchObject({ ok: false, reason: 'no-drop' });
  });
});

describe('coaster derived stats and cost', () => {
  it('derives deterministic evidence-backed stats from pure track shape', () => {
    const stats = deriveCoasterStats(rectangularLoop(), COMET);
    expect(stats).toEqual(deriveCoasterStats(rectangularLoop(), COMET));
    expect(stats.pieces).toBe(20);
    expect(stats.turns).toBe(4);
    expect(stats.highestHeight).toBe(2);
    expect(stats.totalDescent).toBe(2);
    expect(stats.drops).toBe(1);
    const profile = coasterSpeedProfile(rectangularLoop());
    expect(stats.durationSeconds).toBe(
      Math.round((profile.totalTravelSeconds + GAME_CONFIG.coaster.stationLoadSeconds) * 10) / 10,
    );
    expect(stats.topSpeed).toBe(profile.topSpeed);
    expect(stats.travelSeconds).toEqual(profile.travelSeconds);
    expect(stats.capacity).toBe(COMET.trainCapacity);
    expect(stats.excitement).toBeGreaterThan(0);
    expect(stats.excitement).toBeLessThanOrEqual(100);

    // More turns and taller drops make a measurably wilder ride.
    const taller = rectangularLoop().map((piece, index) => ({
      ...piece,
      height: [0, 0, 0, 1, 2, 3, 3, 3, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0][index],
    }));
    const tallerStats = deriveCoasterStats(taller, CHASER);
    expect(tallerStats.excitement).toBeGreaterThan(stats.excitement);
    expect(tallerStats.intensity).toBeGreaterThan(stats.intensity);
  });

  it('prices the track by pieces, elevation, and special pieces per coaster type', () => {
    const pieces = rectangularLoop();
    const heightLevels = pieces.reduce((total, piece) => total + piece.height, 0);
    expect(coasterBaseCost(pieces, COMET)).toBe(
      COMET.stationCost + pieces.length * COMET.pieceCost + heightLevels * COMET.heightCostPerLevel,
    );
    const withLoop = pieces.map((piece, index) => index === 5 ? { ...piece, special: 'loop' as const } : piece);
    expect(coasterBaseCost(withLoop, CHASER)).toBe(
      CHASER.stationCost + pieces.length * CHASER.pieceCost
      + heightLevels * CHASER.heightCostPerLevel + GAME_CONFIG.coaster.specials.loop.cost,
    );
  });

  it('runs the train faster downhill and slower on the chain lift', () => {
    const profile = coasterSpeedProfile(rectangularLoop());
    // Piece 3→4 climbs (chain lift); piece 11→12 finishes the drop back to ground.
    const climbSeconds = profile.travelSeconds[3];
    const dropSeconds = profile.travelSeconds[11];
    expect(dropSeconds).toBeLessThan(climbSeconds);
    expect(1 / climbSeconds).toBe(GAME_CONFIG.coaster.speed.lift);
    expect(profile.topSpeed).toBeGreaterThan(GAME_CONFIG.coaster.speed.cruise);

    const boosted = rectangularLoop().map((piece, index) =>
      index === 14 ? { ...piece, special: 'boost' as const } : piece);
    expect(coasterSpeedProfile(boosted).topSpeed).toBeGreaterThanOrEqual(GAME_CONFIG.coaster.speed.boost);

    // A loop carries its whole circumference: that piece takes several times longer
    // to traverse, so the total ride is measurably longer than the plain layout.
    const looped = rectangularLoop().map((piece, index) =>
      index === 5 ? { ...piece, special: 'loop' as const } : piece);
    const loopedProfile = coasterSpeedProfile(looped);
    expect(loopedProfile.travelSeconds[5]).toBeGreaterThan(profile.travelSeconds[5] * 2);
    expect(loopedProfile.totalTravelSeconds).toBeGreaterThan(profile.totalTravelSeconds);
  });

  it('enforces per-type height limits and special-piece rules', () => {
    const tall = rectangularLoop().map((piece, index) => ({
      ...piece,
      height: [0, 0, 0, 1, 2, 3, 3, 3, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0][index],
    }));
    expect(validateCoasterLayout(tall, COMET)).toMatchObject({ ok: false, reason: 'height-range' });
    expect(validateCoasterLayout(tall, CHASER)).toEqual({ ok: true });

    const loopOnStraight = rectangularLoop().map((piece, index) =>
      index === 5 ? { ...piece, special: 'loop' as const } : piece);
    expect(validateCoasterLayout(loopOnStraight, COMET)).toMatchObject({ ok: false, reason: 'special-not-allowed' });
    expect(validateCoasterLayout(loopOnStraight, CHASER)).toEqual({ ok: true });
    expect(validateCoasterLayout(loopOnStraight, SERPENT)).toEqual({ ok: true });

    // Index 7 is the corner at (17,10): specials need straight track.
    const loopOnCorner = rectangularLoop().map((piece, index) =>
      index === 7 ? { ...piece, special: 'loop' as const } : piece);
    expect(validateCoasterLayout(loopOnCorner, CHASER)).toMatchObject({ ok: false, reason: 'special-not-straight' });

    const loopOnStation = rectangularLoop().map((piece, index) =>
      index === 1 ? { ...piece, special: 'loop' as const } : piece);
    expect(validateCoasterLayout(loopOnStation, CHASER)).toMatchObject({ ok: false, reason: 'special-on-station' });

    // Rings need breathing room: adjacent specials overlap on screen.
    const crowded = rectangularLoop().map((piece, index) =>
      index === 4 || index === 5 ? { ...piece, special: 'loop' as const } : piece);
    expect(validateCoasterLayout(crowded, CHASER)).toMatchObject({ ok: false, reason: 'specials-too-close' });
    const spaced = rectangularLoop().map((piece, index) =>
      index === 4 || index === 6 ? { ...piece, special: 'loop' as const } : piece);
    expect(validateCoasterLayout(spaced, CHASER)).toEqual({ ok: true });

    const loopStats = deriveCoasterStats(loopOnStraight, CHASER);
    const plainStats = deriveCoasterStats(rectangularLoop(), CHASER);
    expect(loopStats.loops).toBe(1);
    expect(loopStats.excitement).toBeGreaterThan(plainStats.excitement);
    expect(loopStats.intensity).toBeGreaterThan(plainStats.intensity);
  });
});

describe('coaster placement in the world', () => {
  it('places a validated coaster, occupies every track cell, and charges the multiplied cost', () => {
    const world = new GameWorld(15_000, 0.8);
    const pieces = rectangularLoop();
    const stats = deriveCoasterStats(pieces, COMET);
    const baseCost = coasterBaseCost(pieces, COMET);
    const result = world.placeCoaster('comet-trail', pieces, stats, baseCost);
    expect('error' in result).toBe(false);
    const placed = result as { id: number };
    const expectedCost = Math.round(baseCost * 0.8);
    expect(world.cash).toBe(15_000 - expectedCost);
    expect(world.coasters.get(placed.id)?.paidCost).toBe(expectedCost);
    expect(world.transactions[0].category).toBe('construction');
    expect(world.canPlacePath({ x: 13, y: 10 })).toBe(false);
    expect(world.checkObjectBuild('ribbon-bench', { x: 12, y: 12 }).ok).toBe(true);
    expect(world.objectFootprint(world.objects.get(placed.id)!)).toHaveLength(20);

    const profile = world.rideProfile(placed.id);
    expect(profile?.excitement).toBe(stats.excitement);
    expect(profile?.duration).toBe(stats.durationSeconds);
    expect(profile?.capacity).toBe(COMET.trainCapacity);
  });

  it('refuses blocked tracks and insufficient funds, and stamping the card directly is impossible', () => {
    const world = new GameWorld();
    world.buildPaths([{ x: 12, y: 10 }]);
    const pieces = rectangularLoop();
    expect(world.placeCoaster('comet-trail', pieces, deriveCoasterStats(pieces, COMET), coasterBaseCost(pieces, COMET)))
      .toEqual({ error: 'blocked' });

    const broke = new GameWorld(100);
    expect(broke.placeCoaster('comet-trail', pieces, deriveCoasterStats(pieces, COMET), coasterBaseCost(pieces, COMET)))
      .toEqual({ error: 'funds' });
    expect(broke.cash).toBe(100);

    expect(world.checkObjectBuild('comet-trail', { x: 5, y: 5 })).toEqual({ ok: false, reason: 'custom' });
  });

  it('bulldozing any track cell removes the whole coaster and refunds from the paid cost', () => {
    const world = new GameWorld();
    const pieces = rectangularLoop();
    const placed = world.placeCoaster('comet-trail', pieces, deriveCoasterStats(pieces, COMET), coasterBaseCost(pieces, COMET));
    const paidCost = world.coasters.get((placed as { id: number }).id)!.paidCost;

    const result = world.bulldoze({ x: 17, y: 12 });
    expect(result.removed).toBe(true);
    expect(result.refund).toBe(Math.floor(paidCost * GAME_CONFIG.bulldozeRefundRate));
    expect(world.objects.size).toBe(0);
    expect(world.coasters.size).toBe(0);
    expect(world.canPlacePath({ x: 10, y: 10 })).toBe(true);
  });
});

describe('paths under elevated track', () => {
  it('allows walkways under high track, blocks them under low track, and lets high track cross paths', () => {
    const world = new GameWorld();
    const pieces = rectangularLoop();
    world.placeCoaster('comet-trail', pieces, deriveCoasterStats(pieces, COMET), coasterBaseCost(pieces, COMET));

    // (14,10) carries track at height 2 — a path fits underneath; (10,10) is the station at 0.
    expect(world.canPlacePath({ x: 14, y: 10 })).toBe(true);
    expect(world.canPlacePath({ x: 10, y: 10 })).toBe(false);
    expect(world.buildPaths([{ x: 14, y: 10 }]).built).toBe(1);

    // Bulldozing that cell removes only the walkway; the coaster survives.
    const bulldozed = world.bulldoze({ x: 14, y: 10 });
    expect(bulldozed.removed).toBe(true);
    expect(world.coasters.size).toBe(1);
    expect(world.paths.has('14,10')).toBe(false);
    // A second bulldoze on the same cell now removes the whole coaster.
    expect(world.bulldoze({ x: 14, y: 10 }).removed).toBe(true);
    expect(world.coasters.size).toBe(0);
  });

  it('lets only sufficiently high pieces be laid over an existing path', () => {
    const world = new GameWorld();
    expect(world.buildPaths([{ x: 14, y: 10 }]).built).toBe(1);
    expect(world.canPlaceCoasterPiece({ cell: { x: 14, y: 10 }, height: 2 })).toBe(true);
    expect(world.canPlaceCoasterPiece({ cell: { x: 14, y: 10 }, height: 1 })).toBe(false);

    const pieces = rectangularLoop();
    const result = world.placeCoaster(
      'comet-trail', pieces, deriveCoasterStats(pieces, COMET), coasterBaseCost(pieces, COMET),
    );
    expect('error' in result).toBe(false);
    expect(world.paths.has('14,10')).toBe(true);

    const lowOverPath = new GameWorld();
    lowOverPath.buildPaths([{ x: 11, y: 10 }]);
    expect(lowOverPath.placeCoaster(
      'comet-trail', pieces, deriveCoasterStats(pieces, COMET), coasterBaseCost(pieces, COMET),
    )).toEqual({ error: 'blocked' });
  });
});

describe('coaster as a live ride', () => {
  const buildRunningPark = () => {
    const world = new GameWorld();
    const pieces = rectangularLoop();
    const placed = world.placeCoaster(
      'comet-trail', pieces, deriveCoasterStats(pieces, COMET), coasterBaseCost(pieces, COMET),
    ) as { id: number };
    const rides = new RideSimulation(world);
    const shops = new ShopSimulation(world);
    return { world, rides, shops, coasterId: placed.id, stats: deriveCoasterStats(pieces, COMET) };
  };

  it('boards guests, runs a full cycle, and posts coaster-priced revenue and wear', () => {
    const { world, rides, coasterId, stats } = buildRunningPark();
    const runtime = rides.getRide(coasterId);
    expect(runtime).toBeDefined();
    expect(runtime!.ticketPrice).toBe(stats.ticketPrice);
    expect(runtime!.reliability).toBe(COMET.reliability);

    const guest = createGuest(1);
    const guests = new Map([[guest.id, guest]]);
    expect(rides.joinQueue(coasterId, guest)).toBe('joined');

    const cashBefore = world.cash;
    const dispatchTicks = Math.ceil(GAME_CONFIG.rides.maximumDispatchWaitSeconds * 10) + 2;
    const cycleTicks = Math.ceil(stats.durationSeconds * 10) + 2;
    for (let tick = 0; tick < dispatchTicks + cycleTicks; tick += 1) rides.step(100, guests);

    expect(runtime!.completedCycles).toBe(1);
    expect(runtime!.ridersToday).toBe(1);
    expect(runtime!.satisfactionCount).toBe(1);
    expect(guest.lastRideSatisfaction).not.toBeNull();
    expect(guest.recentRideIds).toContain(coasterId);
    expect(world.cash).toBeCloseTo(
      cashBefore + stats.ticketPrice - Math.round(stats.runningCost * 100) / 100,
      5,
    );
    expect(world.transactions.some((transaction) =>
      transaction.category === 'ride-revenue' && transaction.label.includes('Comet Trail'))).toBe(true);
    expect(runtime!.condition).toBeLessThan(100);

    const snapshot = rides.snapshot(coasterId);
    expect(snapshot?.coaster).toEqual({
      pieces: 20,
      turns: 4,
      drops: 1,
      totalDescent: 2,
      highestHeight: 2,
      topSpeed: stats.topSpeed,
      loops: 0,
      boosts: 0,
    });
    expect(snapshot?.excitement).toBe(stats.excitement);
    expect(snapshot?.capacity).toBe(COMET.trainCapacity);
  });

  it('counts the coaster as a reachable guest destination through its track-side access', () => {
    const { world, rides, shops } = buildRunningPark();
    const pathCells = [];
    for (let y = 30; y >= 14; y -= 1) pathCells.push({ x: 15, y });
    for (let x = 14; x >= 10; x -= 1) pathCells.push({ x, y: 14 });
    expect(world.buildPaths(pathCells).built).toBe(pathCells.length);

    const simulation = new GuestSimulation(world, rides, shops, 7);
    expect(simulation.organicGuestPotential()).toBeGreaterThan(0);
  });
});
